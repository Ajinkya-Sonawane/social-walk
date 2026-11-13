// A simple, original low-poly character built from primitives, tinted per player.
import * as THREE from 'three';

const skinTones = ['#f1c7a5', '#e0ac87', '#c68863', '#9c6644', '#6f4a33'];
const shared = {
  head: new THREE.SphereGeometry(0.26, 18, 14),
  torso: new THREE.CapsuleGeometry(0.27, 0.42, 6, 14),
  limb: new THREE.CapsuleGeometry(0.085, 0.42, 4, 8),
  leg: new THREE.CapsuleGeometry(0.1, 0.48, 4, 8),
  eye: new THREE.SphereGeometry(0.035, 8, 6),
  ring: new THREE.RingGeometry(0.55, 0.68, 32),
  shadow: new THREE.CircleGeometry(0.45, 20),
};
const eyeMat = new THREE.MeshBasicMaterial({ color: '#1d1d1f' });
const pantsMat = new THREE.MeshLambertMaterial({ color: '#2f3640' });
const shadowMat = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.22, depthWrite: false });

function seeded(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

export function createAvatar({ id, color, guest }) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const shirt = new THREE.MeshLambertMaterial({ color });
  const skin = new THREE.MeshLambertMaterial({ color: skinTones[seeded(id) % skinTones.length] });
  if (guest) { shirt.transparent = true; shirt.opacity = 0.85; }

  const torso = new THREE.Mesh(shared.torso, shirt); torso.position.y = 1.05; body.add(torso);
  const head = new THREE.Mesh(shared.head, skin); head.position.y = 1.62; body.add(head);
  for (const s of [-1, 1]) { const e = new THREE.Mesh(shared.eye, eyeMat); e.position.set(0.09 * s, 1.66, 0.23); body.add(e); }

  const limb = (geo, mat, x, y) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const m = new THREE.Mesh(geo, mat); m.position.y = -0.3; pivot.add(m); body.add(pivot); return pivot;
  };
  const armL = limb(shared.limb, shirt, -0.36, 1.32), armR = limb(shared.limb, shirt, 0.36, 1.32);
  const legL = limb(shared.leg, pantsMat, -0.13, 0.72), legR = limb(shared.leg, pantsMat, 0.13, 0.72);
  legL.children[0].position.y = -0.36; legR.children[0].position.y = -0.36;

  const shadow = new THREE.Mesh(shared.shadow, shadowMat); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; root.add(shadow);

  let phase = 0, waveT = 0;
  root.userData = {
    shirt,
    setColor(c) { shirt.color.set(c); },
    wave() { waveT = 1.6; },
    // speed in m/s; dt in seconds
    animate(dt, speed) {
      const moving = speed > 0.3;
      phase += dt * (moving ? Math.min(14, 4 + speed * 1.1) : 0);
      const amp = moving ? Math.min(0.9, 0.35 + speed * 0.05) : 0;
      const s = Math.sin(phase) * amp;
      legL.rotation.x = s; legR.rotation.x = -s; armL.rotation.x = -s * 0.8;
      body.position.y = moving ? Math.abs(Math.cos(phase)) * 0.06 : 0;
      if (!moving) { legL.rotation.x *= 0.8; legR.rotation.x *= 0.8; }
      if (waveT > 0) {
        waveT -= dt;
        armR.rotation.x = 0; armR.rotation.z = 2.6 + Math.sin(waveT * 14) * 0.35;
      } else { armR.rotation.z = 0; armR.rotation.x = s * 0.8; }
    },
  };
  return root;
}

// Translucent ring on the ground that shows the "encounter" radius around you.
export function createEncounterRing(radius) {
  const g = new THREE.RingGeometry(radius - 0.35, radius, 96);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#4f8cff', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.06; m.renderOrder = 5;
  return m;
}
