"""Verify hashes and row counts in a DBMT Supabase JSONL backup."""

from __future__ import annotations

import gzip
import hashlib
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify_supabase_backup.py BACKUP_DIRECTORY", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    verified_rows = 0
    for item in manifest.get("tables", []):
        path = root / item["file"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            rows = sum(1 for _ in stream)
        if digest != item["sha256"]:
            raise RuntimeError(f"SHA-256 mismatch: {item['table']}")
        if rows != item["rows"]:
            raise RuntimeError(f"row-count mismatch: {item['table']}")
        verified_rows += rows
    print(json.dumps({
        "verifiedTables": len(manifest.get("tables", [])),
        "verifiedRows": verified_rows,
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest().upper(),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
