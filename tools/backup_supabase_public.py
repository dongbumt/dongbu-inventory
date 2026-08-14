"""Create a read-only, restorable snapshot of the linked ERP public schema.

Connection secrets are read only from PG* environment variables.  The script
never writes to the database: it opens a read-only transaction, exports every
ordinary/partitioned table as gzip-compressed JSON Lines, and records schema
catalog metadata needed to audit or reconstruct the snapshot.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql


def json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return {"encoding": "hex", "value": value.hex()}
    return str(value)


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, default=json_default) + "\n",
        encoding="utf-8",
    )


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def rows_as_dicts(cursor: psycopg.Cursor[Any]) -> list[dict[str, Any]]:
    columns = [column.name for column in cursor.description or []]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def query_dicts(connection: psycopg.Connection[Any], statement: str) -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(statement)
        return rows_as_dicts(cursor)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: backup_supabase_public.py OUTPUT_DIRECTORY", file=sys.stderr)
        return 2

    required = ("PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(f"missing connection environment variables: {', '.join(missing)}", file=sys.stderr)
        return 2

    output = Path(sys.argv[1]).resolve()
    data_dir = output / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    connection = psycopg.connect(
        host=os.environ["PGHOST"],
        port=int(os.environ["PGPORT"]),
        user=os.environ["PGUSER"],
        password=os.environ["PGPASSWORD"],
        dbname=os.environ["PGDATABASE"],
        sslmode="require",
        connect_timeout=20,
        application_name="dbmt_read_only_backup",
    )

    manifest: dict[str, Any] = {
        "format": "dbmt-public-jsonl-v1",
        "createdAt": datetime.now().astimezone().isoformat(),
        "databaseHost": os.environ["PGHOST"],
        "databaseName": os.environ["PGDATABASE"],
        "transactionMode": "read only, repeatable read",
        "tables": [],
    }

    try:
        with connection.transaction():
            # Supabase CLI login roles are intentionally narrow.  The linked
            # project ticket permits SET ROLE postgres, which is also how the
            # official `supabase db dump` command reads protected tables.
            connection.execute("set transaction isolation level repeatable read read only")
            connection.execute("set role postgres")
            manifest["serverVersion"] = connection.execute("show server_version").fetchone()[0]
            tables = query_dicts(
                connection,
                """
                select n.nspname as schema_name, c.relname as table_name
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r', 'p')
                order by c.relname
                """,
            )

            for table in tables:
                schema_name = table["schema_name"]
                table_name = table["table_name"]
                target = data_dir / f"{safe_name(schema_name)}.{safe_name(table_name)}.jsonl.gz"
                row_count = 0
                with connection.cursor(name=f"backup_{safe_name(table_name)[:40]}") as cursor:
                    cursor.itersize = 1000
                    cursor.execute(
                        sql.SQL("select row_to_json(t)::text from {}.{} t").format(
                            sql.Identifier(schema_name), sql.Identifier(table_name)
                        )
                    )
                    with gzip.open(target, "wt", encoding="utf-8", newline="\n") as stream:
                        for row in cursor:
                            stream.write(row[0])
                            stream.write("\n")
                            row_count += 1
                manifest["tables"].append(
                    {
                        "schema": schema_name,
                        "table": table_name,
                        "rows": row_count,
                        "file": str(target.relative_to(output)).replace("\\", "/"),
                        "bytes": target.stat().st_size,
                        "sha256": sha256_file(target),
                    }
                )

            catalog = {
                "columns": query_dicts(
                    connection,
                    """
                    select n.nspname as schema_name, c.relname as table_name,
                           a.attnum as ordinal_position, a.attname as column_name,
                           pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
                           a.attnotnull as not_null,
                           pg_get_expr(ad.adbin, ad.adrelid) as column_default
                    from pg_attribute a
                    join pg_class c on c.oid = a.attrelid
                    join pg_namespace n on n.oid = c.relnamespace
                    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
                    where n.nspname = 'public' and c.relkind in ('r', 'p')
                      and a.attnum > 0 and not a.attisdropped
                    order by c.relname, a.attnum
                    """,
                ),
                "constraints": query_dicts(
                    connection,
                    """
                    select n.nspname as schema_name, c.relname as table_name,
                           con.conname as constraint_name, con.contype as constraint_type,
                           pg_get_constraintdef(con.oid, true) as definition
                    from pg_constraint con
                    join pg_class c on c.oid = con.conrelid
                    join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public'
                    order by c.relname, con.conname
                    """,
                ),
                "indexes": query_dicts(
                    connection,
                    """
                    select schemaname as schema_name, tablename as table_name,
                           indexname as index_name, indexdef as definition
                    from pg_indexes where schemaname = 'public'
                    order by tablename, indexname
                    """,
                ),
                "functions": query_dicts(
                    connection,
                    """
                    select n.nspname as schema_name, p.proname as function_name,
                           pg_get_function_identity_arguments(p.oid) as arguments,
                           pg_get_functiondef(p.oid) as definition
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                    order by p.proname, arguments
                    """,
                ),
                "triggers": query_dicts(
                    connection,
                    """
                    select n.nspname as schema_name, c.relname as table_name,
                           t.tgname as trigger_name, pg_get_triggerdef(t.oid, true) as definition
                    from pg_trigger t
                    join pg_class c on c.oid = t.tgrelid
                    join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and not t.tgisinternal
                    order by c.relname, t.tgname
                    """,
                ),
                "policies": query_dicts(
                    connection,
                    """
                    select schemaname as schema_name, tablename as table_name,
                           policyname as policy_name, permissive, roles, cmd, qual, with_check
                    from pg_policies where schemaname = 'public'
                    order by tablename, policyname
                    """,
                ),
                "sequences": query_dicts(
                    connection,
                    """
                    select schemaname as schema_name, sequencename as sequence_name,
                           start_value, min_value, max_value, increment_by, cycle, cache_size,
                           last_value
                    from pg_sequences where schemaname = 'public'
                    order by sequencename
                    """,
                ),
            }
            write_json(output / "schema-catalog.json", catalog)

            try:
                migrations = query_dicts(
                    connection,
                    """
                    select * from supabase_migrations.schema_migrations
                    order by version
                    """,
                )
            except psycopg.Error as error:
                migrations = [{"warning": str(error)}]
            write_json(output / "migration-history.json", migrations)

        write_json(output / "manifest.json", manifest)
    finally:
        connection.close()

    print(json.dumps({
        "output": str(output),
        "tableCount": len(manifest["tables"]),
        "totalRows": sum(row["rows"] for row in manifest["tables"]),
        "manifestSha256": sha256_file(output / "manifest.json"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
