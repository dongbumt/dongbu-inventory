"""Real RPCs with fictional fixtures. Installation and test writes always roll back."""
import os
import importlib.util
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]


def tests(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda key: 'qa_itemcount_' + key + '_' + suffix
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Item count QA') returning id", (uid('role'),)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'submaterials',true,true,true,true)", (role,))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Item count QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", (uid('user'),uuid.uuid4().hex,role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token,user))
    today = datetime.now(timezone(timedelta(hours=9))).date()
    item = dict(id=uid('item'),code=uid('code'),name='합계실사 가상 포장지',spec='규격',unit='장')
    other = dict(id=uid('other'),code=uid('othercode'),name=item['name'],spec=item['spec'],unit='장')
    lots = [dict(id=uid('lot'+str(i)),itemId=item['id'],itemCode=item['code'],itemName=item['name'],itemSpec=item['spec'],unit='장',
                 lot='SAME-LOT',date=(today-timedelta(days=4-i)).isoformat(),qty=qty) for i,qty in enumerate([30,50,20])]
    other_lot = dict(id=uid('otherlot'),itemId=other['id'],itemCode=other['code'],itemName=other['name'],itemSpec=other['spec'],unit='장',lot='SAME-LOT',date=lots[0]['date'],qty=999)
    legacy = dict(id=uid('legacy'),itemId=item['id'],itemCode=item['code'],itemName=item['name'],itemSpec=item['spec'],date='2026-01-01',qty=123,unit='장',note='Preserve legacy')

    def app(key,value):
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload', (key,Jsonb(value)))

    def reset(quantities=(30,50,20)):
        for lot,qty in zip(lots,quantities): lot['qty']=qty
        app('subMaterialItems',[item,other]);app('subMaterialLots',lots+[other_lot]);app('subMaterialCounts',[legacy])
        conn.execute('delete from public.submaterial_usages where lot_id=any(%s)',([l['id'] for l in lots],))

    def rpc(name,*args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(a) if isinstance(a,(list,dict)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def request(name,actual):
        rows=conn.execute('select lot,stock_qty from erp_submaterial_private.item_lots(%s)',(item['id'],)).fetchall()
        snapshot={l['id']:dict(qty=float(q),date=l.get('date',''),createdAt=l.get('createdAt',''),unit=l.get('unit',item['unit'])) for l,q in rows}
        return dict(id=uid(name),itemId=item['id'],qty=actual,expectedSystemQty=float(sum(q for _,q in rows)),expectedLots=snapshot,manager='실사 담당',note='합계 실사')

    save=lambda value:rpc('dbmt_erp_save_submaterial_item_count',token,value)
    snapshot=lambda:rpc('dbmt_erp_get_submaterial_stock',token)
    stocks=lambda:[conn.execute('select public.dbmt_submaterial_lot_stock(%s)',(l['id'],)).fetchone()[0] for l in lots]
    delete=lambda count_id:rpc('dbmt_erp_delete_submaterial_count',token,count_id,snapshot()['countsRevision'])

    def reject(callback,fragment):
        try: callback()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001','42501'),error.sqlstate
            assert fragment in error.diag.message_primary,error.diag.message_primary
        else: raise AssertionError('Expected rejection: '+fragment)

    reset()
    assert rpc('dbmt_erp_save_submaterial_item_count','invalid',request('badtoken',60))['code']=='session_expired'
    conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s",(role,))
    assert not save(request('denied',60))['ok']
    conn.execute("update public.erp_role_permissions set can_create=true where role_id=%s",(role,))
    req=request('decrease',40)
    saved=save(req)
    assert saved['ok'] and stocks()==[0,20,20]
    assert [c['adjustmentQty'] for c in saved['allocations']]==[-30,-30]
    assert saved['counts'][0]==legacy
    assert conn.execute('select public.dbmt_submaterial_lot_stock(%s)',(other_lot['id'],)).fetchone()[0]==999
    retried=save(req)
    assert retried['alreadySaved'] and len(retried['counts'])==3
    assert rpc('dbmt_erp_save_app_data',token,{'subMaterialCounts':[legacy]})['ok']
    assert len(snapshot()['counts'])==3, 'A stale generic array cannot remove group allocations or metadata'
    assert save(dict(req,qty=41))['code']=='count_id_conflict'
    assert rpc('dbmt_erp_delete_submaterial_count',token,saved['allocations'][0]['id'],'stale')['code']=='counts_conflict'
    # Deleting any member cancels every LOT adjustment in this one count.
    assert delete(saved['allocations'][1]['id'])['ok'] and stocks()==[30,50,20]
    assert save(req)['code']=='count_deleted'
    assert snapshot()['counts']==[legacy]
    req=request('increase',125)
    increased=save(req)
    assert increased['ok'] and stocks()==[55,50,20] and len(increased['allocations'])==1
    # A stale request must fail even when transfers between LOTs leave the sum unchanged.
    stale=request('same_total',90)
    app('subMaterialLots',[dict(l,qty=l['qty']+(-1 if i==0 else 1 if i==1 else 0)) for i,l in enumerate(lots)]+[other_lot])
    assert save(stale)['code']=='stock_conflict' and len(snapshot()['counts'])==2
    app('subMaterialLots',lots+[other_lot])
    membership=request('new_zero_lot',90)
    app('subMaterialLots',lots+[other_lot,dict(lots[0],id=uid('new_zero'),qty=0)])
    assert save(membership)['code']=='stock_conflict'
    app('subMaterialLots',lots+[other_lot])
    # Increased stock already used cannot be removed by deleting the physical count.
    usage_id=uid('usage')
    conn.execute('insert into public.submaterial_usages(id,production_id,work_date,item_id,lot_id,qty,raw) values(%s,%s,%s,%s,%s,40,%s)',
                 (usage_id,uid('prod'),today,item['id'],lots[0]['id'],Jsonb(dict(id=usage_id,lotId=lots[0]['id'],itemId=item['id'],qty=40))))
    before=snapshot()['counts']
    assert delete(increased['allocations'][0]['id'])['code']=='count_in_use'
    assert snapshot()['counts']==before
    reset()
    assert save(request('zero_delta',100))['ok'] and stocks()==[30,50,20]
    assert save(request('zero_actual',0))['ok'] and stocks()==[0,0,0]
    reset((0,0,0))
    assert save(request('empty_increase',7))['ok'] and stocks()==[7,0,0]
    reset((0.1,0.2,0.3))
    assert save(request('decimal',0.35))['ok'] and stocks()==[0,Decimal('0.05'),Decimal('0.3')]
    reset((0,-5,15))
    assert save(request('existing_negative',0))['ok'] and stocks()==[0,-5,5]
    assert save(request('negative_increase',20))['ok'] and stocks()==[20,-5,5]
    reset()
    reject(lambda:save(request('negative',-1)),'0 이상')
    reject(lambda:save(request('precision',0.1234567)),'여섯')
    reject(lambda:save(dict(request('not_number',1),qty='1')),'최신 LOT')
    app('subMaterialLots',[])
    reject(lambda:save(request('no_lots',1)),'입고 LOT')
    app('subMaterialLots',[dict(lots[0],date=(today+timedelta(days=1)).isoformat())]+lots[1:])
    reject(lambda:save(request('future',1)),'미래 입고일')
    app('subMaterialLots',[dict(lots[0],unit='개')]+lots[1:])
    reject(lambda:save(request('mixed_units',1)),'단위가 다른')
    reset()
    # Equal dates use creation time, then stable receipt ID, irrespective of array order.
    tied=[dict(l,date=today.isoformat(),createdAt='2026-01-01T00:00:00Z') for l in lots]
    app('subMaterialLots',list(reversed(tied))+[other_lot])
    assert save(request('ties',101))['allocations'][0]['lotId']==min(l['id'] for l in lots)
    reset()
    # Any downstream audit failure must roll the whole multi-LOT update back.
    conn.execute("""create function pg_temp.reject_item_count_audit() returns trigger language plpgsql as $$ begin
      if new.entity='부자재 실사' and new.payload->'count'->>'lotId'="""+"'"+lots[1]['id']+"'"+""" then raise exception 'QA audit failure'; end if;return new;end;$$""")
    conn.execute('create trigger qa_item_count_fail before insert on public.change_logs for each row execute function pg_temp.reject_item_count_audit()')
    reject(lambda:save(request('atomic',0)),'QA audit failure')
    assert snapshot()['counts']==[legacy] and stocks()==[30,50,20]
    conn.execute('drop trigger qa_item_count_fail on public.change_logs')
    assert conn.execute("select not prosecdef from pg_proc where oid='public.dbmt_erp_save_submaterial_item_count(text,jsonb)'::regprocedure").fetchone()[0]
    assert not conn.execute("select has_function_privilege('anon','erp_submaterial_private.item_lots(text)','execute')").fetchone()[0]
    assert not conn.execute("select has_function_privilege('anon','erp_submaterial_private.delete_item_count(text,text,text)','execute')").fetchone()[0]
    print('PASS: oldest-first decrease/increase, multi-LOT atomicity, identity isolation, decimals/zero/negative stock, unchanged legacy, retries, cancellation, consumption guard, same-total conflict, dates/units, authentication and permissions')


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER',''): raise RuntimeError('Wrong linked project')
    migration,=(ROOT/'supabase/migrations').glob('*_submaterial_item_stock_counts.sql')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_item_count_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='40s'")
            if os.environ.get('DBMT_ITEM_COUNT_DEPLOYED')!='1': conn.execute(migration.read_text(encoding='utf-8'))
            tests(conn)
            legacy_spec=importlib.util.spec_from_file_location('legacy_stock_count_tests',ROOT/'supabase/tests/check-submaterial-stock-count-db.py')
            legacy=importlib.util.module_from_spec(legacy_spec)
            legacy_spec.loader.exec_module(legacy)
            legacy.fixture_tests(conn)
        assert not conn.execute("select 1 from public.erp_users where login_id like 'qa_itemcount_%'").fetchone()
    print('PASS: all QA schema, user, LOT, stock and audit changes rolled back')


if __name__=='__main__': main()
