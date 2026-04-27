# IEE Operations Dashboard — Comprehensive Audit

Snapshot date: 2026-04-27. Code version: package.json v5.4.22. Audit covers `server.js` (6,450 lines), `client/` (React + Vite, 14 pages, ~13k LOC), `seed-config.js`, env/build config, and integration with the V2 production system.

Severity scale:
- **P0** — correctness, data loss, security, or breaks user sessions
- **P1** — high-value reliability / UX / performance wins
- **P2** — polish, code health, deferred improvements

---

## 1. Executive summary

> Items 1-5 below were the original P0s; items 1-4 shipped in PR #1. PR #2 ships §6.5 metric-correctness fixes and the `/diag/*` auth bypass fix.

1. **Auth is fragile in two places.** `JWT_SECRET` silently regenerates a new random secret per process when the env var is missing (`server.js:52`), invalidating sessions on every restart. And `/auth/login` (`server.js:1891`) writes nothing to `dashboard_audit_log`, so credential stuffing leaves no trail. Both are P0. **Both fixed in PR #1.**
2. **`/reports/query` has a NoSQL field-name injection vector** at `server.js:5291` — `default: return '$' + gb` blindly interpolates user-supplied `groupBy` strings into a `$group` aggregation. P0. **Fixed in PR #1 via `lib/validate-group-by.js` allowlist.**
3. **The backfill watchdog can silently truncate runs** (`server.js:3642-3654`). 10-minute hard reset fires with only a `console.error`, no audit log, no `/health` surfacing. A legitimately long cold-start backfill produces incomplete data with no operator visibility. P0. **Fixed in PR #1 — 30-min default + audit row + `/health` surfacing.**
4. **Zero React error boundaries** in `client/src/`. A render error in any page unmounts the entire app and shows a blank screen with no recovery path. P0. **Fixed in PR #1 via `client/src/components/ErrorBoundary.jsx`.**
5. **Per-worker XpH was mathematically incoherent** for any worker whose segments mixed unit types (Orders, Reports, Credentials). The summary card summed heterogeneous units and labeled them with the first non-Orders unit found. **Fixed in PR #2 — see §6.5.**
6. **145-hour segments inflated Avg / Median / Total Hours / XpH** because chain-break gaps in `orderStatusHistory` produced segments spanning many missing transitions. The 5-bucket classifier already labeled these "Excl Long" but only used the label for In-Range %. **Fixed in PR #2 — central-tendency aggregations now apply the same exclusion.**
7. **No tests, no lint, no CI, no README** — and `server.js` (6,450 lines) is one closure with shared mutable state (`backfillRunning`, `CONFIG_CACHE`) that makes refactor expensive. The dashboard ships, but every change risks regression. P1 across the board. (Tests started in PR #1, expanded in PR #2.)

---

## 2. Backend — `server.js`

### 2.1 Security

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| B-S1 | **P0** | `server.js:52` | `JWT_SECRET: process.env.JWT_SECRET \|\| crypto.randomBytes(32)` silently auto-generates per-process secret. Tokens invalidate on every Railway restart. Either intentional and undocumented, or a hidden bug — should fail-fast. |
| B-S2 | **P0** | `server.js:5291` | `/reports/query` `buildGroupKey` `default: return '$' + gb` accepts arbitrary user input as a MongoDB field reference. NoSQL injection vector. Replace with allowlist. |
| B-S3 | **P0** | `server.js:1891` | `POST /auth/login` does not call `auditLog()` on success or failure. No detection of credential stuffing / brute force. |
| B-S4 | P1 | `server.js:115` | Global rate limit 60/min only. `/reports/query` (expensive aggregation) and `/data/forecast/*` get the same allowance as cheap reads. AI chat has separate 10/min. Add per-endpoint limits for expensive paths. |
| B-S5 | P1 | `server.js:2076` | Password creation requires only ≥6 chars. No complexity, no breach-list check, no lockout on repeated failures. |
| B-S6 | P1 | `server.js:75-93` | CORS allows `*.up.railway.app` and any `localhost`. Any compromised Railway preview branch can hit production API. Tighten in production. |
| B-S7 | P1 | 100+ sites | Error responses pattern `res.status(500).json({ error: err.message })` leaks Mongo internals, collection names, stack details. Wrap in env-aware sanitizer. |
| B-S8 | P2 | `server.js:66` | `helmet()` default config. No explicit CSP for the SPA. |
| B-S9 | P2 | `server.js:1860,1986,2086,2194` | bcrypt 12 rounds is acceptable. No account lockout on N failed logins. |
| B-S10 | P2 | `server.js:1877` | `/auth/setup` audits as `'system_setup'` rather than the requestor identity. |

### 2.2 Reliability / correctness

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| B-R1 | **P0** | `server.js:3642-3654` | Watchdog 10-min reset can fire on legitimately long backfill (cold start, large `runOrderArrivalBackfill`). Silent data truncation. Surface in `/health`, write audit row, raise default to 30 min, make configurable. |
| B-R2 | P1 | `server.js:6305` + `server.js:6436` | **Two graceful shutdown handlers registered.** `gracefulShutdown` (drains 15s, closes connections) and `shutdown` (closes connections, no drain) both register `SIGTERM`/`SIGINT` listeners. Both fire on signal — non-deterministic teardown. |
| B-R3 | P1 | `server.js:3645,6343,3654` | `setInterval` handles for watchdog (30s) and cron scheduler (60s) are never stored or cleared on shutdown. Minor leak between `_httpServer.close` and `process.exit`. |
| B-R4 | P1 | `server.js:3661,3673` | User sync runs hourly, decoupled from backfill cycle. On boot, a startup user sync is forced at 8s post-listen (`server.js:6284`). If first backfill cycle fires before that completes, segments enrich with stale or missing department names. |
| B-R5 | P1 | `server.js:355-369` | Config cache is server-local. No coordination across multiple Railway instances if scaled out. PUT on instance A doesn't invalidate instance B. (Single-instance deploy today, but pin this risk.) |
| B-R6 | P1 | `server.js:97-113` | Gzip middleware allocates a Buffer per response in-memory. On 5–10MB JSON payloads (kpi-segments page) under high concurrency, RSS spikes are real. Streaming gzip would be cheaper. |
| B-R7 | P1 | `server.js:5337` | `/reports/query` aggregation has `$limit: Math.min(limit \|\| 200, 1000)` after `$group` — but `$match` is unbounded and `$group` materializes all groups before limit. A wide filter (no department, full date range) materializes everything. |
| B-R8 | P1 | `server.js:6350` | Cron timezone hardcoded to `America/New_York`. DST transitions / non-EST ops break silently. |
| B-R9 | P2 | `server.js:318-348` | Mongo pool: 10 prod / 5 config. No backpressure logging when pool is exhausted under burst load. |
| B-R10 | P2 | `server.js:451+` | Several `.toArray()` calls on production reads (vs. the streaming cursor used in `runOrderArrivalBackfill`). Inconsistent — small collections fine, but the pattern isn't applied consistently when migrating to larger sets. |

### 2.3 Performance

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| B-P1 | P1 | `server.js:398-446` | `ensureIndexes()` covers `backfill_kpi_segments`, `backfill_qc_events`, `backfill_users`. Other backfill collections (`backfill_order_turnaround`, `backfill_order_arrivals`, `dashboard_chat_history`, `dashboard_audit_log`) have no explicit indexes. Audit-log queries grow unbounded. |
| B-P2 | P1 | `server.js:5331` | `/reports/query` $match uses arbitrary user filters; only the leading filter benefits from compound indexes. Expensive cross-cuts (department + errorType + date) have no good index. |
| B-P3 | P1 | `server.js:2406+` | AI chat tools call `internalFetch` per tool invocation. No memoization across iterations of the same conversation turn — `fetch_kpi_summary` called twice in one tool sequence pays full cost twice. |
| B-P4 | P2 | `server.js:355` | Config cache stores raw arrays (~500KB benchmarks). Acceptable today; revisit if benchmarks grow. |

### 2.4 Code structure

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| B-C1 | P1 | `server.js` whole file | 6,450 lines. Natural seams: utility helpers (1-200), DB/cache (300-450), auth middleware (600-680), endpoints by domain (700-3000), config CRUD (3100-3500), AI (2400-3080), backfill (3600-5100), fast reads (4844-5872), reports (5142-5500), email cron (6336+), shutdown. Extracting into modules requires plumbing the shared closure (`backfillRunning`, `CONFIG_CACHE`, `client`). High value, high effort. |
| B-C2 | P2 | many | `getCutoff(days)` called 15+ times — fine, already shared. But name/department enrichment (e.g. `[u.firstName, u.lastName].filter(Boolean).join(' ')`) duplicated 5+ times. |
| B-C3 | P2 | `server.js:5272-5315` | `buildGroupKey` and `buildMetricAccumulator` are deeply nested switches inside the route handler. Extract to module-level for testability. |
| B-C4 | P2 | header `server.js:1` | Top-of-file header comments still say "v4.2" while package.json is 5.4.22 and CHANGELOG tracks 5.4.x. Stale by a major version. |
| B-C5 | P2 | `server.js:62-63,52-58` | Config validation is inconsistent: `MONGO_URI` and `API_KEY` fail-fast, but `JWT_SECRET`/`CLAUDE_API_KEY`/`SENDGRID_API_KEY` silently fall back. Standardize startup validation. |

### 2.5 Operational

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| B-O1 | P1 | everywhere | All logging is `console.log`/`console.error` text. No structured JSON, no log levels, no request IDs in messages. Searching Railway logs requires regex grep. |
| B-O2 | P1 | `server.js:700-708` | `/health` checks production Mongo only. Doesn't verify config DB, backfill freshness, or report cache stats. Add `lastBackfillAt`, `lastWatchdogResetAt`, `cacheHitRate`. |
| B-O3 | P1 | `server.js:3649` | `[WATCHDOG] Backfill stuck` log line is the *only* signal that a stuck run was force-reset. No alert delivery (no Slack/email/Sentry). |
| B-O4 | P2 | `server.js:6448-6451` | `uncaughtException` handler logs and exits, but doesn't notify ops. |

### 2.6 Audit log coverage

`auditLog()` (`server.js:3098`) is wired to:
- ✅ Most `PUT /config/*` endpoints (benchmarks, production-hours, user-levels, thresholds)
- ✅ User CRUD (`/auth/users` POST, PUT, DELETE)
- ✅ API key regeneration
- ✅ AI guardrails / system prompt changes
- ❌ `/auth/login` (P0 — see B-S3)
- ❌ `/auth/accept-invite` and `/auth/resend-invite`
- ❌ Backfill manual triggers (`/backfill/run`)
- ❌ Watchdog auto-reset (P0 — see B-R1)
- ❌ AI chat conversations (only saved to `dashboard_chat_history`, not audit log)
- ❌ Report exports (no row indicating who exported what data)

---

## 3. Frontend — `client/`

### 3.1 Code quality / structure

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| F-C1 | **P0** | `client/src/` (no occurrences) | Zero `ErrorBoundary` usage. Render error → whole-app unmount → blank screen. |
| F-C2 | P1 | `client/src/pages/ReportBuilder.jsx` (689 lines) | Mixes config UI, aggregation, chart rendering, export in one component. Split: ConfigPanel / Renderer / Export. |
| F-C3 | P1 | `client/src/pages/StaffingForecast.jsx` (634 lines) | Similar — split forecast model, SLA panel, shift analyzer. |
| F-C4 | P1 | `client/src/pages/SettingsPage.jsx:20-72` | `ConfigTable` is a generic CRUD pattern declared inline. Used implicitly across 5+ admin tables. Extract as a reusable component + hook. |
| F-C5 | P1 | KPIOverview/KPIUsers | `classifySegment` and worker disambiguation logic duplicated. Extract `useKpiClassification` hook + a pure `classifySegment(segment, benchmarks)` util. |
| F-C6 | P2 | `client/src/hooks/useData.jsx` | DataProvider eagerly preps `loadKpi`/`loadQc`/`loadQueue` — any page entering AuthGuard triggers them. Pages like ChatPage, AdminUsers, BackfillPage don't need this data; lazy per-page would speed first paint. |
| F-C7 | P2 | many pages | `alert()` and native `confirm()` used for confirmations and errors (AdminUsers, ChatPage, ReportBuilder, GlossaryPage, EmailPage). No central toast/notification system. |

### 3.2 UI/UX

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| F-U1 | P1 | sitewide | Zero ARIA attributes. `role`, `aria-label`, `aria-modal`, `aria-sort` etc. are absent. Tour modal lacks focus trap. WCAG 2.1 AA noncompliant. |
| F-U2 | P1 | `client/src/components/Tour.jsx` | Tour tour is documented as 18 steps but coverage of newer pages (StaffingForecast added v5.4.22, ReportBuilder, GuardrailsPage, EmailPage) is thin. Verify `data-tour` selectors still hit. |
| F-U3 | P2 | sitewide | Inconsistent loading patterns: SettingsPage uses `Skel` skeleton, KPIOverview uses inline `loading ? <div>`, others show blank. Unify around one `<LoadingState>`/`<EmptyState>`. |
| F-U4 | P2 | sitewide | Mobile responsiveness uneven. Sidebar collapse exists, but tables, filter bars, and modals overflow on phones. `xl:grid-cols-[320px_1fr]` falls to single col but config panels get dense. |
| F-U5 | P2 | `client/src/components/UI.jsx` | Two parallel "stat card" implementations (Card vs ad-hoc) and inconsistent button color usage (`brand-500` vs `emerald-600` vs `slate-700`). No `<Button variant>` primitive. |

### 3.3 Performance

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| F-P1 | P1 | `client/vite.config.js` | No code splitting. All 14 pages + recharts + react-markdown + react-grid-layout in one bundle. `React.lazy()` for ChatPage, ReportBuilder, StaffingForecast, BackfillPage would meaningfully reduce TTI. |
| F-P2 | P2 | `client/src/pages/KPIUsers.jsx` | `workers` derivation lacks `useMemo` (the equivalent in KPIOverview uses it). |
| F-P3 | P2 | Recharts everywhere | Charts re-render on every parent state change. Wrap chart containers in `React.memo` keyed on data slice. |
| F-P4 | P2 | `client/src/hooks/useData.jsx:73` | Parallel page fetch is good, but `cb=Date.now()` cache-buster runs on every load — would benefit from `If-None-Match`/`ETag` if server preserved them (currently disabled in `server.js:67`). |

### 3.4 Security

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| F-S1 | **P0** | `client/src/pages/ChatPage.jsx:262` | `<ReactMarkdown>{m.content}</ReactMarkdown>` without explicit `skipHtml` or `urlTransform`. Default v9 behavior is safe, but a future contributor could enable `rehype-raw` and reintroduce XSS. AI tool output is technically influenced by admin-supplied glossary content. |
| F-S2 | P1 | `client/src/hooks/useApi.js:6-9` | JWT in `localStorage`. Standard tradeoff; accessible to any XSS. Move to httpOnly cookie if XSS surface grows. |
| F-S3 | P2 | none | No client-side CSP enforcement. Only the helmet default headers. |

---

## 4. Cross-cutting

### 4.1 Documentation

- ✅ `CLAUDE.md` (added this session)
- ✅ `CHANGELOG.md` — running narrative
- ❌ No README — onboarding starts from zero
- ❌ No API contract docs / OpenAPI spec / Postman collection
- ❌ `.env.example` is terse and slightly stale (`v5.0` header)

### 4.2 Build / deploy / CI

- ❌ No `.github/workflows/`, no GitLab CI, no Makefile
- ❌ No pre-commit hooks
- ❌ No linter (ESLint), no formatter (Prettier)
- ❌ No test runner
- ✅ Railway single-service deploy with `postinstall → build:client`
- ❌ No blue/green or staged rollout strategy documented

### 4.3 Version drift

| Source | Version |
|--------|---------|
| `package.json` | 5.4.22 |
| `client/package.json` | 5.4.22 |
| `CHANGELOG.md` | 5.4.22 |
| `server.js:1` header | "v4.2" — **stale by 1 major** |
| `server.js:6177` startup log | "v5.0" — stale |
| `.env.example:2` | "v5.0" — stale |

Cosmetic, but a maintenance signal.

### 4.4 Schema / contract coupling

- Client–server contracts are implicit. `useData.jsx` decodes `{ segments, totalPages }`, `{ benchmarks: [{ status, xphUnit }] }`, `{ events, totalPages }`, etc. with no schema validation.
- Any rename on the server breaks the client silently.
- No OpenAPI spec, no JSON Schema, no TypeScript shared types (project is plain JS on both sides).
- Server returns dates as ISO strings inconsistently — some endpoints stringify on output, others rely on Mongo's `toJSON` of `Date`. Client parses defensively in places, naively in others.

### 4.5 AI guardrail coverage

- AI chat has **no access** to invoice/billing/payment data today. By default safe.
- Guardrails (`dashboard_ai_guardrails`) gate `maxDays`, `maxPageSize`, `maxToolIterations`. They do **not** redact PII (customer email, phone) from tool outputs — when invoice/billing tools are added, must redact customer-identifying fields by default.
- `dashboard_chat_history` stores full conversation transcripts indefinitely. No retention policy.

### 4.6 Multi-tenancy / i18n

- Single-tenant. JWT has no tenant id; `iee_dashboard` is a global config DB.
- No i18n. All UI strings hardcoded English. Server error messages also English.
- Effort to add multi-tenancy: medium (tenant id in JWT + scoped queries). Effort to add i18n: medium (`react-i18next` + extract strings).

---

## 5. V2 Invoice schema reference

Source: `/Users/andrew/Code/IEE/iee_v2/apps/api-payment/src/invoice/`. Use this as input to a future invoice-tracking plan.

### Entity (MikroORM, in `orders` MongoDB database)

Collection: invoice entity (likely `invoices` or `invoice` per MikroORM default — confirm via `mongosh` `db.getCollectionNames()`).

Key fields:
- `invoiceNumber` (string, unique) — display ID
- `orderSerialNumber` (string) — human-readable order ref
- `orderId` (ObjectId, indexed) — join key to `orders.orders`
- `status` (enum) — `PENDING | FINALIZED | PAID | PARTIALLY_REFUNDED | REFUNDED | CANCELLED`
- Financials: `subTotal`, `convenienceFee`, `creditsApplied`, `invoiceTotalAmount`, `totalAmount`, `amountDue`, `prorationAmount`, `refundableAmount`, `discountAmount`
- Customer: `user` (UserEmbeddable), `customerEmail`, `otherEmails[]`, `customerNote`, `notes`
- Dates: `finalizeDate`, `cancelledAt`, `paidAt`
- Discount detail: `appliedDiscounts[]` of `{discountId, code, appliedAmount, isApplied}`
- Audit: `history[]` of `{timestamp, action}`
- Files: `paymentReport` (FileEmbeddable), `paymentInvoice` (FileEmbeddable)
- Cancel: `cancelReason` (ref to `CancelReasonInvoiceEntity`)

### State machine

`PENDING → FINALIZED → (PAID | PARTIALLY_REFUNDED | REFUNDED) | CANCELLED`

Aging is **not** stored — must be derived: `daysOutstanding = (now - finalizeDate)` for `status=FINALIZED ∧ paidAt=null`.

### Endpoints (V2 API; auth required unless noted)

```
GET    /invoices                       list w/ search/status/date/orderId
GET    /invoices/pending               current user's pending
GET    /invoices/counts                status-grouped counts
GET    /invoices/order/:orderId        invoices for an order
GET    /invoices/finalized/:orderId    can-finalize check
GET    /invoices/:invoiceId            detail
GET    /invoices/:invoiceId/line-items public, no auth
GET    /invoices/:invoiceId/download-preview  PDF preview
GET    /invoices/:orderId/transactions billing rows incl. refunds
PUT    /invoices/finalize/:invoiceId   email customer
PUT    /invoices/resend-email/:invoiceId
PUT    /invoices/cancel/:invoiceId
POST   /invoices/:invoiceId/payment-report
```

### Recommended dashboard integration shape (for a follow-up plan)

- New `runInvoiceBackfill()` step inside the backfill cycle. Source: `orders.<invoice-collection>`. Sink: `iee_dashboard.backfill_invoices`. Compute `daysOutstanding` and an `agingBucket` (`0-30 / 31-60 / 61-90 / 90+`) at upsert time.
- New `GET /data/invoices` and `GET /data/invoices/aging-summary` reading from `backfill_invoices`.
- New `client/src/pages/InvoiceTracker.jsx` modeled after `OrderTracker.jsx` (search + detail) with status badges and aging color coding.
- New AI tool `fetch_invoices` registered behind a guardrail that redacts `customerEmail`, `otherEmails`, `customerNote`, `notes`.
- Sidebar entry under `ManagerGuard` (same gating as Email).

---

## 6. Prioritized roadmap

### 6.1 This plan (P0 — shipping now)

1. **B1** — JWT secret fail-fast at startup (`server.js:52`)
2. **B2** — Backfill watchdog: 30-min default, audit row, `/health` surfacing, `clearInterval` on shutdown (`server.js:3642-3654`)
3. **B3** — `/reports/query` `groupBy` allowlist + extracted `validateGroupBy()` + unit test (`server.js:5291`)
4. **B4** — React `<ErrorBoundary>` with friendly fallback (`client/src/components/ErrorBoundary.jsx`, `client/src/App.jsx`)
5. **B5** — explicit `skipHtml` + `urlTransform` URL whitelist on `<ReactMarkdown>` (`client/src/pages/ChatPage.jsx`)
6. **B6** — login audit logging on success and bad-password failure (`server.js:1891`)

Test work:
- `test/validate-group-by.test.js` (node:test)
- `test/jwt-secret-startup.test.js` (node:test, child process)

### 6.2 Next plan candidates (P1)

In rough ROI order:

1. **Invoice tracker feature** — backfill + `/data/invoices` + `InvoiceTracker.jsx` + `fetch_invoices` AI tool with PII redaction
2. Resolve duplicate shutdown handlers (`server.js:6305` vs `6436`)
3. `/reports/query` per-endpoint rate limit (e.g. 5/min)
4. Password complexity + login lockout
5. Tighten production CORS allowlist
6. Sanitize 500-error responses (no `err.message` leakage in production)
7. `/health` fleshed out: `lastBackfillAt`, `lastWatchdogResetAt`, config DB ping, cache stats
8. Audit log coverage gaps: invite accept/resend, backfill manual run, AI chat exports, report exports
9. Toast/notification system to replace `alert()` and `confirm()`
10. ARIA + keyboard / focus pass; tour focus trap
11. `React.lazy` route splitting for ChatPage, ReportBuilder, StaffingForecast, BackfillPage
12. Extract `useKpiClassification` hook + shared `<ConfigTable>` component

### 6.3 Backlog (P2)

- Structured logging (pino/winston) + request IDs in messages
- Index `dashboard_audit_log` (timestamp+changedBy compound)
- Streaming gzip vs full Buffer
- Cron timezone via env var; replace hand-rolled scheduler with node-cron
- Refactor `server.js` into modules (auth, backfill, ai, fast-reads, reports, email)
- `useData` lazy-load per page
- Mongo connection pool sizing + backpressure logging
- Mobile polish: pinned table cols, modal sheets, denser FilterBar
- Inconsistent button/card/loading primitives → unified `<Button variant>`, `<LoadingState>`, `<EmptyState>`
- Version drift cleanup (`server.js:1` header, `.env.example` v5.0, `server.js:6177` startup log)
- README + API contract docs
- Pre-commit hooks + ESLint + Prettier + GitHub Actions CI
- AI chat retention policy on `dashboard_chat_history`
- i18n scaffolding (`react-i18next`)
- Multi-tenancy: tenant id in JWT, scoped collections — only if a second tenant lands

---

## 6.4 Data quality — V1↔V2 status sync (added 2026-04-27)

**Severity: P0.** Production `orders.orderStatusHistory` shows two distinct anomaly patterns that skew every duration-based metric the dashboard reports (Avg Duration, Median, XpH, In-Range %, Daily Volume).

**Pattern A — same-minute batch stamping.** Order #1632380638 has six independent status transitions all stamped within the same wall-clock minute (2026-04-21 02:21 AM), with one further entry stamped 2 minutes earlier than the cluster despite representing a logically *later* workflow step. Effect: real multi-day durations between consecutive Processing statuses get reported as 0 seconds, then dropped at `server.js:805` by the `durationSeconds <= 0` filter. The order looks fast in metrics but the real workload silently disappears from XpH attribution.

**Pattern B — chain breaks.** Order #1632388091 (Evaluation, CUSTOM tag) has `orderStatusHistory` entries that don't form a continuous From→To chain. Multiple Processing statuses appear to have been skipped without being recorded. Effect: when the dashboard segment-builder pairs `entry[i]` with `entry[i+1]` to compute a duration, those durations span two unrelated workflow stages, producing nonsensical (often very long) segment durations attributed to the wrong worker and status.

**Diagnostic surface (shipped 2026-04-27):**
- `GET /diag/coverage?from=YYYY-MM-DD&to=YYYY-MM-DD` (admin) — daily transition counts in production vs `backfill_kpi_segments`, watchdog reset audit rows, and gap classification (`no-source-data` vs `backfill-missing`). Used to triage missing-window reports.
- `GET /diag/order-quality?serial=<orderSerialNumber>` (admin) — per-order full timeline plus heuristic flags: `sameMinuteClusters`, `outOfOrderEntries`, `largeGapsHours`, `selfTransitions`.

**Root cause (confirmed via V2 source audit, 2026-04-27):**

**Schema** — `orderStatusHistory` is an embedded array on the `Order` MikroORM entity. Each element is `OrderStatusHistoryEmbedded` defined at `iee_v2/apps/api-orders/src/orders/orderStatusHistory.embedded.ts:10-11`:
```typescript
@Property({ type: 'date', onCreate: () => new Date() })
createdAt: Date = new Date();
```
`createdAt` is stamped at object-instantiation time, not preserved from the originating event unless the writer explicitly sets it.

**Writers identified** (all in `iee_v2/apps/api-orders/src/`):
1. `orders-sync/orderSync.service.ts:241-334` — V1→V2 sync worker. Iterates `orderData.statusChanges` and sets `createdAt: this.parseAnyDate(change?.createdAt)`. **Problem:** `parseAnyDate()` at line 409 silently falls back to `new Date()` on parse failure, masking bad data with current time. Dedup on `v1ID` at lines 248-258 silently drops retries — including legitimate new transitions that happen to share an ID.
2. `admin/admin-order/adminOrder.service.ts:257-295` — admin status change UI. Pushes plain object without explicit `createdAt`, so embedded default fires (`new Date()` at push). Acceptable for live admin actions.
3. `admin/error-reporting/errorReporting.service.ts:349-376` — error-reporting flow. Same pattern as #2.
4. `orders/bulk-evaluation-order/bulkEvaluationOrder.service.ts:395-418` — explicit `createdAt: new Date()` at line 415 inside a batch loop.

**Pattern A (same-minute clusters) — most likely cause:** the V1 sync worker is faithfully ingesting V1 payloads where `change.createdAt` itself is collapsed (V1 stamped multiple status changes at the same second, or a V1 → V2 replay batched events without per-entry timestamps and the worker fell back to `new Date()` for the whole batch). The dedup loop processes them sequentially within milliseconds, so all 6 entries land with identical `createdAt`.

**Pattern B (chain breaks) — most likely cause:** the dedup-by-`v1ID` logic in the same sync worker silently drops entries when retries happen, leaving holes in the chain. Combined with `continue` on parse errors at lines 259, 325 (which doesn't log), entries can vanish without trace.

**Recommended V2-side fixes** (to be opened in the V2 repo, not this one):
- `orderSync.service.ts:409` — `parseAnyDate()` should return `null` on failure, not `new Date()`. The caller should reject the entry and log it instead of silently stamping with current time.
- `orderSync.service.ts:248-258` — dedup-by-`v1ID` should compare `(v1ID, createdAt, updatedStatus.slug)` instead of `v1ID` alone. A retry with the same `v1ID` but a new state transition is a real event, not a duplicate.
- `orderSync.service.ts:259, 325` — `continue` paths should emit a structured warning (order serial, v1ID, reason) so dropped entries are observable.
- Investigate the V1 emitter — if V1 itself is collapsing event timestamps when replaying old data, fix it there. If V1 emits events with originalEventTime distinct from createdAt, the sync worker should prefer originalEventTime.

**Recommended downstream defenses in `server.js`** (deferred until `/diag/coverage` + `/diag/order-quality` data confirms prevalence and informs thresholds):
- Detect and quarantine same-minute clusters of ≥3 Processing entries on a single order — flag with `dataQuality: 'batch_stamped'` and exclude from duration metrics
- When a chain break is detected (gap > 24h between Processing entries with no intermediate non-Processing pause), do not compute a segment that spans the gap; emit it with `dataQuality: 'chain_break'` and exclude from averages
- Add `dataQuality` index field to `backfill_kpi_segments` and a "Data Health" panel on the dashboard surfacing affected order count + impact on metrics

---

## 6.5 Metric correctness (added 2026-04-27, shipped PR #2)

User reported that the User Drill-Down page showed nonsensical values for at least one worker (Elena Gamburg in Document Management): an XpH summary card reading "1.5 Reports" when the worker did 154 Orders-unit segments and only 1 Reports-unit segment, plus segments listed at 145 hours that don't represent real workload. An Explore agent traced the full computation pipeline (`server.js` segment builder → `client/src/hooks/useData.jsx` enrichment → `client/src/pages/KPIUsers.jsx` aggregation) and surfaced four concrete bugs.

### 6.5.1 The corrected XpH unit assignment per department / status

Sourced from `seed-config.js:35-48` and matches the user's spec:

| Team                | Status                                | XpH unit    |
|---------------------|---------------------------------------|-------------|
| Customer Support    | initial-review                        | Orders      |
| Data Entry          | eval-prep-processing                  | Credentials |
| Digital Fulfillment | digital-fulfillment-processing        | Orders      |
| Digital Records     | digital-records-processing, review    | Orders      |
| Document Management | document, shipment, verification      | Orders      |
| Evaluation          | initial-evaluation, senior-eval-review| Reports     |
| Translations        | translation-prep, translation-review  | Orders      |

The benchmarks config is correct. The bugs were all in how the dashboard *aggregated* values that already had the right unit tags.

### 6.5.2 The four bugs and their fixes

| # | Sev | Where | Bug | Fix in PR #2 |
|---|-----|-------|-----|--------------|
| **6.5-B1** | **P0** | `KPIUsers.jsx:121-122` (pre-fix) | Reports / Credentials summary cards summed `reportItemCount` and `credentialCount` across **every** segment of the worker. Both fields are order-level — an order with 5 reports touched in 3 segments produced 15 instead of 5. | Replaced with `sumOrderLevelField(segments, field)` from `lib/segment-aggregations.js` which dedupes by `orderSerialNumber` and takes each value once. |
| **6.5-B2** | **P1** | `KPIUsers.jsx:115-119, 137` (pre-fix) | Per-worker XpH summed `unitValue` across heterogeneous-unit segments and then labeled the card with the first non-Orders unit found. For Elena: `unitSum = 154 + 1 = 155 mixed units`, label = `"Reports"`, value mathematically incoherent. | Replaced with `computeXphByUnit(closedSegments)` — partitions by `xphUnit`, computes per-unit `{ units, hours, xph }`, picks the dominant. Card now reads "1.5 Orders" for Elena, with the per-status table showing the Reports value in its own row (already correct there). |
| **6.5-B3** | **P1** | `server.js:737-865` (live `/kpi-segments`) | Live endpoint never attached `credentialCount` to segments. Only the backfill path did. Bruno / GAS / any client hitting live got `credentialCount = undefined`, so Data Entry XpH was `0` on those code paths. | Mirrored the backfill credential pre-fetch in the live endpoint — one `order-credentials` aggregation per request, attached to each segment alongside `reportItemCount`. |
| **6.5-B4** | **P0** | client aggregations | Segments with 145-hour durations (chain-break artifacts from the V1↔V2 sync issue documented in §6.4) flowed untouched into Avg / Median / Total Hours / XpH on every page. The 5-bucket classifier labeled them "Excl Long" via per-status `excludeLongSec` thresholds in Settings, but the label was consumed only by In-Range %. | Extended the canonical "closed segments" filter in `KPIOverview.jsx` and `KPIUsers.jsx` (summary cards + per-status breakdown) to drop `Excl-Short` and `Excl-Long` buckets. `Unclassified` stays in. Excluded count surfaced on the Avg / Median card subtitles so the trim is visible. |

### 6.5.3 Design choices worth recording

- **Outlier exclusion is client-side, not at segment-build.** Real long durations (legitimate weekend-soak segments, etc.) stay in the segment list and the drilldown drawer; only the central-tendency rollups apply the trim. Operators can dial the per-status thresholds via Settings — that's the correct place for the policy decision.
- **Dominant-unit selection ties to "Orders" by default.** When a worker has zero closed segments, `computeXphByUnit` returns `dominant: 'orders'` so the card label is stable. Future drift (e.g., adding a new unit type) needs to be reflected in `client/src/lib/segment-aggregations.js` and its mirror at `lib/segment-aggregations.js`.
- **`classifySegment` and `segment-aggregations` were extracted to shared client utilities** (`client/src/lib/`). Previously they lived inline in `KPIOverview.jsx` and were going to drift. KPIUsers now imports them. KPIScorecard does not yet use these; if it grows central-tendency cards, fold it in.

### 6.5.4 What was *not* changed

- Live and backfill segment builders still produce raw 145h segments — the cap is downstream, not at the source. This intentionally preserves the ability to see the artifacts in drilldown drawers and `/diag/order-quality`.
- The upstream V2 fix (in `iee_v2/apps/api-orders/src/orders-sync/orderSync.service.ts:241-334`) still belongs in the V2 repo; once shipped, the chain breaks will subside and the outlier exclusion in this PR will gradually have less work to do.

---

## 7. References used while auditing

- Backend monolith: `server.js` (route paths line numbers in §2)
- Frontend entry: `client/src/App.jsx`, `client/src/hooks/useApi.js`, `client/src/hooks/useData.jsx`
- Largest pages: `client/src/pages/ReportBuilder.jsx` (689), `StaffingForecast.jsx` (634), `KPIOverview.jsx` (473), `SettingsPage.jsx` (445), `KPIUsers.jsx` (416)
- V2 invoice domain: `/Users/andrew/Code/IEE/iee_v2/apps/api-payment/src/invoice/{invoice.entity.ts, invoice.types.ts, invoice.dto.ts, invoice.controller.ts}`
- Changelog narrative: `CHANGELOG.md`
- Env contract: `.env.example`
- Architecture overview: `CLAUDE.md`
