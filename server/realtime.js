// Real-time presence over WebSockets: positions, joins/leaves, and in-world connection requests.
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { parseCookies } from './auth.js';

export const ENCOUNTER_RADIUS = 30; // metres: how close two people must be to send a connection request
const TICK_MS = 100;                // snapshot broadcast rate (10 Hz)
const GUEST_COLORS = ['#e07a5f', '#81b29a', '#f2cc8f', '#3d9be9', '#b388eb', '#ef8354', '#5fb49c', '#d4a5a5'];

export function attachRealtime({ server, db, sessions, world }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const players = new Map();     // playerId -> player
  const byUser = new Map();      // userId -> playerId

  const pub = (p) => ({ id: p.id, name: p.name, color: p.color, guest: p.guest, userId: p.userId, bio: p.bio });
  const send = (p, msg) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); };
  const broadcast = (msg, except) => { const s = JSON.stringify(msg); for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const [minX, minY, maxX, maxY] = world.bounds;

  wss.on('connection', (ws, req) => {
    const uid = sessions.verify(parseCookies(req.headers.cookie).sid);
    const user = uid ? db.userById(uid) : null;
    const id = crypto.randomBytes(6).toString('hex');

    // One live avatar per account: a newer tab replaces the older one.
    if (user && byUser.has(user.id)) {
      const old = players.get(byUser.get(user.id));
      if (old) { send(old, { t: 'kicked', reason: 'You opened the city in another tab.' }); old.ws.close(4001, 'replaced'); }
    }

    const spawn = user && user.last_x != null ? { x: user.last_x, z: user.last_z } : world.spawnPoint();
    const p = {
      id, ws,
      userId: user ? user.id : null,
      guest: !user,
      name: user ? user.display_name : `Guest ${1000 + crypto.randomInt(9000)}`,
      color: user ? user.color : GUEST_COLORS[crypto.randomInt(GUEST_COLORS.length)],
      bio: user ? user.bio : '',
      x: spawn.x, z: spawn.z, ry: 0, a: 0,
      lastSaved: 0,
    };
    players.set(id, p);
    if (user) byUser.set(user.id, id);

    send(p, { t: 'welcome', you: pub(p), spawn, radius: ENCOUNTER_RADIUS, players: [...players.values()].filter((o) => o !== p).map((o) => ({ ...pub(o), x: o.x, z: o.z, ry: o.ry })) });
    broadcast({ t: 'join', player: { ...pub(p), x: p.x, z: p.z, ry: p.ry } }, p);

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'm': { // movement update
          if (![msg.x, msg.z, msg.ry].every(Number.isFinite)) return;
          p.x = clamp(msg.x, minX, maxX); p.z = clamp(msg.z, -maxY, -minY);
          p.ry = msg.ry; p.a = msg.a ? 1 : 0;
          if (p.userId && Date.now() - p.lastSaved > 5000) { db.savePosition(p.userId, p.x, p.z); p.lastSaved = Date.now(); }
          break;
        }
        case 'connect': return handleConnect(p, msg.target);
        case 'wave': { // small greeting emote, registered users only
          if (p.guest) return send(p, { t: 'err', msg: 'Create an account to interact with people.' });
          broadcast({ t: 'wave', id: p.id });
          break;
        }
      }
    });

    ws.on('close', () => {
      if (players.get(id) !== p) return;
      players.delete(id);
      if (p.userId) { db.savePosition(p.userId, p.x, p.z); if (byUser.get(p.userId) === id) byUser.delete(p.userId); }
      broadcast({ t: 'leave', id });
    });
  });

  function handleConnect(p, targetId) {
    const err = (msg) => send(p, { t: 'err', msg });
    if (p.guest) return err('Create an account to connect with people.');
    const o = players.get(targetId);
    if (!o || o === p) return err('That person is no longer here.');
    if (o.guest) return err(`${o.name} is exploring as a guest and can't receive connection requests.`);
    if (Math.hypot(o.x - p.x, o.z - p.z) > ENCOUNTER_RADIUS + 5) return err(`Walk closer to ${o.name} to connect.`);
    const existing = db.relationBetween(p.userId, o.userId);
    if (existing?.status === 'accepted') return err(`You're already connected with ${o.name}.`);
    if (existing?.status === 'pending') {
      // They already asked us: treat our request as acceptance.
      if (existing.from_id === o.userId) { db.respond(existing.id, 'accepted'); notifyAccepted(existing.id); return; }
      return err(`Your request to ${o.name} is still pending.`);
    }
    const place = world.placeName(p.x, p.z);
    const r = db.createRequest(p.userId, o.userId, place);
    send(p, { t: 'sent', to: o.name, requestId: r.id });
    send(o, { t: 'request', requestId: r.id, from: pub(p), place });
  }

  function notifyAccepted(requestId) {
    const r = db.requestById(requestId);
    if (!r) return;
    for (const [me, other] of [[r.from_id, r.to_id], [r.to_id, r.from_id]]) {
      const pp = players.get(byUser.get(me));
      const ou = db.userById(other);
      if (pp && ou) send(pp, { t: 'connected', with: ou.display_name, userId: ou.id, place: r.place });
    }
  }

  // Lightweight position snapshots: [id, x, z, rotation, animating]
  const timer = setInterval(() => {
    if (!players.size) return;
    const snap = JSON.stringify({ t: 's', p: [...players.values()].map((o) => [o.id, Math.round(o.x * 10) / 10, Math.round(o.z * 10) / 10, Math.round(o.ry * 100) / 100, o.a]) });
    for (const o of players.values()) if (o.ws.readyState === 1) o.ws.send(snap);
  }, TICK_MS);
  wss.on('close', () => clearInterval(timer));

  return {
    wss,
    notifyAccepted,
    notifyUser(userId, msg) { const p = players.get(byUser.get(userId)); if (p) send(p, msg); },
    onlinePlayerFor(userId) { const p = players.get(byUser.get(userId)); return p ? { id: p.id, x: p.x, z: p.z } : null; },
    updateProfile(userId, user) {
      const p = players.get(byUser.get(userId));
      if (!p) return;
      Object.assign(p, { name: user.display_name, color: user.color, bio: user.bio });
      broadcast({ t: 'profile', player: pub(p) });
    },
    stats: () => ({ online: players.size, guests: [...players.values()].filter((p) => p.guest).length }),
  };
}
