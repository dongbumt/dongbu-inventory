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
10. `schema-rpc-05a-upsert-transactions.sql`
11. `schema-rpc-05b-delete-helpers.sql`
12. `schema-rpc-06a-upsert-production.sql`
13. `schema-rpc-06b-upsert-prices.sql`
14. `schema-rpc-07-submaterial-usage.sql`
15. `schema-rpc-08-document-requests.sql`
16. `schema-rpc-09a-driver-tables.sql`
17. `schema-rpc-09b-driver-admin.sql`
18. `schema-rpc-09c-driver-locations.sql`
19. `schema-rpc-09d-driver-login.sql`
20. `schema-rpc-09e-driver-state.sql`
21. `schema-rpc-09f-driver-clock.sql`
22. `schema-rpc-10-app-data-save-guard.sql`
23. `schema-rpc-11a-driver-flexible-tables.sql`
24. `schema-rpc-11b-driver-state.sql`
25. `schema-rpc-11c-driver-clock.sql`
26. `schema-rpc-11d-driver-events.sql`
27. `schema-rpc-11e-driver-admin-data.sql`
28. `schema-rpc-11f-driver-admin-write.sql`

`schema-rpc.sql` contains the original combined setup. Use the split files above
for the current setup and for safer execution in the Supabase dashboard.

This creates:

- `dbmt_import_transactions(password, rows)`
- `dbmt_import_production(password, rows)`
- `dbmt_import_prices(password, rows)`
- `dbmt_import_app_data(password, payload)`
- `dbmt_get_all(password)`
- `dbmt_sync_transactions(password, rows)`
- `dbmt_sync_production(password, rows)`
- `dbmt_sync_prices(password, rows)`
- `dbmt_upsert_transactions(password, rows)`
- `dbmt_delete_transaction(password, id)`
- `dbmt_delete_production(password, id)`
- `dbmt_delete_price(password, id)`
- `dbmt_upsert_production(password, rows)`
- `dbmt_upsert_prices(password, rows)`
- `dbmt_get_submaterial_usages(password)`
- `dbmt_upsert_submaterial_usages(password, rows)`
- `dbmt_delete_submaterial_usage(password, id)`
- `dbmt_get_document_request_logs(password, limit)`

The tables stay protected by RLS. The browser app uses these RPC functions
instead of direct table access.

## 3. Document request delivery

The `send-document-request` Edge Function sends document requests through Daum
SMTP or Barobill Fax and writes the result to `document_request_logs`.

Set these Edge Function secrets:

```text
DAUM_SMTP_USER
DAUM_SMTP_APP_PASSWORD
DAUM_SMTP_FROM
DOCUMENT_REQUEST_PHONE
```

Barobill Fax additionally needs:

```text
BAROBILL_ENV
BAROBILL_CERT_KEY
BAROBILL_CORP_NUM
BAROBILL_SENDER_ID
BAROBILL_MEMBER_PASSWORD
BAROBILL_FROM_NUMBER
```

Use `BAROBILL_ENV=test` until test fax delivery is verified. Change it to
`production` only after the Barobill production account and balance are ready.

## 4. Project values

Current project URL:

```text
https://hdwjwtmbsxfjrlvicgnn.supabase.co
```

Current publishable key:

```text
sb_publishable_40Sg1P9a5KKA-2pXtzXJZA_qSXDqPZg
```

Do not store or share the database password in this repository.
