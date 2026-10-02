// Car catalogue, upgrade system and derived physics specs.
import { Vehicle, SURF } from './physics.js';
import { clamp } from './util.js';

export const CAR_ORDER = ['sports', 'truck', 'rally'];

export const CAR_DEFS = {
  sports: {
    id: 'sports',
    name: 'Vortex GT',
    klass: 'Sports Car',
    desc: 'Rear-wheel-drive supercar. Untouchable on tarmac, but it gets loose and twitchy on dirt.',
    drive: 'RWD',
    frontDrive: 0,
    mass: 1380,
    length: 4.45,
    width: 1.95,
    wheelbase: 2.6,
    frontWeight: 0.46,
    cgHeight: 0.46,
    track: 1.66,
    wheelRadius: 0.34,
    maxTorque: 470,
    idleRpm: 950,
    redline: 8000,
    launchRpm: 3800,
    curve: [[0, 0.55], [0.25, 0.78], [0.5, 0.95], [0.7, 1.0], [0.88, 0.96], [1.0, 0.84]],
    gears: [3.1, 2.15, 1.62, 1.28, 1.04, 0.86],
    finalDrive: 3.55,
    reverseRatio: 3.0,
    CdA: 0.74,
    maxSteer: 0.58,
    steerSpeed: 3.2,
    steerFalloff: 14,
    grip: { asphalt: 1.15, dirt: 0.68, grass: 0.58, sand: 0.5 },
    tireB: 11,
    tireC: 1.45,
    offroad: 1.7,
    brakeG: 1.15,
    susFreq: 1.9,
    susZeta: 0.55,
    susTravel: 0.1,
    susComp: 0.11,
    shiftTime: 0.18,
    engineBrake: 70,
    handbrakeGrip: 0.4,
    yawDamp: 0.5,
    sound: { cyl: 8, base: 0.9, rough: 0.25, filter: 1.2 },
    color: '#c8102e',
  },
  truck: {
    id: 'truck',
    name: 'Ironhorse 4x4',
    klass: 'Off-road Truck',
    desc: 'Heavy four-wheel-drive pickup on big tyres. Slow off the line, but bumps, grass and sand barely slow it down.',
    drive: '4WD',
    frontDrive: 0.42,
    mass: 2350,
    length: 5.4,
    width: 2.12,
    wheelbase: 3.3,
    frontWeight: 0.55,
    cgHeight: 0.92,
    track: 1.82,
    wheelRadius: 0.47,
    maxTorque: 500,
    idleRpm: 700,
    redline: 5800,
    launchRpm: 2500,
    curve: [[0, 0.72], [0.25, 0.93], [0.45, 1.0], [0.65, 0.93], [0.85, 0.78], [1, 0.66]],
    gears: [3.6, 2.3, 1.55, 1.18, 0.92, 0.76],
    finalDrive: 3.9,
    reverseRatio: 3.4,
    CdA: 1.55,
    maxSteer: 0.6,
    steerSpeed: 2.4,
    steerFalloff: 12.5,
    grip: { asphalt: 0.95, dirt: 0.86, grass: 0.82, sand: 0.78 },
    tireB: 8,
    tireC: 1.5,
    offroad: 0.5,
    brakeG: 0.95,
    susFreq: 1.3,
    susZeta: 0.45,
    susTravel: 0.22,
    susComp: 0.22,
    shiftTime: 0.28,
    engineBrake: 110,
    handbrakeGrip: 0.45,
    yawDamp: 0.6,
    sound: { cyl: 8, base: 0.6, rough: 0.45, filter: 0.8 },
    color: '#1f4fa0',
  },
  rally: {
    id: 'rally',
    name: 'Strada R4',
    klass: 'Rally Car',
    desc: 'Lightweight all-wheel-drive rally weapon with short gearing. King of the dirt and quick everywhere.',
    drive: 'AWD',
    frontDrive: 0.45,
    mass: 1230,
    length: 4.1,
    width: 1.85,
    wheelbase: 2.52,
    frontWeight: 0.56,
    cgHeight: 0.5,
    track: 1.58,
    wheelRadius: 0.33,
    maxTorque: 345,
    idleRpm: 1000,
    redline: 7600,
    launchRpm: 4300,
    curve: [[0, 0.5], [0.3, 0.86], [0.45, 1.0], [0.75, 1.0], [0.9, 0.92], [1, 0.8]],
    gears: [3.3, 2.25, 1.72, 1.38, 1.12, 0.94],
    finalDrive: 4.2,
    reverseRatio: 3.2,
    CdA: 0.74,
    maxSteer: 0.62,
    steerSpeed: 3.6,
    steerFalloff: 15,
    grip: { asphalt: 1.04, dirt: 0.97, grass: 0.85, sand: 0.74 },
    tireB: 9.5,
    tireC: 1.4,
    offroad: 0.8,
    brakeG: 1.1,
    susFreq: 1.6,
    susZeta: 0.5,
    susTravel: 0.16,
    susComp: 0.17,
    shiftTime: 0.14,
    engineBrake: 60,
    handbrakeGrip: 0.35,
    yawDamp: 0.5,
    sound: { cyl: 4, base: 1.15, rough: 0.35, filter: 1.4 },
    color: '#f2f2f2',
  },
};

export const UPGRADE_KEYS = ['engine', 'handling', 'tires'];
export const UPGRADES = {
  engine: { name: 'Engine', desc: 'More power, quicker acceleration and a higher top speed.' },
  handling: { name: 'Handling', desc: 'Faster steering, stiffer suspension and a lower centre of gravity.' },
  tires: { name: 'Tyres', desc: 'More grip on every surface and shorter braking distances.' },
};
export const UPGRADE_MAX = 5;
export const UPGRADE_COSTS = [400, 750, 1200, 1800, 2600];

export function upgradeCost(level) {
  return level >= UPGRADE_MAX ? Infinity : UPGRADE_COSTS[level];
}

// Build the numbers the physics engine needs from a car + its upgrade levels.
export function computeSpec(def, upg = { engine: 0, handling: 0, tires: 0 }) {
  const e = upg.engine || 0;
  const h = upg.handling || 0;
  const t = upg.tires || 0;
  const L = def.wheelbase;
  const b = def.frontWeight * L; // CG to rear axle
  const a = L - b; // CG to front axle
  const gripMul = 1 + 0.04 * t;
  const grip = {};
  for (const k of Object.keys(def.grip)) grip[k] = def.grip[k] * gripMul;
  const spec = {
    id: def.id,
    name: def.name,
    mass: def.mass,
    length: def.length,
    width: def.width,
    L,
    a,
    b,
    h: def.cgHeight * (1 - 0.06 * h),
    track: def.track,
    rw: def.wheelRadius,
    frontDrive: def.frontDrive,
    maxTorque: def.maxTorque * (1 + 0.085 * e),
    idleRpm: def.idleRpm,
    redline: def.redline * (1 + 0.012 * e),
    launchRpm: def.launchRpm,
    curve: def.curve,
    gears: def.gears,
    finalDrive: def.finalDrive / (1 + 0.035 * e),
    reverseRatio: def.reverseRatio,
    eff: 0.86,
    CdA: def.CdA,
    maxSteer: def.maxSteer * (1 + 0.035 * h),
    steerSpeed: def.steerSpeed * (1 + 0.09 * h),
    steerFalloff: def.steerFalloff * (1 + 0.04 * h),
    grip,
    tireB: def.tireB * (1 + 0.04 * h),
    tireC: def.tireC,
    offroad: def.offroad * (1 - 0.05 * t),
    brakeG: def.brakeG * (1 + 0.05 * t),
    susOmega: Math.PI * 2 * def.susFreq * (1 + 0.05 * h),
    susZeta: def.susZeta,
    susTravel: def.susTravel,
    susComp: def.susComp,
    shiftTime: def.shiftTime,
    engineBrake: def.engineBrake,
    handbrakeGrip: def.handbrakeGrip,
    yawDamp: def.yawDamp + 0.12 * h,
    minSlipSpeed: 2.0,
    Iz: (def.mass * ((L * 1.65) ** 2 + def.width ** 2)) / 12,
    sound: def.sound,
  };
  return spec;
}

// Measure acceleration and top speed by actually running the physics on a
// flat test strip. Cached because the garage asks for it a lot.
const statCache = new Map();
export function measurePerformance(spec) {
  const key = `${spec.id}|${spec.maxTorque.toFixed(1)}|${spec.finalDrive.toFixed(3)}|${spec.grip.asphalt.toFixed(3)}`;
  if (statCache.has(key)) return statCache.get(key);
  const flat = { heightAt: () => 0, surfaceAt: () => SURF.ASPHALT };
  const car = new Vehicle(spec);
  car.controls.throttle = 1;
  const dt = 1 / 120;
  let t = 0;
  let t100 = 0;
  let top = 0;
  let still = 0;
  while (t < 90) {
    car.step(dt, flat, true);
    t += dt;
    if (!t100 && car.speed >= 100 / 3.6) t100 = t;
    if (car.speed > top + 0.01) {
      top = car.speed;
      still = 0;
    } else still += dt;
    if (still > 4 && t100) break;
  }
  const res = { zeroTo100: t100 || 99, topSpeed: top };
  statCache.set(key, res);
  return res;
}

// 0..10 ratings for the garage bars.
export function ratings(def, upg) {
  const spec = computeSpec(def, upg);
  const perf = measurePerformance(spec);
  const kmh = perf.topSpeed * 3.6;
  const speed = clamp(((kmh - 150) / 190) * 10, 0.5, 10);
  const accel = clamp(((9 - perf.zeroTo100) / 6) * 10, 0.5, 10);
  const handling = clamp(
    (spec.grip.asphalt - 0.8) * 9 + (spec.steerSpeed - 2) * 1.4 + (1 - spec.h) * 4 - (spec.mass - 1200) / 500 + 1.2,
    0.5,
    10
  );
  const offroad = clamp((((spec.grip.dirt + spec.grip.grass) * 0.5 - 0.5) * 16) + (1.7 - spec.offroad) * 3.4, 0.5, 10);
  return { speed, accel, handling, offroad, perf, spec };
}
