"""Actual label/PDA RPC regression. Schema and fictional fixtures ALWAYS roll back.

Pass additive split schema on stdin, or use --installed for deployed-schema checks.
Never use this verifier to deploy. Credentials come from PG* environment only.
"""
import copy
import json
import os
import sys
import traceback
import uuid
from decimal import Decimal

import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda kind: 'qa_split_' + suffix + '_' + kind
    pin = '0927'  # Rollback-contained fictional PIN, never an operator credential.
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    role, user, partner = (uuid.uuid4() for _ in range(3))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Label split QA')", (role, uid('role')))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Label split QA','unused',%s)", (user, uid('user'), role))
    for menu in ['production', 'transactions', 'stock', 'pda']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)", (role, menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매출')", (partner, 'Q' + suffix.upper(), uid('partner')))
    source = dict(key=uid('raw'), product=uid('raw_product'), lot='QA-RAW', origin='국내산', packunit='벌크',
                  proddate='2026-10-01', stockLocation='가공장', price=5000, stock=100)
    order = dict(id=uid('order'), date='2026-10-17', title='QA label splitting', product=uid('output'),
                 labelProductId=uid('product'), inputWeight=100, weight=20, lot='QA-OUTPUT', origin='국내산', packunit='20KG', grade='',
                 mfgdate='2026-10-17', expdate='2027-10-16', temptype='냉동', note='원본 생산 메모', sourceStock=source)
    foreign = dict(order, id=uid('foreign_order'), product=uid('foreign_product'))
    products = [dict(id=order['labelProductId'], name=order['product'], packunit='20KG', taxType='면세')]
    for key, value in [('workOrders', [order, foreign]), ('labelProducts', products), ('labelPrintLogs', [])]:
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
                result = call()
                if isinstance(result, dict) and result.get('ok') is False:
                    assert fragment in str(result.get('message') or result.get('error') or ''), result
                    return
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001', '42501', '28000'), error.sqlstate
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    prefix = uuid.uuid4().hex[:5].upper()
    logs = [dict(id=uid('label' + str(i)), code='DB2610171200-' + prefix + str(i), workOrderId=order['id'],
                 product=order['product'], labelWeight=20, status='active', reprintCount=i,
                 printedAt='2026-10-17T03:' + ('00' if i < 2 else '01') + ':00Z', batchId=uid('batch' + ('A' if i < 2 else 'B')),
                 workOrderSnapshot={**order, 'weight': 20}) for i in range(5)]
    foreign_log = {**logs[0], 'id': uid('foreign_label'), 'code': 'DB2610171200-' + prefix + 'F',
                   'workOrderId': foreign['id'], 'workOrderSnapshot': foreign}
    assert rpc('dbmt_label_print_save_logs', pin, logs)['ok']
    pid = rpc('dbmt_label_complete_production', pin, order['id'], [r['id'] for r in logs])['productionId']
    before = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    stock = before['outputs'][0]['stockRowId']
    assert before['outputs'][0]['qty'] == 100 and before['outputs'][0]['boxCount'] == 5

    def get(source_id=stock, production_id=pid, session=token):
        return rpc('dbmt_erp_get_label_split', session, production_id, source_id)

    def split(ids, source_id=stock, version=None, request=None, production_id=pid, session=token):
        return rpc('dbmt_erp_split_label_stock', session, production_id, source_id, ids,
                   get(source_id, production_id)['version'] if version is None else version, request or uuid.uuid4())

    def entry(production_id=pid):
        return conn.execute('select raw from public.production_entries where id=%s', (production_id,)).fetchone()[0]

    def lookup(index=0):
        return rpc('dbmt_pda_lookup', token, logs[index]['code'])['item']

    def scan(index=0):
        item = lookup(index)
        return dict(barcode=item['code'], revision=item['revision'])

    def pda(mode, items, request=None):
        return rpc('dbmt_pda_commit', token, request or uuid.uuid4(), mode, '가공장', partner if mode == 'outbound' else None,
                   '2026-10-17', items, 'QA label split')

    def immutable_totals(value):
        return (value['inputs'], sum(Decimal(str(o['qty'])) for o in value['outputs']),
                sum(Decimal(str(o['boxCount'])) for o in value['outputs']),
                sum(Decimal(str(o['amount'])) for o in value['outputs']))

    original_totals = immutable_totals(before)
    original_logs = conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    initial = get()
    assert initial['canSplit'] and len(initial['labels']) == 5, 'Initial eligibility: ' + str(initial.get('reason')) + '; label count=' + str(len(initial.get('labels', [])))
    assert Decimal(str(initial['totalWeight'])) == 100 and initial['boxCount'] == 5
    assert {row['id'] for row in initial['labels']} == {row['id'] for row in logs}
    assert all(lookup(i)['stockRowId'] == stock for i in range(5))
    assert conn.execute('select count(*) from public.pda_packages where production_id=%s', (pid,)).fetchone()[0] == 0
    reject(lambda: get(session='invalid-token'))
    reject(lambda: split([logs[0]['id']], version=initial['version'], session='invalid-token'))
    for field in ['can_view', 'can_update']:
        with conn.transaction(force_rollback=True):
            conn.execute('update public.erp_role_permissions set ' + field + '=false where role_id=%s and menu_code=\'production\'', (role,))
            if field == 'can_view':
                reject(get)
            else:
                assert get()['canSplit'] is False
            reject(lambda: split([logs[0]['id']], version=initial['version']))
    for invalid in [[], [l['id'] for l in logs], [logs[0]['id'], logs[0]['id']], [logs[0]['id'], foreign_log['id']], ['missing']]:
        reject(lambda invalid=invalid: split(invalid, version=initial['version']))
        assert entry() == before, 'Rejected subset cannot change production'
    reject(lambda: split([logs[0]['id']], version='stale-version'), '변경')

    # Every downstream stock consumer blocks splitting, including a zero-quantity identity reference.
    for kind in ['출고', '사용', '재고이동', '재고조정']:
        with conn.transaction(force_rollback=True):
            raw = dict(id=uid('dependent'), stockRowId=stock, product=order['product'], weight=1,
                       stockLocation='가공장', fromLocation='가공장', toLocation='외부창고')
            conn.execute('insert into public.transactions(id,date,type,product,weight,stock_location,from_location,to_location,raw) values(%s,\'2026-10-17\',%s,%s,1,\'가공장\',\'가공장\',\'외부창고\',%s)',
                         (raw['id'], kind, order['product'], Jsonb(raw)))
            blocked = get()
            assert not blocked['canSplit'], kind
            reject(lambda: split([logs[0]['id']], version=blocked['version']))
            assert entry() == before
    for multi in [False, True]:
        with conn.transaction(force_rollback=True):
            reserved = dict(id=uid('reserved'), sourceStock=dict(stockRowId=stock), inputWeight=10)
            if multi:
                reserved = dict(id=uid('reserved'), sourceInputs=[dict(sourceStock=dict(stockRowId=stock), inputWeight=10)])
            conn.execute("update public.app_data set payload=payload||%s where key='workOrders'", (Jsonb([reserved]),))
            assert not get()['canSplit'], 'Pending work-order stock reservation blocks split'
            reject(lambda: split([logs[0]['id']], version=initial['version']))
    with conn.transaction(force_rollback=True):
        pda('inbound', [scan()])
        assert not get()['canSplit']
        reject(lambda: split([logs[0]['id']], version=initial['version']), 'PDA')

    # Note changes remain editable and invalidate a previously loaded version.
    changed = copy.deepcopy(before)
    changed['outputs'][0]['note'] = '거래처 A 분할 전 확인'
    assert rpc('dbmt_erp_save_production', token, changed, [], pid)['ok']
    reject(lambda: split([logs[0]['id']], version=initial['version']), '변경')
    loaded = get()
    # If the final audit write fails, journal rows, stock bindings and receipt all roll back.
    with conn.transaction(force_rollback=True):
        audit_name = 'qa_split_audit_' + suffix
        conn.execute('create function public.' + audit_name + "() returns trigger language plpgsql as $$ begin if new.action='라벨 분할' then raise exception 'QA split audit failure'; end if; return new; end $$")
        conn.execute('create trigger ' + audit_name + ' before insert on public.change_logs for each row execute function public.' + audit_name + '()')
        atomic_request = uuid.uuid4()
        saved_entry = entry()
        reject(lambda: split([logs[0]['id']], version=loaded['version'], request=atomic_request), 'QA split audit failure')
        assert entry() == saved_entry
        assert conn.execute('select count(*) from public.label_stock_assignments where production_id=%s', (pid,)).fetchone()[0] == 0
        assert not conn.execute('select 1 from public.label_stock_split_requests where id=%s', (atomic_request,)).fetchone()
        assert all(lookup(i)['stockRowId'] == stock for i in range(5))
    request = uuid.uuid4()
    result = split([logs[0]['id'], logs[1]['id']], version=loaded['version'], request=request)
    assert result['ok']
    first = result['splitStockRowId']
    remaining = result['remainingStockRowId']
    after = entry()
    assert result['entry'] == after
    assert immutable_totals(after) == original_totals, 'Input, total weight, boxes and total cost stay exact'
    by_stock = {row['stockRowId']: row for row in after['outputs']}
    assert (by_stock[first]['qty'], by_stock[first]['boxCount']) == (40, 2)
    assert (by_stock[remaining]['qty'], by_stock[remaining]['boxCount']) == (60, 3)
    assert all(o['product'] == order['product'] and o['lot'] == 'QA-OUTPUT' for o in after['outputs'])
    assert all(o['price'] == before['outputs'][0]['price'] for o in after['outputs'])
    posted = conn.execute("select weight,raw from public.transactions where prod_id=%s and type='생산입고' and deleted_at is null", (pid,)).fetchall()
    assert sorted((float(w), int(row['boxCount'])) for w, row in posted) == [(40, 2), (60, 3)]
    assert len({row['stockRowId'] for _, row in posted}) == 2
    assert all(lookup(i)['stockRowId'] == (first if i < 2 else remaining) for i in range(5)), 'Before first PDA receive, every barcode resolves its split row'
    assert conn.execute('select count(*) from public.pda_packages where production_id=%s', (pid,)).fetchone()[0] == 0
    assert conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0] == original_logs, 'Immutable print snapshots/barcodes are preserved'
    assert split([logs[1]['id'], logs[0]['id']], version=loaded['version'], request=request)['alreadySaved']
    assert entry() == after, 'Unknown-result retry cannot split twice'
    reject(lambda: split([logs[0]['id']], version=loaded['version'], request=request))
    reject(lambda: split([logs[2]['id']], source_id=first))
    assert {r['id'] for r in get(first)['labels']} == {logs[0]['id'], logs[1]['id']}
    assert {r['id'] for r in get(remaining)['labels']} == {l['id'] for l in logs[2:]}

    # Actual outbound posting hits only the selected group's stock identity.
    with conn.transaction(force_rollback=True):
        shipped = pda('outbound', [scan(0)])
        tx_id = shipped['items'][0]['transactionId']
        posting = conn.execute('select weight,raw from public.transactions where id=%s', (tx_id,)).fetchone()
        assert float(posting[0]) == 20 and posting[1]['stockRowId'] == first and posting[1]['boxCount'] == 1
        assert conn.execute('select pda_private.balance(%s,\'가공장\')', (first,)).fetchone()[0] == 20
        assert conn.execute('select pda_private.balance(%s,\'가공장\')', (remaining,)).fetchone()[0] == 60
        assert lookup(1)['stockRowId'] == first and lookup(2)['stockRowId'] == remaining
        assert not get(remaining)['canSplit'], 'Any PDA registration in the journal protects all its groups'
        reject(lambda: split([logs[2]['id']], source_id=remaining), 'PDA')
        assert pda('inbound', [scan(0)])['returned'] == 1
        assert lookup(0)['stockRowId'] not in [first, remaining], 'PDA return keeps its separate receipt source'
        edited = copy.deepcopy(after)
        edited['outputs'][0]['note'] = 'PDA 출고 이후 비고 수정'
        # Existing PDA workflow blocks journal replacement after package processing,
        # including its transient soft-delete on a note-only save. Keep that guard.
        reject(lambda: rpc('dbmt_erp_save_production', token, edited, [], pid), 'PDA')

    # Office edits can label groups in the existing note column, never manually reallocate barcodes.
    edited = copy.deepcopy(after)
    for row in edited['outputs']:
        row['note'] = '선택 그룹' if row['stockRowId'] == first else '잔여 그룹'
    saved = rpc('dbmt_erp_save_production', token, edited, [], pid)
    assert saved['ok'] and immutable_totals(saved['entry']) == original_totals
    for field, value in [('qty', 39), ('boxCount', 1), ('product', '임의 품명'), ('lot', 'IMPOSTOR'), ('stockRowId', uid('forged'))]:
        malformed = copy.deepcopy(saved['entry'])
        malformed['outputs'][0][field] = value
        reject(lambda: rpc('dbmt_erp_save_production', token, malformed, [], pid))
        assert immutable_totals(entry()) == original_totals
    malformed = copy.deepcopy(saved['entry'])
    malformed['outputs'].pop()
    reject(lambda: rpc('dbmt_erp_save_production', token, malformed, [], pid))

    # Split a previously divided group again; earlier groups/barcodes stay unchanged.
    second = split([logs[0]['id']], source_id=first)
    third = second['splitStockRowId']
    first_remainder = second['remainingStockRowId']
    repeated = entry()
    assert sorted((o['qty'], o['boxCount']) for o in repeated['outputs']) == [(20, 1), (20, 1), (60, 3)]
    assert immutable_totals(repeated) == original_totals
    assert lookup(0)['stockRowId'] == third and lookup(1)['stockRowId'] == first_remainder
    assert all(lookup(i)['stockRowId'] == remaining for i in range(2, 5))
    assert not get(third)['canSplit'], 'One label alone cannot be split'

    # Old idempotent receipts must never leak their cancelled bindings into a successor.
    cancelled = rpc('dbmt_label_cancel_production', pin, order['id'], pid)
    assert cancelled['ok']
    reject(lambda: get(production_id=pid))
    assert split([logs[0]['id'], logs[1]['id']], version=loaded['version'], request=request)['alreadySaved']
    assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null', (pid,)).fetchone()[0] == 0, 'Old receipt replay cannot resurrect cancelled stock'
    successor = rpc('dbmt_label_resubmit_production', pin, order['id'], [l['id'] for l in logs], pid)['productionId']
    assert successor != pid
    successor_entry = entry(successor)
    assert len(successor_entry['outputs']) == 1 and immutable_totals(successor_entry) == original_totals
    successor_stock = successor_entry['outputs'][0]['stockRowId']
    assert successor_stock not in [stock, first, remaining, third]
    assert all(lookup(i)['stockRowId'] == successor_stock for i in range(5))
    successor_data = get(successor_stock, successor)
    assert successor_data['canSplit'] and len(successor_data['labels']) == 5
    assert split([logs[0]['id'], logs[1]['id']], version=loaded['version'], request=request)['alreadySaved']
    assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null', (pid,)).fetchone()[0] == 0
    successor_result = split([logs[3]['id'], logs[4]['id']], source_id=successor_stock,
                             production_id=successor, version=successor_data['version'])
    assert successor_result['ok'] and immutable_totals(entry(successor)) == original_totals
    assert all(lookup(i)['stockRowId'] == (successor_result['splitStockRowId'] if i > 2 else successor_result['remainingStockRowId']) for i in range(5))
    assert conn.execute("select has_function_privilege('anon','public.dbmt_erp_get_label_split(text,text,text)','execute')").fetchone()[0]
    assert conn.execute("select has_function_privilege('anon','public.dbmt_erp_split_label_stock(text,text,text,jsonb,text,uuid)','execute')").fetchone()[0]
    for table in ['label_stock_assignments', 'label_stock_split_requests']:
        assert not conn.execute("select has_table_privilege('anon',%s,'SELECT')", ('public.' + table,)).fetchone()[0]
        assert conn.execute('select relrowsecurity from pg_class where oid=%s::regclass', ('public.' + table,)).fetchone()[0]
    assert not conn.execute("select has_schema_privilege('anon','label_stock_private','USAGE')").fetchone()[0]
    assert not conn.execute("select has_function_privilege('anon','label_stock_private.snapshot(text,text)','execute')").fetchone()[0]

    # Older completed journals may lack boxCount. Real label weights, never division,
    # supply exact weights and physical box counts when those journals are split.
    fractional_order = dict(order, id=uid('fractional_order'))
    conn.execute("update public.app_data set payload=payload||%s where key='workOrders'", (Jsonb([fractional_order]),))
    fractional = [{**log, 'id': uid('fractional' + str(i)), 'code': 'DB2610171201-' + prefix + str(i),
                   'workOrderId': fractional_order['id'], 'labelWeight': weight,
                   'workOrderSnapshot': {**fractional_order, 'weight': weight}}
                  for i, (log, weight) in enumerate(zip(logs, [20.25, 19.75, 20, 20, 20]))]
    assert rpc('dbmt_label_print_save_logs', pin, fractional)['ok']
    fractional_pid = rpc('dbmt_label_complete_production', pin, fractional_order['id'], [l['id'] for l in fractional])['productionId']
    fractional_entry = entry(fractional_pid)
    fractional_stock = fractional_entry['outputs'][0]['stockRowId']
    fractional_entry['outputs'][0].pop('boxCount')
    conn.execute('update public.production_entries set raw=%s where id=%s', (Jsonb(fractional_entry), fractional_pid))
    conn.execute("update public.transactions set raw=raw-'boxCount' where prod_id=%s and type='생산입고'", (fractional_pid,))
    fractional_get = get(fractional_stock, fractional_pid)
    assert fractional_get['canSplit'] and fractional_get['boxCount'] == 5
    fractional_result = split([fractional[0]['id']], source_id=fractional_stock, production_id=fractional_pid, version=fractional_get['version'])
    assert sorted((o['qty'], o['boxCount']) for o in fractional_result['entry']['outputs']) == [(20.25, 1), (79.75, 4)]
    assert sum(Decimal(str(o['amount'])) for o in fractional_result['entry']['outputs']) == Decimal(str(fractional_entry['outputs'][0]['amount']))
    assert rpc('dbmt_pda_lookup', token, fractional[0]['code'])['item']['stockRowId'] == fractional_result['splitStockRowId']
    assert rpc('dbmt_pda_lookup', token, fractional[1]['code'])['item']['stockRowId'] == fractional_result['remainingStockRowId']
    repriced = copy.deepcopy(fractional_result['entry'])
    repriced['outputs'][0]['price'] = 5100
    assert rpc('dbmt_erp_save_production', token, repriced, [], fractional_pid)['ok'], 'Mapped output price edits stay supported before PDA processing'
    return ('100KG/5 labels -> 40KG/2 + 60KG/3; exact inputs/costs/boxes; auth/RLS/private helpers; subsets/stale/retries; atomic audit rollback; downstream/PDA/reservations; PDA barcode/outbound/return; notes/price/edit guards; repeated split; cancel/resubmit generations; fractional weights/legacy box counts',
            'qa_split_' + suffix + '_')


def main():
    if '--apply' in sys.argv:
        raise RuntimeError('This verifier never deploys schema or preserves fixture records.')
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', '') + os.environ.get('PGHOST', ''):
        raise RuntimeError('Wrong linked project')
    sql = '' if '--installed' in sys.argv else sys.stdin.buffer.read().decode('utf-8-sig')
    if '--installed' not in sys.argv and 'dbmt_erp_split_label_stock' not in sql:
        raise RuntimeError('Expected additive label-split schema on stdin')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_label_split_rollback_qa') as conn:
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='45s'")
            if sql:
                conn.execute(sql)
            checks, prefix = fixture_tests(conn)
        # Read-only aggregate after rollback verifies no fictional business rows remain.
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            counts = conn.execute("""select jsonb_build_object(
                'productions',(select count(*) from public.production_entries where raw#>>'{_labelCompletion,workOrderId}' like %s),
                'transactions',(select count(*) from public.transactions where product like %s),
                'labels',(select count(*) from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'id' like %s),
                'workOrders',(select count(*) from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='workOrders' and e->>'id' like %s),
                'users',(select count(*) from public.erp_users where login_id like %s),
                'roles',(select count(*) from public.erp_roles where code like %s),
                'partners',(select count(*) from public.business_partners where name like %s))""", (prefix+'%',)*7).fetchone()[0]
            assert sum(counts.values()) == 0, 'Fictional records must all roll back: ' + json.dumps(counts)
    print(json.dumps(dict(ok=True, schemaApplied=False, allChangesRolledBack=True, remainingFixtures=counts, tests=checks), ensure_ascii=False))


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
