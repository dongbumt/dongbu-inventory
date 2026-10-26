"""Verify checklist read RPCs never update login rows; all fixtures/DDL roll back."""
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb


def checks(conn):
    suffix = uuid.uuid4().hex[:12]
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Document reads QA') returning id", ('qa_read_' + suffix,)).fetchone()[0]
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Document reads QA','unused',%s) returning id", ('qa_read_' + suffix, role)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete,can_api_send) values(%s,'document_check',true,false,false,false,false)", (role,))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at,last_used_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes',now()-interval '1 day')", (token, user))
    original = conn.execute('select last_used_at from public.erp_user_sessions where user_id=%s', (user,)).fetchone()[0]
    flags = {'QA-READ-' + suffix: True}
    conn.execute("insert into public.app_data(key,payload) values('docChecks',%s) on conflict(key) do update set payload=excluded.payload", (Jsonb(flags),))
    content = {'html': '<p>Preserved body</p>'}
    pid = conn.execute("insert into public.document_request_logs(channel,trader,recipient,status,provider,documents,document_count,content_snapshot) values('email',%s,'fixture@example.invalid','sent','QA',%s,1,%s) returning id", ('qa_read_' + suffix, Jsonb([{'lot': 'QA-READ-' + suffix}]), Jsonb(content))).fetchone()[0]

    def rpc(name, *args, auth=token):
        with conn.transaction():
            conn.execute('set local role anon')
            value = conn.execute('select public.' + name + '(' + ','.join(['%s'] * (len(args) + 1)) + ')', (auth,) + args).fetchone()[0]
            conn.execute('set local role postgres')
            return value

    calls = [('dbmt_erp_get_doc_checks', ()), ('dbmt_erp_get_document_request_delivery', ()),
             ('dbmt_erp_get_document_request_logs', (500,)), ('dbmt_erp_get_document_request_log_detail', (pid,))]
    assert rpc(*calls[0][:1]) == {'docChecks': flags}
    rows = rpc(*calls[1][:1])
    assert any(r['identity']['lot'] == ('QAREAD' + suffix).upper() for r in rows)
    history = rpc(calls[2][0], *calls[2][1])
    record = next(r for r in history if r['id'] == pid)
    assert 'content_snapshot' not in record
    assert rpc(calls[3][0], *calls[3][1])['log']['content_snapshot'] == content
    assert conn.execute('select last_used_at from public.erp_user_sessions where user_id=%s', (user,)).fetchone()[0] == original, 'Read RPCs must not lock/update the shared session row'
    assert conn.execute("select payload from public.app_data where key='docChecks'").fetchone()[0] == flags
    assert rpc('dbmt_erp_get_document_request_log_detail', -1)['ok'] is False

    def rejected(auth=token):
        for name, args in calls:
            try:
                with conn.transaction():
                    rpc(name, *args, auth=auth)
            except psycopg.Error:
                pass
            else:
                raise AssertionError('Unauthorized read accepted: ' + name)

    rejected('invalid-token')
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s", (role,))
    rejected()
    conn.execute("update public.erp_role_permissions set can_view=true where role_id=%s", (role,))
    conn.execute('update public.erp_user_sessions set expires_at=now()-interval \'1 minute\' where user_id=%s', (user,))
    rejected()
    assert not conn.execute("select has_table_privilege('anon','public.erp_user_sessions','update') or has_table_privilege('anon','public.document_request_logs','select') or has_table_privilege('anon','public.app_data','select')").fetchone()[0]


def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER', '')
    root = Path(__file__).resolve().parent.parent
    sql = (root / 'supabase/schema-rpc-69-document-check-nonblocking-reads.sql').read_text(encoding='utf-8-sig')
    migration, = (root / 'supabase/migrations').glob('*_document_check_nonblocking_reads.sql')
    assert sql == migration.read_text(encoding='utf-8-sig')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_document_reads_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='2s'")
            conn.execute("set local statement_timeout='3s'")
            if '--installed' not in sys.argv:
                conn.execute(sql)
            checks(conn)
            for filename in ['check-document-request-delivery-db.py', 'check-document-request-content-db.py']:
                spec = importlib.util.spec_from_file_location('qa_' + filename, root / 'tools' / filename)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                module.checks(conn)
    print(json.dumps(dict(ok=True, allChangesRolledBack=True, tests='3s statement limit; receipt-only fetch; unchanged session audit rows; mail/fax summary/history/detail; denied/expired/view-only access; unchanged receipt data; complete previous delivery/content regression'), ensure_ascii=False))


if __name__ == '__main__':
    main()
