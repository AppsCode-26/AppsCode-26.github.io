// Physics sanity tests. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vehicle, SURF, collideVehicles } from '../js/physics.js';
import { CAR_DEFS, CAR_ORDER, computeSpec, measurePerformance, ratings } from '../js/cars.js';

const flat = (surface = SURF.ASPHALT) => ({ heightAt: () => 0, surfaceAt: () => surface });
const DT = 1 / 180;

test('every car accelerates to a sensible top speed', () => {
  const expect = { sports: [270, 330], truck: [170, 230], rally: [210, 260] };
  for (const id of CAR_ORDER) {
    const p = measurePerformance(computeSpec(CAR_DEFS[id]));
    const kmh = p.topSpeed * 3.6;
    assert.ok(kmh > expect[id][0] && kmh < expect[id][1], `${id} top speed ${kmh.toFixed(0)} km/h`);
    assert.ok(p.zeroTo100 > 2.5 && p.zeroTo100 < 9, `${id} 0-100 ${p.zeroTo100.toFixed(2)} s`);
  }
});

test('the three cars have distinct strengths', () => {
  const r = Object.fromEntries(CAR_ORDER.map((id) => [id, ratings(CAR_DEFS[id], { engine: 0, handling: 0, tires: 0 })]));
  assert.ok(r.sports.speed > r.rally.speed && r.sports.speed > r.truck.speed, 'sports car is fastest');
  assert.ok(r.rally.accel > r.truck.accel, 'rally car out-accelerates the truck');
  assert.ok(r.truck.offroad > r.sports.offroad && r.rally.offroad > r.sports.offroad, 'sports car is worst off-road');
});

test('upgrades improve the car', () => {
  for (const id of CAR_ORDER) {
    const base = measurePerformance(computeSpec(CAR_DEFS[id]));
    const eng = measurePerformance(computeSpec(CAR_DEFS[id], { engine: 5, handling: 0, tires: 0 }));
    assert.ok(eng.topSpeed > base.topSpeed + 3, `${id} engine raises top speed`);
    assert.ok(eng.zeroTo100 < base.zeroTo100, `${id} engine improves acceleration`);
    const a = computeSpec(CAR_DEFS[id], { engine: 0, handling: 0, tires: 0 });
    const t = computeSpec(CAR_DEFS[id], { engine: 0, handling: 5, tires: 5 });
    assert.ok(t.grip.dirt > a.grip.dirt && t.steerSpeed > a.steerSpeed && t.h < a.h, `${id} handling/tyres upgrade`);
  }
});

test('steering right turns the car right, left turns it left', () => {
  for (const [steer, sign] of [[1, -1], [-1, 1]]) {
    const car = new Vehicle(computeSpec(CAR_DEFS.rally));
    car.vz = 15;
    car.controls.steer = steer;
    car.controls.throttle = 0.3;
    for (let i = 0; i < 180; i++) car.step(DT, flat(), true);
    // Heading decreases when turning right (forward = (sin h, cos h)).
    assert.equal(Math.sign(car.heading), sign);
    // Facing +z, the car's right is -x.
    assert.equal(Math.sign(car.x), sign);
  }
});

test('brakes stop a car from 100 km/h in a realistic distance', () => {
  for (const id of CAR_ORDER) {
    const car = new Vehicle(computeSpec(CAR_DEFS[id]));
    car.vz = 100 / 3.6;
    car.speed = car.vz;
    car.controls.brake = 1;
    let d = 0;
    for (let i = 0; i < 2000 && car.speed > 0.3; i++) {
      const z0 = car.z;
      car.step(DT, flat(), true);
      d += car.z - z0;
    }
    assert.ok(d > 25 && d < 55, `${id} braking distance ${d.toFixed(1)} m`);
  }
});

test('holding brake when stopped engages reverse', () => {
  const car = new Vehicle(computeSpec(CAR_DEFS.sports));
  car.controls.brake = 1;
  for (let i = 0; i < 180 * 2; i++) car.step(DT, flat(), true);
  assert.equal(car.gear, -1);
  assert.ok(car.forwardSpeed < -2);
});

test('a parked car stays put', () => {
  const car = new Vehicle(computeSpec(CAR_DEFS.truck));
  for (let i = 0; i < 1000; i++) car.step(DT, flat(), true);
  assert.ok(Math.hypot(car.x, car.z) < 1e-3 && Math.abs(car.heading) < 1e-3);
});

test('cars bounce off each other', () => {
  const a = new Vehicle(computeSpec(CAR_DEFS.rally));
  const b = new Vehicle(computeSpec(CAR_DEFS.truck));
  a.reset(0, 0, 0, 0);
  b.reset(0, 0, 4, 0);
  a.vz = 10;
  const impact = collideVehicles(a, b);
  assert.ok(impact > 5);
  assert.ok(b.vz > 0 && a.vz < 10);
});

test('the truck loses less speed off-road than the sports car', () => {
  const coast = (id) => {
    const car = new Vehicle(computeSpec(CAR_DEFS[id]));
    car.vz = 20;
    for (let i = 0; i < 180 * 3; i++) car.step(DT, flat(SURF.GRASS), true);
    return car.speed;
  };
  assert.ok(coast('truck') > coast('sports'));
});
