// 2D maps: a small north-up minimap that follows you, and a full map you can click to travel.
const M_PER_PX = 4; // resolution of the pre-rendered base map

export function createMaps(world, { miniCanvas, fullCanvas }) {
  const { minX, maxX, minZ, maxZ } = world.bounds;
  const W = Math.ceil((maxX - minX) / M_PER_PX), H = Math.ceil((maxZ - minZ) / M_PER_PX);
  const base = document.createElement('canvas'); base.width = W; base.height = H;
  const g = base.getContext('2d');
  const px = (x) => (x - minX) / M_PER_PX, pz = (z) => (z - minZ) / M_PER_PX; // world x/z -> base px
  const data = world.data;

  g.fillStyle = '#ece8df'; g.fillRect(0, 0, W, H);
  const fillPolys = (list, color) => {
    g.fillStyle = color;
    for (const rings of list) {
      g.beginPath();
      for (const r of rings) { for (let k = 0; k < r.length; k += 2) (k ? g.lineTo : g.moveTo).call(g, px(r[k]), pz(-r[k + 1])); g.closePath(); }
      g.fill('evenodd');
    }
  };
  fillPolys(data.parks, '#bcd9a0');
  fillPolys(data.water, '#9cc7e6');
  const widths = [3.2, 2.4, 1.8, 1.2, 0.8], colors = ['#f2b45a', '#ffffff', '#ffffff', '#ffffff', '#f6f3ec'];
  for (let cls = 4; cls >= 0; cls--) {
    g.strokeStyle = colors[cls]; g.lineWidth = widths[cls]; g.lineCap = 'round'; g.beginPath();
    for (const r of data.roads) { if (r[0] !== cls) continue; for (let k = 1; k < r.length; k += 2) (k === 1 ? g.moveTo : g.lineTo).call(g, px(r[k]), pz(-r[k + 1])); }
    g.stroke();
  }
  g.fillStyle = '#c9c1b4';
  for (const b of data.buildings) { g.beginPath(); for (let k = 1; k < b.length; k += 2) (k === 1 ? g.moveTo : g.lineTo).call(g, px(b[k]), pz(-b[k + 1])); g.fill(); }

  const mctx = miniCanvas.getContext('2d');
  const fctx = fullCanvas.getContext('2d');
  let fullView = null; // {scale, ox, oy}

  function dot(ctx, x, y, color, r, ring) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = ring ? 2.5 : 1.5; ctx.strokeStyle = ring || '#fff'; ctx.stroke();
  }
  function arrow(ctx, x, y, ry, size) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(-ry + Math.PI);
    ctx.beginPath(); ctx.moveTo(0, -size); ctx.lineTo(size * 0.7, size * 0.8); ctx.lineTo(0, size * 0.4); ctx.lineTo(-size * 0.7, size * 0.8); ctx.closePath();
    ctx.fillStyle = '#1f6fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.restore();
  }
  const dotColor = (o) => (o.guest ? '#9aa0a6' : o.color);

  return {
    drawMini(me, others, connectedIds) {
      const S = miniCanvas.width, zoom = 1.3; // px per base px
      mctx.fillStyle = '#ece8df'; mctx.fillRect(0, 0, S, S);
      const cx = px(me.x), cz = pz(me.z), span = S / zoom;
      mctx.drawImage(base, cx - span / 2, cz - span / 2, span, span, 0, 0, S, S);
      const to = (x, z) => [(px(x) - cx) * zoom + S / 2, (pz(z) - cz) * zoom + S / 2];
      for (const o of others) {
        const [x, y] = to(o.x, o.z);
        if (x < -5 || y < -5 || x > S + 5 || y > S + 5) continue;
        dot(mctx, x, y, dotColor(o), 4, connectedIds.has(o.userId) ? '#ffd23f' : null);
      }
      arrow(mctx, S / 2, S / 2, me.ry, 8);
    },
    drawFull(me, others, connectedIds) {
      const cw = fullCanvas.clientWidth, ch = fullCanvas.clientHeight, dpr = devicePixelRatio || 1;
      if (fullCanvas.width !== cw * dpr) { fullCanvas.width = cw * dpr; fullCanvas.height = ch * dpr; }
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const scale = Math.min(cw / W, ch / H), ox = (cw - W * scale) / 2, oy = (ch - H * scale) / 2;
      fullView = { scale, ox, oy };
      fctx.fillStyle = '#ece8df'; fctx.fillRect(0, 0, cw, ch);
      fctx.drawImage(base, ox, oy, W * scale, H * scale);
      const to = (x, z) => [ox + px(x) * scale, oy + pz(z) * scale];
      fctx.font = '600 12px system-ui, sans-serif'; fctx.textAlign = 'center';
      for (const l of world.landmarks) {
        const [x, y] = to(l.x, l.z);
        fctx.lineWidth = 3; fctx.strokeStyle = 'rgba(255,255,255,.9)'; fctx.strokeText(l.name, x, y); fctx.fillStyle = '#333'; fctx.fillText(l.name, x, y);
      }
      for (const o of others) { const [x, y] = to(o.x, o.z); dot(fctx, x, y, dotColor(o), 5, connectedIds.has(o.userId) ? '#ffd23f' : null); }
      const [mx, my] = to(me.x, me.z); arrow(fctx, mx, my, me.ry, 10);
    },
    // Convert a click on the full map to world coordinates.
    fullToWorld(clientX, clientY) {
      if (!fullView) return null;
      const r = fullCanvas.getBoundingClientRect();
      const bx = (clientX - r.left - fullView.ox) / fullView.scale, bz = (clientY - r.top - fullView.oy) / fullView.scale;
      if (bx < 0 || bz < 0 || bx > W || bz > H) return null;
      return { x: bx * M_PER_PX + minX, z: bz * M_PER_PX + minZ };
    },
  };
}
