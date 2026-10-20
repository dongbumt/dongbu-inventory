"""Verify the real detail RPC inside a rollback-only transaction."""
import json,os,sys,uuid
import psycopg
from psycopg.types.json import Jsonb

def checks(conn):
    suffix=uuid.uuid4().hex[:12]
    role=conn.execute("insert into public.erp_roles(code,name) values(%s,'Document content QA') returning id",('qa_doc_'+suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete,can_api_send) values(%s,'document_check',true,false,false,false,false)",(role,))
    user=conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Document content QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id",('qa_doc_'+suffix,uuid.uuid4().hex,role)).fetchone()[0]
    token=uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')",(token,user))
    def read(pid,session=token):
        with conn.transaction():
            conn.execute('set local role anon')
            result=conn.execute('select public.dbmt_erp_get_document_request_log_detail(%s,%s)',(session,pid)).fetchone()[0]
            conn.execute('set local role postgres');return result
    for channel in ['email','fax']:
        content=dict(version=1,html='<p>Fictional sent body</p>',text='Fictional body',sender=dict(displayName='Fictional sender'))
        pid=conn.execute("insert into public.document_request_logs(channel,trader,recipient,subject,status,provider,documents,document_count,content_snapshot) values(%s,%s,'recipient@example.invalid','Fictional subject','sent','QA',%s,1,%s) returning id",(channel,'qa_doc_'+suffix,Jsonb([dict(product='가상 품목',lot='001-LOT')]),Jsonb(content))).fetchone()[0]
        result=read(pid);assert result['ok'] and result['log']['content_snapshot']==content
        with conn.transaction():
            conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s",(role,))
            try:read(pid)
            except psycopg.Error:pass
            else:raise AssertionError('Missing view permission accepted')
        conn.execute("update public.erp_role_permissions set can_view=true where role_id=%s",(role,))
        try:read(pid,'bad-token')
        except psycopg.Error:pass
        else:raise AssertionError('Invalid token accepted')
        conn.execute('update public.document_request_logs set content_snapshot=null where id=%s',(pid,))
        legacy=read(pid)['log'];assert legacy['content_snapshot'] is None and legacy['subject']=='Fictional subject' and legacy['documents'][0]['lot']=='001-LOT'
    assert read(-1)['ok'] is False
    assert not conn.execute("select has_table_privilege('anon','public.document_request_logs','select')").fetchone()[0]

def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER','')+os.environ.get('PGHOST','')
    sql='' if '--installed' in sys.argv else sys.stdin.buffer.read().decode('utf-8-sig')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_doc_content_rollback_qa') as conn:
        conn.execute('set role postgres')
        snapshot="select count(*),md5(jsonb_agg(to_jsonb(l)-'content_snapshot' order by id)::text) from public.document_request_logs l"
        before=conn.execute(snapshot).fetchone()
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'");conn.execute("set local statement_timeout='45s'")
            if sql:conn.execute(sql);conn.execute(sql)
            checks(conn)
        assert conn.execute(snapshot).fetchone()==before
    print(json.dumps(dict(ok=True,allChangesRolledBack=True,historicalLogsUnchanged=True,tests='Email/fax detail; original content; legacy null; view-only access; invalid login; denied permission; no direct table access'),ensure_ascii=False))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(type(error).__name__+': '+str(getattr(getattr(error,'diag',None),'message_primary',None) or error),file=sys.stderr)
        raise SystemExit(1)
