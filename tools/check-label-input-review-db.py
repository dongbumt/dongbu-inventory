"""Real RPC regression with fictional records; schema trials and fixtures always roll back."""
import copy
import json
import os
import sys
import uuid
from pathlib import Path
from decimal import Decimal

import psycopg
from psycopg.types.json import Jsonb


def tests(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda kind: 'qa_input_review_' + suffix + '_' + kind
    pin = '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    sources = [dict(sourceStock=dict(key=uid('source' + str(i)), product=uid('raw' + str(i)), lot='QA-LOT-' + str(i),
                    origin='미국산', price=4980 + i * 10, stock=qty, stockLocation='가공장'), inputWeight=qty,
                    **({} if boxes is None else dict(boxCount=boxes)))
               for i, (qty, boxes) in enumerate([(870.01, 48), (1.54, None), (4.43, 1), (5, 1), (7.66, 10), (20, None), (5, None)])]
    old = dict(id=uid('order'), date='2026-10-23', title='QA input review', product=uid('product'),
               labelProductId=uid('master'), inputWeight=875.98, weight=10, lot='QA-PRINTED-LOT', origin='미국산', packunit='5KG',
               mfgdate='2026-10-23', expdate='2027-10-22', sourceStock=sources[0]['sourceStock'], sourceInputs=sources[:3])
    current = dict(old, inputWeight=913.64, sourceInputs=sources)
    products = [dict(id=old['labelProductId'], name=old['product'], packunit='5KG', origin='미국산')]
    for key, value in [('workOrders', [old]), ('labelProducts', products), ('labelPrintLogs', [])]:
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload', (key, Jsonb(value)))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                  tuple(Jsonb(a) if isinstance(a, (dict, list)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(call, message):
        try:
            with conn.transaction():
                call()
        except psycopg.Error as error:
            assert message in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + message)

    def work_order(order):
        conn.execute("update public.app_data set payload=%s where key='workOrders'", (Jsonb([order]),))

    logs = []
    for i in range(80):
        snap = old if i < 37 else current
        weight = (13 if i < 36 else 22) if i < 37 else (10 if i < 79 else 8.06)
        logs.append(dict(id=uid('label' + str(i)), code='DB2610231200-' + suffix[:4].upper() + str(i).zfill(2), workOrderId=old['id'],
                         product=old['product'], labelWeight=weight, status='active', reprintCount=0,
                         printedAt='2026-10-23T03:00:00Z', workOrderSnapshot=dict(snap, weight=weight)))
    assert rpc('dbmt_label_print_save_logs', pin, logs[:37])['ok']
    work_order(current)
    assert rpc('dbmt_label_print_save_logs', pin, logs[37:])['ok']
    ids = [r['id'] for r in logs]
    original_logs = conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    complete = lambda expected=current, log_ids=ids, auth=pin: rpc('dbmt_label_complete_production_reviewed', auth, old['id'], log_ids, expected)
    reject(lambda: complete(auth='bad'), 'PIN')
    reject(lambda: rpc('dbmt_label_complete_production', pin, old['id'], ids), '투입정보')
    reject(lambda: complete(old), '다시 변경')
    reject(lambda: complete(dict(current, inputWeight=1)), '다시 변경')
    reject(lambda: complete(log_ids=ids[:-1]), '출력이력')
    work_order(dict(current, date='2026-10-24'))
    reject(lambda: complete(dict(current, date='2026-10-24')), '작업일')
    work_order(current)
    broken = copy.deepcopy(current)
    broken['sourceInputs'][0]['inputWeight'] = 870
    work_order(broken)
    reject(lambda: complete(broken), '합계')
    broken = copy.deepcopy(current)
    broken['sourceInputs'][1]['sourceStock'] = broken['sourceInputs'][0]['sourceStock']
    work_order(broken)
    reject(lambda: complete(broken), '중복')
    work_order(current)
    assert not conn.execute('select 1 from public.label_production_completions where work_order_id=%s', (old['id'],)).fetchone()
    done = complete()
    pid = done['productionId']
    entry = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    assert len(entry['inputs']) == 7 and sum(r['qty'] for r in entry['inputs']) == 913.64
    assert [r.get('boxCount') for r in entry['inputs']] == [48, None, 1, 1, 10, None, None]
    assert len(entry['outputs']) == 1
    output = entry['outputs'][0]
    assert output['qty'] == 918.06 and output['boxCount'] == 80 and output['lot'] == old['lot']
    assert output['stockRowId']
    assert entry['_labelCompletion']['inputConfirmation']['workOrder'] == current
    assert len(entry['_labelCompletion']['inputConfirmation']['printedInputVersions']) == 2
    assert conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0] == original_logs
    assert conn.execute('select baseline from public.label_production_completions where production_id=%s', (pid,)).fetchone()[0] == entry
    assert conn.execute("select sum(weight) from public.transactions where prod_id=%s and type='생산입고' and deleted_at is null", (pid,)).fetchone()[0] == Decimal('918.06')
    count = conn.execute('select count(*) from public.transactions where prod_id=%s', (pid,)).fetchone()[0]
    assert complete()['productionId'] == pid and complete()['alreadyCompleted']
    assert conn.execute('select count(*) from public.transactions where prod_id=%s', (pid,)).fetchone()[0] == count

    # Existing barcode resolution must still reach the one produced stock row.
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Input review QA') returning id", (uid('role'),)).fetchone()[0]
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Input review QA','unused',%s) returning id", ('qa_review_' + suffix, role)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'pda',true,true,true,true)", (role,))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))
    for index in (0, 36, 37, 79):
        item = rpc('dbmt_pda_lookup', token, logs[index]['code'])['item']
        assert item['stockRowId'] == output['stockRowId'] and item['lot'] == old['lot']

    # Deleted-generation replay remains atomic, auditable and idempotent.
    assert rpc('dbmt_label_cancel_production', pin, old['id'], pid)['ok']
    reject(lambda: rpc('dbmt_label_resubmit_production_reviewed', pin, old['id'], ids, pid, old), '다시 변경')
    assert conn.execute('select production_id from public.label_production_completions where work_order_id=%s', (old['id'],)).fetchone()[0] == pid
    again = rpc('dbmt_label_resubmit_production_reviewed', pin, old['id'], ids, pid, current)
    assert again['productionId'] != pid
    assert rpc('dbmt_label_resubmit_production_reviewed', pin, old['id'], ids, pid, current)['productionId'] == again['productionId']
    assert conn.execute("select sum(public.dbmt_safe_numeric(raw->>'boxCount')) from public.transactions where prod_id=%s and type='생산입고' and deleted_at is null", (again['productionId'],)).fetchone()[0] == 80
    assert conn.execute("select has_function_privilege('anon','public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb)','execute')").fetchone()[0]
    assert not conn.execute("select exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.dbmt_label_complete_production_reviewed(text,text,jsonb,jsonb)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')").fetchone()[0]
    return uid('')


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    root = Path(__file__).resolve().parent.parent
    sql = (root / 'supabase/schema-rpc-67-label-completion-input-review.sql').read_text(encoding='utf-8-sig')
    migration, = (root / 'supabase/migrations').glob('*_label_completion_input_review.sql')
    assert sql == migration.read_text(encoding='utf-8-sig')
    installed = '--installed' in sys.argv
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_label_input_review_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='45s'")
            if not installed:
                conn.execute(sql)
            prefix = tests(conn)
            # Also exercise existing unmodified completion/cancel/box counting flows.
            conn.execute((root / 'tools/check-label-outer-box-counts-db.sql').read_text(encoding='utf-8-sig').replace('begin;', '', 1).rsplit('rollback;', 1)[0])
        assert not conn.execute("select 1 from public.production_entries where raw#>>'{_labelCompletion,workOrderId}' like %s", (prefix + '%',)).fetchone()
    print(json.dumps(dict(ok=True, installed=installed, fixturesRolledBack=True,
        tests='80 mixed-snapshot labels / 918.06KG / 7 sources / 913.64KG; input boxes; PIN/version/log/date/total/duplicate guards; immutable snapshots; barcode inventory mapping; single postings; cancel/resubmit generations; legacy completion/box counting'), ensure_ascii=False))


if __name__ == '__main__':
    main()
