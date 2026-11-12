"""All schema, session, partner and financial fixtures roll back."""
import os
import uuid
from decimal import Decimal
import json
import subprocess
from pathlib import Path
import psycopg

ROOT = Path(__file__).resolve().parents[1]


def tests(conn):
    suffix = uuid.uuid4().hex[:12]
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Ledger QA') returning id", ('qa_ledger_'+suffix,)).fetchone()[0]
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Ledger QA','unused',%s) returning id", ('qa_ledger_'+suffix,role)).fetchone()[0]
    partner = conn.execute("insert into public.business_partners(code,name) values(%s,%s) returning id", ('QA'+suffix.upper(),'Ledger QA '+suffix)).fetchone()[0]
    for menu in ['customer_ledger','product_ledger']:
        conn.execute('insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)', (role,menu))
    token = uuid.uuid4().hex+uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token,user))

    def rpc(name,*args):
        with conn.transaction():
            conn.execute('set local role anon')
            result = conn.execute('select public.'+name+'('+','.join(['%s']*len(args))+')',args).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(call,fragment):
        try:
            with conn.transaction():
                call()
        except psycopg.Error as error:
            assert fragment in str(error), str(error)
            conn.execute('set local role postgres')
        else:
            raise AssertionError('Expected rejection: '+fragment)

    reject(lambda:rpc('dbmt_erp_get_ledger_snapshot','invalid','customer'),'로그인')
    reject(lambda:rpc('dbmt_erp_get_ledger_snapshot',token,'unknown'),'원장')
    entry = uuid.uuid4()
    reject(lambda:rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-11-02','receipt',100,'',None),'기초잔액')
    result=rpc('dbmt_erp_save_ledger_account',token,partner,'2026-11-01',500,200,None)
    assert result['account']['revision']==1
    reject(lambda:rpc('dbmt_erp_save_ledger_account',token,partner,'2026-11-01',Decimal('0.5'),0,1),'정수')
    reject(lambda:rpc('dbmt_erp_save_ledger_account',token,partner,'2026-11-01',1,0,0),'다른 PC')
    assert rpc('dbmt_erp_save_ledger_account',token,partner,'2026-11-01',0,0,1)['account']['revision']==2
    reject(lambda:rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-11-02','receipt',0,'',None),'1원')
    reject(lambda:rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-10-31','receipt',100,'',None),'기초일자')
    saved=rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-11-02','receipt',100,'QA',None)['entry']
    assert saved['revision']==1 and saved['amount']==100
    assert rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-11-02','receipt',100,'QA',None)['entry']==saved
    assert conn.execute('select count(*) from erp_ledger_private.entries where id=%s',(entry,)).fetchone()[0]==1
    reject(lambda:rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-11-02','receipt',200,'QA',None),'등록번호')
    assert rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-11-03','payment',200,'edited',1)['entry']['revision']==2
    reject(lambda:rpc('dbmt_erp_save_ledger_entry',token,entry,partner,'2026-11-03','receipt',300,'stale',1),'다른 PC')
    reject(lambda:rpc('dbmt_erp_save_ledger_account',token,partner,'2026-11-04',0,0,2),'수금·지급일')
    snapshot=rpc('dbmt_erp_get_ledger_snapshot',token,'customer')
    assert snapshot['ok'] and any(e['id']==str(entry) for e in snapshot['entries'])
    assert isinstance(snapshot['transactions'],list) and isinstance(snapshot['production'],list)
    checked=subprocess.run(['node',str(ROOT/'tools/check-ledgers-live-model.cjs')],input=json.dumps(snapshot,ensure_ascii=False),text=True,encoding='utf-8',capture_output=True)
    if checked.returncode:
        raise AssertionError(checked.stderr)
    print(checked.stdout.strip())
    product=rpc('dbmt_erp_get_ledger_snapshot',token,'product')
    assert product['accounts']==[] and product['entries']==[], 'Product-only endpoint must not leak settlements'
    conn.execute("update public.erp_role_permissions set can_create=false,can_update=false,can_delete=false where role_id=%s and menu_code='customer_ledger'",(role,))
    reject(lambda:rpc('dbmt_erp_save_ledger_account',token,partner,'2026-11-01',0,0,2),'권한')
    reject(lambda:rpc('dbmt_erp_save_ledger_entry',token,uuid.uuid4(),partner,'2026-11-03','receipt',100,'',None),'권한')
    reject(lambda:rpc('dbmt_erp_delete_ledger_entry',token,entry,2),'권한')
    conn.execute("update public.erp_role_permissions set can_delete=true where role_id=%s and menu_code='customer_ledger'",(role,))
    reject(lambda:rpc('dbmt_erp_delete_ledger_entry',token,entry,1),'변경')
    assert rpc('dbmt_erp_delete_ledger_entry',token,entry,2)['ok']
    assert rpc('dbmt_erp_delete_ledger_entry',token,entry,2)['ok']
    assert not any(e['partner_id']==str(partner) for e in rpc('dbmt_erp_get_ledger_snapshot',token,'customer')['entries'])
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s and menu_code='customer_ledger'",(role,))
    reject(lambda:rpc('dbmt_erp_get_ledger_snapshot',token,'customer'),'권한')
    assert rpc('dbmt_erp_get_ledger_snapshot',token,'product')['ok']
    for table in ['accounts','entries']:
        assert not conn.execute("select has_table_privilege('anon',%s,'select')",('erp_ledger_private.'+table,)).fetchone()[0]
        assert conn.execute('select relrowsecurity from pg_class where oid=%s::regclass',('erp_ledger_private.'+table,)).fetchone()[0]
    assert conn.execute("select not bool_or(prosecdef) from pg_proc where proname in ('dbmt_erp_get_ledger_snapshot','dbmt_erp_save_ledger_account','dbmt_erp_save_ledger_entry','dbmt_erp_delete_ledger_entry')").fetchone()[0]
    print('PASS: schema compiles, real snapshots read, private RLS tables, invoker API, authentication/view/write permissions, zero opening, exact cash amounts, retry deduplication, revisions and soft deletion')


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER',''):
        raise RuntimeError('Wrong linked project')
    migration,= (ROOT/'supabase/migrations').glob('*_customer_product_ledgers.sql')
    with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_ledger_qa') as conn:
        conn.execute('set role postgres')
        with conn.transaction(force_rollback=True):
            conn.execute("set local lock_timeout='8s'")
            conn.execute("set local statement_timeout='45s'")
            if os.environ.get('DBMT_LEDGER_TEST_DEPLOYED')!='1':
                conn.execute(migration.read_text(encoding='utf-8'))
            tests(conn)
        assert not conn.execute("select 1 from public.business_partners where name like 'Ledger QA %'").fetchone()
    print('PASS: all QA schema, user, permission, partner and financial changes rolled back')


if __name__=='__main__':
    main()
