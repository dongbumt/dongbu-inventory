"""Reproduce catalog/snapshot drift and verify input-only edits. Always rollback."""
import copy
import os
import uuid
import psycopg
from psycopg.types.json import Jsonb

assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER','')+os.environ.get('PGHOST','')
with psycopg.connect(sslmode='require',connect_timeout=20,application_name='dbmt_label_input_edit_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='3s'")
        conn.execute("set local statement_timeout='40s'")
        suffix=uuid.uuid4().hex[:12]
        uid=lambda key:'qa_input_'+suffix+'_'+key
        role,user=uuid.uuid4(),uuid.uuid4()
        token=uuid.uuid4().hex*2
        pin='0927'
        conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'",(pin,))
        conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Label input edit QA')",(role,uid('role')))
        conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Label input edit QA','unused',%s)",(user,uid('user'),role))
        for menu in ['production','transactions','stock','pda']:
            conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update) values(%s,%s,true,true,true)",(role,menu))
        conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')",(token,user))
        source=dict(key=uid('raw'),product=uid('raw'),lot='QA-RAW',origin='국내산',packunit='벌크',stockLocation='가공장',price=5000,stock=100)
        order=dict(id=uid('order'),date='2026-11-10',product=uid('product'),labelProductId=uid('product_id'),inputWeight=100,
                   weight=20,lot='QA-LOT',origin='국내산',packunit='5KG',grade='CH',mfgdate='2026-11-10',expdate='2027-11-09',temptype='냉동',sourceStock=source)
        product=dict(id=order['labelProductId'],name=order['product'],packunit='5KG',grade='',taxType='면세')
        for key,value in [('workOrders',[order]),('labelProducts',[product])]:
            conn.execute('update public.app_data set payload=payload||%s where key=%s',(Jsonb(value),key))
        def rpc(name,*args):
            with conn.transaction():
                conn.execute('set local role anon')
                result=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(v) if isinstance(v,(dict,list)) else v for v in args)).fetchone()[0]
                conn.execute('set local role postgres')
                return result
        logs=[dict(id=uid('log'+str(i)),code='DB2611101200-'+suffix[:5].upper()+str(i),workOrderId=order['id'],product=order['product'],labelWeight=20,status='active',workOrderSnapshot={**order,'weight':20}) for i in range(5)]
        assert rpc('dbmt_label_print_save_logs',pin,logs)['ok']
        pid=rpc('dbmt_label_complete_production',pin,order['id'],[row['id'] for row in logs])['productionId']
        before=conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]
        assert before['outputs'][0]['grade']=='CH'
        original=before['outputs'][0]['stockRowId']
        state=rpc('dbmt_erp_get_label_split',token,pid,original)
        assert state['canSplit'],state.get('reason')
        assert rpc('dbmt_erp_split_label_stock',token,pid,original,[logs[0]['id'],logs[1]['id']],state['version'],uuid.uuid4())['ok']
        entry=conn.execute('select raw from public.production_entries where id=%s',(pid,)).fetchone()[0]
        original_codes=[row['code'] for row in logs]
        bindings=conn.execute('select label_id,stock_row_id,label_snapshot,row_identity from public.label_stock_assignments where production_id=%s order by label_id',(pid,)).fetchall()
        # The old browser rebuilt grade from the master, even when only raw input kg changed.
        broken=copy.deepcopy(entry);broken['inputs'][0]['qty']=90
        for row in broken['outputs']:row['grade']=''
        try:
            rpc('dbmt_erp_save_production',token,broken,[],pid)
        except psycopg.Error as error:
            assert '라벨 분할된 생산품' in error.diag.message_primary,error.diag.message_primary
        else:raise AssertionError('Snapshot drift must reproduce the reported save failure')
        fixed=copy.deepcopy(entry);fixed['inputs'][0]['qty']=90
        saved=rpc('dbmt_erp_save_production',token,fixed,[],pid)
        assert saved['ok'] and saved['entry']['inputs'][0]['qty']==90
        assert saved['entry']['outputs']==entry['outputs']
        assert sum(row['weight'] for row in saved['transactionRows'] if row['type']=='사용')==90
        assert sum(row['weight'] for row in saved['transactionRows'] if row['type']=='생산입고')==100
        assert sum(row['boxCount'] for row in saved['entry']['outputs'])==5
        assert bindings==conn.execute('select label_id,stock_row_id,label_snapshot,row_identity from public.label_stock_assignments where production_id=%s order by label_id',(pid,)).fetchall()
        for log in logs:
            item=rpc('dbmt_pda_lookup',token,log['code'])['item']
            assert item['stockRowId']==next(row[1] for row in bindings if row[0]==log['id'])
        printed=conn.execute("select e->>'code' from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'workOrderId'=%s order by e->>'id'",(order['id'],)).fetchall()
        assert sorted(row[0] for row in printed)==sorted(original_codes)
        with conn.transaction(force_rollback=True):
            conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='production'",(role,))
            assert rpc('dbmt_erp_save_production',token,fixed,[],pid)['ok'] is False
        print('PASS: reproduced grade drift failure; input kg correction saves with unchanged split output kg/boxes/metadata, issued barcodes and exact PDA mappings; update permission enforced.')
    finally:
        conn.rollback()
        print('ROLLED BACK: fictional PIN, users, labels, split stock and transactions. No operating records changed.')
