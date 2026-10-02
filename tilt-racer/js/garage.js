// 3D showroom used behind the menus and in the garage.
import * as THREE from './vendor/three.module.min.js';
import { buildCarModel } from './carModels.js';
import { disposeObject } from './worldRender.js';

function studioEnv(renderer) {
  const pm = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(30, 14, 30), new THREE.MeshBasicMaterial({ color: 0x15171c, side: THREE.BackSide }));
  room.add(walls);
  const panel = (w, h, x, y, z, ry, rx, intensity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    room.add(m);
  };
  panel(14, 3, 0, 6.9, 0, 0, Math.PI / 2, 6); // big overhead softbox
  panel(3, 8, -14.9, 3, 0, Math.PI / 2, 0, 2.5);
  panel(3, 8, 14.9, 3, 0, -Math.PI / 2, 0, 2.5);
  panel(10, 2, 0, 3, -14.9, 0, 0, 1.6);
  panel(10, 2, 0, 2, 14.9, Math.PI, 0, 1.2);
  const tex = pm.fromScene(room, 0.03).texture;
  pm.dispose();
  disposeObject(room);
  return tex;
}

export class GarageScene {
  constructor(renderer) {
    this.renderer = renderer;
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x0c0e13);
    scene.fog = new THREE.Fog(0x0c0e13, 14, 34);
    scene.environment = studioEnv(renderer);
    scene.environmentIntensity = 0.9;
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.4 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.table = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.8, 0.14, 64), new THREE.MeshStandardMaterial({ color: 0x2a2e37, metalness: 0.7, roughness: 0.35 }));
    disc.position.y = 0.07;
    disc.receiveShadow = true;
    this.table.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.75, 0.035, 8, 96), new THREE.MeshStandardMaterial({ color: 0xffb300, emissive: 0xffa000, emissiveIntensity: 2 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.14;
    this.table.add(ring);
    scene.add(this.table);

    const key = new THREE.SpotLight(0xffffff, 260, 30, 0.6, 0.6, 1.4);
    key.position.set(3, 9, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    scene.add(key);
    const rimL = new THREE.SpotLight(0x5aa0ff, 45, 25, 0.5, 0.8, 1.5);
    rimL.position.set(-7, 4, -6);
    rimL.target.position.set(0, 0.8, 0);
    scene.add(rimL.target);
    scene.add(rimL);
    const rimR = new THREE.SpotLight(0xff8a3c, 40, 25, 0.5, 0.8, 1.5);
    rimR.position.set(7, 4, -5);
    rimR.target.position.set(0, 0.8, 0);
    scene.add(rimR.target);
    scene.add(rimR);
    scene.add(new THREE.HemisphereLight(0x8090a0, 0x101010, 0.4));

    this.model = null;
    this.angle = 0.6;
    this.spin = 0.25;
    this.dragging = false;
    this.t = 0;
    this.offsetX = 0;
  }

  // Drag horizontally to spin the turntable.
  startDrag(x) {
    this.dragging = true;
    this._lastX = x;
  }

  drag(x) {
    if (!this.dragging) return;
    this.angle += (x - this._lastX) * 0.01;
    this._lastX = x;
  }

  endDrag() {
    this.dragging = false;
  }

  setCar(type, color, spec) {
    if (this.model) {
      this.table.remove(this.model.root);
      disposeObject(this.model.root);
    }
    this.model = buildCarModel(type, color, { spec, number: 7 });
    this.model.root.position.y = 0.14;
    this.table.add(this.model.root);
    this.type = type;
  }

  setColor(color) {
    if (this.model) this.model.paintMat.color.set(color);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt, mode) {
    this.t += dt;
    if (!this.dragging) this.angle += dt * this.spin;
    this.table.rotation.y = this.angle;
    const cam = this.camera;
    const wide = cam.aspect > 1.2;
    const dist = mode === 'garage' ? (wide ? 18 : 21) : wide ? 15 : 18;
    const lookY = 0.8;
    cam.position.set(Math.sin(0.5) * dist, 3.2 + Math.sin(this.t * 0.3) * 0.2, Math.cos(0.5) * dist);
    cam.lookAt(0, lookY, 0);
    // Shift the view so the car sits between the side panels.
    const portrait = cam.aspect < 1;
    const offY = mode === 'menu' ? (portrait ? 230 : 110) : portrait ? 270 : 0;
    cam.setViewOffset(1000, 1000, this.offsetX, offY, 1000, 1000);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
