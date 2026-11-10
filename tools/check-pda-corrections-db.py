"""Receipt book corrections and negative PDA stock. DDL/fixtures always roll back."""
import ast
import os
import uuid
from decimal import Decimal
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261110080326_pda_receipt_corrections_negative_shipments.sql'


def definitions(filename):
    file = ROOT / 'tools' / filename
    tree = ast.parse(file.read_text(encoding='utf-8-sig'))
    nodes = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))]
    namespace = {'ROOT': ROOT, '__file__': str(file)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, 'exec'), namespace)
    return namespace


def corrections(conn, fixture):
    rpc, reject, lookup, commit = [fixture[key] for key in ['rpc', 'reject', 'lookup', 'commit']]
    row, token, tx, source, role, codes = [fixture[key] for key in ['row', 'token', 'tx', 'source', 'role', 'codes']]
    old_packages = conn.execute('select id,barcode,parsed,snapshot,weight,revision from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall()
    new_partner = uuid.uuid4()
    name = 'QA corrected supplier ' + uuid.uuid4().hex[:8]
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매입')", (new_partner, 'QC' + uuid.uuid4().hex[:10].upper(), name))

    def save(changed):
        return rpc('dbmt_erp_save_transactions', token, [changed], [])['updatedRawReceipts'][0]

    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='transactions'", (role,))
        assert not rpc('dbmt_erp_save_transactions', token, [dict(row, price=1)], [])['ok']
        assert conn.execute('select price from public.transactions where id=%s', (tx,)).fetchone()[0] == 4400
    reject(lambda: save(dict(row, lot='WRONG')), '품목·이력번호')
    reject(lambda: save(dict(row, boxCount=19)), '박스수')
    reject(lambda: save(dict(row, weight=0)), '합계중량')
    reject(lambda: save(dict(row, weight=1.111)), '합계중량')
    reject(lambda: save(dict(row, price=-1)), '단가')
    reject(lambda: save(dict(row, trader='unknown supplier')), '입고처')
    corrected = save(dict(row, price=4441, trader=name, weight=340, amount=1, note='Manual correction QA'))
    assert corrected['price'] == 4441 and corrected['weight'] == 340 and corrected['amount'] == 1509940
    assert corrected['traderId'] == str(new_partner) and corrected['trader'] == name
    assert corrected['_pdaRawScannedWeight'] == 341.4 and corrected['_pdaRawWeightDelta'] == -1.4
    assert corrected['_pdaRawEditRevision'] == 1
    assert corrected['stockRowId'] == row['stockRowId'] and corrected['_pdaRawBoxes'] == row['_pdaRawBoxes']
    assert conn.execute('select id,barcode,parsed,snapshot,weight,revision from pda_private.raw_packages where source_id=%s order by id', (source,)).fetchall() == old_packages
    assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == 340
    reject(lambda: save(dict(row, price=5000)), '다른 사용자가')
    zero = save(dict(corrected, price=0))
    assert zero['amount'] == 0 and zero['price'] == 0 and zero['_pdaRawEditRevision'] == 2
    corrected = save(dict(zero, price=4441))
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='transactions'", (role,))
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [dict(corrected, price=7000), dict(id='qa_denied_' + uuid.uuid4().hex, type='입고')], []), '권한')
        assert conn.execute('select price from public.transactions where id=%s', (tx,)).fetchone()[0] == 4441
    print('PASS: actual ERP API corrects supplier/price/weight/note; raw barcode weights and identities preserved; exact amounts/zero prices, versions, permission/immutable checks and mixed-write rollback')
    with conn.transaction(force_rollback=True):
        scans = [fixture['scan'](code) for code in codes[:20]]
        request = uuid.uuid4()
        shipped = rpc('dbmt_pda_raw_commit', token, request, 'outbound', '가공장', fixture['partner'], '2026-11-10', scans, fixture['pid'], 'QA-RECEIPT', None, 4400, 'QA')
        assert shipped['count'] == 20 and shipped['weight'] == 341.4
        assert shipped['negativeStock'][0]['weight'] == -1.4
        assert conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == Decimal('-1.4')
        assert rpc('dbmt_pda_raw_commit', token, request, 'outbound', '가공장', fixture['partner'], '2026-11-10', scans, fixture['pid'], 'QA-RECEIPT', None, 4400, 'QA')['alreadySaved']
        reject(lambda: commit('outbound', codes[:1]), '이미 출고')
        later = save(dict(corrected, weight=330, price=4500))
        assert later['weight'] == 330 and conn.execute("select pda_private.balance(%s,'가공장')", (source,)).fetchone()[0] == Decimal('-11.4')
        out = conn.execute("select raw from public.transactions where raw->>'stockRowId'=%s and type='출고' and deleted_at is null limit 1", (source,)).fetchone()[0]
        assert rpc('dbmt_erp_save_transactions', token, [dict(out, price=0, amount=0)], [])['ok'], 'Negative inventory cannot block a later sales-price edit'
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [tx]), '연결된 PDA 입고')
    print('PASS: 20-box outbound past corrected stock -> -1.40KG, duplicates/retries safe, later receipt correction -> -11.40KG, sales-price edits and used receipt deletion guard')
    assert rpc('dbmt_erp_save_transactions', token, [], [tx])['ok'], 'Corrected but unused receipts remain cancellable'
    assert not lookup(codes[0])['registered']
    assert conn.execute('select count(*) from pda_private.raw_receipt_context where transaction_xid=txid_current()').fetchone()[0] == 0
    print('PASS: corrected unused receipt cancellation and context cleanup')


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_receipt_correction_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_CORRECTION_TEST_DEPLOYED') != '1':
            conn.execute(MIGRATION.read_text(encoding='utf-8-sig'))
        definitions('check-pda-receipts-db.py')['check'](conn, corrections)
        for name in ['check-pda-raw-db.py', 'check-pda-cost-db.py', 'check-pda-product-db.py']:
            with conn.transaction(force_rollback=True):
                definitions(name)['check'](conn)
        print('PASS: existing raw, completed product and provisional production-cost workflows')
    finally:
        conn.rollback()
        print('All schema and fixtures rolled back. No operating records edited.')
