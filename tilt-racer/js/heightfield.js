// Terrain height grid + surface-type grid + static obstacle hash (pure JS).
import { staticContact } from './physics.js';
import { clamp } from './util.js';

export class Heightfield {
  constructor(minX, minZ, size, cell) {
    this.minX = minX;
    this.minZ = minZ;
    this.size = size;
    this.cell = cell;
    this.n = Math.round(size / cell) + 1;
    this.h = new Float32Array(this.n * this.n);
  }
  x(ix) {
    return this.minX + ix * this.cell;
  }
  z(iz) {
    return this.minZ + iz * this.cell;
  }
  fill(fn) {
    const n = this.n;
    for (let iz = 0; iz < n; iz++) {
      const z = this.z(iz);
      for (let ix = 0; ix < n; ix++) this.h[iz * n + ix] = fn(this.x(ix), z);
    }
  }
  // Same triangulation as the rendered mesh: split along the (0,1)-(1,0) diagonal.
  heightAt(x, z) {
    const n = this.n;
    let fx = (x - this.minX) / this.cell;
    let fz = (z - this.minZ) / this.cell;
    fx = clamp(fx, 0, n - 1.0001);
    fz = clamp(fz, 0, n - 1.0001);
    const ix = fx | 0;
    const iz = fz | 0;
    const tx = fx - ix;
    const tz = fz - iz;
    const i = iz * n + ix;
    const h = this.h;
    if (tx + tz <= 1) return h[i] + (h[i + 1] - h[i]) * tx + (h[i + n] - h[i]) * tz;
    const h11 = h[i + n + 1];
    return h11 + (h[i + n] - h11) * (1 - tx) + (h[i + 1] - h11) * (1 - tz);
  }
  normalAt(x, z, out) {
    const e = this.cell * 0.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -dx;
    const ny = 2 * e;
    const nz = -dz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
    return out;
  }
}

export class SurfaceGrid {
  constructor(minX, minZ, size, cell, fillValue = 0) {
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.n = Math.ceil(size / cell);
    this.data = new Uint8Array(this.n * this.n).fill(fillValue);
  }
  get(x, z) {
    const ix = Math.floor((x - this.minX) / this.cell);
    const iz = Math.floor((z - this.minZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return 0;
    return this.data[iz * this.n + ix];
  }
  set(ix, iz, v) {
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return;
    this.data[iz * this.n + ix] = v;
  }
}

// Spatial hash of circles and oriented boxes that cars bounce off.
export class Obstacles {
  constructor(cell = 16) {
    this.cell = cell;
    this.map = new Map();
    this.list = [];
  }
  _key(ix, iz) {
    return ix * 73856093 + iz * 19349663;
  }
  _insert(o, minX, minZ, maxX, maxZ) {
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++) {
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        const k = this._key(ix, iz);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(o);
      }
    }
    this.list.push(o);
  }
  addCircle(x, z, r) {
    const o = { type: 0, x, z, r };
    this._insert(o, x - r, z - r, x + r, z + r);
    return o;
  }
  addBox(x, z, hw, hd, angle = 0) {
    const o = { type: 1, x, z, hw, hd, c: Math.cos(angle), s: Math.sin(angle) };
    const R = Math.hypot(hw, hd);
    this._insert(o, x - R, z - R, x + R, z + R);
    return o;
  }
  // Is a point (with radius) free of obstacles? Used when scattering props.
  isFree(x, z, r) {
    const c = this.cell;
    const k = this._key(Math.floor(x / c), Math.floor(z / c));
    const arr = this.map.get(k);
    if (!arr) return true;
    for (const o of arr) {
      if (o.type === 0) {
        if (Math.hypot(x - o.x, z - o.z) < o.r + r) return false;
      } else {
        const dx = x - o.x;
        const dz = z - o.z;
        const lx = dx * o.c - dz * o.s;
        const lz = dx * o.s + dz * o.c;
        if (Math.abs(lx) < o.hw + r && Math.abs(lz) < o.hd + r) return false;
      }
    }
    return true;
  }
  // Push a car out of anything it overlaps. Car = two circles along its length.
  collide(car) {
    const s = car.spec;
    const r = s.width * 0.5;
    const off = s.length * 0.5 - r;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const c = this.cell;
    let impact = 0;
    for (let i = -1; i <= 1; i += 2) {
      const px = car.x + fx * off * i;
      const pz = car.z + fz * off * i;
      const k = this._key(Math.floor(px / c), Math.floor(pz / c));
      const arr = this.map.get(k);
      if (!arr) continue;
      for (const o of arr) {
        if (o.type === 0) {
          const dx = px - o.x;
          const dz = pz - o.z;
          const d = Math.hypot(dx, dz);
          const pen = r + o.r - d;
          if (pen > 0 && d > 1e-4) {
            const nx = dx / d;
            const nz = dz / d;
            impact = Math.max(impact, staticContact(car, o.x + nx * o.r, o.z + nz * o.r, nx, nz, pen));
          }
        } else {
          const dx = px - o.x;
          const dz = pz - o.z;
          // Into box space (rotation by -angle).
          const lx = dx * o.c - dz * o.s;
          const lz = dx * o.s + dz * o.c;
          const cx = clamp(lx, -o.hw, o.hw);
          const cz = clamp(lz, -o.hd, o.hd);
          let nlx = lx - cx;
          let nlz = lz - cz;
          let d = Math.hypot(nlx, nlz);
          let pen;
          if (d < 1e-4) {
            // Centre inside the box: push out along the shallowest axis.
            const ox = o.hw - Math.abs(lx);
            const oz = o.hd - Math.abs(lz);
            if (ox < oz) {
              nlx = Math.sign(lx) || 1;
              nlz = 0;
              pen = ox + r;
            } else {
              nlx = 0;
              nlz = Math.sign(lz) || 1;
              pen = oz + r;
            }
            d = 1;
          } else {
            pen = r - d;
            nlx /= d;
            nlz /= d;
          }
          if (pen > 0) {
            // Back to world space (rotation by +angle).
            const nx = nlx * o.c + nlz * o.s;
            const nz = -nlx * o.s + nlz * o.c;
            const qx = o.x + cx * o.c + cz * o.s;
            const qz = o.z - cx * o.s + cz * o.c;
            impact = Math.max(impact, staticContact(car, qx, qz, nx, nz, pen));
          }
        }
      }
    }
    return impact;
  }
}
