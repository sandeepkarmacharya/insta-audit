'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-audit-test-'));
process.env.IG_APP_ID = 'test-app-id';
process.env.IG_APP_SECRET = 'test-app-secret';

const { handle, ig, __test } = require('../server.js');
const Sample = require('../lib/sample.js');

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  });
});

function request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: Object.assign(
          data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
          headers || {}
        ),
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (e) { /* html/text */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: buf });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // 1. status endpoint
  let r = await request('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.authenticated, false);
  assert.equal(r.json.configured, true);
  assert.equal(r.json.snapshotCount, 0);

  // 2. static index served
  r = await request('GET', '/');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Follow Audit'), 'index served');
  assert.ok((r.headers['content-security-policy'] || '').includes("default-src 'self'"), 'CSP header set');

  // 3. static traversal + sensitive files blocked
  r = await request('GET', '/../server.js');
  assert.ok(r.status === 400 || r.status === 404, 'traversal blocked');
  r = await request('GET', '/data/store.json');
  assert.equal(r.status, 404, 'data dir not served');
  r = await request('GET', '/.env');
  assert.equal(r.status, 404, '.env not served');

  // 4. analyze (no persist) with Instagram-format sample data
  const sample = Sample.generate(42);
  r = await request('POST', '/api/analyze', { followersRaw: sample.followersRaw, followingRaw: sample.followingRaw });
  assert.equal(r.status, 200);
  assert.equal(r.json.analysis.followers.length, 140);
  assert.ok(r.json.analysis.notFollowingBack.length > 0);
  r = await request('GET', '/api/status');
  assert.equal(r.json.snapshotCount, 0, 'analyze does not persist');

  // 5. upload persists a snapshot and returns analysis
  r = await request('POST', '/api/upload', { followersRaw: sample.followersRaw, followingRaw: sample.followingRaw });
  assert.equal(r.status, 200);
  assert.equal(r.json.changes, null, 'first snapshot has no changes');
  assert.equal(r.json.snapshots.length, 1);
  const ts1 = r.json.snapshot.ts;

  // 6. second upload with 2 followers removed -> unfollowers detected
  const followers2 = sample.followersRaw.slice(2); // drop first two usernames
  r = await request('POST', '/api/upload', { followersRaw: followers2, followingRaw: sample.followingRaw });
  assert.equal(r.status, 200);
  assert.equal(r.json.snapshots.length, 2);
  assert.equal(r.json.changes.lostFollowers.length, 2, 'two unfollowers detected');
  assert.equal(r.json.changes.newFollowers.length, 0);

  // 7. analysis endpoint reflects latest snapshot
  r = await request('GET', '/api/analysis');
  assert.equal(r.status, 200);
  assert.equal(r.json.analysis.followers.length, 138);
  assert.equal(r.json.snapshots.length, 2);
  assert.ok(r.json.changes, 'changes vs previous present');

  // 8. changes against a specific snapshot
  r = await request('GET', '/api/changes?against=' + ts1);
  assert.equal(r.status, 200);
  assert.equal(r.json.against, ts1);
  assert.equal(r.json.changes.lostFollowers.length, 2);
  r = await request('GET', '/api/changes?against=999999');
  assert.equal(r.status, 404);

  // 9. sync without session -> 401
  r = await request('POST', '/api/sync');
  assert.equal(r.status, 401);

  // 10. sync with stubbed Instagram client + session
  const session = 'test-session-token';
  __test.setStore({
    sessionToken: session,
    igToken: { access_token: 'fake-token', expires_at: Date.now() + 3600e3, obtained_at: Date.now() },
  });
  const before = (await request('GET', '/api/analysis')).json.analysis;
  const apiFollowers = before.followers.slice(0, -2); // two people unfollowed since last upload
  const origResolve = ig.resolveUser;
  const origFetchList = ig.fetchList;
  ig.resolveUser = async () => ({ id: '123', username: 'tester' });
  ig.fetchList = async (userId, edge) => (edge === 'followers' ? apiFollowers : before.following);
  r = await request('POST', '/api/sync', null, { Cookie: 'fa_session=' + session });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.snapshot.source, 'api');
  assert.equal(r.json.snapshot.username, 'tester');
  assert.equal(r.json.analysis.followers.length, before.followers.length - 2);
  assert.equal(r.json.changes.lostFollowers.length, 2, 'api sync diff vs previous upload snapshot');
  assert.deepEqual(r.json.changes.lostFollowers, before.followers.slice(-2));
  ig.resolveUser = origResolve;
  ig.fetchList = origFetchList;

  // 11. login redirect when configured
  r = await request('GET', '/auth/login');
  assert.equal(r.status, 302);
  assert.ok(r.headers.location.includes('dialog/oauth'), 'redirects to Meta OAuth dialog');
  assert.ok(r.headers.location.includes('state='), 'CSRF state present');

  // 12. callback with bad state -> 400
  r = await request('GET', '/auth/callback?code=x&state=wrong');
  assert.equal(r.status, 400);

  // 13. delete one snapshot, then all
  r = await request('DELETE', '/api/snapshots/' + ts1);
  assert.equal(r.status, 200);
  assert.equal(r.json.snapshots.length, 2);
  r = await request('DELETE', '/api/snapshots');
  assert.equal(r.status, 200);
  r = await request('GET', '/api/snapshots');
  assert.equal(r.json.snapshots.length, 0);

  // 14. logout clears session/token
  __test.setStore({ sessionToken: 's2', igToken: { access_token: 't', expires_at: null, obtained_at: 1 } });
  r = await request('POST', '/auth/logout', null, { Cookie: 'fa_session=s2' });
  assert.equal(r.status, 200);
  r = await request('GET', '/api/status');
  assert.equal(r.json.authenticated, false);

  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log('All server tests passed ✓');
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
