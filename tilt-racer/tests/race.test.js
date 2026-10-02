// Headless AI race on every track: checks AI can complete races with the
// real physics, terrain and barriers. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS } from '../js/trackData.js';
import { RaceCore } from '../js/raceCore.js';
import { Vehicle, collideVehicles } from '../js/physics.js';
import { CAR_DEFS, computeSpec } from '../js/cars.js';
import { AIDriver } from '../js/ai.js';
import { formatTime } from '../js/util.js';

for (const def of TRACKS) test(`AI finishes a race on ${def.name}`, () => {
  const t0 = Date.now();
  const core = new RaceCore(def);
  const build = Date.now() - t0;
  const types = ['rally', 'sports', 'truck', 'rally', 'sports', 'truck'];
  const cars = [];
  const ais = [];
  types.forEach((type, k) => {
    const spec = computeSpec(CAR_DEFS[type], { engine: 3, handling: 3, tires: 3 });
    const car = new Vehicle(spec);
    const slot = core.gridSlot(k);
    car.reset(slot.x, core.heightAt(slot.x, slot.z), slot.z, slot.heading);
    core.initRacer(car);
    const mu = spec.grip.dirt;
    const profile = core.path.speedProfile(core.line, mu * 0.92, 75, mu * 9.81 * 0.75);
    ais.push(new AIDriver(car, core.path, { skill: 0.95, name: type + k, line: core.line, profile, reaction: 0.1 + k * 0.05 }));
    cars.push(car);
  });
  const dt = 1 / 180;
  let t = 0;
  let hits = 0;
  let frame = 0;
  let airborne = 0;
  while (t < 420 && cars.some((c) => !c.finished)) {
    if (frame % 3 === 0) ais.forEach((a, i) => a.update(dt * 3, cars, !cars[i].finished, t));
    for (const c of cars) {
      if (c.finished) { c.controls.throttle = 0; c.controls.brake = 1; }
      c.step(dt, core, true);
      if (core.collide(c) > 3) hits++;
      if (!c.grounded && c.airTime > 0.25) airborne++;
    }
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) collideVehicles(cars[i], cars[j]);
    for (const c of cars) {
      if (core.updateProgress(c, t) === 'lap' && c.lapsDone >= def.laps && !c.finished) { c.finished = true; c.finishTime = t; }
    }
    t += dt;
    frame++;
  }
  console.log(`${def.name}: ${core.path.length.toFixed(0)} m, terrain ${build} ms, barrier hits ${hits}, air frames ${airborne}`);
  cars.forEach((c, i) => {
    console.log(`  ${ais[i].name.padEnd(8)} ${c.finished ? 'FIN ' + formatTime(c.finishTime) : 'DNF lap ' + c.lapsDone}  laps: ${c.lapTimes.map(formatTime).join(' ')}`);
    assert.ok(c.finished, `${ais[i].name} did not finish`);
  });
});
