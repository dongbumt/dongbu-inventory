"""Real RPC tests. All schema trials, fictional users and postings roll back."""
import copy
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb


def tests(conn):
    prefix = 'qa_output_lots_' + uuid.uuid4().hex[:10]
    pin, token, role, user = '0927', uuid.uuid4().hex * 2, uuid.uuid4(), uuid.uuid4()
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Output LOT QA')", (role, prefix))
    conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Output LOT QA','unused',%s)", (user, prefix, role))
    for menu in ['workorders', 'production', 'pda']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)", (role, menu))
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
    product = dict(id=prefix+'_p', name=prefix+'_product', packunit='5KG')
    sources = [dict(sourceStockKey=prefix+str(i), sourceStock=dict(key=prefix+str(i), product=prefix+'_raw', lot='LOT-'+str(i), origin='미국산', price=5000, stock=qty, stockBoxes=10, stockLocation='가공장'), inputWeight=qty, boxCount=10) for i, qty in enumerate([100, 50, 20, 10])]
    order = dict(id=prefix+'_order', date='2026-10-29', product=product['name'], labelProductId=product['id'], packunit='5KG', sourceInputs=sources, sourceStock=sources[0]['sourceStock'], sourceStockKey=sources[0]['sourceStockKey'], inputWeight=180, inputBoxCount=40, weight=5, lot='LOT-1', origin='미국산', mfgdate='2026-10-29', expdate='2027-10-28', temptype='냉동', outputLotSelectionVersion=1, outputLots=['LOT-0', 'LOT-1', 'LOT-2'], defaultOutputLot='LOT-1')
    for key, value in [('workOrders', []), ('labelProducts', [product]), ('labelPrintLogs', [])]:
        conn.execute('update public.app_data set payload=%s where key=%s', (Jsonb(value), key))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result = conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')', tuple(Jsonb(a) if isinstance(a, (dict, list)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(call, fragment):
        try:
            with conn.transaction():
                call()
        except psycopg.Error as e:
            assert fragment in e.diag.message_primary, e.diag.message_primary
        else:
            raise AssertionError('Expected rejection: '+fragment)

    write = lambda row, version=None: rpc('dbmt_erp_write_work_order', token, row, version, False)
    for extras, fragment in [({'outputLots': ['LOT-0']*2}, '중복'), ({'outputLots': ['LOT-0','LOT-1','LOT-2','LOT-3']}, '1~3'), ({'outputLots':['FOREIGN']}, '투입 원료육'), ({'defaultOutputLot':'LOT-3'}, '기본'), ({'defaultOutputLot':1}, '기본')]:
        reject(lambda e=extras: write(dict(order, **e)), fragment)
    saved = write(order)
    assert saved['ok'] and saved['rows'][0] == order
    reject(lambda: write({k:v for k,v in order.items() if k not in ['outputLotSelectionVersion','outputLots','defaultOutputLot']}, saved['versions'][order['id']]), '출력 이력번호')
    reject(lambda: rpc('dbmt_label_inner_prints', 'bad', order['id']), 'PIN')
    assert not conn.execute("select has_table_privilege('anon','label_print_private.inner_print_logs','select')").fetchone()[0]
    assert not conn.execute("select has_function_privilege('anon','public.dbmt_label_order_for_output_lot(jsonb,jsonb)','execute')").fetchone()[0]

    def label(lot, weight, inner=False):
        return dict(id=prefix+uuid.uuid4().hex, code=('IN' if inner else 'DB')+'2610291200-'+uuid.uuid4().hex[:6].upper(), workOrderId=order['id'], product=order['product'], lot=lot, labelWeight=weight, inputWeight=180, status='active', reprintCount=0, weightOmitted=weight==0, printedAt='2026-10-29T03:00:00Z', workOrderSnapshot=dict(order, lot=lot, weight=weight), **({'packageKind':'inner'} if inner else {}))
    outer = [label('LOT-0', 40), label('LOT-1', 30), label('LOT-1', 30), label('LOT-2', 10)]
    assert rpc('dbmt_label_print_save_logs', pin, outer)['ok']
    reject(lambda: rpc('dbmt_label_print_save_logs', pin, [label('LOT-3', 1)]), '선택한 이력번호')
    stale = label('LOT-0', 1); stale['workOrderSnapshot']['outputLots']=['LOT-0']
    reject(lambda: rpc('dbmt_label_print_save_logs', pin, [stale]), '설정이 변경')
    reject(lambda: rpc('dbmt_label_print_save_logs', pin, [label('LOT-0', 1, True)]), '내포장')
    inner = [label('LOT-0', 1, True), label('LOT-0', 1.35, True), label('LOT-1', 0, True), label('LOT-2', 2, True)]
    data = rpc('dbmt_label_save_inner_prints', pin, inner)
    totals = lambda d: {r['lot']:(r['count'],float(r['weight'])) for r in d['totals']}
    assert totals(data) == {'LOT-0':(2,2.35),'LOT-1':(1,0),'LOT-2':(1,2)}
    assert totals(rpc('dbmt_label_save_inner_prints', pin, inner)) == totals(data), 'Same-ID retry must not duplicate'
    printed = dict(inner[0], reprintCount=1, lastReprintedAt='2026-10-29T04:00:00Z')
    assert totals(rpc('dbmt_label_save_inner_prints', pin, [printed])) == totals(data)
    reject(lambda: rpc('dbmt_label_save_inner_prints', pin, [dict(printed,lot='LOT-1')]), '변경할 수 없습니다')
    deleted = dict(inner[1], status='void', voidedAt='2026-10-29T04:00:00Z')
    assert totals(rpc('dbmt_label_save_inner_prints', pin, [deleted]))['LOT-0'] == (1,1)
    assert totals(rpc('dbmt_label_save_inner_prints', pin, [inner[1]]))['LOT-0'] == (1,1), 'Retry must not resurrect void'
    page = rpc('dbmt_label_inner_prints', pin, order['id'], None, 'LOT-0', 1)
    assert len(page['logs'])==1 and page['nextBeforeId']
    page2 = rpc('dbmt_label_inner_prints', pin, order['id'], page['nextBeforeId'], 'LOT-0', 1)
    assert len(page2['logs'])==1 and page['logs'][0]['id']!=page2['logs'][0]['id'] and not page2['nextBeforeId']
    assert conn.execute("select jsonb_array_length(payload) from public.app_data where key='labelPrintLogs'").fetchone()[0]==4
    original = conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    done = rpc('dbmt_label_complete_production', pin, order['id'], [l['id'] for l in outer])
    entry = conn.execute('select raw from public.production_entries where id=%s', (done['productionId'],)).fetchone()[0]
    assert sum(r['qty'] for r in entry['inputs'])==180 and len(entry['inputs'])==4, 'No raw usage recalculation'
    outputs = {r['lot']:r for r in entry['outputs']}
    assert {k:(v['qty'],v['boxCount']) for k,v in outputs.items()}=={'LOT-0':(40,1),'LOT-1':(60,2),'LOT-2':(10,1)}
    for log in outer:
        item=rpc('dbmt_pda_lookup', token, log['code'])['item']
        assert item['lot']==log['lot'] and item['stockRowId']==outputs[log['lot']]['stockRowId']
    assert conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]==original
    assert rpc('dbmt_label_complete_production', pin, order['id'], [l['id'] for l in outer])['alreadyCompleted']
    # Selection on a different day is limited to raw LOTs actually carried over.
    carry_order = dict(order, id=prefix+'_carry')
    assert write(carry_order)['ok']
    context = rpc('dbmt_erp_get_work_order_carryover', token, carry_order['id'])
    result = rpc('dbmt_erp_carry_work_order', token, carry_order['id'], '2026-10-30', [dict(index=1,qty=20,boxCount=2)], context['stateVersion'], uuid.uuid4())
    rows = rpc('dbmt_erp_get_work_orders', token, None)['rows']
    child = next(r for r in rows if r.get('_carryoverFrom',{}).get('id')==carry_order['id'])
    assert child['outputLots']==['LOT-1'] and child['lot']=='LOT-1'
    fallback_order=dict(order,id=prefix+'_carry_unselected')
    assert write(fallback_order)['ok']
    context=rpc('dbmt_erp_get_work_order_carryover',token,fallback_order['id'])
    rpc('dbmt_erp_carry_work_order',token,fallback_order['id'],'2026-10-30',[dict(index=3,qty=5,boxCount=1)],context['stateVersion'],uuid.uuid4())
    child=next(r for r in rpc('dbmt_erp_get_work_orders',token,None)['rows'] if r.get('_carryoverFrom',{}).get('id')==fallback_order['id'])
    assert child['outputLots']==['LOT-3'] and child['defaultOutputLot']=='LOT-3'
    # An already printed legacy barcode keeps its LOT when this order opts in.
    legacy={k:v for k,v in order.items() if k not in ['outputLotSelectionVersion','outputLots','defaultOutputLot']}
    legacy.update(id=prefix+'_legacy',lot='OLD-PRINTED')
    state=write(legacy)
    old_label=label('OLD-PRINTED',10)
    old_label.update(workOrderId=legacy['id'],workOrderSnapshot=dict(legacy,weight=10))
    assert rpc('dbmt_label_print_save_logs',pin,[old_label])['ok']
    upgraded=dict(legacy,outputLotSelectionVersion=1,outputLots=['LOT-0','LOT-1'],defaultOutputLot='LOT-0',lot='LOT-0')
    assert write(upgraded,state['versions'][legacy['id']])['ok']
    new_label=label('LOT-1',20)
    new_label.update(workOrderId=legacy['id'],workOrderSnapshot=dict(upgraded,lot='LOT-1',weight=20))
    assert rpc('dbmt_label_print_save_logs',pin,[new_label])['ok']
    done=rpc('dbmt_label_complete_production',pin,legacy['id'],[old_label['id'],new_label['id']])
    output_rows=conn.execute('select raw from public.production_entries where id=%s',(done['productionId'],)).fetchone()[0]['outputs']
    assert {r['lot']:r['qty'] for r in output_rows}=={'OLD-PRINTED':10,'LOT-1':20}
    assert rpc('dbmt_pda_lookup',token,old_label['code'])['item']['lot']=='OLD-PRINTED'
    return prefix


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER','')+os.environ.get('PGHOST',''):
        raise RuntimeError('Wrong project')
    root=Path(__file__).resolve().parent.parent
    sql=(root/'supabase/schema-rpc-71-work-order-output-lots.sql').read_text(encoding='utf-8-sig')
    migration,=(root/'supabase/migrations').glob('*_work_order_output_lots.sql')
    assert sql==migration.read_text(encoding='utf-8-sig')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_output_lots_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='2s'")
            conn.execute("set local statement_timeout='5s'")
            if '--installed' not in sys.argv:
                conn.execute(sql)
            prefix=tests(conn)
            for name in ['check-label-input-review-db','check-work-order-row-sync-db','check-work-order-carryover-db']:
                spec=importlib.util.spec_from_file_location(name,root/'tools'/(name+'.py'))
                module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                module.tests(conn)
        if conn.execute("select to_regclass('label_print_private.inner_print_logs')").fetchone()[0]:
            assert not conn.execute('select 1 from label_print_private.inner_print_logs where id like %s',(prefix+'%',)).fetchone()
    print(json.dumps(dict(ok=True,installed='--installed' in sys.argv,fixturesRolledBack=True,tests='LOT validation; inner fixed/scale/omitted counts, retry/reprint/void/pagination/PIN; outer isolation; LOT-specific journal/boxes/PDA barcode mapping; carry selection; existing row sync/carryover/input review regressions'),ensure_ascii=False))


if __name__=='__main__':
    main()
