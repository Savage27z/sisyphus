// Small persistent stores for player settings and lifetime records (this device only).

export interface Settings {
  music: boolean;
  /** 0..1 */
  volume: number;
  /** Multiplier on mouse look speed. */
  sensitivity: number;
  invertY: boolean;
}

export interface Records {
  played: number;
  wins: number;
  bestFloor: number;
  biggestFall: number;
  floorsSent: number;
  timesKnocked: number;
  fastestWin: number | null;
}

const SETTINGS_KEY = 'sisyphus.settings.v1';
const RECORDS_KEY = 'sisyphus.records.v1';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    /* storage unavailable */
  }
  return { ...fallback };
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function loadSettings(): Settings {
  return load<Settings>(SETTINGS_KEY, { music: true, volume: 0.8, sensitivity: 1, invertY: false });
}

export function saveSettings(s: Settings): void {
  save(SETTINGS_KEY, s);
}

export function loadRecords(): Records {
  return load<Records>(RECORDS_KEY, { played: 0, wins: 0, bestFloor: 0, biggestFall: 0, floorsSent: 0, timesKnocked: 0, fastestWin: null });
}

export function saveRecords(r: Records): void {
  save(RECORDS_KEY, r);
}
