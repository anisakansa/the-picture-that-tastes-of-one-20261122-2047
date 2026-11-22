// The picture that tastes of one ingredient — one hero burger, painted procedurally.
// Zero-dependency Node 22 (stdlib only): software rasterizer + hand-rolled PNG encoder.
// Writes a single 1024x1024 PNG to /output/entry.png. Deterministic (fixed seed).
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";

const W = 1024;
const H = 1024;
const buf = new Uint8Array(W * H * 4);

// ---------- deterministic PRNG ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261123);

// ---------- value noise ----------
function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
type RGBA = [number, number, number, number];

function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 4;
  const ia = 1 - a;
  buf[i] = clamp255(r * a + buf[i] * ia);
  buf[i + 1] = clamp255(g * a + buf[i + 1] * ia);
  buf[i + 2] = clamp255(b * a + buf[i + 2] * ia);
  buf[i + 3] = 255;
}

// Fill an ellipse; fn(nx, ny, d01) -> RGBA. d01 = normalized distance 0..1.
function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fn: (nx: number, ny: number, d: number) => RGBA,
  yMax: number = H,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry), Math.floor(yMax));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const d2 = nx * nx + ny * ny;
      if (d2 <= 1) {
        const c = fn(nx, ny, Math.sqrt(d2));
        blend(x, y, c[0], c[1], c[2], c[3]);
      }
    }
  }
}

function rect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fn: (x: number, y: number) => RGBA,
): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const c = fn(x, y);
      blend(x, y, c[0], c[1], c[2], c[3]);
    }
  }
}

// Soft round stamp (used for steam + gloss).
function stamp(cx: number, cy: number, r: number, cr: number, cg: number, cb: number, alpha: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d <= 1) {
        const fall = (1 - d * d) * (1 - d * d);
        blend(x, y, cr, cg, cb, alpha * fall);
      }
    }
  }
}

// Thick soft line: stamp along the segment.
function softLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  cr: number,
  cg: number,
  cb: number,
  alpha: number,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / (w * 0.4)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stamp(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, cr, cg, cb, alpha);
  }
}

// ================= PAINTING =================

// 1. Background: warm vertical gradient + warm glow behind the burger.
rect(0, 0, W - 1, H - 1, (x, y) => {
  const t = y / H;
  const r = lerp(58, 26, t);
  const g = lerp(38, 18, t);
  const b = lerp(24, 12, t);
  return [r, g, b, 1];
});
ellipse(512, 470, 520, 430, (nx, ny, d) => {
  const glow = (1 - d) * 0.34;
  return [196, 128, 62, glow];
});

// 2. Table shadow + plate.
ellipse(512, 828, 375, 72, (_nx, _ny, d) => [0, 0, 0, (1 - d) * 0.38]);
ellipse(512, 792, 352, 96, (_nx, _ny, d) => {
  const r = lerp(244, 214, d);
  const g = lerp(236, 196, d);
  const b = lerp(218, 164, d);
  return [r, g, b, 1];
});
ellipse(512, 792, 300, 76, (_nx, _ny, d) => {
  const r = lerp(247, 232, d);
  const g = lerp(240, 214, d);
  const b = lerp(224, 182, d);
  return [r, g, b, 1];
});
// Contact shadow of the burger on the plate.
ellipse(512, 782, 285, 30, (_nx, _ny, d) => [0, 0, 0, (1 - d) * 0.22]);

// 3. Bottom bun.
ellipse(512, 748, 272, 44, (nx, ny, d) => {
  const t = (ny + 1) / 2;
  const r = lerp(226, 158, t);
  const g = lerp(164, 106, t);
  const b = lerp(74, 30, t);
  const edge = d > 0.92 ? 0.85 : 1;
  return [r * edge, g * edge, b * edge, 1];
});

// 4. Patty: dark, charred, speckled.
ellipse(512, 706, 296, 35, (nx, ny, _d) => {
  const n = vnoise(nx * 26 + 7, ny * 26 + 3);
  const n2 = vnoise(nx * 90 + 31, ny * 90 + 11);
  let r = lerp(74, 96, n);
  let g = lerp(46, 62, n);
  let b = lerp(28, 38, n);
  if (n2 > 0.72) {
    r = lerp(r, 122, 0.5);
    g = lerp(g, 78, 0.5);
    b = lerp(b, 44, 0.5);
  }
  if (ny < -0.55) {
    r *= 1.18;
    g *= 1.18;
    b *= 1.18;
  }
  return [r, g, b, 1];
});

// 5. Cheese + drips.
ellipse(512, 672, 292, 23, (nx, ny, _d) => {
  const t = (ny + 1) / 2;
  return [lerp(250, 222, t), lerp(172, 128, t), lerp(38, 12, t), 1];
});
const dripX = [288, 388, 512, 636, 736];
for (const dx of dripX) {
  const len = 20 + rnd() * 14;
  ellipse(dx, 690 + len / 2 - 6, 17, len / 2 + 8, (_nx, _ny, d) => {
    const shade = d > 0.8 ? 0.9 : 1;
    return [238 * shade, 152 * shade, 22 * shade, 1];
  });
}

// 6. Tomato slice.
ellipse(512, 648, 266, 19, (nx, ny, _d) => {
  const t = (ny + 1) / 2;
  return [lerp(214, 168, t), lerp(64, 40, t), lerp(44, 28, t), 1];
});
ellipse(512, 646, 240, 12, (_nx, _ny, d) => [226, 84, 60, (1 - d) * 0.55]);

// 7. Lettuce: wavy ruffled edge.
{
  const cx = 512;
  const cy = 622;
  const baseRx = 288;
  const baseRy = 21;
  const x0 = Math.max(0, Math.floor(cx - baseRx * 1.15));
  const x1 = Math.min(W - 1, Math.ceil(cx + baseRx * 1.15));
  const y0 = Math.max(0, Math.floor(cy - baseRy * 1.4));
  const y1 = Math.min(H - 1, Math.ceil(cy + baseRy * 1.4));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / baseRx;
      const dy = (y - cy) / baseRy;
      const ang = Math.atan2(dy, dx);
      const mod = 1 + 0.16 * Math.sin(ang * 9 + 1.3) + 0.06 * Math.sin(ang * 23);
      const d = Math.sqrt(dx * dx + dy * dy) / mod;
      if (d <= 1) {
        const edge = d > 0.85 ? 0.8 : 1;
        const vein = vnoise(x * 0.06, y * 0.06) > 0.62 ? 0.88 : 1;
        blend(x, y, 111 * edge * vein, 168 * edge * vein, 52 * edge * vein, 1);
      }
    }
  }
}

// 8. Top bun dome (clipped to y <= 612).
ellipse(
  512,
  612,
  302,
  282,
  (nx, ny, d) => {
    const t = (ny + 1) / 2; // 0 top -> 1 bottom edge
    let r = lerp(240, 196, t);
    let g = lerp(192, 138, t);
    let b = lerp(106, 44, t);
    // warm radial highlight upper-left
    const hx = (nx * 302 + 512 - 430) / 150;
    const hy = (ny * 282 + 612 - 400) / 150;
    const hd = Math.hypot(hx, hy);
    if (hd < 1) {
      const k = (1 - hd) * 0.35;
      r = lerp(r, 255, k);
      g = lerp(g, 226, k);
      b = lerp(b, 150, k);
    }
    // toasted rim near bottom edge
    if (t > 0.9) {
      r *= 0.88;
      g *= 0.85;
      b *= 0.8;
    }
    // soft edge
    const edge = d > 0.985 ? 0.9 : 1;
    return [r * edge, g * edge, b * edge, 1];
  },
  612,
);

// 9. Sesame seeds (deterministic positions on the dome).
const seeds: Array<[number, number, number]> = [
  [392, 420, 0.4], [470, 380, -0.3], [556, 396, 0.2], [628, 452, 0.5],
  [430, 500, -0.5], [520, 470, 0.1], [604, 512, -0.2], [352, 500, 0.6],
  [662, 540, 0.3], [480, 540, -0.4], [580, 560, 0.15], [420, 580, 0.45],
  [660, 470, -0.6], [540, 420, 0.0],
];
for (const [sx, sy, rot] of seeds) {
  // shadow under the seed
  ellipse(sx + 2, sy + 3, 11, 5.5, (_nx, _ny, d) => [150, 104, 40, (1 - d) * 0.5]);
  void rot;
  ellipse(sx, sy, 11, 5.5, (_nx, _ny, d) => {
    const shade = d > 0.7 ? 0.92 : 1;
    return [248 * shade, 231 * shade, 184 * shade, 1];
  });
}

// 10. Gloss on the dome.
stamp(430, 400, 110, 255, 240, 200, 0.16);
stamp(470, 430, 60, 255, 244, 210, 0.14);

// 11. Steam wisps rising from the dome.
const wisps: Array<[number, number, number]> = [
  [430, 330, 0],
  [512, 320, 2.1],
  [596, 332, 4.0],
];
for (const [wx, wy, phase] of wisps) {
  const steps = 26;
  let px = wx;
  let py = wy;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const nx = wx + 20 * Math.sin(t * 5.2 + phase) + 6 * t;
    const ny = wy - t * 210;
    softLine(px, py, nx, ny, 26 - 8 * t, 255, 250, 240, 0.055);
    softLine(px, py, nx, ny, 12, 255, 250, 240, 0.05);
    px = nx;
    py = ny;
  }
}

// 12. Vignette.
rect(0, 0, W - 1, H - 1, (x, y) => {
  const dx = (x - 512) / 512;
  const dy = (y - 512) / 512;
  const d = Math.sqrt(dx * dx + dy * dy);
  const v = d < 0.62 ? 1 : 1 - 0.32 * ((d - 0.62) / 0.6) * ((d - 0.62) / 0.6);
  const i = (y * W + x) * 4;
  buf[i] = clamp255(buf[i] * v);
  buf[i + 1] = clamp255(buf[i + 1] * v);
  buf[i + 2] = clamp255(buf[i + 2] * v);
  return [buf[i], buf[i + 1], buf[i + 2], 0];
});

// ================= PNG ENCODE =================
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc32(crcData));
  return out;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function encodePNG(): Uint8Array {
  const bpp = 3;
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  const prev = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      row[x * 3] = buf[si];
      row[x * 3 + 1] = buf[si + 1];
      row[x * 3 + 2] = buf[si + 2];
    }
    // pick best filter by sum of |signed byte|
    let bestFilter = 0;
    let bestScore = Infinity;
    let bestRow: Uint8Array = row;
    for (let f = 0; f <= 4; f++) {
      const fr = new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = prev[i];
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = left;
        else if (f === 2) pred = up;
        else if (f === 3) pred = Math.floor((left + up) / 2);
        else if (f === 4) pred = paeth(left, up, upLeft);
        fr[i] = (row[i] - pred) & 0xff;
      }
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const s = fr[i] < 128 ? fr[i] : fr[i] - 256;
        score += s < 0 ? -s : s;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        bestRow = fr;
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    raw.set(bestRow, y * (stride + 1) + 1);
    prev.set(row);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const png = encodePNG();
fs.mkdirSync("/output", { recursive: true });
fs.writeFileSync("/output/entry.png", png);
const sha = crypto.createHash("sha256").update(png).digest("hex");
console.log(`entry.png ${W}x${H}, ${png.length} bytes, sha256 ${sha}`);
