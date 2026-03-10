// ============================================================
// IEE KPI Dashboard — Google Apps Script v4.0
//
// CHANGES from prior version:
//   - refreshKpiSegments: now paginated — loops until hasMore=false
//     (single-page fetch silently truncated at 5000 segments)
//   - refreshKpiSegments: credential-counts now passes ?days= param
//     to match the date window used by kpi-segments
//   - refreshKpiSegments: credential fetch result logged to Refresh_Log
//   - refreshQcEvents: fixed field mapping — evt.qcCreatedAt (not evt.createdAt)
//   - refreshQcEvents: collection_mismatch diagnostic handled (v4 server
//     no longer returns this, but guard retained for safety)
//   - onOpen: added "Discover QC Collection" menu item (/qc-discovery)
//   - testConnection: shows version from /health response
// ============================================================

// ── Configuration ──────────────────────────────────────────
const CONFIG = {
  API_BASE_URL: 'https://iee-kpi-api-production-3622.up.railway.app',
  API_KEY: 'REPLACE_WITH_YOUR_API_KEY',  // Must match Railway API_KEY env var
  DAYS: 90,
  PAGE_SIZE: 5000
};

// ── Tab Names ──────────────────────────────────────────────
const TABS = {
  KPI_SEGMENTS: 'KPI_Segments',
  QC_EVENTS: 'QC_Events',
  BENCHMARK_CONFIG: 'Benchmark_Config',
  USER_LEVELS: 'User_Levels',
  REFRESH_LOG: 'Refresh_Log'
};

// ── Initial Setup (run once) ───────────────────────────────
function initialSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  for (const tabName of Object.values(TABS)) {
    if (!ss.getSheetByName(tabName)) ss.insertSheet(tabName);
  }

  // KPI_Segments
  const kpiSheet = ss.getSheetByName(TABS.KPI_SEGMENTS);
  kpiSheet.getRange('A1').setValue('Last Refreshed:');
  kpiSheet.getRange('B1').setValue('Not yet refreshed');
  kpiSheet.getRange('A2:S2').setValues([[
    'Order Serial', 'Order Type', 'Report Type', 'Report Count',
    'Status Slug', 'Status Name', 'Worker Name', 'Worker Email',
    'Segment Start (UTC)', 'Segment End (UTC)',
    'Duration (min)', 'Duration (sec)', 'Is Open',
    'Is Error Reporting', 'Changed By',
    'Credential Count', 'XpH Unit', 'XpH Numerator', 'Parent Order ID'
  ]]);
  kpiSheet.getRange('A2:S2').setFontWeight('bold').setBackground('#1F4E79').setFontColor('#FFFFFF');
  kpiSheet.setFrozenRows(2);

  // QC_Events
  const qcSheet = ss.getSheetByName(TABS.QC_EVENTS);
  qcSheet.getRange('A1').setValue('Last Refreshed:');
  qcSheet.getRange('B1').setValue('Not yet refreshed');
  qcSheet.getRange('A2:L2').setValues([[
    'Order ID', 'Error Type', 'Is Fixed It', 'Is Kick It Back',
    'Reporter Name', 'Accountable User', 'Accountable User ID',
    'Department', 'Issue', 'Issue Custom Text',
    'Created At (UTC)', 'QC Event ID'
  ]]);
  qcSheet.getRange('A2:L2').setFontWeight('bold').setBackground('#1F4E79').setFontColor('#FFFFFF');
  qcSheet.setFrozenRows(2);

  // Benchmark_Config
  const benchSheet = ss.getSheetByName(TABS.BENCHMARK_CONFIG);
  benchSheet.getRange('A1:I1').setValues([['TEAM', 'STATUS', 'XPH_UNIT', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5']]);
  benchSheet.getRange('A1:I1').setFontWeight('bold').setBackground('#1F4E79').setFontColor('#FFFFFF');
  benchSheet.setFrozenRows(1);

  const benchmarks = [
    ['Customer Support',    'initial-review',                    'Orders',      '', '',   7,    7,    '', ''],
    ['Data Entry',          'eval-prep-processing',              'Credentials', '', 2.5,  2.8,  3,    '', ''],
    ['Digital Fulfillment', 'digital-fulfillment-processing',    'Orders',      '', '',   8,    9,    '', ''],
    ['Digital Records',     'digital-records-processing',        'Orders',      '', 5,    6,    7,    '', ''],
    ['Digital Records',     'digital-records-review-processing', 'Orders',      '', 5,    6,    7,    '', ''],
    ['Document Management', 'document-processing',               'Orders',      '', '',   5,    6,    '', ''],
    ['Document Management', 'shipment-processing',               'Orders',      '', '',   7,    8.5,  '', ''],
    ['Document Management', 'verification-processing',           'Orders',      '', '',   6,    8,    '', ''],
    ['Evaluation',          'senior-evaluation-review',          'Reports',     '', '',   3.32, 3.32, 3.62, 4.6],
    ['Evaluation',          'initial-evaluation',                'Reports',     1.22, 1.41, 1.53, 1.53, '', ''],
    ['Translations',        'translation-prep',                  'Orders',      '', 4,    4,    '', '', ''],
    ['Translations',        'translation-review',                'Orders',      '', 3,    3,    '', '', ''],
  ];
  if (benchSheet.getLastRow() < 3) {
    benchSheet.getRange(2, 1, benchmarks.length, benchmarks[0].length).setValues(benchmarks);
  }

  // User_Levels
  const userSheet = ss.getSheetByName(TABS.USER_LEVELS);
  userSheet.getRange('A1:E1').setValues([['USER_ID', 'USER_NAME', 'DEPARTMENT', 'LEVEL', 'NOTES']]);
  userSheet.getRange('A1:E1').setFontWeight('bold').setBackground('#1F4E79').setFontColor('#FFFFFF');
  userSheet.setFrozenRows(1);

  // Refresh_Log
  const logSheet = ss.getSheetByName(TABS.REFRESH_LOG);
  logSheet.getRange('A1:E1').setValues([['Timestamp', 'Type', 'Rows', 'Status', 'Details']]);
  logSheet.getRange('A1:E1').setFontWeight('bold').setBackground('#1F4E79').setFontColor('#FFFFFF');
  logSheet.setFrozenRows(1);

  deleteExistingTriggers_();
  ScriptApp.newTrigger('refreshAllData').timeBased().everyHours(1).create();

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Setup complete! Run "Refresh All Data" from the IEE KPI menu.',
    'IEE KPI Setup', 10
  );
}

// ── Main Refresh ───────────────────────────────────────────
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
// Paginates until hasMore=false. With 5000 rows/page this handles
// any dataset size without truncation.
function refreshKpiSegments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TABS.KPI_SEGMENTS);

  // Step 1: Credential counts (date-scoped to match segment window)
  let credMap = {};
  try {
    const credData = apiCall_('/credential-counts?days=' + CONFIG.DAYS);
    for (const c of credData.credentials || []) credMap[c.orderId] = c.credentialCount;
    logRefresh_('Credential_Counts', credData.count || 0, 'OK',
      (credData.count || 0) + ' orders | window: ' +
      (credData.dateRange ? credData.dateRange.from.substring(0, 10) : 'unknown'));
  } catch (e) {
    logRefresh_('Credential_Counts', 0, 'WARN', 'Failed: ' + e.message);
  }

  // Step 2: XpH unit lookup from Benchmark_Config tab (status slug → unit)
  const benchSheet = ss.getSheetByName(TABS.BENCHMARK_CONFIG);
  const benchData = benchSheet.getDataRange().getValues();
  const xphUnitMap = {};
  for (let i = 1; i < benchData.length; i++) {
    if (benchData[i][1]) xphUnitMap[benchData[i][1]] = benchData[i][2];
  }

  // Step 3: Paginate through all KPI segments
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
      // XpH numerator:
      //   Reports     → reportItemCount (embedded on order doc)
      //   Credentials → credentialCount (from /credential-counts)
      //   Orders      → 1 (one order = one unit)
      let xphNumerator = 1;
      if (xphUnit === 'Reports')     xphNumerator = seg.reportItemCount || 1;
      if (xphUnit === 'Credentials') xphNumerator = credCount || 1;

      allRows.push([
        seg.orderSerialNumber,
        seg.orderType,
        seg.reportItemName || '',
        seg.reportItemCount || 0,
        seg.statusSlug,
        seg.statusName,
        seg.workerName || 'UNATTRIBUTED',
        seg.workerEmail || '',
        seg.segmentStart || '',
        seg.segmentEnd || '',
        seg.durationMinutes !== null ? seg.durationMinutes : '',
        seg.durationSeconds !== null ? seg.durationSeconds : '',
        seg.isOpen ? 'TRUE' : 'FALSE',
        seg.isErrorReporting ? 'TRUE' : 'FALSE',
        seg.changedByName || '',
        credCount,
        xphUnit,
        xphNumerator,
        seg.parentOrderId || ''
      ]);
    }

    Logger.log('KPI page ' + page + '/' + segData.totalPages + ' — ' +
      (segData.segments || []).length + ' segments');

    if (!segData.hasMore) break;
    page++;
    Utilities.sleep(500);
  } while (true);

  // Step 4: Write to sheet (clear rows 3+, keep header rows 1-2)
  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, sheet.getLastColumn()).clearContent();
  }
  if (allRows.length > 0) {
    sheet.getRange(3, 1, allRows.length, allRows[0].length).setValues(allRows);
  }

  sheet.getRange('B1').setValue(new Date().toISOString());
  logRefresh_('KPI_Segments', allRows.length, 'OK',
    orderCount + ' orders | ' + allRows.length + ' segments | ' + page + ' page(s)');
}

// ── QC Events Refresh ──────────────────────────────────────
// Writes one row per QC event to QC_Events tab.
// Uses evt.qcCreatedAt (not evt.createdAt — corrected in v4.0).
function refreshQcEvents() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TABS.QC_EVENTS);

  const qcData = apiCall_('/qc-events?days=' + CONFIG.DAYS + '&includeHtml=false&includeText=false');

  // Safety guard: v3.0 server returned status='collection_mismatch' — no longer
  // expected from v4.0 server, but guard retained for safe rollback scenarios.
  if (qcData.status === 'collection_mismatch') {
    logRefresh_('QC_Events', 0, 'WARN', 'Collection mismatch — run Discover QC Collection from IEE KPI menu');
    sheet.getRange('B1').setValue('Collection mismatch — run Discover QC Collection from IEE KPI menu');
    return;
  }

  if (qcData.error) {
    logRefresh_('QC_Events', 0, 'ERROR', qcData.error);
    sheet.getRange('B1').setValue('Error — check Refresh_Log');
    return;
  }

  const rows = (qcData.events || []).map(evt => [
    evt.orderId || '',
    evt.errorType || '',
    evt.isFixedIt ? 'TRUE' : 'FALSE',
    evt.isKickItBack ? 'TRUE' : 'FALSE',
    (evt.reporterName || '').trim(),
    (evt.accountableName || '').trim(),
    evt.accountableUserId || '',
    evt.departmentName || '',
    evt.issueName || '',
    evt.issueCustomText || '',
    evt.qcCreatedAt || '',   // v4.0 fix: was evt.createdAt in prior GAS version
    evt.qcEventId || ''
  ]);

  if (sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, sheet.getLastColumn()).clearContent();
  }
  if (rows.length > 0) {
    sheet.getRange(3, 1, rows.length, rows[0].length).setValues(rows);
  }

  sheet.getRange('B1').setValue(new Date().toISOString());
  logRefresh_('QC_Events', rows.length, 'OK',
    rows.length + ' events | collection: ' + (qcData.collectionUsed || 'unknown'));
}

// ── Helpers ────────────────────────────────────────────────
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
    throw new Error('API returned ' + code + ': ' + response.getContentText().substring(0, 500));
  }
  return JSON.parse(response.getContentText());
}

function logRefresh_(type, rows, status, details) {
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.REFRESH_LOG);
  if (!logSheet) return;
  logSheet.insertRowAfter(1);
  logSheet.getRange(2, 1, 1, 5).setValues([[new Date().toISOString(), type, rows, status, details]]);
  if (logSheet.getLastRow() > 501) logSheet.deleteRows(502, logSheet.getLastRow() - 501);
}

function deleteExistingTriggers_() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'refreshAllData') ScriptApp.deleteTrigger(t);
  }
}

// ── Menu ───────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getActiveSpreadsheet().addMenu('IEE KPI', [
    { name: 'Refresh All Data',       functionName: 'refreshAllData' },
    { name: 'Refresh KPI Only',       functionName: 'refreshKpiSegments' },
    { name: 'Refresh QC Only',        functionName: 'refreshQcEvents' },
    null,
    { name: 'Test API Connection',    functionName: 'testConnection' },
    { name: 'Discover QC Collection', functionName: 'testQcDiscovery' },
    null,
    { name: 'Initial Setup',          functionName: 'initialSetup' }
  ]);
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

// Run from IEE KPI menu to validate the QC collection schema after V2 deploys.
// Check Logger output for full field list.
function testQcDiscovery() {
  try {
    const result = apiCall_('/qc-discovery');
    const top = result.candidates.slice(0, 3);
    const msg = 'Scanned ' + result.scannedCollections + ' collections. ' +
      result.candidatesFound + ' candidates.\nTop: ' +
      top.map(c => c.collection + ' (score:' + c.likelyCandidateScore + ')').join(', ');
    Logger.log('QC Discovery full result: ' + JSON.stringify(result, null, 2));
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'QC Discovery', 15);
  } catch (err) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Failed: ' + err.message, 'QC Discovery', 10);
  }
}
