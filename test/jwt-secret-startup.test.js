const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

// Boots server.js without JWT_SECRET and asserts it exits non-zero with the
// expected FATAL message. We pass placeholder MONGO_URI/API_KEY so the JWT_SECRET
// check is the one that fires (the earlier checks would otherwise be reached first).
test('server fails to start when JWT_SECRET is missing', { timeout: 5000 }, async () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env.PATH,
      MONGO_URI: 'mongodb://placeholder:27017/_unused',
      API_KEY: 'placeholder',
      // JWT_SECRET intentionally unset
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within timeout; stderr so far: ${stderr}`));
    }, 4000);
    child.on('exit', (code) => { clearTimeout(killer); resolve(code); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });

  assert.notEqual(exitCode, 0, 'expected non-zero exit code');
  assert.match(stderr, /FATAL: JWT_SECRET required/, 'expected FATAL JWT_SECRET message on stderr');
});
