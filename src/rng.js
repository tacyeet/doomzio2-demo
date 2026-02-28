// Deterministic helpers (ported from your original build)
export function hash32(x, y, salt) {
  let h = 2166136261 >>> 0;
  h ^= (x * 374761393) >>> 0; h = Math.imul(h, 16777619) >>> 0;
  h ^= (y * 668265263) >>> 0; h = Math.imul(h, 16777619) >>> 0;
  h ^= (salt * 2246822519) >>> 0; h = Math.imul(h, 16777619) >>> 0;
  h ^= 0x9e3779b9; h = Math.imul(h, 16777619) >>> 0;
  return h >>> 0;
}

export function rand01(seed) {
  let x = seed >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17; x >>>= 0;
  x ^= x << 5;  x >>>= 0;
  return (x >>> 0) / 4294967296;
}

export function noise(wx, wy, layer) {
  const a = rand01(hash32(wx, wy, layer));
  const b = rand01(hash32(wx + 17, wy - 9, layer));
  return (a * 0.7 + b * 0.3);
}
