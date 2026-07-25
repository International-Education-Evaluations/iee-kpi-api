const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMongoConnector } = require('../lib/mongo-connector');

// Fake MongoClient whose connect() fails a configurable number of times, then
// succeeds. Mirrors the real driver contract we rely on: db() on a client that
// never connected throws "Topology is closed".
function makeFakeClientClass(initialFailures) {
  class FakeClient {
    constructor(uri, options) {
      this.uri = uri;
      this.options = options;
      this.connectCalls = 0;
      this.connected = false;
      this.closed = false;
      FakeClient.instances.push(this);
    }
    async connect() {
      this.connectCalls++;
      if (FakeClient._remainingFailures > 0) {
        FakeClient._remainingFailures--;
        throw new Error('connect failed');
      }
      this.connected = true;
    }
    async close() { this.closed = true; }
    db(name) {
      if (!this.connected) throw new Error('Topology is closed');
      return { name };
    }
  }
  FakeClient.instances = [];
  FakeClient._remainingFailures = initialFailures;
  return FakeClient;
}

// This is the regression test for the production incident: getConfigDb assigned
// the singleton BEFORE connect() succeeded and never nulled it on failure, so a
// single failed connect returned a permanently-closed client ("Topology is
// closed") on every subsequent request until a process restart.
test('retries connect after a failure instead of caching a dead client', async () => {
  const FakeClient = makeFakeClientClass(1); // first connect throws, second succeeds
  const connector = createMongoConnector({ uri: 'mongodb://x', options: {}, MongoClient: FakeClient });

  await assert.rejects(() => connector.getClient(), /connect failed/);

  const client = await connector.getClient();
  assert.equal(client.connected, true, 'second call must return a freshly connected client');
  assert.equal(FakeClient.instances.length, 2, 'a new client must be constructed on retry');
  assert.equal(FakeClient.instances[0].closed, true, 'the failed half-open client must be closed');
});

test('caches the client across calls once connected (single connect)', async () => {
  const FakeClient = makeFakeClientClass(0);
  const connector = createMongoConnector({ uri: 'mongodb://x', options: {}, MongoClient: FakeClient });

  const a = await connector.getClient();
  const b = await connector.getClient();
  assert.equal(a, b, 'same connected client instance is reused');
  assert.equal(FakeClient.instances.length, 1, 'only one client constructed');
  assert.equal(a.connectCalls, 1, 'connect called exactly once');
});

test('concurrent first calls dedupe to a single connect', async () => {
  const FakeClient = makeFakeClientClass(0);
  const connector = createMongoConnector({ uri: 'mongodb://x', options: {}, MongoClient: FakeClient });

  const [a, b] = await Promise.all([connector.getClient(), connector.getClient()]);
  assert.equal(a, b, 'concurrent callers share the same client');
  assert.equal(FakeClient.instances.length, 1, 'concurrent calls share one connect attempt');
});

test('close() clears the cache so a later getClient reconnects', async () => {
  const FakeClient = makeFakeClientClass(0);
  const connector = createMongoConnector({ uri: 'mongodb://x', options: {}, MongoClient: FakeClient });

  const a = await connector.getClient();
  await connector.close();
  assert.equal(a.closed, true, 'close() closes the live client');

  const b = await connector.getClient();
  assert.notEqual(a, b, 'after close, a new client is created on next use');
  assert.equal(FakeClient.instances.length, 2);
});

test('onConnect fires only on successful connect, onError only on failure', async () => {
  const FakeClient = makeFakeClientClass(1);
  let connects = 0;
  let errors = 0;
  const connector = createMongoConnector({
    uri: 'mongodb://x', options: {}, MongoClient: FakeClient,
    onConnect: () => { connects++; },
    onError: () => { errors++; },
  });

  await assert.rejects(() => connector.getClient());
  assert.equal(errors, 1);
  assert.equal(connects, 0);

  await connector.getClient();
  assert.equal(connects, 1);
  assert.equal(errors, 1);
});
