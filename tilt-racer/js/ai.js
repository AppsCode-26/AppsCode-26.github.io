// AI drivers: follow a racing line with pure-pursuit steering, brake for
// corners using a grip-based speed profile, dodge cars ahead and recover when
// stuck. They drive the exact same physics model as the player.
import { clamp, lerp } from './util.js';
import { steerLimit } from './physics.js';

export class AIDriver {
  constructor(car, path, opts) {
    this.car = car;
    this.path = path;
    this.skill = opts.skill;
    this.name = opts.name;
    this.line = opts.line;
    this.profile = opts.profile;
    this.laneBias = opts.laneBias || 0;
    this.reaction = opts.reaction || 0.2;
    this.offset = this.laneBias;
    this.avoid = 0;
    this.stuck = 0;
    this.recover = 0;
    this.noise = Math.random() * 100;
    this.wobble = opts.wobble || 0;
    this._near = {};
    this._tp = {};
  }

  update(dt, cars, active, raceTime) {
    const car = this.car;
    const ctl = car.controls;
    const p = this.path;
    if (!active) {
      ctl.throttle = 0;
      ctl.brake = 1;
      ctl.steer = 0;
      ctl.handbrake = false;
      return;
    }
    if (raceTime < this.reaction) {
      ctl.brake = 1;
      ctl.throttle = 0;
      return;
    }
    const s = car.spec;
    const near = p.nearest(car.x, car.z, car.trackHint ?? -1, this._near);
    car.trackHint = near.i;
    const speed = car.speed;

    // --- recovery when stuck against something
    if (this.recover > 0) {
      this.recover -= dt;
      ctl.throttle = 0;
      ctl.brake = 1;
      ctl.handbrake = false;
      ctl.steer = -Math.sign(near.lat) * 0.8 * Math.sign(car.forwardSpeed || 1);
      return;
    }
    if (speed < 1.2) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 2.2) {
      this.stuck = 0;
      this.recover = 1.3;
    }

    // --- traffic: steer around cars just ahead of us
    let wantAvoid = 0;
    for (const other of cars) {
      if (other === car) continue;
      let ds = (other.trackS ?? 0) - (car.trackS ?? 0);
      if (p.closed) {
        if (ds > p.length / 2) ds -= p.length;
        if (ds < -p.length / 2) ds += p.length;
      }
      if (ds < 0 || ds > 16 + speed * 0.4) continue;
      const dl = (other.trackLat ?? 0) - near.lat;
      if (Math.abs(dl) < 2.6) {
        const lim = p.halfWidth - 1.5;
        const roomLeft = near.lat + lim;
        const roomRight = lim - near.lat;
        wantAvoid = dl >= 0 ? (roomLeft > 2.5 ? -3 : 3) : roomRight > 2.5 ? 3 : -3;
      }
    }
    this.avoid = lerp(this.avoid, wantAvoid, 1 - Math.exp(-dt * 1.5));

    // --- pure pursuit target on the racing line
    const look = clamp(5 + speed * 0.42, 6, 34);
    const ti = near.i + Math.round(look / p.spacing);
    const j = p.idx(ti);
    this.noise += dt * 0.6;
    const wob = this.wobble * Math.sin(this.noise * 1.7) * Math.sin(this.noise * 0.63);
    const lim = p.halfWidth - 1.1;
    const lateral = clamp(this.line[j] + this.offset + this.avoid + wob, -lim, lim);
    const tp = p.pointAt(j, lateral, this._tp);
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const rx = -fz;
    const rz = fx;
    const dx = tp.x - car.x;
    const dz = tp.z - car.z;
    const lx = dx * rx + dz * rz;
    const lz = dx * fx + dz * fz;
    const ld2 = Math.max(lx * lx + lz * lz, 4);
    let delta = Math.atan((2 * lx * s.L) / ld2);
    if (lz < 0) delta = Math.sign(lx || 1) * s.maxSteer; // target behind: full lock
    const limit = steerLimit(s, speed);
    // Catch slides: steer into the direction of travel.
    const beta = Math.atan2(car.lateralSpeed, Math.max(Math.abs(car.forwardSpeed), 2));
    delta += beta * 0.55;
    ctl.steer = clamp(delta / limit, -1, 1);

    // --- speed control
    const aheadI = p.idx(near.i + Math.round((speed * 0.35 + 2) / p.spacing));
    let target = this.profile[aheadI] * this.skill;
    // Stay calmer when far off line or sliding.
    if (Math.abs(beta) > 0.25) target = Math.min(target, speed * 0.97);
    const err = target - speed;
    if (err > 0) {
      ctl.throttle = clamp(0.55 + err * 0.3, 0, 1);
      ctl.brake = 0;
    } else if (err < -1.2) {
      ctl.throttle = 0;
      ctl.brake = clamp(-err * 0.18, 0, 1);
    } else {
      ctl.throttle = 0.25;
      ctl.brake = 0;
    }
    // Wrong way round? Turn back hard.
    const align = fx * p.tx[near.i] + fz * p.tz[near.i];
    if (align < -0.2) {
      ctl.steer = Math.sign(lx || 1);
      ctl.throttle = 0.5;
      ctl.brake = 0;
    }
    ctl.handbrake = false;
  }
}
