// Builds the 3D scene for a dirt race track from a RaceCore.
import * as THREE from './vendor/three.module.min.js';
import { RaceCore } from './raceCore.js';
import { buildTerrainMesh, buildRibbon, buildWall, PropGeo, instanced } from './worldRender.js';
import { terrainDetail, dirtTexture, stripeTexture, checkerTexture, bannerTexture, chevronTexture, crowdTexture, woodTexture } from './textures.js';
import { makeNoise2D, mulberry32, smoothstep, clamp } from './util.js';

const PALETTES = {
  desert: { low: [0.82, 0.68, 0.47], high: [0.74, 0.55, 0.36], slope: [0.66, 0.46, 0.3], verge: [0.78, 0.63, 0.43] },
  forest: { low: [0.33, 0.47, 0.22], high: [0.27, 0.4, 0.2], slope: [0.42, 0.4, 0.34], verge: [0.42, 0.42, 0.26] },
  canyon: { low: [0.78, 0.55, 0.38], high: [0.7, 0.36, 0.22], slope: [0.62, 0.3, 0.18], verge: [0.74, 0.52, 0.36] },
};

export function buildRaceWorld(def, quality) {
  const core = new RaceCore(def);
  const group = new THREE.Group();
  const p = core.path;
  const pal = PALETTES[def.theme];
  const noise = makeNoise2D(def.seed + 99);
  const heightAt = (x, z) => core.heightAt(x, z);

  // ---------------------------------------------------------------- terrain
  const colorFn = (x, z, h, slope) => {
    const d = core.distanceAt(x, z);
    const n = noise(x * 0.02, z * 0.02) * 0.5 + noise(x * 0.11, z * 0.11) * 0.2;
    let c = pal.low.slice();
    const t = clamp(0.5 + n, 0, 1);
    for (let k = 0; k < 3; k++) c[k] = c[k] * (1 - t * 0.4) + pal.high[k] * t * 0.4;
    if (def.theme === 'canyon') {
      // Horizontal rock strata on the canyon walls.
      const band = Math.sin(h * 0.9 + n * 2) * 0.5 + 0.5;
      const w = smoothstep(0.35, 0.9, slope);
      for (let k = 0; k < 3; k++) c[k] = c[k] * (1 - w) + (pal.slope[k] * (0.8 + band * 0.35)) * w;
    } else {
      const w = smoothstep(0.45, 1.0, slope);
      for (let k = 0; k < 3; k++) c[k] = c[k] * (1 - w) + pal.slope[k] * w;
    }
    // Worn verge next to the track.
    const v = 1 - smoothstep(core.barrier - 2, core.barrier + 8, d);
    for (let k = 0; k < 3; k++) c[k] = c[k] * (1 - v * 0.6) + pal.verge[k] * v * 0.6;
    return c;
  };
  group.add(buildTerrainMesh(core.hf, colorFn, terrainDetail(), 5));

  // ------------------------------------------------------------------ track
  const dirtMat = new THREE.MeshStandardMaterial({ map: dirtTexture(def.theme), roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  group.add(buildRibbon(p, { halfWidth: p.halfWidth + 0.8, heightAt, yOffset: 0.04, across: 6, material: dirtMat, vRepeat: 14, stride: 2 }));

  // Start / finish line.
  const lineMat = new THREE.MeshStandardMaterial({ map: checkerTexture(16, 2), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(p.width + 1.6, 2), lineMat);
  startLine.rotation.x = -Math.PI / 2;
  const h0 = Math.atan2(p.tx[0], p.tz[0]);
  const sl = new THREE.Group();
  sl.add(startLine);
  sl.position.set(p.x[0], heightAt(p.x[0], p.z[0]) + 0.07, p.z[0]);
  sl.rotation.y = h0;
  group.add(sl);

  // ---------------------------------------------------------------- barriers
  const wallMat = new THREE.MeshStandardMaterial({ map: stripeTexture('#d4202a', '#f4f4f4'), roughness: 0.6, side: THREE.DoubleSide });
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.9, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    group.add(buildWall(p, { lateral: side * (core.barrier + 0.3), height: 0.75, heightAt, material: def.theme === 'forest' ? woodMat : wallMat, stride: 2, vRepeat: 3 }));
  }
  // Posts every few metres and tyre stacks on the outside of fast corners.
  const posts = [];
  const tires = [];
  const chevrons = [];
  for (let i = 0; i < p.n; i += 5) {
    for (const side of [-1, 1]) {
      const lat = side * (core.barrier + 0.45);
      const x = p.x[i] + p.nx[i] * lat;
      const z = p.z[i] + p.nz[i] * lat;
      posts.push({ x, y: heightAt(x, z), z, s: 1 });
    }
  }
  for (let i = 0; i < p.n; i += 3) {
    const k = p.curv[i];
    if (Math.abs(k) > 1 / 60) {
      const side = k > 0 ? -1 : 1; // outside of the corner
      const lat = side * (core.barrier + 1.1);
      const x = p.x[i] + p.nx[i] * lat;
      const z = p.z[i] + p.nz[i] * lat;
      tires.push({ x, y: heightAt(x, z), z, s: 1, r: i });
      if (i % 12 === 0 && Math.abs(k) > 1 / 40) chevrons.push({ i, side, k });
    }
  }
  const postGeo = new THREE.BoxGeometry(0.12, 1.1, 0.12).translate(0, 0.45, 0);
  const postMesh = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.7 }), posts.length);
  const m4 = new THREE.Matrix4();
  posts.forEach((q, i) => postMesh.setMatrixAt(i, m4.makeTranslation(q.x, q.y, q.z)));
  postMesh.castShadow = quality === 'high';
  group.add(postMesh);
  if (tires.length) group.add(instanced(PropGeo.tire(), tires, { castShadow: quality === 'high' }));

  // Chevron boards on the outside of tight corners.
  const chevMat = new THREE.MeshStandardMaterial({ map: chevronTexture(), roughness: 0.6 });
  const chevGeo = new THREE.PlaneGeometry(2.4, 0.6);
  for (const c of chevrons) {
    const i = c.i;
    const lat = c.side * (core.barrier + 1.9);
    const x = p.x[i] + p.nx[i] * lat;
    const z = p.z[i] + p.nz[i] * lat;
    const board = new THREE.Mesh(chevGeo, chevMat);
    board.position.set(x, heightAt(x, z) + 1.3, z);
    // Face oncoming traffic, arrows point the way the road turns.
    const head = Math.atan2(p.tx[i], p.tz[i]);
    board.rotation.y = head + Math.PI;
    if (c.k < 0) board.scale.x = -1;
    group.add(board);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), postMesh.material);
      leg.position.set(x + Math.cos(head) * s * 0.9, heightAt(x, z) + 0.7, z - Math.sin(head) * s * 0.9);
      group.add(leg);
    }
  }

  // ------------------------------------------------------- start gantry
  const gantry = new THREE.Group();
  const span = p.width + 6;
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.6, roughness: 0.4 });
  for (const s of [-1, 1]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), pillarMat);
    pil.position.set((s * span) / 2, 3.5, 0);
    gantry.add(pil);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(span + 0.6, 1.6, 0.3), [
    pillarMat, pillarMat, pillarMat, pillarMat,
    new THREE.MeshStandardMaterial({ map: bannerTexture('FINISH'), roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ map: bannerTexture('TILT RACER'), roughness: 0.5 }),
  ]);
  banner.position.y = 7;
  gantry.add(banner);
  gantry.position.set(p.x[0], heightAt(p.x[0], p.z[0]) - 0.2, p.z[0]);
  gantry.rotation.y = h0 + Math.PI;
  gantry.traverse((o) => o.isMesh && (o.castShadow = true));
  group.add(gantry);

  // ------------------------------------------------------- grandstand
  const gs = new THREE.Group();
  const standLen = 40;
  const crowd = new THREE.MeshStandardMaterial({ map: crowdTexture(), roughness: 0.9 });
  crowd.map.repeat.set(4, 1);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.9 });
  for (let r = 0; r < 5; r++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(standLen, 0.8 + r * 0.8, 1.6), [concrete, concrete, crowd, concrete, crowd, concrete]);
    step.position.set(0, (0.8 + r * 0.8) / 2, -r * 1.6);
    gs.add(step);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(standLen + 2, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0xc23030, roughness: 0.6 }));
  roof.position.set(0, 7.2, -3.4);
  gs.add(roof);
  for (const s of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7.2, 0.4), pillarMat);
    col.position.set((s * standLen) / 2, 3.6, -7.5);
    gs.add(col);
  }
  const gsI = p.idx(25);
  const gsLat = -(core.barrier + 9);
  gs.position.set(p.x[gsI] + p.nx[gsI] * gsLat, heightAt(p.x[gsI] + p.nx[gsI] * gsLat, p.z[gsI] + p.nz[gsI] * gsLat) - 0.3, p.z[gsI] + p.nz[gsI] * gsLat);
  gs.rotation.y = Math.atan2(p.tx[gsI], p.tz[gsI]) - Math.PI / 2;
  gs.traverse((o) => o.isMesh && ((o.castShadow = true), (o.receiveShadow = true)));
  group.add(gs);

  // Flags along the start straight.
  const flagCols = [0xe53935, 0xfdd835, 0x1e88e5, 0x43a047, 0xffffff];
  for (let k = 0; k < 10; k++) {
    const i = p.idx(-40 + k * 9);
    const side = k % 2 ? 1 : -1;
    const lat = side * (core.barrier + 3);
    const x = p.x[i] + p.nx[i] * lat;
    const z = p.z[i] + p.nz[i] * lat;
    const y = heightAt(x, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6, 6), pillarMat);
    pole.position.set(x, y + 3, z);
    group.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1), new THREE.MeshStandardMaterial({ color: flagCols[k % flagCols.length], side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(x + 0.8, y + 5.4, z);
    flag.userData.flag = true;
    group.add(flag);
  }

  // ------------------------------------------------------- scenery scatter
  const rand = mulberry32(def.seed * 13);
  const b = core.bounds;
  const trees = [];
  const trees2 = [];
  const rocks = [];
  const bushes = [];
  const hay = [];
  const density = quality === 'low' ? 0.45 : quality === 'medium' ? 0.75 : 1;
  const tries = (def.theme === 'forest' ? 9000 : 4500) * density;
  for (let t = 0; t < tries; t++) {
    const x = b.minX + 20 + rand() * (b.size - 40);
    const z = b.minZ + 20 + rand() * (b.size - 40);
    const d = core.distanceAt(x, z);
    if (d < core.barrier + 6) continue;
    // Keep the grandstand area clear.
    if (Math.hypot(x - gs.position.x, z - gs.position.z) < 35) continue;
    const y = heightAt(x, z) - 0.15;
    const s = 0.7 + rand() * 0.8;
    const r = rand() * Math.PI * 2;
    if (def.theme === 'forest') {
      if (d > 260) continue;
      if (rand() < 0.75) trees.push({ x, y, z, s: s * 1.2, r });
      else trees2.push({ x, y, z, s, r });
    } else if (def.theme === 'desert') {
      if (d > 220) continue;
      const k = rand();
      if (k < 0.25) trees.push({ x, y, z, s, r });
      else if (k < 0.55) bushes.push({ x, y, z, s: s * 0.8, r });
      else if (k < 0.65) rocks.push({ x, y, z, s: s * 1.4, r });
    } else {
      if (d > 200) continue;
      const k = rand();
      if (k < 0.45) rocks.push({ x, y, z, s: s * (1 + rand() * 2.5), r, rx: rand(), rz: rand() });
      else if (k < 0.75) bushes.push({ x, y, z, s: s * 0.7, r });
      else if (k < 0.8) trees.push({ x, y, z, s, r });
    }
  }
  // Hay bales stacked behind the barrier on corner exits.
  for (let i = 0; i < p.n; i += 7) {
    if (Math.abs(p.curv[i]) > 1 / 50 && rand() < 0.5) {
      const side = p.curv[i] > 0 ? -1 : 1;
      const lat = side * (core.barrier + 3.2);
      const x = p.x[i] + p.nx[i] * lat;
      const z = p.z[i] + p.nz[i] * lat;
      hay.push({ x, y: heightAt(x, z) - 0.05, z, s: 1, r: Math.atan2(p.tx[i], p.tz[i]) });
    }
  }
  const castTrees = quality === 'high';
  if (def.theme === 'forest') {
    if (trees.length) group.add(instanced(PropGeo.pine(), trees, { castShadow: castTrees, seed: 2 }));
    if (trees2.length) group.add(instanced(PropGeo.broadleaf(), trees2, { castShadow: castTrees, seed: 3 }));
  } else if (trees.length) group.add(instanced(PropGeo.cactus(), trees, { castShadow: castTrees, seed: 4 }));
  if (rocks.length) group.add(instanced(PropGeo.rock(def.theme === 'canyon' ? 0xa0583a : 0x9a8a70), rocks, { castShadow: castTrees, seed: 5 }));
  if (bushes.length) group.add(instanced(PropGeo.bush(def.theme === 'desert' ? 0x8a8a4a : 0x6a6a3a), bushes, { castShadow: false, seed: 6 }));
  if (hay.length) group.add(instanced(PropGeo.hay(), hay, { castShadow: castTrees, seed: 7 }));

  return { core, group, minimap: buildMinimap(core) };
}

function buildMinimap(core) {
  const p = core.path;
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
  const pad = 30;
  const size = Math.max(maxX - minX, maxZ - minZ) + pad * 2;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return {
    kind: 'track',
    minX: cx - size / 2,
    minZ: cz - size / 2,
    size,
    draw(ctx, S) {
      const sc = S / size;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const path = () => {
        ctx.beginPath();
        for (let i = 0; i <= p.n; i += 3) {
          const j = i % p.n;
          const x = (p.x[j] - (cx - size / 2)) * sc;
          const y = (p.z[j] - (cz - size / 2)) * sc;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      };
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(5, p.width * sc + 4);
      path();
      ctx.stroke();
      ctx.strokeStyle = '#e9d2a8';
      ctx.lineWidth = Math.max(3, p.width * sc);
      path();
      ctx.stroke();
      // Start line.
      const x0 = (p.x[0] - (cx - size / 2)) * sc;
      const y0 = (p.z[0] - (cz - size / 2)) * sc;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x0 - 3, y0 - 3, 6, 6);
    },
  };
}
