const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_GROUP_BY, validateGroupBy } = require('../lib/validate-group-by');

test('every allowlisted value passes', () => {
  for (const value of ALLOWED_GROUP_BY) {
    assert.equal(validateGroupBy(value), true, `expected ${value} to validate`);
  }
});

test('rejects field-name injection attempts', () => {
  assert.equal(validateGroupBy('$evil'), false);
  assert.equal(validateGroupBy('passwordHash'), false);
  assert.equal(validateGroupBy('worker; drop'), false);
  assert.equal(validateGroupBy('worker.$ne'), false);
});

test('rejects non-string and edge-case inputs', () => {
  assert.equal(validateGroupBy(''), false);
  assert.equal(validateGroupBy(null), false);
  assert.equal(validateGroupBy(undefined), false);
  assert.equal(validateGroupBy(0), false);
  assert.equal(validateGroupBy({}), false);
  assert.equal(validateGroupBy(['worker']), false);
  assert.equal(validateGroupBy(() => 'worker'), false);
});

test('is case-sensitive (does not accept variants)', () => {
  assert.equal(validateGroupBy('Worker'), false);
  assert.equal(validateGroupBy('WORKER'), false);
});

test('allowlist contains the expected canonical values', () => {
  // If this fails, server.js buildGroupKey switch and the allowlist have drifted.
  const expected = ['worker', 'workerEmail', 'statusName', 'statusSlug', 'status',
    'department', 'orderType', 'errorType', 'issueName', 'orderSource',
    'date', 'week', 'month'];
  for (const v of expected) {
    assert.ok(ALLOWED_GROUP_BY.has(v), `missing canonical value: ${v}`);
  }
});
