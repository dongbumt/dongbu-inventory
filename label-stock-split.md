# Production Output Grouping After PDA Processing

`출력 라벨로 생산품 분할` groups existing issued labels into separate output
rows of the same completed production entry. It does not divide a physical box,
issue new barcodes, undo shipments, or add inventory. Physical weight splitting
remains a separate feature documented in `label-weight-split.md`.

## PDA Compatibility

PDA receipt, shipment (including a shipment before production completion), and
return records do not by themselves block output grouping. Selected packages
keep their barcode, weight, location, state, and immutable label snapshot. Their
original production-row attribution and associated active transaction/cost links
move together. A returned box retains its separate inbound source. Relocated
package revisions increase, requiring any previously queued PDA scan to refresh.

The original input postings, unrelated output rows, sales prices, transaction
identities, and total production weight remain unchanged. Existing cost-edit
and shipment-cancellation logic follows the relocated package. ERP receives
current linked PDA transactions only when the operator has transaction-view
permission, and merges them without duplication.

Unattributed manual stock movements, production use, work-order reservations,
inconsistent label mappings, and physical weight-split descendants remain
protected. These require a separate reconciliation rather than guessing which
barcodes were consumed.

## Authorization and Atomicity

Existing production view/update permissions and split request idempotency apply.
The private `label_stock_private.pda_split_context` has RLS enabled and no client
grants. Its transaction-scoped capability is created only by the authenticated
split path, consumed by narrow production/transaction guards, then removed.
Failed audit writes roll back journal grouping, package revisions, stock sources,
and shipment links together. No installation-time business rows are changed.

The added private table intentionally has no RLS policies because clients have
no access. See [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
and [database functions](https://supabase.com/docs/guides/database/functions).

## Verification

Migration: `supabase/migrations/20261113071720_label_stock_split_pda_links.sql`.
`tools/check-label-pda-split-db.py` runs real RPCs inside rolled-back transactions,
including pending/completed shipments, shipped-label selection, warehouse returns,
repeated grouping, cost corrections, cancellation, stale scans, permissions,
idempotency, audit failure, and ordinary grouping/physical-split regressions.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-pda-receipts-db.ps1 -TestScript check-label-pda-split-db.py
```

Set `DBMT_LABEL_PDA_SPLIT_DEPLOYED=1` to test the installed migration without DDL.
The test always rolls back fictional production, stock, credentials and settings.
Browser coverage is in `tools/test-label-stock-split.cjs`.
