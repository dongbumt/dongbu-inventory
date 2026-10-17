"""Rollback-only actual label completion tests for optional consumed boxes.

Schema comes from stdin. --installed verifies an already installed schema.
Credentials are process-memory PG* values; never print them or fixture tokens.
"""
import copy
import json
import os
import sys
import traceback
import uuid

import psycopg
from psycopg.types.json import Jsonb


def tests(conn):
    suffix = uuid.uuid4().hex[:12]
    ident = lambda name: 'qa_wobox_' + suffix + '_' + name
    pin = '0927'  # Fictional rollback-only fixture PIN.
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    role, user = uuid.uuid4(), uuid.uuid4()
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Work-order box QA')", (role, ident('role')))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Work-order box QA','unused',%s)", (user, ident('user'), role))
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'production',true,true,true,true)", (role,))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    product = dict(id=ident('product'), name=ident('output'), packunit='20KG', taxType='면세')
    for key, value in [('workOrders', []), ('labelProducts', [product]), ('labelPrintLogs', [])]:
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload', (key, Jsonb(value)))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                  tuple(Jsonb(a) if isinstance(a, (dict, list)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(call, fragment=''):
        try:
            with conn.transaction():
                call()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001', '42501', '28000'), error.sqlstate
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    def normalize(order):
        return conn.execute('select public.dbmt_work_order_source_inputs(%s)', (Jsonb(order),)).fetchone()[0]

    def factory(name, counts=(1, 2), legacy=False, top='missing'):
        source_a = dict(key=ident(name + '_raw_a'), product=ident('raw_a'), lot=name + '-A', origin='국내산',
                        packunit='벌크', proddate='2026-10-01', stockLocation='가공장', price=4000, stock=100, stockBoxes=4)
        source_b = dict(key=ident(name + '_raw_b'), product=ident('raw_b'), lot=name + '-B', origin='미국산',
                        packunit='벌크', proddate='2026-10-01', stockLocation='가공장', price=6000, stock=100, stockBoxes=5)
        inputs = [dict(sourceStockKey=source_a['key'], sourceStock=source_a, inputWeight=40),
                  dict(sourceStockKey=source_b['key'], sourceStock=source_b, inputWeight=60)]
        for source, count in zip(inputs, counts):
            if count != 'missing':
                source['boxCount'] = count
        order = dict(id=ident(name), date='2026-10-17', title='QA optional input boxes', product=product['name'],
                     labelProductId=product['id'], packunit=product['packunit'], inputWeight=100,
                     weight=20, lot='QA-' + name, origin='국내산', mfgdate='2026-10-17', expdate='2027-10-16',
                     temptype='냉동', sourceStock=source_a)
        if legacy:
            if top != 'missing':
                order['inputBoxCount'] = top
        else:
            order['sourceInputs'] = inputs
            order['inputBoxCount'] = sum(counts) if all(isinstance(n, int) for n in counts) else None
        conn.execute("update public.app_data set payload=payload||%s where key='workOrders'", (Jsonb([order]),))
        snapshot = copy.deepcopy(order)
        if snapshot.get('inputBoxCount') is None:
            snapshot.pop('inputBoxCount', None)  # Actual UI snapshot omits unknown top-level count.
        prefix = uuid.uuid4().hex[:5].upper()
        logs = [dict(id=ident(name + '_label_' + str(i)), code='DB2610171200-' + prefix + str(i),
                     workOrderId=order['id'], product=order['product'], lot=order['lot'], labelWeight=20,
                     inputWeight=100, status='active', printedAt='2026-10-17T03:00:00Z', batchId=ident(name + '_batch'),
                     workOrderSnapshot=copy.deepcopy(snapshot)) for i in range(5)]
        assert rpc('dbmt_label_print_save_logs', pin, logs)['ok']
        return order, logs

    def complete(order, logs):
        result = rpc('dbmt_label_complete_production', pin, order['id'], [l['id'] for l in logs])
        assert result['ok']
        pid = result['productionId']
        journal = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
        posting = conn.execute("select raw from public.transactions where prod_id=%s and type='사용' and deleted_at is null order by id", (pid,)).fetchall()
        posting = [r[0] for r in posting]
        assert sum(o['qty'] for o in journal['outputs']) == 100
        assert sum(o['boxCount'] for o in journal['outputs']) == 5, 'Output boxes still come from active outer labels'
        expected_weights = [100] if 'sourceInputs' not in order else [40, 60]
        assert [i['qty'] for i in journal['inputs']] == expected_weights
        assert [i['weight'] for i in posting] == expected_weights
        assert sum(i['amount'] for i in journal['inputs']) == (400000 if len(expected_weights) == 1 else 520000)
        assert sum(i['amount'] for i in posting) == (400000 if len(expected_weights) == 1 else 520000)
        assert journal['inputs'][0]['price'] == 4000
        if len(expected_weights) == 2:
            assert journal['inputs'][1]['price'] == 6000
        assert rpc('dbmt_label_complete_production', pin, order['id'], [l['id'] for l in logs])['alreadyCompleted']
        return pid, journal, posting

    # Pure normalizer: no old or unknown count can become zero implicitly.
    assert 'boxCount' not in normalize(dict(sourceStock={}, inputWeight=1))[0]
    assert 'boxCount' not in normalize(dict(sourceStock={}, inputWeight=1, inputBoxCount=None))[0]
    assert normalize(dict(sourceStock={}, inputWeight=1, inputBoxCount=0))[0]['boxCount'] == 0
    assert normalize(dict(sourceInputs=[dict(sourceStock={}, inputWeight=1, boxCount=None)]))[0]['boxCount'] is None
    for invalid in [-1, 1.5, '2', '', True, {}, [], 1000000000]:
        reject(lambda invalid=invalid: normalize(dict(sourceInputs=[dict(sourceStock={}, inputWeight=1, boxCount=invalid)])), '투입 박스수')
    reject(lambda: normalize(dict(sourceInputs=[dict(sourceStock={'stockBoxes': 1}, inputWeight=1, boxCount=2)])), '재고의 박스수보다')
    assert normalize(dict(sourceInputs=[dict(sourceStock={'stockBoxes': None}, inputWeight=1, boxCount=2)]))[0]['boxCount'] == 2
    assert normalize(dict(sourceInputs=[dict(sourceStock={}, inputWeight=1, boxCount=999999999)]))[0]['boxCount'] == 999999999

    order, logs = factory('known')
    with conn.transaction(force_rollback=True):
        changed = copy.deepcopy(order)
        changed['sourceInputs'][0]['boxCount'] = 2
        conn.execute("update public.app_data set payload=(select jsonb_agg(case when e->>'id'=%s then %s else e end) from jsonb_array_elements(payload) e) where key='workOrders'", (order['id'], Jsonb(changed)))
        reject(lambda: complete(order, logs), '변경')
        assert not conn.execute('select exists(select 1 from public.label_production_completions where work_order_id=%s)', (order['id'],)).fetchone()[0]
    pid, journal, posting = complete(order, logs)
    assert [i['boxCount'] for i in journal['inputs']] == [1, 2]
    assert [i['boxCount'] for i in posting] == [1, 2]
    assert rpc('dbmt_label_cancel_production', pin, order['id'], pid)['ok']
    next_pid = rpc('dbmt_label_resubmit_production', pin, order['id'], [l['id'] for l in logs], pid)['productionId']
    assert next_pid != pid
    next_entry = conn.execute('select raw from public.production_entries where id=%s', (next_pid,)).fetchone()[0]
    assert [i['boxCount'] for i in next_entry['inputs']] == [1, 2]
    assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null', (pid,)).fetchone()[0] == 0

    for name, counts in [('missing', (1, 'missing')), ('unknown', (None, 2)), ('zero', (0, 2))]:
        case_order, case_logs = factory(name, counts)
        _, case_entry, case_posting = complete(case_order, case_logs)
        for actual, expected in zip(case_entry['inputs'], counts):
            assert ('boxCount' not in actual) if expected == 'missing' else actual['boxCount'] == expected
        for actual, expected in zip(case_posting, counts):
            assert ('boxCount' not in actual) if expected == 'missing' else actual['boxCount'] == expected

    for name, top in [('legacy_missing', 'missing'), ('legacy_null', None), ('legacy_zero', 0), ('legacy_known', 3)]:
        legacy_order, legacy_logs = factory(name, legacy=True, top=top)
        legacy_pid, legacy_entry, legacy_posting = complete(legacy_order, legacy_logs)
        if top in ('missing', None):
            assert 'boxCount' not in legacy_entry['inputs'][0] and 'boxCount' not in legacy_posting[0]
        else:
            assert legacy_entry['inputs'][0]['boxCount'] == top and legacy_posting[0]['boxCount'] == top
        if top == 'missing':
            assert rpc('dbmt_label_cancel_production', pin, legacy_order['id'], legacy_pid)['ok']
            replacement = rpc('dbmt_label_resubmit_production', pin, legacy_order['id'], [l['id'] for l in legacy_logs], legacy_pid)['productionId']
            replacement_entry = conn.execute('select raw from public.production_entries where id=%s', (replacement,)).fetchone()[0]
            assert 'boxCount' not in replacement_entry['inputs'][0]
    assert not conn.execute("select has_function_privilege('anon','public.dbmt_work_order_source_inputs(jsonb)','execute')").fetchone()[0]
    return 'Optional per-source boxes 1/2/0/null/missing; malformed/range/snapshot limits; immutable snapshot mismatch; actual consumption postings; exact weights/costs; output-label counts; legacy top-level 0/null/missing; cancel/resubmit'


def main():
    if '--apply' in sys.argv:
        raise RuntimeError('This verifier never deploys or preserves fixture records.')
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', '') + os.environ.get('PGHOST', ''):
        raise RuntimeError('Wrong linked project')
    sql = '' if '--installed' in sys.argv else sys.stdin.buffer.read().decode('utf-8-sig')
    if '--installed' not in sys.argv and 'v_source_input' not in sql:
        raise RuntimeError('Expected additive input-box schema on stdin')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_workorder_boxes_rollback_qa') as conn:
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='45s'")
            if sql:
                conn.execute(sql)
                conn.execute(sql)  # Installation is safe to retry without adding another copy.
            definition = conn.execute("select pg_get_functiondef('public.dbmt_label_complete_production(text,text,jsonb)'::regprocedure)").fetchone()[0]
            assert '투입 예정량' not in definition
            checks = tests(conn)
        conn.execute('set role postgres')
        remaining = conn.execute("""select
          (select count(*) from public.production_entries where left(product,9)='qa_wobox_'),
          (select count(*) from public.transactions where left(product,9)='qa_wobox_'),
          (select count(*) from public.label_production_completions where left(work_order_id,9)='qa_wobox_'),
          (select count(*) from public.label_production_completion_history where left(work_order_id,9)='qa_wobox_'),
          (select count(*) from public.erp_users where left(login_id,9)='qa_wobox_'),
          (select count(*) from public.erp_roles where left(code,9)='qa_wobox_'),
          (select count(*) from public.app_data a cross join lateral jsonb_array_elements(
             case when jsonb_typeof(a.payload)='array' then a.payload else '[]'::jsonb end) e
             where a.key in('workOrders','labelProducts','labelPrintLogs') and left(e->>'id',9)='qa_wobox_')
          """).fetchone()
        assert all(n == 0 for n in remaining), 'Unexpected fixture residue'
    print(json.dumps(dict(ok=True, schemaApplied=False, allChangesRolledBack=True,
                         remainingFixtures=list(remaining), tests=checks), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        if isinstance(error, AssertionError):
            for frame in traceback.extract_tb(error.__traceback__):
                print('Assertion location: ' + frame.filename + ':' + str(frame.lineno), file=sys.stderr)
        if isinstance(error, psycopg.Error):
            print('SQL context: ' + str(error.diag.context), file=sys.stderr)
        raise SystemExit(1)
