// Procedurally painted canvas textures (no image downloads needed).
import * as THREE from './vendor/three.module.min.js';
import { mulberry32, makeNoise2D, fbm } from './util.js';

let maxAniso = 4;
export function setMaxAnisotropy(a) {
  maxAniso = a;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c, { repeat = true, srgb = true, aniso = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso ? maxAniso : 1;
  t.needsUpdate = true;
  return t;
}

// Tileable value-noise speckle painted into an ImageData.
function noiseFill(ctx, w, h, base, variance, seed, scale = 1) {
  const img = ctx.createImageData(w, h);
  const rand = mulberry32(seed);
  const n = makeNoise2D(seed);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Tileable noise via torus mapping.
      const ax = (x / w) * Math.PI * 2;
      const ay = (y / h) * Math.PI * 2;
      const nx = Math.cos(ax) * 1.6 * scale;
      const ny = Math.sin(ax) * 1.6 * scale;
      const nz = Math.cos(ay) * 1.6 * scale;
      const nw = Math.sin(ay) * 1.6 * scale;
      const v = (fbm(n, nx + nz * 0.7 + 10, ny + nw * 0.7 - 5, 3) * 0.6 + (rand() - 0.5) * 0.8) * variance;
      const i = (y * w + x) * 4;
      d[i] = Math.max(0, Math.min(255, base[0] + v * 255));
      d[i + 1] = Math.max(0, Math.min(255, base[1] + v * 255));
      d[i + 2] = Math.max(0, Math.min(255, base[2] + v * 255));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const cache = {};
function cached(key, fn) {
  return cache[key] || (cache[key] = fn());
}

// Neutral detail texture multiplied over terrain vertex colours.
export function terrainDetail() {
  return cached('terrain', () => {
    const c = canvas(256, 256);
    const ctx = c.getContext('2d');
    noiseFill(ctx, 256, 256, [200, 200, 200], 0.28, 5, 2);
    // Sprinkle small blades / pebbles.
    const r = mulberry32(9);
    for (let i = 0; i < 1800; i++) {
      const x = r() * 256;
      const y = r() * 256;
      const g = 150 + r() * 100;
      ctx.fillStyle = `rgba(${g},${g},${g},${0.25 + r() * 0.3})`;
      ctx.fillRect(x, y, 1 + r() * 1.5, 1 + r() * 3);
    }
    return toTexture(c);
  });
}

export function asphaltTexture() {
  return cached('asphalt', () => {
    const W = 256;
    const H = 512;
    const c = canvas(W, H);
    const ctx = c.getContext('2d');
    noiseFill(ctx, W, H, [70, 72, 76], 0.16, 21, 3);
    // Tyre wear darker lanes.
    for (const u of [0.22, 0.34, 0.66, 0.78]) {
      const g = ctx.createLinearGradient((u - 0.06) * W, 0, (u + 0.06) * W, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, 'rgba(20,20,22,0.25)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect((u - 0.06) * W, 0, 0.12 * W, H);
    }
    // Edge lines.
    ctx.fillStyle = 'rgba(235,235,230,0.92)';
    ctx.fillRect(0.035 * W, 0, 0.022 * W, H);
    ctx.fillRect((1 - 0.057) * W, 0, 0.022 * W, H);
    // Dashed centre line.
    ctx.fillStyle = 'rgba(240,200,60,0.95)';
    ctx.fillRect(0.49 * W, 0, 0.02 * W, H * 0.5);
    // Cracks.
    const r = mulberry32(3);
    ctx.strokeStyle = 'rgba(25,25,25,0.5)';
    for (let i = 0; i < 14; i++) {
      ctx.lineWidth = 0.6 + r();
      ctx.beginPath();
      let x = r() * W;
      let y = r() * H;
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (r() - 0.5) * 18;
        y += (r() - 0.5) * 18;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return toTexture(c);
  });
}

// Wide runway / car park asphalt without lane markings.
export function plainAsphaltTexture() {
  return cached('plainAsphalt', () => {
    const c = canvas(256, 256);
    noiseFill(c.getContext('2d'), 256, 256, [74, 76, 80], 0.15, 33, 3);
    return toTexture(c);
  });
}

export function dirtTexture(theme = 'desert') {
  return cached('dirt_' + theme, () => {
    const W = 256;
    const H = 512;
    const c = canvas(W, H);
    const ctx = c.getContext('2d');
    const base = theme === 'forest' ? [116, 88, 62] : theme === 'canyon' ? [168, 104, 70] : [178, 140, 98];
    noiseFill(ctx, W, H, base, 0.22, 44, 3);
    // Packed racing line ruts (darker, smoother).
    for (const u of [0.3, 0.42, 0.58, 0.7]) {
      const g = ctx.createLinearGradient((u - 0.07) * W, 0, (u + 0.07) * W, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, 'rgba(40,25,10,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect((u - 0.07) * W, 0, 0.14 * W, H);
    }
    // Loose stones and gravel at the edges.
    const r = mulberry32(12);
    for (let i = 0; i < 2200; i++) {
      const edge = r() < 0.6;
      const u = edge ? (r() < 0.5 ? r() * 0.18 : 1 - r() * 0.18) : r();
      const x = u * W;
      const y = r() * H;
      const s = 0.8 + r() * 2.2;
      const l = 0.7 + r() * 0.6;
      ctx.fillStyle = `rgba(${base[0] * l | 0},${base[1] * l | 0},${base[2] * l | 0},0.9)`;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * (0.6 + r() * 0.5), r() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Soft edge fade into the verge.
    const ge = ctx.createLinearGradient(0, 0, W, 0);
    ge.addColorStop(0, 'rgba(0,0,0,0.25)');
    ge.addColorStop(0.06, 'rgba(0,0,0,0)');
    ge.addColorStop(0.94, 'rgba(0,0,0,0)');
    ge.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = ge;
    ctx.fillRect(0, 0, W, H);
    return toTexture(c);
  });
}

export function checkerTexture(cols = 8, rows = 2) {
  return cached(`checker${cols}x${rows}`, () => {
    const c = canvas(256, 64 * rows);
    const ctx = c.getContext('2d');
    const cw = 256 / cols;
    const ch = c.height / rows;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
        ctx.fillRect(x * cw, y * ch, cw, ch);
      }
    return toTexture(c);
  });
}

export function bannerTexture(text) {
  return cached('banner' + text, () => {
    const c = canvas(1024, 128);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#d8161e');
    g.addColorStop(1, '#8e0b10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 128);
    for (let x = 0; x < 1024; x += 32) {
      ctx.fillStyle = (x / 32) % 2 ? '#111' : '#fff';
      ctx.fillRect(x, 0, 32, 14);
      ctx.fillStyle = (x / 32) % 2 ? '#fff' : '#111';
      ctx.fillRect(x, 114, 32, 14);
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'italic 900 70px system-ui, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 512, 66);
    return toTexture(c, { repeat: false });
  });
}

export function stripeTexture(a = '#d61e1e', b = '#f2f2f2') {
  return cached('stripe' + a + b, () => {
    const c = canvas(128, 32);
    const ctx = c.getContext('2d');
    for (let x = -32; x < 160; x += 32) {
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.moveTo(x, 32);
      ctx.lineTo(x + 16, 0);
      ctx.lineTo(x + 32, 0);
      ctx.lineTo(x + 16, 32);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = b;
    ctx.fillRect(0, 0, 128, 32);
    return toTexture(c);
  });
}

export function woodTexture() {
  return cached('wood', () => {
    const c = canvas(256, 64);
    const ctx = c.getContext('2d');
    noiseFill(ctx, 256, 64, [128, 92, 58], 0.18, 71, 2);
    ctx.strokeStyle = 'rgba(50,30,15,0.5)';
    for (let y = 0; y < 64; y += 16) {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(256, y + 0.5);
      ctx.stroke();
    }
    return toTexture(c);
  });
}

export function chevronTexture() {
  return cached('chevron', () => {
    const c = canvas(256, 64);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#ffd21a';
    for (let x = 8; x < 256; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x + 26, 8);
      ctx.lineTo(x + 50, 32);
      ctx.lineTo(x + 26, 56);
      ctx.lineTo(x, 56);
      ctx.lineTo(x + 24, 32);
      ctx.fill();
    }
    return toTexture(c, { repeat: false });
  });
}

export function windowsTexture(seed = 1, tint = [190, 200, 210]) {
  return cached('windows' + seed, () => {
    const c = canvas(256, 256);
    const ctx = c.getContext('2d');
    noiseFill(ctx, 256, 256, tint, 0.08, seed, 2);
    const r = mulberry32(seed * 7);
    // 4x4 window grid per tile (one tile = 4 m wide, 3.5 m tall per row).
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const lit = r();
        const b = 40 + lit * 70;
        const g = ctx.createLinearGradient(0, y * 64 + 12, 0, y * 64 + 52);
        g.addColorStop(0, `rgb(${b * 0.8 | 0},${b | 0},${b * 1.25 | 0})`);
        g.addColorStop(1, `rgb(${b * 0.5 | 0},${b * 0.65 | 0},${b * 0.85 | 0})`);
        ctx.fillStyle = g;
        ctx.fillRect(x * 64 + 10, y * 64 + 12, 44, 40);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x * 64 + 10, y * 64 + 12, 44, 4);
      }
    return toTexture(c);
  });
}

export function crowdTexture() {
  return cached('crowd', () => {
    const c = canvas(256, 64);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3a3f48';
    ctx.fillRect(0, 0, 256, 64);
    const r = mulberry32(5);
    const cols = ['#e33', '#fd3', '#3ae', '#fff', '#2c5', '#f80', '#a4f', '#222'];
    for (let row = 0; row < 4; row++)
      for (let x = 2; x < 256; x += 5 + r() * 3) {
        ctx.fillStyle = cols[(r() * cols.length) | 0];
        const y = row * 16 + 6 + r() * 2;
        ctx.fillRect(x, y, 4, 8);
        ctx.fillStyle = '#e8c39e';
        ctx.fillRect(x + 0.5, y - 3, 3, 3);
      }
    return toTexture(c);
  });
}

export function cloudTexture() {
  return cached('cloud', () => {
    const c = canvas(256, 128);
    const ctx = c.getContext('2d');
    const r = mulberry32(17);
    for (let i = 0; i < 26; i++) {
      const x = 40 + r() * 176;
      const y = 50 + r() * 40 - Math.abs(x - 128) * 0.12;
      const rad = 18 + r() * 30;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    return toTexture(c, { repeat: false });
  });
}

export function numberDecal(num, color = '#ffffff') {
  return cached('num' + num + color, () => {
    const c = canvas(128, 128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#111';
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = '900 72px system-ui, Arial Black, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 64, 68);
    return toTexture(c, { repeat: false });
  });
}

export function tireTreadTexture() {
  return cached('tread', () => {
    const c = canvas(64, 256);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1b1b1d';
    ctx.fillRect(0, 0, 64, 256);
    ctx.fillStyle = '#0c0c0d';
    for (let y = 0; y < 256; y += 16) {
      ctx.fillRect(4, y, 24, 7);
      ctx.fillRect(36, y + 8, 24, 7);
    }
    return toTexture(c);
  });
}

export function rockTexture() {
  return cached('rock', () => {
    const c = canvas(256, 256);
    const ctx = c.getContext('2d');
    noiseFill(ctx, 256, 256, [170, 160, 150], 0.3, 88, 4);
    return toTexture(c);
  });
}

export function waterNormalLike() {
  return cached('water', () => {
    const c = canvas(256, 256);
    const ctx = c.getContext('2d');
    noiseFill(ctx, 256, 256, [40, 90, 120], 0.12, 64, 4);
    return toTexture(c);
  });
}
