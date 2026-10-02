// Builds the 3D scene for the free-roam map from a FreeRoamCore.
import * as THREE from './vendor/three.module.min.js';
import { FreeRoamCore, LAKE, TOWN, QUARRY } from './freeRoamCore.js';
import { buildTerrainMesh, buildRibbon, PropGeo, instanced } from './worldRender.js';
import { terrainDetail, asphaltTexture, plainAsphaltTexture, dirtTexture, windowsTexture } from './textures.js';
import { SURF } from './physics.js';
import { makeNoise2D, smoothstep } from './util.js';

export function buildFreeRoamWorld(quality) {
  const density = quality === 'low' ? 0.45 : quality === 'medium' ? 0.75 : 1;
  const core = new FreeRoamCore(density);
  const group = new THREE.Group();
  const noise = makeNoise2D(404);
  const heightAt = (x, z) => core.hf.heightAt(x, z);

  // ---------------------------------------------------------------- terrain
  const grassA = [0.36, 0.5, 0.22];
  const grassB = [0.47, 0.56, 0.27];
  const forest = [0.24, 0.37, 0.17];
  const rock = [0.5, 0.48, 0.45];
  const sand = [0.83, 0.75, 0.56];
  const snow = [0.95, 0.96, 0.98];
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const colorFn = (x, z, h, slope) => {
    const n = noise(x * 0.008, z * 0.008) * 0.5 + 0.5;
    const n2 = noise(x * 0.05, z * 0.05) * 0.5 + 0.5;
    let c = mix(grassA, grassB, n * 0.8 + n2 * 0.2);
    const f = smoothstep(150, 40, Math.hypot(x - 230, z + 230));
    c = mix(c, forest, f * 0.7);
    const s = core.surf.get(x, z);
    if (s === SURF.SAND) c = mix(c, sand, 0.9);
    if (s === SURF.WATER) c = [0.36, 0.33, 0.25];
    // Dry patches near the quarry.
    c = mix(c, sand, smoothstep(QUARRY.r + 50, QUARRY.r, Math.hypot(x - QUARRY.x, z - QUARRY.z)) * 0.8);
    // Town: trampled grass / gravel.
    c = mix(c, [0.48, 0.47, 0.4], smoothstep(TOWN.r, TOWN.r - 60, Math.hypot(x - TOWN.x, z - TOWN.z)) * 0.55);
    c = mix(c, rock, smoothstep(0.5, 1.0, slope));
    c = mix(c, rock, smoothstep(55, 80, h) * 0.8);
    c = mix(c, snow, smoothstep(110, 135, h + n2 * 10));
    return c;
  };
  group.add(buildTerrainMesh(core.hf, colorFn, terrainDetail(), 6));

  // ------------------------------------------------------------------- roads
  const asphalt = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const plain = new THREE.MeshStandardMaterial({ map: plainAsphaltTexture(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const dirtMat = new THREE.MeshStandardMaterial({ map: dirtTexture('forest'), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const order = { airfield: 0, trail: 1, spur: 1, quarryLink: 1, ring: 2, ns: 3, main: 4 };
  for (const road of core.roads) {
    const mat = road.plain ? plain : road.surface === SURF.DIRT ? dirtMat : asphalt.clone();
    if (!road.plain && road.surface !== SURF.DIRT) {
      mat.polygonOffsetFactor = -2 - order[road.id];
      mat.polygonOffsetUnits = -2 - order[road.id];
    }
    if (road.plain) mat.map.repeat.set(1, 1);
    const mesh = buildRibbon(road.path, {
      halfWidth: road.width / 2 + (road.surface === SURF.DIRT ? 0.6 : 0.3),
      heightAt,
      yOffset: 0.05 + order[road.id] * 0.01,
      across: road.width > 20 ? 8 : 4,
      material: mat,
      vRepeat: road.plain ? 20 : road.surface === SURF.DIRT ? 12 : 14,
      stride: 2,
    });
    mesh.renderOrder = order[road.id];
    group.add(mesh);
  }

  // ------------------------------------------------------------------- lake
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(LAKE.r + 70, 48),
    new THREE.MeshStandardMaterial({ color: 0x2a6a86, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.86, envMapIntensity: 1.4 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(LAKE.x, core.waterLevel, LAKE.z);
  water.receiveShadow = true;
  group.add(water);

  // -------------------------------------------------------------- buildings
  const wallMats = [0, 1, 2, 3].map((k) => new THREE.MeshStandardMaterial({ map: windowsTexture(k + 1, [[196, 190, 178], [170, 182, 196], [204, 178, 150], [180, 180, 186]][k]), roughness: 0.8 }));
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x55575c, roughness: 0.9 });
  const houseWall = new THREE.MeshStandardMaterial({ color: 0xe9e1d0, roughness: 0.9 });
  const houseRoofs = [0x9c3b2c, 0x5d4a3d, 0x3d4f66, 0x7a2f2a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, flatShading: true }));
  for (const b of core.buildings) {
    let mesh;
    if (b.kind === 'house') {
      mesh = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), houseWall);
      body.position.y = b.h / 2;
      mesh.add(body);
      const shape = new THREE.Shape();
      shape.moveTo(-b.d / 2 - 0.5, 0);
      shape.lineTo(b.d / 2 + 0.5, 0);
      shape.lineTo(0, b.d * 0.38);
      shape.closePath();
      const rg = new THREE.ExtrudeGeometry(shape, { depth: b.w + 0.6, bevelEnabled: false });
      rg.translate(0, 0, -(b.w + 0.6) / 2);
      rg.rotateY(Math.PI / 2);
      const roof = new THREE.Mesh(rg, houseRoofs[b.seed]);
      roof.position.y = b.h;
      mesh.add(roof);
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.1), roofMat);
      door.position.set(0, 1.1, b.d / 2 + 0.03);
      mesh.add(door);
    } else {
      const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
      // Scale UVs so windows keep a real-world size (4 m x 3.5 m tiles).
      const uv = geo.attributes.uv;
      for (let f = 0; f < 6; f++) {
        const su = f < 2 ? b.d / 16 : b.w / 16;
        const sv = f === 2 || f === 3 ? b.d / 14 : b.h / 14;
        for (let k = 0; k < 4; k++) {
          const i = f * 4 + k;
          uv.setXY(i, uv.getX(i) * su * 4, uv.getY(i) * sv * 4);
        }
      }
      const wm = wallMats[b.seed];
      mesh = new THREE.Mesh(geo, [wm, wm, roofMat, roofMat, wm, wm]);
      mesh.geometry.translate(0, b.h / 2, 0);
    }
    mesh.position.set(b.x, b.y - 0.3, b.z);
    mesh.rotation.y = b.angle + Math.PI / 2;
    mesh.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    group.add(mesh);
  }

  // ------------------------------------------------------------ vegetation
  const castTrees = quality === 'high';
  const pines = core.trees.filter((t) => t.kind === 'pine');
  const broads = core.trees.filter((t) => t.kind !== 'pine');
  if (pines.length) group.add(instanced(PropGeo.pine(), pines, { castShadow: castTrees, seed: 11 }));
  if (broads.length) group.add(instanced(PropGeo.broadleaf(), broads, { castShadow: castTrees, seed: 12 }));
  if (core.rocks.length) group.add(instanced(PropGeo.rock(0x8c8780), core.rocks, { castShadow: castTrees, seed: 13 }));
  if (core.bushes.length) group.add(instanced(PropGeo.bush(0x557a30), core.bushes, { castShadow: false, seed: 14 }));

  // Street lamps.
  if (core.lamps.length) {
    const lampGeo = new THREE.CylinderGeometry(0.08, 0.12, 7, 6).translate(0, 3.5, 0);
    const armGeo = new THREE.BoxGeometry(0.1, 0.1, 1.6).translate(0, 7, 0.7);
    const headGeo = new THREE.BoxGeometry(0.35, 0.15, 0.6).translate(0, 6.9, 1.4);
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.7, roughness: 0.4 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 0.6 });
    const n = core.lamps.length;
    const poles = new THREE.InstancedMesh(lampGeo, metal, n);
    const arms = new THREE.InstancedMesh(armGeo, metal, n);
    const heads = new THREE.InstancedMesh(headGeo, glow, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    core.lamps.forEach((l, i) => {
      // Arm reaches over the road.
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.heading + (l.side > 0 ? Math.PI / 2 : -Math.PI / 2));
      m.compose(new THREE.Vector3(l.x, l.y - 0.1, l.z), q, one);
      poles.setMatrixAt(i, m);
      arms.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
    });
    poles.castShadow = arms.castShadow = true;
    group.add(poles, arms, heads);
  }

  // ---------------------------------------------------------------- ramps
  const rampMat = new THREE.MeshStandardMaterial({ map: dirtTexture('desert'), roughness: 0.95, side: THREE.DoubleSide });
  for (const rp of core.ramps) {
    const segL = 24;
    const segW = 6;
    const g = new THREE.BufferGeometry();
    const pos = [];
    const uvs = [];
    const side = rp.width / 2 + 1.2;
    const fx = rp.s;
    const fz = rp.c;
    const rx = -rp.c;
    const rz = rp.s;
    for (let i = 0; i <= segL; i++) {
      const lf = (i / segL) * rp.len - rp.len / 2;
      for (let j = 0; j <= segW; j++) {
        const ll = -side + (2 * side * j) / segW;
        const x = rp.x + fx * lf + rx * ll;
        const z = rp.z + fz * lf + rz * ll;
        pos.push(x, core.heightAt(x, z) + 0.03, z);
        uvs.push(j / segW, (i / segL) * rp.len * 0.25);
      }
    }
    const idx = [];
    for (let i = 0; i < segL; i++)
      for (let j = 0; j < segW; j++) {
        const a = i * (segW + 1) + j;
        const b = a + 1;
        const c = a + segW + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, rampMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    // Hazard boards at the lip.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(rp.width, 0.08, 0.3), new THREE.MeshStandardMaterial({ color: 0xffc400, roughness: 0.6 }));
    const lf = rp.up - rp.len / 2;
    const lx = rp.x + fx * lf;
    const lz = rp.z + fz * lf;
    lip.position.set(lx, core.heightAt(lx, lz) + 0.05, lz);
    lip.rotation.y = rp.yaw;
    group.add(lip);
  }

  // --------------------------------------------------------------- pickups
  const coinGeo = new THREE.CylinderGeometry(0.75, 0.75, 0.16, 24);
  coinGeo.rotateX(Math.PI / 2);
  const coinMat = new THREE.MeshStandardMaterial({ color: 0xffc400, metalness: 1, roughness: 0.25, emissive: 0x6a4a00, emissiveIntensity: 0.5 });
  const bonusMat = new THREE.MeshStandardMaterial({ color: 0x40e0ff, metalness: 0.8, roughness: 0.2, emissive: 0x0a5a80, emissiveIntensity: 0.8 });
  const coins = [];
  for (const pk of core.pickups) {
    const m = new THREE.Mesh(coinGeo, pk.bonus ? bonusMat : coinMat);
    m.position.set(pk.x, pk.y, pk.z);
    if (pk.bonus) m.scale.setScalar(1.6);
    m.castShadow = true;
    group.add(m);
    coins.push(m);
  }

  return {
    core,
    group,
    coins,
    minimap: buildMinimap(core),
    update(t) {
      for (let i = 0; i < coins.length; i++) {
        const pk = core.pickups[i];
        coins[i].visible = !pk.taken;
        coins[i].rotation.y = t * 2.5 + i;
        coins[i].position.y = pk.y + Math.sin(t * 2 + i) * 0.15;
      }
    },
  };
}

function buildMinimap(core) {
  return {
    kind: 'map',
    minX: -800,
    minZ: -800,
    size: 1600,
    draw(ctx, S) {
      const sc = S / 1600;
      const X = (x) => (x + 800) * sc;
      ctx.fillStyle = '#4e6b3a';
      ctx.fillRect(0, 0, S, S);
      // Mountains edge.
      ctx.strokeStyle = 'rgba(120,110,100,0.9)';
      ctx.lineWidth = 200 * sc;
      ctx.strokeRect(0, 0, S, S);
      ctx.fillStyle = '#d8c690';
      ctx.beginPath();
      ctx.arc(X(QUARRY.x), X(QUARRY.z), QUARRY.r * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3f86b0';
      ctx.beginPath();
      ctx.arc(X(LAKE.x), X(LAKE.z), LAKE.r * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(200,200,200,0.35)';
      ctx.beginPath();
      ctx.arc(X(TOWN.x), X(TOWN.z), TOWN.r * 0.9 * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const road of core.roads) {
        const p = road.path;
        ctx.strokeStyle = road.surface === SURF.DIRT ? '#c9a46e' : '#e8e8e8';
        ctx.lineWidth = Math.max(2, road.width * sc * 1.4);
        ctx.beginPath();
        for (let i = 0; i < p.n; i += 4) {
          if (i === 0) ctx.moveTo(X(p.x[i]), X(p.z[i]));
          else ctx.lineTo(X(p.x[i]), X(p.z[i]));
        }
        if (p.closed) ctx.closePath();
        else ctx.lineTo(X(p.x[p.n - 1]), X(p.z[p.n - 1]));
        ctx.stroke();
      }
      ctx.fillStyle = '#ffcf33';
      for (const rp of core.ramps) ctx.fillRect(X(rp.x) - 2, X(rp.z) - 2, 4, 4);
    },
  };
}
