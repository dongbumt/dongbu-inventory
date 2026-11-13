"""Mixed manual/scanned raw receipts, exact pound rounding and unchanged product workflow. Rollback only."""
import os
import uuid
from decimal import Decimal
from pathlib import Path
import psycopg

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261113003104_pda_raw_manual_receipts.sql'


def manual_checks(conn, f):
    rpc, reject, scan = (f[k] for k in ['rpc', 'reject', 'scan'])
    token, pid, partner, role = (f[k] for k in ['token', 'pid', 'partner', 'role'])

    def manual(value, unit='KG'):
        weight = (Decimal(str(value)) * (Decimal('0.45359237') if unit == 'LB' else 1)).quantize(Decimal('.01'), rounding='ROUND_HALF_UP')
        return dict(barcode='DR1' + str(uuid.uuid4().int % 10**26).zfill(26), revision=0,
                    rule='manual:v1', labelWeight=float(weight), checked=True, manualWeight=value, manualUnit=unit)

    def commit(items, request=None, mode='inbound', lot='QA-MANUAL', source=None):
        return rpc('dbmt_pda_raw_commit', token, request or uuid.uuid4(), mode, '가공장', partner, '2026-11-10',
                   items, pid, lot, source, 4400, 'QA')

    def lookup(code):
        return rpc('dbmt_pda_raw_resolve', token, code, 'outbound', None, None, None, 'auto', '동부엠티', False)['item']

    first, pounds = manual(17.07), manual(49.2, 'LB')
    items = [scan(f['codes'][22]), first, pounds]
    request = uuid.uuid4()
    receipt = commit(items, request)
    assert receipt['count'] == 3 and receipt['weight'] == 56.46, receipt
    ids = {i['transactionId'] for i in receipt['items']}
    assert len(ids) == 1, receipt
    tx = next(iter(ids))
    row = conn.execute('select raw from public.transactions where id=%s', (tx,)).fetchone()[0]
    assert row['boxCount'] == 3 and row['weight'] == 56.46 and len(row['_pdaRawBoxes']) == 3
    assert len({lookup(i['barcode'])['stockRowId'] for i in items}) == 1
    source = row['stockRowId']
    assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == Decimal('56.46')
    manual_result = receipt['items'][2]
    assert manual_result['manualUnit'] == 'LB' and manual_result['manualWeight'] == 49.2
    assert manual_result['entryReason'] == '바코드 훼손 수기입고' and manual_result['barcode'] == pounds['barcode']
    parsed = lookup(pounds['barcode'])
    assert parsed['lot'] == 'QA-MANUAL' and parsed['weight'] == 22.32
    assert parsed['manualWeight'] == 49.2 and parsed['manualUnit'] == 'LB'
    assert lookup(']C0' + pounds['barcode'])['id'] == parsed['id']
    event = conn.execute('select scan from pda_private.raw_events where batch_id=%s and package_id=%s', (request, parsed['id'])).fetchone()[0]
    assert event['parsed']['manualWeight'] == 49.2 and event['parsed']['manualUnit'] == 'LB'
    assert conn.execute('select user_id,request_id from pda_private.raw_manual_labels where barcode=%s', (pounds['barcode'],)).fetchone() == (f['user'], request)
    conn.execute('set constraints all immediate')
    conn.execute('set constraints all deferred')
    retry = commit(items, request)
    assert retry['alreadySaved'] and retry['items'] == receipt['items']
    history = rpc('dbmt_pda_raw_history', token)
    assert any(r['id'] == str(request) and r['result']['items'] == receipt['items'] for r in history['rows'])
    reject(lambda: commit(items), '다른 작업자')
    reject(lambda: commit([dict(pounds, manualWeight=22.32, manualUnit='KG')], request), '원입력')
    print('PASS: normal + KG + LB boxes -> one 56.46KG/3-box receipt, original LB audit/history, idempotent retry and stable printable barcode')

    for invalid in [dict(manual(1), labelWeight=1.01), dict(manual(1), manualUnit='lb'),
                    dict(manual(1), manualWeight=-1), dict(manual(1), manualWeight=1.0000001),
                    dict(manual(1), labelWeight='1'), dict(manual(1), reason='not accepted'),
                    dict(manual(1), manualUnit=None), dict(manual(1), barcode='anything')]:
        before = conn.execute('select count(*) from pda_private.raw_manual_labels').fetchone()[0]
        reject(lambda: commit([invalid]), '수기입고')
        assert conn.execute('select count(*) from pda_private.raw_manual_labels').fetchone()[0] == before
    reject(lambda: commit([manual(1000.01)]), '수기입고')
    reject(lambda: commit([manual(.001)]), '수기입고')
    missing = manual(1)
    del missing['manualUnit']
    reject(lambda: commit([missing]), '수기입고')
    reject(lambda: commit([manual(1)], lot=' '), '이력번호')
    duplicate = manual(1)
    reject(lambda: commit([duplicate, duplicate]), '중복')
    before = conn.execute('select count(*) from pda_private.raw_manual_labels').fetchone()[0]
    reject(lambda: commit([manual(1), scan(f['codes'][0])]), '중복 입고')
    assert conn.execute('select count(*) from pda_private.raw_manual_labels').fetchone()[0] == before
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='pda'", (role,))
        reject(lambda: commit([manual(1)]), '권한')
    print('PASS: malformed/manual precision/weight/traceability/duplicate/permission guards and mixed failure roll back every label and receipt')

    with conn.transaction(force_rollback=True):
        rounding = commit([manual(1.005), manual(1, 'LB'), manual(1.01, 'LB')])
        assert [i['weight'] for i in rounding['items']] == [1.01, .45, .46]
        print('PASS: exact decimal half-up rounding at third KG decimal, KG shown/stored at two decimal places')
    with conn.transaction(force_rollback=True):
        out = commit([dict(barcode=parsed['code'], rule=parsed['ruleKey'], labelWeight=parsed['weight'], revision=parsed['revision'], checked=True)], mode='outbound')
        assert out['count'] == 1 and out['weight'] == 22.32 and lookup(pounds['barcode'])['state'] == 'shipped'
        assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == Decimal('34.14')
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [tx]), '연결된 PDA 입고')
        print('PASS: internal replacement label resolves and ships through existing PDA raw outbound without product code changes')
    with conn.transaction(force_rollback=True):
        assert rpc('dbmt_erp_save_transactions', token, [], [tx])['ok']
        assert not lookup(pounds['barcode'])['registered']
        assert commit(items, request)['cancelledTransactionIds'] == [tx]
        old = lookup(pounds['barcode'])
        rereceive = commit([dict(pounds, revision=old['revision'])], lot='QA-CORRECTED-MANUAL')
        assert rereceive['weight'] == 22.32 and lookup(pounds['barcode'])['lot'] == 'QA-CORRECTED-MANUAL'
        print('PASS: cancellation retains audit, old retry never restores stock, deliberate re-receipt reuses same physical barcode/revision')
    with conn.transaction(force_rollback=True):
        unbound = 'stock_qa_manual_' + uuid.uuid4().hex
        raw = dict(f['product'], id='qa_manual_bind_' + uuid.uuid4().hex, product=f['product']['name'],
                   labelProductId=pid, date='2026-11-10', type='입고', lot='QA-BIND', weight=10, price=4400,
                   amount=44000, trader=f['product']['name'], stockRowId=unbound, stockLocation='가공장', _isUser=True)
        assert rpc('dbmt_erp_save_transactions', token, [raw], [])['ok']
        bound = commit([manual(1.01)], source=unbound, lot='QA-BIND')
        assert bound['items'][0]['action'] == 'bind' and bound['items'][0]['transactionId'] is None
        assert conn.execute("select pda_private.balance(%s,'가공장')", (unbound,)).fetchone()[0] == 10
        print('PASS: manual existing-stock binding adds a package only, never a second receipt')
    assert not conn.execute("select has_table_privilege('anon','pda_private.raw_manual_labels','SELECT,INSERT,UPDATE,DELETE')").fetchone()[0]
    assert not conn.execute("select has_function_privilege('anon','pda_private.raw_manual_parse(text,text)','EXECUTE')").fetchone()[0]


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_manual_receipt_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_MANUAL_DEPLOYED') != '1':
            conn.execute(MIGRATION.read_text(encoding='utf-8-sig'))
        # Load only definitions, never the module's connection/DDL entry point.
        import ast
        path = ROOT / 'tools/check-pda-receipts-db.py'
        tree = ast.parse(path.read_text(encoding='utf-8-sig'))
        namespace = {'__file__': str(path)}
        exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign))], type_ignores=[]), str(path), 'exec'), namespace)
        namespace['check'](conn, extra_check=manual_checks)
        for filename in ['check-pda-raw-db.py', 'check-pda-cost-db.py']:
            with conn.transaction(force_rollback=True):
                path = ROOT / 'tools' / filename
                tree = ast.parse(path.read_text(encoding='utf-8-sig'))
                ns = {'__file__': str(path)}
                exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))], type_ignores=[]), str(path), 'exec'), ns)
                ns['check'](conn)
    finally:
        conn.rollback()
        print('All manual labels, receipts, packages, user fixtures and DDL rolled back. No operating stock changed.')
