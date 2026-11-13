"""Real production regroup/PDA/cost integration; every fixture and DDL rolls back."""
import ast
import copy
import os
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261113071720_label_stock_split_pda_links.sql'


def module(filename):
    path = ROOT / 'tools' / filename
    tree = ast.parse(path.read_text(encoding='utf-8-sig'))
    ns = {'__file__': str(path)}
    nodes = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign, ast.AugAssign))]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), ns)
    return ns


def check(conn, completed):
    f = module('check-pda-product-cancellations-db.py')['fixture'](conn, completed=completed)
    rpc, token, logs, lookup = [f[k] for k in ['rpc', 'token', 'logs', 'lookup']]
    pid = f['complete']()['productionId']
    original = conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0]
    source = original['outputs'][0]['stockRowId']
    snapshots = conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0]
    inputs = conn.execute("select jsonb_agg(to_jsonb(t) order by id) from public.transactions t where prod_id=%s and type='사용'", (pid,)).fetchone()[0]

    def get(row=source):
        return rpc('dbmt_erp_get_label_split', token, pid, row)

    def split(indices, row=source, version=None, request=None):
        return rpc('dbmt_erp_split_label_stock', token, pid, row, [logs[i]['id'] for i in indices],
                   version or get(row)['version'], request or uuid.uuid4())

    initial = get()
    assert initial['canSplit'], initial['reason']
    assert all(l['pdaState'] == 'shipped' for l in initial['labels'])
    with conn.transaction(force_rollback=True):
        moved = split([0, 1])
        new_source = moved['splitStockRowId']
        assert lookup(0)['state'] == lookup(1)['state'] == 'shipped'
        assert lookup(0)['stockRowId'] == lookup(1)['stockRowId'] == new_source
        assert conn.execute("select pda_private.balance(%s,'가공장'),pda_private.balance(%s,'가공장')", (source, new_source)).fetchone() == (0, 0)
        assert f['cancel']([f['ids'][0]])['ok']
        assert lookup(0)['state'] == 'in_stock' and lookup(0)['stockRowId'] == new_source
        assert conn.execute("select pda_private.balance(%s,'가공장')", (new_source,)).fetchone()[0] == 5
        assert len(moved['linkedTransactions']) == 3
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='production'", (f['role'],))
        f['reject'](lambda: split([0], version=initial['version']), '권한')
    assert f['cancel']([f['ids'][0]])['ok']
    f['commit']('inbound', [1], location='물류창고')
    returned_source = lookup(1)['stockRowId']
    f['reject'](lambda: split([0], version=initial['version']), '변경')
    # A failed audit must also undo package revisions and every moved shipment link.
    with conn.transaction(force_rollback=True):
        conn.execute("create function label_stock_private.qa_fail_split() returns trigger language plpgsql as $$ begin if new.action='라벨 분할' then raise exception 'QA split audit failure';end if;return new;end $$")
        conn.execute('create trigger qa_fail_split before insert on public.change_logs for each row execute function label_stock_private.qa_fail_split()')
        before_pack = [lookup(i) for i in range(3)]
        f['reject'](lambda: split([0, 1]), 'QA split audit failure')
        assert [lookup(i) for i in range(3)] == before_pack
        assert conn.execute('select raw from public.production_entries where id=%s', (pid,)).fetchone()[0] == original
    loaded = get()
    request = uuid.uuid4()
    old_scan = f['scan'](0)
    sales = conn.execute("select id,price,amount,trader from public.transactions where raw->>'_pdaLabelId'=any(%s) and type='출고' order by id", ([l['id'] for l in logs],)).fetchall()
    result = split([0, 1], version=loaded['version'], request=request)
    target = result['splitStockRowId']
    assert result['ok'] and split([0, 1], version=loaded['version'], request=request)['alreadySaved']
    assert any(t.get('stockRowId') == returned_source for t in result['linkedTransactions'])
    assert lookup(0)['state'] == 'in_stock' and lookup(0)['stockRowId'] == target
    assert lookup(1)['state'] == 'in_stock' and lookup(1)['stockRowId'] == returned_source
    assert lookup(2)['state'] == 'shipped' and lookup(2)['stockRowId'] == source
    assert sorted((o['qty'], o['boxCount']) for o in result['entry']['outputs']) == [(5, 1), (10, 2)]
    assert sum(o['amount'] for o in result['entry']['outputs']) == sum(o['amount'] for o in original['outputs'])
    assert conn.execute("select pda_private.balance(%s,'가공장'),pda_private.balance(%s,'가공장'),pda_private.balance(%s,'물류창고')", (source, target, returned_source)).fetchone() == (0, 5, 5)
    f['reject'](lambda: rpc('dbmt_pda_commit', token, uuid.uuid4(), 'outbound', '가공장', f['partner'], '2026-11-11', [old_scan], 'QA'), '다른 작업자')
    assert conn.execute("select id,price,amount,trader from public.transactions where raw->>'_pdaLabelId'=any(%s) and type='출고' order by id", ([l['id'] for l in logs],)).fetchall() == sales
    assert conn.execute("select jsonb_agg(to_jsonb(t) order by id) from public.transactions t where prod_id=%s and type='사용'", (pid,)).fetchone()[0] == inputs
    assert conn.execute("select payload from public.app_data where key='labelPrintLogs'").fetchone()[0] == snapshots
    assert conn.execute('select count(*) from label_stock_private.pda_split_context').fetchone()[0] == 0

    # Cost edits retain the distinct new source, including sales that predate completion.
    edited = copy.deepcopy(result['entry'])
    edited['note'] = 'QA regrouped PDA shipment'
    for o in edited['outputs']:
        o['price'] = 6000 if o['stockRowId'] == target else 7000
        o['amount'] = o['qty'] * o['price']
    assert rpc('dbmt_erp_save_production', token, edited, [], pid)['ok']
    for i, expected in [(0, 6000), (1, 6000), (2, 7000)]:
        costs = conn.execute("select type,stock_unit_price,raw->>'stockRowId',raw->>'_productionCostSourceId' from public.transactions where deleted_at is null and raw->>'_pdaLabelId'=%s", (logs[i]['id'],)).fetchall()
        assert not costs or all(c[1] == expected for c in costs), (i, expected, costs)
    second = split([0], row=target)
    leaf = second['splitStockRowId']
    assert lookup(0)['stockRowId'] == leaf and lookup(1)['stockRowId'] == returned_source
    assert conn.execute("select original_stock_row_id from public.pda_packages where label_id=%s", (logs[1]['id'],)).fetchone()[0] == target
    # Office cancellation still restores the current group, not the historical pre-split source.
    new_sale = f['commit']('outbound', [0])
    assert f['cancel']([new_sale['items'][0]['transactionId']])['ok']
    assert lookup(0)['state'] == 'in_stock' and lookup(0)['stockRowId'] == leaf
    assert f['cancel']([f['ids'][2]])['ok'] and lookup(2)['stockRowId'] == source
    # A client cannot impersonate the private relocation capability.
    malformed = copy.deepcopy(second['entry'])
    malformed['outputs'][0]['qty'] += 1
    f['reject'](lambda: rpc('dbmt_erp_save_production', token, malformed, [], pid))
    for role in ['anon', 'authenticated']:
        assert not conn.execute("select has_table_privilege(%s,'label_stock_private.pda_split_context','SELECT,INSERT,UPDATE,DELETE')", (role,)).fetchone()[0]
        assert not conn.execute("select has_function_privilege(%s,'label_stock_private.save_pda_split(text,jsonb,text,text,text,jsonb)','execute')", (role,)).fetchone()[0]
    conn.execute('set constraints all immediate')
    print('PASS: ' + ('completed' if completed else 'provisional-before-completion') + ' shipment regroup, return source, partial/repeated grouping, audit rollback, versions/retries, final cost edits, cancellation, sales/inputs/labels unchanged and private capability')


def main():
    with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_pda_label_regroup_qa') as conn:
        try:
            conn.execute('set local role postgres')
            conn.execute("set local lock_timeout='6s'")
            conn.execute("set local statement_timeout='90s'")
            if os.environ.get('DBMT_LABEL_PDA_SPLIT_DEPLOYED') != '1':
                conn.execute(MIGRATION.read_text(encoding='utf-8-sig'))
            # The reported row is inspected only; never split or edit operating records.
            for row in conn.execute("select p.id,o->>'stockRowId' from public.production_entries p cross join lateral jsonb_array_elements(p.raw->'outputs') o where p.deleted_at is null and o->>'lot'='903024600808' and o->>'product'='목전지(작업)' and o->>'qty'='335.86'").fetchall():
                state = conn.execute('select label_stock_private.snapshot(%s,%s)', row).fetchone()[0]
                print('READ ONLY reported row: canSplit=' + str(state['canSplit']) + '; reason=' + state['reason'])
            for completed in [False, True]:
                with conn.transaction(force_rollback=True):
                    check(conn, completed)
            for filename in ['check-pda-cost-db.py', 'check-pda-product-cancellations-db.py', 'check-label-weight-db.py']:
                with conn.transaction(force_rollback=True):
                    module(filename)['check'](conn)
            with conn.transaction(force_rollback=True):
                module('check-label-stock-split-db.py')['fixture_tests'](conn, verify_lot_correction=True)
                print('PASS: ordinary/repeated production regroup, stock downstream guards, LOT correction, cancelled-generation retry and fractional/legacy box regressions')
        finally:
            conn.rollback()
            print('ROLLED BACK: all test schema, PIN, stock, production, PDA and user fixtures; operating data unchanged.')


if __name__ == '__main__':
    main()
