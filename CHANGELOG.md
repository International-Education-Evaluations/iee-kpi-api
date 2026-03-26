# IEE Operations Dashboard — Changelog

## v5.3 (2026-03-25)

### Performance
- **Global data cache** — KPI segments, QC events, and queue snapshot load once and persist in memory across page navigations. Switching between KPI Overview, User Drill-Down, QC Overview, and Queue Ops is now instant (no re-fetch).
- **Queue snapshot cached in backfill** — Queue Ops now reads from `backfill_queue_snapshot` (updated every 5 min) instead of hitting production MongoDB on every page visit. Sub-second load.

### Data Fixes
- **QC backfill fields** — Added `isFixedIt` (boolean), `isKickItBack` (boolean), `accountableName`, `orderSerialNumber`, `orderType`, `issueCustomText` to backfill QC documents. Both incremental and full refresh paths. QC Overview now shows Fixed It / Kick Back counts, order counts, and user counts correctly.
- **User backfill v1Id** — `backfill_users` now stores `v1Id` from MongoDB `user.user` collection, enabling the `workerUserId → department` join for KPI classification.
- **User collection name** — Fixed `user.users` (plural, wrong) → `user.user` (singular, correct) in backfill. Users: 0 bug resolved.
- **Seed schema** — Benchmarks and production hours now use flat `l0`–`l5` fields matching the UI and PUT endpoint schema. Previously nested `{ levels: { L0: ... } }` caused all values to show as dashes.
- **Department field** — Settings > User Levels now reads `u.department` (matching `/users` API) instead of `u.departmentName`.

### UI/UX
- **Grid layout locked** — Widgets cannot be dragged or resized unless "Customize Layout" is clicked. Fixed `onLayoutChange` firing when `editing=false`.
- **QC Event Log table** — New widget on QC Overview showing the 200 most recent events with columns: Date, Order (clickable), Outcome (badge), Accountable User, Department, Issue, Reporter, Type.
- **Queue Ops cached label** — Shows "(cached)" with timestamp, or "(live)" when force-refreshed. "Force Live Refresh" button available for on-demand data.

### Auth
- **User invite flow** — Admin creates user with `sendInvite: true` → system emails invite link via SendGrid → user sets password at `/invite?token=...` → auto-login. 7-day expiry, resend support.
- **Accept-invite public endpoint** — `POST /auth/accept-invite` added to auth bypass list.

### API
- **`POST /config/user-levels/seed`** — Bulk seed user levels by V1 ID.
- **`POST /config/benchmarks/thresholds/seed`** — Bulk seed 5-bucket thresholds.
- **`GET /data/queue-snapshot`** — Fast-read cached queue snapshot from backfill.
- **`workerUserId` filter** — Added to `GET /data/kpi-segments` query params.
- **Classification endpoint** — Now resolves user levels by `v1Id` first (then email fallback), and adds `departmentName` to classified segments.

### Identity
- **Worker identity keyed by `workerUserId`** — All KPI pages use V1 MySQL user ID as canonical key instead of `workerEmail`. `disambiguateWorkers()` resolves `workerUserId → workerEmail → workerName` with collision detection.

---

## v5.2 (2026-03-25)
- React dashboard: 14 pages with light theme (IEE brand cyan)
- react-grid-layout v2 on KPI Overview, User Drill-Down, QC Overview, Queue Ops
- Report Builder with 7 metrics, 10 group-by options, 5 chart types, CSV export
- Incremental backfill with bulkWrite, open segment recovery, monthly batched full refresh
- User invite system with SendGrid email
- AI chatbot with 7 tools, guardrails, glossary
- Per-user customizable dashboard layouts saved to MongoDB
- Dual MongoDB connections (read-only prod + readWrite config)
- 5-bucket KPI classification + thresholds UI
- Security hardening (rate limits, auth, graceful shutdown)
