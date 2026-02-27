(() => {
  'use strict';

  // ===== Canvas =====
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  // ===== Constants =====
  const TILE = 24;
  const CHUNK_TILES = 16;
  const CHUNK_PX = TILE * CHUNK_TILES;

  const WORLD_CHUNKS_W = 12, WORLD_CHUNKS_H = 12;
  const WORLD_W = WORLD_CHUNKS_W * CHUNK_PX;
  const WORLD_H = WORLD_CHUNKS_H * CHUNK_PX;

  const LAYER0 = 0; // surface
  const LAYER1 = 1; // cave
  const LAYER2 = 2; // deep
  const LAYER_NAMES = ['Surface', 'Cave', 'Deep'];

  // local +Y is "into entrance"
  const DIRS = [
    { name: 'Down',  dx: 0,  dy:  1, ang: 0 },
    { name: 'Right', dx: 1,  dy:  0, ang: -Math.PI / 2 },
    { name: 'Up',    dx: 0,  dy: -1, ang: Math.PI },
    { name: 'Left',  dx: -1, dy:  0, ang: Math.PI / 2 },
  ];

  // ===== UI =====
  const layerBadge = document.getElementById('layerBadge');
  const entranceInfo = document.getElementById('entranceInfo');
  function setLayerUI(layer) {
    if (!layerBadge) return;
    layerBadge.textContent = `Layer: ${LAYER_NAMES[layer] ?? layer}`;
  }

  // ===== Input =====
  const keys = new Set();
  let debug = false;
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === 'f') debug = !debug;
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // ===== Math =====
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2);

  // ===== Deterministic random =====
  function hash32(x, y, layer) {
    let h = 2166136261 >>> 0;
    h ^= (x * 374761393) >>> 0; h = Math.imul(h, 16777619) >>> 0;
    h ^= (y * 668265263) >>> 0; h = Math.imul(h, 16777619) >>> 0;
    h ^= (layer * 2246822519) >>> 0; h = Math.imul(h, 16777619) >>> 0;
    h ^= 0x9e3779b9; h = Math.imul(h, 16777619) >>> 0;
    return h >>> 0;
  }
  function rand01(seed) {
    let x = seed >>> 0;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 4294967296;
  }

  // ===== Rounded rect (subpath; no beginPath) =====
  function roundRectSubPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // ===== Terrain shading =====
  function baseTileColor(layer, v) {
    if (layer === LAYER0) return (v === 0 ? '#18402a' : (v === 1 ? '#4b4f57' : '#23563a'));
    if (layer === LAYER1) return (v === 0 ? '#141724' : (v === 1 ? '#3a3f4c' : '#23283a'));
    return (v === 0 ? '#1a1117' : (v === 1 ? '#4a3b46' : '#2a1d27'));
  }
  function shadeHex(hex, amt) {
    const s = hex.startsWith('#') ? hex.slice(1) : hex;
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    const k = Math.round(amt * 35);
    const nr = Math.max(0, Math.min(255, r + k));
    const ng = Math.max(0, Math.min(255, g + k));
    const nb = Math.max(0, Math.min(255, b + k));
    const toHex = (v) => v.toString(16).padStart(2, '0');
    return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
  }
  function noise(wx, wy, layer) {
    const a = rand01(hash32(wx, wy, layer));
    const b = rand01(hash32(wx + 17, wy - 9, layer));
    return (a * 0.7 + b * 0.3);
  }

  // ===== Chunk cache: bake each chunk once =====
  const chunkCache = new Map(); // key -> { img, entrances: [] }
  const chunkUse = new Map();
  const MAX_CHUNKS = 340;
  const chunkKey = (layer, cx, cy) => `${layer}:${cx}:${cy}`;

  // Portal placement:
  // - 0<->1 portals: even-even chunks where parity == 0
  // - 1<->2 portals: even-even chunks where parity == 1 (offset ~2 chunks) => no overlap
  function portalTypeFor(layer, cx, cy) {
    if ((cx & 1) || (cy & 1)) return null; // only even-even
    const parity = ((cx >> 1) + (cy >> 1)) & 1;

    if (layer === LAYER0) return 0;
    if (layer === LAYER2) return 1;
    return parity; // layer1: parity=0 connects to L0, parity=1 connects to L2
  }

  function genChunk(layer, cx, cy) {
    const off = document.createElement('canvas');
    off.width = CHUNK_PX;
    off.height = CHUNK_PX;
    const g = off.getContext('2d', { alpha: false });

    const baseSeed = hash32(cx, cy, layer);

    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = cx * CHUNK_TILES + tx;
        const wy = cy * CHUNK_TILES + ty;

        const r = rand01(hash32(wx, wy, layer) ^ baseSeed);
        let v = 0;
        if (r < 0.08) v = 1;
        else if (r < 0.14) v = 2;

        const base = baseTileColor(layer, v);
        const n = noise(wx, wy, layer) - 0.52;
        const shaded = shadeHex(base, n * 0.7);

        g.fillStyle = shaded;
        g.fillRect(tx * TILE, ty * TILE, TILE, TILE);

        if (v !== 0) {
          g.globalAlpha = 0.75;
          g.fillStyle = (layer === LAYER0)
            ? (v === 1 ? '#2b2f36' : '#173322')
            : (layer === LAYER1)
              ? (v === 1 ? '#1d2028' : '#141724')
              : (v === 1 ? '#211820' : '#140c12');
          g.fillRect(tx * TILE + 4, ty * TILE + 4, TILE - 8, TILE - 8);
          g.globalAlpha = 1;
        }
      }
    }

    const entrances = [];
    const pType = portalTypeFor(layer, cx, cy);
    if (pType !== null) {
      const idx = ((cx * 131) ^ (cy * 197) ^ (layer * 911)) & 3;
      const dir = DIRS[idx];

      const pad = TILE * 1.35;
      let ex = cx * CHUNK_PX + CHUNK_PX / 2;
      let ey = cy * CHUNK_PX + CHUNK_PX / 2;

      if (dir.name === 'Down')  ey = cy * CHUNK_PX + (CHUNK_PX - pad);
      if (dir.name === 'Up')    ey = cy * CHUNK_PX + pad;
      if (dir.name === 'Right') ex = cx * CHUNK_PX + (CHUNK_PX - pad);
      if (dir.name === 'Left')  ex = cx * CHUNK_PX + pad;

      let toLayer = layer;
      if (layer === LAYER0) toLayer = LAYER1;
      else if (layer === LAYER2) toLayer = LAYER1;
      else toLayer = (pType === 0) ? LAYER0 : LAYER2;

      entrances.push({
        id: `${layer}:${cx}:${cy}:${pType}`,
        layer,
        toLayer,
        x: ex, y: ey,
        dir,
        mouthW: TILE * 3.4,
        mouthH: TILE * 1.9,
        depth:  TILE * 3.2,
        pType
      });
    }

    return { img: off, entrances };
  }

  function getChunk(layer, cx, cy, now) {
    const key = chunkKey(layer, cx, cy);
    const hit = chunkCache.get(key);
    if (hit) { chunkUse.set(key, now); return hit; }

    const ch = genChunk(layer, cx, cy);
    chunkCache.set(key, ch);
    chunkUse.set(key, now);

    if (chunkCache.size > MAX_CHUNKS) {
      let oldestKey = null, oldestT = Infinity;
      for (const [k, last] of chunkUse.entries()) {
        if (last < oldestT) { oldestT = last; oldestKey = k; }
      }
      if (oldestKey) { chunkCache.delete(oldestKey); chunkUse.delete(oldestKey); }
    }
    return ch;
  }

  // ===== Player & camera =====
  const player = { x: WORLD_W / 2, y: WORLD_H / 2, r: 10, speed: 190, sprintMul: 1.45 };
  let currentLayer = LAYER0;
  setLayerUI(currentLayer);

  const cam = { x: player.x, y: player.y, smooth: 0.12 };
  function worldClamp() {
    player.x = clamp(player.x, 0, WORLD_W);
    player.y = clamp(player.y, 0, WORLD_H);
  }

  // ===== Render layer (baked chunks) =====
  function chunkRangeForRect(camX, camY, rect) {
    const wx0 = camX + rect.x;
    const wy0 = camY + rect.y;
    const wx1 = camX + rect.x + rect.w;
    const wy1 = camY + rect.y + rect.h;

    const minCX = clamp(Math.floor(wx0 / CHUNK_PX) - 1, 0, WORLD_CHUNKS_W - 1);
    const maxCX = clamp(Math.floor(wx1 / CHUNK_PX) + 1, 0, WORLD_CHUNKS_W - 1);
    const minCY = clamp(Math.floor(wy0 / CHUNK_PX) - 1, 0, WORLD_CHUNKS_H - 1);
    const maxCY = clamp(Math.floor(wy1 / CHUNK_PX) + 1, 0, WORLD_CHUNKS_H - 1);
    return { minCX, maxCX, minCY, maxCY };
  }

  function renderLayer(layer, now, camX, camY, clipRect /*screen rect or null*/) {
    const w = innerWidth, h = innerHeight;

    ctx.save();
    if (clipRect) {
      ctx.beginPath();
      roundRectSubPath(clipRect.x, clipRect.y, clipRect.w, clipRect.h, clipRect.r || 0);
      ctx.clip();
    }

    let minCX, maxCX, minCY, maxCY;
    if (clipRect) {
      ({ minCX, maxCX, minCY, maxCY } = chunkRangeForRect(camX, camY, clipRect));
    } else {
      minCX = clamp(Math.floor((camX - CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_W - 1);
      maxCX = clamp(Math.floor((camX + w + CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_W - 1);
      minCY = clamp(Math.floor((camY - CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_H - 1);
      maxCY = clamp(Math.floor((camY + h + CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_H - 1);
    }

    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const ch = getChunk(layer, cx, cy, now);
        const ox = cx * CHUNK_PX - camX;
        const oy = cy * CHUNK_PX - camY;
        ctx.drawImage(ch.img, ox, oy);

        if (debug) {
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(ox, oy, CHUNK_PX, CHUNK_PX);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = '#fff';
          ctx.font = '12px ui-sans-serif,system-ui';
          ctx.fillText(`${cx},${cy}`, ox + 6, oy + 14);
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }

  // ===== Portal rendering (preview) =====
  function renderOtherLayerInPortal(e, now, camX, camY) {
    const w = innerWidth, h = innerHeight;

    const sx = e.x - camX;
    const sy = e.y - camY;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(e.dir.ang);

    ctx.beginPath();
    roundRectSubPath(-e.mouthW/2, -e.mouthH/2, e.mouthW, e.mouthH, 12);
    ctx.clip();

    // Undo transform: draw in screen coords
    ctx.rotate(-e.dir.ang);
    ctx.translate(-sx, -sy);

    const portalCamX = player.x - w / 2;
    const portalCamY = player.y - h / 2;
    renderLayer(e.toLayer, now, portalCamX, portalCamY, null);

    ctx.restore();
  }

  // ===== Entrance drawing =====
  function drawEntranceRimAndArrow(e, camX, camY) {
    const sx = e.x - camX;
    const sy = e.y - camY;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(e.dir.ang);

    const w = e.mouthW, h = e.mouthH;

    ctx.fillStyle = (e.pType === 0) ? '#2b2a26' : '#262b2a';
    ctx.beginPath();
    roundRectSubPath(-w/2 - 10, -h/2 - 10, w + 20, h + 20, 14);
    roundRectSubPath(-w/2,      -h/2,      w,      h,      12);
    ctx.fill('evenodd');

    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    roundRectSubPath(-w/2, -h/2, w, h, 12);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const arrowDist = h / 2 + 22;
    ctx.save();
    ctx.translate(0, -arrowDist);

    ctx.globalAlpha = 0.95;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, 16);
    ctx.lineTo(-11, -2);
    ctx.lineTo(11, -2);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(-7, 0);
    ctx.lineTo(7, 0);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
    ctx.restore();
  }

  // Transition rect start: AABB around rotated mouth (good enough)
  function portalStartRectScreen(e, camX, camY) {
    const sx = e.x - camX;
    const sy = e.y - camY;

    const pw = e.mouthW;
    const ph = e.mouthH;
    const ang = e.dir.ang;
    const c = Math.abs(Math.cos(ang));
    const s = Math.abs(Math.sin(ang));
    const aw = pw * c + ph * s;
    const ah = pw * s + ph * c;

    return { x: sx - aw/2, y: sy - ah/2, w: aw, h: ah, r: 10 };
  }

  function lerpRect(a, b, t) {
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      w: lerp(a.w, b.w, t),
      h: lerp(a.h, b.h, t),
      r: lerp(a.r || 0, b.r || 0, t),
    };
  }

  // ===== Transition =====
  let transitioning = false;
  const trans = {
    entrance: null,
    progress: 0,
    duration: 0.30,
  };

  function pointInOrientedMouth(px, py, e) {
    const ang = e.dir.ang;
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const lx = (px - e.x) * cos - (py - e.y) * sin;
    const ly = (px - e.x) * sin + (py - e.y) * cos;
    return (Math.abs(lx) <= e.mouthW / 2) && (Math.abs(ly) <= e.mouthH / 2);
  }
  function movingInto(e, mvx, mvy) {
    const mLen = Math.hypot(mvx, mvy);
    if (mLen < 0.01) return false;
    const mx = mvx / mLen, my = mvy / mLen;
    return (mx * e.dir.dx + my * e.dir.dy) > 0.35;
  }

  function getNearbyEntrances(layer, now) {
    const cx = Math.floor(player.x / CHUNK_PX);
    const cy = Math.floor(player.y / CHUNK_PX);
    const out = [];
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const nx = cx + ox, ny = cy + oy;
      if (nx < 0 || ny < 0 || nx >= WORLD_CHUNKS_W || ny >= WORLD_CHUNKS_H) continue;
      const ch = getChunk(layer, nx, ny, now);
      for (const e of ch.entrances) out.push(e);
    }
    return out;
  }

  function tryStartTransition(entrances, mvx, mvy) {
    if (transitioning) return;
    for (const e of entrances) {
      if (pointInOrientedMouth(player.x, player.y, e) && movingInto(e, mvx, mvy)) {
        transitioning = true;
        trans.entrance = e;
        trans.progress = 0;
        break;
      }
    }
  }

  // ===== Main loop =====
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    let ax = 0, ay = 0;
    if (keys.has('w')) ay -= 1;
    if (keys.has('s')) ay += 1;
    if (keys.has('a')) ax -= 1;
    if (keys.has('d')) ax += 1;

    const l = Math.hypot(ax, ay) || 1;
    ax /= l; ay /= l;

    const sprint = keys.has('shift');
    const speed = player.speed * (sprint ? player.sprintMul : 1);
    const mvx = ax * speed;
    const mvy = ay * speed;

    if (!transitioning) {
      player.x += mvx * dt;
      player.y += mvy * dt;
      worldClamp();
    } else {
      const e = trans.entrance;
      trans.progress += dt / trans.duration;
      const p = clamp(trans.progress, 0, 1);

      const push = (e.depth / trans.duration);
      player.x += e.dir.dx * push * dt + mvx * dt * 0.08;
      player.y += e.dir.dy * push * dt + mvy * dt * 0.08;
      worldClamp();

      if (p >= 1) {
        currentLayer = e.toLayer;
        setLayerUI(currentLayer);
        transitioning = false;
        trans.entrance = null;
      }
    }

    cam.x += (player.x - cam.x) * cam.smooth;
    cam.y += (player.y - cam.y) * cam.smooth;

    render(now, mvx, mvy);
    requestAnimationFrame(tick);
  }

  function render(now, mvx, mvy) {
    const w = innerWidth, h = innerHeight;
    const camX = cam.x - w / 2;
    const camY = cam.y - h / 2;

    ctx.fillStyle = (currentLayer === LAYER0) ? '#0b2417' : (currentLayer === LAYER1 ? '#070912' : '#0b0509');
    ctx.fillRect(0, 0, w, h);

    renderLayer(currentLayer, now, camX, camY, null);

    const entrances = getNearbyEntrances(currentLayer, now);

    for (const e of entrances) {
      const d = Math.hypot(player.x - e.x, player.y - e.y);
      if (d < TILE * 14) renderOtherLayerInPortal(e, now, camX, camY);
      drawEntranceRimAndArrow(e, camX, camY);
    }

    if (transitioning && trans.entrance) {
      const e = trans.entrance;
      const p = clamp(trans.progress, 0, 1);
      const t = easeInOut(p);

      const start = portalStartRectScreen(e, camX, camY);
      const end = { x: 0, y: 0, w, h, r: 0 };
      const rect = lerpRect(start, end, t);

      const portalCamX = player.x - w / 2;
      const portalCamY = player.y - h / 2;
      renderLayer(e.toLayer, now, portalCamX, portalCamY, rect);
    }

    const px = player.x - camX;
    const py = player.y - camY;

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(px, py + 8, player.r * 1.0, player.r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = '#d9f99d';
    ctx.fillRect(-player.r, -player.r, player.r * 2, player.r * 2);
    ctx.fillStyle = '#14532d';
    ctx.fillRect(-player.r + 3, -player.r + 3, 6, 6);
    ctx.restore();

    if (entranceInfo) {
      let nearest = null, best = Infinity;
      for (const e of entrances) {
        const d = Math.hypot(player.x - e.x, player.y - e.y);
        if (d < best) { best = d; nearest = e; }
      }
      if (nearest && best < TILE * 4.2) {
        entranceInfo.textContent = `Portal nearby • walk in`;
        entranceInfo.classList.remove('ghost');
      } else {
        entranceInfo.textContent = `No portal nearby`;
        entranceInfo.classList.add('ghost');
      }
    }

    if (!transitioning) tryStartTransition(entrances, mvx, mvy);

    if (debug) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '12px ui-sans-serif,system-ui';
      ctx.fillText(`Layer=${currentLayer} pos=(${player.x.toFixed(1)},${player.y.toFixed(1)}) cache=${chunkCache.size}`, 14, h - 14);
      ctx.restore();
    }
  }

  requestAnimationFrame(tick);
})();
