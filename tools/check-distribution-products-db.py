"""Schema, user/session, role, catalog and audit fixtures always roll back."""
import os
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

ROOT=Path(__file__).resolve().parents[1]

def tests(conn):
    suffix=uuid.uuid4().hex[:12]
    role=conn.execute("insert into public.erp_roles(code,name) values(%s,'Distribution QA') returning id",('qa_dist_'+suffix,)).fetchone()[0]
    user=conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Distribution QA','unused',%s) returning id",('qa_dist_'+suffix,role)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'distribution_products',true,true,true,true)",(role,))
    token=uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '2 hours')",(token,user))
    def rpc(name,*args):
        with conn.transaction():
            conn.execute('set local role anon')
            result=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',args).fetchone()[0]
            conn.execute('set local role postgres')
            return result
    def reject(call,text):
        try:
            with conn.transaction():call()
        except psycopg.Error as error:
            assert text in str(error),str(error)
        else:raise AssertionError('Expected rejection: '+text)
    def save(record,product_id=None,revision=None):
        return rpc('dbmt_erp_save_distribution_product',token,product_id,Jsonb(record),revision)
    assert not rpc('dbmt_erp_get_distribution_products','invalid')['ok']
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_admin) values(%s,'access_control',true,true)",(role,))
    admin=rpc('dbmt_erp_admin_get',token)
    assert any(row['menuCode']=='distribution_products' for row in admin['catalog'])
    permissions=[{'menuCode':'distribution_products','canView':True,'canCreate':False,'canUpdate':True,'canDelete':False}]
    saved_role=rpc('dbmt_erp_admin_save_role',token,None,'qa_dist_ui_'+suffix,'Distribution UI QA','',True,Jsonb(permissions),None)
    assert saved_role['ok']
    assert conn.execute("select can_view and not can_create and can_update and not can_delete from public.erp_role_permissions where role_id=%s and menu_code='distribution_products'",(saved_role['id'],)).fetchone()[0]
    record={'name':'QA 동명 제품','itemno':'QA-DIST-'+suffix,'origin':'국내산','brand':'QA 브랜드','grade':'1등급','packunit':'5KG',
      'meattype':'소고기','ingredientDetails':'전각 85%, 지방 15%','storage':'냉동','shelfdays':365}
    product=save(record)['product'];assert product['revision']==1 and product['kind']=='제품'
    assert product['itemno']==record['itemno'] and product['ingredientDetails']==record['ingredientDetails']
    assert product in rpc('dbmt_erp_get_distribution_products',token)['products']
    other=save(dict(record,itemno='QA-SECOND-'+suffix))['product'];assert other['id']!=product['id']
    assert all(row['id']!=product['id'] for row in conn.execute("select payload from public.app_data where key='labelProducts'").fetchone()[0])
    changed=save(dict(record,itemno='QA-EDIT-'+suffix,shelfdays=730),product['id'],1)['product'];assert changed['revision']==2
    reject(lambda:save(record,product['id'],1),'다른 사용자')
    reject(lambda:save(dict(record,name='')),'제품명')
    reject(lambda:save(dict(record,shelfdays=0)),'소비기한')
    reject(lambda:save(dict(record,shelfdays=1.5)),'소비기한')
    reject(lambda:save(dict(record,name='x'*201)),'check constraint')
    mt=conn.execute("select p->>'itemno' from public.app_data a cross join lateral jsonb_array_elements(a.payload) p where a.key='labelProducts' and coalesce(p->>'itemno','')<>'' limit 1").fetchone()
    if mt:reject(lambda:save(dict(record,itemno=mt[0])),'동부엠티에 등록된')
    conn.execute("update public.erp_role_permissions set can_create=false,can_update=false,can_delete=false where role_id=%s",(role,))
    assert not save(record)['ok'];assert not save(record,product['id'],2)['ok']
    assert not rpc('dbmt_erp_delete_distribution_product',token,product['id'],2)['ok']
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s",(role,))
    assert not rpc('dbmt_erp_get_distribution_products',token)['ok']
    # Existing MT catalog rights must not imply distribution rights.
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'label_products',true,true,true,true)",(role,))
    assert not save(record)['ok'];assert not rpc('dbmt_erp_get_distribution_products',token)['ok']
    # A label operator can choose products without catalog-maintenance access.
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create) values(%s,'label',true,true)",(role,))
    assert changed in rpc('dbmt_erp_get_distribution_products',token)['products'];assert not save(record)['ok']
    conn.execute("update public.erp_role_permissions set can_view=true,can_delete=true where role_id=%s and menu_code='distribution_products'",(role,))
    reject(lambda:rpc('dbmt_erp_delete_distribution_product',token,product['id'],1),'다른 사용자')
    assert rpc('dbmt_erp_delete_distribution_product',token,product['id'],2)['ok']
    assert all(row['id']!=product['id'] for row in rpc('dbmt_erp_get_distribution_products',token)['products'])
    assert conn.execute('select deleted_at is not null from erp_distribution_private.products where id=%s',(product['id'],)).fetchone()[0]
    assert conn.execute("select count(*) from public.change_logs where entity='동부축산유통 품목' and entity_id=%s",(product['id'],)).fetchone()[0]==3
    assert conn.execute("select relrowsecurity from pg_class where oid='erp_distribution_private.products'::regclass").fetchone()[0]
    for role_name in ['anon','authenticated']:
        for action in ['select','insert','update','delete']:
            assert not conn.execute("select has_table_privilege(%s,'erp_distribution_private.products',%s)",(role_name,action)).fetchone()[0]
    assert conn.execute("select bool_and(not prosecdef) from pg_proc where proname in ('dbmt_erp_get_distribution_products','dbmt_erp_save_distribution_product','dbmt_erp_delete_distribution_product')").fetchone()[0]
    conn.execute('set constraints all immediate')
    assert conn.execute("select expires_at>now()+interval '23 hours' from public.erp_user_sessions where user_id=%s",(user,)).fetchone()[0]
    print('PASS: isolated CRUD, same names/different IDs, MT-number rejection, revisions/soft delete/audit, independent role rights and label-only reads, private RLS/grants, 24-hour write renewal')

def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER',''):raise RuntimeError('Wrong project')
    migration,=(ROOT/'supabase/migrations').glob('*_distribution_label_products.sql')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_distribution_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'");conn.execute("set local statement_timeout='40s'")
            before=conn.execute("select md5(payload::text) from public.app_data where key='labelProducts'").fetchone()[0]
            if os.environ.get('DBMT_DISTRIBUTION_DEPLOYED')!='1':conn.execute(migration.read_text(encoding='utf-8'))
            tests(conn)
            assert conn.execute("select md5(payload::text) from public.app_data where key='labelProducts'").fetchone()[0]==before
        assert not conn.execute("select 1 from public.erp_users where login_id like 'qa_dist_%'").fetchone()
    print('PASS: all test schema/session/product/audit changes rolled back; existing MT catalog unchanged')

if __name__=='__main__':main()
