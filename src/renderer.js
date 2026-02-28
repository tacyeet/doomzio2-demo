import { LAYER0, LAYER1, PORTAL, WORLD_CHUNKS_W, WORLD_CHUNKS_H } from './config.js';
import { roundRectSubPath, clamp } from './math.js';
import { portalStartRectScreen } from './portals.js';

export function createRenderer(ctx, world) {
  function clear(layer, w, h) {
    ctx.fillStyle = (layer === LAYER0) ? '#0b2417' : (layer === LAYER1 ? '#070912' : '#0b0509');
    ctx.fillRect(0, 0, w, h);
  }

  function renderChunks(layer, now, camX, camY, rect /* screen rect or null */, wantDebug) {
    const w = innerWidth, h = innerHeight;

    let minCX, maxCX, minCY, maxCY;
    if (rect) {
      ({ minCX, maxCX, minCY, maxCY } = world.chunkRangeForRect(camX, camY, rect));
    } else {
      // full screen + safety margin of one chunk
      const CHUNK_PX = (world.getChunk(layer, 0, 0, now).img.width);
      minCX = Math.max(0, Math.floor((camX - CHUNK_PX) / CHUNK_PX));
      maxCX = Math.min(WORLD_CHUNKS_W - 1, Math.floor((camX + w + CHUNK_PX) / CHUNK_PX));
      minCY = Math.max(0, Math.floor((camY - CHUNK_PX) / CHUNK_PX));
      maxCY = Math.min(WORLD_CHUNKS_H - 1, Math.floor((camY + h + CHUNK_PX) / CHUNK_PX));
    }

    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const ch = world.getChunk(layer, cx, cy, now);
        const ox = cx * ch.img.width - camX;
        const oy = cy * ch.img.height - camY;
        ctx.drawImage(ch.img, ox, oy);

        if (wantDebug) {
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(ox, oy, ch.img.width, ch.img.height);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = '#fff';
          ctx.font = '12px ui-sans-serif,system-ui';
          ctx.fillText(`${cx},${cy}`, ox + 6, oy + 14);
          ctx.restore();
        }
      }
    }
  }

  function drawPortalPreview(e, now, camX, camY, portalCamX, portalCamY) {
    const sx = e.x - camX;
    const sy = e.y - camY;
    const aabb = portalStartRectScreen(e, camX, camY);

    ctx.save();
    // clip to rotated mouth
    ctx.translate(sx, sy);
    ctx.rotate(e.dir.ang);
    ctx.beginPath();
    roundRectSubPath(ctx, -e.mouthW/2, -e.mouthH/2, e.mouthW, e.mouthH, 12);
    ctx.clip();

    // back to screen coords (clip remains active)
    ctx.rotate(-e.dir.ang);
    ctx.translate(-sx, -sy);

    ctx.globalAlpha = PORTAL.previewAlpha;
    // Only draw chunks that overlap the portal's screen AABB.
    renderChunks(e.toLayer, now, portalCamX, portalCamY, aabb, false);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawArrow(e, camX, camY) {
    const sx = e.x - camX;
    const sy = e.y - camY;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(e.dir.ang);

    const arrowDist = e.mouthH / 2 + 22;
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
  }

  // Cheapest feather: draw a few expanding rounded-rect "rings" with low alpha.
  function featherRectEdge(rect, steps = 6, maxGrow = 18, alpha = 0.18) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const grow = t * maxGrow;
      ctx.globalAlpha = alpha * (1 - t);

      ctx.beginPath();
      roundRectSubPath(ctx, rect.x - grow, rect.y - grow, rect.w + grow*2, rect.h + grow*2, (rect.r || 0) + grow*0.25);
      roundRectSubPath(ctx, rect.x,       rect.y,       rect.w,           rect.h,           rect.r || 0);
      ctx.fill('evenodd');
    }
    ctx.restore();
  }

  function drawTransition(e, now, camX, camY, portalCamX, portalCamY, progress, easeFn) {
    const w = innerWidth, h = innerHeight;
    const p = clamp(progress, 0, 1);
    const t = easeFn(p);

    const start = portalStartRectScreen(e, camX, camY);
    const end = { x: 0, y: 0, w, h, r: 0 };
    const rect = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      w: start.w + (end.w - start.w) * t,
      h: start.h + (end.h - start.h) * t,
      r: (start.r || 0) + ((end.r || 0) - (start.r || 0)) * t,
    };

    ctx.save();
    ctx.beginPath();
    roundRectSubPath(ctx, rect.x, rect.y, rect.w, rect.h, rect.r);
    ctx.clip();
    renderChunks(e.toLayer, now, portalCamX, portalCamY, rect, false);
    ctx.restore();

    featherRectEdge(rect, 6, 18, 0.18);
  }

  return {
    clear,
    renderChunks,
    drawPortalPreview,
    drawArrow,
    drawTransition,
  };
}
