import * as THREE from 'three';
import { loadCity } from './world.js';
import { createAvatar, createEncounterRing } from './avatar.js';
import { connectRealtime, api } from './net.js';
import { createMaps } from './minimap.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('#scene').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const SKY = new THREE.Color('#cfe3f3');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 400, 2600);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 9000);
scene.add(new THREE.HemisphereLight('#ffffff', '#b8b0a0', 1.6));
const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
sun.position.set(-0.6, 1, 0.35);
scene.add(sun);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------- state ----------
let world, maps, net = null;
let user = null;          // signed-in account, or null for guests
let me = null;            // {id, name, color, guest, userId}
let myAvatar = null;
let radius = 30;
const pos = { x: 0, z: 0, ry: 0 };
const others = new Map(); // playerId -> remote player
let social = { incoming: [], outgoing: [], connections: [] };
const rel = { connected: new Set(), outgoing: new Set(), incoming: new Map() }; // by userId
const ring = createEncounterRing(30);
scene.add(ring);

// ---------- boot ----------
(async function boot() {
  try {
    world = await loadCity((p, text) => { $('#loadbar').style.width = `${Math.round(p * 100)}%`; $('#loadtext').textContent = text; });
  } catch (e) {
    $('#loadtext').textContent = `Couldn't load the city: ${e.message}`;
    return;
  }
  scene.add(world.group);
  maps = createMaps(world, { miniCanvas: $('#minimap'), fullCanvas: $('#fullmap-canvas') });
  buildLandmarkLabels();
  buildJumpList();
  const common = world.landmarks.find((l) => l.name === 'Boston Common');
  Object.assign(pos, { x: common.x, z: common.z });
  $('#loading').classList.add('hidden');
  try { user = (await api('/api/me')).user; } catch { user = null; }
  if (user) enterWorld(); else showWelcome(true);
  requestAnimationFrame(loop);
})();

// ---------- auth UI ----------
function showWelcome(first) {
  $('#welcome').classList.remove('hidden');
  $('#guest-btn').textContent = first ? 'Explore as a guest' : 'Keep exploring as a guest';
  $('#auth-error').textContent = '';
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#login-form').classList.toggle('hidden', t.dataset.tab !== 'login');
  $('#register-form').classList.toggle('hidden', t.dataset.tab !== 'register');
  $('#auth-error').textContent = '';
}));
async function submitAuth(e, path) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    user = (await api(path, { method: 'POST', body })).user;
    e.target.reset();
    $('#welcome').classList.add('hidden');
    enterWorld();
    toast(path.includes('register') ? `Welcome, ${user.displayName}! Walk up to people to connect.` : `Welcome back, ${user.displayName}.`);
  } catch (err) { $('#auth-error').textContent = err.message; }
  btn.disabled = false;
}
$('#login-form').addEventListener('submit', (e) => submitAuth(e, '/api/login'));
$('#register-form').addEventListener('submit', (e) => submitAuth(e, '/api/register'));
$('#guest-btn').addEventListener('click', () => { $('#welcome').classList.add('hidden'); if (!net) enterWorld(); });
$('#account-btn').addEventListener('click', () => {
  if (!user) return showWelcome(false);
  const f = $('#profile-form');
  f.displayName.value = user.displayName; f.bio.value = user.bio; f.color.value = user.color;
  $('#profile-error').textContent = '';
  $('#account').classList.remove('hidden');
});
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    user = (await api('/api/me', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) })).user;
    me.name = user.displayName; me.color = user.color;
    myAvatar.userData.setColor(user.color);
    updateHud();
    $('#account').classList.add('hidden');
    toast('Profile saved.');
  } catch (err) { $('#profile-error').textContent = err.message; }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  user = null;
  $('#account').classList.add('hidden');
  enterWorld();
  toast('Signed out. You are now exploring as a guest.');
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden')));

// ---------- realtime ----------
function enterWorld() {
  $('#hud').classList.remove('hidden');
  if (net) net.close();
  for (const o of others.values()) removeOther(o.id);
  net = connectRealtime({
    welcome(m) {
      me = m.you; radius = m.radius;
      ring.geometry.dispose(); ring.geometry = new THREE.RingGeometry(radius - 0.35, radius, 96);
      $('#radius').textContent = radius;
      if (myAvatar) scene.remove(myAvatar);
      myAvatar = createAvatar(me); scene.add(myAvatar);
      teleport(m.spawn.x, m.spawn.z, false);
      for (const id of [...others.keys()]) removeOther(id);
      for (const p of m.players) addOther(p);
      updateHud();
      refreshSocial();
    },
    join(m) { addOther(m.player); },
    leave(m) { removeOther(m.id); },
    s(m) {
      for (const [id, x, z, ry, a] of m.p) {
        const o = others.get(id);
        if (!o) continue;
        if (Math.hypot(x - o.tx, z - o.tz) > 60) { o.cx = x; o.cz = z; }
        Object.assign(o, { tx: x, tz: z, try: ry, moving: a });
      }
    },
    profile(m) {
      const o = others.get(m.player.id); if (!o) return;
      Object.assign(o, m.player); o.avatar.userData.setColor(m.player.color); o.labelDirty = true;
    },
    wave(m) {
      const o = m.id === me?.id ? null : others.get(m.id);
      (o ? o.avatar : myAvatar)?.userData.wave();
      if (o) { o.waveUntil = performance.now() + 2500; o.labelDirty = true; }
    },
    request(m) {
      refreshSocial();
      toast(`${esc(m.from.name)} wants to connect (${esc(m.place)}).`, [
        { label: 'Accept', cls: 'ok', run: () => respond(m.requestId, true) },
        { label: 'Decline', run: () => respond(m.requestId, false) },
      ], 15000);
    },
    sent(m) { toast(`Connection request sent to ${esc(m.to)}.`); refreshSocial(); },
    connected(m) { toast(`🎉 You're now connected with ${esc(m.with)}.`); refreshSocial(); },
    social() { refreshSocial(); },
    err(m) { toast(esc(m.msg)); },
    kicked(m) { toast(esc(m.reason), [{ label: 'Reload', run: () => location.reload() }], 600000); },
    close() { $('#online').textContent = 'Reconnecting…'; },
  });
}

function addOther(p) {
  if (others.has(p.id) || p.id === me?.id) return;
  const avatar = createAvatar(p);
  avatar.position.set(p.x, 0, p.z);
  scene.add(avatar);
  const label = document.createElement('div');
  $('#labels').appendChild(label);
  others.set(p.id, { ...p, avatar, label, labelDirty: true, tx: p.x, tz: p.z, try: p.ry, cx: p.x, cz: p.z, cry: p.ry, speed: 0, moving: 0 });
}
function removeOther(id) {
  const o = others.get(id); if (!o) return;
  scene.remove(o.avatar); o.label.remove(); others.delete(id);
}

async function refreshSocial() {
  rel.connected.clear(); rel.outgoing.clear(); rel.incoming.clear();
  if (user) {
    try { social = await api('/api/social'); } catch { social = { incoming: [], outgoing: [], connections: [] }; }
  } else social = { incoming: [], outgoing: [], connections: [] };
  social.connections.forEach((c) => rel.connected.add(c.user_id));
  social.outgoing.forEach((r) => rel.outgoing.add(r.user_id));
  social.incoming.forEach((r) => rel.incoming.set(r.user_id, r.id));
  const n = social.incoming.length;
  $('#req-count').textContent = n; $('#req-count').classList.toggle('hidden', !n);
  for (const o of others.values()) o.labelDirty = true;
  renderSocial(); nearbyKey = '';
}
async function respond(id, accept) {
  try { await api(`/api/requests/${id}/respond`, { method: 'POST', body: { accept } }); } catch (e) { toast(esc(e.message)); }
  refreshSocial();
}

// ---------- HUD ----------
function updateHud() {
  $('#me-dot').style.background = me.color;
  $('#me-name').textContent = me.name;
  $('#me-badge').textContent = me.guest ? 'Guest' : 'Member';
  $('#me-badge').className = 'badge' + (me.guest ? ' guest' : '');
  $('#account-btn').textContent = user ? 'Profile' : 'Sign in / Join';
}

let nearbyKey = '';
const metRecently = new Map();
function updateNearby() {
  if (!me) return;
  const near = [...others.values()]
    .map((o) => ({ o, d: Math.hypot(o.cx - pos.x, o.cz - pos.z) }))
    .filter((e) => e.d <= radius).sort((a, b) => a.d - b.d);
  for (const { o } of near) {
    const last = metRecently.get(o.id) || 0;
    if (performance.now() - last > 120000) toast(`You ran into ${esc(o.name)}${o.guest ? ' (guest)' : ''}.`);
    metRecently.set(o.id, performance.now());
  }
  const key = near.map((e) => e.o.id + e.o.name).join('|');
  if (key === nearbyKey) return;
  nearbyKey = key;
  $('#nearby').classList.toggle('hidden', !near.length);
  $('#nearby-list').innerHTML = near.map(({ o }) => {
    let action = '';
    if (o.guest) action = '<span class="status">Guest</span>';
    else if (me.guest) action = '';
    else if (rel.connected.has(o.userId)) action = '<span class="status">✓ Connected</span>';
    else if (rel.incoming.has(o.userId)) action = `<button class="small ok" data-accept="${rel.incoming.get(o.userId)}">Accept</button>`;
    else if (rel.outgoing.has(o.userId)) action = '<span class="status">Request sent</span>';
    else action = `<button class="small primary" data-connect="${o.id}">Connect</button>`;
    return `<div class="person"><span class="dot" style="background:${esc(o.guest ? '#9aa0a6' : o.color)}"></span>
      <div class="info"><div class="name">${esc(o.name)}</div>${o.bio ? `<div class="bio">${esc(o.bio)}</div>` : ''}</div>${action}</div>`;
  }).join('') + (me.guest && near.some((e) => !e.o.guest) ? '<div class="cta">Want to connect? <a data-join>Create a free account</a> — guests can look but not interact.</div>' : '');
}
$('#nearby-list').addEventListener('click', (e) => {
  const c = e.target.closest('[data-connect]'), a = e.target.closest('[data-accept]'), j = e.target.closest('[data-join]');
  if (c) { c.disabled = true; net.send({ t: 'connect', target: c.dataset.connect }); }
  if (a) { a.disabled = true; respond(Number(a.dataset.accept), true); }
  if (j) { showWelcome(false); document.querySelector('.tab[data-tab=register]').click(); }
});

function renderSocial() {
  const b = $('#social-body');
  if (!user) {
    b.innerHTML = `<p>You're exploring as a guest. Guests can see everyone, but connecting with people needs an account.</p><button class="primary" id="social-join">Create an account</button>`;
    $('#social-join').onclick = () => { $('#social').classList.add('hidden'); showWelcome(false); document.querySelector('.tab[data-tab=register]').click(); };
    return;
  }
  const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  const person = (r, extra) => `<div class="person"><span class="dot" style="background:${esc(r.color)}"></span><div class="info"><div class="name">${r.online ? '<span class="online-dot" title="Online"></span>' : ''}${esc(r.display_name)} <span class="muted small">@${esc(r.username)}</span></div><div class="bio">${esc(r.bio || '')}</div><div class="status">${r.place ? `Met ${esc(r.place)}` : ''} ${when(r.responded_at || r.created_at)}</div></div><div class="btns">${extra}</div></div>`;
  b.innerHTML = `
    <div class="section">Requests (${social.incoming.length})</div>
    ${social.incoming.map((r) => person(r, `<button class="small ok" data-resp="${r.id}" data-ok="1">Accept</button><button class="small" data-resp="${r.id}">Decline</button>`)).join('') || '<p class="muted small">No pending requests.</p>'}
    <div class="section">Connections (${social.connections.length})</div>
    ${social.connections.map((r) => person(r, `${r.online ? `<button class="small" data-goto="${r.user_id}">Go to</button>` : ''}<button class="small" data-remove="${r.user_id}" title="Remove connection">✕</button>`)).join('') || '<p class="muted small">No connections yet. Walk up to someone and press Connect.</p>'}
    ${social.outgoing.length ? `<div class="section">Sent (${social.outgoing.length})</div>${social.outgoing.map((r) => person(r, '<span class="status">Pending</span>')).join('')}` : ''}`;
}
$('#social-body').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.resp) respond(Number(t.dataset.resp), !!t.dataset.ok);
  if (t.dataset.goto) {
    const c = social.connections.find((x) => x.user_id === Number(t.dataset.goto));
    const o = [...others.values()].find((x) => x.userId === c?.user_id);
    if (o) { teleport(o.cx + 3, o.cz + 3); $('#social').classList.add('hidden'); toast(`Travelled to ${esc(o.name)}.`); }
    else toast('They just went offline.');
  }
  if (t.dataset.remove) {
    try { await api(`/api/connections/${t.dataset.remove}`, { method: 'DELETE' }); } catch (err) { toast(esc(err.message)); }
    refreshSocial();
  }
});
$('#social-btn').addEventListener('click', () => { $('#social').classList.toggle('hidden'); refreshSocial(); });

function toast(html, actions = [], ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${html}</span>`;
  for (const a of actions) {
    const b = document.createElement('button'); b.textContent = a.label; if (a.cls) b.className = a.cls;
    b.onclick = () => { a.run(); el.remove(); }; el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

// ---------- maps & travel ----------
function teleport(x, z, announce = true) {
  const b = world.bounds;
  x = Math.min(b.maxX, Math.max(b.minX, x)); z = Math.min(b.maxZ, Math.max(b.minZ, z));
  // spiral outwards to the nearest open spot with a few metres of room around it
  const roomy = (px, pz) => { if (world.blocked(px, pz)) return false; for (let a = 0; a < 8; a++) if (world.blocked(px + Math.cos(a * 0.785) * 5, pz + Math.sin(a * 0.785) * 5)) return false; return true; };
  search: for (let r = 0; r < 300; r += 3) {
    const steps = Math.max(1, Math.round(r));
    for (let a = 0; a < steps; a++) {
      const nx = x + Math.cos(a / steps * Math.PI * 2) * r, nz = z + Math.sin(a / steps * Math.PI * 2) * r;
      if (roomy(nx, nz)) { x = nx; z = nz; break search; }
    }
  }
  pos.x = x; pos.z = z;
  lastSent = 0;
  if (announce) sendMove(true);
}
function buildJumpList() {
  $('#jump-list').innerHTML = world.landmarks.filter((l) => l.name !== 'Charles River').map((l) => `<button data-jump="${esc(l.name)}">${esc(l.name)}</button>`).join('');
  $('#jump-list').addEventListener('click', (e) => {
    const n = e.target.dataset.jump; if (!n) return;
    const l = world.landmarks.find((x) => x.name === n);
    teleport(l.x, l.z); $('#fullmap').classList.add('hidden');
  });
}
function openMap() { $('#fullmap').classList.remove('hidden'); }
$('#map-btn').addEventListener('click', openMap);
$('#minimap').addEventListener('click', openMap);
$('#fullmap-canvas').addEventListener('click', (e) => {
  const p = maps.fullToWorld(e.clientX, e.clientY);
  if (p) { teleport(p.x, p.z); $('#fullmap').classList.add('hidden'); }
});

const landmarkEls = [];
function buildLandmarkLabels() {
  for (const l of world.landmarks) {
    const el = document.createElement('div'); el.className = 'landmark'; el.textContent = l.name;
    $('#labels').appendChild(el); landmarkEls.push({ l, el, v: new THREE.Vector3(l.x, 45, l.z) });
  }
}

// ---------- input ----------
const keys = new Set();
const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
addEventListener('keydown', (e) => {
  if (typing()) return;
  keys.add(e.code);
  if (e.code === 'KeyM') $('#fullmap').classList.toggle('hidden');
  if (e.code === 'KeyC' && me) { $('#social').classList.toggle('hidden'); refreshSocial(); }
  if (e.code === 'KeyQ' && me) { if (me.guest) toast('Create an account to wave at people.'); else net.send({ t: 'wave' }); }
  if (e.code === 'Escape') document.querySelectorAll('#fullmap, #social, #account').forEach((x) => x.classList.add('hidden'));
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const cam = { yaw: 0.6, pitch: 0.42, dist: 14 };
let camPitch = cam.pitch; // smoothed pitch actually used (may be raised to see over buildings)
let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  cam.yaw -= (e.clientX - drag.x) * 0.006;
  cam.pitch = Math.min(1.45, Math.max(0.05, cam.pitch + (e.clientY - drag.y) * 0.005));
  drag = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', () => { drag = null; });
renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.min(900, Math.max(3, cam.dist * Math.exp(e.deltaY * 0.0012))); }, { passive: false });

// touch joystick
const joy = { x: 0, y: 0 };
(() => {
  const el = $('#joystick'), knob = el.querySelector('.knob');
  const move = (e) => {
    const r = el.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy), max = r.width / 2;
    if (m > max) { dx *= max / m; dy *= max / m; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`; joy.x = dx / max; joy.y = dy / max;
  };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); move(e); });
  el.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') move(e); });
  el.addEventListener('pointerup', () => { joy.x = joy.y = 0; knob.style.transform = ''; });
})();

// ---------- loop ----------
let lastSent = 0, lastMoveKey = '', lastNearby = 0, lastMini = 0, prev = performance.now(), mySpeed = 0;
const v3 = new THREE.Vector3();

function sendMove(force) {
  if (!net || !me) return;
  const key = `${pos.x.toFixed(1)},${pos.z.toFixed(1)},${pos.ry.toFixed(2)},${mySpeed > 0.3 ? 1 : 0}`;
  const now = performance.now();
  if (!force && (now - lastSent < 100 || (key === lastMoveKey && now - lastSent < 2000))) return;
  lastSent = now; lastMoveKey = key;
  net.send({ t: 'm', x: pos.x, z: pos.z, ry: pos.ry, a: mySpeed > 0.3 ? 1 : 0 });
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - prev) / 1000); prev = now;

  // --- local movement ---
  let f = 0, s = 0;
  if (!typing()) {
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  }
  f -= joy.y; s += joy.x;
  mySpeed = 0;
  if (me && (f || s)) {
    const len = Math.hypot(f, s); f /= Math.max(1, len); s /= Math.max(1, len);
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight') || Math.hypot(joy.x, joy.y) > 0.9;
    const speed = (run ? 13 : 4.5) * Math.max(1, cam.dist / 80);
    const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw), rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
    const dx = (fx * f + rx * s) * speed * dt, dz = (fz * f + rz * s) * speed * dt;
    const b = world.bounds;
    const ok = (x, z) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && !world.blocked(x, z);
    if (ok(pos.x + dx, pos.z + dz)) { pos.x += dx; pos.z += dz; }
    else if (ok(pos.x + dx, pos.z)) pos.x += dx;
    else if (ok(pos.x, pos.z + dz)) pos.z += dz;
    pos.ry = Math.atan2(dx, dz);
    mySpeed = Math.hypot(dx, dz) / dt;
  }
  if (myAvatar) {
    myAvatar.position.set(pos.x, 0, pos.z);
    myAvatar.rotation.y = lerpAngle(myAvatar.rotation.y, pos.ry, Math.min(1, dt * 12));
    myAvatar.userData.animate(dt, mySpeed);
    ring.position.set(pos.x, 0.06, pos.z);
    ring.visible = !me.guest;
    sendMove(false);
  }

  // --- remote players: interpolate toward last snapshot ---
  for (const o of others.values()) {
    const k = Math.min(1, dt * 8);
    const px = o.cx, pz = o.cz;
    o.cx += (o.tx - o.cx) * k; o.cz += (o.tz - o.cz) * k;
    o.cry = lerpAngle(o.cry, o.try, k);
    o.speed = o.moving ? Math.max(1.5, Math.hypot(o.cx - px, o.cz - pz) / Math.max(dt, 1e-3)) : 0;
    o.avatar.position.set(o.cx, 0, o.cz); o.avatar.rotation.y = o.cry;
    o.avatar.userData.animate(dt, o.speed);
  }

  // --- camera ---
  // Keep the camera out of buildings: if the view is blocked, rise up over the rooftops
  // (raise the pitch) before resorting to moving in closer.
  const clear = (pitch, d) => {
    const cp = Math.cos(pitch), sy = Math.sin(pitch), sx = Math.sin(cam.yaw) * cp, sz = Math.cos(cam.yaw) * cp;
    const step = Math.max(0.75, d / 160);
    for (let t = 1.5; t < d; t += step) if (world.heightAt(pos.x + sx * t, pos.z + sz * t) > 1.6 + sy * t - 0.5) return t - step;
    return d;
  };
  let wantPitch = null;
  for (let p = cam.pitch; p < 1.46; p += 0.08) if (clear(Math.min(p, 1.45), cam.dist) >= cam.dist) { wantPitch = Math.min(p, 1.45); break; }
  const boxedIn = wantPitch === null; // e.g. a narrow alley: look straight down from above instead
  camPitch += ((boxedIn ? 1.45 : wantPitch) - camPitch) * Math.min(1, dt * 5);
  const dist = boxedIn ? cam.dist : Math.max(1.5, clear(camPitch, cam.dist));
  const dir = [Math.sin(cam.yaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(cam.yaw) * Math.cos(camPitch)];
  camera.position.set(pos.x + dir[0] * dist, 1.6 + dir[1] * dist, pos.z + dir[2] * dist);
  camera.lookAt(pos.x, 1.4, pos.z);
  scene.fog.near = 300 + cam.dist * 2; scene.fog.far = 2400 + cam.dist * 4;

  renderer.render(scene, camera);
  updateLabels();

  if (now - lastNearby > 250) { lastNearby = now; updateNearby(); updatePlace(); }
  if (me && now - lastMini > 100) {
    lastMini = now;
    const list = [...others.values()].map((o) => ({ x: o.cx, z: o.cz, color: o.color, guest: o.guest, userId: o.userId }));
    maps.drawMini(pos, list, rel.connected);
    if (!$('#fullmap').classList.contains('hidden')) maps.drawFull(pos, list, rel.connected);
    $('#online').textContent = `${others.size + 1} online`;
  }
}

function lerpAngle(a, b, t) { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; }

function project(v) {
  v3.copy(v).project(camera);
  if (v3.z > 1 || v3.z < -1) return null;
  return [(v3.x * 0.5 + 0.5) * innerWidth, (-v3.y * 0.5 + 0.5) * innerHeight];
}
const headV = new THREE.Vector3();
function updateLabels() {
  for (const o of others.values()) {
    const d = Math.hypot(o.cx - pos.x, o.cz - pos.z);
    const friend = rel.connected.has(o.userId);
    const maxD = friend ? 600 : 150 + cam.dist;
    headV.set(o.cx, 2.15, o.cz);
    const p = d < maxD ? project(headV) : null;
    if (!p) { o.label.style.display = 'none'; continue; }
    if (o.labelDirty || (o.waveUntil && performance.now() > o.waveUntil)) {
      if (o.waveUntil && performance.now() > o.waveUntil) o.waveUntil = 0;
      o.label.className = 'label' + (o.guest ? ' guest' : '') + (friend ? ' friend' : '');
      o.label.innerHTML = `${o.waveUntil ? '<span class="wave">👋</span>' : ''}${esc(o.name)}${o.guest ? ' · guest' : ''}`;
      o.labelDirty = false;
    }
    o.label.style.display = '';
    o.label.style.left = `${p[0]}px`; o.label.style.top = `${p[1]}px`;
  }
  for (const { l, el, v } of landmarkEls) {
    const d = Math.hypot(l.x - pos.x, l.z - pos.z);
    const p = d > 120 && d < 1500 + cam.dist * 3 ? project(v) : null;
    if (!p) { el.style.display = 'none'; continue; }
    el.style.display = ''; el.style.left = `${p[0]}px`; el.style.top = `${p[1]}px`;
  }
}

let lastPlace = '';
function updatePlace() {
  if (!world) return;
  let best = null, bd = Infinity;
  for (const l of world.landmarks) { const d = Math.hypot(l.x - pos.x, l.z - pos.z); if (d < bd) { bd = d; best = l; } }
  const txt = bd < 900 ? `📍 ${best.name}` : '📍 Boston';
  if (txt !== lastPlace) { $('#place').textContent = txt; lastPlace = txt; }
}
