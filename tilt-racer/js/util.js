// Small math helpers shared by every module. No three.js imports here so the
// physics / AI code can also run under Node for testing.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
// Frame-rate independent exponential smoothing.
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D simplex noise (Gustavson). Returns roughly [-1, 1].
export function makeNoise2D(seed = 1) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = [1, -1, 1, -1, 1, -1, 0, 0];
  const gy = [1, 1, -1, -1, 0, 0, 1, -1];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  return function (xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj]] & 7;
      t0 *= t0;
      n += t0 * t0 * (gx[g] * x0 + gy[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]] & 7;
      t1 *= t1;
      n += t1 * t1 * (gx[g] * x1 + gy[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = perm[ii + 1 + perm[jj + 1]] & 7;
      t2 *= t2;
      n += t2 * t2 * (gx[g] * x2 + gy[g] * y2);
    }
    return 70 * n;
  };
}

export function fbm(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// Centripetal Catmull-Rom point (Barry-Goldman). Points are [x, y, z].
function crPoint(p0, p1, p2, p3, u, out) {
  const d = (a, b) => Math.max(Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.5), 1e-4);
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const t = t1 + (t2 - t1) * u;
  for (let k = 0; k < 3; k++) {
    const a1 = ((t1 - t) / (t1 - t0)) * p0[k] + ((t - t0) / (t1 - t0)) * p1[k];
    const a2 = ((t2 - t) / (t2 - t1)) * p1[k] + ((t - t1) / (t2 - t1)) * p2[k];
    const a3 = ((t3 - t) / (t3 - t2)) * p2[k] + ((t - t2) / (t3 - t2)) * p3[k];
    const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[k] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
  return out;
}

// Samples a Catmull-Rom spline through `points` ([x,y,z] arrays) at a roughly
// uniform arc-length spacing. Returns { x, y, z, n, length, spacing }.
export function sampleSpline(points, closed, spacing) {
  const P = points;
  const count = P.length;
  const segs = closed ? count : count - 1;
  const dense = [];
  const tmp = [0, 0, 0];
  const get = (i) => {
    if (closed) return P[((i % count) + count) % count];
    if (i < 0) return [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1], 2 * P[0][2] - P[1][2]];
    if (i >= count) {
      const a = P[count - 1];
      const b = P[count - 2];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    return P[i];
  };
  const steps = 60;
  for (let s = 0; s < segs; s++) {
    const p0 = get(s - 1);
    const p1 = get(s);
    const p2 = get(s + 1);
    const p3 = get(s + 2);
    for (let k = 0; k < steps; k++) {
      crPoint(p0, p1, p2, p3, k / steps, tmp);
      dense.push(tmp[0], tmp[1], tmp[2]);
    }
  }
  if (closed) dense.push(dense[0], dense[1], dense[2]);
  else dense.push(P[count - 1][0], P[count - 1][1], P[count - 1][2]);

  const m = dense.length / 3;
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    const dx = dense[i * 3] - dense[i * 3 - 3];
    const dz = dense[i * 3 + 2] - dense[i * 3 - 1];
    cum[i] = cum[i - 1] + Math.hypot(dx, dz);
  }
  const total = cum[m - 1];
  const n = Math.max(4, Math.round(total / spacing)) + (closed ? 0 : 1);
  const step = closed ? total / n : total / (n - 1);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = i * step;
    while (j < m - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = clamp((target - cum[j]) / seg, 0, 1);
    x[i] = lerp(dense[j * 3], dense[j * 3 + 3], t);
    y[i] = lerp(dense[j * 3 + 1], dense[j * 3 + 4], t);
    z[i] = lerp(dense[j * 3 + 2], dense[j * 3 + 5], t);
  }
  return { x, y, z, n, length: total, spacing: step };
}

export function formatTime(t) {
  if (!isFinite(t) || t <= 0) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
