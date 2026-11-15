// Secret Santa - local server. No dependencies. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const groups = {}; // code -> { code, adminToken, started, members: [{token,name}], matches: {token: name} }

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

  if (req.method === 'POST' && url.pathname === '/api/create') {
    const { name } = await readBody(req);
    if (!name || !name.trim()) return send(res, 400, { error: 'Enter your name' });
    const code = makeCode();
    const token = makeToken();
    groups[code] = { code, adminToken: token, started: false, members: [{ token, name: name.trim().slice(0, 40) }], matches: {} };
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
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/remove') {
    const { code, token, name } = await readBody(req);
    const g = groups[(code || '').toUpperCase()];
    if (!g || g.adminToken !== token) return send(res, 403, { error: 'Only the admin can do that' });
    if (g.started) return send(res, 400, { error: 'Already started' });
    const i = g.members.findIndex((m) => m.name === name && m.token !== g.adminToken);
    if (i >= 0) g.members.splice(i, 1);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎅 Secret Santa is running!\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal) console.log(`  For the family (same Wi-Fi):  http://${i.address}:${PORT}`);
  console.log('\nPress Ctrl+C to stop.\n');
});
