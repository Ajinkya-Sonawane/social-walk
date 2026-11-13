// Real names in the world: shop/place signs near you, building names on rooftops,
// street-name signs, and "the street you're on". Data comes from details.json
// (Overture Maps places + building names, OpenStreetMap street names).
import * as THREE from 'three';

const PLACE_RADIUS = 110, BUILDING_RADIUS = 450, STREET_RADIUS = 140;
const MAX_PLACES = 28, MAX_BUILDINGS = 14, MAX_STREETS = 8;

const ICONS = [
  [/coffee|cafe|tea/, '☕'], [/bakery|dessert|ice_cream|donut/, '🥐'], [/bar|pub|brewery|wine|cocktail|night/, '🍸'],
  [/pizza/, '🍕'], [/restaurant|eatery|food_court|diner|grill|sushi|burger|sandwich|deli/, '🍽️'],
  [/grocery|supermarket|food_and_beverage|convenience|market/, '🛒'], [/pharmacy|drug/, '💊'],
  [/hospital|clinic|health|medical|dental|doctor|urgent/, '🏥'], [/bank|atm|credit_union|financial/, '🏦'],
  [/hotel|lodging|hostel|inn/, '🏨'], [/college|university|school|education|library/, '🎓'],
  [/church|worship|synagogue|mosque|temple/, '⛪'], [/museum|gallery|historic|monument|landmark|art/, '🏛️'],
  [/park|garden|playground/, '🌳'], [/gym|fitness|sport|yoga|climb/, '🏋️'], [/beauty|salon|barber|spa|nail/, '💇'],
  [/theater|theatre|cinema|music|concert|entertainment/, '🎭'], [/station|transit|subway|bus|train|parking/, '🚉'],
  [/book/, '📚'], [/fashion|apparel|clothing|shoe|jewel/, '👗'], [/store|shop|retail|boutique/, '🛍️'],
  [/office|service|law|attorney|real_estate|agency|consult/, '🏢'],
];
// Street-level businesses people walk past first; offices and services last.
const PRIORITY = /restaurant|eatery|coffee|cafe|bar|pub|bakery|store|shop|market|grocery|pharmacy|museum|park|hotel|theat|cinema|gym|library|church|university|college|landmark|historic|pizza|dessert|ice_cream/;

function grid(cell) {
  const map = new Map();
  return {
    add(x, z, v) { const k = Math.floor(x / cell) + ',' + Math.floor(z / cell); let a = map.get(k); if (!a) map.set(k, a = []); a.push(v); },
    near(x, z, r, out = []) {
      const x0 = Math.floor((x - r) / cell), x1 = Math.floor((x + r) / cell), z0 = Math.floor((z - r) / cell), z1 = Math.floor((z + r) / cell);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const a = map.get(i + ',' + j); if (a) out.push(...a); }
      return out;
    },
  };
}

export function createNames(details, world, layer) {
  const cats = details.placeCategories.map((c) => {
    const icon = (ICONS.find(([re]) => re.test(c)) || [null, '📍'])[1];
    return { name: c.replace(/_/g, ' '), icon, priority: PRIORITY.test(c) ? 1 : 0 };
  });
  const placeGrid = grid(60);
  for (const [name, ci, x, y, conf] of details.places) placeGrid.add(x, -y, { name, cat: cats[ci], x, z: -y, conf });
  const bGrid = grid(150);
  for (const [name, x, y, h, size] of details.buildingNames) bGrid.add(x, -y, { name, x, z: -y, h, size });
  const streetNames = world.data.streetNames;
  const sGrid = grid(80);
  for (const r of world.data.roads) {
    if (r[1] < 0) continue;
    for (let k = 2; k + 3 < r.length; k += 2) {
      const ax = r[k], az = -r[k + 1], bx = r[k + 2], bz = -r[k + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 3) continue;
      sGrid.add((ax + bx) / 2, (az + bz) / 2, { name: streetNames[r[1]], ax, az, bx, bz, cls: r[0] });
    }
  }

  // DOM label pool
  const pool = [];
  function el(i) {
    while (pool.length <= i) { const d = document.createElement('div'); layer.appendChild(d); pool.push({ d, key: '' }); }
    return pool[i];
  }
  let active = []; // [{key, cls, html, v: Vector3, dist}]
  let currentStreet = '';

  function refresh(px, pz) {
    const items = [];
    // places: nearest, street-level businesses first
    const places = placeGrid.near(px, pz, PLACE_RADIUS)
      .map((p) => ({ p, d: Math.hypot(p.x - px, p.z - pz) }))
      .filter((e) => e.d < PLACE_RADIUS)
      .sort((a, b) => (a.d - a.p.cat.priority * 40 - a.p.conf * 10) - (b.d - b.p.cat.priority * 40 - b.p.conf * 10))
      .slice(0, MAX_PLACES);
    for (const { p, d } of places) {
      items.push({ key: 'p' + p.name + p.x, cls: 'sign place-sign' + (d > 60 ? ' far' : ''), html: `<span class="ic">${p.cat.icon}</span>${esc(p.name)}`, title: p.cat.name, v: new THREE.Vector3(p.x, 3.4, p.z), d });
    }
    const bs = bGrid.near(px, pz, BUILDING_RADIUS)
      .map((b) => ({ b, d: Math.hypot(b.x - px, b.z - pz) }))
      .filter((e) => e.d < BUILDING_RADIUS + e.b.size)
      .sort((a, b) => (a.d - a.b.size) - (b.d - b.b.size))
      .slice(0, MAX_BUILDINGS);
    for (const { b, d } of bs) items.push({ key: 'b' + b.name + b.x, cls: 'sign building-sign', html: esc(b.name), v: new THREE.Vector3(b.x, b.h + 3, b.z), d });

    // streets: closest segment per name, plus the street you're on
    const best = new Map();
    let onStreet = null, onD = Infinity;
    for (const s of sGrid.near(px, pz, STREET_RADIUS)) {
      const [qx, qz] = closest(px, pz, s);
      const d = Math.hypot(qx - px, qz - pz);
      if (d < onD) { onD = d; onStreet = s; }
      const cur = best.get(s.name);
      if (!cur || d < cur.d) best.set(s.name, { s, d, qx, qz });
    }
    currentStreet = onStreet && onD < 25 ? onStreet.name : '';
    [...best.values()].sort((a, b) => a.d - b.d).slice(0, MAX_STREETS).forEach(({ s, d, qx, qz }) => {
      items.push({ key: 's' + s.name, cls: 'sign street-sign', html: esc(s.name), v: new THREE.Vector3(qx, 0.6, qz), d });
    });
    active = items;
  }

  return {
    refresh,
    get street() { return currentStreet; },
    // project every frame; hide labels that would overlap ones already placed (nearest wins)
    draw(camera, w, h) {
      const placed = [];
      const v = new THREE.Vector3();
      const order = [...active].sort((a, b) => a.d - b.d);
      let i = 0;
      for (const it of order) {
        v.copy(it.v).project(camera);
        if (v.z > 1 || v.z < -1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) continue;
        const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
        const halfW = Math.min(110, it.html.length * 2.6 + 20);
        if (placed.some((p) => Math.abs(p.x - x) < p.hw + halfW && Math.abs(p.y - y) < 20)) continue;
        placed.push({ x, y, hw: halfW });
        const e = el(i++);
        if (e.key !== it.key) { e.d.className = it.cls; e.d.innerHTML = it.html; e.d.title = it.title || ''; e.key = it.key; }
        e.d.style.display = '';
        e.d.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      }
      for (; i < pool.length; i++) { pool[i].d.style.display = 'none'; pool[i].key = ''; }
    },
    // search across all places for the map's "find a place" box
    search(q, limit = 8) {
      q = q.trim().toLowerCase();
      if (q.length < 2) return [];
      const out = [];
      for (const [name, ci, x, y] of details.places) {
        if (name.toLowerCase().includes(q)) { out.push({ name, cat: cats[ci], x, z: -y }); if (out.length >= limit * 4) break; }
      }
      return out.sort((a, b) => (b.name.toLowerCase().startsWith(q) ? 1 : 0) - (a.name.toLowerCase().startsWith(q) ? 1 : 0) || b.cat.priority - a.cat.priority).slice(0, limit);
    },
  };
}

function closest(px, pz, s) {
  const dx = s.bx - s.ax, dz = s.bz - s.az, L = dx * dx + dz * dz;
  const t = L ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / L)) : 0;
  return [s.ax + dx * t, s.az + dz * t];
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
