"""Apply only the PIN function definition with --apply. All test data rolls back.
SQL comes from stdin; PG credentials are resolved by the linked CLI wrapper.
"""
import json
import os
import sys
import uuid

import psycopg


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    login_id, employee_id = 'qapin' + suffix, 'qa_pin_' + suffix
    role = conn.execute("insert into public.erp_roles(code,name) values (%s,'Driver PIN QA') returning id",
                        ('qapin_' + suffix,)).fetchone()[0]
    conn.execute("""insert into public.erp_role_permissions(role_id,menu_code,can_view,can_admin)
      values (%s,'driver_attendance',true,true)""", (role,))
    user = conn.execute("""insert into public.erp_users(login_id,display_name,password_hash,role_id)
      values (%s,'Driver PIN QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id""",
      (login_id, uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("""insert into public.erp_user_sessions(token_hash,user_id,expires_at)
      values (encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')""", (token,user))

    def rpc(query, params):
        with conn.transaction():
            # Each RPC normally starts a fresh HTTP transaction, without legacy authorization.
            conn.execute("set local dbmt.personal_authorized = 'false'")
            conn.execute('set local role anon')
            value = conn.execute(query, params).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    save_query = 'select public.dbmt_erp_driver_admin_save_account(%s,%s,%s,%s,%s,%s)'

    def save(password, active=True, session=token):
        return rpc(save_query, (session,employee_id,'Driver PIN QA',login_id,password,active))

    def rejected(callback, expected=None):
        try:
            callback()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001','42501'), error.sqlstate
            if expected:
                assert expected in error.diag.message_primary
        else:
            raise AssertionError('Request must be rejected')

    def login(password):
        return rpc('select public.dbmt_driver_login(%s,%s)', (login_id,password))

    def session_account(driver_token):
        return conn.execute('select public.dbmt_driver_session_account(%s)', (driver_token,)).fetchone()[0]

    rejected(lambda: save('0123',session='invalid-token'))
    rejected(lambda: rpc('select public.dbmt_driver_admin_save_account(%s,%s,%s,%s,%s,true)',
                        ('invalid-password',employee_id,'Driver PIN QA',login_id,'0123')))
    invalid = [None,'','123','12345','abcd','12a4',' 123','1234 ','１２３４','123\n','1234\n','1234\r\n']
    for password in invalid:
        rejected(lambda: save(password), '숫자 4자리')
    account = save('0123')['id']
    first_login = login('0123')
    assert first_login['ok'] and str(session_account(first_login['token'])) == account
    assert not login('123')['ok'], 'Leading zero must be preserved'
    for password in invalid[2:]:
        rejected(lambda: save(password), '숫자 4자리')
    assert str(session_account(first_login['token'])) == account, 'Rejected changes must preserve sessions'
    for blank in (None,''):
        assert save(blank)['ok']
        assert str(session_account(first_login['token'])) == account
    assert save('9876')['ok']
    assert session_account(first_login['token']) is None, 'Password change must invalidate sessions'
    assert not login('0123')['ok'] and login('9876')['ok']
    assert save(None,active=False)['ok'] and not login('9876')['ok']
    assert save(None,active=True)['ok'] and login('9876')['ok']

    # Represent an existing legacy account; never change a real account.
    legacy = 'Legacy-' + uuid.uuid4().hex
    conn.execute("update public.driver_accounts set password_hash=extensions.crypt(%s,extensions.gen_salt('bf')) where id=%s",
                 (legacy,account))
    original_hash = conn.execute('select password_hash from public.driver_accounts where id=%s', (account,)).fetchone()[0]
    for blank in (None,''):
        assert save(blank)['ok'] and login(legacy)['ok']
        assert conn.execute('select password_hash from public.driver_accounts where id=%s', (account,)).fetchone()[0] == original_hash
    assert save('0000')['ok'] and login('0000')['ok']
    conn.execute('update public.erp_role_permissions set can_admin=false where role_id=%s', (role,))
    rejected(lambda: save('4321'))
    for _ in range(5):
        assert not login('wrong-password')['ok']
    assert not login('0000')['ok'], 'Existing failed-login lockout must remain effective'


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER',''):
        raise RuntimeError('Wrong linked database project')
    sql = sys.stdin.buffer.read().decode('utf-8-sig')
    if 'create or replace function public.dbmt_driver_admin_save_account(' not in sql:
        raise RuntimeError('Expected driver PIN schema on stdin')
    apply = '--apply' in sys.argv
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,
                        application_name='dbmt_driver_pin_check') as conn:
        with conn.transaction(force_rollback=not apply):
            conn.execute('set local role postgres')
            conn.execute(sql)
            with conn.transaction(force_rollback=True):
                fixture_tests(conn)
    print(json.dumps({'ok':True,'schemaApplied':apply,'fixturesRolledBack':True,
                      'tests':'four digits, leading zeros, legacy login, blank edit, session invalidation, permissions, lockout'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error,'diag',None),'message_primary',None) or error),file=sys.stderr)
        sys.exit(1)
