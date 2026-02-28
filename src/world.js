import {
  TILE, CHUNK_TILES, CHUNK_PX,
  WORLD_CHUNKS_W, WORLD_CHUNKS_H,
  WORLD_W, WORLD_H,
  LAYER0, LAYER1, LAYER2,
  CHUNK_CACHE_MAX,
} from './config.js';
import { clamp } from './math.js';
import { hash32, rand01 } from './rng.js';

/**
 * World generation (v0.5.0)
 * - Large biome regions (Voronoi in world-pixel space)
 * - Multiple materials per layer (surface/caves/deep)
 * - Chunk-seamless borders and subtle height modulation
 * - Border outline is intentionally 1px wider than before
 */

// --- Tuning knobs ---
const VORONOI_SEEDS = 16;       // fewer seeds => larger biome regions (>= ~3 chunks on avg)
const NOISE_CELL_PX = 160;      // low-frequency height modulation
const HEIGHT_STRENGTH = 0.030;  // subtle variation (tile-art vibe)

// Outline + dark bands (pixel-art border feel)
const C_OUTLINE = [63, 63, 63];
const BAND1_MUL = 0.74; // strong near-edge dark
const BAND2_MUL = 0.87; // softer outer edge dark

// Palettes: each entry is an RGB base "material" color.
// More than 3 biomes, per-layer.
const PALETTES = {
  [LAYER0]: [ // Surface
    [ 94, 119,  19], // grass
    [191, 139,  50], // sand
    [191, 191, 191], // snow
    [ 74, 104,  62], // forest/moss
    [134,  92,  58], // dirt
  ],
  [LAYER1]: [ // Caves
    [110,  84,  45], // dirt
    [120, 120, 120], // rock
    [ 70, 110,  70], // moss
    [ 86,  86,  96], // slate
    [ 58,  72,  82], // damp stone
  ],
  [LAYER2]: [ // Deep
    [ 70,  70,  75], // basalt
    [ 95,  80,  55], // deep dirt
    [120,  70, 140], // crystal-ish
    [ 52,  48,  58], // dark shale
    [ 84,  52,  62], // iron/clay
  ],
};

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

function valueNoise01(wx, wy, salt) {
  // Value noise on a NOISE_CELL_PX grid with smooth interpolation; output [0..1]
  const gx = Math.floor(wx / NOISE_CELL_PX);
  const gy = Math.floor(wy / NOISE_CELL_PX);
  const fx = (wx - gx * NOISE_CELL_PX) / NOISE_CELL_PX;
  const fy = (wy - gy * NOISE_CELL_PX) / NOISE_CELL_PX;

  const sx = smoothstep(fx);
  const sy = smoothstep(fy);

  const v00 = rand01(hash32(gx,     gy,     salt));
  const v10 = rand01(hash32(gx + 1, gy,     salt));
  const v01 = rand01(hash32(gx,     gy + 1, salt));
  const v11 = rand01(hash32(gx + 1, gy + 1, salt));

  const vx0 = lerp(v00, v10, sx);
  const vx1 = lerp(v01, v11, sx);
  return lerp(vx0, vx1, sy);
}

function makeSeedsForLayer(layer) {
  // Deterministic world-space Voronoi seeds per layer (stable, seamless across chunks).
  const seeds = new Array(VORONOI_SEEDS);
  const salt = 9001 + layer * 97;
  for (let i = 0; i < VORONOI_SEEDS; i++) {
    const sx = rand01(hash32(i, 0, salt)) * (WORLD_W - 1);
    const sy = rand01(hash32(i, 1, salt)) * (WORLD_H - 1);
    seeds[i] = { x: sx, y: sy };
  }
  return seeds;
}

function regionIdAt(seeds, wx, wy) {
  let best = 1e30;
  let bestId = 0;
  for (let i = 0; i < seeds.length; i++) {
    const dx = wx - seeds[i].x;
    const dy = wy - seeds[i].y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bestId = i; }
  }
  return bestId;
}

function baseColorForRegion(layer, regionId) {
  const pal = PALETTES[layer] || PALETTES[LAYER0];
  return pal[regionId % pal.length];
}

function dilate8(mask, w, h) {
  // mask: Uint8Array of 0/1
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      let v = 0;
      for (let yy = y0; yy <= y1 && !v; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          if (mask[row + xx]) { v = 1; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export function createWorld(portalSystem) {
  const chunkCache = new Map(); // key -> { img, entrances: [] }
  const chunkUse = new Map();
  const chunkKey = (layer, cx, cy) => `${layer}:${cx}:${cy}`;

  const seedsByLayer = [
    makeSeedsForLayer(LAYER0),
    makeSeedsForLayer(LAYER1),
    makeSeedsForLayer(LAYER2),
  ];

  function genChunk(layer, cx, cy) {
    const off = document.createElement('canvas');
    off.width = CHUNK_PX;
    off.height = CHUNK_PX;
    const g = off.getContext('2d', { alpha: false });

    // Render via ImageData for crisp borders.
    const img = g.createImageData(CHUNK_PX, CHUNK_PX);
    const data = img.data;

    const seeds = seedsByLayer[layer] || seedsByLayer[0];

    // We do border dilation up to 3 px (outline wider + 2 dark bands).
    const PAD = 3;
    const PW = CHUNK_PX + PAD * 2;
    const PH = CHUNK_PX + PAD * 2;

    const region = new Uint8Array(PW * PH);

    // Region IDs in world-pixel space (clamped at world bounds).
    for (let py = 0; py < PH; py++) {
      const wy = cy * CHUNK_PX + (py - PAD);
      const clampedWy = clamp(wy, 0, WORLD_H - 1);
      const row = py * PW;
      for (let px = 0; px < PW; px++) {
        const wx = cx * CHUNK_PX + (px - PAD);
        const clampedWx = clamp(wx, 0, WORLD_W - 1);
        region[row + px] = regionIdAt(seeds, clampedWx, clampedWy);
      }
    }

    // Edge pixels (4-neighbor differences: right/down)
    const edge = new Uint8Array(PW * PH);
    for (let py = 0; py < PH; py++) {
      const row = py * PW;
      for (let px = 0; px < PW; px++) {
        const id = region[row + px];
        let e = 0;
        if (px + 1 < PW && region[row + (px + 1)] !== id) e = 1;
        if (py + 1 < PH && region[(py + 1) * PW + px] !== id) e = 1;
        edge[row + px] = e;
      }
    }

    // Make outline 1px wider than the previous look:
    // outline = dilate1(edge) (so it includes edge + neighbors => thicker stroke)
    const d1 = dilate8(edge, PW, PH);         // outline (wider)
    const d2 = dilate8(d1, PW, PH);           // outline + band1
    const d3 = dilate8(d2, PW, PH);           // outline + band1 + band2

    const outline = d1;
    const band1 = new Uint8Array(PW * PH);
    const band2 = new Uint8Array(PW * PH);

    for (let i = 0; i < band1.length; i++) band1[i] = (d2[i] && !d1[i]) ? 1 : 0;
    for (let i = 0; i < band2.length; i++) band2[i] = (d3[i] && !d2[i]) ? 1 : 0;

    // Base fill with subtle height modulation.
    const heightSalt = 7777 + layer * 131;

    for (let y = 0; y < CHUNK_PX; y++) {
      const wy = cy * CHUNK_PX + y;
      const rowImg = y * CHUNK_PX;
      const rowP = (y + PAD) * PW;

      for (let x = 0; x < CHUNK_PX; x++) {
        const wx = cx * CHUNK_PX + x;

        const pid = region[rowP + (x + PAD)];
        const base = baseColorForRegion(layer, pid);

        let r = base[0], gg = base[1], b = base[2];

        // Height modulation only affects the base.
        const h = valueNoise01(wx, wy, heightSalt) - 0.5; // [-0.5..+0.5]
        const mul = 1 + h * HEIGHT_STRENGTH;
        r = Math.max(0, Math.min(255, Math.round(r * mul)));
        gg = Math.max(0, Math.min(255, Math.round(gg * mul)));
        b = Math.max(0, Math.min(255, Math.round(b * mul)));

        const idxP = rowP + (x + PAD);

        if (band2[idxP]) {
          r = Math.round(r * BAND2_MUL);
          gg = Math.round(gg * BAND2_MUL);
          b = Math.round(b * BAND2_MUL);
        }
        if (band1[idxP]) {
          r = Math.round(r * BAND1_MUL);
          gg = Math.round(gg * BAND1_MUL);
          b = Math.round(b * BAND1_MUL);
        }
        if (outline[idxP]) {
          r = C_OUTLINE[0];
          gg = C_OUTLINE[1];
          b = C_OUTLINE[2];
        }

        const di = (rowImg + x) * 4;
        data[di + 0] = r;
        data[di + 1] = gg;
        data[di + 2] = b;
        data[di + 3] = 255;
      }
    }

    g.putImageData(img, 0, 0);

    // Portals are generated deterministically per chunk.
    const entrances = portalSystem.entrancesForChunk(layer, cx, cy);
    return { img: off, entrances };
  }

  function getChunk(layer, cx, cy, now) {
    const key = chunkKey(layer, cx, cy);
    const hit = chunkCache.get(key);
    if (hit) { chunkUse.set(key, now); return hit; }

    const ch = genChunk(layer, cx, cy);
    chunkCache.set(key, ch);
    chunkUse.set(key, now);

    if (chunkCache.size > CHUNK_CACHE_MAX) {
      let oldestKey = null, oldestT = Infinity;
      for (const [k, last] of chunkUse.entries()) {
        if (last < oldestT) { oldestT = last; oldestKey = k; }
      }
      if (oldestKey) { chunkCache.delete(oldestKey); chunkUse.delete(oldestKey); }
    }
    return ch;
  }

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

  function getNearbyEntrances(layer, px, py, now) {
    const cx = Math.floor(px / CHUNK_PX);
    const cy = Math.floor(py / CHUNK_PX);
    const out = [];
    for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) {
      const nx = cx + ox, ny = cy + oy;
      if (nx < 0 || ny < 0 || nx >= WORLD_CHUNKS_W || ny >= WORLD_CHUNKS_H) continue;
      const ch = getChunk(layer, nx, ny, now);
      for (const e of ch.entrances) out.push(e);
    }
    return out;
  }

  return {
    getChunk,
    chunkRangeForRect,
    getNearbyEntrances,
    get cacheSize() { return chunkCache.size; },
  };
}
