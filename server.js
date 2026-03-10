// ============================================================
// IEE KPI Data API Server — v2.1
// Purpose:
//   - KPI processing segments
//   - Credential/report counts
//   - QC event, order, and summary datasets sourced from V2 MongoDB
//
// QC model confirmed from V2 source:
//   - Collection: orders.order-discussion
//   - QC grain: discussion rows where
//       type = 'system_logs'
//       category.slug = 'quality_control'
//   - Related workflow signal may also appear on orders.orderStatusHistory[*].isErrorReporting
// ============================================================

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();

const CONFIG = {
  MONGO_URI: process.env.MONGO_URI,
  API_KEY: process.env.API_KEY,
  PORT: process.env.PORT || 3000,
  ALLOWED_IPS: process.env.ALLOWED_IPS || '',
  NODE_ENV: process.env.NODE_ENV || 'production'
};

if (!CONFIG.MONGO_URI) {
  console.error('FATAL: MONGO_URI required');
  process.exit(1);
}
if (!CONFIG.API_KEY) {
  console.error('FATAL: API_KEY required');
  process.exit(1);
}

app.use(helmet());
app.use(cors({
  origin: ['https://script.google.com', 'https://script.googleusercontent.com'],
  methods: ['GET'],
  allowedHeaders: ['x-api-key', 'Content-Type']
}));
app.set('trust proxy', 1);
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(express.json());

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
  return value === undefined || value === null ? null : String(value);
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

function getStatusContext(order, qcCreatedAt) {
  const history = Array.isArray(order?.orderStatusHistory) ? order.orderStatusHistory : [];
  if (!history.length || !qcCreatedAt) {
    return {
      statusAtQcSlug: null,
      statusAtQcName: null,
      statusAtQcType: null,
      previousStatusSlug: null,
      previousStatusName: null,
      nextStatusChangeAt: null,
      nextStatusSlug: null,
      nextStatusName: null,
      nextStatusType: null,
      minutesToNextStatusChange: null,
      hoursToNextStatusChange: null
    };
  }

  const normalized = history
    .map(entry => ({
      createdAt: toDate(entry?.createdAt),
      oldStatus: entry?.oldStatus || null,
      updatedStatus: entry?.updatedStatus || null,
      isErrorReporting: !!entry?.isErrorReporting,
      assignedTo: entry?.assignedTo || null,
      user: entry?.user || null
    }))
    .filter(entry => entry.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt);

  let current = null;
  let next = null;
  for (const entry of normalized) {
    if (entry.createdAt <= qcCreatedAt) {
      current = entry;
      continue;
    }
    next = entry;
    break;
  }

  const nextMinutes = next ? Math.round(((next.createdAt - qcCreatedAt) / 60000) * 10) / 10 : null;
  const nextHours = nextMinutes !== null ? Math.round((nextMinutes / 60) * 10) / 10 : null;

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
    orderSerialNumber: order?.orderSerialNumber || null,
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
    issueCustomText: issue?.issueCustomText || null,
    reporterUserId: doc?.user?.foreignKeyId || null,
    reporterName: buildFullName(doc?.user),
    reporterEmail: doc?.user?.email || null,
    accountableUserId: doc?.errorAssignedTo?.foreignKeyId || null,
    accountableName: buildFullName(doc?.errorAssignedTo),
    accountableEmail: doc?.errorAssignedTo?.email || null,
    text: doc?.text || null,
    html: doc?.html || null,
    ...statusContext
  };
}

let client;
async function getDb(dbName) {
  if (!client) {
    client = new MongoClient(CONFIG.MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });
    await client.connect();
    console.log('Connected to MongoDB Atlas');
  }
  return client.db(dbName);
}

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
        orderType: 1,
        paymentStatus: 1,
        isErrorReporting: 1,
        orderStatusHistory: 1,
        assignedTo: 1,
        user: 1,
        createdAt: 1,
        updatedAt: 1
      }
    }
  ).toArray();

  return new Map(docs.map(doc => [String(doc._id), doc]));
}

async function getQcEventsDataset(days) {
  const cutoff = getCutoff(days);
  const db = await getDb('orders');
  const qcCol = db.collection('order-discussion');

  const docs = await qcCol.find(buildQcQuery(cutoff), {
    projection: {
      _id: 1,
      order: 1,
      createdAt: 1,
      type: 1,
      category: 1,
      errorType: 1,
      department: 1,
      issue: 1,
      user: 1,
      errorAssignedTo: 1,
      text: 1,
      html: 1,
      deletedAt: 1
    }
  }).sort({ createdAt: -1 }).toArray();

  const orderIds = docs
    .map(doc => safeString(doc?.order))
    .filter(Boolean);

  const ordersMap = await getOrdersMap(orderIds);
  const events = docs.map(doc => buildQcEvent(doc, ordersMap.get(safeString(doc?.order)))).sort((a, b) => {
    if (!a.qcCreatedAt && !b.qcCreatedAt) return 0;
    if (!a.qcCreatedAt) return 1;
    if (!b.qcCreatedAt) return -1;
    return new Date(b.qcCreatedAt) - new Date(a.qcCreatedAt);
  });

  return {
    cutoff,
    refreshedAt: new Date(),
    events
  };
}

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

function average(values) {
  const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!valid.length) return null;
  return Math.round((valid.reduce((sum, v) => sum + v, 0) / valid.length) * 10) / 10;
}

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

app.get('/health', async (req, res) => {
  try {
    const db = await getDb('orders');
    await db.command({ ping: 1 });
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      env: CONFIG.NODE_ENV,
      version: '2.1'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

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

app.get('/kpi-segments', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, { min: 1, max: 365 });
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
    const pageSize = parsePositiveInt(req.query.pageSize, 5000, { min: 100, max: 10000 });
    const cutoff = getCutoff(days);

    const db = await getDb('orders');
    const ordersCol = db.collection('orders');

    const ordersPipeline = [
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
    ];

    const orders = await ordersCol.aggregate(ordersPipeline, { allowDiskUse: true }).toArray();
    const allSegments = [];

    for (const order of orders) {
      const history = Array.isArray(order.orderStatusHistory) ? order.orderStatusHistory : [];
      const reportCount = Array.isArray(order.reportItems) ? order.reportItems.length : 0;
      const reportName = Array.isArray(order.reportItems) ? order.reportItems[0]?.name || null : null;

      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        if (entry?.updatedStatus?.statusType !== 'Processing') continue;

        const entryDate = toDate(entry?.createdAt);
        if (!entryDate || entryDate < cutoff) continue;

        const nextEntry = i + 1 < history.length ? history[i + 1] : null;
        const segmentEndDate = toDate(nextEntry?.createdAt);
        const durationSeconds = segmentEndDate ? (segmentEndDate.getTime() - entryDate.getTime()) / 1000 : null;
        const durationMinutes = durationSeconds !== null ? Math.round((durationSeconds / 60) * 10) / 10 : null;

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
          workerUserId: assigned.foreignKeyId || null,
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

app.get('/credential-counts', async (req, res) => {
  try {
    const db = await getDb('orders');
    const credsCol = db.collection('order-credentials');

    const pipeline = [
      {
        $match: {
          active: true,
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
    ];

    const counts = await credsCol.aggregate(pipeline).toArray();
    res.json({ count: counts.length, credentials: counts });
  } catch (err) {
    console.error('Credential counts error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
        $match: {
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
        }
      },
      {
        $group: {
          _id: '$orderReport',
          reportItemCount: { $sum: 1 }
        }
      }
    ]).toArray();

    const orderCounts = {};
    for (const itemCount of itemCounts) {
      const orderRef = reportToOrderMap[String(itemCount._id)];
      if (!orderRef) continue;
      const orderId = String(orderRef);
      orderCounts[orderId] = (orderCounts[orderId] || 0) + itemCount.reportItemCount;
    }

    const result = Object.entries(orderCounts).map(([orderId, count]) => ({
      orderId,
      reportItemCount: count
    }));

    res.json({ count: result.length, reports: result });
  } catch (err) {
    console.error('Report counts error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
      orderCount: new Set(dataset.events.map(event => event.orderId).filter(Boolean)).size,
      page: paged.page,
      pageSize: paged.pageSize,
      totalPages: paged.totalPages,
      hasMore: paged.hasMore,
      collectionUsed: 'order-discussion',
      qcFilter: {
        type: 'system_logs',
        categorySlug: 'quality_control',
        allOrdersWithQcRecords: true,
        qcDateField: 'order-discussion.createdAt',
        departmentSource: 'order-discussion.department'
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
        allOrdersWithQcRecords: true,
        qcDateField: 'order-discussion.createdAt',
        departmentSource: 'order-discussion.department'
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

app.get('/qc-summary', async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, { min: 1, max: 365 });
    const dataset = await getQcEventsDataset(days);
    const orderSummaries = buildQcOrderSummaries(dataset.events);

    const minutesToNextStatusChange = dataset.events.map(event => event.minutesToNextStatusChange);
    const hoursToNextStatusChange = dataset.events.map(event => event.hoursToNextStatusChange);

    res.json({
      collectionUsed: 'order-discussion',
      qcFilter: {
        type: 'system_logs',
        categorySlug: 'quality_control',
        allOrdersWithQcRecords: true,
        qcDateField: 'order-discussion.createdAt',
        departmentSource: 'order-discussion.department'
      },
      dateRange: { from: dataset.cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: dataset.refreshedAt.toISOString(),
      totals: {
        qcEventCount: dataset.events.length,
        qcOrderCount: orderSummaries.length,
        kickItBackCount: dataset.events.filter(event => event.isKickItBack).length,
        fixedItCount: dataset.events.filter(event => event.isFixedIt).length,
        avgQcEventsPerOrder: average(orderSummaries.map(order => order.qcEventCount)),
        avgMinutesToNextStatusChange: average(minutesToNextStatusChange),
        avgHoursToNextStatusChange: average(hoursToNextStatusChange)
      },
      byDepartment: groupCounts(dataset.events, 'departmentName'),
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

app.get('/indexes', async (req, res) => {
  res.json({
    description: 'Run these in MongoDB Atlas → Data Explorer → each collection → Indexes tab → Create Index',
    indexes: [
      {
        database: 'orders',
        collection: 'orders',
        name: 'kpi_segments_query',
        keys: { paymentStatus: 1, orderType: 1, deletedAt: 1, 'orderStatusHistory.createdAt': 1 },
        reason: 'Speeds up the main KPI segments aggregation pipeline'
      },
      {
        database: 'orders',
        collection: 'order-credentials',
        name: 'credential_count_query',
        keys: { order: 1, active: 1, deletedAt: 1 },
        reason: 'Speeds up credential count grouping per order'
      },
      {
        database: 'orders',
        collection: 'order-discussion',
        name: 'qc_events_query_v2',
        keys: { type: 1, 'category.slug': 1, createdAt: -1, deletedAt: 1 },
        reason: 'Speeds up QC event filtering by quality_control discussions'
      },
      {
        database: 'orders',
        collection: 'orders',
        name: 'qc_order_lookup',
        keys: { _id: 1, orderSerialNumber: 1, orderType: 1, paymentStatus: 1 },
        reason: 'Supports QC event enrichment by order details and workflow history'
      },
      {
        database: 'orders',
        collection: 'order-report',
        name: 'report_order_lookup',
        keys: { order: 1, deletedAt: 1 },
        reason: 'Speeds up report count lookup per order'
      },
      {
        database: 'orders',
        collection: 'order-report-item',
        name: 'report_item_grouping',
        keys: { orderReport: 1, deletedAt: 1 },
        reason: 'Speeds up report item count aggregation'
      }
    ]
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: [
      '/health',
      '/collections',
      '/kpi-segments',
      '/credential-counts',
      '/report-counts',
      '/qc-events',
      '/qc-orders',
      '/qc-summary',
      '/indexes'
    ]
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`IEE KPI Data API running on port ${CONFIG.PORT}`);
  console.log(`Environment: ${CONFIG.NODE_ENV}`);
  console.log('Version: 2.1');
  console.log('Rate limit: 60 requests/minute');
  console.log(`IP allowlist: ${CONFIG.ALLOWED_IPS || 'disabled (all IPs allowed)'}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  if (client) await client.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
