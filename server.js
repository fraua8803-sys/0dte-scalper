const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

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

app.delete('/api/session', async (req, res) => {
  const { env = 'demo' } = req.body;
  if (sessions[env]) { await igFetch(env, '/session', 'DELETE').catch(() => {}); delete sessions[env]; }
  res.json({ ok: true });
});

app.get('/api/accounts', async (req, res) => {
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, '/accounts');
  res.status(status).json(data);
});

app.get('/api/positions', async (req, res) => {
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, '/positions/otc', 'GET', null, '2');
  res.status(status).json(data);
});

app.post('/api/positions', async (req, res) => {
  const { env = 'demo', epic, direction, size, stopDistance, limitDistance, currencyCode = 'USD' } = req.body;
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

app.delete('/api/positions/:dealId', async (req, res) => {
  const { dealId } = req.params;
  const { env = 'demo', size, direction } = req.body;
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const closeOrder = { dealId, direction, size, orderType: 'MARKET', timeInForce: 'FILL_OR_KILL', expiry: '-' };
  const { status, data } = await igFetch(env, '/positions/otc', 'DELETE', closeOrder, '1');
  res.status(status).json(data);
});

app.get('/api/markets/search', async (req, res) => {
  const { q, env = 'demo' } = req.query;
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  if (!q) return res.status(400).json({ error: 'q required' });
  const { status, data } = await igFetch(env, `/markets?searchTerm=${encodeURIComponent(q)}`);
  res.status(status).json(data);
});

app.get('/api/markets/:epic', async (req, res) => {
  const { epic } = req.params;
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, `/markets/${encodeURIComponent(epic)}`);
  res.status(status).json(data);
});

app.get('/api/prices/:epic', async (req, res) => {
  const { epic } = req.params;
  const { env = 'demo', resolution = 'MINUTE', max = '80' } = req.query;
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, `/prices/${epic}?resolution=${resolution}&max=${max}`, 'GET', null, '3');
  res.status(status).json(data);
});

app.get('/api/confirms/:dealRef', async (req, res) => {
  const { dealRef } = req.params;
  const env = req.query.env || 'demo';
  if (!sessions[env]) return res.status(401).json({ error: 'Not logged in' });
  const { status, data } = await igFetch(env, `/confirms/${dealRef}`);
  res.status(status).json(data);
});

app.get('/api/status', (req, res) => {
  res.json({ ok: true, railway: true,
    sessions: Object.keys(sessions).map(env => ({
      env, accountId: sessions[env].accountId,
      expiresIn: Math.round((sessions[env].expires - Date.now()) / 60000) + ' min',
    }))
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ 0DTE Scalper running on port ${PORT}`);
});
