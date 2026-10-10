// All gameplay tunables live here so the feel can be iterated quickly.
export const CONFIG = {
  // Tower layout
  FLOOR_HEIGHT: 6,
  FLOORS: 12,
  CORE_HALF: 6,
  PATH_WIDTH: 5,
  CORNER_SIZE: 5,
  RISE_PER_SIDE: 3,
  SLAB_THICKNESS: 0.6,

  // Movement
  GRAVITY: 28,
  WALK_SPEED: 6.5,
  SPRINT_SPEED: 9.5,
  JUMP_SPEED: 10.5,
  GROUND_ACCEL: 70,
  AIR_ACCEL: 14,
  SLIPPERY_ACCEL: 4,
  STUN_FRICTION: 5,
  MAX_FALL_SPEED: 50,
  COYOTE_TIME: 0.12,
  JUMP_BUFFER: 0.15,

  CAPSULE_HALF_HEIGHT: 0.5,
  CAPSULE_RADIUS: 0.4,

  // Health
  HP_MAX: 100,
  HP_REGEN_DELAY: 4,
  HP_REGEN_RATE: 10,
  KO_STUN: 2.5,

  // Win condition
  FLAG_HOLD_SECONDS: 3, // 0 = instant win on touch
  FLAG_GRAB_RADIUS: 1.3,
  FLAG_HOLD_RADIUS: 3,
  MATCH_SECONDS: 480,

  // Bots
  BOT_COUNT: 5,

  // Airdrops
  AIRDROP_FIRST: 12,
  AIRDROP_INTERVAL: 30,
  AIRDROP_MAX: 3,

  // Starting trap inventory
  START_TRAPS: { grease: 2, spring: 2, trapdoor: 1, beartrap: 2 },
};

export const TOWER_HEIGHT = CONFIG.FLOOR_HEIGHT * CONFIG.FLOORS;

/** Distance from capsule center to feet. */
export const CHAR_HALF_TOTAL = CONFIG.CAPSULE_HALF_HEIGHT + CONFIG.CAPSULE_RADIUS;

export function floorOf(feetY: number): number {
  return Math.max(0, Math.min(CONFIG.FLOORS, Math.floor((feetY + 0.2) / CONFIG.FLOOR_HEIGHT)));
}
