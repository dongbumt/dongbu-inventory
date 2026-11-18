"""Batch-save performance and lifecycle regressions; every fixture/DDL trial rolls back."""
import ast
import copy
import json
import os
import sys
import time
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION, = (ROOT / 'supabase/migrations').glob('*_label_log_batch_save.sql')
SQL = MIGRATION.read_text(encoding='utf-8-sig')
SIGNATURE = 'public.dbmt_label_print_save_logs(text,jsonb)'
CORE = 'label_print_private.save_log_batch(text,jsonb,text)'


def module(filename):
    path = ROOT / 'tools' / filename
    tree = ast.parse(path.read_text(encoding='utf-8-sig'))
    body = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))]
    namespace = {'__file__': str(path)}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(path), 'exec'), namespace)
    return namespace


def rpc(conn, pin, logs, order_id=None):
    with conn.transaction():
        conn.execute("set local dbmt.personal_authorized='false'")
        conn.execute('set local role anon')
        if order_id is None:
            result = conn.execute('select public.dbmt_label_print_save_logs(%s,%s)', (pin, Jsonb(logs))).fetchone()[0]
        else:
            result = conn.execute('select public.dbmt_label_print_save_logs(%s,%s,%s)', (pin, Jsonb(logs), order_id)).fetchone()[0]
        conn.execute('set local role postgres')
        return result


def fixture(conn):
    prefix = 'qa_batch_' + uuid.uuid4().hex[:12]
    pin = '0927'
    conn.execute("update public.app_config set value=extensions.crypt(%s,extensions.gen_salt('bf')) where key='label_print_pin_hash'", (pin,))
    product = dict(id=prefix+'_product', name=prefix+'_product', kind='제품', storage='냉동', shelfdays=365,
                   productCode='200001', meattype='돼지고기', packunit='5KG', taxType='면세')
    sources = [dict(sourceStockKey=prefix+str(i), sourceStock=dict(key=prefix+str(i), product=prefix+'_raw',
        lot='QA-LOT', price=5300, stock=200, stockBoxes=10, stockLocation='가공장',
        origin='미국산', brand='QA brand', note='QA detailed source '+str(i)), inputWeight=190, boxCount=10) for i in range(6)]
    order = dict(id=prefix+'_order', date='2026-11-19', product=product['name'], labelProductId=product['id'],
        lot='QA-LOT', origin='미국산', grade='', inputWeight=1140, inputBoxCount=60,
        sourceStock=sources[0]['sourceStock'], sourceInputs=sources, weight=20,
        mfgdate='2026-11-19', expdate='2027-11-18', temptype='냉동')
    original = conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    for key, rows in [('workOrders', [order]), ('labelProducts', [product])]:
        conn.execute('update public.app_data set payload=payload||%s where key=%s', (Jsonb(rows), key))
    snapshot = conn.execute('select public.dbmt_label_selected_product_order(%s,%s)', (Jsonb(order), Jsonb(product))).fetchone()[0]

    def label(i):
        return dict(id=prefix+'_label_'+str(i), code='DB2611191200-'+format(i, '06X'),
            workOrderId=order['id'], product=product['name'], lot=order['lot'], labelWeight=20,
            inputWeight=1140, status='active', printedAt='2026-11-19T03:00:00Z', reprintCount=0,
            batchId=prefix+'_batch', workOrderSnapshot=dict(snapshot, weight=20))

    # Retain every operating label; use realistic source snapshots near the ledger's current cap.
    target = len(original) if '--profile' not in sys.argv else max(len(original), 4400)
    assert target <= 4500, 'Reserve room for the 500-label regression without deleting real history'
    filler = [dict(label(i+10000), status='void') for i in range(target-len(original))]
    if filler:
        conn.execute("update public.app_data set payload=payload||%s where key='labelPrintLogs'", (Jsonb(filler),))
    return pin, order, label, original, filler


def benchmark(conn, optimized):
    with conn.transaction(force_rollback=True):
        pin, order, label, original, filler = fixture(conn)
        base = original + filler
        profile = '--profile' in sys.argv
        sizes = [55] if profile else ([55, 500] if optimized else [55])
        timings = {}
        for count in sizes:
            with conn.transaction(force_rollback=True):
                # Match PostgREST's function-level timeout hoisting, not a role-wide override.
                conn.execute("set local statement_timeout='15s'" if optimized else "set local statement_timeout='3s'")
                if profile:
                    conn.execute("set local track_functions='all'")
                records = [label(i) for i in range(count)]
                start = time.perf_counter()
                try:
                    saved = rpc(conn, pin, records, order['id'])
                except psycopg.errors.QueryCanceled:
                    if optimized:
                        source = conn.execute('select prosrc from pg_proc where oid=%s::regprocedure', (CORE,)).fetchone()[0]
                        print('\n'.join(str(i)+': '+line for i, line in enumerate(source.splitlines(), 1) if 118 <= i <= 138), flush=True)
                        raise
                    timings[str(count)] = 'timeout at 3s'
                    continue
                timings[str(count)] = round((time.perf_counter()-start)*1000)
                print(json.dumps(dict(stage='save', count=count, ms=timings[str(count)])), flush=True)
                if profile:
                    print(conn.execute('select funcname,calls,round(total_time::numeric,1),round(self_time::numeric,1) from pg_stat_xact_user_functions order by total_time desc limit 12').fetchall(), flush=True)
                    continue
                assert saved['ok'] and saved['logs'] == records
                all_logs = conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
                assert all_logs == base + records, 'All original snapshots, codes, order and metadata remain byte-equivalent JSON'
                if optimized:
                    # Same-ID retry, legacy API, mixed updates/adds and permanent void behavior.
                    assert rpc(conn, pin, records, order['id'])['logs'] == records
                    changed = [dict(records[0], reprintCount=2, lastReprintedAt='2026-11-19T04:00:00Z'),
                               dict(records[-1], status='void', voidedAt='2026-11-19T04:00:00Z'), label(999)]
                    mixed = rpc(conn, pin, changed)
                    expected = copy.deepcopy(records)
                    expected[0] = changed[0]
                    expected[-1] = dict(records[-1], status='void', voidedAt='2026-11-19T04:00:00Z', voidReason=None)
                    assert mixed['logs'] == base + expected + [changed[-1]]
                    retry = rpc(conn, pin, records, order['id'])
                    assert retry['logs'] == expected + [changed[-1]], 'Stale retry cannot resurrect a void or lower reprint count'
                    malformed = dict(label(998), workOrderSnapshot=dict(records[0]['workOrderSnapshot'], product='tampered'))
                    before = conn.execute("select md5(payload::text) from public.app_data where key='labelPrintLogs'").fetchone()[0]
                    try:
                        with conn.transaction():
                            rpc(conn, pin, [label(997), malformed], order['id'])
                    except psycopg.Error as error:
                        assert '생산품목 또는 작업지시' in error.diag.message_primary
                    else:
                        raise AssertionError('A malformed row must reject the entire batch')
                    assert conn.execute("select md5(payload::text) from public.app_data where key='labelPrintLogs'").fetchone()[0] == before
        print(json.dumps(dict(optimized=optimized, historyRows=len(base), timingsMs=timings), ensure_ascii=False), flush=True)


def metadata(conn):
    return conn.execute("select prosecdef,array(select c from unnest(proconfig) c where split_part(c,'=',1)<>'statement_timeout'),proacl::text from pg_proc where oid=%s::regprocedure", (SIGNATURE,)).fetchone()


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', '') + os.environ.get('PGHOST', ''):
        raise RuntimeError('Wrong linked project')
    installed = '--installed' in sys.argv
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_label_batch_qa') as conn:
        conn.execute('set role postgres')
        conn.execute("set statement_timeout='30s'")
        conn.execute("set lock_timeout='2s'")
        if not installed and '--profile' not in sys.argv:
            benchmark(conn, False)
        with conn.transaction(force_rollback=True):
            before = metadata(conn)
            if not installed:
                conn.execute(SQL)
            assert metadata(conn) == before, 'Privileges, execution mode and search path must not change'
            definition = conn.execute('select pg_get_functiondef(%s::regprocedure)', (CORE,)).fetchone()[0]
            assert 'v_batch_log_indices' in definition
            for role in ['anon', 'authenticated']:
                assert not conn.execute('select has_function_privilege(%s,%s,\'execute\')', (role, CORE)).fetchone()[0]
            conn.execute(SQL)
            assert conn.execute('select pg_get_functiondef(%s::regprocedure)', (CORE,)).fetchone()[0] == definition
            if '--profile' in sys.argv:
                conn.add_notice_handler(lambda message: print(message.message_primary, flush=True))
                instrumented = definition.replace('declare\n', 'declare\n  qa_clock timestamptz := clock_timestamp();\n', 1)
                for stage, anchor in [
                    ('loaded', '  if exists(select 1 from jsonb_array_elements(p_logs)'),
                    ('indexed', '  for v_new in select * from jsonb_array_elements(p_logs) loop'),
                    ('validated', '  if cardinality(v_batch_updated)>0 then'),
                    ('assembled', '  if jsonb_array_length(v_logs)>5000 then'),
                    ('persisted', "  insert into public.change_logs(entity,action,summary,payload)"),
                    ('audited', '  if p_work_order_id is null then'),
                ]:
                    assert anchor in instrumented
                    instrumented = instrumented.replace(anchor, "  raise notice 'PROFILE "+stage+" %',extract(epoch from clock_timestamp()-qa_clock)*1000;\n"+anchor, 1)
                conn.execute(instrumented)
            benchmark(conn, True)
            if '--profile' in sys.argv:
                return
            # Run mature lifecycle suites without importing their executable entry points.
            for filename, entry in [
                ('check-label-log-reads-db.py', 'tests'),
                ('check-work-order-output-lots-db.py', 'tests'),
                ('check-pda-cost-db.py', 'check'),
                ('check-label-weight-db.py', 'check'),
                ('check-pda-product-cancellations-db.py', 'check'),
            ]:
                with conn.transaction(force_rollback=True):
                    module(filename)[entry](conn)
                    conn.execute('set constraints all immediate')
                print('PASS: '+filename, flush=True)
        assert not conn.execute("select 1 from public.app_data a cross join lateral jsonb_array_elements(a.payload) e where a.key='labelPrintLogs' and e->>'id' like 'qa_batch_%' limit 1").fetchone()
    print(json.dumps(dict(ok=True, installed=installed, allFixturesRolledBack=True,
        checks='old 3s timeout vs bounded 15s/55/500; immutable full history; legacy/scoped API; retry/reprint/void/mixed batch; atomic rejection; PIN/grants; LOT/production/PDA/provisional costs/returns/resplit/cancellation'), ensure_ascii=False))


if __name__ == '__main__':
    main()
