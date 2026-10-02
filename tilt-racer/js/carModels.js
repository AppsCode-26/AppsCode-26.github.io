// Procedural 3D car models built from extruded side profiles.
// Model space: +Z forward, +Y up, the car's right side is -X. Origin is on
// the ground directly under the centre of gravity (front axle at +a, rear at -b).
import * as THREE from './vendor/three.module.min.js';
import { CAR_DEFS, computeSpec } from './cars.js';
import { numberDecal, tireTreadTexture } from './textures.js';

const shared = {};
function mats() {
  if (shared.mats) return shared.mats;
  shared.mats = {
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0a0f14, metalness: 0.2, roughness: 0.06, envMapIntensity: 0.9, clearcoat: 1 }),
    black: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.65, metalness: 0.1 }),
    matte: new THREE.MeshStandardMaterial({ color: 0x232427, roughness: 0.85 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xe0e2e6, metalness: 1, roughness: 0.15 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.93, map: tireTreadTexture() }),
    tireSide: new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9 }),
    headlight: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3dc, emissiveIntensity: 2.2, roughness: 0.2 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x8a8d92, metalness: 0.8, roughness: 0.45 }),
    caliperRed: new THREE.MeshStandardMaterial({ color: 0xc81414, roughness: 0.4 }),
    caliperGold: new THREE.MeshStandardMaterial({ color: 0xd8a420, roughness: 0.4 }),
    under: new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 1 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xffa020, emissive: 0xff7a00, emissiveIntensity: 0.6 }),
  };
  return shared.mats;
}

function paint(color) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: 0.4,
    roughness: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.85,
  });
}

// Extrude a side profile ([z, y] points, may include arch commands) across width.
function profileMesh(build, width, material, bevel = 0.05) {
  const shape = new THREE.Shape();
  build(shape);
  const depth = Math.max(0.01, width - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 3,
    curveSegments: 12,
  });
  geo.rotateY(-Math.PI / 2);
  geo.translate(depth / 2, 0, 0);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

function poly(points) {
  return (s) => {
    s.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
    s.closePath();
  };
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function cyl(r, len, mat, seg = 16) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateZ(Math.PI / 2);
  return new THREE.Mesh(g, mat);
}

// A plane lying on a sloped part of the body (windscreen / rear window),
// facing outward (up) with a small lift so it sits just above the paint.
function slopeGlass(z1, y1, z2, y2, width, mat, lift = 0.04) {
  const dz = z2 - z1;
  const dy = y2 - y1;
  const len = Math.hypot(dz, dy);
  let ny = dz / len;
  let nz = -dy / len;
  if (ny < 0) {
    ny = -ny;
    nz = -nz;
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, len), mat);
  m.rotation.x = Math.atan2(-ny, nz);
  m.position.set(0, (y1 + y2) / 2 + ny * lift, (z1 + z2) / 2 + nz * lift);
  return m;
}

// Merge every single-material child mesh of `group` that shares a material
// into one mesh. A car is built from ~100 small parts; merging brings it down
// to roughly one draw call per material, which matters a lot on iPad where
// every WebGL call is expensive (six cars in a race, plus the shadow pass).
function mergeByMaterial(group) {
  const buckets = new Map();
  for (const child of group.children.slice()) {
    if (!child.isMesh || Array.isArray(child.material)) continue;
    child.updateMatrix();
    const g = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    g.applyMatrix4(child.matrix);
    if (!buckets.has(child.material)) buckets.set(child.material, []);
    buckets.get(child.material).push(g);
    group.remove(child);
    child.geometry.dispose();
  }
  for (const [material, geos] of buckets) {
    let count = 0;
    for (const g of geos) count += g.attributes.position.count;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    let o = 0;
    for (const g of geos) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      o += n;
      g.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    merged.computeBoundingSphere();
    group.add(new THREE.Mesh(merged, material));
  }
}

function wheel(radius, width, rimMat, caliperMat, spokes = 5, chunky = false) {
  const M = mats();
  const spin = new THREE.Group();
  const tire = cyl(radius, width, [M.tire, M.tireSide], 28);
  // Caps are contiguous after the tread: draw them as one group.
  const tg = tire.geometry.groups;
  tire.geometry.clearGroups();
  tire.geometry.addGroup(tg[0].start, tg[0].count, 0);
  tire.geometry.addGroup(tg[1].start, tg[1].count + tg[2].count, 1);
  spin.add(tire);
  if (chunky) {
    // Off-road tread blocks.
    const blocks = 18;
    for (let i = 0; i < blocks; i++) {
      const a = (i / blocks) * Math.PI * 2;
      const b = box(width * 0.95, 0.05, radius * 0.22, M.tireSide, 0, Math.cos(a) * radius, Math.sin(a) * radius);
      b.rotation.x = -a;
      spin.add(b);
    }
  }
  const rimR = radius * 0.64;
  const rim = cyl(rimR, width * 0.7, rimMat, 24);
  rim.position.x = width * 0.18;
  spin.add(rim);
  const hub = cyl(rimR * 0.25, width * 0.75, rimMat, 12);
  hub.position.x = width * 0.22;
  spin.add(hub);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const sp = box(0.04, rimR * 0.95, rimR * 0.22, rimMat, width * 0.56, 0, 0);
    sp.position.y = Math.cos(a) * rimR * 0.5;
    sp.position.z = Math.sin(a) * rimR * 0.5;
    sp.rotation.x = -a;
    spin.add(sp);
  }
  const disc = cyl(rimR * 0.82, 0.03, M.disc, 20);
  disc.position.x = -width * 0.05;
  spin.add(disc);
  mergeByMaterial(spin);
  const steer = new THREE.Group();
  steer.add(spin);
  if (caliperMat) {
    const cal = box(0.08, rimR * 0.5, rimR * 0.35, caliperMat, width * 0.05, rimR * 0.45, -rimR * 0.35);
    steer.add(cal); // calipers don't spin
  }
  return { steer, spin };
}

function addWheels(root, spec, opts) {
  const wheels = [];
  const r = spec.rw;
  const tw = spec.track / 2;
  const defs = [
    { z: spec.a, x: tw, front: true },
    { z: spec.a, x: -tw, front: true },
    { z: -spec.b, x: tw, front: false },
    { z: -spec.b, x: -tw, front: false },
  ];
  for (const d of defs) {
    const w = wheel(r, opts.tireWidth, opts.rimMat, opts.caliper, opts.spokes, opts.chunky);
    const pivot = new THREE.Group();
    pivot.position.set(d.x, r, d.z);
    // Mirror so the rim face points outward on both sides.
    if (d.x < 0) w.spin.scale.x = -1;
    pivot.add(w.steer);
    root.add(pivot);
    wheels.push({ pivot, steer: w.steer, spin: w.spin, front: d.front, baseY: r });
  }
  return wheels;
}

function lights(body, M, { headZ, headY, headW, headX, tailZ, tailY, tailW, tailX, tailH = 0.08 }) {
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x4a0000, emissive: 0xff1010, emissiveIntensity: 0.5, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const hl = box(headW, 0.09, 0.08, M.headlight, s * headX, headY, headZ);
    body.add(hl);
    const tl = box(tailW, tailH, 0.06, tailMat, s * tailX, tailY, tailZ);
    body.add(tl);
  }
  return tailMat;
}

// ---------------------------------------------------------------- sports
function buildSports(body, spec, paintMat, W) {
  const M = mats();
  const a = spec.a;
  const b = spec.b;
  const r = spec.rw + 0.05;
  const zF = 2.28;
  const zR = -2.2;
  body.add(
    profileMesh(
      (s) => {
        s.moveTo(zR, 0.3);
        s.lineTo(zR - 0.05, 0.55);
        s.lineTo(zR + 0.02, 0.84);
        s.lineTo(-1.35, 0.93);
        s.lineTo(0.95, 0.88);
        s.lineTo(1.75, 0.72);
        s.lineTo(zF - 0.05, 0.55);
        s.lineTo(zF, 0.38);
        s.lineTo(zF - 0.12, 0.2);
        s.lineTo(a + r, 0.2);
        s.absarc(a, spec.rw, r, 0, Math.PI, false);
        s.lineTo(-b + r, 0.2);
        s.absarc(-b, spec.rw, r, 0, Math.PI, false);
        s.lineTo(zR + 0.1, 0.2);
        s.closePath();
      },
      W,
      paintMat,
      0.035
    )
  );
  // Cabin (body coloured) with glass.
  const cabW = W * 0.8;
  const cab = profileMesh(poly([[-1.38, 0.9], [-0.6, 1.2], [0.12, 1.22], [0.98, 0.87]]), cabW, paintMat, 0.03);
  body.add(cab);
  body.add(profileMesh(poly([[-1.15, 0.94], [-0.58, 1.15], [0.1, 1.17], [0.78, 0.92]]), cabW + 0.03, M.glass, 0.0));
  body.add(slopeGlass(0.12, 1.22, 0.98, 0.87, cabW * 0.92, M.glass));
  body.add(slopeGlass(-0.6, 1.2, -1.38, 0.9, cabW * 0.85, M.glass));
  // Spoiler.
  const wing = box(W * 0.92, 0.04, 0.32, paintMat, 0, 1.13, -1.98);
  wing.rotation.x = 0.08;
  body.add(wing);
  for (const s of [-1, 1]) body.add(box(0.05, 0.22, 0.14, M.black, s * W * 0.32, 1.0, -1.95));
  // Front splitter, intakes, diffuser, side skirts.
  body.add(box(W * 0.95, 0.04, 0.25, M.black, 0, 0.2, zF - 0.15));
  body.add(box(W * 0.55, 0.14, 0.05, M.black, 0, 0.36, zF - 0.04));
  for (const s of [-1, 1]) {
    body.add(box(0.36, 0.13, 0.05, M.black, s * W * 0.33, 0.33, zF - 0.06));
    body.add(box(0.04, 0.09, 1.3, M.black, s * (W / 2 + 0.01), 0.27, -0.05));
    body.add(box(0.05, 0.16, 0.5, M.black, s * (W / 2 - 0.02), 0.62, -0.95)); // side intake
    const mirror = box(0.18, 0.08, 0.12, paintMat, s * (cabW / 2 + 0.1), 0.98, 0.72);
    body.add(mirror);
  }
  body.add(box(W * 0.8, 0.12, 0.08, M.black, 0, 0.28, zR - 0.02));
  for (const s of [-1, 1])
    for (const k of [0.2, 0.33]) {
      const ex = cyl(0.045, 0.2, M.chrome, 12);
      ex.rotation.y = Math.PI / 2;
      ex.position.set(s * k, 0.3, zR - 0.05);
      body.add(ex);
    }
  body.add(box(W * 0.9, 0.08, 4.0, M.under, 0, 0.18, 0));
  return lights(body, M, {
    headZ: zF - 0.32, headY: 0.67, headW: 0.42, headX: W * 0.3,
    tailZ: zR - 0.03, tailY: 0.74, tailW: 0.55, tailX: W * 0.3,
  });
}

// ----------------------------------------------------------------- truck
function buildTruck(body, spec, paintMat, W) {
  const M = mats();
  const a = spec.a;
  const b = spec.b;
  const r = spec.rw + 0.08;
  const zF = 2.48;
  const zR = -2.95;
  const cabBack = -0.85;
  // Cab + hood.
  body.add(
    profileMesh(
      (s) => {
        s.moveTo(cabBack, 0.62);
        s.lineTo(cabBack, 1.9);
        s.lineTo(cabBack + 0.12, 1.98);
        s.lineTo(0.42, 1.98);
        s.lineTo(1.05, 1.38);
        s.lineTo(2.35, 1.3);
        s.lineTo(zF - 0.02, 1.14);
        s.lineTo(zF, 0.66);
        s.lineTo(zF - 0.2, 0.56);
        s.lineTo(a + r, 0.56);
        s.absarc(a, spec.rw + 0.02, r, 0, Math.PI, false);
        s.lineTo(cabBack, 0.62);
        s.closePath();
      },
      W,
      paintMat,
      0.035
    )
  );
  body.add(profileMesh(poly([[cabBack + 0.12, 1.42], [cabBack + 0.12, 1.86], [0.38, 1.86], [0.88, 1.42]]), W + 0.03, M.glass, 0));
  body.add(box(0.06, 0.48, W + 0.05, paintMat, -0.25, 1.64, 0).rotateY(Math.PI / 2)); // B-pillar
  body.add(slopeGlass(0.42, 1.97, 1.05, 1.38, W * 0.86, M.glass));
  body.add(box(W * 0.8, 0.42, 0.02, M.glass, 0, 1.66, cabBack - 0.012));
  // Bed: floor, sides with arches, front wall, tailgate.
  const bedTop = 1.42;
  const bedFloor = 0.98;
  const sideT = 0.08;
  for (const s of [-1, 1]) {
    const side = profileMesh(
      (sh) => {
        sh.moveTo(zR, 0.62);
        sh.lineTo(zR, bedTop);
        sh.lineTo(cabBack - 0.08, bedTop);
        sh.lineTo(cabBack - 0.08, 0.62);
        sh.lineTo(-b + r, 0.62);
        sh.absarc(-b, spec.rw + 0.02, r, 0, Math.PI, false);
        sh.lineTo(zR, 0.62);
        sh.closePath();
      },
      sideT,
      paintMat,
      0.02
    );
    side.position.x = s * (W / 2 - sideT / 2);
    body.add(side);
    // Fender flares.
    const flareF = new THREE.Mesh(new THREE.TorusGeometry(r + 0.02, 0.06, 6, 16, Math.PI), M.black);
    flareF.rotation.y = Math.PI / 2;
    flareF.position.set(s * (W / 2 + 0.02), spec.rw + 0.02, a);
    body.add(flareF);
    const flareR = flareF.clone();
    flareR.position.z = -b;
    body.add(flareR);
    // Side steps.
    body.add(box(0.18, 0.05, 1.3, M.black, s * (W / 2 + 0.05), 0.5, 0.2));
  }
  body.add(box(W - 0.1, 0.06, -cabBack + zR * -1 - 0.05, M.matte, 0, bedFloor, (zR + cabBack) / 2));
  body.add(box(W - 0.1, bedTop - bedFloor, 0.08, paintMat, 0, (bedTop + bedFloor) / 2, cabBack - 0.12));
  body.add(box(W - 0.02, bedTop - 0.62, 0.08, paintMat, 0, (bedTop + 0.62) / 2, zR + 0.04));
  body.add(box(W - 0.2, 0.36, -cabBack + zR * -1 - 0.6, M.under, 0, 0.78, (zR + cabBack) / 2));
  // Roll bar with light bar.
  for (const s of [-1, 1]) body.add(box(0.07, 0.5, 0.07, M.black, s * (W / 2 - 0.12), bedTop + 0.25, cabBack - 0.3));
  body.add(box(W - 0.2, 0.07, 0.07, M.black, 0, bedTop + 0.5, cabBack - 0.3));
  body.add(box(W * 0.7, 0.1, 0.12, M.black, 0, 2.05, 0.2));
  for (let i = 0; i < 4; i++) body.add(box(0.2, 0.08, 0.04, M.headlight, (i - 1.5) * 0.36, 2.05, 0.27));
  // Grille, bull bar and bumpers.
  body.add(box(W * 0.7, 0.4, 0.04, M.black, 0, 0.92, zF + 0.005));
  for (let i = 0; i < 4; i++) body.add(box(W * 0.68, 0.025, 0.05, M.chrome, 0, 0.78 + i * 0.1, zF + 0.01));
  body.add(box(W + 0.05, 0.18, 0.18, M.black, 0, 0.55, zF + 0.08));
  for (const s of [-1, 1]) body.add(box(0.06, 0.55, 0.06, M.black, s * 0.4, 0.85, zF + 0.16));
  body.add(box(0.9, 0.06, 0.06, M.black, 0, 1.12, zF + 0.16));
  body.add(box(W + 0.05, 0.16, 0.14, M.chrome, 0, 0.58, zR - 0.06));
  // Mud flaps.
  for (const s of [-1, 1]) body.add(box(0.3, 0.32, 0.02, M.black, s * (W / 2 - 0.2), 0.38, -b - 0.65));
  // Mirrors.
  for (const s of [-1, 1]) body.add(box(0.1, 0.22, 0.14, M.black, s * (W / 2 + 0.12), 1.55, 0.62));
  body.add(box(W * 0.9, 0.1, 5.0, M.under, 0, 0.5, -0.2));
  return lights(body, M, {
    headZ: zF + 0.02, headY: 1.0, headW: 0.34, headX: W * 0.38,
    tailZ: zR - 0.05, tailY: 1.1, tailW: 0.12, tailX: W / 2 - 0.1, tailH: 0.35,
  });
}

// ----------------------------------------------------------------- rally
function buildRally(body, spec, paintMat, W, accent, number) {
  const M = mats();
  const a = spec.a;
  const b = spec.b;
  const r = spec.rw + 0.06;
  const zF = 1.96;
  const zR = -2.1;
  body.add(
    profileMesh(
      (s) => {
        s.moveTo(zR, 0.3);
        s.lineTo(zR - 0.03, 0.75);
        s.lineTo(zR + 0.05, 1.02);
        s.lineTo(-1.82, 1.38);
        s.lineTo(-0.22, 1.43);
        s.lineTo(0.55, 1.0);
        s.lineTo(1.72, 0.84);
        s.lineTo(zF - 0.02, 0.62);
        s.lineTo(zF, 0.34);
        s.lineTo(zF - 0.12, 0.22);
        s.lineTo(a + r, 0.22);
        s.absarc(a, spec.rw, r, 0, Math.PI, false);
        s.lineTo(-b + r, 0.22);
        s.absarc(-b, spec.rw, r, 0, Math.PI, false);
        s.lineTo(zR + 0.1, 0.22);
        s.closePath();
      },
      W,
      paintMat,
      0.035
    )
  );
  body.add(profileMesh(poly([[-1.78, 1.02], [-1.72, 1.32], [-0.26, 1.36], [0.42, 1.03]]), W + 0.03, M.glass, 0));
  body.add(slopeGlass(-0.22, 1.43, 0.55, 1.0, W * 0.84, M.glass));
  body.add(slopeGlass(-1.82, 1.38, zR + 0.05, 1.02, W * 0.8, M.glass));
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.3 });
  // Livery stripes and door numbers.
  for (const s of [-1, 1]) {
    body.add(box(0.012, 0.12, 3.4, accentMat, s * (W / 2 + 0.006), 0.62, -0.05));
    body.add(box(0.012, 0.05, 3.4, accentMat, s * (W / 2 + 0.006), 0.48, -0.05));
    const dec = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshStandardMaterial({ map: numberDecal(number), transparent: true, roughness: 0.5 }));
    dec.position.set(s * (W / 2 + 0.014), 0.82, -0.35);
    dec.rotation.y = (s * Math.PI) / 2;
    body.add(dec);
  }
  body.add(box(W * 0.5, 0.012, 1.0, accentMat, 0, 0.86, 1.2).rotateX(0.16));
  // Roof scoop + rear wing on the hatch.
  body.add(box(0.36, 0.1, 0.4, M.black, 0, 1.47, -0.45));
  const wing = box(W * 0.95, 0.05, 0.36, accentMat, 0, 1.58, -1.95);
  wing.rotation.x = 0.12;
  body.add(wing);
  for (const s of [-1, 1]) {
    body.add(box(0.04, 0.22, 0.26, M.black, s * W * 0.44, 1.5, -1.9));
    body.add(box(0.04, 0.2, 0.3, accentMat, s * W * 0.475, 1.6, -1.95));
  }
  // Light pod on the bonnet.
  body.add(box(W * 0.7, 0.14, 0.12, M.black, 0, 0.95, 1.6));
  for (let i = 0; i < 4; i++) {
    const l = cyl(0.07, 0.04, M.headlight, 16);
    l.rotation.y = Math.PI / 2;
    l.position.set((i - 1.5) * 0.3, 0.95, 1.67);
    body.add(l);
  }
  // Mud flaps, bumper, fender flares.
  for (const s of [-1, 1]) {
    body.add(box(0.36, 0.3, 0.02, accentMat, s * (spec.track / 2), 0.25, -b - 0.48));
    body.add(box(0.36, 0.26, 0.02, accentMat, s * (spec.track / 2), 0.25, a - 0.48));
    body.add(box(0.06, 0.08, 0.95, M.black, s * (W / 2 + 0.02), r + spec.rw - 0.04, a));
    body.add(box(0.06, 0.08, 0.95, M.black, s * (W / 2 + 0.02), r + spec.rw - 0.04, -b));
    body.add(box(0.16, 0.08, 0.12, paintMat, s * (W / 2 + 0.08), 1.06, 0.45));
  }
  body.add(box(W * 0.98, 0.14, 0.1, M.black, 0, 0.3, zF - 0.02));
  body.add(box(W * 0.98, 0.14, 0.1, M.black, 0, 0.32, zR + 0.02));
  const ex = cyl(0.06, 0.25, M.chrome, 12);
  ex.rotation.y = Math.PI / 2;
  ex.position.set(-W * 0.3, 0.28, zR - 0.06);
  body.add(ex);
  body.add(box(W * 0.9, 0.08, 3.7, M.under, 0, 0.2, 0));
  return lights(body, M, {
    headZ: zF + 0.02, headY: 0.5, headW: 0.34, headX: W * 0.33,
    tailZ: zR - 0.03, tailY: 0.86, tailW: 0.22, tailX: W * 0.4, tailH: 0.14,
  });
}

// Public: build a complete car. Returns handles the game animates.
export function buildCarModel(type, color, opts = {}) {
  const def = CAR_DEFS[type];
  const spec = opts.spec || computeSpec(def);
  const M = mats();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paintMat = paint(color);
  let tailMat;
  let wheelOpts;
  if (type === 'sports') {
    tailMat = buildSports(body, spec, paintMat, def.width);
    wheelOpts = { tireWidth: 0.3, rimMat: new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.9, roughness: 0.3 }), caliper: M.caliperRed, spokes: 5 };
  } else if (type === 'truck') {
    tailMat = buildTruck(body, spec, paintMat, def.width);
    wheelOpts = { tireWidth: 0.36, rimMat: new THREE.MeshStandardMaterial({ color: 0x202224, metalness: 0.6, roughness: 0.5 }), caliper: null, spokes: 6, chunky: true };
  } else {
    tailMat = buildRally(body, spec, paintMat, def.width, opts.accent || 0x1555c0, opts.number ?? 7);
    wheelOpts = { tireWidth: 0.25, rimMat: new THREE.MeshStandardMaterial({ color: 0xf0f0f0, metalness: 0.5, roughness: 0.35 }), caliper: M.caliperGold, spokes: 6, chunky: false };
  }
  mergeByMaterial(body);
  const wheels = addWheels(root, spec, wheelOpts);
  // Only parts big enough to matter cast shadows (keeps the shadow pass cheap).
  root.traverse((o) => {
    if (o.isMesh) {
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      o.castShadow = o.geometry.boundingSphere.radius * Math.abs(o.scale.x) > 0.3;
      o.receiveShadow = false;
    }
  });
  return { root, body, wheels, paintMat, tailMat, type, spec };
}

export function setCarColor(model, color) {
  model.paintMat.color.set(color);
}

// Animate wheels / body from a physics Vehicle.
export function syncCarModel(model, car, dt) {
  const root = model.root;
  root.position.set(car.x, car.y, car.z);
  root.rotation.set(0, car.heading, 0);
  // Body attitude: terrain slope + weight-transfer squat/dive and body roll.
  const s = car.spec;
  const pitchTarget = -car.groundPitch - car.ax * 0.0045 * (s.h + 0.3);
  const rollTarget = -car.groundRoll - car.ay * 0.007 * (s.h + 0.2);
  const k = 1 - Math.exp(-dt * 10);
  model._pitch = (model._pitch ?? 0) + (pitchTarget - (model._pitch ?? 0)) * k;
  model._roll = (model._roll ?? 0) + (rollTarget - (model._roll ?? 0)) * k;
  model.body.rotation.set(model._pitch, 0, model._roll, 'YXZ');
  // Wheels touch the terrain under them.
  const H = car.wheelH;
  for (let i = 0; i < 4; i++) {
    const w = model.wheels[i];
    let off = H[i] - car.y;
    if (!car.grounded) off = Math.min(off, -s.susTravel);
    off = Math.max(-s.susTravel - 0.05, Math.min(0.25, off));
    w.pivot.position.y = w.baseY + off;
    w.spin.rotation.x = car.wheelRot;
    if (w.front) w.steer.rotation.y = -car.steer;
  }
  if (model.tailMat) model.tailMat.emissiveIntensity = car.controls.brake > 0.1 || (car.gear === -1 && car.controls.throttle > 0.1) ? 3 : 0.6;
}
