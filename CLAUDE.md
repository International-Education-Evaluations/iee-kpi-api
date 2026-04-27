# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                # production server (node server.js)
npm run dev              # server with --watch (auto-reload on edit)
npm test                 # node:test runner over test/*.test.js
npm run build:client     # build React client → dist/ (served by Express)
npm install              # postinstall runs build:client automatically

# Client-only dev (Vite hot-reload on :3001, proxies API to :3000)
cd client && npm run dev

# One-time config seed (benchmarks, production hours, user levels, thresholds)
node seed-config.js <BASE_URL> <JWT_TOKEN>
```

Tests use Node's built-in `node:test` runner (zero deps). Coverage is intentionally narrow today — only `lib/validate-group-by.js` and the JWT-secret startup contract. New code should add tests next to it; existing untested code is captured as a backlog item in `AUDIT.md`. There is no linter or formatter configured.

Required env vars (server fails to start if any of the first three are missing): `MONGO_URI`, `API_KEY`, `JWT_SECRET`. Also: `CLAUDE_API_KEY`, `SENDGRID_API_KEY`, `SENDGRID_TEMPLATE_ID`, `SENDGRID_INVITE_TEMPLATE_ID`, `SENDGRID_FROM_EMAIL`. Optional `MONGO_CONFIG_URI` to put config on a separate cluster, `SETUP_SECRET` to enable first-time admin creation via `POST /auth/setup`, `BACKFILL_WATCHDOG_MIN` (default 30) to tune the stuck-backfill reset threshold. See `.env.example`. **`JWT_SECRET` must be stable across restarts** — generating a new one each deploy invalidates every active session token.

## Architecture

**Single Railway service.** One Express process serves both the JSON API and the built React SPA from `dist/`. There are exactly three top-level source files: `server.js` (6,450 lines, the entire backend), `seed-config.js` (idempotent admin seeder), and the `client/` Vite app.

### MongoDB topology — three databases, two roles

- `orders` (read-only) — V2 production data: `orders.orders`, `orders.orderStatusHistory`, `orders.order-discussion`
- `user` (read-only) — V2 staff data (note: `user.user`, singular — fixed in v5.3)
- `iee_dashboard` (read/write) — everything dashboard-owned. All config collections are prefixed `dashboard_*`; all backfilled fast-read collections are prefixed `backfill_*`.

`getDb(name)` returns a connection to production data; `getConfigDb()` returns `iee_dashboard`. They use separate `MongoClient` instances so config can live on a different cluster (`MONGO_CONFIG_URI`).

### The backfill pattern (most important thing to understand)

The dashboard does **not** query production MongoDB directly on every page load. A scheduler runs every ~60s and copies/transforms production data into `iee_dashboard.backfill_*` collections. Each request type has two endpoints:

- **Legacy/live** (`/kpi-segments`, `/qc-events`, `/queue-snapshot`, `/credential-counts`, …) — used by Google Apps Script, Bruno, Report Builder; queries production directly. Slow.
- **Fast** (`/data/kpi-segments`, `/data/qc-events`, `/data/queue-snapshot`, `/data/forecast/*`, …) — used by the dashboard; reads from `backfill_*` collections. Sub-second.

When adding a new dashboard data source, add it to the backfill cycle (search for `backfillRunning` in `server.js`) and expose a `/data/*` reader. Don't make the dashboard hit live endpoints — it will not scale.

**Backfill safety:** there's a watchdog `setInterval` that force-resets `backfillRunning = false` after 10 minutes (recovers from hung Atlas cursors without redeploy). User sync (`backfill_users`) is decoupled and runs hourly, not every cycle, because users change infrequently.

**`GO_LIVE = 2026-02-07`** is a hard floor on order arrival queries — the V1 migration batch is all stamped `createdAt = 2026-02-06` and must be excluded. Any new query against `orders.orders` historical data must respect this floor or it will count migration noise as real arrivals.

### Worker identity is fragile — read this before joining user data

There are three identifiers in flight and they don't all line up:

- `workerUserId` on segments — a **V2 ObjectId string** (e.g. `"687a5894ef7495fca0666516"`), not an integer
- `v1Id` on `dashboard_user_levels` — the V1 MySQL integer ID (canonical key for level assignments)
- `email` — the only key reliably present in both systems

`backfill_users` stores both `v1Id` and `v2Id`. To enrich a segment with department/level, the working strategy (see `client/src/hooks/useData.jsx`) is: try `v2Id` lookup for department, fall back to email; use **email** for level lookup because `dashboard_user_levels` is keyed on `v1Id` but segments don't carry `v1Id`. The level-by-v1Id map exists only for forward-compat once user-levels is migrated to v2Id.

If you write a new join, copy this pattern. Trying to key everything on a single ID will silently lose ~half the rows.

### Caching layers (invalidate carefully)

- **Server-side config cache** — `CONFIG_CACHE` Map, 5-min TTL. Every `PUT /config/*` endpoint must call `invalidateConfigCache(key)` or stale data sticks for 5 minutes.
- **Backfill metadata cache** — 30s TTL on `backfill_metadata.status`. `invalidateBackfillMeta()` is called when a run finishes.
- **Gzip middleware** — wraps `res.json`, runs before rate-limit so compressed size counts. Skips bodies under 1KB.
- **`res.set('Cache-Control', 'no-store')` on `/data/*`** — backfill reads must always be fresh for the dashboard's last-updated indicator.
- **ETags disabled globally** (`app.set('etag', false)`) — parallel paginated requests were getting 304 instead of data.

### Auth

JWT-based, three roles: `admin`, `manager`, `user`. `requireRole('admin', 'manager')` middleware on routes. Tokens live in `localStorage` (`iee_t`, `iee_u`); client decodes `exp` to pre-empt 401s. First admin is created via `POST /auth/setup` gated by `SETUP_SECRET` — once any user exists, the route is closed. Invites email a 7-day signed token via SendGrid.

Per-user browser state uses `userGet(key)`/`userSet(key)` in `useApi.js` — keys are namespaced `iee:<userId>:<key>` so multiple users on a shared browser don't collide.

### AI chatbot

`POST /ai/chat` proxies Anthropic's API and exposes ~9 tools that hit our own endpoints (`fetch_kpi_segments`, `fetch_qc_events`, `fetch_order_demand`, `fetch_staffing_model`, …). Tool implementations call `internalFetch(path)` to round-trip through our own routes (so guardrails, caching, and pagination apply uniformly). The system prompt and a `dashboard_glossary` collection are both fed into context. Tool iteration cap and other limits live in `dashboard_ai_guardrails`; conversations save to `dashboard_chat_history` per `userId`.

### Client structure

React 18 + Vite + Tailwind + Recharts + react-router-dom v6. State is `DataProvider` in `client/src/hooks/useData.jsx` — exposes `kpiSegs`, `qcEvents`, `queueSnap`, `users`, `benchmarks` and `loadKpi`/`loadQc`/`loadQueue` lazy loaders. Each loader is gated on `loadedRef` so navigating between pages doesn't refetch. `refreshAll()` resets the gates.

`vite.config.js` proxies every API path prefix to `:3000` for local dev. When adding a new server route prefix, add it to the proxy list or local dev will 404. Build outputs to `../dist` (a sibling of `client/`), which Express serves via `express.static(distPath)` plus an SPA fallback `app.get('*')` — that fallback **must remain the last route registered**.

Routes in `App.jsx` are wrapped in `AuthGuard` → optional `ManagerGuard` / `AdminGuard`. Glossary and Email require manager+; AI Guardrails, Admin Users, and Backfill require admin.

### Deployment

Railway, single service. `npm install` triggers `postinstall` → `build:client`, producing `dist/`. `npm start` runs the server. Graceful shutdown (`SIGTERM`/`SIGINT`) drains connections. The cron scheduler (`startCronScheduler`) ticks every 60s for email schedules; the backfill scheduler runs independently with an RSS memory guard (450MB ceiling) to prevent OOM on the small Railway instance.

## Conventions worth knowing

- `server.js` is organized by `═══` section banners — grep for them to navigate (`ENDPOINTS`, `5-BUCKET KPI CLASSIFICATION`, `AUTH ENDPOINTS`, `AI CHATBOT`, `DATA BACKFILL SYSTEM`, `FAST READ ENDPOINTS`, etc.). It's monolithic on purpose; resist the urge to split unless you're prepared to redo all the closures around `backfillRunning`/`userSyncRunning`/cache state.
- `CHANGELOG.md` is the running narrative for why things are the way they are — read the most recent entry before changing anything in the same area.
- `AUDIT.md` is the prioritized gap inventory (P0/P1/P2 across security, reliability, UX, structure) plus the V2 invoice schema reference. Check it before proposing improvements so you don't duplicate work or miss the next-up roadmap.
- `seed-config.js` is the source of truth for default benchmarks, production hours, 5-bucket thresholds, and L0–L5 user level assignments. Editing the constants there and re-running is the supported way to update defaults.
- The 5-bucket classification (Exclude Short / Out-of-Range Short / In-Range / Out-of-Range Long / Exclude Long) is applied in `/kpi-classify` using thresholds stored on the benchmark document (`excludeShortSec`, `inRangeMinSec`, `inRangeMaxSec`, `excludeLongSec`). Segments with no matching benchmark become `Unclassified`.
