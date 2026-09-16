"""Availability RPC QA; fixtures always roll back. --apply commits only DDL."""
import json
import os
import sys
import uuid
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Product availability QA') returning id", ('qa_active_' + suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'label_products',true,true,true,false)", (role,))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Availability QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", ('qa_active_' + suffix, uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))

    def history():
        # Fingerprints only. No business records leave the connection.
        return [conn.execute('select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,\'[]\')) from public.' + table + ' t').fetchone()[0]
                for table in ['transactions', 'production_entries']]

    before = history()
    def save(record, session=token):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.dbmt_erp_save_label_product(%s,%s)', (session, Jsonb(record))).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    p = dict(id='qa_availability_' + suffix, name='QA active ' + suffix, meattype='가금류', kind='원료육', origin='국내산', shelfdays=365)
    assert save(p, 'invalid')['ok'] is False
    result = save(p)
    assert result['ok'] and result['product']['isActive'] is True
    p = result['product']
    code = p['productCode']
    p['isActive'] = False
    result = save(p)
    assert result['product']['isActive'] is False and result['product']['productCode'] == code
    audit = conn.execute("select payload from public.change_logs where entity_id=%s order by id desc limit 1", (p['id'],)).fetchone()[0]
    assert audit['before']['isActive'] is True and audit['after']['isActive'] is False
    older = dict(p)
    del older['isActive']
    assert save(older)['product']['isActive'] is False, 'Old client must not reactivate'
    for invalid in ['false', None, 0, {}, []]:
        try:
            save(dict(p, isActive=invalid))
        except psycopg.Error as error:
            assert '사용 여부' in error.diag.message_primary
        else:
            raise AssertionError('Non-boolean availability accepted')
    conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='label_products'", (role,))
    assert save(dict(p, isActive=True))['ok'] is False
    conn.execute("update public.erp_role_permissions set can_update=true where role_id=%s and menu_code='label_products'", (role,))
    assert save(dict(p, isActive=True))['product']['isActive'] is True
    # A legacy saved master without the field is treated as active on its next save.
    conn.execute("update public.app_data set payload=(select jsonb_agg(case when e->>'id'=%s then e-'isActive' else e end order by ord) from jsonb_array_elements(payload) with ordinality q(e,ord)) where key='labelProducts'", (p['id'],))
    assert save(older)['product']['isActive'] is True
    assert history() == before, 'Availability must never change transaction or production history'


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    sql = sys.stdin.buffer.read().decode('utf-8-sig')
    assert 'create or replace function public.dbmt_erp_save_label_product' in sql and "'isActive'" in sql
    apply = '--apply' in sys.argv
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_availability_qa') as conn:
        with conn.transaction(force_rollback=not apply):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='30s'")
            conn.execute('set local role postgres')
            existing = conn.execute("select prosrc from pg_proc where oid='public.dbmt_erp_save_label_product(text,jsonb)'::regprocedure").fetchone()[0].strip()
            previous = (Path(__file__).resolve().parent.parent / 'supabase/migrations/20260818090000_product_species_details.sql').read_text(encoding='utf-8-sig').split('$dbmt$')[1].strip()
            proposed = sql.split('$dbmt$')[1].strip()
            if existing.replace('\r', '') not in [previous.replace('\r', ''), proposed.replace('\r', '')]:
                raise RuntimeError('Live product RPC differs from the reviewed baseline; inspect before replacing it')
            conn.execute(sql)
            with conn.transaction(force_rollback=True):
                fixture_tests(conn)
    print(json.dumps(dict(ok=True, schemaApplied=apply, fixturesRolledBack=True,
                         tests='default active, deactivate/reactivate, old-client compatibility, boolean validation, permissions, audit, historical data unchanged')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        raise SystemExit(1)
