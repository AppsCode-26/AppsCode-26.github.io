// Shared scene builders: terrain mesh, road ribbons, walls, vegetation and
// props as instanced meshes.
import * as THREE from './vendor/three.module.min.js';
import { mulberry32 } from './util.js';

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// colorFn(x, z, h, slope) -> [r, g, b] in sRGB 0..1
export function buildTerrainMesh(hf, colorFn, detailTex, detailScale = 6) {
  const n = hf.n;
  const N = n * n;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const uv = new Float32Array(N * 2);
  const h = hf.h;
  const inv = 1 / (2 * hf.cell);
  for (let iz = 0; iz < n; iz++) {
    const z = hf.z(iz);
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const x = hf.x(ix);
      const y = h[i];
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      const hx = (h[iz * n + Math.min(n - 1, ix + 1)] - h[iz * n + Math.max(0, ix - 1)]) * inv;
      const hz = (h[Math.min(n - 1, iz + 1) * n + ix] - h[Math.max(0, iz - 1) * n + ix]) * inv;
      const slope = Math.hypot(hx, hz);
      const c = colorFn(x, z, y, slope);
      col[i * 3] = toLin(c[0]);
      col[i * 3 + 1] = toLin(c[1]);
      col[i * 3 + 2] = toLin(c[2]);
      uv[i * 2] = x / detailScale;
      uv[i * 2 + 1] = z / detailScale;
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
      idx[k++] = b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTex, roughness: 0.96, metalness: 0 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// Flat ribbon that follows the terrain along a sampled path.
// path: { n, x, z, nx, nz, closed, spacing }
export function buildRibbon(path, opts) {
  const { halfWidth, heightAt, yOffset = 0.05, across = 4, material, vRepeat = 10, stride = 2, lateralOffset = 0 } = opts;
  const rows = [];
  for (let i = 0; i < path.n; i += stride) rows.push(i);
  if (!path.closed && rows[rows.length - 1] !== path.n - 1) rows.push(path.n - 1);
  const A = across + 1;
  const R = rows.length;
  const pos = new Float32Array(R * A * 3);
  const uv = new Float32Array(R * A * 2);
  let dist = 0;
  for (let r = 0; r < R; r++) {
    const i = rows[r];
    if (r > 0) {
      const j = rows[r - 1];
      dist += Math.hypot(path.x[i] - path.x[j], path.z[i] - path.z[j]);
    }
    for (let k = 0; k < A; k++) {
      const lat = lateralOffset - halfWidth + (2 * halfWidth * k) / across;
      const x = path.x[i] + path.nx[i] * lat;
      const z = path.z[i] + path.nz[i] * lat;
      const o = (r * A + k) * 3;
      pos[o] = x;
      pos[o + 1] = heightAt(x, z) + yOffset;
      pos[o + 2] = z;
      uv[(r * A + k) * 2] = k / across;
      uv[(r * A + k) * 2 + 1] = dist / vRepeat;
    }
  }
  const segs = path.closed ? R : R - 1;
  const idx = new Uint32Array(segs * across * 6);
  let q = 0;
  for (let r = 0; r < segs; r++) {
    const r2 = (r + 1) % R;
    for (let k = 0; k < across; k++) {
      const a = r * A + k;
      const b = a + 1;
      const c = r2 * A + k;
      const d = c + 1;
      idx[q++] = a;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = b;
      idx[q++] = d;
      idx[q++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  return mesh;
}

// Vertical strip (fence / tyre wall) at a lateral offset from a path.
export function buildWall(path, opts) {
  const { lateral, height, heightAt, material, stride = 2, vRepeat = 2, sink = 0.2 } = opts;
  const rows = [];
  for (let i = 0; i < path.n; i += stride) rows.push(i);
  const R = rows.length;
  const pos = new Float32Array(R * 2 * 3);
  const uv = new Float32Array(R * 2 * 2);
  let dist = 0;
  for (let r = 0; r < R; r++) {
    const i = rows[r];
    if (r > 0) {
      const j = rows[r - 1];
      dist += Math.hypot(path.x[i] - path.x[j], path.z[i] - path.z[j]);
    }
    const x = path.x[i] + path.nx[i] * lateral;
    const z = path.z[i] + path.nz[i] * lateral;
    const y = heightAt(x, z);
    pos.set([x, y - sink, z, x, y + height, z], r * 6);
    uv.set([dist / vRepeat, 0, dist / vRepeat, 1], r * 4);
  }
  const segs = path.closed ? R : R - 1;
  const idx = new Uint32Array(segs * 6);
  let q = 0;
  for (let r = 0; r < segs; r++) {
    const r2 = (r + 1) % R;
    const a = r * 2;
    const c = r2 * 2;
    idx.set([a, c, a + 1, a + 1, c, c + 1], q);
    q += 6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- props
function colorize(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

export function mergeGeos(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return m;
}

function jitter(geo, amount, seed) {
  const r = mulberry32(seed);
  const p = geo.attributes.position;
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = map.get(key);
    if (!d) map.set(key, (d = [(r() - 0.5) * amount, (r() - 0.5) * amount, (r() - 0.5) * amount]));
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  return geo;
}

export const PropGeo = {
  pine() {
    const parts = [colorize(new THREE.CylinderGeometry(0.18, 0.28, 2.2, 6).translate(0, 1.1, 0), 0x5a3d24)];
    const shades = [0x24502a, 0x2b5e30, 0x336b36];
    for (let i = 0; i < 3; i++) {
      const r = 2.3 - i * 0.6;
      const cone = new THREE.ConeGeometry(r, 3.2 - i * 0.4, 8).translate(0, 2.6 + i * 1.7, 0);
      parts.push(colorize(jitter(cone, 0.25, i + 3), shades[i]));
    }
    return mergeGeos(parts);
  },
  broadleaf() {
    const parts = [colorize(new THREE.CylinderGeometry(0.2, 0.32, 2.6, 6).translate(0, 1.3, 0), 0x5e4630)];
    const blobs = [
      [0, 3.6, 0, 2.0, 0x3f7a2e],
      [0.9, 3.1, 0.4, 1.4, 0x4a8834],
      [-0.8, 3.2, -0.3, 1.5, 0x376d29],
      [0.1, 4.6, 0.2, 1.3, 0x55933a],
    ];
    blobs.forEach(([x, y, z, r, c], i) => parts.push(colorize(jitter(new THREE.IcosahedronGeometry(r, 1), 0.35, i + 11).translate(x, y, z), c)));
    return mergeGeos(parts);
  },
  cactus() {
    const parts = [colorize(new THREE.CylinderGeometry(0.28, 0.32, 3.4, 8).translate(0, 1.7, 0), 0x4f7a3a)];
    parts.push(colorize(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8).rotateZ(Math.PI / 2).translate(0.55, 1.6, 0), 0x4a7336));
    parts.push(colorize(new THREE.CylinderGeometry(0.19, 0.2, 1.1, 8).translate(1.1, 2.1, 0), 0x4a7336));
    parts.push(colorize(new THREE.CylinderGeometry(0.17, 0.18, 0.9, 8).rotateZ(Math.PI / 2).translate(-0.45, 2.2, 0), 0x52803d));
    parts.push(colorize(new THREE.CylinderGeometry(0.16, 0.17, 0.8, 8).translate(-0.85, 2.6, 0), 0x52803d));
    return mergeGeos(parts);
  },
  bush(color = 0x5d7a35) {
    return mergeGeos([
      colorize(jitter(new THREE.IcosahedronGeometry(0.9, 1), 0.3, 5).scale(1.2, 0.75, 1.2).translate(0, 0.5, 0), color),
      colorize(jitter(new THREE.IcosahedronGeometry(0.6, 1), 0.25, 6).translate(0.7, 0.45, 0.2), color),
    ]);
  },
  rock(color = 0x8a8580) {
    return mergeGeos([colorize(jitter(new THREE.DodecahedronGeometry(1, 0), 0.5, 21).scale(1.3, 0.8, 1.1), color)]);
  },
  hay() {
    const g = new THREE.CylinderGeometry(0.75, 0.75, 1.4, 12).rotateZ(Math.PI / 2).translate(0, 0.75, 0);
    return mergeGeos([colorize(g, 0xd8b75a)]);
  },
  tire() {
    const parts = [];
    for (let i = 0; i < 3; i++) parts.push(colorize(new THREE.TorusGeometry(0.42, 0.17, 6, 12).rotateX(Math.PI / 2).translate(0, 0.17 + i * 0.3, 0), i % 2 ? 0x1b1b1b : 0x222222));
    return mergeGeos(parts);
  },
};

const propMat = {};
export function propMaterial(flat = true) {
  const key = flat ? 'flat' : 'smooth';
  return propMat[key] || (propMat[key] = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: flat }));
}

// items: [{ x, y, z, s, r, tint? }]
export function instanced(geo, items, { castShadow = true, material = propMaterial(), tintVar = 0.15, seed = 1 } = {}) {
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, items.length));
  mesh.count = items.length;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  const r = mulberry32(seed);
  items.forEach((it, i) => {
    e.set(it.rx || 0, it.r || 0, it.rz || 0);
    q.setFromEuler(e);
    const s = it.s || 1;
    sc.set(s * (it.sx || 1), s * (it.sy || 1), s * (it.sz || 1));
    p.set(it.x, it.y, it.z);
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
    const t = 1 - tintVar / 2 + r() * tintVar;
    c.setRGB(t, t * (0.97 + r() * 0.06), t);
    mesh.setColorAt(i, c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

export function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) m.dispose();
    }
  });
}
