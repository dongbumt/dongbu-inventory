"""Rollback-only checks for private, conditional catalog reads. No live edits persist."""
import json
import os
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER','')+os.environ.get('PGHOST',''):
    raise RuntimeError('Wrong linked project')
sql=Path(__file__).resolve().parent.parent.joinpath('supabase/schema-rpc-77-product-catalog-polling.sql').read_text(encoding='utf-8-sig')
with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_catalog_rollback_qa') as conn:
    conn.execute('set role postgres')
    before=conn.execute("select md5(payload::text),updated_at from public.app_data where key='labelProducts'").fetchone()
    with conn.transaction(force_rollback=True):
        conn.execute("set local lock_timeout='3s'")
        conn.execute("set local statement_timeout='15s'")
        if '--installed' not in sys.argv:conn.execute(sql)
        role,user=uuid.uuid4(),uuid.uuid4()
        token=uuid.uuid4().hex*2
        code='qa_catalog_'+uuid.uuid4().hex[:12]
        conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Catalog read QA')",(role,code))
        conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Catalog read QA','unused',%s)",(user,code,role))
        # Catalog consumers need not have permission to administer the product master.
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view) values(%s,'production',true)",(role,))
        conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '5 minutes')",(token,user))
        def read(revision=None,session=token):
            with conn.transaction():
                conn.execute('set local role anon')
                result=conn.execute('select public.dbmt_erp_get_label_products(%s,%s)',(session,revision)).fetchone()[0]
                conn.execute('set local role postgres')
                return result
        def denied(session=token):
            try:read(session=session)
            except psycopg.Error as error:assert '로그인' in error.diag.message_primary
            else:raise AssertionError('Invalid session must not read the catalog')
        first=read()
        assert first['ok'] and isinstance(first['products'],list)
        unchanged=read(first['revision'])
        assert unchanged['unchanged'] and 'products' not in unchanged
        unchanged_bytes=len(json.dumps(unchanged).encode())
        assert unchanged_bytes<1024
        count=len(first['products'])
        fixture={'id':code,'name':'QA 신규 품목','kind':'제품','meattype':'기타','productCode':'','isActive':True}
        conn.execute("update public.app_data set payload=payload||%s,updated_at=clock_timestamp() where key='labelProducts'",(Jsonb([fixture]),))
        added=read(first['revision'])
        assert len(added['products'])==count+1 and added['products'][-1]['id']==code
        assert added['revision']!=first['revision']
        assert read(added['revision'])['unchanged']
        conn.execute("update public.app_data set payload=jsonb_set(payload,array[(jsonb_array_length(payload)-1)::text,'isActive'],'false'::jsonb),updated_at=clock_timestamp() where key='labelProducts'")
        disabled=read(added['revision'])
        assert disabled['products'][-1]['isActive'] is False
        conn.execute("update public.app_data set payload=payload-(jsonb_array_length(payload)-1),updated_at=clock_timestamp() where key='labelProducts'")
        removed=read(disabled['revision'])
        assert len(removed['products'])==count
        denied('invalid-session')
        conn.execute('update public.erp_user_sessions set expires_at=now()-interval \'1 second\' where user_id=%s',(user,))
        denied()
        conn.execute("update public.erp_user_sessions set expires_at=now()+interval '5 minutes' where user_id=%s",(user,))
        conn.execute('update public.erp_users set active=false where id=%s',(user,));denied()
        conn.execute('update public.erp_users set active=true where id=%s',(user,))
        conn.execute('update public.erp_roles set active=false where id=%s',(role,));denied()
        assert not conn.execute("select has_table_privilege('anon','public.app_data','select')").fetchone()[0]
    after=conn.execute("select md5(payload::text),updated_at from public.app_data where key='labelProducts'").fetchone()
    assert before==after,'Real products and modification time must be unchanged'
print(json.dumps(dict(ok=True,unchangedResponseBytes=unchanged_bytes,allChangesRolledBack=True,tests='conditional read, add/disable/delete visibility, production-only reader, invalid/expired/disabled account and role, no direct table access'),ensure_ascii=False))
