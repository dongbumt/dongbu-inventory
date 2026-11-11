"""Actual product shipment cancellations, state restoration and retries. Always roll back."""
import ast
import copy
import os
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261111044148_pda_product_shipment_cancellations.sql'


def regression(conn, filename):
    file = ROOT / 'tools' / filename
    tree = ast.parse(file.read_text(encoding='utf-8-sig'))
    nodes = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))]
    namespace = {'ROOT': ROOT, '__file__': str(file)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, 'exec'), namespace)
    namespace['check'](conn)


def fixture(conn, completed=False, manual_sale=False, shipment_location='가공장'):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda name: 'qa_cancel_' + suffix + '_' + name
    role, user, partner = (uuid.uuid4() for _ in range(3))
    token, pin = uuid.uuid4().hex + uuid.uuid4().hex, '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'PDA cancel QA')", (role, uid('role')))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'PDA cancel QA','unused',%s)", (user, uid('user')[:30], role))
    for menu in ['pda', 'production', 'transactions', 'stock']:
        conn.execute('insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)', (role, menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매출')", (partner, 'QD' + suffix.upper(), uid('partner')))
    order = dict(id=uid('order'), date='2026-11-10', product=uid('product'), labelProductId=uid('product_id'), inputWeight=100,
                 weight=5, lot='QA-CANCEL-LOT', origin='국내산', packunit='5KG', grade='', mfgdate='2026-11-10', expdate='2027-11-09', temptype='냉동',
                 sourceStock=dict(key=uid('raw'), product=uid('raw'), price=1000, stock=100, origin='국내산', lot='RAW'))
    logs = [dict(id=uid('label' + str(i)), code='DB2611101200-QACN0' + str(i), workOrderId=order['id'], labelWeight=5,
                 status='active', workOrderSnapshot=order) for i in range(3)]
    for key, value in [('workOrders', [order]), ('labelProducts', [dict(id=order['labelProductId'], name=order['product'], packunit='5KG', taxType='면세')]), ('labelPrintLogs', logs)]:
        conn.execute('update public.app_data set payload=payload||%s where key=%s', (Jsonb(value), key))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                  tuple(Jsonb(x) if isinstance(x, (list, dict)) else x for x in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(fn, fragment=None):
        try:
            with conn.transaction():
                fn()
        except psycopg.Error as error:
            if fragment:
                assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + str(fragment))

    lookup = lambda i: rpc('dbmt_pda_lookup', token, logs[i]['code'])['item']
    scan = lambda i: dict(barcode=lookup(i)['code'], revision=lookup(i)['revision'])
    commit = lambda mode, indices, location='가공장', date='2026-11-11', request=None: rpc('dbmt_pda_commit', token, request or uuid.uuid4(), mode, location,
        partner if mode == 'outbound' else None, date, [scan(i) for i in indices], 'QA')
    complete = lambda: rpc('dbmt_label_complete_production_reviewed', pin, order['id'], [log['id'] for log in logs], None)
    if completed:
        complete()
    if manual_sale:
        source = lookup(0)['stockRowId']
        row = dict(id=uid('manual'), date='2026-11-11', type='출고', product=order['product'], lot=order['lot'], origin='국내산',
                   weight=15, stockRowId=source, stockLocation='가공장', stockUnitPrice=0, price=1, amount=15, trader=uid('partner'), _isUser=True)
        assert rpc('dbmt_erp_save_transactions', token, [row], [])['ok']
    request, scans = uuid.uuid4(), [scan(i) for i in range(3)]
    done = rpc('dbmt_pda_commit', token, request, 'outbound', shipment_location, partner, '2026-11-11', scans, 'QA')
    ids = [item['transactionId'] for item in done['items']]
    cancel = lambda values, rows=[]: rpc('dbmt_erp_save_transactions', token, rows, values)
    return locals()


def check(conn):
    f = fixture(conn)
    rpc, cancel, lookup, commit, reject = [f[k] for k in ['rpc', 'cancel', 'lookup', 'commit', 'reject']]
    ids, role, token = [f[k] for k in ['ids', 'role', 'token']]
    originals = conn.execute('select raw from public.transactions where id=any(%s) order by id', (ids,)).fetchall()
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_delete=false where role_id=%s and menu_code='transactions'", (role,))
        assert not cancel(ids)['ok']
        assert all(lookup(i)['state'] == 'shipped' for i in range(3))
    assert not rpc('dbmt_erp_save_transactions', 'invalid-session', [], ids)['ok']
    reject(lambda: conn.execute('update public.transactions set deleted_at=now() where id=%s', (ids[0],)), '일반 거래내역')
    reject(lambda: conn.execute('delete from public.transactions where id=%s', (ids[0],)), '삭제할 수 없습니다')
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_view=false,can_create=false where role_id=%s and menu_code='pda'", (role,))
        conn.execute("update public.erp_role_permissions set can_update=false,can_create=false where role_id=%s and menu_code='transactions'", (role,))
        assert cancel([ids[0]])['cancelledPdaShipments'] == [ids[0]], 'ERP delete permission alone is sufficient'
    before = lookup(0)
    assert cancel([ids[0]])['cancelledPdaShipments'] == [ids[0]]
    restored = lookup(0)
    assert restored['state'] == 'in_stock' and restored['productionPending'] and restored['revision'] > before['revision']
    assert restored['stockRowId'] == before['stockRowId'] and restored['weight'] == before['weight']
    assert conn.execute('select count(*) from public.production_entries where product=%s', (f['order']['product'],)).fetchone()[0] == 0
    assert cancel([ids[0]])['cancelledPdaShipments'] == [ids[0]] and lookup(0)['revision'] == restored['revision']
    deleted_row = conn.execute('select raw from public.transactions where id=%s', (ids[0],)).fetchone()[0]
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [deleted_row], []), '재사용')
    retried = rpc('dbmt_pda_commit', token, f['request'], 'outbound', '가공장', f['partner'], '2026-11-11', f['scans'], 'QA')
    assert retried['alreadySaved'] and retried['cancelledTransactionIds'] == [ids[0]] and lookup(0)['state'] == 'in_stock'
    reject(lambda: rpc('dbmt_pda_commit', token, uuid.uuid4(), 'outbound', '가공장', f['partner'], '2026-11-11', [f['scans'][0]], 'QA'), '다른 작업자')
    new_ship = commit('outbound', [0], date='2026-11-10')
    assert lookup(0)['state'] == 'shipped', 'A cancelled future-dated movement does not block correction of the work date'
    revision = lookup(0)['revision']
    assert cancel([ids[0]])['ok'] and lookup(0)['revision'] == revision and lookup(0)['state'] == 'shipped'
    active_ids = [new_ship['items'][0]['transactionId'], ids[1], ids[2]]
    assert len(cancel(active_ids)['cancelledPdaShipments']) == 3
    f['complete']()
    source = lookup(0)['stockRowId']
    assert all(lookup(i)['state'] == 'in_stock' and not lookup(i)['productionPending'] for i in range(3))
    assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == 15
    assert conn.execute('select count(*) from public.transactions where id=any(%s) and deleted_at is not null', (ids,)).fetchone()[0] == 3
    assert len(originals) == 3
    assert rpc('dbmt_pda_history', token)['rows'][0]['result']['cancelledTransactionIds']
    print('PASS: ERP delete-only permission, pending grouped/single cancellation, no fake production/inbound, restored state/revisions, old retry safety, stale scans, re-shipment/date correction and later full production stock')


def completed_checks(conn):
    f = fixture(conn)
    rpc, cancel, lookup, commit, reject = [f[k] for k in ['rpc', 'cancel', 'lookup', 'commit', 'reject']]
    ids = f['ids']
    pid = f['complete']()['productionId']
    entry = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    corrected = copy.deepcopy(entry)
    corrected['outputs'][0]['price'], corrected['outputs'][0]['amount'] = 6000, 90000
    assert rpc('dbmt_erp_save_production', f['token'], corrected, [], pid)['ok']
    saved_production = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    package_before = lookup(0)
    assert len(cancel(ids[:2])['cancelledPdaShipments']) == 2
    assert lookup(0)['stockRowId'] == package_before['stockRowId'] and lookup(0)['state'] == 'in_stock'
    source = lookup(0)['stockRowId']
    assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == 10
    assert conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0] == saved_production
    assert conn.execute('select stock_unit_price from public.transactions where id=%s', (ids[0],)).fetchone()[0] == 6000
    commit('inbound', [2], location='물류창고')
    reject(lambda: cancel([ids[2]]), '후속 처리')
    reship = commit('outbound', [2], location='물류창고')
    reject(lambda: cancel([ids[2]]), '후속 처리')
    returned_source = lookup(2)['stockRowId']
    assert cancel([reship['items'][0]['transactionId']])['ok']
    assert lookup(2)['location'] == '물류창고' and lookup(2)['stockRowId'] == returned_source
    assert conn.execute("select pda_private.balance(%s,'물류창고')", (returned_source,)).fetchone()[0] == 5
    reject(lambda: cancel([ids[2]]), '후속 처리')
    print('PASS: cancellation after cost settlement restores the final source and leaves production/cost unchanged; prior return/re-shipment protected, latest re-shipment restores the returned warehouse source')


def atomic_checks(conn):
    f = fixture(conn, completed=True)
    cancel, commit, lookup, reject = [f[k] for k in ['cancel', 'commit', 'lookup', 'reject']]
    last_id = sorted(f['ids'])[-1]
    index = f['ids'].index(last_id)
    commit('inbound', [index])
    before = conn.execute('select to_jsonb(t) from public.transactions t where id=any(%s) order by id', (f['ids'],)).fetchall()
    packages = conn.execute('select to_jsonb(p) from public.pda_packages p where label_id=any(%s) order by label_id', ([log['id'] for log in f['logs']],)).fetchall()
    batch_before = conn.execute('select result from public.pda_batches where id=%s', (f['request'],)).fetchone()[0]
    reject(lambda: cancel(f['ids']), '후속 처리')
    assert conn.execute('select to_jsonb(t) from public.transactions t where id=any(%s) order by id', (f['ids'],)).fetchall() == before
    assert conn.execute('select to_jsonb(p) from public.pda_packages p where label_id=any(%s) order by label_id', ([log['id'] for log in f['logs']],)).fetchall() == packages
    assert conn.execute('select result from public.pda_batches where id=%s', (f['request'],)).fetchone()[0] == batch_before
    active_id = next(i for i in f['ids'] if i != last_id)
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='transactions'", (f['role'],))
        reject(lambda: cancel([active_id], [dict(id='qa_denied_' + uuid.uuid4().hex, type='입고')]), '권한')
        assert lookup(f['ids'].index(active_id))['state'] == 'shipped'
    raw = conn.execute('select raw from public.transactions where id=%s', (active_id,)).fetchone()[0]
    reject(lambda: cancel([active_id], [raw]), '동시에')
    assert conn.execute('select count(*) from pda_private.product_shipment_cancellations where transaction_id=any(%s)', (f['ids'],)).fetchone()[0] == 0
    print('PASS: group dependency failure and mixed-write failure roll back every cancellation, package state, audit and batch result; same-row update/delete rejected')


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_product_cancel_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_PRODUCT_CANCEL_DEPLOYED') != '1':
            conn.execute(MIGRATION.read_text(encoding='utf-8-sig'))
        for test in [check, completed_checks, atomic_checks]:
            with conn.transaction(force_rollback=True):
                test(conn)
        with conn.transaction(force_rollback=True):
            f = fixture(conn, completed=True, manual_sale=True)
            assert f['cancel']([f['ids'][0]])['ok']
            source = f['lookup'](0)['stockRowId']
            assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == -10
            print('PASS: cancelling an accepted negative shipment restores weight without blocking on the remaining book shortage')
        with conn.transaction(force_rollback=True):
            f = fixture(conn, shipment_location='물류창고')
            assert f['cancel'](f['ids'])['ok']
            assert all(f['lookup'](i)['location'] == '가공장' for i in range(3))
            f['complete']()
            source = f['lookup'](0)['stockRowId']
            assert conn.execute("select pda_private.balance(%s,'가공장'),pda_private.balance(%s,'물류창고')", (source, source)).fetchone() == (15, 0)
            print('PASS: first pending shipment from another location restores its pre-shipment location and later production stock without phantom warehouse balances')
        assert not conn.execute("select has_table_privilege('anon','pda_private.product_shipment_cancellations','SELECT,INSERT,UPDATE,DELETE')").fetchone()[0]
        assert not conn.execute("select has_function_privilege('anon','pda_private.cancel_product_shipment(uuid,text)','EXECUTE')").fetchone()[0]
        for filename in ['check-pda-shipment-edits-db.py', 'check-pda-cost-db.py', 'check-pda-product-db.py', 'check-pda-receipts-db.py']:
            with conn.transaction(force_rollback=True):
                regression(conn, filename)
    finally:
        conn.rollback()
        print('All schema and virtual fixtures rolled back. No operating shipments cancelled.')
