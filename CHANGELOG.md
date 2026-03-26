# IEE Operations Dashboard — Changelog

## v5.4 (2026-03-25)

### Login Fix
- **503 crash resolved** — Login, Setup, and Invite pages now handle non-JSON server responses (e.g. Railway/Atlas 503 "Service Unavailable" HTML) gracefully instead of crashing with `Unexpected token 'S'`.
- **Persistent auth** — Switched from `sessionStorage` to `localStorage`. Login now survives tab close, new tabs, and browser restart.
- **Client-side JWT expiration** — `isAuth()` now decodes the JWT payload and checks the `exp` claim. Expired tokens are cleared immediately instead of waiting for a 401 on the first API call.
- **Server health check** — Login page pings `/health` on mount and shows a red "Server Unavailable" banner if the API is down, with actionable guidance.
- **Button text fix** — Sign In button text changed from `text-ink-900` to `text-white` for readability on brand cyan background.

### Refresh Controls
- **Top bar refresh widget** — All authenticated pages now show a sticky header with: auto-refresh status (enabled/paused/syncing), last refresh time + duration, next refresh countdown (live), and a "↻ Refresh" button (admin only) to trigger immediate incremental backfill.
- **`GET /backfill/next`** — New lightweight endpoint returning `isRunning`, `lastRunAt`, `nextRunAt`, `enabled`, `intervalMin` for the dashboard widget.
- **Scheduler hardened** — Polling interval reduced from 15s to 60s. Memory safety guard skips auto-backfill if RSS > 400MB.

### Dashboard Rebuild — All 4 Pages
- **KPI Overview** — Added: median duration, week-over-week volume trend arrow, XpH in worker table, percentage column in status breakdown, 5-bucket progress bar visualization, proper chart tooltips with formatters, shortened date labels (Jan 15 instead of 2026-01-15), adaptive X-axis intervals.
- **User Drill-Down** — Added: XpH metric card, median duration, ComposedChart with volume bars + avg duration line overlay, dual Y-axis labels, percentage column in status table.
- **QC Overview** — Added: daily QC trend stacked bar (Fixed vs Kick Back), week-over-week trend on total events, kick-back rate column in user table with red highlighting >20%, fix rate with color coding (green ≥80%, amber ≥50%, red <50%), custom pie labels for large slices.
- **Queue Ops** — Added: dynamic aging chart height based on row count, proper chart legend with bucket descriptions, zero-value suppression in table (grey "0" instead of bold), conditional color formatting on all aging columns.
- **All pages** — Shared tooltip style with shadow + rounded corners. Chart legends via new `ChartLegend` component. Filter reset button only shows when filters are active.

### Responsive / Mobile
- **Sidebar collapse** — Sidebar hidden on screens ≤1024px, replaced with hamburger menu. Overlay sidebar with backdrop tap-to-close.
- **Metric cards** — Responsive grid: 2 cols on mobile, 3 on sm, 4 on md, up to 7 on xl. Touch-friendly padding.
- **Tables** — Sticky headers on scroll. Reduced padding on mobile. Horizontal scroll with momentum.
- **Filter bars** — Flexible wrapping, smaller touch targets on mobile.
- **Top bar** — Responsive padding, hamburger toggle on mobile.
- **Pills** — Horizontal scroll overflow for narrow screens.

### Shared Components
- **UI.jsx** — New: `fmtDur()` (human-readable duration), `fmtHrs()`, `MiniStat`, `ChartLegend`, `TOOLTIP_STYLE`. Enhanced `Card` with trend arrows and icon slot.
- **DashboardGrid** — Tighter margins (10px vs 12px), responsive widget title bar.

### Dev Experience
- **Vite proxy complete** — Added all missing API paths (`/data`, `/backfill`, `/reports`, `/user`, `/email`, `/glossary`, `/kpi-classify`, `/credential-counts`, `/report-counts`, `/qc-orders`, `/qc-discovery`, `/indexes`, `/collections`) to the Vite dev server proxy. No more 404s in local dev.

---

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
