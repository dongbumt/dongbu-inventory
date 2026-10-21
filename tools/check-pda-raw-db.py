"""Raw-material PDA integration checks. Fixtures and schema are always rolled back."""
import ast
import json
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = [ROOT / 'supabase/schema-rpc-65-pda-raw-material-movements.sql', ROOT / 'supabase/pda-raw-verified-rules.sql']
PHOTO_CASES = [
    ('07662300206004601597009456', 15.97),
    ('2606251220400045701526', 15.26),
    ('01040199194722001126031231020017261052476119', 17.26),
    ('01900287495000281125102832020055402180234658', 25.13),
    ('0190017995886314320200322411250703210077040584', 14.62),
    ('019001933617340432010007741125092421256481', 35.11),
    ('011843560101195431030162501527063010310054325', 16.25),
    ('001843600426824733340118436004983947310200110717261111104462', 11.07),
    ('019829288818906811260513310200111521146134120970', 11.15),
    ('01993526560490683102002640132509242100022656', 26.40),
    ('019933107903812531020020801326062521126766270623', 20.80),
]

def check(conn):
    def reject(call, text):
        try:
            with conn.transaction():
                call()
        except psycopg.Error as error:
            assert text in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + text)

    parse = lambda code, rule=None: conn.execute('select pda_private.raw_parse(%s,%s)', (code, rule)).fetchone()[0]
    for code, kg in PHOTO_CASES:
        assert abs(parse(code)['weight'] - kg) < .001, code
    assert parse(PHOTO_CASES[5][0])['requiresReview'], 'LB sample differs from label: never bypass review'
    canonical = parse(PHOTO_CASES[2][0])
    assert parse(']C1' + PHOTO_CASES[2][0])['id'] == canonical['id']
    assert parse('(01)04019919472200(11)260312(3102)001726(10)52476119')['id'] == canonical['id']
    assert parse('010401991947220010ABC|3102001726')['barcodeLot'] == 'ABC'
    assert parse(PHOTO_CASES[3][0])['id'] == parse(PHOTO_CASES[3][0].replace('005540', '005541'))['id'], 'GTIN+serial is independent of weight'
    reject(lambda: parse('010401991947220010ABCDEFGHIJKLMNOPQRSTU3102001726'), '구분자')
    reject(lambda: parse('01040199194722013102001726'), '체크숫자')
    reject(lambda: parse('DB2610131200-ABC120'), '제품 바코드')
    reject(lambda: parse('9826101312000000000001'), '제품 바코드')
    reject(lambda: parse('270601682170500000212000247'), '제품 바코드')
    reject(lambda: parse('L12610134894005'), '박스 바코드')
    reject(lambda: parse('12345678901234567890123456'), '검증된 SM')
    reject(lambda: parse(PHOTO_CASES[0][0], 'not-verified'), '검증된 SM')
    reject(lambda: parse('01040199194722003102000000'), '허용범위')
    print('PASS: all 11 photo-weight cases, GS1 AI boundaries/check digits/aliases, two domestic formats, product/LOT/unverified rejection')

    suffix = uuid.uuid4().hex[:10]
    role, user, partner = (uuid.uuid4() for _ in range(3))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    product_id = 'qa_raw_product_' + suffix
    prod = dict(id=product_id, name='QA raw ' + suffix, kind='원료육', origin='국내산', storage='냉동', packunit='', brand='', factoryNo='')
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Raw PDA QA')", (role, 'qa_raw_' + suffix))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Raw PDA QA','unused',%s)", (user, 'qa_raw_' + suffix, role))
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create) values(%s,'pda',true,true)", (role,))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매입/매출')", (partner, 'QRAW' + suffix.upper(), 'QA Raw partner ' + suffix))
    inactive = dict(prod, id=product_id+'_inactive', isActive=False)
    conn.execute("update public.app_data set payload=payload||%s where key='labelProducts'", (Jsonb([prod, inactive]),))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            value = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')', tuple(Jsonb(v) if isinstance(v, (dict, list)) else v for v in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    def lookup(code=PHOTO_CASES[0][0], auth=token):
        return rpc('dbmt_pda_raw_lookup', auth, code, None)['item']

    def scan(code=PHOTO_CASES[0][0]):
        item = lookup(code)
        return dict(barcode=item['code'], revision=item['revision'], rule=item['ruleKey'], labelWeight=item['weight'], checked=True)

    def commit(mode, items, req=None, location='가공장', source=None, auth=token, lot='QA-LOT', pid=product_id):
        return rpc('dbmt_pda_raw_commit', auth, req or uuid.uuid4(), mode, location, partner, '2026-10-21', items, pid, lot, source, 5000, 'QA')

    reject(lambda: lookup(auth='bad-token'), '로그인')
    bootstrap = rpc('dbmt_pda_raw_bootstrap', token)
    assert bootstrap['canSave'] and any(p['id'] == product_id for p in bootstrap['products'])
    assert not any(p['id'] == inactive['id'] for p in bootstrap['products'])
    assert len(bootstrap['rules']) == 60
    reject(lambda: commit('outbound', [scan()]), '먼저')
    reject(lambda: commit('inbound', [scan()], lot=''), '이력번호')
    reject(lambda: commit('inbound', [scan()], pid='unknown'), '원료육 품목')
    reject(lambda: commit('inbound', [scan()], pid=inactive['id']), '원료육 품목')
    reject(lambda: commit('inbound', [dict(scan(), labelWeight=100)]), '계산 중량')
    reject(lambda: commit('inbound', [dict(scan(), checked=False)]), '중량 대조')
    req = uuid.uuid4(); items = [scan()]
    result = commit('inbound', items, req=req)
    assert result['count'] == 1 and result['weight'] == 15.97
    assert commit('inbound', items, req=req)['alreadySaved']
    reject(lambda: commit('inbound', items, req=req, lot='DIFFERENT'), '다른 내용')
    reject(lambda: commit('inbound', [scan()]), '중복 입고')
    item = lookup(); source = item['stockRowId']
    balance = lambda: float(conn.execute('select pda_private.balance(%s,%s)', (source, '가공장')).fetchone()[0])
    assert balance() == 15.97
    reject(lambda: commit('outbound', [dict(scan(), revision=0)]), '다른 작업자')
    reject(lambda: commit('outbound', [scan()], location='물류창고'), '재고 지점')
    reject(lambda: conn.execute('delete from public.transactions where id=%s', (result['items'][0]['transactionId'],)), '변경할 수 없습니다')
    with conn.transaction(force_rollback=True):
        conn.execute("update public.transactions set price=6000,amount=round(weight*6000),raw=raw||jsonb_build_object('price',6000,'amount',round(weight*6000)) where id=%s", (result['items'][0]['transactionId'],))
        assert balance() == 15.97
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='pda'", (role,))
        assert not rpc('dbmt_pda_raw_bootstrap', token)['canSave']
        reject(lambda: commit('outbound', [scan()]), 'PDA 입출고')
    shipped = commit('outbound', [scan()]);assert shipped['count'] == 1 and balance() == 0
    reject(lambda: commit('outbound', [scan()]), '이미 출고')
    reject(lambda: commit('inbound', [scan()]), '자동 반입')

    # Register an existing identified incoming source without increasing inventory.
    stock = 'qa_raw_existing_' + suffix;tx = 'qa_raw_tx_' + suffix
    row = dict(id=tx, date='2026-10-20', type='입고', product=prod['name'], labelProductId=product_id, lot='QA-LOT', origin='국내산', packunit='', stockLocation='가공장', stockRowId=stock, weight=100, price=5000, amount=500000)
    conn.execute("insert into public.transactions(id,date,type,product,lot,origin,weight,price,amount,stock_location,raw) values(%s,'2026-10-20','입고',%s,'QA-LOT','국내산',100,5000,500000,'가공장',%s)", (tx, prod['name'], Jsonb(row)))
    assert any(r['id'] == stock for r in rpc('dbmt_pda_raw_sources', token, product_id, '가공장')['rows'])
    code = PHOTO_CASES[1][0];before = conn.execute('select count(*) from public.transactions').fetchone()[0]
    bound = commit('inbound', [scan(code)], source=stock)
    assert bound['items'][0]['action'] == 'bind' and conn.execute('select count(*) from public.transactions').fetchone()[0] == before
    assert conn.execute('select pda_private.balance(%s,%s)', (stock, '가공장')).fetchone()[0] == 100
    reject(lambda: conn.execute('delete from public.transactions where id=%s', (tx,)), '재고원본')
    reject(lambda: conn.execute("insert into public.transactions(id,date,type,product,weight,stock_location,raw) values(%s,'2026-10-21','출고',%s,90,'가공장',%s)", ('qa_bad_' + suffix, prod['name'], Jsonb(dict(stockRowId=stock)))), '원료육 박스 몫')
    reject(lambda: conn.execute("insert into public.transactions(id,date,type,product,lot,weight,raw) values(%s,'2026-10-21','출고',%s,'QA-LOT',1,'{}')", ('qa_unlinked_'+suffix, prod['name'])), '재고원본을 지정')
    commit('outbound', [scan(code)])
    assert float(conn.execute('select pda_private.balance(%s,%s)', (stock, '가공장')).fetchone()[0]) == 84.74
    lb_scan=scan(PHOTO_CASES[5][0]);lb_scan['labelWeight']=35.10
    lb_result=commit('inbound',[lb_scan]);assert lb_result['weight']==35.1
    reject(lambda: lookup(PHOTO_CASES[5][0].replace('000774','000775')), '변경되었습니다')
    assert len(rpc('dbmt_pda_raw_history', token)['rows']) == 5
    # A later invalid item rolls back the entire batch.
    c1 = '07662300206004601597009457';c2 = '07662300206004601597009458'
    reject(lambda: commit('inbound', [scan(c1), dict(scan(c2), labelWeight=999)]), '계산 중량')
    assert not lookup(c1)['registered']
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='pda'", (role,))
        reject(lambda: lookup(), 'PDA 입출고')
    with conn.transaction():
        conn.execute('set local role anon')
        reject(lambda: conn.execute('select * from pda_private.raw_packages'), 'permission denied')
        reject(lambda: conn.execute('select * from pda_private.raw_rules'), 'permission denied')
        conn.execute('set local role postgres')
    print('PASS: real RPC authorization, inbound/outbound, idempotency, duplicates, stale revisions, source binding without double stock, stock/metadata guards, price edits, full rollback and history')

def main():
    migration = list((ROOT / 'supabase/migrations').glob('*_pda_raw_material_movements.sql'))
    expected = '\n\n'.join(file.read_text(encoding='utf-8-sig').rstrip() for file in SCHEMAS) + '\n'
    assert len(migration) == 1 and migration[0].read_text(encoding='utf-8-sig').replace('\r\n','\n') == expected.replace('\r\n','\n'), 'Migration and reviewed schema/rules must match'
    with psycopg.connect('', autocommit=False, sslmode='require', connect_timeout=20, application_name='dbmt_raw_pda_qa') as conn:
        try:
            conn.execute('set local role postgres')
            conn.execute("set local lock_timeout='5s'")
            conn.execute("set local statement_timeout='45s'")
            before = conn.execute("select p.oid::text,md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pda_private' or (n.nspname='public' and p.proname like 'dbmt_pda_%') order by 1").fetchall()
            for file in SCHEMAS:conn.execute(file.read_text(encoding='utf-8-sig'))
            check(conn)
            tree = ast.parse((ROOT / 'tools/check-pda-product-db.py').read_text(encoding='utf8'))
            definitions = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))], type_ignores=[])
            namespace = {'ROOT': ROOT}
            exec(compile(definitions, 'existing_product_tests', 'exec'), namespace)
            namespace['check'](conn)
            for oid, digest in before:
                assert conn.execute('select md5(pg_get_functiondef(%s::oid))', (oid,)).fetchone()[0] == digest, 'Existing product functions must not change'
            print('PASS: existing product receive/ship/return integration and unchanged product functions')
        finally:
            conn.rollback()
            print('ROLLED BACK: schema, virtual users/products/stock/scans and tests. No operating records changed.')

if __name__ == '__main__':main()
