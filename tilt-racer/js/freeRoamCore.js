// Open-world map data (no rendering): rolling hills ringed by mountains, a
// ring highway, a town crossroads, a lake, forest dirt trail, airfield and a
// sand quarry full of jumps.
import { TrackPath } from './trackPath.js';
import { Heightfield, SurfaceGrid, Obstacles } from './heightfield.js';
import { SURF, staticContact } from './physics.js';
import { makeNoise2D, fbm, smoothstep, clamp, lerp, mulberry32 } from './util.js';

const HALF = 800;
const WALL = 780;

function ringRadius(a) {
  return 500 + 40 * Math.sin(3 * a + 0.5) + 20 * Math.sin(5 * a);
}

export const LAKE = { x: -230, z: 200, r: 88 };
export const TOWN = { x: 0, z: 0, r: 190 };
export const QUARRY = { x: -310, z: -290, r: 115 };

export class FreeRoamCore {
  constructor(density = 1, seed = 5) {
    this.seed = seed;
    this.noise = makeNoise2D(seed);
    this.noise2 = makeNoise2D(seed + 1);
    this.noise3 = makeNoise2D(seed + 2);
    this.hf = new Heightfield(-HALF, -HALF, HALF * 2, 4);
    this._defineRoads();
    this._buildTerrain();
    this._buildSurfaces();
    this._defineRamps();
    this.obstacles = new Obstacles(16);
    this._placeBuildings();
    this._scatter(density);
    this._placePickups();
    // Spawn on the main street heading east out of town.
    const cr = this.roads.find((r) => r.id === 'main').path;
    const near = cr.nearest(40, 0, -1, {});
    const sp = cr.pointAt(near.i, 3.2, {});
    this.spawn = { x: sp.x, z: sp.z, heading: sp.heading };
  }

  _defineRoads() {
    const ring = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const r = ringRadius(a);
      ring.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
    }
    const loop = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const r = 118 + 22 * Math.sin(2 * a + 1) + 12 * Math.sin(5 * a);
      loop.push([230 + Math.cos(a) * r, 0, -230 + Math.sin(a) * r]);
    }
    const rE = ringRadius(0);
    const rW = ringRadius(Math.PI);
    const rS = ringRadius(Math.PI / 2);
    const rN = ringRadius(Math.PI * 1.5);
    const defs = [
      { id: 'ring', name: 'Ring Highway', points: ring, closed: true, width: 14, surface: SURF.ASPHALT },
      {
        id: 'main',
        name: 'Main Street',
        points: [[-rW, 0, 0], [-300, 0, 14], [-130, 0, -4], [0, 0, 0], [130, 0, 8], [300, 0, -10], [rE, 0, 0]],
        closed: false,
        width: 12,
        surface: SURF.ASPHALT,
      },
      {
        id: 'ns',
        name: 'Valley Road',
        points: [[0, 0, -rN], [26, 0, -380], [-22, 0, -250], [14, 0, -120], [0, 0, 0], [30, 0, 130], [-26, 0, 280], [20, 0, 400], [0, 0, rS]],
        closed: false,
        width: 11,
        surface: SURF.ASPHALT,
      },
      { id: 'trail', name: 'Forest Trail', points: loop, closed: true, width: 9, surface: SURF.DIRT },
      { id: 'spur', name: 'Trail Link', points: [[332, 0, -332], [350, 0, -352], [362, 0, -366]], closed: false, width: 8, surface: SURF.DIRT },
      { id: 'quarryLink', name: 'Quarry Road', points: [[-372, 0, -347], [-340, 0, -318], [-300, 0, -285]], closed: false, width: 9, surface: SURF.DIRT },
      { id: 'airfield', name: 'Airfield', points: [[95, 0, 205], [240, 0, 238], [385, 0, 272]], closed: false, width: 34, surface: SURF.ASPHALT, plain: true },
    ];
    this.roads = defs.map((d) => ({ ...d, path: new TrackPath(d.points, { closed: d.closed, spacing: 1, width: d.width }) }));
  }

  _natural(x, z) {
    const n1 = fbm(this.noise, x * 0.0022, z * 0.0022, 5);
    const n2 = fbm(this.noise2, x * 0.011, z * 0.011, 3);
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const mount = smoothstep(560, 770, edge) * (85 + 70 * fbm(this.noise3, x * 0.004, z * 0.004, 4));
    return n1 * 17 + n2 * 2.5 + mount;
  }

  _buildTerrain() {
    const hf = this.hf;
    const townH = this._natural(TOWN.x, TOWN.z);
    this.waterLevel = this._natural(LAKE.x, LAKE.z) - 2;
    const quarryH = this._natural(QUARRY.x, QUARRY.z) - 4;
    this.townH = townH;
    this.quarryH = quarryH;
    const base = (x, z) => {
      let h = this._natural(x, z);
      // Town plateau.
      const rt = Math.hypot(x - TOWN.x, z - TOWN.z);
      h = lerp(townH, h, smoothstep(TOWN.r - 20, TOWN.r + 90, rt));
      // Lake basin with a sandy shore.
      const ang = Math.atan2(z - LAKE.z, x - LAKE.x);
      const R = LAKE.r + 14 * Math.sin(ang * 3 + 1) + 8 * Math.sin(ang * 5);
      const rl = Math.hypot(x - LAKE.x, z - LAKE.z);
      if (rl < R + 70) {
        const shore = this.waterLevel + 0.7;
        if (rl > R) h = lerp(shore, h, smoothstep(R, R + 70, rl));
        else h = lerp(shore, this.waterLevel - 6, smoothstep(R, R - 40, rl));
      }
      // Quarry bowl with rolling dunes.
      const rq = Math.hypot(x - QUARRY.x, z - QUARRY.z);
      if (rq < QUARRY.r + 60) {
        const dunes = quarryH + fbm(this.noise2, x * 0.02, z * 0.02, 2) * 2.2;
        h = lerp(dunes, h, smoothstep(QUARRY.r - 10, QUARRY.r + 60, rq));
      }
      return h;
    };
    hf.fill(base);

    // Road elevation profiles: sample the terrain, smooth heavily, then cap
    // the gradient like a real road engineer would (cuttings + embankments).
    const smoothProfile = (p, prof, win) => {
      const out = new Float32Array(p.n);
      let sum = 0;
      let cnt = 0;
      const get = (i) => prof[p.idx(i)];
      for (let k = -win; k <= win; k++) {
        sum += get(k);
        cnt++;
      }
      for (let i = 0; i < p.n; i++) {
        out[i] = sum / cnt;
        sum += get(i + win + 1) - get(i - win);
      }
      return out;
    };
    const limitGrade = (p, y, g) => {
      const d = g * p.spacing;
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < p.n + (p.closed ? p.n : 0); i++) {
          const a = p.idx(i - 1);
          const b = p.idx(i);
          y[b] = clamp(y[b], y[a] - d, y[a] + d);
        }
        for (let i = p.n - 2 + (p.closed ? p.n : 0); i >= 0; i--) {
          const a = p.idx(i + 1);
          const b = p.idx(i);
          y[b] = clamp(y[b], y[a] - d, y[a] + d);
        }
      }
    };
    const gradeOf = (road) => (road.id === 'airfield' ? 0.012 : road.surface === SURF.DIRT ? 0.13 : 0.075);
    for (const road of this.roads) {
      const p = road.path;
      let prof = new Float32Array(p.n);
      for (let i = 0; i < p.n; i++) prof[i] = hf.heightAt(p.x[i], p.z[i]);
      const win = road.id === 'airfield' ? 150 : road.surface === SURF.DIRT ? 22 : 60;
      for (let pass = 0; pass < 3; pass++) prof = smoothProfile(p, prof, win);
      limitGrade(p, prof, gradeOf(road));
      for (let i = 0; i < p.n; i++) p.y[i] = prof[i];
    }
    // Make junctions meet: open-road ends adopt the height of the road they join.
    for (const road of this.roads) {
      if (road.path.closed) continue;
      const p = road.path;
      for (const end of [0, p.n - 1]) {
        let best = null;
        for (const other of this.roads) {
          if (other === road) continue;
          const near = other.path.nearest(p.x[end], p.z[end], -1, {});
          if (near.dist < 25 && (!best || near.dist < best.dist)) best = { dist: near.dist, y: other.path.y[near.i] };
        }
        if (!best) continue;
        const delta = best.y - p.y[end];
        const span = Math.min(160, p.n - 1);
        for (let k = 0; k <= span; k++) {
          const i = end === 0 ? k : p.n - 1 - k;
          p.y[i] += delta * (1 - smoothstep(0, span, k));
        }
      }
    }
    // Junction centre (town crossroads) — make main/ns agree at (0,0).
    const main = this.roads.find((r) => r.id === 'main').path;
    const ns = this.roads.find((r) => r.id === 'ns').path;
    const nm = main.nearest(0, 0, -1, {});
    const nn = ns.nearest(0, 0, -1, {});
    const target = (main.y[nm.i] + ns.y[nn.i]) / 2;
    for (const [p, ni] of [[main, nm.i], [ns, nn.i]]) {
      const d = target - p.y[ni];
      for (let k = -160; k <= 160; k++) {
        const i = p.idx(ni + k);
        p.y[i] += d * (1 - smoothstep(0, 160, Math.abs(k)));
      }
    }

    // Flatten terrain under / beside every road.
    const n = hf.n;
    const cell = hf.cell;
    const best = new Float32Array(n * n).fill(Infinity);
    const bestY = new Float32Array(n * n);
    const bestW = new Float32Array(n * n);
    for (const road of this.roads) {
      const p = road.path;
      const hw = road.width / 2;
      const R = hw + 24;
      for (let i = 0; i < p.n; i += 2) {
        const px = p.x[i];
        const pz = p.z[i];
        const ix0 = Math.max(0, Math.floor((px - R + HALF) / cell));
        const ix1 = Math.min(n - 1, Math.ceil((px + R + HALF) / cell));
        const iz0 = Math.max(0, Math.floor((pz - R + HALF) / cell));
        const iz1 = Math.min(n - 1, Math.ceil((pz + R + HALF) / cell));
        for (let iz = iz0; iz <= iz1; iz++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const x = -HALF + ix * cell;
            const z = -HALF + iz * cell;
            const d = Math.hypot(x - px, z - pz) - hw;
            const k = iz * n + ix;
            if (d < best[k]) {
              best[k] = d;
              bestY[k] = p.y[i];
              bestW[k] = hw;
            }
          }
        }
      }
    }
    for (let k = 0; k < n * n; k++) {
      if (best[k] === Infinity) continue;
      const w = 1 - smoothstep(2, 24, best[k]);
      hf.h[k] = lerp(hf.h[k], bestY[k] - (best[k] > 0.5 ? Math.min(0.25, best[k] * 0.04) : 0), w);
    }
  }

  _buildSurfaces() {
    const sg = (this.surf = new SurfaceGrid(-HALF, -HALF, HALF * 2, 1, SURF.GRASS));
    const stamp = (cx, cz, r, v) => {
      const ix0 = Math.floor(cx - r + HALF);
      const ix1 = Math.ceil(cx + r + HALF);
      const iz0 = Math.floor(cz - r + HALF);
      const iz1 = Math.ceil(cz + r + HALF);
      for (let iz = iz0; iz <= iz1; iz++)
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = ix - HALF + 0.5;
          const z = iz - HALF + 0.5;
          if ((x - cx) ** 2 + (z - cz) ** 2 <= r * r) sg.set(ix, iz, v);
        }
    };
    // Quarry sand.
    for (let iz = -QUARRY.r - 10; iz <= QUARRY.r + 10; iz++)
      for (let ix = -QUARRY.r - 10; ix <= QUARRY.r + 10; ix++) {
        const d = Math.hypot(ix, iz) + fbm(this.noise, (QUARRY.x + ix) * 0.05, (QUARRY.z + iz) * 0.05, 2) * 10;
        if (d < QUARRY.r) sg.set(Math.floor(QUARRY.x + ix + HALF), Math.floor(QUARRY.z + iz + HALF), SURF.SAND);
      }
    // Lake water and beach.
    const R = LAKE.r + 30;
    for (let iz = -R; iz <= R; iz++)
      for (let ix = -R; ix <= R; ix++) {
        const x = LAKE.x + ix;
        const z = LAKE.z + iz;
        const h = this.hf.heightAt(x, z);
        const v = h < this.waterLevel - 0.15 ? SURF.WATER : h < this.waterLevel + 1.2 ? SURF.SAND : -1;
        if (v >= 0) sg.set(Math.floor(x + HALF), Math.floor(z + HALF), v);
      }
    // Roads last so they win.
    for (const road of this.roads) {
      const p = road.path;
      for (let i = 0; i < p.n; i++) stamp(p.x[i], p.z[i], road.width / 2 + 0.3, road.surface);
    }
  }

  _defineRamps() {
    // Table-top ramps: up slope, flat top, down slope. yaw = direction of travel.
    const air = this.roads.find((r) => r.id === 'airfield').path;
    const ramps = [];
    const onAir = (frac, lat, h, scale = 1) => {
      const i = Math.round(frac * (air.n - 1));
      const pt = air.pointAt(i, lat, {});
      ramps.push({ x: pt.x, z: pt.z, yaw: pt.heading, up: 9 * scale, top: 5 * scale, down: 14 * scale, width: 7, h });
    };
    onAir(0.55, 0, 2.2, 1.1);
    onAir(0.85, -8, 3.2, 1.4);
    onAir(0.3, 9, 1.4, 0.8);
    const r = mulberry32(77);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + r() * 0.4;
      const d = 30 + r() * 55;
      const x = QUARRY.x + Math.cos(a) * d;
      const z = QUARRY.z + Math.sin(a) * d;
      ramps.push({ x, z, yaw: a + Math.PI / 2 + (r() - 0.5), up: 8 + r() * 6, top: 3 + r() * 5, down: 12 + r() * 6, width: 6 + r() * 3, h: 1.6 + r() * 2.2 });
    }
    // One huge kicker in the middle of the quarry.
    ramps.push({ x: QUARRY.x, z: QUARRY.z + 10, yaw: 0.3, up: 16, top: 8, down: 24, width: 10, h: 4.5 });
    for (const rp of ramps) {
      rp.c = Math.cos(rp.yaw);
      rp.s = Math.sin(rp.yaw);
      rp.len = rp.up + rp.top + rp.down;
      rp.R = Math.hypot(rp.len / 2, rp.width / 2) + 2;
      rp.baseY = this.hf.heightAt(rp.x, rp.z);
    }
    this.ramps = ramps;
  }

  rampHeight(rp, x, z) {
    const dx = x - rp.x;
    const dz = z - rp.z;
    // Local frame: forward along yaw.
    const lf = dx * rp.s + dz * rp.c + rp.len / 2; // 0..len
    const ll = dx * rp.c - dz * rp.s;
    if (lf < 0 || lf > rp.len) return -Infinity;
    const side = rp.width / 2 + 1.2;
    if (Math.abs(ll) > side) return -Infinity;
    let h;
    if (lf < rp.up) h = Math.pow(lf / rp.up, 1.35) * rp.h;
    else if (lf < rp.up + rp.top) h = rp.h;
    else h = (1 - smoothstep(0, 1, (lf - rp.up - rp.top) / rp.down)) * rp.h;
    const edge = clamp((side - Math.abs(ll)) / 1.2, 0, 1);
    return h * edge;
  }

  heightAt(x, z) {
    let h = this.hf.heightAt(x, z);
    const rs = this.ramps;
    for (let i = 0; i < rs.length; i++) {
      const rp = rs[i];
      const dx = x - rp.x;
      const dz = z - rp.z;
      if (dx * dx + dz * dz > rp.R * rp.R) continue;
      const rh = this.rampHeight(rp, x, z);
      if (rh > 0) h = Math.max(h, this.hf.heightAt(x, z) + rh);
    }
    return h;
  }

  surfaceAt(x, z) {
    return this.surf.get(x, z);
  }

  _roadDistanceOK(x, z, r) {
    // Reject points within r metres of any non-grass surface (roads etc.).
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const s = this.surf.get(x + Math.cos(ang) * r, z + Math.sin(ang) * r);
      if (s === SURF.ASPHALT || s === SURF.DIRT) return false;
    }
    const s = this.surf.get(x, z);
    return s === SURF.GRASS || s === SURF.SAND;
  }

  _placeBuildings() {
    const r = mulberry32(this.seed * 31);
    const main = this.roads.find((q) => q.id === 'main').path;
    const ns = this.roads.find((q) => q.id === 'ns').path;
    this.buildings = [];
    const tryPlace = (path, i, side) => {
      const w = 10 + r() * 12;
      const d = 10 + r() * 10;
      const tall = r();
      const h = tall < 0.15 ? 28 + r() * 30 : 6 + r() * 14;
      const setback = path.width / 2 + 5 + d / 2 + r() * 3;
      const pt = path.pointAt(i, side * setback, {});
      const angle = pt.heading;
      // Footprint check against roads.
      const R = Math.hypot(w, d) / 2 + 1.5;
      if (!this._roadDistanceOK(pt.x, pt.z, R)) return;
      for (const b of this.buildings) if (Math.hypot(b.x - pt.x, b.z - pt.z) < (b.R + R) * 0.85) return;
      const y = this.hf.heightAt(pt.x, pt.z);
      const kind = h < 10 && r() < 0.5 ? 'house' : 'block';
      const b = { x: pt.x, z: pt.z, y, w, d, h: kind === 'house' ? 5 + r() * 2 : h, angle, R, kind, tint: r(), seed: (r() * 4) | 0 };
      this.buildings.push(b);
      // Box collider: local x = width (across road), local z = depth? Use
      // angle so local z runs along the road direction.
      this.obstacles.addBox(b.x, b.z, w / 2, d / 2, angle + Math.PI / 2);
    };
    for (const path of [main, ns]) {
      const c = path.nearest(TOWN.x, TOWN.z, -1, {});
      for (let k = -175; k <= 175; k += 9) {
        if (Math.abs(k) < 26) continue;
        for (const side of [-1, 1]) if (r() < 0.85) tryPlace(path, c.i + k, side);
      }
    }
  }

  _scatter(density) {
    const r = mulberry32(this.seed * 7);
    this.trees = [];
    this.rocks = [];
    this.bushes = [];
    const hf = this.hf;
    const target = Math.round(2600 * density);
    let tries = 0;
    while (this.trees.length < target && tries < target * 12) {
      tries++;
      const x = (r() - 0.5) * 1540;
      const z = (r() - 0.5) * 1540;
      const edge = Math.max(Math.abs(x), Math.abs(z));
      if (edge > 720) continue;
      if (Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.r + 20) continue;
      if (Math.hypot(x - QUARRY.x, z - QUARRY.z) < QUARRY.r + 15) continue;
      const h = hf.heightAt(x, z);
      if (h < this.waterLevel + 1.5) continue;
      const nrm = hf.normalAt(x, z, {});
      if (nrm.y < 0.82) continue;
      // Denser forest in the north-east around the trail.
      const forest = fbm(this.noise3, x * 0.004, z * 0.004, 3) + (Math.hypot(x - 230, z + 230) < 230 ? 0.55 : 0);
      if (r() > 0.18 + forest * 0.9) continue;
      if (!this._roadDistanceOK(x, z, 5)) continue;
      // Keep ramps clear.
      if (this.ramps.some((rp) => Math.hypot(rp.x - x, rp.z - z) < rp.R + 6)) continue;
      const kind = forest > 0.4 || h > 40 ? 'pine' : r() < 0.5 ? 'pine' : 'broad';
      const s = 0.8 + r() * 0.7;
      this.trees.push({ x, y: h - 0.2, z, s, r: r() * Math.PI * 2, kind });
      this.obstacles.addCircle(x, z, 0.45 * s);
    }
    for (let k = 0; k < 220 * density; k++) {
      const x = (r() - 0.5) * 1500;
      const z = (r() - 0.5) * 1500;
      const h = hf.heightAt(x, z);
      if (h < this.waterLevel + 1) continue;
      if (Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.r) continue;
      if (!this._roadDistanceOK(x, z, 6)) continue;
      if (this.ramps.some((rp) => Math.hypot(rp.x - x, rp.z - z) < rp.R + 6)) continue;
      const s = 0.6 + r() * 1.8;
      this.rocks.push({ x, y: h - 0.3 * s, z, s, r: r() * 6, rx: r(), rz: r() });
      this.obstacles.addCircle(x, z, 1.0 * s);
    }
    for (let k = 0; k < 900 * density; k++) {
      const x = (r() - 0.5) * 1500;
      const z = (r() - 0.5) * 1500;
      const h = hf.heightAt(x, z);
      if (h < this.waterLevel + 1) continue;
      if (Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.r - 30) continue;
      if (!this._roadDistanceOK(x, z, 3)) continue;
      this.bushes.push({ x, y: h - 0.1, z, s: 0.6 + r() * 0.8, r: r() * 6 });
    }
    // Street lamps along town roads.
    this.lamps = [];
    for (const id of ['main', 'ns']) {
      const p = this.roads.find((q) => q.id === id).path;
      const c = p.nearest(0, 0, -1, {});
      for (let k = -170; k <= 170; k += 22) {
        if (Math.abs(k) < 20) continue;
        for (const side of [-1, 1]) {
          const pt = p.pointAt(c.i + k, side * (p.halfWidth + 1.6), {});
          if (!this.obstacles.isFree(pt.x, pt.z, 1)) continue;
          this.lamps.push({ x: pt.x, z: pt.z, y: hf.heightAt(pt.x, pt.z), heading: pt.heading, side });
          this.obstacles.addCircle(pt.x, pt.z, 0.18);
        }
      }
    }
  }

  _placePickups() {
    const r = mulberry32(this.seed * 3);
    this.pickups = [];
    const weights = { ring: 22, main: 8, ns: 10, trail: 10, airfield: 4, quarryLink: 2, spur: 1 };
    for (const road of this.roads) {
      const count = weights[road.id] || 0;
      const p = road.path;
      for (let k = 0; k < count; k++) {
        const i = Math.floor(((k + r() * 0.5) / count) * p.n);
        const pt = p.pointAt(i, (r() - 0.5) * road.width * 0.5, {});
        this.pickups.push({ x: pt.x, z: pt.z, y: this.heightAt(pt.x, pt.z) + 1.3, value: 20, taken: false, timer: 0 });
      }
    }
    // Airborne bonus coins above the big ramps.
    for (const rp of this.ramps) {
      if (rp.h < 2.5) continue;
      const fx = rp.s;
      const fz = rp.c;
      const x = rp.x + fx * (rp.len / 2 + 2);
      const z = rp.z + fz * (rp.len / 2 + 2);
      this.pickups.push({ x, z, y: this.hf.heightAt(x, z) + rp.h + 3.5, value: 75, taken: false, timer: 0, bonus: true });
    }
  }

  collide(car) {
    let impact = this.obstacles.collide(car);
    // Invisible wall at the foot of the outer mountains.
    const lim = WALL;
    if (car.x > lim) impact = Math.max(impact, staticContact(car, lim, car.z, -1, 0, car.x - lim));
    if (car.x < -lim) impact = Math.max(impact, staticContact(car, -lim, car.z, 1, 0, -lim - car.x));
    if (car.z > lim) impact = Math.max(impact, staticContact(car, car.x, lim, 0, -1, car.z - lim));
    if (car.z < -lim) impact = Math.max(impact, staticContact(car, car.x, -lim, 0, 1, -lim - car.z));
    return impact;
  }

  // Closest road point for "reset car".
  nearestRoadPoint(x, z) {
    let best = null;
    for (const road of this.roads) {
      const n = road.path.nearest(x, z, -1, {});
      if (!best || n.dist < best.dist) best = { dist: n.dist, road, i: n.i };
    }
    const pt = best.road.path.pointAt(best.i, 0, {});
    return pt;
  }

  isInWater(car) {
    return this.hf.heightAt(car.x, car.z) < this.waterLevel - 0.9;
  }
}
