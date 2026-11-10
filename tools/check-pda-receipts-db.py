"""Grouped raw receipts and safe ERP cancellation; every fixture/DDL is rolled back."""
import os
import ast
import uuid
from decimal import Decimal
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261110073257_pda_raw_grouped_receipts.sql'


def check(conn, extra_check=None):
    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            value = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                 tuple(Jsonb(v) if isinstance(v, (dict, list)) else v for v in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    def reject(call, text):
        try:
            with conn.transaction():
                call()
        except psycopg.Error as error:
            assert text in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + text)

    suffix = uuid.uuid4().hex[:12]
    role, user, partner = (uuid.uuid4() for _ in range(3))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    pid = 'qa_receipt_' + suffix
    product = dict(id=pid, name='QA receipt ' + suffix, kind='원료육', origin='국내산', storage='냉동', packunit='')
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Receipt QA')", (role, 'qr_' + suffix))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Receipt QA','unused',%s)", (user, 'qr_' + suffix, role))
    for menu in ['pda', 'transactions']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)", (role, menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매입/매출')", (partner, 'QR' + suffix.upper(), 'QA Receipt partner ' + suffix))
    conn.execute("update public.app_data set payload=payload||%s where key='labelProducts'", (Jsonb([product]),))
    seed = uuid.uuid4().int % 900000

    def lookup(code):
        return rpc('dbmt_pda_raw_lookup', token, code, None)['item']

    def scan(code):
        item = lookup(code)
        return dict(barcode=item['code'], revision=item['revision'], rule=item['ruleKey'], labelWeight=item['weight'], checked=True)

    def commit(mode, codes, request=None, lot='QA-RECEIPT', source=None, price=4400):
        return rpc('dbmt_pda_raw_commit', token, request or uuid.uuid4(), mode, '가공장', partner, '2026-11-10',
                   [scan(code) for code in codes], pid, lot, source, price, 'QA')

    codes = ['07607600224004601707' + str((seed + i) % 1000000).zfill(6) for i in range(24)]
    request = uuid.uuid4()
    original_scans = [scan(code) for code in codes[:20]]
    receipt = commit('inbound', codes[:20], request)
    assert receipt['count'] == 20 and receipt['weight'] == 341.4
    ids = {item['transactionId'] for item in receipt['items']}
    assert len(ids) == 1, ids
    tx = next(iter(ids))
    row = conn.execute('select raw from public.transactions where id=%s', (tx,)).fetchone()[0]
    source = row['stockRowId']
    assert row['weight'] == 341.4 and row['boxCount'] == 20 and len(row['_pdaRawBoxes']) == 20
    assert conn.execute("select count(distinct source_id),count(*) from pda_private.raw_packages where product_id=%s", (pid,)).fetchone() == (1, 20)
    assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == Decimal('341.4')
    assert len({lookup(code)['id'] for code in codes[:20]}) == 20
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [row['_pdaRawMergedIds'][0]]), '합산된 입고')
    assert conn.execute('select count(*) from pda_private.raw_events where batch_id=%s', (request,)).fetchone()[0] == 20
    retry = rpc('dbmt_pda_raw_commit', token, request, 'inbound', '가공장', partner, '2026-11-10', original_scans, pid, 'QA-RECEIPT', None, 4400, 'QA')
    assert retry['alreadySaved'] and {i['transactionId'] for i in retry['items']} == {tx}
    reject(lambda: commit('inbound', codes[:1]), '중복 입고')
    reject(lambda: conn.execute("update public.transactions set weight=1 where id=%s", (tx,)), '변경할 수 없습니다')
    print('PASS: 20 barcodes -> one 341.40KG/20-box source and receipt, original scans/events preserved, idempotent retry and duplicate/edit guards')
    if extra_check:
        with conn.transaction(force_rollback=True):
            extra_check(conn,locals())

    # Different receipt dates, costs, batches and LOTs retain separate sources.
    other = commit('inbound', codes[20:22], lot='QA-OTHER', price=5000)
    other_tx = other['items'][0]['transactionId']
    assert other_tx != tx and len({i['transactionId'] for i in other['items']}) == 1
    assert lookup(codes[20])['stockRowId'] != source
    with conn.transaction(force_rollback=True):
        ship = commit('outbound', codes[:2])
        assert ship['weight'] == 34.14
        assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == Decimal('307.26')
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [tx]), '연결된 PDA 입고')
        assert lookup(codes[2])['registered'] and lookup(codes[0])['state'] == 'shipped'
    print('PASS: independent outbound after grouping, exact remaining stock, used receipt cancellation rejected atomically')

    for menu in ['transactions']:
        with conn.transaction(force_rollback=True):
            conn.execute('update public.erp_role_permissions set can_delete=false where role_id=%s and menu_code=%s', (role, menu))
            denied = rpc('dbmt_erp_save_transactions', token, [], [tx])
            assert not denied['ok'] and lookup(codes[0])['registered']
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [row], [tx]), '동시에')
    # Other rows failing authorization must roll back a prepared cancellation too.
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='transactions'", (role,))
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [dict(id='qa_denied_' + suffix, date='2026-11-10', type='입고')], [tx]), '권한')
        assert lookup(codes[0])['registered']
    with conn.transaction(force_rollback=True):
        order = dict(id='qa_order_' + suffix, sourceStock=dict(stockRowId=source))
        conn.execute("update public.app_data set payload=payload||%s where key='workOrders'", (Jsonb([order]),))
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [tx]), '연결된 PDA 입고')
        assert lookup(codes[0])['registered']
    result = rpc('dbmt_erp_save_transactions', token, [], [tx])
    assert result['ok'] and result['cancelledRawReceipts'] == [tx]
    assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == 0
    assert all(not lookup(code)['registered'] for code in codes[:20])
    assert lookup(codes[20])['registered'], 'Never cancel another receipt'
    old_request = rpc('dbmt_pda_raw_commit', token, request, 'inbound', '가공장', partner, '2026-11-10', original_scans, pid, 'QA-RECEIPT', None, 4400, 'QA')
    assert old_request['alreadySaved'] and old_request['cancelledTransactionIds'] == [tx]
    assert not lookup(codes[0])['registered'], 'A retry cannot recreate a cancelled receipt'
    rereceived = commit('inbound', codes[:20], lot='QA-CORRECTED', price=4500)
    assert rereceived['items'][0]['transactionId'] != tx and lookup(codes[0])['lot'] == 'QA-CORRECTED'
    assert lookup(codes[0])['revision'] > original_scans[0]['revision']
    assert conn.execute('select count(*) from pda_private.raw_events where package_id=%s', (lookup(codes[0])['id'],)).fetchone()[0] == 2
    assert conn.execute('select count(*) from pda_private.raw_receipt_context where transaction_xid=txid_current()').fetchone()[0] == 0
    print('PASS: ERP delete permission, combined-write rollback, work-order protection, whole-receipt cancellation, audit retention, old retry and re-receiving corrected LOT')
    with conn.transaction():
        conn.execute('set local role anon')
        reject(lambda: conn.execute('select * from pda_private.raw_receipt_context'), 'permission denied')
        reject(lambda: conn.execute('select pda_private.raw_group_receipts(%s)', (request,)), 'permission denied')
        conn.execute('set local role postgres')
    print('PASS: private helpers/context cannot be called or forged by API roles')


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_receipt_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_RECEIPT_TEST_DEPLOYED') != '1':
            totals_sql = "select coalesce(sum(weight),0),coalesce(sum(amount),0),coalesce(sum((raw->>'boxCount')::numeric),0) from public.transactions where deleted_at is null and type='입고' and raw ? '_pdaRawRequestId'"
            totals = conn.execute(totals_sql).fetchone()
            packages_before = conn.execute('select id,barcode,parsed,product_id,snapshot,weight,state,location,work_date from pda_private.raw_packages order by id').fetchall()
            conn.execute(MIGRATION.read_text(encoding='utf-8'))
            assert conn.execute(totals_sql).fetchone() == totals, 'Backfill must preserve weight, amount and box totals'
            assert conn.execute('select id,barcode,parsed,product_id,snapshot,weight,state,location,work_date from pda_private.raw_packages order by id').fetchall() == packages_before
            print('PASS: migration/backfill compiled inside rollback-only transaction')
        check(conn)
        for filename in ['check-pda-raw-db.py', 'check-pda-cost-db.py']:
            with conn.transaction(force_rollback=True):
                tree = ast.parse((ROOT / 'tools' / filename).read_text(encoding='utf-8-sig'))
                definitions = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))], type_ignores=[])
                namespace = {'ROOT': ROOT, '__file__': str(ROOT / 'tools' / filename)}
                exec(compile(definitions, filename, 'exec'), namespace)
                namespace['check'](conn)
        print('PASS: existing raw parsing/bind/outbound and product provisional/cost regressions')
    finally:
        conn.rollback()
        print('All DDL and fixtures rolled back.')
