const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorBody } = require('../lib/error-response');

test('production hides the real error message', () => {
  const body = errorBody(new Error('Topology is closed'), { production: true });
  assert.deepEqual(body, { error: 'Internal server error' });
});

test('non-production surfaces the real message for debugging', () => {
  const body = errorBody(new Error('bad query'), { production: false });
  assert.deepEqual(body, { error: 'bad query' });
});

test('missing/blank error falls back to a generic message', () => {
  assert.deepEqual(errorBody(undefined, { production: false }), { error: 'Internal server error' });
  assert.deepEqual(errorBody({}, { production: false }), { error: 'Internal server error' });
});
