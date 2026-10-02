// Sky dome, sun + hemisphere lighting with a shadow camera that follows the
// player, image-based reflections and decorative clouds.
import * as THREE from './vendor/three.module.min.js';
import { cloudTexture } from './textures.js';
import { mulberry32 } from './util.js';

export const SKY_PRESETS = {
  day: { top: 0x2f6fc0, horizon: 0xbfd6ea, ground: 0x6d6a5e, sun: 0xfff1d6, sunIntensity: 3.0, hemi: 0.9, fog: 0xc4d6e6 },
  desert: { top: 0x3a7ccc, horizon: 0xe8d9bf, ground: 0x9c8462, sun: 0xfff0d2, sunIntensity: 3.2, hemi: 0.95, fog: 0xe6d8c0 },
  forest: { top: 0x3b6fae, horizon: 0xc6d8e2, ground: 0x4c5a3a, sun: 0xfff2dc, sunIntensity: 2.8, hemi: 0.85, fog: 0xbfd0d8 },
  canyon: { top: 0x356ab8, horizon: 0xf0cfae, ground: 0x8a5a3c, sun: 0xffe7c8, sunIntensity: 3.2, hemi: 0.9, fog: 0xe9c9a8 },
};

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const skyFrag = /* glsl */ `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 ground;
uniform vec3 sunDir;
uniform vec3 sunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, pow(min(-h * 4.0, 1.0), 0.6));
  float sd = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * (pow(sd, 900.0) * 18.0 + pow(sd, 24.0) * 0.35 + pow(sd, 4.0) * 0.08);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSky(preset, sunDir) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    uniforms: {
      top: { value: new THREE.Color(preset.top) },
      horizon: { value: new THREE.Color(preset.horizon) },
      ground: { value: new THREE.Color(preset.ground) },
      sunDir: { value: sunDir.clone() },
      sunColor: { value: new THREE.Color(preset.sun) },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// Prefiltered environment map so paint and glass reflect the sky.
export function createEnvMap(renderer, preset, sunDir) {
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const sky = createSky(preset, sunDir);
  sky.scale.setScalar(0.05);
  envScene.add(sky);
  const groundMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(preset.ground).multiplyScalar(0.6), side: THREE.DoubleSide });
  const g = new THREE.Mesh(new THREE.CircleGeometry(40, 24), groundMat);
  g.rotation.x = -Math.PI / 2;
  g.position.y = -2;
  envScene.add(g);
  const rt = pm.fromScene(envScene, 0.02, 0.1, 100);
  pm.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  g.geometry.dispose();
  groundMat.dispose();
  return rt.texture;
}

export class Lighting {
  constructor(scene, preset, sunDir, quality) {
    this.sunDir = sunDir.clone().normalize();
    this.hemi = new THREE.HemisphereLight(preset.horizon, preset.ground, preset.hemi);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(preset.sun, preset.sunIntensity);
    this.sun.castShadow = quality !== 'low';
    const size = quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(size, size);
    const ext = quality === 'high' ? 55 : 45;
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 10;
    cam.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.ext = ext;
    this.size = size;
    scene.add(this.sun);
    scene.add(this.sun.target);
  }

  follow(x, y, z) {
    // Snap to shadow texels to stop shimmering while driving.
    const texel = (this.ext * 2) / this.size;
    const sx = Math.round(x / texel) * texel;
    const sz = Math.round(z / texel) * texel;
    this.sun.target.position.set(sx, y, sz);
    this.sun.position.set(sx + this.sunDir.x * 250, y + this.sunDir.y * 250, sz + this.sunDir.z * 250);
    this.sun.target.updateMatrixWorld();
  }
}

export function createClouds(count, radius, seed = 3) {
  const group = new THREE.Group();
  const tex = cloudTexture();
  const rand = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.55 + rand() * 0.35 });
    const s = new THREE.Sprite(mat);
    const a = rand() * Math.PI * 2;
    const r = radius * (0.3 + rand() * 0.7);
    s.position.set(Math.cos(a) * r, 260 + rand() * 160, Math.sin(a) * r);
    const sc = 180 + rand() * 260;
    s.scale.set(sc, sc * 0.45, 1);
    group.add(s);
  }
  return group;
}
