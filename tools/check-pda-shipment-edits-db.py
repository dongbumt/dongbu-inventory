"""PDA grouped sales edits through the real RPC. All schema and fixtures roll back."""
import ast
import copy
import os
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261111041128_pda_shipment_corrections.sql'


def regression(conn, filename):
    file = ROOT / 'tools' / filename
    tree = ast.parse(file.read_text(encoding='utf-8-sig'))
    nodes = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))]
    namespace = {'ROOT': ROOT, '__file__': str(file)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, 'exec'), namespace)
    namespace['check'](conn)


def check(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda name: 'qa_ship_' + suffix + '_' + name
    role, user, original_partner, target_partner, buyer = (uuid.uuid4() for _ in range(5))
    token, pin = uuid.uuid4().hex + uuid.uuid4().hex, '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'PDA shipment QA')", (role, uid('role')))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'PDA shipment QA','unused',%s)", (user, uid('user')[:30], role))
    for menu in ['pda', 'production', 'transactions', 'stock']:
        conn.execute('insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)', (role, menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    for partner, name, trade in [(original_partner, 'original', '매출'), (target_partner, 'target', '매입/매출'), (buyer, 'buyer', '매입')]:
        conn.execute('insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,%s)', (partner, 'QS' + uuid.uuid4().hex[:12].upper(), uid(name), trade))
    order = dict(id=uid('order'), date='2026-11-11', product=uid('product'), labelProductId=uid('product_id'), inputWeight=100,
                 weight=5, lot='QA-SHIP-LOT', origin='국내산', packunit='5KG', grade='', mfgdate='2026-11-11', expdate='2027-11-10', temptype='냉동',
                 sourceStock=dict(key=uid('raw'), product=uid('raw'), price=1000, stock=100, origin='국내산', lot='RAW'))
    logs = [dict(id=uid('label' + str(i)), code='DB2611111200-QASH1' + str(i), workOrderId=order['id'], labelWeight=5,
                 status='active', workOrderSnapshot=order) for i in range(3)]
    product = dict(id=order['labelProductId'], name=order['product'], packunit='5KG', taxType='면세')
    for key, value in [('workOrders', [order]), ('labelProducts', [product]), ('labelPrintLogs', logs)]:
        conn.execute('update public.app_data set payload=payload||%s where key=%s', (Jsonb(value), key))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                  tuple(Jsonb(x) if isinstance(x, (list, dict)) else x for x in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(fn, fragment):
        try:
            with conn.transaction():
                fn()
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    items = []
    for log in logs:
        item = rpc('dbmt_pda_lookup', token, log['code'])['item']
        items.append(dict(barcode=item['code'], revision=item['revision']))
    batch = uuid.uuid4()
    rpc('dbmt_pda_commit', token, batch, 'outbound', '가공장', original_partner, '2026-11-11', items, 'QA')
    rows = conn.execute("select raw from public.transactions where raw->>'_pdaRequestId'=%s and type='출고' order by id", (str(batch),)).fetchall()
    originals = [r[0] for r in rows]
    assert len(originals) == 3 and all(row['productionCost'] is None for row in originals)
    packages = conn.execute('select to_jsonb(p) from public.pda_packages p where label_id=any(%s) order by label_id', ([log['id'] for log in logs],)).fetchall()
    historical_batch = conn.execute('select request,result from public.pda_batches where id=%s', (batch,)).fetchone()
    save = lambda values: rpc('dbmt_erp_save_transactions', token, values, [])
    changed = [dict(row, trader=uid('target'), price=7500, amount=1, note='Corrected customer') for row in originals]
    saved = save(changed)['updatedPdaShipments']
    assert len(saved) == 3 and all(row['traderId'] == str(target_partner) and row['price'] == 7500 and row['amount'] == 37500 for row in saved)
    assert all(row['_pdaShipmentEditRevision'] == 1 and row['productionCost'] is None and row['_pdaProvisional'] for row in saved)
    assert conn.execute('select count(*) from public.transactions where raw->>\'traderId\'=%s and business_partner_id=%s', (str(target_partner), target_partner)).fetchone()[0] == 3
    assert conn.execute('select to_jsonb(p) from public.pda_packages p where label_id=any(%s) order by label_id', ([log['id'] for log in logs],)).fetchall() == packages
    assert conn.execute('select request,result from public.pda_batches where id=%s', (batch,)).fetchone() == historical_batch
    reject(lambda: save(changed), '다른 사용자가')
    for field, value in [('weight', 9), ('lot', 'WRONG'), ('boxCount', 9), ('date', '2026-11-12'), ('_pdaLabelId', 'WRONG')]:
        reject(lambda: save([dict(saved[0], **{field: value})]), '품목·중량')
    reject(lambda: save([dict(saved[0], price=-1)]), '단가')
    reject(lambda: save([dict(saved[0], trader=uid('buyer'))]), '매출')
    reject(lambda: save([dict(saved[0], trader='unknown customer')]), '매출')
    reject(lambda: save([saved[0], saved[0]]), '중복')
    reject(lambda: conn.execute('update public.transactions set trader=%s where id=%s', (uid('original'), saved[0]['id'])), '일반 거래내역')
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='transactions'", (role,))
        assert not save([dict(saved[0], price=1)])['ok']
    before = conn.execute('select price,raw from public.transactions where id=%s', (saved[0]['id'],)).fetchone()
    reject(lambda: save([dict(saved[0], price=1), dict(saved[1], weight=1)]), '품목·중량')
    assert conn.execute('select price,raw from public.transactions where id=%s', (saved[0]['id'],)).fetchone() == before
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='transactions'", (role,))
        reject(lambda: save([dict(saved[0], price=1), dict(id=uid('denied'), type='입고')]), '권한')
        assert conn.execute('select price,raw from public.transactions where id=%s', (saved[0]['id'],)).fetchone() == before
    assert conn.execute('select count(*) from pda_private.shipment_edit_context where transaction_xid=txid_current()').fetchone()[0] == 0
    assert conn.execute("select count(*) from public.change_logs where entity='PDA 제품' and entity_id=%s", (saved[0]['id'],)).fetchone()[0] == 1
    print('PASS: actual grouped shipment RPC changes canonical sales customer/price/note atomically; amounts, permissions, stale edits, immutable fields, rollback, one audit log and original package/batch preservation')

    complete = rpc('dbmt_label_complete_production_reviewed', pin, order['id'], [log['id'] for log in logs], None)
    pid = complete['productionId']
    # The editor may have opened while production cost was still pending.
    latest = save([dict(saved[0], price=8000)])['updatedPdaShipments'][0]
    assert latest['price'] == 8000 and latest['traderId'] == str(target_partner) and latest['productionCost'] is not None and not latest['_pdaProvisional']
    entry = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    edited = copy.deepcopy(entry)
    edited['outputs'][0]['price'] = 6000
    edited['outputs'][0]['amount'] = 90000
    assert rpc('dbmt_erp_save_production', token, edited, [], pid)['ok']
    actual = conn.execute('select raw from public.transactions where id=%s', (latest['id'],)).fetchone()[0]
    assert actual['productionCost'] == 6000 and actual['productionCostAmount'] == 30000 and actual['price'] == 8000 and actual['traderId'] == str(target_partner)
    balance = conn.execute("select pda_private.balance(%s,'가공장')", (actual['stockRowId'],)).fetchone()[0]
    zeros = save([dict(actual, price=0)])['updatedPdaShipments']
    assert zeros[0]['price'] == 0 and zeros[0]['amount'] == 0 and zeros[0]['productionCost'] == 6000
    assert conn.execute("select pda_private.balance(%s,'가공장')", (actual['stockRowId'],)).fetchone()[0] == balance
    with conn.transaction(force_rollback=True):
        conn.execute('update public.business_partners set active=false where id=%s', (target_partner,))
        assert save([dict(zeros[0], price=1)])['ok'], 'Existing archived customer may retain its identity during a price edit'
    print('PASS: pending shipment edits -> production completion -> stale editor save -> later production-cost correction; customer/sales amounts and stock preserved, zero-price and archived-customer handling')


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_shipment_edit_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='60s'")
        if os.environ.get('DBMT_SHIPMENT_EDITS_DEPLOYED') != '1':
            conn.execute(MIGRATION.read_text(encoding='utf-8-sig'))
        check(conn)
        for filename in ['check-pda-cost-db.py', 'check-pda-product-db.py']:
            with conn.transaction(force_rollback=True):
                regression(conn, filename)
    finally:
        conn.rollback()
        print('All DDL and virtual fixtures rolled back. No operating records edited.')
