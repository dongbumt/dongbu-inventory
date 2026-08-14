"""Atomically rotate and verify the ERP application-password verifier.

The new password is read from stdin and is never accepted as a command-line
argument. Database connection values are inherited through the temporary PG*
environment created by rotate-erp-password.ps1.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import psycopg


def main() -> int:
    new_password = sys.stdin.read().rstrip("\r\n")
    if not new_password:
        raise RuntimeError("새 비밀번호 입력을 받지 못했습니다.")

    required = ("PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"DB 연결정보가 없습니다: {', '.join(missing)}")

    project_ref = os.environ.get("DBMT_PROJECT_REF", "").strip()
    if project_ref and project_ref not in os.environ["PGUSER"]:
        raise RuntimeError("연결된 Supabase 프로젝트가 DBMT ERP 운영 프로젝트와 다릅니다.")

    verifier = hashlib.sha256(new_password.encode("utf-8")).hexdigest()
    connection = psycopg.connect(
        host=os.environ["PGHOST"],
        port=int(os.environ["PGPORT"]),
        user=os.environ["PGUSER"],
        password=os.environ["PGPASSWORD"],
        dbname=os.environ["PGDATABASE"],
        sslmode="require",
        connect_timeout=20,
        application_name="dbmt_password_rotation",
    )

    try:
        with connection.transaction():
            connection.execute("set transaction isolation level serializable")
            connection.execute("set role postgres")
            connection.execute(
                """
                insert into public.app_config(key, value, updated_at)
                values ('app_password_sha256', %s, now())
                on conflict (key) do update
                set value = excluded.value, updated_at = excluded.updated_at
                """,
                (verifier,),
            )

            password_ok = connection.execute(
                "select public.dbmt_check_password(%s)", (new_password,)
            ).fetchone()[0]
            wrong_password_ok = connection.execute(
                "select public.dbmt_check_password(%s)", (new_password + "!",)
            ).fetchone()[0]
            core_rpc_ok = connection.execute(
                "select jsonb_typeof(public.dbmt_get_all(%s)) = 'object'",
                (new_password,),
            ).fetchone()[0]
            if password_ok is not True or wrong_password_ok is not False or core_rpc_ok is not True:
                raise RuntimeError("새 비밀번호의 서버 검증에 실패해 변경을 취소했습니다.")
    finally:
        connection.close()
        new_password = ""

    print(json.dumps({
        "ok": True,
        "projectRef": project_ref,
        "passwordCheck": "passed",
        "coreRpcCheck": "passed",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"비밀번호 변경 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
