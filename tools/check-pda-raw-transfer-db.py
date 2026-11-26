"""PDA warehouse-to-factory raw transfer. All fixtures and DDL roll back."""
import ast
import os
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = next((ROOT / 'supabase/migrations').glob('*_pda_raw_manual_warehouse_transfer.sql'))


def transfer_checks(conn, fixture):
    rpc, reject, scan, lookup = (fixture[key] for key in ['rpc', 'reject', 'scan', 'lookup'])
    token, pid, partner, role = (fixture[key] for key in ['token', 'pid', 'partner', 'role'])
    source = 'stock_qa_transfer_' + uuid.uuid4().hex
    lot = 'QA-MOVE'

    def receipt(source, lot, location='물류창고', weight=100, boxes=5, date='2026-11-09'):
        raw = dict(fixture['product'], id='tx_qa_' + uuid.uuid4().hex, product=fixture['product']['name'],
                   labelProductId=pid, date=date, type='입고', lot=lot, weight=weight, boxCount=boxes, price=4400,
                   amount=weight * 4400, trader='QA warehouse supplier', stockRowId=source, stockLocation=location, _isUser=True)
        assert rpc('dbmt_erp_save_transactions', token, [raw], [])['ok']
        return raw['id']

    def transfer(items, source_id=source, source_lot=lot, request=None, date='2026-11-10', note='QA 이동'):
        return rpc('dbmt_pda_raw_transfer', token, request or uuid.uuid4(), date, items, pid, source_lot, source_id, note)

    def sources():
        return {row['id']: row for row in rpc('dbmt_pda_raw_transfer_sources', token, pid)['rows']}

    def balance(source_id=source):
        return conn.execute("select pda_private.balance(%s,'물류창고'),pda_private.balance(%s,'가공장')",
                            (source_id, source_id)).fetchone()

    def manual():
        return dict(barcode='DR1' + str(uuid.uuid4().int % 10**26).zfill(26), revision=0, rule='manual:v1',
                    labelWeight=22.32, checked=True, manualWeight=49.2, manualUnit='LB')

    receipt_id = receipt(source, lot)
    factory_source = 'stock_qa_factory_' + uuid.uuid4().hex
    receipt(factory_source, 'QA-FACTORY', location='가공장')
    prior_code, scanned_code, later_code, blocked_code = fixture['codes'][20:24]
    prior = rpc('dbmt_pda_raw_commit', token, uuid.uuid4(), 'inbound', '물류창고', None, '2026-11-09',
                [scan(prior_code)], pid, lot, source, 4400, 'QA bind')
    assert prior['items'][0]['action'] == 'bind'
    assert factory_source not in sources()
    assert (sources()[source]['available'], sources()[source]['unlinkedWeight'], sources()[source]['linkedBoxes']) == (100, 82.93, 1)

    handwritten = manual()
    request = uuid.uuid4()
    batch = [scan(prior_code), scan(scanned_code), handwritten]
    reject(lambda: transfer(batch, source_lot='잘못된 LOT'), '이력번호')
    reject(lambda: transfer(batch, date='2026-11-08'), '기존 입고일')
    reject(lambda: transfer([batch[0], batch[0]]), '중복')
    reject(lambda: transfer([dict(batch[0], revision=0)]), '다른 작업자')
    reject(lambda: transfer([handwritten, dict(batch[1], labelWeight=5)]), '중량')
    assert conn.execute('select count(*) from pda_private.raw_manual_labels where barcode=%s', (handwritten['barcode'],)).fetchone()[0] == 0
    assert balance() == (Decimal('100'), Decimal('0'))

    result = transfer(batch, request=request)
    assert result['count'] == 3 and result['weight'] == 56.46, result
    tx_id = result['transactionId']
    assert [item['newlyLinked'] for item in result['items']] == [False, True, True]
    assert {item['action'] for item in result['items']} == {'transfer'}
    assert result['items'][2]['barcode'] == handwritten['barcode'] and result['items'][2]['manualUnit'] == 'LB'
    assert {item['transactionId'] for item in result['items']} == {tx_id}
    assert balance() == (Decimal('43.54'), Decimal('56.46'))
    assert conn.execute("select type,from_location,to_location,price,weight,raw from public.transactions where id=%s", (tx_id,)).fetchone()[:5] == (
        '재고이동', '물류창고', '가공장', Decimal('4400'), Decimal('56.46'))
    raw = conn.execute('select raw from public.transactions where id=%s', (tx_id,)).fetchone()[0]
    assert raw['stockRowId'] == source and raw['boxCount'] == 3 and raw['_pdaAction'] == 'transfer' and raw['_serverAudit']['savedAt']
    assert conn.execute("select count(*) from public.transactions where raw->>'stockRowId'=%s and type='입고' and deleted_at is null", (source,)).fetchone()[0] == 1
    assert conn.execute("select count(*) from pda_private.raw_events where batch_id=%s and action='transfer' and transaction_id=%s", (request, tx_id)).fetchone()[0] == 3
    assert conn.execute("select array_agg(action) from public.change_logs where entity='PDA 원료육' and entity_id=%s", (str(request),)).fetchone()[0] == ['재고이동']
    assert lookup(prior_code)['revision'] == 2 and lookup(scanned_code)['revision'] == 2
    for code in [prior_code, scanned_code, handwritten['barcode']]:
        item = lookup(code)
        assert (item['stockRowId'], item['state'], item['location']) == (source, 'in_stock', '가공장')
    history = rpc('dbmt_pda_raw_history', token)
    saved = next(row for row in history['rows'] if row['id'] == str(request))
    assert saved['request']['mode'] == 'transfer' and saved['request']['toLocation'] == '가공장'
    conn.execute('set constraints all immediate')
    conn.execute('set constraints all deferred')
    retry = transfer(batch, request=request)
    assert retry['alreadySaved'] and retry['transactionId'] == tx_id and retry['items'] == result['items']
    reject(lambda: transfer(batch, request=request, note='다른 내용'), '같은 요청번호')
    reject(lambda: transfer([scan(scanned_code)]), '남아 있는 박스')
    reject(lambda: conn.execute('update public.transactions set weight=1 where id=%s', (tx_id,)), '변경할 수 없습니다')
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [tx_id]), '변경할 수 없습니다')
    print('PASS: existing + newly scanned + LB boxes move together with source and cost intact; no second receipt; retry, audit and edit/delete protection')

    second = transfer([scan(later_code)])
    assert second['weight'] == 17.07 and balance() == (Decimal('26.47'), Decimal('73.53'))
    assert (sources()[source]['available'], sources()[source]['linkedBoxes']) == (26.47, 0)
    ship = rpc('dbmt_pda_raw_commit', token, uuid.uuid4(), 'outbound', '가공장', partner, '2026-11-10',
               [scan(scanned_code)], None, '', None, 0, 'QA ship')
    assert ship['count'] == 1 and lookup(scanned_code)['state'] == 'shipped'
    assert balance() == (Decimal('26.47'), Decimal('56.46'))
    assert conn.execute("select count(*) from public.transactions where id=%s and deleted_at is null", (receipt_id,)).fetchone()[0] == 1
    assert rpc('dbmt_pda_raw_transfer_sources', token, 'invalid product')['rows'] == []
    with conn.transaction(force_rollback=True):
        assert transfer([manual()])['count'] == 1
        assert balance()[0] == Decimal('4.15')
        reject(lambda: transfer([scan(blocked_code)]), '재고 중량')
    print('PASS: remaining warehouse stock transfers again and the same scanned box ships from the factory')

    boxed = 'stock_qa_box_cap_' + uuid.uuid4().hex
    receipt(boxed, 'QA-BOX-CAP', boxes=1)
    reject(lambda: transfer([manual(), manual()], boxed, 'QA-BOX-CAP'), '재고 박스수')
    with conn.transaction(force_rollback=True):
        prebound = scan(blocked_code)
        rpc('dbmt_pda_raw_commit', token, uuid.uuid4(), 'inbound', '물류창고', None, '2026-11-11',
            [prebound], pid, 'QA-BOX-CAP', boxed, 4400, 'QA bind only')
        reject(lambda: transfer([scan(blocked_code)], boxed, 'QA-BOX-CAP'), '이전 처리일')
        only_bound = transfer([scan(blocked_code)], boxed, 'QA-BOX-CAP', date='2026-11-11')
        assert only_bound['count'] == 1 and only_bound['items'][0]['newlyLinked'] is False
        assert balance(boxed) == (Decimal('82.93'), Decimal('17.07'))

    historical = 'stock_qa_backdated_' + uuid.uuid4().hex
    receipt(historical, 'QA-BACKDATE', weight=10)
    conn.execute("""insert into public.transactions(id,date,type,product,lot,weight,stock_location,raw)
        values(%s,'2026-11-12','재고조정',%s,'QA-BACKDATE',30,'물류창고',jsonb_build_object('stockRowId',%s::text,'boxCount',1))""",
        ('tx_qa_' + uuid.uuid4().hex, fixture['product']['name'], historical))
    assert balance(historical) == (Decimal('40'), Decimal('0'))
    reject(lambda: transfer([scan(blocked_code)], historical, 'QA-BACKDATE'), '이동일 이후')
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='pda'", (role,))
        reject(lambda: transfer([scan(blocked_code)]), '권한')
        assert sources()[source]['available'] == 26.47
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='pda'", (role,))
        reject(sources, '권한')
    assert not conn.execute("select has_function_privilege('anon','pda_private.raw_manual_warehouse_receipts(text)','EXECUTE')").fetchone()[0]
    print('PASS: existing-only scan, known box count, historical balance and authorization guards')


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_raw_transfer_qa') as connection:
    try:
        connection.execute('set local role postgres')
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_PDA_TRANSFER_DEPLOYED') != '1':
            connection.execute(MIGRATION.read_text(encoding='utf-8-sig'))
        path = ROOT / 'tools/check-pda-receipts-db.py'
        tree = ast.parse(path.read_text(encoding='utf-8-sig'))
        namespace = {'__file__': str(path)}
        definitions = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign))]
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(path), 'exec'), namespace)
        namespace['check'](connection, extra_check=transfer_checks)
    finally:
        connection.rollback()
        print('All transfer fixtures and DDL rolled back. No operating stock changed.')
