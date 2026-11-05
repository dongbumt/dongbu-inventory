"""Verify the deployed read-only place lookup with a short-lived QA session.
No attendance, GPS or payroll record is changed. QA role/user/session are removed.
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
import uuid
from pathlib import Path
import psycopg

root=Path(__file__).resolve().parent.parent
html=(root/'index.html').read_text(encoding='utf-8-sig')
base=re.search(r"const SUPABASE_URL\s*=\s*['\"]([^'\"]+)",html).group(1)
public_key=re.search(r"const SUPABASE_PUBLISHABLE_KEY\s*=\s*['\"]([^'\"]+)",html).group(1)
week=sys.argv[1] if len(sys.argv)>1 else '2026-11-02'
if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',week):raise RuntimeError('Invalid week')
if 'hdwjwtmbsxfjrlvicgnn' not in os.environ.get('PGHOST','')+os.environ.get('PGUSER',''):raise RuntimeError('Wrong project')
role,user,token=uuid.uuid4(),uuid.uuid4(),uuid.uuid4().hex*2
name='qa_driver_place_'+uuid.uuid4().hex[:10]
with psycopg.connect(sslmode='require',connect_timeout=20,autocommit=True,application_name='dbmt_driver_place_live_qa') as conn:
    conn.execute('set role postgres')
    try:
        with conn.transaction():
            conn.execute("insert into public.erp_roles(id,code,name) values(%s,%s,'Place Lookup QA')",(role,name))
            conn.execute("insert into public.erp_users(id,login_id,display_name,password_hash,role_id) values(%s,%s,'Place Lookup QA',extensions.crypt(encode(extensions.gen_random_bytes(16),'hex'),extensions.gen_salt('bf')),%s)",(user,name,role))
            conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view) values(%s,'driver_attendance',true)",(role,))
            conn.execute("insert into public.erp_user_sessions(token_hash,user_id,expires_at) values(encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '5 minutes')",(token,user))
        rows=conn.execute("select id::text from public.driver_attendance where deleted_at is null and work_date between %s::date and %s::date+6 order by work_date desc limit 50",(week,week)).fetchall()
        body=dict(sessionToken=token,weekStart=week,attendanceIds=[row[0] for row in rows])
        def invoke(payload):
            req=urllib.request.Request(base+'/functions/v1/driver-place-lookup',data=json.dumps(payload).encode(),headers={'apikey':public_key,'Authorization':'Bearer '+public_key,'Content-Type':'application/json'},method='POST')
            try:
                with urllib.request.urlopen(req,timeout=90) as response:return response.status,json.load(response)
            except urllib.error.HTTPError as error:return error.code,json.load(error)
        status,result=invoke(body)
        if status!=200 or not result.get('ok'):raise RuntimeError('Place lookup failed: '+str(status)+' '+str(result.get('message')))
        names=[item.get(prefix,{}).get('placeName','') for item in result['items'] for prefix in ['start','end']]
        names=sorted(set(filter(None,names)))
        # Every result must be a current member of the permission-protected week.
        assert set(item['id'] for item in result['items'])<=set(body['attendanceIds'])
        denied_status,_=invoke(dict(body,sessionToken='qa-invalid-token'))
        assert denied_status==403
        with conn.transaction():
            conn.execute('update public.erp_role_permissions set can_view=false where role_id=%s',(role,))
        revoked_status,_=invoke(body)
        assert revoked_status==403,'Permissions are checked even after a successful cached lookup'
        print(json.dumps(dict(ok=True,week=week,attendanceRows=len(result['items']),matchedPlaceNames=names,partial=bool(result.get('partial')),invalidSessionRejected=True,revokedPermissionRejected=True),ensure_ascii=False))
    finally:
        with conn.transaction():
            conn.execute('delete from public.erp_users where id=%s',(user,))
            conn.execute('delete from public.erp_roles where id=%s',(role,))
        assert not conn.execute('select 1 from public.erp_users where id=%s',(user,)).fetchone()
