"""Production/raw-box lifecycle. Every migration, PIN and fixture rolls back."""
import ast
import copy
import os
import uuid
from decimal import Decimal
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261112050727_pda_raw_production_usage.sql'
DEPLOYED = os.environ.get('DBMT_RAW_PRODUCTION_TEST_DEPLOYED') == '1'


def production(conn, fixture):
    rpc, reject, lookup, commit = [fixture[key] for key in ['rpc', 'reject', 'lookup', 'commit']]
    token, role, source, codes = [fixture[key] for key in ['token', 'role', 'source', 'codes']]
    suffix = uuid.uuid4().hex[:12]
    uid = lambda name: 'qa_raw_prod_' + suffix + '_' + name
    pin = '0329'
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'production',true,true,true,true)", (role,))
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    raw = fixture['row']
    stock = dict(key='row|' + source + '|가공장', stockRowId=source, stockLocation='가공장', product=raw['product'],
                 origin=raw.get('origin', ''), lot=raw['lot'], packunit=raw.get('packunit', ''), price=4400, stock=341.4, stockBoxes=20)
    order = dict(id=uid('order'), date='2026-11-10', product=uid('finished'), labelProductId=uid('finished_id'),
                 inputWeight=9.56, inputBoxCount=1, sourceStock=stock,
                 sourceInputs=[dict(sourceStock=stock, inputWeight=9.56, boxCount=1, sourceStockKey=stock['key'])],
                 weight=2.36, lot=raw['lot'], origin=raw.get('origin', ''), packunit='5KG', mfgdate='2026-11-10', expdate='2027-11-09', temptype='냉동')
    finished = dict(id=order['labelProductId'], name=order['product'], kind='제품', packunit='5KG', origin=order['origin'], taxType='면세')
    for key, value in [('workOrders', [order]), ('labelProducts', [finished])]:
        conn.execute('update public.app_data set payload=payload||%s where key=%s', (Jsonb(value), key))
    logs = [dict(id=uid('log' + str(i)), code='DB2611101200-' + suffix[:5].upper() + str(i), workOrderId=order['id'],
                 product=order['product'], labelWeight=weight, status='active', workOrderSnapshot={**order, 'weight': weight})
            for i, weight in enumerate([2.36, 2.36, 2.37, 2.37])]
    assert rpc('dbmt_label_print_save_logs', pin, logs)['ok']
    ids = [log['id'] for log in logs]
    complete = lambda auth=pin: rpc('dbmt_label_complete_production', auth, order['id'], ids)
    immutable = lambda: conn.execute('select id,barcode,parsed,snapshot,weight,source_id from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall()
    original_boxes = immutable()
    other_receipt = commit('inbound', codes[20:22], lot=raw['lot'])
    other_source = lookup(codes[20])['stockRowId']
    assert other_source != source, 'A separately confirmed receipt remains a separate random-selection pool'
    if not DEPLOYED:
        reject(complete, 'PDA 원료육 박스 몫')
        assert not conn.execute('select 1 from public.label_production_completions where work_order_id=%s', (order['id'],)).fetchone()
        assert immutable() == original_boxes
        print('PASS: reproduced 9.56KG/1-box production blocked by the old raw reservation guard')
        conn.execute(MIGRATION.read_text(encoding='utf-8'))
        assert immutable() == original_boxes, 'Installation must not rewrite operating boxes'
        print('PASS: migration compiled; no existing barcodes, weights or stock rewritten')

    count_used = lambda: conn.execute("select count(*) from pda_private.raw_packages where source_id=%s and state='used'", (source,)).fetchone()[0]
    balance = lambda: conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0]
    assignments = lambda pid: conn.execute('select package_id from pda_private.raw_production_packages where production_id=%s order by package_id', (pid,)).fetchall()
    reject(lambda: complete('bad-pin'), 'PIN')
    result = complete()
    pid = result['productionId']
    assert result['ok'] and count_used() == 1 and balance() == Decimal('331.84')
    assert len(assignments(pid)) == 1
    assert assignments(pid)[0][0] in {row[0] for row in original_boxes}, 'Random selection stays inside the exact receipt source'
    assert conn.execute("select count(*) from pda_private.raw_packages where source_id=%s and state='in_stock'", (other_source,)).fetchone()[0] == 2
    entry = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    assert sum(item['qty'] for item in entry['outputs']) == 9.46
    assert sum(item['boxCount'] for item in entry['outputs']) == 4
    used_code = conn.execute("select barcode from pda_private.raw_packages where source_id=%s and state='used'", (source,)).fetchone()[0]
    assert lookup(used_code)['state'] == 'used'
    reject(lambda: commit('inbound', [used_code]), '중복 입고')
    assert immutable() == original_boxes
    versions = conn.execute('select id,state,revision from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall()
    assert complete()['productionId'] == pid
    assert versions == conn.execute('select id,state,revision from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall()
    for log in logs:
        assert rpc('dbmt_pda_lookup', token, log['code'])['item']['stockRowId'] == entry['outputs'][0]['stockRowId']
    with conn.transaction(force_rollback=True):
        shipped = commit('outbound', [used_code])
        assert shipped['ok'] and lookup(used_code)['state'] == 'shipped'
        assert balance() == Decimal('314.77') and len(assignments(pid)) == 1
        assert complete()['productionId'] == pid and lookup(used_code)['state'] == 'shipped', 'Completion retry must not revive or re-consume a shipped binding'
        reject(lambda: commit('outbound', [used_code]), '이미 출고')
        assert rpc('dbmt_label_cancel_production', pin, order['id'], pid)['ok']
        assert lookup(used_code)['state'] == 'shipped' and balance() == Decimal('324.33'), 'Cancel production without resurrecting a physical shipment'
    print('PASS: production consumes 9.56KG/1 raw box, creates 9.46KG/4 output labels, preserves barcode payloads and retries idempotently')

    changed = copy.deepcopy(entry)
    changed['inputs'][0]['qty'] = 10.56
    saved = rpc('dbmt_erp_save_production', token, changed, [], pid)
    assert saved['ok'] and balance() == Decimal('330.84') and count_used() == 1
    assert saved['entry']['outputs'] == entry['outputs']
    assert versions == conn.execute('select id,state,revision from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall()
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='production'", (role,))
        assert not rpc('dbmt_erp_save_production', token, changed, [], pid)['ok']
        assert count_used() == 1 and balance() == Decimal('330.84')
    excessive = copy.deepcopy(saved['entry'])
    excessive['inputs'][0]['qty'] = 500
    reject(lambda: rpc('dbmt_erp_save_production', token, excessive, [], pid), '재고')
    assert balance() == Decimal('330.84') and count_used() == 1
    bad_count = copy.deepcopy(saved['entry'])
    bad_count['inputs'][0]['boxCount'] = 200
    reject(lambda: rpc('dbmt_erp_save_production', token, bad_count, [], pid), '박스수')
    posting = conn.execute("select raw from public.transactions where prod_id=%s and type='사용' and deleted_at is null", (pid,)).fetchone()[0]
    posting['weight'] = 9
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [posting], []), '생산')
    reject(lambda: conn.execute("update public.transactions set weight=9 where prod_id=%s and type='사용' and deleted_at is null", (pid,)), '생산일보')
    print('PASS: input edits preserve assigned boxes and finished labels; insufficient box counts, bypass edits and missing permissions reject atomically')

    cancel = lambda: rpc('dbmt_label_cancel_production', pin, order['id'], pid)
    assert cancel()['ok'] and balance() == Decimal('341.40') and count_used() == 0
    assert not assignments(pid)
    restored = conn.execute('select id,state,revision from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall()
    assert cancel()['alreadyCancelled']
    assert restored == conn.execute('select id,state,revision from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall()
    new = rpc('dbmt_label_resubmit_production', pin, order['id'], ids, pid)
    new_pid = new['productionId']
    assert new['ok'] and new_pid != pid and count_used() == 1
    assert rpc('dbmt_erp_save_production', token, None, [], new_pid)['ok']
    assert balance() == Decimal('341.4') and count_used() == 0
    print('PASS: label cancellation/retry, new-generation resubmission and ERP deletion restore raw boxes with unchanged printed barcodes')

    def manual(name, kg, boxes):
        record = copy.deepcopy(entry)
        record.pop('_labelCompletion', None)
        record['id'], record['job_no'] = uid(name), 9000 + len(name)
        record['inputs'][0]['qty'], record['inputs'][0]['boxCount'] = kg, boxes
        record['outputs'][0]['qty'], record['outputs'][0]['boxCount'] = kg, 1
        record['outputs'][0]['stockRowId'] = uid(name + '_stock')
        rows = conn.execute('select public.dbmt_label_production_transactions(%s)', (Jsonb(record),)).fetchone()[0]
        result = rpc('dbmt_erp_save_production', token, record, rows, None)
        assert result['ok'], result
        return record['id']

    manual_pid = manual('automatic', 40, None)
    assert count_used() == 3 and balance() == Decimal('301.4')
    loose_pid = manual('loose', 9.56, 0)
    assert count_used() == 3 and balance() == Decimal('291.84'), 'An opened remainder does not consume a second whole-box barcode'
    assert rpc('dbmt_erp_save_production', token, None, [], manual_pid)['ok']
    assert count_used() == 0 and balance() == Decimal('331.84')
    assert rpc('dbmt_erp_save_production', token, None, [], loose_pid)['ok']
    assert count_used() == 0 and balance() == Decimal('341.4') and immutable() == original_boxes
    negative_pid = manual('negative', 340, 20)
    assert count_used() == 20 and balance() == Decimal('1.4')
    overlap_code = conn.execute("select barcode from pda_private.raw_packages where source_id=%s and state='used' order by id limit 1", (source,)).fetchone()[0]
    shipped = commit('outbound', [overlap_code])
    assert balance() == Decimal('-15.67') and shipped['negativeStock'][0]['weight'] == -15.67
    assert lookup(overlap_code)['state'] == 'shipped' and len(assignments(negative_pid)) == 20
    reject(lambda: commit('outbound', [overlap_code]), '이미 출고')
    assert rpc('dbmt_erp_save_production', token, None, [], negative_pid)['ok']
    assert balance() == Decimal('324.33') and lookup(overlap_code)['state'] == 'shipped' and not assignments(negative_pid)
    assert conn.execute("select count(*) from pda_private.raw_packages where source_id=%s and state='in_stock'", (source,)).fetchone()[0] == 19
    assert immutable() == original_boxes
    assert conn.execute('select count(*) from pda_private.raw_production_context').fetchone()[0] == 0
    assert not conn.execute("select has_table_privilege('anon','pda_private.raw_production_packages','select') or has_table_privilege('anon','pda_private.raw_production_context','insert') or has_function_privilege('anon','pda_private.sync_raw_production(text)','execute')").fetchone()[0]
    print('PASS: random links stay in the same receipt; ordinary/unknown-count production and partial remainders; used-barcode outbound with -15.67KG shortage; duplicate rejection; cancellation never resurrects shipped boxes; private capability protections')
    with conn.transaction(force_rollback=True):
        cost_file = ROOT / 'tools/check-pda-cost-db.py'
        cost_tree = ast.parse(cost_file.read_text(encoding='utf-8-sig'))
        cost_namespace = {'__file__': str(cost_file)}
        exec(compile(ast.Module(body=[node for node in cost_tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))], type_ignores=[]), str(cost_file), 'exec'), cost_namespace)
        cost_namespace['check'](conn)
    print('PASS: existing provisional product shipment, production-cost settlement and barcode identity lifecycle with the new production wrappers')


assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER', '') + os.environ.get('PGHOST', '')
base = ROOT / 'tools/check-pda-receipts-db.py'
tree = ast.parse(base.read_text(encoding='utf-8-sig'))
namespace = {'__file__': str(base)}
exec(compile(ast.Module(body=[node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))], type_ignores=[]), str(base), 'exec'), namespace)
with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_raw_production_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='4s'")
        conn.execute("set local statement_timeout='45s'")
        namespace['check'](conn, production)
        print('PASS: existing grouped-receipt, outbound, receipt cancellation and permission regressions')
    finally:
        conn.rollback()
        print('ROLLED BACK: all DDL, fictional users, PIN, incoming boxes, labels and production records. No operating data changed.')
