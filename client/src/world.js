// Builds the 3D city from the preprocessed Overture Maps / OpenStreetMap extract:
// ground, parks, water, roads with sidewalks and centre lines, extruded buildings with
// procedural windows, and (from details.json) real trees, street lamps and benches.
// Data coordinates are metres east (x) / north (y) of the origin; in three.js space north is -z.
import * as THREE from 'three';

const TILE = 600; // metres per building mesh tile (frustum + shadow culling)
const CELL = 25;  // collision grid cell size

// Facade palettes by material / height
const BRICK = ['#9e4f37', '#8c4430', '#a85c40', '#7f4a3a', '#b0694c', '#94533c'];
const BROWNSTONE = ['#7a5444', '#86604d', '#6e4b3d', '#9a7560'];
const LIGHT = ['#d9cfbf', '#cbbfae', '#e3dccf', '#bfb3a2', '#d2c3a8', '#e8e2d6'];
const STONE = ['#c9c2b5', '#b8b1a5', '#d6d0c4', '#a9a398'];
const GLASS = ['#7e98ad', '#8aa4b8', '#6f889d', '#9db2c2', '#5f7b92', '#a7b8c4'];
// style codes passed to the shader: 0 punched windows, 1 curtain-wall glass
const STYLE_PUNCHED = 0, STYLE_GLASS = 1;

function hash(i) { let x = (i + 1) * 2654435761; x ^= x >>> 13; x = Math.imul(x, 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
const tick = () => new Promise((r) => setTimeout(r, 0));

export async function loadCity(onProgress = () => {}) {
  onProgress(0.02, 'Downloading map of Boston & Cambridge…');
  const res = await fetch('/data/city.json');
  if (!res.ok) throw new Error('Could not load city data');
  const data = await res.json();
  onProgress(0.25, 'Laying out streets…');
  await tick();

  const group = new THREE.Group();
  const [minX, minY, maxX, maxY] = data.bounds;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX + 6000, maxY - minY + 6000), new THREE.MeshStandardMaterial({ color: '#b9b3a6', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((minX + maxX) / 2, -0.02, -(minY + maxY) / 2);
  ground.receiveShadow = true;
  group.add(ground);

  group.add(flatPolys(data.parks, new THREE.MeshStandardMaterial({ color: '#6f9a4e', roughness: 1 }), 1));
  const water = flatPolys(data.water, new THREE.MeshStandardMaterial({ color: '#2f5f7d', roughness: 0.08, metalness: 0.25 }), 2);
  water.receiveShadow = false;
  group.add(water);
  for (const m of buildRoads(data.roads)) group.add(m);
  onProgress(0.35, 'Raising 50,000 buildings…');
  await tick();

  const collision = new Map(); // "cx,cz" -> [building index]
  const polys = [], heights = [];
  const tiles = new Map();
  const N = data.buildings.length;
  for (let i = 0; i < N; i++) {
    const b = data.buildings[i];
    const h = b[0], material = b[1];
    const pts = [];
    for (let k = 2; k < b.length; k += 2) pts.push(b[k], -b[k + 1]);
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
    let t = tiles.get(tk); if (!t) tiles.set(tk, t = { pos: [], col: [], sty: [], idx: [] });
    extrude(t, poly, h, material, i);
    if (i % 4000 === 0) { onProgress(0.35 + 0.6 * (i / N), 'Raising 50,000 buildings…'); await tick(); }
  }
  const bMat = buildingMaterial();
  for (const t of tiles.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(t.col, 3));
    g.setAttribute('aStyle', new THREE.Float32BufferAttribute(t.sty, 1));
    g.setIndex(t.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, bMat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  onProgress(1, 'Ready');

  const landmarks = data.landmarks.map(([name, x, y]) => ({ name, x, z: -y }));
  const world = {
    group, data, landmarks,
    bounds: { minX, maxX, minZ: -maxY, maxZ: -minY },
    blocked(x, z) { return world.heightAt(x, z) > 0; },
    // Height of the building at (x, z), or 0 if open ground.
    heightAt(x, z) {
      const arr = collision.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
      if (!arr) return 0;
      for (const i of arr) if (pointInPoly(x, z, polys[i])) return heights[i];
      return 0;
    },
  };
  return world;
}

// Street furniture and trees from details.json (real positions from OpenStreetMap).
export function buildDetails(details, world) {
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const free = (x, z) => !world.blocked(x, z);

  // Trees: trunk + two-lobed crown, randomised size and tint
  const trees = details.trees;
  const n = trees.length / 2;
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 3.2, 7); trunkGeo.translate(0, 1.6, 0);
  const crownGeo = jitter(new THREE.IcosahedronGeometry(2.4, 1), 0.35); crownGeo.translate(0, 5.2, 0);
  const crown2 = jitter(new THREE.IcosahedronGeometry(1.8, 1), 0.3); crown2.translate(0.9, 6.4, 0.4);
  const crownMerged = mergeSimple([crownGeo, crown2]);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#5a4332', roughness: 1 }), n);
  const crowns = new THREE.InstancedMesh(crownMerged, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true }), n);
  let c = 0;
  for (let i = 0; i < n; i++) {
    const x = trees[i * 2], z = -trees[i * 2 + 1];
    if (!free(x, z)) continue;
    const r = hash(i), s = 0.75 + r * 0.7;
    dummy.position.set(x, 0, z); dummy.rotation.set(0, r * 6.28, 0); dummy.scale.set(s, s * (0.9 + hash(i + 7) * 0.3), s); dummy.updateMatrix();
    trunks.setMatrixAt(c, dummy.matrix); crowns.setMatrixAt(c, dummy.matrix);
    color.setHSL(0.22 + r * 0.08, 0.38 + hash(i + 3) * 0.2, 0.22 + hash(i + 5) * 0.1);
    crowns.setColorAt(c, color);
    c++;
  }
  trunks.count = crowns.count = c;
  for (const m of [trunks, crowns]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); group.add(m); }

  // Street lamps: pole + arm + lamp head
  const lamps = details.lamps, ln = lamps.length / 2;
  const pole = new THREE.CylinderGeometry(0.07, 0.09, 5, 6); pole.translate(0, 2.5, 0);
  const arm = new THREE.BoxGeometry(0.08, 0.08, 1); arm.translate(0, 4.95, 0.45);
  const head = new THREE.BoxGeometry(0.3, 0.14, 0.5); head.translate(0, 4.88, 0.9);
  const lampGeo = mergeSimple([pole, arm, head]);
  const lampMesh = new THREE.InstancedMesh(lampGeo, new THREE.MeshStandardMaterial({ color: '#2d3236', roughness: 0.5, metalness: 0.6 }), ln);
  c = 0;
  for (let i = 0; i < ln; i++) {
    const x = lamps[i * 2], z = -lamps[i * 2 + 1];
    if (!free(x, z)) continue;
    dummy.position.set(x, 0, z); dummy.rotation.set(0, hash(i + 11) * 6.28, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
    lampMesh.setMatrixAt(c++, dummy.matrix);
  }
  lampMesh.count = c; lampMesh.castShadow = true; lampMesh.computeBoundingSphere(); group.add(lampMesh);

  // Benches: seat, back and legs
  const benches = details.benches, bn = benches.length / 2;
  const seat = new THREE.BoxGeometry(1.6, 0.06, 0.42); seat.translate(0, 0.45, 0);
  const back = new THREE.BoxGeometry(1.6, 0.4, 0.05); back.translate(0, 0.72, -0.2);
  const l1 = new THREE.BoxGeometry(0.06, 0.45, 0.4); l1.translate(-0.7, 0.22, 0);
  const l2 = l1.clone(); l2.translate(1.4, 0, 0);
  const benchMesh = new THREE.InstancedMesh(mergeSimple([seat, back, l1, l2]), new THREE.MeshStandardMaterial({ color: '#6b4f36', roughness: 0.9 }), bn);
  c = 0;
  for (let i = 0; i < bn; i++) {
    const x = benches[i * 2], z = -benches[i * 2 + 1];
    if (!free(x, z)) continue;
    dummy.position.set(x, 0, z); dummy.rotation.set(0, hash(i + 21) * 6.28, 0); dummy.updateMatrix();
    benchMesh.setMatrixAt(c++, dummy.matrix);
  }
  benchMesh.count = c; benchMesh.castShadow = true; benchMesh.computeBoundingSphere(); group.add(benchMesh);
  return group;
}

function jitter(g, amount) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 1 + (hash(Math.round(p.getX(i) * 100) * 31 + Math.round(p.getY(i) * 100) * 17 + Math.round(p.getZ(i) * 100)) - 0.5) * amount;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.85, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

function pointInPoly(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function pickFacade(h, material, r) {
  if (material === 3) return [GLASS, STYLE_GLASS];
  if (material === 1) return [BRICK, STYLE_PUNCHED];
  if (material === 2) return [STONE, STYLE_PUNCHED];
  if (material === 4) return [LIGHT, STYLE_PUNCHED];
  if (h >= 70) return r < 0.7 ? [GLASS, STYLE_GLASS] : [STONE, STYLE_PUNCHED];
  if (h >= 30) return r < 0.3 ? [GLASS, STYLE_GLASS] : r < 0.7 ? [LIGHT, STYLE_PUNCHED] : [STONE, STYLE_PUNCHED];
  return r < 0.5 ? [BRICK, STYLE_PUNCHED] : r < 0.7 ? [BROWNSTONE, STYLE_PUNCHED] : [LIGHT, STYLE_PUNCHED];
}

// Extrude one footprint into walls + flat roof (with a parapet tint), appended to a tile.
function extrude(t, poly, h, material, seed) {
  const n = poly.length / 2;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += (poly[j * 2] * poly[i * 2 + 1] - poly[i * 2] * poly[j * 2 + 1]);
  const ccw = area < 0; // in x/z with z pointing south, negative shoelace means CCW from above
  const P = (i) => { const k = ccw ? i : n - 1 - i; return [poly[k * 2], poly[k * 2 + 1]]; };

  const r = hash(seed);
  const [pal, style] = pickFacade(h, material, r);
  const c = new THREE.Color(pal[Math.floor(hash(seed + 99) * pal.length)]);
  const base = c.clone().multiplyScalar(0.8);
  const roof = new THREE.Color(h < 25 ? '#5b5753' : '#8d8b87').multiplyScalar(0.85 + r * 0.3);

  for (let i = 0; i < n; i++) {
    const [ax, az] = P(i), [bx, bz] = P((i + 1) % n);
    const o = t.pos.length / 3;
    t.pos.push(ax, 0, az, bx, 0, bz, bx, h, bz, ax, h, az);
    t.col.push(base.r, base.g, base.b, base.r, base.g, base.b, c.r, c.g, c.b, c.r, c.g, c.b);
    t.sty.push(style, style, style, style);
    t.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const contour = [];
  for (let i = 0; i < n; i++) { const [x, z] = P(i); contour.push(new THREE.Vector2(x, z)); }
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const o = t.pos.length / 3;
  for (const v of contour) { t.pos.push(v.x, h, v.y); t.col.push(roof.r, roof.g, roof.b); t.sty.push(-1); }
  for (const [a, b, d] of tris) {
    const ax = contour[a].x, az = contour[a].y, bx = contour[b].x, bz = contour[b].y, dx = contour[d].x, dz = contour[d].y;
    const cross = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    if (cross < 0) t.idx.push(o + a, o + b, o + d); else t.idx.push(o + a, o + d, o + b);
  }
}

// Standard material plus procedural windows: punched windows per floor, or glass curtain walls
// with mullions. Window panes are darker, glossier and slightly metallic so they pick up the sky.
function buildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aStyle;\nvarying float vStyle;\nvarying vec3 vWPos;\nvarying vec3 vONormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvONormal = normal;\nvStyle = aStyle;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vStyle;\nvarying vec3 vWPos;\nvarying vec3 vONormal;\nfloat winMask = 0.0;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vStyle > -0.5 && abs(vONormal.y) < 0.5 && vWPos.y > 0.4) {
          float horiz = abs(vONormal.x) > abs(vONormal.z) ? vWPos.z : vWPos.x;
          float fade = 1.0 - smoothstep(150.0, 700.0, length(vWPos - cameraPosition));
          if (vStyle > 0.5) {
            // curtain wall: big panes, thin mullions, a spandrel band per floor
            float fy = fract(vWPos.y / 3.8), fx = fract(horiz / 1.6);
            winMask = (1.0 - step(0.86, fy)) * step(0.06, fx) * fade + (1.0 - fade) * 0.75;
          } else {
            float fy = fract(vWPos.y / 3.4), fx = fract(horiz / 2.6);
            float ground = step(3.4, vWPos.y);
            winMask = step(0.3, fy) * step(fy, 0.8) * step(0.22, fx) * step(fx, 0.78) * fade * ground;
            // shopfront glazing at street level
            winMask = max(winMask, (1.0 - ground) * step(0.6, vWPos.y) * step(vWPos.y, 2.9) * step(0.08, fract(horiz / 4.0)) * fade * 0.9);
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.10, 0.13, 0.17), winMask * 0.85);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, winMask);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.55, winMask);');
  };
  return m;
}

// Flat polygons (with holes) lying on the ground plane.
function flatPolys(list, material, layer) {
  const geoms = [];
  for (const rings of list) {
    const toV = (flat) => { const v = []; for (let k = 0; k < flat.length; k += 2) v.push(new THREE.Vector2(flat[k], flat[k + 1])); return v; };
    const shape = new THREE.Shape(toV(rings[0]));
    for (const hole of rings.slice(1)) shape.holes.push(new THREE.Path(toV(hole)));
    geoms.push(new THREE.ShapeGeometry(shape));
  }
  const merged = mergeSimple(geoms);
  merged.rotateX(-Math.PI / 2); // shape x/y (east/north) -> world x/-z
  Object.assign(material, { polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer * 4 });
  const m = new THREE.Mesh(merged, material);
  m.renderOrder = layer; m.receiveShadow = true;
  return m;
}

// Roads: a wider concrete sidewalk strip under the asphalt, plus a yellow centre line on big roads.
const ROAD_W = [16, 12, 9, 7, 3.5];
const ASPHALT = ['#3b3e43', '#43464b', '#484b50', '#4e5156', '#9d978c'];
function buildRoads(roads) {
  const layers = [
    { pos: [], col: [], idx: [], layer: 3 }, // sidewalks
    { pos: [], col: [], idx: [], layer: 4 }, // asphalt
    { pos: [], col: [], idx: [], layer: 5 }, // markings
  ];
  const sidewalk = new THREE.Color('#b8b2a7'), yellow = new THREE.Color('#d9b23a');
  const sorted = [...roads].sort((a, b) => b[0] - a[0]);
  for (const r of sorted) {
    const cls = r[0], asphalt = new THREE.Color(ASPHALT[cls]);
    for (let k = 2; k + 3 < r.length; k += 2) {
      const ax = r[k], az = -r[k + 1], bx = r[k + 2], bz = -r[k + 3];
      if (cls < 4) ribbon(layers[0], ax, az, bx, bz, ROAD_W[cls] / 2 + 2.6, sidewalk);
      ribbon(layers[1], ax, az, bx, bz, ROAD_W[cls] / 2, asphalt);
      if (cls <= 1) ribbon(layers[2], ax, az, bx, bz, 0.22, yellow, false);
    }
  }
  return layers.map((L) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(L.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(L.col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(L.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(L.idx);
    g.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: L.layer === 4 ? 0.95 : 1, polygonOffset: true, polygonOffsetFactor: -L.layer, polygonOffsetUnits: -L.layer * 4 });
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = L.layer; m.receiveShadow = true;
    return m;
  });
}
function ribbon(L, ax, az, bx, bz, w, c, extend = true) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
  const nx = (-dz / len) * w, nz = (dx / len) * w;
  const e = extend ? w * 0.9 : 0, ex = (dx / len) * e, ez = (dz / len) * e;
  const o = L.pos.length / 3;
  L.pos.push(ax - ex + nx, 0, az - ez + nz, ax - ex - nx, 0, az - ez - nz, bx + ex - nx, 0, bz + ez - nz, bx + ex + nx, 0, bz + ez + nz);
  for (let q = 0; q < 4; q++) L.col.push(c.r, c.g, c.b);
  L.idx.push(o, o + 2, o + 1, o, o + 3, o + 2); // wound to face up
}

function mergeSimple(geoms) {
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
