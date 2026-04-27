// Allowlist for /reports/query `groupBy`. Server-side validation guards against
// arbitrary user-supplied values being interpolated into a MongoDB $group stage.
const ALLOWED_GROUP_BY = new Set([
  'worker', 'workerEmail', 'statusName', 'statusSlug', 'status',
  'department', 'orderType', 'errorType', 'issueName', 'orderSource',
  'date', 'week', 'month'
]);

function validateGroupBy(gb) {
  return typeof gb === 'string' && ALLOWED_GROUP_BY.has(gb);
}

module.exports = { ALLOWED_GROUP_BY, validateGroupBy };
