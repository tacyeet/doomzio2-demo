export function createInput() {
  const keys = new Set();
  const keyHandlers = new Map();

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    const fn = keyHandlers.get(k);
    if (fn) fn(e);
  });

  addEventListener('keyup', (e) => {
    keys.delete(e.key.toLowerCase());
  });

  return {
    isDown: (key) => keys.has(key.toLowerCase()),
    onKey: (key, cb) => keyHandlers.set(key.toLowerCase(), cb),
  };
}
