// ============================================================
// IEE KPI Data API Server — Production
// Secured with: Helmet, Rate Limiting, API Key Auth, IP Allowlist
// ============================================================

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();

// ── Configuration (from environment variables) ─────────────
const CONFIG = {
  MONGO_URI: process.env.MONGO_URI,
  API_KEY: process.env.API_KEY,
  PORT: process.env.PORT || 3000,
  // Comma-separated list of allowed IPs (optional — leave empty to skip IP check)
  ALLOWED_IPS: process.env.ALLOWED_IPS || '',
  NODE_ENV: process.env.NODE_ENV || 'production'
};

// Validate required config
if (!CONFIG.MONGO_URI) {
  console.error('FATAL: MONGO_URI environment variable is required');
  process.exit(1);
}
if (!CONFIG.API_KEY) {
  console.error('FATAL: API_KEY environment variable is required');
  process.exit(1);
}

// ── Security Middleware ────────────────────────────────────
// Helmet: sets secure HTTP headers
app.use(helmet());

// CORS: restrict to Google Apps Script origin
app.use(cors({
  origin: ['https://script.google.com', 'https://script.googleusercontent.com'],
  methods: ['GET'],
  allowedHeaders: ['x-api-key', 'Content-Type']
}));

// Trust Railway proxy for accurate IP detection
app.set('trust proxy', 1);

// Rate limiting: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Limit: 60 per minute.' }
});
app.use(limiter);

// Parse JSON
app.use(express.json());

// ── IP Allowlist (optional) ────────────────────────────────
function ipCheck(req, res, next) {
  if (!CONFIG.ALLOWED_IPS) return next(); // Skip if not configured
  const allowedList = CONFIG.ALLOWED_IPS.split(',').map(ip => ip.trim());
  const clientIp = req.ip || req.connection.remoteAddress;
  if (allowedList.includes(clientIp)) return next();
  console.warn(`Blocked request from unauthorized IP: ${clientIp}`);
  return res.status(403).json({ error: 'Forbidden' });
}

// ── API Key Auth ───────────────────────────────────────────
function authCheck(req, res, next) {
  // Allow health check without auth
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== CONFIG.API_KEY) {
    console.warn(`Unauthorized request to ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' });
  }
  next();
}

app.use(ipCheck);
app.use(authCheck);

// ── MongoDB Connection Pool ────────────────────────────────
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

// ── Request Logger ─────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms [${req.ip}]`);
  });
  next();
});

// ═══════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════

// ── Health Check (no auth required) ────────────────────────
app.get('/health', async (req, res) => {
  try {
    const db = await getDb('orders');
    await db.command({ ping: 1 });
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: CONFIG.NODE_ENV });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── Collection Discovery ───────────────────────────────────
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

// ── KPI Segments ───────────────────────────────────────────
app.get('/kpi-segments', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365); // Cap at 365 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const db = await getDb('orders');
    const ordersCol = db.collection('orders');

    // Step 1: Get orders with Processing history entries in our date range
    // We use a two-pass approach for accuracy:
    // Pass 1 — get order IDs and their FULL history (needed to compute end times)
    // Pass 2 — extract Processing segments with computed durations

    const ordersPipeline = [
      {
        $match: {
          paymentStatus: 'paid',
          orderType: { $in: ['evaluation', 'translation'] },
          deletedAt: null,
          orderStatusHistory: { $exists: true, $not: { $size: 0 } }
        }
      },
      // Filter orders that have at least one history entry in our date range
      {
        $match: {
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

    // Step 2: Process each order's history to extract Processing segments
    const segments = [];

    for (const order of orders) {
      const history = order.orderStatusHistory || [];
      const reportCount = (order.reportItems || []).length;
      const reportName = (order.reportItems || [])[0]?.name || null;

      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        const statusType = entry.updatedStatus?.statusType;

        // Only Processing statuses
        if (statusType !== 'Processing') continue;

        // Only entries within our date range
        const entryDate = new Date(entry.createdAt);
        if (entryDate < cutoff) continue;

        // Compute end time from next entry
        const nextEntry = i + 1 < history.length ? history[i + 1] : null;
        const segmentEnd = nextEntry ? new Date(nextEntry.createdAt) : null;
        const durationSeconds = segmentEnd
          ? (segmentEnd.getTime() - entryDate.getTime()) / 1000
          : null;
        const durationMinutes = durationSeconds !== null
          ? Math.round(durationSeconds / 60 * 10) / 10
          : null;

        // Skip segments with zero or negative duration (data artifacts)
        if (durationSeconds !== null && durationSeconds <= 0) continue;

        const assigned = entry.assignedTo || {};
        const user = entry.user || {};

        segments.push({
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

    res.json({
      count: segments.length,
      orderCount: orders.length,
      dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: new Date().toISOString(),
      segments
    });

  } catch (err) {
    console.error('KPI segments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Credential Counts ──────────────────────────────────────
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

// ── QC Events ──────────────────────────────────────────────
app.get('/qc-events', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const db = await getDb('orders');

    // Try known collection names for QC discussions
    const collections = await db.listCollections().toArray();
    const collNames = collections.map(c => c.name);
    const qcCollectionName = [
      'order-discussions',
      'order-discussion',
      'order-discussion-entities',
      'orderdiscussions'
    ].find(name => collNames.includes(name));

    if (!qcCollectionName) {
      return res.json({
        error: 'QC collection not found. Available collections listed.',
        availableCollections: collNames,
        hint: 'Look for a collection containing order discussions/messages with errorType field'
      });
    }

    const qcCol = db.collection(qcCollectionName);

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

    // Format dates after aggregation
    const formattedEvents = events.map(evt => ({
      ...evt,
      createdAt: evt.createdAt ? new Date(evt.createdAt).toISOString() : null
    }));

    res.json({
      count: formattedEvents.length,
      collectionUsed: qcCollectionName,
      dateRange: { from: cutoff.toISOString(), to: new Date().toISOString() },
      refreshedAt: new Date().toISOString(),
      events: formattedEvents
    });

  } catch (err) {
    console.error('QC events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 404 Handler ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', availableEndpoints: ['/health', '/collections', '/kpi-segments', '/credential-counts', '/qc-events'] });
});

// ── Error Handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start Server ───────────────────────────────────────────
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`IEE KPI Data API running on port ${CONFIG.PORT}`);
  console.log(`Environment: ${CONFIG.NODE_ENV}`);
  console.log(`Rate limit: 60 requests/minute`);
  console.log(`IP allowlist: ${CONFIG.ALLOWED_IPS || 'disabled (all IPs allowed)'}`);
});

// Graceful shutdown
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
