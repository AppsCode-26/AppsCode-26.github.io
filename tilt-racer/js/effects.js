// Dust / smoke particles and tyre skid marks.
import * as THREE from './vendor/three.module.min.js';

const dustVert = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = min(aSize * uScale / max(dist, 0.5), 480.0);
  // Fade particles right in front of the lens so they never fill the screen.
  vAlpha = aAlpha * smoothstep(0.8, 4.0, dist);
  vColor = aColor;
}`;

const dustFrag = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.1, d) * vAlpha;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}`;

export class Dust {
  constructor(scene, max = 700) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: dustVert,
      fragmentShader: dustFrag,
      uniforms: { uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.geometry = g;
    scene.add(this.points);
  }

  setScale(viewportHeight, fovDeg) {
    this.material.uniforms.uScale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(x, y, z, vx, vy, vz, size, color, life, alpha = 0.5, grow = 1.5) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.size[i] = size;
    this.grow[i] = grow;
    this.alpha0[i] = alpha;
    this.alpha[i] = alpha;
    this.color[i * 3] = color[0];
    this.color[i * 3 + 1] = color[1];
    this.color[i * 3 + 2] = color[2];
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt) {
    const damp = Math.exp(-dt * 1.8);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k] *= damp;
      this.vel[k + 1] = this.vel[k + 1] * damp + dt * 0.4;
      this.vel[k + 2] *= damp;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = this.alpha0[i] * Math.min(1, t * 1.6) * Math.min(1, (1 - t) * 8);
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class SkidMarks {
  constructor(scene, maxQuads = 1600) {
    this.max = maxQuads;
    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.col = new Float32Array(maxQuads * 4 * 4);
    const idx = new Uint32Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const v = q * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], q * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.geometry = g;
    this.next = 0;
    this.last = new Map();
    this.dirty = false;
    scene.add(this.mesh);
  }

  // Add a mark segment for a tyre identified by `key`.
  add(key, x, y, z, width, color, alpha) {
    const prev = this.last.get(key);
    if (!prev) {
      this.last.set(key, { x, y, z, l: null });
      return;
    }
    const dx = x - prev.x;
    const dz = z - prev.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.35) return;
    if (d > 4) {
      this.last.set(key, { x, y, z, l: null });
      return;
    }
    const px = (-dz / d) * width * 0.5;
    const pz = (dx / d) * width * 0.5;
    const q = this.next;
    this.next = (this.next + 1) % this.max;
    const p = this.pos;
    const o = q * 12;
    const lift = 0.04;
    const l = prev.l || [prev.x - px, prev.y + lift, prev.z - pz, prev.x + px, prev.y + lift, prev.z + pz];
    p[o] = l[0];
    p[o + 1] = l[1];
    p[o + 2] = l[2];
    p[o + 3] = l[3];
    p[o + 4] = l[4];
    p[o + 5] = l[5];
    p[o + 6] = x - px;
    p[o + 7] = y + lift;
    p[o + 8] = z - pz;
    p[o + 9] = x + px;
    p[o + 10] = y + lift;
    p[o + 11] = z + pz;
    const c = this.col;
    const co = q * 16;
    const a0 = prev.a ?? alpha;
    for (let k = 0; k < 4; k++) {
      c[co + k * 4] = color[0];
      c[co + k * 4 + 1] = color[1];
      c[co + k * 4 + 2] = color[2];
      c[co + k * 4 + 3] = k < 2 ? a0 : alpha;
    }
    this.last.set(key, { x, y, z, a: alpha, l: [x - px, y + lift, z - pz, x + px, y + lift, z + pz] });
    this.dirty = true;
  }

  lift(key) {
    this.last.delete(key);
  }

  update() {
    if (!this.dirty) return;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.dirty = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
