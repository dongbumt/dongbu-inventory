"""Install stock-row SQL and test fictional data in an always-rolled-back transaction."""
import copy
import json
import os
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda kind: 'qa_' + kind + '_' + suffix
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Stock row QA') returning id", (uid('role'),)).fetchone()[0]
    for menu in ['production', 'transactions', 'stock']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)", (role, menu))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Stock row QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", (uid('user'), uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')', tuple(Jsonb(a) if isinstance(a, (list, dict)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(fn, fragment):
        try:
            fn()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001', '42501'), error.sqlstate
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    def output(stock_id, qty=100, note='납품 메모'):
        return dict(product='QA 같은 생산품', productId=uid('product'), labelProductId=uid('product'),
                    origin='국내산', lot='QA-SAME-LOT', packunit='5KG', proddate='2026-09-13',
                    stockLocation='가공장', qty=qty, price=1000, amount=qty * 1000, note=note, stockRowId=stock_id)

    def postings(entry):
        return conn.execute('select public.dbmt_label_production_transactions(%s)', (Jsonb(entry),)).fetchone()[0]

    def save(entry, previous=None, rows=None):
        return rpc('dbmt_erp_save_production', token, entry, postings(entry) if rows is None and entry else rows or [], previous)

    a, b, c = uid('a'), uid('b'), uid('c')
    entry = dict(id=uid('production'), date='2026/09/13', job_no='1', job_type='생산', inputs=[],
                 outputs=[output(a), output(b, 60, '납품 메모')], _isUser=True)
    assert save(entry)['ok']
    saved = conn.execute('select raw from public.production_entries where id=%s', (entry['id'],)).fetchone()[0]
    assert [r['stockRowId'] for r in saved['outputs']] == [a, b]
    rows = conn.execute('select raw from public.transactions where prod_id=%s and deleted_at is null', (entry['id'],)).fetchall()
    assert {r[0]['stockRowId'] for r in rows} == {a, b}
    assert all(r[0]['stockNote'] == '납품 메모' for r in rows)

    duplicate = copy.deepcopy(entry)
    duplicate['outputs'][1]['stockRowId'] = a
    reject(lambda: save(duplicate, entry['id']), '중복')
    collision = dict(entry, id=uid('collision'))
    reject(lambda: save(collision), '다른 생산일보')
    bad_rows = postings(entry)
    bad_rows[0]['stockNote'] = 'forged'
    reject(lambda: save(entry, entry['id'], bad_rows), '비고')
    bad_rows = postings(entry)
    bad_rows[0]['product'] = 'forged'
    reject(lambda: save(entry, entry['id'], bad_rows), '비고')

    def movement(kind, quantity, stock_id=a, **extra):
        row = dict(output(stock_id), id=uid(kind) + uuid.uuid4().hex[:4], date='2026-09-13', type=kind,
                   weight=quantity, stockNote='납품 메모', stockProddate='2026-09-13', stockUnitPrice=1000,
                   trader='QA 거래처', _isUser=True)
        row.update(extra)
        return row

    shipped = movement('출고', 30)
    assert rpc('dbmt_erp_save_transactions', token, [shipped], [])['ok']
    missing = copy.deepcopy(entry)
    missing['outputs'][0].pop('stockRowId')
    reject(lambda: save(missing, entry['id']), '연결')
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [movement('출고', 1, uid('missing'))], []), '재고행')
    adjusted = movement('재고조정', -10, stockBefore=70, stockActual=60, note='QA 실사', sourceStockKey='QA source')
    adjusted['id'] = uid('adjust')
    adjust_result = rpc('dbmt_erp_save_stock_adjust', token, adjusted)
    assert adjust_result['ok'] and adjust_result['transaction']['stockRowId'] == a
    assert adjust_result['transaction']['stockNote'] == '납품 메모'
    assert adjust_result['transaction']['sourceStockKey'] == 'QA source'
    assert rpc('dbmt_erp_save_transactions', token, [movement('재고이동', 20, fromLocation='가공장', toLocation='외부창고')], [])['ok']
    consumed = dict(output(a, 20), stockNote='납품 메모')
    reused = dict(id=uid('reuse'), date='2026/09/13', job_no='2', inputs=[consumed], outputs=[output(c, 15, '재작업')])
    assert save(reused)['ok']
    reject(lambda: save(None, entry['id']), '연결')
    removed = copy.deepcopy(entry)
    removed['outputs'] = [removed['outputs'][1]]
    reject(lambda: save(removed, entry['id']), '연결')
    changed = copy.deepcopy(entry)
    changed['outputs'][0]['product'] = '다른 품목'
    reject(lambda: save(changed, entry['id']), '변경')
    reduced = copy.deepcopy(entry)
    reduced['outputs'][0]['qty'] = 60
    reject(lambda: save(reduced, entry['id']), '중량')
    reduced['outputs'][0]['qty'] = 80
    reduced['outputs'][0]['note'] = '수정된 비고'
    assert save(reduced, entry['id'])['ok']
    assert conn.execute("select raw->>'stockNote' from public.transactions where prod_id=%s and raw->>'stockRowId'=%s and type='생산입고' and deleted_at is null", (entry['id'], a)).fetchone()[0] == '수정된 비고'
    # Identical product, LOT and note do not make the independent B row dependent.
    only_a = copy.deepcopy(reduced)
    only_a['outputs'] = only_a['outputs'][:1]
    assert save(only_a, entry['id'])['ok']

    legacy = dict(id=uid('legacy'), date='2026/09/13', job_no='3', inputs=[], outputs=[output('', 10, '예전 생산품')])
    legacy['outputs'][0].pop('stockRowId')
    conn.execute('insert into public.production_entries(id,work_date,raw) values(%s,%s,%s)', (legacy['id'], '2026-09-13', Jsonb(legacy)))
    legacy['outputs'][0]['note'] = '예전 비고 수정'
    assert save(legacy, legacy['id'])['ok']
    assert not conn.execute('select raw from public.production_entries where id=%s', (legacy['id'],)).fetchone()[0]['outputs'][0].get('stockRowId')

    # Label completion assigns IDs after grouping and carries the input row ID.
    pin = '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    source = dict(output(a), key='qa_source', stock=20, stockNote='수정된 비고')
    order = dict(id=uid('order'), date='2026-09-13', title='QA 라벨', product='QA 라벨 생산품', labelProductId=uid('label_product'),
                 inputWeight=5, weight=5, lot='QA-LABEL', origin='국내산', mfgdate='2026-09-13', note='라벨 개별비고', sourceStock=source)
    product = dict(id=uid('label_product'), name=order['product'], packunit='5KG', taxType='면세')
    for key, value in [('workOrders', [order]), ('labelProducts', [product]), ('labelPrintLogs', [])]:
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload', (key, Jsonb(value)))
    log = dict(id=uid('log'), workOrderId=order['id'], product=order['product'], labelWeight=5, status='active', reprintCount=0, workOrderSnapshot=order)
    assert rpc('dbmt_label_print_save_logs', pin, [log])['ok']
    completed = rpc('dbmt_label_complete_production', pin, order['id'], [log['id']])
    label_entry = conn.execute('select raw from public.production_entries where id=%s', (completed['productionId'],)).fetchone()[0]
    label_id = label_entry['outputs'][0]['stockRowId']
    assert label_id and label_entry['outputs'][0]['note'] == '라벨 개별비고'
    assert label_entry['inputs'][0]['stockRowId'] == a and label_entry['inputs'][0]['stockNote'] == '수정된 비고'
    assert rpc('dbmt_label_complete_production', pin, order['id'], [])['alreadyCompleted']
    label_entry['outputs'][0]['note'] = '라벨 수정 비고'
    label_saved = save(label_entry, label_entry['id'])
    assert label_saved['entry']['outputs'][0]['stockRowId'] == label_id
    assert next(r for r in label_saved['transactionRows'] if r['type'] == '생산입고')['stockNote'] == '라벨 수정 비고'
    assert save(None, label_entry['id'])['ok']
    reopened = rpc('dbmt_label_resubmit_production', pin, order['id'], [log['id']], label_entry['id'])
    new_label = conn.execute('select raw from public.production_entries where id=%s', (reopened['productionId'],)).fetchone()[0]
    assert new_label['outputs'][0]['stockRowId'] != label_id

    # Simulate an old completed journal without identifiers, then edit its note.
    old_label = copy.deepcopy(new_label)
    old_label['outputs'][0].pop('stockRowId')
    conn.execute('update public.production_entries set raw=%s where id=%s', (Jsonb(old_label), old_label['id']))
    conn.execute("update public.transactions set raw=raw-'stockRowId' where prod_id=%s and type='생산입고'", (old_label['id'],))
    old_label['outputs'][0]['note'] = '이전 라벨 기록'
    legacy_label = save(old_label, old_label['id'])
    assert not legacy_label['entry']['outputs'][0].get('stockRowId')
    old_label['outputs'].append(output(uid('extra_label'), 2, '새로 추가'))
    extra_label = save(old_label, old_label['id'])
    assert not extra_label['entry']['outputs'][0].get('stockRowId')
    assert extra_label['entry']['outputs'][1]['stockRowId'] == uid('extra_label')
    old_label['outputs'].reverse()
    reordered = save(old_label, old_label['id'])
    assert reordered['entry']['outputs'][0]['stockRowId'] == uid('extra_label')
    assert not reordered['entry']['outputs'][1].get('stockRowId'), 'Reordering must not backfill an old row ID'

    assert conn.execute("select active from public.erp_permission_catalog where menu_code='samsung'").fetchone()[0] is False
    for helper in ['dbmt_validate_production_stock_rows(jsonb,text)', 'dbmt_prepare_label_stock_rows(jsonb,jsonb)', 'dbmt_erp_save_production_before_stock_rows(text,jsonb,jsonb,text)']:
        assert conn.execute("select has_function_privilege('anon',%s,'execute')", ('public.' + helper,)).fetchone()[0] is False


def main():
    if '--apply' in sys.argv:
        raise RuntimeError('This verifier never deploys schema or keeps fixture data.')
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    sql = sys.stdin.buffer.read().decode('utf-8-sig')
    if 'dbmt_validate_production_stock_rows' not in sql:
        raise RuntimeError('Expected stock-row schema')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_stock_rows_rollback_qa') as conn:
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            conn.execute(sql)
            fixture_tests(conn)
    print(json.dumps(dict(ok=True, schemaApplied=False, allChangesRolledBack=True,
                         tests='duplicate IDs, cross-journal collisions, connected missing IDs, posting mismatch, outbound, adjustment fields, moves, reinput, connected delete/change/quantity guards, legacy rows and mixed reorder, label completion/edit/reopen, private helpers')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        if isinstance(error, psycopg.Error):
            print('SQL context: ' + str(error.diag.context), file=sys.stderr)
        raise SystemExit(1)
