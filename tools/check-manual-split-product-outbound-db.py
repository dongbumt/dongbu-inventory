"""Exercise ERP shipment of split labels with fictional stock. Always roll back."""
import os
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'supabase/migrations'
LOCATION = '가공장'


def check(conn):
    suffix = uuid.uuid4().hex[:12]
    role, user, partner = (uuid.uuid4() for _ in range(3))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    today, manufactured = conn.execute(
        "select (now() at time zone 'Asia/Seoul')::date, (now() at time zone 'Asia/Seoul')::date-1"
    ).fetchone()

    def uid(name):
        return 'qa_manual_split_' + suffix + '_' + name

    conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Manual split QA')", (role, uid('role')))
    conn.execute(
        "insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Manual split QA','unused',%s)",
        (user, 'qa_' + suffix, role),
    )
    for menu in ['pda', 'production', 'transactions', 'stock', 'label']:
        conn.execute(
            'insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)',
            (role, menu),
        )
    conn.execute(
        "insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')",
        (token, user),
    )
    conn.execute(
        "insert into public.business_partners(id,code,name,trade_type) values(%s,%s,%s,'매출')",
        (partner, 'QMS' + suffix.upper(), uid('partner')),
    )

    def rpc(name, *args):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute(
                'select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')',
                tuple(Jsonb(arg) if isinstance(arg, (dict, list)) else arg for arg in args),
            ).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(action, fragment=None):
        try:
            with conn.transaction():
                result = action()
        except psycopg.Error as error:
            if fragment:
                assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            assert isinstance(result, dict) and result.get('ok') is False, (fragment, result)
            if fragment:
                assert fragment in result.get('message', ''), result

    def retry(action):
        try:
            with conn.transaction():
                action()
        except psycopg.Error:
            # A stale retry can fail or return the existing batch. Neither can create another sale.
            pass

    source, production, work_order = uid('stock'), uid('production'), uid('work_order')
    snapshot = dict(product=uid('product'), labelProductId=uid('product_id'), lot=uid('lot'),
                    origin='미국산', packunit='5KG', grade='', mfgdate=manufactured.isoformat(), temptype='냉동')
    output = dict(product=snapshot['product'], labelProductId=snapshot['labelProductId'], lot=snapshot['lot'],
                  origin=snapshot['origin'], packunit=snapshot['packunit'], grade='', proddate=manufactured.isoformat(),
                  qty=50, boxCount=4, price=5000, amount=250000, stockRowId=source)
    entry = dict(id=production, date=manufactured.isoformat(), inputs=[], outputs=[output])
    conn.execute('insert into public.production_entries(id,work_date,raw) values(%s,%s,%s)', (production, manufactured, Jsonb(entry)))
    receipt = dict(output, id=uid('receipt'), type='생산입고', date=manufactured.isoformat(), stockLocation=LOCATION,
                   weight=50, stockUnitPrice=5000, _prodId=production, _isProdOut=True)
    conn.execute(
        """insert into public.transactions
           (id,date,type,product,lot,origin,packunit,proddate,weight,price,amount,stock_location,stock_unit_price,prod_id,is_prod_out,raw)
           values(%s,%s,'생산입고',%s,%s,%s,%s,%s,50,5000,250000,%s,5000,%s,true,%s)""",
        (receipt['id'], manufactured, snapshot['product'], snapshot['lot'], snapshot['origin'],
         snapshot['packunit'], manufactured, LOCATION, production, Jsonb(receipt)),
    )
    logs = []
    for index, weight in enumerate([10, 15, 15, 10]):
        logs.append(dict(id=uid('label_' + str(index)), code='DB' + manufactured.strftime('%y%m%d') + '1200-'
                         + ('A' + uuid.uuid4().hex[:5]).upper(), workOrderId=work_order,
                         labelWeight=weight, status='active', workOrderSnapshot=snapshot, sizeKey='7x10'))
    for log in logs:
        conn.execute(
            'insert into label_print_private.outer_print_logs(id,work_order_id,code,data) values(%s,%s,%s,%s)',
            (log['id'], log['workOrderId'], log['code'], Jsonb(log)),
        )
    conn.execute(
        'insert into public.label_production_completions(work_order_id,production_id,baseline,log_ids) values(%s,%s,%s,%s)',
        (work_order, production, Jsonb(entry), Jsonb([log['id'] for log in logs])),
    )
    split = rpc('dbmt_label_weight_split', None, token, uuid.uuid4(), logs[0]['code'], 0, LOCATION, [5, 5])
    assert split['ok']
    child_ids = [label['id'] for label in split['labels']]
    source_request = [dict(stockRowId=source, location=LOCATION)]

    def balance():
        return conn.execute('select pda_private.balance(%s,%s)', (source, LOCATION)).fetchone()[0]

    def state():
        return conn.execute(
            'select state,revision from public.pda_packages where label_id=any(%s) order by label_id',
            (child_ids,),
        ).fetchall()

    def live_sales():
        return conn.execute(
            """select id,weight,amount,(raw->>'boxCount')::integer as boxes,raw->>'_pdaLabelId' as label_id
               from public.transactions where deleted_at is null and type='출고' and raw->>'stockRowId'=%s
               order by weight,id""",
            (source,),
        ).fetchall()

    def row(name, weight, boxes, **changes):
        posting = dict(id=uid(name), date=today.isoformat(), type='출고', product=snapshot['product'],
                       origin=snapshot['origin'], lot=snapshot['lot'], packunit=snapshot['packunit'],
                       proddate=manufactured.isoformat(), weight=weight, boxCount=boxes, price=6700, amount=6700*weight,
                       stockRowId=source, stockLocation=LOCATION, stockUnitPrice=5000,
                       trader=uid('partner'), traderId=str(partner), note='QA ERP shipment', _isUser=True)
        return dict(posting, **changes)

    def save(rows, delete_ids=None, session=token):
        return rpc('dbmt_erp_save_transactions', session, rows, delete_ids or [])

    def details():
        result = rpc('dbmt_erp_get_manual_split_stock', token, source_request)
        assert result['ok']
        return next(r for r in result['rows'] if r['stockRowId'] == source and r['location'] == LOCATION)

    initial = details()
    assert (initial['quantity'], initial['heldWeight']) == (50, 10)
    assert sorted(p['weight'] for p in initial['packages']) == [5, 5]
    choices = [dict(barcode=p['barcode'], revision=p['revision']) for p in initial['packages']]
    initial_state = state()
    assert balance() == 50 and live_sales() == [] and [s[0] for s in initial_state] == ['in_stock', 'in_stock']

    # New ERP clients preselect both split barcodes for the reported 50 kg / 5 boxes.
    # An open older client still receives the guard error until it reloads.
    reject(lambda: save([row('legacy_full', 50, 5)]), 'PDA 추적 재고')
    full = row('full_sale', 50, 5, _manualSplitLabels=choices)
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_view=false,can_create=false where role_id=%s and menu_code='pda'", (role,))
        shipped = save([full])
        assert shipped['ok'] and len(shipped['splitShipments']) == 1
        assert len(shipped['splitShipments'][0]['rows']) == 3
        sales = live_sales()
        assert [(s[1],s[2],s[3]) for s in sales] == [(5,33500,1),(5,33500,1),(40,268000,3)]
        assert {s[4] for s in sales if s[4]} == set(child_ids)
        assert {s['id'] for s in shipped['splitShipments'][0]['rows']} == {s[0] for s in sales}
        assert balance() == 0 and [s[0] for s in state()] == ['shipped', 'shipped']
        assert conn.execute(
            "select count(*) from public.pda_package_events where label_id=any(%s) and action='ship' and transaction_id=any(%s)",
            (child_ids, [s[0] for s in sales]),
        ).fetchone()[0] == 2
        shipped_state = state()
        retry(lambda: save([full]))
        assert balance() == 0 and live_sales() == sales and state() == shipped_state
        # Delete the recorded rows through ERP and restore both split children.
        cancelled = save([], [s[0] for s in sales])
        assert cancelled['ok']
        assert balance() == 50 and live_sales() == [] and [s[0] for s in state()] == ['in_stock', 'in_stock']
        restored_state = state()
        retry(lambda: save([full]))
        assert balance() == 50 and live_sales() == [] and state() == restored_state

    # A partial shipment that reaches a registered child must identify it.
    reject(lambda: save([row('unidentified_partial', 45, 4)]))
    stale = dict(choices[0], revision=choices[0]['revision'] + 1)
    reject(lambda: save([row('stale_partial', 45, 4, _manualSplitLabels=[stale])]))
    reject(lambda: save([row('bad_partial', 45, 4, _manualSplitLabels=[choices[0], choices[0]])]))
    reject(lambda: save([row('wrong_location', 45, 4, stockLocation='물류창고', _manualSplitLabels=[choices[0]])]))
    reject(lambda: save([
        row('valid_first', 45, 4, _manualSplitLabels=[choices[0]]),
        row('invalid_second', 5, 1, _manualSplitLabels=[dict(choices[1], revision=choices[1]['revision']+1)]),
    ]))
    reject(lambda: save([full], session='invalid-session'))
    with conn.transaction(force_rollback=True):
        conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='transactions'", (role,))
        reject(lambda: save([full]))
        reject(lambda: rpc('dbmt_erp_get_manual_split_stock', token, source_request))
    assert balance() == 50 and state() == initial_state and live_sales() == []
    with conn.transaction(force_rollback=True):
        selected_only = row('one_split_box', 5, 1, _manualSplitLabels=[choices[0]])
        result = save([selected_only])
        assert result['ok'] and len(result['splitShipments'][0]['rows']) == 1
        sales = live_sales()
        assert len(sales) == 1 and sales[0][1:4] == (5, 33500, 1) and sales[0][4] in child_ids
        shipped_state = state()
        assert balance() == 45
        retry(lambda: save([selected_only]))
        assert live_sales() == sales and state() == shipped_state
        assert save([], [sales[0][0]])['ok'] and balance() == 50
        retry(lambda: save([selected_only]))
        assert live_sales() == [] and balance() == 50
    with conn.transaction(force_rollback=True):
        saved = save([row('explicit_partial', 45, 4, _manualSplitLabels=[choices[0]])])
        assert saved['ok']
        sales = live_sales()
        assert [(s[1], s[3]) for s in sales] == [(5, 1), (40, 3)]
        assert balance() == 5 and sorted(s[0] for s in state()) == ['in_stock', 'shipped']
        rejected = lambda: rpc('dbmt_pda_commit', token, uuid.uuid4(), 'outbound', LOCATION, partner, today, [choices[0]], 'QA PDA')
        reject(rejected)
        left = details()['packages']
        assert len(left) == 1 and left[0]['barcode'] == choices[1]['barcode']
        pdaship = rpc('dbmt_pda_commit', token, uuid.uuid4(), 'outbound', LOCATION, partner, today, [choices[1]], 'QA PDA')
        assert pdaship['shipped'] == 1 and balance() == 0

    # Ordinary PDA-registered boxes remain protected under the new ERP route.
    with conn.transaction(force_rollback=True):
        scan = dict(barcode=logs[1]['code'], revision=0)
        received = rpc('dbmt_pda_commit', token, uuid.uuid4(), 'inbound', LOCATION, None, today, [scan], 'QA ordinary PDA')
        assert received['received'] == 1 and balance() == 50
        reject(lambda: save([full]))
        assert live_sales() == [] and state() == initial_state
    with conn.transaction(force_rollback=True):
        ordinary = save([row('ordinary_remaining_share', 40, 3)])
        assert ordinary['ok']
        assert balance() == 10 and state() == initial_state
        assert len(live_sales()) == 1 and live_sales()[0][4] is None
    print('PASS: ERP full 50kg/5 boxes, exact sales totals, split labels and ledger, cancellation, selected partial shipment, stale/duplicate/location rejection, atomic batch, permissions and ordinary PDA isolation.')


def main():
    deployment = os.environ.get('DBMT_MANUAL_SPLIT_OUTBOUND_DEPLOYED') == '1'
    with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_manual_split_outbound_qa') as conn:
        try:
            conn.execute('set local role postgres')
            conn.execute("set local lock_timeout='5s'")
            conn.execute("set local statement_timeout='90s'")
            if not deployment:
                candidates = list(MIGRATIONS.glob('*_manual_split_product_outbound.sql'))
                assert len(candidates) == 1, candidates
                conn.execute(candidates[0].read_text(encoding='utf-8-sig'))
            check(conn)
        finally:
            conn.rollback()
            print('ROLLED BACK: QA schema, ledger postings, PDA events, packages and users.')


if __name__ == '__main__':
    main()
