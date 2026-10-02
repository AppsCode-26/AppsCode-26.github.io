// Tilt Racer — app controller: screens, game sessions, camera, HUD.
import * as THREE from './vendor/three.module.min.js';
import { save, persist, resetProgress } from './save.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { CAR_DEFS, CAR_ORDER, computeSpec, ratings, UPGRADES, UPGRADE_KEYS, UPGRADE_MAX, upgradeCost } from './cars.js';
import { Vehicle, collideVehicles, SURFACE_INFO, SURF } from './physics.js';
import { buildCarModel, syncCarModel } from './carModels.js';
import { SKY_PRESETS, createSky, createEnvMap, Lighting, createClouds } from './environment.js';
import { buildFreeRoamWorld } from './freeRoamWorld.js';
import { buildRaceWorld } from './raceWorld.js';
import { TRACKS } from './trackData.js';
import { TrackPath } from './trackPath.js';
import { AIDriver } from './ai.js';
import { Dust, SkidMarks } from './effects.js';
import { GarageScene } from './garage.js';
import { setMaxAnisotropy } from './textures.js';
import { disposeObject } from './worldRender.js';
import { clamp, damp, lerp, formatTime, mulberry32 } from './util.js';

const $ = (id) => document.getElementById(id);
const settings = save.settings;
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// ------------------------------------------------------------------ renderer
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

function quality() {
  if (settings.quality !== 'auto') return settings.quality;
  return isTouch ? 'medium' : 'high';
}

// Dynamic resolution (Graphics: Auto only).
let dynScale = 1;
let frameAvg = 16.7;
let scaleCooldown = 3;
let stepAvg = 0;
function applyPixelRatio() {
  const q = quality();
  const cap = q === 'low' ? 1 : q === 'medium' ? 1.5 : 2;
  const s = settings.quality === 'auto' ? dynScale : 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap) * s);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
function resetDynamicResolution() {
  dynScale = 1;
  frameAvg = 16.7;
  scaleCooldown = 3;
  stepAvg = 0;
  applyPixelRatio();
}

const input = new Input(settings);
const audio = new AudioEngine();
audio.volume = settings.volume;
const garage = new GarageScene(renderer);
let session = null;
let screen = 'title';
let paused = false;
let garageReturn = 'menu';
let settingsReturn = 'menu';
let selectedTrack = 0;

function onResize() {
  applyPixelRatio();
  const w = window.innerWidth;
  const h = window.innerHeight;
  garage.resize(w, h);
  if (session) {
    session.camera.aspect = w / h;
    session.camera.updateProjectionMatrix();
  }
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
onResize();

// --------------------------------------------------------------- env cache
const envCache = new Map();
function envFor(presetName, sunDir) {
  if (!envCache.has(presetName)) envCache.set(presetName, createEnvMap(renderer, SKY_PRESETS[presetName], sunDir));
  return envCache.get(presetName);
}

// ------------------------------------------------------------------ screens
const SCREENS = ['title', 'menu', 'garage', 'tracks', 'settings', 'pause', 'results', 'loading'];
function show(name) {
  for (const s of SCREENS) $('screen-' + s).classList.toggle('hidden', s !== name);
  screen = name;
  garage.active = name === 'garage';
  refreshCoins();
}

function refreshCoins() {
  document.querySelectorAll('.coins-val').forEach((el) => (el.textContent = Math.floor(save.coins).toLocaleString()));
  const car = CAR_DEFS[save.selectedCar];
  $('menu-car-name').textContent = `${car.name} (${car.klass})`;
  $('race-car-name').textContent = car.name;
}

function selectedSpec(type = save.selectedCar) {
  return computeSpec(CAR_DEFS[type], save.cars[type]);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// ================================================================== SESSION
const AI_NAMES = ['Dusty Rhodes', 'Lia Sideways', 'Kenji Drift', 'Rosa Gravel', 'Bjorn Flatout', 'Max Torque', 'Ana Apex', 'Tex Mudflap', 'Yuki Slide', 'Ollie Rally'];
const AI_COLORS = ['#ff7b00', '#18a558', '#1565c0', '#8e24aa', '#fdd835', '#00acc1', '#e53935', '#5d4037', '#ec407a', '#7cb342'];
const DIFF = {
  easy: { skill: 0.76, upg: [0, 1], reward: 1, wobble: 1.2 },
  medium: { skill: 0.87, upg: [1, 3], reward: 1.5, wobble: 0.7 },
  hard: { skill: 0.955, upg: [3, 5], reward: 2.2, wobble: 0.3 },
};
const CAM_NAMES = ['Chase', 'Far chase', 'Hood', 'Bumper'];

class Session {
  constructor(mode, opts = {}) {
    this.mode = mode;
    this.opts = opts;
    this.q = quality();
    const scene = (this.scene = new THREE.Scene());
    const sunDir = new THREE.Vector3(-0.45, 0.62, -0.35).normalize();
    this.trackDef = mode === 'race' ? TRACKS[opts.track] : null;
    const presetName = mode === 'race' ? this.trackDef.theme : 'day';
    const preset = SKY_PRESETS[presetName];
    scene.environment = envFor(presetName, sunDir);
    scene.environmentIntensity = 0.65;
    scene.fog = new THREE.Fog(preset.fog, 160, this.q === 'low' ? 520 : 820);
    this.sky = createSky(preset, sunDir);
    scene.add(this.sky);
    this.lighting = new Lighting(scene, preset, sunDir, this.q);
    scene.add(createClouds(18, 900, presetName.length));
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.25, 2200);

    if (mode === 'race') {
      this.world = buildRaceWorld(this.trackDef, this.q);
      this.laps = opts.laps || this.trackDef.laps;
      this.difficulty = opts.difficulty || 'medium';
    } else {
      this.world = buildFreeRoamWorld(this.q);
    }
    this.core = this.world.core;
    scene.add(this.world.group);

    this.dust = new Dust(scene, this.q === 'low' ? 350 : 700);
    this.skids = new SkidMarks(scene, this.q === 'low' ? 800 : 1800);

    // Player car.
    const type = save.selectedCar;
    const spec = selectedSpec(type);
    const car = new Vehicle(spec);
    car.id = 'p';
    const model = buildCarModel(type, save.cars[type].color, { spec, number: 7, accent: '#ff9500' });
    scene.add(model.root);
    this.player = { car, model, name: 'You', color: save.cars[type].color, type, isPlayer: true };
    this.racers = [this.player];
    audio.setTone(spec.sound);

    if (mode === 'race') this._setupAI();
    this._minimapSetup();
    this.camMode = settings.camera || 0;
    this.camPos = new THREE.Vector3();
    this.camDir = new THREE.Vector2(0, 1);
    this.shake = 0;
    this.time = 0;
    this.toastCoins = 0;
    this.distance = 0;
    this.coinsEarned = 0;
    this.waterTime = 0;
    this.stuckTime = 0;
    this.saveTimer = 0;
    this.restart();
  }

  _setupAI() {
    const rand = mulberry32((Date.now() & 0xffff) + 7);
    const d = DIFF[this.difficulty];
    const names = AI_NAMES.slice().sort(() => rand() - 0.5);
    const colors = AI_COLORS.slice().sort(() => rand() - 0.5);
    const types = ['rally', 'rally', 'truck', 'sports', rand() < 0.5 ? 'rally' : 'truck'];
    this.lineCache = new Map();
    for (let k = 0; k < 5; k++) {
      const type = types[k];
      const lv = () => d.upg[0] + Math.floor(rand() * (d.upg[1] - d.upg[0] + 1));
      const upg = { engine: lv(), handling: lv(), tires: lv() };
      const spec = computeSpec(CAR_DEFS[type], upg);
      const car = new Vehicle(spec);
      car.id = 'a' + k;
      const model = buildCarModel(type, colors[k], { spec, number: 11 + k * 7, accent: colors[(k + 2) % colors.length] });
      this.scene.add(model.root);
      const r = { car, model, name: names[k], color: colors[k], type, isPlayer: false };
      r.ai = new AIDriver(car, this.core.path, {
        skill: clamp(d.skill + (rand() - 0.5) * 0.04, 0.6, 0.985),
        name: names[k],
        line: this.core.line,
        profile: this._profileFor(spec),
        laneBias: (rand() - 0.5) * 1.2,
        reaction: 0.15 + rand() * 0.35,
        wobble: d.wobble,
      });
      this.racers.push(r);
    }
  }

  _profileFor(spec) {
    const mu = spec.grip.dirt;
    const key = mu.toFixed(3);
    if (!this.lineCache.has(key)) this.lineCache.set(key, this.core.path.speedProfile(this.core.line, mu * 0.92, 75, mu * 9.81 * 0.75));
    return this.lineCache.get(key);
  }

  _minimapSetup() {
    const mm = this.world.minimap;
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    mm.draw(c.getContext('2d'), 512);
    this.mapImage = c;
    const el = $('minimap');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = el.height = Math.round(170 * dpr);
    this.mmCtx = el.getContext('2d');
  }

  restart() {
    this.time = 0;
    this.raceTime = 0;
    this.finishedAt = 0;
    this.ended = false;
    for (const r of this.racers) {
      r.car.hitImpact = 0;
      r.car.landImpact = 0;
      r.finished = false;
    }
    if (this.mode === 'race') {
      this.state = 'countdown';
      this.countdown = 3.6;
      this._lastBeep = 4;
      // Player starts at the back of the grid.
      const order = this.racers.slice(1).concat([this.player]);
      order.forEach((r, k) => {
        const slot = this.core.gridSlot(k);
        r.car.reset(slot.x, this.core.heightAt(slot.x, slot.z), slot.z, slot.heading);
        this.core.initRacer(r.car);
        r.car.finished = false;
        if (r.isPlayer) r.ai = null;
      });
      this.racers.forEach((r) => r.ai && (r.ai.stuck = 0));
    } else {
      this.state = 'free';
      const sp = this.core.spawn;
      this.player.car.reset(sp.x, this.core.heightAt(sp.x, sp.z), sp.z, sp.heading);
    }
    for (const r of this.racers) syncCarModel(r.model, r.car, 1);
    this._snapCamera();
    setMsg('');
  }

  resetPlayer() {
    const car = this.player.car;
    if (this.mode === 'race') {
      const p = this.core.path;
      const n = p.nearest(car.x, car.z, car.trackHint ?? -1, {});
      const pt = p.pointAt(n.i, clamp(n.lat, -p.halfWidth + 2.5, p.halfWidth - 2.5), {});
      const lapsDone = car.lapsDone;
      const cp = car.cp;
      car.reset(pt.x, this.core.heightAt(pt.x, pt.z) + 0.2, pt.z, pt.heading);
      car.lapsDone = lapsDone;
      car.cp = cp;
      car.lastS = n.i * p.spacing;
      car.trackHint = n.i;
    } else {
      const pt = this.core.nearestRoadPoint(car.x, car.z);
      let h = pt.heading;
      if (Math.cos(h - car.heading) < 0) h += Math.PI;
      car.reset(pt.x, this.core.heightAt(pt.x, pt.z) + 0.2, pt.z, h);
    }
    this._snapCamera();
  }

  _snapCamera() {
    const car = this.player.car;
    this.camDir.set(Math.sin(car.heading), Math.cos(car.heading));
    this.camPos.set(car.x - this.camDir.x * 8, car.y + 3, car.z - this.camDir.y * 8);
  }

  // Debug / test hook: let the AI drive the player's car.
  enableAutopilot(skill = 0.9) {
    if (this.mode !== 'race') return;
    this.player.ai = new AIDriver(this.player.car, this.core.path, { skill, name: 'auto', line: this.core.line, profile: this._profileFor(this.player.car.spec), reaction: 0 });
  }

  cycleCamera() {
    this.camMode = (this.camMode + 1) % CAM_NAMES.length;
    settings.camera = this.camMode;
    persist();
    toast(CAM_NAMES[this.camMode] + ' cam', '#fff');
  }

  update(dt) {
    this.time += dt;
    const P = this.player;
    const pc = P.car;
    const racing = this.state === 'racing';

    // ---- player controls
    input.update(dt);
    if (!P.ai) {
      pc.controls.steer = input.steer;
      pc.controls.throttle = input.throttle;
      pc.controls.brake = input.brake;
      pc.controls.handbrake = input.handbrake;
    }

    // ---- countdown
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this._lastBeep && n <= 3) {
        this._lastBeep = n;
        if (n > 0) {
          setMsg(String(n));
          audio.beep(520, 0.22);
        }
      }
      if (this.countdown <= 0) {
        this.state = 'racing';
        setMsg('GO!', 'go', 1.0);
        audio.beep(1040, 0.5);
      }
      // Rev the engine on the grid.
      for (const r of this.racers) {
        const c = r.car;
        const thr = r.isPlayer ? input.throttle : 0.2 + Math.random() * 0.1;
        c.rpm = damp(c.rpm, c.spec.idleRpm + thr * (c.spec.redline * 0.85 - c.spec.idleRpm), 6, dt);
        c.throttleOut = thr;
      }
    } else {
      if (racing) this.raceTime += dt;
      // ---- AI
      const cars = this.racers.map((r) => r.car);
      for (const r of this.racers) if (r.ai) r.ai.update(dt, cars, true, this.raceTime);

      // ---- physics (fixed sub-steps)
      const H = 1 / 180;
      let steps = Math.min(14, Math.max(1, Math.round(dt / H)));
      const h = dt / steps;
      while (steps-- > 0) {
        for (const r of this.racers) {
          r.car.step(h, this.core, r.isPlayer && !r.ai ? settings.assists : true);
          this.core.collide(r.car);
        }
        for (let i = 0; i < this.racers.length; i++)
          for (let j = i + 1; j < this.racers.length; j++) collideVehicles(this.racers[i].car, this.racers[j].car);
      }

      // ---- race progress
      if (this.mode === 'race') this._raceProgress();
      else this._freeRoam(dt);
    }

    // Impacts → sound + shake.
    if (pc.hitImpact > 1.5) {
      audio.impact(pc.hitImpact);
      this.shake = Math.max(this.shake, Math.min(0.5, pc.hitImpact * 0.03));
    }
    if (pc.landImpact > 2.5) {
      audio.impact(pc.landImpact * 0.6);
      this.shake = Math.max(this.shake, Math.min(0.4, pc.landImpact * 0.025));
    }
    for (const r of this.racers) {
      r.car.hitImpact = 0;
      r.car.landImpact = 0;
    }

    // ---- visuals
    for (const r of this.racers) {
      syncCarModel(r.model, r.car, dt);
      this._effects(r, dt);
    }
    this.dust.update(dt);
    this.skids.update();
    if (this.world.update) this.world.update(this.time);
    this._camera(dt);
    this.lighting.follow(pc.x, pc.y, pc.z);
    this.sky.position.copy(this.camera.position);
    audio.update(pc, SURFACE_INFO[pc.surface].loose);
    this._hud(dt);
  }

  _raceProgress() {
    const P = this.player;
    const L = this.core.path.length;
    for (const r of this.racers) {
      const c = r.car;
      const ev = this.core.updateProgress(c, this.raceTime);
      if (ev === 'lap' && !r.finished) {
        if (c.lapsDone >= this.laps) {
          r.finished = true;
          c.finishTime = this.raceTime;
          if (r.isPlayer) this._playerFinished();
        } else if (r.isPlayer) {
          const last = c.lapTimes[c.lapTimes.length - 1];
          const best = c.bestLap === last;
          setMsg(this.laps - c.lapsDone === 1 ? 'FINAL LAP' : `LAP ${c.lapsDone + 1}`, '', 1.6);
          setSub(`${formatTime(last)}${best && c.lapTimes.length > 1 ? '  BEST LAP!' : ''}`, 2.5);
          audio.beep(880, 0.15, 'triangle');
        }
      }
    }
    // Wrong-way warning.
    const pc = P.car;
    const p = this.core.path;
    const i = pc.trackHint ?? 0;
    const along = pc.vx * p.tx[i] + pc.vz * p.tz[i];
    this.wrongWay = !P.finished && along < -3 ? (this.wrongWay || 0) + 1 / 60 : 0;
    if (this.wrongWay > 1.2) setMsg('WRONG WAY', 'warn', 0.5);

    // Standings.
    this.standings = this.racers.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.car.finishTime - b.car.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.car.progress - a.car.progress;
    });

    // End of race: everyone done or 25 s after the player.
    if (P.finished && !this.ended) {
      const allDone = this.racers.every((r) => r.finished);
      if (allDone || this.raceTime - this.finishedAt > 25) {
        this.ended = true;
        for (const r of this.racers) {
          if (!r.finished) {
            // Estimate the remaining time from their average pace.
            const c = r.car;
            const done = Math.max(1, c.progress);
            const total = this.laps * L;
            const pace = done / Math.max(1, this.raceTime);
            c.finishTime = this.raceTime + (total - done) / Math.max(pace, 5);
            r.estimated = true;
          }
        }
        setTimeout(() => showResults(this), 600);
      }
    }
  }

  _playerFinished() {
    const P = this.player;
    this.finishedAt = this.raceTime;
    const pos = this.racers.filter((r) => r.finished).length;
    setMsg(pos === 1 ? 'YOU WIN!' : `FINISHED P${pos}`, pos === 1 ? 'go' : '', 3);
    setSub(formatTime(P.car.finishTime), 3);
    audio.beep(pos === 1 ? 1320 : 880, 0.6, 'triangle');
    // Let the AI bring the player's car home.
    P.ai = new AIDriver(P.car, this.core.path, { skill: 0.55, name: 'you', line: this.core.line, profile: this._profileFor(P.car.spec), reaction: 0 });
  }

  _freeRoam(dt) {
    const pc = this.player.car;
    const core = this.core;
    // Distance + coins.
    this.distance += pc.speed * dt;
    const earned = Math.floor(this.distance / 100) * 5;
    if (earned > this.coinsEarned) {
      save.coins += earned - this.coinsEarned;
      this.coinsEarned = earned;
    }
    for (const pk of core.pickups) {
      if (pk.taken) {
        pk.timer -= dt;
        if (pk.timer <= 0) pk.taken = false;
        continue;
      }
      const dx = pk.x - pc.x;
      const dz = pk.z - pc.z;
      const dy = pk.y - (pc.y + 0.8);
      if (dx * dx + dz * dz < 12 && Math.abs(dy) < 2.6) {
        pk.taken = true;
        pk.timer = 60;
        save.coins += pk.value;
        audio.coin();
        toast(`+${pk.value}${pk.bonus ? '  AIR BONUS!' : ''}`);
      }
    }
    // Water.
    if (core.isInWater(pc)) {
      this.waterTime += dt;
      if (this.waterTime > 1.2) {
        this.waterTime = 0;
        setMsg('SPLASH!', 'warn', 1.2);
        this.resetPlayer();
      }
    } else this.waterTime = 0;
    this.saveTimer += dt;
    if (this.saveTimer > 8) {
      this.saveTimer = 0;
      persist();
    }
  }

  _effects(r, dt) {
    const c = r.car;
    const cam = this.camera.position;
    const dx = c.x - cam.x;
    const dz = c.z - cam.z;
    if (dx * dx + dz * dz > 160 * 160) return;
    const s = c.spec;
    const surf = SURFACE_INFO[c.surface];
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    const rx = -fz;
    const rz = fx;
    const qf = this.q === 'low' ? 0.45 : this.q === 'medium' ? 0.75 : 1;
    r.emit = r.emit || [0, 0];
    for (let w = 0; w < 4; w++) {
      const front = w < 2;
      const side = w % 2 === 0 ? -1 : 1;
      const lz = front ? s.a : -s.b;
      const wx = c.x + fx * lz + rx * side * s.track * 0.5;
      const wz = c.z + fz * lz + rz * side * s.track * 0.5;
      const wy = c.wheelH[w];
      const key = c.id + w;
      const markLvl = surf.loose ? 0.12 : 0.28;
      if (c.grounded && c.skid > markLvl && (!front || c.skid > 0.5)) {
        const col = c.surface === SURF.ASPHALT ? [0.04, 0.04, 0.045] : c.surface === SURF.GRASS ? [0.22, 0.2, 0.1] : c.surface === SURF.WATER ? [0.3, 0.3, 0.3] : [surf.dust[0] * 0.55, surf.dust[1] * 0.5, surf.dust[2] * 0.45];
        this.skids.add(key, wx, wy, wz, 0.26, col, Math.min(0.85, c.skid * 1.1));
      } else this.skids.lift(key);
      if (front || !c.grounded) continue;
      // Dust / smoke from the rear wheels.
      let rate = 0;
      let alpha = 0.3;
      let col = surf.dust;
      let size = 1.0;
      if (surf.loose) {
        rate = (c.speed > 3 ? c.speed * 0.5 : 0) + c.skid * 28 + c.wheelspin * 18;
        alpha = c.surface === SURF.GRASS ? 0.18 : 0.32;
        size = 1.0 + c.speed * 0.02;
      } else if (c.skid > 0.3) {
        rate = c.skid * 34;
        alpha = 0.22;
        col = [0.82, 0.82, 0.84];
        size = 1.1;
      }
      rate *= qf;
      const k = side < 0 ? 0 : 1;
      r.emit[k] += rate * dt;
      while (r.emit[k] >= 1) {
        r.emit[k] -= 1;
        const j = () => (Math.random() - 0.5) * 2;
        this.dust.emit(
          wx + j() * 0.3,
          wy + 0.25,
          wz + j() * 0.3,
          c.vx * 0.25 + j() * 1.2 - fx * 1.5,
          0.8 + Math.random() * 1.2,
          c.vz * 0.25 + j() * 1.2 - fz * 1.5,
          size * (0.6 + Math.random() * 0.6),
          [col[0] * (0.9 + Math.random() * 0.2), col[1] * (0.9 + Math.random() * 0.2), col[2] * (0.9 + Math.random() * 0.2)],
          1.2 + Math.random() * 1.3,
          alpha,
          1.4 + c.speed * 0.04
        );
      }
    }
  }

  _camera(dt) {
    const P = this.player;
    const c = P.car;
    const s = c.spec;
    const cam = this.camera;
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    let fov = 60;
    if (this.camMode <= 1) {
      // Chase: blend between where the car points and where it's going.
      let dx = fx;
      let dz = fz;
      if (c.speed > 4 && c.forwardSpeed > 0) {
        const k = 0.4;
        dx = lerp(fx, c.vx / c.speed, k);
        dz = lerp(fz, c.vz / c.speed, k);
      }
      if (c.forwardSpeed < -2) {
        dx = fx;
        dz = fz;
      }
      const l = Math.hypot(dx, dz) || 1;
      this.camDir.x = damp(this.camDir.x, dx / l, 4.5, dt);
      this.camDir.y = damp(this.camDir.y, dz / l, 4.5, dt);
      const dl = Math.hypot(this.camDir.x, this.camDir.y) || 1;
      const cdx = this.camDir.x / dl;
      const cdz = this.camDir.y / dl;
      const far = this.camMode === 1;
      const dist = (far ? 9.5 : 5.9) + s.length * 0.35;
      const height = (far ? 3.6 : 2.25) + (P.type === 'truck' ? 0.6 : 0);
      const tx = c.x - cdx * dist;
      const tz = c.z - cdz * dist;
      let ty = c.y + height;
      this.camPos.x = damp(this.camPos.x, tx, 10, dt);
      this.camPos.z = damp(this.camPos.z, tz, 10, dt);
      this.camPos.y = damp(this.camPos.y, ty, 6, dt);
      const ground = this.core.heightAt(this.camPos.x, this.camPos.z) + 0.8;
      if (this.camPos.y < ground) this.camPos.y = ground;
      cam.position.copy(this.camPos);
      cam.lookAt(c.x + cdx * 3, c.y + 1.1 + (P.type === 'truck' ? 0.4 : 0), c.z + cdz * 3);
      fov = 58 + Math.min(16, c.speed * 0.2);
    } else {
      const body = P.model.body;
      body.updateWorldMatrix(true, false);
      const hood = this.camMode === 2;
      // Hood cam sits just in front of the windscreen, above the bonnet.
      const eye = { sports: [1.1, 0.95], truck: [1.74, 1.25], rally: [1.25, 0.7] }[P.type];
      const local = hood ? new THREE.Vector3(0, eye[0], eye[1]) : new THREE.Vector3(0, 0.62, s.length / 2 + 0.15);
      const look = local.clone().add(new THREE.Vector3(0, hood ? -0.25 : 0, 12));
      cam.position.copy(body.localToWorld(local));
      cam.lookAt(body.localToWorld(look));
      fov = (hood ? 66 : 72) + Math.min(12, c.speed * 0.15);
    }
    // Shake from bumpy surfaces and impacts.
    const bump = SURFACE_INFO[c.surface].bump * (c.grounded ? 1 : 0) * Math.min(1, c.speed / 25);
    const amp = bump * 0.035 + this.shake;
    if (amp > 0.001) {
      cam.position.x += (Math.random() - 0.5) * amp;
      cam.position.y += (Math.random() - 0.5) * amp;
      cam.position.z += (Math.random() - 0.5) * amp;
    }
    this.shake = Math.max(0, this.shake - dt * 1.2);
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = damp(cam.fov, fov, 3, dt);
      cam.updateProjectionMatrix();
    }
    this.dust.setScale(renderer.domElement.height, cam.fov);
  }

  _hud(dt) {
    const c = this.player.car;
    const kmh = c.speed * 3.6;
    const v = settings.units === 'mph' ? kmh * 0.621371 : kmh;
    setText('h-speed', Math.round(v));
    setText('h-unit', settings.units === 'mph' ? 'mph' : 'km/h');
    const gear = c.gear === -1 ? 'R' : c.speed < 0.4 && c.throttleOut < 0.05 ? 'N' : String(c.gear);
    setText('h-gear', gear);
    const rpmN = clamp((c.rpm - c.spec.idleRpm * 0.6) / (c.spec.redline - c.spec.idleRpm * 0.6), 0, 1);
    const g = $('g-rpm');
    const dash = (rpmN * 377).toFixed(1);
    if (g._d !== dash) {
      g._d = dash;
      g.style.strokeDasharray = `${dash} 1000`;
      g.style.stroke = rpmN > 0.9 ? '#ff4d2e' : '';
    }
    $('h-wheel-ico').style.transform = `rotate(${(input.steer * 100).toFixed(0)}deg)`;

    if (this.mode === 'race') {
      const st = this.standings || this.racers;
      const pos = st.indexOf(this.player) + 1;
      setText('h-pos', `${pos}/${this.racers.length}`);
      setText('h-lap', `${Math.min(this.laps, Math.max(1, c.lapsDone + 1))}/${this.laps}`);
      const lapT = this.state === 'racing' ? this.raceTime - c.lapStart : 0;
      setText('h-time', formatTime(this.player.finished ? c.finishTime : this.state === 'racing' ? lapT : 0));
      setText('h-best', formatTime(c.bestLap));
    } else {
      setText('h-coins', Math.floor(save.coins).toLocaleString());
      setText('h-dist', `${(this.distance / 1000).toFixed(1)} km`);
      this._areaTimer = (this._areaTimer || 0) - dt;
      if (this._areaTimer <= 0) {
        this._areaTimer = 0.5;
        setText('h-area', this._areaName());
      }
    }
    this._minimap();
  }

  _areaName() {
    const c = this.player.car;
    for (const road of this.core.roads) {
      const n = road.path.nearest(c.x, c.z, -1, {});
      if (n.dist < road.width / 2 + 2) return road.name;
    }
    if (c.surface === SURF.SAND) return 'Sand Quarry';
    if (c.surface === SURF.WATER) return 'Lake';
    return 'Off-road';
  }

  _minimap() {
    const ctx = this.mmCtx;
    const S = ctx.canvas.width;
    const mm = this.world.minimap;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    const c = this.player.car;
    const toPx = 512 / mm.size;
    if (mm.kind === 'track') {
      ctx.fillStyle = 'rgba(20,24,30,0.6)';
      ctx.fillRect(0, 0, S, S);
      ctx.drawImage(this.mapImage, 0, 0, S, S);
      const sc = S / mm.size;
      for (const r of this.racers) {
        if (r.isPlayer) continue;
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.arc((r.car.x - mm.minX) * sc, (r.car.z - mm.minZ) * sc, S * 0.028, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      this._arrow(ctx, (c.x - mm.minX) * sc, (c.z - mm.minZ) * sc, Math.atan2(Math.cos(c.heading), Math.sin(c.heading)) + Math.PI / 2, S * 0.05);
    } else {
      const range = 240;
      const scale = S / 2 / range;
      ctx.translate(S / 2, S / 2);
      const alpha = Math.atan2(Math.cos(c.heading), Math.sin(c.heading));
      ctx.rotate(-Math.PI / 2 - alpha);
      ctx.scale(scale / toPx, scale / toPx);
      ctx.translate(-(c.x - mm.minX) * toPx, -(c.z - mm.minZ) * toPx);
      ctx.drawImage(this.mapImage, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Coins nearby.
      ctx.fillStyle = '#ffd000';
      const ca = Math.cos(-Math.PI / 2 - alpha);
      const sa = Math.sin(-Math.PI / 2 - alpha);
      for (const pk of this.core.pickups) {
        if (pk.taken) continue;
        const dx = pk.x - c.x;
        const dz = pk.z - c.z;
        if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
        const x = (dx * ca - dz * sa) * scale + S / 2;
        const y = (dx * sa + dz * ca) * scale + S / 2;
        ctx.beginPath();
        ctx.arc(x, y, S * 0.018, 0, Math.PI * 2);
        ctx.fill();
      }
      this._arrow(ctx, S / 2, S / 2, 0, S * 0.055);
    }
    ctx.restore();
  }

  _arrow(ctx, x, y, angle, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = '#ffb300';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.8);
    ctx.lineTo(0, size * 0.4);
    ctx.lineTo(-size * 0.7, size * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  render() {
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    disposeObject(this.scene);
    this.dust.dispose();
    this.skids.dispose();
  }
}

// ---------------------------------------------------------------- HUD utils
const textCache = {};
function setText(id, v) {
  const s = String(v);
  if (textCache[id] === s) return;
  textCache[id] = s;
  $(id).textContent = s;
}

let msgTimer = null;
function setMsg(text, cls = '', dur = 0) {
  const el = $('hud-msg');
  el.textContent = text;
  el.className = cls;
  el.style.opacity = text ? 1 : 0;
  clearTimeout(msgTimer);
  if (dur > 0) msgTimer = setTimeout(() => (el.style.opacity = 0), dur * 1000);
}
let subTimer = null;
function setSub(text, dur = 2) {
  const el = $('hud-sub');
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(subTimer);
  subTimer = setTimeout(() => (el.style.opacity = 0), dur * 1000);
}
function toast(text, color) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  if (color) el.style.color = color;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// ================================================================ SESSIONS
async function startSession(mode, opts) {
  audio.setActive(false);
  show('loading');
  $('loading-text').textContent = mode === 'race' ? `Loading ${TRACKS[opts.track].name}…` : 'Building the open world…';
  await nextFrame();
  if (session) {
    session.dispose();
    session = null;
  }
  try {
    session = new Session(mode, opts);
  } catch (err) {
    console.error(err);
    $('loading-text').textContent = 'Something went wrong: ' + err.message;
    return;
  }
  // Warm up shaders before showing the scene.
  renderer.compile(session.scene, session.camera);
  resetDynamicResolution();
  show('none');
  $('screen-loading').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('race-info').classList.toggle('hidden', mode !== 'race');
  $('free-info').classList.toggle('hidden', mode === 'race');
  $('steer-btns').classList.toggle('hidden', !(settings.steerMode === 'buttons' || (!input.tiltSeen && isTouch)));
  input.releaseAll();
  paused = false;
  audio.setActive(true);
  requestWakeLock();
}

function endSession() {
  if (session) {
    if (session.mode === 'free') {
      save.stats.distance += session.distance;
    }
    session.dispose();
    session = null;
  }
  persist();
  resetDynamicResolution();
  audio.setActive(false);
  $('hud').classList.add('hidden');
  setMsg('');
  paused = false;
}

function pauseGame() {
  if (!session || paused || screen === 'results') return;
  paused = true;
  audio.setActive(false);
  input.releaseAll();
  show('pause');
}

function resumeGame() {
  if (!session) return;
  paused = false;
  show('none');
  input.releaseAll();
  audio.setActive(true);
}

function showResults(sess) {
  if (session !== sess) return;
  paused = true;
  audio.setActive(false);
  const P = sess.player;
  const order = sess.racers.slice().sort((a, b) => a.car.finishTime - b.car.finishTime);
  const pos = order.indexOf(P) + 1;
  const def = sess.trackDef;
  const rec = (save.records[def.id] = save.records[def.id] || { bestLap: 0, bestRace: {}, aiBest: {} });
  const newLap = P.car.bestLap < Infinity && (!rec.bestLap || P.car.bestLap < rec.bestLap);
  if (newLap) rec.bestLap = P.car.bestLap;
  const rkey = String(sess.laps);
  const newRace = !rec.bestRace[rkey] || P.car.finishTime < rec.bestRace[rkey];
  if (newRace) rec.bestRace[rkey] = P.car.finishTime;
  let aiBest = Infinity;
  for (const r of sess.racers) if (!r.isPlayer) aiBest = Math.min(aiBest, r.car.bestLap);
  if (aiBest < Infinity && (!rec.aiBest[sess.difficulty] || aiBest < rec.aiBest[sess.difficulty])) rec.aiBest[sess.difficulty] = aiBest;
  const base = [600, 400, 280, 180, 120, 80][pos - 1] || 50;
  const lapsF = clamp(sess.laps / def.laps, 0.4, 2);
  let reward = Math.round(base * DIFF[sess.difficulty].reward * lapsF);
  if (newLap) reward += 250;
  save.coins += reward;
  save.stats.races += 1;
  if (pos === 1) save.stats.wins += 1;
  persist();

  $('r-title').textContent = pos === 1 ? 'YOU WIN!' : `YOU FINISHED P${pos}`;
  $('r-sub').textContent = `${def.name} · ${sess.laps} lap${sess.laps > 1 ? 's' : ''} · ${sess.difficulty[0].toUpperCase() + sess.difficulty.slice(1)} AI`;
  const rows = order
    .map((r, i) => {
      const gap = i === 0 ? formatTime(r.car.finishTime) : '+' + (r.car.finishTime - order[0].car.finishTime).toFixed(2) + 's';
      return `<tr class="${r.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td><span class="car-dot" style="background:${r.color}"></span>${r.name}</td><td>${CAR_DEFS[r.type].name}</td><td>${r.estimated ? '~' : ''}${gap}</td><td>${formatTime(r.car.bestLap)}</td></tr>`;
    })
    .join('');
  $('r-table').innerHTML = `<tr><th>POS</th><th>DRIVER</th><th>CAR</th><th>TIME</th><th>BEST LAP</th></tr>${rows}`;
  $('r-reward').textContent = `+${reward} coins${newLap ? ' · NEW LAP RECORD!' : ''}${newRace && !newLap ? ' · NEW BEST RACE TIME!' : ''}`;
  show('results');
}

// ================================================================== GARAGE UI
const PAINTS = ['#c8102e', '#f2f2f2', '#111317', '#1f4fa0', '#ff8a00', '#ffd400', '#1b9e4b', '#7b2cbf', '#00b3c7', '#8d99ae'];
let garageType = save.selectedCar;

function renderGarage() {
  const def = CAR_DEFS[garageType];
  const upg = save.cars[garageType];
  const r = ratings(def, upg);
  $('g-class').textContent = def.klass;
  $('g-name').textContent = def.name;
  $('g-desc').textContent = def.desc;
  const top = settings.units === 'mph' ? `${Math.round(r.perf.topSpeed * 2.237)} mph` : `${Math.round(r.perf.topSpeed * 3.6)} km/h`;
  $('g-specs').innerHTML = `<span>${def.drive}</span><span>${def.mass} kg</span><span>0-100: ${r.perf.zeroTo100.toFixed(1)} s</span><span>Top: ${top}</span>`;
  const bars = [
    ['Top speed', r.speed],
    ['Acceleration', r.accel],
    ['Handling', r.handling],
    ['Off-road', r.offroad],
  ];
  $('g-stats').innerHTML = bars.map(([n, v]) => `<div class="stat"><div class="s-top"><span>${n}</span><span>${v.toFixed(1)}</span></div><div class="bar"><i style="width:${v * 10}%"></i></div></div>`).join('');
  $('g-colors').innerHTML = PAINTS.map((c) => `<button class="swatch ${c === upg.color ? 'sel' : ''}" data-c="${c}" style="background:${c}"></button>`).join('');
  $('g-upgrades').innerHTML = UPGRADE_KEYS.map((k) => {
    const lvl = upg[k];
    const cost = upgradeCost(lvl);
    const maxed = lvl >= UPGRADE_MAX;
    const pips = Array.from({ length: UPGRADE_MAX }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
    return `<div class="upg"><div class="upg-head"><div class="upg-name">${UPGRADES[k].name}</div>
      <button class="upg-btn" data-k="${k}" ${maxed || save.coins < cost ? 'disabled' : ''}>${maxed ? 'MAX' : `<span class="coin-ico"></span>${cost.toLocaleString()}`}</button></div>
      <div class="upg-desc">${UPGRADES[k].desc}</div><div class="pips">${pips}</div></div>`;
  }).join('');
  $('g-select').textContent = garageType === save.selectedCar ? 'DRIVE THIS CAR' : 'SELECT & DRIVE';
  refreshCoins();
}

function openGarage(ret = 'menu') {
  garageReturn = ret;
  garageType = save.selectedCar;
  garage.setCar(garageType, save.cars[garageType].color, selectedSpec(garageType));
  renderGarage();
  show('garage');
}

function cycleGarage(dir) {
  const i = CAR_ORDER.indexOf(garageType);
  garageType = CAR_ORDER[(i + dir + CAR_ORDER.length) % CAR_ORDER.length];
  garage.setCar(garageType, save.cars[garageType].color, selectedSpec(garageType));
  renderGarage();
  audio.click();
}

$('g-prev').onclick = () => cycleGarage(-1);
$('g-next').onclick = () => cycleGarage(1);
$('g-colors').onclick = (e) => {
  const c = e.target.dataset && e.target.dataset.c;
  if (!c) return;
  save.cars[garageType].color = c;
  garage.setColor(c);
  persist();
  renderGarage();
};
$('g-upgrades').onclick = (e) => {
  const btn = e.target.closest('.upg-btn');
  if (!btn || btn.disabled) return;
  const k = btn.dataset.k;
  const upg = save.cars[garageType];
  const cost = upgradeCost(upg[k]);
  if (save.coins < cost) return;
  save.coins -= cost;
  upg[k]++;
  persist();
  audio.coin();
  garage.setCar(garageType, upg.color, selectedSpec(garageType));
  renderGarage();
};
$('g-select').onclick = () => {
  save.selectedCar = garageType;
  persist();
  audio.click();
  if (garageReturn === 'tracks') openTracks();
  else show('menu');
};

// Drag on the empty part of the garage to spin the car.
$('screen-garage').addEventListener('pointerdown', (e) => {
  if (e.target.closest('.glass, button')) return;
  garage.startDrag(e.clientX);
});
window.addEventListener('pointermove', (e) => garage.drag(e.clientX));
window.addEventListener('pointerup', () => garage.endDrag());
window.addEventListener('pointercancel', () => garage.endDrag());

// =============================================================== TRACKS UI
function openTracks() {
  const list = $('track-list');
  list.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const rec = save.records[t.id] || {};
    const p = new TrackPath(t.points, { closed: true, spacing: 2, width: t.width });
    const card = document.createElement('button');
    card.className = 'track-card' + (i === selectedTrack ? ' sel' : '');
    const ai = rec.aiBest && rec.aiBest[settings.difficulty];
    card.innerHTML = `<canvas width="300" height="120"></canvas><div class="tc-name">${t.name}</div><div class="tc-desc">${t.desc}</div>
      <div class="tc-meta"><span>${(p.length / 1000).toFixed(2)} km</span><span>${t.laps} laps</span><span>${t.theme}</span></div>
      <div class="tc-rec">Your best lap: <b>${formatTime(rec.bestLap)}</b><br>AI best lap (${settings.difficulty}): <b>${ai ? formatTime(ai) : 'race to find out'}</b></div>`;
    card.onclick = () => {
      selectedTrack = i;
      audio.click();
      openTracks();
    };
    list.appendChild(card);
    drawTrackThumb(card.querySelector('canvas'), p, i === selectedTrack);
  });
  setSeg('opt-diff', settings.difficulty);
  setSeg('opt-laps', String(settings.laps || 0));
  refreshCoins();
  show('tracks');
}

function drawTrackThumb(cv, p, sel) {
  const ctx = cv.getContext('2d');
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
  const sc = Math.min((cv.width - 20) / (maxX - minX), (cv.height - 20) / (maxZ - minZ));
  const ox = (cv.width - (maxX - minX) * sc) / 2;
  const oz = (cv.height - (maxZ - minZ) * sc) / 2;
  ctx.lineJoin = 'round';
  for (const [w, col] of [[9, 'rgba(0,0,0,0.5)'], [5, sel ? '#ffb300' : '#d9c09a']]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    for (let i = 0; i <= p.n; i++) {
      const j = i % p.n;
      const x = ox + (p.x[j] - minX) * sc;
      const y = oz + (p.z[j] - minZ) * sc;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox + (p.x[0] - minX) * sc - 4, oz + (p.z[0] - minZ) * sc - 4, 8, 8);
}

function setSeg(id, v) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('sel', b.dataset.v === v));
}
function bindSeg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg(id, b.dataset.v);
    fn(b.dataset.v);
    audio.click();
  });
}
bindSeg('opt-diff', (v) => {
  settings.difficulty = v;
  persist();
  openTracks();
});
bindSeg('opt-laps', (v) => {
  settings.laps = +v;
  persist();
});

// ============================================================= SETTINGS UI
function openSettings(ret) {
  settingsReturn = ret;
  setSeg('s-steer', settings.steerMode);
  setSeg('s-units', settings.units);
  setSeg('s-quality', settings.quality);
  $('s-sens').value = settings.sensitivity;
  $('s-sens-val').textContent = `(${settings.sensitivity}/10)`;
  $('s-invert').checked = settings.invertTilt;
  $('s-autogas').checked = settings.autoGas;
  $('s-assists').checked = settings.assists;
  $('s-volume').value = settings.volume;
  show('settings');
}
bindSeg('s-steer', (v) => {
  settings.steerMode = v;
  persist();
});
bindSeg('s-units', (v) => {
  settings.units = v;
  persist();
});
bindSeg('s-quality', (v) => {
  settings.quality = v;
  persist();
  resetDynamicResolution();
});
$('s-sens').oninput = (e) => {
  settings.sensitivity = +e.target.value;
  $('s-sens-val').textContent = `(${settings.sensitivity}/10)`;
  persist();
};
$('s-invert').onchange = (e) => {
  settings.invertTilt = e.target.checked;
  persist();
};
$('s-autogas').onchange = (e) => {
  settings.autoGas = e.target.checked;
  persist();
};
$('s-assists').onchange = (e) => {
  settings.assists = e.target.checked;
  persist();
};
$('s-volume').oninput = (e) => {
  settings.volume = +e.target.value;
  audio.setVolume(settings.volume);
  persist();
};
$('s-calib').onclick = () => {
  input.calibrate();
  persist();
  toast('Tilt centred', '#fff');
  audio.click();
};
$('s-reset').onclick = () => {
  if (confirm('Reset all coins, upgrades and records?')) {
    resetProgress();
    refreshCoins();
    toast('Progress reset', '#fff');
  }
};
$('settings-back').onclick = () => {
  if (settingsReturn === 'pause') {
    $('steer-btns').classList.toggle('hidden', !(settings.steerMode === 'buttons' || (!input.tiltSeen && isTouch)));
    show('pause');
  } else show('menu');
};

// ================================================================ BUTTONS
document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => {
  audio.click();
  show(b.dataset.back);
}));

$('b-start').onclick = async () => {
  audio.init();
  audio.setVolume(settings.volume);
  let tiltOK = false;
  if (isTouch) tiltOK = await input.enableTilt();
  else input.enableTilt();
  if (isTouch && !tiltOK && settings.steerMode === 'tilt') {
    toast('Tilt not allowed: using touch buttons', '#fff');
    settings.steerMode = 'buttons';
  }
  try {
    const el = document.documentElement;
    if (isTouch && el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (isTouch && el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (e) {
    /* not supported */
  }
  garage.setCar(save.selectedCar, save.cars[save.selectedCar].color, selectedSpec());
  show('menu');
};
$('m-free').onclick = () => {
  audio.click();
  startSession('free', {});
};
$('m-race').onclick = () => {
  audio.click();
  openTracks();
};
$('m-garage').onclick = () => {
  audio.click();
  openGarage('menu');
};
$('m-settings').onclick = () => {
  audio.click();
  openSettings('menu');
};
$('race-garage').onclick = () => openGarage('tracks');
$('b-race-start').onclick = () => {
  audio.click();
  startSession('race', { track: selectedTrack, difficulty: settings.difficulty, laps: settings.laps || 0 });
};

$('b-pause').onclick = pauseGame;
$('b-cam').onclick = () => session && session.cycleCamera();
$('b-reset').onclick = () => session && !paused && session.resetPlayer();
$('p-resume').onclick = resumeGame;
$('p-restart').onclick = () => {
  if (!session) return;
  session.restart();
  resumeGame();
};
$('p-calib').onclick = () => {
  input.calibrate();
  persist();
  toast('Tilt centred', '#fff');
};
$('p-settings').onclick = () => openSettings('pause');
$('p-quit').onclick = () => {
  endSession();
  garage.setCar(save.selectedCar, save.cars[save.selectedCar].color, selectedSpec());
  show('menu');
};
$('r-again').onclick = () => {
  if (!session) return;
  session.restart();
  resumeGame();
};
$('r-garage').onclick = () => {
  endSession();
  openGarage('tracks');
};
$('r-menu').onclick = () => {
  endSession();
  garage.setCar(save.selectedCar, save.cars[save.selectedCar].color, selectedSpec());
  show('menu');
};

input.bindButton($('c-gas'), 'gas');
input.bindButton($('c-brake'), 'brake');
input.bindButton($('c-hand'), 'hand');
input.bindButton($('c-left'), 'left');
input.bindButton($('c-right'), 'right');
input.onKey = (code) => {
  if (!session) return;
  if (code === 'Escape' || code === 'KeyP') paused ? resumeGame() : pauseGame();
  if (code === 'KeyC' && !paused) session.cycleCamera();
  if (code === 'KeyR' && !paused) session.resetPlayer();
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseGame();
    audio.suspend();
  } else {
    audio.resume();
    requestWakeLock();
  }
});
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest('.screen')) e.preventDefault();
}, { passive: false });

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    wakeLock = null;
  }
}

// ================================================================ MAIN LOOP
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (dt <= 0) return;

  if (session && !paused) {
    session.update(dt);
    session.render();
    // Dynamic resolution: keep the frame rate up on slower iPads.
    frameAvg = frameAvg * 0.95 + dt * 1000 * 0.05;
    scaleCooldown -= dt;
    if (scaleCooldown <= 0 && settings.quality === 'auto') {
      // Only the first check after a step may judge whether that step helped.
      const prevStepAvg = stepAvg;
      stepAvg = 0;
      if (frameAvg > 26 && dynScale > 0.6) {
        if (prevStepAvg && frameAvg > prevStepAvg * 0.92) {
          // The last step didn't help: the frame rate is capped (Low Power
          // Mode / heat) or CPU-bound, so lowering resolution only blurs it.
          // Undo the step and stop adjusting for this session.
          dynScale = Math.min(1, dynScale + 0.1);
          applyPixelRatio();
          scaleCooldown = Infinity;
        } else {
          stepAvg = frameAvg;
          dynScale = Math.max(0.6, dynScale - 0.1);
          applyPixelRatio();
          scaleCooldown = 2;
        }
      } else if (frameAvg < 17 && dynScale < 1) {
        dynScale = Math.min(1, dynScale + 0.05);
        applyPixelRatio();
        scaleCooldown = 4;
      }
    }
  } else if (session && paused) {
    session.render();
  } else {
    garage.offsetX = screen === 'garage' ? (window.innerWidth > 900 ? -40 : 0) : 0;
    garage.update(dt, screen === 'garage' ? 'garage' : 'menu');
    garage.render();
  }
  // Live tilt needle on the settings screen.
  if (screen === 'settings') {
    const st = input.tiltSeen ? input.tiltSteer() : 0;
    $('s-tilt-needle').style.left = `${50 + st * 50}%`;
  }
}

// Boot.
garage.setCar(save.selectedCar, save.cars[save.selectedCar].color, selectedSpec());
show('title');
requestAnimationFrame(frame);

// Expose for debugging / automated tests.
window.__tilt = { get session() { return session; }, input, save, startSession, show, garage, cycleGarage, renderer };
