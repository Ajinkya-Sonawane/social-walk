// Builds the 3D city (ground, water, parks, roads, extruded buildings) from the preprocessed
// Overture Maps / OpenStreetMap extract, plus a spatial index used for building collisions.
// Data coordinates are metres east (x) / north (y) of the origin; in three.js space north is -z.
import * as THREE from 'three';

const TILE = 800; // metres per building mesh tile (for frustum culling)
const CELL = 25;  // collision grid cell size

// Facade palettes: brick and brownstone for low-rise, stone for mid-rise, glass for towers.
const LOW = ['#b5654a', '#a4573f', '#c27b5b', '#9c6b54', '#d0b593', '#c9a27e', '#b98f72', '#e0d4c0', '#8f5a48'];
const MID = ['#cfc6b8', '#bdb5a8', '#d9d2c5', '#a9a49c', '#c4b49c'];
const HIGH = ['#a9bccd', '#b7c6d3', '#9badbf', '#c3ccd4', '#8fa2b4'];

function hash(i) { let x = (i + 1) * 2654435761; x ^= x >>> 13; x = Math.imul(x, 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }

export async function loadCity(onProgress = () => {}) {
  onProgress(0.02, 'Downloading map of Boston & Cambridge…');
  const res = await fetch('/data/city.json');
  if (!res.ok) throw new Error('Could not load city data');
  const data = await res.json();
  onProgress(0.25, 'Laying out streets…');
  await tick();

  const group = new THREE.Group();
  const [minX, minY, maxX, maxY] = data.bounds;

  // Ground
  const groundW = maxX - minX + 4000, groundH = maxY - minY + 4000;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundW, groundH), new THREE.MeshLambertMaterial({ color: '#d9d5cb' }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((minX + maxX) / 2, 0, -(minY + maxY) / 2);
  group.add(ground);

  group.add(flatPolys(data.parks, '#a8c98a', 1));
  group.add(flatPolys(data.water, '#7fb4d8', 2));
  group.add(buildRoads(data.roads));
  onProgress(0.35, 'Raising 50,000 buildings…');
  await tick();

  const collision = new Map(); // "cx,cz" -> [building index]
  const polys = [];            // building footprints in three.js x/z space
  const heights = [];
  const tiles = new Map();
  const N = data.buildings.length;
  for (let i = 0; i < N; i++) {
    const b = data.buildings[i];
    const h = b[0];
    let pts = [];
    for (let k = 1; k < b.length; k += 2) pts.push(b[k], -b[k + 1]);
    const poly = Float32Array.from(pts);
    polys.push(poly); heights.push(h);
    let cx = 0, cz = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < poly.length; k += 2) {
      cx += poly[k]; cz += poly[k + 1];
      x0 = Math.min(x0, poly[k]); x1 = Math.max(x1, poly[k]); z0 = Math.min(z0, poly[k + 1]); z1 = Math.max(z1, poly[k + 1]);
    }
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
      for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
        const key = gx + ',' + gz; let arr = collision.get(key); if (!arr) collision.set(key, arr = []); arr.push(i);
      }
    cx /= poly.length / 2; cz /= poly.length / 2;
    const tk = Math.floor(cx / TILE) + ',' + Math.floor(cz / TILE);
    let t = tiles.get(tk); if (!t) tiles.set(tk, t = { pos: [], col: [], idx: [] });
    extrude(t, poly, h, i);
    if (i % 4000 === 0) { onProgress(0.35 + 0.6 * (i / N), 'Raising 50,000 buildings…'); await tick(); }
  }
  const bMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // Procedural windows: darken a grid of floor-height panes on walls, fading out with distance.
  bMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (abs(vWNormal.y) < 0.5 && vWPos.y > 1.2) {
          float fy = fract(vWPos.y / 3.6);
          float horiz = abs(vWNormal.x) > abs(vWNormal.z) ? vWPos.z : vWPos.x;
          float fx = fract(horiz / 3.0);
          float win = step(0.32, fy) * step(fy, 0.78) * step(0.18, fx) * step(fx, 0.82);
          float fade = 1.0 - smoothstep(120.0, 520.0, length(vWPos - cameraPosition));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45 + vec3(0.06, 0.08, 0.11), win * 0.8 * fade);
        }`);
  };
  for (const t of tiles.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(t.col, 3));
    g.setIndex(t.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    group.add(new THREE.Mesh(g, bMat));
  }
  onProgress(1, 'Ready');

  const landmarks = data.landmarks.map(([name, x, y]) => ({ name, x, z: -y }));
  return {
    group, data, landmarks,
    bounds: { minX, maxX, minZ: -maxY, maxZ: -minY },
    blocked(x, z) { return this.heightAt(x, z) > 0; },
    // Height of the building at (x, z), or 0 if open ground.
    heightAt(x, z) {
      const arr = collision.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
      if (!arr) return 0;
      for (const i of arr) if (pointInPoly(x, z, polys[i])) return heights[i];
      return 0;
    },
  };
}

function tick() { return new Promise((r) => setTimeout(r, 0)); }

function pointInPoly(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Extrude one footprint into walls + flat roof, appended to a tile's buffers.
function extrude(t, poly, h, seed) {
  const n = poly.length / 2;
  // Ensure counter-clockwise when viewed from above (+y) so walls face outward.
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += (poly[j * 2] * poly[i * 2 + 1] - poly[i * 2] * poly[j * 2 + 1]);
  const ccw = area < 0; // in x/z with z pointing south, negative shoelace means CCW from above
  const P = (i) => { const k = ccw ? i : n - 1 - i; return [poly[k * 2], poly[k * 2 + 1]]; };

  const r = hash(seed);
  const pal = h < 22 ? LOW : h < 60 ? MID : HIGH;
  const c = new THREE.Color(pal[Math.floor(r * pal.length)]);
  const dark = c.clone().multiplyScalar(0.72);
  const roof = new THREE.Color(h < 22 ? '#6d6964' : '#8a8a88').multiplyScalar(0.9 + r * 0.2);

  for (let i = 0; i < n; i++) {
    const [ax, az] = P(i), [bx, bz] = P((i + 1) % n);
    const base = t.pos.length / 3;
    t.pos.push(ax, 0, az, bx, 0, bz, bx, h, bz, ax, h, az);
    t.col.push(dark.r, dark.g, dark.b, dark.r, dark.g, dark.b, c.r, c.g, c.b, c.r, c.g, c.b);
    t.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const contour = [];
  for (let i = 0; i < n; i++) { const [x, z] = P(i); contour.push(new THREE.Vector2(x, z)); }
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const base = t.pos.length / 3;
  for (const v of contour) { t.pos.push(v.x, h, v.y); t.col.push(roof.r, roof.g, roof.b); }
  for (const [a, b, d] of tris) {
    // Roof must face up: check winding in x/z.
    const ax = contour[a].x, az = contour[a].y, bx = contour[b].x, bz = contour[b].y, dx = contour[d].x, dz = contour[d].y;
    const cross = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    if (cross < 0) t.idx.push(base + a, base + b, base + d); else t.idx.push(base + a, base + d, base + b);
  }
}

// Flat polygons (with holes) lying on the ground plane.
function flatPolys(list, color, layer) {
  const geoms = [];
  for (const rings of list) {
    const toV = (flat) => { const v = []; for (let k = 0; k < flat.length; k += 2) v.push(new THREE.Vector2(flat[k], flat[k + 1])); return v; };
    const shape = new THREE.Shape(toV(rings[0]));
    for (const hole of rings.slice(1)) shape.holes.push(new THREE.Path(toV(hole)));
    geoms.push(new THREE.ShapeGeometry(shape));
  }
  const merged = mergeGeoms(geoms);
  merged.rotateX(-Math.PI / 2); // shape x/y (east/north) -> world x/-z
  const m = new THREE.Mesh(merged, layerMat(color, layer));
  m.renderOrder = layer;
  return m;
}

function layerMat(color, layer) {
  return new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer * 4, side: THREE.DoubleSide });
}

const ROAD_W = [16, 11, 8, 6, 3.5];
const ROAD_C = ['#5b5f66', '#6a6e75', '#777b81', '#83868b', '#b9b3a6'];
function buildRoads(roads) {
  const pos = [], col = [], idx = [];
  // draw minor classes first so major roads end up on top within the same layer
  const sorted = [...roads].sort((a, b) => b[0] - a[0]);
  for (const r of sorted) {
    const cls = r[0], w = ROAD_W[cls] / 2, c = new THREE.Color(ROAD_C[cls]);
    for (let k = 1; k + 3 < r.length; k += 2) {
      const ax = r[k], az = -r[k + 1], bx = r[k + 2], bz = -r[k + 3];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * w, nz = (dx / len) * w;
      // extend each segment by half-width to cover joints
      const ex = (dx / len) * w * 0.9, ez = (dz / len) * w * 0.9;
      const base = pos.length / 3;
      pos.push(ax - ex + nx, 0, az - ez + nz, ax - ex - nx, 0, az - ez - nz, bx + ex - nx, 0, bz + ez - nz, bx + ex + nx, 0, bz + ez + nz);
      for (let q = 0; q < 4; q++) col.push(c.r, c.g, c.b);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2); // wound to face up
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mat = layerMat('#ffffff', 3); mat.vertexColors = true;
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 3;
  return m;
}

function mergeGeoms(geoms) {
  let total = 0, totalIdx = 0;
  for (const g of geoms) { total += g.attributes.position.count; totalIdx += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), idx = new Uint32Array(totalIdx);
  let o = 0, oi = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[oi + i] = g.index.array[i] + o; oi += g.index.count; }
    else { for (let i = 0; i < g.attributes.position.count; i++) idx[oi + i] = o + i; oi += g.attributes.position.count; }
    o += g.attributes.position.count;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  m.computeBoundingSphere();
  return m;
}
