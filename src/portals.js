import {
  TILE, CHUNK_PX,
  LAYER0, LAYER1, LAYER2,
  DIRS, PORTAL, PORTAL_MODE,
} from './config.js';
import { hash32, rand01 } from './rng.js';

// Portal groups stay aligned between layers.
// even-even chunks can spawn portal entrances.
function portalGroupAt(cx, cy) {
  if ((cx & 1) || (cy & 1)) return null;
  const parity = ((cx >> 1) + (cy >> 1)) & 1;
  return parity; // 0 => 0<->1, 1 => 1<->2
}

function pickDir(cx, cy, group) {
  const idx = ((cx * 131) ^ (cy * 197) ^ (group * 911)) & 3;
  return { idx, dir: DIRS[idx] };
}

function portalSharedDef(cx, cy, group) {
  const { idx, dir } = pickDir(cx, cy, group);

  const pad = PORTAL.pad;
  let ex = cx * CHUNK_PX + CHUNK_PX / 2;
  let ey = cy * CHUNK_PX + CHUNK_PX / 2;

  if (dir.name === 'Down')  ey = cy * CHUNK_PX + (CHUNK_PX - pad);
  if (dir.name === 'Up')    ey = cy * CHUNK_PX + pad;
  if (dir.name === 'Right') ex = cx * CHUNK_PX + (CHUNK_PX - pad);
  if (dir.name === 'Left')  ex = cx * CHUNK_PX + pad;

  return {
    idBase: `g${group}:${cx}:${cy}`,
    cx, cy, group,
    x: ex, y: ey,
    dirIdx: idx,
    dir,
    mouthW: PORTAL.mouthW,
    mouthH: PORTAL.mouthH,
    depth:  PORTAL.depth,
  };
}

function flipDirIdx(idx) {
  return (idx + 2) & 3;
}

// Decide portal "mode" for this portal site.
function portalModeForSite(cx, cy, group) {
  const s = hash32(cx, cy, 9001 + group * 101);
  const r = rand01(s);
  return (r < PORTAL_MODE.oneWayChance) ? 'oneway' : 'twoway';
}

// If one-way, choose which side is the source (deterministic).
function oneWaySourceLayer(cx, cy, group) {
  const bit = (hash32(cx, cy, 4242 + group * 9) >>> 0) & 1;
  if (group === 0) return bit ? LAYER0 : LAYER1; // 0<->1
  return bit ? LAYER1 : LAYER2; // 1<->2
}

export function createPortalSystem() {
  function entrancesForChunk(layer, cx, cy) {
    const group = portalGroupAt(cx, cy);
    if (group === null) return [];

    const validPair =
      (group === 0 && (layer === LAYER0 || layer === LAYER1)) ||
      (group === 1 && (layer === LAYER1 || layer === LAYER2));
    if (!validPair) return [];

    const shared = portalSharedDef(cx, cy, group);
    const mode = portalModeForSite(cx, cy, group);

    const a = (group === 0) ? LAYER0 : LAYER1;
    const b = (group === 0) ? LAYER1 : LAYER2;

    if (mode === 'oneway') {
      const src = oneWaySourceLayer(cx, cy, group);
      const dst = (src === a) ? b : a;
      if (layer !== src) return [];

      return [{
        ...shared,
        id: `${shared.idBase}:oneway:${src}->${dst}`,
        mode,
        layer: src,
        toLayer: dst,
        // dir kept as-is
      }];
    }

    // twoway: emit entrance on both layers, with opposite-facing arrow on the far side
    const toLayer = (layer === a) ? b : a;
    const dirIdx = (layer === b) ? flipDirIdx(shared.dirIdx) : shared.dirIdx;
    const dir = DIRS[dirIdx];

    return [{
      ...shared,
      id: `${shared.idBase}:twoway:${layer}<->${toLayer}`,
      mode,
      layer,
      toLayer,
      dirIdx,
      dir,
    }];
  }

  return {
    entrancesForChunk,
  };
}

// Geometry helpers
export function pointInOrientedMouth(px, py, e) {
  const ang = e.dir.ang;
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  const lx = (px - e.x) * cos - (py - e.y) * sin;
  const ly = (px - e.x) * sin + (py - e.y) * cos;
  return (Math.abs(lx) <= e.mouthW / 2) && (Math.abs(ly) <= e.mouthH / 2);
}

export function movingInto(e, mvx, mvy) {
  const mLen = Math.hypot(mvx, mvy);
  if (mLen < 0.01) return false;
  const mx = mvx / mLen, my = mvy / mLen;
  return (mx * e.dir.dx + my * e.dir.dy) > 0.35;
}

export function portalStartRectScreen(e, camX, camY) {
  const sx = e.x - camX;
  const sy = e.y - camY;

  const pw = e.mouthW, ph = e.mouthH;
  const ang = e.dir.ang;
  const c = Math.abs(Math.cos(ang));
  const s = Math.abs(Math.sin(ang));
  const aw = pw * c + ph * s;
  const ah = pw * s + ph * c;

  return { x: sx - aw/2, y: sy - ah/2, w: aw, h: ah, r: 12 };
}
