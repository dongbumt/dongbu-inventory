"""Test the label-note migration with fictional records in a rollback, then optionally deploy it."""
import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb


ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / 'supabase/migrations/20260929090000_label_completion_note.sql'


def fixture_tests(conn, sql):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda name: 'qa_note_' + suffix + '_' + name
    pin = '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    source = dict(key=uid('stock'), product='QA raw', lot='QA-RAW', origin='국내산', packunit='벌크',
                  proddate='2026-09-01', stockLocation='가공장', price=5000, stock=100)
    orders = [dict(id=uid(kind), date='2026-09-29', title='QA ' + kind, product='QA output',
                   labelProductId=uid('product'), inputWeight=100, weight=5, lot='QA-LOT',
                   origin='국내산', mfgdate='2026-09-29', sourceStock=source)
              for kind in ('original', 'office', 'future')]
    product = dict(id=uid('product'), name='QA output', packunit='5KG', taxType='면세')
    for key, value in [('workOrders', orders), ('labelProducts', [product]), ('labelPrintLogs', [])]:
        conn.execute('insert into public.app_data(key,payload) values(%s,%s) on conflict(key) do update set payload=excluded.payload',
                     (key, Jsonb(value)))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                                  tuple(Jsonb(arg) if isinstance(arg, (list, dict)) else arg for arg in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    logs = []
    def complete(order):
        log = dict(id=uid('log_' + order['title'].split()[-1]), workOrderId=order['id'],
                   product=order['product'], labelWeight=5, status='active', reprintCount=0,
                   workOrderSnapshot={**order, 'weight': 5})
        logs.append(log)
        rpc('dbmt_label_print_save_logs', pin, logs)
        return rpc('dbmt_label_complete_production', pin, order['id'], [log['id']])['productionId']

    first, second = (complete(order) for order in orders[:2])
    old_note = orders[0]['title'] + ' / 라벨 생산완료'
    conn.execute("update public.production_entries set raw=jsonb_set(raw,'{note}',to_jsonb(%s::text)) where id=%s", (old_note, first))
    conn.execute("update public.label_production_completions set baseline=jsonb_set(baseline,'{note}',to_jsonb(%s::text)) where production_id=%s", (old_note, first))
    second_baseline = orders[1]['title'] + ' / 라벨 생산완료'
    conn.execute("update public.label_production_completions set baseline=jsonb_set(baseline,'{note}',to_jsonb(%s::text)) where production_id=%s", (second_baseline, second))
    conn.execute("update public.production_entries set raw=jsonb_set(raw,'{note}',to_jsonb('QA office edited'::text)) where id=%s", (second,))

    conn.execute(sql)
    get_note = lambda production: conn.execute("select raw->>'note' from public.production_entries where id=%s", (production,)).fetchone()[0]
    assert get_note(first) == orders[0]['title'], 'Remove only the generated suffix'
    assert get_note(second) == 'QA office edited', 'Keep user-edited notes'
    baseline = conn.execute("select baseline->>'note' from public.label_production_completions where production_id=%s", (first,)).fetchone()[0]
    assert baseline == old_note, 'Keep the original completion baseline for audit'
    assert conn.execute("select count(*) from public.change_logs where entity_id=%s and action='비고 자동문구 제거'", (first,)).fetchone()[0] == 1
    assert conn.execute("select count(*) from public.change_logs where entity_id=%s and action='비고 자동문구 제거'", (second,)).fetchone()[0] == 0
    definition = conn.execute("select pg_get_functiondef('public.dbmt_label_complete_production(text,text,jsonb)'::regprocedure)").fetchone()[0]
    assert "' / 라벨 생산완료'" not in definition
    assert 'dbmt_prepare_label_stock_rows' in definition, 'Keep current stock-row logic'
    future = complete(orders[2])
    assert get_note(future) == orders[2]['title'], 'New completions use the work-order title alone'
    conn.execute(sql)
    assert get_note(first) == orders[0]['title'], 'Migration can be re-run safely'


def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER', ''), 'Wrong linked project'
    sql = MIGRATION.read_text(encoding='utf-8')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True,
                         application_name='dbmt_label_completion_note_qa') as conn:
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            fixture_tests(conn, sql)
        if '--deploy' in sys.argv:
            with conn.transaction():
                conn.execute('set local role postgres')
                conn.execute("set local lock_timeout='10s'")
                conn.execute(sql)
            definition = conn.execute("select pg_get_functiondef('public.dbmt_label_complete_production(text,text,jsonb)'::regprocedure)").fetchone()[0]
            assert "' / 라벨 생산완료'" not in definition
    print(json.dumps(dict(ok=True, fixturesRolledBack=True, deployed='--deploy' in sys.argv,
                          tests='existing autogenerated note, office edit preservation, baseline audit, new completion, idempotence')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        raise SystemExit(1)
