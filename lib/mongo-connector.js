// Self-healing, lazily-connected MongoClient holder.
//
// Fixes the "poisoned singleton" bug that took down login/config/data in prod:
// the old getDb/getConfigDb assigned the module-level client BEFORE connect()
// succeeded and never nulled it on failure. A single failed connect (a startup
// blip, or an unreachable/misconfigured config cluster) therefore left a client
// whose topology was closed, and the `if (!client)` guard skipped every retry —
// so every later request returned "Topology is closed" until a process restart.
//
// This holder caches the *connection attempt* only, and drops it if the attempt
// rejects, so the next caller retries with a fresh client. It also dedupes the
// thundering herd of concurrent first-callers into a single connect().
//
// MongoClient is injected so the lifecycle is unit-testable without a real Atlas.
function createMongoConnector({ uri, options, MongoClient, onConnect, onError }) {
  let pending = null; // Promise<MongoClient> for the in-flight/resolved connection

  function getClient() {
    if (pending) return pending;

    pending = (async () => {
      const c = new MongoClient(uri, options);
      try {
        await c.connect();
      } catch (err) {
        // Close the half-open client so it can't linger, then let the cache be
        // cleared (below) so the next call attempts a fresh connection.
        try { await c.close(); } catch { /* ignore */ }
        if (onError) onError(err);
        throw err;
      }
      if (onConnect) onConnect();
      return c;
    })();

    // If this attempt fails, drop it so a subsequent getClient() retries instead
    // of returning a rejected/closed connection forever.
    pending.catch(() => { pending = null; });

    return pending;
  }

  async function close() {
    const p = pending;
    pending = null;
    if (!p) return;
    try {
      const c = await p;
      await c.close();
    } catch { /* already failed/closed — nothing to clean up */ }
  }

  return { getClient, close };
}

module.exports = { createMongoConnector };
