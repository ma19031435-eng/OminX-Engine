/**
 * OminX Engine — noise & procedural generation helpers.
 * Perlin/simplex/value noise, fbm, worley, plus a domain-warped generator
 * used for procedural materials, muzzle-scorch decals and map variation.
 * @module engine/math/Noise
 */
import { RNG } from './Random.js';
import { lerp, smootherstep, clamp01 } from './MathUtils.js';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

export class Noise {
  /** @param {number} [seed] */
  constructor(seed = 1337) {
    this.rng = new RNG(seed);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = this.rng.nextInteger(0, i);
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = perm[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }
  static new(seed) { return new Noise(seed); }

  /** 2D simplex noise in [-1, 1]. */
  simplex2(xin, yin) {
    const perm = this.perm, permMod12 = this.permMod12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = xin - X0, y0 = yin - Y0;
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { const gi0 = permMod12[ii + perm[jj]]; t0 *= t0; n0 = t0 * t0 * (GRAD3[gi0][0] * x0 + GRAD3[gi0][1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { const gi1 = permMod12[ii + i1 + perm[jj + j1]]; t1 *= t1; n1 = t1 * t1 * (GRAD3[gi1][0] * x1 + GRAD3[gi1][1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { const gi2 = permMod12[ii + 1 + perm[jj + 1]]; t2 *= t2; n2 = t2 * t2 * (GRAD3[gi2][0] * x2 + GRAD3[gi2][1] * y2); }
    return 70 * (n0 + n1 + n2);
  }

  /** 3D simplex noise in [-1, 1]. */
  simplex3(xin, yin, zin) {
    const perm = this.perm, permMod12 = this.permMod12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 >= 0) { const gi0 = permMod12[ii + perm[jj + perm[kk]]]; t0 *= t0; n0 = t0 * t0 * (GRAD3[gi0][0] * x0 + GRAD3[gi0][1] * y0 + GRAD3[gi0][2] * z0); }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 >= 0) { const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]; t1 *= t1; n1 = t1 * t1 * (GRAD3[gi1][0] * x1 + GRAD3[gi1][1] * y1 + GRAD3[gi1][2] * z1); }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 >= 0) { const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]; t2 *= t2; n2 = t2 * t2 * (GRAD3[gi2][0] * x2 + GRAD3[gi2][1] * y2 + GRAD3[gi2][2] * z2); }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 >= 0) { const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]; t3 *= t3; n3 = t3 * t3 * (GRAD3[gi3][0] * x3 + GRAD3[gi3][1] * y3 + GRAD3[gi3][2] * z3); }
    return 32 * (n0 + n1 + n2 + n3);
  }

  /** Classic Perlin gradient noise, 3D, [-1,1]. */
  perlin3(x, y, z) {
    const perm = this.perm;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = smootherstep(0, 1, x), v = smootherstep(0, 1, y), w = smootherstep(0, 1, z);
    const grad = (hash, gx, gy, gz) => {
      const h = perm[hash] % 12;
      return GRAD3[h][0] * gx + GRAD3[h][1] * gy + GRAD3[h][2] * gz;
    };
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    const x1 = lerp(grad(AA, x, y, z), grad(BA, x - 1, y, z), u);
    const x2 = lerp(grad(AB, x, y - 1, z), grad(BB, x - 1, y - 1, z), u);
    const y1 = lerp(x1, x2, v);
    const x3 = lerp(grad(AA + 1, x, y, z - 1), grad(BA + 1, x - 1, y, z - 1), u);
    const x4 = lerp(grad(AB + 1, x, y - 1, z - 1), grad(BB + 1, x - 1, y - 1, z - 1), u);
    const y2 = lerp(x3, x4, v);
    return lerp(y1, y2, w) * 0.5;
  }
  perlin2(x, y) { return this.perlin3(x, y, 0.5); }

  /** Fractal Brownian motion. */
  fbm2(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / (norm || 1);
  }
  fbm3(x, y, z, octaves = 5, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / (norm || 1);
  }
  /** Ridged multifractal — good for rock/terrain silhouettes. */
  ridged2(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.simplex2(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / (norm || 1);
  }
  /** Domain-warped fbm — organic, good for camo/grunge textures. */
  warped2(x, y, strength = 1.5, octaves = 4) {
    const wx = this.fbm2(x + 5.2, y + 1.3, 3);
    const wy = this.fbm2(x - 3.7, y + 2.8, 3);
    return this.fbm2(x + strength * wx, y + strength * wy, octaves);
  }
  /** Worley/cellular noise returning distance to nearest feature point (0..1ish). */
  worley2(x, y, cells = 1) {
    const xi = Math.floor(x * cells), yi = Math.floor(y * cells);
    let minDist = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy;
        const h = this.perm[(cx & 255) + this.perm[(cy & 255)]] / 255;
        const h2 = this.perm[((cx + 37) & 255) + this.perm[((cy + 91) & 255)]] / 255;
        const px = (cx + h) / cells, py = (cy + h2) / cells;
        const d = Math.hypot(x - px, y - py);
        if (d < minDist) minDist = d;
      }
    }
    return clamp01(minDist * cells);
  }
  /** Absolute-value turbulence, useful for smoke/fire masks. */
  turbulence2(x, y, octaves = 5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * Math.abs(this.simplex2(x * freq, y * freq));
      norm += amp;
      amp *= 0.5; freq *= 2;
    }
    return sum / (norm || 1);
  }
}
const _defaultNoise = new Noise(1337);
Object.assign(Noise, {
  /** Shared-seed convenience wrappers (static form of the instance methods). */
  noise2D(x, y) { return _defaultNoise.simplex2(x, y); },
  noise3D(x, y, z) { return _defaultNoise.simplex3(x, y, z); },
  perlin2D(x, y) { return _defaultNoise.perlin2(x, y); },
  fbm2(x, y, octaves = 5) { return _defaultNoise.fbm2(x, y, octaves); },
  fbm3(x, y, z, octaves = 5) { return _defaultNoise.fbm3(x, y, z, octaves); },
});

export default Noise;
