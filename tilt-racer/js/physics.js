// Vehicle dynamics: a single-track ("bicycle") model with a Pacejka-style tyre
// curve, friction circle, longitudinal weight transfer, an engine torque curve
// with automatic gearbox, aero drag, rolling resistance per surface, slopes and
// a vertical suspension that lets cars catch air over crests and ramps.
//
// World frame: three.js style, Y up. A car with heading h faces
// forward = (sin h, cos h) and right = (-cos h, sin h) in the XZ plane.
// yawRate is positive when the car rotates to the right.

import { clamp, lerp } from './util.js';

export const SURF = { GRASS: 0, ASPHALT: 1, DIRT: 2, SAND: 3, WATER: 4, ROCK: 5 };

export const SURFACE_INFO = [
  { key: 'grass', rr: 0.05, bump: 0.5, loose: true, dust: [0.42, 0.47, 0.3] },
  { key: 'asphalt', rr: 0.012, bump: 0.04, loose: false, dust: [0.78, 0.78, 0.8] },
  { key: 'dirt', rr: 0.028, bump: 0.3, loose: true, dust: [0.66, 0.53, 0.38] },
  { key: 'sand', rr: 0.09, bump: 0.35, loose: true, dust: [0.86, 0.76, 0.56] },
  { key: 'water', rr: 0.3, bump: 0.25, loose: true, dust: [0.85, 0.92, 1.0] },
  { key: 'rock', rr: 0.02, bump: 0.45, loose: false, dust: [0.6, 0.6, 0.6] },
];

const G = 9.81;
const AIR = 0.5 * 1.225;

function tyreCurve(alpha, B, C) {
  return Math.sin(C * Math.atan(B * alpha));
}

function sampleCurve(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (x <= curve[i][0]) {
      const a = curve[i - 1];
      const b = curve[i];
      return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
    }
  }
  return curve[curve.length - 1][1];
}

// Maximum road-wheel angle at a given speed. Steering is speed sensitive (like
// a real power-steering rack + driver) so full tilt at 200 km/h doesn't spin.
export function steerLimit(spec, speed) {
  return spec.maxSteer / (1 + Math.pow(speed / spec.steerFalloff, 1.5));
}

export class Vehicle {
  constructor(spec) {
    this.spec = spec;
    this.controls = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    this.reset(0, 0, 0, 0);
  }

  reset(x, y, z, heading) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.heading = heading;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.rpm = this.spec.idleRpm;
    this.gear = 1;
    this.shiftTimer = 0;
    this.reverseTimer = 0;
    this.ax = 0;
    this.ay = 0;
    this.load = 1;
    this.grounded = true;
    this.airTime = 0;
    this.prevGroundY = null;
    this.groundPitch = 0;
    this.groundRoll = 0;
    this.surface = SURF.ASPHALT;
    this.speed = 0;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.slipAngleF = 0;
    this.slipAngleR = 0;
    this.wheelspin = 0;
    this.skid = 0;
    this.wheelRot = 0;
    this.wheelOmega = 0;
    this.landImpact = 0;
    this.hitImpact = 0;
    this.throttleOut = 0;
    this.wheelH = [y, y, y, y];
    this.suspOffset = 0;
  }

  setSpec(spec) {
    this.spec = spec;
  }

  get forwardX() {
    return Math.sin(this.heading);
  }
  get forwardZ() {
    return Math.cos(this.heading);
  }

  // world: { heightAt(x,z), surfaceAt(x,z) }
  step(dt, world, assists) {
    const s = this.spec;
    const c = this.controls;
    const m = s.mass;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fx = sinH;
    const fz = cosH;
    const rx = -cosH;
    const rz = sinH;

    let u = this.vx * fx + this.vz * fz;
    let v = this.vx * rx + this.vz * rz;
    const speed = Math.hypot(this.vx, this.vz);

    // ---------------------------------------------------------------- ground
    const ht = s.track * 0.5;
    const ax_ = fx * s.a;
    const az_ = fz * s.a;
    const bx_ = fx * s.b;
    const bz_ = fz * s.b;
    const tx_ = rx * ht;
    const tz_ = rz * ht;
    const hFL = world.heightAt(this.x + ax_ - tx_, this.z + az_ - tz_);
    const hFR = world.heightAt(this.x + ax_ + tx_, this.z + az_ + tz_);
    const hRL = world.heightAt(this.x - bx_ - tx_, this.z - bz_ - tz_);
    const hRR = world.heightAt(this.x - bx_ + tx_, this.z - bz_ + tz_);
    this.wheelH[0] = hFL;
    this.wheelH[1] = hFR;
    this.wheelH[2] = hRL;
    this.wheelH[3] = hRR;
    const hFront = (hFL + hFR) * 0.5;
    const hRear = (hRL + hRR) * 0.5;
    const groundY = hRear + (hFront - hRear) * (s.b / s.L);
    const slopeF = (hFront - hRear) / s.L;
    const slopeR = (hFR + hRR - hFL - hRL) / (2 * s.track);
    this.groundPitch = Math.atan(slopeF);
    this.groundRoll = Math.atan(slopeR);

    this.surface = world.surfaceAt(this.x, this.z);
    const surf = SURFACE_INFO[this.surface];

    // ------------------------------------------------------------ suspension
    if (this.prevGroundY === null) this.prevGroundY = groundY;
    const groundVy = (groundY - this.prevGroundY) / dt;
    this.prevGroundY = groundY;
    const w = s.susOmega;
    const off = this.y - groundY;
    let springAcc = 0;
    if (off < s.susTravel) {
      springAcc = G - w * w * off - 2 * s.susZeta * w * (this.vy - groundVy);
      if (springAcc < 0) springAcc = 0;
    }
    this.vy += (springAcc - G) * dt;
    this.y += this.vy * dt;
    if (this.y < groundY - s.susComp) {
      this.y = groundY - s.susComp;
      if (this.vy < groundVy) {
        this.landImpact = Math.max(this.landImpact, groundVy - this.vy);
        this.vy = groundVy;
      }
    }
    this.suspOffset = this.y - groundY;
    const rawLoad = clamp(springAcc / G, 0, 2.5);
    this.load = lerp(this.load, rawLoad, 1 - Math.exp(-dt * 25));
    if (rawLoad === 0 && off > 0.02) {
      this.grounded = false;
      this.airTime += dt;
    } else {
      this.grounded = true;
      this.airTime = 0;
    }
    const load = this.grounded ? Math.max(this.load, 0.05) : this.load * 0.3;

    // -------------------------------------------------------------- steering
    let target = clamp(c.steer, -1, 1) * steerLimit(s, speed);
    const beta = Math.atan2(v, Math.max(Math.abs(u), 1));
    const maxRate = s.steerSpeed * dt;
    this.steer += clamp(target - this.steer, -maxRate, maxRate);
    const delta = this.steer;

    // --------------------------------------------------------- gearbox/engine
    if (this.gear > 0) {
      if (c.brake > 0.1 && c.throttle < 0.1 && u < 0.8) {
        this.reverseTimer += dt;
        if (this.reverseTimer > 0.3) {
          this.gear = -1;
          this.reverseTimer = 0;
        }
      } else this.reverseTimer = 0;
    } else if (c.throttle > 0.1 && u > -0.8) {
      this.reverseTimer += dt;
      if (this.reverseTimer > 0.15) {
        this.gear = 1;
        this.reverseTimer = 0;
      }
    } else this.reverseTimer = 0;

    let throttle = clamp(this.gear === -1 ? c.brake : c.throttle, 0, 1);
    let brake = clamp(this.gear === -1 ? c.throttle : c.brake, 0, 1);

    const ratio = this.gear === -1 ? s.reverseRatio : s.gears[this.gear - 1];
    const totalRatio = ratio * s.finalDrive;
    const rpmWheel = (Math.abs(u) / s.rw) * totalRatio * 9.5493;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const launch = s.idleRpm + throttle * (s.launchRpm - s.idleRpm);
    let rpmTarget = Math.max(rpmWheel, this.gear === 1 || this.gear === -1 ? launch : s.idleRpm);
    if (!this.grounded) rpmTarget = s.idleRpm + throttle * (s.redline - s.idleRpm);
    this.rpm = lerp(this.rpm, Math.min(rpmTarget, s.redline * 1.02), 1 - Math.exp(-dt * 14));

    if (this.gear > 0 && this.shiftTimer <= 0 && this.grounded) {
      const n = s.gears.length;
      if (rpmWheel > s.redline * 0.95 && this.gear < n) {
        this.gear++;
        this.shiftTimer = s.shiftTime;
      } else if (this.gear > 1) {
        const lower = (rpmWheel * s.gears[this.gear - 2]) / s.gears[this.gear - 1];
        const kick = throttle > 0.85 && rpmWheel < s.redline * 0.55 && lower < s.redline * 0.85;
        if ((rpmWheel < s.redline * 0.4 || kick) && lower < s.redline * 0.9) {
          this.gear--;
          this.shiftTimer = s.shiftTime * 0.7;
        }
      }
    }

    const shiftCut = this.shiftTimer > s.shiftTime * 0.35;
    let driveTorque = 0;
    const reverseCapped = this.gear === -1 && -u > 9;
    if (!shiftCut && rpmWheel < s.redline && !reverseCapped) {
      driveTorque = s.maxTorque * sampleCurve(s.curve, this.rpm / s.redline) * throttle;
    }
    let Fdrive = (driveTorque * totalRatio * s.eff) / s.rw;
    if (this.gear === -1) Fdrive = -Fdrive;
    // Engine braking opposes motion while off the throttle.
    const ebScale = clamp(Math.abs(u) / 3, 0, 1) * (1 - throttle) * (rpmWheel / s.redline);
    Fdrive -= Math.sign(u) * ebScale * s.engineBrake * totalRatio / s.rw / 3;

    // ------------------------------------------------------------- tyre loads
    const FzTot = m * G * load;
    let Fzf = FzTot * (s.b / s.L) - (m * this.ax * s.h) / s.L * Math.min(load, 1);
    Fzf = clamp(Fzf, FzTot * 0.08, FzTot * 0.92);
    const Fzr = FzTot - Fzf;

    let grip = s.grip[surf.key] ?? s.grip.grass;
    if (this.surface === SURF.WATER) grip = s.grip.grass * 0.55;
    if (this.surface === SURF.ROCK) grip = s.grip.asphalt * 0.85;
    const B = surf.loose ? s.tireB * 0.72 : s.tireB;
    const Cc = s.tireC;
    const maxF = grip * Fzf;
    const maxR = grip * Fzr;

    // Contact patch velocities (body frame).
    const cosD = Math.cos(delta);
    const sinD = Math.sin(delta);
    const vF = v + s.a * this.yawRate;
    const vLongF = u * cosD + vF * sinD;
    const vLatF = -u * sinD + vF * cosD;
    const minV = s.minSlipSpeed;
    const alphaF = Math.atan2(vLatF, Math.max(Math.abs(vLongF), minV));
    const vR = v - s.b * this.yawRate;
    const alphaR = Math.atan2(vR, Math.max(Math.abs(u), minV));
    this.slipAngleF = alphaF;
    this.slipAngleR = alphaR;

    let FyF = -tyreCurve(alphaF, B, Cc) * maxF;
    let FyR = -tyreCurve(alphaR, B, Cc) * maxR;

    // Drive split.
    let driveF = Fdrive * s.frontDrive;
    let driveR = Fdrive * (1 - s.frontDrive);

    // Stability assist: back off the power when the car is sliding sideways.
    if (assists && speed > 6 && Math.abs(beta) > 0.14 && throttle > 0) {
      const k = clamp(1 - (Math.abs(beta) - 0.14) * 2.5, 0.35, 1);
      driveF *= k;
      driveR *= k;
    }
    // Traction control: never ask more than the friction circle allows.
    if (assists) {
      const allowF = Math.max(maxF * 0.35, Math.sqrt(Math.max(0, maxF * maxF - FyF * FyF))) * 0.98;
      const allowR = Math.max(maxR * 0.35, Math.sqrt(Math.max(0, maxR * maxR - FyR * FyR))) * 0.98;
      if (Math.abs(driveF) > allowF) driveF = Math.sign(driveF) * allowF;
      if (Math.abs(driveR) > allowR) driveR = Math.sign(driveR) * allowR;
    }

    // Brakes (ABS keeps them just under the lock threshold).
    const dir = clamp(u / 0.6, -1, 1);
    const brakeTot = brake * s.brakeG * m * G * Math.min(load, 1.2);
    let brakeF = -dir * Math.min(brakeTot * 0.64, maxF * 0.96);
    let brakeR = -dir * Math.min(brakeTot * 0.36, maxR * 0.96);

    let FxF = driveF + brakeF;
    let FxR = driveR + brakeR;
    let rearLocked = false;
    if (c.handbrake) {
      rearLocked = true;
      if (s.frontDrive === 0) FxR = 0;
      FxR = -clamp(u / 1.0, -1, 1) * maxR * 0.8 + (s.frontDrive === 0 ? 0 : FxR * 0.2);
      FyR *= s.handbrakeGrip;
    }

    // Friction circle per axle.
    let spinF = 0;
    let spinR = 0;
    {
      const ratioF = maxF > 1 ? Math.abs(FxF) / maxF : 0;
      if (ratioF > 1) {
        spinF = ratioF - 1;
        FxF = Math.sign(FxF) * maxF * 0.9;
      }
      const latF = maxF * Math.max(ratioF > 1 ? 0.3 : 0.25, Math.sqrt(Math.max(0, 1 - Math.min(1, ratioF) ** 2)));
      if (Math.abs(FyF) > latF) FyF = Math.sign(FyF) * latF;

      const ratioR = maxR > 1 ? Math.abs(FxR) / maxR : 0;
      if (ratioR > 1) {
        spinR = ratioR - 1;
        FxR = Math.sign(FxR) * maxR * 0.9;
      }
      const latR = maxR * Math.max(ratioR > 1 ? 0.3 : 0.25, Math.sqrt(Math.max(0, 1 - Math.min(1, ratioR) ** 2)));
      if (Math.abs(FyR) > latR) FyR = Math.sign(FyR) * latR;
    }
    this.wheelspin = this.grounded ? Math.min(1, Math.max(spinF, spinR) * 1.5) : 0;

    // ---------------------------------------------------------- body forces
    const FxFb = FxF * cosD - FyF * sinD;
    const FyFb = FxF * sinD + FyF * cosD;
    let Fx = FxFb + FxR;
    let Fy = FyFb + FyR;

    const rrCoef = surf.rr * (this.surface === SURF.ASPHALT ? 1 : s.offroad);
    Fx -= clamp(u / 0.5, -1, 1) * rrCoef * m * G * Math.min(load, 1.5);
    Fy -= clamp(v / 0.5, -1, 1) * rrCoef * m * G * 0.5 * Math.min(load, 1.5);
    Fx -= AIR * s.CdA * u * Math.abs(u);
    Fy -= AIR * s.CdA * 2.5 * v * Math.abs(v);
    if (this.surface === SURF.WATER) {
      Fx -= 900 * u * Math.abs(u) * 0.05 + 600 * u;
      Fy -= 900 * v;
    }
    if (this.grounded) {
      Fx -= m * G * Math.sin(this.groundPitch);
      Fy -= m * G * Math.sin(this.groundRoll);
    }

    const Tz = s.a * FyFb - s.b * FyR;

    // ------------------------------------------------------------ integrate
    const axW = (Fx * fx + Fy * rx) / m;
    const azW = (Fx * fz + Fy * rz) / m;
    this.vx += axW * dt;
    this.vz += azW * dt;
    this.yawRate += (Tz / s.Iz) * dt;
    const yawDamp = this.grounded ? s.yawDamp : 0.3;
    this.yawRate *= 1 - yawDamp * dt;

    // Static friction: hold the car still when stopped with the brake on.
    const newSpeed = Math.hypot(this.vx, this.vz);
    if (this.grounded && newSpeed < 0.35 && throttle < 0.05 && (brake > 0.05 || c.handbrake || newSpeed < 0.06)) {
      const slopeAcc = G * Math.hypot(Math.sin(this.groundPitch), Math.sin(this.groundRoll));
      if (slopeAcc < grip * G * 0.9) {
        this.vx *= 0.6;
        this.vz *= 0.6;
        this.yawRate *= 0.6;
      }
    }

    this.heading -= this.yawRate * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    this.ax = lerp(this.ax, Fx / m, 1 - Math.exp(-dt * 10));
    this.ay = lerp(this.ay, Fy / m, 1 - Math.exp(-dt * 10));
    u = this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading);
    v = this.vx * -Math.cos(this.heading) + this.vz * Math.sin(this.heading);
    this.forwardSpeed = u;
    this.lateralSpeed = v;
    this.speed = Math.hypot(this.vx, this.vz);
    this.throttleOut = throttle;

    // Wheel spin for visuals.
    this.wheelOmega = u / s.rw + Math.sign(Fdrive || 1) * this.wheelspin * 25;
    if (rearLocked) this.wheelOmega = 0;
    this.wheelRot += this.wheelOmega * dt;

    // Skid intensity (sound, smoke, skid marks).
    const latSlide = Math.max(Math.abs(vLatF), Math.abs(vR)) - 1.2;
    let skid = clamp(latSlide / 6, 0, 1);
    skid = Math.max(skid, this.wheelspin * clamp(speed / 3, 0.4, 1));
    if (rearLocked && speed > 2) skid = Math.max(skid, clamp(speed / 12, 0, 1));
    if (brake > 0.8 && speed > 8 && !assists) skid = Math.max(skid, 0.3);
    this.skid = this.grounded ? skid : 0;
  }
}

// Car-vs-car collision using two circles per car and an impulse that includes
// rotation, so glancing hits spin cars realistically.
export function collideVehicles(A, B) {
  const sa = A.spec;
  const sb = B.spec;
  const dx0 = B.x - A.x;
  const dz0 = B.z - A.z;
  const reach = (sa.length + sb.length) * 0.5 + 0.5;
  if (dx0 * dx0 + dz0 * dz0 > reach * reach) return 0;
  if (Math.abs(A.y - B.y) > 2.5) return 0;
  const ra = sa.width * 0.5;
  const rb = sb.width * 0.5;
  const offA = sa.length * 0.5 - ra;
  const offB = sb.length * 0.5 - rb;
  const afx = Math.sin(A.heading);
  const afz = Math.cos(A.heading);
  const bfx = Math.sin(B.heading);
  const bfz = Math.cos(B.heading);
  let maxImpact = 0;
  for (let i = -1; i <= 1; i += 2) {
    for (let j = -1; j <= 1; j += 2) {
      const pax = A.x + afx * offA * i;
      const paz = A.z + afz * offA * i;
      const pbx = B.x + bfx * offB * j;
      const pbz = B.z + bfz * offB * j;
      let nx = pax - pbx;
      let nz = paz - pbz;
      const d = Math.hypot(nx, nz);
      const pen = ra + rb - d;
      if (pen <= 0 || d < 1e-5) continue;
      nx /= d;
      nz /= d;
      // Contact point halfway between surfaces.
      const qx = pbx + nx * (rb - pen * 0.5);
      const qz = pbz + nz * (rb - pen * 0.5);
      const imA = 1 / sa.mass;
      const imB = 1 / sb.mass;
      // Positional correction.
      const corr = pen / (imA + imB);
      A.x += nx * corr * imA;
      A.z += nz * corr * imA;
      B.x -= nx * corr * imB;
      B.z -= nz * corr * imB;
      const rax = qx - A.x;
      const raz = qz - A.z;
      const rbx = qx - B.x;
      const rbz = qz - B.z;
      const wa = -A.yawRate;
      const wb = -B.yawRate;
      const vax = A.vx + wa * raz;
      const vaz = A.vz - wa * rax;
      const vbx = B.vx + wb * rbz;
      const vbz = B.vz - wb * rbx;
      const vn = (vax - vbx) * nx + (vaz - vbz) * nz;
      if (vn >= 0) continue;
      const rna = raz * nx - rax * nz;
      const rnb = rbz * nx - rbx * nz;
      const e = 0.3;
      const jn = (-(1 + e) * vn) / (imA + imB + (rna * rna) / sa.Iz + (rnb * rnb) / sb.Iz);
      A.vx += jn * nx * imA;
      A.vz += jn * nz * imA;
      B.vx -= jn * nx * imB;
      B.vz -= jn * nz * imB;
      A.yawRate = -(wa + (rna * jn) / sa.Iz);
      B.yawRate = -(wb - (rnb * jn) / sb.Iz);
      // A bit of friction along the contact tangent (cars rub).
      const tx = -nz;
      const tz = nx;
      const vt = (vax - vbx) * tx + (vaz - vbz) * tz;
      const rta = raz * tx - rax * tz;
      const rtb = rbz * tx - rbx * tz;
      let jt = -vt / (imA + imB + (rta * rta) / sa.Iz + (rtb * rtb) / sb.Iz);
      jt = clamp(jt, -0.3 * jn, 0.3 * jn);
      A.vx += jt * tx * imA;
      A.vz += jt * tz * imA;
      B.vx -= jt * tx * imB;
      B.vz -= jt * tz * imB;
      A.yawRate -= (rta * jt) / sa.Iz;
      B.yawRate += (rtb * jt) / sb.Iz;
      const impact = -vn;
      A.hitImpact = Math.max(A.hitImpact, impact);
      B.hitImpact = Math.max(B.hitImpact, impact);
      maxImpact = Math.max(maxImpact, impact);
    }
  }
  return maxImpact;
}

// Resolve a contact between a car and an immovable object. (qx,qz) is the
// contact point, (nx,nz) the normal pointing out of the obstacle toward the car.
export function staticContact(car, qx, qz, nx, nz, pen, restitution = 0.25, friction = 0.35) {
  const s = car.spec;
  car.x += nx * pen;
  car.z += nz * pen;
  const rx = qx - car.x;
  const rz = qz - car.z;
  const w = -car.yawRate;
  const vpx = car.vx + w * rz;
  const vpz = car.vz - w * rx;
  const vn = vpx * nx + vpz * nz;
  if (vn >= 0) return 0;
  const im = 1 / s.mass;
  const rn = rz * nx - rx * nz;
  const jn = (-(1 + restitution) * vn) / (im + (rn * rn) / s.Iz);
  car.vx += jn * nx * im;
  car.vz += jn * nz * im;
  let wNew = w + (rn * jn) / s.Iz;
  const tx = -nz;
  const tz = nx;
  const vt = vpx * tx + vpz * tz;
  const rt = rz * tx - rx * tz;
  let jt = -vt / (im + (rt * rt) / s.Iz);
  jt = clamp(jt, -friction * jn, friction * jn);
  car.vx += jt * tx * im;
  car.vz += jt * tz * im;
  wNew += (rt * jt) / s.Iz;
  car.yawRate = -wNew;
  car.hitImpact = Math.max(car.hitImpact, -vn);
  return -vn;
}
