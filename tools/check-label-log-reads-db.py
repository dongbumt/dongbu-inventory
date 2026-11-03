"""Scoped print-history reads/writes. All schema trials and fictional data roll back."""
import copy
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT=Path(__file__).resolve().parent.parent
SQL=(ROOT/'supabase/schema-rpc-74-label-logs-on-demand.sql').read_text(encoding='utf-8-sig')


def tests(conn):
    prefix='qa_log_reads_'+uuid.uuid4().hex[:9]
    pin='0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'",(pin,))
    role,user,token=uuid.uuid4(),uuid.uuid4(),uuid.uuid4().hex*2
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Log Read QA')",(role,prefix))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Log Read QA','unused',%s)",(user,prefix,role))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')",(token,user))
    raw=dict(key=prefix+'_raw',product='가상 원료',lot='RAW',origin='미국산',price=5000,stock=100)
    order=dict(id=prefix+'_a',date='2026-11-04',title='가상 작업 A',product='가상 제품',labelProductId=prefix+'_p',inputWeight=100,weight=5,lot='RAW',origin='미국산',mfgdate='2026-11-04',expdate='2027-11-03',sourceStock=raw)
    other=dict(order,id=prefix+'_b',title='가상 작업 B')
    for key,value in [('workOrders',[order,other]),('labelProducts',[dict(id=prefix+'_p',name=order['product'])]),('labelPrintLogs',[])]:
        conn.execute('update public.app_data set payload=%s where key=%s',(Jsonb(value),key))

    def rpc(name,*args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            value=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(a) if isinstance(a,(dict,list)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    def reject(fn,text):
        try:
            with conn.transaction():fn()
        except psycopg.Error as error:
            assert text in error.diag.message_primary,error.diag.message_primary
        else:raise AssertionError('Expected rejection: '+text)

    def log(row,weight,status='active'):
        return dict(id=prefix+uuid.uuid4().hex,code='DB2611041200-'+uuid.uuid4().hex[:6].upper(),workOrderId=row['id'],status=status,printedAt='2026-11-04T03:00:00Z',product=row['product'],lot=row['lot'],labelWeight=weight,inputWeight=100,reprintCount=0,workOrderSnapshot=dict(row,weight=weight))
    a=[log(order,5),log(order,7.35),log(order,9,'void')]
    b=[log(other,20),log(other,15)]
    rpc('dbmt_label_print_save_logs',pin,a+b)  # Old stations keep their original contract.
    stored=lambda:conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    before=stored()
    boot=rpc('dbmt_label_print_get_data',pin,None)
    assert boot['appData']['labelPrintLogs']==[] and boot['logScope']==dict(workOrderId=None)
    totals={r['workOrderId']:r for r in boot['logSummaries']}
    assert totals[order['id']]['count']==2 and float(totals[order['id']]['weight'])==12.35
    assert totals[order['id']]['totalCount']==3 and totals[other['id']]['count']==2
    selected=rpc('dbmt_label_print_get_data',pin,order['id'])
    assert selected['appData']['labelPrintLogs']==a
    assert rpc('dbmt_label_print_get_data',pin)['appData']['labelPrintLogs']==a+b
    assert stored()==before,'Reads must not modify history'
    core=rpc('dbmt_erp_get_all',token)
    assert 'labelPrintLogs' not in core['appData'] and core['deferredAppData']==['labelPrintLogs']
    # Compare every remaining core field with the former full read under identical authorization.
    with conn.transaction():
        conn.execute("set local dbmt.personal_authorized='true'")
        old=conn.execute("select public.dbmt_get_all('')").fetchone()[0]
    del old['appData']['labelPrintLogs']
    assert {k:core[k] for k in old}==old,'Transactions, production, prices and other app data are unchanged'
    reject(lambda:rpc('dbmt_erp_get_all','invalid'),'만료')
    reject(lambda:rpc('dbmt_label_print_get_data','9999',None),'PIN')
    reject(lambda:rpc('dbmt_label_print_get_data',pin,prefix+'_missing'),'찾을 수 없습니다')
    reject(lambda:rpc('dbmt_label_print_save_logs','9999',a,order['id']),'PIN')
    reject(lambda:rpc('dbmt_label_print_save_logs',pin,b,order['id']),'선택한 작업지시')
    wrong=copy.deepcopy(a[0]);wrong['workOrderSnapshot']['product']='변경'
    reject(lambda:rpc('dbmt_label_print_save_logs',pin,[wrong],order['id']),'변경할 수 없습니다')
    reprinted=dict(a[0],reprintCount=1,lastReprintedAt='2026-11-04T04:00:00Z')
    saved=rpc('dbmt_label_print_save_logs',pin,[reprinted],order['id'])
    assert len(saved['logs'])==3 and all(r['workOrderId']==order['id'] for r in saved['logs'])
    assert saved['logs'][0]['workOrderSnapshot']==a[0]['workOrderSnapshot']
    assert saved['logs'][0]['code']==a[0]['code']
    assert [r for r in stored() if r['workOrderId']==other['id']]==b
    removed=dict(a[1],status='void',voidedAt='2026-11-04T04:00:00Z',voidReason='가상 취소')
    rpc('dbmt_label_print_save_logs',pin,[removed],order['id'])
    current=rpc('dbmt_label_print_get_data',pin,order['id'])
    summary=next(r for r in current['logSummaries'] if r['workOrderId']==order['id'])
    assert summary['count']==1 and float(summary['weight'])==5 and summary['totalCount']==3
    assert len(stored())==5 and [r for r in stored() if r['workOrderId']==other['id']]==b
    for who in ['anon','authenticated']:
        assert not conn.execute("select has_function_privilege(%s,'label_print_private.outer_log_summaries(jsonb)','execute')",(who,)).fetchone()[0]
    return len(json.dumps(old,ensure_ascii=False).encode('utf8'))


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER','')+os.environ.get('PGHOST',''):raise RuntimeError('Wrong project')
    migration,=(ROOT/'supabase/migrations').glob('*_label_logs_on_demand.sql')
    assert migration.read_text(encoding='utf-8-sig')==SQL
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_label_log_reads_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='2s'")
            conn.execute("set local statement_timeout='8s'")
            if '--installed' not in sys.argv:conn.execute(SQL)
            tests(conn)
            # Historical production/barcode/LOT/split/carryover behavior still uses the intact ledger.
            spec=importlib.util.spec_from_file_location('lots',ROOT/'tools/check-work-order-output-lots-db.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            module.tests(conn)
    print(json.dumps(dict(ok=True,installed='--installed' in sys.argv,fixturesRolledBack=True,
        tests='core payload parity; bootstrap/detail/save scope; summaries; PIN/session checks; immutable barcode/snapshot; reprint/void isolation; original client compatibility; LOT/production/PDA/carryover regressions'),ensure_ascii=False))


if __name__=='__main__':main()
