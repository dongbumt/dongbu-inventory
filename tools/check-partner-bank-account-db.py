"""Exercise actual partner RPCs using fictional accounts, then roll back all rows."""
import json
import os
import sys
import uuid
import psycopg
from psycopg.types.json import Jsonb


def checks(conn):
    suffix = uuid.uuid4().hex[:12]
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Partner account QA') returning id", ('qa_bank_'+suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,'traders',true,true,true,true)", (role,))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Partner account QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", ('qa_bank_'+suffix, uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token,user))

    def save(record, revision=None, session=token):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.dbmt_erp_save_business_partner(%s,%s,%s)', (session,Jsonb(record),revision)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(record, revision, fragment):
        try:
            save(record,revision)
        except psycopg.Error as error:
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: '+fragment)

    record = dict(name='qa_bank_'+suffix,tradeType='매입',bankAccount='  가상은행 / 001-002-000003 / 가상 예금주  ')
    assert save(record,session='bad-token')['ok'] is False
    first = save(record)
    partner = first['partner']; account = record['bankAccount'].strip()
    assert partner['bankAccount']==account
    assert first['traderInfoMap'][record['name']]['bankAccount']==account
    pid = partner['id']; record.update(id=pid,bankAccount=account)
    assert conn.execute('select bank_account from public.business_partners where id=%s',(pid,)).fetchone()[0]==account
    legacy = dict(record);del legacy['bankAccount']
    updated = save(legacy,partner['revision'])['partner']
    assert updated['bankAccount']==account, 'Old clients must preserve the account'
    reject(record,partner['revision'],'stale business partner revision')
    reject(dict(record,bankAccount='x'*301),updated['revision'],'300자')
    reject(dict(record,bankAccount=123),updated['revision'],'문자로')
    assert save(dict(record,bankAccount=''),updated['revision'])['partner']['bankAccount']==''
    blank = save(dict(name='qa_bank_blank_'+suffix))['partner']
    assert blank['bankAccount']==''
    assert conn.execute('select bank_account is null from public.business_partners where id=%s',(blank['id'],)).fetchone()[0]
    special = '가상은행 / 000-001 / <가상 & 예금주>'
    current = conn.execute('select revision from public.business_partners where id=%s',(pid,)).fetchone()[0]
    changed = save(dict(record,name=record['name']+'_renamed',bankAccount=special),current)
    assert changed['partner']['bankAccount']==special
    assert changed['traderInfoMap'][record['name']]['bankAccount']==special, 'Aliases retain the canonical account'
    current = changed['partner']['revision']
    assert save(dict(record,name=changed['partner']['name'],bankAccount=None),current)['partner']['bankAccount']==''
    conn.execute('update public.erp_role_permissions set can_create=false,can_update=false where role_id=%s',(role,))
    assert save(dict(name='qa_bank_denied_'+suffix))['ok'] is False
    current = conn.execute('select revision from public.business_partners where id=%s',(pid,)).fetchone()[0]
    assert save(dict(record,bankAccount='denied'),current)['ok'] is False
    assert not conn.execute("select has_table_privilege('anon','public.business_partners','select') or has_table_privilege('anon','public.business_partners','update')").fetchone()[0]


def main():
    assert 'hdwjwtmbsxfjrlvicgnn' in os.environ.get('PGUSER','')+os.environ.get('PGHOST','')
    sql = '' if '--installed' in sys.argv else sys.stdin.buffer.read().decode('utf-8-sig')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_partner_bank_rollback_qa') as conn:
        conn.execute('set role postgres')
        snapshot = "select (select md5(jsonb_agg(to_jsonb(p)-'bank_account' order by id)::text) from public.business_partners p),(select md5(payload::text) from public.app_data where key='traderInfoMap'),(select count(*) from public.transactions),(select count(*) from public.production_entries)"
        before = conn.execute(snapshot).fetchone()
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'");conn.execute("set local statement_timeout='45s'")
            if sql:conn.execute(sql);conn.execute(sql)
            checks(conn)
        assert conn.execute(snapshot).fetchone()==before
        assert conn.execute("select count(*) from public.business_partners where name like 'qa_bank_%'").fetchone()[0]==0
    print(json.dumps(dict(ok=True,allChangesRolledBack=True,existingDataUnchanged=True,tests='Create/read/update/clear; leading zeros; optional input; old-client preservation; alias rename; length/type validation; revision conflicts; permissions'),ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(type(error).__name__+': '+str(getattr(getattr(error,'diag',None),'message_primary',None) or error),file=sys.stderr)
        if not isinstance(error,psycopg.Error):
            import traceback
            traceback.print_exc()
        raise SystemExit(1)
