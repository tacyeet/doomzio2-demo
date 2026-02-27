(() => {
  'use strict';

  // ===== Canvas setup =====
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ===== World constants =====
  const TILE = 24;                 // pixels per tile
  const CHUNK_TILES = 16;          // chunk is CHUNK_TILES x CHUNK_TILES tiles
  const CHUNK_PX = TILE * CHUNK_TILES;

  const WORLD_CHUNKS_W = 12;
  const WORLD_CHUNKS_H = 12;
  const WORLD_W = WORLD_CHUNKS_W * CHUNK_PX;
  const WORLD_H = WORLD_CHUNKS_H * CHUNK_PX;

  // Two layers
  const LAYER_SURFACE = 0;
  const LAYER_CAVE = 1;

  // ===== Input =====
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key.toLowerCase() === 'f') debug = !debug;
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // ===== Deterministic RNG helpers =====
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
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 4294967296;
  }
  function smoothstep(t) { return t * t * (3 - 2 * t); }

  // Smooth-ish 2D value noise (cheap, deterministic)
  function valueNoise2D(x, y, layer, freq) {
    const fx = x / freq;
    const fy = y / freq;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = x0 + 1, y1 = y0 + 1;
    const tx = smoothstep(fx - x0);
    const ty = smoothstep(fy - y0);

    const a = rand01(hash32(x0, y0, layer) ^ 0xA3C59AC3);
    const b = rand01(hash32(x1, y0, layer) ^ 0xA3C59AC3);
    const c = rand01(hash32(x0, y1, layer) ^ 0xA3C59AC3);
    const d = rand01(hash32(x1, y1, layer) ^ 0xA3C59AC3);

    const ab = a + (b - a) * tx;
    const cd = c + (d - c) * tx;
    return ab + (cd - ab) * ty; // 0..1
  }

  // Small helper to shade a hex color
  function shadeHex(hex, amt) {
    // amt in [-1..1], shifts brightness
    const s = hex.startsWith('#') ? hex.slice(1) : hex;
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);

    const k = Math.round(amt * 38); // brightness scale
    const nr = Math.max(0, Math.min(255, r + k));
    const ng = Math.max(0, Math.min(255, g + k));
    const nb = Math.max(0, Math.min(255, b + k));

    const toHex = (v) => v.toString(16).padStart(2, '0');
    return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
  }

  // ===== Chunk cache (LRU-ish) =====
  const MAX_CHUNKS = 220;
  const chunkCache = new Map(); // key => {tiles, entrances}
  const chunkUse = new Map();   // key => lastUsedTime
  function chunkKey(layer, cx, cy) { return `${layer}:${cx}:${cy}`; }

  function getChunk(layer, cx, cy, t) {
    const key = chunkKey(layer, cx, cy);
    if (chunkCache.has(key)) {
      chunkUse.set(key, t);
      return chunkCache.get(key);
    }
    const chunk = genChunk(layer, cx, cy);
    chunkCache.set(key, chunk);
    chunkUse.set(key, t);

    if (chunkCache.size > MAX_CHUNKS) {
      // evict least recently used (prefer to evict non-current layer)
      let oldestKey = null;
      let oldestT = Infinity;
      for (const [k, last] of chunkUse.entries()) {
        if (last < oldestT) { oldestT = last; oldestKey = k; }
      }
      if (oldestKey && !oldestKey.startsWith(currentLayer + ':')) {
        chunkCache.delete(oldestKey);
        chunkUse.delete(oldestKey);
      }
    }
    return chunk;
  }

  // ===== Entrance directions =====
  const DIRS = [
    { name: 'Down',  dx: 0, dy:  1, ang: Math.PI / 2 },
    { name: 'Right', dx: 1, dy:  0, ang: 0 },
    { name: 'Up',    dx: 0, dy: -1, ang: -Math.PI / 2 },
    { name: 'Left',  dx: -1,dy:  0, ang: Math.PI },
  ];

  // ===== Chunk generation =====
  function genChunk(layer, cx, cy) {
    const tiles = new Uint8Array(CHUNK_TILES * CHUNK_TILES);
    const baseSeed = hash32(cx, cy, layer);

    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = cx * CHUNK_TILES + tx;
        const wy = cy * CHUNK_TILES + ty;
        const s = hash32(wx, wy, layer) ^ baseSeed;
        const r = rand01(s);

        let v = 0;
        // sprinkle obstacles
        if (r < 0.08) v = 1;        // rock
        else if (r < 0.14) v = 2;   // shrub/rubble
        tiles[ty * CHUNK_TILES + tx] = v;
      }
    }

    // Entrances: every 4 chunks, but now placed on chunk edges (not center)
    const entrances = [];
    if (cx % 4 === 0 && cy % 4 === 0) {
      const idx = ((cx / 4) + (cy / 4) * 9999) & 3;
      const dir = DIRS[idx];

      // Style cycles A/B/C/D
      const style = idx & 3;

      // Place mouth on the chunk EDGE in the dir direction
      const pad = TILE * 1.35;
      let ex = cx * CHUNK_PX + CHUNK_PX / 2;
      let ey = cy * CHUNK_PX + CHUNK_PX / 2;

      if (dir.name === 'Down')  ey = cy * CHUNK_PX + (CHUNK_PX - pad);
      if (dir.name === 'Up')    ey = cy * CHUNK_PX + pad;
      if (dir.name === 'Right') ex = cx * CHUNK_PX + (CHUNK_PX - pad);
      if (dir.name === 'Left')  ex = cx * CHUNK_PX + pad;

      const mouthW = TILE * 3.4;
      const mouthH = TILE * 1.9;
      const depth = TILE * 3.2;

      entrances.push({
        id: `${cx},${cy},${style}`,
        layer,
        toLayer: (layer === LAYER_SURFACE ? LAYER_CAVE : LAYER_SURFACE),
        cx, cy,
        x: ex,
        y: ey,
        dir,
        style,
        mouthW,
        mouthH,
        depth,
      });
    }

    return { tiles, entrances };
  }

  // ===== Player =====
  const player = {
    x: WORLD_W / 2,
    y: WORLD_H / 2,
    r: 10,
    speed: 170,
    sprintMul: 1.45,
  };

  let currentLayer = LAYER_SURFACE;

  // ===== Transition state =====
  let transitioning = false;
  let trans = {
    entrance: null,
    progress: 0,
    duration: 0.60,
    fromLayer: 0,
    toLayer: 1,
    carryDx: 0,
    carryDy: 0,
    swapped: false
  };

  // ===== Debug =====
  let debug = false;

  // ===== Camera =====
  const cam = { x: player.x, y: player.y, smooth: 0.12 };
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function worldClamp() {
    player.x = clamp(player.x, 0, WORLD_W);
    player.y = clamp(player.y, 0, WORLD_H);
  }

  // ===== Entrances =====
  function getNearbyEntrances(layer, t) {
    const cx = Math.floor(player.x / CHUNK_PX);
    const cy = Math.floor(player.y / CHUNK_PX);
    const out = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= WORLD_CHUNKS_W || ny >= WORLD_CHUNKS_H) continue;
        const ch = getChunk(layer, nx, ny, t);
        for (const e of ch.entrances) out.push(e);
      }
    }
    return out;
  }

  function pointInOrientedMouth(px, py, e) {
    // Transform point into entrance local space aligned with dir.
    const ang = e.dir.ang;
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const lx = (px - e.x) * cos - (py - e.y) * sin;
    const ly = (px - e.x) * sin + (py - e.y) * cos;
    return (Math.abs(lx) <= e.mouthW / 2) && (Math.abs(ly) <= e.mouthH / 2);
  }

  function isApproachingEntrance(e, mvx, mvy) {
    const mLen = Math.hypot(mvx, mvy);
    if (mLen < 0.01) return false;
    const mx = mvx / mLen, my = mvy / mLen;
    const dot = mx * e.dir.dx + my * e.dir.dy;
    return dot > 0.45; // tighter cone now that entrances are directional
  }

  function maybeStartTransition(entrances, mvx, mvy) {
    if (transitioning) return null;
    for (const e of entrances) {
      if (pointInOrientedMouth(player.x, player.y, e) && isApproachingEntrance(e, mvx, mvy)) {
        transitioning = true;
        trans.entrance = e;
        trans.progress = 0;
        trans.duration = 0.60;
        trans.fromLayer = currentLayer;
        trans.toLayer = e.toLayer;
        trans.carryDx = e.dir.dx;
        trans.carryDy = e.dir.dy;
        trans.swapped = false;
        return e;
      }
    }
    return null;
  }

  // ===== UI =====
  const layerBadge = document.getElementById('layerBadge');
  const entranceInfo = document.getElementById('entranceInfo');
  function setLayerUI() {
    layerBadge.textContent = `Layer: ${currentLayer === LAYER_SURFACE ? 'Surface' : 'Cave'}`;
  }
  setLayerUI();

  // ===== Rendering helpers =====
  function roundRectFill(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    ctx.fill();
  }

  // World-anchored grid (fixes “grid stuck to player”)
  function drawWorldGrid(camX, camY, w, h, stepPx, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;

    const startX = Math.floor(camX / stepPx) * stepPx;
    const startY = Math.floor(camY / stepPx) * stepPx;

    ctx.beginPath();
    for (let x = startX; x <= camX + w; x += stepPx) {
      const sx = x - camX;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let y = startY; y <= camY + h; y += stepPx) {
      const sy = y - camY;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Terrain palette
  function baseTileColor(layer, v) {
    if (layer === LAYER_SURFACE) {
      if (v === 0) return '#18402a'; // grass base
      if (v === 1) return '#4b4f57'; // rock
      return '#23563a';              // shrub
    } else {
      if (v === 0) return '#141724'; // cave floor
      if (v === 1) return '#3a3f4c'; // cave rock
      return '#23283a';              // rubble
    }
  }

  // Draw a tile with sub-square micro variation + smooth noise shading
  function drawTile(layer, wxTile, wyTile, screenX, screenY, v) {
    const base = baseTileColor(layer, v);

    // Large-scale smooth variation
    const n1 = valueNoise2D(wxTile, wyTile, layer ^ 17, 7.5); // 0..1
    const n2 = valueNoise2D(wxTile, wyTile, layer ^ 77, 18.0); // 0..1
    const shade = (n1 * 0.65 + n2 * 0.35) - 0.52; // ~[-0.5..0.5]
    const shaded = shadeHex(base, shade * 0.55);

    // Fill base tile
    ctx.fillStyle = shaded;
    ctx.fillRect(screenX, screenY, TILE, TILE);

    // Sub-square micro pattern (2x2)
    const half = TILE / 2;
    const microA = rand01(hash32(wxTile * 3 + 11, wyTile * 3 + 7, layer) ^ 0x55AA);
    const microB = rand01(hash32(wxTile * 3 + 19, wyTile * 3 + 3, layer) ^ 0xAA55);
    const microC = rand01(hash32(wxTile * 3 + 5, wyTile * 3 + 17, layer) ^ 0xCC33);
    const microD = rand01(hash32(wxTile * 3 + 23, wyTile * 3 + 29, layer) ^ 0x33CC);

    const m = (u) => (u - 0.5) * 0.22; // small variation amount
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = shadeHex(shaded, m(microA));
    ctx.fillRect(screenX, screenY, half, half);
    ctx.fillStyle = shadeHex(shaded, m(microB));
    ctx.fillRect(screenX + half, screenY, half, half);
    ctx.fillStyle = shadeHex(shaded, m(microC));
    ctx.fillRect(screenX, screenY + half, half, half);
    ctx.fillStyle = shadeHex(shaded, m(microD));
    ctx.fillRect(screenX + half, screenY + half, half, half);
    ctx.globalAlpha = 1;

    // If obstacle, add a simple glyph so it reads
    if (v !== 0) {
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = (layer === LAYER_SURFACE)
        ? (v === 1 ? '#2b2f36' : '#173322')
        : (v === 1 ? '#1d2028' : '#141724');
      const pad = 4;
      roundRectFill(screenX + pad, screenY + pad, TILE - pad * 2, TILE - pad * 2, 4);
      ctx.restore();
    }
  }

  // Draw a "mirror window" preview of the other layer inside the entrance mouth
  function drawMirrorPreview(e, camX, camY) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Screen position
    const sx = e.x - camX;
    const sy = e.y - camY;

    // Clip to the mouth shape in screen space
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(e.dir.ang);

    // mouth rect local coords
    const mw = e.mouthW;
    const mh = e.mouthH;

    // Clip region
    ctx.beginPath();
    const r = 10;
    const x = -mw / 2, y = -mh / 2;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + mw, y, x + mw, y + mh, r);
    ctx.arcTo(x + mw, y + mh, x, y + mh, r);
    ctx.arcTo(x, y + mh, x, y, r);
    ctx.arcTo(x, y, x + mw, y, r);
    ctx.closePath();
    ctx.clip();

    // Parallax shift so it reads as "depth"
    const par = TILE * 0.9;
    const shiftX = e.dir.dx * par;
    const shiftY = e.dir.dy * par;

    // We will render the other layer tiles behind this mouth in a small area
    const toLayer = e.toLayer;

    // Determine world-space rect to sample
    // We sample a small rectangle centered at entrance, shifted "forward"
    const sampleCenterX = e.x + shiftX;
    const sampleCenterY = e.y + shiftY;

    // Draw tile samples at the mouth scale (no need for perfect perspective)
    const sampleTilesX = 6;
    const sampleTilesY = 4;

    const startWX = Math.floor((sampleCenterX - (sampleTilesX * TILE) / 2) / TILE);
    const startWY = Math.floor((sampleCenterY - (sampleTilesY * TILE) / 2) / TILE);

    // Fill with other-layer terrain
    for (let iy = 0; iy < sampleTilesY; iy++) {
      for (let ix = 0; ix < sampleTilesX; ix++) {
        const wxTile = startWX + ix;
        const wyTile = startWY + iy;

        // Convert world tile -> chunk -> local tile
        const ccx = Math.floor((wxTile * TILE) / CHUNK_PX);
        const ccy = Math.floor((wyTile * TILE) / CHUNK_PX);
        if (ccx < 0 || ccy < 0 || ccx >= WORLD_CHUNKS_W || ccy >= WORLD_CHUNKS_H) continue;

        const ch = getChunk(toLayer, ccx, ccy, performance.now());
        const localTx = wxTile - ccx * CHUNK_TILES;
        const localTy = wyTile - ccy * CHUNK_TILES;
        if (localTx < 0 || localTy < 0 || localTx >= CHUNK_TILES || localTy >= CHUNK_TILES) continue;

        const v = ch.tiles[localTy * CHUNK_TILES + localTx];

        // draw into mouth local coords (centered)
        const dx = (-mw / 2) + (ix / sampleTilesX) * mw;
        const dy = (-mh / 2) + (iy / sampleTilesY) * mh;
        const tw = mw / sampleTilesX;
        const th = mh / sampleTilesY;

        const base = baseTileColor(toLayer, v);
        const n = valueNoise2D(wxTile, wyTile, toLayer ^ 33, 11);
        const shaded = shadeHex(base, (n - 0.52) * 0.45);

        ctx.fillStyle = shaded;
        ctx.fillRect(dx, dy, tw + 0.5, th + 0.5);
      }
    }

    // Add a faint "glass" sheen to sell mirror
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#a5f3fc';
    ctx.fillRect(-mw / 2, -mh / 2, mw, mh);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawEntrance(e, camX, camY) {
    // Mirror preview first (so rim draws over it)
    drawMirrorPreview(e, camX, camY);

    const sx = e.x - camX;
    const sy = e.y - camY;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(e.dir.ang);

    const w = e.mouthW, h = e.mouthH;

    // Rim / mouth visuals
    if (e.style === 0) {
      // A: Hole with lip
      ctx.fillStyle = '#2b2a26';
      roundRectFill(-w / 2 - 8, -h / 2 - 8, w + 16, h + 16, 12);
      const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      g.addColorStop(0, '#0b0c0f');
      g.addColorStop(1, '#000000');
      ctx.fillStyle = g;
      roundRectFill(-w / 2, -h / 2, w, h, 10);

      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#ffffff';
      roundRectFill(-w / 2 - 8, -h / 2 - 8, w + 16, 7, 12);
      ctx.globalAlpha = 1;
    } else if (e.style === 1) {
      // B: Ramp / steps
      ctx.fillStyle = '#2a2e3a';
      for (let i = 0; i < 6; i++) {
        const t = i / 6;
        const ww = w * (1 - 0.18 * t);
        const yy = -h / 2 + t * h;
        ctx.globalAlpha = 0.95 - 0.12 * i;
        roundRectFill(-ww / 2, yy, ww, h / 6 + 1, 6);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b0c0f';
      roundRectFill(-w * 0.38, -h / 2 + h * 0.55, w * 0.76, h * 0.42, 8);
    } else if (e.style === 2) {
      // C: Arch mouth / overhang
      ctx.fillStyle = '#2b2a26';
      roundRectFill(-w / 2 - 10, -h / 2 - 12, w + 20, h + 24, 16);
      ctx.fillStyle = '#0b0c0f';
      roundRectFill(-w / 2, -h / 2, w, h, 12);

      // Overhang band
      ctx.fillStyle = '#1b1a17';
      ctx.globalAlpha = 0.85;
      roundRectFill(-w / 2 - 10, -h / 2 - 12, w + 20, 14, 16);
      ctx.globalAlpha = 1;
    } else {
      // D: Rune rim (fantasy)
      ctx.fillStyle = '#1b1a17';
      roundRectFill(-w / 2 - 9, -h / 2 - 9, w + 18, h + 18, 14);
      ctx.fillStyle = '#050608';
      roundRectFill(-w / 2, -h / 2, w, h, 12);

      ctx.globalAlpha = 0.65;
      ctx.strokeStyle = '#7dd3fc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(w, h) * 0.44, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Shadow behind lip to sell depth (always)
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    roundRectFill(-w / 2, h / 2 + 6, w, 8, 6);
    ctx.globalAlpha = 1;

    // Entry arrow (shows which side to walk in from)
    // Arrow sits outside the mouth on the "front" side and points inward
    const arrowDist = h / 2 + 22;
    ctx.save();
    ctx.translate(0, -arrowDist);  // front side in local space is negative Y
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-10, -14);
    ctx.lineTo(10, -14);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.moveTo(0, -3);
    ctx.lineTo(-6, -12);
    ctx.lineTo(6, -12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  function drawVignette(amount) {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.save();
    ctx.globalAlpha = amount;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.15, w / 2, h / 2, Math.max(w, h) * 0.65);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // ===== Main loop =====
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Input movement
    let ax = 0, ay = 0;
    if (keys.has('w')) ay -= 1;
    if (keys.has('s')) ay += 1;
    if (keys.has('a')) ax -= 1;
    if (keys.has('d')) ax += 1;

    const len = Math.hypot(ax, ay) || 1;
    ax /= len; ay /= len;

    const sprint = keys.has('shift');
    const speed = player.speed * (sprint ? player.sprintMul : 1);

    const mvx = ax * speed;
    const mvy = ay * speed;

    let vignette = 0;

    if (!transitioning) {
      player.x += mvx * dt;
      player.y += mvy * dt;
      worldClamp();
    } else {
      const e = trans.entrance;
      trans.progress += dt / trans.duration;
      const p = clamp(trans.progress, 0, 1);

      // Swap at midpoint (feels like you're inside)
      if (!trans.swapped && p >= 0.52) {
        currentLayer = trans.toLayer;
        setLayerUI();
        trans.swapped = true;
      }

      // Carry forward down the entrance direction (so it feels like walking into it)
      const carrySpeed = (e.depth / trans.duration);
      player.x += trans.carryDx * carrySpeed * dt + mvx * dt * 0.12;
      player.y += trans.carryDy * carrySpeed * dt + mvy * dt * 0.12;
      worldClamp();

      vignette = Math.sin(p * Math.PI) * 0.60;

      if (p >= 1) {
        transitioning = false;
        trans.entrance = null;
      }
    }

    // Camera follow
    cam.x += (player.x - cam.x) * cam.smooth;
    cam.y += (player.y - cam.y) * cam.smooth;

    render(now, vignette, mvx, mvy);
    requestAnimationFrame(tick);
  }

  function render(t, vignette, mvx, mvy) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Background clear
    ctx.fillStyle = (currentLayer === LAYER_SURFACE) ? '#0b2417' : '#070912';
    ctx.fillRect(0, 0, w, h);

    const camX = cam.x - w / 2;
    const camY = cam.y - h / 2;

    // Visible chunk range (+ margin)
    const minCX = clamp(Math.floor((camX - CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_W - 1);
    const maxCX = clamp(Math.floor((camX + w + CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_W - 1);
    const minCY = clamp(Math.floor((camY - CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_H - 1);
    const maxCY = clamp(Math.floor((camY + h + CHUNK_PX) / CHUNK_PX), 0, WORLD_CHUNKS_H - 1);

    // Draw tiles and entrances
    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const chunk = getChunk(currentLayer, cx, cy, t);

        const ox = cx * CHUNK_PX - camX;
        const oy = cy * CHUNK_PX - camY;

        // Draw tiles with smoothing
        for (let ty = 0; ty < CHUNK_TILES; ty++) {
          for (let tx = 0; tx < CHUNK_TILES; tx++) {
            const v = chunk.tiles[ty * CHUNK_TILES + tx];
            const wxTile = cx * CHUNK_TILES + tx;
            const wyTile = cy * CHUNK_TILES + ty;
            drawTile(currentLayer, wxTile, wyTile, ox + tx * TILE, oy + ty * TILE, v);
          }
        }

        // Chunk border + label
        if (debug) {
          ctx.save();
          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(ox, oy, CHUNK_PX, CHUNK_PX);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = '#fff';
          ctx.font = '12px ui-sans-serif,system-ui';
          ctx.fillText(`c${cx},${cy}`, ox + 6, oy + 14);
          ctx.restore();
        }

        // Entrances
        for (const e of chunk.entrances) drawEntrance(e, camX, camY);
      }
    }

    // Debug world grid (anchored)
    if (debug) {
      drawWorldGrid(camX, camY, w, h, TILE, 0.14);          // small grid
      drawWorldGrid(camX, camY, w, h, CHUNK_PX, 0.22);       // chunk grid
    }

    // Player shadow
    const px = player.x - camX;
    const py = player.y - camY;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(px, py + 8, player.r * 1.0, player.r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Player body (rounded square)
    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = '#d9f99d';
    roundRectFill(-player.r, -player.r, player.r * 2, player.r * 2, 6);
    ctx.fillStyle = '#14532d';
    roundRectFill(-player.r + 3, -player.r + 3, 6, 6, 2);
    ctx.restore();

    // Entrance proximity UI
    const entrances = getNearbyEntrances(currentLayer, t);
    let nearest = null;
    let nearestD = Infinity;
    for (const e of entrances) {
      const d = Math.hypot(player.x - e.x, player.y - e.y);
      if (d < nearestD) { nearestD = d; nearest = e; }
    }
    if (nearest && nearestD < TILE * 3.6) {
      const names = ['A Hole/Lip', 'B Ramp', 'C Arch', 'D Rune'];
      entranceInfo.textContent = `Entrance: ${names[nearest.style]} • Walk in from arrow side`;
      entranceInfo.classList.remove('ghost');
    } else {
      entranceInfo.textContent = 'No entrance nearby';
      entranceInfo.classList.add('ghost');
    }

    // Auto-start transition if we walk into a mouth in the correct direction
    if (!transitioning) {
      maybeStartTransition(entrances, mvx, mvy);
    }

    // Transition vignette
    if (vignette > 0.001) drawVignette(vignette);

    // Cave atmosphere overlay (subtle)
    if (currentLayer === LAYER_CAVE) {
      ctx.save();
      ctx.globalAlpha = 0.10;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    // Debug readout
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
