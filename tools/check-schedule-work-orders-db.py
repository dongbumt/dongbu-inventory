"""Rollback-only integration of work orders, manual plans and mobile reads."""
import copy
import json
import math
import os
import runpy
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb


def tests(conn):
    # The existing manual CRUD/permission/conflict contract stays intact.
    runpy.run_path(str(Path(__file__).with_name('check-production-schedule-db.py')))['fixture_tests'](conn)
    prefix='qa_pswo_'+uuid.uuid4().hex[:10]
    role,user=uuid.uuid4(),uuid.uuid4();token=uuid.uuid4().hex+uuid.uuid4().hex;pin='0720'
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Schedule work order QA')",(role,prefix))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Schedule work order QA','unused',%s)",(user,prefix,role))
    for menu in ['production_schedule','workorders','production']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)",(role,menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')",(token,user))
    account=conn.execute("insert into public.mobile_admin_accounts(display_name,login_id,pin_hash) values('Schedule QA',%s,extensions.crypt('0123',extensions.gen_salt('bf'))) returning id",(prefix,)).fetchone()[0]
    mobile=uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.mobile_admin_sessions(token_hash,account_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')",(mobile,account))
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'",(pin,))
    product={'id':prefix+'_product','name':prefix+'_output','packunit':'100KG','taxType':'면세'}
    for key,value in [('workOrders',[]),('labelProducts',[product]),('labelPrintLogs',[])]:conn.execute('update public.app_data set payload=%s where key=%s',(Jsonb(value),key))

    def rpc(name,*args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            out=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(x) if isinstance(x,(dict,list)) else x for x in args)).fetchone()[0]
            conn.execute('set local role postgres');return out
    def reject(call):
        try:
            with conn.transaction():call()
        except psycopg.Error:return
        raise AssertionError('Expected rejection')
    def get():return rpc('dbmt_erp_get_production_schedule',token,'2098-01-01','2098-01-31')['events']
    def event(order):return next(e for e in get() if e.get('workOrderId')==order['id'])
    def create(name,amount=500):
        stock={'key':prefix+'_raw_'+name,'product':prefix+'_raw','lot':'RAW-'+name,'origin':'국내산','stock':amount,'stockBoxes':5,'price':4000,'stockLocation':'가공장'}
        row=dict(id=prefix+'_'+name,date='2098-01-10',product=product['name'],labelProductId=product['id'],packunit='100KG',title='고객 요청 / 5mm',inputWeight=amount,inputBoxCount=5,sourceStock=stock,sourceStockKey=stock['key'],sourceInputs=[dict(sourceStock=stock,sourceStockKey=stock['key'],inputWeight=amount,boxCount=5)],lot='OUT-'+name,origin='국내산',mfgdate='2098-01-10',expdate='2099-01-09',weight=100)
        saved=rpc('dbmt_erp_write_work_order',token,row,None,False);return row,saved

    manual=rpc('dbmt_erp_save_production_schedule',token,None,dict(date='2098-01-10',product=product['name'],qty=90,note='수기 유지',status='planned'),None)['event']
    a,first=create('A');b,second=create('B',200)
    events=get();assert len(events)==3
    assert next(e for e in events if e['id']==manual['id'])['source']=='manual'
    assert event(a)['qty']==500 and event(a)['inputQty']==500 and event(a)['readonly']
    assert event(a)['note']==a['title'] and event(a)['status']=='planned'
    assert len(get())==3,'Repeated reads never create copies'
    changed=dict(b,date='2098-01-11',title='변경한 작업명')
    rpc('dbmt_erp_write_work_order',token,changed,second['versions'][b['id']],False)
    assert event(b)['date']=='2098-01-11' and event(b)['note']=='변경한 작업명'
    latest=rpc('dbmt_erp_get_work_orders',token,None)
    rpc('dbmt_erp_write_work_order',token,{'id':b['id']},latest['versions'][b['id']],True)
    assert not any(e.get('workOrderId')==b['id'] for e in get())
    assert conn.execute('select qty from public.production_schedule where id=%s',(manual['id'],)).fetchone()[0]==90
    reject(lambda:rpc('dbmt_erp_delete_production_schedule',token,event(a)['id'],1))
    logs=[dict(id=prefix+'_log_'+str(n),code='DB9801101200-'+uuid.uuid4().hex[:5].upper(),workOrderId=a['id'],product=a['product'],lot=a['lot'],labelWeight=100,inputWeight=500,status='active',printedAt='2098-01-10T03:00:00Z',workOrderSnapshot=a) for n in range(3)]
    assert rpc('dbmt_label_print_save_logs',pin,logs)['ok']
    completed=rpc('dbmt_label_complete_production',pin,a['id'],[x['id'] for x in logs]);pid=completed['productionId']
    assert event(a)['status']=='completed' and event(a)['qty']==300 and event(a)['inputQty']==500
    assert rpc('dbmt_label_cancel_production',pin,a['id'],pid)['ok']
    assert event(a)['status']=='planned' and event(a)['qty']==500
    pid=rpc('dbmt_label_resubmit_production',pin,a['id'],[x['id'] for x in logs],pid)['productionId']
    journal=conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]
    assert journal['inputs'][0]['qty']==500,'Schedule read must not alter the completion input flow'
    journal['inputs'][0].update(qty=350,boxCount=3,amount=1400000)
    for output in journal['outputs']:output.update(price=math.ceil(1400000/300),amount=math.ceil(1400000/300)*output['qty'])
    postings=conn.execute('select public.dbmt_label_production_transactions(%s)',(Jsonb(journal),)).fetchone()[0]
    assert rpc('dbmt_erp_save_production',token,journal,postings,pid)['ok']
    conn.execute('set constraints all immediate');conn.execute('set constraints all deferred')
    context=rpc('dbmt_erp_get_work_order_carryover',token,a['id'])
    carried=rpc('dbmt_erp_carry_work_order',token,a['id'],'2098-01-11',[dict(index=0,qty=150,boxCount=2)],context['stateVersion'],uuid.uuid4())
    child=next(r for r in carried['rows'] if r['id']==carried['childId'])
    assert event(a)['qty']==300 and event(a)['carryTo']=='2098-01-11'
    assert event(child)['qty']==150 and event(child)['status']=='planned'
    untouched,_=create('unstarted',200)
    ctx=rpc('dbmt_erp_get_work_order_carryover',token,untouched['id'])
    moved=rpc('dbmt_erp_carry_work_order',token,untouched['id'],'2098-01-12',[dict(index=0,qty=100,boxCount=None)],ctx['stateVersion'],uuid.uuid4())
    assert not any(e.get('workOrderId')==untouched['id'] for e in get())
    assert any(e.get('workOrderId')==moved['childId'] and e['date']=='2098-01-12' for e in get())
    assert rpc('dbmt_erp_cancel_work_order_carryover',token,moved['childId'],moved['versions'][moved['childId']])['ok']
    assert event(untouched)['qty']==200
    assert not any(e.get('workOrderId')==moved['childId'] for e in get())
    assert rpc('dbmt_mobile_admin_production_schedule',mobile,'2098-01-01','2098-01-31')['events']==get()
    before=conn.execute('select (select count(*) from public.transactions),(select count(*) from public.production_entries),(select count(*) from public.production_schedule)').fetchone()
    get();get()
    assert conn.execute('select (select count(*) from public.transactions),(select count(*) from public.production_entries),(select count(*) from public.production_schedule)').fetchone()==before
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='workorders'",(role,))
    assert event(a)['source']=='work_order','Production schedule access exposes only the intended summary, not source costs'
    assert 'sourceStock' not in event(a) and 'price' not in event(a)
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='production_schedule'",(role,))
    assert rpc('dbmt_erp_get_production_schedule',token,'2098-01-01','2098-01-31')['ok'] is False
    reject(lambda:rpc('dbmt_mobile_admin_production_schedule','invalid','2098-01-01','2098-01-31'))
    reject(lambda:rpc('dbmt_mobile_admin_production_schedule',mobile,'2098-01-01','2098-12-31'))
    assert not conn.execute("select has_function_privilege('anon','public.dbmt_production_schedule_events(date,date)','execute')").fetchone()[0]
    return 'Manual CRUD unchanged; live create/update/delete; duplicate-name distinct orders; no read-side copies; completed actual quantities; cancel/resubmit; partial and unstarted carry/undo; ERP/mobile equality; no stock/production writes; auth and period bounds'


def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER','')+os.environ.get('PGHOST','')
    sql='' if '--installed' in sys.argv else sys.stdin.buffer.read().decode('utf-8-sig')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_schedule_work_orders_rollback_qa') as conn:
        conn.execute('set role postgres')
        before=conn.execute("select md5(payload::text) from public.app_data where key='workOrders'").fetchone()[0]
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'");conn.execute("set local statement_timeout='45s'")
            if sql:conn.execute(sql);conn.execute(sql)
            checks=tests(conn);conn.execute('set constraints all immediate')
        assert conn.execute("select md5(payload::text) from public.app_data where key='workOrders'").fetchone()[0]==before
        residue=conn.execute("select (select count(*) from public.erp_users where login_id like 'qa_pswo_%'),(select count(*) from public.mobile_admin_accounts where login_id like 'qa_pswo_%'),(select count(*) from public.production_entries where product like 'qa_pswo_%')").fetchone()
        assert not any(residue)
    print(json.dumps(dict(ok=True,allChangesRolledBack=True,realWorkOrdersUnchanged=True,remainingFixtures=list(residue),tests=checks),ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(type(error).__name__+': '+str(getattr(getattr(error,'diag',None),'message_primary',None) or error),file=sys.stderr)
        if isinstance(error,psycopg.Error):print('SQL context: '+str(error.diag.context),file=sys.stderr)
        else:
            import traceback
            for f in traceback.extract_tb(error.__traceback__):print(str(f.filename)+':'+str(f.lineno),file=sys.stderr)
        raise SystemExit(1)
