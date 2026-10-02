// Race track simulation data (no rendering): terrain, surfaces, barriers,
// lap / checkpoint tracking and starting grid.
import { TrackPath } from './trackPath.js';
import { Heightfield, SurfaceGrid } from './heightfield.js';
import { SURF, staticContact } from './physics.js';
import { makeNoise2D, fbm, smoothstep, clamp, lerp } from './util.js';

export const THEMES = {
  desert: { verge: SURF.SAND, outside: SURF.SAND },
  forest: { verge: SURF.GRASS, outside: SURF.GRASS },
  canyon: { verge: SURF.SAND, outside: SURF.ROCK },
};

export class RaceCore {
  constructor(def) {
    this.def = def;
    this.theme = THEMES[def.theme];
    const path = (this.path = new TrackPath(def.points, { closed: true, spacing: 1, width: def.width }));
    this._applyJumps();
    this.barrier = path.halfWidth + 4.5;
    this.line = path.computeRacingLine(1.7);
    this._buildTerrain();
    this._buildSurfaces();
  }

  _applyJumps() {
    const p = this.path;
    for (const j of this.def.jumps || []) {
      const start = Math.round(j.at * p.n);
      const total = j.up + j.top + j.down;
      for (let k = 0; k <= total; k++) {
        let h;
        if (k < j.up) h = smoothstep(0, 1, k / j.up) * j.height;
        else if (k < j.up + j.top) h = j.height;
        else h = (1 - smoothstep(0, 1, (k - j.up - j.top) / j.down)) * j.height;
        // Sharpen the lip so cars really launch.
        if (k < j.up) h = Math.pow(k / j.up, 1.6) * j.height;
        p.y[p.idx(start + k)] += h;
      }
    }
    p.jumps = (this.def.jumps || []).map((j) => ({ i: Math.round(j.at * p.n), len: j.up + j.top + j.down, h: j.height }));
  }

  _buildTerrain() {
    const p = this.path;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < p.n; i++) {
      minX = Math.min(minX, p.x[i]);
      maxX = Math.max(maxX, p.x[i]);
      minZ = Math.min(minZ, p.z[i]);
      maxZ = Math.max(maxZ, p.z[i]);
    }
    const margin = 320;
    const size = Math.ceil(Math.max(maxX - minX, maxZ - minZ) + margin * 2);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    this.bounds = { minX: cx - size / 2, minZ: cz - size / 2, size };
    const cell = 3;
    const hf = (this.hf = new Heightfield(cx - size / 2, cz - size / 2, size, cell));

    // Coarse distance + nearest-height field (brute force on a 10 m grid).
    const cc = 10;
    const cn = Math.ceil(size / cc) + 1;
    const cd = new Float32Array(cn * cn);
    const cy = new Float32Array(cn * cn);
    for (let iz = 0; iz < cn; iz++) {
      for (let ix = 0; ix < cn; ix++) {
        const x = hf.minX + ix * cc;
        const z = hf.minZ + iz * cc;
        let best = Infinity;
        let by = 0;
        for (let i = 0; i < p.n; i += 4) {
          const d = (p.x[i] - x) ** 2 + (p.z[i] - z) ** 2;
          if (d < best) {
            best = d;
            by = p.y[i];
          }
        }
        cd[iz * cn + ix] = Math.sqrt(best);
        cy[iz * cn + ix] = by;
      }
    }
    // Blur nearest-height so the medial axis isn't a step.
    for (let pass = 0; pass < 4; pass++) {
      const tmp = cy.slice();
      for (let iz = 1; iz < cn - 1; iz++)
        for (let ix = 1; ix < cn - 1; ix++) {
          const i = iz * cn + ix;
          cy[i] = (tmp[i] * 4 + tmp[i - 1] + tmp[i + 1] + tmp[i - cn] + tmp[i + cn]) / 8;
        }
    }
    const coarse = (arr, x, z) => {
      const fx = clamp((x - hf.minX) / cc, 0, cn - 1.001);
      const fz = clamp((z - hf.minZ) / cc, 0, cn - 1.001);
      const ix = fx | 0;
      const iz = fz | 0;
      const tx = fx - ix;
      const tz = fz - iz;
      const i = iz * cn + ix;
      return lerp(lerp(arr[i], arr[i + 1], tx), lerp(arr[i + cn], arr[i + cn + 1], tx), tz);
    };
    this.distanceAt = (x, z) => coarse(cd, x, z);

    const noise = makeNoise2D(this.def.seed);
    const noise2 = makeNoise2D(this.def.seed + 7);
    const theme = this.def.theme;
    const bar = this.barrier;
    const natural = (x, z) => {
      const d = coarse(cd, x, z);
      const base = coarse(cy, x, z);
      const n1 = fbm(noise, x * 0.006, z * 0.006, 4);
      const n2 = fbm(noise2, x * 0.02, z * 0.02, 3);
      let h = base;
      if (theme === 'desert') {
        h += n1 * 6 * smoothstep(bar, bar + 60, d) + n2 * 1.2;
        h += smoothstep(160, 300, d) * (25 + n1 * 25);
      } else if (theme === 'forest') {
        h += n1 * 9 * smoothstep(bar, bar + 70, d) + n2 * 1.5;
        h += smoothstep(120, 300, d) * (40 + n1 * 35);
      } else {
        // Canyon: steep rock walls close to the track.
        const wall = smoothstep(bar + 8, bar + 45, d);
        h += wall * (26 + n1 * 14 + n2 * 4) + n2 * 0.8;
        h += smoothstep(90, 260, d) * (30 + n1 * 30);
      }
      return h;
    };
    hf.fill(natural);

    // Exact flatten near the track: nearest centreline sample per vertex.
    const n = hf.n;
    const best = new Float32Array(n * n).fill(Infinity);
    const bestY = new Float32Array(n * n);
    const R = bar + 28;
    for (let i = 0; i < p.n; i++) {
      const px = p.x[i];
      const pz = p.z[i];
      const ix0 = Math.max(0, Math.floor((px - R - hf.minX) / cell));
      const ix1 = Math.min(n - 1, Math.ceil((px + R - hf.minX) / cell));
      const iz0 = Math.max(0, Math.floor((pz - R - hf.minZ) / cell));
      const iz1 = Math.min(n - 1, Math.ceil((pz + R - hf.minZ) / cell));
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = hf.minZ + iz * cell;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = hf.minX + ix * cell;
          const d = (x - px) ** 2 + (z - pz) ** 2;
          const k = iz * n + ix;
          if (d < best[k]) {
            best[k] = d;
            bestY[k] = p.y[i];
          }
        }
      }
    }
    for (let k = 0; k < n * n; k++) {
      if (best[k] === Infinity) continue;
      const d = Math.sqrt(best[k]);
      // Gentle camber outside the track so the verge drains away.
      const w = 1 - smoothstep(bar + 1.5, R, d);
      const verge = d > p.halfWidth ? -Math.min(0.35, (d - p.halfWidth) * 0.05) : 0;
      hf.h[k] = lerp(hf.h[k], bestY[k] + verge, w);
    }
  }

  _buildSurfaces() {
    const p = this.path;
    const b = this.bounds;
    const sg = (this.surf = new SurfaceGrid(b.minX, b.minZ, b.size, 1, this.theme.outside));
    const mark = (radius, value) => {
      for (let i = 0; i < p.n; i++) {
        const px = p.x[i];
        const pz = p.z[i];
        const ix0 = Math.floor(px - radius - b.minX);
        const ix1 = Math.ceil(px + radius - b.minX);
        const iz0 = Math.floor(pz - radius - b.minZ);
        const iz1 = Math.ceil(pz + radius - b.minZ);
        for (let iz = iz0; iz <= iz1; iz++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const x = b.minX + ix + 0.5;
            const z = b.minZ + iz + 0.5;
            if ((x - px) ** 2 + (z - pz) ** 2 <= radius * radius) sg.set(ix, iz, value);
          }
        }
      }
    };
    mark(this.barrier + 1, this.theme.verge);
    mark(p.halfWidth, SURF.DIRT);
  }

  heightAt(x, z) {
    return this.hf.heightAt(x, z);
  }

  surfaceAt(x, z) {
    return this.surf.get(x, z);
  }

  // Keep cars inside the barriers. Uses each car's last nearest index.
  collide(car) {
    const p = this.path;
    const near = p.nearest(car.x, car.z, car.trackHint ?? -1, this._n || (this._n = {}));
    car.trackHint = near.i;
    const s = car.spec;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const rx = -fz;
    const rz = fx;
    const hl = s.length * 0.5;
    const hw = s.width * 0.5;
    let impact = 0;
    const i = near.i;
    const nx = p.nx[i];
    const nz = p.nz[i];
    for (let a = -1; a <= 1; a += 2) {
      for (let b = -1; b <= 1; b += 2) {
        const cx = car.x + fx * hl * a + rx * hw * b;
        const cz = car.z + fz * hl * a + rz * hw * b;
        const lat = (cx - p.x[i]) * nx + (cz - p.z[i]) * nz;
        const pen = Math.abs(lat) - this.barrier;
        if (pen > 0) {
          const sgn = Math.sign(lat);
          impact = Math.max(impact, staticContact(car, cx, cz, -nx * sgn, -nz * sgn, pen, 0.2, 0.25));
        }
      }
    }
    return impact;
  }

  gridSlot(k) {
    const p = this.path;
    const row = Math.floor(k / 2);
    const s = p.length - 14 - row * 9 - (k % 2) * 3;
    const lat = (k % 2 === 0 ? -1 : 1) * 3.4;
    return p.pointAt(s / p.spacing, lat, {});
  }

  initRacer(car) {
    const near = this.path.nearest(car.x, car.z, -1, {});
    car.trackHint = near.i;
    car.trackS = near.s;
    car.trackLat = near.lat;
    car.lastS = near.s;
    car.lapsDone = near.s > this.path.length / 2 ? -1 : 0;
    car.cp = 0;
    car.undoCross = false;
    car.lapStart = 0;
    car.lapTimes = [];
    car.bestLap = Infinity;
    car.finished = false;
    car.finishTime = 0;
    car.progress = car.lapsDone * this.path.length + near.s;
  }

  // Returns 'lap' when a lap was just completed.
  updateProgress(car, time) {
    const p = this.path;
    const L = p.length;
    const near = p.nearest(car.x, car.z, car.trackHint ?? -1, this._n2 || (this._n2 = {}));
    car.trackHint = near.i;
    const s = ((near.s % L) + L) % L;
    car.trackLat = near.lat;
    const ds = s - car.lastS;
    let event = null;
    const frac = s / L;
    if (frac > 0.3 && frac < 0.45) car.cp |= 1;
    if (frac > 0.6 && frac < 0.75 && car.cp & 1) car.cp |= 2;
    if (ds < -L / 2) {
      // Crossed the line going forward.
      if (car.undoCross) {
        // Re-crossing after reversing over the line: just restore the count.
        car.undoCross = false;
        car.lapsDone++;
        car.cp = 0;
      } else if (car.lapsDone < 0) {
        car.lapsDone = 0;
        car.cp = 0;
      } else if (car.cp === 3) {
        const lt = time - car.lapStart;
        car.lapTimes.push(lt);
        car.bestLap = Math.min(car.bestLap, lt);
        car.lapStart = time;
        car.lapsDone++;
        car.cp = 0;
        event = 'lap';
      }
      // Otherwise checkpoints were skipped and the crossing doesn't count.
    } else if (ds > L / 2) {
      // Reversed back over the line.
      car.lapsDone--;
      car.undoCross = true;
      car.cp = 3;
    }
    car.lastS = s;
    car.trackS = s;
    car.progress = car.lapsDone * L + s;
    return event;
  }
}
