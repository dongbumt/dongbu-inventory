"""Validate the additive temperature-record schema and RPCs with rollback-only fixtures.
SQL is supplied on stdin; PG connection settings must come from the linked CLI.
Only --apply commits the schema. Test accounts, sessions and uploads never persist.
"""
import base64
import json
import os
import sys
import uuid

import psycopg
from psycopg.types.json import Jsonb


def main():
    if "hdwjwtmbsxfjrlvicgnn" not in os.environ.get("PGUSER", ""):
        raise RuntimeError("Wrong linked database project")
    sql = sys.stdin.buffer.read().decode("utf-8-sig")
    if "create table if not exists public.driver_temperature_records" not in sql:
        raise RuntimeError("Expected the temperature-record schema on stdin")
    apply = "--apply" in sys.argv
    conn = psycopg.connect(sslmode="require", connect_timeout=20, autocommit=True,
                           application_name="dbmt_temperature_schema_check")
    try:
        with conn.transaction(force_rollback=not apply):
            conn.execute("set local role postgres")
            conn.execute(sql)
            with conn.transaction(force_rollback=True):
                fixture_tests(conn)
        print(json.dumps({"ok": True, "schemaApplied": apply,
                          "tests": "driver ownership, ERP permission, image validation, retry idempotency, append-only, no public table access",
                          "fixturesRolledBack": True}))
    finally:
        conn.close()


def fixture_tests(conn):
    suffix = uuid.uuid4().hex[:12]

    def driver(number):
        account = conn.execute("""insert into public.driver_accounts(employee_id,employee_name,login_id,password_hash)
          values (%s,%s,%s,extensions.crypt(%s,extensions.gen_salt('bf'))) returning id""",
          ("qa_temp_" + suffix + str(number), "온도기록지 검증", "qat" + suffix + str(number), uuid.uuid4().hex)).fetchone()[0]
        token = uuid.uuid4().hex + uuid.uuid4().hex
        conn.execute("""insert into public.driver_sessions(token_hash,account_id,expires_at)
          values (encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')""", (token,account))
        return token

    token1, token2 = driver(1), driver(2)
    role = conn.execute("insert into public.erp_roles(code,name) values (%s,'온도기록지 검증') returning id", ("qat_"+suffix,)).fetchone()[0]
    conn.execute("insert into public.erp_role_permissions(role_id,menu_code,can_view) values (%s,'driver_attendance',true)", (role,))
    user = conn.execute("""insert into public.erp_users(login_id,display_name,password_hash,role_id)
      values (%s,'온도기록지 검증',extensions.crypt(%s,extensions.gen_salt('bf')),%s) returning id""", ("qat_"+suffix,uuid.uuid4().hex,role)).fetchone()[0]
    office_token = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute("""insert into public.erp_user_sessions(token_hash,user_id,expires_at)
      values (encode(extensions.digest(%s,'sha256'),'hex'),%s,now()+interval '10 minutes')""", (office_token,user))
    date = str(conn.execute("select timezone('Asia/Seoul',now())::date").fetchone()[0])
    # The API validates bounded JPEG framing. Browser tests separately decode real photos.
    image = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8" + bytes(128) + b"\xff\xd9").decode()
    payload = {"requestId": str(uuid.uuid4()), "date":date, "vehicleNo":"TEST-4245", "note":"rollback-only fixture", "image":image,"width":550,"height":1200}

    def rpc(query, params):
        with conn.transaction():
            conn.execute("set local role anon")
            value = conn.execute(query, params).fetchone()[0]
            conn.execute("set local role postgres")
            return value

    def rejected(query, params):
        try:
            rpc(query, params)
        except psycopg.Error as error:
            assert error.sqlstate in ("P0001", "42501", "22023", "22007", "22P02"), error.sqlstate
        else:
            raise AssertionError("Expected request to be rejected")

    save = "select public.dbmt_driver_save_temperature_record(%s,%s)"
    listing = "select public.dbmt_temperature_record_list(%s,%s,%s,%s,0,'TEST-4245')"
    detail = "select public.dbmt_temperature_record_image(%s,%s,%s)"
    rejected(save, ("invalid-token",Jsonb(payload)))
    saved = rpc(save, (token1,Jsonb(payload)))
    assert saved["ok"]
    assert rpc(save, (token1,Jsonb(payload)))["id"] == saved["id"]
    rejected(save, (token1,Jsonb({**payload,"vehicleNo":"CHANGED"})))
    second = rpc(save, (token1,Jsonb({**payload,"requestId":str(uuid.uuid4())})))
    assert second["id"] != saved["id"]
    own = rpc(listing, (token1,"driver",date,date))
    assert own["total"] == 2 and all("image" not in row and "image_data" not in row for row in own["rows"])
    assert rpc(listing, (token2,"driver",date,date))["total"] == 0
    rejected(detail, (token2,"driver",saved["id"]))
    assert rpc(detail, (token1,"driver",saved["id"]))["image"] == image
    assert rpc(listing, (office_token,"erp",date,date))["total"] == 2
    assert rpc(detail, (office_token,"erp",saved["id"]))["vehicle_no"] == "TEST-4245"
    rejected(listing, (token1,"erp",date,date))
    rejected(listing, ("invalid-token","erp",date,date))
    for bad in [{"image":"data:image/svg+xml;base64,PHN2Zz4="},{"width":0},{"height":16001},{"vehicleNo":""},{"image":"data:image/jpeg;base64,"+"A"*2796250}]:
        rejected(save, (token1,Jsonb({**payload,**bad,"requestId":str(uuid.uuid4())})))
    conn.execute("update public.erp_role_permissions set can_view=false where role_id=%s", (role,))
    rejected(detail, (office_token,"erp",saved["id"]))
    rejected("select count(*) from public.driver_temperature_records", ())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ": " + str(getattr(getattr(error, "diag", None), "message_primary", None) or error), file=sys.stderr)
        sys.exit(1)
