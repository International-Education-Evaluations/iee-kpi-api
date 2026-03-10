// ============================================================
// IEE KPI Data API Server — v3.0
// CHANGES from v2:
//   - /kpi-segments: reportItemCount now uses reportItems.length
//     (embedded on order doc — no separate collection needed)
//   - /credential-counts: added date filter (createdAt >= cutoff)
//   - /report-counts: REMOVED — data already in /kpi-segments
//   - /qc-events: patched to return diagnostic when no QC docs
//     found — order-discussion has no errorType field; real QC
//     collection TBD via /collections discovery
//   - MongoDB client: added retryWrites + retryReads for
//     transparent reconnect after connection drops
//   - Removed unused ObjectId import (no longer needed)
//   - Added /qc-discovery endpoint to identify real QC collection
// ============================================================

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { MongoClient } = require('mongodb');

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
      connectTimeoutMS: 10000,
      retryWrites: true,   // auto-retry on transient write failures
      retryReads: true     // auto-retry on transient read failures / reconnect
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
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: CONFIG.NODE_ENV, version: '3.0' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// —— Collection Discovery —————————————————————————————————
app.get('/collections', async (req, res) => {
  try {
    const dbNames = ['orders', 'payment', 'user', 'master', 'evaluation'];
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
//
// Report count source: orders.reportItems (embedded array on the order doc).
// This is the authoritative source — no separate collection join needed.
// reportItems[].name  = product name (e.g. "Education Course Report")
// reportItems.length  = report count used as XpH numerator for Evaluation
app.get('/kpi-segments', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 5000, 100), 10000);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

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
          reportItems: 1,          // embedded product array — used for report count + name
          orderStatusHistory: 1
        }
      }
    ];

    const orders = await ordersCol.aggregate(ordersPipeline, { allowDiskUse: true }).toArray();

    const allSegments = [];

    for (const order of orders) {
      const history = order.orderStatusHistory || [];

      // reportItems is embedded on the order — no separate collection needed.
      // Each element has: foreignKeyId, name (product name), slug
      const reportItems = order.reportItems || [];
      const reportItemCount = reportItems.length;
      // Use first report item name as the representative product name
      const reportItemName = reportItems[0]?.name || null;

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
          reportItemCount,
          reportItemName,
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

    // Pagination (in-memory — all segments built before slicing)
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
// Scoped to orders within the requested date window using credential createdAt.
// order-credentials.order is an ObjectId reference to orders._id.
app.get('/credential-counts', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const db = await getDb('orders');
    const credsCol = db.collection('order-credentials');

    const pipeline = [
      {
        $match: {
          active: true,
          createdAt: { $gte: cutoff },           // date-scoped — was missing in v2
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
        }
      },
      {
        $group: {
          _id: '$order',                          // ObjectId ref to orders._id
          credentialCount: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          orderId: { $toString: '$_id' },         // convert ObjectId to string for JSON
          credentialCount: 1
        }
      }
    ];

    const counts = await credsCol.aggregate(pipeline).toArray();
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

// —— QC Events ————————————————————————————————————————————
// NOTE: order-discussion does NOT contain QC/error data.
// Confirmed schema of order-discussion: { order, user, category, html, text, type }
// type values: 'discussion', 'system_logs' — no errorType, no isFixedIt fields.
// The real QC collection is unknown. Use /qc-discovery to identify it.
// This endpoint returns a diagnostic until the correct collection is confirmed.
app.get('/qc-events', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const db = await getDb('orders');

    // Attempt order-discussion — confirmed to have no QC fields
    const discussionCol = db.collection('order-discussion');
    const sampleDocs = await discussionCol.find({}).limit(3).toArray();
    const sampleKeys = sampleDocs.length > 0 ? Object.keys(sampleDocs[0]) : [];

    // Check if errorType field exists anywhere
    const withErrorType = await discussionCol.countDocuments({ errorType: { $exists: true } });

    res.status(200).json({
      status: 'collection_mismatch',
      message: 'order-discussion does not contain QC/error data. The real QC collection has not been identified yet.',
      diagnosis: {
        collectionChecked: 'order-discussion',
        documentCount: await discussionCol.countDocuments({}),
        fieldsFound: sampleKeys,
        docsWithErrorType: withErrorType,
        expectedFields: ['errorType', 'isFixedIt', 'errorAssignedTo', 'department']
      },
      action: 'Run GET /qc-discovery to identify which collection holds QC/error data',
      events: []
    });

  } catch (err) {
    console.error('QC events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// —— QC Discovery ————————————————————————————————————————
// Scans all collections in the orders DB looking for QC/error fields.
// Run once to identify the real QC collection, then update /qc-events.
app.get('/qc-discovery', async (req, res) => {
  try {
    const db = await getDb('orders');
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);

    const results = [];

    // QC-relevant field signals
    const qcFieldSignals = ['errorType', 'isFixedIt', 'isKickItBack', 'errorAssignedTo', 'kickback', 'qcError', 'qc_error', 'error_type'];

    for (const colName of collectionNames) {
      try {
        const col = db.collection(colName);
        const count = await col.countDocuments({});
        if (count === 0) continue;

        // Sample up to 2 docs to check fields
        const samples = await col.find({}).limit(2).toArray();
        const allKeys = new Set();
        samples.forEach(doc => Object.keys(doc).forEach(k => allKeys.add(k)));
        const keys = Array.from(allKeys);

        // Check for QC signals
        const matchedSignals = qcFieldSignals.filter(sig => keys.includes(sig));

        // Check for errorType specifically with a count
        let withErrorType = 0;
        if (keys.includes('errorType')) {
          withErrorType = await col.countDocuments({ errorType: { $exists: true, $ne: null } });
        }

        if (matchedSignals.length > 0 || colName.toLowerCase().includes('qc') || colName.toLowerCase().includes('error')) {
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

    // Sort by likely candidate score
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
        keys: { order: 1, active: 1, createdAt: 1, deletedAt: 1 },
        reason: 'Speeds up credential count grouping per order (now date-scoped)'
      },
      {
        database: 'orders',
        collection: 'order-discussion',
        name: 'discussion_order_lookup',
        keys: { order: 1, createdAt: -1 },
        reason: 'Supports order-level discussion lookups'
      }
    ]
  });
});

// —— 404 Handler ——————————————————————————————————————————
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: ['/health', '/collections', '/kpi-segments', '/credential-counts', '/qc-events', '/qc-discovery', '/indexes']
  });
});

// —— Error Handler ———————————————————————————————————————
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// —— Start ———————————————————————————————————————————————
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`IEE KPI Data API v3.0 running on port ${CONFIG.PORT}`);
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
