// Synthesised car audio with the Web Audio API: engine (firing-frequency
// oscillators through distortion + filter), tyre squeal, gravel, wind,
// impacts and UI beeps. No audio files needed.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.running = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    // iOS needs a sound started inside the gesture to unlock audio.
    const unlock = ctx.createBufferSource();
    unlock.buffer = ctx.createBuffer(1, 1, 22050);
    unlock.connect(ctx.destination);
    unlock.start(0);

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // ---- engine
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 1.2;
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this._distCurve(6);
    this.shaper.oversample = '2x';
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    this.o1 = ctx.createOscillator();
    this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator();
    this.o2.type = 'square';
    this.o3 = ctx.createOscillator();
    this.o3.type = 'sawtooth';
    this.g1 = ctx.createGain();
    this.g2 = ctx.createGain();
    this.g3 = ctx.createGain();
    this.g1.gain.value = 0.5;
    this.g2.gain.value = 0.35;
    this.g3.gain.value = 0.18;
    this.o1.connect(this.g1).connect(mix);
    this.o2.connect(this.g2).connect(mix);
    this.o3.connect(this.g3).connect(mix);
    // Rumble: amplitude modulation at the firing rate / cylinders.
    this.lfo = ctx.createOscillator();
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0.25;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0.75;
    this.lfo.connect(this.lfoGain).connect(this.amp.gain);
    mix.connect(this.amp).connect(this.shaper).connect(this.engFilter).connect(this.engGain).connect(this.master);
    // Intake / exhaust hiss.
    this.intake = this._noise();
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intake.connect(this.intakeFilter).connect(this.intakeGain).connect(this.master);
    // Turbo whistle.
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'sine';
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain).connect(this.master);

    // ---- tyres
    this.squeal = this._noise();
    const sq1 = ctx.createBiquadFilter();
    sq1.type = 'bandpass';
    sq1.frequency.value = 1350;
    sq1.Q.value = 7;
    const sq2 = ctx.createBiquadFilter();
    sq2.type = 'bandpass';
    sq2.frequency.value = 1900;
    sq2.Q.value = 5;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squeal.connect(sq1).connect(sq2).connect(this.squealGain).connect(this.master);
    this.sq1 = sq1;

    this.gravel = this._noise();
    const gf = ctx.createBiquadFilter();
    gf.type = 'bandpass';
    gf.frequency.value = 420;
    gf.Q.value = 0.6;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    this.gravel.connect(gf).connect(this.gravelGain).connect(this.master);

    this.wind = this._noise();
    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 520;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(wf).connect(this.windGain).connect(this.master);

    for (const o of [this.o1, this.o2, this.o3, this.lfo, this.turbo]) o.start();
    this.running = true;
    this.setTone({ cyl: 8, base: 1, rough: 0.3, filter: 1 });
  }

  _noise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random() * 1.5);
    return src;
  }

  _distCurve(k) {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return c;
  }

  setTone(tone) {
    this.tone = tone;
    if (!this.ctx) return;
    this.shaper.curve = this._distCurve(3 + tone.rough * 14);
    this.turboOn = tone.cyl === 4;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setActive(on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!on) {
      for (const g of [this.engGain, this.intakeGain, this.squealGain, this.gravelGain, this.windGain, this.turboGain]) g.gain.setTargetAtTime(0, t, 0.05);
    }
    this.active = on;
  }

  update(car, surfaceLoose) {
    if (!this.ctx || !this.active) return;
    const t = this.ctx.currentTime;
    const s = car.spec;
    const tone = this.tone;
    const rpmN = Math.min(1.05, car.rpm / s.redline);
    const fire = (car.rpm / 60) * (tone.cyl / 2) * tone.base;
    const tc = 0.03;
    this.o1.frequency.setTargetAtTime(fire, t, tc);
    this.o2.frequency.setTargetAtTime(fire * 0.5, t, tc);
    this.o3.frequency.setTargetAtTime(fire * 2.01, t, tc);
    this.lfo.frequency.setTargetAtTime(fire / Math.max(2, tone.cyl / 2), t, tc);
    const thr = car.throttleOut;
    this.engFilter.frequency.setTargetAtTime((300 + rpmN * 2600 + thr * 1400) * tone.filter, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.1 + thr * 0.16 + rpmN * 0.08, t, 0.05);
    this.intakeFilter.frequency.setTargetAtTime(500 + rpmN * 2500, t, 0.05);
    this.intakeGain.gain.setTargetAtTime(thr * 0.04 * rpmN, t, 0.05);
    if (this.turboOn) {
      this.turbo.frequency.setTargetAtTime(1800 + rpmN * 4200, t, 0.1);
      this.turboGain.gain.setTargetAtTime(thr * rpmN * rpmN * 0.012, t, 0.15);
    } else this.turboGain.gain.setTargetAtTime(0, t, 0.1);

    const loose = surfaceLoose;
    const skid = car.skid;
    this.squealGain.gain.setTargetAtTime(loose ? 0 : Math.min(0.3, skid * 0.32), t, 0.04);
    this.sq1.frequency.setTargetAtTime(1200 + skid * 400, t, 0.1);
    const sp = car.speed;
    this.gravelGain.gain.setTargetAtTime(loose && car.grounded ? Math.min(0.35, sp * 0.006 + skid * 0.25) : 0, t, 0.05);
    this.windGain.gain.setTargetAtTime(Math.min(0.3, (sp / 70) ** 2 * 0.3), t, 0.1);
  }

  impact(strength) {
    if (!this.ctx || strength < 0.5) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 280 + Math.min(strength, 15) * 40;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const v = Math.min(0.9, strength * 0.07);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }

  beep(freq = 660, dur = 0.18, type = 'square', vol = 0.18) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  coin() {
    this.beep(988, 0.08, 'triangle', 0.25);
    setTimeout(() => this.beep(1319, 0.16, 'triangle', 0.25), 70);
  }

  click() {
    this.beep(520, 0.05, 'triangle', 0.12);
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }
}
