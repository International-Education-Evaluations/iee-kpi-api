// ============================================================
// IEE KPI Data API Server — v2.0
// CHANGES from v1:
//   - Confirmed collection names from /collections output
//   - Added /report-counts endpoint (Evaluation XpH unit)
//   - Added pagination to /kpi-segments (?page=1&pageSize=5000)
//   - Fixed QC collection name to 'order-discussion' (confirmed)
//   - Added /indexes endpoint with recommended indexes
// ============================================================

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();

// —— Configuration (from environment variables) ——————————————
const CONFIG = {
  MONGO_URI: process.env.MONGO_URI,
  API_KEY: process.env.API_KEY,
  PORT: process.env.PORT || 3000,
  ALLOWED_IPS: process.env.ALLOWED_IPS || '',
  NODE_ENV: process.env.NODE_ENV || 'production'
};

if (!CONFIG.MONGO_URI) { console.error('FATAL: MONGO_URI required'); process.exit(1); }
if (!CONFIG.API_KEY) { console.error('FATAL: API_KEY required'); process.exit(1); }

// —— Security ————————————————————————————————————————————————
app.use(helmet());
app.use(cors({
  origin: ['https://script.google.com', 'https://script.googleusercontent.com'],
  methods: ['GET'],
  allowedHeaders: ['x-api-key', 'Content-Type']
}));
app.set('trust proxy', 1);
app.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));
app.use(express.json());

// IP Allowlist
function ipCheck(req, res, next) {
  if (!CONFIG.ALLOWED_IPS) return next();
  const allowed = CONFIG.ALLOWED_IPS.split(',').map(ip => ip.trim());
  if (allowed.includes(req.ip)) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// API Key Auth (health exempt)
function authCheck(req, res, next) {
  if (req.path === '/health') return next();
  if (req.headers['x-api-key'] !== CONFIG.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(ipCheck);
app.use(authCheck);

// —— MongoDB ————————————————————————————————————————————————
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

// Request logger
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

// —— Health Check (no auth) ————————————————————————————————
app.get('/health', async (req, res) => {
  try {
    const db = await getDb('orders');
    await db.command({ ping: 1 });
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: CONFIG.NODE_ENV, version: '2.0' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// —— Collection Discovery —————————————————————————————————
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

// —— KPI Segments (with pagination) ———————————————————————
// Usage: /kpi-segments?days=90&page=1&pageSize=5000
app.get('/kpi-segments', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 5000, 100), 10000);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const db = await getDb('orders');
    // Confirmed collection name: 'orders'
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

    // Extract all Processing segments
    const allSegments = [];

    for (const order of orders) {
      const history = order.orderStatusHistory || [];
      const reportCount = (order.reportItems || []).length;
      const reportName = (order.reportItems || [])[0]?.name || null;

      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        if (entry.updatedStatus?.statusType !== 'Processing') continue;

        const entryDate = new Date(entry.createdAt);
        if (entryDate < cutoff) continue;

        const nextEntry = i + 1 < history.length ? history[i + 1] : null;
        const segmentEnd = nextEntry ? new Date(nextEntry.createdAt) : null;
        const durationSeconds = segmentEnd
          ? (segmentEnd.getTime() - entryDate.getTime()) / 1000
          : null;
        const durationMinutes = durationSeconds !== null
          ? Math.round(durationSeconds / 60 * 10) / 10
          : null;

        // Skip zero/negative duration artifacts
        if (durationSeconds !== null && durationSeconds <= 0) continue;

        const assigned = entry.assignedTo || {};
        const user = entry.user || {};

        allSegments.push({
          orderSerialNumber: order.orderSerialNumber,
          orderId: order._id.toString(),
          orderType: order.orderType,
          parentOrderId: order.parentOrderId || null,
          reportItemCount: reportCount,
          reportItemName: reportName,
          statusSlug: entry.updatedStatus?.slug || '',
          statusName: entry.updatedStatus?.name || '',
          workerUserId: assigned.foreignKeyId || null,
          workerName: [assigned.firstName, assigned.lastName].filter(Boolean).join(' ') || null,
          workerEmail: assigned.email || null,
          changedByName: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
          segmentStart: entryDate.toISOString(),
          segmentEnd: segmentEnd ? segmentEnd.toISOString() : null,
          durationSeconds,
          durationMinutes,
          isOpen: segmentEnd === null,
          isErrorReporting: entry.isErrorReporting || false
        });
      }
    }

    // Pagination
    const totalCount = allSegments.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIdx = (page - 1) * pageSize;
    const paginatedSegments = allSegments.slice(startIdx, startIdx + pageSize);

    res.json({
      count: paginatedSegments.length,
      totalCount,
      orderCount: orders.length,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
      dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: new Date().toISOString(),
      segments: paginatedSegments
    });

  } catch (err) {
    console.error('KPI segments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— Credential Counts ————————————————————————————————————
// For Data Entry XpH (unit = Credentials)
app.get('/credential-counts', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const db = await getDb('orders');
    // Confirmed collection name: 'order-credentials'
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

// —— Report Counts (NEW) —————————————————————————————————
// For Evaluation XpH (unit = Reports)
// order-report-item has orderReport (ref to order-report), which has order (ref to orders)
// We need: for each order, count of report items
app.get('/report-counts', async (req, res) => {
  try {
    const db = await getDb('orders');
    // Confirmed collection name: 'order-report-item'
    const reportItemsCol = db.collection('order-report-item');
    // Confirmed collection name: 'order-report'
    const orderReportsCol = db.collection('order-report');

    // Step 1: Get all order-report documents to build orderReport -> orderId map
    const reports = await orderReportsCol.find(
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { projection: { _id: 1, order: 1 } }
    ).toArray();

    const reportToOrderMap = {};
    for (const r of reports) {
      reportToOrderMap[r._id.toString()] = r.order;
    }

    // Step 2: Count report items per orderReport
    const pipeline = [
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
    ];

    const itemCounts = await reportItemsCol.aggregate(pipeline).toArray();

    // Step 3: Map back to orderId
    const orderCounts = {};
    for (const ic of itemCounts) {
      const orderRef = reportToOrderMap[ic._id?.toString()];
      if (!orderRef) continue;
      const orderId = orderRef.toString();
      orderCounts[orderId] = (orderCounts[orderId] || 0) + ic.reportItemCount;
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

// —— QC Events ————————————————————————————————————————————
app.get('/qc-events', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const db = await getDb('orders');
    // Confirmed collection name: 'order-discussion' (singular!)
    const qcCol = db.collection('order-discussion');

    const pipeline = [
      {
        $match: {
          errorType: { $ne: null },
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
          createdAt: { $gte: cutoff }
        }
      },
      {
        $project: {
          _id: 0,
          qcEventId: { $toString: '$_id' },
          orderId: { $toString: '$order' },
          errorType: 1,
          isFixedIt: { $cond: [{ $eq: ['$errorType', 'i_fixed_it'] }, true, false] },
          isKickItBack: { $cond: [{ $eq: ['$errorType', 'kick_it_back'] }, true, false] },
          reporterUserId: '$user.foreignKeyId',
          reporterName: {
            $trim: {
              input: { $concat: [{ $ifNull: ['$user.firstName', ''] }, ' ', { $ifNull: ['$user.lastName', ''] }] }
            }
          },
          accountableUserId: '$errorAssignedTo.foreignKeyId',
          accountableName: {
            $trim: {
              input: { $concat: [{ $ifNull: ['$errorAssignedTo.firstName', ''] }, ' ', { $ifNull: ['$errorAssignedTo.lastName', ''] }] }
            }
          },
          departmentId: '$department.foreignKeyId',
          departmentName: '$department.name',
          issueName: '$issue.name',
          issueCustomText: '$issue.issueCustomText',
          createdAt: 1
        }
      },
      { $sort: { createdAt: -1 } }
    ];

    const events = await qcCol.aggregate(pipeline).toArray();

    const formattedEvents = events.map(evt => ({
      ...evt,
      createdAt: evt.createdAt ? new Date(evt.createdAt).toISOString() : null
    }));

    res.json({
      count: formattedEvents.length,
      collectionUsed: 'order-discussion',
      dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: new Date().toISOString(),
      events: formattedEvents
    });

  } catch (err) {
    console.error('QC events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— Recommended Indexes ——————————————————————————————————
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
        name: 'qc_events_query',
        keys: { errorType: 1, deletedAt: 1, createdAt: -1 },
        reason: 'Speeds up QC event filtering and sorting'
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

// —— 404 Handler ——————————————————————————————————————————
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: ['/health', '/collections', '/kpi-segments', '/credential-counts', '/report-counts', '/qc-events', '/indexes']
  });
});

// —— Error Handler ———————————————————————————————————————
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// —— Start ———————————————————————————————————————————————
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`IEE KPI Data API running on port ${CONFIG.PORT}`);
  console.log(`Environment: ${CONFIG.NODE_ENV}`);
  console.log(`Rate limit: 60 requests/minute`);
  console.log(`IP allowlist: ${CONFIG.ALLOWED_IPS || 'disabled (all IPs allowed)'}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  if (client) await client.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  if (client) await client.close();
  process.exit(0);
});
