export function createCanvasSystem(canvasOrId = 'game') {
  // Accept either an element or an element id string.
  let canvas =
    (canvasOrId && typeof canvasOrId === 'object' && canvasOrId.tagName === 'CANVAS')
      ? canvasOrId
      : document.getElementById(String(canvasOrId));

  // Fallbacks: first canvas on page, or create one.
  if (!canvas) canvas = document.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'game';
    document.body.prepend(canvas);
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D context not available (canvas.getContext failed)');

  let dpr = 1;

  function resize() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    // Use setTransform so all drawing uses CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: window.innerWidth, h: window.innerHeight, dpr };
  }

  addEventListener('resize', resize);
  resize();

  return {
    canvas,
    ctx,
    resize,
    get dpr() { return dpr; },
  };
}
