"""Product-selection integration QA. All fictional records are rolled back.
--apply installs only schema 42 after tests pass, never sample business records.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda name: 'qa_product_' + suffix + '_' + name
    pin = '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    order = dict(id=uid('order'), date='2026-09-15', title='QA multiple outputs', product='QA original', labelProductId=uid('p0'),
                 inputWeight=100, weight=5, lot='QA-LOT', origin='국내산', grade='1등급', mfgdate='2026-09-15', expdate='2027-09-14',
                 ingredients='돼지고기 100%', temptype='냉동',
                 sourceStock=dict(key=uid('stock'), product='QA raw', lot='QA-RAW', origin='국내산', packunit='벌크',
                                  proddate='2026-09-01', stockLocation='가공장', price=5000, stock=100))
    p0 = dict(id=uid('p0'), name=order['product'], packunit='5KG', taxType='면세')
    p1 = dict(id=uid('p1'), name='QA 돈까스 10mm', productCode='P001', brand='QA', factoryNo='F1', nationalPartCode='P01', nationalPartName='등심',
              packunit='2KG', taxType='과세', storage='냉장', shelfdays=30, itemno='REPORT-10', meattype='돼지고기', kind='제품', origin='미국산')
    p2 = dict(p1, id=uid('p2'), name='QA 잡채 3mm', productCode='P002', packunit='5KG', storage='냉동', shelfdays=60, itemno='REPORT-3')
    p3 = dict(p2, id=uid('p3'), packunit='1KG', productCode='P003')  # Same name, distinct inventory product.
    products = [p0, p1, p2, p3]

    def app(key, value):
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload', (key, Jsonb(value)))

    for key, value in [('workOrders', [order]), ('labelProducts', products), ('labelPrintLogs', [])]:
        app(key, value)

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            value = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                 tuple(Jsonb(a) if isinstance(a, (list, dict)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    def reject(fn, fragment):
        try:
            fn()
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    # Compare the actual browser composition module with SQL, including dates,
    # defaults, and an intentionally different master origin (raw origin stays).
    cases = [(order, p1), (order, p2), (dict(order, mfgdate='2024-02-29'), dict(p1, shelfdays=2)),
             (dict(order, mfgdate='2026-12-31'), dict(p1, shelfdays='2')),
             (order, dict(id=uid('default'), name='QA defaults')), (order, dict(p1, shelfdays=0))]
    script = "const fs=require('fs'),vm=require('vm');const x={window:{}};vm.runInNewContext(fs.readFileSync('label-product-selection.js','utf8'),x);let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(([a,b])=>x.window.DBMTLabelProducts.compose(a,b)))));"
    result = subprocess.run(['node', '-e', script], input=json.dumps(cases), text=True, encoding='utf-8', capture_output=True, check=True)
    client = json.loads(result.stdout)
    for case, expected in zip(cases, client):
        actual = conn.execute('select public.dbmt_label_selected_product_order(%s,%s)', tuple(Jsonb(x) for x in case)).fetchone()[0]
        assert actual == expected, 'Browser/SQL product snapshot differs'
    assert client[0]['origin'] == '국내산' and client[0]['expdate'] == '2026-10-14' and client[0]['grade'] == '1등급'

    counter = 0

    def log(product, weight=5, legacy=False):
        nonlocal counter
        counter += 1
        snap = dict(order) if legacy else conn.execute('select public.dbmt_label_selected_product_order(%s,%s)', (Jsonb(order), Jsonb(product))).fetchone()[0]
        snap['weight'] = weight
        return dict(id=uid('log' + str(counter)), workOrderId=order['id'], product=snap['product'], lot=order['lot'],
                    inputWeight=100, labelWeight=weight, status='active', reprintCount=0, workOrderSnapshot=snap)

    save = lambda rows: rpc('dbmt_label_print_save_logs', pin, rows)
    original, a, b, c, d = log(p0, legacy=True), log(p1, 2.35), log(p1, 7.65), log(p2, 12.5), log(p3, 4)
    reject(lambda: rpc('dbmt_label_print_save_logs', 'bad', [a]), 'PIN')
    for key in ['product', 'labelProductId', 'productCode', 'brand', 'factoryNo', 'nationalPartCode', 'nationalPartName', 'taxType', 'packunit', 'origin', 'grade', 'date', 'mfgdate', 'expdate', 'itemno', 'ingredients', 'temptype']:
        forged = log(p1)
        forged['workOrderSnapshot'][key] = 'FORGED'
        reject(lambda: save([forged]), '품목' if key == 'labelProductId' else '변경')
    for key in ['product', 'lot', 'inputWeight', 'labelWeight']:
        forged = log(p1)
        forged[key] = 88 if key in ['inputWeight', 'labelWeight'] else 'FORGED'
        reject(lambda: save([forged]), '정보')
    forged = log(p1)
    forged['workOrderSnapshot']['sourceStock'] = dict(order['sourceStock'], price=1)
    reject(lambda: save([forged]), '투입정보')
    forged = log(p1)
    forged['workOrderSnapshot']['productSelectionVersion'] = 0
    reject(lambda: save([forged]), '버전')
    forged = log(p1)
    del forged['workOrderSnapshot']['productSelectionVersion']
    reject(lambda: save([forged]), '변경')
    # A stale master is rejected, with no partial batch or raw work-order edits.
    app('labelProducts', [p0, dict(p1, itemno='CHANGED'), p2, p3])
    reject(lambda: save([original, a]), '변경')
    assert conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0] == []
    app('labelProducts', products)
    result = save([original, a, b, c, d])
    assert len(result['logs']) == 5
    ids = [e['id'] for e in result['logs']]
    total = lambda: rpc('dbmt_label_complete_production', pin, order['id'], ids)
    forged = copy.deepcopy(a)
    forged['workOrderSnapshot']['labelProductId'] = p2['id']
    reject(lambda: save([forged]), '저장된 라벨')
    # Removing a selected master must not reassign its old labels to an identically
    # named newly registered product. Historical reprinting still remains possible.
    app('labelProducts', [p0, dict(p1, id=uid('replacement')), p2, p3])
    save([dict(a, reprintCount=1)])
    reject(total, '품목관리')
    assert not conn.execute('select 1 from public.label_production_completions where work_order_id=%s', (order['id'],)).fetchone()
    app('labelProducts', [p0, dict(p1, name='QA renamed', packunit='NEW', brand='Changed'), p2, p3])
    completed = total()
    pid = completed['productionId']
    entry = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    assert len(entry['inputs']) == 1 and entry['inputs'][0]['qty'] == 100
    assert len(entry['outputs']) == 4 and len({o['stockRowId'] for o in entry['outputs']}) == 4
    outputs = {o['productId']: o for o in entry['outputs']}
    assert outputs[p1['id']]['product'] == p1['name'] and outputs[p1['id']]['qty'] == 10
    assert outputs[p1['id']]['packunit'] == '2KG' and outputs[p1['id']]['brand'] == 'QA'
    assert outputs[p2['id']]['qty'] == 12.5 and outputs[p3['id']]['qty'] == 4
    assert all(o['origin'] == '국내산' for o in outputs.values())
    rows = conn.execute('select type,weight from public.transactions where prod_id=%s and deleted_at is null', (pid,)).fetchall()
    assert len(rows) == 5 and sum(float(q) for t, q in rows if t == '사용') == 100
    assert sum(float(q) for t, q in rows if t == '생산입고') == 31.5
    assert total()['productionId'] == pid
    reject(lambda: save([log(p2)]), '생산완료')
    assert rpc('dbmt_label_cancel_production', pin, order['id'], pid)['ok']
    save([dict(a, reprintCount=1, status='void', voidReason='QA wrong spec'), log(p2, 3.5)])
    all_logs = rpc('dbmt_label_print_get_data', pin)['appData']['labelPrintLogs']
    active = [e['id'] for e in all_logs if e['workOrderId'] == order['id'] and e['status'] != 'void']
    successor = rpc('dbmt_label_resubmit_production', pin, order['id'], active, pid)['productionId']
    assert successor != pid
    rows = conn.execute('select type,weight from public.transactions where prod_id=%s and deleted_at is null', (successor,)).fetchall()
    assert sum(float(q) for t, q in rows if t == '사용') == 100
    assert abs(sum(float(q) for t, q in rows if t == '생산입고') - 32.65) < .00001
    assert conn.execute("select payload from public.app_data where key='workOrders'").fetchone()[0] == [order]
    assert not conn.execute("select has_function_privilege('anon','public.dbmt_label_selected_product_order(jsonb,jsonb)','execute')").fetchone()[0]


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    sql = sys.stdin.buffer.read().decode('utf-8-sig')
    if 'create or replace function public.dbmt_label_selected_product_order' not in sql:
        raise RuntimeError('Expected product-selection schema')
    apply = '--apply' in sys.argv
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_product_selection_qa') as conn:
        with conn.transaction(force_rollback=not apply):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='30s'")
            conn.execute('set local role postgres')
            conn.execute(sql)
            with conn.transaction(force_rollback=True):
                fixture_tests(conn)
            spec = importlib.util.spec_from_file_location('cancel_qa', Path(__file__).with_name('check-label-cancel-db.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with conn.transaction(force_rollback=True):
                module.fixture_tests(conn)
    print(json.dumps(dict(ok=True, schemaApplied=apply, fixturesRolledBack=True,
                         tests='browser/SQL metadata and expiry parity, source immutability, spoofed/stale master rejection, legacy compatibility, same-name IDs, one raw input/multiple outputs, old snapshots, deleted master/reprint, cancellation/correction/resubmit, permissions, full cancellation regression')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        if isinstance(error, psycopg.Error):
            print('SQL context: ' + str(error.diag.context), file=sys.stderr)
        raise SystemExit(1)
