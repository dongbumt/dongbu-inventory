"""All fixture changes roll back, including the temporary PIN; --apply installs DDL only."""
import copy
import json
import os
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    pin = '0927'  # Transaction-local fixture, never an actual user's credential.
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    order = dict(id='qa_label_'+suffix,date='2026-09-10',title='QA completion',product='QA output',labelProductId='qa_product',
                 inputWeight=100,weight=5,lot='QA-LOT',origin='국내산',mfgdate='2026-09-10',
                 sourceStock=dict(key='qa_stock',product='QA raw',lot='QA-RAW',origin='국내산',packunit='벌크',
                                  proddate='2026-09-01',stockLocation='가공장',price=5000,stock=100))
    products = [dict(id='qa_product',name='QA output',packunit='5KG',taxType='면세')]
    for key,value in [('workOrders',[order]),('labelProducts',products),('labelPrintLogs',[])]:
        conn.execute("insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload",(key,Jsonb(value)))
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Label QA') returning id",('qa_label_'+suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'production',true,true,true,true)",(role,))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Label QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id",('qalabel'+suffix,uuid.uuid4().hex,role)).fetchone()[0]
    token=uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')",(token,user))

    def rpc(name,*args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            value=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(a) if isinstance(a,(list,dict)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    def reject(callback,fragment=''):
        try: callback()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001','42501'), error.sqlstate
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else: raise AssertionError('Request should be rejected')

    def log(name,weight=5):
        return dict(id='qa_'+suffix+'_'+name,workOrderId=order['id'],product=order['product'],labelWeight=weight,
                    status='active',reprintCount=0,workOrderSnapshot={**order,'weight':weight})
    a,b,c=log('a'),log('b',7.35),log('c',10)
    b['workOrderSnapshot'].update(packunit='5KG',taxType='면세',brand='',factoryNo='',nationalPartCode='',nationalPartName='',productCode='')
    save=lambda rows:rpc('dbmt_label_print_save_logs',pin,rows)
    complete=lambda ids:rpc('dbmt_label_complete_production',pin,order['id'],ids)
    reject(lambda:rpc('dbmt_label_complete_production','bad',order['id'],[]),'PIN')
    reject(lambda:complete([]),'출력이력')
    bad=log('forged');bad['workOrderSnapshot']['sourceStock']={**order['sourceStock'],'price':99999}
    reject(lambda:save([bad]),'투입정보')
    bad=log('forgedmeta');bad['workOrderSnapshot']['packunit']='FAKE'
    reject(lambda:save([bad]),'품목정보')
    save([a,b]); save([c])
    reject(lambda:complete([a['id'],b['id']]),'변경')
    void={**c,'status':'void','voidedAt':'2026-09-10T01:00:00Z','voidReason':'QA'}
    save([void]); result=save([a,b,c])
    assert len(result['logs'])==3 and next(x for x in result['logs'] if x['id']==c['id'])['status']=='void'
    reject(lambda:save([{**a,'labelWeight':9}]),'변경')
    done=complete([b['id'],a['id']]); pid=done['productionId']
    entry=conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]
    assert entry['inputs'][0]['qty']==100 and entry['outputs'][0]['qty']==12.35
    assert len(entry['outputs'])==1, 'Old/new snapshot metadata must not split the same product/LOT'
    assert entry['outputs'][0]['packunit']=='5KG'
    rows=conn.execute('select type,weight,raw from public.transactions where prod_id=%s and deleted_at is null',(pid,)).fetchall()
    assert len(rows)==2 and sorted(float(r[1]) for r in rows)==[12.35,100]
    assert all(isinstance(r[2],dict) for r in rows)
    assert complete([a['id'],b['id']])['productionId']==pid
    assert complete([])['alreadyCompleted'] is True
    reject(lambda:save([log('new')]),'생산완료')
    reject(lambda:save([{**a,'status':'void'}]),'생산완료')
    assert save([{**a,'reprintCount':1,'lastReprintedAt':'2026-09-10T02:00:00Z'}])['ok']
    assert complete([a['id'],b['id']])['productionId']==pid
    assert any(c['workOrderId']==order['id'] for c in rpc('dbmt_label_print_get_data',pin)['completions'])
    assert any(e['id']==pid for e in rpc('dbmt_erp_get_label_productions',token)['entries'])
    reject(lambda:rpc('dbmt_erp_get_label_productions','bad'),'권한')

    def edit(value,session=token):
        return rpc('dbmt_erp_save_production',session,value,[],pid)
    extra=dict(product='QA extra',lot='EXTRA',qty=10,price=6000,amount=60000,origin='국내산',packunit='',stockLocation='가공장')
    updated=copy.deepcopy(entry); updated['inputs'].append(extra)
    assert edit(updated,'invalid')['ok'] is False
    conn.execute('update public.erp_role_permissions set can_update=false where role_id=%s',(role,))
    assert edit(updated)['ok'] is False
    conn.execute('update public.erp_role_permissions set can_update=true where role_id=%s',(role,))
    saved=edit(updated)
    assert saved['ok'] and saved['entry']['outputs'][0]['qty']==12.35
    assert saved['entry']['outputs'][0]['price']==entry['outputs'][0]['price'], 'Keep user-entered unit price'
    assert len(saved['transactionRows'])==3
    changed=copy.deepcopy(updated)
    changed.update(date='2026/09/09',job_no='7',job_type='묶음',key=['2026/09/09','7'],note='QA office correction')
    changed['inputs'][0].update(product='QA changed raw',lot='NEW-RAW',qty=90,price=4000,origin='미국산',packunit='박스')
    changed['outputs'][0].update(product='QA changed output',productId='qa_other',labelProductId='qa_other',
                                 lot='NEW-OUT',qty=42,price=22000,origin='미국산',packunit='EA')
    changed['outputs'].append(dict(product='QA second output',lot='SECOND',qty=3,price=2000))
    changed.pop('_labelCompletion')  # Normal form and older clients may omit the metadata.
    changed_result=edit(changed)
    assert changed_result['ok'] and len(changed_result['transactionRows'])==4
    assert changed_result['entry']['_labelCompletion']==entry['_labelCompletion']
    assert changed_result['entry']['inputs'][0]['amount']==360000
    assert changed_result['entry']['outputs'][0]['amount']==924000
    typed=conn.execute('select work_date,output_weight,product,lot from public.production_entries where id=%s',(pid,)).fetchone()
    assert str(typed[0])=='2026-09-09' and float(typed[1])==45 and typed[2:] == ('QA changed output','NEW-OUT')
    posted=conn.execute('select type,product,lot,weight,date,note from public.transactions where prod_id=%s and deleted_at is null',(pid,)).fetchall()
    assert len(posted)==4 and all(str(r[4])=='2026-09-09' and 'QA office correction' in r[5] for r in posted)
    assert any(r[1]=='QA changed raw' and float(r[3])==90 for r in posted)
    assert not any(r[1]=='QA raw' for r in posted), 'Original stock movement must be replaced, not duplicated'
    assert complete([])['alreadyCompleted'] is True
    status=next(c for c in rpc('dbmt_label_print_get_data',pin)['completions'] if c['workOrderId']==order['id'])
    assert status['date']=='2026/09/09' and status['jobNo']=='7'
    assert conn.execute('select baseline from public.label_production_completions where production_id=%s',(pid,)).fetchone()[0]==entry
    assert conn.execute('select output_weight from public.production_entries where id=%s',(pid,)).fetchone()[0]==45
    invalid=copy.deepcopy(changed);invalid['outputs'][0]['qty']=0
    reject(lambda:edit(invalid),'중량')
    invalid=copy.deepcopy(changed);invalid['id']='other-id'
    reject(lambda:edit(invalid),'식별값')
    assert conn.execute('select output_weight from public.production_entries where id=%s',(pid,)).fetchone()[0]==45
    tampered=copy.deepcopy(changed);tampered['_labelCompletion']={'workOrderId':'forged'}
    assert edit(tampered)['entry']['_labelCompletion']==entry['_labelCompletion']
    removed=copy.deepcopy(changed);removed['inputs']=removed['inputs'][1:];removed['outputs']=removed['outputs'][1:]
    assert len(edit(removed)['transactionRows'])==2, 'Original rows may be removed'
    only_output=copy.deepcopy(removed);only_output['inputs']=[]
    assert len(edit(only_output)['transactionRows'])==1, 'Output-only journal matches ordinary form'
    only_input=copy.deepcopy(removed);only_input['outputs']=[]
    assert len(edit(only_input)['transactionRows'])==1, 'Input-only journal matches ordinary form'
    # Arbitrary caller postings cannot replace the server-generated output.
    again=rpc('dbmt_erp_save_production',token,updated,[{'id':'forged','weight':999}],pid)
    assert again['ok'] and next(row for row in again['transactionRows'] if row['_isProdOut'])['weight']==12.35
    assert edit(entry)['ok']  # Restore fixture inputs and output, never real business data.
    assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null',(pid,)).fetchone()[0]==2
    reject(lambda:rpc('dbmt_erp_save_production_before_label',token,entry,[],pid))
    reject(lambda:rpc('dbmt_label_production_transactions',entry))
    # Normal journals retain the original permission-checked behavior.
    normal=dict(id='qa_normal_'+suffix,date='2026/09/10',job_no='99',inputs=[],outputs=[],_isUser=True)
    assert rpc('dbmt_erp_save_production',token,normal,[],None)['ok']
    assert rpc('dbmt_erp_save_production',token,None,[],normal['id'])['ok']
    def resubmit(ids,previous=pid,code=pin):
        return rpc('dbmt_label_resubmit_production',code,order['id'],ids,previous)
    reject(lambda:resubmit([a['id'],b['id']],code='invalid'),'PIN')
    reject(lambda:resubmit([a['id'],b['id']]),'먼저 삭제')
    assert rpc('dbmt_erp_save_production',token,None,[],pid)['ok']
    # A delayed original request cannot recreate a journal after the office deleted it.
    reject(lambda:complete([]),'삭제')
    assert pid in rpc('dbmt_erp_get_label_productions',token)['productionIds']
    assert not any(e['id']==pid for e in rpc('dbmt_erp_get_label_productions',token)['entries'])
    status=next(c for c in rpc('dbmt_label_print_get_data',pin)['completions'] if c['workOrderId']==order['id'])
    assert status['deleted'] is True
    save([{**a,'status':'void','voidReason':'QA correction'}])
    d=log('replacement',9);save([d])
    # Failure after moving the marker into history must roll back that move too.
    reject(lambda:resubmit([a['id'],b['id']]),'변경')
    assert conn.execute('select production_id from public.label_production_completions where work_order_id=%s',(order['id'],)).fetchone()[0]==pid
    assert not conn.execute('select 1 from public.label_production_completion_history where production_id=%s',(pid,)).fetchone()
    with conn.transaction(force_rollback=True):
        conn.execute('update public.transactions set deleted_at=null where prod_id=%s',(pid,))
        reject(lambda:resubmit([b['id'],d['id']]),'재고')
    resent=resubmit([b['id'],d['id']]);new_pid=resent['productionId'];assert new_pid!=pid
    assert float(conn.execute('select output_weight from public.production_entries where id=%s',(new_pid,)).fetchone()[0])==16.35
    archived=conn.execute('select baseline,successor_id from public.label_production_completion_history where production_id=%s',(pid,)).fetchone()
    assert archived==(entry,new_pid)
    assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null',(pid,)).fetchone()[0]==0
    assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null',(new_pid,)).fetchone()[0]==2
    assert resubmit([b['id'],d['id']])['productionId']==new_pid
    assert resubmit([])['alreadyCompleted'] is True
    assert complete([])['productionId']==new_pid
    reject(lambda:save([log('after-resubmit')]),'생산완료')
    reject(lambda:save([{**b,'status':'void'}]),'생산완료')
    office=rpc('dbmt_erp_get_label_productions',token)
    assert pid in office['productionIds'] and new_pid in office['productionIds']
    assert new_pid in [e['id'] for e in office['entries']] and pid not in [e['id'] for e in office['entries']]
    assert rpc('dbmt_erp_save_production',token,None,[],new_pid)['ok']
    reject(lambda:resubmit([b['id'],d['id']]),'변경')
    newest=resubmit([b['id'],d['id']],previous=new_pid)['productionId']
    assert newest not in (pid,new_pid)
    reject(lambda:resubmit([b['id'],d['id']]),'변경')
    assert resubmit([],previous=new_pid)['productionId']==newest
    assert conn.execute('select count(*) from public.label_production_completion_history where work_order_id=%s',(order['id'],)).fetchone()[0]==2
    assert conn.execute("select has_table_privilege('anon','public.label_production_completion_history','SELECT')").fetchone()[0] is False


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER',''): raise RuntimeError('Wrong linked project')
    sql=sys.stdin.buffer.read().decode('utf-8-sig')
    if 'dbmt_label_complete_production' not in sql: raise RuntimeError('Expected completion schema')
    apply='--apply' in sys.argv
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_label_completion_qa') as conn:
        with conn.transaction(force_rollback=not apply):
            conn.execute('set local role postgres')
            conn.execute(sql)
            with conn.transaction(force_rollback=True): fixture_tests(conn)
    print(json.dumps(dict(ok=True,schemaApplied=apply,fixturesRolledBack=True,tests='PIN, atomic postings, full journal edit, reopen only deleted, corrected labels, resubmit rollback, repeated generations, stale retry protection, history/cache IDs, permissions')))


if __name__=='__main__':
    try: main()
    except Exception as error:
        print(type(error).__name__+': '+str(getattr(getattr(error,'diag',None),'message_primary',None) or error),file=sys.stderr)
        if isinstance(error,psycopg.Error):
            print('SQL position: '+str(error.diag.statement_position)+'; context: '+str(error.diag.context),file=sys.stderr)
        sys.exit(1)
