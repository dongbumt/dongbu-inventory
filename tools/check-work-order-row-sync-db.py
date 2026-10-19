"""Rollback-only row save, cross-client conflict and authorization checks."""
import json
import os
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb


def tests(conn):
    prefix = 'qa_worow_' + uuid.uuid4().hex[:12]
    role, user = uuid.uuid4(), uuid.uuid4()
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Work order row QA')", (role, prefix))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Work order row QA','unused',%s)", (user, prefix, role))
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'workorders',true,true,true,true)", (role,))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    conn.execute("update public.app_data set payload='[]'::jsonb where key='workOrders'")

    def rpc(name, *args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                  tuple(Jsonb(a) if isinstance(a, (list, dict)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(call, fragment):
        try:
            with conn.transaction():
                call()
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    get = lambda revision=None: rpc('dbmt_erp_get_work_orders', token, revision)
    write = lambda row, version=None, remove=False: rpc('dbmt_erp_write_work_order', token, row, version, remove)
    row = lambda name: dict(id=prefix+'_'+name, date='2026-10-19', product='QA '+name, title=name,
                            inputWeight=100, inputBoxCount=5, sourceInputs=[dict(sourceStockKey='qa-source',
                            sourceStock=dict(key='qa-source', stockBoxes=5), inputWeight=100, boxCount=5)])

    # Two PCs start from the same empty list, then save different records.
    a, b = row('A'), row('B')
    start = get()
    assert start['rows'] == []
    assert get(start['revision'])['unchanged']
    saved_a = write(a)
    saved_b = write(b)
    assert {e['id'] for e in saved_b['rows']} == {a['id'], b['id']}
    assert len(write(a)['rows']) == 2, 'Lost-response create retry must not duplicate rows'
    va, vb = saved_b['versions'][a['id']], saved_b['versions'][b['id']]
    updated_a, updated_b = dict(a, title='PC A updated'), dict(b, title='PC B updated')
    changed = write(updated_a, va)
    both = write(updated_b, vb)
    assert {e['title'] for e in both['rows']} == {'PC A updated', 'PC B updated'}
    assert write(dict(a, title='stale same-row edit'), va)['conflict']
    assert write({'id': a['id']}, va, True)['conflict']
    assert write(updated_a, va)['ok'], 'Exact successful retry is safe even with old version'
    assert get(start['revision'])['revision'] == both['revision']
    deleted = write({'id': a['id']}, changed['versions'][a['id']], True)
    assert [e['id'] for e in deleted['rows']] == [b['id']]
    assert write(dict(updated_a, title='must not resurrect'), changed['versions'][a['id']])['conflict']
    assert write({'id': a['id']}, changed['versions'][a['id']], True)['ok']
    reject(lambda: rpc('dbmt_erp_save_app_data', token, {'workOrders': [a]}), '건별 저장')
    # Old bulk clients cannot erase the server list; unrelated categories still save.
    assert [e['id'] for e in get()['rows']] == [b['id']]
    reject(lambda: rpc('dbmt_erp_get_work_orders', 'invalid-token', None), '로그인')
    reject(lambda: write([], None), '저장 형식')
    reject(lambda: write({'id': ''}), '식별값')
    reject(lambda: write(dict(row('bad'), product='')), '제품명')
    reject(lambda: write(dict(row('boxes'), sourceInputs=[dict(sourceStock={}, inputWeight=1, boxCount=-1)])), '투입 박스수')
    # Permissions are rechecked for every request, not only at page initialization.
    conn.execute("update public.erp_role_permissions set can_update=false,can_delete=false where role_id=%s and menu_code='workorders'", (role,))
    reject(lambda: write(dict(updated_b, title='forbidden'), both['versions'][b['id']]), '권한')
    reject(lambda: write({'id': b['id']}, both['versions'][b['id']], True), '권한')
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='workorders'", (role,))
    reject(lambda: get(), '권한')
    reject(lambda: write(row('forbidden')), '권한')
    assert not conn.execute("select has_function_privilege('anon','public.dbmt_work_order_snapshot(jsonb)','execute')").fetchone()[0]
    return 'Two stale clients retain different rows; same-row update/delete conflicts; safe create/update/delete retries; no resurrection; conditional reads; old bulk blocked; invalid inputs; per-request permissions; private helper'


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', '') + os.environ.get('PGHOST', ''):
        raise RuntimeError('Wrong linked project')
    sql = '' if '--installed' in sys.argv else sys.stdin.buffer.read().decode('utf-8-sig')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_work_order_row_rollback_qa') as conn:
        conn.execute('set role postgres')
        before = conn.execute("select md5(payload::text) from public.app_data where key='workOrders'").fetchone()[0]
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='30s'")
            if sql:
                conn.execute(sql)
                conn.execute(sql)
            checks = tests(conn)
        after = conn.execute("select md5(payload::text) from public.app_data where key='workOrders'").fetchone()[0]
        assert before == after, 'Real work orders must remain unchanged by verification'
        remaining = conn.execute("""select
          (select count(*) from public.erp_users where login_id like 'qa_worow_%'),
          (select count(*) from public.erp_roles where code like 'qa_worow_%'),
          (select count(*) from public.change_logs where entity='workorders' and payload->>'id' like 'qa_worow_%')""").fetchone()
        assert not any(remaining), 'Unexpected fixture residue'
    print(json.dumps(dict(ok=True, allChangesRolledBack=True, realWorkOrdersUnchanged=True,
                         remainingFixtures=list(remaining), tests=checks), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        if isinstance(error, psycopg.Error):
            print('SQL context: '+str(error.diag.context), file=sys.stderr)
        raise SystemExit(1)
