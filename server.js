/**
 * ICT Forex Scalper — Server
 * ─────────────────────────────────────────────
 * Features:
 * - IG API Proxy (CORS bypass)
 * - Self-ping every 4 min (keeps Railway free tier awake)
 * - Telegram notifications for trades
 */

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

// ── Session store ────────────────────────────────────────────────
const sessions = {};

function igBase(env) {
  return env === 'live'
    ? 'https://api.ig.com/gateway/deal'
    : 'https://demo-api.ig.com/gateway/deal';
}

async function igFetch(env, endpoint, method = 'GET', body = null, version = '1') {
  const sess = sessions[env];
  const headers = {
    'Content-Type': 'application/json',
    'Accept':       'application/json; charset=UTF-8',
    'X-IG-API-KEY': sess?.apiKey || '',
    'Version':      version,
  };
  if (sess?.cst)      headers['CST']              = sess.cst;
  if (sess?.secToken) headers['X-SECURITY-TOKEN'] = sess.secToken;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(igBase(env) + endpoint, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

// ── POST /api/session ────────────────────────────────────────────
app.post('/api/session', async (req, res) => {
  const { apiKey, username, password, env = 'demo' } = req.body;
  if (!apiKey || !username || !password)
    return res.status(400).json({ error: 'apiKey, username, password required' });
  try {
    const igRes = await fetch(igBase(env) + '/session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-IG-API-KEY': apiKey, 'Version': '2' },
      body:    JSON.stringify({ identifier: username, password, encryptedPassword: false }),
    });
    const text = await igRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!igRes.ok) return res.status(igRes.status).json({ error: data?.errorCode || 'Login failed' });
    const cst      = igRes.headers.get('CST');
    const secToken = igRes.headers.get('X-SECURITY-TOKEN');
    const accounts = data.accounts || [];
    const accountId = (accounts.find(a => a.preferred) || accounts[0])?.accountId;
    sessions[env] = { apiKey, cst, secToken, accountId, expires: Date.now() + 6 * 3600 * 1000 };
    console.log(`[IG] ${env.toUpperCase()} login OK — account: ${accountId}`);
    res.json({ ok: true, accountId, accountType: data.accountType, env });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/session ──────────────────────────────────────────
app.delete('/api/session', async (req, res) => {
  const { env = 'demo' } = req.body;
  if (sessions[env]) { await igFetch(env, '/session', 'DELETE').catch(() => {}); delete sessions[env]; }
  res.json({ ok: true });
});

// ── GET /api/accounts ────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, '/accounts');
  res.status(status).json(data);
});

// ── GET /api/positions ───────────────────────────────────────────
app.get('/api/positions', async (req, res) => {
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, '/positions/otc', 'GET', null, '2');
  res.status(status).json(data);
});

// ── POST /api/positions ──────────────────────────────────────────
app.post('/api/positions', async (req, res) => {
  const { env = 'demo', epic, direction, size, stopDistance, limitDistance, currencyCode = 'EUR' } = req.body;
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  if (!epic || !direction || !size) return res.status(400).json({ error: 'epic, direction, size required' });
  const order = {
    epic, expiry: '-', direction, size,
    orderType: 'MARKET', timeInForce: 'FILL_OR_KILL',
    guaranteedStop: false, currencyCode,
    ...(stopDistance  ? { stopDistance, trailingStop: false } : {}),
    ...(limitDistance ? { limitDistance } : {}),
  };
  const { status, data } = await igFetch(env, '/positions/otc', 'POST', order, '2');
  res.status(status).json(data);
});

// ── DELETE /api/positions/:dealId ────────────────────────────────
app.delete('/api/positions/:dealId', async (req, res) => {
  const { dealId } = req.params;
  const { env = 'demo', size, direction } = req.body;
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const closeOrder = { dealId, direction, size, orderType: 'MARKET', timeInForce: 'FILL_OR_KILL', expiry: '-' };
  const { status, data } = await igFetch(env, '/positions/otc', 'DELETE', closeOrder, '1');
  res.status(status).json(data);
});

// ── GET /api/markets/search ──────────────────────────────────────
app.get('/api/markets/search', async (req, res) => {
  const { q, env = 'demo' } = req.query;
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  if (!q) return res.status(400).json({ error: 'q required' });
  const { status, data } = await igFetch(env, `/markets?searchTerm=${encodeURIComponent(q)}`);
  res.status(status).json(data);
});

// ── GET /api/markets/:epic ───────────────────────────────────────
app.get('/api/markets/:epic', async (req, res) => {
  const { epic } = req.params;
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, `/markets/${encodeURIComponent(epic)}`);
  res.status(status).json(data);
});

// ── GET /api/prices/:epic ────────────────────────────────────────
app.get('/api/prices/:epic', async (req, res) => {
  const { epic } = req.params;
  const { env = 'demo', resolution = 'MINUTE', max = '80' } = req.query;
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, `/prices/${epic}?resolution=${resolution}&max=${max}`, 'GET', null, '3');
  res.status(status).json(data);
});

// ── GET /api/confirms/:dealRef ───────────────────────────────────
app.get('/api/confirms/:dealRef', async (req, res) => {
  const { dealRef } = req.params;
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, `/confirms/${dealRef}`);
  res.status(status).json(data);
});

// ── POST /api/notify ─────────────────────────────────────────────
// Called by frontend when a trade is placed/closed
app.post('/api/notify', async (req, res) => {
  const { botToken, chatId, message } = req.body;
  if (!botToken || !chatId || !message)
    return res.status(400).json({ error: 'botToken, chatId, message required' });
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description || 'Telegram error');
    console.log(`[Telegram] Message sent to ${chatId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Telegram] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/status ──────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    railway: true,
    uptime: Math.round(process.uptime()) + 's',
    sessions: Object.keys(sessions).map(env => ({
      env,
      accountId: sessions[env].accountId,
      expiresIn: Math.round((sessions[env].expires - Date.now()) / 60000) + ' min',
    })),
  });
});

// ── SELF-PING (keeps Railway free tier awake) ────────────────────
function startSelfPing() {
  const url = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/status`
    : `http://localhost:${PORT}/api/status`;

  setInterval(async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) });
      console.log(`[Ping] ✅ ${new Date().toUTCString()}`);
    } catch (e) {
      console.log(`[Ping] ⚠️ ${e.message}`);
    }
  }, 4 * 60 * 1000); // every 4 minutes

  console.log(`[Ping] Self-ping active → every 4 min`);
}

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ ICT Scalper Server running on port ${PORT}`);
  console.log(`   Status: /api/status`);
  console.log(`   Notify: POST /api/notify\n`);
  startSelfPing();
});
