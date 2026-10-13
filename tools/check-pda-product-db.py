"""Fictional PDA integration checks in a rollback. --apply installs schema only after passing."""
import json
import os
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / 'supabase/schema-rpc-53-pda-product-movements.sql'

def check(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda name: 'qa_pda_' + suffix + '_' + name
    role, user, partner = (uuid.uuid4() for _ in range(3))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'PDA QA')", (role, uid('role')))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'PDA QA','unused',%s)", (user, uid('user')[:30], role))
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update) values(%s,'transactions',true,true,true),(%s,'stock',true,false,false)", (role, role))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매출')", (partner, 'Q' + suffix.upper(), uid('partner')))
    production, stock, order = uid('prod'), uid('stock'), uid('order')
    snapshot = dict(product=uid('product'), labelProductId=uid('product_id'), lot='QA-LOT', origin='국내산', packunit='5KG', grade='', mfgdate='2026-10-13', expdate='2027-10-12', temptype='냉동')
    output = dict(product=snapshot['product'], labelProductId=snapshot['labelProductId'], lot='QA-LOT', origin='국내산', packunit='5KG', grade='', proddate='2026-10-13', qty=15, price=7000, amount=105000, stockRowId=stock)
    entry = dict(id=production, date='2026/10/13', inputs=[], outputs=[output])
    conn.execute("insert into public.production_entries(id,work_date,raw) values(%s,'2026-10-13',%s)", (production, Jsonb(entry)))
    raw = dict(id=uid('source'), type='생산입고', stockRowId=stock, product=snapshot['product'], lot='QA-LOT', stockLocation='가공장', price=7000, stockUnitPrice=7000, _prodId=production)
    conn.execute("insert into public.transactions(id,date,type,product,lot,weight,price,stock_location,prod_id,raw) values(%s,'2026-10-13','생산입고',%s,'QA-LOT',15,7000,'가공장',%s,%s)", (raw['id'], snapshot['product'], production, Jsonb(raw)))
    logs = [dict(id=uid('label' + str(i)), code='DB2610131200-' + ('ABC12' + str(i)), workOrderId=order, labelWeight=5, status='active', workOrderSnapshot=snapshot) for i in range(3)]
    conn.execute("update public.app_data set payload=payload||%s where key='labelPrintLogs'", (Jsonb(logs),))
    conn.execute("insert into public.label_production_completions(work_order_id,production_id,baseline,log_ids) values(%s,%s,%s,%s)", (order, production, Jsonb(entry), Jsonb([l['id'] for l in logs])))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            value = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')', tuple(Jsonb(v) if isinstance(v, (dict, list)) else v for v in args)).fetchone()[0]
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

    def lookup(index=0):
        return rpc('dbmt_pda_lookup', token, logs[index]['code'])['item']

    def commit(mode, items, request=None, location='가공장'):
        return rpc('dbmt_pda_commit', token, request or uuid.uuid4(), mode, location, partner if mode == 'outbound' else None, '2026-10-13', items, 'QA')

    def scan(index=0):
        item = lookup(index)
        return dict(barcode=item['code'], revision=item['revision'])

    balance = lambda source=stock, loc='가공장': conn.execute('select pda_private.balance(%s,%s)', (source, loc)).fetchone()[0]
    reject(lambda: rpc('dbmt_pda_lookup', 'bad-token', logs[0]['code']), '로그인')
    assert '가공장' in rpc('dbmt_pda_bootstrap', token)['locations']
    numeric = '982610131200' + str(int('ABC120', 36)).zfill(10)
    assert rpc('dbmt_pda_lookup', token, ']C0' + numeric + '\r\n')['item']['code'] == logs[0]['code']
    reject(lambda: rpc('dbmt_pda_lookup', token, 'L12610134894005'), '제품 고유바코드')
    reject(lambda: rpc('dbmt_pda_lookup', token, 'DB2610131200-ZZZZZZ'), '출력이력')
    reject(lambda: rpc('dbmt_pda_lookup', token, '9826101312009999999999'), '형식')
    with conn.transaction(force_rollback=True):
        conn.execute('delete from public.label_production_completions where work_order_id=%s', (order,))
        reject(lambda: lookup(), '생산완료')
    with conn.transaction(force_rollback=True):
        duplicate = dict(logs[0], id=uid('duplicate'))
        conn.execute("update public.app_data set payload=payload||%s where key='labelPrintLogs'", (Jsonb([duplicate]),))
        reject(lambda: lookup(), '여러 건')
    before = balance()
    result = commit('inbound', [scan()])
    assert result['received'] == 1 and balance() == before == 15
    reject(lambda: conn.execute("insert into public.transactions(id,date,type,weight,stock_location,raw) values(%s,'2026-10-13','출고',12,'가공장',%s)", (uid('reserved_out'), Jsonb(dict(stockRowId=stock)))), 'PDA 추적 재고')
    with conn.transaction(force_rollback=True):
        conn.execute("insert into public.transactions(id,date,type,weight,stock_location,raw) values(%s,'2026-10-13','출고',5,'가공장',%s)", (uid('free_out'), Jsonb(dict(stockRowId=stock))))
        assert balance() == 10, 'Unregistered quantity must remain available to ordinary ERP workflows'
    reject(lambda: commit('inbound', [scan()]), '이미 입고')
    stale = scan()
    request = uuid.uuid4()
    result = commit('outbound', [stale], request)
    assert result['shipped'] == 1 and balance() == 10
    assert commit('outbound', [stale], request)['alreadySaved'] and balance() == 10
    reject(lambda: commit('outbound', [scan()]), '이미 출고')
    reject(lambda: commit('inbound', [stale]), '다른 작업자')
    returned = commit('inbound', [scan()], location='물류창고')
    source = lookup()['stockRowId']
    assert returned['returned'] == 1 and balance(source, '물류창고') == 5
    assert balance() == 10
    reject(lambda: commit('outbound', [scan()], location='가공장'), '현재 재고 지점')
    commit('outbound', [scan()], location='물류창고')
    assert balance(source, '물류창고') == 0
    reject(lambda: commit('outbound', [scan(1), scan(1)]), '중복')
    item1 = scan(1)
    with conn.transaction(force_rollback=True):
        conn.execute("insert into public.transactions(id,date,type,product,lot,weight,stock_location,raw) values(%s,'2026-10-13','출고',%s,'QA-LOT',8,'가공장',%s)", (uid('manual_out'), snapshot['product'], Jsonb(dict(stockRowId=stock))))
        reject(lambda: commit('outbound', [item1]), '재고가 부족')
        assert balance() == 2
    reject(lambda: commit('outbound', [item1, dict(barcode=logs[2]['code'], revision=99)]), '다른 작업자')
    assert lookup(1)['revision'] == 0 and balance() == 10, 'Partial batches must roll back'
    reject(lambda: commit('outbound', [item1], request), '다른 내용')
    reject(lambda: commit('outbound', [dict(item1, weight=100)]), '스캔 목록')
    conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='transactions'", (role,))
    reject(lambda: commit('outbound', [item1]), '권한')
    conn.execute("update public.erp_role_permissions set can_create=true where role_id=%s and menu_code='transactions'", (role,))
    assert len(rpc('dbmt_pda_history', token)['rows']) == 4
    tx = result['items'][0]['transactionId']
    reject(lambda: conn.execute('update public.transactions set deleted_at=now() where id=%s', (tx,)), 'PDA 입출고')
    reject(lambda: conn.execute('update public.transactions set weight=100 where id=%s', (tx,)), 'PDA 입출고')
    conn.execute("update public.transactions set price=9000,amount=45000,note='QA price',raw=raw||'{\"price\":9000,\"amount\":45000,\"note\":\"QA price\"}' where id=%s", (tx,))
    row = conn.execute('select raw from public.transactions where id=%s', (tx,)).fetchone()[0]
    row.update(price=9100,amount=45500,note='QA ERP price edit')
    assert rpc('dbmt_erp_save_transactions', token, [row], [])['ok'], 'Existing ERP price/note editing must still work'
    spoof = dict(row, id=uid('spoof'), _pdaRequestId=str(uuid.uuid4()))
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [spoof], []), 'PDA 식별정보')
    reject(lambda: conn.execute('update public.production_entries set deleted_at=now() where id=%s', (production,)), 'PDA로 처리한')
    reject(lambda: conn.execute("update public.production_entries set raw=jsonb_set(raw,'{outputs,0,qty}','1') where id=%s", (production,)), 'PDA로 처리한')
    with conn.transaction():
        conn.execute('set local role anon')
        reject(lambda: conn.execute('select * from public.pda_packages'), 'permission denied')
        reject(lambda: conn.execute("select pda_private.resolve('test')"), 'permission denied')
        conn.execute('set local role postgres')
    print(json.dumps(dict(ok=True, checks='identity, AIM/CRLF, login, permissions, first receive without stock addition, outbound, return, location, revisions, idempotency, duplicate labels, all-or-nothing batches, protected edits, RLS/grants'), ensure_ascii=False))

schema = SCHEMA.read_text(encoding='utf8')
migrations = list((ROOT / 'supabase/migrations').glob('*_pda_product_movements.sql'))
assert len(migrations) == 1 and migrations[0].read_text(encoding='utf8').replace('\r\n','\n') == schema.replace('\r\n','\n'), 'PDA schema and migration must match'
guard = (ROOT / 'supabase/schema-rpc-54-pda-registered-stock-guards.sql').read_text(encoding='utf8')
guard_migrations = list((ROOT / 'supabase/migrations').glob('*_pda_registered_stock_guards.sql'))
assert len(guard_migrations) == 1 and guard_migrations[0].read_text(encoding='utf8').replace('\r\n','\n') == guard.replace('\r\n','\n'), 'PDA guard schema and migration must match'
schema += '\n' + guard
if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER','') + os.environ.get('PGHOST',''):
    raise RuntimeError('Wrong linked project')
with psycopg.connect(sslmode='require',connect_timeout=20,application_name='dbmt_pda_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='30s'")
        conn.execute(schema)
        check(conn)
    finally:
        conn.rollback()
    if '--apply' in sys.argv:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute(schema)
        conn.commit()
        print('DEPLOYED: schema only; all QA fixtures rolled back')
    else:
        print('ROLLED BACK: schema and all QA fixtures')
