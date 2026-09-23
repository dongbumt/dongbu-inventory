"""Exercise production plans with fictional rows in a rolled-back transaction."""
import json
import os
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Production plan QA') returning id", ('qa_plan_'+suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'production_schedule',true,true,true,true)", (role,))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Production plan QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", ('qa_plan_'+suffix, uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))
    counts = conn.execute('select (select count(*) from transactions),(select count(*) from production_entries)').fetchone()

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.dbmt_erp_'+name+'('+','.join(['%s']*len(args))+')', tuple(Jsonb(v) if isinstance(v,dict) else v for v in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(fn, fragment):
        try:
            fn()
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: '+fragment)

    record = dict(date='2097-01-31',product='QA 돈등심',qty=123.45,trader='QA 납품처',note='3mm / 5KG 포장',status='planned')
    assert rpc('get_production_schedule', 'bad-token', '2097-01-01', '2097-02-06')['ok'] is False
    assert rpc('save_production_schedule', 'bad-token', None, record, None)['ok'] is False
    first = rpc('save_production_schedule', token, None, record, None)['event']
    second = rpc('save_production_schedule', token, None, dict(record, qty=None), None)['event']
    assert first['id'] != second['id'] and second['qty'] is None
    events = rpc('get_production_schedule', token, '2097-01-01', '2097-02-06')['events']
    assert {first['id'],second['id']} <= {e['id'] for e in events}
    changed = dict(record,date='2097-02-01',qty=50,status='completed')
    updated = rpc('save_production_schedule', token, first['id'], changed, 1)['event']
    assert updated['revision'] == 2 and updated['date']=='2097-02-01' and updated['status']=='completed'
    reject(lambda: rpc('save_production_schedule', token, first['id'], record, 1), '다른 사용자')
    reject(lambda: rpc('delete_production_schedule', token, first['id'], 1), '다른 사용자')
    for patch in [dict(product=' '),dict(qty=-1),dict(qty='abc'),dict(qty=1.234),dict(status='bad'),dict(date='')]:
        try:
            rpc('save_production_schedule', token, None, dict(record,**patch), None)
        except psycopg.Error:
            pass
        else:
            raise AssertionError('Invalid plan accepted: '+str(patch))
    conn.execute("update erp_role_permissions set can_create=false,can_update=false,can_delete=false where role_id=%s", (role,))
    assert rpc('get_production_schedule', token, '2097-01-01', '2097-02-06')['ok']
    assert rpc('save_production_schedule', token, None, record, None)['ok'] is False
    assert rpc('save_production_schedule', token, first['id'], record, 2)['ok'] is False
    assert rpc('delete_production_schedule', token, first['id'], 2)['ok'] is False
    conn.execute("update erp_role_permissions set can_view=false where role_id=%s", (role,))
    assert rpc('get_production_schedule', token, '2097-01-01', '2097-02-06')['ok'] is False
    try:
        with conn.transaction():
            conn.execute('set local role anon')
            conn.execute('select * from public.production_schedule')
    except psycopg.errors.InsufficientPrivilege:
        pass
    else:
        raise AssertionError('Direct unauthenticated table access allowed')
    conn.execute("update erp_role_permissions set can_view=true,can_delete=true where role_id=%s", (role,))
    assert rpc('delete_production_schedule', token, first['id'], 2)['ok']
    assert not conn.execute('select 1 from production_schedule where id=%s', (first['id'],)).fetchone()
    assert conn.execute('select (select count(*) from transactions),(select count(*) from production_entries)').fetchone() == counts
    assert conn.execute("select count(*) from change_logs where entity='생산일정' and entity_id=%s", (first['id'],)).fetchone()[0] == 3


def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER',''), 'Wrong project'
    root = Path(__file__).resolve().parent.parent
    schema = (root/'supabase/schema-rpc-46-production-schedule.sql').read_text(encoding='utf-8')
    assert schema == (root/'supabase/migrations/20260923090000_production_schedule.sql').read_text(encoding='utf-8')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_production_schedule_qa') as conn:
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            conn.execute(schema)
            fixture_tests(conn)
        if '--deploy' in sys.argv:
            with conn.transaction():
                conn.execute('set local role postgres')
                conn.execute("set local lock_timeout='10s'")
                conn.execute(schema)
    print(json.dumps(dict(ok=True,fixturesRolledBack=True,schemaDeployed='--deploy' in sys.argv,tests='CRUD, duplicate plans, month range, optional quantity, revision conflicts, permissions, validation, audit, no stock postings')))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__+': '+str(getattr(getattr(error,'diag',None),'message_primary',None) or error),file=sys.stderr)
        raise SystemExit(1)
