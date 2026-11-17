"""24-hour login and write renewal checks; rollback or clean all QA fixtures."""
import json
import os
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from urllib.request import Request, urlopen
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parent.parent
SQL = next((ROOT / 'supabase/migrations').glob('*_erp_session_activity_24h.sql')).read_text(encoding='utf-8-sig')


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
    assert touched == initial and expiry2 == expiry, 'Reads do not write session activity'
    rpc(conn, 'dbmt_erp_session', token)
    assert heartbeat(conn, token) == (touched, expiry), 'Frequent requests do not rewrite or extend session'
    assert rpc(conn, 'dbmt_erp_get_company_master', token)
    assert heartbeat(conn, token) == (touched, expiry), 'Legacy authorization is read-only'
    conn.execute("update public.erp_user_sessions set last_used_at=now()-interval '10 minutes' where user_id=%s", (user,))
    rpc(conn, 'dbmt_erp_get_company_master', token)
    assert heartbeat(conn, token)[0] == initial, 'Read-only legacy RPC leaves activity unchanged'
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
    # Password checks and lockout stay unchanged; new logins last 24 hours.
    with conn.transaction(force_rollback=True):
        conn.execute('set local role anon')
        bad = conn.execute("select public.dbmt_erp_login(%s,'1111')", (name,)).fetchone()[0]
        assert not bad['ok']
        good = conn.execute("select public.dbmt_erp_login(%s,'0927')", (name,)).fetchone()[0]
        assert good['ok'] and good['token']
        conn.execute('set local role postgres')
        assert conn.execute("select expires_at=now()+interval '24 hours' from public.erp_user_sessions where token_hash=encode(extensions.digest(%s,'sha256'),'hex')", (good['token'],)).fetchone()[0]


def rolling_checks(conn):
    role, user, token, _ = fixture(conn)
    other_token = uuid.uuid4().hex * 2
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '2 hours')", (other_token,user))
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'product_specs',true,true,true,true),(%s,'workorders',true,true,true,true),(%s,'schedule',true,true,true,true),(%s,'document_check',true,false,false,false)", (role,role,role,role))
    def flush():
        # PostgREST commits before returning the HTTP response. Simulate that
        # boundary inside the outer unconditional rollback used by this test.
        conn.execute('set constraints all immediate')
        conn.execute('set constraints all deferred')
    def call(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            result=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(a) if isinstance(a,(dict,list)) else a for a in args)).fetchone()[0]
            flush()  # Also checks renewal after the RPC SECURITY DEFINER unwinds.
            conn.execute('set local role postgres')
            return result
    def reset():
        flush()
        conn.execute("update public.erp_user_sessions set expires_at=now()+interval '1 hour',last_used_at=now()-interval '10 minutes' where user_id=%s",(user,))
        return heartbeat(conn,token),heartbeat(conn,other_token)
    def renewed(before):
        activity,expiry=heartbeat(conn,token)
        assert expiry>before[1]+timedelta(hours=22)
        assert conn.execute("select expires_at>=statement_timestamp()+interval '24 hours'-interval '5 seconds' and expires_at<=statement_timestamp()+interval '24 hours' from public.erp_user_sessions where token_hash=encode(extensions.digest(%s,'sha256'),'hex')",(token,)).fetchone()[0]
        assert activity>before[0]
    def reject(callback):
        try:
            with conn.transaction(): callback()
        except psycopg.Error: pass
        else: raise AssertionError('Expected rejected save')
    before,other=reset()
    for name,args in [('dbmt_erp_session',(token,)),('dbmt_erp_get_company_master',(token,)),
                      ('dbmt_erp_get_label_products',(token,None)),('dbmt_erp_get_product_specs',(token,)),
                      ('dbmt_erp_get_work_orders',(token,None)),('dbmt_erp_get_doc_checks',(token,))]:
        assert call(name,*args)
        assert heartbeat(conn,token)==before, name+' must not renew'
    record=dict(trader='Session QA',material='Session QA',origin='QA',monthly_usage=1)
    saved=call('dbmt_erp_save_product_spec',token,None,record,None)
    assert saved['ok'];renewed(before)
    assert heartbeat(conn,other_token)==other, 'Another PC using the same account is not renewed'
    spec=saved['spec']
    before,_=reset()
    updated=call('dbmt_erp_save_product_spec',token,uuid.UUID(spec['id']),dict(record,note='updated'),spec['revision'])
    assert updated['ok'];renewed(before)
    before,_=reset()
    reject(lambda:call('dbmt_erp_save_product_spec',token,uuid.UUID(spec['id']),record,spec['revision']))
    assert heartbeat(conn,token)==before,'Stale revision is not activity'
    reject(lambda:call('dbmt_erp_save_product_spec',token,None,dict(record,monthly_usage=-1),None))
    assert heartbeat(conn,token)==before,'Invalid input is not activity'
    with conn.transaction(force_rollback=True):
        call('dbmt_erp_save_product_spec',token,None,record,None)
        renewed(before)
    assert heartbeat(conn,token)==before,'Renewal is rolled back with the business save'
    call('dbmt_erp_delete_product_spec',token,uuid.UUID(spec['id']),updated['spec']['revision'])
    renewed(before)
    # app_data-backed legacy saves and permission-only work-order writes use
    # the same policy as relational product-spec writes.
    before,_=reset()
    schedule=call('dbmt_erp_save_schedule',token,None,'2099-01-01','Session QA')
    assert schedule['ok'];renewed(before)
    before,_=reset()
    order=dict(id='qa_session_'+uuid.uuid4().hex,date='2099-01-01',product='Session QA')
    saved=call('dbmt_erp_write_work_order',token,order,None,False)
    assert saved['ok'];renewed(before)
    before,_=reset()
    assert call('dbmt_erp_write_work_order',token,order,None,False)['ok']
    assert heartbeat(conn,token)==before,'Idempotent retry without a write is not activity'
    conflict=call('dbmt_erp_write_work_order',token,dict(order,product='conflict'),'wrong-version',False)
    assert conflict['conflict']
    assert heartbeat(conn,token)==before,'Version conflict is not activity'
    # A denied action can create an audit record; that is not a business save.
    conn.execute('update public.erp_role_permissions set can_create=false where role_id=%s and menu_code=%s',(role,'product_specs'));flush()
    before,_=reset()
    assert not call('dbmt_erp_save_product_spec',token,None,record,None)['ok']
    assert heartbeat(conn,token)==before,'Permission-denied audit cannot renew'
    conn.execute('update public.erp_role_permissions set can_create=true where role_id=%s and menu_code=%s',(role,'product_specs'));flush()
    # Invalid/expired/inactive sessions never regain access or receive renewal.
    for change,args in [
        ("update public.erp_user_sessions set expires_at=now()-interval '1 second' where user_id=%s",(user,)),
        ('update public.erp_users set active=false where id=%s',(user,)),
        ('update public.erp_roles set active=false where id=%s',(role,))]:
        with conn.transaction(force_rollback=True):
            conn.execute(change,args);flush()
            state=heartbeat(conn,token)
            assert not call('dbmt_erp_save_product_spec',token,None,record,None)['ok']
            assert heartbeat(conn,token)==state
    with conn.transaction(force_rollback=True):
        assert call('dbmt_erp_logout',token)
        assert not call('dbmt_erp_session',token)['ok']
        assert not call('dbmt_erp_save_product_spec',token,None,record,None)['ok']
    for who in ['anon','authenticated']:
        for helper in ['collect_write_session()','commit_write_sessions()']:
            assert not conn.execute('select has_function_privilege(%s,%s,%s)',(who,'erp_session_private.'+helper,'execute')).fetchone()[0]
    triggers=conn.execute("select count(*),bool_and(tgdeferrable and tginitdeferred) from pg_trigger where tgname='dbmt_commit_write_sessions'").fetchone()
    assert triggers==(29,True),triggers
    # Preserve the old nonblocking login fix: no session-row write is attempted
    # during reads, and collection never locks authentication rows itself.
    assert conn.execute("select pg_get_functiondef('erp_session_private.touch_session(text)'::regprocedure) not ilike '%%update public.erp_user_sessions%%'").fetchone()[0]


def concurrency():
    # Independent transactions need visible fixtures. Only fictional QA users,
    # sessions and specs are briefly committed, then removed in finally.
    with connect() as setup:
        role = user = None
        trader = 'qa_concurrency_'+uuid.uuid4().hex
        try:
            with setup.transaction():
                role, user, token, login_id = fixture(setup)
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
                assert heartbeat(setup,token)[0] == initial[0]
                assert heartbeat(setup,token)[1] == initial[1]
            with setup.transaction():
                setup.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create) values(%s,'product_specs',true,true)",(role,))
            def save(index):
                with connect() as worker:
                    with worker.transaction():
                        worker.execute('set local role anon')
                        worker.execute("set local statement_timeout='3s'")
                        record=Jsonb(dict(trader=trader,material='QA '+str(index),origin='QA'))
                        result=worker.execute('select public.dbmt_erp_save_product_spec(%s,null,%s,null)',(token,record)).fetchone()[0]
                        assert result['ok']
                    return result['spec']['id']
            with ThreadPoolExecutor(max_workers=2) as pool:
                ids=list(pool.map(save,range(2)))
            assert len(set(ids))==2
            assert setup.execute('select count(*) from public.product_specs where trader=%s',(trader,)).fetchone()[0]==2
            assert setup.execute("select expires_at>now()+interval '23 hours' from public.erp_user_sessions where user_id=%s",(user,)).fetchone()[0]
            # Transaction-local identity must not remain on a reused connection.
            with setup.transaction():
                assert not setup.execute("select nullif(current_setting('dbmt.erp_session_hash',true),'')").fetchone()[0]
            # Verify the real HTTPS RPC/commit boundary too, without logging
            # credentials/tokens or touching an operating user's account.
            html=(ROOT/'index.html').read_text(encoding='utf-8')
            base=re.search(r"const SUPABASE_URL = '([^']+)'",html).group(1)
            key=re.search(r"const SUPABASE_PUBLISHABLE_KEY = '([^']+)'",html).group(1)
            def http_rpc(name,body):
                request=Request(base+'/rest/v1/rpc/'+name,data=json.dumps(body).encode(),
                    headers={'apikey':key,'Content-Type':'application/json'},method='POST')
                with urlopen(request,timeout=15) as response:return json.load(response)
            login=http_rpc('dbmt_erp_login',dict(p_login_id=login_id,p_login_password='0927'))
            assert login['ok']
            http_token=login['token']
            assert setup.execute("select expires_at=created_at+interval '24 hours' and expires_at>now()+interval '23 hours' from public.erp_user_sessions where token_hash=encode(extensions.digest(%s,'sha256'),'hex')",(http_token,)).fetchone()[0]
            setup.execute("update public.erp_user_sessions set expires_at=now()+interval '1 hour' where token_hash=encode(extensions.digest(%s,'sha256'),'hex')",(http_token,))
            before_http=heartbeat(setup,http_token)
            assert http_rpc('dbmt_erp_session',dict(p_token=http_token))['ok']
            assert heartbeat(setup,http_token)==before_http
            saved=http_rpc('dbmt_erp_save_product_spec',dict(p_token=http_token,p_id=None,
                p_record=dict(trader=trader,material='HTTPS QA',origin='QA'),p_revision=None))
            assert saved['ok']
            assert heartbeat(setup,http_token)[1]>before_http[1]+timedelta(hours=22)
        finally:
            if user:
                with setup.transaction():
                    setup.execute('delete from public.product_specs where trader=%s',(trader,))
                    setup.execute("delete from public.change_logs where payload->>'userId'=%s or (entity='ERP사용자' and entity_id=%s)",(str(user),str(user)))
                    setup.execute('delete from public.erp_users where id=%s', (user,))
                    setup.execute('delete from public.erp_roles where id=%s', (role,))
                assert not setup.execute('select 1 from public.erp_users where id=%s', (user,)).fetchone()


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER','')+os.environ.get('PGHOST',''):
        raise RuntimeError('Wrong project')
    installed = '--installed' in sys.argv
    with connect() as conn:
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='2s'")
            conn.execute("set local statement_timeout='5s'")
            pending=not installed and not conn.execute("select exists(select 1 from pg_trigger where tgname='dbmt_commit_write_sessions')").fetchone()[0]
            if pending:
                _,migration_user,migration_token,_=fixture(conn)
                conn.execute("update public.erp_user_sessions set created_at=now()-interval '2 hours',expires_at=now()+interval '10 hours' where user_id=%s",(migration_user,))
                conn.execute(SQL)
                assert conn.execute("select expires_at=now()+interval '22 hours' from public.erp_user_sessions where user_id=%s",(migration_user,)).fetchone()[0]
            checks(conn)
            rolling_checks(conn)
    if installed:
        concurrency()
    print(json.dumps(dict(ok=True,installed=installed,fixturesCleaned=True,
        tests='24-hour login and successful-write renewal, read/poll isolation, failed saves and rollback, same-user PC isolation, authentication/permissions/revocation, private trigger ACL, PIN preservation'+('; four reads ignore locked session, two parallel saves and live HTTPS RPC renewal' if installed else '; existing sessions migrate from original login time' if pending else '; deployed schema')), ensure_ascii=False))


if __name__ == '__main__':
    main()
