"""Verify inbound stock-source tracking in an always-rolled-back transaction."""
import copy
import json
import os
import sys
import uuid
from decimal import Decimal

import psycopg
from psycopg.types.json import Jsonb


def fixture_tests(conn, allow_price_correction=False):
    suffix = uuid.uuid4().hex[:12]
    uid = lambda kind: 'qa_' + kind + '_' + suffix
    role = conn.execute("insert into public.erp_roles(code,name) values(%s,'Stock source QA') returning id", (uid('role'),)).fetchone()[0]
    for menu in ['production', 'transactions', 'stock']:
        conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view,can_create,can_update,can_delete) values(%s,%s,true,true,true,true)", (role, menu))
    user = conn.execute("insert into public.erp_users(login_id,display_name,password_hash,role_id) values(%s,'Stock source QA',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id", (uid('user'), uuid.uuid4().hex, role)).fetchone()[0]
    token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')", (token, user))

    def rpc(name, *args):
        with conn.transaction():
            conn.execute("set local dbmt.personal_authorized='false'")
            conn.execute('set local role anon')
            result = conn.execute('select public.' + name + '(' + ','.join(['%s'] * len(args)) + ')', tuple(Jsonb(value) if isinstance(value, (list, dict)) else value for value in args)).fetchone()[0]
            conn.execute('set local role postgres')
            return result

    def reject(fn, fragment):
        try:
            fn()
        except psycopg.Error as error:
            assert error.sqlstate in ('P0001', '42501'), error.sqlstate
            assert fragment in error.diag.message_primary, error.diag.message_primary
        else:
            raise AssertionError('Expected rejection: ' + fragment)

    def source_tag(source_id):
        parts = source_id.split('_')
        return parts[-2] if len(parts) > 1 else 'legacy'

    def inbound(source_id, quantity, price):
        return dict(id=uid('in_' + source_tag(source_id)), date='2026-09-17', type='입고', product='QA 우설깃',
                    origin='호주산', packunit='5KG', trader='QA 매입처', storage='냉동', lot='QA-LOT-1',
                    weight=quantity, price=price, amount=quantity * price, stockLocation='가공장',
                    stockRowId=source_id, stockTrackingVersion='1', _isUser=True)

    def consume(source_id, quantity, kind='출고'):
        return dict(id=uid(kind + '_' + source_tag(source_id)), date='2026-09-17', type=kind, product='QA 우설깃',
                    origin='호주산', packunit='5KG', trader='QA 거래처', lot='QA-LOT-1',
                    weight=quantity, price=20000, amount=quantity * 20000, stockLocation='가공장',
                    stockUnitPrice=13839, stockProddate='2026-09-17', stockRowId=source_id,
                    sourceStockKey='row|' + source_id, _isUser=True)

    source_a, source_b = uid('stock_a'), uid('stock_b')
    first, second = inbound(source_a, 0.34, 13839), inbound(source_b, 7.8, 14238)
    assert rpc('dbmt_erp_save_transactions', token, [first, second], [])['ok']
    assert rpc('dbmt_erp_save_transactions', token, [consume(source_b, 7.8)], [])['ok']
    assert rpc('dbmt_erp_save_transactions', token, [consume(source_a, 0.34, '사용')], [])['ok']
    saved = conn.execute("select raw->>'stockRowId', price from public.transactions where id in (%s,%s) order by id", (first['id'], second['id'])).fetchall()
    assert {row[0] for row in saved} == {source_a, source_b}
    assert {row[1] for row in saved} == {13839, 14238}

    reject(lambda: rpc('dbmt_erp_save_transactions', token, [consume(uid('missing'), 1)], []), '재고원본')
    collision = inbound(source_a, 1, 14000)
    collision['id'] = uid('collision')
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [collision], []), '이미 다른 입고')

    changed = copy.deepcopy(first)
    changed['price'] = 15000
    changed['amount'] = changed['price'] * changed['weight']
    if allow_price_correction:
        linked_before = conn.execute("select id,raw from public.transactions where id<>%s and raw->>'stockRowId'=%s order by id", (first['id'], source_a)).fetchall()
        assert rpc('dbmt_erp_save_transactions', token, [changed], [])['ok']
        assert conn.execute('select price,amount,weight from public.transactions where id=%s', (first['id'],)).fetchone() == (15000, 5100, Decimal('0.34'))
        assert conn.execute("select id,raw from public.transactions where id<>%s and raw->>'stockRowId'=%s order by id", (first['id'], source_a)).fetchall() == linked_before
        assert conn.execute('select price from public.transactions where id=%s', (second['id'],)).fetchone()[0] == 14238
        altered_identity = dict(changed, lot='QA-OTHER-LOT')
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [altered_identity], []), '보관장소는 변경')
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [dict(changed, stockRowId='')], []), '해제할 수 없습니다')
        conn.execute("update public.erp_role_permissions set can_update=false where role_id=%s and menu_code='transactions'", (role,))
        assert rpc('dbmt_erp_save_transactions', token, [changed], [])['ok'] is False
        conn.execute("update public.erp_role_permissions set can_update=true where role_id=%s and menu_code='transactions'", (role,))
    else:
        reject(lambda: rpc('dbmt_erp_save_transactions', token, [changed], []), '단가는 변경')
    reduced = copy.deepcopy(second)
    reduced['weight'] = 7
    reduced['amount'] = reduced['weight'] * reduced['price']
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [reduced], []), '입고중량')
    reject(lambda: rpc('dbmt_erp_save_transactions', token, [], [first['id']]), '삭제할 수 없습니다')

    # Existing no-ID history remains accepted and is not retroactively changed.
    legacy = inbound('', 4, 12000)
    legacy['id'] = uid('legacy')
    legacy.pop('stockRowId')
    legacy.pop('stockTrackingVersion')
    assert rpc('dbmt_erp_save_transactions', token, [legacy], [])['ok']
    assert conn.execute("select raw ? 'stockRowId' from public.transactions where id=%s", (legacy['id'],)).fetchone()[0] is False


def main():
    if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGUSER', ''):
        raise RuntimeError('Wrong linked project')
    sql = sys.stdin.buffer.read().decode('utf-8-sig')
    if '재고원본' not in sql or 'dbmt_stock_row_write_lock' not in sql:
        raise RuntimeError('Expected stock-source tracking schema')
    with psycopg.connect(sslmode='require', connect_timeout=20, autocommit=True, application_name='dbmt_stock_source_rollback_qa') as conn:
        with conn.transaction(force_rollback=True):
            conn.execute('set local role postgres')
            conn.execute(sql)
            fixture_tests(conn, allow_price_correction='--allow-price-correction' in sys.argv)
    print(json.dumps(dict(ok=True, schemaApplied=False, allChangesRolledBack=True,
                          tests='tracked sources, exact linkage, collision/identity/quantity/deletion guards, price correction permission and snapshot preservation, legacy preservation')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(getattr(getattr(error, 'diag', None), 'message_primary', None) or error), file=sys.stderr)
        if isinstance(error, psycopg.Error):
            print('SQL context: ' + str(error.diag.context), file=sys.stderr)
        raise SystemExit(1)
