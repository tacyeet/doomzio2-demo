export const VERSION = "0.5.0";

export const TILE = 24;

// Smaller chunks to avoid loading huge areas for portal previews.
export const CHUNK_TILES = 8;
export const CHUNK_PX = TILE * CHUNK_TILES;

export const WORLD_CHUNKS_W = 12;
export const WORLD_CHUNKS_H = 12;
export const WORLD_W = WORLD_CHUNKS_W * CHUNK_PX;
export const WORLD_H = WORLD_CHUNKS_H * CHUNK_PX;

export const LAYER0 = 0;
export const LAYER1 = 1;
export const LAYER2 = 2;
export const LAYER_NAMES = ['Surface', 'Cave', 'Deep'];

// local +Y is "into entrance"
export const DIRS = [
  { name: 'Down',  dx: 0,  dy:  1, ang: 0 },
  { name: 'Right', dx: 1,  dy:  0, ang: -Math.PI / 2 },
  { name: 'Up',    dx: 0,  dy: -1, ang: Math.PI },
  { name: 'Left',  dx: -1, dy:  0, ang: Math.PI / 2 },
];

export const CHUNK_CACHE_MAX = 520; // more chunks since they're smaller now

// Portal tuning
export const PORTAL = {
  mouthW: TILE * 3.4,
  mouthH: TILE * 1.9,
  depth:  TILE * 3.2,
  pad:    TILE * 1.35,
  previewAlpha: 0.78,
  transition: {
    duration: 0.28,
    cooldown: 0.22,
  },
};

// One-way vs two-way split
export const PORTAL_MODE = {
  // portion of portals that become one-way
  oneWayChance: 0.45,
};
