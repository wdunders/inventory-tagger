/*
 * Inventory Tagger — backend (Phase 1)
 * - Serves the app (public/index.html)
 * - Stores your data in Postgres (or in-memory if no DATABASE_URL, for local testing)
 * - Single-password login -> token; all data routes require the token
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PASSWORD = process.env.APP_PASSWORD || 'changeme';
const SECRET = process.env.SECRET || crypto.createHash('sha256').update('it::' + PASSWORD).digest('hex');
const TOKEN = crypto.createHmac('sha256', SECRET).update('inventory-tagger').digest('hex');

let pool = null;     // Postgres connection (production)
let mem = null;      // in-memory fallback (local testing only)

const app = express();
app.use(express.json({ limit: '50mb' }));
// Serve the app (index.html sits next to server.js — flat layout, no public/ folder)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function initDB() {
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS ebay_tokens (id INT PRIMARY KEY, refresh_token TEXT, access_token TEXT, expires_at BIGINT)');
    console.log('Postgres connected.');
  } else {
    console.warn('!! No DATABASE_URL set — using in-memory store. Data will NOT survive a restart. (Fine for local testing.)');
  }
}

function auth(req, res, next) {
  if (req.headers['x-auth'] === TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// timing-safe password check
function passwordOk(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/login', (req, res) => {
  if (passwordOk(req.body && req.body.password)) return res.json({ token: TOKEN });
  res.status(401).json({ error: 'bad password' });
});

app.get('/api/state', auth, async (req, res) => {
  try {
    if (pool) {
      const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
      return res.json({ data: r.rows[0] ? r.rows[0].data : null });
    }
    res.json({ data: mem });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'load failed' });
  }
});

app.put('/api/state', auth, async (req, res) => {
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'no data' });
  try {
    if (pool) {
      await pool.query(
        'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()',
        [data]
      );
    } else {
      mem = data;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'save failed' });
  }
});

/* ===================== eBay integration (Phase 2) ===================== */
const EBAY_CLIENT_ID = (process.env.EBAY_CLIENT_ID || '').trim();
const EBAY_CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET || '').trim();
const EBAY_RUNAME = (process.env.EBAY_RUNAME || '').trim();
const EBAY_VERIFICATION_TOKEN = (process.env.EBAY_VERIFICATION_TOKEN || '').trim();
const APP_URL = (process.env.APP_URL || 'https://williams.up.railway.app').replace(/\/$/, '');
const EBAY_SCOPES = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances';
let memTok = null;

async function ebayLoadTok() {
  if (pool) { const r = await pool.query('SELECT refresh_token, access_token, expires_at FROM ebay_tokens WHERE id=1'); return r.rows[0] || null; }
  return memTok;
}
async function ebaySaveTok(t) {
  if (pool) { await pool.query('INSERT INTO ebay_tokens(id,refresh_token,access_token,expires_at) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET refresh_token=$1,access_token=$2,expires_at=$3', [t.refresh_token, t.access_token, t.expires_at]); }
  else memTok = t;
}
async function loadStateInternal() {
  if (pool) { const r = await pool.query('SELECT data FROM app_state WHERE id=1'); return r.rows[0] ? r.rows[0].data : null; }
  return mem;
}
async function saveStateInternal(d) {
  if (pool) { await pool.query('INSERT INTO app_state(id,data,updated_at) VALUES(1,$1,now()) ON CONFLICT(id) DO UPDATE SET data=$1,updated_at=now()', [d]); }
  else mem = d;
}
function ebayBasicAuth() { return 'Basic ' + Buffer.from(EBAY_CLIENT_ID + ':' + EBAY_CLIENT_SECRET).toString('base64'); }
async function ebayTokenRequest(params) {
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: ebayBasicAuth() },
    body: new URLSearchParams(params).toString()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('eBay token error: ' + (j.error_description || j.error || r.status));
  return j;
}
async function ebayAccessToken() {
  const t = await ebayLoadTok();
  if (!t || !t.refresh_token) return null;
  if (t.access_token && t.expires_at && Date.now() < Number(t.expires_at) - 60000) return t.access_token;
  const j = await ebayTokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: EBAY_SCOPES });
  const nt = { refresh_token: t.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in * 1000) };
  await ebaySaveTok(nt);
  return nt.access_token;
}
async function ebayGet(url, at) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + at, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU', 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('eBay API ' + r.status + ': ' + JSON.stringify(j).slice(0, 300));
  return j;
}

// Marketplace account-deletion notification endpoint (required to enable the Production keyset)
app.get('/api/ebay/deletion', (req, res) => {
  const challenge = req.query.challenge_code;
  if (!challenge) return res.status(400).json({ error: 'missing challenge_code' });
  const endpoint = APP_URL + '/api/ebay/deletion';
  const h = crypto.createHash('sha256');
  h.update(challenge); h.update(EBAY_VERIFICATION_TOKEN); h.update(endpoint);
  res.status(200).json({ challengeResponse: h.digest('hex') });
});
app.post('/api/ebay/deletion', (req, res) => res.status(200).send()); // we don't store other users' data; just acknowledge

// connection status
app.get('/api/ebay/status', auth, async (req, res) => {
  let connected = false;
  try { const t = await ebayLoadTok(); connected = !!(t && t.refresh_token); } catch (e) {}
  res.json({ connected, configured: !!(EBAY_CLIENT_ID && EBAY_RUNAME) });
});

// start OAuth — returns the eBay consent URL for the browser to open
app.get('/api/ebay/connect', auth, (req, res) => {
  if (!EBAY_CLIENT_ID || !EBAY_RUNAME) return res.status(400).json({ error: 'eBay keys not configured yet' });
  const state = crypto.randomBytes(8).toString('hex');
  const url = 'https://auth.ebay.com/oauth2/authorize?' + new URLSearchParams({
    client_id: EBAY_CLIENT_ID, response_type: 'code', redirect_uri: EBAY_RUNAME, scope: EBAY_SCOPES, state
  }).toString();
  res.json({ url });
});

// OAuth callback — eBay redirects the user here after consent
app.get('/api/ebay/callback', async (req, res) => {
  if (req.query.error) { console.error('eBay auth error:', req.query.error, req.query.error_description); return res.redirect('/?ebay=error&reason=' + encodeURIComponent(req.query.error_description || req.query.error)); }
  const code = req.query.code;
  if (!code) return res.redirect('/?ebay=declined');
  try {
    const j = await ebayTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: EBAY_RUNAME });
    await ebaySaveTok({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in * 1000) });
    res.redirect('/?ebay=connected');
  } catch (e) { console.error('eBay callback:', e.message); res.redirect('/?ebay=error&reason=' + encodeURIComponent(e.message)); }
});

// simple privacy policy page (eBay OAuth consent requires a privacy policy URL)
app.get('/privacy', (req, res) => res.send('<!doctype html><html><head><meta charset="utf-8"><title>Williams — Privacy Policy</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:48px auto;padding:0 18px;line-height:1.6;color:#222"><h1>Williams — Privacy Policy</h1><p>Williams is a private, single-user inventory and bookkeeping tool used by its owner. When connected to eBay, it accesses <strong>only the owner\'s own eBay account</strong> on a read-only basis to import the owner\'s own orders and fee data.</p><p>It does <strong>not</strong> collect, store, share, or sell any other person\'s personal information. eBay marketplace account-deletion notifications are acknowledged and no third-party user data is retained.</p><p>For any questions, contact the account owner.</p></body></html>'));

app.post('/api/ebay/disconnect', auth, async (req, res) => {
  if (pool) await pool.query('DELETE FROM ebay_tokens WHERE id=1'); else memTok = null;
  res.json({ ok: true });
});

// match an eBay order's line items to inventory by SKU (earliest unsold wins for multi-SKU listings)
function applyEbayOrders(state, orders, feeByOrder) {
  const byRef = {};
  state.transactions.forEach(t => t.items.forEach(it => {
    if (it.status !== 'sold') { const ref = String(t.txnNumber) + String(it.label || '').toLowerCase(); (byRef[ref] = byRef[ref] || []).push(it); }
  }));
  let matched = 0, unmatched = 0, skippedUnpaid = 0;
  orders.forEach(o => {
    // only treat genuinely sold orders (paid, not cancelled) — avoids marking unpaid/Best-Offer-pending orders as sold
    if (o.orderPaymentStatus && o.orderPaymentStatus !== 'PAID' && o.orderPaymentStatus !== 'PARTIALLY_REFUNDED') { skippedUnpaid++; return; }
    if (o.cancelStatus && o.cancelStatus.cancelState && o.cancelStatus.cancelState !== 'NONE_REQUESTED') { skippedUnpaid++; return; }
    const date = (o.creationDate || '').slice(0, 10);
    const orderTotal = Number((o.pricingSummary && o.pricingSummary.total && o.pricingSummary.total.value) || 0);
    const f = feeByOrder[o.orderId] || { broker: 0, shipping: 0 };
    (o.lineItems || []).forEach(li => {
      const price = Number((li.total && li.total.value) || (li.lineItemCost && li.lineItemCost.value) || 0);
      const share = orderTotal > 0 ? (price / orderTotal) : 1;
      const broker = Math.round(f.broker * share * 100) / 100;
      const shipping = Math.round(f.shipping * share * 100) / 100;
      const skus = String(li.sku || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      let assigned = false;
      for (const sku of skus) {
        const list = byRef[sku];
        if (list && list.length) {
          const it = list.shift();
          it.status = 'sold';
          it.sale = { broker: 'eBay', date, salePrice: price, saleAmount: price, fees: broker, shipping: shipping || ((it.sale && it.sale.shipping) || 0), other: 0, ebayOrderId: o.orderId };
          matched++; assigned = true; break;
        }
      }
      if (!assigned) unmatched++;
    });
  });
  return { orders: orders.length, matched, unmatched, skippedUnpaid };
}

// pull sold orders + fees, match by SKU, save
app.post('/api/ebay/sync', auth, async (req, res) => {
  try {
    const at = await ebayAccessToken();
    if (!at) return res.status(400).json({ error: 'eBay not connected' });
    let orders = [], offset = 0;
    for (let p = 0; p < 15; p++) {
      const j = await ebayGet('https://api.ebay.com/sell/fulfillment/v1/order?limit=200&offset=' + offset, at);
      const batch = j.orders || [];
      orders = orders.concat(batch);
      if (batch.length < 200) break; offset += batch.length;
    }
    let txns = [], fo = 0;
    for (let p = 0; p < 15; p++) {
      let j; try { j = await ebayGet('https://apiz.ebay.com/sell/finances/v1/transaction?limit=200&offset=' + fo, at); } catch (e) { console.error('finances:', e.message); break; }
      const batch = j.transactions || [];
      txns = txns.concat(batch);
      if (batch.length < 200) break; fo += batch.length;
    }
    // Classify eBay fees per order:
    //  broker  = all eBay selling fees: SALE.totalFeeAmount (final value, fixed, international, regulatory)
    //            + NON_SALE_CHARGE transactions tied to the order (promoted-listing AD fees & separately-billed fees)
    //  shipping = SHIPPING_LABEL transactions (eBay-purchased postage)
    const feeByOrder = {};
    const addFee = (oid, kind, amt) => { if (!oid || !amt) return; (feeByOrder[oid] = feeByOrder[oid] || { broker: 0, shipping: 0 }); feeByOrder[oid][kind] += amt; };
    txns.forEach(tx => {
      let orderId = tx.orderId || null;
      if (!orderId && Array.isArray(tx.references)) { const r = tx.references.find(x => x.referenceType === 'ORDER_ID'); orderId = r ? r.referenceId : null; }
      if (!orderId) return;
      const amt = Number((tx.amount && tx.amount.value) || 0);
      if (tx.transactionType === 'SALE') addFee(orderId, 'broker', Number((tx.totalFeeAmount && tx.totalFeeAmount.value) || 0));
      else if (tx.transactionType === 'NON_SALE_CHARGE') addFee(orderId, 'broker', amt);
      else if (tx.transactionType === 'SHIPPING_LABEL') addFee(orderId, 'shipping', amt);
    });
    const state = await loadStateInternal();
    if (!state || !Array.isArray(state.transactions)) return res.status(400).json({ error: 'no inventory data' });
    const summary = applyEbayOrders(state, orders, feeByOrder);
    await saveStateInternal(state);
    res.json(summary);
  } catch (e) { console.error('eBay sync:', e); res.status(500).json({ error: e.message }); }
});

// quick diagnostic
app.get('/api/ebay/debug', auth, async (req, res) => {
  try {
    const at = await ebayAccessToken();
    if (!at) return res.json({ connected: false });
    const o = await ebayGet('https://api.ebay.com/sell/fulfillment/v1/order?limit=3', at);
    res.json({ connected: true, total: o.total, sampleSkus: (o.orders || []).flatMap(x => (x.lineItems || []).map(l => l.sku)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, db: !!pool }));

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log('Inventory Tagger listening on port ' + PORT)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
