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
29. `schema-rpc-12-driver-region-bonus.sql`
30. `schema-rpc-13-driver-default-break.sql`
31. `schema-rpc-14-driver-address-label.sql`
32. `schema-rpc-15-driver-region-from-address.sql`
33. `schema-rpc-16-driver-break-minimum.sql`
34. `schema-rpc-17a-mobile-admin-tables.sql`
35. `schema-rpc-17b-mobile-admin-login.sql`
36. `schema-rpc-17c-mobile-admin-accounts.sql`
37. `schema-rpc-17d-mobile-admin-data.sql`
38. `schema-rpc-17e-mobile-admin-driver-week.sql`
39. `schema-rpc-17f-mobile-admin-schedule-write.sql`
40. `schema-rpc-18-cold-storage-public.sql`
41. `schema-rpc-19-company-master.sql`
42. `schema-rpc-20-erp-users-roles.sql`
43. `schema-rpc-21-erp-schedule-permissions.sql`
44. `schema-rpc-22-erp-stock-adjust-permission.sql`
45. `schema-rpc-23-erp-transaction-permissions.sql`
46. `schema-rpc-24-erp-production-permissions.sql`
47. `schema-rpc-25-erp-excel-import-permissions.sql`
48. `schema-rpc-26-erp-core-write-hardening.sql`
49. `schema-rpc-27-erp-schedule-delete-fix.sql`
50. `schema-rpc-28-erp-submaterial-usage-permissions.sql`
51. `schema-rpc-29-business-partner-master.sql`
52. `schema-rpc-30-product-codes.sql`

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
- `dbmt_get_company_master(password)`
- `dbmt_save_company(password, record, expected_revision)`
- `dbmt_save_business_site(password, record, expected_revision)`
- `dbmt_save_business_site_identifier(password, record, expected_revision)`
- `dbmt_save_document_sender_profile(password, record, expected_revision)`
- `dbmt_erp_login(login_id, login_password)`
- `dbmt_erp_session(token)`
- `dbmt_erp_logout(token)`
- `dbmt_m02_get_admin(password)`
- `dbmt_m02_save_role(password, ..., permissions, expected_revision)`
- `dbmt_m02_save_user(password, ..., login_password, expected_revision)`
- `dbmt_erp_save_schedule(token, id, date, text)`
- `dbmt_erp_delete_schedule(token, id)`
- `dbmt_erp_save_stock_adjust(token, record)`
- `dbmt_erp_save_transactions(token, rows, delete_ids)`
- `dbmt_erp_save_production(token, entry, transaction_rows, replace_id)`
- `dbmt_erp_import_transactions(token, rows)`
- `dbmt_erp_save_label_product(token, record)`
- `dbmt_erp_delete_label_product(token, product_id, business_registration_no)`

The tables stay protected by RLS. The browser app uses these RPC functions
instead of direct table access.

The shared ERP password is stored only as a SHA-256 hash in
`app_config.app_password_sha256`; never put its plaintext in this repository or
browser code. Re-running `schema-rpc-01-config.sql` preserves the existing
verifier for operational compatibility. Fresh installations start with a
deliberately disabled value until an administrator stores a password hash.
Rotating legacy passwords remains strongly recommended, even though an existing
deployment may deliberately keep its current verifier.

`schema-rpc-19-company-master.sql` creates `companies`, `business_sites`,
`business_site_identifiers`, and `document_sender_profiles`. `companies` is a
database-enforced singleton: this ERP can store one legal company and cannot
create a second company. The `companies` array remains in the read response for
compatibility, but it contains at most one record; `company` is the preferred
single-record field.

One company can have any number of business sites and inventory locations.
`siteType` supports `head_office`, `office`, `factory`, `warehouse`,
`external_warehouse`, and `other`; `ownershipType` supports `owned`, `leased`,
and `third_party`. A warehouse is always an inventory location. An external
cold-storage company that holds our stock should be saved as
`external_warehouse` + `third_party` + `inventoryLocation=true`. Its own trader
master key/name may be stored in `operatorTraderKey` and `operatorName`, while
`businessRegistrationNo` may be empty for a location that is not our registered
place of business. The head office must have a business registration number.

`document_sender_profiles` separates the two fax/document sender choices from
the legal-company master. A profile can select a business site and override only
its label, reply email/fax, seal asset, and non-secret `secretAlias`. It does not
duplicate legal-company or business-registration data. Actual Barobill account
credentials stay in Edge Function secrets. The script intentionally inserts no
master data. Confirm the legal company and site details before entering them
through the ERP. Saves use the current `revision` value to reject stale browser
writes, and records are deactivated instead of physically deleted. Edge
Functions using the Supabase service role receive read-only table access.

`schema-rpc-20-erp-users-roles.sql` implements M02 personal ERP users,
roles, menu permissions, and 12-hour browser sessions. Passwords are stored as
PostgreSQL `crypt()` hashes and session tokens are stored only as SHA-256
hashes. Personal ERP passwords are exactly four numeric digits. Login IDs may
use English letters only (3-30 characters); digits and `._-` remain supported
for compatibility with previously designed IDs.
The initial rollout keeps `m02_auth_mode=optional`: legacy staff can continue
using the existing ERP app password, while a first personal administrator can
be created from the 사용자·권한 menu. Do not change this mode to enforced until
all legacy write RPCs accept and verify a personal user session.

If migrations are applied instead of the split schema files, apply
`20260813125000_password_check_fail_closed.sql` before
`20260813130000_company_master.sql`, then apply
`20260813131000_cold_storage_company_snapshot.sql`. The verified DBMT production
master is inserted separately by `20260814090000_m01_official_master_data.sql`.
Apply `20260814130000_erp_users_roles.sql` for the M02 optional personal-login
rollout. It creates the system administrator role but deliberately does not
seed a user or a known password.
Apply `20260814140000_erp_user_four_digit_pin.sql` after it to use a four-digit
numeric personal PIN. The historical `130000` migration is intentionally not
rewritten after deployment.
Apply `20260814150000_erp_schedule_permissions.sql` to enforce personal
`create`, `update`, and `delete` permissions for 일정관리. After this migration,
the generic shared-password app-data RPC cannot replace `scheduleEvents`;
desktop ERP users must be personally logged in to change schedules. The mobile
administrator keeps its independent authenticated schedule RPC.
Apply `20260814160000_erp_stock_adjust_permission.sql` to require a personal
session with the 재고현황 `update` permission for the 재고 정리 action. The ERP
uses the dedicated `dbmt_erp_save_stock_adjust` RPC and records the acting user.
Apply the next three M02 migrations in order:

1. `20260814170000_erp_transaction_permissions.sql` moves 거래내역 create,
   update, and delete writes to `dbmt_erp_save_transactions`.
2. `20260814180000_erp_production_permissions.sql` moves 생산일보 writes to the
   atomic `dbmt_erp_save_production` RPC, including linked transaction rows and
   submaterial-usage cancellation on delete.
3. `20260814190000_erp_excel_import_permissions.sql` moves the active Excel
   transaction import to `dbmt_erp_import_transactions` with the `import/create`
   permission.

These migrations revoke browser execution of the corresponding legacy
shared-password upsert, delete, full-sync, and migration RPCs. Trusted
`service_role` maintenance access is retained; never expose that key to the
browser.
Apply `20260814200000_erp_core_write_hardening.sql` after them. It prevents a
transaction writer from taking over production/stock-adjustment row IDs,
requires update permission when a deleted transaction ID is reused, and blocks
production transaction IDs that already belong to another record.
Apply `20260814210000_erp_schedule_delete_fix.sql` after it. It repairs the
schedule-delete change-log summary so authorized deletions complete normally.
Apply `20260814220000_erp_submaterial_usage_permissions.sql` last. It moves
production-linked submaterial usage saves and deletes to personal production
permissions and reserves the legacy shared-password writers for maintenance.
Apply `20260814230000_business_partner_master.sql` after it for M03. It assigns
stable partner IDs/codes, preserves renamed partner aliases, links existing
transactions and prices without rewriting their historical display names, and
moves partner create/update/deactivate actions to personal `traders`
permissions. The existing `traderInfoMap` remains a read-only compatibility
projection for older document and cold-storage consumers.

Apply `20260817090000_product_codes.sql` after M03 for the M04 product-code
registry. It assigns existing products permanent six-digit codes in their
current registration order: `1xxxxx` for beef, `2xxxxx` for pork, and `3xxxxx`
for other livestock such as lamb or poultry. New codes are issued only by the
dedicated personal-session RPC, cannot be edited, and remain reserved after a
product is deleted. The legacy shared-password app-data RPC can no longer
replace `labelProducts` after this migration.

Apply `20260818090000_product_species_details.sql` after it. It separates the
`3xxxxx` family into `가금류`, `양고기`, and `오리고기` choices while keeping
the same permanent `3xxxxx` code sequence for all three.
Apply `20260818091000_product_species_immutability.sql` after it so an issued
product cannot be changed from one species to another; register a new product
instead.

## 3. Document request delivery

The `send-document-request` Edge Function sends document requests through Daum
SMTP or Barobill Fax and writes the result to `document_request_logs`.

Set these Edge Function secrets:

```text
DAUM_SMTP_USER
DAUM_SMTP_APP_PASSWORD
DAUM_SMTP_FROM
DOCUMENT_REQUEST_PHONE
COLD_STORAGE_PUBLIC_ACCESS_SHA256
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

`COLD_STORAGE_PUBLIC_ACCESS_SHA256` is optional. When set, it is the SHA-256 hash
of an access code entered by staff on the standalone cold-storage page. When it
is absent, the operator-approved legacy no-login public workflow remains active;
the public request history/write/delete/fax surface is therefore intentionally
accepted. Never put a plaintext access code in HTML, JavaScript, URLs, or this
repository.

Each document-sender profile may use `BAROBILL_PROFILE_<ALIAS>_*` secrets, where
`<ALIAS>` is the profile's non-secret `secretAlias` in uppercase. For example,
the legacy alias `dongbu_distribution` selects
`BAROBILL_PROFILE_DONGBU_DISTRIBUTION_CERT_KEY`, `_CORP_NUM`, `_SENDER_ID`,
`_MEMBER_PASSWORD`, `_FROM_NUMBER`, and `_ENV`. Profile-scoped values take
priority. Account credentials and the outbound number may fall back to the
common `BAROBILL_*` values above because both sender profiles belong to the same
legal company. A scoped `_FROM_NUMBER` overrides the common number when a sender
needs a separate outbound identity. The alias selects a credential group; credentials themselves
must never be stored in the database. Every
profile's Barobill corporate number must match the single ERP company's legal
corporate/business identity expected by the delivery function, or fax delivery
must be rejected.

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
