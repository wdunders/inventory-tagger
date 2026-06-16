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

app.get('/api/health', (req, res) => res.json({ ok: true, db: !!pool }));

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log('Inventory Tagger listening on port ' + PORT)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
