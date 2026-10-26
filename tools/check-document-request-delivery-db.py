"""Real read-only RPC tests; fictional logs/users and schema trials always roll back."""
import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb


def checks(conn):
    suffix = uuid.uuid4().hex[:12]
    prefix = 'qa_delivery_' + suffix
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Delivery QA') returning id", (prefix,)).fetchone()[0]
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Delivery QA','unused',%s) returning id", (prefix, role)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'document_check',true,false,false,false)", (role,))
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))

    def read(auth=token):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.dbmt_erp_get_document_request_delivery(%s)', (auth,)).fetchone()[0]
            conn.execute('set local role postgres')
            return [r for r in result if r['identity']['lot'].startswith(prefix.replace('_', '').upper()) or r['identity']['trader'] == prefix]

    def reject(call):
        try:
            with conn.transaction():
                call()
        except psycopg.Error:
            return
        raise AssertionError('Permission failure expected')

    def add(channel, status, docs, date='2026-10-26T01:00:00Z', provider_status=None):
        return str(conn.execute("insert into public.document_request_logs(channel,trader,recipient,status,provider,documents,document_count,created_at,provider_status,content_snapshot) values(%s,%s,'fixture@example.invalid',%s,'QA',%s,%s,%s,%s,%s) returning id", (channel, prefix, status, Jsonb(docs), len(docs), date, provider_status, Jsonb({'html': '<p>Do not expose bodies in summary</p>'}))).fetchone()[0])

    lot = prefix + '-a b'
    doc = dict(lot=lot, product='원료 A', origin='미국산', date='2026-10-20')
    sent = add('email', 'sent', [doc, dict(doc, product='동일 이력 제품')], '2026-01-01T01:00:00Z')
    retry = add('email', 'failed', [doc], '2026-10-26T03:00:00Z')
    fax = add('fax', 'accepted', [doc], provider_status='테스트 접수')
    blank1 = dict(product='이력 없는 품목', origin='국내산', date='2026/10/20')
    blank2 = dict(blank1, date='2026-10-21')
    add('email', 'failed', [blank1])
    add('email', 'sent', [blank2])
    pending = dict(doc, lot=prefix + '-pending')
    add('fax', 'sending', [pending])
    # Older successful requests cannot disappear behind 100 newer attempts.
    conn.execute("insert into public.document_request_logs(channel,trader,recipient,status,provider,documents,document_count) select 'email',%s,'fixture@example.invalid','sent','QA','[]'::jsonb,0 from generate_series(1,120)", (prefix,))
    before = conn.execute('select count(*),md5(jsonb_agg(to_jsonb(l) order by id)::text) from public.document_request_logs l').fetchone()
    rows = read()
    assert len(rows) == 5, rows
    key = lot.replace('-', '').replace(' ', '').upper()
    email = next(r for r in rows if r['identity']['lot'] == key and r['channel'] == 'email')
    assert email['success']['id'] == sent and email['latest']['id'] == retry
    assert email['latest']['status'] == 'failed'
    accepted = next(r for r in rows if r['channel'] == 'fax' and r['identity']['lot'] == key)
    assert accepted['success']['id'] == fax and accepted['success']['provider_status'] == '테스트 접수'
    blanks = [r for r in rows if not r['identity']['lot']]
    assert len(blanks) == 2 and {r['identity']['date'] for r in blanks} == {'2026-10-20', '2026-10-21'}
    assert next(r for r in blanks if r['identity']['date'] == '2026-10-20')['success'] is None
    assert next(r for r in rows if r['identity']['lot'].endswith('PENDING'))['success'] is None
    assert all(set(r) == {'identity', 'channel', 'latest', 'success'} for r in rows)
    assert 'content_snapshot' not in json.dumps(rows) and 'fixture@example.invalid' not in json.dumps(rows)
    reject(lambda: read('bad-token'))
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s", (role,))
    reject(read)
    assert not conn.execute("select has_table_privilege('anon','public.document_request_logs','select')").fetchone()[0]
    assert conn.execute('select count(*),md5(jsonb_agg(to_jsonb(l) order by id)::text) from public.document_request_logs l').fetchone() == before
    return prefix


def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER', '')
    root = Path(__file__).resolve().parent.parent
    sql = (root / 'supabase/schema-rpc-68-document-request-delivery-status.sql').read_text(encoding='utf-8-sig')
    migration, = (root / 'supabase/migrations').glob('*_document_request_delivery_status.sql')
    assert sql == migration.read_text(encoding='utf-8-sig')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_document_delivery_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='45s'")
            if '--installed' not in sys.argv:
                conn.execute(sql)
            prefix = checks(conn)
        assert not conn.execute('select 1 from public.document_request_logs where trader=%s', (prefix,)).fetchone()
    print(json.dumps(dict(ok=True, fixturesRolledBack=True, tests='Full history beyond 100; normalized LOT; grouped documents; independent mail/fax; prior success after failed retry; fax acceptance/test and pending states; precise blank-LOT identity; view-only authorization; unchanged logs; no body/recipient exposure'), ensure_ascii=False))


if __name__ == '__main__':
    main()
