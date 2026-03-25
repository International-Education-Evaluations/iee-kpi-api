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
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL || 'ops@myiee.org',
  SETUP_SECRET: process.env.SETUP_SECRET || '',
  NODE_ENV: process.env.NODE_ENV || 'production'
};

if (!CONFIG.MONGO_URI) { console.error('FATAL: MONGO_URI required'); process.exit(1); }
if (!CONFIG.API_KEY) { console.error('FATAL: API_KEY required'); process.exit(1); }

// —— Security ————————————————————————————————————————————
app.use(helmet());
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
  if (req.path === '/health' || req.path === '/auth/login' || req.path === '/auth/setup') return next();

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
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: CONFIG.NODE_ENV, version: '5.1' });
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
          workerEmail: assigned.email || null,
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

    // 2. Fetch benchmarks + user levels from config DB
    const db = await getConfigDb();
    const [benchmarks, userLevels] = await Promise.all([
      db.collection('dashboard_benchmarks').find({}).toArray(),
      db.collection('dashboard_user_levels').find({}).toArray()
    ]);

    // Index benchmarks by status slug
    const benchmarkMap = {};
    for (const b of benchmarks) {
      benchmarkMap[b.status] = b;
    }

    // Index user levels by email
    const levelMap = {};
    for (const u of userLevels) {
      if (u.email) levelMap[u.email.toLowerCase()] = u.level;
    }

    // 3. Classify each segment
    const classified = segments.map(seg => {
      const benchmark = benchmarkMap[seg.statusSlug] || benchmarkMap[seg.statusName] || null;
      const userLevel = seg.workerEmail ? (levelMap[seg.workerEmail.toLowerCase()] || null) : null;

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

      return {
        ...seg,
        bucket,
        bucketCode,
        userLevel,
        xphTarget,
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
          createdAt: { $gte: cutoff },  // date-scope prevents unbounded credential fetch
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
        database: 'orders', collection: 'order-credentials', name: 'credential_count_query',
        keys: { order: 1, active: 1, createdAt: 1, deletedAt: 1 },
        reason: 'Speeds up credential count grouping per order (date-scoped in v4.0)'
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
app.get('/queue-wait-summary', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 60, { min: 1, max: 900 });
    const cutoff = getCutoff(days);

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
      {
        $project: {
          orderType: 1,
          orderStatusHistory: 1
        }
      }
    ], { allowDiskUse: true }).toArray();

    // Collect durations per status
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

        // Skip terminal statuses
        if (TERMINAL_SLUGS.includes(slug)) continue;

        const nextEntry = i + 1 < history.length ? history[i + 1] : null;
        const nextDate = toDate(nextEntry?.createdAt);
        const durationHours = nextDate
          ? (nextDate.getTime() - entryDate.getTime()) / 3600000
          : null;

        // Skip zero/negative durations
        if (durationHours !== null && durationHours <= 0) continue;

        const nextSlug = nextEntry?.updatedStatus?.slug || null;
        const nextName = nextEntry?.updatedStatus?.name || null;
        const isOpen = nextDate === null;

        if (!statusMap.has(slug)) {
          statusMap.set(slug, {
            slug, name, type,
            durations: [],     // completed durations in hours
            openCount: 0,      // still in this status (no exit)
            totalVolume: 0,    // total entries
            evalCount: 0,
            transCount: 0,
            nextStatuses: new Map()  // where orders go after this
          });
        }

        const bucket = statusMap.get(slug);
        bucket.totalVolume++;
        if (order.orderType === 'evaluation') bucket.evalCount++;
        if (order.orderType === 'translation') bucket.transCount++;

        if (isOpen) {
          bucket.openCount++;
        } else if (durationHours !== null) {
          bucket.durations.push(durationHours);
        }

        // Track next status distribution
        if (nextSlug) {
          const ns = nextName || nextSlug;
          bucket.nextStatuses.set(ns, (bucket.nextStatuses.get(ns) || 0) + 1);
        }
      }
    }

    // Compute percentiles and build response
    function percentile(sorted, p) {
      if (!sorted.length) return null;
      const idx = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return Math.round(sorted[lo] * 10) / 10;
      return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)) * 10) / 10;
    }

    const summary = [...statusMap.values()]
      .map(s => {
        const sorted = s.durations.slice().sort((a, b) => a - b);
        const avg = sorted.length
          ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10
          : null;

        // Top 3 next statuses
        const topNext = [...s.nextStatuses.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, count]) => `${name} (${count})`)
          .join(', ');

        return {
          statusName: s.name,
          statusSlug: s.slug,
          statusType: s.type,
          totalVolume: s.totalVolume,
          completedCount: sorted.length,
          openCount: s.openCount,
          evaluationCount: s.evalCount,
          translationCount: s.transCount,
          medianWaitHours: percentile(sorted, 50),
          avgWaitHours: avg,
          p75WaitHours: percentile(sorted, 75),
          p90WaitHours: percentile(sorted, 90),
          over24h: sorted.filter(h => h > 24).length,
          over48h: sorted.filter(h => h > 48).length,
          over72h: sorted.filter(h => h > 72).length,
          minWaitHours: sorted.length ? Math.round(sorted[0] * 100) / 100 : null,
          maxWaitHours: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
          topNextStatuses: topNext,
          isWaiting: ['Holding', 'Waiting', 'On-Hold'].includes(s.type) || s.slug.startsWith('awaiting'),
          isProcessing: s.type === 'Processing'
        };
      })
      .sort((a, b) => b.totalVolume - a.totalVolume);

    res.json({
      refreshedAt: new Date().toISOString(),
      days,
      dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
      orderCount: orders.length,
      statusCount: summary.length,
      summary
    });
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

    // Default cutoff: exclude orders stuck since before 2024
    const sinceStr = req.query.since || '2024-01-01';
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

// —— POST /auth/users — Create user (admin only) ——————————
app.post('/auth/users', requireRole('admin'), async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password, and name required' });
    }
    const validRoles = ['admin', 'manager', 'viewer'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'role must be admin, manager, or viewer' });
    }

    const db = await getConfigDb();
    const exists = await db.collection('dashboard_users').findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ error: 'User with this email already exists' });

    const hash = await bcrypt.hash(password, 12);
    const apiKey = 'iee_' + crypto.randomBytes(24).toString('hex');

    const user = {
      email: email.toLowerCase().trim(),
      passwordHash: hash,
      name: name.trim(),
      role: role || 'viewer',
      apiKey,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: req.user?.name || 'admin'
    };

    const result = await db.collection('dashboard_users').insertOne(user);

    await auditLog('create_user', 'dashboard_users',
      { email: user.email, role: user.role, createdBy: req.user?.name },
      req.user?.name);

    res.json({
      success: true,
      user: { id: result.insertedId, email: user.email, name: user.name, role: user.role, apiKey }
    });
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


// ═══════════════════════════════════════════════════════════
// AI CHATBOT — Claude API proxy with live data access
// ═══════════════════════════════════════════════════════════

const DEFAULT_SYSTEM_PROMPT = `You are an IEE Operations data analyst assistant. You have access to live data from IEE's KPI, QC, and Queue systems.

When users ask questions about data, use the provided tools to fetch current information. Always cite specific numbers and be precise.

Available data:
- KPI segments: processing time per worker per status per order
- QC events: quality control errors with accountability
- Queue snapshot: live view of orders waiting in each status
- Queue wait summary: historical wait time analysis
- User list: staff roster with departments

Key terminology:
- XpH = items per hour (productivity metric)
- In-Range = worker met their benchmark target
- Out-of-Range = below benchmark
- Fixed It = QC reviewer corrected error in place
- Kick It Back = order returned to responsible team
- Segment = one processing status a worker spent time in

All timestamps are in US Eastern time. Data covers the last 60 days for KPI/QC and configurable window for queue analysis.

Departments: Data Entry, Digital Fulfillment, Digital Records, Document Management, Evaluation, Translations, Customer Support.

Be direct, use numbers, and flag any data quality concerns you notice.`;

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
        text: 'Which queues have the longest wait times right now?',
        category: 'Queue Operations',
        description: 'Shows live queue status with median wait and aging orders'
      },
      {
        text: 'What are the top QC issues this month and which departments are most affected?',
        category: 'Quality Control',
        description: 'Breaks down error types by department with accountability'
      },
      {
        text: 'How is the Evaluation team performing on processing speed this month?',
        category: 'KPI Performance',
        description: 'Shows segment counts, avg durations, and worker breakdown for Evaluation'
      },
      {
        text: 'Are there any statuses where orders are getting stuck for more than 48 hours?',
        category: 'Queue Operations',
        description: 'Identifies bottleneck statuses using aging bucket analysis'
      },
      {
        text: 'Give me a daily operations summary — queues, processing volume, and QC issues.',
        category: 'Daily Summary',
        description: 'Comprehensive overview pulling from all data sources'
      }
    ]
  });
});

// AI-specific rate limiter (stricter than global)
const aiRateLimit = rateLimit({ windowMs: 60000, max: 10, message: { error: 'AI rate limit exceeded. Max 10 requests per minute.' }, standardHeaders: true, legacyHeaders: false });

// —— POST /ai/chat —————————————————————————————————————————
// Proxies to Claude API with internal data tools
app.post('/ai/chat', aiRateLimit, async (req, res) => {
  try {
    if (!CONFIG.CLAUDE_API_KEY) {
      return res.status(500).json({ error: 'Claude API key not configured' });
    }

    const { messages, context } = req.body;
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
    const tools = [
      {
        name: 'fetch_kpi_summary',
        description: 'Fetch KPI segment summary. Returns aggregated counts and avg durations by status and by worker. Max 90 days. Does NOT return individual segment rows — only summaries.',
        input_schema: {
          type: 'object',
          properties: {
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
        input_schema: {
          type: 'object',
          properties: {
            worker: { type: 'string', description: 'Worker name or email (partial match supported).' },
            days: { type: 'number', description: 'Days to look back (max 90, default 7).' }
          },
          required: ['worker']
        }
      },
      {
        name: 'fetch_anomaly_scan',
        description: 'Scan for data anomalies and inconsistencies. Returns workers with unusual patterns: zero-activity days during work hours, abnormally high/low segment counts, segments with impossible durations, orders stuck in processing for extended periods, workers with no QC events despite high volume. Use when asked about discrepancies, suspicious patterns, or data quality.',
        input_schema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Days to scan (max 30, default 7).' }
          }
        }
      }
    ];

    // First Claude call
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: guardrailConfig.model || 'claude-sonnet-4-20250514',
        max_tokens: guardrailConfig.maxTokens || 4096,
        system: systemPrompt + glossaryText + contextStr,
        messages,
        tools
      })
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errBody);
      return res.status(500).json({ error: 'Claude API error: ' + claudeRes.status });
    }

    let claudeData = await claudeRes.json();

    // Handle tool use — Claude wants to fetch data
    let iterations = 0;
    const guardrailConfig = await getGuardrails();
    const maxIterations = guardrailConfig.maxToolIterations || 5;

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
              const days = Math.min(toolBlock.input?.days || 60, AI_MAX_DAYS);
              // Fetch ONE page only — summarize, never return raw rows
              const kpi = await internalFetch(`/kpi-segments?days=${days}&page=1&pageSize=${AI_PAGE_SIZE}`);
              const segments = kpi.segments || [];
              const byStatus = {};
              const byWorker = {};
              for (const s of segments) {
                const st = s.statusName || s.statusSlug;
                if (!byStatus[st]) byStatus[st] = { count: 0, totalMin: 0, closed: 0 };
                byStatus[st].count++;
                if (!s.isOpen && s.durationMinutes > 0) { byStatus[st].totalMin += s.durationMinutes; byStatus[st].closed++; }

                const w = s.workerName || 'UNATTRIBUTED';
                if (!byWorker[w]) byWorker[w] = { count: 0, totalMin: 0, closed: 0, email: s.workerEmail };
                byWorker[w].count++;
                if (!s.isOpen && s.durationMinutes > 0) { byWorker[w].totalMin += s.durationMinutes; byWorker[w].closed++; }
              }

              result = {
                note: `Summary of first ${segments.length} segments out of ${kpi.totalCount} total (${days} day window). Data is aggregated — no raw rows returned.`,
                totalSegments: kpi.totalCount,
                sampleSize: segments.length,
                orderCount: kpi.orderCount,
                days,
                byStatus: Object.entries(byStatus).map(([status, d]) => ({
                  status, segments: d.count, avgMin: d.closed ? Math.round(d.totalMin/d.closed*10)/10 : null
                })).sort((a,b) => b.segments - a.segments).slice(0, 20),
                topWorkers: Object.entries(byWorker).map(([worker, d]) => ({
                  worker, email: d.email, segments: d.count, avgMin: d.closed ? Math.round(d.totalMin/d.closed*10)/10 : null
                })).sort((a,b) => b.segments - a.segments).slice(0, 20)
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
              result = await internalFetch(`/qc-summary?days=${days}`);
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
              const days = Math.min(toolBlock.input?.days || 7, AI_MAX_DAYS);
              const kpi = await internalFetch(`/kpi-segments?days=${days}&page=1&pageSize=${AI_PAGE_SIZE}`);
              const segments = (kpi.segments || []).filter(s => {
                const wn = (s.workerName || '').toLowerCase();
                const we = (s.workerEmail || '').toLowerCase();
                const q = workerQuery.toLowerCase();
                return wn.includes(q) || we.includes(q);
              });
              // Group by day
              const byDay = {};
              segments.forEach(s => {
                const d = s.segmentStart?.substring(0, 10) || 'unknown';
                if (!byDay[d]) byDay[d] = { date: d, count: 0, totalMin: 0, statuses: {}, orders: new Set() };
                byDay[d].count++;
                if (!s.isOpen && s.durationMinutes > 0) byDay[d].totalMin += s.durationMinutes;
                const st = s.statusName || s.statusSlug;
                byDay[d].statuses[st] = (byDay[d].statuses[st] || 0) + 1;
                if (s.orderSerialNumber) byDay[d].orders.add(s.orderSerialNumber);
              });
              result = {
                worker: workerQuery,
                matchedSegments: segments.length,
                workerName: segments[0]?.workerName || workerQuery,
                workerEmail: segments[0]?.workerEmail || '',
                days,
                dailyBreakdown: Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date)).map(d => ({
                  date: d.date, segments: d.count, totalMinutes: Math.round(d.totalMin),
                  totalHours: Math.round(d.totalMin / 60 * 10) / 10, uniqueOrders: d.orders.size,
                  statusBreakdown: d.statuses
                })),
                summary: {
                  totalSegments: segments.length,
                  totalHours: Math.round(segments.filter(s => !s.isOpen).reduce((a, s) => a + (s.durationMinutes || 0), 0) / 60 * 10) / 10,
                  uniqueOrders: new Set(segments.map(s => s.orderSerialNumber).filter(Boolean)).size,
                  avgSegmentsPerDay: Object.keys(byDay).length ? Math.round(segments.length / Object.keys(byDay).length * 10) / 10 : 0,
                  statusTotals: Object.entries(segments.reduce((acc, s) => { const st = s.statusName || s.statusSlug; acc[st] = (acc[st] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1])
                }
              };
              break;
            }
            case 'fetch_anomaly_scan': {
              const days = Math.min(toolBlock.input?.days || 7, 30);
              const [kpi, qc] = await Promise.all([
                internalFetch(`/kpi-segments?days=${days}&page=1&pageSize=${AI_PAGE_SIZE}`),
                internalFetch(`/qc-summary?days=${days}`)
              ]);
              const segments = kpi.segments || [];
              // Anomaly 1: Workers with very few segments vs team avg
              const byWorker = {};
              segments.forEach(s => {
                const w = s.workerEmail || 'none';
                if (!byWorker[w]) byWorker[w] = { name: s.workerName, email: w, count: 0, totalMin: 0, maxDuration: 0, zeroDays: 0 };
                byWorker[w].count++;
                if (s.durationMinutes > 0) { byWorker[w].totalMin += s.durationMinutes; byWorker[w].maxDuration = Math.max(byWorker[w].maxDuration, s.durationMinutes); }
              });
              const workers = Object.values(byWorker).filter(w => w.email !== 'none');
              const avgCount = workers.length ? workers.reduce((a, w) => a + w.count, 0) / workers.length : 0;
              // Flag workers >2x or <0.5x average
              const outlierWorkers = workers.filter(w => w.count > avgCount * 2 || w.count < avgCount * 0.3).map(w => ({
                ...w, avgForTeam: Math.round(avgCount), ratio: Math.round(w.count / avgCount * 100) / 100,
                flag: w.count > avgCount * 2 ? 'HIGH_VOLUME' : 'LOW_VOLUME'
              }));
              // Anomaly 2: Segments with extreme durations (>8hrs)
              const longSegments = segments.filter(s => s.durationMinutes > 480 && !s.isOpen).length;
              // Anomaly 3: Segments with 0 duration
              const zeroDuration = segments.filter(s => !s.isOpen && (s.durationMinutes === 0 || s.durationMinutes === null)).length;
              // Anomaly 4: Unattributed segments
              const unattributed = segments.filter(s => !s.workerEmail).length;
              result = {
                scanPeriod: days + ' days',
                totalSegments: segments.length,
                anomalies: {
                  outlierWorkers: outlierWorkers.slice(0, 10),
                  longSegments: { count: longSegments, description: 'Segments over 8 hours processing time' },
                  zeroDurationSegments: { count: zeroDuration, description: 'Closed segments with 0 or null duration' },
                  unattributedSegments: { count: unattributed, percentage: segments.length ? Math.round(unattributed / segments.length * 1000) / 10 : 0, description: 'Segments with no assigned worker' }
                },
                qcSummary: { totalEvents: qc.totalEvents || 0, topDepartments: (qc.byDepartment || []).slice(0, 5) }
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

      // Continue conversation with tool results
      const continuedMessages = [
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
          model: guardrailConfig.model || 'claude-sonnet-4-20250514',
          max_tokens: guardrailConfig.maxTokens || 4096,
          system: systemPrompt + contextStr,
          messages: continuedMessages,
          tools
        })
      });

      if (!continueRes.ok) {
        const errBody = await continueRes.text();
        console.error('Claude continue error:', continueRes.status, errBody);
        break;
      }

      claudeData = await continueRes.json();
      // Update messages for potential next iteration
      messages.push({ role: 'assistant', content: claudeData.content });
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

    res.json({
      response,
      content: claudeData.content,
      toolIterations: iterations
    });

  } catch (err) {
    console.error('AI chat error:', err);
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
    const db = await getConfigDb();
    const benchmarks = await db.collection('dashboard_benchmarks')
      .find({}).sort({ team: 1, status: 1 }).toArray();
    res.json({ count: benchmarks.length, benchmarks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /config/benchmarks ————————————————————————————————
// Upsert a benchmark row (by team + status)
app.put('/config/benchmarks', requireRole('admin', 'manager'), async (req, res) => {
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
    const db = await getConfigDb();
    const hours = await db.collection('dashboard_production_hours')
      .find({}).sort({ team: 1, status: 1 }).toArray();
    res.json({ count: hours.length, hours });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /config/production-hours ——————————————————————————
app.put('/config/production-hours', requireRole('admin', 'manager'), async (req, res) => {
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
    const db = await getConfigDb();
    const levels = await db.collection('dashboard_user_levels')
      .find({}).sort({ name: 1 }).toArray();
    res.json({ count: levels.length, levels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— PUT /config/user-levels ——————————————————————————————
// Upsert a user level by email
app.put('/config/user-levels', requireRole('admin', 'manager'), async (req, res) => {
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
  model: 'claude-sonnet-4-20250514',
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
      model: model || 'claude-sonnet-4-20250514',
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

async function runBackfill(options = {}) {
  if (backfillRunning) return { error: 'Backfill already in progress' };
  backfillRunning = true;
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
      const days = options.days || 90;
      segmentCutoff = getCutoff(days);
      qcCutoff = getCutoff(days);
      await segCol.deleteMany({});
      await qcCol.deleteMany({});
      push(`Full refresh: cleared all, window=${days} days`);
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
    // 1. KPI SEGMENTS
    // ═════════════════════════════════════════════════════════

    // 1a. Fetch orders with history entries in the cutoff window
    push('Querying production orders...');
    const prodDb = await getDb('orders');
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
    const openSegments = await segCol.find({ isOpen: true }, { projection: { orderId: 1 } }).toArray();
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
              workerEmail: assigned.email || null,
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

    const qcOps = qcRaw.map(doc => {
      const qcKey = String(doc._id); // MongoDB _id is the natural unique key
      return {
        updateOne: {
          filter: { _qcKey: qcKey },
          update: { $set: {
            _qcKey: qcKey,
            orderId: doc.order ? String(doc.order) : null,
            reporterName: doc.user ? [doc.user.firstName, doc.user.lastName].filter(Boolean).join(' ') : null,
            reporterEmail: doc.user?.email || null,
            departmentName: doc.department?.name || null,
            departmentShortName: doc.department?.shortName || null,
            issueName: doc.issue?.name || null,
            errorType: doc.errorType || null,
            errorAssignedToName: doc.errorAssignedTo ? [doc.errorAssignedTo.firstName, doc.errorAssignedTo.lastName].filter(Boolean).join(' ') : null,
            errorAssignedToEmail: doc.errorAssignedTo?.email || null,
            categoryName: doc.category?.name || null,
            text: doc.text || null,
            qcCreatedAt: doc.createdAt ? toIso(toDate(doc.createdAt)) : null,
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

    // ═════════════════════════════════════════════════════════
    // 3. USERS (always full replace — small dataset, can change)
    // ═════════════════════════════════════════════════════════

    push('Fetching users...');
    const userDb = await getDb('user');
    const users = await userDb.collection('users').find(
      { deletedAt: null },
      { projection: { firstName: 1, middleName: 1, lastName: 1, email: 1, type: 1, active: 1, department: 1 } }
    ).toArray();

    const userDocs = users.map(u => ({
      v2Id: String(u._id),
      fullName: [u.firstName, u.middleName, u.lastName].filter(Boolean).join(' ').trim(),
      email: u.email, type: u.type, isActive: u.active !== false,
      departmentName: u.department?.name || null,
      _backfilledAt: new Date()
    }));

    await usrCol.deleteMany({});
    if (userDocs.length > 0) await usrCol.insertMany(userDocs, { ordered: false });
    await usrCol.createIndex({ email: 1 }).catch(() => {});

    push(`Users: ${userDocs.length} (full replace)`);

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
        ordersScanned: allOrders.size,
        openOrdersRechecked: openOrders.length,
        segmentsProcessed: segOps.length,
        segmentsNew: upsertedSegs,
        segmentsUpdated: updatedSegs,
        segmentsTotal: totalSegs,
        qcProcessed: qcRaw.length,
        qcNew: upsertedQc,
        qcTotal: totalQc,
        users: userDocs.length,
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
      .deleteMany({ completedAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }); // keep 7 days

    push(`Done in ${(elapsed/1000).toFixed(1)}s — ${upsertedSegs} new segs, ${updatedSegs} updated, ${upsertedQc} new QC, ${totalSegs} total`);
    backfillRunning = false;
    return metadata;

  } catch (err) {
    push(`ERROR: ${err.message}`);
    backfillRunning = false;
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
    const { days, full, dateFrom, dateTo } = req.body;
    if (backfillRunning) return res.status(409).json({ error: 'Backfill already in progress' });

    const opts = {
      days: days ? Math.min(Math.max(parseInt(days) || 90, 1), 365) : 90,
      full: !!full,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
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

// ═══════════════════════════════════════════════════════════
// FAST READ ENDPOINTS — Read from backfill collections
// These replace the slow live queries for the dashboard.
// The original endpoints still work for GAS/Bruno (live data).
// ═══════════════════════════════════════════════════════════

// —— GET /data/kpi-segments — Fast read from backfill ————
app.get('/data/kpi-segments', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = parsePositiveInt(req.query.pageSize, 5000, { min: 1, max: 10000 });
    const db = await getConfigDb();
    const col = db.collection('backfill_kpi_segments');

    // Build filter
    const filter = {};
    if (req.query.orderType) filter.orderType = req.query.orderType;
    if (req.query.workerEmail) filter.workerEmail = req.query.workerEmail;
    if (req.query.statusSlug) filter.statusSlug = req.query.statusSlug;
    if (req.query.from) filter.segmentStart = { $gte: req.query.from };
    if (req.query.to) filter.segmentStart = { ...filter.segmentStart, $lte: req.query.to + 'T23:59:59' };

    const totalCount = await col.countDocuments(filter);
    const segments = await col.find(filter)
      .sort({ segmentStart: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    const meta = await db.collection('backfill_metadata').findOne({ _id: 'status' });

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

    const totalCount = await col.countDocuments(filter);
    const events = await col.find(filter)
      .sort({ qcCreatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    const meta = await db.collection('backfill_metadata').findOne({ _id: 'status' });

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
    const users = await db.collection('backfill_users').find({}).sort({ fullName: 1 }).toArray();
    res.json({ count: users.length, source: 'backfill', users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backfill auto-scheduler ─────────────────────────────
function startBackfillScheduler() {
  let lastCheckMs = 0;

  setInterval(async () => {
    try {
      const db = await getConfigDb();
      const settings = await db.collection('backfill_metadata').findOne({ _id: 'settings' });
      if (!settings?.enabled) return;

      const intervalMs = (settings.autoRefreshMinutes || 5) * 60 * 1000;
      const status = await db.collection('backfill_metadata').findOne({ _id: 'status' });
      const lastRun = status?.lastRunAt ? new Date(status.lastRunAt).getTime() : 0;

      if (Date.now() - lastRun >= intervalMs && !backfillRunning) {
        console.log(`[BACKFILL-CRON] Auto-backfill triggered (interval: ${settings.autoRefreshMinutes}min)`);
        runBackfill({ days: settings.days || 90, triggeredBy: 'auto-scheduler' });
      }
    } catch (err) {
      console.error('[BACKFILL-CRON] Error:', err.message);
    }
  }, 15000); // Check every 15 seconds

  console.log('Backfill auto-scheduler started (checks every 15s)');
}


// ═══════════════════════════════════════════════════════════
// REPORT BUILDER — Server-side aggregation against backfill data
// ═══════════════════════════════════════════════════════════

// —— POST /reports/query — Execute a report ——————————————
app.post('/reports/query', async (req, res) => {
  try {
    const { source, metric, groupBy, filters, dateGrouping } = req.body;
    if (!source || !metric || !groupBy) {
      return res.status(400).json({ error: 'source, metric, and groupBy required' });
    }

    const db = await getConfigDb();
    const colName = source === 'qc' ? 'backfill_qc_events' : 'backfill_kpi_segments';
    const col = db.collection(colName);

    // Build match filter
    const match = {};
    if (filters) {
      if (filters.dateFrom) {
        const dateField = source === 'qc' ? 'qcCreatedAt' : 'segmentStart';
        match[dateField] = { ...match[dateField], $gte: filters.dateFrom };
      }
      if (filters.dateTo) {
        const dateField = source === 'qc' ? 'qcCreatedAt' : 'segmentStart';
        match[dateField] = { ...match[dateField], $lte: filters.dateTo + 'T23:59:59' };
      }
      if (filters.workers?.length) match.workerEmail = { $in: filters.workers };
      if (filters.statuses?.length) match.statusSlug = { $in: filters.statuses };
      if (filters.orderTypes?.length) match.orderType = { $in: filters.orderTypes };
      if (filters.departments?.length) match.departmentName = { $in: filters.departments };
      if (filters.errorTypes?.length) match.errorType = { $in: filters.errorTypes };
      if (filters.excludeOpen) match.isOpen = { $ne: true };
    }

    // Build group key
    const dateField = source === 'qc' ? 'qcCreatedAt' : 'segmentStart';
    let groupKey;
    switch (groupBy) {
      case 'worker': groupKey = source === 'qc' ? '$errorAssignedToName' : '$workerName'; break;
      case 'workerEmail': groupKey = source === 'qc' ? '$errorAssignedToEmail' : '$workerEmail'; break;
      case 'status': groupKey = '$statusSlug'; break;
      case 'statusName': groupKey = '$statusName'; break;
      case 'department': groupKey = '$departmentName'; break;
      case 'orderType': groupKey = '$orderType'; break;
      case 'errorType': groupKey = '$errorType'; break;
      case 'issueName': groupKey = '$issueName'; break;
      case 'date':
        // Group by day/week/month
        if (dateGrouping === 'week') {
          groupKey = { $dateToString: { format: '%G-W%V', date: { $dateFromString: { dateString: `$${dateField}` } } } };
        } else if (dateGrouping === 'month') {
          groupKey = { $substr: [`$${dateField}`, 0, 7] };
        } else {
          groupKey = { $substr: [`$${dateField}`, 0, 10] }; // day
        }
        break;
      default: groupKey = '$' + groupBy;
    }

    // Build metric aggregation
    let metricField;
    switch (metric) {
      case 'count': metricField = { $sum: 1 }; break;
      case 'avgDuration': metricField = { $avg: '$durationMinutes' }; break;
      case 'totalHours': metricField = { $sum: { $divide: ['$durationMinutes', 60] } }; break;
      case 'totalMinutes': metricField = { $sum: '$durationMinutes' }; break;
      case 'maxDuration': metricField = { $max: '$durationMinutes' }; break;
      case 'minDuration': metricField = { $min: '$durationMinutes' }; break;
      case 'uniqueOrders': metricField = { $addToSet: '$orderSerialNumber' }; break;
      default: metricField = { $sum: 1 };
    }

    const pipeline = [
      { $match: match },
      { $group: { _id: groupKey, value: metricField, count: { $sum: 1 } } },
      { $sort: { value: -1 } },
      { $limit: 200 }
    ];

    let results = await col.aggregate(pipeline).toArray();

    // Post-process uniqueOrders to get count
    if (metric === 'uniqueOrders') {
      results = results.map(r => ({ ...r, value: Array.isArray(r.value) ? r.value.length : 0 }));
    }

    // Round numeric values
    results = results.map(r => ({
      label: r._id || 'N/A',
      value: typeof r.value === 'number' ? Math.round(r.value * 100) / 100 : r.value,
      count: r.count
    }));

    const totalDocs = await col.countDocuments(match);

    res.json({
      source, metric, groupBy, dateGrouping,
      filters,
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
    const [workers, statuses, departments, errorTypes] = await Promise.all([
      db.collection('backfill_kpi_segments').distinct('workerEmail'),
      db.collection('backfill_kpi_segments').distinct('statusSlug'),
      db.collection('backfill_qc_events').distinct('departmentName'),
      db.collection('backfill_qc_events').distinct('errorType')
    ]);

    // Worker name map
    const workerNames = {};
    const workerDocs = await db.collection('backfill_kpi_segments')
      .aggregate([
        { $match: { workerEmail: { $ne: null } } },
        { $group: { _id: '$workerEmail', name: { $first: '$workerName' } } }
      ]).toArray();
    workerDocs.forEach(w => { workerNames[w._id] = w.name; });

    // Status name map
    const statusNames = {};
    const statusDocs = await db.collection('backfill_kpi_segments')
      .aggregate([
        { $match: { statusSlug: { $ne: null } } },
        { $group: { _id: '$statusSlug', name: { $first: '$statusName' } } }
      ]).toArray();
    statusDocs.forEach(s => { statusNames[s._id] = s.name; });

    res.json({
      workers: workers.filter(Boolean).map(e => ({ email: e, name: workerNames[e] || e })).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
      statuses: statuses.filter(Boolean).map(s => ({ slug: s, name: statusNames[s] || s })).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
      departments: departments.filter(Boolean).sort(),
      errorTypes: errorTypes.filter(Boolean).sort(),
      orderTypes: ['evaluation', 'translation']
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— POST /reports/export — CSV export ———————————————————
app.post('/reports/export', async (req, res) => {
  try {
    const { source, filters } = req.body;
    const db = await getConfigDb();
    const colName = source === 'qc' ? 'backfill_qc_events' : 'backfill_kpi_segments';

    const match = {};
    if (filters) {
      if (filters.dateFrom) {
        const df = source === 'qc' ? 'qcCreatedAt' : 'segmentStart';
        match[df] = { ...match[df], $gte: filters.dateFrom };
      }
      if (filters.dateTo) {
        const df = source === 'qc' ? 'qcCreatedAt' : 'segmentStart';
        match[df] = { ...match[df], $lte: filters.dateTo + 'T23:59:59' };
      }
      if (filters.workers?.length) match.workerEmail = { $in: filters.workers };
      if (filters.statuses?.length) match.statusSlug = { $in: filters.statuses };
      if (filters.orderTypes?.length) match.orderType = { $in: filters.orderTypes };
    }

    const docs = await db.collection(colName).find(match).sort({ segmentStart: -1 }).limit(50000).toArray();

    if (!docs.length) return res.status(404).json({ error: 'No data found for these filters' });

    // Build CSV
    const keys = Object.keys(docs[0]).filter(k => !k.startsWith('_'));
    const header = keys.join(',');
    const rows = docs.map(d => keys.map(k => {
      const v = d[k];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="iee-${source}-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([header, ...rows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// —— Saved Reports CRUD ————————————————————————————————
app.get('/reports/saved', async (req, res) => {
  try {
    const db = await getConfigDb();
    const reports = await db.collection('dashboard_saved_reports')
      .find({}).sort({ updatedAt: -1 }).toArray();
    res.json({ count: reports.length, reports });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/reports/saved', async (req, res) => {
  try {
    const { name, config } = req.body;
    if (!name || !config) return res.status(400).json({ error: 'name and config required' });
    const db = await getConfigDb();
    const doc = { name, config, createdBy: req.user?.name || 'unknown', createdAt: new Date(), updatedAt: new Date() };
    const result = await db.collection('dashboard_saved_reports').insertOne(doc);
    res.json({ success: true, id: result.insertedId, report: doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/reports/saved/:id', async (req, res) => {
  try {
    const db = await getConfigDb();
    await db.collection('dashboard_saved_reports').deleteOne({ _id: new ObjectId(req.params.id) });
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
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`IEE KPI Data API v5.0 running on port ${CONFIG.PORT}`);
  console.log(`Environment: ${CONFIG.NODE_ENV}`);
  console.log(`Rate limit: 60 requests/minute`);
  console.log(`IP allowlist: ${CONFIG.ALLOWED_IPS || 'disabled (all IPs allowed)'}`);
  // Start cron scheduler for automated emails
  if (CONFIG.SENDGRID_API_KEY) { startCronScheduler(); }
  else { console.log('SendGrid not configured — email scheduler disabled'); }
  // Start backfill auto-scheduler
  startBackfillScheduler();
});

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