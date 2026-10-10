// Plausibility checks on what clients report. Movement is simulated on the clients, so a
// modified client could teleport or fly; with prizes on the line the server refuses to
// relay impossible movement, only lets someone grab the flag after it has watched them
// climb there, and won't credit a win to anyone who keeps tripping the checks.
//
// The limits are generous (no honest player should ever trip them): the hardest knockback
// in the game launches you at ~26 m/s sideways, springs at 17 m/s straight up, and the
// fastest sustained climb (stairs at a sprint) is ~3.6 m/s.

const MAX_H_SPEED = 34; // m/s (a railgun knockout launches you at ~26)
const MAX_UP_BURST = 13; // m/s over the first second (springs, trampoline nets)
const MAX_UP_SUSTAINED = 4; // m/s beyond that
const SLACK = 3; // m, for jitter and interpolation
const MIN_WINDOW = 0.4; // s: compare against a sample at least this old
const CONTINUOUS = 1.5; // s: a longer silence breaks the chain of verified climbing
const FLOOR_H = 6;
const ROOF = 12;
const FLAG = { x: 0, y: ROOF * FLOOR_H, z: 0 };
export const STRIKES_TO_FLAG = 8;

const floorOf = (y) => Math.max(0, Math.min(ROOF, Math.floor((y + 0.2) / FLOOR_H)));
/** Respawns put you back in the start area (each map's spawnPoints, with a margin). */
const SPAWN_AREAS = {
  tower: { x0: -30.5, x1: -15, z0: -7.5, z1: 7.5 },
  construction: { x0: -30.5, x1: -15, z0: -7.5, z1: 7.5 },
  hotel: { x0: -30.5, x1: -15, z0: -7.5, z1: 7.5 },
  olympus: { x0: -48, x1: -31.5, z0: -48, z1: -35 },
};

function upLimit(dt) {
  return dt <= 1 ? MAX_UP_BURST * dt + SLACK : MAX_UP_BURST + MAX_UP_SUSTAINED * (dt - 1) + SLACK;
}

export class Guard {
  constructor(map = 'tower') {
    const a = SPAWN_AREAS[map] ?? SPAWN_AREAS.tower;
    this.inSpawnArea = (x, y, z) => y < 0.6 && x > a.x0 && x < a.x1 && z > a.z0 && z < a.z1;
    this.track = new Map(); // netId -> { hist: [{ t, x, y, z }], verified: floor }
    this.strikes = new Map(); // client id -> count
  }

  /** Is this reported position possible given where the fighter was? */
  move(netId, x, y, z, t) {
    if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 400 || Math.abs(z) > 400 || y < -200 || y > 120) return false;
    let tr = this.track.get(netId);
    if (!tr) {
      // First sighting (round start or drop-in): you start at the bottom.
      tr = { hist: [], verified: 0 };
      this.track.set(netId, tr);
    }
    const hist = tr.hist;
    const prev = hist[hist.length - 1];
    if (this.inSpawnArea(x, y, z)) {
      tr.verified = 0;
    } else if (prev) {
      // Compare with the newest sample that's old enough to measure speed over.
      let ref = prev;
      for (let i = hist.length - 1; i >= 0; i--) {
        if ((t - hist[i].t) / 1000 >= MIN_WINDOW) {
          ref = hist[i];
          break;
        }
      }
      const dt = Math.max(MIN_WINDOW, (t - ref.t) / 1000);
      if (Math.hypot(x - ref.x, z - ref.z) > MAX_H_SPEED * dt + SLACK || y - ref.y > upLimit(dt)) {
        this.why = `${netId} moved (${ref.x.toFixed(1)},${ref.y.toFixed(1)},${ref.z.toFixed(1)}) -> (${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) in ${dt.toFixed(2)}s`;
        return false;
      }
      // Height only counts if we watched you get there: one floor at a time, no silences.
      const f = floorOf(y);
      const continuous = (t - prev.t) / 1000 <= CONTINUOUS;
      // Back from a silence more than a floor above where we last saw you climb: no.
      if (!continuous && f > tr.verified + 1) {
        this.why = `${netId} back after ${((t - prev.t) / 1000).toFixed(1)}s silence on floor ${f} (verified ${tr.verified})`;
        return false;
      }
      if (!continuous) tr.verified = Math.min(tr.verified, f);
      else if (f <= tr.verified + 1) tr.verified = f;
    }
    hist.push({ t, x, y, z });
    if (hist.length > 120) hist.splice(0, hist.length - 120);
    return true;
  }

  last(netId) {
    const h = this.track.get(netId)?.hist;
    return h && h.length ? h[h.length - 1] : null;
  }

  /** Can this fighter be grabbing the flag: by the pole, having actually climbed to the roof? */
  atFlag(netId) {
    const tr = this.track.get(netId);
    const p = this.last(netId);
    if (!tr || !p || tr.verified < ROOF) return false;
    return Math.hypot(p.x - FLAG.x, p.z - FLAG.z) < 2.5 && p.y > FLAG.y - 1 && p.y < FLAG.y + 2.5;
  }

  /** Could `a` plausibly hit `b` (within the longest weapon's reach)? */
  inReach(a, b) {
    const pa = this.last(a);
    const pb = this.last(b);
    if (!pa || !pb) return true;
    return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) < 36;
  }

  strike(clientId) {
    const n = (this.strikes.get(clientId) ?? 0) + 1;
    this.strikes.set(clientId, n);
    return n;
  }

  flagged(clientId) {
    return (this.strikes.get(clientId) ?? 0) >= STRIKES_TO_FLAG;
  }
}
