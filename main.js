/*
  Doomz Layers + Chunking demo
  - 2 layers: Surface (0) and Cave (1)
  - Chunk streaming + basic LRU cache
  - Grid-based world
  - Entrances every 4 chunks (various transition styles)

  No dependencies.
*/

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // roundRect polyfill for older browsers
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
      const rr = Array.isArray(r) ? r : [r,r,r,r];
      const [r1,r2,r3,r4] = rr;
      this.beginPath();
      this.moveTo(x + r1, y);
      this.lineTo(x + w - r2, y);
      this.quadraticCurveTo(x + w, y, x + w, y + r2);
      this.lineTo(x + w, y + h - r3);
      this.quadraticCurveTo(x + w, y + h, x + w - r3, y + h);
      this.lineTo(x + r4, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - r4);
      this.lineTo(x, y + r1);
      this.quadraticCurveTo(x, y, x + r1, y);
      return this;
    };
  }


  // ----- World config -----
  const TILE = 16;               // tile size in pixels
  const CHUNK_TILES = 32;        // 32 tiles per chunk
  const CHUNK_PX = TILE * CHUNK_TILES; // 512px

  const WORLD_CHUNKS_X = 12;     // "kinda big" but not huge
  const WORLD_CHUNKS_Y = 12;
  const WORLD_PX_W = WORLD_CHUNKS_X * CHUNK_PX;
  const WORLD_PX_H = WORLD_CHUNKS_Y * CHUNK_PX;

  const LAYERS = [
    { id: 0, name: 'Surface', palette: { a: '#133d2f', b: '#0f2e24', grid: 'rgba(255,255,255,0.08)', prop: '#2dd4bf' } },
    { id: 1, name: 'Cave',    palette: { a: '#1b1a2b', b: '#121225', grid: 'rgba(255,255,255,0.08)', prop: '#a78bfa' } },
  ];

  // Entrance types (we rotate them across entrances)
  const ENTRANCE_TYPES = [
    {
      id: 'A',
      name: 'Crossfade swap (seamless feeling)',
      hint: 'Fades to dark then swaps active layer. Same (x,y).',
      transition: crossfadeTransition,
      renderEntrance: renderHoleEntrance,
    },
    {
      id: 'B',
      name: 'Zoom + vignette (tight tunnel feel)',
      hint: 'Small zoom-in, heavy vignette, swap, zoom-out. Same (x,y).',
      transition: zoomVignetteTransition,
      renderEntrance: renderRampEntrance,
    },
    {
      id: 'C',
      name: 'Slide down + darkness ("descending")',
      hint: 'Camera eases down briefly, darkens, swap, ease back.',
      transition: slideDownTransition,
      renderEntrance: renderArchEntrance,
    },
    {
      id: 'D',
      name: 'Interior offset (teleport disguised)',
      hint: 'Moves you to an off-map interior region (still looks like descent).',
      transition: interiorOffsetTransition,
      renderEntrance: renderPitEntrance,
    },
  ];

  // ----- Simple RNG (deterministic per chunk/layer) -----
  function hash32(x) {
    x |= 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return x >>> 0;
  }
  function seededRand(seed) {
    // xorshift32
    let s = seed >>> 0;
    return () => {
      s ^= (s << 13) >>> 0;
      s ^= (s >>> 17) >>> 0;
      s ^= (s << 5) >>> 0;
      return (s >>> 0) / 4294967296;
    };
  }

  // ----- Chunk cache (LRU) -----
  class LRU {
    constructor(limit) {
      this.limit = limit;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return null;
      const v = this.map.get(key);
      // refresh
      this.map.delete(key);
      this.map.set(key, v);
      return v;
    }
    set(key, val) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, val);
      while (this.map.size > this.limit) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    }
    size() { return this.map.size; }
  }

  // Keep chunk canvases cached (Chromebook-friendly)
  const chunkCache = new LRU(220); // tuneable

  function chunkKey(layerId, cx, cy) {
    const salt = (layerId===1 && interior.enabled) ? "I" : "N";
    return `${layerId}:${cx},${cy}:${salt}`;
  }

  function generateChunkCanvas(layerId, cx, cy) {
    const layer = LAYERS[layerId];

    const off = document.createElement('canvas');
    off.width = CHUNK_PX;
    off.height = CHUNK_PX;
    const g = off.getContext('2d');

    // Base tiles
    const interiorSalt = (layerId===1 && interior.enabled) ? 91138233 : 0;
    const seed = hash32(((layerId + 1) * 1000003) + (cx * 374761393) + (cy * 668265263) + interiorSalt);
    const rnd = seededRand(seed);

    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const v = rnd();
        g.fillStyle = v > 0.5 ? layer.palette.a : layer.palette.b;
        g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      }
    }

    // Sprinkle static props (just visual)
    const propCount = 16;
    g.fillStyle = layer.palette.prop;
    for (let i = 0; i < propCount; i++) {
      const x = Math.floor(rnd() * CHUNK_PX);
      const y = Math.floor(rnd() * CHUNK_PX);
      const r = 3 + Math.floor(rnd() * 6);
      g.globalAlpha = 0.35;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }

    // Chunk grid border
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 2;
    g.strokeRect(0, 0, CHUNK_PX, CHUNK_PX);

    return off;
  }

  function getChunkCanvas(layerId, cx, cy) {
    const k = chunkKey(layerId, cx, cy);
    let c = chunkCache.get(k);
    if (!c) {
      c = generateChunkCanvas(layerId, cx, cy);
      chunkCache.set(k, c);
    }
    return c;
  }

  // ----- Entrances -----
  // Every 4 chunks add an entrance (one per chunk).
  // We use cx%4==1 and cy%4==1 so it's not always on map border.
  const entrances = [];
  for (let cy = 0; cy < WORLD_CHUNKS_Y; cy++) {
    for (let cx = 0; cx < WORLD_CHUNKS_X; cx++) {
      if (cx % 4 === 1 && cy % 4 === 1) {
        const idx = entrances.length;
        const type = ENTRANCE_TYPES[idx % ENTRANCE_TYPES.length];
        // position near chunk center
        const x = cx * CHUNK_PX + CHUNK_PX * 0.5;
        const y = cy * CHUNK_PX + CHUNK_PX * 0.5;
        entrances.push({ id: idx, cx, cy, x, y, w: 56, l: 92, dir: ENTRANCE_DIRS[idx % ENTRANCE_DIRS.length], type, cooldownUntil: 0 });
      }
    }
  }

  function findNearestEntrance(px, py, maxDist) {
    let best = null;
    let bestD2 = maxDist * maxDist;
    for (const e of entrances) {
      const dx = px - e.x;
      const dy = py - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  function entranceLocal(e, px, py) {
    // local coords: s along dir, t along perp
    const dx = px - e.x;
    const dy = py - e.y;
    const dirx = e.dir.dx, diry = e.dir.dy;
    const perpx = -diry, perpy = dirx;
    const s = dx * dirx + dy * diry;
    const t = dx * perpx + dy * perpy;
    return { s, t, dirx, diry, perpx, perpy };
  }

  function entranceContains(e, px, py) {
    const { s, t } = entranceLocal(e, px, py);
    const halfL = e.l * 0.5;
    const halfW = e.w * 0.5;
    return (Math.abs(t) <= halfW) && (s >= -halfL) && (s <= halfL);
  }

  function entranceFacingDot(e, vx, vy) {
    // vx/vy are normalized movement intent
    return vx * e.dir.dx + vy * e.dir.dy;
  }

  function tryAutoEntrance(now, moveVx, moveVy) {
    if (transition.running) return;
    if (now < player.ignoreEntranceUntil) return;

    // Need a clear movement intent (avoid idle-trigger)
    const mvLen = Math.hypot(moveVx, moveVy);
    if (mvLen < 0.2) return;

    const near = findNearestEntrance(player.x, player.y, 90);
    if (!near) return;
    if (now < near.cooldownUntil) return;

    // Must be inside the tunnel mouth area
    if (!entranceContains(near, player.x, player.y)) return;

    // Must be moving "into" it (or "out of" it when in cave)
    const dot = entranceFacingDot(near, moveVx / mvLen, moveVy / mvLen);
    const into = (activeLayer === 0) ? (dot > 0.55) : (dot < -0.55);
    if (!into) return;

    const targetLayer = activeLayer === 0 ? 1 : 0;
    const style = near.type;

    // Prefetch chunks around the entrance in target layer for seamless feel
    prefetchAround(player.x, player.y, targetLayer, 2);

    // Start a "walk-in" tunnel transition: we keep moving player forward while visuals change.
    const dirSign = (activeLayer === 0) ? 1 : -1; // flip when exiting
    runTransition(style.transition, 0.55, {
      mode: 'tunnel',
      entrance: near,
      targetLayer,
      style,
      dirSign,
      _swapped: false,
      startX: player.x,
      startY: player.y,
      // travel distance through the tunnel
      travel: 92,
      // snap strength to entrance centerline
      snap: 0.65,
    });

    // prevent immediate retrigger
    player.ignoreEntranceUntil = now + 0.9;
    near.cooldownUntil = now + 0.9;
  }

  // ----- Player & camera -----
  const player = {
    x: WORLD_PX_W * 0.35,
    y: WORLD_PX_H * 0.50,
    r: 12,
    speed: 220,
  };

  const camera = {
    x: player.x,
    y: player.y,
    zoom: 1,
  };

  let activeLayer = 0;

  // For interior-offset entrance style
  // (Concept: you can keep same (x,y) but render from offset region)
  const interior = {
    enabled: false,
    offsetX: WORLD_PX_W + 2000, // far away
    offsetY: 1200,
  };

  // ----- Input -----
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','KeyF'].includes(e.code)) {
      e.preventDefault();
    }
    keys.add(e.code);

    if (e.code === 'KeyF') debug = !debug;
  }, { passive: false });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // ----- UI -----
  const elLayer = document.getElementById('layer');
  const elChunk = document.getElementById('chunk');
  const elPos = document.getElementById('pos');
  const elNear = document.getElementById('near');
  const elNote = document.getElementById('note');

  function setNote(html) {
    elNote.innerHTML = html;
  }

  // ----- Transition engine -----
  const transition = {
    running: false,
    t: 0,
    dur: 0,
    fn: null,
    data: null,
  };

  function runTransition(fn, dur, data) {
    if (transition.running) return;
    transition.running = true;
    transition.t = 0;
    transition.dur = dur;
    transition.fn = fn;
    transition.data = data;
  }

  function finishTransition() {
    transition.running = false;
    transition.fn = null;
    transition.data = null;
  } 

  // ----- Prefetch helper -----
  function prefetchAround(px, py, layerId, radiusChunks) {
    const { cx, cy } = worldToChunk(px, py);
    for (let oy = -radiusChunks; oy <= radiusChunks; oy++) {
      for (let ox = -radiusChunks; ox <= radiusChunks; ox++) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || y < 0 || x >= WORLD_CHUNKS_X || y >= WORLD_CHUNKS_Y) continue;
        getChunkCanvas(layerId, x, y);
      }
    }
  }

  // ----- Transition styles -----
  // Transition functions are called each frame during transition.
  // They can adjust camera/player/layer switch timing.

  function crossfadeTransition(alpha, data) {
    // Switch layer at midpoint
    // draw overlay handled in render
  }

  function zoomVignetteTransition(alpha, data) {
    // zoom in then out
    const z = alpha < 0.5
      ? lerp(1, 1.06, smoothstep(0, 0.5, alpha))
      : lerp(1.06, 1, smoothstep(0.5, 1, alpha));
    camera.zoom = z;
  }

  function slideDownTransition(alpha, data) {
    // slight camera slide down on enter, up on exit
    const slide = 22;
    const dy = alpha < 0.5
      ? lerp(0, slide, smoothstep(0, 0.5, alpha))
      : lerp(slide, 0, smoothstep(0.5, 1, alpha));
    data._camSlide = dy;
  }

  function interiorOffsetTransition(alpha, data) {
    // Disguised teleport into an "interior region" off-map.
    // You still keep the player's local chunk position stable.
    // In this demo, we implement by toggling an offset on rendering & chunk keys.

    // Add a little zoom for effect
    camera.zoom = alpha < 0.5
      ? lerp(1, 1.05, smoothstep(0, 0.5, alpha))
      : lerp(1.05, 1, smoothstep(0.5, 1, alpha));

    if (alpha >= 0.5 && !data._swapped) {
      swapLayer(data);
      data._swapped = true;
      // Toggle interior rendering only while in cave for this entrance type
      interior.enabled = (activeLayer === 1);
    }
  }

  function swapLayer(data) {
    activeLayer = data.targetLayer;
    elLayer.textContent = LAYERS[activeLayer].name;

    // Reset camera slide effects
    camera.zoom = 1;

    // If leaving cave, disable interior view
    if (activeLayer === 0) interior.enabled = false;

    setNote(
      `Entered <b>${LAYERS[activeLayer].name}</b> via entrance <b>${data.style.id}</b> — ${escapeHtml(data.style.name)} ` +
      `<span style="color:#a7b3c7">(${escapeHtml(data.style.hint)})</span>`
    );
  }

  // ----- Helpers -----
  function worldToChunk(x, y) {
    return {
      cx: Math.floor(x / CHUNK_PX),
      cy: Math.floor(y / CHUNK_PX),
    };
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function dirToAngle(e) {
    const dx = e.dir.dx, dy = e.dir.dy;
    if (dx === 0 && dy === 1) return 0;
    if (dx === 0 && dy === -1) return Math.PI;
    if (dx === 1 && dy === 0) return Math.PI / 2;
    return -Math.PI / 2;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, t) {
    t = clamp((t - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#39;');
  }

  // ----- Rendering -----
  let debug = false;

  function drawGridOverlay() {
    // Draw tile grid lightly around camera
    const layer = LAYERS[activeLayer];
    ctx.strokeStyle = layer.palette.grid;
    ctx.lineWidth = 1;

    const left = camera.x - (canvas.width / 2) / camera.zoom;
    const top = camera.y - (canvas.height / 2) / camera.zoom;
    const right = camera.x + (canvas.width / 2) / camera.zoom;
    const bottom = camera.y + (canvas.height / 2) / camera.zoom;

    const startX = Math.floor(left / TILE) * TILE;
    const startY = Math.floor(top / TILE) * TILE;

    for (let x = startX; x <= right; x += TILE) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    for (let y = startY; y <= bottom; y += TILE) {
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
  }

  function renderEntranceHole(gx, gy, e, layerId) {
    // Hole entrance: rim + depth gradient
    const type = e.type;
    type.renderEntrance(gx, gy, e, layerId);
  }

    function renderHoleEntrance(gx, gy, e, layerId) {
    // "Hole with lip" aligned to entrance direction (reads as depth, not a portal)
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(dirToAngle(e));

    const halfW = e.w * 0.5;
    const halfL = e.l * 0.5;

    // ground shadow behind the lip (outside)
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(0, -halfL - 6, halfW * 0.95, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    // rocky lip (thick rim)
    const lipGrad = ctx.createLinearGradient(0, -halfL - 12, 0, -halfL + 12);
    lipGrad.addColorStop(0, 'rgba(255,255,255,0.10)');
    lipGrad.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = lipGrad;
    ctx.beginPath();
    ctx.roundRect(-halfW - 8, -halfL - 18, e.w + 16, 24, 10);
    ctx.fill();

    // dark interior (depth gradient)
    const g = ctx.createLinearGradient(0, -halfL, 0, halfL);
    g.addColorStop(0, 'rgba(0,0,0,0.96)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.75)');
    g.addColorStop(1, 'rgba(0,0,0,0.15)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(-halfW, -halfL, e.w, e.l, 10);
    ctx.fill();

    // subtle inner edge highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-halfW, -halfL, e.w, e.l, 10);
    ctx.stroke();

    ctx.restore();
  }

    function renderRampEntrance(gx, gy, e, layerId) {
    // Ramp / stairwell: perspective narrowing sells "down"
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(dirToAngle(e));

    const halfW = e.w * 0.5;
    const halfL = e.l * 0.5;

    // ramp trapezoid (narrower deeper)
    const topW = e.w * 1.05;
    const botW = e.w * 0.55;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(0, -halfL - 8, topW * 0.45, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    const rampGrad = ctx.createLinearGradient(0, -halfL, 0, halfL);
    rampGrad.addColorStop(0, 'rgba(60,60,80,0.55)');
    rampGrad.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = rampGrad;
    ctx.beginPath();
    ctx.moveTo(-topW/2, -halfL);
    ctx.lineTo(topW/2, -halfL);
    ctx.lineTo(botW/2, halfL);
    ctx.lineTo(-botW/2, halfL);
    ctx.closePath();
    ctx.fill();

    // steps
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    const steps = 6;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const y = lerp(-halfL, halfL, t);
      const w = lerp(topW, botW, t);
      ctx.beginPath();
      ctx.moveTo(-w/2, y);
      ctx.lineTo(w/2, y);
      ctx.stroke();
    }

    // mouth darkness at the bottom
    const mouth = ctx.createRadialGradient(0, halfL - 6, 2, 0, halfL - 6, 26);
    mouth.addColorStop(0, 'rgba(0,0,0,0.95)');
    mouth.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = mouth;
    ctx.beginPath();
    ctx.ellipse(0, halfL - 6, botW * 0.42, 14, 0, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
  }

    ctx.restore();
  }

    function renderArchEntrance(gx, gy, e, layerId) {
    // Cave mouth arch with overhang feel (occlusion cue)
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(dirToAngle(e));

    const halfW = e.w * 0.55;
    const halfL = e.l * 0.5;

    // interior darkness
    const g = ctx.createLinearGradient(0, -halfL, 0, halfL);
    g.addColorStop(0, 'rgba(0,0,0,0.95)');
    g.addColorStop(1, 'rgba(0,0,0,0.20)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(-halfW, -halfL, halfW*2, e.l, 14);
    ctx.fill();

    // arch rim
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(-halfW-6, -halfL-6, (halfW+6)*2, e.l+12, 18);
    ctx.stroke();

    // overhang shadow (drawn on top edge)
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(0, -halfL-4, halfW*0.95, 10, 0, 0, Math.PI*2);
    ctx.fill();

    // little rocks
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.arc(-halfW-10, -halfL+10, 4, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(halfW+8, -halfL+18, 3, 0, Math.PI*2); ctx.fill();

    ctx.restore();
  }

    function renderPitEntrance(gx, gy, e, layerId) {
    // "Magic pit" variant: still reads as depth but adds fantasy glow
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(dirToAngle(e));

    const halfW = e.w * 0.5;
    const halfL = e.l * 0.5;

    // outer rim
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.roundRect(-halfW-8, -halfL-8, e.w+16, e.l+16, 12);
    ctx.fill();

    // inner dark
    ctx.fillStyle = 'rgba(0,0,0,0.80)';
    ctx.beginPath();
    ctx.roundRect(-halfW, -halfL, e.w, e.l, 10);
    ctx.fill();

    // faint glow (changes per layer to show it's an "entrance", not a portal)
    const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 48);
    glow.addColorStop(0, layerId === 0 ? 'rgba(59,130,246,0.22)' : 'rgba(168,85,247,0.20)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(0, 0, halfW*1.05, halfL*0.85, 0, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
  }

    ctx.restore();
  }

  function drawEntrances() {
    // draw entrances only if on surface OR cave (both layers have same entrance positions)
    for (const e of entrances) {
      const gx = e.x;
      const gy = e.y;
      // draw only if near camera (simple cull)
      if (Math.abs(gx - camera.x) > (canvas.width / 2) / camera.zoom + 120) continue;
      if (Math.abs(gy - camera.y) > (canvas.height / 2) / camera.zoom + 120) continue;

      // Different entrance visuals per entrance type
      e.type.renderEntrance(gx, gy, e, activeLayer);

      // Label (only in debug)
      if (debug) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas';
        ctx.fillText(`E${e.id} [${e.type.id}]`, gx - 28, gy - 34);
      }
    }
  }

  function drawPlayer() {
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(player.x + 5, player.y + 7, player.r + 3, player.r, 0.2, 0, Math.PI * 2);
    ctx.fill();

    // player circle
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
    ctx.fill();

    // facing marker
    ctx.fillStyle = '#0ea5e9';
    ctx.beginPath();
    ctx.arc(player.x + player.r * 0.55, player.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawVignette(strength) {
    if (strength <= 0) return;
    // One cheap fullscreen vignette
    const w = canvas.width;
    const h = canvas.height;
    const grad = ctx.createRadialGradient(w/2, h/2, Math.min(w,h)*0.2, w/2, h/2, Math.max(w,h)*0.65);
    grad.addColorStop(0, `rgba(0,0,0,0)`);
    grad.addColorStop(1, `rgba(0,0,0,${0.60 * strength})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  function drawTransitionOverlay(alpha) {
    // alpha: 0..1
    // Fade to black in first half, fade out in second half.
    const a = alpha < 0.5
      ? smoothstep(0, 0.5, alpha)
      : (1 - smoothstep(0.5, 1, alpha));

    // heavier for cave
    const strength = a * 0.85;

    ctx.save();
    ctx.resetTransform();
    ctx.fillStyle = `rgba(0,0,0,${strength})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawVignette(a);
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Camera transform
    ctx.save();

    const slide = transition.running && transition.data? (transition.data._camSlide || 0) : 0;

    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y + slide);

    // Determine visible chunk range
    const viewW = canvas.width / camera.zoom;
    const viewH = canvas.height / camera.zoom;
    const left = camera.x - viewW / 2;
    const top = camera.y - viewH / 2 + slide;
    const right = camera.x + viewW / 2;
    const bottom = camera.y + viewH / 2 + slide;

    const minCx = clamp(Math.floor(left / CHUNK_PX) - 1, 0, WORLD_CHUNKS_X - 1);
    const maxCx = clamp(Math.floor(right / CHUNK_PX) + 1, 0, WORLD_CHUNKS_X - 1);
    const minCy = clamp(Math.floor(top / CHUNK_PX) - 1, 0, WORLD_CHUNKS_Y - 1);
    const maxCy = clamp(Math.floor(bottom / CHUNK_PX) + 1, 0, WORLD_CHUNKS_Y - 1);

    // Render chunks (active layer only)
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunkCanvas = getChunkCanvas(activeLayer, cx, cy);
        const x = cx * CHUNK_PX;
        const y = cy * CHUNK_PX;
        ctx.drawImage(chunkCanvas, x, y);
      }
    }

    // Draw entrances
    drawEntrances();

    // Player
    drawPlayer();

    // Optional debug overlay
    if (debug) {
      drawGridOverlay();
      // chunk bounds
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.25)';
      ctx.lineWidth = 2;
      const ch = worldToChunk(player.x, player.y);
      ctx.strokeRect(ch.cx * CHUNK_PX, ch.cy * CHUNK_PX, CHUNK_PX, CHUNK_PX);
    }

    ctx.restore();

    // Cave ambience overlay
    if (activeLayer === 1) {
      ctx.save();
      ctx.resetTransform();
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawVignette(0.65);
      ctx.restore();
    }

    // Transition overlay
    if (transition.running) {
      const alpha = transition.t / transition.dur;
      drawTransitionOverlay(alpha);
    }

    // HUD updates
    const ch = worldToChunk(player.x, player.y);
    elChunk.textContent = `(${ch.cx},${ch.cy})`;
    elPos.textContent = `(${Math.floor(player.x)},${Math.floor(player.y)})`;

    const near = findNearestEntrance(player.x, player.y, 60);
    if (near) {
      elNear.textContent = `Yes — [${near.type.id}] ${near.type.name}`;
      setNote(
        `Press <kbd>E</kbd> to enter/exit. This entrance uses <b>${near.type.id}</b>: ${escapeHtml(near.type.hint)} ` +
        `${debug ? `<span style="color:#a7b3c7">(Entrances every 4 chunks)</span>` : ''}`
      );
    } else {
      elNear.textContent = 'No';
      if (!transition.running) {
        setNote(`Walk to an entrance (they're placed every 4 chunks). Press <kbd>F</kbd> for debug labels.`);
      }
    }
  }

  // ----- Update loop -----
  let last = performance.now();

  function update(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Movement
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const spd = player.speed * (sprint ? 1.55 : 1);
    let vx = 0, vy = 0;
    if (keys.has('KeyW')) vy -= 1;
    if (keys.has('KeyS')) vy += 1;
    if (keys.has('KeyA')) vx -= 1;
    if (keys.has('KeyD')) vx += 1;

    let intentVx = vx, intentVy = vy;

    // If a tunnel transition is running, we 'walk' the player through the entrance and ignore manual input.
    if (transition.running && transition.data && transition.data.mode === 'tunnel') {
      const d = transition.data;
      const e = d.entrance;
      const alpha = clamp(transition.t / transition.dur, 0, 1);

      // Move forward through the entrance
      const dirx = e.dir.dx * d.dirSign;
      const diry = e.dir.dy * d.dirSign;

      // Progress-based travel (feels consistent regardless of fps)
      const dist = (alpha) * d.travel;
      const baseX = d.startX + dirx * dist;
      const baseY = d.startY + diry * dist;

      // Snap slightly toward the entrance centerline to avoid sideways 'portal' feel
      const loc = entranceLocal(e, baseX, baseY);
      const halfW = e.w * 0.5;
      const clampedT = clamp(loc.t, -halfW, halfW);
      const snappedX = e.x + (loc.s * loc.dirx) + (clampedT * loc.perpx);
      const snappedY = e.y + (loc.s * loc.diry) + (clampedT * loc.perpy);

      player.x = lerp(baseX, snappedX, d.snap);
      player.y = lerp(baseY, snappedY, d.snap);

      // Swap layers at midpoint (visual-only fns no longer swap)
      if (alpha >= 0.5 && !d._swapped) {
        swapLayer(d);
        d._swapped = true;
      }

      // No further movement this frame
      intentVx = dirx;
      intentVy = diry;
    } else {
      if (vx !== 0 || vy !== 0) {
        const len = Math.hypot(vx, vy) || 1;
        vx /= len; vy /= len;
        intentVx = vx; intentVy = vy;
        player.x += vx * spd * dt;
        player.y += vy * spd * dt;
      }
    }

    // Bounds
    player.x = clamp(player.x, player.r, WORLD_PX_W - player.r);
    player.y = clamp(player.y, player.r, WORLD_PX_H - player.r);

    // Auto-enter/exit entrances by walking into them
    tryAutoEntrance(now / 1000, intentVx, intentVy);

    // Camera follow
    camera.x = lerp(camera.x, player.x, 1 - Math.pow(0.001, dt));
    camera.y = lerp(camera.y, player.y, 1 - Math.pow(0.001, dt));

    // Transition progress
    if (transition.running) {
      transition.t += dt;
      const alpha = clamp(transition.t / transition.dur, 0, 1);
      transition.fn(alpha, transition.data);
      if (alpha >= 1) {
        // reset slide/zoom
        camera.zoom = 1;
        if (transition.data) transition.data._camSlide = 0;
        finishTransition();
      }
    }

    // Interior offset concept: for the demo, we only change how chunk keys are generated.
    // (A real implementation would maintain separate chunk coords and stream the correct data.)
    // Here we just show the *idea* using different visuals in cave.

    // Prefetch around player in active layer
    prefetchAround(player.x, player.y, activeLayer, 3);

    render();
    requestAnimationFrame(update);
  }

  // Initial UI
  elLayer.textContent = LAYERS[activeLayer].name;
  setNote(`Walk to an entrance (they're placed every 4 chunks). Press <kbd>F</kbd> for debug labels.`);

  // Warm start cache near spawn
  prefetchAround(player.x, player.y, activeLayer, 3);

  requestAnimationFrame(update);
})();  const ENTRANCE_DIRS = [
    {dx:0,dy:1}, {dx:0,dy:-1}, {dx:1,dy:0}, {dx:-1,dy:0}
  ];
