'use strict';

/*
 * Follow Audit — local server.
 * Zero-dependency Node backend:
 *  - serves the static frontend
 *  - Instagram OAuth (official Graph API) so the user does not have to export data manually
 *  - fetches followers/following via the Graph API and stores snapshots locally
 *  - REST API consumed by the frontend
 *
 * Binds to 127.0.0.1 by default; never expose it publicly.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FA = require('./lib/parse.js');

(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined && value !== '') process.env[key] = value;
  }
})();

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_SNAPSHOTS = 200;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '3000', 10),
  igAppId: process.env.IG_APP_ID || '',
  igAppSecret: process.env.IG_APP_SECRET || '',
  redirectUri: process.env.IG_REDIRECT_URI || '',
  scopes: process.env.IG_SCOPES || 'instagram_business_basic,instagram_business_manage_insights',
  apiVersion: process.env.IG_API_VERSION || 'v21.0',
  graphHost: (process.env.IG_GRAPH_HOST || 'https://graph.instagram.com').replace(/\/+$/, ''),
  sessionCookie: 'fa_session',
};
if (!config.redirectUri) config.redirectUri = `http://localhost:${config.port}/auth/callback`;

function configured() {
  return Boolean(config.igAppId && config.igAppSecret);
}

// ---------- persistent store ----------

function defaultStore() {
  return { sessionToken: null, pendingState: null, igToken: null, igUser: null, snapshots: [] };
}

function loadStore() {
  try {
    return Object.assign(defaultStore(), JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
  } catch (e) {
    return defaultStore();
  }
}

let store = loadStore();

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

// ---------- HTTP helpers ----------

function setSecurityHeaders(res, isHtml) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isHtml) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"
    );
  }
}

function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }, extraHeaders || {}));
  res.end(body);
}

function redirect(res, location, extraHeaders) {
  res.writeHead(302, Object.assign({ Location: location }, extraHeaders || {}));
  res.end();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function hasSession(req) {
  return Boolean(store.sessionToken) && getCookie(req, config.sessionCookie) === store.sessionToken;
}

// ---------- Instagram Graph API client ----------

function httpsJson(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('invalid URL'));
    }
    const req = https.get(u, { timeout: timeoutMs || 25000 }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
        if (body.length > 5 * 1024 * 1024) req.destroy();
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {
          /* non-JSON body */
        }
        resolve({ status: res.statusCode, json, body: body.slice(0, 2000) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Instagram request timed out')));
    req.on('error', reject);
  });
}

function apiError(r, fallback) {
  if (r.json && r.json.error) {
    const msg = r.json.error.message || fallback;
    const e = new Error(msg + (r.json.error.type ? ` (${r.json.error.type})` : ''));
    e.api = r.json.error;
    return e;
  }
  return new Error(`${fallback} (HTTP ${r.status})`);
}

const ig = {
  async apiGet(pathname, params, token) {
    const u = new URL(`${config.graphHost}/${config.apiVersion}${pathname}`);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    if (token) u.searchParams.set('access_token', token);
    const r = await httpsJson(u.toString());
    if (r.json && r.json.error) throw apiError(r, 'Instagram API error');
    if (r.status >= 400 || !r.json) throw apiError(r, 'Instagram API request failed');
    return r.json;
  },

  async exchangeCode(code) {
    const u = new URL(`https://graph.facebook.com/${config.apiVersion}/oauth/access_token`);
    u.searchParams.set('client_id', config.igAppId);
    u.searchParams.set('client_secret', config.igAppSecret);
    u.searchParams.set('redirect_uri', config.redirectUri);
    u.searchParams.set('code', code);
    const r = await httpsJson(u.toString());
    if (!r.json || !r.json.access_token) throw apiError(r, 'Could not exchange OAuth code');
    return r.json;
  },

  async toLongLived(token) {
    const attempts = [
      () => {
        const u = new URL('https://graph.instagram.com/access_token');
        u.searchParams.set('grant_type', 'ig_exchange_token');
        u.searchParams.set('client_secret', config.igAppSecret);
        u.searchParams.set('access_token', token);
        return httpsJson(u.toString());
      },
      () => {
        const u = new URL(`https://graph.facebook.com/${config.apiVersion}/oauth/access_token`);
        u.searchParams.set('grant_type', 'fb_exchange_token');
        u.searchParams.set('client_id', config.igAppId);
        u.searchParams.set('client_secret', config.igAppSecret);
        u.searchParams.set('fb_exchange_token', token);
        return httpsJson(u.toString());
      },
    ];
    let best = null;
    for (const attempt of attempts) {
      try {
        const r = await attempt();
        if (r.json && r.json.access_token && (!best || (r.json.expires_in || 0) > (best.expires_in || 0))) best = r.json;
      } catch (e) {
        /* try next strategy */
      }
    }
    return best;
  },

  async refresh(token) {
    const attempts = [
      () => {
        const u = new URL('https://graph.instagram.com/refresh_access_token');
        u.searchParams.set('grant_type', 'ig_refresh_token');
        u.searchParams.set('access_token', token);
        return httpsJson(u.toString());
      },
      () => {
        const u = new URL(`https://graph.facebook.com/${config.apiVersion}/oauth/access_token`);
        u.searchParams.set('grant_type', 'fb_exchange_token');
        u.searchParams.set('client_id', config.igAppId);
        u.searchParams.set('client_secret', config.igAppSecret);
        u.searchParams.set('fb_exchange_token', token);
        return httpsJson(u.toString());
      },
    ];
    for (const attempt of attempts) {
      try {
        const r = await attempt();
        if (r.json && r.json.access_token) return r.json;
      } catch (e) {
        /* try next strategy */
      }
    }
    throw new Error('Access token expired and could not be refreshed — please reconnect Instagram.');
  },

  async resolveUser(token) {
    const me = await ig.apiGet('/me', { fields: 'id,username' }, token);
    if (me && me.id) return me;
    const accounts = await ig.apiGet('/me/accounts', { fields: 'name,instagram_business_account{id,username}' }, token);
    const page = (accounts.data || []).find((p) => p.instagram_business_account);
    if (page && page.instagram_business_account) return page.instagram_business_account;
    throw new Error('No Instagram account found for this access token.');
  },

  async fetchList(userId, edge, token) {
    const out = [];
    let after = null;
    let pages = 0;
    do {
      const params = { limit: '100' };
      if (after) params.after = after;
      const res = await ig.apiGet(`/${userId}/${edge}`, params, token);
      for (const item of res.data || []) out.push(item.username || String(item.id));
      const hasNext = Boolean(res.paging && res.paging.next);
      after = hasNext && res.paging.cursors && res.paging.cursors.after ? res.paging.cursors.after : null;
      if (++pages > 1000) throw new Error('Pagination guard triggered (too many pages).');
    } while (after);
    return [...new Set(out)];
  },

  async ensureFreshToken() {
    const t = store.igToken;
    if (!t || !t.access_token) throw new Error('Not connected to Instagram.');
    if (!t.expires_at || t.expires_at > Date.now() + 5 * 60 * 1000) return t.access_token;
    const refreshed = await ig.refresh(t.access_token);
    store.igToken = {
      access_token: refreshed.access_token,
      expires_at: Date.now() + (refreshed.expires_in || 3600) * 1000,
      obtained_at: Date.now(),
    };
    saveStore();
    return store.igToken.access_token;
  },
};

// ---------- snapshots ----------

function snapshotMeta(s) {
  return {
    ts: s.ts,
    source: s.source,
    username: s.username || null,
    followers: s.followers.length,
    following: s.following.length,
  };
}

function ingestSnapshot(input) {
  const analysis = FA.analyze(input.followersRaw, input.followingRaw);
  const prev = store.snapshots.length ? store.snapshots[store.snapshots.length - 1] : null;
  const record = {
    ts: Date.now(),
    source: input.source || 'upload',
    username: input.username || null,
    followers: analysis.followers,
    following: analysis.following,
  };
  store.snapshots.push(record);
  if (store.snapshots.length > MAX_SNAPSHOTS) store.snapshots = store.snapshots.slice(-MAX_SNAPSHOTS);
  saveStore();
  const changes = prev ? FA.diffSnapshots(prev, record) : null;
  return { ok: true, analysis, changes, snapshot: snapshotMeta(record), snapshots: store.snapshots.map(snapshotMeta) };
}

function analysisResponse() {
  const latest = store.snapshots.length ? store.snapshots[store.snapshots.length - 1] : null;
  if (!latest) return { ok: true, analysis: null, changes: null, snapshots: [] };
  const prev = store.snapshots.length > 1 ? store.snapshots[store.snapshots.length - 2] : null;
  return {
    ok: true,
    analysis: FA.analyze(latest.followers, latest.following),
    changes: prev ? FA.diffSnapshots(prev, latest) : null,
    snapshots: store.snapshots.map(snapshotMeta),
  };
}

// ---------- route handlers ----------

function handleLogin(req, res) {
  if (!configured()) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Instagram app is not configured. Set IG_APP_ID and IG_APP_SECRET in .env (see README.md).',
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  store.pendingState = { state, exp: Date.now() + 10 * 60 * 1000 };
  saveStore();
  const u = new URL(`https://www.facebook.com/${config.apiVersion}/dialog/oauth`);
  u.searchParams.set('client_id', config.igAppId);
  u.searchParams.set('redirect_uri', config.redirectUri);
  u.searchParams.set('scope', config.scopes);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  redirect(res, u.toString());
}

async function handleCallback(req, res, u) {
  const state = u.searchParams.get('state') || '';
  const code = u.searchParams.get('code') || '';
  const err = u.searchParams.get('error_description') || u.searchParams.get('error');
  if (err) return sendJson(res, 400, { ok: false, error: 'Instagram authorization failed: ' + err });
  if (!store.pendingState || store.pendingState.state !== state || store.pendingState.exp < Date.now()) {
    return sendJson(res, 400, { ok: false, error: 'Invalid or expired OAuth state. Try connecting again.' });
  }
  if (!code) return sendJson(res, 400, { ok: false, error: 'Missing OAuth code.' });
  store.pendingState = null;

  const shortLived = await ig.exchangeCode(code);
  const longLived = await ig.toLongLived(shortLived.access_token);
  const chosen = longLived || shortLived;
  store.igToken = {
    access_token: chosen.access_token,
    expires_at: chosen.expires_in ? Date.now() + chosen.expires_in * 1000 : null,
    obtained_at: Date.now(),
  };
  store.igUser = await ig.resolveUser(chosen.access_token);
  store.sessionToken = crypto.randomBytes(24).toString('hex');
  saveStore();

  const cookie = `${config.sessionCookie}=${store.sessionToken}; Path=/; HttpOnly; SameSite=Lax`;
  redirect(res, '/?connected=1', { 'Set-Cookie': cookie });
}

function handleLogout(req, res) {
  if (!hasSession(req)) return sendJson(res, 401, { ok: false, error: 'no session' });
  store.sessionToken = null;
  store.igToken = null;
  store.igUser = null;
  saveStore();
  const cookie = `${config.sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
}

async function handleSync(req, res) {
  if (!hasSession(req)) return sendJson(res, 401, { ok: false, error: 'Not connected. Click "Connect Instagram" first.' });
  const token = await ig.ensureFreshToken();
  const user = await ig.resolveUser(token);
  store.igUser = { id: user.id, username: user.username };
  const followers = await ig.fetchList(user.id, 'followers', token);
  const following = await ig.fetchList(user.id, 'following', token);
  saveStore();
  const result = ingestSnapshot({ source: 'api', username: user.username, followersRaw: followers, followingRaw: following });
  sendJson(res, 200, result);
}

async function handleApi(req, res, u) {
  const p = u.pathname;

  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      configured: configured(),
      authenticated: Boolean(store.igToken),
      username: store.igUser ? store.igUser.username : null,
      tokenExpiresAt: store.igToken ? store.igToken.expires_at : null,
      snapshotCount: store.snapshots.length,
      lastSnapshotTs: store.snapshots.length ? store.snapshots[store.snapshots.length - 1].ts : null,
      scopes: config.scopes,
      redirectUri: config.redirectUri,
      apiVersion: config.apiVersion,
    });
  }

  if (p === '/api/sync' && req.method === 'POST') return handleSync(req, res);

  if (p === '/api/analysis' && req.method === 'GET') return sendJson(res, 200, analysisResponse());

  if (p === '/api/changes' && req.method === 'GET') {
    const latest = store.snapshots.length ? store.snapshots[store.snapshots.length - 1] : null;
    if (!latest) return sendJson(res, 200, { ok: true, changes: null, against: null });
    const againstTs = u.searchParams.get('against');
    let against = null;
    if (againstTs) {
      against = store.snapshots.find((s) => String(s.ts) === String(againstTs)) || null;
      if (!against) return sendJson(res, 404, { ok: false, error: 'snapshot not found' });
    } else {
      against = store.snapshots.length > 1 ? store.snapshots[store.snapshots.length - 2] : null;
    }
    return sendJson(res, 200, {
      ok: true,
      against: against ? against.ts : null,
      changes: against ? FA.diffSnapshots(against, latest) : null,
    });
  }

  if (p === '/api/analyze' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    if (!body || !('followersRaw' in body) || !('followingRaw' in body)) {
      return sendJson(res, 400, { ok: false, error: 'Body must be JSON with followersRaw and followingRaw.' });
    }
    return sendJson(res, 200, { ok: true, analysis: FA.analyze(body.followersRaw, body.followingRaw) });
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    if (!body || !('followersRaw' in body) || !('followingRaw' in body)) {
      return sendJson(res, 400, { ok: false, error: 'Body must be JSON with followersRaw and followingRaw.' });
    }
    return sendJson(res, 200, ingestSnapshot({ source: 'upload', followersRaw: body.followersRaw, followingRaw: body.followingRaw }));
  }

  if (p === '/api/snapshots' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, snapshots: store.snapshots.map(snapshotMeta) });
  }

  if (p === '/api/snapshots' && req.method === 'DELETE') {
    store.snapshots = [];
    saveStore();
    return sendJson(res, 200, { ok: true });
  }

  const snapMatch = p.match(/^\/api\/snapshots\/(\d+)$/);
  if (snapMatch && req.method === 'DELETE') {
    const ts = Number(snapMatch[1]);
    const before = store.snapshots.length;
    store.snapshots = store.snapshots.filter((s) => s.ts !== ts);
    if (store.snapshots.length === before) return sendJson(res, 404, { ok: false, error: 'snapshot not found' });
    saveStore();
    return sendJson(res, 200, { ok: true, snapshots: store.snapshots.map(snapshotMeta) });
  }

  return sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
}

// ---------- static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, p) {
  let rel = decodeURIComponent(p);
  if (rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
    res.writeHead(400);
    return res.end('bad path');
  }
  if (full.startsWith(DATA_DIR) || full.includes('node_modules') || full.endsWith('.env')) {
    res.writeHead(404);
    return res.end('not found');
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    setSecurityHeaders(res, type.startsWith('text/html'));
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

// ---------- entry ----------

async function handle(req, res) {
  const rawPath = (req.url || '').split('?')[0];
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch (e) {
    /* malformed encoding */
  }
  if (decodedPath.split('/').includes('..')) {
    setSecurityHeaders(res);
    res.writeHead(400);
    return res.end('bad path');
  }
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  try {
    if (p === '/auth/login' && req.method === 'GET') return handleLogin(req, res);
    if (p === '/auth/callback' && req.method === 'GET') return await handleCallback(req, res, u);
    if (p === '/auth/logout' && req.method === 'POST') return handleLogout(req, res);
    if (p.startsWith('/api/')) return await handleApi(req, res, u);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    setSecurityHeaders(res);
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    if (!res.headersSent) {
      setSecurityHeaders(res);
      sendJson(res, e.message && e.message.includes('Not connected') ? 401 : 500, { ok: false, error: e.message || 'server error' });
    } else {
      res.end();
    }
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else res.end();
  });
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log(`Follow Audit running at http://${config.host}:${config.port}`);
    console.log(configured() ? 'Instagram app configured.' : 'Instagram app NOT configured — set IG_APP_ID/IG_APP_SECRET in .env (see README.md). Manual JSON upload still works.');
  });
}

module.exports = {
  server,
  handle,
  config,
  ig,
  store: () => store,
  __test: {
    setStore(patch) {
      Object.assign(store, patch);
      saveStore();
    },
  },
};
