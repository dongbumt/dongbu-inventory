"""Rollback-only carry-over checks using real completion and inventory RPCs."""
import copy
import json
import math
import os
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb


def tests(conn):
    prefix='qa_wocarry_'+uuid.uuid4().hex[:10]
    role,user=uuid.uuid4(),uuid.uuid4()
    token=uuid.uuid4().hex+uuid.uuid4().hex
    pin='0719'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'",(pin,))
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Carry QA')",(role,prefix))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Carry QA','unused',%s)",(user,prefix,role))
    for menu in ['production','workorders']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)",(role,menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')",(token,user))
    product=dict(id=prefix+'_product',name=prefix+'_output',packunit='100KG',taxType='면세')
    for key,value in [('workOrders',[]),('labelProducts',[product]),('labelPrintLogs',[])]:
        conn.execute('update public.app_data set payload=%s where key=%s',(Jsonb(value),key))

    def rpc(name,*args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(a) if isinstance(a,(dict,list)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(call,fragment=''):
        try:
            with conn.transaction():
                call()
                conn.execute('set constraints all immediate')
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary,error.diag.message_primary
        else:raise AssertionError('Expected rejection: '+fragment)

    def flush():
        conn.execute('set constraints all immediate')
        conn.execute('set constraints all deferred')

    def factory(name,labels=True,boxes=5):
        stock=dict(key=prefix+'_'+name+'_raw',product=prefix+'_raw',lot='RAW-'+name,origin='국내산',price=4000,stock=500,stockBoxes=boxes,stockLocation='가공장')
        source=dict(sourceStockKey=stock['key'],sourceStock=stock,inputWeight=500,boxCount=boxes)
        order=dict(id=prefix+'_'+name,date='2026-10-19',title='QA carry '+name,product=product['name'],labelProductId=product['id'],packunit='100KG',inputWeight=500,inputBoxCount=boxes,sourceStock=stock,sourceStockKey=stock['key'],sourceInputs=[source],weight=100,lot='OUT-'+name,origin='국내산',mfgdate='2026-10-19',expdate='2027-10-18',temptype='냉동')
        conn.execute("update public.app_data set payload=payload||%s where key='workOrders'",(Jsonb([order]),))
        logs=[]
        if labels:
            for n in range(3):
                logs.append(dict(id=prefix+'_'+name+'_log_'+str(n),code='DB2610191200-'+uuid.uuid4().hex[:5].upper(),workOrderId=order['id'],product=order['product'],lot=order['lot'],labelWeight=100,inputWeight=500,status='active',printedAt='2026-10-19T03:00:00Z',batchId=prefix+'_batch',workOrderSnapshot=copy.deepcopy(order)))
            assert rpc('dbmt_label_print_save_logs',pin,logs)['ok']
        return order,logs

    def context(order):return rpc('dbmt_erp_get_work_order_carryover',token,order['id'])
    def carry(order,c,qty,boxes=2,request=None,date='2026-10-20'):
        return rpc('dbmt_erp_carry_work_order',token,order['id'],date,[dict(index=0,qty=qty,boxCount=boxes)],c['stateVersion'],request or uuid.uuid4())
    def entry(pid):return conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]
    def adjust(pid,qty,boxes):
        journal=entry(pid)
        journal['inputs'][0].update(qty=qty,boxCount=boxes,amount=qty*4000)
        price=math.ceil(qty*4000/sum(e['qty'] for e in journal['outputs']))
        for output in journal['outputs']:output.update(price=price,amount=round(output['qty']*price))
        postings=conn.execute('select public.dbmt_label_production_transactions(%s)',(Jsonb(journal),)).fetchone()[0]
        assert rpc('dbmt_erp_save_production',token,journal,postings,pid)['ok']
        flush()

    order,logs=factory('partial')
    assert not context(order)['state']['canCarry'],'Unposted printed production must be completed first'
    done=rpc('dbmt_label_complete_production',pin,order['id'],[l['id'] for l in logs])
    pid=done['productionId']
    assert entry(pid)['inputs'][0]['qty']==500,'Existing all-input completion must remain unchanged'
    assert context(order)['state']['sources'][0]['maxKg']==0
    assert not context(order)['state']['canCarry'],'Never duplicate already consumed raw material'
    flush()
    # This is an explicit office edit, not something carry-over calculates or writes.
    adjust(pid,350,3)
    c=context(order)
    assert c['state']['sources'][0]['maxKg']==150
    assert c['state']['sources'][0]['maxBoxes']==2
    assert c['state']['labelKg']==300 and c['state']['labelBoxes']==3
    reject(lambda:carry(order,c,200),'이월 상한')
    reject(lambda:carry(order,c,150,3),'박스수')
    reject(lambda:carry(order,c,150,date='2026-10-19'),'작업일')
    adjust(pid,340,3)
    reject(lambda:carry(order,c,150),'변경')
    adjust(pid,350,3)
    c=context(order)
    before=entry(pid)
    ledger_before=conn.execute('select jsonb_agg(raw order by id) from public.transactions where prod_id=%s',(pid,)).fetchone()[0]
    labels_before=conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    request=uuid.uuid4()
    saved=carry(order,c,150,2,request)
    child=next(r for r in saved['rows'] if r['id']==saved['childId'])
    parent=next(r for r in saved['rows'] if r['id']==order['id'])
    assert child['inputWeight']==150 and child['inputBoxCount']==2
    assert child['sourceInputs'][0]['sourceStock']==order['sourceStock']
    assert child['date']==child['mfgdate']=='2026-10-20' and child['expdate']=='2027-10-19'
    assert child['_carryoverFrom']['id']==order['id'] and parent['_carryoverTo']['id']==child['id']
    assert parent['date']==order['date'] and parent['sourceInputs']==order['sourceInputs']
    assert entry(pid)==before
    assert conn.execute('select jsonb_agg(raw order by id) from public.transactions where prod_id=%s',(pid,)).fetchone()[0]==ledger_before
    assert conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]==labels_before
    assert carry(order,c,150,2,request)['childId']==child['id']
    reject(lambda:carry(order,c,149,2,request),'변경')
    reject(lambda:carry(order,context(order),150),'이미 잔량')
    reject(lambda:rpc('dbmt_erp_write_work_order',token,parent,saved['versions'][parent['id']],False),'원 작업지시')
    reject(lambda:rpc('dbmt_erp_write_work_order',token,dict(child,inputWeight=200),saved['versions'][child['id']],False),'이월된 원료')
    reject(lambda:rpc('dbmt_erp_write_work_order',token,dict(child,_carryoverTo={'id':'forged'}),saved['versions'][child['id']],False),'이월 연결')
    reject(lambda:rpc('dbmt_erp_write_work_order',token,{'id':child['id']},saved['versions'][child['id']],True),'삭제')
    # Existing barcodes remain reprintable. New print attempts on the parent stop.
    reprint=copy.deepcopy(logs[0]);reprint['reprintCount']=1
    assert rpc('dbmt_label_print_save_logs',pin,[reprint])['ok']
    fresh=copy.deepcopy(logs[0]);fresh['id']+='new';fresh['code']='DB2610191200-ABCDE'
    reject(lambda:rpc('dbmt_label_print_save_logs',pin,[fresh]))
    # The deferred guard allows the ordinary soft-delete/upsert note save.
    note=entry(pid);note['note']='Original notes remain editable'
    postings=conn.execute('select public.dbmt_label_production_transactions(%s)',(Jsonb(note),)).fetchone()[0]
    assert rpc('dbmt_erp_save_production',token,note,postings,pid)['ok'];flush()
    reject(lambda:adjust(pid,360,3),'이월')
    reject(lambda:rpc('dbmt_label_cancel_production',pin,order['id'],pid),'이월')
    # Output label splitting still works with the carry source history locked.
    stock_id=entry(pid)['outputs'][0]['stockRowId']
    split=rpc('dbmt_erp_get_label_split',token,pid,stock_id)
    assert split['canSplit']
    result=rpc('dbmt_erp_split_label_stock',token,pid,stock_id,[logs[0]['id']],split['version'],uuid.uuid4())
    assert result['ok'];flush()
    # Tomorrow's separate barcode and journal consume only its 150KG allocation.
    child_log=dict(id=prefix+'_child_log',code='DB2610201200-ABCDE',workOrderId=child['id'],product=child['product'],lot=child['lot'],labelWeight=100,inputWeight=150,status='active',printedAt='2026-10-20T03:00:00Z',workOrderSnapshot=child)
    assert rpc('dbmt_label_print_save_logs',pin,[child_log])['ok']
    child_pid=rpc('dbmt_label_complete_production',pin,child['id'],[child_log['id']])['productionId']
    assert entry(child_pid)['inputs'][0]['qty']==150 and entry(child_pid)['inputs'][0]['boxCount']==2
    assert entry(pid)['inputs'][0]['qty']+entry(child_pid)['inputs'][0]['qty']==500
    assert entry(child_pid)['outputs'][0]['proddate']=='2026-10-20'
    latest=rpc('dbmt_erp_get_work_orders',token,None)
    reject(lambda:rpc('dbmt_erp_cancel_work_order_carryover',token,child['id'],latest['versions'][child['id']]),'라벨 출력')
    flush()
    # Unstarted work can be forwarded repeatedly; unknown boxes stay unknown.
    unused,_=factory('unused',False,None)
    moved=carry(unused,context(unused),200,None)
    unused_log=copy.deepcopy(logs[0]);unused_log.update(id=prefix+'_closed_unused_log',code='DB2610191200-CLOSE',workOrderId=unused['id'],workOrderSnapshot=unused)
    reject(lambda:rpc('dbmt_label_print_save_logs',pin,[unused_log]),'잔량을 이월한 작업')
    next_order=next(r for r in moved['rows'] if r['id']==moved['childId'])
    assert next_order['inputBoxCount'] is None
    again=carry(next_order,context(next_order),200,None,date='2026-10-21')
    assert next(r for r in again['rows'] if r['id']==again['childId'])['_carryoverFrom']['rootId']==unused['id']
    assert rpc('dbmt_erp_cancel_work_order_carryover',token,again['childId'],again['versions'][again['childId']])['ok']
    unforwarded=rpc('dbmt_erp_get_work_orders',token,None)
    undone=rpc('dbmt_erp_cancel_work_order_carryover',token,next_order['id'],unforwarded['versions'][next_order['id']])
    assert next(r for r in undone['rows'] if r['id']==unused['id']).get('_carryoverTo') is None
    assert all(r['id'] not in [next_order['id'],again['childId']] for r in undone['rows'])
    multi,_=factory('multi',False,5)
    extra=copy.deepcopy(multi['sourceInputs'][0]);extra['sourceStock']['key']+='_second';extra['sourceStockKey']=extra['sourceStock']['key']
    extra.update(inputWeight=200,boxCount=None)
    multi['sourceInputs'].append(extra);multi.update(inputWeight=700,inputBoxCount=None)
    conn.execute("update public.app_data set payload=(select jsonb_agg(case when e->>'id'=%s then %s else e end) from jsonb_array_elements(payload) e) where key='workOrders'",(multi['id'],Jsonb(multi)))
    multi_context=context(multi)
    allocations=[dict(index=0,qty=100,boxCount=1),dict(index=1,qty=50,boxCount=None)]
    reject(lambda:rpc('dbmt_erp_carry_work_order',token,multi['id'],'2026-10-20',[allocations[0],allocations[0]],multi_context['stateVersion'],uuid.uuid4()),'중복')
    multiple=rpc('dbmt_erp_carry_work_order',token,multi['id'],'2026-10-20',allocations,multi_context['stateVersion'],uuid.uuid4())
    multi_child=next(r for r in multiple['rows'] if r['id']==multiple['childId'])
    assert [i['inputWeight'] for i in multi_child['sourceInputs']]==[100,50] and multi_child['inputBoxCount'] is None
    assert rpc('dbmt_erp_write_work_order',token,dict(multi_child,title='Editable follow-up spec'),multiple['versions'][multi_child['id']],False)['ok']
    conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='workorders'",(role,))
    reject(lambda:carry(multi_child,context(multi_child),100,None),'권한')
    reject(lambda:rpc('dbmt_erp_get_work_order_carryover','invalid',order['id']),'권한')
    assert not conn.execute("select has_function_privilege('anon','public.dbmt_work_order_carry_state(text)','execute')").fetchone()[0]
    return '500 input/300 output stays 500 until manual office edit; manual 350 leaves 150; no ledger/label rewrite; source limits; stale state; UUID retry; linked history/date/shelf life; reprints; tomorrow 150 input; source edit/delete/cancel guards; note edits and label splits; unknown boxes; multiple raw sources; multi-day forwarding and pre-print undo; permissions'


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER','')+os.environ.get('PGHOST',''):raise RuntimeError('Wrong linked project')
    sql='' if '--installed' in sys.argv else sys.stdin.buffer.read().decode('utf-8-sig')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_carryover_rollback_qa') as conn:
        conn.execute('set role postgres')
        before=conn.execute("select md5(payload::text) from public.app_data where key='workOrders'").fetchone()[0]
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='45s'")
            if sql:conn.execute(sql);conn.execute(sql)
            checks=tests(conn)
            conn.execute('set constraints all immediate')
        assert conn.execute("select md5(payload::text) from public.app_data where key='workOrders'").fetchone()[0]==before
        residue=conn.execute("""select
          (select count(*) from public.erp_users where login_id like 'qa_wocarry_%'),
          (select count(*) from public.production_entries where product like 'qa_wocarry_%'),
          (select count(*) from public.change_logs where payload->>'id' like 'qa_wocarry_%')""").fetchone()
        assert not any(residue)
    print(json.dumps(dict(ok=True,allChangesRolledBack=True,realWorkOrdersUnchanged=True,remainingFixtures=list(residue),tests=checks),ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(type(error).__name__+': '+str(getattr(getattr(error,'diag',None),'message_primary',None) or error),file=sys.stderr)
        if isinstance(error,psycopg.Error):print('SQL context: '+str(error.diag.context),file=sys.stderr)
        else:
            import traceback
            for frame in traceback.extract_tb(error.__traceback__):print(str(frame.filename)+':'+str(frame.lineno),file=sys.stderr)
        raise SystemExit(1)
