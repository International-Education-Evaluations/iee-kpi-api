// ============================================================
// IEE KPI Data API Server — v4.2
//
// CHANGES from v2.1:
//   - MongoClient: added retryWrites + retryReads for transparent
//     reconnect after Atlas connection drops (restored from v3.0)
//   - /credential-counts: restored date-scoping via createdAt >= cutoff
//     (was removed in v2.1, required for accurate XpH numerator)
//   - /kpi-segments: workerUserId now uses foreignKeyId from assignedTo
//     with fallback to v2Id for orders where foreignKeyId is missing
//   - /qc-events: added orderSerialNumber to response (Power BI join key)
//   - /qc-discovery: restored diagnostic scan endpoint (from v3.0)
//     useful for confirming collection shape after V2 deploys
//   - /qc-summary: added orderType breakdown to byDepartment grouping
//   - buildQcEvent: issueCustomText now reads from issue.customText
//     in addition to issue.issueCustomText (field name varies in V2 docs)
//   - buildQcEvent: null-safe guard on html/text fields
//   - getOrdersMap: added orderType to projection (needed for qc-summary)
//   - Version bumped to 4.0 across all response payloads
//
// QC model confirmed from V2 source code review:
//   - Collection: orders.order-discussion
//   - QC grain: discussion rows where
//       type = 'system_logs'
//       category.slug = 'quality_control'
//   - errorType: 'i_fixed_it' | 'kick_it_back'
//   - errorAssignedTo: the accountable user (who made the error)
//   - user: the reporter (who filed the QC event)
//   - Related workflow signal: orders.orderStatusHistory[*].isErrorReporting
// ============================================================

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const zlib = require('zlib');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();

// —— Configuration ————————————————————————————————————————
const CONFIG = {
  MONGO_URI: process.env.MONGO_URI,
  MONGO_CONFIG_URI: process.env.MONGO_CONFIG_URI || '',
  API_KEY: process.env.API_KEY,
  PORT: process.env.PORT || 3000,
  ALLOWED_IPS: process.env.ALLOWED_IPS || '',
  JWT_SECRET: process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex'),
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY || '',
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  SENDGRID_TEMPLATE_ID: process.env.SENDGRID_TEMPLATE_ID || '',
  SENDGRID_INVITE_TEMPLATE_ID: process.env.SENDGRID_INVITE_TEMPLATE_ID || '',
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL || 'ops@myiee.org',
  SETUP_SECRET: process.env.SETUP_SECRET || '',
  NODE_ENV: process.env.NODE_ENV || 'production'
};

if (!CONFIG.MONGO_URI) { console.error('FATAL: MONGO_URI required'); process.exit(1); }
if (!CONFIG.API_KEY) { console.error('FATAL: API_KEY required'); process.exit(1); }

// —— Security ————————————————————————————————————————————
app.use(helmet());
app.set('etag', false); // Disable ETags — parallel paginated requests get 304 instead of data

// Prevent browser caching on all /data/* endpoints
// These are live backfill reads that must always return fresh data
app.use('/data', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(cors({
  origin: function(origin, callback) {
    // Allow GAS, Railway dashboard, and localhost dev
    const allowed = [
      'https://script.google.com',
      'https://script.googleusercontent.com'
    ];
    // Allow any Railway app origin and localhost for dev
    if (!origin || allowed.includes(origin)
        || origin.endsWith('.up.railway.app')
        || origin.startsWith('http://localhost')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['x-api-key', 'Content-Type', 'Authorization']
}));
app.set('trust proxy', 1);
// Gzip compression — reduces /data/kpi-segments from ~5.5MB to ~800KB per page.
// Applied before rate limit so compressed size counts toward content-length.
app.use((req, res, next) => {
  const accept = req.headers['accept-encoding'] || '';
  if (!accept.includes('gzip')) return next();
  const _json = res.json.bind(res);
  res.json = (body) => {
    const str = JSON.stringify(body);
    if (str.length < 1024) return _json(body); // skip small responses
    zlib.gzip(Buffer.from(str), { level: 6 }, (err, compressed) => {
      if (err) return _json(body);
      res.set('Content-Encoding', 'gzip');
      res.set('Content-Type', 'application/json');
      res.set('Content-Length', compressed.length);
      res.send(compressed);
    });
  };
  next();
});

app.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '1mb' }));

// —— Utility helpers ————————————————————————————————————

function parsePositiveInt(value, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'object' && value.$date) {
    const date = new Date(value.$date);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function toDate(value) {
  const iso = toIso(value);
  return iso ? new Date(iso) : null;
}

function safeString(value) {
  return (value === undefined || value === null) ? null : String(value);
}

function buildFullName(person) {
  if (!person) return null;
  const parts = [person.firstName, person.middleName, person.lastName]
    .map(v => (v || '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function paginate(items, page, pageSize) {
  const totalCount = items.length;
  const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);
  const currentPage = Math.min(page, totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  return {
    totalCount,
    totalPages,
    page: currentPage,
    pageSize,
    hasMore: currentPage < totalPages,
    items: items.slice(startIdx, startIdx + pageSize)
  };
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getCutoff(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}

function average(values) {
  const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!valid.length) return null;
  return Math.round((valid.reduce((sum, v) => sum + v, 0) / valid.length) * 10) / 10;
}

// —— QC helpers —————————————————————————————————————————

function buildQcQuery(cutoff) {
  return {
    type: 'system_logs',
    createdAt: { $gte: cutoff },
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    $and: [
      {
        $or: [
          { 'category.slug': 'quality_control' },
          { 'category.name': { $regex: '^quality control$', $options: 'i' } }
        ]
      },
      {
        $or: [
          { 'issue.name': { $exists: true, $ne: null } },
          { 'issue.foreignKeyId': { $exists: true, $ne: null } },
          { errorType: { $exists: true, $ne: null } }
        ]
      }
    ]
  };
}

// Returns the order status active at the time of a QC event, plus next-status
// transition timing — used to derive "what was the worker doing when QC was filed"
function getStatusContext(order, qcCreatedAt) {
  const empty = {
    statusAtQcSlug: null, statusAtQcName: null, statusAtQcType: null,
    previousStatusSlug: null, previousStatusName: null,
    nextStatusChangeAt: null, nextStatusSlug: null, nextStatusName: null,
    nextStatusType: null, minutesToNextStatusChange: null, hoursToNextStatusChange: null
  };
  const history = Array.isArray(order?.orderStatusHistory) ? order.orderStatusHistory : [];
  if (!history.length || !qcCreatedAt) return empty;

  const normalized = history
    .map(entry => ({
      createdAt: toDate(entry?.createdAt),
      oldStatus: entry?.oldStatus || null,
      updatedStatus: entry?.updatedStatus || null,
      isErrorReporting: !!entry?.isErrorReporting
    }))
    .filter(entry => entry.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt);

  let current = null;
  let next = null;
  for (const entry of normalized) {
    if (entry.createdAt <= qcCreatedAt) { current = entry; continue; }
    next = entry;
    break;
  }

  const nextMinutes = next
    ? Math.round(((next.createdAt - qcCreatedAt) / 60000) * 10) / 10
    : null;
  const nextHours = nextMinutes !== null
    ? Math.round((nextMinutes / 60) * 10) / 10
    : null;

  return {
    statusAtQcSlug: current?.updatedStatus?.slug || null,
    statusAtQcName: current?.updatedStatus?.name || null,
    statusAtQcType: current?.updatedStatus?.statusType || null,
    previousStatusSlug: current?.oldStatus?.slug || null,
    previousStatusName: current?.oldStatus?.name || null,
    nextStatusChangeAt: next ? toIso(next.createdAt) : null,
    nextStatusSlug: next?.updatedStatus?.slug || null,
    nextStatusName: next?.updatedStatus?.name || null,
    nextStatusType: next?.updatedStatus?.statusType || null,
    minutesToNextStatusChange: nextMinutes,
    hoursToNextStatusChange: nextHours
  };
}

// Maps a single order-discussion QC doc + its parent order into a flat event shape.
// issueCustomText: V2 docs use either issue.customText or issue.issueCustomText — check both.
function buildQcEvent(doc, order) {
  const qcCreatedAt = toDate(doc?.createdAt);
  const orderId = safeString(doc?.order);
  const department = doc?.department || {};
  const issue = doc?.issue || {};
  const category = doc?.category || {};
  const statusContext = getStatusContext(order, qcCreatedAt);

  return {
    qcEventId: safeString(doc?._id),
    orderId,
    orderSerialNumber: order?.orderSerialNumber || null,  // added v4.0 — Power BI join key
    orderType: order?.orderType || null,
    paymentStatus: order?.paymentStatus || null,
    isErrorReportingFlagOnOrder: !!order?.isErrorReporting,
    qcCreatedAt: toIso(qcCreatedAt),
    qcType: doc?.type || null,
    qcCategoryId: category?.foreignKeyId || null,
    qcCategorySlug: category?.slug || null,
    qcCategoryName: category?.name || null,
    errorType: doc?.errorType || null,
    isFixedIt: doc?.errorType === 'i_fixed_it',
    isKickItBack: doc?.errorType === 'kick_it_back',
    departmentId: department?.foreignKeyId || null,
    departmentName: department?.name || null,
    issueId: issue?.foreignKeyId || null,
    issueName: issue?.name || null,
    // V2 field name varies across doc versions — check both
    issueCustomText: issue?.customText || issue?.issueCustomText || null,
    reporterUserId: doc?.user?.foreignKeyId || null,
    reporterName: buildFullName(doc?.user),
    reporterEmail: doc?.user?.email || null,
    accountableUserId: doc?.errorAssignedTo?.foreignKeyId || null,
    accountableName: buildFullName(doc?.errorAssignedTo),
    accountableEmail: doc?.errorAssignedTo?.email || null,
    // html/text are large fields — callers can suppress via includeHtml/includeText params
    text: doc?.text || null,
    html: doc?.html || null,
    ...statusContext
  };
}

// —— MongoDB ————————————————————————————————————————————
// Two clients: read-only for production data, read-write for dashboard config.
// If MONGO_CONFIG_URI is not set, falls back to MONGO_URI (single cluster mode).
let client;
async function getDb(dbName) {
  if (!client) {
    client = new MongoClient(CONFIG.MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      retryReads: true
    });
    await client.connect();
    console.log('Connected to MongoDB Atlas (production data - read)');
  }
  return client.db(dbName);
}

let configClient;
async function getConfigDb() {
  const uri = CONFIG.MONGO_CONFIG_URI || CONFIG.MONGO_URI;
  if (!configClient) {
    configClient = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      retryReads: true
    });
    await configClient.connect();
    console.log(`Connected to MongoDB Atlas (config - readWrite)${CONFIG.MONGO_CONFIG_URI ? ' [separate cluster]' : ' [same cluster]'}`);
  }
  return configClient.db('iee_dashboard');
}

// ── Server-side in-memory config cache ─────────────────────────────────────
// /config/benchmarks, /config/user-levels, /config/production-hours are read on
// every dashboard load but only change when an admin explicitly edits them.
// This cache eliminates repeated MongoDB round trips for static config data.
// TTL: 5 minutes (safety net). Invalidated immediately on any PUT to the collection.
const CONFIG_CACHE = new Map(); // key → { data, ts }
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedConfig(key) {
  const entry = CONFIG_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CONFIG_CACHE_TTL_MS) { CONFIG_CACHE.delete(key); return null; }
  return entry.data;
}
function setCachedConfig(key, data) {
  CONFIG_CACHE.set(key, { data, ts: Date.now() });
}
function invalidateConfigCache(key) {
  if (key) CONFIG_CACHE.delete(key);
  else CONFIG_CACHE.clear();
}

// ── Server-side backfill metadata cache ─────────────────────────────────────
// The backfill_metadata lastRunAt is fetched on every /data/kpi-segments page call.
// Cache it in memory; update when backfill completes.
let _backfillMetaCache = null;
let _backfillMetaCacheTs = 0;
const BACKFILL_META_TTL_MS = 30 * 1000; // 30 seconds

async function getBackfillMeta(configDb) {
  const now = Date.now();
  if (_backfillMetaCache && now - _backfillMetaCacheTs < BACKFILL_META_TTL_MS) {
    return _backfillMetaCache;
  }
  const meta = await configDb.collection('backfill_metadata').findOne({ _id: 'status' });
  _backfillMetaCache = meta;
  _backfillMetaCacheTs = now;
  return meta;
}
function invalidateBackfillMeta() {
  _backfillMetaCache = null;
  _backfillMetaCacheTs = 0;
}

// ── Index management — run once at startup and after full refresh ────────────
// createIndex is called on every backfill run otherwise, wasting round trips.
// MongoDB ignores duplicate requests but we pay the network cost each time.
let _indexesEnsured = false;
async function ensureIndexes() {
  if (_indexesEnsured) return;
  try {
    const db = await getConfigDb();
    const seg = db.collection('backfill_kpi_segments');
    const qc  = db.collection('backfill_qc_events');
    const usr = db.collection('backfill_users');

    // ── backfill_kpi_segments ────────────────────────────────
    await Promise.all([
      seg.createIndex({ _compositeKey: 1 },   { unique: true, background: true }).catch(() => {}),
      seg.createIndex({ segmentStart: -1 },    { background: true }).catch(() => {}),
      seg.createIndex({ workerEmail: 1 },      { background: true }).catch(() => {}),
      seg.createIndex({ workerUserId: 1 },     { background: true }).catch(() => {}), // was missing
      seg.createIndex({ statusSlug: 1 },       { background: true }).catch(() => {}),
      seg.createIndex({ orderType: 1 },        { background: true }).catch(() => {}),
      seg.createIndex({ isOpen: 1 },           { background: true }).catch(() => {}),
      seg.createIndex({ departmentName: 1 },   { background: true }).catch(() => {}), // was missing
      // Compound indexes for common query patterns
      seg.createIndex({ statusSlug: 1, segmentStart: -1 },  { background: true }).catch(() => {}),
      seg.createIndex({ workerEmail: 1, segmentStart: -1 }, { background: true }).catch(() => {}),
      seg.createIndex({ isOpen: 1, segmentStart: -1 },      { background: true }).catch(() => {}), // open-segs recheck
      seg.createIndex({ orderType: 1, segmentStart: -1 },   { background: true }).catch(() => {}),
    ]);

    // ── backfill_qc_events ───────────────────────────────────
    await Promise.all([
      qc.createIndex({ _qcKey: 1 },           { unique: true, background: true }).catch(() => {}),
      qc.createIndex({ qcCreatedAt: -1 },      { background: true }).catch(() => {}),
      qc.createIndex({ departmentName: 1 },    { background: true }).catch(() => {}),
      qc.createIndex({ errorType: 1 },         { background: true }).catch(() => {}),
      qc.createIndex({ orderType: 1 },         { background: true }).catch(() => {}), // was missing
      qc.createIndex({ accountableName: 1 },   { background: true }).catch(() => {}), // was missing
      // Compound for common filter combos
      qc.createIndex({ departmentName: 1, qcCreatedAt: -1 }, { background: true }).catch(() => {}),
      qc.createIndex({ errorType: 1, qcCreatedAt: -1 },      { background: true }).catch(() => {}),
    ]);

    // ── backfill_users ───────────────────────────────────────
    await Promise.all([
      usr.createIndex({ email: 1 },   { background: true }).catch(() => {}),
      usr.createIndex({ v1Id: 1 },    { background: true }).catch(() => {}),
      usr.createIndex({ fullName: 1 },{ background: true }).catch(() => {}),
    ]);

    _indexesEnsured = true;
    console.log('[INDEXES] All backfill collection indexes ensured');
  } catch (err) {
    console.error('[INDEXES] Failed to ensure indexes:', err.message);
  }
}

// Batch-fetches parent order docs for a list of order IDs (used by QC enrichment).
async function getOrdersMap(orderIds) {
  const uniqueIds = [...new Set(orderIds.filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  const db = await getDb('orders');
  const ordersCol = db.collection('orders');
  const docs = await ordersCol.find(
    { _id: { $in: uniqueIds.map(id => new ObjectId(id)) } },
    {
      projection: {
        _id: 1,
        orderSerialNumber: 1,
        orderType: 1,         // needed for qc-summary breakdown
        paymentStatus: 1,
        isErrorReporting: 1,
        orderStatusHistory: 1
      }
    }
  ).toArray();

  return new Map(docs.map(doc => [String(doc._id), doc]));
}

// Fetches and enriches all QC events for a given day window.
// Single shared dataset used by /qc-events, /qc-orders, and /qc-summary
// to avoid redundant Mongo round-trips when all three are called in sequence.
async function getQcEventsDataset(days) {
  const cutoff = getCutoff(days);
  const db = await getDb('orders');
  const qcCol = db.collection('order-discussion');

  const docs = await qcCol.find(buildQcQuery(cutoff), {
    projection: {
      _id: 1, order: 1, createdAt: 1, type: 1, category: 1,
      errorType: 1, department: 1, issue: 1, user: 1,
      errorAssignedTo: 1, text: 1, html: 1, deletedAt: 1
    }
  }).sort({ createdAt: -1 }).toArray();

  const orderIds = docs.map(doc => safeString(doc?.order)).filter(Boolean);
  const ordersMap = await getOrdersMap(orderIds);

  const events = docs
    .map(doc => buildQcEvent(doc, ordersMap.get(safeString(doc?.order))))
    .sort((a, b) => {
      if (!a.qcCreatedAt && !b.qcCreatedAt) return 0;
      if (!a.qcCreatedAt) return 1;
      if (!b.qcCreatedAt) return -1;
      return new Date(b.qcCreatedAt) - new Date(a.qcCreatedAt);
    });

  return { cutoff, refreshedAt: new Date(), events };
}

// Collapses event-grain QC records to one summary row per order.
function buildQcOrderSummaries(events) {
  const grouped = new Map();

  for (const event of events) {
    const key = event.orderId || `missing:${event.qcEventId}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        orderId: event.orderId,
        orderSerialNumber: event.orderSerialNumber,
        orderType: event.orderType,
        paymentStatus: event.paymentStatus,
        isErrorReportingFlagOnOrder: event.isErrorReportingFlagOnOrder,
        firstQcAt: event.qcCreatedAt,
        lastQcAt: event.qcCreatedAt,
        qcEventCount: 0,
        kickItBackCount: 0,
        fixedItCount: 0,
        departments: [],
        issues: [],
        issueCustomTexts: [],
        reporterNames: [],
        accountableNames: [],
        latestStatusAtQcSlug: event.statusAtQcSlug,
        latestStatusAtQcName: event.statusAtQcName,
        latestNextStatusSlug: event.nextStatusSlug,
        latestNextStatusName: event.nextStatusName,
        latestNextStatusChangeAt: event.nextStatusChangeAt,
        latestMinutesToNextStatusChange: event.minutesToNextStatusChange
      });
    }

    const bucket = grouped.get(key);
    bucket.qcEventCount += 1;
    if (event.isKickItBack) bucket.kickItBackCount += 1;
    if (event.isFixedIt) bucket.fixedItCount += 1;
    if (event.departmentName) bucket.departments.push(event.departmentName);
    if (event.issueName) bucket.issues.push(event.issueName);
    if (event.issueCustomText) bucket.issueCustomTexts.push(event.issueCustomText);
    if (event.reporterName) bucket.reporterNames.push(event.reporterName);
    if (event.accountableName) bucket.accountableNames.push(event.accountableName);

    if (event.qcCreatedAt && (!bucket.firstQcAt || new Date(event.qcCreatedAt) < new Date(bucket.firstQcAt))) {
      bucket.firstQcAt = event.qcCreatedAt;
    }
    if (event.qcCreatedAt && (!bucket.lastQcAt || new Date(event.qcCreatedAt) > new Date(bucket.lastQcAt))) {
      bucket.lastQcAt = event.qcCreatedAt;
      bucket.latestStatusAtQcSlug = event.statusAtQcSlug;
      bucket.latestStatusAtQcName = event.statusAtQcName;
      bucket.latestNextStatusSlug = event.nextStatusSlug;
      bucket.latestNextStatusName = event.nextStatusName;
      bucket.latestNextStatusChangeAt = event.nextStatusChangeAt;
      bucket.latestMinutesToNextStatusChange = event.minutesToNextStatusChange;
    }
  }

  return [...grouped.values()]
    .map(item => ({
      ...item,
      departments: uniqueSorted(item.departments),
      issues: uniqueSorted(item.issues),
      issueCustomTexts: uniqueSorted(item.issueCustomTexts),
      reporterNames: uniqueSorted(item.reporterNames),
      accountableNames: uniqueSorted(item.accountableNames)
    }))
    .sort((a, b) => {
      if (!a.lastQcAt && !b.lastQcAt) return 0;
      if (!a.lastQcAt) return 1;
      if (!b.lastQcAt) return -1;
      return new Date(b.lastQcAt) - new Date(a.lastQcAt);
    });
}

function groupCounts(events, field) {
  const counts = new Map();
  for (const event of events) {
    const value = event[field] || '(blank)';
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildDailyTrend(events) {
  const counts = new Map();
  for (const event of events) {
    if (!event.qcCreatedAt) continue;
    const day = event.qcCreatedAt.slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// —— Middleware ——————————————————————————————————————————

function ipCheck(req, res, next) {
  if (!CONFIG.ALLOWED_IPS) return next();
  const allowed = CONFIG.ALLOWED_IPS.split(',').map(ip => ip.trim());
  if (allowed.includes(req.ip)) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

function generateToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email, role: user.role, name: user.name },
    CONFIG.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  try { return jwt.verify(token, CONFIG.JWT_SECRET); } catch { return null; }
}

function authMiddleware(req, res, next) {
  // Skip auth for public routes
  if (req.path === '/health' || req.path === '/auth/login' || req.path === '/auth/setup' || req.path === '/auth/accept-invite') return next();

  // Skip auth for static assets and SPA routes (React handles auth client-side)
  // Static files: .js, .css, .html, .png, .svg, .ico, .woff, etc.
  if (req.path.startsWith('/assets/') || req.path.endsWith('.js') || req.path.endsWith('.css') ||
      req.path.endsWith('.html') || req.path.endsWith('.png') || req.path.endsWith('.svg') ||
      req.path.endsWith('.ico') || req.path.endsWith('.woff') || req.path.endsWith('.woff2')) {
    return next();
  }

  // Skip auth for SPA page routes (no dot = not an API path, not a file)
  // API routes all start with known prefixes; everything else is a React route
  const apiPrefixes = ['/kpi-', '/qc-', '/queue-', '/credential', '/report-',
    '/users', '/collections', '/indexes', '/config/', '/auth/', '/ai/', '/glossary', '/email/',
    '/backfill/', '/data/', '/reports/', '/user/'];
  const isApiRoute = apiPrefixes.some(p => req.path.startsWith(p));
  if (!isApiRoute && req.method === 'GET' && !req.path.includes('.')) {
    return next(); // Let SPA fallback handle it
  }

  // JWT Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const decoded = verifyToken(authHeader.slice(7));
    if (decoded) { req.user = decoded; return next(); }
  }

  // Legacy master API key (GAS, Bruno)
  if (req.headers['x-api-key'] === CONFIG.API_KEY) {
    req.user = { role: 'admin', name: 'API Key', email: 'system@iee.com' };
    return next();
  }

  // Per-user API key (async lookup)
  (async () => {
    try {
      const userKey = req.headers['x-api-key'];
      if (userKey) {
        const db = await getConfigDb();
        const user = await db.collection('dashboard_users').findOne({ apiKey: userKey, isActive: true });
        if (user) { req.user = { userId: user._id.toString(), email: user.email, role: user.role, name: user.name }; return next(); }
      }
    } catch (err) { console.error('Auth lookup error:', err.message); }
    res.status(401).json({ error: 'Unauthorized' });
  })();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

app.use(ipCheck);
app.use(authMiddleware);

app.use((req, res, next) => {
  const start = Date.now();
  req.requestId = crypto.randomBytes(4).toString('hex');
  res.on('finish', () => {
    const duration = Date.now() - start;
    const user = req.user?.name || req.user?.email || '-';
    const size = res.getHeader('content-length') || '-';
    console.log(`[${req.requestId}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms user=${user} ip=${req.ip} size=${size}`);
    // Warn on slow requests
    if (duration > 5000) console.warn(`[${req.requestId}] SLOW REQUEST: ${req.method} ${req.path} took ${duration}ms`);
  });
  next();
});

// ═══════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════

// —— Health (no auth) ————————————————————————————————————
app.get('/health', async (req, res) => {
  try {
    const db = await getDb('orders');
    await db.command({ ping: 1 });
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: CONFIG.NODE_ENV, version: '5.4.22' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// —— Collection Discovery ————————————————————————————————
app.get('/collections', async (req, res) => {
  try {
    const dbNames = ['orders', 'payment', 'user', 'master'];
    const result = {};
    for (const dbName of dbNames) {
      try {
        const db = await getDb(dbName);
        const collections = await db.listCollections().toArray();
        result[dbName] = collections.map(c => c.name).sort();
      } catch (e) {
        result[dbName] = { error: e.message };
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— KPI Segments ————————————————————————————————————————
// Usage: /kpi-segments?days=90&page=1&pageSize=5000
//
// Segments are derived from orders.orderStatusHistory entries where
// updatedStatus.statusType = 'Processing'. Duration = time to next entry.
// reportItemCount sourced from order.reportItems (embedded array, no join needed).
// workerUserId uses assignedTo.foreignKeyId with fallback to assignedTo.v2Id.
app.get('/kpi-segments', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, { min: 1, max: 365 });
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
    const pageSize = parsePositiveInt(req.query.pageSize, 5000, { min: 100, max: 10000 });
    const cutoff = getCutoff(days);

    const db = await getDb('orders');
    const ordersCol = db.collection('orders');

    const orders = await ordersCol.aggregate([
      {
        $match: {
          paymentStatus: 'paid',
          orderType: { $in: ['evaluation', 'translation'] },
          deletedAt: null,
          orderStatusHistory: { $exists: true, $not: { $size: 0 } },
          'orderStatusHistory.createdAt': { $gte: cutoff }
        }
      },
      {
        $project: {
          orderSerialNumber: 1,
          orderType: 1,
          parentOrderId: 1,
          reportItems: 1,
          orderStatusHistory: 1,
          lastAssignedAt: 1,
          orderVersion: 1,
          orderSource: 1
        }
      }
    ], { allowDiskUse: true }).toArray();

    const allSegments = [];

    for (const order of orders) {
      const history = Array.isArray(order.orderStatusHistory) ? order.orderStatusHistory : [];
      const reportCount = Array.isArray(order.reportItems) ? order.reportItems.length : 0;
      const reportName = Array.isArray(order.reportItems) ? (order.reportItems[0]?.name || null) : null;

      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        if (entry?.updatedStatus?.statusType !== 'Processing') continue;

        const entryDate = toDate(entry?.createdAt);
        if (!entryDate || entryDate < cutoff) continue;

        const nextEntry = i + 1 < history.length ? history[i + 1] : null;
        const segmentEndDate = toDate(nextEntry?.createdAt);
        const durationSeconds = segmentEndDate
          ? (segmentEndDate.getTime() - entryDate.getTime()) / 1000
          : null;
        const durationMinutes = durationSeconds !== null
          ? Math.round((durationSeconds / 60) * 10) / 10
          : null;

        if (durationSeconds !== null && durationSeconds <= 0) continue;

        const assigned = entry?.assignedTo || {};
        const user = entry?.user || {};

        // V2 metric: anotherStatusUpdatedAt gives precise end time
        const preciseEnd = entry?.anotherStatusUpdatedAt ? toDate(entry.anotherStatusUpdatedAt) : null;
        const effectiveEnd = preciseEnd || segmentEndDate;
        const effectiveDurationSec = effectiveEnd
          ? (effectiveEnd.getTime() - entryDate.getTime()) / 1000
          : durationSeconds;
        const effectiveDurationMin = effectiveDurationSec !== null
          ? Math.round((effectiveDurationSec / 60) * 10) / 10
          : durationMinutes;

        allSegments.push({
          orderSerialNumber: order.orderSerialNumber,
          orderId: String(order._id),
          orderType: order.orderType,
          parentOrderId: order.parentOrderId || null,
          reportItemCount: reportCount,
          reportItemName: reportName,
          statusSlug: entry?.updatedStatus?.slug || '',
          statusName: entry?.updatedStatus?.name || '',
          // V2 user IDs: foreignKeyId is canonical, email is fallback
          workerUserId: assigned.foreignKeyId || assigned.v2Id || null,
          workerName: buildFullName(assigned),
          workerEmail: assigned.email ? assigned.email.toLowerCase().trim() : null,
          changedByName: buildFullName(user),
          segmentStart: toIso(entryDate),
          segmentEnd: toIso(effectiveEnd || segmentEndDate),
          durationSeconds: effectiveDurationSec ?? durationSeconds,
          durationMinutes: effectiveDurationMin ?? durationMinutes,
          isOpen: (effectiveEnd || segmentEndDate) === null,
          isErrorReporting: !!entry?.isErrorReporting,
          // V2 metrics
          lastAssignedAt: order.lastAssignedAt ? toIso(toDate(order.lastAssignedAt)) : null,
          orderVersion: order.orderVersion || null,
          orderSource: order.orderSource || null
        });
      }
    }

    const paged = paginate(allSegments, page, pageSize);
    res.json({
      count: paged.items.length,
      totalCount: paged.totalCount,
      orderCount: orders.length,
      page: paged.page,
      pageSize: paged.pageSize,
      totalPages: paged.totalPages,
      hasMore: paged.hasMore,
      dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: new Date().toISOString(),
      segments: paged.items
    });
  } catch (err) {
    console.error('KPI segments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 5-BUCKET KPI CLASSIFICATION
// ═══════════════════════════════════════════════════════════
// Applies benchmark thresholds to classify each segment:
//   1. Exclude Short — below minimum threshold (e.g. accidental clicks)
//   2. Out-of-Range Short — below benchmark target
//   3. In-Range — within benchmark min/max
//   4. Out-of-Range Long — above benchmark target
//   5. Exclude Long — above maximum threshold (e.g. left open overnight)
//
// Benchmarks stored in dashboard_benchmarks collection with fields:
//   team, status, xphUnit, l0-l5 (XpH targets per level)
//   excludeShortMin, inRangeMin, inRangeMax, excludeLongMax (minutes)
//
// If no benchmark exists for a segment's status, it's classified as "Unclassified".
// ═══════════════════════════════════════════════════════════

app.get('/kpi-classify', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 60, { min: 1, max: 365 });
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = parsePositiveInt(req.query.pageSize, 5000, { min: 1, max: 10000 });

    // 1. Fetch segments via internal API
    const segData = await internalFetch(`/kpi-segments?days=${days}&page=${page}&pageSize=${pageSize}`);
    const segments = segData.segments || [];

    // 2. Fetch benchmarks + user levels + backfill users from config DB
    const db = await getConfigDb();
    const [benchmarks, userLevels, backfillUsers] = await Promise.all([
      db.collection('dashboard_benchmarks').find({}).toArray(),
      db.collection('dashboard_user_levels').find({}).toArray(),
      db.collection('backfill_users').find({}).toArray()
    ]);

    // Index benchmarks by status slug
    const benchmarkMap = {};
    for (const b of benchmarks) {
      benchmarkMap[b.status] = b;
    }

    // Index user levels by email AND by v1Id
    const levelByEmail = {};
    const levelByV1Id = {};
    for (const u of userLevels) {
      if (u.email) levelByEmail[u.email.toLowerCase()] = u.level;
      if (u.v1Id) levelByV1Id[String(u.v1Id)] = u.level;
    }

    // Index backfill users by v2Id (primary — matches segment workerUserId) and email (fallback).
    // NOTE: segments carry workerUserId as a v2Id ObjectId string, NOT v1Id integer.
    // v1Id is an integer (e.g. 311571); workerUserId is "687a5894ef7495fca0666516" — never equal.
    const deptByV2Id  = {};
    const deptByEmail = {};
    for (const u of backfillUsers) {
      if (u.v2Id && u.departmentName)  deptByV2Id[String(u.v2Id)]          = u.departmentName;
      if (u.email && u.departmentName) deptByEmail[u.email.toLowerCase()]  = u.departmentName;
    }

    // 3. Classify each segment
    const classified = segments.map(seg => {
      const benchmark = benchmarkMap[seg.statusSlug] || benchmarkMap[seg.statusName] || null;

      // Level resolution: email first (v1Id path dead — workerUserId is v2Id, not v1Id)
      const workerEmail = seg.workerEmail ? seg.workerEmail.toLowerCase() : null;
      const userLevel = (workerEmail ? levelByEmail[workerEmail] : null) || null;

      // Department resolution: v2Id first (workerUserId IS v2Id), email fallback
      const workerId = seg.workerUserId ? String(seg.workerUserId) : null;
      const departmentName = (workerId ? deptByV2Id[workerId] : null)
        || (workerEmail ? deptByEmail[workerEmail] : null)
        || null;

      // Default thresholds if benchmark exists but thresholds aren't set
      const excludeShortMin = benchmark?.excludeShortMin ?? 0.5;   // < 30 seconds
      const inRangeMin = benchmark?.inRangeMin ?? 1;               // 1 minute
      const inRangeMax = benchmark?.inRangeMax ?? 120;             // 2 hours
      const excludeLongMax = benchmark?.excludeLongMax ?? 480;     // 8 hours

      // Get XpH target for this user's level
      let xphTarget = null;
      if (benchmark && userLevel) {
        const levelKey = userLevel.toLowerCase(); // L0 → l0
        xphTarget = benchmark[levelKey] ?? null;
      }

      let bucket = 'Unclassified';
      let bucketCode = 0;

      if (seg.isOpen) {
        bucket = 'Open';
        bucketCode = -1;
      } else if (seg.durationMinutes == null) {
        bucket = 'Unclassified';
        bucketCode = 0;
      } else if (!benchmark) {
        bucket = 'Unclassified';
        bucketCode = 0;
      } else if (seg.durationMinutes < excludeShortMin) {
        bucket = 'Exclude Short';
        bucketCode = 1;
      } else if (seg.durationMinutes < inRangeMin) {
        bucket = 'Out-of-Range Short';
        bucketCode = 2;
      } else if (seg.durationMinutes <= inRangeMax) {
        bucket = 'In-Range';
        bucketCode = 3;
      } else if (seg.durationMinutes <= excludeLongMax) {
        bucket = 'Out-of-Range Long';
        bucketCode = 4;
      } else {
        bucket = 'Exclude Long';
        bucketCode = 5;
      }

      // Compute xphUnit and unitValue for this segment
      const xphUnit = benchmark?.xphUnit || 'Orders'; // Orders | Credentials | Reports
      const unitValue = xphUnit === 'Credentials'
        ? (seg.credentialCount || 0)
        : xphUnit === 'Reports'
          ? (seg.reportItemCount || 0)
          : 1; // Orders: always 1 per segment

      return {
        ...seg,
        bucket,
        bucketCode,
        userLevel,
        departmentName,
        xphTarget,
        xphUnit,
        unitValue,
        benchmarkStatus: benchmark ? seg.statusSlug : null,
        thresholds: benchmark ? { excludeShortMin, inRangeMin, inRangeMax, excludeLongMax } : null
      };
    });

    // 4. Summary stats
    const closedClassified = classified.filter(s => !s.isOpen && s.bucketCode > 0);
    const bucketCounts = {};
    for (const s of classified) {
      bucketCounts[s.bucket] = (bucketCounts[s.bucket] || 0) + 1;
    }

    const inRange = classified.filter(s => s.bucketCode === 3);
    const outShort = classified.filter(s => s.bucketCode === 2);
    const outLong = classified.filter(s => s.bucketCode === 4);
    const scorable = closedClassified.length || 1; // avoid division by zero

    res.json({
      count: classified.length,
      totalCount: segData.totalCount,
      page: segData.page,
      pageSize: segData.pageSize,
      totalPages: segData.totalPages,
      hasMore: segData.hasMore,
      dateRange: segData.dateRange,
      refreshedAt: new Date().toISOString(),
      classification: {
        bucketCounts,
        inRangePercent: Math.round(inRange.length / scorable * 1000) / 10,
        outRangeShortPercent: Math.round(outShort.length / scorable * 1000) / 10,
        outRangeLongPercent: Math.round(outLong.length / scorable * 1000) / 10,
        excludedPercent: Math.round(classified.filter(s => s.bucketCode === 1 || s.bucketCode === 5).length / (classified.length || 1) * 1000) / 10,
        unclassifiedPercent: Math.round(classified.filter(s => s.bucketCode === 0).length / (classified.length || 1) * 1000) / 10
      },
      benchmarksApplied: benchmarks.length,
      userLevelsApplied: userLevels.length,
      segments: classified
    });
  } catch (err) {
    console.error('KPI classify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// BENCHMARK THRESHOLDS — GET/PUT for the 5-bucket thresholds
// Adds threshold fields to existing benchmark documents
// ═══════════════════════════════════════════════════════════

app.put('/config/benchmarks/thresholds', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { status, excludeShortMin, inRangeMin, inRangeMax, excludeLongMax, changedBy } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });

    const db = await getConfigDb();
    const update = { updatedAt: new Date(), updatedBy: changedBy || req.user?.name || 'unknown' };
    if (excludeShortMin !== undefined) update.excludeShortMin = Number(excludeShortMin);
    if (inRangeMin !== undefined) update.inRangeMin = Number(inRangeMin);
    if (inRangeMax !== undefined) update.inRangeMax = Number(inRangeMax);
    if (excludeLongMax !== undefined) update.excludeLongMax = Number(excludeLongMax);

    await db.collection('dashboard_benchmarks').updateMany(
      { status },
      { $set: update }
    );

    await auditLog('update_thresholds', 'dashboard_benchmarks', { status, ...update }, req.user?.name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— Credential Counts ———————————————————————————————————
// For Data Entry XpH (unit = Credentials).
// Date-scoped to the same window as kpi-segments so credential counts
// are only counted for orders active within the reporting period.
// order-credentials.order is an ObjectId reference to orders._id.
app.get('/credential-counts', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, { min: 1, max: 365 });
    const cutoff = getCutoff(days);  // restored in v4.0 — was dropped in v2.1

    const db = await getDb('orders');
    const credsCol = db.collection('order-credentials');

    const counts = await credsCol.aggregate([
      {
        $match: {
          active: true,
          // Note: we do NOT filter by createdAt here because V1-imported credentials
          // have old createdAt dates even on recent orders. Scope is by parent order only.
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
        }
      },
      {
        $group: {
          _id: '$order',
          credentialCount: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          orderId: { $toString: '$_id' },
          credentialCount: 1
        }
      }
    ]).toArray();

    res.json({
      count: counts.length,
      dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
      credentials: counts
    });
  } catch (err) {
    console.error('Credential counts error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— Report Counts ——————————————————————————————————————
// Preserved from v2.1. Counts report items per order via the
// order-report-item collection (two-hop join: item → report → order).
// Note: /kpi-segments already embeds reportItemCount from order.reportItems.
// This endpoint is kept for reconciliation and alternative report count sourcing.
app.get('/report-counts', async (req, res) => {
  try {
    const db = await getDb('orders');
    const reportItemsCol = db.collection('order-report-item');
    const orderReportsCol = db.collection('order-report');

    const reports = await orderReportsCol.find(
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { projection: { _id: 1, order: 1 } }
    ).toArray();

    const reportToOrderMap = {};
    for (const report of reports) {
      reportToOrderMap[String(report._id)] = report.order;
    }

    const itemCounts = await reportItemsCol.aggregate([
      {
        $match: { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] }
      },
      {
        $group: { _id: '$orderReport', reportItemCount: { $sum: 1 } }
      }
    ]).toArray();

    const orderCounts = {};
    for (const itemCount of itemCounts) {
      const orderRef = reportToOrderMap[String(itemCount._id)];
      if (!orderRef) continue;
      const orderId = String(orderRef);
      orderCounts[orderId] = (orderCounts[orderId] || 0) + itemCount.reportItemCount;
    }

    const result = Object.entries(orderCounts).map(([orderId, count]) => ({ orderId, reportItemCount: count }));
    res.json({ count: result.length, reports: result });
  } catch (err) {
    console.error('Report counts error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— QC Events ——————————————————————————————————————————
// Usage: /qc-events?days=90&page=1&pageSize=5000&includeHtml=false&includeText=false
//
// One row per QC event. Collection: orders.order-discussion.
// Filter: type='system_logs' AND category.slug='quality_control'.
// Each event enriched with parent order context and status-at-QC derivation.
// orderSerialNumber included for Power BI join to KPI segments.
app.get('/qc-events', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, { min: 1, max: 365 });
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
    const pageSize = parsePositiveInt(req.query.pageSize, 5000, { min: 100, max: 10000 });
    const includeHtml = parseBoolean(req.query.includeHtml, true);
    const includeText = parseBoolean(req.query.includeText, true);

    const dataset = await getQcEventsDataset(days);
    const paged = paginate(dataset.events, page, pageSize);

    const events = paged.items.map(event => ({
      ...event,
      text: includeText ? event.text : undefined,
      html: includeHtml ? event.html : undefined
    }));

    res.json({
      count: events.length,
      totalCount: paged.totalCount,
      orderCount: new Set(dataset.events.map(e => e.orderId).filter(Boolean)).size,
      page: paged.page,
      pageSize: paged.pageSize,
      totalPages: paged.totalPages,
      hasMore: paged.hasMore,
      collectionUsed: 'order-discussion',
      qcFilter: {
        type: 'system_logs',
        categorySlug: 'quality_control',
        qcDateField: 'order-discussion.createdAt',
        departmentSource: 'order-discussion.department',
        allOrderPopulation: true
      },
      dateRange: { from: dataset.cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: dataset.refreshedAt.toISOString(),
      events
    });
  } catch (err) {
    console.error('QC events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— QC Orders ——————————————————————————————————————————
// Usage: /qc-orders?days=90&page=1&pageSize=5000
//
// One summary row per order with QC activity. Aggregates event-level
// fields (departments, issues, reporter/assignee names) into arrays.
app.get('/qc-orders', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, { min: 1, max: 365 });
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
    const pageSize = parsePositiveInt(req.query.pageSize, 5000, { min: 100, max: 10000 });

    const dataset = await getQcEventsDataset(days);
    const orderSummaries = buildQcOrderSummaries(dataset.events);
    const paged = paginate(orderSummaries, page, pageSize);

    res.json({
      count: paged.items.length,
      totalCount: paged.totalCount,
      qcEventCount: dataset.events.length,
      page: paged.page,
      pageSize: paged.pageSize,
      totalPages: paged.totalPages,
      hasMore: paged.hasMore,
      collectionUsed: 'order-discussion',
      qcFilter: {
        type: 'system_logs',
        categorySlug: 'quality_control',
        qcDateField: 'order-discussion.createdAt',
        departmentSource: 'order-discussion.department',
        allOrderPopulation: true
      },
      dateRange: { from: dataset.cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: dataset.refreshedAt.toISOString(),
      orders: paged.items
    });
  } catch (err) {
    console.error('QC orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— QC Summary —————————————————————————————————————————
// Usage: /qc-summary?days=90
//
// Aggregated QC metrics — no pagination. Suitable for dashboard header KPIs
// and breakdown charts (by department, issue, error type, reporter, assignee,
// status at QC, next status, daily trend).
app.get('/qc-summary', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, { min: 1, max: 365 });
    const dataset = await getQcEventsDataset(days);
    const orderSummaries = buildQcOrderSummaries(dataset.events);

    res.json({
      collectionUsed: 'order-discussion',
      qcFilter: {
        type: 'system_logs',
        categorySlug: 'quality_control',
        qcDateField: 'order-discussion.createdAt',
        departmentSource: 'order-discussion.department',
        allOrderPopulation: true
      },
      dateRange: { from: dataset.cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: dataset.refreshedAt.toISOString(),
      totals: {
        qcEventCount: dataset.events.length,
        qcOrderCount: orderSummaries.length,
        kickItBackCount: dataset.events.filter(e => e.isKickItBack).length,
        fixedItCount: dataset.events.filter(e => e.isFixedIt).length,
        avgQcEventsPerOrder: average(orderSummaries.map(o => o.qcEventCount)),
        avgMinutesToNextStatusChange: average(dataset.events.map(e => e.minutesToNextStatusChange)),
        avgHoursToNextStatusChange: average(dataset.events.map(e => e.hoursToNextStatusChange))
      },
      byDepartment: groupCounts(dataset.events, 'departmentName'),
      byOrderType: groupCounts(dataset.events, 'orderType'),
      byIssue: groupCounts(dataset.events, 'issueName'),
      byErrorType: groupCounts(dataset.events, 'errorType'),
      byReporter: groupCounts(dataset.events, 'reporterName'),
      byAssignee: groupCounts(dataset.events, 'accountableName'),
      byStatusAtQc: groupCounts(dataset.events, 'statusAtQcName'),
      byNextStatus: groupCounts(dataset.events, 'nextStatusName'),
      trendByDay: buildDailyTrend(dataset.events)
    });
  } catch (err) {
    console.error('QC summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— QC Discovery ————————————————————————————————————————
// Diagnostic scan — restored from v3.0.
// Scans all collections in the orders DB for QC-signal fields.
// Run after V2 deployments to verify order-discussion schema hasn't changed.
// Check /qc-discovery response and compare fieldsFound vs expectedFields.
app.get('/qc-discovery', async (req, res) => {
  try {
    const db = await getDb('orders');
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);

    const qcFieldSignals = [
      'errorType', 'isFixedIt', 'isKickItBack', 'errorAssignedTo',
      'kickback', 'qcError', 'qc_error', 'error_type'
    ];
    const results = [];

    for (const colName of collectionNames) {
      try {
        const col = db.collection(colName);
        const count = await col.countDocuments({});
        if (count === 0) continue;

        const samples = await col.find({}).limit(2).toArray();
        const allKeys = new Set();
        samples.forEach(doc => Object.keys(doc).forEach(k => allKeys.add(k)));
        const keys = Array.from(allKeys);

        const matchedSignals = qcFieldSignals.filter(sig => keys.includes(sig));

        let withErrorType = 0;
        if (keys.includes('errorType')) {
          withErrorType = await col.countDocuments({ errorType: { $exists: true, $ne: null } });
        }

        if (matchedSignals.length > 0
          || colName.toLowerCase().includes('qc')
          || colName.toLowerCase().includes('error')) {
          results.push({
            collection: colName,
            totalDocs: count,
            fields: keys,
            qcSignalsFound: matchedSignals,
            docsWithErrorType: withErrorType,
            likelyCandidateScore: matchedSignals.length + (withErrorType > 0 ? 5 : 0)
          });
        }
      } catch (e) {
        results.push({ collection: colName, error: e.message });
      }
    }

    results.sort((a, b) => (b.likelyCandidateScore || 0) - (a.likelyCandidateScore || 0));

    res.json({
      scannedCollections: collectionNames.length,
      candidatesFound: results.length,
      candidates: results,
      allCollections: collectionNames.sort()
    });
  } catch (err) {
    console.error('QC discovery error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— Indexes ————————————————————————————————————————————

// ── /users — Active staff list from user.user collection ──
app.get('/users', async (req, res) => {
  try {
    const userDb = await getDb('user');
    const col    = userDb.collection('user');

    // ── Type discovery mode ──────────────────────────────────
    // GET /users?discover=true returns all distinct type values in the collection.
    // Use this once to confirm which type values represent internal staff.
    if (req.query.discover === 'true') {
      const types = await col.distinct('type', {});
      const roleIds = await col.distinct('roleId', {});
      const sample = await col.find(
        {},
        { projection: { type: 1, roleId: 1, department: 1, firstName: 1, lastName: 1 } }
      ).limit(50).toArray();
      const byType = {};
      for (const doc of sample) {
        const t = doc.type || '(none)';
        if (!byType[t]) byType[t] = { count: 0, examples: [] };
        byType[t].count++;
        if (byType[t].examples.length < 3) {
          byType[t].examples.push({
            name: [doc.firstName, doc.lastName].filter(Boolean).join(' ') || '(blank)',
            dept: (doc.department && doc.department.name) || '',
            roleId: doc.roleId || ''
          });
        }
      }
      return res.json({ distinctTypes: types, distinctRoleIds: roleIds, sampleByType: byType });
    }

    // Staff role ObjectId (confirmed from user.role collection)
    const STAFF_ROLE_ID = '67acba952a78ccf7588a3ee1';

    // Filter: type='staff' only.
    // 'active' field is an account-activation flag in V2, NOT employment status —
    // many current staff have active:false. Do NOT filter on it.
    const STAFF_TYPES = ['staff'];

    // Internal email domains — only these are IEE employees or known internal accounts.
    // Contractors (gmail, yahoo, etc.) and legacy @foreigntranscripts.com are excluded.
    const INTERNAL_DOMAINS = ['myiee.org'];

    // Known junk/test/bot email prefixes and addresses to exclude server-side.
    const EXCLUDE_EMAILS = new Set([
      'devauth@myiee.org',          // IEE Dev bot
      'testadmin@myiee.org',        // Test Admin
      'worker@myiee.org',           // Evaluator McEvaluator test account
      'documentmanagement@myiee.org', // Shared CLT inbox, not a person
      'devscanner@myiee.org',       // Dev Scanner bot
      'testuser2@myiee.org',        // Test User 2
      'teststaaff@myiee.org',       // Test Staff
    ]);

    // Known junk name patterns (lowercase match)
    const JUNK_NAME_PATTERNS = [
      /^test/i, /^aaa/i, /omit omit/i, /evaluator mcevaluator/i,
      /^john doe$/i, /top lingual/i, /document management - clt/i,
      /^dev /i, /jagamohan/i, /^[?\s]+$/  // blank/corrupt names like "? ?"
    ];

    const cursor = col.find(
      { type: { $in: STAFF_TYPES } },
      {
        projection: {
          _id: 1,
          v1Id: 1,
          legacyId: 1,
          firstName: 1,
          middleName: 1,
          lastName: 1,
          email: 1,
          department: 1,
          tags: 1,
          type: 1,
          roleId: 1,
          active: 1
        }
      }
    ).sort({ lastName: 1, firstName: 1 });

    const docs = await cursor.toArray();

    const allMapped = docs.map(u => {
      // Name: firstName + lastName only (middleName excluded — unreliable)
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      const email    = (u.email || '').toLowerCase().trim();
      const dept     = (u.department && u.department.name) || '';

      // Tags: extract names as comma-separated string
      const tagNames = (u.tags || []).map(t => t.name).filter(Boolean).join(', ');

      // isStaff: has Staff roleId
      const isStaff = u.roleId === STAFF_ROLE_ID;

      // ── Exclusion logic ──────────────────────────────────────
      // 1. Excluded email list (known bots/test/shared inboxes)
      const isExcludedEmail = EXCLUDE_EMAILS.has(email);

      // 2. Domain filter — only @myiee.org internal staff
      const emailDomain = email.split('@')[1] || '';
      const isInternalDomain = INTERNAL_DOMAINS.includes(emailDomain);

      // 3. Junk name patterns
      const isJunkName = !fullName || JUNK_NAME_PATTERNS.some(p => p.test(fullName));

      // 4. N/A last name (external applicant accounts)
      const isNAAccount = (u.lastName || '').trim() === 'N/A';

      const excluded = isExcludedEmail || !isInternalDomain || isJunkName || isNAAccount;

      return {
        userId:       u._id.toString(),
        v1Id:         u.v1Id || null,
        legacyId:     u.legacyId || null,
        fullName:     fullName,
        email:        email,
        department:   dept,
        departmentId: (u.department && u.department.legacyId) || '',
        tags:         tagNames,
        type:         u.type || '',
        roleId:       u.roleId || '',
        isStaff:      isStaff,
        active:       u.active === true,
        _excluded:    excluded
      };
    });

    // Only return non-excluded users
    const users = allMapped.filter(u => !u._excluded).map(u => {
      const { _excluded, ...clean } = u;
      return clean;
    });

    res.json({
      count:      users.length,
      staffCount: users.filter(u => u.isStaff).length,
      totalRaw:   allMapped.length,
      excluded:   allMapped.filter(u => u._excluded).length,
      users
    });
  } catch (err) {
    console.error('/users error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/indexes', async (req, res) => {
  res.json({
    description: 'Run these in MongoDB Atlas → Data Explorer → each collection → Indexes tab → Create Index',
    indexes: [
      {
        database: 'orders', collection: 'orders', name: 'kpi_segments_query',
        keys: { paymentStatus: 1, orderType: 1, deletedAt: 1, 'orderStatusHistory.createdAt': 1 },
        reason: 'Speeds up the main KPI segments aggregation pipeline'
      },
      {
        database: 'orders', collection: 'order-credentials', name: 'credential_count_query_v2',
        keys: { active: 1, order: 1 },
        reason: 'Speeds up credential count grouping per order — filters active first then groups by order'
      },
      {
        database: 'orders', collection: 'order-discussion', name: 'qc_events_query_v4',
        keys: { type: 1, 'category.slug': 1, createdAt: -1, deletedAt: 1 },
        reason: 'Speeds up QC event filtering by quality_control discussion entries'
      },
      {
        database: 'orders', collection: 'orders', name: 'qc_order_lookup',
        keys: { _id: 1, orderSerialNumber: 1, orderType: 1, paymentStatus: 1 },
        reason: 'Supports QC event enrichment with order details and status history'
      },
      {
        database: 'orders', collection: 'order-report', name: 'report_order_lookup',
        keys: { order: 1, deletedAt: 1 },
        reason: 'Speeds up report count lookup per order (/report-counts)'
      },
      {
        database: 'orders', collection: 'order-report-item', name: 'report_item_grouping',
        keys: { orderReport: 1, deletedAt: 1 },
        reason: 'Speeds up report item count aggregation (/report-counts)'
      }
    ]
  });
});

// ═══════════════════════════════════════════════════════════
// QUEUE WAIT SUMMARY & QUEUE SNAPSHOT
// Added in v4.3 — queue-level metrics for operations.
// ═══════════════════════════════════════════════════════════

// —— Queue Wait Summary ———————————————————————————————————
// Usage: /queue-wait-summary?days=60
//
// Aggregates ALL status transitions over the time window and returns
// ONE ROW PER STATUS with:
//   - Volume: how many times orders entered this status
//   - Wait times: median, avg, p75, p90 duration in this status
//   - Aging: how many had wait > 24hr, > 48hr, > 72hr
//   - Flow: how many completed (exited) vs still open
//   - Next status distribution: where orders go after this status
//
// Only includes non-terminal statuses. Excludes zero-duration entries.
// This is HISTORICAL (over the window), not live — use /queue-snapshot for live.
// ── computeQueueWaitSummary — shared logic used by both the HTTP endpoint
// and the backfill system. Calling internalFetch('/queue-wait-summary') from
// inside the backfill caused a self-referential HTTP round-trip that added
// 10s to every backfill cycle. This function is called directly instead.
async function computeQueueWaitSummary(days = 90) {
  // Floor at 2025-01-01 — pre-2025 orders are historical V1 backlog and skew wait stats
  const WAIT_FLOOR = new Date('2025-01-01T00:00:00Z');
  const rawCutoff = getCutoff(days);
  const cutoff = rawCutoff < WAIT_FLOOR ? WAIT_FLOOR : rawCutoff;
  const TERMINAL_SLUGS = ['completed', 'deleted', 'refunded', 'confirmed-fraudulent', 'expired'];

  const db = await getDb('orders');
  const ordersCol = db.collection('orders');

  const orders = await ordersCol.aggregate([
    {
      $match: {
        paymentStatus: 'paid',
        orderType: { $in: ['evaluation', 'translation'] },
        deletedAt: null,
        orderStatusHistory: { $exists: true, $not: { $size: 0 } },
        'orderStatusHistory.createdAt': { $gte: cutoff }
      }
    },
    { $project: { orderType: 1, orderStatusHistory: 1 } }
  ], { allowDiskUse: true }).toArray();

  const statusMap = new Map();

  for (const order of orders) {
    const history = Array.isArray(order.orderStatusHistory) ? order.orderStatusHistory : [];
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const entryDate = toDate(entry?.createdAt);
      if (!entryDate || entryDate < cutoff) continue;

      const slug = entry?.updatedStatus?.slug || '';
      const name = entry?.updatedStatus?.name || '';
      const type = entry?.updatedStatus?.statusType || '';
      if (TERMINAL_SLUGS.includes(slug)) continue;

      const nextEntry = i + 1 < history.length ? history[i + 1] : null;
      const nextDate = toDate(nextEntry?.createdAt);
      const durationHours = nextDate ? (nextDate.getTime() - entryDate.getTime()) / 3600000 : null;
      if (durationHours !== null && durationHours <= 0) continue;

      const nextSlug = nextEntry?.updatedStatus?.slug || null;
      const nextName = nextEntry?.updatedStatus?.name || null;
      const isOpen = nextDate === null;

      if (!statusMap.has(slug)) {
        statusMap.set(slug, { slug, name, type, durations: [], openCount: 0, totalVolume: 0, evalCount: 0, transCount: 0, nextStatuses: new Map() });
      }

      const bucket = statusMap.get(slug);
      bucket.totalVolume++;
      if (order.orderType === 'evaluation') bucket.evalCount++;
      if (order.orderType === 'translation') bucket.transCount++;
      if (isOpen) { bucket.openCount++; }
      else if (durationHours !== null) { bucket.durations.push(durationHours); }
      if (nextSlug) { const ns = nextName || nextSlug; bucket.nextStatuses.set(ns, (bucket.nextStatuses.get(ns) || 0) + 1); }
    }
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx); const hi = Math.ceil(idx);
    if (lo === hi) return Math.round(sorted[lo] * 10) / 10;
    return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)) * 10) / 10;
  }

  const summary = [...statusMap.values()].map(s => {
    const sorted = s.durations.slice().sort((a, b) => a - b);
    const avg = sorted.length ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10 : null;
    const topNext = [...s.nextStatuses.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,c])=>`${n} (${c})`).join(', ');
    return {
      statusName: s.name, statusSlug: s.slug, statusType: s.type,
      totalVolume: s.totalVolume, completedCount: sorted.length,
      openCount: s.openCount, evaluationCount: s.evalCount, translationCount: s.transCount,
      medianWaitHours: percentile(sorted, 50), avgWaitHours: avg,
      p75WaitHours: percentile(sorted, 75), p90WaitHours: percentile(sorted, 90),
      over24h: sorted.filter(h=>h>24).length, over48h: sorted.filter(h=>h>48).length, over72h: sorted.filter(h=>h>72).length,
      minWaitHours: sorted.length ? Math.round(sorted[0]*100)/100 : null,
      maxWaitHours: sorted.length ? Math.round(sorted[sorted.length-1]*10)/10 : null,
      topNextStatuses: topNext,
      isWaiting: ['Holding','Waiting','On-Hold'].includes(s.type) || s.slug.startsWith('awaiting'),
      isProcessing: s.type === 'Processing'
    };
  }).sort((a,b) => b.totalVolume - a.totalVolume);

  return {
    refreshedAt: new Date().toISOString(),
    days,
    dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
    orderCount: orders.length,
    statusCount: summary.length,
    summary
  };
}

app.get('/queue-wait-summary', async (req, res) => {
  // Thin wrapper — delegates to computeQueueWaitSummary() which is also called
  // directly by the backfill system to avoid a self-referential HTTP round-trip.
  try {
    const days = parsePositiveInt(req.query.days, 60, { min: 1, max: 900 });
    const result = await computeQueueWaitSummary(days);
    res.json(result);
  } catch (err) {
    console.error('Queue wait summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— Queue Snapshot (Enhanced) ————————————————————————————
// Usage: /queue-snapshot?since=2024-01-01
//
// Returns actionable queue metrics for each active status:
//   - Order count (total, eval, translation)
//   - Median wait time (not skewed by outliers)
//   - Aging buckets: orders waiting >24h, >48h, >72h
//   - Flow rate: orders entering today vs orders that were picked up today
//   - Oldest and newest entry (for context)
//
// Terminal statuses (Completed, Refunded, Deleted, Cancelled, etc.)
// are excluded — only Waiting, Holding, Processing, and On-Hold shown.
//
// The `since` parameter excludes orders that entered their current status
// before the given date. Default: 2024-01-01. This filters out abandoned
// orders stuck in old statuses for years.
app.get('/queue-snapshot', async (req, res) => {
  try {
    const db = await getDb('orders');
    const ordersCol = db.collection('orders');

    // Default cutoff: exclude orders stuck since before 2025 (pre-2025 data is historical V1 backlog)
    const sinceStr = req.query.since || '2025-01-01';
    const sinceCutoff = new Date(sinceStr + 'T00:00:00Z');

    // Terminal status types to exclude
    const TERMINAL_TYPES = ['Completed', 'Cancelled', 'Refunded', 'Voided'];
    const TERMINAL_SLUGS = ['completed', 'deleted', 'refunded', 'confirmed-fraudulent', 'expired'];

    const results = await ordersCol.aggregate([
      {
        $match: {
          paymentStatus: 'paid',
          orderType: { $in: ['evaluation', 'translation'] },
          deletedAt: null,
          orderStatusHistory: { $exists: true, $not: { $size: 0 } }
        }
      },
      {
        $addFields: {
          currentStatus: { $arrayElemAt: ['$orderStatusHistory', -1] }
        }
      },
      {
        // Exclude terminal statuses AND orders stuck since before cutoff
        $match: {
          'currentStatus.updatedStatus.statusType': { $nin: TERMINAL_TYPES },
          'currentStatus.updatedStatus.slug': { $nin: TERMINAL_SLUGS },
          'currentStatus.createdAt': { $gte: sinceCutoff }
        }
      },
      {
        $group: {
          _id: {
            slug: '$currentStatus.updatedStatus.slug',
            name: '$currentStatus.updatedStatus.name',
            type: '$currentStatus.updatedStatus.statusType'
          },
          orderCount: { $sum: 1 },
          orderTypes: { $push: '$orderType' },
          // Collect all entry timestamps for percentile calculation
          entryTimes: { $push: '$currentStatus.createdAt' },
          oldestEntry: { $min: '$currentStatus.createdAt' },
          newestEntry: { $max: '$currentStatus.createdAt' }
        }
      },
      { $sort: { orderCount: -1 } }
    ], { allowDiskUse: true }).toArray();

    const now = new Date();
    const ONE_HOUR = 3600000;
    const ONE_DAY = 86400000;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const snapshot = results.map(r => {
      const evalCount = r.orderTypes.filter(t => t === 'evaluation').length;
      const transCount = r.orderTypes.filter(t => t === 'translation').length;

      // Calculate wait times in hours for each order
      const waitHours = (r.entryTimes || [])
        .map(t => toDate(t))
        .filter(d => d !== null)
        .map(d => (now.getTime() - d.getTime()) / ONE_HOUR)
        .sort((a, b) => a - b); // ascending for percentile calc

      // Median wait time
      let medianWaitHours = null;
      if (waitHours.length > 0) {
        const mid = Math.floor(waitHours.length / 2);
        medianWaitHours = waitHours.length % 2 === 0
          ? Math.round(((waitHours[mid - 1] + waitHours[mid]) / 2) * 10) / 10
          : Math.round(waitHours[mid] * 10) / 10;
      }

      // Aging buckets
      const over24h = waitHours.filter(h => h > 24).length;
      const over48h = waitHours.filter(h => h > 48).length;
      const over72h = waitHours.filter(h => h > 72).length;

      // Flow rate: how many entered THIS status today
      const enteredToday = (r.entryTimes || [])
        .map(t => toDate(t))
        .filter(d => d !== null && d >= todayStart)
        .length;

      const oldestDate = toDate(r.oldestEntry);
      const newestDate = toDate(r.newestEntry);

      return {
        statusSlug: r._id.slug || '',
        statusName: r._id.name || '',
        statusType: r._id.type || '',
        orderCount: r.orderCount,
        evaluationCount: evalCount,
        translationCount: transCount,
        medianWaitHours,
        over24h,
        over48h,
        over72h,
        enteredToday,
        oldestWaitHours: oldestDate
          ? Math.round((now.getTime() - oldestDate.getTime()) / ONE_HOUR * 10) / 10
          : null,
        oldestWaitingSince: toIso(oldestDate),
        newestEntry: toIso(newestDate),
        isProcessingStatus: r._id.type === 'Processing',
        isWaitingStatus: ['Holding', 'Waiting', 'On-Hold'].includes(r._id.type)
          || (r._id.slug || '').startsWith('awaiting')
      };
    });

    const totalInQueue = snapshot.reduce((sum, s) => sum + s.orderCount, 0);
    const waitingOnly = snapshot.filter(s => s.isWaitingStatus);
    const processingOnly = snapshot.filter(s => s.isProcessingStatus);

    res.json({
      refreshedAt: new Date().toISOString(),
      since: sinceStr,
      totalActiveOrders: totalInQueue,
      waitingOrders: waitingOnly.reduce((sum, s) => sum + s.orderCount, 0),
      processingOrders: processingOnly.reduce((sum, s) => sum + s.orderCount, 0),
      statusCount: snapshot.length,
      snapshot
    });
  } catch (err) {
    console.error('Queue snapshot error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// AUTH & USER MANAGEMENT — v4.5
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════

// —— POST /auth/setup — First-time admin creation ——————————
// Only works if no users exist yet AND the setup secret matches.
// Set SETUP_SECRET in Railway env vars. Without it, setup is disabled.
app.post('/auth/setup', async (req, res) => {
  try {
    const { email, password, name, setupSecret } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password, and name required' });
    }

    // Require setup secret if configured (recommended)
    if (CONFIG.SETUP_SECRET && setupSecret !== CONFIG.SETUP_SECRET) {
      return res.status(403).json({ error: 'Invalid setup secret' });
    }

    const db = await getConfigDb();
    const existing = await db.collection('dashboard_users').countDocuments();
    if (existing > 0) {
      return res.status(400).json({ error: 'Setup already completed. Use /auth/login.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const apiKey = 'iee_' + crypto.randomBytes(24).toString('hex');

    const user = {
      email: email.toLowerCase().trim(),
      passwordHash: hash,
      name: name.trim(),
      role: 'admin',
      apiKey,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('dashboard_users').insertOne(user);
    user._id = result.insertedId;

    await auditLog('create_user', 'dashboard_users', { email: user.email, role: 'admin' }, 'system_setup');

    const token = generateToken(user);
    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, name: user.name, role: user.role, apiKey }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /auth/login ——————————————————————————————————————
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }

    const db = await getConfigDb();
    const user = await db.collection('dashboard_users').findOne({
      email: email.toLowerCase().trim(),
      isActive: true
    });

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Update last login
    await db.collection('dashboard_users').updateOne(
      { _id: user._id },
      { $set: { lastLoginAt: new Date() } }
    );

    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /auth/me ——————————————————————————————————————————
app.get('/auth/me', async (req, res) => {
  try {
    if (!req.user?.userId) {
      return res.json({ user: { name: req.user?.name || 'API Key', role: req.user?.role || 'admin' } });
    }
    const db = await getConfigDb();
    const user = await db.collection('dashboard_users').findOne(
      { _id: new ObjectId(req.user.userId) },
      { projection: { passwordHash: 0 } }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /auth/users — List all users (admin only) ————————
app.get('/auth/users', requireRole('admin'), async (req, res) => {
  try {
    const db = await getConfigDb();
    const users = await db.collection('dashboard_users')
      .find({}, { projection: { passwordHash: 0 } })
      .sort({ name: 1 })
      .toArray();
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /auth/users — Create user or send invite (admin only) ——
// Body: { email, name, role, password }         → create with password
// Body: { email, name, role, sendInvite: true }  → create pending + send invite email
app.post('/auth/users', requireRole('admin'), async (req, res) => {
  try {
    const { email, name, role, password, sendInvite } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'email and name required' });
    }
    const validRoles = ['admin', 'manager', 'viewer'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'role must be admin, manager, or viewer' });
    }

    const db = await getConfigDb();
    const exists = await db.collection('dashboard_users').findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ error: 'User with this email already exists' });

    const apiKey = 'iee_' + crypto.randomBytes(24).toString('hex');
    const inviteToken = sendInvite ? crypto.randomBytes(32).toString('hex') : null;
    const inviteExpiresAt = sendInvite ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null; // 7 days

    const user = {
      email: email.toLowerCase().trim(),
      passwordHash: password ? await bcrypt.hash(password, 12) : null,
      name: name.trim(),
      role: role || 'viewer',
      apiKey,
      isActive: !sendInvite, // pending until they accept
      isPending: !!sendInvite,
      inviteToken,
      inviteExpiresAt,
      invitedBy: req.user?.name || 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: req.user?.name || 'admin'
    };

    const result = await db.collection('dashboard_users').insertOne(user);

    await auditLog('create_user', 'dashboard_users',
      { email: user.email, role: user.role, createdBy: req.user?.name, invited: !!sendInvite },
      req.user?.name);

    // Send invite email if requested and SendGrid is configured
    let inviteEmailStatus = null;
    if (sendInvite) {
      if (!CONFIG.SENDGRID_API_KEY) {
        inviteEmailStatus = { sent: false, reason: 'SENDGRID_API_KEY not configured' };
        console.error('[INVITE] Cannot send invite — SENDGRID_API_KEY missing');
      } else if (!CONFIG.SENDGRID_INVITE_TEMPLATE_ID) {
        inviteEmailStatus = { sent: false, reason: 'SENDGRID_INVITE_TEMPLATE_ID not configured' };
        console.error('[INVITE] Cannot send invite — SENDGRID_INVITE_TEMPLATE_ID missing');
      } else {
        try {
          const dashboardUrl = req.headers.origin || `https://${req.headers.host}`;
          const inviteUrl = `${dashboardUrl}/invite?token=${inviteToken}`;

          const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${CONFIG.SENDGRID_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              personalizations: [{
                to: [{ email: user.email }],
                dynamic_template_data: {
                  recipient_name: user.name.split(' ')[0],
                  sender_name: req.user?.name || 'Operations',
                  role: user.role,
                  invite_url: inviteUrl,
                  expires_in: '7 days',
                  dashboard_url: dashboardUrl
                }
              }],
              from: { email: CONFIG.SENDGRID_FROM_EMAIL, name: 'IEE Ops Dashboard' },
              template_id: CONFIG.SENDGRID_INVITE_TEMPLATE_ID
            })
          });

          if (!sgRes.ok) {
            const errBody = await sgRes.text();
            inviteEmailStatus = { sent: false, reason: `SendGrid ${sgRes.status}: ${errBody}` };
            console.error(`[INVITE] SendGrid error for ${user.email}:`, sgRes.status, errBody);
          } else {
            inviteEmailStatus = { sent: true };
            console.log(`[INVITE] Sent invite email to ${user.email}`);
          }
        } catch (emailErr) {
          inviteEmailStatus = { sent: false, reason: emailErr.message };
          console.error(`[INVITE] Failed to send invite email:`, emailErr.message);
          // Don't fail the request — user is created, email just didn't send
        }
      }
    }

    res.json({
      success: true,
      invited: !!sendInvite,
      inviteEmail: inviteEmailStatus,
      user: { id: result.insertedId, email: user.email, name: user.name, role: user.role, apiKey, isPending: user.isPending }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /auth/accept-invite — Set password via invite token ——
// Public endpoint — no auth required
app.post('/auth/accept-invite', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const db = await getConfigDb();
    const user = await db.collection('dashboard_users').findOne({ inviteToken: token });

    if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
    if (user.inviteExpiresAt && new Date() > new Date(user.inviteExpiresAt)) {
      return res.status(410).json({ error: 'Invite link has expired. Ask your administrator to resend.' });
    }

    const hash = await bcrypt.hash(password, 12);
    await db.collection('dashboard_users').updateOne(
      { _id: user._id },
      { $set: {
        passwordHash: hash,
        isActive: true,
        isPending: false,
        inviteToken: null,
        inviteExpiresAt: null,
        activatedAt: new Date(),
        updatedAt: new Date()
      }}
    );

    await auditLog('accept_invite', 'dashboard_users', { email: user.email }, user.email);

    // Auto-login
    const token2 = generateToken({ ...user, isActive: true, isPending: false });
    res.json({
      success: true,
      token: token2,
      user: { id: user._id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /auth/resend-invite — Resend invite email (admin) ——
app.post('/auth/resend-invite', requireRole('admin'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const db = await getConfigDb();
    const user = await db.collection('dashboard_users').findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.isPending) return res.status(400).json({ error: 'User has already accepted their invite' });

    // Generate new token
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.collection('dashboard_users').updateOne(
      { _id: user._id },
      { $set: { inviteToken, inviteExpiresAt, updatedAt: new Date() } }
    );

    if (!CONFIG.SENDGRID_API_KEY || !CONFIG.SENDGRID_INVITE_TEMPLATE_ID) {
      const reason = !CONFIG.SENDGRID_API_KEY ? 'SENDGRID_API_KEY not configured' : 'SENDGRID_INVITE_TEMPLATE_ID not configured';
      console.error(`[INVITE] Cannot resend invite to ${user.email} — ${reason}`);
      await auditLog('resend_invite', 'dashboard_users', { email: user.email }, req.user?.name);
      return res.json({ success: true, inviteEmail: { sent: false, reason } });
    }

    try {
      const dashboardUrl = req.headers.origin || `https://${req.headers.host}`;
      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{
            to: [{ email: user.email }],
            dynamic_template_data: {
              recipient_name: user.name.split(' ')[0],
              sender_name: req.user?.name || 'Operations',
              role: user.role,
              invite_url: `${dashboardUrl}/invite?token=${inviteToken}`,
              expires_in: '7 days',
              dashboard_url: dashboardUrl
            }
          }],
          from: { email: CONFIG.SENDGRID_FROM_EMAIL, name: 'IEE Ops Dashboard' },
          template_id: CONFIG.SENDGRID_INVITE_TEMPLATE_ID
        })
      });

      if (!sgRes.ok) {
        const errBody = await sgRes.text();
        console.error(`[INVITE] SendGrid error on resend for ${user.email}:`, sgRes.status, errBody);
        await auditLog('resend_invite', 'dashboard_users', { email: user.email }, req.user?.name);
        return res.json({ success: true, inviteEmail: { sent: false, reason: `SendGrid ${sgRes.status}: ${errBody}` } });
      }
      console.log(`[INVITE] Resent invite email to ${user.email}`);
    } catch (emailErr) {
      console.error(`[INVITE] Failed to resend invite email:`, emailErr.message);
      await auditLog('resend_invite', 'dashboard_users', { email: user.email }, req.user?.name);
      return res.json({ success: true, inviteEmail: { sent: false, reason: emailErr.message } });
    }

    await auditLog('resend_invite', 'dashboard_users', { email: user.email }, req.user?.name);
    res.json({ success: true, inviteEmail: { sent: true } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /auth/users/:id — Update user (admin only) ———————
app.put('/auth/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const { name, role, isActive, password } = req.body;
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name.trim();
    if (role !== undefined) update.role = role;
    if (isActive !== undefined) update.isActive = isActive;
    if (password) update.passwordHash = await bcrypt.hash(password, 12);

    const db = await getConfigDb();
    await db.collection('dashboard_users').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: update }
    );

    await auditLog('update_user', 'dashboard_users',
      { userId: req.params.id, fields: Object.keys(update) },
      req.user?.name);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /auth/users/:id/regenerate-key — New API key —————
app.post('/auth/users/:id/regenerate-key', requireRole('admin'), async (req, res) => {
  try {
    const apiKey = 'iee_' + crypto.randomBytes(24).toString('hex');
    const db = await getConfigDb();
    await db.collection('dashboard_users').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { apiKey, updatedAt: new Date() } }
    );

    await auditLog('regenerate_api_key', 'dashboard_users',
      { userId: req.params.id },
      req.user?.name);

    res.json({ success: true, apiKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— DELETE /auth/users/:id — Permanently delete a dashboard user ——
app.delete('/auth/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const db = await getConfigDb();
    const user = await db.collection('dashboard_users').findOne({ _id: new ObjectId(req.params.id) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent self-deletion
    if (user._id.toString() === req.user?.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    await db.collection('dashboard_users').deleteOne({ _id: new ObjectId(req.params.id) });
    await auditLog('delete_user', 'dashboard_users',
      { userId: req.params.id, email: user.email, name: user.name },
      req.user?.name);

    res.json({ success: true, deleted: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /config/benchmarks/statuses — Distinct status slugs from backfill ——
// Used by the Benchmarks config UI to prefill the status dropdown
app.get('/config/benchmarks/statuses', async (req, res) => {
  try {
    const db = await getConfigDb();
    const slugs = await db.collection('backfill_kpi_segments').distinct('statusSlug');
    const names = await db.collection('backfill_kpi_segments').distinct('statusName');
    // Build slug→name map
    const segments = await db.collection('backfill_kpi_segments')
      .aggregate([
        { $group: { _id: '$statusSlug', name: { $first: '$statusName' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).toArray();
    res.json({
      statuses: segments.map(s => ({ slug: s._id, name: s.name, count: s.count }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// AI CHATBOT — Claude API proxy with live data access
// ═══════════════════════════════════════════════════════════

const DEFAULT_SYSTEM_PROMPT = `You are the IEE Operations Intelligence Assistant — a senior data analyst with direct access to live data via tools.

RULES:
- Always call a tool before answering questions about current data. Never guess.
- Lead with the number or conclusion, then explain.
- For dept questions: always pass dept= to tools. If dept is ambiguous, ask first.
- Show your math for staffing calculations: ceil(arrivals/hr ÷ XpH) + 20-30% buffer.
- Flag anomalies you notice even if not asked. End every substantive response with "Watch out:" or "Recommendation:" if data warrants it.
- Never invent numbers. If a tool returns empty data, say so.
- XpH = unit/hr where unit = Orders (1/seg), Credentials (credentialCount/seg), or Reports (reportItemCount/seg) — set per-status in Configuration > Benchmarks.
- Staffing model WARNING: always pass dept= or the numbers are system-wide and will massively overstate headcount needs.
- Data before 2026-02-07 is V1 historical import — treat trend analysis with caution.

DEPARTMENTS: Digital Records | Evaluation | Digital Fulfillment | Document Management | Customer Support | Translations | Data Entry

ORDER LIFECYCLE: payment → Digital Records → Evaluation → Digital Fulfillment → Completed
- Documentation Needed / Awaiting Documents = customer hasn't submitted docs (not ops bottleneck)
- Financial Hold = billing issue, not ops
- Orders >72h in Waiting status = ops concern

XPH BENCHMARKS: Simple statuses (DR Processing, Initial Review) healthy at 4-8 XpH. Complex evaluation statuses healthy at 1-3 XpH. Flag if worker drops >30% week-over-week.

All times US Eastern.`

// —— GET /ai/system-prompt ————————————————————————————————
app.get('/ai/system-prompt', async (req, res) => {
  try {
    const db = await getConfigDb();
    const prompt = await db.collection('dashboard_ai_prompts')
      .findOne({ active: true }, { sort: { updatedAt: -1 } });
    res.json({
      prompt: prompt?.content || DEFAULT_SYSTEM_PROMPT,
      isDefault: !prompt,
      updatedAt: prompt?.updatedAt || null,
      updatedBy: prompt?.updatedBy || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /ai/system-prompt ————————————————————————————————
app.put('/ai/system-prompt', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    const db = await getConfigDb();
    // Deactivate old prompts
    await db.collection('dashboard_ai_prompts').updateMany(
      { active: true },
      { $set: { active: false } }
    );

    await db.collection('dashboard_ai_prompts').insertOne({
      content,
      active: true,
      updatedBy: req.user?.name || 'unknown',
      updatedAt: new Date(),
      createdAt: new Date()
    });

    await auditLog('update_system_prompt', 'dashboard_ai_prompts',
      { length: content.length },
      req.user?.name);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /ai/suggested-questions ———————————————————————————
app.get('/ai/suggested-questions', (req, res) => {
  res.json({
    questions: [
      {
        text: 'Give me a full operations briefing for today — volume, queue health, and any red flags.',
        category: '📋 Daily Briefing',
        description: 'Pulls live data across all sources for a morning standup summary'
      },
      {
        text: 'Which worker had the biggest XpH drop this week and what might explain it?',
        category: '👤 Worker Intelligence',
        description: 'Identifies performance drops and surfaces context automatically'
      },
      {
        text: 'How much staff does the Digital Records team need next Monday based on historical demand?',
        category: '◑ Staffing Forecast',
        description: 'Uses order arrival patterns and XpH to compute required concurrent staff'
      },
      {
        text: 'What is our current SLA performance and which order types are most at risk?',
        category: '⏱ SLA Health',
        description: 'P50/P75/P90 turnaround vs recommended targets with late % breakdown'
      },
      {
        text: 'Which statuses are bottlenecks right now — where are orders waiting the longest?',
        category: '🚧 Bottlenecks',
        description: 'Combines live queue depth with historical wait time data'
      },
      {
        text: 'Show me the top 5 workers by XpH this month and compare them to benchmark.',
        category: '🏆 Performance Ranking',
        description: 'Ranks workers by throughput and shows attainment vs configured benchmarks'
      },
      {
        text: 'Which departments have the worst QC kick-back rate and what issues are driving it?',
        category: '✅ QC Deep Dive',
        description: 'Breaks down rework by department, issue type, and accountable worker'
      },
      {
        text: 'Are there any orders that have been open for more than 48 hours? Show me the oldest ones.',
        category: '⚠️ Stuck Orders',
        description: 'Scans for aged open segments that may need urgent attention'
      }
    ]
  });
});

// AI-specific rate limiter (stricter than global)
const aiRateLimit = rateLimit({ windowMs: 60000, max: 10, message: { error: 'AI rate limit exceeded. Max 10 requests per minute.' }, standardHeaders: true, legacyHeaders: false });

// —— POST /ai/chat —————————————————————————————————————————
// Proxies to Claude API with internal data tools
app.post(`/ai/chat`, aiRateLimit, async (req, res) => {
  const chatMemMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[AI/chat] ▶ request — user=${req.user?.name||'?'} mem=${chatMemMB}MB backfillRunning=${backfillRunning}`);

  // Memory guard: only block if backfill running AND memory is extremely high.
  // Raised from 420 → 4000MB — server runs on 32GB Railway instance.
  if (backfillRunning && chatMemMB > 4000) {
    console.warn(`[AI/chat] ✗ blocked by memory guard (${chatMemMB}MB > 4000MB)`);
    return res.status(503).json({
      error: 'A data sync is running in the background. Please try again in 2–3 minutes.',
      retryAfter: 120
    });
  }

  try {
    if (!CONFIG.CLAUDE_API_KEY) {
      console.error('[AI/chat] ✗ CLAUDE_API_KEY not set');
      return res.status(500).json({ error: 'Claude API key not configured' });
    }

    let { messages, context } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    // Get system prompt
    const db = await getConfigDb();
    const promptDoc = await db.collection('dashboard_ai_prompts')
      .findOne({ active: true }, { sort: { updatedAt: -1 } });
    const systemPrompt = promptDoc?.content || DEFAULT_SYSTEM_PROMPT;
    const glossaryText = await getGlossaryText();

    // Build context from any pre-fetched data
    let contextStr = '';
    if (context) {
      contextStr = '\n\nCurrent data context provided by the dashboard:\n' + JSON.stringify(context, null, 2);
    }

    // Define tools that Claude can use to fetch live data
    // GUARDRAILS: All tools are capped at 90 days max, return summaries only (never raw rows)
    const guardrailConfig = await getGuardrails();
    // Guard: if stored model string is stale/invalid, override with current default.
    // Prevents a bad value in dashboard_ai_guardrails from silently 500ing all chat.
    const VALID_MODELS = ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'];
    if (guardrailConfig.model && !VALID_MODELS.includes(guardrailConfig.model)) {
      console.warn(`[AI] Stored model "${guardrailConfig.model}" is not valid — overriding with claude-sonnet-4-5`);
      guardrailConfig.model = 'claude-sonnet-4-5';
    }
    const maxIterations = guardrailConfig.maxToolIterations || 5;
    const tools = [
      {
        name: 'fetch_kpi_summary',
        description: 'Fetch complete KPI summary with unit-aware XpH (Orders/Credentials/Reports per hour), segment counts, and worker rankings. Always pass dept when user asks about a specific department.',
        input_schema: {
          type: 'object',
          properties: {
            dept: { type: 'string', description: 'Department filter: Digital Records, Evaluation, Data Entry, Digital Fulfillment, Document Management, Translations, Customer Support. Omit for all.' },
            days: { type: 'number', description: 'Days to look back (max 90, default 60).' }
          }
        }
      },
      {
        name: 'fetch_queue_snapshot',
        description: 'Fetch the LIVE queue snapshot. Shows how many orders are currently in each status with median wait times, aging buckets (>24h, >48h, >72h), and flow rate. No parameters needed.',
        input_schema: { type: 'object', properties: {} }
      },
      {
        name: 'fetch_queue_wait_summary',
        description: 'Fetch historical queue wait time analysis. Shows median, avg, p75, p90 wait hours per status. Max 90 days.',
        input_schema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Days to analyze (max 90, default 60).' }
          }
        }
      },
      {
        name: 'fetch_qc_summary',
        description: 'Fetch QC event summary. Returns error counts by department, issue type, and accountable user. Max 90 days.',
        input_schema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Days (max 90, default 60).' }
          }
        }
      },
      {
        name: 'fetch_user_list',
        description: 'Fetch staff roster with names, emails, and departments. Returns first 50 users. Use to look up workers.',
        input_schema: { type: 'object', properties: {} }
      },
      {
        name: 'fetch_worker_pattern',
        description: 'Fetch a specific worker\'s activity pattern for the last N days. Pass the worker name or email. Returns their segments grouped by day with status breakdown, total hours, and patterns. Use for questions like "What did Deana do last week?" or "Show me John\'s work pattern."',
        input_schema: { type: 'object', properties: {
          worker: { type: 'string', description: 'Worker name or email (required)' },
          days: { type: 'number', description: 'Days to look back (default 14)' }
        } }
      },
      {
        name: 'fetch_anomaly_scan',
        description: 'Scan for data anomalies and inconsistencies. Returns workers with unusual patterns: zero-activity days during work hours, abnormally high/low segment counts, segments with impossible durations, orders stuck in processing for extended periods, workers with no QC events despite high volume. Use when asked about discrepancies, suspicious patterns, or data quality.',
        input_schema: { type: 'object', properties: {
          dept: { type: 'string', description: 'Department filter for targeted anomaly scan.' },
          days: { type: 'number', description: 'Days to scan (default 7, max 30)' }
        } }
      },
      {
        name: 'fetch_order_demand',
        description: 'Fetch order arrival demand patterns and SLA analysis. Returns avg daily orders, peak hours/days, volume by day-of-week, SLA distributions, bottleneck statuses. Pass dept for department-filtered demand.',
        input_schema: { type: 'object', properties: {
          dept: { type: 'string', description: 'Department filter e.g. Digital Records, Evaluation. Omit for system-wide.' },
          days: { type: 'number', description: 'Days to look back (default 60)' }
        } }
      },
      {
        name: 'fetch_staffing_model',
        description: 'Fetch staffing model: required concurrent staff by hour based on order demand and team XpH. Returns peak hour, staff-by-hour, weighted team XpH, and XpH per status. ALWAYS pass dept when user asks about a specific team — system-wide numbers will be misleading.',
        input_schema: { type: 'object', properties: {
          dept: { type: 'string', description: 'REQUIRED for dept-specific staffing. e.g. Digital Records, Evaluation, Data Entry. Without this, system-wide demand is used which overstates staffing needs.' }
        } }
      }
    ];

    // First Claude call
    const useModel = guardrailConfig.model || 'claude-sonnet-4-5';
    console.log(`[AI/chat] → calling Anthropic API model=${useModel} msgs=${messages.length}`);
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: guardrailConfig.maxTokens || 4096,
        system: systemPrompt + glossaryText + contextStr,
        messages,
        tools
      })
    });

    console.log(`[AI/chat] ← Anthropic response status=${claudeRes.status}`);
    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error(`[AI/chat] ✗ Anthropic API error ${claudeRes.status}:`, errBody);
      return res.status(500).json({ error: 'Claude API error: ' + claudeRes.status });
    }

    let claudeData = await claudeRes.json();
    console.log(`[AI/chat] stop_reason=${claudeData.stop_reason} content_blocks=${claudeData.content?.length}`);

    // Handle tool use — Claude wants to fetch data
    let iterations = 0;

    while (claudeData.stop_reason === 'tool_use' && iterations < maxIterations) {
      iterations++;
      const toolBlocks = claudeData.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolBlock of toolBlocks) {
        let result;
        try {
          // ── GUARDRAILS: loaded from MongoDB config ──
          const g = await getGuardrails();
          const AI_MAX_DAYS = g.maxDays || 90;
          const AI_PAGE_SIZE = g.maxPageSize || 2000;

          switch (toolBlock.name) {
            case 'fetch_kpi_summary': {
              // Aggregate directly in MongoDB — avoids loading 150k+ segments into memory
              // which caused OOM spikes on Railway's 512MB container.
              const days = Math.min(toolBlock.input?.days || 60, AI_MAX_DAYS);
              const dept = toolBlock.input?.dept || '';
              const aiCutoff = new Date(Date.now() - days * 86400000);

              const aiSegDb = await getConfigDb();

              // Load benchmarks for xphUnit
              const aiBenchDocs = await aiSegDb.collection('dashboard_benchmarks')
                .find({}, { projection:{ status:1, xphUnit:1 } }).toArray();
              const aiXphUnitMap = {};
              for (const b of aiBenchDocs) if (b.status) aiXphUnitMap[b.status] = b.xphUnit || 'Orders';

              const aiMatch = {
                isOpen: false,
                durationMinutes: { $gt: 0 },
                segmentStart: { $gte: aiCutoff.toISOString() }
              };
              if (dept) aiMatch.departmentName = dept;

              // Aggregate by status server-side
              const aiByStatus = await aiSegDb.collection('backfill_kpi_segments').aggregate([
                { $match: aiMatch },
                { $group: {
                    _id: { slug: '$statusSlug', name: '$statusName' },
                    segments: { $sum: 1 },
                    totalMin: { $sum: '$durationMinutes' },
                    orderUnits: { $sum: 1 },
                    credUnits:  { $sum: { $ifNull: ['$credentialCount', 0] } },
                    rptUnits:   { $sum: { $ifNull: ['$reportItemCount', 0] } },
                }},
                { $sort: { segments: -1 } },
                { $limit: 25 }
              ], { allowDiskUse: true }).toArray();

              // Aggregate by worker server-side
              const aiByWorker = await aiSegDb.collection('backfill_kpi_segments').aggregate([
                { $match: aiMatch },
                { $group: {
                    _id: { email: '$workerEmail', name: '$workerName', dept: '$departmentName' },
                    segments: { $sum: 1 },
                    totalMin: { $sum: '$durationMinutes' },
                    orderUnits: { $sum: 1 },
                    credUnits:  { $sum: { $ifNull: ['$credentialCount', 0] } },
                    rptUnits:   { $sum: { $ifNull: ['$reportItemCount', 0] } },
                }},
                { $sort: { segments: -1 } },
                { $limit: 30 }
              ], { allowDiskUse: true }).toArray();

              // Total count
              const aiTotal = await aiSegDb.collection('backfill_kpi_segments')
                .countDocuments(aiMatch);

              // Resolve unit-aware XpH post-aggregation
              const resolveXph = (r, slug) => {
                const unit = aiXphUnitMap[slug] || 'Orders';
                const unitSum = unit === 'Credentials' ? r.credUnits
                              : unit === 'Reports'     ? r.rptUnits
                              : r.orderUnits;
                return { xph: r.totalMin > 0 ? Math.round(unitSum/(r.totalMin/60)*100)/100 : null, xphUnit: unit };
              };

              result = {
                note: `Complete ${days}-day KPI summary${dept ? ' for ' + dept : ' across all departments'}. ${aiTotal.toLocaleString()} segments analysed. All XpH values are unit-aware.`,
                totalSegments: aiTotal,
                dept: dept || 'All',
                days,
                byStatus: aiByStatus.map(r => {
                  const { xph, xphUnit } = resolveXph(r, r._id.slug);
                  return { status: r._id.name||r._id.slug, xphUnit, segments: r.segments,
                           xph, avgMin: Math.round(r.totalMin/r.segments*10)/10 };
                }),
                topWorkers: aiByWorker.map(r => {
                  // For workers across multiple statuses, use order units as safe default
                  const xph = r.totalMin > 0 ? Math.round(r.orderUnits/(r.totalMin/60)*100)/100 : null;
                  return { name: r._id.name, email: r._id.email, dept: r._id.dept||dept,
                           segments: r.segments, xph,
                           avgMin: Math.round(r.totalMin/r.segments*10)/10 };
                }),
              };
              break;
            }
            case 'fetch_queue_snapshot': {
              result = await internalFetch('/queue-snapshot');
              break;
            }
            case 'fetch_queue_wait_summary': {
              const days = Math.min(toolBlock.input?.days || 60, AI_MAX_DAYS);
              result = await internalFetch(`/queue-wait-summary?days=${days}`);
              break;
            }
            case 'fetch_qc_summary': {
              const days = Math.min(toolBlock.input?.days || 60, AI_MAX_DAYS);
              const deptQc = toolBlock.input?.dept || '';
              const raw = await internalFetch(`/qc-summary?days=${days}`);
              const events = raw; // qc-summary returns aggregated data, not raw events

              // If dept specified, filter all breakdown arrays to that dept
              if (deptQc && raw && !raw.error) {
                const filterByDept = (arr) => (arr || []).filter(r =>
                  (r.name||'').toLowerCase().includes(deptQc.toLowerCase()) ||
                  (r._id||'').toLowerCase().includes(deptQc.toLowerCase())
                );
                // For dept-specific view: use byDepartment to find the dept row,
                // and filter byAssignee/byIssue/byErrorType to workers in that dept
                const deptRow = (raw.byDepartment||[]).find(r =>
                  (r.name||r._id||'').toLowerCase().includes(deptQc.toLowerCase())
                );
                result = {
                  dept: deptQc,
                  days,
                  note: deptRow
                    ? `QC data filtered to ${deptQc}. ${deptRow.count} QC events in this department.`
                    : `No QC events found for department: ${deptQc}. Check department name spelling.`,
                  deptSummary: deptRow || null,
                  byIssue: raw.byIssue || [],
                  byErrorType: raw.byErrorType || [],
                  byAssignee: raw.byAssignee || [],
                  byStatusAtQc: raw.byStatusAtQc || [],
                  totals: raw.totals || {},
                  trendByDay: (raw.trendByDay || []).slice(-14),
                };
              } else {
                result = {
                  days,
                  totals: raw.totals || {},
                  byDepartment: (raw.byDepartment || []).slice(0, 10),
                  byIssue: (raw.byIssue || []).slice(0, 10),
                  byErrorType: (raw.byErrorType || []).slice(0, 10),
                  byAssignee: (raw.byAssignee || []).slice(0, 15),
                  byStatusAtQc: (raw.byStatusAtQc || []).slice(0, 10),
                  trendByDay: (raw.trendByDay || []).slice(-14),
                };
              }
              break;
            }
            case 'fetch_user_list': {
              const userData = await internalFetch('/users');
              result = {
                total: (userData.users || []).length,
                users: (userData.users || []).map(u => ({
                  name: u.fullName, email: u.email, department: u.departmentName
                })).slice(0, 50)
              };
              break;
            }
            case 'fetch_worker_pattern': {
              const workerQuery = toolBlock.input?.worker || '';
              const days = Math.min(toolBlock.input?.days || 14, AI_MAX_DAYS);
              if (!workerQuery) { result = { error: 'worker name or email required' }; break; }

              // Query MongoDB directly — avoids loading all segments into memory
              const wpCutoff = new Date(Date.now() - days * 86400000);
              const wpDb = await getConfigDb();
              const q = workerQuery.toLowerCase();
              const wpMatch = {
                segmentStart: { $gte: wpCutoff.toISOString() },
                $or: [
                  { workerEmail: { $regex: q, $options: 'i' } },
                  { workerName:  { $regex: q, $options: 'i' } }
                ]
              };
              const segments = await wpDb.collection('backfill_kpi_segments')
                .find(wpMatch, { projection:{ workerName:1, workerEmail:1, workerUserId:1,
                  departmentName:1, statusSlug:1, statusName:1, segmentStart:1,
                  durationMinutes:1, isOpen:1, orderSerialNumber:1,
                  credentialCount:1, reportItemCount:1, xphUnit:1 } })
                .sort({ segmentStart: -1 })
                .limit(2000) // cap at 2k segments per worker for AI context safety
                .toArray();

              // Load benchmarks for xphUnit
              const bDb = await getConfigDb();
              const bDocs = await bDb.collection('dashboard_benchmarks').find({}, { projection:{ status:1, xphUnit:1 } }).toArray();
              const xUnitMap = {};
              for (const b of bDocs) if (b.status) xUnitMap[b.status] = b.xphUnit || 'Orders';

              const byDay = {};
              const byStatus = {};
              for (const s of segments) {
                const day = s.segmentStart?.substring(0, 10) || 'unknown';
                if (!byDay[day]) byDay[day] = { date:day, count:0, totalMin:0, unitSum:0, statuses:{}, orders:new Set() };
                byDay[day].count++;
                const xUnit = xUnitMap[s.statusSlug] || 'Orders';
                const uVal = xUnit === 'Credentials' ? (s.credentialCount||0)
                           : xUnit === 'Reports'     ? (s.reportItemCount||0) : 1;
                if (!s.isOpen && s.durationMinutes > 0) {
                  byDay[day].totalMin += s.durationMinutes;
                  byDay[day].unitSum += uVal;
                }
                const st = s.statusName || s.statusSlug;
                byDay[day].statuses[st] = (byDay[day].statuses[st]||0) + 1;
                if (s.orderSerialNumber) byDay[day].orders.add(s.orderSerialNumber);

                if (!byStatus[st]) byStatus[st] = { count:0, totalMin:0, unitSum:0, xphUnit:xUnit };
                byStatus[st].count++;
                if (!s.isOpen && s.durationMinutes > 0) { byStatus[st].totalMin += s.durationMinutes; byStatus[st].unitSum += uVal; }
              }

              const closedSegs = segments.filter(s => !s.isOpen && s.durationMinutes > 0);
              const totalMin = closedSegs.reduce((a,s) => a + s.durationMinutes, 0);
              const totalUnitSum = closedSegs.reduce((a,s) => {
                const u = xUnitMap[s.statusSlug] || 'Orders';
                return a + (u==='Credentials'?(s.credentialCount||0):u==='Reports'?(s.reportItemCount||0):1);
              }, 0);

              result = {
                worker: workerQuery,
                matchedSegments: segments.length,
                workerName: segments[0]?.workerName || workerQuery,
                workerEmail: segments[0]?.workerEmail || '',
                department: segments[0]?.departmentName || 'Unknown',
                days,
                summary: {
                  totalSegments: segments.length,
                  closedSegments: closedSegs.length,
                  totalHours: Math.round(totalMin/60*10)/10,
                  overallXph: totalMin > 0 ? Math.round(totalUnitSum/(totalMin/60)*100)/100 : null,
                  uniqueOrders: new Set(segments.map(s=>s.orderSerialNumber).filter(Boolean)).size,
                  activeDays: Object.keys(byDay).filter(d => byDay[d].count > 0).length,
                  byStatus: Object.entries(byStatus).map(([st, d]) => ({
                    status: st, xphUnit: d.xphUnit, segments: d.count,
                    xph: d.totalMin > 0 ? Math.round(d.unitSum/(d.totalMin/60)*100)/100 : null,
                    avgMin: d.count ? Math.round(d.totalMin/d.count*10)/10 : null,
                  })).sort((a,b) => b.segments-a.segments),
                },
                dailyBreakdown: Object.values(byDay).sort((a,b) => b.date.localeCompare(a.date)).map(d => ({
                  date: d.date, segments: d.count,
                  hours: Math.round(d.totalMin/60*10)/10,
                  xph: d.totalMin > 0 ? Math.round(d.unitSum/(d.totalMin/60)*100)/100 : null,
                  uniqueOrders: d.orders.size,
                  statusBreakdown: d.statuses,
                })),
              };
              break;
            }
            case 'fetch_anomaly_scan': {
              const days = Math.min(toolBlock.input?.days || 7, 30);
              const deptAnomaly = toolBlock.input?.dept || '';
              const deptAnomalyParam = deptAnomaly ? `&dept=${encodeURIComponent(deptAnomaly)}` : '';

              // Query MongoDB directly — avoids loading all segments into memory
              const anCutoff = new Date(Date.now() - days * 86400000);
              const anDb = await getConfigDb();
              const anMatch = {
                segmentStart: { $gte: anCutoff.toISOString() }
              };
              if (deptAnomaly) anMatch.departmentName = deptAnomaly;
              const segments = await anDb.collection('backfill_kpi_segments')
                .find(anMatch, { projection:{ workerName:1, workerEmail:1, departmentName:1,
                  statusSlug:1, statusName:1, durationMinutes:1, isOpen:1,
                  credentialCount:1, reportItemCount:1 } })
                .sort({ segmentStart: -1 })
                .toArray();
              const qc = await internalFetch(`/qc-summary?days=${days}`);

              // Load benchmarks for xphUnit
              const aDb = await getConfigDb();
              const aDocs = await aDb.collection('dashboard_benchmarks').find({}, { projection:{ status:1, xphUnit:1, inRangeMin:1, inRangeMax:1 } }).toArray();
              const aBenchMap = {};
              for (const b of aDocs) if (b.status) aBenchMap[b.status] = b;

              // Per-department worker stats (compare within dept, not cross-dept)
              const byDeptWorker = {};
              for (const s of segments) {
                const dept = s.departmentName || 'Unknown';
                const w = s.workerEmail || 'UNATTRIBUTED';
                const key = `${dept}::${w}`;
                if (!byDeptWorker[key]) byDeptWorker[key] = { name:s.workerName||w, email:w, dept, count:0, totalMin:0, unitSum:0 };
                byDeptWorker[key].count++;
                const b = aBenchMap[s.statusSlug];
                const xUnit = b?.xphUnit || 'Orders';
                const uVal = xUnit==='Credentials'?(s.credentialCount||0):xUnit==='Reports'?(s.reportItemCount||0):1;
                if (!s.isOpen && s.durationMinutes > 0) {
                  byDeptWorker[key].totalMin += s.durationMinutes;
                  byDeptWorker[key].unitSum += uVal;
                }
              }

              // Find outliers WITHIN each department
              const byDept = {};
              for (const [, w] of Object.entries(byDeptWorker)) {
                if (!byDept[w.dept]) byDept[w.dept] = [];
                if (w.email !== 'UNATTRIBUTED') byDept[w.dept].push(w);
              }
              const outlierWorkers = [];
              for (const [dept, workers] of Object.entries(byDept)) {
                if (workers.length < 2) continue;
                const avgSegs = workers.reduce((a,w)=>a+w.count,0) / workers.length;
                const avgXph = workers.reduce((a,w)=>a+(w.totalMin>0?w.unitSum/(w.totalMin/60):0),0) / workers.length;
                for (const w of workers) {
                  const xph = w.totalMin > 0 ? w.unitSum/(w.totalMin/60) : 0;
                  const xphDrop = avgXph > 0 ? (avgXph - xph) / avgXph : 0;
                  if (xphDrop > 0.35) outlierWorkers.push({ ...w, avgXphForDept: Math.round(avgXph*100)/100, workerXph: Math.round(xph*100)/100, dropPct: Math.round(xphDrop*100), flag:'LOW_XPH' });
                  else if (w.count < avgSegs * 0.3 && avgSegs >= 5) outlierWorkers.push({ ...w, avgForDept: Math.round(avgSegs), flag:'LOW_VOLUME' });
                }
              }

              // Data quality anomalies
              const longSegs = segments.filter(s => s.durationMinutes > 480 && !s.isOpen);
              const zeroSegs = segments.filter(s => !s.isOpen && (s.durationMinutes===0||s.durationMinutes==null));
              const unattributed = segments.filter(s => !s.workerEmail);

              result = {
                dept: deptAnomaly || 'All',
                scanPeriod: days + ' days',
                totalSegments: segments.length,
                anomalies: {
                  lowXphWorkers: outlierWorkers.filter(w=>w.flag==='LOW_XPH').slice(0,8),
                  lowVolumeWorkers: outlierWorkers.filter(w=>w.flag==='LOW_VOLUME').slice(0,5),
                  longSegments: { count: longSegs.length, examples: longSegs.slice(0,3).map(s=>({ worker:s.workerName, status:s.statusName, hours:Math.round(s.durationMinutes/60*10)/10 })) },
                  zeroDurationSegments: { count: zeroSegs.length },
                  unattributedSegments: { count: unattributed.length, pct: segments.length ? Math.round(unattributed.length/segments.length*1000)/10 : 0 },
                },
                qcSummary: { totalEvents: qc.totalEvents||0, topDepartments: (qc.byDepartment||[]).slice(0,5) },
              };
              break;
            }
            case 'fetch_order_demand': {
              const deptDemand = toolBlock.input?.dept || '';
              const deptDemandParam = deptDemand ? `?dept=${encodeURIComponent(deptDemand)}` : '';
              const [slaRes, trendRes] = await Promise.all([
                fetch(`http://localhost:${CONFIG.PORT}/data/forecast/sla-analysis${deptDemandParam}`, {
                  headers: { 'Authorization': req.headers['authorization'] || '' }
                }).then(r => r.json()).catch(() => ({})),
                fetch(`http://localhost:${CONFIG.PORT}/data/forecast/arrivals${deptDemandParam}`, {
                  headers: { 'Authorization': req.headers['authorization'] || '' }
                }).then(r => r.json()).catch(() => ({})),
              ]);

              const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
              const fmtH = h => h===0?'12am':h<12?h+'am':h===12?'12pm':(h-12)+'pm';
              const slots = trendRes.slots || [];
              const dataSpanWeeks = trendRes.dataSpanWeeks || 1;

              const totalByDow = [0,1,2,3,4,5,6].map(d =>
                slots.filter(s => s.dow === d).reduce((a,s) => a + s.count, 0)
              );
              const totalByHour = Array(24).fill(0);
              for (const s of slots) totalByHour[s.hour] = (totalByHour[s.hour]||0) + s.count;

              const peakHour = totalByHour.indexOf(Math.max(...totalByHour));
              const peakDow = totalByDow.indexOf(Math.max(...totalByDow));

              result = {
                dept: deptDemand || 'All Departments (system-wide)',
                note: deptDemand ? `Demand data filtered to ${deptDemand}.` : 'System-wide demand. All numbers are org-wide totals.',
                summary: {
                  avgDailyOrders: trendRes.avgPerDay || null,
                  peakHour: fmtH(peakHour) + ' UTC',
                  peakDay: DAYS[peakDow],
                  dataSpanWeeks,
                  avgByDow: totalByDow.map((v,i) => ({
                    day: DAYS[i],
                    avgDailyOrders: Math.round(v / Math.max(dataSpanWeeks, 1) * 10) / 10,
                  })),
                },
                weeklyTrend: (trendRes.weeklyTrend || []).slice(-12),
                slaRecommendations: (slaRes.recommendations || []).slice(0, 5),
                bottlenecks: (slaRes.bottlenecks || []).slice(0, 5),
                topWaitStatuses: (slaRes.byStatus || []).slice(0, 8),
              };
              break;
            }
            case 'fetch_staffing_model': {
              const deptFilter = toolBlock.input?.dept || '';
              const deptParam = deptFilter ? `?dept=${encodeURIComponent(deptFilter)}` : '';
              const staffRes = await fetch(`http://localhost:${CONFIG.PORT}/data/forecast/staffing${deptParam}`, {
                headers: { 'Authorization': req.headers['authorization'] || '' }
              }).then(r => r.json()).catch(e => ({ error: e.message }));
              if (staffRes.error) { result = staffRes; break; }

              const xphList = staffRes.xphByStatus || [];
              const totalSegs = xphList.reduce((a,s) => a+s.segments, 0);
              const weightedXph = totalSegs > 0
                ? xphList.reduce((a,s) => a + s.xph * (s.segments/totalSegs), 0) : 0;
              const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
              const fmtHr = h => h===0?'12am':h<12?h+'am':h===12?'12pm':(h-12)+'pm';

              // Per-hour demand: average arrivals across the data span, not raw totals
              // totalByHour has CUMULATIVE counts across all weeks of data
              const dataSpanWeeks = staffRes.modelMeta?.dataSpanWeeks || 1;
              const staffByHour = (staffRes.totalByHour || []).map((total, h) => {
                const avgArrivalsPerDay = Math.round(total / Math.max(dataSpanWeeks * 7, 1) * 10) / 10;
                return {
                  hour: fmtHr(h),
                  avgArrivalsPerDay: avgArrivalsPerDay,
                  requiredStaff: avgArrivalsPerDay > 0 ? Math.ceil(avgArrivalsPerDay / (weightedXph||1)) : 0,
                };
              });

              // Per-DOW demand — average daily orders by day of week
              const totalByDow = staffRes.totalByDow || [];
              const dowDemand = DAYS.map((day, i) => ({
                day,
                avgDailyOrders: Math.round(totalByDow[i] / Math.max(dataSpanWeeks, 1) * 10) / 10,
              }));

              const peak = staffByHour.reduce((a,b) => a.requiredStaff >= b.requiredStaff ? a : b, staffByHour[0] || {});

              result = {
                dept: deptFilter || 'All Departments',
                note: deptFilter
                  ? `Staffing model filtered to ${deptFilter}. Required staff = ceil(avg daily arrivals ÷ XpH). Add 20–30% for breaks and variance.`
                  : 'WARNING: This is system-wide demand. For department staffing use dept= parameter.',
                dataFoundation: {
                  dataSpanWeeks,
                  xphSampleSegments: totalSegs,
                  avgDailyOrders: staffRes.avgPerDay,
                },
                weightedTeamXph: Math.round(weightedXph * 100) / 100,
                xphByStatus: xphList.map(s => ({
                  status: s.statusName, xphUnit: s.xphUnit,
                  xph: s.xph, segments: s.segments, avgDurMin: s.avgDurMin,
                })).slice(0, 15),
                peakHour: peak,
                staffByHour,
                dowDemand,
              };
              break;
            }
            default:
              result = { error: 'Unknown tool: ' + toolBlock.name };
          }
        } catch (err) {
          result = { error: 'Tool execution failed: ' + err.message };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result)
        });
      }

      // Continue conversation with tool results.
      // CRITICAL: mutate messages in-place so each iteration builds on full history.
      // Every tool_use block must be immediately followed by its tool_result block.
      // Rebuilding from a stale snapshot causes 400 "tool_use without tool_result" errors.
      messages = [
        ...messages,
        { role: 'assistant', content: claudeData.content },
        { role: 'user', content: toolResults }
      ];

      const continueRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CONFIG.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: guardrailConfig.model || 'claude-sonnet-4-5',
          max_tokens: guardrailConfig.maxTokens || 4096,
          system: systemPrompt + contextStr,
          messages,
          tools
        })
      });

      if (!continueRes.ok) {
        const errBody = await continueRes.text();
        console.error(`[AI/chat] continue error ${continueRes.status}:`, await continueRes.text().catch(()=>''));
        break;
      }

      claudeData = await continueRes.json();
      console.log(`[AI/chat] tool iter ${iterations} — stop_reason=${claudeData.stop_reason}`);
    }

    // Extract text response
    const textBlocks = (claudeData.content || []).filter(b => b.type === 'text');
    const response = textBlocks.map(b => b.text).join('\n');

    // Log chat (optional — for analytics)
    try {
      await db.collection('dashboard_chat_history').insertOne({
        user: req.user?.name || 'unknown',
        userEmail: req.user?.email,
        question: messages[messages.length - 1]?.content || '',
        response: response.substring(0, 1000),
        toolsUsed: iterations,
        timestamp: new Date()
      });
    } catch { /* non-critical */ }

    console.log(`[AI/chat] ✓ done — iterations=${iterations} response_len=${response?.length||0}`);
    res.json({
      response,
      content: claudeData.content,
      toolIterations: iterations
    });

  } catch (err) {
    console.error(`[AI/chat] ✗ unhandled error:`, err.message, err.stack?.split('\n')[1]||'');
    res.status(500).json({ error: err.message });
  }
});

// Internal fetch helper — calls own API endpoints without HTTP overhead
async function internalFetch(path) {
  // Parse the path and call the handler directly via a mock req/res
  // For simplicity, just use HTTP to self — this ensures all middleware runs
  const url = `http://localhost:${CONFIG.PORT}${path}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': CONFIG.API_KEY }
  });
  return res.json();
}


// ═══════════════════════════════════════════════════════════
// CONFIG MANAGEMENT — Benchmarks, Production Hours, User Levels
// Added in v4.4 — MongoDB-backed config with audit trail.
// Collections: dashboard_benchmarks, dashboard_production_hours,
//              dashboard_user_levels, dashboard_audit_log
// ═══════════════════════════════════════════════════════════

// CONFIG_DB connection is defined above with the MongoDB connection code

async function auditLog(action, collection, data, changedBy) {
  try {
    const db = await getConfigDb();
    await db.collection('dashboard_audit_log').insertOne({
      action,
      collection,
      data,
      changedBy: changedBy || 'unknown',
      timestamp: new Date()
    });
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

// —— GET /config/benchmarks ————————————————————————————————
// Returns all benchmark configurations
app.get('/config/benchmarks', async (req, res) => {
  try {
    const cached = getCachedConfig('benchmarks');
    if (cached) return res.json(cached);
    const db = await getConfigDb();
    const benchmarks = await db.collection('dashboard_benchmarks')
      .find({}).sort({ team: 1, status: 1 }).toArray();
    const payload = { count: benchmarks.length, benchmarks };
    setCachedConfig('benchmarks', payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /config/benchmarks ————————————————————————————————
// Upsert a benchmark row (by team + status)
app.put('/config/benchmarks', requireRole('admin', 'manager'), async (req, res) => {
  invalidateConfigCache('benchmarks'); invalidateConfigCache('benchmarks_statuses');
  try {
    const { team, status, xphUnit, l0, l1, l2, l3, l4, l5, changedBy } = req.body;
    if (!team || !status) return res.status(400).json({ error: 'team and status required' });

    const db = await getConfigDb();
    const doc = {
      team, status, xphUnit: xphUnit || 'Orders',
      l0: l0 !== null && l0 !== undefined && l0 !== '' ? Number(l0) : null,
      l1: l1 !== null && l1 !== undefined && l1 !== '' ? Number(l1) : null,
      l2: l2 !== null && l2 !== undefined && l2 !== '' ? Number(l2) : null,
      l3: l3 !== null && l3 !== undefined && l3 !== '' ? Number(l3) : null,
      l4: l4 !== null && l4 !== undefined && l4 !== '' ? Number(l4) : null,
      l5: l5 !== null && l5 !== undefined && l5 !== '' ? Number(l5) : null,
      updatedAt: new Date(),
      updatedBy: changedBy || 'unknown'
    };

    await db.collection('dashboard_benchmarks').updateOne(
      { team, status },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    await auditLog('upsert', 'dashboard_benchmarks', doc, changedBy);
    res.json({ success: true, benchmark: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /config/benchmarks/seed ——————————————————————————
// Bulk-seed benchmarks from an array (one-time migration from sheet)
app.post('/config/benchmarks/seed', requireRole('admin'), async (req, res) => {
  try {
    const { benchmarks, changedBy } = req.body;
    if (!Array.isArray(benchmarks)) return res.status(400).json({ error: 'benchmarks array required' });

    const db = await getConfigDb();
    let upserted = 0;
    for (const b of benchmarks) {
      if (!b.team || !b.status) continue;
      await db.collection('dashboard_benchmarks').updateOne(
        { team: b.team, status: b.status },
        { $set: { ...b, updatedAt: new Date(), updatedBy: changedBy || 'seed' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      upserted++;
    }
    await auditLog('seed', 'dashboard_benchmarks', { count: upserted }, changedBy);
    res.json({ success: true, upserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /config/production-hours ——————————————————————————
app.get('/config/production-hours', async (req, res) => {
  try {
    const cached = getCachedConfig('production_hours');
    if (cached) return res.json(cached);
    const db = await getConfigDb();
    const hours = await db.collection('dashboard_production_hours')
      .find({}).sort({ team: 1, status: 1 }).toArray();
    setCachedConfig('production_hours', { count: hours.length, hours });
    res.json({ count: hours.length, hours });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /config/production-hours ——————————————————————————
app.put('/config/production-hours', requireRole('admin', 'manager'), async (req, res) => {
  invalidateConfigCache('production_hours');
  try {
    const { team, status, l0, l1, l2, l3, l4, l5, changedBy } = req.body;
    if (!team || !status) return res.status(400).json({ error: 'team and status required' });

    const db = await getConfigDb();
    const doc = {
      team, status,
      l0: l0 !== null && l0 !== undefined && l0 !== '' ? Number(l0) : null,
      l1: l1 !== null && l1 !== undefined && l1 !== '' ? Number(l1) : null,
      l2: l2 !== null && l2 !== undefined && l2 !== '' ? Number(l2) : null,
      l3: l3 !== null && l3 !== undefined && l3 !== '' ? Number(l3) : null,
      l4: l4 !== null && l4 !== undefined && l4 !== '' ? Number(l4) : null,
      l5: l5 !== null && l5 !== undefined && l5 !== '' ? Number(l5) : null,
      updatedAt: new Date(),
      updatedBy: changedBy || 'unknown'
    };

    await db.collection('dashboard_production_hours').updateOne(
      { team, status },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    await auditLog('upsert', 'dashboard_production_hours', doc, changedBy);
    res.json({ success: true, hours: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /config/production-hours/seed ————————————————————
app.post('/config/production-hours/seed', requireRole('admin'), async (req, res) => {
  try {
    const { hours, changedBy } = req.body;
    if (!Array.isArray(hours)) return res.status(400).json({ error: 'hours array required' });

    const db = await getConfigDb();
    let upserted = 0;
    for (const h of hours) {
      if (!h.team || !h.status) continue;
      await db.collection('dashboard_production_hours').updateOne(
        { team: h.team, status: h.status },
        { $set: { ...h, updatedAt: new Date(), updatedBy: changedBy || 'seed' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      upserted++;
    }
    await auditLog('seed', 'dashboard_production_hours', { count: upserted }, changedBy);
    res.json({ success: true, upserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /config/user-levels ——————————————————————————————
app.get('/config/user-levels', async (req, res) => {
  try {
    const cached = getCachedConfig('user_levels');
    if (cached) return res.json(cached);
    const db = await getConfigDb();
    const levels = await db.collection('dashboard_user_levels')
      .find({}).sort({ name: 1 }).toArray();
    const payload = { count: levels.length, levels };
    setCachedConfig('user_levels', payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /config/user-levels ——————————————————————————————
// Upsert a user level by email
app.put('/config/user-levels', requireRole('admin', 'manager'), async (req, res) => {
  invalidateConfigCache('user_levels');
  try {
    const { email, name, department, level, changedBy } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const db = await getConfigDb();
    const doc = {
      email: email.toLowerCase().trim(),
      name: name || '',
      department: department || '',
      level: level || null,
      updatedAt: new Date(),
      updatedBy: changedBy || 'unknown'
    };

    await db.collection('dashboard_user_levels').updateOne(
      { email: doc.email },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    await auditLog('upsert', 'dashboard_user_levels', doc, changedBy);
    res.json({ success: true, level: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /config/user-levels/seed — Bulk seed user levels ———
// Body: { levels: [{ v1Id, level }, ...], changedBy }
app.post('/config/user-levels/seed', requireRole('admin'), async (req, res) => {
  try {
    const { levels, changedBy } = req.body;
    if (!Array.isArray(levels)) return res.status(400).json({ error: 'levels array required' });

    const db = await getConfigDb();
    let upserted = 0;
    for (const l of levels) {
      if (!l.v1Id || !l.level) continue;
      await db.collection('dashboard_user_levels').updateOne(
        { v1Id: String(l.v1Id) },
        { $set: { v1Id: String(l.v1Id), level: l.level, updatedAt: new Date(), updatedBy: changedBy || 'seed' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      upserted++;
    }
    await auditLog('seed', 'dashboard_user_levels', { count: upserted }, changedBy);
    res.json({ success: true, upserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /config/benchmarks/thresholds/seed — Bulk seed thresholds ——
// Body: { thresholds: [{ status, excludeShortSec, inRangeMinSec, inRangeMaxSec, excludeLongSec }, ...] }
app.post('/config/benchmarks/thresholds/seed', requireRole('admin'), async (req, res) => {
  try {
    const { thresholds, changedBy } = req.body;
    if (!Array.isArray(thresholds)) return res.status(400).json({ error: 'thresholds array required' });

    const db = await getConfigDb();
    let updated = 0;
    for (const t of thresholds) {
      if (!t.status) continue;
      const update = { updatedAt: new Date(), updatedBy: changedBy || 'seed' };
      if (t.excludeShortSec !== undefined) update.excludeShortMin = Number(t.excludeShortSec) / 60;
      if (t.inRangeMinSec !== undefined) update.inRangeMin = Number(t.inRangeMinSec) / 60;
      if (t.inRangeMaxSec !== undefined) update.inRangeMax = Number(t.inRangeMaxSec) / 60;
      if (t.excludeLongSec !== undefined) update.excludeLongMax = Number(t.excludeLongSec) / 60;

      await db.collection('dashboard_benchmarks').updateMany(
        { status: t.status },
        { $set: update }
      );
      updated++;
    }
    await auditLog('seed_thresholds', 'dashboard_benchmarks', { count: updated }, changedBy);
    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /config/audit-log ————————————————————————————————
app.get('/config/audit-log', async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, { min: 1, max: 500 });
    const db = await getConfigDb();
    const logs = await db.collection('dashboard_audit_log')
      .find({}).sort({ timestamp: -1 }).limit(limit).toArray();
    res.json({ count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ═══════════════════════════════════════════════════════════
// GLOSSARY — Admin-editable terminology fed into AI chatbot
// Collection: dashboard_glossary
// ═══════════════════════════════════════════════════════════

// —— GET /glossary ————————————————————————————————————————
app.get('/glossary', async (req, res) => {
  try {
    const db = await getConfigDb();
    const items = await db.collection('dashboard_glossary')
      .find({}).sort({ term: 1 }).toArray();
    res.json({ count: items.length, glossary: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— PUT /glossary ————————————————————————————————————————
app.put('/glossary', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { term, definition, category, examples } = req.body;
    if (!term || !definition) return res.status(400).json({ error: 'term and definition required' });
    const db = await getConfigDb();
    const doc = {
      term: term.trim(),
      definition: definition.trim(),
      category: category || 'General',
      examples: examples || [],
      updatedAt: new Date(),
      updatedBy: req.user?.name || 'unknown'
    };
    await db.collection('dashboard_glossary').updateOne(
      { term: doc.term },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    await auditLog('upsert', 'dashboard_glossary', { term: doc.term }, req.user?.name);
    res.json({ success: true, item: doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— DELETE /glossary/:term ———————————————————————————————
app.delete('/glossary/:term', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const db = await getConfigDb();
    await db.collection('dashboard_glossary').deleteOne({ term: req.params.term });
    await auditLog('delete', 'dashboard_glossary', { term: req.params.term }, req.user?.name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// AI GUARDRAILS — Full admin control over chatbot behavior
// Collection: dashboard_ai_guardrails
// ═══════════════════════════════════════════════════════════

const DEFAULT_GUARDRAILS = {
  maxDays: 90,
  maxPageSize: 2000,
  maxToolIterations: 5,
  maxTokens: 4096,
  model: 'claude-sonnet-4-5',
  allowedTools: ['fetch_kpi_summary', 'fetch_queue_snapshot', 'fetch_queue_wait_summary', 'fetch_qc_summary', 'fetch_user_list', 'fetch_worker_pattern', 'fetch_anomaly_scan'],
  rateLimitPerMinute: 10,
  summaryOnly: true,
  description: 'Default guardrails. Edit to control AI behavior.'
};

// —— GET /ai/guardrails ——————————————————————————————————
app.get('/ai/guardrails', async (req, res) => {
  try {
    const db = await getConfigDb();
    const g = await db.collection('dashboard_ai_guardrails').findOne({ active: true });
    res.json({ guardrails: g || DEFAULT_GUARDRAILS, isDefault: !g });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— PUT /ai/guardrails ——————————————————————————————————
app.put('/ai/guardrails', requireRole('admin'), async (req, res) => {
  try {
    const { maxDays, maxPageSize, maxToolIterations, maxTokens, model, allowedTools, rateLimitPerMinute, summaryOnly } = req.body;
    const db = await getConfigDb();
    await db.collection('dashboard_ai_guardrails').updateMany({ active: true }, { $set: { active: false } });
    const doc = {
      maxDays: Math.min(maxDays || 90, 365),
      maxPageSize: Math.min(maxPageSize || 2000, 5000),
      maxToolIterations: Math.min(maxToolIterations || 5, 10),
      maxTokens: Math.min(maxTokens || 4096, 8192),
      model: model || 'claude-sonnet-4-5',
      allowedTools: allowedTools || DEFAULT_GUARDRAILS.allowedTools,
      rateLimitPerMinute: rateLimitPerMinute || 10,
      summaryOnly: summaryOnly !== false,
      active: true,
      updatedBy: req.user?.name,
      updatedAt: new Date()
    };
    await db.collection('dashboard_ai_guardrails').insertOne(doc);
    await auditLog('update_guardrails', 'dashboard_ai_guardrails', doc, req.user?.name);
    res.json({ success: true, guardrails: doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper: get active guardrails
async function getGuardrails() {
  try {
    const db = await getConfigDb();
    return (await db.collection('dashboard_ai_guardrails').findOne({ active: true })) || DEFAULT_GUARDRAILS;
  } catch { return DEFAULT_GUARDRAILS; }
}

// Helper: get glossary as text for AI prompt
async function getGlossaryText() {
  try {
    const db = await getConfigDb();
    const items = await db.collection('dashboard_glossary').find({}).sort({ term: 1 }).toArray();
    if (!items.length) return '';
    return '\n\nGLOSSARY (use these definitions when answering):\n' +
      items.map(i => `- ${i.term}: ${i.definition}${i.examples?.length ? ' Examples: ' + i.examples.join(', ') : ''}`).join('\n');
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════
// SCHEDULED EMAIL — SendGrid integration for ops reports
// Collection: dashboard_email_schedules
// ═══════════════════════════════════════════════════════════

// —— GET /email/schedules ————————————————————————————————
app.get('/email/schedules', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const db = await getConfigDb();
    const schedules = await db.collection('dashboard_email_schedules')
      .find({}).sort({ createdAt: -1 }).toArray();
    res.json({ count: schedules.length, schedules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— POST /email/schedules ———————————————————————————————
app.post('/email/schedules', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, recipients, frequency, templateId, reportType, enabled } = req.body;
    if (!name || !recipients?.length) return res.status(400).json({ error: 'name and recipients required' });
    const db = await getConfigDb();
    const doc = {
      name, recipients, frequency: frequency || 'daily',
      templateId: templateId || CONFIG.SENDGRID_TEMPLATE_ID,
      reportType: reportType || 'daily_ops_summary',
      enabled: enabled !== false,
      createdBy: req.user?.name,
      createdAt: new Date(), updatedAt: new Date(),
      lastSentAt: null
    };
    const result = await db.collection('dashboard_email_schedules').insertOne(doc);
    await auditLog('create_schedule', 'dashboard_email_schedules', { name }, req.user?.name);
    res.json({ success: true, id: result.insertedId, schedule: doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— PUT /email/schedules/:id ————————————————————————————
app.put('/email/schedules/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, recipients, frequency, templateId, reportType, enabled } = req.body;
    const db = await getConfigDb();
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (recipients !== undefined) update.recipients = recipients;
    if (frequency !== undefined) update.frequency = frequency;
    if (templateId !== undefined) update.templateId = templateId;
    if (reportType !== undefined) update.reportType = reportType;
    if (enabled !== undefined) update.enabled = enabled;
    await db.collection('dashboard_email_schedules').updateOne(
      { _id: new ObjectId(req.params.id) }, { $set: update }
    );
    await auditLog('update_schedule', 'dashboard_email_schedules', { id: req.params.id }, req.user?.name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— DELETE /email/schedules/:id —————————————————————————
app.delete('/email/schedules/:id', requireRole('admin'), async (req, res) => {
  try {
    const db = await getConfigDb();
    await db.collection('dashboard_email_schedules').deleteOne({ _id: new ObjectId(req.params.id) });
    await auditLog('delete_schedule', 'dashboard_email_schedules', { id: req.params.id }, req.user?.name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— POST /email/send-now ————————————————————————————————
// Manual trigger for a scheduled email report
app.post('/email/send-now', requireRole('admin', 'manager'), async (req, res) => {
  try {
    if (!CONFIG.SENDGRID_API_KEY) return res.status(500).json({ error: 'SendGrid not configured' });
    const { scheduleId, recipients, templateId } = req.body;

    // Build report data from live endpoints
    const [queueData, qcData, kpiData] = await Promise.all([
      internalFetch('/queue-snapshot'),
      internalFetch('/qc-summary?days=1'),
      internalFetch('/kpi-segments?days=1&page=1&pageSize=2000')
    ]);

    const snapshot = queueData.snapshot || [];
    const waitingOrders = snapshot.filter(s => s.isWaitingStatus).reduce((a, s) => a + s.orderCount, 0);
    const over24h = snapshot.filter(s => s.isWaitingStatus).reduce((a, s) => a + (s.over24h || 0), 0);
    const over72h = snapshot.filter(s => s.isWaitingStatus).reduce((a, s) => a + (s.over72h || 0), 0);

    const templateData = {
      report_date: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      total_active_orders: queueData.totalActiveOrders || 0,
      waiting_orders: waitingOrders,
      orders_over_24h: over24h,
      orders_over_72h: over72h,
      top_queues: snapshot.filter(s => s.isWaitingStatus).sort((a, b) => b.orderCount - a.orderCount).slice(0, 5).map(s => ({ status: s.statusName, count: s.orderCount, median_hrs: s.medianWaitHours?.toFixed(1) || '0' })),
      qc_events_today: qcData.totalEvents || 0,
      qc_fixed: (qcData.byErrorType || []).find(e => e.errorType === 'i_fixed_it')?.count || 0,
      qc_kickback: (qcData.byErrorType || []).find(e => e.errorType === 'kick_it_back')?.count || 0,
      kpi_segments_today: kpiData.totalCount || 0,
      dashboard_url: 'https://' + (req.headers.host || 'dashboard.myiee.org')
    };

    // Send via SendGrid
    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CONFIG.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: (recipients || ['ops@myiee.org']).map(e => ({ email: e })), dynamic_template_data: templateData }],
        from: { email: CONFIG.SENDGRID_FROM_EMAIL, name: 'IEE Ops Dashboard' },
        template_id: templateId || CONFIG.SENDGRID_TEMPLATE_ID
      })
    });

    if (!sgRes.ok) {
      const errBody = await sgRes.text();
      console.error('SendGrid error:', sgRes.status, errBody);
      return res.status(500).json({ error: 'SendGrid error: ' + sgRes.status });
    }

    // Update last sent
    if (scheduleId) {
      const db = await getConfigDb();
      await db.collection('dashboard_email_schedules').updateOne(
        { _id: new ObjectId(scheduleId) }, { $set: { lastSentAt: new Date() } }
      );
    }

    await auditLog('send_email', 'dashboard_email_schedules', { recipients, templateData: { report_date: templateData.report_date } }, req.user?.name);
    res.json({ success: true, templateData });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ═══════════════════════════════════════════════════════════
// DATA BACKFILL SYSTEM
// ═══════════════════════════════════════════════════════════
// Copies KPI segments, QC events, queue snapshots, and users
// from production MongoDB into iee_dashboard for fast local reads.
// Admin-triggered or auto-scheduled.
// ═══════════════════════════════════════════════════════════

let backfillRunning = false;
let backfillLastRunEnd = 0;
let backfillStartedAt  = 0; // timestamp when current run started — for watchdog

// Watchdog: if a backfill run has been active for more than 10 minutes, it's
// stuck (likely a hung MongoDB cursor on production). Reset the flag so the
// next cron cycle can start a fresh incremental run.
setInterval(() => {
  if (!backfillRunning || !backfillStartedAt) return;
  const elapsedMin = (Date.now() - backfillStartedAt) / 60000;
  if (elapsedMin > 10) {
    console.error(`[WATCHDOG] Backfill stuck for ${Math.round(elapsedMin)}min — forcing reset`);
    backfillRunning  = false;
    backfillStartedAt = 0;
    // Don't update lastRunEnd so the scheduler fires again promptly
  }
}, 30000); // check every 30s // epoch ms — anchors next-run calculation to run completion, not wall clock

// ── User sync state — decoupled from main backfill cycle ──
// Users change infrequently (HR ops, not order ops). Syncing 150k docs every
// 2 minutes costs ~35s and 200MB RSS for zero benefit. Run independently.
let userSyncRunning = false;
let userSyncLastRunAt = 0; // epoch ms
const USER_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes default

async function runUserSync(configDb, push) {
  if (userSyncRunning) {
    push('User sync: skipped (already running)');
    return { count: null, skipped: true };
  }

  const now = Date.now();
  const timeSinceSync = now - userSyncLastRunAt;

  // Skip if synced recently and this is an incremental run (not forced)
  if (timeSinceSync < USER_SYNC_INTERVAL_MS && !push._forceUserSync) {
    const minsAgo = Math.round(timeSinceSync / 60000);
    push(`User sync: skipped (last synced ${minsAgo}m ago — next sync in ${Math.round((USER_SYNC_INTERVAL_MS - timeSinceSync) / 60000)}m)`);
    return { count: null, skipped: true };
  }

  userSyncRunning = true;
  try {
    push('User sync: fetching from production...');
    const userDb = await getDb('user');
    // Filter to staff only: must have a department assigned.
    // Without this filter the query returns ~150k records (all users ever created
    // including customers, partners, etc.). Staff have department populated;
    // non-staff do not. This reduces the sync set to ~500-2000 rows.
    const users = await userDb.collection('user').find(
      {
        deletedAt: null,
        'department': { $exists: true, $ne: null },
        'department.name': { $exists: true, $ne: '' }
      },
      { projection: { firstName: 1, middleName: 1, lastName: 1, email: 1, type: 1, active: 1, department: 1, v1Id: 1, legacyId: 1, foreignKeyId: 1 } }
    ).toArray();

    const userDocs = users.map(u => ({
      v2Id: String(u._id),
      v1Id: u.v1Id || u.legacyId || u.foreignKeyId || null,
      fullName: [u.firstName, u.middleName, u.lastName].filter(Boolean).join(' ').trim(),
      email: u.email, type: u.type, isActive: u.active !== false,
      departmentName: u.department?.name || null,
      departmentId: u.department?.legacyId || u.department?.foreignKeyId || null,
      _backfilledAt: new Date()
    }));

    // Guard: if production returns 0 staff, something is wrong with the query or connection.
    // Don't wipe the collection. Also guard against suspiciously low counts.
    if (userDocs.length < 5) {
      push(`User sync: WARNING — only ${userDocs.length} users returned (expected hundreds), skipping write to avoid data loss`);
      userSyncRunning = false;
      return { count: 0, skipped: true };
    }

    // ── Staging swap: write to temp collection, then rename atomically ──
    // This eliminates the read gap from deleteMany → insertMany.
    // backfill_users is never empty during the swap.
    const stagingName = 'backfill_users_staging';
    const stagingCol = configDb.collection(stagingName);

    // Drop staging if leftover from a previous failed run
    await stagingCol.drop().catch(() => {}); // ignore if not exists

    // Write all docs to staging
    await stagingCol.insertMany(userDocs, { ordered: false });

    // Build indexes on staging before swap (cheaper than post-swap rebuild)
    // Indexes will be applied by ensureIndexes() after the rename

    // Atomic rename: staging → backfill_users
    // dropTarget: true drops the existing backfill_users as part of the rename (single op)
    await configDb.renameCollection(stagingName, 'backfill_users', { dropTarget: true });

    userSyncLastRunAt = Date.now();
    userSyncRunning = false;
    push(`User sync: ${userDocs.length} users written via staging swap`);
    return { count: userDocs.length, skipped: false };

  } catch (err) {
    userSyncRunning = false;
    push(`User sync: ERROR — ${err.message}`);
    // Drop staging on error to avoid stale data next run
    await configDb.collection('backfill_users_staging').drop().catch(() => {});
    return { count: null, skipped: true, error: err.message };
  }
}

// ── Order Arrival & Turnaround Backfill ─────────────────────────────────────
async function runOrderArrivalBackfill(prodDb, configDb, push, opts = {}) {
  try {
    push('Backfilling order arrivals + turnaround...');
    const ordersCol = prodDb.collection('orders');
    const arrCol    = configDb.collection('backfill_order_arrivals');
    const turnCol   = configDb.collection('backfill_order_turnaround');

    // Data floor: 2025-01-01 — oldest data we trust for demand/staffing analysis.
    // Pre-2025 data exists but is fragile (low volume, system changes, inconsistent fields).
    // Separate from the migration spike: 2026-02-06 had 123,490 bulk-imported V1 historical
    // orders all stamped that single day — those are excluded by the $ne filter below,
    // not by this floor date.
    const DATA_FLOOR = new Date('2025-01-01T00:00:00.000Z');
    // Feb 6 2026 migration spike bounds — exclude this specific day regardless of cutoff
    const MIGRATION_DAY_START = new Date('2026-02-06T00:00:00.000Z');
    const MIGRATION_DAY_END   = new Date('2026-02-07T00:00:00.000Z');

    // On a full refresh: always seed from DATA_FLOOR regardless of what's in the collection.
    // Without this, a stale single record left from a previous partial run causes
    // latest?.createdAt to resolve to today → cutoff = today → only today's orders fetched.
    let cutoff;
    if (opts.forceFullSeed) {
      cutoff = DATA_FLOOR;
      push(`  Arrivals: full seed mode — fetching all orders since ${DATA_FLOOR.toISOString().slice(0,10)}`);
    } else {
      const latest   = await turnCol.findOne({}, { sort:{ createdAt:-1 }, projection:{ createdAt:1 } });
      const bufferMs = 30 * 60 * 1000;
      const rawCutoff = latest?.createdAt
        ? new Date(new Date(latest.createdAt).getTime() - bufferMs)
        : new Date(Date.now() - 500 * 24 * 60 * 60 * 1000);
      // Enforce data floor — never pull pre-2025 fragile data
      cutoff = rawCutoff < DATA_FLOOR ? DATA_FLOOR : rawCutoff;
    }

    // One-time cleanup: remove any records that were inserted before the isImport filter
    // was added. These are V1 bulk-import orders that artificially spike the heatmap.
    // Safe to run every time — it only deletes records that match isImport:true in prod.
    // We identify them by cross-referencing with production: easier to just purge and
    // rebuild by resetting the cutoff when we detect the collection has suspect data.
    const totalExisting = await turnCol.countDocuments();
    // Purge stale data: wipe and reseed if collection contains pre-floor OR migration-day records.
    const hasPreFloorData = totalExisting > 0 &&
      await turnCol.countDocuments({
        $or: [
          { createdAt: { $lt: DATA_FLOOR } },
          { createdAt: { $gte: MIGRATION_DAY_START, $lt: MIGRATION_DAY_END } }
        ]
      }) > 0;

    if (hasPreFloorData) {
      const preCount = await turnCol.countDocuments({ createdAt: { $lt: DATA_FLOOR } });
      push(`  Found ${preCount} pre-floor records (before 2025-01-01) — purging and re-seeding`);
      await turnCol.deleteMany({});
      await arrCol.deleteMany({});
      cutoff = DATA_FLOOR;
    }

    push(`  Arrivals: fetching since ${cutoff.toISOString().slice(0,10)}`);

    const cursor = ordersCol.find(
      { paymentStatus:'paid', orderType:{ $in:['evaluation','translation'] }, deletedAt:null,
        // Exclude Feb 6 2026 migration day (123,490 bulk-imported V1 orders stamped that day).
        // $not with range operators is invalid in MongoDB — must use $nor instead.
        // $gte DATA_FLOOR ensures we never pull pre-2025 data.
        // $nor excludes the exact migration day window.
        createdAt: { $gte: DATA_FLOOR },
        $nor: [{ createdAt: { $gte: MIGRATION_DAY_START, $lt: MIGRATION_DAY_END } }],
        $or:[{ createdAt:{ $gte:cutoff } },{ orderPlaced:{ $gte:cutoff } }] },
      { projection:{ orderSerialNumber:1, orderType:1, createdAt:1, orderPlaced:1, paidAt:1,
          orderCompletedAt:1, orderDueDate:1, isUrgent:1, processTime:1,
          orderStatus:1, institution:1, orderStatusHistory:1, reportItems:1 },
        maxTimeMS: 120000 }
    ).batchSize(500);

    // Process in streaming batches to keep memory bounded
    let totalProcessed = 0;
    let turnaroundCount = 0;
    let batch = [];

    const processBatch = async (ops) => {
      if (!ops.length) return;
      for (let i = 0; i < ops.length; i += 2000) {
        const r = await turnCol.bulkWrite(ops.slice(i, i+2000), { ordered:false });
        turnaroundCount += (r.upsertedCount||0) + (r.modifiedCount||0);
      }
    };

    const turnaroundOps = []; // kept for compatibility — flushed per batch below
    for await (const order of cursor) {
      totalProcessed++;
      const arrivedAt = toDate(order.createdAt || order.orderPlaced || order.paidAt);
      if (!arrivedAt) continue;
      const serial      = order.orderSerialNumber;
      const oType       = order.orderType;
      const processSlug = order.processTime?.slug || 'standard';
      const isUrgent    = !!order.isUrgent;
      const reportItemName = Array.isArray(order.reportItems) && order.reportItems.length
        ? (order.reportItems[0]?.name || null) : null;
      const completedAt = toDate(order.orderCompletedAt);
      const dueAt       = toDate(order.orderDueDate);
      const turnaroundHrs = completedAt ? Math.round((completedAt - arrivedAt) / 360000) / 10 : null;
      const isLate        = completedAt && dueAt ? completedAt > dueAt : null;
      const daysLate      = (isLate && completedAt && dueAt) ? Math.round((completedAt - dueAt) / 86400000 * 10) / 10 : null;

      // Walk history for Waiting-status wait times
      const history    = Array.isArray(order.orderStatusHistory) ? order.orderStatusHistory : [];
      const statusWaits = {};
      for (let i = 0; i < history.length; i++) {
        const entry = history[i]; const next = history[i+1];
        const entryAt = toDate(entry?.createdAt); const nextAt = next ? toDate(next?.createdAt) : null;
        const sType = entry?.updatedStatus?.statusType; const slug = entry?.updatedStatus?.slug;
        if (!entryAt || !slug || sType !== 'Waiting' || !nextAt || nextAt <= entryAt) continue;
        const waitMin = Math.round((nextAt - entryAt) / 60000 * 10) / 10;
        statusWaits[slug] = (statusWaits[slug] || 0) + waitMin;
      }

      turnaroundOps.push({ updateOne: { filter:{ orderSerialNumber:serial }, update:{ $set:{
        orderSerialNumber:serial, orderType:oType, processTimeSlug:processSlug,
        isUrgent, institutionName:order.institution?.name||null,
        reportItemName,
        createdAt:arrivedAt, completedAt:completedAt||null, dueAt:dueAt||null,
        turnaroundHrs, isLate, daysLate, isCompleted:!!completedAt,
        currentStatusType:order.orderStatus?.statusType||null, statusWaits,
        _backfilledAt:new Date()
      }}, upsert:true }});

      // Flush every 1000 orders to keep memory bounded
      if (turnaroundOps.length >= 1000) {
        await processBatch(turnaroundOps.splice(0));
        if (totalProcessed % 5000 === 0) push(`  Arrivals: ${totalProcessed} processed...`);
      }
    }
    // Flush remainder
    await processBatch(turnaroundOps.splice(0));
    push(`  Processed ${totalProcessed} orders`);

    // Enrich turnaround records with departmentName via backfill_users.
    // Orders don't have a department field — we derive it by:
    //   1. Building a Map of v2Id → departmentName from backfill_users
    //   2. Finding the dominant workerUserId per order from backfill_kpi_segments
    //   3. Looking up that workerUserId (which IS a v2Id) in the Map
    // NOTE: workerUserId in segments is populated from assignedTo.foreignKeyId || assignedTo.v2Id
    // which produces v2-format ObjectId strings (e.g. "687a5894ef7495fca0666516").
    // backfill_users.v1Id is an integer (e.g. 311571) — these NEVER match.
    // Must key the Map on v2Id, not v1Id.
    push('  Enriching turnaround with department names...');
    try {
      // Load backfill_users into memory as a Map: String(v2Id) → departmentName
      const userDeptDocs = await configDb.collection('backfill_users')
        .find({ v2Id: { $exists: true, $ne: null }, departmentName: { $exists: true, $ne: null } },
              { projection: { v2Id: 1, departmentName: 1 } }).toArray();
      const deptByV2Id = new Map();
      for (const u of userDeptDocs) {
        if (u.v2Id && u.departmentName) deptByV2Id.set(String(u.v2Id), u.departmentName);
      }
      push(`    Loaded ${deptByV2Id.size} users with v2Id → dept mapping`);

      if (deptByV2Id.size === 0) {
        push('  Dept enrichment: 0 users with v2Id found — run user sync first');
      } else {
        // Find the dominant workerUserId per orderSerialNumber from segments.
        // workerUserId is a v2Id string — matches directly against deptByV2Id keys.
        const workerByOrder = await configDb.collection('backfill_kpi_segments').aggregate([
          { $match: { orderSerialNumber: { $exists:true, $ne:null }, workerUserId: { $exists:true, $ne:null } } },
          { $group: { _id: { order:'$orderSerialNumber', uid:'$workerUserId' }, count:{ $sum:1 } } },
          { $sort: { count:-1 } },
          { $group: { _id:'$_id.order', workerUserId:{ $first:'$_id.uid' } } }
        ], { allowDiskUse: true }).toArray();
        push(`    Found ${workerByOrder.length} orders with worker assignments`);

        // Join in JS using the in-memory Map
        const deptOps = [];
        let matched = 0, unmatched = 0;
        for (const r of workerByOrder) {
          const dept = deptByV2Id.get(String(r.workerUserId));
          if (dept) {
            deptOps.push({ updateOne: {
              filter: { orderSerialNumber: r._id },
              update: { $set: { departmentName: dept } }
            }});
            matched++;
          } else {
            unmatched++;
          }
        }
        push(`    Matched: ${matched} orders | Unmatched workerUserId: ${unmatched}`);

        if (deptOps.length > 0) {
          for (let i = 0; i < deptOps.length; i += 2000) {
            await turnCol.bulkWrite(deptOps.slice(i, i + 2000), { ordered: false });
          }
          push(`  ✓ Enriched ${deptOps.length} turnaround records with departmentName`);
          await turnCol.createIndex({ departmentName:1 }, { background:true }).catch(()=>{});
          await turnCol.createIndex({ departmentName:1, createdAt:-1 }, { background:true }).catch(()=>{});
        } else {
          push('  Dept enrichment: 0 ops generated — no v2Id overlap between segments workerUserId and users');
        }
      }
    } catch (dErr) {
      push(`  Dept enrichment: FAILED — ${dErr.message}`);
    }

    // Rebuild arrival heatmap from turnaround collection
    // Build heatmap: include departmentName in grouping so front-end can filter
    const aggResult = await turnCol.aggregate([
      { $match:{ createdAt:{ $exists:true } } },
      { $group:{ _id:{
            dow:{ $subtract:[{ $dayOfWeek:'$createdAt' },1] },
            hour:{ $hour:'$createdAt' },
            dept:{ $ifNull:['$departmentName',''] }
          },
          count:{ $sum:1 }, evaluation:{ $sum:{ $cond:[{ $eq:['$orderType','evaluation'] },1,0] } },
          translation:{ $sum:{ $cond:[{ $eq:['$orderType','translation'] },1,0] } },
          urgent:{ $sum:{ $cond:['$isUrgent',1,0] } },
          completed:{ $sum:{ $cond:['$isCompleted',1,0] } },
          avgTurnaroundHrs:{ $avg:{ $cond:['$isCompleted','$turnaroundHrs',null] } },
          latePct:{ $avg:{ $cond:['$isCompleted',{ $cond:['$isLate',1,0] },null] } }
      }},
      { $project:{ _id:0, dow:'$_id.dow', hour:'$_id.hour', dept:'$_id.dept', count:1,
          evaluation:1, translation:1, urgent:1, completed:1,
          avgTurnaroundHrs:{ $round:['$avgTurnaroundHrs',1] },
          latePct:{ $round:[{ $multiply:['$latePct',100] },1] } }}
    ]).toArray();

    // Key: dow-hour-dept (safe chars only — replace spaces with _)
    const arrOps = aggResult.map(r => {
      const deptKey = (r.dept||'').replace(/[^a-zA-Z0-9]/g,'_').substring(0,30);
      const id = `${r.dow}-${String(r.hour).padStart(2,'0')}-${deptKey}`;
      return { updateOne:{
        filter:{ _id: id },
        update:{ $set:{ ...r, _id: id, _backfilledAt:new Date() } },
        upsert:true
      }};
    });
    if (arrOps.length) await arrCol.bulkWrite(arrOps, { ordered:false });

    await Promise.all([
      turnCol.createIndex({ createdAt:-1 }, { background:true }).catch(()=>{}),
      turnCol.createIndex({ orderSerialNumber:1 }, { unique:true, background:true }).catch(()=>{}),
      turnCol.createIndex({ orderType:1, createdAt:-1 }, { background:true }).catch(()=>{}),
      turnCol.createIndex({ reportItemName:1, createdAt:-1 }, { background:true }).catch(()=>{}),
      turnCol.createIndex({ isCompleted:1, turnaroundHrs:1 }, { background:true }).catch(()=>{}),
      turnCol.createIndex({ processTimeSlug:1 }, { background:true }).catch(()=>{}),
      arrCol.createIndex({ dow:1, hour:1 }, { background:true }).catch(()=>{}),
      // TTL: automatically expire turnaround records older than 365 days
      // This prevents unbounded growth — at ~200 orders/day the collection
      // would otherwise reach ~73k docs/year and slow aggregations significantly.
      turnCol.createIndex({ createdAt:1 }, { expireAfterSeconds: 365*24*3600, background:true }).catch(()=>{}),
    ]);

    push(`  Arrivals done: ${turnaroundCount} turnaround records, ${aggResult.length} heatmap slots`);
    return { arrivalCount:aggResult.length, turnaroundCount };
  } catch (err) {
    push(`  Arrivals: SKIPPED (${err.message})`);
    return { error:err.message };
  }
}

async function runBackfill(options = {}) {
  if (backfillRunning) return { error: 'Backfill already in progress' };
  backfillRunning  = true;
  backfillStartedAt = Date.now();
  const startTime = Date.now();
  const log = [];
  const push = (msg) => { log.push(`[${((Date.now()-startTime)/1000).toFixed(1)}s] ${msg}`); console.log(`[BACKFILL] ${msg}`); };

  try {
    const configDb = await getConfigDb();
    const isFullRefresh = !!options.full;
    const hasDateRange = !!(options.dateFrom || options.dateTo);

    push(`Starting ${isFullRefresh ? 'FULL' : hasDateRange ? 'DATE RANGE' : 'INCREMENTAL'} backfill`);

    await configDb.collection('backfill_metadata').updateOne(
      { _id: 'status' },
      { $set: { running: true, startedAt: new Date(), triggeredBy: options.triggeredBy || 'system', mode: isFullRefresh ? 'full' : hasDateRange ? 'range' : 'incremental' } },
      { upsert: true }
    );

    const segCol = configDb.collection('backfill_kpi_segments');
    const qcCol = configDb.collection('backfill_qc_events');
    const usrCol = configDb.collection('backfill_users');
    const prodDb = await getDb('orders');
    let fullBatchResults = null; // set if full refresh runs batched

    // ── Determine what to fetch ─────────────────────────────
    let segmentCutoff;
    let qcCutoff;
    let upperBound = null; // null = no upper limit (fetch to now)

    if (hasDateRange) {
      // Explicit date range — backfill only this window
      segmentCutoff = options.dateFrom ? new Date(options.dateFrom) : getCutoff(options.days || 90);
      qcCutoff = options.dateFrom ? new Date(options.dateFrom) : getCutoff(options.days || 90);
      upperBound = options.dateTo ? new Date(options.dateTo + 'T23:59:59.999Z') : null;
      push(`Date range: ${segmentCutoff.toISOString()} → ${upperBound ? upperBound.toISOString() : 'now'}`);
    } else if (isFullRefresh) {
      // Full refresh runs in monthly batches to avoid timeout
      const days = options.days || 90;
      await segCol.deleteMany({});
      await qcCol.deleteMany({});
      push(`Full refresh: cleared all, will batch ${days} days in monthly chunks`);

      // Build month boundaries from oldest to newest
      const startDate = getCutoff(days);
      const endDate = new Date();
      const monthBounds = [];
      let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      while (cursor < endDate) {
        const monthStart = new Date(Math.max(cursor.getTime(), startDate.getTime()));
        const nextMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
        const monthEnd = new Date(Math.min(nextMonth.getTime(), endDate.getTime()));
        monthBounds.push({ from: monthStart, to: monthEnd });
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }

      push(`Batching into ${monthBounds.length} monthly chunks`);

      let totalOrders = 0, totalSegOps = 0, totalUpsertedSegs = 0, totalQcRaw = 0, totalUpsertedQc = 0;

      for (let bi = 0; bi < monthBounds.length; bi++) {
        const batch = monthBounds[bi];
        const batchLabel = `${batch.from.toISOString().slice(0,7)}`;
        push(`Batch ${bi+1}/${monthBounds.length}: ${batchLabel} (${batch.from.toISOString().slice(0,10)} → ${batch.to.toISOString().slice(0,10)})`);

        // Segments for this month
        const batchOrders = await prodDb.collection('orders').aggregate([
          {
            $match: {
              paymentStatus: 'paid',
              orderType: { $in: ['evaluation', 'translation'] },
              deletedAt: null,
              orderStatusHistory: { $exists: true, $not: { $size: 0 } },
              'orderStatusHistory.createdAt': { $gte: batch.from, $lte: batch.to }
            }
          },
          {
            $project: {
              orderSerialNumber: 1, orderType: 1, parentOrderId: 1,
              reportItems: 1, orderStatusHistory: 1,
              lastAssignedAt: 1, orderVersion: 1, orderSource: 1
            }
          }
        ], { allowDiskUse: true }).toArray();

        totalOrders += batchOrders.length;

        // Pre-fetch credential counts for this batch of orders
        let credCountMap = {};
        try {
          const batchOrderIds = batchOrders.map(o => o._id);
          const batchCreds = await prodDb.collection('order-credentials').aggregate([
            { $match: {
                order: { $in: batchOrderIds },
                active: true,
                $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
            }},
            { $group: { _id: { $toString: '$order' }, credentialCount: { $sum: 1 } } },
            { $project: { _id: 0, orderId: '$_id', credentialCount: 1 } }
          ], { allowDiskUse: true }).toArray();
          for (const r of batchCreds) credCountMap[r.orderId] = r.credentialCount;
        } catch (cErr) {
          // Non-fatal — credentialCount will default to 0
        }

        // Build segment ops for this batch
        const batchSegOps = [];
        for (const order of batchOrders) {
          const history = Array.isArray(order.orderStatusHistory) ? order.orderStatusHistory : [];
          const reportCount = Array.isArray(order.reportItems) ? order.reportItems.length : 0;
          const reportName = Array.isArray(order.reportItems) ? (order.reportItems[0]?.name || null) : null;

          for (let i = 0; i < history.length; i++) {
            const entry = history[i];
            if (entry?.updatedStatus?.statusType !== 'Processing') continue;
            const entryDate = toDate(entry?.createdAt);
            if (!entryDate || entryDate < batch.from || entryDate > batch.to) continue;
            const nextEntry = i + 1 < history.length ? history[i + 1] : null;
            const segEnd = toDate(nextEntry?.createdAt);
            const durSec = segEnd ? (segEnd.getTime() - entryDate.getTime()) / 1000 : null;
            if (durSec !== null && durSec <= 0) continue;
            const durMin = durSec !== null ? Math.round((durSec / 60) * 10) / 10 : null;
            const assigned = entry?.assignedTo || {};
            const user = entry?.user || {};
            const preciseEnd = entry?.anotherStatusUpdatedAt ? toDate(entry.anotherStatusUpdatedAt) : null;
            const effectiveEnd = preciseEnd || segEnd;
            const eDurSec = effectiveEnd ? (effectiveEnd.getTime() - entryDate.getTime()) / 1000 : durSec;
            const eDurMin = eDurSec !== null ? Math.round((eDurSec / 60) * 10) / 10 : durMin;
            const compositeKey = `${String(order._id)}_${entry?.updatedStatus?.slug || ''}_${entryDate.toISOString()}`;

            batchSegOps.push({
              updateOne: {
                filter: { _compositeKey: compositeKey },
                update: { $set: {
                  _compositeKey: compositeKey,
                  orderSerialNumber: order.orderSerialNumber,
                  orderId: String(order._id), orderType: order.orderType,
                  parentOrderId: order.parentOrderId || null,
                  reportItemCount: reportCount, reportItemName: reportName,
                  credentialCount: credCountMap[String(order._id)] ?? 0,
                  statusSlug: entry?.updatedStatus?.slug || '',
                  statusName: entry?.updatedStatus?.name || '',
                  workerUserId: assigned.foreignKeyId || assigned.v2Id || null,
                  workerName: buildFullName(assigned),
                  workerEmail: assigned.email ? assigned.email.toLowerCase().trim() : null,
                  changedByName: buildFullName(user),
                  segmentStart: toIso(entryDate),
                  segmentEnd: toIso(effectiveEnd || segEnd),
                  durationSeconds: eDurSec ?? durSec,
                  durationMinutes: eDurMin ?? durMin,
                  isOpen: (effectiveEnd || segEnd) === null,
                  isErrorReporting: !!entry?.isErrorReporting,
                  lastAssignedAt: order.lastAssignedAt ? toIso(toDate(order.lastAssignedAt)) : null,
                  orderVersion: order.orderVersion || null,
                  orderSource: order.orderSource || null,
                  _backfilledAt: new Date()
                }},
                upsert: true
              }
            });
          }
        }

        totalSegOps += batchSegOps.length;
        if (batchSegOps.length > 0) {
          for (let i = 0; i < batchSegOps.length; i += 2000) {
            const result = await segCol.bulkWrite(batchSegOps.slice(i, i + 2000), { ordered: false });
            totalUpsertedSegs += result.upsertedCount || 0;
          }
        }

        // QC events for this month
        const batchQc = await prodDb.collection('order-discussion').find({
          type: 'system_logs', 'category.slug': 'quality_control',
          createdAt: { $gte: batch.from, $lte: batch.to }, deletedAt: null
        }, {
          projection: { order: 1, user: 1, category: 1, department: 1, issue: 1, errorType: 1, errorAssignedTo: 1, text: 1, createdAt: 1 }
        }).toArray();

        totalQcRaw += batchQc.length;
        // Build order lookup for serial numbers and order types
        const qcOrderIds = [...new Set(batchQc.map(d => d.order).filter(Boolean))];
        const qcOrderMap = {};
        if (qcOrderIds.length > 0) {
          const qcOrders = await prodDb.collection('orders').find(
            { _id: { $in: qcOrderIds.map(id => typeof id === 'string' ? new ObjectId(id) : id) } },
            { projection: { orderSerialNumber: 1, orderType: 1 } }
          ).toArray();
          for (const o of qcOrders) qcOrderMap[String(o._id)] = o;
        }

        const batchQcOps = batchQc.map(doc => {
          const oid = doc.order ? String(doc.order) : null;
          const ord = oid ? qcOrderMap[oid] : null;
          return {
            updateOne: {
              filter: { _qcKey: String(doc._id) },
              update: { $set: {
                _qcKey: String(doc._id),
                orderId: oid,
                orderSerialNumber: ord?.orderSerialNumber || null,
                orderType: ord?.orderType || null,
                reporterName: doc.user ? [doc.user.firstName, doc.user.lastName].filter(Boolean).join(' ') : null,
                reporterEmail: doc.user?.email || null,
                departmentName: doc.department?.name || null,
                departmentShortName: doc.department?.shortName || null,
                issueName: doc.issue?.name || null,
                issueCustomText: doc.issue?.customText || doc.issue?.issueCustomText || null,
                errorType: doc.errorType || null,
                isFixedIt: doc.errorType === 'i_fixed_it',
                isKickItBack: doc.errorType === 'kick_it_back',
                accountableName: doc.errorAssignedTo ? [doc.errorAssignedTo.firstName, doc.errorAssignedTo.lastName].filter(Boolean).join(' ') : null,
                accountableEmail: doc.errorAssignedTo?.email || null,
                categoryName: doc.category?.name || null,
                text: doc.text || null,
                qcCreatedAt: doc.createdAt ? toIso(toDate(doc.createdAt)) : null,
                _backfilledAt: new Date()
              }},
              upsert: true
            }
          };
        });

        if (batchQcOps.length > 0) {
          for (let i = 0; i < batchQcOps.length; i += 2000) {
            const result = await qcCol.bulkWrite(batchQcOps.slice(i, i + 2000), { ordered: false });
            totalUpsertedQc += result.upsertedCount || 0;
          }
        }

        push(`  → ${batchOrders.length} orders, ${batchSegOps.length} segs, ${batchQc.length} QC`);
      }

      // After all batches, set these for the metadata
      segmentCutoff = getCutoff(days);
      qcCutoff = getCutoff(days);

      // Skip the normal segment/QC processing below — jump straight to users + metadata
      // We set a flag so the code below knows batches already ran
      fullBatchResults = { totalOrders, totalSegOps, totalUpsertedSegs, totalQcRaw, totalUpsertedQc };
    } else {
      // Find the latest record we already have
      const latestSeg = await segCol
        .findOne({}, { sort: { segmentStart: -1 }, projection: { segmentStart: 1 } });
      const latestQc = await qcCol
        .findOne({}, { sort: { qcCreatedAt: -1 }, projection: { qcCreatedAt: 1 } });

      if (!latestSeg && !latestQc) {
        // Empty — seed with full window
        const days = options.days || 90;
        segmentCutoff = getCutoff(days);
        qcCutoff = getCutoff(days);
        push(`No existing data — seeding full ${days}-day window`);
      } else {
        // Overlap buffer: 15 minutes catches in-flight orders
        // (an order transitioning status right at the boundary)
        const bufferMs = 15 * 60 * 1000;
        segmentCutoff = latestSeg?.segmentStart
          ? new Date(new Date(latestSeg.segmentStart).getTime() - bufferMs)
          : getCutoff(options.days || 90);
        qcCutoff = latestQc?.qcCreatedAt
          ? new Date(new Date(latestQc.qcCreatedAt).getTime() - bufferMs)
          : getCutoff(options.days || 90);
        push(`Incremental from seg=${segmentCutoff.toISOString()}, qc=${qcCutoff.toISOString()}`);
      }
    }

    // ═════════════════════════════════════════════════════════
    // 1. KPI SEGMENTS + 2. QC EVENTS
    // (Skipped if full refresh already ran batched above)
    // ═════════════════════════════════════════════════════════

    let upsertedSegs = 0, updatedSegs = 0, segOpsCount = 0, qcRawCount = 0, upsertedQc = 0, ordersScanned = 0, openOrdersRechecked = 0;

    if (!fullBatchResults) {

    // 1a. Fetch orders with history entries in the cutoff window
    push('Querying production orders...');

    // Pre-fetch credential counts for all active credentials (no date filter —
    // V1-imported credentials have old createdAt dates, scoping must be by order not by cred date)
    push('Fetching credential counts...');
    let credCountMap = {}; // orderId (string) → credentialCount
    try {
      const credCounts = await prodDb.collection('order-credentials').aggregate([
        { $match: {
            active: true,
            $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
        }},
        { $group: { _id: { $toString: '$order' }, credentialCount: { $sum: 1 } } },
        { $project: { _id: 0, orderId: '$_id', credentialCount: 1 } }
      ], { allowDiskUse: true, maxTimeMS: 60000 }).toArray();
      for (const r of credCounts) credCountMap[r.orderId] = r.credentialCount;
      push(`  Credential counts: ${Object.keys(credCountMap).length} orders mapped`);
    } catch (cErr) {
      push(`  Credential counts: SKIPPED (${cErr.message}) — will default to 1`);
    }

    const orders = await prodDb.collection('orders').aggregate([
      {
        $match: {
          paymentStatus: 'paid',
          orderType: { $in: ['evaluation', 'translation'] },
          deletedAt: null,
          orderStatusHistory: { $exists: true, $not: { $size: 0 } },
          'orderStatusHistory.createdAt': upperBound
            ? { $gte: segmentCutoff, $lte: upperBound }
            : { $gte: segmentCutoff }
        }
      },
      {
        $project: {
          orderSerialNumber: 1, orderType: 1, parentOrderId: 1,
          reportItems: 1, orderStatusHistory: 1,
          lastAssignedAt: 1, orderVersion: 1, orderSource: 1
        }
      }
    ], { allowDiskUse: true }).toArray();
    push(`Fetched ${orders.length} orders`);

    // 1b. Also fetch orders that have open segments in our backfill
    //     (they may have closed since last run, even if outside the 2hr buffer)
    // Cap at 200 most-recent open segments to prevent unbounded growth of this query.
    // Orders are sorted by segmentStart descending so stale/old open segments
    // (likely data anomalies) are naturally deprioritized.
    const OPEN_SEGMENT_RECHECK_LIMIT = 200;
    const openSegments = await segCol
      .find({ isOpen: true }, { projection: { orderId: 1, segmentStart: 1 } })
      .sort({ segmentStart: -1 })
      .limit(OPEN_SEGMENT_RECHECK_LIMIT)
      .toArray();
    const openOrderIds = [...new Set(openSegments.map(s => s.orderId))];
    let openOrders = [];
    if (openOrderIds.length > 0 && !isFullRefresh) {
      push(`Re-checking ${openOrderIds.length} orders with open segments...`);
      // Convert string IDs back to ObjectId for the query
      // ObjectId already imported at top of file
      const objectIds = openOrderIds.map(id => { try { return new ObjectId(id); } catch { return null; } }).filter(Boolean);
      if (objectIds.length > 0) {
        openOrders = await prodDb.collection('orders').find(
          { _id: { $in: objectIds } },
          { projection: { orderSerialNumber: 1, orderType: 1, parentOrderId: 1, reportItems: 1, orderStatusHistory: 1, lastAssignedAt: 1, orderVersion: 1, orderSource: 1 } }
        ).toArray();
        push(`Fetched ${openOrders.length} previously-open orders`);
      }
    }

    // 1c. Merge and deduplicate by _id
    const allOrders = new Map();
    for (const o of orders) allOrders.set(String(o._id), o);
    for (const o of openOrders) allOrders.set(String(o._id), o); // overwrite with fresh copy

    // 1d. Build segments
    const segOps = []; // bulkWrite operations
    for (const order of allOrders.values()) {
      const history = Array.isArray(order.orderStatusHistory) ? order.orderStatusHistory : [];
      const reportCount = Array.isArray(order.reportItems) ? order.reportItems.length : 0;
      const reportName = Array.isArray(order.reportItems) ? (order.reportItems[0]?.name || null) : null;

      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        if (entry?.updatedStatus?.statusType !== 'Processing') continue;
        const entryDate = toDate(entry?.createdAt);
        if (!entryDate) continue;

        // For incremental: skip segments we definitely already have and that are closed
        // (they're immutable). Only process if:
        //   - The segment is in the cutoff window, OR
        //   - The order had an open segment we're re-checking
        if (!isFullRefresh && entryDate < segmentCutoff && !openOrderIds.includes(String(order._id))) continue;

        const nextEntry = i + 1 < history.length ? history[i + 1] : null;
        const segEnd = toDate(nextEntry?.createdAt);
        const durSec = segEnd ? (segEnd.getTime() - entryDate.getTime()) / 1000 : null;
        if (durSec !== null && durSec <= 0) continue;
        const durMin = durSec !== null ? Math.round((durSec / 60) * 10) / 10 : null;
        const assigned = entry?.assignedTo || {};
        const user = entry?.user || {};
        const preciseEnd = entry?.anotherStatusUpdatedAt ? toDate(entry.anotherStatusUpdatedAt) : null;
        const effectiveEnd = preciseEnd || segEnd;
        const eDurSec = effectiveEnd ? (effectiveEnd.getTime() - entryDate.getTime()) / 1000 : durSec;
        const eDurMin = eDurSec !== null ? Math.round((eDurSec / 60) * 10) / 10 : durMin;

        const compositeKey = `${String(order._id)}_${entry?.updatedStatus?.slug || ''}_${entryDate.toISOString()}`;

        segOps.push({
          updateOne: {
            filter: { _compositeKey: compositeKey },
            update: { $set: {
              _compositeKey: compositeKey,
              orderSerialNumber: order.orderSerialNumber,
              orderId: String(order._id),
              orderType: order.orderType,
              parentOrderId: order.parentOrderId || null,
              reportItemCount: reportCount,
              reportItemName: reportName,
              statusSlug: entry?.updatedStatus?.slug || '',
              statusName: entry?.updatedStatus?.name || '',
              workerUserId: assigned.foreignKeyId || assigned.v2Id || null,
              workerName: buildFullName(assigned),
              workerEmail: assigned.email ? assigned.email.toLowerCase().trim() : null,
              changedByName: buildFullName(user),
              segmentStart: toIso(entryDate),
              segmentEnd: toIso(effectiveEnd || segEnd),
              durationSeconds: eDurSec ?? durSec,
              durationMinutes: eDurMin ?? durMin,
              isOpen: (effectiveEnd || segEnd) === null,
              isErrorReporting: !!entry?.isErrorReporting,
              lastAssignedAt: order.lastAssignedAt ? toIso(toDate(order.lastAssignedAt)) : null,
              orderVersion: order.orderVersion || null,
              orderSource: order.orderSource || null,
              _backfilledAt: new Date()
            }},
            upsert: true
          }
        });
      }
    }

    // 1e. Execute bulk upsert (one network round trip)
    let upsertedSegs = 0, updatedSegs = 0;
    if (segOps.length > 0) {
      // bulkWrite in batches of 2000 (MongoDB limit is 100k but smaller is safer)
      for (let i = 0; i < segOps.length; i += 2000) {
        const batch = segOps.slice(i, i + 2000);
        const result = await segCol.bulkWrite(batch, { ordered: false });
        upsertedSegs += result.upsertedCount || 0;
        updatedSegs += result.modifiedCount || 0;
      }
    }

    // 1f. Indexes (idempotent, fast if already exist)
    await segCol.createIndex({ _compositeKey: 1 }, { unique: true }).catch(() => {});
    await segCol.createIndex({ workerEmail: 1 }).catch(() => {});
    await segCol.createIndex({ statusSlug: 1 }).catch(() => {});
    await segCol.createIndex({ orderType: 1 }).catch(() => {});
    await segCol.createIndex({ segmentStart: -1 }).catch(() => {});
    await segCol.createIndex({ isOpen: 1 }).catch(() => {});
    // Compound indexes for common filtered queries
    await segCol.createIndex({ departmentName: 1, segmentStart: -1 }).catch(() => {});
    await segCol.createIndex({ workerEmail: 1, segmentStart: -1 }).catch(() => {});
    await segCol.createIndex({ statusSlug: 1, segmentStart: -1 }).catch(() => {});

    push(`Segments: ${upsertedSegs} new, ${updatedSegs} updated, ${segOps.length} processed`);

    // ═════════════════════════════════════════════════════════
    // 2. QC EVENTS
    // ═════════════════════════════════════════════════════════

    push('Querying production QC events...');
    // Query order-discussion directly with our cutoff (don't go through getQcEventsDataset)
    const qcRaw = await prodDb.collection('order-discussion').find({
      type: 'system_logs',
      'category.slug': 'quality_control',
      createdAt: upperBound ? { $gte: qcCutoff, $lte: upperBound } : { $gte: qcCutoff },
      deletedAt: null
    }, {
      projection: {
        order: 1, user: 1, category: 1, department: 1, issue: 1,
        errorType: 1, errorAssignedTo: 1, text: 1, createdAt: 1
      }
    }).toArray();

    push(`Fetched ${qcRaw.length} QC events from production`);

    // Build order lookup for serial numbers and order types
    const qcOrderIds = [...new Set(qcRaw.map(d => d.order).filter(Boolean))];
    const qcOrderMap = {};
    if (qcOrderIds.length > 0) {
      const qcOrders = await prodDb.collection('orders').find(
        { _id: { $in: qcOrderIds.map(id => typeof id === 'string' ? new ObjectId(id) : id) } },
        { projection: { orderSerialNumber: 1, orderType: 1 } }
      ).toArray();
      for (const o of qcOrders) qcOrderMap[String(o._id)] = o;
    }

    const qcOps = qcRaw.map(doc => {
      const qcKey = String(doc._id);
      const oid = doc.order ? String(doc.order) : null;
      const ord = oid ? qcOrderMap[oid] : null;
      return {
        updateOne: {
          filter: { _qcKey: qcKey },
          update: { $set: {
            _qcKey: qcKey,
            orderId: oid,
            orderSerialNumber: ord?.orderSerialNumber || null,
            orderType: ord?.orderType || null,
            reporterName: doc.user ? [doc.user.firstName, doc.user.lastName].filter(Boolean).join(' ') : null,
            reporterEmail: doc.user?.email || null,
            departmentName: doc.department?.name || null,
            departmentShortName: doc.department?.shortName || null,
            issueName: doc.issue?.name || null,
            issueCustomText: doc.issue?.customText || doc.issue?.issueCustomText || null,
            errorType: doc.errorType || null,
            isFixedIt: doc.errorType === 'i_fixed_it',
            isKickItBack: doc.errorType === 'kick_it_back',
            accountableName: doc.errorAssignedTo ? [doc.errorAssignedTo.firstName, doc.errorAssignedTo.lastName].filter(Boolean).join(' ') : null,
            accountableEmail: doc.errorAssignedTo?.email || null,
            categoryName: doc.category?.name || null,
            text: doc.text || null,
            qcCreatedAt: doc.createdAt ? toIso(toDate(doc.createdAt)) : null,
            // Find which status the order was in when this QC event was created
            // by walking orderStatusHistory and finding the active status at qcCreatedAt
            statusAtQcName: (() => {
              if (!ord?.orderStatusHistory || !doc.createdAt) return null;
              const qcTs = toDate(doc.createdAt)?.getTime();
              if (!qcTs) return null;
              const hist = ord.orderStatusHistory;
              let active = null;
              for (let i = 0; i < hist.length; i++) {
                const entryTs = toDate(hist[i]?.createdAt)?.getTime();
                if (entryTs && entryTs <= qcTs) active = hist[i]?.updatedStatus?.name || null;
                else if (entryTs && entryTs > qcTs) break;
              }
              return active;
            })(),
            _backfilledAt: new Date()
          }},
          upsert: true
        }
      };
    });

    let upsertedQc = 0;
    if (qcOps.length > 0) {
      for (let i = 0; i < qcOps.length; i += 2000) {
        const batch = qcOps.slice(i, i + 2000);
        const result = await qcCol.bulkWrite(batch, { ordered: false });
        upsertedQc += result.upsertedCount || 0;
      }
    }

    await qcCol.createIndex({ _qcKey: 1 }, { unique: true }).catch(() => {});
    await qcCol.createIndex({ departmentName: 1 }).catch(() => {});
    await qcCol.createIndex({ errorType: 1 }).catch(() => {});
    await qcCol.createIndex({ qcCreatedAt: -1 }).catch(() => {});

    push(`QC events: ${upsertedQc} new out of ${qcRaw.length} processed`);

    ordersScanned = allOrders.size;
    openOrdersRechecked = openOrders.length;
    segOpsCount = segOps.length;
    qcRawCount = qcRaw.length;

    } // end if (!fullBatchResults)

    // If full batch ran, pull numbers from there
    if (fullBatchResults) {
      ordersScanned = fullBatchResults.totalOrders;
      segOpsCount = fullBatchResults.totalSegOps;
      upsertedSegs = fullBatchResults.totalUpsertedSegs;
      qcRawCount = fullBatchResults.totalQcRaw;
      upsertedQc = fullBatchResults.totalUpsertedQc;
    }

    // Indexes managed by ensureIndexes() — called once at startup
    await ensureIndexes();

    // ═════════════════════════════════════════════════════════
    // 3. QUEUE SNAPSHOT (always fresh — captures current state)
    // ═════════════════════════════════════════════════════════

    push('Capturing queue snapshot...');
    try {
      const snapResult = await internalFetch('/queue-snapshot');
      await configDb.collection('backfill_queue_snapshot').updateOne(
        { _id: 'current' },
        { $set: { ...snapResult, _backfilledAt: new Date() } },
        { upsert: true }
      );
      push(`Queue snapshot: ${snapResult.totalActiveOrders || 0} active orders, ${snapResult.statusCount || 0} statuses`);
    } catch (qErr) {
      push(`Queue snapshot: SKIPPED (${qErr.message})`);
    }

    // ═════════════════════════════════════════════════════════
    // 3b. QUEUE WAIT SUMMARY — backfill into config DB
    // ═════════════════════════════════════════════════════════
    // Previously called live on every Queue Ops page load (/queue-wait-summary?days=450)
    // which runs a 450-day production MongoDB aggregation (10-22s, blocks the UI).
    // Now pre-computed here and served instantly from /data/queue-wait-summary.
    // 90-day window — 450 days was excessive and the primary cause of timeouts.
    try {
      push('Computing queue wait summary...');
      // Call the shared function directly — no HTTP round-trip overhead.
      // internalFetch('/queue-wait-summary') was adding ~10s to every backfill cycle.
      const waitResult = await computeQueueWaitSummary(90);
      await configDb.collection('backfill_queue_wait_summary').updateOne(
        { _id: 'current' },
        { $set: { ...waitResult, _backfilledAt: new Date() } },
        { upsert: true }
      );
      push(`Queue wait summary: ${waitResult.statusCount || 0} statuses over ${waitResult.days || 90} days`);
    } catch (wErr) {
      push(`Queue wait summary: SKIPPED (${wErr.message})`);
    }

    // ═════════════════════════════════════════════════════════
    // 3c. ORDER ARRIVALS + TURNAROUND — staffing forecast data
    // ═════════════════════════════════════════════════════════
    try {
      await runOrderArrivalBackfill(prodDb, configDb, push, { forceFullSeed: isFullRefresh });
    } catch (aErr) {
      push(`Order arrivals: SKIPPED (${aErr.message})`);
    }

    // ═════════════════════════════════════════════════════════
    // 4. USERS — decoupled sync (60-minute cadence, staging swap)
    // ═════════════════════════════════════════════════════════
    // Users don't change at KPI frequency. Running a 150k-doc full replace
    // every 2 minutes costs ~35s and spikes RSS by ~200MB for no benefit.
    // Full refresh and forced user sync bypass the interval guard.
    const _push = push;
    _push._forceUserSync = isFullRefresh || !!options.forceUserSync;
    const userSyncResult = await runUserSync(configDb, _push);

    // ═════════════════════════════════════════════════════════
    // 4. METADATA + HISTORY
    // ═════════════════════════════════════════════════════════

    const elapsed = Date.now() - startTime;
    const totalSegs = await segCol.countDocuments();
    const totalQc = await qcCol.countDocuments();
    const openCount = await segCol.countDocuments({ isOpen: true });

    const metadata = {
      running: false,
      lastRunAt: new Date(),
      lastRunDurationMs: elapsed,
      lastRunDurationSec: Math.round(elapsed / 100) / 10,
      mode: isFullRefresh ? 'full' : 'incremental',
      triggeredBy: options.triggeredBy || 'system',
      counts: {
        ordersScanned,
        openOrdersRechecked,
        segmentsProcessed: segOpsCount,
        segmentsNew: upsertedSegs,
        segmentsUpdated: updatedSegs,
        segmentsTotal: totalSegs,
        qcProcessed: qcRawCount,
        qcNew: upsertedQc,
        qcTotal: totalQc,
        users: userSyncResult.count ?? null,
        userSyncSkipped: userSyncResult.skipped ?? false,
        openSegments: openCount
      },
      log
    };

    await configDb.collection('backfill_metadata').replaceOne(
      { _id: 'status' }, { _id: 'status', ...metadata }, { upsert: true }
    );

    // History: capped at 50 via simple delete
    const { _id: _, ...historyDoc } = { ...metadata };
    await configDb.collection('backfill_history').insertOne({ ...historyDoc, completedAt: new Date() });
    await configDb.collection('backfill_history')
      .deleteMany({ completedAt: { $lt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } }); // keep 60 days (needed for monthly full-refresh detection)

    push(`Done in ${(elapsed/1000).toFixed(1)}s — ${upsertedSegs} new segs, ${updatedSegs} updated, ${upsertedQc} new QC, ${totalSegs} total`);
    backfillRunning  = false;
    backfillStartedAt = 0;
    backfillLastRunEnd = Date.now(); // anchor next-run window to completion, not wall clock
    invalidateBackfillMeta(); // flush cached meta so next request sees fresh lastRunAt
    return metadata;

  } catch (err) {
    push(`ERROR: ${err.message}`);
    backfillRunning  = false;
    backfillStartedAt = 0;
    backfillLastRunEnd = Date.now(); // record end even on error so scheduler doesn't tight-loop
    try {
      const configDb = await getConfigDb();
      await configDb.collection('backfill_metadata').updateOne(
        { _id: 'status' },
        { $set: { running: false, lastError: err.message, lastErrorAt: new Date(), log } },
        { upsert: true }
      );
    } catch {}
    return { error: err.message, log };
  }
}

// —— POST /backfill/run — Admin trigger ——————————————————
// Body options:
//   { full: true, days: 90 }          — wipe + re-seed last N days
//   { dateFrom: "2025-01-01", dateTo: "2025-01-31" }  — backfill specific range
//   {}                                 — incremental (only new since last run)
app.post('/backfill/run', requireRole('admin'), async (req, res) => {
  try {
    const { days, full, dateFrom, dateTo, forceUserSync } = req.body;
    if (backfillRunning) return res.status(409).json({ error: 'Backfill already in progress' });

    const opts = {
      days: days ? Math.min(Math.max(parseInt(days) || 500, 1), 500) : 500,
      full: !!full,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      forceUserSync: !!forceUserSync, // bypass 60-min user sync interval for this run
      triggeredBy: req.user?.name || 'admin'
    };

    const mode = full ? 'Full' : (dateFrom || dateTo) ? `Range ${dateFrom || '...'}→${dateTo || 'now'}` : 'Incremental';
    res.json({ success: true, message: `${mode} backfill started. Check /backfill/status.` });
    runBackfill(opts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /backfill/status ————————————————————————————————
app.get('/backfill/status', async (req, res) => {
  try {
    const db = await getConfigDb();
    const status = await db.collection('backfill_metadata').findOne({ _id: 'status' });

    // Also get collection counts
    const [segCount, qcCount, usrCount] = await Promise.all([
      db.collection('backfill_kpi_segments').countDocuments().catch(() => 0),
      db.collection('backfill_qc_events').countDocuments().catch(() => 0),
      db.collection('backfill_users').countDocuments().catch(() => 0)
    ]);

    res.json({
      ...status,
      currentCounts: { segments: segCount, qcEvents: qcCount, users: usrCount },
      isRunning: backfillRunning
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /backfill/history ———————————————————————————————
app.get('/backfill/history', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const db = await getConfigDb();
    const history = await db.collection('backfill_metadata')
      .find({ type: 'history' })
      .sort({ lastRunAt: -1 })
      .limit(20)
      .toArray();
    res.json({ count: history.length, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /backfill/settings —————————————————————————————
app.put('/backfill/settings', requireRole('admin'), async (req, res) => {
  try {
    const { autoRefreshMinutes, days, enabled } = req.body;
    const db = await getConfigDb();
    const settings = {
      autoRefreshMinutes: Math.max(autoRefreshMinutes || 5, 1), // min 1 minute
      days: Math.min(days || 90, 365),
      enabled: enabled !== false,
      updatedBy: req.user?.name,
      updatedAt: new Date()
    };
    await db.collection('backfill_metadata').replaceOne(
      { _id: 'settings' }, { _id: 'settings', ...settings }, { upsert: true }
    );
    await auditLog('update_backfill_settings', 'backfill_metadata', settings, req.user?.name);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /backfill/settings —————————————————————————————
app.get('/backfill/settings', async (req, res) => {
  try {
    const db = await getConfigDb();
    const settings = await db.collection('backfill_metadata').findOne({ _id: 'settings' });
    res.json(settings || { autoRefreshMinutes: 5, days: 90, enabled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /backfill/next — Lightweight status for dashboard widget ——
// Returns: isRunning, lastRunAt, nextRunAt, enabled, intervalMin, userSync
app.get('/backfill/next', async (req, res) => {
  try {
    const db = await getConfigDb();
    const [settings, status] = await Promise.all([
      db.collection('backfill_metadata').findOne({ _id: 'settings' }),
      db.collection('backfill_metadata').findOne({ _id: 'status' })
    ]);
    const enabled = settings?.enabled !== false;
    const intervalMin = settings?.autoRefreshMinutes || 5;
    const lastRunAt = status?.lastRunAt || null;
    const lastRunDurationSec = status?.lastRunDurationSec || null;
    const isRunning = backfillRunning;

    // nextRunAt anchored to run-end (backfillLastRunEnd), not run-start
    // Falls back to lastRunAt-based estimate if process restarted (lastRunEnd = 0)
    let nextRunAt = null;
    if (enabled && !isRunning) {
      const anchor = backfillLastRunEnd > 0
        ? backfillLastRunEnd
        : (lastRunAt ? new Date(lastRunAt).getTime() : 0);
      if (anchor > 0) {
        nextRunAt = new Date(anchor + intervalMin * 60 * 1000).toISOString();
      }
    }

    // User sync state for admin visibility
    const userSyncMinsAgo = userSyncLastRunAt > 0
      ? Math.round((Date.now() - userSyncLastRunAt) / 60000)
      : null;
    const userSyncNextInMins = userSyncLastRunAt > 0
      ? Math.max(0, Math.round((USER_SYNC_INTERVAL_MS - (Date.now() - userSyncLastRunAt)) / 60000))
      : 0;

    res.json({
      enabled, intervalMin, isRunning, lastRunAt, lastRunDurationSec, nextRunAt,
      userSync: {
        lastSyncMinsAgo: userSyncMinsAgo,
        nextSyncInMins: userSyncNextInMins,
        isRunning: userSyncRunning,
        intervalMin: USER_SYNC_INTERVAL_MS / 60000
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// FAST READ ENDPOINTS — Read from backfill collections
// These replace the slow live queries for the dashboard.
// The original endpoints still work for GAS/Bruno (live data).
// ═══════════════════════════════════════════════════════════

// —— GET /data/kpi-segments — Fast read from backfill ————
app.get('/data/kpi-segments', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = parsePositiveInt(req.query.pageSize, 10000, { min: 1, max: 10000 }); // raised from 5000 — halves round trips
    const db = await getConfigDb();
    const col = db.collection('backfill_kpi_segments');

    // Build filter
    const filter = {};
    if (req.query.orderType) filter.orderType = req.query.orderType;
    if (req.query.workerEmail) filter.workerEmail = req.query.workerEmail;
    if (req.query.workerUserId) filter.workerUserId = req.query.workerUserId;
    if (req.query.statusSlug) filter.statusSlug = req.query.statusSlug;
    if (req.query.from) filter.segmentStart = { $gte: req.query.from };
    if (req.query.to) filter.segmentStart = { ...filter.segmentStart, $lte: req.query.to + 'T23:59:59' };

    // Use a single find() — avoids separate countDocuments() round trip.
    // We fetch pageSize+1 docs to detect if there are more pages.
    // This is safe because pageSize is capped at 10000 and dataset is ~95k rows.
    // Two-tier projection: summary fields always sent, drilldown fields only when requested
    const drilldown = req.query.drilldown === '1';
    const CLIENT_PROJECTION = {
      // Core fields — needed for all KPI calculations
      orderSerialNumber:1, orderId:1, orderType:1,
      statusSlug:1, statusName:1,
      workerUserId:1, workerName:1, workerEmail:1,
      segmentStart:1, durationMinutes:1, isOpen:1,
      reportItemCount:1,  // Reports unit XpH
      credentialCount:1,  // Credentials unit XpH
      departmentName:1,   // For dept filtering
      ...(drilldown ? {
        // Drilldown-only fields — fetched separately when user opens detail tabs
        segmentEnd:1, durationSeconds:1,
        changedByName:1, isErrorReporting:1, reportItemName:1,
        orderSource:1, parentOrderId:1
      } : {})
    };
    const rawSegments = await col.find(filter, { projection: CLIENT_PROJECTION })
      .sort({ segmentStart: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize + 1)
      .toArray();
    const hasMorePage = rawSegments.length > pageSize;
    const segments = hasMorePage ? rawSegments.slice(0, pageSize) : rawSegments;
    // Approximate totalCount: exact only on last page, estimated otherwise
    const totalCount = hasMorePage
      ? (page - 1) * pageSize + pageSize + 1  // at least this many
      : (page - 1) * pageSize + segments.length;

    const meta = await getBackfillMeta(db);

    res.json({
      count: segments.length,
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      hasMore: page * pageSize < totalCount,
      source: 'backfill',
      lastBackfillAt: meta?.lastRunAt || null,
      lastBackfillDuration: meta?.lastRunDurationSec || null,
      segments
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/qc-events — Fast read from backfill ———————
app.get('/data/qc-events', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = parsePositiveInt(req.query.pageSize, 5000, { min: 1, max: 10000 });
    const db = await getConfigDb();
    const col = db.collection('backfill_qc_events');

    const filter = {};
    if (req.query.departmentName) filter.departmentName = req.query.departmentName;
    if (req.query.errorType) filter.errorType = req.query.errorType;
    if (req.query.orderType) filter.orderType = req.query.orderType;

    const QC_PROJECTION = {
      _qcKey:1, orderId:1, orderSerialNumber:1, orderType:1,
      reporterName:1, departmentName:1,
      issueName:1, errorType:1,
      isFixedIt:1, isKickItBack:1,
      accountableName:1,
      qcCreatedAt:1,
      // statusAtQcName populated if available (v5.4.14+)
      statusAtQcName:1, nextStatusName:1,
    };
    const totalCount = await col.countDocuments(filter);
    const events = await col.find(filter, { projection: QC_PROJECTION })
      .sort({ qcCreatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    const meta = await getBackfillMeta(db);

    res.json({
      count: events.length,
      totalCount,
      page, pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      hasMore: page * pageSize < totalCount,
      source: 'backfill',
      lastBackfillAt: meta?.lastRunAt || null,
      events
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/users — Fast read from backfill ——————————
app.get('/data/users', async (req, res) => {
  try {
    const db = await getConfigDb();
    // Project only the fields the client actually needs for department/level resolution.
    // Before the staff-only filter fix, backfill_users had 150k docs and fetching
    // all fields took ~20s. This projection keeps it fast even on a stale collection.
    const users = await db.collection('backfill_users')
      .find({}, { projection: { v2Id:1, v1Id:1, fullName:1, email:1, departmentName:1, departmentId:1, isActive:1 } })
      .sort({ fullName: 1 })
      .toArray();
    res.json({ count: users.length, source: 'backfill', users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/queue-snapshot — Fast read from backfill ——
// Returns the cached queue snapshot from the last backfill run.
// Falls back to live /queue-snapshot if no cached data exists.
app.get('/data/queue-snapshot', async (req, res) => {
  try {
    const db = await getConfigDb();
    const cached = await db.collection('backfill_queue_snapshot').findOne({ _id: 'current' });
    if (cached) {
      delete cached._id;
      res.json({ ...cached, source: 'backfill' });
    } else {
      // No cache yet — fall back to live (first-time scenario)
      const live = await internalFetch('/queue-snapshot');
      res.json({ ...live, source: 'live-fallback' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/queue-status-orders — Orders currently in a given status ——
// Used by QueueOps drilldown drawer. Returns order-level rows for a status slug
// from backfill_kpi_segments (open segments only) so we never hit production.
// Query params:
//   statusSlug  (required) — the status slug to filter on
//   orderType   (optional) — 'evaluation' | 'translation'
//   agingBucket (optional) — 'lt24' | '24-48' | '48-72' | 'gt72'
app.get('/data/queue-status-orders', async (req, res) => {
  try {
    const { statusSlug, orderType, agingBucket } = req.query;
    if (!statusSlug) return res.status(400).json({ error: 'statusSlug is required' });

    const db = await getConfigDb();
    const col = db.collection('backfill_kpi_segments');

    // Base filter: open segments in this status
    const filter = { statusSlug, isOpen: true };
    if (orderType) filter.orderType = orderType;

    const segments = await col.find(filter)
      .sort({ segmentStart: 1 }) // oldest first — most urgent at top
      .limit(2000)
      .toArray();

    // Calculate wait hours and apply aging bucket filter
    const now = Date.now();
    const rows = segments.map(s => {
      const startMs = s.segmentStart ? new Date(s.segmentStart).getTime() : null;
      const waitHours = startMs ? Math.round((now - startMs) / 36000) / 100 : null;
      return {
        orderSerialNumber: s.orderSerialNumber,
        orderId: s.orderId,
        orderType: s.orderType,
        workerName: s.workerName || null,
        workerEmail: s.workerEmail || null,
        departmentName: s.departmentName || null,
        segmentStart: s.segmentStart,
        waitHours,
        statusName: s.statusName,
        statusSlug: s.statusSlug,
      };
    }).filter(r => {
      if (!agingBucket || r.waitHours === null) return true;
      const h = r.waitHours;
      if (agingBucket === 'lt24')  return h < 24;
      if (agingBucket === '24-48') return h >= 24 && h < 48;
      if (agingBucket === '48-72') return h >= 48 && h < 72;
      if (agingBucket === 'gt72')  return h >= 72;
      return true;
    });

    res.json({ count: rows.length, statusSlug, statusName: rows[0]?.statusName || statusSlug, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/queue-wait-summary — Fast read from backfill ——————————————————
// Returns the pre-computed queue wait summary from the last backfill run.
// Replaces the live /queue-wait-summary?days=450 call (10-22s production query)
// with a sub-millisecond config DB read. Falls back to live if not yet cached.
app.get('/data/queue-wait-summary', async (req, res) => {
  try {
    const db = await getConfigDb();
    const cached = await db.collection('backfill_queue_wait_summary').findOne({ _id: 'current' });
    if (cached) {
      delete cached._id;
      res.json({ ...cached, source: 'backfill' });
    } else {
      // No cache yet (first deploy after backfill runs it will be populated).
      // Compute directly — no HTTP round-trip.
      console.log('[QUEUE-WAIT] No cache found, computing live (first deploy)');
      const live = await computeQueueWaitSummary(90);
      res.json({ ...live, source: 'live-fallback' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Fires every 60s to check whether a run is due.
// IMPORTANT: interval eligibility is anchored to backfillLastRunEnd (run completion),
// not lastRunAt (run start). This guarantees a full cooldown period between runs
// even when runs take 30+ seconds, preventing back-to-back execution under load.
let _schedulerSkipUntil = 0; // epoch ms — mandatory cooldown after a memory-skip

function startBackfillScheduler() {
  setInterval(async () => {
    try {
      // Enforce mandatory post-skip cooldown (90s) before re-checking memory
      if (Date.now() < _schedulerSkipUntil) return;

      const db = await getConfigDb();
      const settings = await db.collection('backfill_metadata').findOne({ _id: 'settings' });
      if (!settings?.enabled) return; // disabled by default — must be explicitly enabled

      const intervalMs = (settings.autoRefreshMinutes || 5) * 60 * 1000;

      // Memory guard: skip auto-cron if RSS is unreasonably high.
      // Raised to 4000MB — this server runs on a 32GB Railway instance so the
      // old 450MB threshold (tuned for 512MB containers) was firing constantly.
      // At 4000MB we only skip if something is genuinely leaking.
      const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      if (memMB > 4000) {
        _schedulerSkipUntil = Date.now() + 90_000; // 90s mandatory cooldown
        console.log(`[BACKFILL-CRON] Skipped — memory too high (${memMB}MB RSS). Cooldown 90s.`);
        return;
      }

      // Anchor to run-end, not run-start.
      // If a run takes 37s and interval is 2min, next eligible fire is 2min after
      // the run *finished*, not 2min after it started.
      const timeSinceEnd = Date.now() - backfillLastRunEnd;
      if (timeSinceEnd >= intervalMs && !backfillRunning) {

        // Monthly full-refresh guard: if last full refresh was >30 days ago,
        // trigger a full refresh to purge segments outside the retention window.
        // This prevents old segment accumulation when only incremental runs.
        const historyDb = await getConfigDb();
        const lastFull = await historyDb.collection('backfill_history')
          .findOne({ mode: 'full' }, { sort: { completedAt: -1 }, projection: { completedAt: 1 } });
        const lastFullAt = lastFull?.completedAt ? new Date(lastFull.completedAt) : null;
        const daysSinceFullRefresh = lastFullAt
          ? (Date.now() - lastFullAt.getTime()) / 86400000
          : 999;

        if (daysSinceFullRefresh > 30) {
          console.log(`[BACKFILL-CRON] Auto full-refresh triggered — last full refresh was ${Math.round(daysSinceFullRefresh)}d ago`);
          runBackfill({ fullRefresh: true, days: settings.days || 90, triggeredBy: 'auto-monthly-full' });
        } else {
          console.log(`[BACKFILL-CRON] Auto-backfill triggered (interval: ${settings.autoRefreshMinutes}min, mem: ${memMB}MB, cooldown: ${Math.round(timeSinceEnd/1000)}s since last end)`);
          runBackfill({ days: settings.days || 90, triggeredBy: 'auto-scheduler' });
        }
      }
    } catch (err) {
      console.error('[BACKFILL-CRON] Error:', err.message);
    }
  }, 60000); // Poll every 60s

  console.log('Backfill auto-scheduler started (checks every 60s, run-end-anchored, disabled by default)');
}


// ═══════════════════════════════════════════════════════════
// REPORT BUILDER — Server-side aggregation against backfill data
// ═══════════════════════════════════════════════════════════

// —— GET /data/order/:serialNumber — Full order lifecycle ────
// Returns all segments + QC events for a single order serial number.
// Used by the Order Tracker page for root-cause investigation.
app.get('/data/order/:serialNumber', async (req, res) => {
  try {
    const serial = (req.params.serialNumber || '').trim();
    if (!serial) return res.status(400).json({ error: 'serialNumber required' });

    const db = await getConfigDb();

    const [segments, qcEvents] = await Promise.all([
      db.collection('backfill_kpi_segments')
        .find({ orderSerialNumber: serial })
        .sort({ segmentStart: 1 })
        .toArray(),
      db.collection('backfill_qc_events')
        .find({ orderSerialNumber: serial })
        .sort({ qcCreatedAt: 1 })
        .toArray(),
    ]);

    if (!segments.length && !qcEvents.length) {
      return res.status(404).json({ error: `No data found for order ${serial}` });
    }

    // Build timeline: merge segments + QC events sorted chronologically
    const timeline = [
      ...segments.map(s => ({
        type: 'segment',
        at: s.segmentStart,
        end: s.segmentEnd,
        statusName: s.statusName,
        statusSlug: s.statusSlug,
        workerName: s.workerName,
        workerEmail: s.workerEmail,
        workerUserId: s.workerUserId,
        durationMinutes: s.durationMinutes,
        durationSeconds: s.durationSeconds,
        isOpen: s.isOpen,
        orderType: s.orderType,
        departmentName: s.departmentName,
        changedByName: s.changedByName,
        isErrorReporting: s.isErrorReporting,
        reportItemCount: s.reportItemCount,
        reportItemName: s.reportItemName,
      })),
      ...qcEvents.map(e => ({
        type: 'qc',
        at: e.qcCreatedAt,
        errorType: e.errorType,
        isFixedIt: e.isFixedIt,
        isKickItBack: e.isKickItBack,
        reporterName: e.reporterName,
        accountableName: e.accountableName,
        issueName: e.issueName,
        departmentName: e.departmentName,
        statusAtQcName: e.statusAtQcName,
      })),
    ].sort((a, b) => (a.at || '').localeCompare(b.at || ''));

    // Summary stats
    const closedSegs = segments.filter(s => !s.isOpen && s.durationMinutes != null);
    const totalMinutes = closedSegs.reduce((a, s) => a + (s.durationMinutes || 0), 0);
    const uniqueStatuses = [...new Set(segments.map(s => s.statusName).filter(Boolean))];
    const uniqueWorkers  = [...new Set(segments.map(s => s.workerEmail || s.workerName).filter(Boolean))];

    res.json({
      serialNumber: serial,
      orderType: segments[0]?.orderType || null,
      totalSegments: segments.length,
      openSegments: segments.filter(s => s.isOpen).length,
      totalQcEvents: qcEvents.length,
      fixedItCount: qcEvents.filter(e => e.isFixedIt).length,
      kickBackCount: qcEvents.filter(e => e.isKickItBack).length,
      totalMinutes: Math.round(totalMinutes * 10) / 10,
      uniqueStatuses,
      uniqueWorkers: uniqueWorkers.length,
      firstSeen: segments[0]?.segmentStart || null,
      lastSeen: segments[segments.length - 1]?.segmentEnd || segments[segments.length - 1]?.segmentStart || null,
      timeline,
      segments,
      qcEvents,
    });
  } catch (err) {
    console.error('Order tracker error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— POST /reports/query — Execute a report ——————————————
app.post('/reports/query', async (req, res) => {
  try {
    const { source, metric, secondaryMetric, groupBy, filters, sortBy, limit } = req.body;
    if (!source || !metric || !groupBy) {
      return res.status(400).json({ error: 'source, metric, and groupBy required' });
    }

    const db = await getConfigDb();
    const colName = source === 'qc' ? 'backfill_qc_events' : 'backfill_kpi_segments';
    const col = db.collection(colName);
    const dateField = source === 'qc' ? 'qcCreatedAt' : 'segmentStart';

    // ── Build match filter ───────────────────────────────────
    const match = {};
    if (filters) {
      if (filters.dateFrom) match[dateField] = { ...match[dateField], $gte: filters.dateFrom };
      if (filters.dateTo)   match[dateField] = { ...match[dateField], $lte: filters.dateTo + 'T23:59:59' };
      if (filters.workers?.length) {
        // workers filter contains workerUserId values (integers as strings) or emails
        // Split into uids and emails for proper matching
        const uids   = filters.workers.filter(w => /^\d+$/.test(String(w))).map(Number);
        const emails = filters.workers.filter(w => !/^\d+$/.test(String(w)));
        const workerClauses = [];
        if (uids.length)   workerClauses.push({ workerUserId: { $in: uids } });
        if (emails.length) workerClauses.push({ workerEmail: { $in: emails } });
        if (workerClauses.length === 1) Object.assign(match, workerClauses[0]);
        else if (workerClauses.length > 1) match.$or = [...(match.$or||[]), ...workerClauses];
      }
      if (filters.statuses?.length)    match.statusSlug    = { $in: filters.statuses };
      if (filters.orderType)           match.orderType     = filters.orderType;
      if (filters.orderTypes?.length)  match.orderType     = { $in: filters.orderTypes };
      if (filters.departments?.length) match.departmentName= { $in: filters.departments };
      if (filters.errorTypes?.length)  match.errorType     = { $in: filters.errorTypes };
      if (filters.issues?.length)      match.issueName     = { $in: filters.issues };
      if (filters.excludeOpen)         match.isOpen        = { $ne: true };
    }

    // ── Build group key ──────────────────────────────────────
    function buildGroupKey(gb) {
      switch (gb) {
        // Group 'worker' by workerUserId (stable V1 integer ID).
        // Falls back to workerEmail for segments where workerUserId is null.
        // This ensures each real person is one group regardless of name/email variants.
        case 'worker':      return source==='qc' ? '$accountableName'
          : { $ifNull: ['$workerUserId', { $ifNull: ['$workerEmail', '$workerName'] }] };
        case 'workerEmail': return source==='qc' ? '$accountableEmail' : '$workerEmail';
        case 'statusName':  return '$statusName';
        case 'statusSlug':
        case 'status':      return '$statusSlug';
        case 'department':  return '$departmentName';
        case 'orderType':   return '$orderType';
        case 'errorType':   return '$errorType';
        case 'issueName':   return '$issueName';
        case 'orderSource': return '$orderSource';
        case 'date':  return { $substr: [`$${dateField}`, 0, 10] };
        case 'week':  return { $dateToString: { format:'%G-W%V', date:{ $dateFromString:{ dateString:`$${dateField}` } } } };
        case 'month': return { $substr: [`$${dateField}`, 0, 7] };
        default: return '$' + gb;
      }
    }

    // ── Build metric accumulator ─────────────────────────────
    function buildMetricAccumulator(m) {
      switch (m) {
        case 'count':          return { $sum: 1 };
        case 'avgDuration':    return { $avg: '$durationMinutes' };
        case 'medianDuration': return { $push: '$durationMinutes' }; // post-processed
        case 'totalHours':     return { $sum: { $divide: ['$durationMinutes', 60] } };
        case 'totalMinutes':   return { $sum: '$durationMinutes' };
        case 'maxDuration':    return { $max: '$durationMinutes' };
        case 'minDuration':    return { $min: '$durationMinutes' };
        case 'xph':            return null; // computed post-group
        case 'uniqueOrders':   return { $addToSet: '$orderSerialNumber' };
        case 'openRate':       return null; // computed post-group
        case 'inRangeCount':   return null; // computed post-group — needs benchmark lookup
        case 'fixedIt':        return { $sum: { $cond: ['$isFixedIt', 1, 0] } };
        case 'kickBack':       return { $sum: { $cond: ['$isKickItBack', 1, 0] } };
        case 'fixRate':        return null; // computed post-group
        case 'kbRate':         return null; // computed post-group
        default:               return { $sum: 1 };
      }
    }

    const primaryAcc   = buildMetricAccumulator(metric);
    const secondaryAcc = secondaryMetric ? buildMetricAccumulator(secondaryMetric) : null;
    const groupSpec    = { _id: buildGroupKey(groupBy), count: { $sum: 1 } };

    // Always collect what we need for post-computed metrics
    const needsDurations = ['xph', 'openRate', 'medianDuration'].includes(metric) || ['xph','openRate','medianDuration'].includes(secondaryMetric);
    const needsOpen      = ['openRate'].includes(metric) || ['openRate'].includes(secondaryMetric);

    if (primaryAcc)   groupSpec.value     = primaryAcc;
    else              groupSpec._durations = { $push: '$durationMinutes' };
    if (needsOpen)    groupSpec._openCount = { $sum: { $cond: ['$isOpen', 1, 0] } };
    if (secondaryAcc) groupSpec.secondary  = secondaryAcc;
    else if (secondaryMetric) groupSpec._secDurations = { $push: '$durationMinutes' };

    const pipeline = [
      { $match: match },
      { $group: groupSpec },
      { $limit: Math.min(limit || 200, 1000) }
    ];

    let results = await col.aggregate(pipeline, { allowDiskUse: true }).toArray();

    // ── Post-process computed metrics ───────────────────────
    function postProcess(r, m, valField, durField, openField) {
      const raw = r[valField];
      switch (m) {
        case 'uniqueOrders':
          return Array.isArray(raw) ? raw.length : 0;
        case 'medianDuration': {
          const arr = (r[durField] || []).filter(v => v != null).sort((a,b)=>a-b);
          if (!arr.length) return null;
          const mid = Math.floor(arr.length/2);
          return arr.length%2 ? arr[mid] : (arr[mid-1]+arr[mid])/2;
        }
        case 'xph': {
          const durs = (r[durField] || []).filter(v => v != null);
          const totalMin = durs.reduce((a,b)=>a+b,0);
          return totalMin > 0 ? durs.length / (totalMin/60) : 0;
        }
        case 'openRate':
          return r.count > 0 ? ((r[openField] || 0) / r.count) * 100 : 0;
        case 'fixRate': {
          const fi = r._fi || 0; return r.count > 0 ? (fi/r.count)*100 : 0;
        }
        case 'kbRate': {
          const kb = r._kb || 0; return r.count > 0 ? (kb/r.count)*100 : 0;
        }
        default:
          return typeof raw === 'number' ? Math.round(raw * 100) / 100 : raw;
      }
    }

    // Build canonical name map for worker groupBy relabeling.
    // r._id is now workerUserId (integer) or workerEmail (string fallback).
    // We resolve it to a display name using backfill_users as source of truth.
    let canonWorkerById = null;   // v1Id (string) → name
    let canonWorkerByEmail = null; // email → name
    if (groupBy === 'worker' && source !== 'qc') {
      const bfUsers = await db.collection('backfill_users')
        .find({}, { projection:{ v1Id:1, email:1, fullName:1 } }).toArray();
      canonWorkerById = {};
      canonWorkerByEmail = {};
      bfUsers.forEach(u => {
        if (u.v1Id && u.fullName)  canonWorkerById[String(u.v1Id)]  = u.fullName;
        if (u.email && u.fullName) canonWorkerByEmail[u.email.toLowerCase()] = u.fullName;
      });
      // Fallback: most-frequent name per uid/email from segments
      const segNames = await db.collection('backfill_kpi_segments').aggregate([
        { $match: { workerName: { $ne:null } } },
        { $group: { _id:{ uid:'$workerUserId', email:'$workerEmail', name:'$workerName' }, cnt:{ $sum:1 } } },
        { $sort: { cnt:-1 } },
        { $group: { _id:{ uid:'$_id.uid', email:'$_id.email' }, name:{ $first:'$_id.name' } } }
      ]).toArray();
      segNames.forEach(s => {
        const uid = s._id.uid ? String(s._id.uid) : null;
        const em  = s._id.email ? s._id.email.toLowerCase() : null;
        if (uid && !canonWorkerById[uid])   canonWorkerById[uid]  = s.name;
        if (em  && !canonWorkerByEmail[em]) canonWorkerByEmail[em] = s.name;
      });
    }

    results = results.map(r => {
      const value     = postProcess(r, metric,          'value',      '_durations',    '_openCount');
      const secondary = secondaryMetric
        ? postProcess(r, secondaryMetric, 'secondary',  '_secDurations', '_openCount')
        : undefined;
      // Relabel: r._id is workerUserId (number/string) or workerEmail (string)
      let label = r._id != null ? String(r._id) : '(blank)';
      if (groupBy === 'worker' && source !== 'qc' && (canonWorkerById || canonWorkerByEmail)) {
        const rawId = r._id;
        // If it looks like an integer it's a workerUserId
        if (rawId != null && /^\d+$/.test(String(rawId))) {
          label = canonWorkerById?.[String(rawId)] || String(rawId);
        } else {
          // It's an email (fallback for segments without workerUserId)
          const em = (rawId || '').toString().toLowerCase();
          label = canonWorkerByEmail?.[em] || canonWorkerById?.[em] || rawId || '(blank)';
        }
      }
      return {
        label,
        value:     typeof value === 'number' ? Math.round(value * 10000) / 10000 : (value ?? 0),
        secondary: secondary != null ? (typeof secondary === 'number' ? Math.round(secondary * 10000)/10000 : secondary) : undefined,
        count:     r.count
      };
    });

    // ── Sort ────────────────────────────────────────────────
    switch (sortBy || 'value_desc') {
      case 'value_asc':  results.sort((a,b)=>a.value-b.value); break;
      case 'value_desc': results.sort((a,b)=>b.value-a.value); break;
      case 'label_asc':  results.sort((a,b)=>String(a.label).localeCompare(String(b.label))); break;
      case 'label_desc': results.sort((a,b)=>String(b.label).localeCompare(String(a.label))); break;
      case 'count_desc': results.sort((a,b)=>b.count-a.count); break;
    }

    const totalDocs = await col.countDocuments(match);

    res.json({
      source, metric, secondaryMetric, groupBy, filters,
      totalMatched: totalDocs,
      resultCount: results.length,
      results
    });
  } catch (err) {
    console.error('Report query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— GET /reports/filters — Available filter values ——————
app.get('/reports/filters', async (req, res) => {
  try {
    const db = await getConfigDb();
    const [workers, statuses, departments, errorTypes, issues, kpiDepts] = await Promise.all([
      db.collection('backfill_kpi_segments').distinct('workerEmail'),
      db.collection('backfill_kpi_segments').distinct('statusSlug'),
      db.collection('backfill_qc_events').distinct('departmentName'),
      db.collection('backfill_qc_events').distinct('errorType'),
      db.collection('backfill_qc_events').distinct('issueName'),
      db.collection('backfill_kpi_segments').distinct('departmentName'),
    ]);

    // Build worker list keyed by workerUserId (stable V1 MySQL integer ID).
    // Falls back to workerEmail for segments where workerUserId is null.
    // Name comes from backfill_users (HR source of truth) → most-frequent segment name.
    //
    // Using workerUserId as the key means:
    // - Same person with different email variants is one entry
    // - Name changes / typos don't create duplicate entries
    // - Report filter values are stable integers, not mutable strings

    // Step 1: canonical name + email from backfill_users, keyed by v1Id
    const userByV1Id = {};  // v1Id → { name, email }
    const userByEmail = {}; // email → { name, v1Id }
    const bfUsers = await db.collection('backfill_users')
      .find({}, { projection: { v1Id:1, email:1, fullName:1 } }).toArray();
    bfUsers.forEach(u => {
      const v1 = u.v1Id ? String(u.v1Id) : null;
      const em = u.email ? u.email.toLowerCase() : null;
      if (v1 && u.fullName) userByV1Id[v1] = { name: u.fullName, email: em };
      if (em && u.fullName) userByEmail[em] = { name: u.fullName, v1Id: v1 };
    });

    // Step 2: aggregate distinct (workerUserId, workerEmail, most-frequent workerName)
    // from segments to get a deduplicated worker list
    const workerDocs = await db.collection('backfill_kpi_segments')
      .aggregate([
        { $match: { $or: [{ workerUserId: { $ne: null } }, { workerEmail: { $ne: null } }] } },
        { $group: {
            _id: { uid: '$workerUserId', email: '$workerEmail' },
            nameCount: { $push: '$workerName' },
            segCount: { $sum: 1 }
        }},
        { $sort: { segCount: -1 } }
      ]).toArray();

    // Step 3: build deduplicated worker list keyed by workerUserId (or email fallback)
    const workerMap = {}; // key → { id, email, name, segCount }
    for (const w of workerDocs) {
      const uid   = w._id.uid ? String(w._id.uid) : null;
      const email = w._id.email ? w._id.email.toLowerCase() : null;
      const key   = uid || email || 'unknown';

      // Canonical name: backfill_users first, then most-frequent from segments
      let name = (uid && userByV1Id[uid]?.name)
               || (email && userByEmail[email]?.name)
               || null;
      if (!name) {
        // most-frequent name from pushed array
        const freq = {};
        for (const n of w.nameCount) if (n) freq[n] = (freq[n]||0)+1;
        name = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0]?.[0] || key;
      }

      const canonEmail = (uid && userByV1Id[uid]?.email) || email || '';

      if (!workerMap[key] || w.segCount > workerMap[key].segCount) {
        workerMap[key] = { id: key, uid, email: canonEmail, name, segCount: w.segCount };
      }
    }

    const workerNames = {}; // kept for status names below - not used for workers anymore

    // Status name map
    const statusNames = {};
    const statusDocs = await db.collection('backfill_kpi_segments')
      .aggregate([
        { $match: { statusSlug: { $ne: null } } },
        { $group: { _id: '$statusSlug', name: { $first: '$statusName' } } }
      ]).toArray();
    statusDocs.forEach(s => { statusNames[s._id] = s.name; });

    res.json({
      workers: Object.values(workerMap)
        .map(w => ({ id: w.id, uid: w.uid, email: w.email, name: w.name }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
      statuses: statuses.filter(Boolean).map(s => ({ slug: s, name: statusNames[s] || s })).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
      departments: [...new Set([...departments, ...kpiDepts])].filter(Boolean).sort(),
      errorTypes: errorTypes.filter(Boolean).sort(),
      issues: issues.filter(Boolean).sort(),
      orderTypes: ['evaluation', 'translation']
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /reports/export — CSV export of report results ————
app.post('/reports/export', async (req, res) => {
  try {
    const { source, metric, secondaryMetric, groupBy, filters, sortBy, limit } = req.body;
    const db = await getConfigDb();
    const colName = source === 'qc' ? 'backfill_qc_events' : 'backfill_kpi_segments';
    const col = db.collection(colName);
    const dateField = source === 'qc' ? 'qcCreatedAt' : 'segmentStart';

    // Same match logic as /reports/query
    const match = {};
    if (filters) {
      if (filters.dateFrom) match[dateField] = { ...match[dateField], $gte: filters.dateFrom };
      if (filters.dateTo)   match[dateField] = { ...match[dateField], $lte: filters.dateTo + 'T23:59:59' };
      if (filters.workers?.length) {
        const uids   = filters.workers.filter(w => /^\d+$/.test(String(w))).map(Number);
        const emails = filters.workers.filter(w => !/^\d+$/.test(String(w)));
        const workerClauses = [];
        if (uids.length)   workerClauses.push({ workerUserId: { $in: uids } });
        if (emails.length) workerClauses.push({ workerEmail: { $in: emails } });
        if (workerClauses.length === 1) Object.assign(match, workerClauses[0]);
        else if (workerClauses.length > 1) match.$or = [...(match.$or||[]), ...workerClauses];
      }
      if (filters.statuses?.length)    match.statusSlug     = { $in: filters.statuses };
      if (filters.orderType)           match.orderType      = filters.orderType;
      if (filters.departments?.length) match.departmentName = { $in: filters.departments };
      if (filters.errorTypes?.length)  match.errorType      = { $in: filters.errorTypes };
      if (filters.issues?.length)      match.issueName      = { $in: filters.issues };
      if (filters.excludeOpen)         match.isOpen         = { $ne: true };
    }

    // If no groupBy/metric, export raw matching docs (up to 50k)
    if (!groupBy || !metric) {
      const docs = await col.find(match).sort({ [dateField]: -1 }).limit(50000).toArray();
      if (!docs.length) return res.status(404).json({ error: 'No data found' });
      const keys = Object.keys(docs[0]).filter(k => !k.startsWith('_'));
      const esc = v => { if (v==null) return ''; const s=String(v); return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}"`  :s; };
      const csv = [keys.join(','), ...docs.map(d => keys.map(k => esc(d[k])).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="iee-${source}-raw-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    // Export the aggregated report — re-run the query and format as CSV
    const internalReq = { body: req.body, user: req.user };
    const rows = await new Promise((resolve, reject) => {
      const mockRes = {
        json: d => resolve(d),
        status: () => ({ json: e => reject(new Error(e.error)) })
      };
      // Re-use query logic by calling the handler directly via internalFetch
      internalFetch(`/reports/query`, { method:'POST', body: JSON.stringify(req.body) })
        .then(resolve).catch(reject);
    });

    const results = rows.results || [];
    if (!results.length) return res.status(404).json({ error: 'No data found' });

    const headers = ['Rank', 'Group', metric, secondaryMetric||null, 'Record Count'].filter(Boolean);
    const csvRows = results.map((r, i) => {
      const vals = [i+1, r.label, r.value, secondaryMetric?r.secondary:null, r.count].filter((_,j) => headers[j] != null);
      return vals.map(v => { if (v==null)return''; const s=String(v); return s.includes(',')||s.includes('"')?`"${s.replace(/"/g,'""')}"`  :s; }).join(',');
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="iee-report-${source}-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send([headers.join(','), ...csvRows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/forecast/arrivals — Arrival heatmap ───────────
// Returns hourly order arrival counts by day-of-week.
// Powers the demand curve in the staffing forecast page.
app.get('/data/forecast/arrivals', async (req, res) => {
  try {
    const db = await getConfigDb();
    const dept = req.query.dept || ''; // optional department filter

    // Get distinct departments from turnaround collection (more reliable than arrivals
    // which may not have dept field if heatmap was built before enrichment ran)
    const allDepts = await db.collection('backfill_order_turnaround')
      .distinct('departmentName').then(d => d.filter(Boolean).sort()).catch(() => []);

    const filter = dept ? { dept } : {};
    // Aggregate across all dept slots for the selected dept (or all)
    const rawSlots = await db.collection('backfill_order_arrivals').find(filter).toArray();

    // Collapse to dow-hour (sum counts across matching dept slots)
    const slotMap = {};
    for (const s of rawSlots) {
      const key = `${s.dow}-${s.hour}`;
      if (!slotMap[key]) slotMap[key] = { dow:s.dow, hour:s.hour, count:0, evaluation:0, translation:0, urgent:0 };
      slotMap[key].count       += s.count||0;
      slotMap[key].evaluation  += s.evaluation||0;
      slotMap[key].translation += s.translation||0;
      slotMap[key].urgent      += s.urgent||0;
    }
    const slots = Object.values(slotMap);

    // Also return weekly totals and recent trend from turnaround collection
    const now = new Date();
    const d30 = new Date(now - 30 * 86400000);
    const d90 = new Date(now - 90 * 86400000);

    const [weeklyTrend, slaStats] = await Promise.all([
      // Weekly order count for last 12 weeks
      db.collection('backfill_order_turnaround').aggregate([
        { $match: { createdAt: { $gte: d90 } } },
        { $group: {
            _id: { $dateToString: { format:'%G-W%V', date:'$createdAt' } },
            count: { $sum: 1 }, evaluation: { $sum: { $cond:[{ $eq:['$orderType','evaluation'] },1,0] } },
            translation: { $sum: { $cond:[{ $eq:['$orderType','translation'] },1,0] } },
        }},
        { $sort: { _id: 1 } }
      ]).toArray(),

      // SLA stats by processTimeSlug (standard/rush) over last 90 days
      db.collection('backfill_order_turnaround').aggregate([
        { $match: { createdAt: { $gte: d90 }, isCompleted: true, turnaroundHrs:{ $gt:0, $lt:2000 } } },
        { $group: {
            _id: { processTimeSlug: '$processTimeSlug', orderType: '$orderType' },
            count: { $sum: 1 }, avgHrs: { $avg: '$turnaroundHrs' },
            latePct: { $avg: { $cond:['$isLate',1,0] } },
            hrs: { $firstN:{ input:'$turnaroundHrs', n:2000 } } // capped for scale
        }},
        { $project: { _id:0, processTimeSlug:'$_id.processTimeSlug', orderType:'$_id.orderType',
            count:1, avgHrs:{ $round:['$avgHrs',1] }, latePct:{ $round:[{ $multiply:['$latePct',100] },1] }, hrs:1 }}
      ]).toArray().then(rows => rows.map(r => {
        const s = (r.hrs||[]).sort((a,b)=>a-b);
        const p = (pct) => s.length ? Math.round((s[Math.floor(s.length*pct)]||s[s.length-1])*10)/10 : null;
        return { ...r, hrs:undefined, p50Hrs:p(0.5), p75Hrs:p(0.75), p90Hrs:p(0.9) };
      }))
    ]);

    // Compute data span in weeks from turnaround collection
    const [earliestArr, latestArr] = await Promise.all([
      db.collection('backfill_order_turnaround').findOne(
        dept ? { departmentName:dept } : {},
        { sort:{ createdAt:1 }, projection:{ createdAt:1 } }
      ),
      db.collection('backfill_order_turnaround').findOne(
        dept ? { departmentName:dept } : {},
        { sort:{ createdAt:-1 }, projection:{ createdAt:1 } }
      ),
    ]);
    const spanDays = earliestArr?.createdAt && latestArr?.createdAt
      ? Math.max(1, Math.round((new Date(latestArr.createdAt) - new Date(earliestArr.createdAt)) / 86400000))
      : 7;
    const dataSpanWeeks = Math.max(1, Math.round(spanDays / 7 * 10) / 10);

    res.json({ slots, weeklyTrend, slaStats, departments: allDepts, activeDept: dept,
               dataSpanWeeks, dataSpanDays: spanDays });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/forecast/staffing — Staffing model ─────────────
// Combines arrival demand + XpH from segments to recommend staff per hour/day.
app.get('/data/forecast/staffing', async (req, res) => {
  try {
    const db = await getConfigDb();
    const dept = req.query.dept || '';
    const deptFilter = dept ? { departmentName: dept } : {};
    // Hard timeout — prevents Railway 503 on slow aggregations
    res.setTimeout(25000, () => {
      if (!res.headersSent) res.status(503).json({ error: 'Staffing forecast timed out — try again in a moment.' });
    });

    // Arrival heatmap — filter by dept if specified, collapse to dow-hour
    let rawArrivals = await db.collection('backfill_order_arrivals').find(dept ? { dept } : {}).toArray();
    let arrivalsDeptNote = null;
    // If dept filter returns no results, the heatmap may not have dept field yet
    // (requires backfill enrichment to run). Fall back to system-wide with a warning.
    if (dept && rawArrivals.length === 0) {
      rawArrivals = await db.collection('backfill_order_arrivals').find({}).toArray();
      arrivalsDeptNote = `WARNING: No dept-filtered arrival data for "${dept}" yet — showing system-wide demand. Run a full backfill to populate department-level heatmap data.`;
    }
    const slotMap = {};
    for (const s of rawArrivals) {
      const key = `${s.dow}-${s.hour}`;
      if (!slotMap[key]) slotMap[key] = { dow:s.dow, hour:s.hour, count:0 };
      slotMap[key].count += s.count||0;
    }
    const arrivals = Object.values(slotMap);

    // XpH per status from segments (last 60 days) — filter by dept if specified
    const cutoff60 = new Date(Date.now() - 60 * 86400000);
    const segMatch = { isOpen:false, segmentStart:{ $gte:cutoff60.toISOString() }, durationMinutes:{ $gt:0 } };
    if (dept) segMatch.departmentName = dept;
    // Fetch benchmarks to resolve xphUnit per status
    const benchmarkDocs = await db.collection('dashboard_benchmarks').find({}, { projection:{ status:1, xphUnit:1 } }).toArray();
    const xphUnitBySlug = {};
    for (const b of benchmarkDocs) if (b.status) xphUnitBySlug[b.status] = b.xphUnit || 'Orders';

    const xphByStatusRaw = await db.collection('backfill_kpi_segments').aggregate([
      { $match: segMatch },
      { $group: {
          _id: '$statusSlug',
          statusName: { $first:'$statusName' },
          segments: { $sum:1 },
          totalMin: { $sum:'$durationMinutes' },
          // Accumulate all three unit types — we pick the right one post-query
          orderUnits:      { $sum: 1 },
          credentialUnits: { $sum: { $ifNull:['$credentialCount', 0] } },
          reportUnits:     { $sum: { $ifNull:['$reportItemCount', 0] } },
      }},
      { $sort: { segments:-1 } }
    ]).toArray();

    const xphByStatus = xphByStatusRaw.map(r => {
      const unit = xphUnitBySlug[r._id] || 'Orders';
      const unitSum = unit === 'Credentials' ? r.credentialUnits
                    : unit === 'Reports'      ? r.reportUnits
                    : r.orderUnits;
      const xph = r.totalMin > 0 ? Math.round(unitSum / (r.totalMin / 60) * 100) / 100 : 0;
      const avgDurMin = r.segments > 0 ? Math.round(r.totalMin / r.segments * 10) / 10 : 0;
      return { statusSlug: r._id, statusName: r.statusName, segments: r.segments,
               xph, avgDurMin, xphUnit: unit };
    });

    // Status wait times (avg minutes waiting per status)
    const waitByStatus = await db.collection('backfill_order_turnaround').aggregate([
      { $match: { createdAt:{ $gte:cutoff60 } } },
      { $project: { sw:{ $objectToArray:'$statusWaits' } } },
      { $unwind:'$sw' },
      { $group: { _id:'$sw.k', avgWaitMin:{ $avg:'$sw.v' }, count:{ $sum:1 } } },
      { $project: { _id:0, statusSlug:'$_id', avgWaitMin:{ $round:['$avgWaitMin',0] }, count:1 } }
    ]).toArray();

    // Peak hours: find top 3 hour windows
    const totalByHour = Array(24).fill(0);
    for (const s of arrivals) totalByHour[s.hour] = (totalByHour[s.hour]||0) + s.count;
    const maxHourVol = Math.max(...totalByHour, 1);

    // Model metadata + totalOrders — run together so earliestDoc is available for avgPerDay calc
    const [earliestDoc, latestDoc, totalSegments, totalOrders] = await Promise.all([
      db.collection('backfill_order_turnaround').findOne(
        { createdAt:{ $exists:true }, ...deptFilter },
        { sort:{ createdAt:1 }, projection:{ createdAt:1 } }
      ),
      db.collection('backfill_order_turnaround').findOne(
        { createdAt:{ $exists:true }, ...deptFilter },
        { sort:{ createdAt:-1 }, projection:{ createdAt:1 } }
      ),
      db.collection('backfill_kpi_segments').countDocuments(
        dept ? { departmentName:dept, isOpen:false, segmentStart:{ $gte:cutoff60.toISOString() } }
             : { isOpen:false, segmentStart:{ $gte:cutoff60.toISOString() } }
      ),
      db.collection('backfill_order_turnaround').countDocuments(deptFilter),
    ]);

    // avgPerDay: divide total by actual data span since GO_LIVE (not hardcoded 180)
    const GO_LIVE = new Date('2026-02-07T00:00:00.000Z');
    const spanStart = earliestDoc?.createdAt
      ? new Date(Math.max(new Date(earliestDoc.createdAt).getTime(), GO_LIVE.getTime()))
      : GO_LIVE;
    const spanDaysActual = Math.max(1, Math.round((Date.now() - spanStart.getTime()) / 86400000));
    const avgPerDay = Math.round(totalOrders / spanDaysActual * 10) / 10;

    const earliestDate = earliestDoc?.createdAt || null;
    const latestDate   = latestDoc?.createdAt   || null;
    const dataSpanDays = earliestDate && latestDate
      ? Math.round((new Date(latestDate) - new Date(earliestDate)) / 86400000)
      : 0;
    const dataSpanWeeks = Math.round(dataSpanDays / 7 * 10) / 10;

    // Get departments from backfill_order_turnaround
    const departments = await db.collection('backfill_order_turnaround')
      .distinct('departmentName')
      .then(d => d.filter(Boolean).sort())
      .catch(() => []);

    // Per-DOW sample counts — how many distinct calendar days exist for each day-of-week
    // Single aggregation instead of 7 separate queries — avoids 7x full collection scans
    const totalByDow = [0,1,2,3,4,5,6].map(d =>
      arrivals.filter(s => s.dow === d).reduce((a,s) => a + s.count, 0)
    );
    const dowWeekDocs = await db.collection('backfill_order_turnaround').aggregate([
      { $match: { createdAt: { $exists: true }, ...deptFilter } },
      { $group: {
          _id: {
            dow: { $subtract: [{ $dayOfWeek: '$createdAt' }, 1] },
            week: { $dateToString: { format: '%G-W%V', date: '$createdAt' } }
          }
      }},
      { $group: { _id: '$_id.dow', weeks: { $sum: 1 } } }
    ]).toArray();
    const dowWeekMap = {};
    for (const d of dowWeekDocs) dowWeekMap[d._id] = d.weeks;
    const dowSampleWeeks = [0,1,2,3,4,5,6].map(d => dowWeekMap[d] || 0);

    const modelMeta = {
      earliestDate,
      latestDate,
      dataSpanDays,
      dataSpanWeeks,
      totalSegmentsForXph: totalSegments,
      dowSampleWeeks,  // [sun,mon,tue,wed,thu,fri,sat] — weeks of data per day
      xphSampleSize: xphByStatus.reduce((a,s) => a + s.segments, 0),
      activeDept: dept || null,
      generatedAt: new Date(),
    };

    res.json({
      arrivals,           // heatmap slots
      arrivalsDeptNote,   // null or warning if dept filter fell back to system-wide
      xphByStatus,        // throughput per status
      waitByStatus,       // avg wait per status queue
      totalByHour,
      totalByDow,
      totalOrders,
      avgPerDay,
      spanDaysActual,     // real data span used for avgPerDay denominator
      maxHourVol,
      departments,        // available departments for filter dropdown
      modelMeta,          // transparency data for the confidence panel
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— GET /data/forecast/sla-analysis — SLA recommendations ────
// Analyses actual turnaround distributions and recommends SLA targets.
app.get('/data/forecast/sla-analysis', async (req, res) => {
  try {
    const db = await getConfigDb();
    const d180 = new Date(Date.now() - 180 * 86400000);
    const dept = req.query.dept || '';
    const deptMatch = dept ? { departmentName: dept } : {};

    const [byTypeRaw, byStatusRaw, bottlenecksRaw, departments, dailyTrend] = await Promise.all([

      // Turnaround distribution by report type + process time
      db.collection('backfill_order_turnaround').aggregate([
        { $match: { isCompleted:true, createdAt:{ $gte:d180 }, turnaroundHrs:{ $gt:0, $lt:2000 }, ...deptMatch } },
        { $group: {
            _id: { reportItemName:{ $ifNull:['$reportItemName','(unknown)'] }, processTimeSlug:'$processTimeSlug' },
            count:    { $sum:1 }, avgHrs:{ $avg:'$turnaroundHrs' },
            latePct:  { $avg:{ $cond:['$isLate',1,0] } },
            avgDaysLate: { $avg:{ $cond:['$isLate','$daysLate',null] } },
            hrs: { $firstN: { input:'$turnaroundHrs', n:2000 } }
        }},
        { $project: { _id:0, reportItemName:'$_id.reportItemName', processTimeSlug:'$_id.processTimeSlug',
            count:1, avgHrs:{ $round:['$avgHrs',1] },
            latePct:{ $round:[{ $multiply:['$latePct',100] },1] },
            avgDaysLate:{ $round:['$avgDaysLate',1] }, hrs:1 }}
      ]).toArray().then(rows => rows.map(r => {
        const s = (r.hrs||[]).sort((a,b)=>a-b);
        const p = (pct) => s.length ? Math.round((s[Math.floor(s.length*pct)]||s[s.length-1])*10)/10 : null;
        return { ...r, hrs:undefined, p50Hrs:p(0.5), p75Hrs:p(0.75), p90Hrs:p(0.9), p95Hrs:p(0.95) };
      })),

      // Wait time per status (where is queue time being spent?)
      db.collection('backfill_order_turnaround').aggregate([
        { $match: { createdAt:{ $gte:d180 } } },
        { $project:{ sw:{ $objectToArray:'$statusWaits' }, orderType:1 } },
        { $unwind:'$sw' },
        { $group:{ _id:'$sw.k',
            avgWaitMin:{ $avg:'$sw.v' }, maxWaitMin:{ $max:'$sw.v' },
            count:{ $sum:1 },
            vals:{ $firstN:{ input:'$sw.v', n:2000 } } // capped for scale
        }},
        { $project:{ _id:0, statusSlug:'$_id',
            avgWaitMin:{ $round:['$avgWaitMin',0] },
            maxWaitMin:{ $round:['$maxWaitMin',0] },
            count:1, vals:1
        }},
        { $sort:{ avgWaitMin:-1 } }
      ]).toArray(),

      // Bottleneck detection: statuses where P75 wait > 24h (1440 min)
      db.collection('backfill_order_turnaround').aggregate([
        { $match:{ createdAt:{ $gte:d180 }, ...deptMatch } },
        { $project:{ sw:{ $objectToArray:'$statusWaits' } } },
        { $unwind:'$sw' },
        { $match:{ 'sw.v':{ $gt:60 } } }, // >1 hour waits only
        { $group:{ _id:'$sw.k',
            avgWaitHrs:{ $avg:{ $divide:['$sw.v',60] } },
            count:{ $sum:1 },
            vals:{ $firstN:{ input:{ $divide:['$sw.v',60] }, n:2000 } } // capped for scale
        }},
        { $project:{ _id:0, statusSlug:'$_id',
            avgWaitHrs:{ $round:['$avgWaitHrs',1] },
            count:1, vals:1
        }},
        { $sort:{ p75Hrs:-1 } }
      ]).toArray(),

      // Available departments
      db.collection('backfill_order_turnaround').distinct('departmentName'),

      // Daily order volume trend (last 90 days)
      db.collection('backfill_order_turnaround').aggregate([
        { $match:{ createdAt:{ $gte: new Date(Date.now() - 90*86400000) }, ...deptMatch } },
        { $group:{
            _id:{ $dateToString:{ format:'%Y-%m-%d', date:'$createdAt' } },
            count:{ $sum:1 },
            evaluation:{ $sum:{ $cond:[{ $eq:['$orderType','evaluation'] },1,0] } },
            translation:{ $sum:{ $cond:[{ $eq:['$orderType','translation'] },1,0] } },
        }},
        { $sort:{ _id:1 } }
      ]).toArray()
    ]);

    // Compute p75 for bottlenecks in JS and filter
    const bottlenecks = (bottlenecksRaw||[]).map(r => {
      const s = (r.vals||[]).sort((a,b)=>a-b);
      const p75Hrs = s.length ? Math.round((s[Math.floor(s.length*0.75)]||s[s.length-1])*10)/10 : 0;
      return { ...r, vals:undefined, p75Hrs };
    }).filter(r => r.p75Hrs > 4).sort((a,b)=>b.p75Hrs-a.p75Hrs);

    const byType = byTypeRaw;
    const byStatus = byStatusRaw;

    // Compute SLA recommendations:
    // Recommend P75 turnaround + 20% buffer, rounded to nearest half-day
    const recommendations = byType.map(r => {
      const baseHrs   = r.p75Hrs || r.avgHrs || 72;
      const targetHrs = Math.ceil(baseHrs * 1.2 / 12) * 12; // round up to nearest 12h
      const targetDays= Math.round(targetHrs / 24 * 2) / 2;  // nearest 0.5 day
      return {
        ...r,
        recommendedSlaHrs:  targetHrs,
        recommendedSlaDays: targetDays,
        currentLatePct:     r.latePct,
        // "on track" if latePct < 10% at P90
        status: r.latePct < 10 ? 'on-track' : r.latePct < 25 ? 'at-risk' : 'breaching',
      };
    });

    // Compute p75 for byStatus in JS (avoids $percentile MongoDB 7+ requirement)
    const byStatusFinal = (byStatus||[]).map(r => {
      const s = (r.vals||[]).sort((a,b)=>a-b);
      const p75Min = s.length ? Math.round(s[Math.floor(s.length*0.75)]||s[s.length-1]) : null;
      return { ...r, vals:undefined, p75Min };
    });

    res.json({ byType, byStatus:byStatusFinal, bottlenecks, dailyTrend, recommendations, departments: (departments||[]).filter(Boolean).sort(), activeDept: dept });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— AI Conversation history (per-user) ──────────────────────
app.get('/ai/conversations', async (req, res) => {
  try {
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Auth required' });
    const convos = await db.collection('dashboard_ai_conversations')
      .find({ userId }).sort({ updatedAt: -1 }).limit(50)
      .project({ title:1, createdAt:1, updatedAt:1, messageCount:1, preview:1 }).toArray();
    res.json({ count: convos.length, conversations: convos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/ai/conversations/:id', async (req, res) => {
  try {
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email;
    const convo = await db.collection('dashboard_ai_conversations').findOne({ _id: new ObjectId(req.params.id), userId });
    if (!convo) return res.status(404).json({ error: 'Not found' });
    res.json(convo);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/ai/conversations', async (req, res) => {
  try {
    const { title, messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Auth required' });
    const preview = messages.find(m=>m.role==='user')?.content?.substring(0,100)||'';
    const doc = { userId, title:title||preview.substring(0,60)||'New conversation', messages, preview, messageCount:messages.length, createdAt:new Date(), updatedAt:new Date() };
    const result = await db.collection('dashboard_ai_conversations').insertOne(doc);

    // Cap at 100 conversations per user — prune oldest beyond the limit.
    // This prevents unbounded growth for power users over months.
    // 100 conversations ≈ ~3 months of daily use at 1/day.
    const totalConvos = await db.collection('dashboard_ai_conversations').countDocuments({ userId });
    if (totalConvos > 100) {
      const oldest = await db.collection('dashboard_ai_conversations')
        .find({ userId }, { projection:{ _id:1 } })
        .sort({ updatedAt: 1 })
        .limit(totalConvos - 100)
        .toArray();
      if (oldest.length > 0) {
        await db.collection('dashboard_ai_conversations').deleteMany({
          _id: { $in: oldest.map(o => o._id) }
        });
      }
    }

    res.json({ success:true, id:result.insertedId, conversation:doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/ai/conversations/:id', async (req, res) => {
  try {
    const { title, messages } = req.body;
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email;
    const preview = messages?.find(m=>m.role==='user')?.content?.substring(0,100)||'';
    await db.collection('dashboard_ai_conversations').updateOne(
      { _id:new ObjectId(req.params.id), userId },
      { $set:{ ...(title&&{title}), ...(messages&&{messages,messageCount:messages.length,preview}), updatedAt:new Date() } }
    );
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/ai/conversations/:id', async (req, res) => {
  try {
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email;
    await db.collection('dashboard_ai_conversations').deleteOne({ _id:new ObjectId(req.params.id), userId });
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// —— Saved Reports CRUD ————————————————————————————————
app.get('/reports/saved', async (req, res) => {
  try {
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email || null;
    // Return only this user's reports. Legacy reports without userId shown to all.
    const filter = userId
      ? { $or: [{ userId }, { userId: { $exists: false } }] }
      : {};
    const reports = await db.collection('dashboard_saved_reports')
      .find(filter).sort({ updatedAt: -1 }).toArray();
    res.json({ count: reports.length, reports });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/reports/saved', async (req, res) => {
  try {
    const { name, config } = req.body;
    if (!name || !config) return res.status(400).json({ error: 'name and config required' });
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email || null;
    const doc = { name, config, userId, createdBy: req.user?.name || 'unknown', createdAt: new Date(), updatedAt: new Date() };
    const result = await db.collection('dashboard_saved_reports').insertOne(doc);
    res.json({ success: true, id: result.insertedId, report: doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/reports/saved/:id', async (req, res) => {
  try {
    const db = await getConfigDb();
    const userId = req.user?.id || req.user?._id || req.user?.email || null;
    // Only allow deleting own reports (or legacy reports without userId)
    const filter = { _id: new ObjectId(req.params.id) };
    if (userId) filter.$or = [{ userId }, { userId: { $exists: false } }];
    await db.collection('dashboard_saved_reports').deleteOne(filter);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// USER LAYOUT PREFERENCES — Persist dashboard grid layouts
// ═══════════════════════════════════════════════════════════

app.get('/user/layout/:page', async (req, res) => {
  try {
    const db = await getConfigDb();
    const layout = await db.collection('dashboard_user_layouts').findOne({
      userId: req.user?.userId || req.user?.email,
      page: req.params.page
    });
    res.json({ layout: layout?.layout || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/user/layout/:page', async (req, res) => {
  try {
    const { layout } = req.body;
    if (!layout) return res.status(400).json({ error: 'layout required' });
    const db = await getConfigDb();
    await db.collection('dashboard_user_layouts').updateOne(
      { userId: req.user?.userId || req.user?.email, page: req.params.page },
      { $set: { layout, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// STATIC FILE SERVING — React dashboard (MUST be after ALL API routes)
// ═══════════════════════════════════════════════════════════
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
// SPA fallback: any GET not matched by an API route serves the React app
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});


// —— 404 / Error handlers —————————————————————————————
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: [
      '/health', '/collections',
      '/kpi-segments', '/kpi-classify', '/credential-counts', '/report-counts',
      '/qc-events', '/qc-orders', '/qc-summary', '/qc-discovery',
      '/queue-wait-summary', '/queue-snapshot',
      '/config/benchmarks', '/config/production-hours',
      '/config/user-levels', '/config/audit-log',
      '/auth/login', '/auth/setup', '/auth/me', '/auth/users',
      '/ai/chat', '/ai/system-prompt', '/ai/guardrails',
      '/glossary', '/email/schedules', '/email/send-now',
      '/backfill/run', '/backfill/status', '/backfill/settings', '/backfill/history',
      '/data/kpi-segments', '/data/qc-events', '/data/users',
      '/data/order',
      '/ai/conversations',
      '/reports/query', '/reports/filters', '/reports/export', '/reports/saved',
      '/user/layout/:page',
      '/users', '/indexes'
    ]
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// —— Start ——————————————————————————————————————————————
const _httpServer = app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`IEE KPI Data API v5.0 running on port ${CONFIG.PORT}`);
  console.log(`Environment: ${CONFIG.NODE_ENV}`);
  console.log(`Rate limit: 60 requests/minute`);
  console.log(`IP allowlist: ${CONFIG.ALLOWED_IPS || 'disabled (all IPs allowed)'}`);
  // Start cron scheduler for automated emails
  if (CONFIG.SENDGRID_API_KEY) { startCronScheduler(); }
  else { console.log('SendGrid not configured — email scheduler disabled'); }
  // Start backfill auto-scheduler
  startBackfillScheduler();

  // Ensure all indexes exist — runs once, idempotent
  setTimeout(() => ensureIndexes().catch(e => console.error('[STARTUP]', e.message)), 3000);

  // One-time migration: normalize workerEmail to lowercase in backfill_kpi_segments.
  // Mixed-case emails (e.g. "Camelo@myiee.org" vs "camelo@myiee.org") cause the same
  // person to appear as two separate workers in the dropdown.
  // This runs once at startup and self-disables after completion.
  setTimeout(async () => {
    try {
      const db = await getConfigDb();
      const col = db.collection('backfill_kpi_segments');
      const meta = db.collection('backfill_metadata');

      const migrationKey = 'email_lowercase_v1';
      const done = await meta.findOne({ _id: migrationKey });
      if (done) return; // already ran

      console.log('[MIGRATION] Normalizing workerEmail case in backfill_kpi_segments...');
      // Find all segments where email has uppercase chars
      const mixed = await col.find(
        { workerEmail: { $regex: '[A-Z]' } },
        { projection: { _id: 1, workerEmail: 1 } }
      ).toArray();

      if (mixed.length === 0) {
        console.log('[MIGRATION] No mixed-case emails found — done');
      } else {
        const ops = mixed.map(s => ({
          updateOne: {
            filter: { _id: s._id },
            update: { $set: { workerEmail: s.workerEmail.toLowerCase().trim() } }
          }
        }));
        for (let i = 0; i < ops.length; i += 2000) {
          await col.bulkWrite(ops.slice(i, i + 2000), { ordered: false });
        }
        console.log(`[MIGRATION] Normalized ${mixed.length} workerEmail values to lowercase`);
      }

      await meta.updateOne({ _id: migrationKey }, { $set: { _id: migrationKey, completedAt: new Date() } }, { upsert: true });
    } catch (e) {
      console.error('[MIGRATION] workerEmail normalize failed:', e.message);
    }
  }, 12000);

  // Migration 2: normalize workerName in backfill_kpi_segments using backfill_users
  // as the source of truth. Fixes "deana deana" style bad names from source system.
  // Groups segments by email, computes most-frequent name, cross-refs backfill_users.
  setTimeout(async () => {
    try {
      const db = await getConfigDb();
      const meta = db.collection('backfill_metadata');
      const migrationKey2 = 'workername_normalize_v1';
      const done2 = await meta.findOne({ _id: migrationKey2 });
      if (done2) return;

      console.log('[MIGRATION] Normalizing workerName from backfill_users...');

      // Build canonical name map from backfill_users
      const userDocs = await db.collection('backfill_users')
        .find({}, { projection:{email:1,fullName:1} }).toArray();
      const canonMap = {};
      userDocs.forEach(u => { if (u.email && u.fullName) canonMap[u.email.toLowerCase()] = u.fullName; });

      if (Object.keys(canonMap).length === 0) {
        console.log('[MIGRATION] backfill_users empty — skipping (will retry next boot)');
        return; // Don't mark done — retry next boot after user sync runs
      }

      // Find segments where workerEmail maps to a different canonical name
      const col = db.collection('backfill_kpi_segments');
      let updatedCount = 0;

      // Process in batches by email
      for (const [email, canonName] of Object.entries(canonMap)) {
        const result = await col.updateMany(
          { workerEmail: email, workerName: { $ne: canonName, $ne: null } },
          { $set: { workerName: canonName } }
        );
        updatedCount += result.modifiedCount || 0;
      }

      if (updatedCount > 0) {
        console.log(`[MIGRATION] Normalized ${updatedCount} segment workerName values`);
      } else {
        console.log('[MIGRATION] No workerName corrections needed');
      }

      await meta.updateOne({ _id: migrationKey2 }, { $set: { _id: migrationKey2, completedAt: new Date(), updated: updatedCount } }, { upsert: true });
    } catch (e) {
      console.error('[MIGRATION] workerName normalize failed:', e.message);
    }
  }, 15000); // 15s — after user sync completes // 12s after boot — after indexes are built

  // One-time startup: force a user sync so any stale backfill_users collection
  // (e.g. 150k docs from before the staff-only department filter) gets cleaned up
  // immediately on first boot instead of waiting for the next scheduled backfill.
  setTimeout(async () => {
    try {
      const configDb = await getConfigDb();
      const noop = (msg) => console.log(`[STARTUP-USERSYNC] ${msg}`);
      noop._forceUserSync = true;
      const result = await runUserSync(configDb, noop);
      if (!result.skipped) {
        console.log(`[STARTUP-USERSYNC] Complete — ${result.count} staff users in backfill_users`);
      }
    } catch (e) {
      console.error('[STARTUP-USERSYNC] Failed:', e.message);
    }
  }, 8000); // 8s after boot — let connections settle first
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Railway sends SIGTERM before killing the container. We drain in-flight requests
// (max 15s) then cleanly close MongoDB connections.
let _shuttingDown = false;
const server = app.listen; // reference captured below — overwritten at actual listen

function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received — draining requests (max 15s)`);

  // Stop accepting new connections
  if (_httpServer) {
    _httpServer.close(async () => {
      console.log('[SHUTDOWN] HTTP server closed');
      try {
        if (client)       await client.close();
        if (configClient) await configClient.close();
        console.log('[SHUTDOWN] MongoDB connections closed');
      } catch {}
      process.exit(0);
    });

    // Force exit after 15s if requests don't drain
    setTimeout(() => {
      console.error('[SHUTDOWN] Force exit after 15s timeout');
      process.exit(1);
    }, 15000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ═══════════════════════════════════════════════════════════
// CRON SCHEDULER — Automated email reports
// Checks every minute, sends based on schedule frequency.
// ═══════════════════════════════════════════════════════════

function startCronScheduler() {
  const CHECK_INTERVAL_MS = 60 * 1000; // every minute

  setInterval(async () => {
    try {
      const db = await getConfigDb();
      const schedules = await db.collection('dashboard_email_schedules')
        .find({ enabled: true }).toArray();

      const now = new Date();
      const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const hour = estNow.getHours();
      const minute = estNow.getMinutes();
      const dayOfWeek = estNow.getDay(); // 0=Sun, 1=Mon
      const dayOfMonth = estNow.getDate();

      // Only send at 7:00 AM EST (check within the minute window)
      if (hour !== 7 || minute !== 0) return;

      for (const schedule of schedules) {
        let shouldSend = false;
        const lastSent = schedule.lastSentAt ? new Date(schedule.lastSentAt) : null;
        const hoursSinceLast = lastSent ? (now - lastSent) / (1000 * 60 * 60) : Infinity;

        switch (schedule.frequency) {
          case 'daily':
            shouldSend = hoursSinceLast > 20; // at least 20hrs since last
            break;
          case 'weekly':
            shouldSend = dayOfWeek === 1 && hoursSinceLast > 144; // Monday, 6 days buffer
            break;
          case 'monthly':
            shouldSend = dayOfMonth === 1 && hoursSinceLast > 672; // 1st of month, 28 day buffer
            break;
        }

        if (!shouldSend) continue;

        console.log(`[CRON] Sending scheduled email: ${schedule.name}`);
        try {
          // Build report data
          const [queueData, qcData, kpiData] = await Promise.all([
            internalFetch('/queue-snapshot'),
            internalFetch('/qc-summary?days=1'),
            internalFetch('/kpi-segments?days=1&page=1&pageSize=2000')
          ]);

          const snapshot = queueData.snapshot || [];
          const waitingOrders = snapshot.filter(s => s.isWaitingStatus).reduce((a, s) => a + s.orderCount, 0);

          const templateData = {
            report_date: estNow.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
            total_active_orders: queueData.totalActiveOrders || 0,
            waiting_orders: waitingOrders,
            orders_over_24h: snapshot.filter(s => s.isWaitingStatus).reduce((a, s) => a + (s.over24h || 0), 0),
            orders_over_72h: snapshot.filter(s => s.isWaitingStatus).reduce((a, s) => a + (s.over72h || 0), 0),
            top_queues: snapshot.filter(s => s.isWaitingStatus).sort((a, b) => b.orderCount - a.orderCount).slice(0, 5)
              .map(s => ({ status: s.statusName, count: s.orderCount, median_hrs: (s.medianWaitHours || 0).toFixed(1) })),
            qc_events_today: qcData.totalEvents || 0,
            qc_fixed: (qcData.byErrorType || []).find(e => e.errorType === 'i_fixed_it')?.count || 0,
            qc_kickback: (qcData.byErrorType || []).find(e => e.errorType === 'kick_it_back')?.count || 0,
            kpi_segments_today: kpiData.totalCount || 0,
            dashboard_url: `https://iee-kpi-api-production.up.railway.app`
          };

          const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${CONFIG.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              personalizations: [{ to: schedule.recipients.map(e => ({ email: e })), dynamic_template_data: templateData }],
              from: { email: CONFIG.SENDGRID_FROM_EMAIL, name: 'IEE Ops Dashboard' },
              template_id: schedule.templateId || CONFIG.SENDGRID_TEMPLATE_ID
            })
          });

          if (sgRes.ok) {
            await db.collection('dashboard_email_schedules').updateOne(
              { _id: schedule._id }, { $set: { lastSentAt: now } }
            );
            console.log(`[CRON] Sent: ${schedule.name} → ${schedule.recipients.join(', ')}`);
          } else {
            console.error(`[CRON] SendGrid error for ${schedule.name}: ${sgRes.status}`);
          }
        } catch (err) {
          console.error(`[CRON] Failed to send ${schedule.name}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Scheduler error:', err.message);
    }
  }, CHECK_INTERVAL_MS);

  console.log('Email cron scheduler started (checks every 60s, sends at 7:00 AM EST)');
}


async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  try { if (client) { await client.close(); console.log('Production MongoDB closed.'); } } catch {}
  try { if (configClient) { await configClient.close(); console.log('Config MongoDB closed.'); } } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});