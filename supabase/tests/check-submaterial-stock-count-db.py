"""Exercise DB40 with fictional rows; DDL and all fixture writes always roll back."""
import copy
import json
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda kind: 'qa_' + kind + '_' + suffix
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Submaterial count QA') returning id", (uid('role'),)).fetchone()[0]
    for menu in ['submaterials', 'production']:
        conn.execute('insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)', (role, menu))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Submaterial QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", (uid('user'), uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))
    today = datetime.now(timezone(timedelta(hours=9))).date()
    item = dict(id=uid('item'), code='QA001', name='같은 부자재', spec='동일 규격', unit='장', certRequired=True, certDate=today.isoformat())
    lots = [dict(id=uid('lot1'), itemId=item['id'], itemCode=item['code'], itemName=item['name'], itemSpec=item['spec'],
                 lot='QA-SAME-LOT', date=today.isoformat(), qty=100, unit='장'),
            dict(id=uid('lot2'), itemId=item['id'], itemCode=item['code'], itemName=item['name'], itemSpec=item['spec'],
                 lot='QA-SAME-LOT', date=today.isoformat(), qty=10, unit='장'),
            dict(id=uid('future'), itemId=item['id'], lot='QA-FUTURE', date=(today + timedelta(days=1)).isoformat(), qty=10)]
    legacy = dict(id=uid('legacy'), itemId=item['id'], itemCode=item['code'], itemName=item['name'], itemSpec=item['spec'],
                  date='2026-09-01', qty=200, unit='장', manager='기존 담당', note='과거 품목실사 원문', createdAt='2026-09-01T01:02:03.000Z')
    for key, value in [('subMaterialItems', [item]), ('subMaterialLots', lots), ('subMaterialCounts', [legacy])]:
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload', (key, Jsonb(value)))
    # Isolate existing usage rows from fixtures by unrelated generated lot IDs.
    usage = dict(id=uid('usage1'), productionId=uid('production'), workDate=today.isoformat(), itemId=item['id'], lotId=lots[0]['id'], qty=20)
    conn.execute('insert into public.submaterial_usages(id,production_id,work_date,item_id,lot_id,qty,raw) values(%s,%s,%s,%s,%s,%s,%s)',
                 (usage['id'], usage['productionId'], usage['workDate'], usage['itemId'], usage['lotId'], usage['qty'], Jsonb(usage)))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                  tuple(Jsonb(a) if isinstance(a, (list, dict)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(callback, fragment):
        try:
            callback()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001', '42501'), error.sqlstate
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    snapshot = lambda: rpc('dbmt_erp_get_submaterial_stock', token)
    save = lambda value: rpc('dbmt_erp_save_submaterial_count', token, value)
    delete = lambda count_id, revision=None: rpc('dbmt_erp_delete_submaterial_count', token, count_id, revision)
    stock = lambda lot_id=lots[0]['id']: conn.execute('select public.dbmt_submaterial_lot_stock(%s)', (lot_id,)).fetchone()[0]
    request = lambda name, qty, expected, **extra: dict(id=uid(name), lotId=lots[0]['id'], qty=qty, expectedSystemQty=expected, manager='실사 담당', note='LOT 실사', **extra)
    assert snapshot()['counts'] == [legacy]
    assert stock() == 80 and stock(lots[1]['id']) == 10
    assert rpc('dbmt_erp_get_submaterial_stock', 'invalid')['code'] == 'session_expired'
    conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='submaterials'", (role,))
    assert save(request('denied', 70, 80))['ok'] is False
    conn.execute("update public.erp_role_permissions set can_create=true where role_id=%s and menu_code='submaterials'", (role,))
    saved = save(request('first', 70, 80))
    count1 = saved['count']
    assert saved['ok'] and saved['currentQty'] == 70 and stock() == 70
    assert count1['systemQty'] == 80 and count1['adjustmentQty'] == -10
    assert count1['date'] == today.isoformat() and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', count1['createdAt'])
    assert saved['counts'][0] == legacy and saved['logEntry']['refId'] == count1['id']
    retried = save(request('first', 70, 80))
    assert retried['alreadySaved'] and len(retried['counts']) == 2 and 'logEntry' not in retried
    assert save(request('first', 71, 80))['code'] == 'count_id_conflict'
    stale = save(request('stale', 60, 80))
    assert stale['code'] == 'stock_conflict' and stale['currentQty'] == 70 and len(stale['counts']) == 2
    invalid = request('negative', -1, 70)
    reject(lambda: save(invalid), '0 이상')
    reject(lambda: save(request('precision', 1.0000001, 70)), '여섯')
    invalid = request('notnumber', 60, 70)
    invalid['qty'] = 'NaN'
    reject(lambda: save(invalid), '숫자')
    invalid = request('future_count', 10, 10)
    invalid['lotId'] = lots[2]['id']
    reject(lambda: save(invalid), '입고일')
    invalid['lotId'] = 'no_such_lot'
    assert save(invalid)['code'] == 'lot_not_found'

    usage2 = dict(usage, id=uid('usage2'), qty=10)
    assert rpc('dbmt_erp_save_submaterial_usages', token, [usage2], [])['ok']
    assert stock() == 60
    assert save(request('usage_stale', 50, 70))['currentQty'] == 60
    saved2 = save(request('second', 65, 60))
    count2 = saved2['count']
    assert saved2['ok'] and count2['adjustmentQty'] == 5 and stock(lots[1]['id']) == 10

    # A stale full array cannot erase either newer LOT count.
    changed_legacy = dict(legacy, itemName='품목명 갱신', itemCode='QA002', unit='장')
    merged = rpc('dbmt_erp_save_app_data', token, {'subMaterialCounts': [changed_legacy]})
    assert merged['ok'] and len(merged['counts']) == 3
    assert merged['counts'][0]['itemName'] == '품목명 갱신' and merged['counts'][0]['qty'] == 200
    assert {c['id'] for c in merged['counts']} == {legacy['id'], count1['id'], count2['id']}
    stale_empty = rpc('dbmt_erp_save_app_data', token, {'subMaterialCounts': []})
    assert len(stale_empty['counts']) == 3, 'Generic omission is not a delete operation'
    changed = copy.deepcopy(merged['counts'])
    changed[1]['adjustmentQty'] = -99
    reject(lambda: rpc('dbmt_erp_save_app_data', token, {'subMaterialCounts': changed}), '일반 저장')
    reject(lambda: rpc('dbmt_erp_save_app_data', token, {'subMaterialCounts': [dict(legacy, id=uid('forged'))]}), '실사 등록')
    changed = copy.deepcopy(merged['counts'])
    changed[1]['itemName'] = '품목명 갱신'
    changed[1]['systemQty'] = float(changed[1]['systemQty'])
    assert rpc('dbmt_erp_save_app_data', token, {'subMaterialCounts': changed})['ok']
    reject(lambda: rpc('dbmt_erp_save_app_data', token, {'subMaterialLots': lots[1:]}), '사용 또는 실사')
    changed_item = dict(item, certDate='2026-09-01', certRequired=False)
    assert rpc('dbmt_erp_save_app_data', token, {'subMaterialItems': [changed_item]})['ok']
    assert snapshot()['items'] == [changed_item]

    before_zero = snapshot()['countsRevision']
    zero = save(request('zero', 0, 65))
    assert zero['ok'] and stock() == 0
    late_usage = dict(usage, id=uid('late_usage'), qty=1)
    reject(lambda: rpc('dbmt_erp_save_submaterial_usages', token, [late_usage], []), '가용재고')
    assert not conn.execute('select 1 from public.submaterial_usages where id=%s', (late_usage['id'],)).fetchone()
    assert stock() == 0, 'Rejected late usage must roll back rows and inventory'
    conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='production'", (role,))
    assert rpc('dbmt_erp_save_submaterial_usages', token, [late_usage], [])['ok'] is False
    conn.execute("update public.erp_role_permissions set can_update=true where role_id=%s and menu_code='production'", (role,))
    conflict = delete(zero['count']['id'], before_zero)
    assert conflict['code'] == 'counts_conflict' and stock() == 0
    conn.execute("update public.erp_role_permissions set can_delete=false where role_id=%s and menu_code='submaterials'", (role,))
    assert delete(zero['count']['id'], zero['countsRevision'])['ok'] is False
    conn.execute("update public.erp_role_permissions set can_delete=true where role_id=%s and menu_code='submaterials'", (role,))
    deleted = delete(zero['count']['id'], snapshot()['countsRevision'])
    assert deleted['ok'] and deleted['currentQty'] == 65 and stock() == 65
    assert delete(zero['count']['id'], zero['countsRevision'])['alreadyDeleted']
    assert save(request('zero', 0, 65))['code'] == 'count_deleted', 'A delayed retry cannot resurrect deleted counts'
    assert delete(count2['id'], snapshot()['countsRevision'])['ok'] and stock() == 60
    raised = save(request('raised', 100, 60))
    assert raised['count']['adjustmentQty'] == 40
    usage3 = dict(usage, id=uid('usage3'), qty=80)
    assert rpc('dbmt_erp_save_submaterial_usages', token, [usage3], [])['ok']
    assert stock() == 20
    blocked = delete(raised['count']['id'], snapshot()['countsRevision'])
    assert blocked['code'] == 'count_in_use' and blocked['qtyAfterDelete'] == -20
    removed_legacy = delete(legacy['id'], snapshot()['countsRevision'])
    assert removed_legacy['ok'] and all(c['id'] != legacy['id'] for c in removed_legacy['counts'])
    assert stock() == 20 and stock(lots[1]['id']) == 10

    # Existing negative stock can be corrected or metadata-edited, never worsened.
    negative_usage = dict(usage, id=uid('old_negative'), lotId=lots[1]['id'], qty=25)
    conn.execute('insert into public.submaterial_usages(id,production_id,work_date,item_id,lot_id,qty,raw) values(%s,%s,%s,%s,%s,%s,%s)',
                 (negative_usage['id'], negative_usage['productionId'], negative_usage['workDate'], negative_usage['itemId'], negative_usage['lotId'], negative_usage['qty'], Jsonb(negative_usage)))
    assert stock(lots[1]['id']) == -15
    improved = dict(negative_usage, qty=20)
    assert rpc('dbmt_erp_save_submaterial_usages', token, [improved], [])['ok'] and stock(lots[1]['id']) == -10
    reject(lambda: rpc('dbmt_erp_save_submaterial_usages', token, [dict(improved, qty=21)], []), '가용재고')
    assert stock(lots[1]['id']) == -10
    assert rpc('dbmt_erp_save_submaterial_usages', token, [dict(improved, note='설명 정정')], [])['ok']
    assert rpc('dbmt_erp_save_submaterial_usages', token, [], [improved['id']])['ok'] and stock(lots[1]['id']) == 10
    reject(lambda: rpc('dbmt_erp_save_submaterial_usages', token, [dict(usage, id=uid('unknown_lot'), lotId='missing', qty=1)], []), '품목 연결')

    # The table triggers include production-driven usage deletion in the lock.
    triggers = conn.execute("select tgname from pg_trigger where tgname in ('trg_submaterial_usage_lock','trg_submaterial_app_data_lock')").fetchall()
    assert len(triggers) == 2
    for signature in ['dbmt_submaterial_lot_stock(text)', 'dbmt_submaterial_stock_snapshot()',
                      'dbmt_submaterial_count_log(text,text,jsonb)', 'dbmt_erp_save_app_data_before_submaterial_counts(text,jsonb)',
                      'dbmt_erp_save_submaterial_usages_before_stock_count(text,jsonb,jsonb)']:
        assert conn.execute("select has_function_privilege('anon',%s,'execute')", ('public.' + signature,)).fetchone()[0] is False
    return dict(counts=len(snapshot()['counts']), lot1Stock=float(stock()), lot2Stock=float(stock(lots[1]['id'])))


def main():
    if '--apply' in sys.argv:
        raise RuntimeError('This verifier never deploys schema or retains fixture data')
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    schema = sys.stdin.buffer.read().decode('utf-8-sig')
    assert 'dbmt_erp_save_submaterial_count' in schema, 'Expected DB40 schema'
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True,
                         application_name='dbmt_submaterial_count_rollback_qa') as conn:
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            conn.execute(schema)
            conn.execute(schema)  # Reinstalling must not wrap the wrapper or lose grants.
            result = fixture_tests(conn)
    print(json.dumps(dict(ok=True, schemaApplied=False, allChangesRolledBack=True, fictionalResult=result,
                         tests='idempotent install, permissions, current-stock compare, usage changes and late overdraw rollback, negative-stock improvement, exact LOT IDs, zero/precision, KST time, retry idempotency, ID collision and deleted retry, revision CAS, adjustment reversal, used-increase deletion guard, legacy preservation/deletion, stale generic merge, ledger tamper rejection, certificate fields, table locks and private helpers')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        if isinstance(error, psycopg.Error):
            print('SQL context: ' + str(error.diag.context), file=sys.stderr)
        raise SystemExit(1)
