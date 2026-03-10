// ============================================================
// IEE KPI Dashboard — Google Apps Script v4.1
// Full automated setup: all data tabs, config tabs, summary
// pivot tabs, and charts. Run initialSetup() once to build
// the entire spreadsheet from scratch.
//
// MENU: IEE KPI → Initial Setup (run once)
//       IEE KPI → Refresh All Data (or use hourly trigger)
//
// CHANGES from prior version:
//   - Full initialSetup now creates ALL tabs automatically
//   - Summary pivot tabs auto-built: QC_By_Department,
//     QC_By_Issue, QC_By_User, KPI_By_User, KPI_By_Status
//   - Charts auto-inserted on summary tabs
//   - refreshKpiSegments: paginated loop (hasMore=false)
//   - refreshQcEvents: fixed field mapping (qcCreatedAt)
//   - refreshQcEvents: auto-rebuilds summary pivot tabs after load
//   - refreshKpiSegments: auto-rebuilds KPI pivot tabs after load
//   - credential-counts: date-scoped (?days= param)
//   - Discover QC Collection menu item restored
//   - All tabs color-coded by domain (blue=KPI, green=QC, grey=config)
// ============================================================

// ── Configuration ──────────────────────────────────────────
const CONFIG = {
  API_BASE_URL: 'https://iee-kpi-api-production-3622.up.railway.app',
  API_KEY: 'REPLACE_WITH_YOUR_API_KEY',
  DAYS: 60,
  PAGE_SIZE: 5000
};

// ── Tab Registry ───────────────────────────────────────────
// Defined in desired left-to-right tab order — inserted in this sequence.
// color: hex tab color
const TAB_DEFS = {
  // ── KPI tabs ─────────────────────────────────────────────
  KPI_SEGMENTS:       { color: '#1F4E79', freeze: 2 },
  KPI_BY_USER:        { color: '#1F4E79', freeze: 1 },
  KPI_BY_STATUS:      { color: '#1F4E79', freeze: 1 },
  // ── QC tabs ──────────────────────────────────────────────
  QC_EVENTS:          { color: '#1B5E20', freeze: 2 },
  QC_BY_DEPARTMENT:   { color: '#1B5E20', freeze: 1 },
  QC_BY_ISSUE:        { color: '#1B5E20', freeze: 1 },
  QC_BY_USER:         { color: '#1B5E20', freeze: 1 },
  // ── Config tabs ──────────────────────────────────────────
  BENCHMARK_CONFIG:   { color: '#4A4A4A', freeze: 1 },
  USER_LEVELS:        { color: '#4A4A4A', freeze: 1 },
  REFRESH_LOG:        { color: '#4A4A4A', freeze: 1 }
};

const HEADER_BG    = '#1F4E79';
const HEADER_FG    = '#FFFFFF';
const QC_HEADER_BG = '#1B5E20';
const CFG_HEADER_BG = '#37474F';

// ── Benchmarks seed data ───────────────────────────────────
const BENCHMARKS = [
  ['Customer Support',    'initial-review',                    'Orders',      '', '',   7,    7,    '',   ''  ],
  ['Data Entry',          'eval-prep-processing',              'Credentials', '', 2.5,  2.8,  3,    '',   ''  ],
  ['Digital Fulfillment', 'digital-fulfillment-processing',    'Orders',      '', '',   8,    9,    '',   ''  ],
  ['Digital Records',     'digital-records-processing',        'Orders',      '', 5,    6,    7,    '',   ''  ],
  ['Digital Records',     'digital-records-review-processing', 'Orders',      '', 5,    6,    7,    '',   ''  ],
  ['Document Management', 'document-processing',               'Orders',      '', '',   5,    6,    '',   ''  ],
  ['Document Management', 'shipment-processing',               'Orders',      '', '',   7,    8.5,  '',   ''  ],
  ['Document Management', 'verification-processing',           'Orders',      '', '',   6,    8,    '',   ''  ],
  ['Evaluation',          'senior-evaluation-review',          'Reports',     '', '',   3.32, 3.32, 3.62, 4.6 ],
  ['Evaluation',          'initial-evaluation',                'Reports',     1.22, 1.41, 1.53, 1.53, '', '' ],
  ['Translations',        'translation-prep',                  'Orders',      '', 4,    4,    '',   '',   ''  ],
  ['Translations',        'translation-review',                'Orders',      '', 3,    3,    '',   '',   ''  ],
];

// ═══════════════════════════════════════════════════════════
// INITIAL SETUP — run once to build the entire spreadsheet
// ═══════════════════════════════════════════════════════════
function initialSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Building spreadsheet structure...', 'IEE KPI Setup', -1);

  // Create all tabs if they don't exist, set tab colors
  for (const [name, def] of Object.entries(TAB_DEFS)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.setTabColor(def.color);
  }

  // Build each tab
  setupKpiSegmentsTab_(ss);
  setupQcEventsTab_(ss);
  setupBenchmarkConfigTab_(ss);
  setupUserLevelsTab_(ss);
  setupRefreshLogTab_(ss);
  setupKpiByUserTab_(ss);
  setupKpiByStatusTab_(ss);
  setupQcByDepartmentTab_(ss);
  setupQcByIssueTab_(ss);
  setupQcByUserTab_(ss);

  // Note: tab reordering via GAS API requires UI context and is unreliable
  // when run from the script editor. Tabs are created in the logical order
  // defined in TAB_DEFS above (KPI → QC → Config), which is correct as-is.

  // Set up hourly auto-refresh trigger
  deleteExistingTriggers_();
  ScriptApp.newTrigger('refreshAllData').timeBased().everyHours(1).create();

  ss.toast('Setup complete! Run "Refresh All Data" to load data.', 'IEE KPI Setup', 10);
}

// ── Tab setup helpers ──────────────────────────────────────

function setupKpiSegmentsTab_(ss) {
  const sheet = ss.getSheetByName('KPI_SEGMENTS');
  sheet.clear();
  sheet.getRange('A1').setValue('Last Refreshed:');
  sheet.getRange('B1').setValue('Not yet refreshed');
  sheet.getRange('C1').setValue('Days Window:');
  sheet.getRange('D1').setValue(CONFIG.DAYS);
  const headers = [
    'Order Serial', 'Order Type', 'Report Type', 'Report Count',
    'Status Slug', 'Status Name', 'Worker Name', 'Worker Email',
    'Segment Start (UTC)', 'Segment End (UTC)',
    'Duration (min)', 'Duration (sec)', 'Is Open',
    'Is Error Reporting', 'Changed By',
    'Credential Count', 'XpH Unit', 'XpH Numerator', 'Parent Order ID'
  ];
  const hdrRange = sheet.getRange(2, 1, 1, headers.length);
  hdrRange.setValues([headers]).setFontWeight('bold')
    .setBackground(HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 120);  // Order Serial
  sheet.setColumnWidth(7, 150);  // Worker Name
  sheet.setColumnWidth(9, 160);  // Segment Start
  sheet.setColumnWidth(10, 160); // Segment End
}

function setupQcEventsTab_(ss) {
  const sheet = ss.getSheetByName('QC_EVENTS');
  sheet.clear();
  sheet.getRange('A1').setValue('Last Refreshed:');
  sheet.getRange('B1').setValue('Not yet refreshed');
  sheet.getRange('C1').setValue('Days Window:');
  sheet.getRange('D1').setValue(CONFIG.DAYS);
  const headers = [
    'Order ID', 'Order Serial', 'Error Type', 'Is Fixed It', 'Is Kick It Back',
    'Reporter Name', 'Accountable User', 'Accountable User ID',
    'Department', 'Issue', 'Issue Custom Text',
    'Status At QC', 'Next Status', 'Mins to Next Status',
    'QC Created At (UTC)', 'Order Type', 'QC Event ID'
  ];
  const hdrRange = sheet.getRange(2, 1, 1, headers.length);
  hdrRange.setValues([headers]).setFontWeight('bold')
    .setBackground(QC_HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(6, 150);  // Reporter Name
  sheet.setColumnWidth(7, 150);  // Accountable User
  sheet.setColumnWidth(9, 140);  // Department
  sheet.setColumnWidth(10, 200); // Issue
  sheet.setColumnWidth(15, 160); // QC Created At
}

function setupBenchmarkConfigTab_(ss) {
  const sheet = ss.getSheetByName('BENCHMARK_CONFIG');
  sheet.clear();
  const headers = ['TEAM', 'STATUS', 'XPH_UNIT', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(CFG_HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(1);
  sheet.getRange(2, 1, BENCHMARKS.length, BENCHMARKS[0].length).setValues(BENCHMARKS);
  sheet.getRange(1, 1, BENCHMARKS.length + 1, 9).setBorder(true, true, true, true, true, true);
  sheet.setColumnWidth(1, 160); // Team
  sheet.setColumnWidth(2, 220); // Status
}

function setupUserLevelsTab_(ss) {
  const sheet = ss.getSheetByName('USER_LEVELS');
  sheet.clear();
  const headers = ['USER_ID', 'USER_NAME', 'DEPARTMENT', 'LEVEL', 'EFFECTIVE_DATE', 'NOTES'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(CFG_HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(1);
  // Note row
  sheet.getRange('A2').setValue('← Populate from staff roster. LEVEL = L0/L1/L2/L3/L4/L5. USER_ID must match workerUserId from API.');
  sheet.getRange('A2').setFontStyle('italic').setFontColor('#888888');
}

function setupRefreshLogTab_(ss) {
  const sheet = ss.getSheetByName('REFRESH_LOG');
  sheet.clear();
  const headers = ['Timestamp', 'Type', 'Rows', 'Status', 'Details'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(CFG_HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(5, 400);
}

function setupKpiByUserTab_(ss) {
  const sheet = ss.getSheetByName('KPI_BY_USER');
  sheet.clear();
  sheet.getRange('A1').setValue('KPI Summary by Worker — auto-built on each refresh. Do not edit.');
  sheet.getRange('A1').setFontStyle('italic').setFontColor('#888888');
  const headers = [
    'Worker Name', 'Worker Email', 'Order Type',
    'Segment Count', 'Avg Duration (min)', 'Total Duration (hr)',
    'Open Segments', 'Error Reporting Segments'
  ];
  sheet.getRange(2, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 200);
}

function setupKpiByStatusTab_(ss) {
  const sheet = ss.getSheetByName('KPI_BY_STATUS');
  sheet.clear();
  sheet.getRange('A1').setValue('KPI Summary by Status — auto-built on each refresh. Do not edit.');
  sheet.getRange('A1').setFontStyle('italic').setFontColor('#888888');
  const headers = [
    'Status Slug', 'Status Name', 'XpH Unit',
    'Segment Count', 'Avg Duration (min)', 'Total Duration (hr)',
    'Open Segments', 'Unique Workers'
  ];
  sheet.getRange(2, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 200);
}

function setupQcByDepartmentTab_(ss) {
  const sheet = ss.getSheetByName('QC_BY_DEPARTMENT');
  sheet.clear();
  sheet.getRange('A1').setValue('QC Summary by Department — auto-built on each refresh. Do not edit.');
  sheet.getRange('A1').setFontStyle('italic').setFontColor('#888888');
  const headers = [
    'Department', 'Total Events', 'Fixed It', 'Kick It Back',
    '% Fixed It', '% Kick It Back', 'Unique Orders', 'Unique Accountable Users'
  ];
  sheet.getRange(2, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(QC_HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 180);
}

function setupQcByIssueTab_(ss) {
  const sheet = ss.getSheetByName('QC_BY_ISSUE');
  sheet.clear();
  sheet.getRange('A1').setValue('QC Summary by Issue Category — auto-built on each refresh. Do not edit.');
  sheet.getRange('A1').setFontStyle('italic').setFontColor('#888888');
  const headers = [
    'Issue', 'Department', 'Total Events', 'Fixed It', 'Kick It Back',
    '% Fixed It', '% Kick It Back', 'Unique Orders'
  ];
  sheet.getRange(2, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(QC_HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 250);
  sheet.setColumnWidth(2, 160);
}

function setupQcByUserTab_(ss) {
  const sheet = ss.getSheetByName('QC_BY_USER');
  sheet.clear();
  sheet.getRange('A1').setValue('QC Summary by Accountable User — auto-built on each refresh. Do not edit.');
  sheet.getRange('A1').setFontStyle('italic').setFontColor('#888888');
  const headers = [
    'Accountable User', 'Department', 'Total Errors', 'Fixed It', 'Kick It Back',
    '% Fixed It', '% Kick It Back', 'Unique Orders', 'Issues (distinct)'
  ];
  sheet.getRange(2, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold')
    .setBackground(QC_HEADER_BG).setFontColor(HEADER_FG);
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(9, 200);
}

// ═══════════════════════════════════════════════════════════
// REFRESH — runs on hourly trigger and manual menu call
// ═══════════════════════════════════════════════════════════
function refreshAllData() {
  try {
    refreshKpiSegments();
    Utilities.sleep(2000);
    refreshQcEvents();
    SpreadsheetApp.getActiveSpreadsheet().toast('Data refresh complete!', 'IEE KPI', 5);
  } catch (err) {
    logRefresh_('ALL', 0, 'ERROR', err.message);
    throw err;
  }
}

// ── KPI Segments Refresh ───────────────────────────────────
function refreshKpiSegments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('KPI_SEGMENTS');

  // Step 1: Credential counts — date-scoped to match segment window
  let credMap = {};
  try {
    const credData = apiCall_('/credential-counts?days=' + CONFIG.DAYS);
    for (const c of (credData.credentials || [])) credMap[c.orderId] = c.credentialCount;
    logRefresh_('Credential_Counts', credData.count || 0, 'OK',
      (credData.count || 0) + ' orders | window: ' +
      (credData.dateRange ? credData.dateRange.from.substring(0, 10) : 'unknown'));
  } catch (e) {
    logRefresh_('Credential_Counts', 0, 'WARN', 'Failed: ' + e.message);
  }

  // Step 2: XpH unit lookup from Benchmark_Config tab
  const benchSheet = ss.getSheetByName('BENCHMARK_CONFIG');
  const benchData = benchSheet.getDataRange().getValues();
  const xphUnitMap = {};
  for (let i = 1; i < benchData.length; i++) {
    if (benchData[i][1]) xphUnitMap[benchData[i][1]] = benchData[i][2];
  }

  // Step 3: Paginated segment fetch
  const allRows = [];
  let page = 1;
  let orderCount = 0;

  do {
    const segData = apiCall_(
      '/kpi-segments?days=' + CONFIG.DAYS +
      '&page=' + page +
      '&pageSize=' + CONFIG.PAGE_SIZE
    );
    if (page === 1) orderCount = segData.orderCount || 0;

    for (const seg of (segData.segments || [])) {
      const xphUnit = xphUnitMap[seg.statusSlug] || 'Orders';
      const credCount = credMap[seg.orderId] || 0;
      let xphNumerator = 1;
      if (xphUnit === 'Reports')     xphNumerator = seg.reportItemCount || 1;
      if (xphUnit === 'Credentials') xphNumerator = credCount || 1;

      allRows.push([
        seg.orderSerialNumber    || '',
        seg.orderType            || '',
        seg.reportItemName       || '',
        seg.reportItemCount      || 0,
        seg.statusSlug           || '',
        seg.statusName           || '',
        seg.workerName           || 'UNATTRIBUTED',
        seg.workerEmail          || '',
        seg.segmentStart         || '',
        seg.segmentEnd           || '',
        seg.durationMinutes      !== null ? seg.durationMinutes : '',
        seg.durationSeconds      !== null ? seg.durationSeconds : '',
        seg.isOpen               ? 'TRUE' : 'FALSE',
        seg.isErrorReporting     ? 'TRUE' : 'FALSE',
        seg.changedByName        || '',
        credCount,
        xphUnit,
        xphNumerator,
        seg.parentOrderId        || ''
      ]);
    }

    Logger.log('KPI page ' + page + '/' + segData.totalPages + ' — ' +
      (segData.segments || []).length + ' segments');
    if (!segData.hasMore) break;
    page++;
    Utilities.sleep(500);
  } while (true);

  // Step 4: Write to sheet
  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, sheet.getLastColumn()).clearContent();
  }
  if (allRows.length > 0) {
    sheet.getRange(3, 1, allRows.length, allRows[0].length).setValues(allRows);
  }
  sheet.getRange('B1').setValue(new Date().toISOString());
  logRefresh_('KPI_Segments', allRows.length, 'OK',
    orderCount + ' orders | ' + allRows.length + ' segments | ' + page + ' page(s)');

  // Step 5: Rebuild KPI pivot summaries
  try { buildKpiByUserPivot_(ss, allRows); } catch(e) { logRefresh_('KPI_By_User_Pivot', 0, 'WARN', e.message); }
  try { buildKpiByStatusPivot_(ss, allRows, xphUnitMap); } catch(e) { logRefresh_('KPI_By_Status_Pivot', 0, 'WARN', e.message); }
}

// ── QC Events Refresh ──────────────────────────────────────
function refreshQcEvents() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('QC_EVENTS');

  const qcData = apiCall_(
    '/qc-events?days=' + CONFIG.DAYS + '&includeHtml=false&includeText=false'
  );

  // Guard: v3.0 collection_mismatch diagnostic (no longer expected from v4.0 server)
  if (qcData.status === 'collection_mismatch') {
    logRefresh_('QC_Events', 0, 'WARN',
      'Collection mismatch — run Discover QC Collection from IEE KPI menu');
    sheet.getRange('B1').setValue('Collection mismatch — run Discover QC Collection');
    return;
  }

  if (qcData.error) {
    logRefresh_('QC_Events', 0, 'ERROR', qcData.error);
    sheet.getRange('B1').setValue('Error — check REFRESH_LOG tab');
    return;
  }

  // Map event fields — qcCreatedAt is the correct field (not createdAt)
  const rows = (qcData.events || []).map(evt => [
    evt.orderId              || '',
    evt.orderSerialNumber    || '',    // added v4.0
    evt.errorType            || '',
    evt.isFixedIt            ? 'TRUE' : 'FALSE',
    evt.isKickItBack         ? 'TRUE' : 'FALSE',
    (evt.reporterName        || '').trim(),
    (evt.accountableName     || '').trim(),
    evt.accountableUserId    || '',
    evt.departmentName       || '',
    evt.issueName            || '',
    evt.issueCustomText      || '',
    evt.statusAtQcName       || '',
    evt.nextStatusName       || '',
    evt.minutesToNextStatusChange !== null ? evt.minutesToNextStatusChange : '',
    evt.qcCreatedAt          || '',    // v4.0 fix: was evt.createdAt in prior GAS
    evt.orderType            || '',
    evt.qcEventId            || ''
  ]);

  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, sheet.getLastColumn()).clearContent();
  }
  if (rows.length > 0) {
    sheet.getRange(3, 1, rows.length, rows[0].length).setValues(rows);
  }
  sheet.getRange('B1').setValue(new Date().toISOString());
  logRefresh_('QC_Events', rows.length, 'OK',
    rows.length + ' events | ' +
    (qcData.orderCount || 0) + ' orders | collection: ' +
    (qcData.collectionUsed || 'unknown'));

  // Rebuild QC pivot summaries
  try { buildQcByDepartmentPivot_(ss, rows); } catch(e) { logRefresh_('QC_Dept_Pivot', 0, 'WARN', e.message); }
  try { buildQcByIssuePivot_(ss, rows); } catch(e) { logRefresh_('QC_Issue_Pivot', 0, 'WARN', e.message); }
  try { buildQcByUserPivot_(ss, rows); } catch(e) { logRefresh_('QC_User_Pivot', 0, 'WARN', e.message); }
}

// ═══════════════════════════════════════════════════════════
// PIVOT BUILDERS — called after each data refresh
// Column index reference (0-based) for QC_EVENTS rows:
//   0=orderId, 1=orderSerial, 2=errorType, 3=isFixedIt, 4=isKickItBack
//   5=reporterName, 6=accountableName, 7=accountableUserId
//   8=department, 9=issue, 10=issueCustomText
//   11=statusAtQc, 12=nextStatus, 13=minsToNext
//   14=qcCreatedAt, 15=orderType, 16=qcEventId
//
// Column index reference (0-based) for KPI_SEGMENTS rows:
//   0=orderSerial, 1=orderType, 2=reportType, 3=reportCount
//   4=statusSlug, 5=statusName, 6=workerName, 7=workerEmail
//   8=segStart, 9=segEnd, 10=durationMin, 11=durationSec
//   12=isOpen, 13=isErrorReporting, 14=changedBy
//   15=credCount, 16=xphUnit, 17=xphNumerator, 18=parentOrderId
// ═══════════════════════════════════════════════════════════

function buildKpiByUserPivot_(ss, rows) {
  const sheet = ss.getSheetByName('KPI_BY_USER');
  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 8).clearContent();
  }
  if (!rows.length) return;

  // Aggregate by workerName + workerEmail + orderType
  const map = new Map();
  for (const r of rows) {
    const key = (r[6] || 'UNATTRIBUTED') + '||' + (r[7] || '') + '||' + (r[1] || '');
    if (!map.has(key)) {
      map.set(key, {
        name: r[6] || 'UNATTRIBUTED',
        email: r[7] || '',
        orderType: r[1] || '',
        count: 0, totalMin: 0, openCount: 0, errorCount: 0
      });
    }
    const b = map.get(key);
    b.count++;
    if (r[10] !== '' && r[10] !== null) b.totalMin += Number(r[10]) || 0;
    if (r[12] === 'TRUE') b.openCount++;
    if (r[13] === 'TRUE') b.errorCount++;
  }

  const pivotRows = [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map(v => [
      v.name, v.email, v.orderType,
      v.count,
      v.count ? Math.round((v.totalMin / v.count) * 10) / 10 : '',
      Math.round((v.totalMin / 60) * 10) / 10,
      v.openCount, v.errorCount
    ]);

  sheet.getRange(3, 1, pivotRows.length, 8).setValues(pivotRows);
}

function buildKpiByStatusPivot_(ss, rows, xphUnitMap) {
  const sheet = ss.getSheetByName('KPI_BY_STATUS');
  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 8).clearContent();
  }
  if (!rows.length) return;

  const map = new Map();
  for (const r of rows) {
    const slug = r[4] || '(unknown)';
    if (!map.has(slug)) {
      map.set(slug, {
        slug, name: r[5] || '', xphUnit: xphUnitMap[slug] || 'Orders',
        count: 0, totalMin: 0, openCount: 0, workers: new Set()
      });
    }
    const b = map.get(slug);
    b.count++;
    if (r[10] !== '' && r[10] !== null) b.totalMin += Number(r[10]) || 0;
    if (r[12] === 'TRUE') b.openCount++;
    if (r[6]) b.workers.add(r[6]);
  }

  const pivotRows = [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map(v => [
      v.slug, v.name, v.xphUnit,
      v.count,
      v.count ? Math.round((v.totalMin / v.count) * 10) / 10 : '',
      Math.round((v.totalMin / 60) * 10) / 10,
      v.openCount, v.workers.size
    ]);

  sheet.getRange(3, 1, pivotRows.length, 8).setValues(pivotRows);
}

function buildQcByDepartmentPivot_(ss, rows) {
  const sheet = ss.getSheetByName('QC_BY_DEPARTMENT');
  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 8).clearContent();
  }
  if (!rows.length) return;

  const map = new Map();
  for (const r of rows) {
    const dept = r[8] || '(blank)';
    if (!map.has(dept)) {
      map.set(dept, { dept, total: 0, fixedIt: 0, kickBack: 0, orders: new Set(), users: new Set() });
    }
    const b = map.get(dept);
    b.total++;
    if (r[3] === 'TRUE') b.fixedIt++;
    if (r[4] === 'TRUE') b.kickBack++;
    if (r[0]) b.orders.add(r[0]);
    if (r[6]) b.users.add(r[6]);
  }

  const pivotRows = [...map.values()]
    .sort((a, b) => b.total - a.total)
    .map(v => [
      v.dept, v.total, v.fixedIt, v.kickBack,
      v.total ? (Math.round(v.fixedIt / v.total * 1000) / 10) + '%' : '',
      v.total ? (Math.round(v.kickBack / v.total * 1000) / 10) + '%' : '',
      v.orders.size, v.users.size
    ]);

  sheet.getRange(3, 1, pivotRows.length, 8).setValues(pivotRows);

  // Bar chart: events by department
  buildBarChart_(sheet, 'QC Events by Department',
    { row: 2, col: 1 }, { row: pivotRows.length + 2, col: 2 },
    'Department', 'Event Count', 20, 2);
}

function buildQcByIssuePivot_(ss, rows) {
  const sheet = ss.getSheetByName('QC_BY_ISSUE');
  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 8).clearContent();
  }
  if (!rows.length) return;

  const map = new Map();
  for (const r of rows) {
    const issue = r[9] || '(blank)';
    const dept  = r[8] || '';
    const key = issue + '||' + dept;
    if (!map.has(key)) {
      map.set(key, { issue, dept, total: 0, fixedIt: 0, kickBack: 0, orders: new Set() });
    }
    const b = map.get(key);
    b.total++;
    if (r[3] === 'TRUE') b.fixedIt++;
    if (r[4] === 'TRUE') b.kickBack++;
    if (r[0]) b.orders.add(r[0]);
  }

  const pivotRows = [...map.values()]
    .sort((a, b) => b.total - a.total)
    .map(v => [
      v.issue, v.dept, v.total, v.fixedIt, v.kickBack,
      v.total ? (Math.round(v.fixedIt / v.total * 1000) / 10) + '%' : '',
      v.total ? (Math.round(v.kickBack / v.total * 1000) / 10) + '%' : '',
      v.orders.size
    ]);

  sheet.getRange(3, 1, pivotRows.length, 8).setValues(pivotRows);
}

function buildQcByUserPivot_(ss, rows) {
  const sheet = ss.getSheetByName('QC_BY_USER');
  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 9).clearContent();
  }
  if (!rows.length) return;

  const map = new Map();
  for (const r of rows) {
    const user = r[6] || '(unattributed)';
    const dept = r[8] || '';
    const key = user + '||' + dept;
    if (!map.has(key)) {
      map.set(key, { user, dept, total: 0, fixedIt: 0, kickBack: 0, orders: new Set(), issues: new Set() });
    }
    const b = map.get(key);
    b.total++;
    if (r[3] === 'TRUE') b.fixedIt++;
    if (r[4] === 'TRUE') b.kickBack++;
    if (r[0]) b.orders.add(r[0]);
    if (r[9]) b.issues.add(r[9]);
  }

  const pivotRows = [...map.values()]
    .sort((a, b) => b.total - a.total)
    .map(v => [
      v.user, v.dept, v.total, v.fixedIt, v.kickBack,
      v.total ? (Math.round(v.fixedIt / v.total * 1000) / 10) + '%' : '',
      v.total ? (Math.round(v.kickBack / v.total * 1000) / 10) + '%' : '',
      v.orders.size,
      [...v.issues].sort().join(', ')
    ]);

  sheet.getRange(3, 1, pivotRows.length, 9).setValues(pivotRows);

  // Bar chart: top error contributors
  buildBarChart_(sheet, 'QC Errors by Accountable User',
    { row: 2, col: 1 }, { row: Math.min(pivotRows.length + 2, 22), col: 3 },
    'User', 'Error Count', 20, 2);
}

// ── Chart builder helper ───────────────────────────────────
// Inserts a basic bar chart on the given sheet using the specified data range.
// anchorRow/Col: where to place the chart on the sheet (1-indexed).
function buildBarChart_(sheet, title, labelRange, valueRange, xTitle, yTitle, anchorRow, anchorCol) {
  try {
    // Remove existing chart with same title if present
    sheet.getCharts().forEach(c => {
      if (c.getOptions().get('title') === title) sheet.removeChart(c);
    });

    const dataRange = sheet.getRange(
      labelRange.row, labelRange.col,
      valueRange.row - labelRange.row + 1,
      valueRange.col - labelRange.col + 1
    );

    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.BAR)
      .addRange(dataRange)
      .setPosition(anchorRow, anchorCol + 9, 0, 0)
      .setOption('title', title)
      .setOption('hAxis.title', yTitle)
      .setOption('vAxis.title', xTitle)
      .setOption('legend', { position: 'none' })
      .setOption('width', 480)
      .setOption('height', 300)
      .build();

    sheet.insertChart(chart);
  } catch (e) {
    // Chart build is best-effort — don't fail the whole refresh
    Logger.log('Chart build failed for "' + title + '": ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function apiCall_(endpoint) {
  const url = CONFIG.API_BASE_URL + endpoint;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'x-api-key': CONFIG.API_KEY },
    muteHttpExceptions: true,
    connectTimeout: 30000,
    timeout: 120000
  });
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('API returned ' + code + ': ' +
      response.getContentText().substring(0, 500));
  }
  return JSON.parse(response.getContentText());
}

function logRefresh_(type, rows, status, details) {
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('REFRESH_LOG');
  if (!logSheet) return;
  logSheet.insertRowAfter(1);
  logSheet.getRange(2, 1, 1, 5).setValues([
    [new Date().toISOString(), type, rows, status, details]
  ]);
  if (logSheet.getLastRow() > 501) logSheet.deleteRows(502, logSheet.getLastRow() - 501);
}

function deleteExistingTriggers_() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'refreshAllData') ScriptApp.deleteTrigger(t);
  }
}

// ═══════════════════════════════════════════════════════════
// MENU
// ═══════════════════════════════════════════════════════════
function onOpen() {
  SpreadsheetApp.getActiveSpreadsheet().addMenu('IEE KPI', [
    { name: 'Refresh All Data',          functionName: 'refreshAllData' },
    { name: 'Refresh KPI Only',          functionName: 'refreshKpiSegments' },
    { name: 'Refresh QC Only',           functionName: 'refreshQcEvents' },
    null,
    { name: 'Rebuild KPI Pivot Tabs',    functionName: 'rebuildKpiPivots' },
    { name: 'Rebuild QC Pivot Tabs',     functionName: 'rebuildQcPivots' },
    null,
    { name: 'Refresh Users',             functionName: 'refreshUsers' },
    { name: 'Test API Connection',       functionName: 'testConnection' },
    { name: 'Discover QC Collection',    functionName: 'testQcDiscovery' },
    null,
    { name: 'Initial Setup (run once)',  functionName: 'initialSetup' }
  ]);
}

// Standalone pivot rebuilds — useful if you want to refresh summaries
// without hitting the API again (e.g., re-running after fixing a pivot bug)
function rebuildKpiPivots() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('KPI_SEGMENTS');
  if (sheet.getLastRow() < 3) {
    SpreadsheetApp.getActiveSpreadsheet().toast('No KPI data loaded yet.', 'IEE KPI', 5);
    return;
  }
  const rows = sheet.getRange(3, 1, sheet.getLastRow() - 2, 19).getValues();

  const benchSheet = ss.getSheetByName('BENCHMARK_CONFIG');
  const benchData = benchSheet.getDataRange().getValues();
  const xphUnitMap = {};
  for (let i = 1; i < benchData.length; i++) {
    if (benchData[i][1]) xphUnitMap[benchData[i][1]] = benchData[i][2];
  }

  buildKpiByUserPivot_(ss, rows);
  buildKpiByStatusPivot_(ss, rows, xphUnitMap);
  SpreadsheetApp.getActiveSpreadsheet().toast('KPI pivot tabs rebuilt.', 'IEE KPI', 5);
}

function rebuildQcPivots() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('QC_EVENTS');
  if (sheet.getLastRow() < 3) {
    SpreadsheetApp.getActiveSpreadsheet().toast('No QC data loaded yet.', 'IEE KPI', 5);
    return;
  }
  const rows = sheet.getRange(3, 1, sheet.getLastRow() - 2, 17).getValues();
  buildQcByDepartmentPivot_(ss, rows);
  buildQcByIssuePivot_(ss, rows);
  buildQcByUserPivot_(ss, rows);
  SpreadsheetApp.getActiveSpreadsheet().toast('QC pivot tabs rebuilt.', 'IEE KPI', 5);
}


// ── Users Refresh ──────────────────────────────────────────
// Populates USER_LEVELS tab from MongoDB user.user collection.
// Preserves any manually entered LEVEL values for existing users.
function refreshUsers() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('USER_LEVELS');

  const data = apiCall_('/users');

  // Build a map of existing LEVEL values keyed by userId so we
  // don't overwrite levels that have been manually set
  const existingLevels = {};
  if (sheet.getLastRow() > 1) {
    const existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    for (const row of existing) {
      if (row[0] && row[3]) existingLevels[row[0]] = row[3]; // userId → LEVEL
    }
  }

  // Filter to staff only (isStaff flag set by server)
  const users = (data.users || []).filter(u => u.isStaff);

  const rows = users.map(u => [
    u.userId,                          // A: USER_ID (ObjectId — QC join key)
    u.v1Id || '',                      // B: V1_ID (MySQL — KPI join key)
    u.fullName,                        // C: USER_NAME
    u.email,                           // D: EMAIL
    u.department,                      // E: DEPARTMENT
    u.tags,                            // F: TAGS (Team Lead, etc.)
    existingLevels[u.userId] || '',    // G: LEVEL (preserved if already set)
    u.type,                            // H: TYPE
    u.active ? 'TRUE' : 'FALSE'        // I: ACTIVE
  ]);

  // Rebuild the tab with updated headers to match new columns
  sheet.clear();
  const headers = [
    'USER_ID', 'V1_ID', 'USER_NAME', 'EMAIL',
    'DEPARTMENT', 'TAGS', 'LEVEL', 'TYPE', 'ACTIVE'
  ];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#37474F')
    .setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 200);  // USER_ID
  sheet.setColumnWidth(3, 160);  // USER_NAME
  sheet.setColumnWidth(4, 200);  // EMAIL
  sheet.setColumnWidth(5, 140);  // DEPARTMENT
  sheet.setColumnWidth(6, 200);  // TAGS

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  logRefresh_('Users', rows.length, 'OK',
    rows.length + ' staff users | ' + data.count + ' total active');
  SpreadsheetApp.getActiveSpreadsheet()
    .toast(rows.length + ' staff users loaded into USER_LEVELS.', 'IEE KPI', 5);
}

function testConnection() {
  try {
    const result = apiCall_('/health');
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Connected! API v' + result.version + ' | Status: ' + result.status,
      'API Test', 5
    );
  } catch (err) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Failed: ' + err.message, 'API Test', 10);
  }
}

function testQcDiscovery() {
  try {
    const result = apiCall_('/qc-discovery');
    const top = (result.candidates || []).slice(0, 3);
    const msg = 'Scanned ' + result.scannedCollections + ' collections. ' +
      result.candidatesFound + ' candidates.\nTop: ' +
      top.map(c => c.collection + ' (score:' + c.likelyCandidateScore + ')').join(', ');
    Logger.log('QC Discovery: ' + JSON.stringify(result, null, 2));
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'QC Discovery', 15);
  } catch (err) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Failed: ' + err.message, 'QC Discovery', 10);
  }
}
