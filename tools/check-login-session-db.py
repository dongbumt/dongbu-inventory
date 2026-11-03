"""Auth and optional heartbeat checks; schema/fixtures roll back except short-lived concurrency fixtures."""
import json
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import psycopg

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / 'supabase/schema-rpc-73-login-session-nonblocking.sql').read_text(encoding='utf-8-sig')


def connect():
    conn = psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True,
                          application_name='dbmt_login_session_qa')
    conn.execute('set role postgres')
    return conn


def fixture(conn):
    role, user, token = uuid.uuid4(), uuid.uuid4(), uuid.uuid4().hex * 2
    name = 'qa_login_' + uuid.uuid4().hex[:12]
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Login QA')", (role, name))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Login QA',extensions.crypt('0927',extensions.gen_salt('bf')),%s)", (user, name, role))
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view) values(%s,'company_master',true)", (role,))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at,last_used_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour',now()-interval '10 minutes')", (token, user))
    return role, user, token, name


def rpc(conn, name, token):
    with conn.transaction():
        conn.execute('set local role anon')
        conn.execute("set local statement_timeout='2s'")
        result = conn.execute('select public.' + name + '(%s)', (token,)).fetchone()[0]
        conn.execute('set local role postgres')
        return result


def heartbeat(conn, token):
    return conn.execute("select last_used_at,expires_at from public.erp_user_sessions where token_hash=encode(extensions.digest(%s,'sha256'),'hex')", (token,)).fetchone()


def checks(conn):
    role, user, token, name = fixture(conn)
    initial, expiry = heartbeat(conn, token)
    assert rpc(conn, 'dbmt_erp_session', token)['ok']
    touched, expiry2 = heartbeat(conn, token)
    assert touched > initial and expiry2 == expiry
    rpc(conn, 'dbmt_erp_session', token)
    assert heartbeat(conn, token) == (touched, expiry), 'Frequent requests do not rewrite or extend session'
    assert rpc(conn, 'dbmt_erp_get_company_master', token)
    assert heartbeat(conn, token) == (touched, expiry), 'Legacy authorization uses same throttled heartbeat'
    conn.execute("update public.erp_user_sessions set last_used_at=now()-interval '10 minutes' where user_id=%s", (user,))
    rpc(conn, 'dbmt_erp_get_company_master', token)
    assert heartbeat(conn, token)[0] == touched
    for change, args in [
        ('update public.erp_users set active=false where id=%s', (user,)),
        ('update public.erp_roles set active=false where id=%s', (role,)),
        ("update public.erp_user_sessions set expires_at=now()-interval '1 second' where user_id=%s", (user,)),
        ('delete from public.erp_user_sessions where user_id=%s', (user,)),
    ]:
        with conn.transaction(force_rollback=True):
            conn.execute(change, args)
            assert not rpc(conn, 'dbmt_erp_session', token)['ok']
            try:
                rpc(conn, 'dbmt_erp_get_company_master', token)
            except psycopg.Error as error:
                assert '만료' in error.diag.message_primary
            else:
                raise AssertionError('Unauthorized read was accepted')
    assert not rpc(conn, 'dbmt_erp_session', 'invalid-token')['ok']
    conn.execute('update public.erp_role_permissions set can_view=false where role_id=%s', (role,))
    try:
        rpc(conn, 'dbmt_erp_get_company_master', token)
    except psycopg.Error as error:
        assert '권한' in error.diag.message_primary
    else:
        raise AssertionError('Permission check was bypassed')
    for who in ['anon', 'authenticated']:
        assert not conn.execute("select has_schema_privilege(%s,'erp_session_private','usage')", (who,)).fetchone()[0]
        assert not conn.execute("select has_function_privilege(%s,'erp_session_private.touch_session(text)','execute')", (who,)).fetchone()[0]
        assert not conn.execute("select has_function_privilege(%s,'public.dbmt_erp_authorize_legacy(text,text,text)','execute')", (who,)).fetchone()[0]
    # Password checks, lockout and absolute twelve-hour expiry stay unchanged.
    with conn.transaction(force_rollback=True):
        conn.execute('set local role anon')
        bad = conn.execute("select public.dbmt_erp_login(%s,'1111')", (name,)).fetchone()[0]
        assert not bad['ok']
        good = conn.execute("select public.dbmt_erp_login(%s,'0927')", (name,)).fetchone()[0]
        assert good['ok'] and good['token']
        conn.execute('set local role postgres')
        assert conn.execute("select expires_at=now()+interval '12 hours' from public.erp_user_sessions where token_hash=encode(extensions.digest(%s,'sha256'),'hex')", (good['token'],)).fetchone()[0]


def concurrency():
    # Real independent transactions need visible fixtures. Only QA users/roles/sessions
    # are briefly committed; no business rows or real-user sessions are modified.
    with connect() as setup:
        role = user = None
        try:
            with setup.transaction():
                role, user, token, _ = fixture(setup)
            before = heartbeat(setup, token)
            with connect() as holder:
                with holder.transaction(force_rollback=True):
                    holder.execute('select 1 from public.erp_user_sessions where user_id=%s for update', (user,))
                    def request(name):
                        with connect() as worker:
                            start=time.monotonic()
                            value=rpc(worker, name, token)
                            return name,time.monotonic()-start,value
                    with ThreadPoolExecutor(max_workers=4) as pool:
                        jobs=[pool.submit(request, name) for name in ['dbmt_erp_session','dbmt_erp_get_company_master']*2]
                        results=[job.result(timeout=12) for job in jobs]
                    assert all(value and elapsed<2 for _,elapsed,value in results), results
                    assert all(value.get('ok') for name,_,value in results if name=='dbmt_erp_session')
                    assert heartbeat(setup,token) == before, 'Locked activity update is skipped; expiry is untouched'
                initial=heartbeat(setup,token)
                assert rpc(setup,'dbmt_erp_session',token)['ok']
                assert heartbeat(setup,token)[0] > initial[0]
                assert heartbeat(setup,token)[1] == initial[1]
        finally:
            if user:
                with setup.transaction():
                    setup.execute('delete from public.erp_users where id=%s', (user,))
                    setup.execute('delete from public.erp_roles where id=%s', (role,))
                assert not setup.execute('select 1 from public.erp_users where id=%s', (user,)).fetchone()


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER','')+os.environ.get('PGHOST',''):
        raise RuntimeError('Wrong project')
    migration, = (ROOT/'supabase/migrations').glob('*_login_session_nonblocking.sql')
    assert migration.read_text(encoding='utf-8-sig') == SQL
    installed = '--installed' in sys.argv
    with connect() as conn:
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='2s'")
            conn.execute("set local statement_timeout='5s'")
            if not installed:
                conn.execute(SQL)
            checks(conn)
    if installed:
        concurrency()
    print(json.dumps(dict(ok=True,installed=installed,fixturesCleaned=True,
        tests='five-minute throttle, fixed expiry, authentication/permission/disabled user/role/revocation, private helper ACL, PIN preservation'+('; four parallel reads skip locked session' if installed else '')), ensure_ascii=False))


if __name__ == '__main__':
    main()
