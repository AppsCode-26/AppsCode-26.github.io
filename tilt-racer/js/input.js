// Player input: iPad tilt (gyroscope / device orientation), on-screen pedals,
// touch steering buttons and keyboard.
import { clamp, damp } from './util.js';

const DEG = Math.PI / 180;

export class Input {
  constructor(settings) {
    this.settings = settings;
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;
    this.rawTilt = 0;
    this.tiltSeen = false;
    this.tiltListening = false;
    this.keys = new Set();
    this.touch = { gas: 0, brake: 0, hand: 0, left: 0, right: 0 };
    this._kbSteer = 0;
    this.onKey = null;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (this.onKey) this.onKey(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this._onOrient = this._onOrient.bind(this);
  }

  get tiltSupported() {
    return typeof window.DeviceOrientationEvent !== 'undefined' && 'ontouchstart' in window;
  }

  // Must be called from a user gesture on iOS (permission prompt).
  async enableTilt() {
    if (typeof window.DeviceOrientationEvent === 'undefined') return false;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch (e) {
      return false;
    }
    if (!this.tiltListening) {
      window.addEventListener('deviceorientation', this._onOrient);
      this.tiltListening = true;
    }
    return true;
  }

  // Angle the screen content is rotated from the frame deviceorientation uses.
  // On iOS beta/gamma are always relative to portrait, and window.orientation
  // (0, 90, -90, 180) is measured from portrait too, so prefer it. On iPad,
  // screen.orientation.angle is measured from *landscape* (0/180 when held
  // sideways) and its sign changed between iPadOS versions, so only use it
  // as a fallback for browsers without window.orientation.
  _screenAngle() {
    if (typeof window.orientation === 'number') return window.orientation;
    const so = window.screen && window.screen.orientation;
    if (so && so.type && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS without window.orientation: derive a portrait-based angle from the type.
      const byType = { 'portrait-primary': 0, 'landscape-primary': 90, 'portrait-secondary': 180, 'landscape-secondary': -90 };
      if (so.type in byType) return byType[so.type];
    }
    if (so && typeof so.angle === 'number') return so.angle;
    return 0;
  }

  _onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    this.tiltSeen = true;
    const b = e.beta * DEG;
    const g = e.gamma * DEG;
    // Gravity direction in device coordinates (x right, y up the screen).
    const dx = Math.cos(b) * Math.sin(g);
    const dy = -Math.sin(b);
    const th = this._screenAngle() * DEG;
    // Rotate into screen coordinates.
    const sx = Math.cos(th) * dx - Math.sin(th) * dy;
    // Right edge down = positive = steer right.
    this.rawTilt = Math.asin(clamp(sx, -1, 1)) / DEG;
  }

  calibrate() {
    // Centring only makes sense for a small offset from level.
    this.settings.tiltOffset = clamp(this.rawTilt, -25, 25);
  }

  bindButton(el, name) {
    const active = new Set();
    const down = (e) => {
      e.preventDefault();
      active.add(e.pointerId);
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      this.touch[name] = 1;
      el.classList.add('down');
    };
    const up = (e) => {
      active.delete(e.pointerId);
      if (active.size === 0) {
        this.touch[name] = 0;
        el.classList.remove('down');
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  releaseAll() {
    for (const k of Object.keys(this.touch)) this.touch[k] = 0;
    document.querySelectorAll('.down').forEach((el) => el.classList.remove('down'));
  }

  tiltSteer() {
    const st = this.settings;
    let a = this.rawTilt - clamp(st.tiltOffset || 0, -25, 25);
    if (st.invertTilt) a = -a;
    // Sensitivity 1..10 maps to 42..14 degrees of tilt for full lock.
    const range = 46 - st.sensitivity * 3.2;
    const dead = 1.2;
    let x = (Math.sign(a) * Math.max(0, Math.abs(a) - dead)) / (range - dead);
    x = clamp(x, -1, 1);
    return Math.sign(x) * Math.pow(Math.abs(x), 1.2);
  }

  update(dt) {
    const k = this.keys;
    const left = k.has('ArrowLeft') || k.has('KeyA');
    const right = k.has('ArrowRight') || k.has('KeyD');
    const kbActive = left || right;
    const kbTarget = (right ? 1 : 0) - (left ? 1 : 0);
    this._kbSteer = damp(this._kbSteer, kbTarget, kbTarget === 0 ? 10 : 5, dt);

    let steerTarget = 0;
    const mode = this.settings.steerMode;
    if (kbActive || Math.abs(this._kbSteer) > 0.02) steerTarget = this._kbSteer;
    else if (mode === 'tilt' && this.tiltSeen) steerTarget = this.tiltSteer();
    else steerTarget = this._btnSteer = damp(this._btnSteer || 0, this.touch.right - this.touch.left, this.touch.right || this.touch.left ? 6 : 12, dt);
    this.steer = damp(this.steer, steerTarget, 16, dt);

    const gasKey = k.has('ArrowUp') || k.has('KeyW');
    const brakeKey = k.has('ArrowDown') || k.has('KeyS');
    this.brake = brakeKey || this.touch.brake ? 1 : 0;
    let gas = gasKey || this.touch.gas ? 1 : 0;
    if (this.settings.autoGas && !this.brake) gas = 1;
    this.throttle = gas;
    this.handbrake = k.has('Space') || this.touch.hand > 0;
  }
}
