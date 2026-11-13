// HTTP API + static client + WebSocket presence server.
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, makeSessions } from './auth.js';
import { attachRealtime } from './realtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'social-web.db');
const SECRET = process.env.SESSION_SECRET || loadOrCreateSecret();
const IS_PROD = process.env.NODE_ENV === 'production';

function loadOrCreateSecret() {
  const f = path.join(ROOT, 'data', '.session-secret');
  try { return fs.readFileSync(f, 'utf8'); } catch {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

// --- world metadata the server needs (bounds, spawn, place names) ---
const city = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/public/data/city.json'), 'utf8'));
const landmarks = city.landmarks.map(([name, x, y]) => ({ name, x, z: -y }));
const common = landmarks.find((l) => l.name === 'Boston Common');
const world = {
  bounds: city.bounds,
  spawnPoint: () => ({ x: common.x + (Math.random() - 0.5) * 30, z: common.z + (Math.random() - 0.5) * 30 }),
  placeName(x, z) {
    let best = null, bd = Infinity;
    for (const l of landmarks) { const d = Math.hypot(l.x - x, l.z - z); if (d < bd) { bd = d; best = l; } }
    return bd < 900 ? `near ${best.name}` : 'around Boston';
  },
};

const db = openDb(DB_FILE);
const sessions = makeSessions(SECRET);
const app = express();
const server = http.createServer(app);
const realtime = attachRealtime({ server, db, sessions, world });

app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

// --- auth helpers ---
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, color: u.color, bio: u.bio });
function setSession(res, userId) {
  res.cookie('sid', sessions.issue(userId), { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: sessions.maxAgeMs, path: '/' });
}
function currentUser(req) { const id = sessions.verify(req.cookies.sid); return id ? db.userById(id) : null; }
function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Sign in to do that.' });
  req.user = u; next();
}
function cleanProfile(body, existing = {}) {
  const displayName = String(body.displayName ?? existing.display_name ?? '').trim().slice(0, 24);
  const color = COLOR_RE.test(body.color) ? body.color : (existing.color || '#4f8cff');
  const bio = String(body.bio ?? existing.bio ?? '').trim().slice(0, 140);
  return { displayName, color, bio };
}

// Naive in-memory rate limit for auth endpoints (per IP).
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip, now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 10 * 60e3);
  if (a.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  a.push(now); attempts.set(key, a); next();
}

// --- API ---
app.post('/api/register', rateLimit, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const prof = cleanProfile({ ...req.body, displayName: req.body.displayName || username });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscores.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!prof.displayName) return res.status(400).json({ error: 'Display name is required.' });
  if (db.userByName(username)) return res.status(409).json({ error: 'That username is taken.' });
  const user = db.createUser({ username, passwordHash: hashPassword(password), ...prof });
  setSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/login', rateLimit, (req, res) => {
  const user = db.userByName(String(req.body.username || '').trim());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
  setSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => { res.clearCookie('sid', { path: '/' }); res.json({ ok: true }); });

app.get('/api/me', (req, res) => { const u = currentUser(req); res.json({ user: u ? publicUser(u) : null }); });

app.patch('/api/me', requireUser, (req, res) => {
  const prof = cleanProfile(req.body, req.user);
  if (!prof.displayName) return res.status(400).json({ error: 'Display name is required.' });
  db.updateProfile(req.user.id, prof);
  const u = db.userById(req.user.id);
  realtime.updateProfile(u.id, u);
  res.json({ user: publicUser(u) });
});

app.get('/api/social', requireUser, (req, res) => {
  const withOnline = (r) => ({ ...r, online: realtime.onlinePlayerFor(r.user_id) });
  res.json({
    incoming: db.incoming(req.user.id),
    outgoing: db.outgoing(req.user.id),
    connections: db.connections(req.user.id).map(withOnline),
  });
});

app.post('/api/requests/:id/respond', requireUser, (req, res) => {
  const r = db.requestById(Number(req.params.id));
  if (!r || r.to_id !== req.user.id || r.status !== 'pending') return res.status(404).json({ error: 'Request not found.' });
  const accept = !!req.body.accept;
  db.respond(r.id, accept ? 'accepted' : 'declined');
  if (accept) realtime.notifyAccepted(r.id);
  else realtime.notifyUser(r.from_id, { t: 'social' });
  res.json({ ok: true });
});

app.delete('/api/connections/:userId', requireUser, (req, res) => {
  const other = Number(req.params.userId);
  if (!db.removeConnection(req.user.id, other)) return res.status(404).json({ error: 'Not connected.' });
  realtime.notifyUser(other, { t: 'social' });
  res.json({ ok: true });
});

app.get('/api/stats', (req, res) => res.json(realtime.stats()));

// --- static client (built by Vite into dist/) ---
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('Client not built. Run `npm run build` (or `npm run dev` for development).'));
}

server.listen(PORT, () => console.log(`Social Web running at http://localhost:${PORT}`));
