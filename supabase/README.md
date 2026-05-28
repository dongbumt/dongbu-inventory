# DBMT ERP Supabase Migration

## 1. Create core tables

Open Supabase Dashboard > SQL Editor, paste `schema-core.sql`, and run it.

This creates:

- `transactions`
- `production_entries`
- `prices`
- `change_logs`
- `app_data`
- `migration_runs`

RLS is enabled, but public read/write policies are not created yet.

## 2. Create password-checked RPC functions

After `schema-core.sql` succeeds, run these files in this order. Use a new SQL
Editor query for each file:

1. `schema-rpc-01-config.sql`
2. `schema-rpc-02a-import-transactions.sql`
3. `schema-rpc-02b-import-production.sql`
4. `schema-rpc-02c-import-prices.sql`
5. `schema-rpc-02d-import-app-data.sql`
6. `schema-rpc-03-read.sql`
7. `schema-rpc-04a-sync-transactions.sql`
8. `schema-rpc-04b-sync-production.sql`
9. `schema-rpc-04c-sync-prices.sql`

`schema-rpc.sql` contains the same setup in one file, but the split files are
easier to run safely in the Supabase dashboard.

This creates:

- `dbmt_import_transactions(password, rows)`
- `dbmt_import_production(password, rows)`
- `dbmt_import_prices(password, rows)`
- `dbmt_import_app_data(password, payload)`
- `dbmt_get_all(password)`
- `dbmt_sync_transactions(password, rows)`
- `dbmt_sync_production(password, rows)`
- `dbmt_sync_prices(password, rows)`

The tables stay protected by RLS. The browser app uses these RPC functions
instead of direct table access.

## 3. Project values

Current project URL:

```text
https://hdwjwtmbsxfjrlvicgnn.supabase.co
```

Current publishable key:

```text
sb_publishable_40Sg1P9a5KKA-2pXtzXJZA_qSXDqPZg
```

Do not store or share the database password in this repository.
