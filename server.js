// Secret Santa - local server. No dependencies. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let groups = {}; // code -> { code, adminToken, started, members: [{token,name}], matches: {token: name} }

// Optional permanent storage in a free Upstash Redis database (survives restarts on Render).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  return (await r.json()).result;
}

async function loadData() {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const v = await redis(['GET', 'santa_groups']);
      groups = v ? JSON.parse(v) : {};
      console.log('Loaded data from Upstash (' + Object.keys(groups).length + ' groups)');
      return;
    } catch (e) { console.error('Could not load from Upstash:', e.message); }
  }
  try { groups = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { groups = {}; }
}

let saveChain = Promise.resolve();
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(groups)); } catch (e) { console.error('Could not save file:', e.message); }
  if (REDIS_URL && REDIS_TOKEN) {
    const snapshot = JSON.stringify(groups);
    saveChain = saveChain
      .then(() => redis(['SET', 'santa_groups', snapshot]))
      .catch((e) => console.error('Could not save to Upstash:', e.message));
  }
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (groups[c]);
  return c;
}
const makeToken = () => crypto.randomBytes(16).toString('hex');

// Random derangement: nobody draws themselves
function derange(n) {
  while (true) {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    if (a.every((v, i) => v !== i)) return a;
  }
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'POST' && url.pathname === '/api/create') {
    const { name } = await readBody(req);
    if (!name || !name.trim()) return send(res, 400, { error: 'Enter your name' });
    const code = makeCode();
    const token = makeToken();
    groups[code] = { code, adminToken: token, started: false, members: [{ token, name: name.trim().slice(0, 40) }], matches: {} };
    save();
    return send(res, 200, { code, token });
  }

  if (req.method === 'POST' && url.pathname === '/api/join') {
    const { name, code } = await readBody(req);
    const g = groups[(code || '').toUpperCase().trim()];
    if (!name || !name.trim()) return send(res, 400, { error: 'Enter your name' });
    if (!g) return send(res, 404, { error: 'Group code not found' });
    if (g.started) return send(res, 400, { error: 'The draw has already started' });
    const clean = name.trim().slice(0, 40);
    if (g.members.some((m) => m.name.toLowerCase() === clean.toLowerCase()))
      return send(res, 400, { error: 'That name is already taken in this group' });
    const token = makeToken();
    g.members.push({ token, name: clean });
    save();
    return send(res, 200, { code: g.code, token });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const g = groups[(url.searchParams.get('code') || '').toUpperCase()];
    const token = url.searchParams.get('token');
    if (!g) return send(res, 404, { error: 'Group not found' });
    const me = g.members.find((m) => m.token === token);
    if (!me) return send(res, 403, { error: 'Not in this group' });
    const out = {
      code: g.code,
      started: g.started,
      isAdmin: token === g.adminToken,
      myName: me.name,
      members: g.members.map((m) => m.name), // names only, never tokens
    };
    if (g.started) out.myMatch = g.matches[token]; // only your own match
    return send(res, 200, out);
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    const { code, token } = await readBody(req);
    const g = groups[(code || '').toUpperCase()];
    if (!g || g.adminToken !== token) return send(res, 403, { error: 'Only the admin can start' });
    if (g.started) return send(res, 400, { error: 'Already started' });
    if (g.members.length < 3) return send(res, 400, { error: 'You need at least 3 people' });
    const perm = derange(g.members.length);
    g.members.forEach((m, i) => { g.matches[m.token] = g.members[perm[i]].name; });
    g.started = true;
    save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/remove') {
    const { code, token, name } = await readBody(req);
    const g = groups[(code || '').toUpperCase()];
    if (!g || g.adminToken !== token) return send(res, 403, { error: 'Only the admin can do that' });
    if (g.started) return send(res, 400, { error: 'Already started' });
    const i = g.members.findIndex((m) => m.name === name && m.token !== g.adminToken);
    if (i >= 0) g.members.splice(i, 1);
    save();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Not found' });
});

loadData().then(() => server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎅 Secret Santa is running!\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal) console.log(`  For the family (same Wi-Fi):  http://${i.address}:${PORT}`);
  console.log('\nPress Ctrl+C to stop.\n');
}));
