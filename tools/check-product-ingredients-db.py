"""Exercise the real product/label functions; schema trials and all fixtures roll back."""
import json
import os
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb


def fingerprints(conn):
    return conn.execute("select key,md5(payload::text) from public.app_data where key in ('labelProducts','workOrders','labelPrintLogs') order by key").fetchall()


def tests(conn):
    suffix = uuid.uuid4().hex[:12]
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Ingredient QA') returning id", ('qa_ing_' + suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'label_products',true,true,true,false)", (role,))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Ingredient QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", ('qa_ing_' + suffix, uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))

    def save(record, session=token):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.dbmt_erp_save_label_product(%s,%s)', (session, Jsonb(record))).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    record = dict(id='qa_ingredient_' + suffix, name='QA Ingredients ' + suffix, meattype='소고기', nationalPartCode='BF005', kind='제품', origin='미국산/국내산', shelfdays=365)
    assert save(record, 'invalid')['ok'] is False
    product = save(record)['product']
    assert product['ingredientDetails'] == ''
    code = product['productCode']
    details = '전각(미국산) 85%, 우지방(국내산) 15%'
    product = save(dict(product, ingredientDetails='  ' + details + '  '))['product']
    assert product['ingredientDetails'] == details and product['productCode'] == code
    assert product['origin'] == '미국산/국내산'
    old_client = dict(product)
    old_client.pop('ingredientDetails')
    assert save(old_client)['product']['ingredientDetails'] == details, 'Old clients preserve the stored detail'
    order = dict(date='2026-10-23', origin='미국산/국내산', lot='QA-LOT', inputWeight=100, ingredients='기존 작업 문구')
    def composed(p):
        return conn.execute('select public.dbmt_label_selected_product_order(%s,%s)', (Jsonb(order), Jsonb(p))).fetchone()[0]
    output = composed(product)
    assert output['ingredients'] == '소고기 100% (' + details + ')'
    assert output['origin'] == order['origin'] and output['lot'] == order['lot'] and output['inputWeight'] == 100
    assert composed(dict(product, ingredientDetails=''))['ingredients'] == '소고기 100%'
    assert composed(dict(product, meattype='돼지고기', ingredientDetails=' '))['ingredients'] == '돼지고기 100%'
    audit = conn.execute("select payload from public.change_logs where entity_id=%s order by id desc limit 1", (product['id'],)).fetchone()[0]
    assert audit['after']['ingredientDetails'] == details
    for invalid in [None, 1, False, {}, [], '가' * 41]:
        try:
            save(dict(product, ingredientDetails=invalid))
        except psycopg.Error as error:
            assert '원재료 및 함량' in error.diag.message_primary
        else:
            raise AssertionError('Invalid ingredient details accepted')
    conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='label_products'", (role,))
    assert save(dict(product, ingredientDetails=''))['ok'] is False
    conn.execute("update public.erp_role_permissions set can_update=true where role_id=%s and menu_code='label_products'", (role,))
    cleared = save(dict(product, ingredientDetails=''))['product']
    assert cleared['ingredientDetails'] == '' and cleared['productCode'] == code


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    root = Path(__file__).resolve().parent.parent
    sql = (root / 'supabase/schema-rpc-65-product-label-ingredients.sql').read_text(encoding='utf-8-sig')
    migrations = list((root / 'supabase/migrations').glob('*_product_label_ingredient_details.sql'))
    assert len(migrations) == 1
    migration = migrations[0].read_text(encoding='utf-8-sig')
    assert sql.replace('\r\n', '\n') == migration.replace('\r\n', '\n')
    installed = '--installed' in sys.argv
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_ingredient_qa') as conn:
        conn.execute('set role postgres')
        before = fingerprints(conn)
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='30s'")
            conn.execute('set local role postgres')
            if not installed:
                conn.execute(sql)
            tests(conn)
        assert fingerprints(conn) == before, 'Fixture verification must not change business data'
    print(json.dumps(dict(ok=True, installed=installed, fixturesRolledBack=True, tests='save/reload, legacy defaults, missing-field preservation, clear, type/length validation, exact SQL composition, origin/code preservation, audit and permissions')))


if __name__ == '__main__':
    main()
