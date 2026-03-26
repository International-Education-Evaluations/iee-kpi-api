#!/usr/bin/env node
// ============================================================
// IEE Ops Dashboard — One-Time Config Seed Script
// Seeds benchmarks, production hours, and user levels into
// the iee_dashboard MongoDB config collections.
//
// Usage:
//   node seed-config.js <BASE_URL> <JWT_TOKEN>
//
// Example:
//   node seed-config.js https://iee-kpi-api-production-3622.up.railway.app eyJhbGciOi...
//
// The JWT token must be from an admin user. Get one by logging in:
//   curl -X POST <BASE_URL>/auth/login \
//     -H 'Content-Type: application/json' \
//     -d '{"email":"your@email.com","password":"yourpass"}'
//
// This script is idempotent — safe to run multiple times.
// It uses upsert logic (team+status key) so existing records
// are updated, not duplicated.
// ============================================================

const BASE_URL = process.argv[2];
const TOKEN    = process.argv[3];

if (!BASE_URL || !TOKEN) {
  console.error('Usage: node seed-config.js <BASE_URL> <JWT_TOKEN>');
  console.error('  BASE_URL: e.g. https://iee-kpi-api-production-3622.up.railway.app');
  console.error('  JWT_TOKEN: from POST /auth/login response');
  process.exit(1);
}

// ─── BENCHMARKS (XpH targets per level) ───────────────────────
// From GAS v5.0 BENCHMARKS constant — confirmed values
const BENCHMARKS = [
  { team: 'Customer Support',    status: 'initial-review',                    xphUnit: 'Orders',      levels: { L0: null, L1: null, L2: 7,    L3: 7,    L4: null, L5: null } },
  { team: 'Data Entry',          status: 'eval-prep-processing',              xphUnit: 'Credentials', levels: { L0: null, L1: 2.5,  L2: 2.8,  L3: 3,    L4: null, L5: null } },
  { team: 'Digital Fulfillment', status: 'digital-fulfillment-processing',    xphUnit: 'Orders',      levels: { L0: null, L1: null, L2: 8,    L3: 9,    L4: null, L5: null } },
  { team: 'Digital Records',     status: 'digital-records-processing',        xphUnit: 'Orders',      levels: { L0: null, L1: 5,    L2: 6,    L3: 7,    L4: null, L5: null } },
  { team: 'Digital Records',     status: 'digital-records-review-processing', xphUnit: 'Orders',      levels: { L0: null, L1: 5,    L2: 6,    L3: 7,    L4: null, L5: null } },
  { team: 'Document Management', status: 'document-processing',               xphUnit: 'Orders',      levels: { L0: null, L1: null, L2: 5,    L3: 6,    L4: null, L5: null } },
  { team: 'Document Management', status: 'shipment-processing',               xphUnit: 'Orders',      levels: { L0: null, L1: null, L2: 7,    L3: 8.5,  L4: null, L5: null } },
  { team: 'Document Management', status: 'verification-processing',           xphUnit: 'Orders',      levels: { L0: null, L1: null, L2: 6,    L3: 8,    L4: null, L5: null } },
  { team: 'Evaluation',          status: 'senior-evaluation-review',          xphUnit: 'Reports',     levels: { L0: null, L1: null, L2: 3.32, L3: 3.32, L4: 3.62, L5: 4.6  } },
  { team: 'Evaluation',          status: 'initial-evaluation',                xphUnit: 'Reports',     levels: { L0: 1.22, L1: 1.41, L2: 1.53, L3: 1.53, L4: null, L5: null } },
  { team: 'Translations',        status: 'translation-prep',                  xphUnit: 'Orders',      levels: { L0: null, L1: 4,    L2: 4,    L3: null, L4: null, L5: null } },
  { team: 'Translations',        status: 'translation-review',                xphUnit: 'Orders',      levels: { L0: null, L1: 3,    L2: 3,    L3: null, L4: null, L5: null } },
];

// ─── PRODUCTION HOURS (net hours per day per level) ───────────
// From GAS v5.0 PRODUCTION_HOURS_DATA constant
const PRODUCTION_HOURS = [
  { team: 'Customer Support',    status: 'initial-review',                    levels: { L0: null, L1: null, L2: 1.5,  L3: 1.5,  L4: null, L5: null } },
  { team: 'Data Entry',          status: 'eval-prep-processing',              levels: { L0: null, L1: null, L2: 8.5,  L3: 8.5,  L4: null, L5: null } },
  { team: 'Digital Fulfillment', status: 'digital-fulfillment-processing',    levels: { L0: null, L1: null, L2: 6.5,  L3: 6.5,  L4: null, L5: null } },
  { team: 'Digital Records',     status: 'digital-records-processing',        levels: { L0: null, L1: 6,    L2: 5,    L3: 5,    L4: null, L5: null } },
  { team: 'Digital Records',     status: 'digital-records-review-processing', levels: { L0: null, L1: 6,    L2: 5,    L3: 5,    L4: null, L5: null } },
  { team: 'Document Management', status: 'document-processing',               levels: { L0: null, L1: null, L2: 5,    L3: 5,    L4: null, L5: null } },
  { team: 'Document Management', status: 'shipment-processing',               levels: { L0: null, L1: null, L2: 5,    L3: 5,    L4: null, L5: null } },
  { team: 'Document Management', status: 'verification-processing',           levels: { L0: null, L1: null, L2: 5,    L3: 5,    L4: null, L5: null } },
  { team: 'Evaluation',          status: 'senior-evaluation-review',          levels: { L0: null, L1: null, L2: 5.7,  L3: 5.7,  L4: 5.7,  L5: 5.7  } },
  { team: 'Evaluation',          status: 'initial-evaluation',                levels: { L0: 6.4,  L1: 6.4,  L2: 6.4,  L3: 6.4,  L4: null, L5: null } },
  { team: 'Translations',        status: 'translation-prep',                  levels: { L0: null, L1: 5,    L2: 5,    L3: null, L4: null, L5: null } },
  { team: 'Translations',        status: 'translation-review',                levels: { L0: null, L1: null, L2: null, L3: null, L4: null, L5: null } },
];

// ─── USER LEVELS (V1 ID → Level) ─────────────────────────────
// From GAS v5.0 SEED_LEVELS constant — ~60 users confirmed
const SEED_LEVELS = {
  "12":"L2","18":"L2","23":"L3","39":"L2","43":"L5","45":"L5",
  "46":"L2","53":"L2","62":"L2","69":"L2","73":"L4","74":"L1",
  "78":"L0","88":"L2","18993":"L4","55061":"L3","55505":"L1",
  "60442":"L2","60444":"L2","60446":"L2","71346":"L2","71348":"L2",
  "75608":"L1","77932":"L2","84664":"L4","86719":"L5","88486":"L0",
  "92510":"L2","119164":"L3","122088":"L5","126421":"L2","131527":"L2",
  "151395":"L2","151396":"L1","151397":"L2","169706":"L2","169707":"L1",
  "174425":"L1","237986":"L1","238594":"L2","240025":"L1","240415":"L1",
  "246199":"L1","247600":"L2","247601":"L2","249426":"L1","249427":"L1",
  "259225":"L2","262463":"L4","262973":"L1","262974":"L1","262975":"L1",
  "268288":"L1","268289":"L1","270211":"L0","270212":"L0","270213":"L0",
  "270214":"Unleveled","270216":"L0","270217":"L0","270218":"L0",
  "275028":"L1","278107":"L1","286714":"L2","291246":"L1",
  "303428":"L1","303429":"L0"
};

// ─── 5-BUCKET CLASSIFICATION THRESHOLDS ───────────────────────
// From GAS v5.1 / dim_benchmark confirmed values (seconds)
const THRESHOLDS = [
  { team: 'Customer Support',    status: 'initial-review',                    excludeShortSec: 180,  inRangeMinSec: 300,  inRangeMaxSec: 450,  excludeLongSec: 600  },
  { team: 'Data Entry',          status: 'eval-prep-processing',              excludeShortSec: 180,  inRangeMinSec: 240,  inRangeMaxSec: 3300, excludeLongSec: 4860 },
  { team: 'Digital Fulfillment', status: 'digital-fulfillment-processing',    excludeShortSec: 60,   inRangeMinSec: 90,   inRangeMaxSec: 936,  excludeLongSec: 1260 },
  { team: 'Digital Records',     status: 'digital-records-processing',        excludeShortSec: 180,  inRangeMinSec: 300,  inRangeMaxSec: 5400, excludeLongSec: 7200 },
  { team: 'Digital Records',     status: 'digital-records-review-processing', excludeShortSec: 300,  inRangeMinSec: 600,  inRangeMaxSec: 4500, excludeLongSec: 6000 },
  { team: 'Document Management', status: 'document-processing',               excludeShortSec: 90,   inRangeMinSec: 180,  inRangeMaxSec: 1080, excludeLongSec: 1500 },
  { team: 'Document Management', status: 'shipment-processing',               excludeShortSec: 72,   inRangeMinSec: 120,  inRangeMaxSec: 480,  excludeLongSec: 600  },
  { team: 'Document Management', status: 'verification-processing',           excludeShortSec: 72,   inRangeMinSec: 150,  inRangeMaxSec: 600,  excludeLongSec: 1500 },
  { team: 'Evaluation',          status: 'senior-evaluation-review',          excludeShortSec: 60,   inRangeMinSec: 90,   inRangeMaxSec: 2700, excludeLongSec: 7200 },
  { team: 'Evaluation',          status: 'initial-evaluation',                excludeShortSec: 120,  inRangeMinSec: 180,  inRangeMaxSec: 3900, excludeLongSec: 10500},
  { team: 'Translations',        status: 'translation-prep',                  excludeShortSec: 60,   inRangeMinSec: 90,   inRangeMaxSec: 2136, excludeLongSec: 3300 },
  { team: 'Translations',        status: 'translation-review',                excludeShortSec: 180,  inRangeMinSec: 240,  inRangeMaxSec: 3276, excludeLongSec: 3300 },
];

// ─── API HELPER ───────────────────────────────────────────────
async function post(path, body) {
  const url = BASE_URL.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function put(path, body) {
  const url = BASE_URL.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('IEE Ops Dashboard — Config Seed');
  console.log('Target:', BASE_URL);
  console.log('');

  // 1. Seed benchmarks (XpH targets)
  console.log('1/4  Seeding benchmarks (XpH targets)...');
  try {
    const r = await post('/config/benchmarks/seed', {
      benchmarks: BENCHMARKS,
      changedBy: 'seed-script'
    });
    console.log(`     ✓ ${r.upserted} benchmarks upserted`);
  } catch (e) {
    console.error('     ✗ Benchmarks failed:', e.message);
  }

  // 2. Seed production hours
  console.log('2/4  Seeding production hours...');
  try {
    const r = await post('/config/production-hours/seed', {
      hours: PRODUCTION_HOURS,
      changedBy: 'seed-script'
    });
    console.log(`     ✓ ${r.upserted} production hours upserted`);
  } catch (e) {
    console.error('     ✗ Production hours failed:', e.message);
  }

  // 3. Seed 5-bucket classification thresholds
  console.log('3/4  Seeding 5-bucket thresholds...');
  try {
    const r = await post('/config/benchmarks/thresholds/seed', {
      thresholds: THRESHOLDS,
      changedBy: 'seed-script'
    });
    console.log(`     ✓ ${r.updated} thresholds updated`);
  } catch (e) {
    console.error('     ✗ Thresholds failed:', e.message);
  }

  // 4. Seed user levels
  console.log('4/4  Seeding user levels...');
  const levelEntries = Object.entries(SEED_LEVELS).map(([v1Id, level]) => ({
    v1Id, level
  }));
  try {
    const r = await post('/config/user-levels/seed', {
      levels: levelEntries,
      changedBy: 'seed-script'
    });
    console.log(`     ✓ ${r.upserted} user levels seeded`);
  } catch (e) {
    console.error('     ✗ User levels failed:', e.message);
  }

  console.log('');
  console.log('Done! Verify in the dashboard Settings page.');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
