"""Production-cost lifecycle integration. All DDL, PIN and virtual rows roll back."""
import ast
import copy
import os
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT=Path(__file__).resolve().parents[1]
SCHEMA=ROOT/'supabase/schema-rpc-77-pda-provisional-product-costs.sql'


def check(conn):
    suffix=uuid.uuid4().hex[:12]
    uid=lambda name:'qa_cost_'+suffix+'_'+name
    pin='0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'",(pin,))
    role,user,partner=(uuid.uuid4() for _ in range(3));token=uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'PDA cost QA')",(role,uid('role')))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'PDA cost QA','unused',%s)",(user,uid('user')[:30],role))
    for menu in ['pda','production','transactions','stock']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)",(role,menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')",(token,user))
    conn.execute("insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매출')",(partner,'QC'+suffix.upper(),uid('partner')))
    order=dict(id=uid('order'),date='2026-11-05',product=uid('product'),labelProductId=uid('product_id'),inputWeight=100,weight=5,
               lot='QA-LOT',origin='국내산',packunit='5KG',grade='',mfgdate='2026-11-05',expdate='2027-11-04',temptype='냉동',
               sourceStock=dict(key=uid('raw'),product=uid('raw'),price=1000,stock=100,origin='국내산',lot='RAW'))
    product=dict(id=order['labelProductId'],name=order['product'],packunit='5KG',taxType='면세')
    logs=[dict(id=uid('label'+str(i)),code='DB2611051200-'+('C0ST0'+str(i)),workOrderId=order['id'],labelWeight=5,status='active',workOrderSnapshot=order) for i in range(4)]
    for key,value in [('workOrders',[order]),('labelProducts',[product]),('labelPrintLogs',logs)]:
        conn.execute("update public.app_data set payload=payload||%s where key=%s",(Jsonb(value),key))
    conn.execute("insert into public.prices(id,product,origin,trader,price,raw) values(%s,%s,'국내산',%s,8000,'{}')",(uid('price'),order['product'],uid('partner')))

    def rpc(name,*args):
        with conn.transaction():
            conn.execute('set local role anon')
            result=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(x) if isinstance(x,(list,dict)) else x for x in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(fn,fragment):
        try:
            with conn.transaction():fn()
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary,error.diag.message_primary
        else:raise AssertionError('Expected rejection: '+fragment)

    lookup=lambda i=0:rpc('dbmt_pda_lookup',token,logs[i]['code'])['item']
    scan=lambda i=0:dict(barcode=lookup(i)['code'],revision=lookup(i)['revision'])
    commit=lambda mode,items,request=None,location='가공장':rpc('dbmt_pda_commit',token,request or uuid.uuid4(),mode,location,partner if mode=='outbound' else None,'2026-11-06',items,'QA')
    complete=lambda:rpc('dbmt_label_complete_production_reviewed',pin,order['id'],[r['id'] for r in logs],None)
    item=lookup();assert item['productionPending'] and item['productionCost'] is None and item['revision']==0
    assert conn.execute('select count(*) from public.transactions where product=%s',(order['product'],)).fetchone()[0]==0
    req=uuid.uuid4();scanned=[scan(0),scan(1)];done=commit('outbound',scanned,req)
    assert done['count']==2 and done['shipped']==2 and commit('outbound',scanned,req)['alreadySaved']
    assert conn.execute('select count(*) from public.production_entries where product=%s',(order['product'],)).fetchone()[0]==0,'Never create a fake journal'
    sales=conn.execute("select id,price,amount,stock_unit_price,raw from public.transactions where product=%s and type='출고' order by id",(order['product'],)).fetchall()
    assert len(sales)==2 and all(r[1]==8000 and r[2]==40000 and r[3] is None and r[4]['productionCost'] is None and r[4]['_productionCostStatus']=='pending' for r in sales)
    reject(lambda:commit('outbound',[scan(0)]),'이미 출고')
    reject(lambda:conn.execute("update public.app_data set payload=(select jsonb_agg(case when e->>'id'=%s then e||'{\"status\":\"void\"}' else e end) from jsonb_array_elements(payload) e) where key='labelPrintLogs'",(logs[0]['id'],)),'가출고')
    reject(lambda:conn.execute("update public.app_data set payload=(select jsonb_agg(e) from jsonb_array_elements(payload) e where e->>'id'<>%s) where key='workOrders'",(order['id'],)),'가출고')
    returned=commit('inbound',[scan(0)],location='물류창고')
    return_id=returned['items'][0]['transactionId']
    assert conn.execute('select price,stock_unit_price from public.transactions where id=%s',(return_id,)).fetchone()==(None,None)
    commit('inbound',[scan(2)])
    pending_scan=scan(2)
    result=complete();pid=result['productionId']
    assert lookup()['costStatus']=='final' and lookup()['productionCost']==5000
    assert not lookup()['productionPending']
    assert complete()['alreadyCompleted']
    reject(lambda:commit('outbound',[pending_scan]),'다른 작업자')
    source=conn.execute('select original_stock_row_id from public.pda_packages where label_id=%s',(logs[0]['id'],)).fetchone()[0]
    assert conn.execute("select pda_private.balance(%s,'가공장')",(source,)).fetchone()[0]==10
    return_source=lookup()['stockRowId']
    assert conn.execute("select pda_private.balance(%s,'물류창고')",(return_source,)).fetchone()[0]==5
    rows=conn.execute('select type,price,amount,stock_unit_price,raw from public.transactions where product=%s and deleted_at is null',(order['product'],)).fetchall()
    assert all(r[3]==5000 and r[4]['productionCost']==5000 and r[4]['_productionCostStatus']=='final' for r in rows)
    assert all(r[1]==8000 and r[2]==40000 for r in rows if r[0]=='출고')
    assert conn.execute('select price,amount from public.transactions where id=%s',(return_id,)).fetchone()==(5000,25000)
    before_sales={r[0]:(r[1],r[2]) for r in sales}
    entry=conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]
    updated=copy.deepcopy(entry);updated['outputs'][0]['price']=6000;updated['outputs'][0]['amount']=120000
    saved=rpc('dbmt_erp_save_production',token,updated,[],pid);assert saved['ok']
    assert saved['costLinkedTransactions'] and all(row['productionCost']==6000 for row in saved['costLinkedTransactions'])
    assert rpc('dbmt_erp_save_production',token,updated,[],pid)['ok'], 'Saving the same cost must be idempotent and retain protected stock'
    assert conn.execute("select count(*) from public.transactions where product=%s and deleted_at is null and stock_unit_price<>6000",(order['product'],)).fetchone()[0]==0
    for tid,price,amount,stock_cost,raw in conn.execute("select id,price,amount,stock_unit_price,raw from public.transactions where product=%s and type='출고'",(order['product'],)):
        assert (price,amount)==before_sales[tid] and stock_cost==6000 and raw['productionCostAmount']==30000
    assert conn.execute('select price,amount from public.transactions where id=%s',(return_id,)).fetchone()==(6000,30000)
    # A stale sales editor must not overwrite an automatically settled cost.
    stale=copy.deepcopy(sales[0][4]);stale.update(price=9000,amount=45000)
    stale['stockRowId']=conn.execute('select raw from public.transactions where id=%s',(sales[0][0],)).fetchone()[0]['stockRowId']
    assert rpc('dbmt_erp_save_transactions',token,[stale],[])['ok']
    assert conn.execute('select price,amount,stock_unit_price from public.transactions where id=%s',(sales[0][0],)).fetchone()==(9000,45000,6000)
    assert conn.execute("select pda_private.balance(%s,'가공장')",(source,)).fetchone()[0]==10
    assert lookup()['productionCost']==6000
    with conn.transaction(force_rollback=True):
        corrected=copy.deepcopy(updated);corrected['inputs'][0]['qty']=90;corrected['inputs'][0]['price']=1600
        corrected['outputs'][0]['price']=7200
        assert rpc('dbmt_erp_save_production',token,corrected,[],pid)['ok'], 'Corrected raw input quantities/prices may establish the final product cost'
        assert lookup()['productionCost']==7200
        assert conn.execute('select price,amount,stock_unit_price from public.transactions where id=%s',(sales[0][0],)).fetchone()==(9000,45000,7200)
    with conn.transaction(force_rollback=True):
        corrected=copy.deepcopy(updated);corrected['outputs'][0]['price']=0
        assert rpc('dbmt_erp_save_production',token,corrected,[],pid)['ok']
        assert lookup()['costStatus']=='final' and lookup()['productionCost']==0, 'A genuinely finalized zero cost is distinct from unknown cost'
    commit('outbound',[scan(0)],location='물류창고')
    assert conn.execute("select pda_private.balance(%s,'물류창고')",(return_source,)).fetchone()[0]==0
    altered=copy.deepcopy(updated);altered['outputs'][0]['qty']=1
    reject(lambda:rpc('dbmt_erp_save_production',token,altered,[],pid),'중량')
    reject(lambda:rpc('dbmt_erp_save_production',token,None,[],pid),'연결')
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='production'",(role,))
        altered=copy.deepcopy(updated);altered['outputs'][0]['price']=7000
        assert rpc('dbmt_erp_save_production',token,altered,[],pid)['ok'] is False
        assert lookup()['productionCost']==6000
    with conn.transaction():
        conn.execute('set local role anon')
        reject(lambda:conn.execute('select * from pda_private.product_cost_context'),'permission denied')
        reject(lambda:conn.execute('select pda_private.sync_product_costs(%s)',(pid,)),'permission denied')
        conn.execute('set local role postgres')
    assert conn.execute('select count(*) from pda_private.product_cost_context').fetchone()[0]==0
    with conn.transaction(force_rollback=True):
        other=copy.deepcopy(order);other.update(id=uid('multi'),product=uid('multi_A'),labelProductId=uid('multi_A_id'))
        products=[dict(product,id=other['labelProductId'],name=other['product']),dict(product,id=uid('multi_B_id'),name=uid('multi_B'))]
        mixed=[dict(logs[0],id=uid('multi_label_A'),code='DB2611051200-C0STA0',workOrderId=other['id'],workOrderSnapshot=other),
               dict(logs[1],id=uid('multi_label_B'),code='DB2611051200-C0STB0',workOrderId=other['id'],workOrderSnapshot=dict(other,product=products[1]['name'],labelProductId=products[1]['id']))]
        for key,value in [('workOrders',[other]),('labelProducts',products),('labelPrintLogs',mixed)]:conn.execute('update public.app_data set payload=payload||%s where key=%s',(Jsonb(value),key))
        scans=[dict(barcode=l['code'],revision=0) for l in mixed]
        commit('outbound',scans)
        done=rpc('dbmt_label_complete_production',pin,other['id'],[l['id'] for l in mixed]);multi_id=done['productionId']
        journal=conn.execute('select raw from public.production_entries where id=%s',(multi_id,)).fetchone()[0]
        for i,o in enumerate(journal['outputs']):o['price']=7000+i*1000
        assert rpc('dbmt_erp_save_production',token,journal,[],multi_id)['ok']
        for l in mixed:
            result=rpc('dbmt_pda_lookup',token,l['code'])['item']
            expected=next(o['price'] for o in journal['outputs'] if o['product']==l['workOrderSnapshot']['product'])
            assert result['productionCost']==expected
            posted=conn.execute("select raw from public.transactions where raw->>'_pdaLabelId'=%s and type='출고'",(l['id'],)).fetchone()[0]
            assert posted['productionCost']==expected,'Different outputs must never borrow another output cost'
        assert not conn.execute('select count(*) from pda_private.product_cost_context').fetchone()[0]
    print('PASS: distinct output costs, multiple-product pending shipment and legacy completion facade')
    print('PASS: pending lookup/ship/return, null cost, duplicate/retry, immutable issued labels, atomic completion and 20-10+5KG stock, automatic cost correction to prior sales/return/current stock, sales price isolation and stale-editor protection, permissions and deletion guards')


def main():
    migrations=list((ROOT/'supabase/migrations').glob('*_pda_provisional_product_costs.sql'))
    assert len(migrations)==1 and migrations[0].read_text(encoding='utf-8-sig')==SCHEMA.read_text(encoding='utf-8-sig'),'Reviewed schema must match the migration'
    with psycopg.connect('',sslmode='require',connect_timeout=20,application_name='dbmt_pda_cost_qa') as conn:
        try:
            conn.execute('set local role postgres')
            conn.execute("set local lock_timeout='5s'");conn.execute("set local statement_timeout='60s'")
            if os.environ.get('DBMT_COST_TEST_DEPLOYED')!='1':conn.execute(SCHEMA.read_text(encoding='utf-8-sig'))
            check(conn)
            tree=ast.parse((ROOT/'tools/check-pda-product-db.py').read_text(encoding='utf-8-sig'))
            namespace={'ROOT':ROOT};definitions=ast.Module(body=[node for node in tree.body if isinstance(node,(ast.Import,ast.ImportFrom,ast.FunctionDef))],type_ignores=[])
            exec(compile(definitions,'existing_product_checks','exec'),namespace)
            namespace['check'](conn)
            print('PASS: existing completed-product receive/ship/return/stock/authorization workflows')
        finally:
            conn.rollback();print('ROLLED BACK: schema, fixture PIN, virtual users/labels/stock and transactions. No operating records changed.')


if __name__=='__main__':main()
