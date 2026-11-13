// An original, stylised human character built from primitives, with jointed limbs
// (hips/knees, shoulders/elbows) and a procedural walk/run/idle/wave cycle.
import * as THREE from 'three';
import { SKIN_TONES, sanitizeLook } from './look.js';

const G = {
  head: new THREE.SphereGeometry(0.115, 24, 18),
  hairCap: new THREE.SphereGeometry(0.124, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.56),
  buzz: new THREE.SphereGeometry(0.118, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
  curl: new THREE.SphereGeometry(0.045, 8, 6),
  bun: new THREE.SphereGeometry(0.06, 14, 10),
  longBack: new THREE.CapsuleGeometry(0.1, 0.16, 4, 12),
  capBrim: new THREE.CylinderGeometry(0.11, 0.11, 0.015, 20, 1, false, -Math.PI / 2, Math.PI),
  eyeWhite: new THREE.SphereGeometry(0.02, 10, 8),
  pupil: new THREE.SphereGeometry(0.011, 8, 6),
  brow: new THREE.BoxGeometry(0.04, 0.008, 0.01),
  nose: new THREE.SphereGeometry(0.018, 8, 6),
  mouth: new THREE.BoxGeometry(0.04, 0.007, 0.01),
  ear: new THREE.SphereGeometry(0.025, 8, 6),
  neck: new THREE.CylinderGeometry(0.048, 0.055, 0.1, 12),
  torso: torsoGeometry(),
  pelvis: new THREE.CapsuleGeometry(0.135, 0.06, 4, 14),
  hood: new THREE.TorusGeometry(0.1, 0.04, 8, 16, Math.PI),
  zip: new THREE.BoxGeometry(0.012, 0.42, 0.01),
  upperArm: new THREE.CapsuleGeometry(0.058, 0.18, 4, 10),
  forearm: new THREE.CapsuleGeometry(0.05, 0.17, 4, 10),
  hand: new THREE.SphereGeometry(0.048, 10, 8),
  thigh: new THREE.CapsuleGeometry(0.088, 0.3, 4, 10),
  shin: new THREE.CapsuleGeometry(0.07, 0.32, 4, 10),
  shoe: roundedBox(0.11, 0.075, 0.27),
  shadow: new THREE.CircleGeometry(0.42, 24),
  knee: new THREE.SphereGeometry(0.071, 10, 8),
  shoulderBall: new THREE.SphereGeometry(0.066, 12, 10),
};

function torsoGeometry() {
  // lathe profile: waist -> chest -> shoulders (radius, height)
  const pts = [[0.0, 0.0], [0.135, 0.0], [0.14, 0.12], [0.165, 0.3], [0.175, 0.4], [0.15, 0.48], [0.06, 0.53], [0.0, 0.535]].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 24);
  g.scale(1.3, 1, 0.74);
  return g;
}
function roundedBox(w, h, d) {
  const g = new THREE.CapsuleGeometry(w / 2, d - w, 4, 10);
  g.rotateX(Math.PI / 2);
  g.scale(1, h / w, 1);
  return g;
}

const mat = (color, rough = 0.8) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
const dark = new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.4 });
const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3 });
const lip = new THREE.MeshStandardMaterial({ color: '#8a4a43', roughness: 0.6 });
const shadowMat = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.18, depthWrite: false });

export function createAvatar({ look, guest } = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group(); // everything above the feet; bobs while walking
  root.add(body);
  const m = { skin: mat('#fff', 0.6), hair: mat('#000', 0.9), top: mat('#fff'), pants: mat('#fff', 0.9), shoes: mat('#fff', 0.5), accent: mat('#fff') };
  const add = (geo, material, parent, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, material); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };

  // --- legs (hip pivot -> knee pivot -> shoe) ---
  const leg = (side) => {
    const hip = new THREE.Group(); hip.position.set(0.095 * side, 0.93, 0); body.add(hip);
    add(G.thigh, m.pants, hip, 0, -0.22, 0);
    const knee = new THREE.Group(); knee.position.y = -0.45; hip.add(knee);
    add(G.shin, m.pants, knee, 0, -0.2, 0);
    add(G.knee, m.pants, knee);
    add(G.shoe, m.shoes, knee, 0, -0.44, 0.045);
    return { hip, knee };
  };
  const legL = leg(-1), legR = leg(1);

  // --- torso ---
  const chest = new THREE.Group(); chest.position.y = 0.93; body.add(chest);
  add(G.pelvis, m.pants, chest, 0, 0.02, 0).scale.set(1.3, 1, 0.8);
  const torso = add(G.torso, m.top, chest, 0, 0.0, 0);
  const extras = new THREE.Group(); chest.add(extras);
  add(G.neck, m.skin, chest, 0, 0.56, 0);

  // --- head ---
  const head = new THREE.Group(); head.position.y = 0.69; chest.add(head);
  add(G.head, m.skin, head).scale.set(1, 1.12, 1.04);
  for (const s of [-1, 1]) {
    add(G.eyeWhite, white, head, 0.042 * s, 0.015, 0.1).scale.set(1, 0.9, 0.6);
    add(G.pupil, dark, head, 0.042 * s, 0.013, 0.112);
    add(G.brow, m.hair, head, 0.043 * s, 0.05, 0.106).rotation.z = -0.12 * s;
    add(G.ear, m.skin, head, 0.113 * s, 0.0, -0.005).scale.set(0.5, 1, 0.8);
  }
  add(G.nose, m.skin, head, 0, -0.015, 0.118).scale.set(0.8, 1, 1.1);
  add(G.mouth, lip, head, 0, -0.058, 0.103);
  const hairGroup = new THREE.Group(); head.add(hairGroup);

  // --- arms (shoulder pivot -> elbow pivot -> hand) ---
  const arm = (side) => {
    const shoulder = new THREE.Group(); shoulder.position.set(0.24 * side, 0.45, 0); chest.add(shoulder);
    add(G.shoulderBall, m.top, shoulder);
    const upper = add(G.upperArm, m.top, shoulder, 0, -0.13, 0);
    const elbow = new THREE.Group(); elbow.position.y = -0.27; shoulder.add(elbow);
    const fore = add(G.forearm, m.skin, elbow, 0, -0.12, 0);
    add(G.hand, m.skin, elbow, 0, -0.27, 0.005).scale.set(0.85, 1.1, 0.7);
    shoulder.rotation.z = 0.08 * side;
    return { shoulder, elbow, upper, fore };
  };
  const armL = arm(-1), armR = arm(1);

  const shadow = new THREE.Mesh(G.shadow, shadowMat); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; root.add(shadow);

  function applyLook(l) {
    l = sanitizeLook(l);
    m.skin.color.set(SKIN_TONES[l.skin]);
    m.hair.color.set(l.hair);
    m.top.color.set(l.topColor);
    m.pants.color.set(l.pants);
    m.shoes.color.set(l.shoes);
    m.accent.color.set(l.topColor).offsetHSL(0, -0.1, l.top === 'jacket' ? 0.25 : -0.12);
    // sleeves: tees have bare forearms
    for (const a of [armL, armR]) a.fore.material = l.top === 'tee' ? m.skin : m.top;
    extras.clear();
    if (l.top === 'hoodie') {
      const h = add(G.hood, m.accent, extras, 0, 0.5, -0.06); h.rotation.set(-0.9, 0, 0);
    } else if (l.top === 'jacket') {
      add(G.zip, m.accent, extras, 0, 0.27, 0.118);
    }
    hairGroup.clear();
    const s = l.hairStyle;
    if (s === 'short' || s === 'long' || s === 'bun') {
      const cap = add(G.hairCap, m.hair, hairGroup, 0, 0.012, -0.008); cap.rotation.x = -0.35; cap.scale.set(1.02, 1.1, 1.06);
    }
    if (s === 'long') add(G.longBack, m.hair, hairGroup, 0, -0.07, -0.07).scale.set(1.15, 1, 0.5);
    if (s === 'bun') add(G.bun, m.hair, hairGroup, 0, 0.11, -0.08);
    if (s === 'buzz') { const b = add(G.buzz, m.hair, hairGroup, 0, 0.01, -0.006); b.rotation.x = -0.3; b.scale.set(1, 1.1, 1.05); }
    if (s === 'curly') {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, ring = i % 2 ? 0.085 : 0.05;
        add(G.curl, m.hair, hairGroup, Math.cos(a) * ring, 0.1 + (i % 2 ? 0 : 0.03), Math.sin(a) * ring - 0.02);
      }
      for (const [x, z] of [[-0.1, -0.03], [0.1, -0.03], [0, -0.1], [-0.07, -0.08], [0.07, -0.08]]) add(G.curl, m.hair, hairGroup, x, 0.04, z);
    }
    if (s === 'cap') {
      const cap = add(G.hairCap, m.top, hairGroup, 0, 0.02, 0); cap.scale.set(1.02, 0.9, 1.04);
      const brim = add(G.capBrim, m.top, hairGroup, 0, 0.045, 0.06); brim.scale.set(1, 1, 1.25);
    }
    for (const o of [...extras.children, ...hairGroup.children]) o.castShadow = true;
  }
  applyLook(look);
  if (guest) for (const k of ['top', 'pants']) { m[k].transparent = true; m[k].opacity = 0.9; }

  let phase = 0, waveT = 0, idleT = Math.random() * 10, moveBlend = 0;
  root.userData = {
    setLook: applyLook,
    wave() { waveT = 2; },
    // speed in m/s, dt in seconds
    animate(dt, speed) {
      idleT += dt;
      const target = speed > 0.3 ? 1 : 0;
      moveBlend += (target - moveBlend) * Math.min(1, dt * 8);
      const run = THREE.MathUtils.clamp((speed - 5) / 6, 0, 1);
      phase += dt * (speed > 0.3 ? 5.5 + speed * 0.75 : 0);
      const k = moveBlend, sw = Math.sin(phase), cw = Math.cos(phase);
      const stride = (0.55 + run * 0.35) * k;
      legL.hip.rotation.x = sw * stride;
      legR.hip.rotation.x = -sw * stride;
      // knees bend while the leg swings forward
      legL.knee.rotation.x = Math.max(0, -cw) * (0.9 + run * 0.6) * k + 0.05;
      legR.knee.rotation.x = Math.max(0, cw) * (0.9 + run * 0.6) * k + 0.05;
      const armSwing = (0.45 + run * 0.5) * k;
      armL.shoulder.rotation.x = -sw * armSwing;
      armL.elbow.rotation.x = -(0.25 + run * 0.9) * k - 0.08;
      body.position.y = Math.abs(cw) * (0.035 + run * 0.05) * k;
      chest.rotation.x = run * 0.18 * k;
      chest.rotation.y = sw * 0.08 * k;
      // idle: breathing and a little sway
      const idle = 1 - k;
      torso.scale.set(1, 1 + Math.sin(idleT * 2.2) * 0.012 * idle, 1);
      head.rotation.y = Math.sin(idleT * 0.5) * 0.25 * idle;
      armL.shoulder.rotation.z = -0.08 - Math.sin(idleT * 2.2) * 0.02 * idle;
      if (waveT > 0) {
        waveT -= dt;
        armR.shoulder.rotation.set(0, 0, 2.7);
        armR.elbow.rotation.set(0, 0, Math.sin(waveT * 12) * 0.35 - 0.3);
      } else {
        armR.shoulder.rotation.set(sw * armSwing, 0, 0.08 + Math.sin(idleT * 2.2) * 0.02 * idle);
        armR.elbow.rotation.set(-(0.25 + run * 0.9) * k - 0.08, 0, 0);
      }
    },
  };
  return root;
}

// Translucent ring on the ground that shows the "encounter" radius around you.
export function createEncounterRing(radius) {
  const g = new THREE.RingGeometry(radius - 0.35, radius, 96);
  const ringMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#4f8cff', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  ringMesh.rotation.x = -Math.PI / 2; ringMesh.position.y = 0.08; ringMesh.renderOrder = 6;
  return ringMesh;
}

// Small standalone renderer that shows a slowly turning avatar (used by the look editor).
export function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#8a8072', 2.2));
  const key = new THREE.DirectionalLight('#fff3e0', 2.2); key.position.set(1.5, 2.5, 2); scene.add(key);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  cam.position.set(0, 1.25, 4.2); cam.lookAt(0, 0.95, 0);
  let avatar = null, running = false, last = 0, angle = 0.5;
  function frame(t) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio())) { renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    angle += dt * 0.6;
    if (avatar) { avatar.rotation.y = Math.sin(angle) * 0.7; avatar.userData.animate(dt, 0); }
    renderer.render(scene, cam);
  }
  return {
    show(look) {
      if (!avatar) { avatar = createAvatar({ look }); scene.add(avatar); } else avatar.userData.setLook(look);
      if (!running) { running = true; requestAnimationFrame(frame); }
    },
    wave() { avatar?.userData.wave(); },
    stop() { running = false; },
  };
}
