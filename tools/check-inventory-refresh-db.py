"""Read-only ledger refresh API, permissions and no business writes; all fixtures roll back."""
import os
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261110233211_inventory_manual_refresh.sql'


with psycopg.connect('', sslmode='require', connect_timeout=20, application_name='dbmt_inventory_refresh_qa') as conn:
    try:
        conn.execute('set local role postgres')
        conn.execute("set local lock_timeout='5s'")
        conn.execute("set local statement_timeout='45s'")
        if os.environ.get('DBMT_INVENTORY_REFRESH_DEPLOYED') != '1':
            conn.execute(MIGRATION.read_text(encoding='utf-8-sig'))
        role, user = uuid.uuid4(), uuid.uuid4()
        suffix = uuid.uuid4().hex[:12]
        token = uuid.uuid4().hex + uuid.uuid4().hex
        conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Refresh QA')", (role, 'qa_refresh_' + suffix))
        conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Refresh QA','unused',%s)", (user, 'qa_refresh_' + suffix, role))
        for menu in ['transactions', 'stock', 'production']:
            conn.execute('insert into public.erp_role_permissions(role_id,menu_code,can_view) values(%s,%s,true)', (role, menu))
        conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '1 hour')", (token, user))
        txid, deleted, prodid = ('qa_refresh_' + name + suffix for name in ['tx_', 'deleted_', 'prod_'])
        for identifier, is_deleted in [(txid, False), (deleted, True)]:
            conn.execute("insert into public.transactions(id,date,type,product,weight,raw,deleted_at) values(%s,'2026-11-11','입고',%s,10,%s,case when %s then now() else null end)",
                         (identifier, 'QA refresh ' + suffix, Jsonb(dict(id='wrong-raw-id', product='QA refresh ' + suffix, weight=10)), is_deleted))
        conn.execute("insert into public.production_entries(id,work_date,raw) values(%s,'2026-11-11',%s)", (prodid, Jsonb(dict(id=prodid, outputs=[], inputs=[]))))

        def rpc(menu, auth=token):
            with conn.transaction():
                conn.execute('set local role anon')
                result = conn.execute('select public.dbmt_erp_get_inventory_snapshot(%s,%s)', (auth, menu)).fetchone()[0]
                conn.execute('set local role postgres')
                return result

        def reject(menu, auth=token):
            try:
                with conn.transaction():
                    rpc(menu, auth)
            except psycopg.Error:
                return
            raise AssertionError('Unauthorized request must fail')

        before = conn.execute('select count(*),sum(weight),sum(amount) from public.transactions').fetchone()
        for menu in ['transactions', 'stock']:
            result = rpc(menu)
            assert set(result) == {'ok', 'transactions', 'prod', 'loadedAt'}
            assert result['ok'] and any(row['id'] == txid for row in result['transactions'])
            assert not any(row['id'] == deleted for row in result['transactions'])
            assert any(row['id'] == prodid for row in result['prod'])
        assert conn.execute('select count(*),sum(weight),sum(amount) from public.transactions').fetchone() == before
        reject('employees')
        reject(None)
        reject('transactions', 'invalid-token')
        with conn.transaction(force_rollback=True):
            conn.execute('update public.erp_user_sessions set expires_at=now()-interval \'1 minute\' where user_id=%s', (user,))
            reject('transactions')
        for menu in ['transactions', 'stock']:
            with conn.transaction(force_rollback=True):
                conn.execute('update public.erp_role_permissions set can_view=false where role_id=%s and menu_code=%s', (role, menu))
                reject(menu)
                assert rpc('stock' if menu == 'transactions' else 'transactions')['ok']
        with conn.transaction(force_rollback=True):
            conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='production'", (role,))
            assert rpc('stock')['prod'] is None
        print('PASS: menu-scoped personal read permissions, invalid/expired requests rejected, active ledgers/canonical IDs only, production access, minimal response and unchanged business rows')
    finally:
        conn.rollback()
        print('All DDL and virtual fixtures rolled back.')
