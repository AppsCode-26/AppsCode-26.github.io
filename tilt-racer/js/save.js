// Persistent progress + settings in localStorage.
const KEY = 'tiltracer.save.v1';

const DEFAULTS = {
  coins: 1500,
  selectedCar: 'rally',
  cars: {
    sports: { engine: 0, handling: 0, tires: 0, color: '#c8102e' },
    truck: { engine: 0, handling: 0, tires: 0, color: '#1f4fa0' },
    rally: { engine: 0, handling: 0, tires: 0, color: '#f2f2f2' },
  },
  settings: {
    steerMode: 'tilt',
    sensitivity: 7,
    invertTilt: false,
    tiltOffset: 0,
    autoGas: false,
    assists: true,
    units: 'kmh',
    quality: 'auto',
    volume: 0.8,
    camera: 0,
    difficulty: 'medium',
    laps: 0,
  },
  records: {},
  stats: { distance: 0, races: 0, wins: 0 },
};

function merge(base, over) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over === undefined ? base : over;
  const out = { ...base };
  if (over && typeof over === 'object') {
    for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(DEFAULTS, JSON.parse(raw));
  } catch (e) {
    /* storage unavailable (private mode) */
  }
  return merge(DEFAULTS, {});
}

export const save = load();

export function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch (e) {
    /* ignore */
  }
}

export function resetProgress() {
  const fresh = merge(DEFAULTS, {});
  fresh.settings = { ...save.settings };
  for (const k of Object.keys(save)) delete save[k];
  Object.assign(save, fresh);
  persist();
}
