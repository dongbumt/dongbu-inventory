"""Verify outbound price saves with fictional data; every write and trial DDL rolls back."""
import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb


def checks(conn):
    suffix = uuid.uuid4().hex[:12]
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Outbound price QA') returning id", ('qa_price_' + suffix,)).fetchone()[0]
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Outbound price QA','unused',%s) returning id", ('qa_price_' + suffix, role)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'transactions',true,false,false,false),(%s,'prices',true,true,true,false)", (role, role))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))
    product = 'QA 제품 ' + suffix
    product2 = product + '(작업)'
    catalog = [{'name':product}, {'name':product2}]
    conn.execute("update public.app_data set payload=payload || %s where key='labelProducts'", (Jsonb(catalog),))
    original_txns = conn.execute("select count(*),max(updated_at) from public.transactions").fetchone()
    trader = 'QA 거래처 ' + suffix

    def row(price=8500, **kw):
        return dict(product=product, origin='국내산', trader=trader, price=price, **kw)

    def rpc(rows, expected=None, auth=token):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.dbmt_erp_save_outbound_prices(%s,%s,%s)', (auth, Jsonb(rows), Jsonb(expected or []))).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def denied(rows, expected=None, auth=token):
        try:
            rpc(rows, expected, auth)
        except psycopg.Error:
            return
        raise AssertionError('Unauthorized/invalid request accepted')

    created = rpc([row(), row()])
    assert created['ok'] and created['inserted'] == 1 and len(created['rows']) == 1
    saved = created['rows'][0]
    pid = saved['id']
    assert conn.execute('select price from public.prices where id=%s', (pid,)).fetchone()[0] == 8500
    logs = conn.execute("select count(*) from public.change_logs where entity_id=%s", (pid,)).fetchone()[0]
    variant = dict(row(), product=product.replace(' ', '  '), origin='국산', trader=trader.replace(' ', '  ').upper())
    repeat = rpc([variant])
    assert repeat['skipped'] == 1 and repeat['rows'][0]['id'] == pid and not repeat['changedRows']
    assert rpc([variant] * 500)['skipped'] == 1
    assert conn.execute("select exists(select 1 from pg_locks where pid=pg_backend_pid() and relation='public.prices'::regclass and mode='ShareRowExclusiveLock' and granted)").fetchone()[0], 'Price inserts/updates must serialize with the duplicate check'
    assert conn.execute("select count(*) from public.change_logs where entity_id=%s", (pid,)).fetchone()[0] == logs

    conflict = rpc([row(9000), dict(row(), product=product2)])
    assert conflict['confirmationRequired'] and len(conflict['conflicts']) == 1
    assert not conn.execute('select 1 from public.prices where product=%s', (product2,)).fetchone(), 'Confirmation stage must write nothing'
    conn.execute("update public.prices set raw=raw || '{\"custom\":\"preserved\"}'::jsonb where id=%s", (pid,))
    updated = rpc([row(9000), dict(row(), product=product2)], conflict['conflicts'])
    assert updated['updated'] == 1 and updated['inserted'] == 1
    assert next(p for p in updated['rows'] if p['id'] == pid)['custom'] == 'preserved'
    assert conn.execute('select count(*) from public.prices where product=%s and trader=%s and deleted_at is null', (product, trader)).fetchone()[0] == 1
    # Existing editor saves the same ID, and the outbound button sees the new value.
    editor = dict(saved, price=9300)
    with conn.transaction():
        conn.execute('set local role anon')
        conn.execute('select public.dbmt_erp_save_prices(%s,%s,%s)', (token, Jsonb([editor]), Jsonb([])))
        conn.execute('set local role postgres')
    assert rpc([row(9300)])['skipped'] == 1
    old = rpc([row(9500)])['conflicts']
    conn.execute('update public.prices set price=9400, updated_at=now()+interval \'1 second\' where id=%s', (pid,))
    assert rpc([row(9500)], old)['confirmationRequired'], 'Stale confirmation must not overwrite another PC'
    assert conn.execute('select price from public.prices where id=%s', (pid,)).fetchone()[0] == 9400

    other_origin = dict(row(), origin='미국산')
    other_trader = dict(row(), trader=trader + '2')
    assert rpc([other_origin, other_trader])['inserted'] == 2
    denied([row(), row(1)])
    for bad in [dict(row(), price=0), dict(row(), price=-1), dict(row(), price='9000'), dict(row(), trader='  '), dict(row(), product='unregistered'), {}, None]:
        denied([bad])
    denied([])
    denied({})
    denied([row()] * 501)
    denied([row()], auth='invalid-token')

    conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='prices'", (role,))
    denied([dict(row(), trader=trader + 'new')])
    conn.execute("update public.erp_role_permissions set can_create=true,can_update=false where role_id=%s and menu_code='prices'", (role,))
    denied([row(9800)])
    assert rpc([row(9400)])['skipped'] == 1
    conn.execute("update public.erp_role_permissions set can_create=false where role_id=%s and menu_code='prices'", (role,))
    denied([row(9400)])
    conn.execute("update public.erp_role_permissions set can_create=true,can_update=true where role_id=%s and menu_code='prices'", (role,))
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='transactions'", (role,))
    denied([row()])
    conn.execute("update public.erp_role_permissions set can_view=true where role_id=%s and menu_code='transactions'", (role,))
    conn.execute('update public.erp_user_sessions set expires_at=now()-interval \'1 minute\' where user_id=%s', (user,))
    denied([row()])
    conn.execute('update public.erp_user_sessions set expires_at=now()+interval \'1 minute\' where user_id=%s', (user,))
    conn.execute("insert into public.prices(id,product,origin,trader,price,raw) values(%s,%s,'국내산',%s,1,'{}')", ('qa_dup_' + suffix, product, trader))
    denied([row()])
    assert conn.execute("select count(*),max(updated_at) from public.transactions").fetchone() == original_txns
    assert not conn.execute("select has_table_privilege('anon','public.prices','insert') or has_function_privilege('anon','public.dbmt_price_identity_key(text,text,text)','execute')").fetchone()[0]


def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER', '')
    root = Path(__file__).resolve().parent.parent
    sql = (root / 'supabase/schema-rpc-70-outbound-price-table-save.sql').read_text(encoding='utf-8-sig')
    migration, = (root / 'supabase/migrations').glob('*_outbound_price_table_save.sql')
    assert sql == migration.read_text(encoding='utf-8-sig')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_outbound_price_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='2s'")
            conn.execute("set local statement_timeout='3s'")
            if '--installed' not in sys.argv:
                conn.execute(sql)
            checks(conn)
    print(json.dumps(dict(ok=True, allChangesRolledBack=True, tests='create/repeat/normalized keys; batch all-or-none confirmation; stale version; existing editor; custom fields; origins/traders; invalid input; privileges/expired login; existing duplicate guard; unchanged transactions'), ensure_ascii=False))


if __name__ == '__main__':
    main()
