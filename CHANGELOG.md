# IEE Operations Dashboard — Changelog

## v5.4.22 (2026-03-26)

### Staffing Forecast — New System
- **`runOrderArrivalBackfill` (Step 3c)** — New backfill step runs inside every cycle. Queries `orders.orders` for `createdAt`, `orderType`, `processTime`, `orderDueDate`, `orderCompletedAt`, `orderStatusHistory`, and `isUrgent`. Writes to two new collections:
  - `backfill_order_turnaround` — one doc per order: `turnaroundHrs`, `isLate`, `daysLate`, `statusWaits` map (minutes per Waiting status)
  - `backfill_order_arrivals` — heatmap: `{dow, hour, dept}` → counts
- **GO_LIVE = 2026-02-07** — hard floor on all arrival queries. Excludes V1 migration batch (all imported orders stamped `createdAt = 2026-02-06`). Auto-purge detects and reseeds if pre-launch records are found in collection
- **Streaming cursor** — `batchSize(500)` + `for await` loop flushes every 1,000 orders. Caps memory to ~350MB vs 460MB spike with `.toArray()`
- **`maxTimeMS: 120000`** on production cursor — prevents indefinite hang
- **Department enrichment** — post-upsert step joins `backfill_kpi_segments` on `orderSerialNumber` to derive `departmentName` per order (most frequent dept seen in segments for that order)
- **`$percentile` removed** — replaced with JS-based percentile computation (`$push` values → sort → index). Required for Atlas M10 compatibility (MongoDB 6.x, `$percentile` requires 7.0+)
- **3 new server endpoints:** `/data/forecast/arrivals`, `/data/forecast/staffing`, `/data/forecast/sla-analysis` — all accept `?dept=` filter, all return `departments` list
- **`StaffingForecast.jsx`** (428 lines) — 4 tabs:
  - **Demand** — 60-day stacked area chart (Evaluation vs Translation), hour×day heatmap, day-of-week summary bar chart (Sun–Sat volume)
  - **Staffing Model** — `Required staff = ceil(avg arrivals ÷ team XpH)`. Bar chart colored red/amber/green. XpH per status table with "staff at 50 ord/hr" column
  - **SLA Analysis** — P50/P75/P90 actual turnaround by order type + process time. Recommended SLA = P75 × 1.2 rounded to nearest half-day. On-track/At-risk/Breaching badges
  - **Bottlenecks** — Waiting statuses where P75 queue wait > 4h. Full status wait time table
- **Department filter dropdown** — reloads all three data sources filtered to selected department. Active dept shown as badge in subtitle
- **`avgPerDay` fixed** — now uses 30-day rolling `countDocuments` instead of lifetime total ÷ 7

### Backfill Engine Hardening
- **Backfill watchdog** — `setInterval` every 30s checks if a run has been active > 10 minutes. Forces `backfillRunning = false` to self-recover from stuck runs without redeploy
- **`backfillStartedAt` timestamp** — set at run start, cleared on success and error, used by watchdog
- **Memory threshold raised** 300MB → 450MB for cron guard — accounts for higher RSS during order arrival seeding

### AI Assistant
- **2 new tools added:**
  - `fetch_order_demand` — arrival patterns, peak hours/days, SLA distribution, bottlenecks, recommended SLA targets
  - `fetch_staffing_model` — required staff by hour, XpH per status, peak staffing hour
- **8 new suggested questions** — replaced generic prompts with capability-showcasing examples: daily ops briefing, worker XpH drop investigation, department staffing forecast, SLA health check, bottleneck detection, performance ranking vs benchmark, QC kick-back deep dive, stuck order identification

### KPI Overview
- **Alerts & Anomalies collapsed by default** — click "▼ Show" to expand. Badge shows count with red pulse for errors, amber for warnings
- **Alerts respect active filters** — when dept/worker/status filters are active, anomaly feed evaluates only segments within that filtered set. Switching to a department shows only that department's alerts
- **Invalid hook fix** — `anomalyOpen` state moved to component top level. Previous IIFE pattern (`(() => { React.useState() })()`) caused React "invalid hook call" crash → white screen on KPI Overview

### QC Overview
- **Blank department excluded** — events with no `departmentName` are excluded from the `byDept` grouping chart and pie. Still visible in raw events table and drilldowns

### Chat / AI Conversations
- **Conversation sidebar** — saved conversations listed in left panel. Auto-saves after every assistant reply (debounced 1.2s). Click to rename, delete with confirmation
- **Per-user isolation** — conversations stored with `userId` field, `GET /ai/conversations` scoped to requesting user
- **5 new endpoints** — `GET/POST /ai/conversations`, `GET/PUT/DELETE /ai/conversations/:id`

### Report Builder
- **Saved reports scoped to userId** — `GET /reports/saved` filters to requesting user's reports. Legacy reports without userId remain visible to all

### Per-User Storage
- **`userGet(key)` / `userSet(key)` / `userDel(key)`** in `useApi.js` — all keys prefixed `iee:<userId>:` for full isolation across users on shared browser
- **KPI Users** — selected worker and active breakdown tab persisted per user via `userGet`/`userSet`

### Tour
- **Rewritten** — 18 steps, accurate `data-tour` selectors, smooth scroll-before-spotlight (350ms settle), viewport clamping, auto-flip on overflow, `iee_tour_v2_completed` storage key
- **Pills and FilterBar** now forward `...rest` props so `data-tour` anchors work correctly

### Stability
- **Gzip compression** — native `zlib`, ~85% response size reduction
- **Server-side config cache** — 5min TTL, write-through invalidation on all PUT endpoints
- **Backfill metadata cache** — 30s TTL
- **`ensureIndexes()`** at startup — adds all missing indexes including `workerUserId`, `departmentName`, compounds
- **Graceful shutdown** — SIGTERM/SIGINT handlers drain active connections

### Documentation
- **IEE Ops Dashboard User Guide** — 13-section Word document (.docx) covering all pages, key concepts (5-bucket, XpH, In-Range %), filters, role breakdown, staffing forecast explanation, AI example questions, quick tips

---

## v5.4 (2026-03-25)

### Login Fix
- **503 crash resolved** — Login, Setup, and Invite pages now handle non-JSON server responses gracefully
- **Persistent auth** — Switched from `sessionStorage` to `localStorage`
- **Client-side JWT expiration** — `isAuth()` decodes JWT payload and checks `exp` claim
- **Server health check** — Login page pings `/health` on mount, shows red banner if API is down

### Refresh Controls
- **Top bar refresh widget** — auto-refresh status, last refresh time, next refresh countdown, manual trigger button
- **`GET /backfill/next`** — new lightweight endpoint for the dashboard widget
- **Scheduler hardened** — 60s polling interval, memory safety guard at RSS > 400MB

### Dashboard Rebuild
- **KPI Overview** — median duration, week-over-week trend arrow, XpH in worker table, 5-bucket progress bar, proper chart tooltips
- **User Drill-Down** — XpH metric card, ComposedChart with volume bars + duration line, dual Y-axis
- **QC Overview** — daily QC trend stacked bar, week-over-week trend, kick-back rate with color coding
- **Queue Ops** — dynamic aging chart, legend with bucket descriptions, zero-value suppression
- **Shared** — unified tooltip style, ChartLegend component, filter reset button

### Responsive / Mobile
- Sidebar collapse with hamburger on ≤1024px screens
- Responsive metric card grid (2–7 cols), touch-friendly padding
- Sticky table headers, horizontal scroll with momentum

---

## v5.3 (2026-03-25)

### Performance
- **Global data cache** — segments, QC events, queue snapshot cached in memory
- **Queue snapshot cached in backfill** — sub-second Queue Ops load

### Data Fixes
- **QC backfill fields** — added `isFixedIt`, `isKickItBack`, `accountableName`, `orderSerialNumber`, `orderType`, `issueCustomText`
- **User backfill `v1Id`** — enables `workerUserId → department` join
- **User collection name** — fixed `user.users` → `user.user`
- **Seed schema** — flat `l0`–`l5` benchmark fields

### Auth
- **User invite flow** — SendGrid email → `/invite?token=` → auto-login. 7-day expiry

### Identity
- **Worker identity keyed by `workerUserId`** — V1 MySQL integer as canonical key with collision detection

---

## v5.2 (2026-03-25)
- React dashboard: 14 pages, IEE brand cyan light theme
- Report Builder: 7 metrics, 10 group-by, 5 chart types, CSV export
- Incremental backfill with bulkWrite, open segment recovery
- AI chatbot: 7 tools, guardrails, glossary
- Per-user dashboard layouts saved to MongoDB
- 5-bucket KPI classification + thresholds UI
- Rate limits, auth hardening, graceful shutdown
