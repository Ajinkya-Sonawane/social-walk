// End-to-end test of the server: registration, login, presence, guest restrictions,
// the encounter-distance rule and the request/accept flow. Starts its own server on a temp DB.
import { spawn } from 'node:child_process';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'social-web-'));
let proc;

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: path.join(tmp, 'test.db'), SESSION_SECRET: 'test-secret' }, stdio: 'pipe',
  });
  await new Promise((res, rej) => { proc.stdout.on('data', (d) => String(d).includes('running') && res()); proc.on('exit', rej); });
});
after(() => { proc?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function call(p, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], data: await r.json() };
}

function client(cookie) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: cookie ? { cookie } : {} });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d); if (m.t === 's') return;
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  return {
    ws, inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    next(t, extra = () => true) {
      const found = inbox.find((m) => m.t === t && extra(m));
      if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((res, rej) => {
        const w = { pred: (m) => m.t === t && extra(m), res: (m) => { inbox.splice(inbox.indexOf(m), 1); res(m); } };
        waiters.push(w); setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), 4000);
      });
    },
  };
}

test('accounts, presence, guest limits and connecting', async () => {
  const a = await call('/api/register', { method: 'POST', body: { username: 'alice', password: 'password123', displayName: 'Alice', color: '#ff0000', bio: 'Hi' } });
  assert.equal(a.status, 201);
  assert.equal((await call('/api/register', { method: 'POST', body: { username: 'ALICE', password: 'password123' } })).status, 409, 'usernames are case-insensitive unique');
  assert.equal((await call('/api/register', { method: 'POST', body: { username: 'bob', password: 'short' } })).status, 400);
  const b = await call('/api/register', { method: 'POST', body: { username: 'bob', password: 'password456', displayName: 'Bob' } });
  assert.equal((await call('/api/login', { method: 'POST', body: { username: 'bob', password: 'nope' } })).status, 401);
  const bLogin = await call('/api/login', { method: 'POST', body: { username: 'bob', password: 'password456' } });
  assert.equal(bLogin.status, 200);
  assert.equal((await call('/api/me', { cookie: bLogin.cookie })).data.user.username, 'bob');

  const A = client(a.cookie); const wa = await A.next('welcome');
  const B = client(b.cookie); const wb = await B.next('welcome');
  const G = client(null); const wg = await G.next('welcome');
  assert.equal(wa.you.guest, false); assert.equal(wg.you.guest, true);
  assert.equal(wg.players.length, 2, 'guest sees both members');
  await A.next('join', (m) => m.player.id === wg.you.id);

  // put everyone in the same spot on Boston Common
  for (const [c, w] of [[A, wa], [B, wb], [G, wg]]) c.send({ t: 'm', x: wa.spawn.x, z: wa.spawn.z, ry: 0, a: 0 });
  await new Promise((r) => setTimeout(r, 150));

  G.send({ t: 'connect', target: wa.you.id });
  assert.match((await G.next('err')).msg, /account/i, 'guests cannot connect');
  A.send({ t: 'connect', target: wg.you.id });
  assert.match((await A.next('err')).msg, /guest/i, 'members cannot request guests');

  // too far away
  B.send({ t: 'm', x: wa.spawn.x + 200, z: wa.spawn.z, ry: 0, a: 0 });
  await new Promise((r) => setTimeout(r, 100));
  A.send({ t: 'connect', target: wb.you.id });
  assert.match((await A.next('err')).msg, /closer/i);

  // close enough
  B.send({ t: 'm', x: wa.spawn.x + 5, z: wa.spawn.z, ry: 0, a: 0 });
  await new Promise((r) => setTimeout(r, 100));
  A.send({ t: 'connect', target: wb.you.id });
  await A.next('sent');
  const req = await B.next('request');
  assert.equal(req.from.name, 'Alice');
  assert.match(req.place, /Boston Common/);
  A.send({ t: 'connect', target: wb.you.id });
  assert.match((await A.next('err')).msg, /pending/);

  const social = await call('/api/social', { cookie: b.cookie });
  assert.equal(social.data.incoming.length, 1);
  assert.equal((await call(`/api/requests/${req.requestId}/respond`, { method: 'POST', body: { accept: true }, cookie: a.cookie })).status, 404, 'only the recipient can respond');
  assert.equal((await call(`/api/requests/${req.requestId}/respond`, { method: 'POST', body: { accept: true }, cookie: b.cookie })).status, 200);
  assert.equal((await A.next('connected')).with, 'Bob');
  assert.equal((await B.next('connected')).with, 'Alice');
  const conns = (await call('/api/social', { cookie: a.cookie })).data.connections;
  assert.equal(conns.length, 1); assert.equal(conns[0].username, 'bob'); assert.ok(conns[0].online);
  assert.equal((await call('/api/social')).status, 401, 'guests have no social graph');

  G.ws.close();
  await A.next('leave', (m) => m.id === wg.you.id);
  for (const c of [A, B]) c.ws.close();
});
