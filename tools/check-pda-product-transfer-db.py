"""Product PDA movement checks against the linked schema. Every fixture rolls back."""
import ast
import copy
import os
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
FACTORY, WAREHOUSE = '가공장', '물류창고'


def product_fixture(conn):
    path = ROOT / 'tools/check-pda-product-cancellations-db.py'
    tree = ast.parse(path.read_text(encoding='utf-8-sig'))
    namespace = {'__file__': str(path)}
    definitions = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef))]
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(path), 'exec'), namespace)

    def save_label_logs(connection, pin, order, logs):
        result = connection.execute('select public.dbmt_label_print_save_logs(%s,%s,%s)',
                                    (pin, Jsonb(logs), order['id'])).fetchone()[0]
        assert result['ok']

    return namespace['fixture'](conn, ship=False, save_label_logs=save_label_logs)


def check(conn):
    f = product_fixture(conn)
    rpc, lookup, scan, commit, reject = (f[key] for key in ['rpc', 'lookup', 'scan', 'commit', 'reject'])
    token, role = f['token'], f['role']

    def move(items, origin=FACTORY, destination=WAREHOUSE, request=None, date='2026-11-11', note='QA transfer'):
        return rpc('dbmt_pda_transfer', token, request or uuid.uuid4(), origin, destination, date, items, note)

    def balances(source):
        return conn.execute('select pda_private.balance(%s,%s),pda_private.balance(%s,%s)',
                            (source, FACTORY, source, WAREHOUSE)).fetchone()

    assert lookup(0)['productionPending']
    reject(lambda: move([scan(0)]), '생산')
    assert not lookup(0)['registered']
    production = f['complete']()['productionId']
    initial = lookup(0)
    source = initial['stockRowId']
    assert not initial['registered'] and not initial['productionPending'] and initial['location'] == FACTORY
    assert balances(source) == (15, 0)
    assert commit('inbound', [1])['received'] == 1 and balances(source) == (15, 0)
    original_batches = len(rpc('dbmt_pda_history', token)['rows'])

    reject(lambda: move([scan(0)], FACTORY, FACTORY))
    reject(lambda: move([scan(0)], 'QA-UNKNOWN', WAREHOUSE))
    reject(lambda: move([scan(0)], WAREHOUSE, FACTORY))
    reject(lambda: move([scan(0), scan(0)]), '중복')
    reject(lambda: move([scan(0), dict(scan(1), revision=99)]))
    reject(lambda: move([scan(0)], date='2026-11-09'))
    assert len(rpc('dbmt_pda_history', token)['rows']) == original_batches
    assert balances(source) == (15, 0) and not lookup(0)['registered']
    assert lookup(1)['location'] == FACTORY

    with conn.transaction(force_rollback=True):
        # A manually deducted box can make its unregistered sibling ambiguous.
        # The observed registered barcode can still move when there is enough stock.
        row = dict(id='tx_qa_' + uuid.uuid4().hex, type='출고', date='2026-11-11', product=f['order']['product'],
                   lot=f['order']['lot'], stockRowId=source, stockLocation=FACTORY, weight=5, boxCount=1,
                   stockUnitPrice=initial['productionCost'], price=1, amount=5, _isUser=True)
        assert rpc('dbmt_erp_save_transactions', token, [row], [])['ok']
        reject(lambda: move([scan(0)]))
        assert not lookup(0)['registered'] and balances(source) == (10, 0)
        assert move([scan(1)])['count'] == 1 and balances(source) == (5, 5)

    request = uuid.uuid4()
    staged = [scan(0), scan(1)]
    result = move(staged, request=request)
    assert (result['count'], result['weight'], result['fromLocation'], result['toLocation']) == (2, 10, FACTORY, WAREHOUSE)
    assert result['requestId'] == str(request) and {item['action'] for item in result['items']} == {'transfer'}
    assert balances(source) == (5, 10)
    for index, item in enumerate(result['items']):
        current = lookup(index)
        assert current['registered'] and current['state'] == 'in_stock' and current['stockRowId'] == source
        assert current['location'] == WAREHOUSE and current['revision'] == staged[index]['revision'] + 1
        assert (current['code'], current['weight']) == (staged[index]['barcode'], 5)
        row = conn.execute('select type,from_location,to_location,stock_unit_price,weight,raw from public.transactions where id=%s',
                           (item['transactionId'],)).fetchone()
        assert row[:5] == ('재고이동', FACTORY, WAREHOUSE, Decimal(str(initial['productionCost'])), 5)
        assert (row[5]['stockRowId'], row[5]['boxCount'], row[5]['_pdaAction'], row[5]['_pdaLabelId']) == (
            source, 1, 'transfer', current['labelId'])
        assert row[5]['_serverAudit']['savedAt']
    assert conn.execute("select count(*) from public.transactions where raw->>'stockRowId'=%s and type in ('입고','생산입고') and deleted_at is null",
                        (source,)).fetchone()[0] == 1
    assert conn.execute("select count(*) from public.pda_package_events where batch_id=%s and action='transfer'", (request,)).fetchone()[0] == 2
    assert conn.execute('select count(*) from public.change_logs where entity_id=%s', (str(request),)).fetchone()[0] == 1
    assert move(staged, request=request)['alreadySaved'] and balances(source) == (5, 10)
    reject(lambda: move(staged, WAREHOUSE, FACTORY, request=request))
    reject(lambda: move(staged, WAREHOUSE, FACTORY))
    reject(lambda: move([scan(1)], FACTORY, WAREHOUSE))
    reject(lambda: move([scan(1)], WAREHOUSE, FACTORY, date='2026-11-10'))
    movement = result['items'][0]['transactionId']
    reject(lambda: conn.execute('update public.transactions set weight=1 where id=%s', (movement,)))
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [movement]))
    print('PASS: unregistered and confirmed product labels move together; atomic source stock, cost, traceable events, legacy inbound/outbound and retry guards')

    reverse = move([scan(0)], WAREHOUSE, FACTORY)
    assert (reverse['fromLocation'], reverse['toLocation']) == (WAREHOUSE, FACTORY)
    assert balances(source) == (10, 5) and lookup(0)['location'] == FACTORY
    assert commit('outbound', [1], location=WAREHOUSE)['shipped'] == 1 and balances(source) == (10, 0)
    reject(lambda: move([scan(1)], WAREHOUSE, FACTORY))
    assert commit('inbound', [1], location=WAREHOUSE)['returned'] == 1
    returned = lookup(1)['stockRowId']
    assert returned != source and balances(returned) == (0, 5)
    assert move([scan(1)], WAREHOUSE, FACTORY)['count'] == 1
    assert balances(returned) == (5, 0) and balances(source) == (10, 0)

    history = rpc('dbmt_pda_history', token)['rows']
    routes = {(row['request']['location'], row['request']['toLocation']) for row in history if row['request']['mode'] == 'transfer'}
    assert routes == {(FACTORY, WAREHOUSE), (WAREHOUSE, FACTORY)}
    corrected = copy.deepcopy(conn.execute('select raw from public.production_entries where id=%s', (production,)).fetchone()[0])
    output = corrected['outputs'][0]
    output['price'], output['amount'] = 5555, 5555 * output['qty']
    assert rpc('dbmt_erp_save_production', token, corrected, [], production)['ok']
    assert conn.execute('select price,stock_unit_price,amount from public.transactions where id=%s', (movement,)).fetchone() == (5555, 5555, 27775)
    print('PASS: both directions, destination outbound, return-source movement, history and production cost correction')

    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='pda'", (role,))
        reject(lambda: move([scan(0)]), '권한')
    with conn.transaction(force_rollback=True):
        conn.execute("delete from public.erp_role_permissions where role_id=%s and menu_code<>'pda'", (role,))
        assert move([scan(0)])['count'] == 1
    print('PASS: product movements use the existing PDA permissions')

    parent = scan(2)
    split = rpc('dbmt_label_weight_split', f['pin'], None, uuid.uuid4(), parent['barcode'], parent['revision'], FACTORY, [2, 3])
    first, second = split['labels']
    assert first['labelWeight'] == 2 and second['labelWeight'] == 3
    child = rpc('dbmt_pda_lookup', token, first['code'])['item']
    work_date = conn.execute("select (now() at time zone 'Asia/Seoul')::date").fetchone()[0]
    reject(lambda: move([parent], date=work_date), '분할')
    moved_child = move([dict(barcode=child['code'], revision=child['revision'])], date=work_date)
    assert moved_child['weight'] == 2 and balances(source) == (8, 2)
    assert rpc('dbmt_pda_lookup', token, first['code'])['item']['location'] == WAREHOUSE
    assert rpc('dbmt_pda_lookup', token, second['code'])['item']['location'] == FACTORY
    print('PASS: a split product child moves independently and its retired parent stays unavailable')


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_product_transfer_qa') as connection:
    try:
        connection.execute('set local role postgres')
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_PDA_PRODUCT_TRANSFER_DEPLOYED') != '1':
            migration = next((ROOT / 'supabase/migrations').glob('*_pda_product_bidirectional_transfer.sql'))
            connection.execute(migration.read_text(encoding='utf-8-sig'))
        check(connection)
    finally:
        connection.rollback()
        print('All product transfer fixtures and DDL rolled back. No operating stock changed.')
