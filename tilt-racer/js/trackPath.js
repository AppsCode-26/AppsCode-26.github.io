// A closed (or open) path sampled every ~1 m with tangents, normals, curvature,
// fast nearest-point queries, an AI racing line and per-car speed profiles.
import { sampleSpline, clamp } from './util.js';

export class TrackPath {
  constructor(points, { closed = true, spacing = 1, width = 12 } = {}) {
    const smp = sampleSpline(points, closed, spacing);
    this.closed = closed;
    this.n = smp.n;
    this.x = smp.x;
    this.y = smp.y;
    this.z = smp.z;
    this.spacing = smp.spacing;
    this.length = closed ? smp.n * smp.spacing : (smp.n - 1) * smp.spacing;
    this.width = width;
    this.halfWidth = width / 2;
    this._computeFrames();
  }

  idx(i) {
    const n = this.n;
    if (this.closed) return ((i % n) + n) % n;
    return clamp(i, 0, n - 1);
  }

  _computeFrames() {
    const n = this.n;
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.curv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.idx(i - 1);
      const b = this.idx(i + 1);
      let dx = this.x[b] - this.x[a];
      let dz = this.z[b] - this.z[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.tx[i] = dx;
      this.tz[i] = dz;
      // Right-hand normal (to the driver's right when travelling forward).
      this.nx[i] = -dz;
      this.nz[i] = dx;
    }
    // Signed curvature, positive when the path bends right.
    for (let i = 0; i < n; i++) {
      const a = this.idx(i - 2);
      const b = this.idx(i + 2);
      const ha = Math.atan2(this.tx[a], this.tz[a]);
      const hb = Math.atan2(this.tx[b], this.tz[b]);
      let d = hb - ha;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.curv[i] = -d / (4 * this.spacing);
    }
  }

  // Nearest sample to (x, z). `hint` speeds things up for cars that move
  // continuously; pass -1 for a full search.
  nearest(x, z, hint = -1, out = {}) {
    const n = this.n;
    let best = -1;
    let bestD = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i += 4) {
        const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      hint = best;
    }
    const win = 40;
    bestD = Infinity;
    for (let k = -win; k <= win; k++) {
      const i = this.idx(hint + k);
      const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const dx = x - this.x[best];
    const dz = z - this.z[best];
    out.i = best;
    out.along = dx * this.tx[best] + dz * this.tz[best];
    out.s = best * this.spacing + out.along;
    out.lat = dx * this.nx[best] + dz * this.nz[best];
    out.dist = Math.sqrt(bestD);
    return out;
  }

  // Minimum-curvature-ish racing line: repeatedly pull each point toward the
  // midpoint of its neighbours while staying inside the track.
  computeRacingLine(margin = 1.6, iterations = 600) {
    const step = 4;
    const m = Math.floor(this.n / step);
    const idx = new Int32Array(m);
    for (let k = 0; k < m; k++) idx[k] = k * step;
    const off = new Float32Array(m);
    const lim = this.halfWidth - margin;
    const px = new Float32Array(m);
    const pz = new Float32Array(m);
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < m; k++) {
        const i = idx[k];
        px[k] = this.x[i] + this.nx[i] * off[k];
        pz[k] = this.z[i] + this.nz[i] * off[k];
      }
      for (let k = 0; k < m; k++) {
        const a = this.closed ? (k - 1 + m) % m : Math.max(0, k - 1);
        const b = this.closed ? (k + 1) % m : Math.min(m - 1, k + 1);
        const mx = (px[a] + px[b]) * 0.5;
        const mz = (pz[a] + pz[b]) * 0.5;
        const i = idx[k];
        const target = (mx - this.x[i]) * this.nx[i] + (mz - this.z[i]) * this.nz[i];
        off[k] = clamp(off[k] + (target - off[k]) * 0.6, -lim, lim);
      }
    }
    // Upsample to every sample with linear interpolation, then smooth.
    const line = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const f = i / step;
      const k0 = Math.floor(f) % m;
      const k1 = (k0 + 1) % m;
      const t = f - Math.floor(f);
      line[i] = off[k0] * (1 - t) + off[k1] * t;
    }
    this.racingLine = line;
    return line;
  }

  // Curvature of the racing line itself (radius used for corner speeds).
  lineCurvature(line) {
    const n = this.n;
    const out = new Float32Array(n);
    const span = 6;
    for (let i = 0; i < n; i++) {
      const a = this.idx(i - span);
      const b = this.idx(i);
      const c = this.idx(i + span);
      const ax = this.x[a] + this.nx[a] * line[a];
      const az = this.z[a] + this.nz[a] * line[a];
      const bx = this.x[b] + this.nx[b] * line[b];
      const bz = this.z[b] + this.nz[b] * line[b];
      const cx = this.x[c] + this.nx[c] * line[c];
      const cz = this.z[c] + this.nz[c] * line[c];
      // Circumscribed circle curvature = 4*area / (|ab||bc||ca|).
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      const ab = Math.hypot(bx - ax, bz - az);
      const bc = Math.hypot(cx - bx, cz - bz);
      const ca = Math.hypot(ax - cx, az - cz);
      out[i] = (2 * Math.abs(cross)) / Math.max(ab * bc * ca, 1e-6);
    }
    return out;
  }

  // Target speeds along the racing line for a car with lateral grip `mu`.
  speedProfile(line, mu, maxSpeed, brakeDecel) {
    const n = this.n;
    const k = this.lineCurvature(line);
    const v = new Float32Array(n);
    const g = 9.81;
    for (let i = 0; i < n; i++) v[i] = Math.min(maxSpeed, Math.sqrt((mu * g) / Math.max(k[i], 1e-4)));
    // Vertical crests also limit speed (light cars lose grip / take off).
    for (let i = 0; i < n; i++) {
      const a = this.idx(i - 6);
      const b = this.idx(i + 6);
      const vc = (this.y[b] - 2 * this.y[i] + this.y[a]) / (36 * this.spacing * this.spacing);
      if (vc < -0.004) v[i] = Math.min(v[i], Math.sqrt(g / -vc) * 1.15);
    }
    const ds = this.spacing;
    // Backward pass: start braking early enough for every corner (two laps
    // round so the wrap-around is handled).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const nx = this.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
        const lim = Math.sqrt(v[nx] * v[nx] + 2 * brakeDecel * ds);
        if (v[i] > lim) v[i] = lim;
      }
    }
    return v;
  }

  pointAt(i, lateral, out = {}) {
    const j = this.idx(Math.round(i));
    out.x = this.x[j] + this.nx[j] * lateral;
    out.z = this.z[j] + this.nz[j] * lateral;
    out.y = this.y[j];
    out.heading = Math.atan2(this.tx[j], this.tz[j]);
    return out;
  }
}
