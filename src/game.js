import {
  WORLD_W, WORLD_H,
  LAYER0,
  PORTAL,
} from './config.js';
import { clamp, easeInOut } from './math.js';
import { createCanvasSystem } from './canvas.js';
import { createInput } from './input.js';
import { createUI } from './ui.js';
import { createPortalSystem, pointInOrientedMouth, movingInto } from './portals.js';
import { createWorld } from './world.js';
import { createRenderer } from './renderer.js';

const canvasSystem = createCanvasSystem('game');
const ctx = canvasSystem.ctx;

const input = createInput();
const ui = createUI();

let debug = false;
input.onKey('f', () => { debug = !debug; });

const portals = createPortalSystem();
const world = createWorld(portals);
const renderer = createRenderer(ctx, world);

// ===== Player & camera =====
const player = { x: WORLD_W / 2, y: WORLD_H / 2, vx: 0, vy: 0, r: 10,
  maxSpeed: 220, sprintMul: 1.45, accel: 1400, friction: 10.5 };
let currentLayer = LAYER0;
ui.setLayerUI(currentLayer);

const cam = { x: player.x, y: player.y, smooth: 0.12 };
function worldClamp() {
  // Prevent chunk index overflow by never allowing x==WORLD_W etc.
  const eps = 0.0001;
  player.x = clamp(player.x, 0, WORLD_W - eps);
  player.y = clamp(player.y, 0, WORLD_H - eps);
}

// ===== Transition =====
let transitioning = false;
const trans = {
  entrance: null,
  srcLayer: null,
  progress: 0,
  duration: PORTAL.transition.duration,
  startX: 0,
  startY: 0,
  cooldown: 0,
};

function tryStartTransition(entrances, mvx, mvy) {
  if (transitioning || trans.cooldown > 0) return;
  for (const e of entrances) {
    if (pointInOrientedMouth(player.x, player.y, e) && movingInto(e, mvx, mvy)) {
      transitioning = true;
      trans.entrance = e;
      trans.srcLayer = currentLayer;
      trans.progress = 0;
      trans.startX = player.x;
      trans.startY = player.y;
      break;
    }
  }
}

// ===== Main loop =====
let last = performance.now();

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // ---- Velocity-based movement ----
  let ix = 0, iy = 0;
  if (input.isDown('w')) iy -= 1;
  if (input.isDown('s')) iy += 1;
  if (input.isDown('a')) ix -= 1;
  if (input.isDown('d')) ix += 1;

  const ilen = Math.hypot(ix, iy) || 1;
  ix /= ilen; iy /= ilen;

  const sprint = input.isDown('shift');
  const maxSpeed = player.maxSpeed * (sprint ? player.sprintMul : 1);

  // Accelerate toward desired velocity
  const targetVx = ix * maxSpeed;
  const targetVy = iy * maxSpeed;

  const accel = player.accel;
  const dvx = targetVx - player.vx;
  const dvy = targetVy - player.vy;
  const dlen = Math.hypot(dvx, dvy);

  if (dlen > 0.0001) {
    const step = Math.min(dlen, accel * dt);
    player.vx += (dvx / dlen) * step;
    player.vy += (dvy / dlen) * step;
  }

  // Friction when no input (or just damping always, cheap & stable)
  const damp = Math.exp(-player.friction * dt);
  if (Math.abs(ix) < 0.001 && Math.abs(iy) < 0.001) {
    player.vx *= damp;
    player.vy *= damp;
  } else {
    // light damping even while moving to keep things stable
    const moveDamp = Math.exp(-player.friction * 0.25 * dt);
    player.vx *= moveDamp;
    player.vy *= moveDamp;
  }

  // Clamp max speed
  const v = Math.hypot(player.vx, player.vy);
  if (v > maxSpeed) {
    player.vx = (player.vx / v) * maxSpeed;
    player.vy = (player.vy / v) * maxSpeed;
  }

  const mvx = player.vx;
  const mvy = player.vy;

  if (trans.cooldown > 0) trans.cooldown = Math.max(0, trans.cooldown - dt);

  // Move every frame, even during portal transition, so the animation feels seamless.
  player.x += mvx * dt;
  player.y += mvy * dt;
  worldClamp();

  if (transitioning) {
    trans.progress += dt / trans.duration;
    if (trans.progress >= 1) {
      const e = trans.entrance;

      // Switch layers without teleporting: you end up where your movement naturally carried you.
      currentLayer = e.toLayer;
      ui.setLayerUI(currentLayer);
      // No positional nudge on exit: keep x/y exactly to avoid snapping.

      transitioning = false;
      trans.entrance = null;
      trans.srcLayer = null;
      trans.cooldown = PORTAL.transition.cooldown;
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

  renderer.clear(currentLayer, w, h);
  renderer.renderChunks(currentLayer, now, camX, camY, null, debug);

  const entrances = world.getNearbyEntrances(currentLayer, player.x, player.y, now);

  // For portal previews/transition, use the SAME camera as the main render to avoid end-of-animation snapping.
  const portalCamX = camX;
  const portalCamY = camY;

  for (const e of entrances) {
    renderer.drawPortalPreview(e, now, camX, camY, portalCamX, portalCamY);
    renderer.drawArrow(e, camX, camY);
  }

  if (transitioning && trans.entrance) {
    renderer.drawTransition(trans.entrance, now, camX, camY, portalCamX, portalCamY, trans.progress, easeInOut);
  }

  // player
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

  ui.setEntranceInfo(transitioning ? 'Transitioning…' : `Portals: ${entrances.length}`);

  if (!transitioning) tryStartTransition(entrances, mvx, mvy);

  if (debug) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '12px ui-sans-serif,system-ui';
    ctx.fillText(`Layer=${currentLayer} pos=(${player.x.toFixed(1)},${player.y.toFixed(1)}) cache=${world.cacheSize}`, 14, h - 14);
    ctx.restore();
  }
}

requestAnimationFrame(tick);
