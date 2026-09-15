"""Cancellation QA uses fictional records and always rolls them back.
--apply commits only additive DDL after all tests pass; never live cancellations.
"""
import json
import os
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda name: 'qa_cancel_' + suffix + '_' + name
    pin = '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    order = dict(id=uid('order'), date='2026-09-15', title='QA cancel', product='QA output', labelProductId=uid('product'),
                 inputWeight=100, weight=5, lot='QA-LOT', origin='국내산', mfgdate='2026-09-15',
                 sourceStock=dict(key=uid('stock'), product='QA raw', lot='QA-RAW', origin='국내산', packunit='벌크',
                                  proddate='2026-09-01', stockLocation='가공장', price=5000, stock=100))
    product = dict(id=uid('product'), name='QA output', packunit='5KG', taxType='면세')
    for key, value in [('workOrders', [order]), ('labelProducts', [product]), ('labelPrintLogs', [])]:
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload', (key, Jsonb(value)))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            value = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                 tuple(Jsonb(a) if isinstance(a, (list, dict)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    def reject(fn, fragment):
        try:
            fn()
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    def make_log(name, weight=5):
        return dict(id=uid(name), workOrderId=order['id'], product=order['product'], labelWeight=weight,
                    status='active', reprintCount=0, workOrderSnapshot={**order, 'weight': weight})

    a, b = make_log('a'), make_log('b', 7.5)
    save = lambda logs: rpc('dbmt_label_print_save_logs', pin, logs)
    save([a, b])
    pid = rpc('dbmt_label_complete_production', pin, order['id'], [a['id'], b['id']])['productionId']
    cancel = lambda production=pid, work=order['id']: rpc('dbmt_label_cancel_production', pin, work, production)
    entry = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    stock = entry['outputs'][0]['stockRowId']
    reject(lambda: rpc('dbmt_label_cancel_production', 'wrong', order['id'], pid), 'PIN')
    reject(lambda: cancel(work=uid('wrong')), '전송 상태')
    reject(lambda: cancel(production=uid('wrong')), '전송 상태')
    reject(lambda: cancel(work=''), '확인')
    other = uid('other')
    conn.execute('insert into public.production_entries(id,raw) values(%s,%s)', (other, Jsonb(dict(id=other, outputs=[]))))
    reject(lambda: cancel(production=other), '전송 상태')
    assert not rpc('dbmt_erp_save_production', pin, None, [], other)['ok'], 'Label PIN is not a general ERP session'

    def add_usage(production, name, quantity=3):
        conn.execute('insert into public.submaterial_usages(id,production_id,lot_id,qty,raw) values(%s,%s,%s,%s,%s)',
                     (uid(name), production, uid('lot'), quantity, Jsonb(dict(id=uid(name), productionId=production, qty=quantity))))

    add_usage(pid, 'usage')
    add_usage(other, 'other_usage')
    saved_logs = conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    # Existing dependent stock rules must still run before any deletion.
    for kind in ['출고', '사용', '재고이동', '재고조정']:
        with conn.transaction(force_rollback=True):
            conn.execute('insert into public.transactions(id,type,weight,raw) values(%s,%s,1,%s)',
                         (uid('dependent'), kind, Jsonb(dict(stockRowId=stock))))
            reject(cancel, '연결')
            assert conn.execute('select deleted_at from public.production_entries where id=%s', (pid,)).fetchone()[0] is None
            assert conn.execute('select deleted_at from public.submaterial_usages where id=%s', (uid('usage'),)).fetchone()[0] is None
    with conn.transaction(force_rollback=True):
        reserved = dict(order, id=uid('reserved'), sourceStock=dict(stockRowId=stock))
        conn.execute("update public.app_data set payload=payload || %s where key='workOrders'", (Jsonb([reserved]),))
        reject(cancel, '연결')
    # A failure after all updates must roll back the entire cancellation.
    with conn.transaction(force_rollback=True):
        conn.execute("""create function public.qa_cancel_audit_fail() returns trigger language plpgsql as $$
        begin if new.action='라벨 전송 취소' then raise exception 'QA audit failure'; end if; return new; end $$;
        create trigger qa_cancel_audit_fail before insert on public.change_logs for each row execute function public.qa_cancel_audit_fail();""")
        reject(cancel, 'QA audit failure')
        assert conn.execute('select deleted_at from public.production_entries where id=%s', (pid,)).fetchone()[0] is None
        assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null', (pid,)).fetchone()[0] == 2
        assert conn.execute('select deleted_at from public.submaterial_usages where id=%s', (uid('usage'),)).fetchone()[0] is None
    # Current journal (including office additions) is deleted, not only baseline rows.
    conn.execute("update public.production_entries set raw=raw || '{\"note\":\"QA office edit\"}'::jsonb where id=%s", (pid,))
    conn.execute('insert into public.transactions(id,prod_id,type,weight,raw) values(%s,%s,%s,3,%s)',
                 (uid('extra'), pid, '사용', Jsonb(dict(_prodId=pid))))
    add_usage(pid, 'extra_usage', 2)
    result = cancel()
    assert result['ok'] and result['deletedTransactions'] == 3 and result['deletedUsages'] == 2
    assert next(c for c in result['completions'] if c['workOrderId'] == order['id'])['deleted']
    assert conn.execute('select deleted_at from public.production_entries where id=%s', (pid,)).fetchone()[0] is not None
    assert conn.execute('select count(*) from public.transactions where prod_id=%s and deleted_at is null', (pid,)).fetchone()[0] == 0
    assert conn.execute('select count(*) from public.submaterial_usages where production_id=%s and deleted_at is null', (pid,)).fetchone()[0] == 0
    assert conn.execute('select deleted_at from public.production_entries where id=%s', (other,)).fetchone()[0] is None
    assert conn.execute('select deleted_at from public.submaterial_usages where id=%s', (uid('other_usage'),)).fetchone()[0] is None
    assert conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0] == saved_logs
    assert cancel()['alreadyCancelled']
    assert conn.execute("select count(*) from public.change_logs where entity_id=%s and action='라벨 전송 취소'", (pid,)).fetchone()[0] == 1
    payload = conn.execute("select payload from public.change_logs where entity_id=%s and action='라벨 전송 취소'", (pid,)).fetchone()[0]
    assert payload['entry']['note'] == 'QA office edit' and payload['authMode'] == 'label_pin'
    # Stale office editor cannot restore a cancelled usage; legacy imports still work.
    def stale_usage():
        with conn.transaction():
            conn.execute('update public.submaterial_usages set deleted_at=null where id=%s', (uid('usage'),))
    reject(stale_usage, '전송 취소')
    add_usage(uid('unmigrated_legacy'), 'legacy_usage')
    # Corrections preserve snapshots and are posted exactly once as a successor.
    save([{**a, 'status': 'void', 'voidReason': 'QA wrong label'}, b, make_log('c', 9)])
    resubmit = lambda: rpc('dbmt_label_resubmit_production', pin, order['id'], [b['id'], uid('c')], pid)
    successor = resubmit()['productionId']
    assert successor != pid and resubmit()['productionId'] == successor
    assert float(conn.execute('select output_weight from public.production_entries where id=%s', (successor,)).fetchone()[0]) == 16.5
    reject(cancel, '전송 상태')
    assert conn.execute('select deleted_at from public.production_entries where id=%s', (successor,)).fetchone()[0] is None
    assert cancel(production=successor)['ok']
    assert not conn.execute("select has_function_privilege('anon','public.dbmt_submaterial_write_lock()','execute')").fetchone()[0]
    assert conn.execute("select has_function_privilege('anon','public.dbmt_label_cancel_production(text,text,text)','execute')").fetchone()[0]
    assert not conn.execute("select has_table_privilege('anon','public.production_entries','DELETE')").fetchone()[0]


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    sql = sys.stdin.buffer.read().decode('utf-8-sig')
    if 'create or replace function public.dbmt_label_cancel_production' not in sql:
        raise RuntimeError('Expected additive cancellation schema')
    apply = '--apply' in sys.argv
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_cancel_rollback_qa') as conn:
        with conn.transaction(force_rollback=not apply):
            conn.execute('set local lock_timeout=\'8s\'')
            conn.execute('set local statement_timeout=\'30s\'')
            conn.execute('set local role postgres')
            conn.execute(sql)
            with conn.transaction(force_rollback=True):
                fixture_tests(conn)
    print(json.dumps(dict(ok=True, schemaApplied=apply, fixturesRolledBack=True,
                         tests='PIN/scope, dependent stock/reservations, atomic rollback, all postings/usages, unrelated protection, preserved logs, idempotent retry, stale office usage, legacy usage, corrected resubmit, old-generation rejection, permissions')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        if isinstance(error, psycopg.Error):
            print('SQL context: ' + str(error.diag.context), file=sys.stderr)
        raise SystemExit(1)
