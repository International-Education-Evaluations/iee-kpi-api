// ============================================================
// IEE KPI Data API Server — v4.1
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
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();

// —— Configuration ————————————————————————————————————————
const CONFIG = {
  MONGO_URI: process.env.MONGO_URI,
  API_KEY: process.env.API_KEY,
  PORT: process.env.PORT || 3000,
  ALLOWED_IPS: process.env.ALLOWED_IPS || '',
  NODE_ENV: process.env.NODE_ENV || 'production'
};

if (!CONFIG.MONGO_URI) { console.error('FATAL: MONGO_URI required'); process.exit(1); }
if (!CONFIG.API_KEY) { console.error('FATAL: API_KEY required'); process.exit(1); }

// —— Security ————————————————————————————————————————————
app.use(helmet());
app.use(cors({
  origin: ['https://script.google.com', 'https://script.googleusercontent.com'],
  methods: ['GET'],
  allowedHeaders: ['x-api-key', 'Content-Type']
}));
app.set('trust proxy', 1);
app.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));
app.use(express.json());

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
let client;
async function getDb(dbName) {
  if (!client) {
    client = new MongoClient(CONFIG.MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      retryWrites: true,  // auto-retry on transient write failures / reconnect
      retryReads: true    // auto-retry on transient read failures / reconnect
    });
    await client.connect();
    console.log('Connected to MongoDB Atlas');
  }
  return client.db(dbName);
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

function authCheck(req, res, next) {
  if (req.path === '/health') return next();
  if (req.headers['x-api-key'] !== CONFIG.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(ipCheck);
app.use(authCheck);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms [${req.ip}]`);
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
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: CONFIG.NODE_ENV, version: '4.0' });
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
          orderStatusHistory: 1
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

        allSegments.push({
          orderSerialNumber: order.orderSerialNumber,
          orderId: String(order._id),
          orderType: order.orderType,
          parentOrderId: order.parentOrderId || null,
          reportItemCount: reportCount,
          reportItemName: reportName,
          statusSlug: entry?.updatedStatus?.slug || '',
          statusName: entry?.updatedStatus?.name || '',
          // foreignKeyId is the V1 MySQL user ID — preferred join key for Power BI
          // v2Id is the MongoDB user ID — fallback for orders never synced to V1
          workerUserId: assigned.foreignKeyId || assigned.v2Id || null,
          workerName: buildFullName(assigned),
          workerEmail: assigned.email || null,
          changedByName: buildFullName(user),
          segmentStart: toIso(entryDate),
          segmentEnd: toIso(segmentEndDate),
          durationSeconds,
          durationMinutes,
          isOpen: segmentEndDate === null,
          isErrorReporting: !!entry?.isErrorReporting
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
    const userDb = mongoClient.db('user');
    const col    = userDb.collection('user');

    // Staff role ObjectId (confirmed from user.role collection)
    const STAFF_ROLE_ID = '67acba952a78ccf7588a3ee1';

    // Pull all active users — filter to non-system accounts
    // Strategy: active:true AND (roleId matches Staff OR type != 'system_admin')
    // We return all active users and include type/roleId so GAS can filter if needed
    const cursor = col.find(
      { active: true },
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

    const users = docs.map(u => {
      // Name: firstName + lastName only (middleName is unreliable — sometimes
      // populated with last name due to data entry quirk)
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ');

      // Tags: extract names as comma-separated string
      const tagNames = (u.tags || []).map(t => t.name).filter(Boolean).join(', ');

      // Is staff: roleId matches Staff role OR type is not system_admin/admin
      const isStaff = u.roleId === STAFF_ROLE_ID ||
        (!['system_admin', 'admin'].includes(u.type));

      return {
        userId:       u._id.toString(),       // ObjectId string — join key for QC events
        v1Id:         u.v1Id || null,          // MySQL user ID — join key for KPI segments
        legacyId:     u.legacyId || null,
        fullName:     fullName,
        email:        u.email || '',
        department:   (u.department && u.department.name) || '',
        departmentId: (u.department && u.department.legacyId) || '',
        tags:         tagNames,
        type:         u.type || '',
        roleId:       u.roleId || '',
        isStaff:      isStaff,
        active:       u.active === true
      };
    });

    res.json({
      count:      users.length,
      staffCount: users.filter(u => u.isStaff).length,
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

// —— 404 / Error handlers —————————————————————————————
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: [
      '/health', '/collections',
      '/kpi-segments', '/credential-counts', '/report-counts',
      '/qc-events', '/qc-orders', '/qc-summary', '/qc-discovery',
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
  console.log(`IEE KPI Data API v4.1 running on port ${CONFIG.PORT}`);
  console.log(`Environment: ${CONFIG.NODE_ENV}`);
  console.log(`Rate limit: 60 requests/minute`);
  console.log(`IP allowlist: ${CONFIG.ALLOWED_IPS || 'disabled (all IPs allowed)'}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  if (client) await client.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
