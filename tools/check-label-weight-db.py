"""Repack/resplit tests against real RPCs. Every fictional row and schema change rolls back."""
import ast
import copy
import os
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261113011133_label_weight_resplit.sql'


def check(conn):
    uid = lambda s: 'qa_weight_' + uuid.uuid4().hex[:12] + '_' + s
    role, user, partner = (uuid.uuid4() for _ in range(3))
    token, pin = uuid.uuid4().hex + uuid.uuid4().hex, '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Weight split QA')", (role, uid('role')))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Weight split QA','unused',%s)", (user, uid('user'), role))
    for menu in ['pda','production','transactions','stock','label']:
        conn.execute('insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)', (role, menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매출')", (partner, 'QW'+uuid.uuid4().hex[:12].upper(), uid('partner')))
    order = dict(id=uid('order'), date='2026-11-10', product=uid('product'), labelProductId=uid('product_id'), inputWeight=100,
                 weight=20, lot='QA-WEIGHT', origin='국내산', packunit='20KG', grade='S', mfgdate='2026-11-10', expdate='2027-11-09',
                 temptype='냉동', sourceStock=dict(key=uid('raw'), product=uid('raw'), price=1000, stock=100, origin='국내산', lot='RAW'))
    log = dict(id=uid('label'), code='DB2611101200-'+uuid.uuid4().hex[:6].upper(), workOrderId=order['id'],
               labelWeight=20, status='active', workOrderSnapshot=order, sizeKey='7x10', printedAt='2026-11-10T03:00:00Z')
    for key, rows in [('workOrders',[order]),('labelProducts',[dict(id=order['labelProductId'],name=order['product'],taxType='면세',packunit='20KG')]),('labelPrintLogs',[log])]:
        conn.execute('update public.app_data set payload=payload||%s where key=%s', (Jsonb(rows), key))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            value = conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')', tuple(Jsonb(a) if isinstance(a,(dict,list)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    def reject(fn, text=''):
        try:
            with conn.transaction():
                fn()
        except psycopg.Error as error:
            assert text in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: '+text)

    def printed(code):
        return conn.execute('select pda_private.print_code(%s)', (code,)).fetchone()[0]

    def search(query, location='가공장', product='', offset=0):
        return rpc('dbmt_label_weight_search', None, token, query, location, product, offset)

    def split(code, weights, revision=None, request=None, session=token, location='가공장'):
        if revision is None:
            revision=rpc('dbmt_pda_lookup',token,code)['item']['revision']
        return rpc('dbmt_label_weight_split',None,session,request or uuid.uuid4(),code,revision,location,weights)

    def move(code, mode='outbound', date=None, location='가공장'):
        item=rpc('dbmt_pda_lookup',token,code)['item']
        date=date or conn.execute("select (now() at time zone 'Asia/Seoul')::date").fetchone()[0]
        return rpc('dbmt_pda_commit',token,uuid.uuid4(),mode,location,partner if mode=='outbound' else None,date,[dict(barcode=code,revision=item['revision'])],'QA')

    suffix=printed(log['code'])[-6:]
    assert search(suffix)['count']==0, 'Pending production is not stock'
    pid=rpc('dbmt_label_complete_production_reviewed',pin,order['id'],[log['id']],None)['productionId']
    original=conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]
    source=original['outputs'][0]['stockRowId']
    assert search(suffix, product=order['product'])['rows'][0]['code']==log['code']
    assert search(suffix,'물류창고')['count']==0
    assert search(suffix,product='NOT THIS PRODUCT')['count']==0
    assert search('')['rows']==[]
    reject(lambda: search('12345'),'6자리')
    reject(lambda: rpc('dbmt_label_weight_search',None,'invalid',suffix,'가공장','',0),'로그인')
    for bad in [[5,14],[0,20],[20],[1.001,18.999],[-1,21]]:
        reject(lambda:split(log['code'],bad))
    assert conn.execute('select count(*) from pda_private.weight_splits').fetchone()[0]==0
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='label'",(role,))
        reject(lambda:split(log['code'],[5,15]),'권한')
        assert search(suffix)['count']>=1
    print('PASS: exact printed suffix, current location/product filters, no initial/pending stock, weights and permissions checked')

    request=uuid.uuid4()
    result=split(log['code'],[5,15],0,request)
    assert split(log['code'],[5,15],0,request)['alreadySaved']
    assert result['weight']==20 and [l['labelWeight'] for l in result['labels']]==[5,15]
    assert all(l['workOrderSnapshot']==order for l in result['labels'])
    for child in result['labels']:
        assert conn.execute('select pda_private.decode_code(pda_private.print_code(%s))',(child['code'],)).fetchone()[0]==child['code']
    assert conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]==original
    assert conn.execute("select e from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'id'=%s",(log['id'],)).fetchone()[0]==log
    assert conn.execute("select pda_private.balance(%s,'가공장')",(source,)).fetchone()[0]==20
    assert search(printed(log['code']))['count']==0
    reject(lambda:rpc('dbmt_pda_lookup',token,log['code']),'분할 완료')
    reject(lambda:split(log['code'],[10,10],0),'분할 완료')
    reject(lambda:rpc('dbmt_label_print_save_logs',pin,[dict(log,reprintCount=1)]),'분할 완료')
    assert rpc('dbmt_label_weight_search',pin,None,suffix,'가공장','',0)['count']==0
    reject(lambda:rpc('dbmt_label_weight_search','wrong-pin',None,suffix,'가공장','',0),'PIN')
    first, second=result['labels']
    reject(lambda:conn.execute("update public.app_data set payload=payload||%s where key='labelPrintLogs'",(Jsonb([dict(log,id=uid('collision'),code=first['code'])]),)),'중복 등록')
    assert search(printed(second['code'])[-6:])['rows'][0]['code']==second['code']
    resplit=split(second['code'],[3,2,10])
    assert resplit['rootId']==log['id'] and resplit['parentId']==second['id']
    assert conn.execute("select sum(weight),count(*) from public.pda_packages where production_id=%s and state='in_stock'",(pid,)).fetchone()==(20,4)
    assert conn.execute("select sum((raw->>'boxCount')::integer),sum(weight) from public.transactions where raw ? '_labelWeightSplitId' and raw->>'stockRowId'=%s",(source,)).fetchone()==(3,0)
    assert rpc('dbmt_label_weight_history',None,token,request)['rows'][0]['labels']==[first]
    assert search(printed(second['code']))['count']==0
    print('PASS: 20 -> 5+15 -> 5+3+2+10, unique child barcodes, exact snapshots, immutable production/original print, zero-KG box adjustment and active-leaf history')

    child=resplit['labels'][0]
    # A new source with ambiguous untracked depletion must not offer arbitrary printed boxes.
    with conn.transaction(force_rollback=True):
        other_order=dict(order,id=uid('ambiguous_order'),product=uid('ambiguous_product'))
        other_log=dict(log,id=uid('ambiguous_label'),code='DB2611101200-'+uuid.uuid4().hex[:6].lstrip('0').upper(),workOrderId=other_order['id'],workOrderSnapshot=other_order)
        conn.execute("update public.app_data set payload=payload||%s where key='workOrders'",(Jsonb([other_order]),))
        conn.execute("update public.app_data set payload=payload||%s where key='labelPrintLogs'",(Jsonb([other_log]),))
        other_pid=rpc('dbmt_label_complete_production_reviewed',pin,other_order['id'],[other_log['id']],None)['productionId']
        other=rpc('dbmt_pda_lookup',token,other_log['code'])['item']
        assert search(printed(other_log['code']))['count']==1
        raw=dict(id=uid('untracked_sale'),date='2026-11-12',type='출고',product=other_order['product'],origin='국내산',lot=other_order['lot'],
                 packunit='20KG',proddate=order['mfgdate'],weight=1,price=1,amount=1,stockRowId=other['stockRowId'],stockLocation='가공장',stockUnitPrice=5000,_isUser=True)
        assert rpc('dbmt_erp_save_transactions',token,[raw],[])['ok']
        assert search(printed(other_log['code']))['count']==0
        reject(lambda:split(other_log['code'],[10,10]),'재고 잔량')
        print('PASS: ambiguous unregistered remainder is excluded rather than guessing physical stock; PIN auth, old-label reprints and cross-ledger code collisions protected')
    reject(lambda:move(child['code'],date='2026-11-10'),'분할일')
    sale=move(child['code'])
    assert search(printed(child['code']))['count']==0
    reject(lambda:split(child['code'],[1,2]),'재고 라벨')
    reject(lambda:move(child['code']),'이미 출고')
    assert rpc('dbmt_erp_save_transactions',token,[],[sale['items'][0]['transactionId']])['ok']
    assert search(printed(child['code']))['count']==1
    sale=move(child['code'])
    returned=move(child['code'],'inbound',location='물류창고')
    assert search(printed(child['code']))['count']==0
    assert search(printed(child['code']),'물류창고')['count']==1
    warehouse=split(child['code'],[1,2],location='물류창고')
    assert warehouse['rootId']==log['id']
    assert conn.execute("select pda_private.balance(%s,'가공장')",(source,)).fetchone()[0]==17
    print('PASS: PDA child shipment/duplicate/date protection, cancellation, return to new source/location and further split without adding KG')

    edited=copy.deepcopy(original);edited['outputs'][0]['price']=6000;edited['outputs'][0]['amount']=120000;edited['note']='QA updated cost'
    assert rpc('dbmt_erp_save_production',token,edited,[],pid)['ok']
    postings=conn.execute("select type,price,stock_unit_price,raw from public.transactions where deleted_at is null and raw->>'stockRowId' in (select source_stock_row_id from public.pda_packages where production_id=%s)",(pid,)).fetchall()
    assert postings and all(p[2]==6000 for p in postings), postings
    assert all(p[1]==6000 for p in postings if p[0]=='재고조정')
    assert conn.execute('select label_snapshot from public.pda_packages where label_id=%s',(first['id'],)).fetchone()[0]==order
    for posting in [result['transaction'],resplit['transaction']]:
        reject(lambda:rpc('dbmt_erp_save_transactions',token,[],[posting['id']]),'분할 박스수')
    reject(lambda:rpc('dbmt_erp_save_transactions',token,[dict(result['transaction'],boxCount=99)],[]),'전용 메뉴')
    reject(lambda:conn.execute('update public.transactions set raw=raw||%s where id=%s',(Jsonb(dict(boxCount=99)),result['transaction']['id'])),'분할 박스수')
    for table in ['weight_splits','weight_split_labels','weight_split_context']:
        assert not conn.execute("select has_table_privilege('anon',%s,'SELECT,INSERT,UPDATE,DELETE')",('pda_private.'+table,)).fetchone()[0]
    assert conn.execute('select count(*) from pda_private.weight_split_context').fetchone()[0]==0
    conn.execute('set constraints all immediate')
    print('PASS: production cost corrections propagate to child sales/returns/box adjustments, immutable snapshots, protected posting deletion/edit and private capabilities')


with psycopg.connect('',sslmode='require',connect_timeout=20,application_name='dbmt_weight_split_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='90s'")
        if os.environ.get('DBMT_LABEL_WEIGHT_DEPLOYED')!='1':conn.execute(MIGRATION.read_text(encoding='utf-8-sig'))
        with conn.transaction(force_rollback=True):check(conn)
        for filename in ['check-pda-product-cancellations-db.py','check-pda-cost-db.py','check-pda-raw-db.py']:
            with conn.transaction(force_rollback=True):
                path=ROOT/'tools'/filename;ns={'__file__':str(path)}
                tree=ast.parse(path.read_text(encoding='utf-8-sig'))
                exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef,ast.Assign,ast.AugAssign))],type_ignores=[]),str(path),'exec'),ns)
                ns['check'](conn)
    finally:
        conn.rollback()
        print('ROLLED BACK: split schema, PIN, fictional production, package, transaction and user changes. No operating stock changed.')
