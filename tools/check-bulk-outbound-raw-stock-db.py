"""Check manual outbound availability and source guards using rollback-only PDA receipts."""
import ast
import os
import uuid
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = next((ROOT / 'supabase/migrations').glob('*_bulk_outbound_raw_stock.sql'))


def receipt_fixture():
    path = ROOT / 'tools/check-pda-receipts-db.py'
    tree = ast.parse(path.read_text(encoding='utf-8'))
    names = {'check', 'ROOT', 'MIGRATION'}
    body = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))
            or isinstance(node, ast.FunctionDef) and node.name in names
            or isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets)]
    scope = {'__file__': str(path)}
    exec(compile(ast.Module(body=body, type_ignores=[]), path, 'exec'), scope)
    return scope['check']


def check_availability(conn, fixture):
    rpc, reject, commit = (fixture[key] for key in ('rpc', 'reject', 'commit'))
    codes, token, role, receipt = (fixture[key] for key in ('codes', 'token', 'role', 'row'))

    def adjust_weight(row, weight):
        return rpc('dbmt_erp_save_transactions', token, [dict(row, weight=weight)], [])['updatedRawReceipts'][0]

    def receive(codes):
        saved = commit('inbound', codes)
        transaction_id = saved['items'][0]['transactionId']
        return conn.execute('select raw from public.transactions where id=%s', (transaction_id,)).fetchone()[0]

    def read(sources, session=token):
        return rpc('dbmt_erp_get_bulk_outbound_raw_stock', session, sources)

    def movement(source, weight, transaction_type='출고'):
        return {key: source[key] for key in ('product', 'lot', 'origin', 'packunit', 'stockRowId', 'stockLocation') if key in source} | {
            'id': 'qa_bulk_' + uuid.uuid4().hex, 'date': '2026-11-10', 'type': transaction_type,
            'weight': weight, 'boxCount': 0, 'price': 4400, 'amount': round(weight * 4400),
            'stockUnitPrice': 4400, '_isUser': True,
        }

    short = adjust_weight(receipt, 333.4)  # 341.40 KG still reserved in 20 scans.
    extra = adjust_weight(receive(codes[20:22]), 55.56)  # 34.14 KG reserved in two scans.
    split = adjust_weight(receive(codes[22:23]), 23.07)  # 17.07 KG reserved in one scan.
    move = dict(movement(split, 2, '재고이동'), fromLocation='가공장', toLocation='물류창고')
    assert rpc('dbmt_erp_save_transactions', token, [move], [])['ok']

    ordinary = movement(split, 4, '입고')
    ordinary['stockRowId'] = 'stock_qa_ordinary_' + uuid.uuid4().hex
    assert rpc('dbmt_erp_save_transactions', token, [ordinary], [])['ok']
    cancelled = receive(codes[23:24])
    assert rpc('dbmt_erp_save_transactions', token, [], [cancelled['id']])['ok']

    request = [{'stockRowId': row['stockRowId']} for row in (short, extra, split, ordinary, cancelled)]
    request += [
        {'stockRowId': split['stockRowId'], 'stockLocation': ' 물류창고 '},
        {'stockRowId': split['stockRowId'], 'stockLocation': '가공장'},
        {'stockRowId': short['stockRowId'], 'stockLocation': '물류창고'},
        {'stockRowId': short['stockRowId'], 'stockLocation': '미등록 창고'},
        {'stockRowId': 'unregistered-' + uuid.uuid4().hex},
    ]

    readback = read(request)
    assert readback['ok'] and all(set(row) == {'stockRowId', 'stockLocation', 'availableWeight', 'reservedBoxes'} for row in readback['rows'])
    rows = {(row['stockRowId'], row['stockLocation']): (row['availableWeight'], row['reservedBoxes']) for row in readback['rows']}
    assert len(readback['rows']) == len(rows) == 4
    assert rows == {
        (short['stockRowId'], '가공장'): (0, 20),
        (extra['stockRowId'], '가공장'): (21.42, 2),
        (split['stockRowId'], '가공장'): (4, 1),
        (split['stockRowId'], '물류창고'): (2, 0),
    }, rows
    assert read([]) == {'ok': True, 'rows': []}
    assert read(request, 'invalid-session')['code'] == 'session_expired'
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_view=false,can_create=false where role_id=%s and menu_code='pda'", (role,))
        assert read(request) == readback
    for permission in ('can_view', 'can_create'):
        with conn.transaction(force_rollback=True):
            conn.execute(f"update public.erp_role_permissions set {permission}=false where role_id=%s and menu_code='transactions'", (role,))
            denied = read(request)
            assert denied['code'] == 'permission_denied' and 'rows' not in denied
    reject(lambda: read({}), '올바른 목록')
    reject(lambda: read([{'stockRowId': 1}]), '올바른 목록')
    reject(lambda: read([request[0]] * 501), '500건')

    outbound = [movement(extra, 21.42), movement(split, 4)]
    forbidden = movement(extra, 21.43)
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [outbound[1], forbidden], []), 'PDA 원료육 박스 몫')
    assert read(request)['rows'] == readback['rows'], 'Failed mixed save must not deduct an earlier source'
    assert rpc('dbmt_erp_save_transactions', token, outbound, [])['ok']
    saved = read(request)['rows']
    assert all(row['availableWeight'] == 0 for row in saved if row['stockLocation'] == '가공장')
    assert all(row['reservedBoxes'] == rows[(row['stockRowId'], row['stockLocation'])][1] for row in saved)
    print('PASS: exact per-source unreserved KG, corrected shortfall, distinct warehouse balance, authorization and atomic outbound stock guards')


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_bulk_outbound_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_BULK_OUTBOUND_RAW_STOCK_DEPLOYED') != '1':
            conn.execute(MIGRATION.read_text(encoding='utf-8'))
        receipt_fixture()(conn, check_availability)
    finally:
        conn.rollback()
        print('All DDL and fixtures rolled back.')
