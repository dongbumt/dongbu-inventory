"""Real product-spec RPCs, fictional records, unconditional rollback."""
import os
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

ROOT=Path(__file__).resolve().parents[1]


def tests(conn):
    suffix=uuid.uuid4().hex[:12]
    role=conn.execute("insert into public.erp_roles(code,name) values(%s,'Product spec usage QA') returning id",('qa_spec_'+suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'product_specs',true,true,true,true)",(role,))
    user=conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Spec usage QA','qa-no-password',%s) returning id",('qa_spec_'+suffix,role)).fetchone()[0]
    token=uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')",(token,user))
    products=[dict(id='qa-product',name='QA 돈등심',kind='제품',origin='국내산',brand='QA A'),
              dict(id='qa-other',name='QA 돈등심',kind='제품',origin='미국산',brand='QA B'),
              dict(id='qa-raw',name='QA 원료육',kind='원료육'),dict(id='qa-off',name='QA 중지품',kind='제품',isActive=False),
              dict(id='qa-raw-off',name='QA 중지원료육',kind='원료육',isActive=False),dict(id='qa-wrong-kind',name='QA 부자재',kind='부자재')]
    def catalog():conn.execute("insert into public.app_data(key,payload) values('labelProducts',%s) on conflict(key) do update set payload=excluded.payload",(Jsonb(products),))
    catalog()
    def rpc(name,*args):
        with conn.transaction():
            conn.execute('set local role anon')
            result=conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',tuple(Jsonb(a) if isinstance(a,(dict,list)) else a for a in args)).fetchone()[0]
            conn.execute('set local role postgres');return result
    def reject(callback,fragment):
        try: callback()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001','42501'),error.sqlstate
            assert fragment in error.diag.message_primary,error.diag.message_primary
        else:raise AssertionError('Expected rejection: '+fragment)
    payload=dict(trader='QA 거래처',distribution='삼성웰스토리',material='클라이언트 임의명',material_product_id='qa-product',origin='국내산',inner_packaging_spec='1KG',outer_packaging_spec='10KG/BOX',monthly_usage=1000.123456,price_kg=0,price_box=None)
    save=lambda record,spec_id=None,revision=None:rpc('dbmt_erp_save_product_spec',token,spec_id,record,revision)
    assert not rpc('dbmt_erp_save_product_spec','invalid',None,payload,None)['ok']
    conn.execute('update public.erp_role_permissions set can_create=false where role_id=%s',(role,))
    assert not save(payload)['ok']
    conn.execute('update public.erp_role_permissions set can_create=true where role_id=%s',(role,))
    created=save(payload)['spec'];spec_id=uuid.UUID(created['id'])
    assert created['material']=='QA 돈등심' and created['material_product_id']=='qa-product'
    assert created['monthly_usage']==1000.123456 and created['price_kg']==0
    assert conn.execute("select payload->'after'->'monthly_usage' from public.change_logs where entity='제품스펙' and entity_id=%s",(created['id'],)).fetchone()[0]==1000.123456
    fetched=rpc('dbmt_erp_get_product_specs',token)
    assert next(row for row in fetched['specs'] if row['id']==created['id'])['monthly_usage']==1000.123456
    # A tab predating this release cannot erase monthly usage or the product identity.
    old_payload={key:value for key,value in payload.items() if key not in ('monthly_usage','material_product_id')}
    updated=save(old_payload,spec_id,created['revision'])['spec']
    assert updated['monthly_usage']==1000.123456 and updated['material_product_id']=='qa-product'
    assert updated['distribution']=='삼성웰스토리' and updated['outer_packaging_spec']=='10KG/BOX'
    reject(lambda:save(payload,spec_id,created['revision']),'다른 사용자')
    zero=save(dict(payload,monthly_usage=0),spec_id,updated['revision'])['spec'];assert zero['monthly_usage']==0
    cleared=save(dict(payload,monthly_usage=None),spec_id,zero['revision'])['spec'];assert cleared['monthly_usage'] is None
    for value in [-1,1000000000,0.1234567]:reject(lambda value=value:save(dict(payload,monthly_usage=value)),'월사용량은 0 이상')
    reject(lambda:save(dict(payload,monthly_usage='10')),'월사용량은 숫자')
    raw_payload=dict(payload,material_product_id='qa-raw')
    raw=save(raw_payload)['spec'];assert raw['material']=='QA 원료육' and raw['material_product_id']=='qa-raw'
    raw_updated=save(dict(raw_payload,monthly_usage=12.5),uuid.UUID(raw['id']),raw['revision'])['spec']
    assert raw_updated['monthly_usage']==12.5 and raw_updated['material']=='QA 원료육'
    raw_copy=save(dict(raw_payload,trader='QA 원료육 복사'))['spec'];assert raw_copy['id']!=raw['id']
    for product_id in ['missing','qa-off','qa-raw-off','qa-wrong-kind']:reject(lambda product_id=product_id:save(dict(payload,material_product_id=product_id)),'사용 가능한 제품 또는 원료육')
    reject(lambda:save(dict(payload,material_product_id=None)),'등록된 제품 또는 원료육')
    # Old free-text records remain editable without guessing a link by a duplicate name.
    legacy=conn.execute("insert into public.product_specs(trader,material,origin,note) values('QA 기존거래처','기존 직접입력','국내산','원문 보존') returning id,revision").fetchone()
    legacy_updated=save(dict(trader='QA 기존거래처',material='기존 직접입력',material_product_id=None,origin='국내산',monthly_usage=25,note='원문 보존'),*legacy)['spec']
    assert legacy_updated['monthly_usage']==25 and legacy_updated['material_product_id'] is None and legacy_updated['material']=='기존 직접입력'
    # Existing linked records remain editable if the master is later disabled/deleted.
    products[0]['isActive']=False;catalog()
    retained=save(dict(payload,material='QA 돈등심',monthly_usage=42),spec_id,cleared['revision'])['spec'];assert retained['monthly_usage']==42
    products.pop(0);catalog()
    retained=save(dict(payload,material='QA 돈등심',monthly_usage=43),spec_id,retained['revision'])['spec'];assert retained['monthly_usage']==43
    reject(lambda:save(dict(payload,material='다른 품목',monthly_usage=44),spec_id,retained['revision']),'사용 가능한 제품')
    conn.execute('update public.erp_role_permissions set can_update=false where role_id=%s',(role,))
    assert not save(payload,spec_id,retained['revision'])['ok']
    conn.execute('update public.erp_role_permissions set can_view=false where role_id=%s',(role,))
    assert not rpc('dbmt_erp_get_product_specs',token)['ok']
    assert conn.execute("select relrowsecurity from pg_class where oid='public.product_specs'::regclass").fetchone()[0]
    assert not conn.execute("select has_table_privilege('anon','public.product_specs','select')").fetchone()[0]
    print('PASS: raw meat create/update/copy, KG usage, canonical material selection, inactive/unsupported kind rejection, legacy/old-client retention, removed masters, revisions, audit and permissions')


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER',''):raise RuntimeError('Wrong project')
    migration,=(ROOT/'supabase/migrations').glob('*_product_spec_raw_materials.sql')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_spec_usage_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'");conn.execute("set local statement_timeout='40s'")
            before=conn.execute("select coalesce(jsonb_agg(to_jsonb(s)-array['monthly_usage','material_product_id'] order by id),'[]'::jsonb) from public.product_specs s").fetchone()[0]
            if os.environ.get('DBMT_SPEC_USAGE_DEPLOYED')!='1':conn.execute(migration.read_text(encoding='utf-8'))
            assert conn.execute("select coalesce(jsonb_agg(to_jsonb(s)-array['monthly_usage','material_product_id'] order by id),'[]'::jsonb) from public.product_specs s").fetchone()[0]==before
            tests(conn)
        assert not conn.execute("select 1 from public.erp_users where login_id like 'qa_spec_%'").fetchone()
    print('PASS: original records unchanged; all QA schema, catalog, role, spec and audit changes rolled back')


if __name__=='__main__':main()
