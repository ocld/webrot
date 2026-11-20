import type { SeededRng } from "./prng";
import type { RotMode } from "./types";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function luma(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

// 1) scattered 2d block tears: vertical strips, horizontal bars & macroblocks teleported in any direction
function opBlockTear(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const src = new Uint8ClampedArray(px);
  const count = Math.max(4, Math.round(6 + t * 48));

  for (let i = 0; i < count; i++) {
    const shape = rng.int(0, 2); // 0 = vertical strip, 1 = horizontal bar, 2 = 2d macroblock
    let bw: number;
    let bh: number;
    if (shape === 0) {
      bw = Math.max(4, Math.round(w * (0.015 + rng.next() * (0.05 + t * 0.12))));
      bh = Math.max(12, Math.round(h * (0.12 + rng.next() * (0.35 + t * 0.5))));
    } else if (shape === 1) {
      bw = Math.max(12, Math.round(w * (0.12 + rng.next() * (0.35 + t * 0.5))));
      bh = Math.max(4, Math.round(h * (0.015 + rng.next() * (0.05 + t * 0.12))));
    } else {
      bw = Math.max(8, Math.round(w * (0.04 + rng.next() * (0.14 + t * 0.18))));
      bh = Math.max(8, Math.round(h * (0.04 + rng.next() * (0.14 + t * 0.18))));
    }

    const sx = rng.int(0, Math.max(0, w - bw));
    const sy = rng.int(0, Math.max(0, h - bh));
    const maxShiftX = Math.max(8, Math.round(w * (0.08 + t * 0.35)));
    const maxShiftY = Math.max(8, Math.round(h * (0.08 + t * 0.35)));
    const dx = clamp(sx + rng.int(-maxShiftX, maxShiftX), 0, Math.max(0, w - bw));
    const dy = clamp(sy + rng.int(-maxShiftY, maxShiftY), 0, Math.max(0, h - bh));

    const flipX = rng.chance(0.28);
    const flipY = rng.chance(0.22);
    const tintMode = rng.int(0, 4); // 0..2 plain, 3 channel swap, 4 xor mask
    const xorR = rng.int(20, 220);
    const xorG = rng.int(20, 220);
    const xorB = rng.int(20, 220);

    for (let y = 0; y < bh; y++) {
      const readY = sy + (flipY ? bh - 1 - y : y);
      const writeY = dy + y;
      for (let x = 0; x < bw; x++) {
        const readX = sx + (flipX ? bw - 1 - x : x);
        const writeX = dx + x;
        const si = (readY * w + readX) * 4;
        const di = (writeY * w + writeX) * 4;
        if (tintMode === 3) {
          px[di] = src[si + 2];
          px[di + 1] = src[si];
          px[di + 2] = src[si + 1];
          px[di + 3] = src[si + 3];
        } else if (tintMode === 4) {
          px[di] = src[si] ^ xorR;
          px[di + 1] = src[si + 1] ^ xorG;
          px[di + 2] = src[si + 2] ^ xorB;
          px[di + 3] = src[si + 3];
        } else {
          px[di] = src[si];
          px[di + 1] = src[si + 1];
          px[di + 2] = src[si + 2];
          px[di + 3] = src[si + 3];
        }
      }
    }
  }
}

// 2) multi-axis pixel sorting: sorts pixel spans vertically, horizontally, or diagonally in random patches
function opPixelSort(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const axis = rng.int(0, 2); // 0 = vertical columns, 1 = horizontal rows, 2 = diagonal streaks
  const asc = rng.chance(0.5);
  const keyMode = rng.int(0, 3); // 0 = luma, 1 = red, 2 = green, 3 = chroma/sat
  // widen luminance window with intensity so dark & high-contrast images still get bold streaks
  const loThresh = Math.max(0, Math.round(rng.int(0, 45) * (1 - t * 0.85)));
  const hiThresh = Math.min(255, Math.round(215 + rng.int(0, 40) * t + 40 * t));
  const patches = Math.max(3, Math.round(4 + t * 18));

  const pixelKey = (r: number, g: number, b: number): number => {
    if (keyMode === 1) return r;
    if (keyMode === 2) return g;
    if (keyMode === 3) return Math.max(r, g, b) - Math.min(r, g, b);
    return luma(r, g, b);
  };

  const sortLine = (indices: number[]) => {
    const n = indices.length;
    if (n < 4) return;
    let i = 0;
    while (i < n) {
      const idx0 = indices[i] * 4;
      if (px[idx0 + 3] < 16) {
        i++;
        continue;
      }
      const l0 = luma(px[idx0], px[idx0 + 1], px[idx0 + 2]);
      if (l0 < loThresh || l0 > hiThresh) {
        i++;
        continue;
      }
      let j = i + 1;
      const maxRun = Math.max(16, Math.round(n * (0.28 + t * 0.72)));
      while (j < n && j - i < maxRun) {
        const idxJ = indices[j] * 4;
        if (px[idxJ + 3] < 16) break;
        const lJ = luma(px[idxJ], px[idxJ + 1], px[idxJ + 2]);
        if (lJ < loThresh || lJ > hiThresh) break;
        j++;
      }
      const span = j - i;
      if (span >= 4) {
        const items: Array<{ key: number; r: number; g: number; b: number; a: number }> = [];
        for (let k = i; k < j; k++) {
          const o = indices[k] * 4;
          const r = px[o];
          const g = px[o + 1];
          const b = px[o + 2];
          items.push({ key: pixelKey(r, g, b), r, g, b, a: px[o + 3] });
        }
        items.sort(asc ? (a, b) => a.key - b.key : (a, b) => b.key - a.key);
        for (let k = 0; k < span; k++) {
          const o = indices[i + k] * 4;
          const it = items[k];
          px[o] = it.r;
          px[o + 1] = it.g;
          px[o + 2] = it.b;
          px[o + 3] = it.a;
        }
      }
      i = j + 1;
    }
  };

  for (let p = 0; p < patches; p++) {
    const pw = Math.max(16, Math.round(w * (0.14 + rng.next() * (0.35 + t * 0.45))));
    const ph = Math.max(16, Math.round(h * (0.14 + rng.next() * (0.35 + t * 0.45))));
    const x0 = rng.int(0, Math.max(0, w - pw));
    const y0 = rng.int(0, Math.max(0, h - ph));
    const useAxis = rng.chance(0.75) ? axis : rng.int(0, 2);

    if (useAxis === 0) {
      // vertical pixel sort (columns)
      for (let x = x0; x < x0 + pw; x++) {
        if (rng.chance(0.15)) continue;
        const line: number[] = [];
        for (let y = y0; y < y0 + ph; y++) line.push(y * w + x);
        sortLine(line);
      }
    } else if (useAxis === 1) {
      // horizontal pixel sort (rows)
      for (let y = y0; y < y0 + ph; y++) {
        if (rng.chance(0.15)) continue;
        const line: number[] = [];
        for (let x = x0; x < x0 + pw; x++) line.push(y * w + x);
        sortLine(line);
      }
    } else {
      // diagonal pixel sort (45-degree streaks)
      const dir = rng.chance(0.5) ? 1 : -1;
      const step = Math.max(1, Math.floor((pw + ph) / 280));
      for (let d = -ph; d < pw; d += step) {
        const line: number[] = [];
        for (let k = 0; k < ph; k++) {
          const x = x0 + (dir === 1 ? d + k : pw - 1 - (d + k));
          const y = y0 + k;
          if (x >= x0 && x < x0 + pw && y >= y0 && y < y0 + ph) {
            line.push(y * w + x);
          }
        }
        if (line.length >= 6) sortLine(line);
      }
    }
  }
}

// 3) 2d chromatic prism split: independent R/G/B 2d offset vectors + scattered channel-swapped zones
function opRgbSplit(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const src = new Uint8ClampedArray(px);
  const maxD = Math.max(4, Math.round(Math.min(w, h) * (0.015 + t * 0.11)));

  const rdx = rng.int(-maxD, maxD);
  const rdy = rng.int(-maxD, maxD);
  const gdx = rng.int(-Math.round(maxD * 0.6), Math.round(maxD * 0.6));
  const gdy = rng.int(-Math.round(maxD * 0.6), Math.round(maxD * 0.6));
  const bdx = rng.int(-maxD, maxD);
  const bdy = rng.int(-maxD, maxD);

  for (let y = 0; y < h; y++) {
    const ry = clamp(y + rdy, 0, h - 1);
    const gy = clamp(y + gdy, 0, h - 1);
    const by = clamp(y + bdy, 0, h - 1);
    for (let x = 0; x < w; x++) {
      const rx = clamp(x + rdx, 0, w - 1);
      const gx = clamp(x + gdx, 0, w - 1);
      const bx = clamp(x + bdx, 0, w - 1);
      const di = (y * w + x) * 4;
      px[di] = src[(ry * w + rx) * 4];
      px[di + 1] = src[(gy * w + gx) * 4 + 1];
      px[di + 2] = src[(by * w + bx) * 4 + 2];
    }
  }

  // add scattered localized high-offset prism patches
  const patches = Math.max(2, Math.round(3 + t * 18));
  for (let p = 0; p < patches; p++) {
    const bw = Math.max(12, Math.round(w * (0.06 + rng.next() * 0.25)));
    const bh = Math.max(12, Math.round(h * (0.06 + rng.next() * 0.25)));
    const x0 = rng.int(0, Math.max(0, w - bw));
    const y0 = rng.int(0, Math.max(0, h - bh));
    const pDx = rng.int(-maxD * 2, maxD * 2);
    const pDy = rng.int(-maxD * 2, maxD * 2);
    const perm = rng.int(0, 2); // swap channel indices

    for (let y = y0; y < y0 + bh; y++) {
      const sy = clamp(y + pDy, 0, h - 1);
      for (let x = x0; x < x0 + bw; x++) {
        const sx = clamp(x + pDx, 0, w - 1);
        const di = (y * w + x) * 4;
        const si = (sy * w + sx) * 4;
        if (perm === 0) {
          px[di] = src[si + 2];
          px[di + 2] = src[si];
        } else if (perm === 1) {
          px[di + 1] = src[si];
          px[di] = src[si + 1];
        } else {
          px[di + 1] = src[si + 2];
          px[di + 2] = src[si + 1];
        }
      }
    }
  }
}

// 4) 2d wave + vortex liquify melt (horizontal + vertical ripples + localized radial swirls)
function opMelt2d(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const src = new Uint8ClampedArray(px);
  const ampX = Math.max(3, Math.round(w * (0.012 + t * 0.085)));
  const ampY = Math.max(3, Math.round(h * (0.012 + t * 0.085)));
  const freqX = (0.01 + rng.next() * 0.045) * (600 / Math.max(200, h));
  const freqY = (0.01 + rng.next() * 0.045) * (600 / Math.max(200, w));
  const phaseX = rng.next() * Math.PI * 2;
  const phaseY = rng.next() * Math.PI * 2;
  const diagFreq = (0.008 + rng.next() * 0.025) * (600 / Math.max(200, Math.min(w, h)));

  // 1 to 3 localized swirl vortices at random (cx, cy) spots
  const vortexCount = rng.int(1, 3);
  const vortices = Array.from({ length: vortexCount }, () => ({
    cx: rng.next() * w,
    cy: rng.next() * h,
    radius: Math.min(w, h) * (0.14 + rng.next() * (0.24 + t * 0.25)),
    twist: (rng.chance(0.5) ? 1 : -1) * (1.2 + t * 5.2),
  }));

  for (let y = 0; y < h; y++) {
    const waveX = Math.sin(y * freqX + phaseX) * ampX;
    for (let x = 0; x < w; x++) {
      const waveY = Math.cos(x * freqY + phaseY) * ampY;
      const diag = Math.sin((x + y) * diagFreq + phaseX) * ampX * 0.45;
      let sx = x + waveX + diag;
      let sy = y + waveY - diag * 0.6;

      for (let v = 0; v < vortices.length; v++) {
        const vt = vortices[v];
        const dx = sx - vt.cx;
        const dy = sy - vt.cy;
        const dist = Math.hypot(dx, dy);
        if (dist < vt.radius && dist > 0.001) {
          const f = 1 - dist / vt.radius;
          const angle = f * f * vt.twist;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          sx = vt.cx + dx * cos - dy * sin;
          sy = vt.cy + dx * sin + dy * cos;
        }
      }

      const rx = clamp(Math.round(sx), 0, w - 1);
      const ry = clamp(Math.round(sy), 0, h - 1);
      const si = (ry * w + rx) * 4;
      const di = (y * w + x) * 4;
      px[di] = src[si];
      px[di + 1] = src[si + 1];
      px[di + 2] = src[si + 2];
      px[di + 3] = src[si + 3];
    }
  }
}

// 5) 2d tile shuffle: divides image into random grid, swaps tiles, rotates/flips random tiles
function opTileShuffle(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const src = new Uint8ClampedArray(px);
  const cols = rng.int(3, Math.max(4, Math.round(5 + t * 9)));
  const rows = rng.int(3, Math.max(4, Math.round(5 + t * 9)));
  const tw = Math.max(4, Math.floor(w / cols));
  const th = Math.max(4, Math.floor(h / rows));
  const total = cols * rows;
  const order = Array.from({ length: total }, (_, i) => i);

  const swaps = Math.max(2, Math.round(total * (0.2 + t * 0.85)));
  for (let i = 0; i < swaps; i++) {
    const a = rng.int(0, total - 1);
    const b = rng.int(0, total - 1);
    const tmp = order[a];
    order[a] = order[b];
    order[b] = tmp;
  }

  for (let dstIdx = 0; dstIdx < total; dstIdx++) {
    const srcIdx = order[dstIdx];
    const flipX = dstIdx !== srcIdx && rng.chance(0.3);
    const flipY = dstIdx !== srcIdx && rng.chance(0.25);
    if (dstIdx === srcIdx && !flipX && !flipY) continue;

    const sx0 = (srcIdx % cols) * tw;
    const sy0 = Math.floor(srcIdx / cols) * th;
    const dx0 = (dstIdx % cols) * tw;
    const dy0 = Math.floor(dstIdx / cols) * th;

    for (let y = 0; y < th && dy0 + y < h && sy0 + y < h; y++) {
      const ry = sy0 + (flipY ? th - 1 - y : y);
      const wy = dy0 + y;
      for (let x = 0; x < tw && dx0 + x < w && sx0 + x < w; x++) {
        const rx = sx0 + (flipX ? tw - 1 - x : x);
        const wx = dx0 + x;
        const si = (ry * w + rx) * 4;
        const di = (wy * w + wx) * 4;
        px[di] = src[si];
        px[di + 1] = src[si + 1];
        px[di + 2] = src[si + 2];
        px[di + 3] = src[si + 3];
      }
    }
  }
}

// 6) ghost stutter echoes: stamps decaying echoed copies of random 2d patches along arbitrary vectors
function opStutterEcho(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const src = new Uint8ClampedArray(px);
  const bursts = Math.max(3, Math.round(4 + t * 20));

  for (let b = 0; b < bursts; b++) {
    const bw = Math.max(12, Math.round(w * (0.06 + rng.next() * 0.24)));
    const bh = Math.max(12, Math.round(h * (0.06 + rng.next() * 0.24)));
    const sx = rng.int(0, Math.max(0, w - bw));
    const sy = rng.int(0, Math.max(0, h - bh));
    const steps = rng.int(3, 8);
    const stepX = rng.int(-Math.max(6, Math.round(bw * 0.55)), Math.max(6, Math.round(bw * 0.55)));
    const stepY = rng.int(-Math.max(6, Math.round(bh * 0.55)), Math.max(6, Math.round(bh * 0.55)));
    const blendXor = rng.chance(0.28);

    for (let s = 1; s <= steps; s++) {
      const ox = sx + stepX * s;
      const oy = sy + stepY * s;
      const alpha = Math.max(0.22, 0.9 - s * 0.11);
      for (let y = 0; y < bh; y++) {
        const wy = oy + y;
        if (wy < 0 || wy >= h) continue;
        for (let x = 0; x < bw; x++) {
          const wx = ox + x;
          if (wx < 0 || wx >= w) continue;
          const si = ((sy + y) * w + (sx + x)) * 4;
          const di = (wy * w + wx) * 4;
          if (blendXor) {
            px[di] = px[di] ^ Math.round(src[si] * alpha);
            px[di + 1] = px[di + 1] ^ Math.round(src[si + 1] * alpha);
            px[di + 2] = px[di + 2] ^ Math.round(src[si + 2] * alpha);
          } else {
            px[di] = Math.round(px[di] * (1 - alpha) + src[si] * alpha);
            px[di + 1] = Math.round(px[di + 1] * (1 - alpha) + src[si + 1] * alpha);
            px[di + 2] = Math.round(px[di + 2] * (1 - alpha) + src[si + 2] * alpha);
          }
        }
      }
    }
  }
}

// 7) solarize / invert / xor patches scattered across 2d shapes
function opInvertXor(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const patches = Math.max(3, Math.round(5 + t * 30));
  for (let p = 0; p < patches; p++) {
    const isCircle = rng.chance(0.3);
    const bw = Math.max(12, Math.round(w * (0.05 + rng.next() * (0.2 + t * 0.35))));
    const bh = Math.max(12, Math.round(h * (0.05 + rng.next() * (0.2 + t * 0.35))));
    const x0 = rng.int(0, Math.max(0, w - bw));
    const y0 = rng.int(0, Math.max(0, h - bh));
    const cx = x0 + bw * 0.5;
    const cy = y0 + bh * 0.5;
    const rx = bw * 0.5;
    const ry = bh * 0.5;
    const op = rng.int(0, 2); // 0 = invert, 1 = solarize, 2 = xor mask
    const maskR = rng.int(32, 255);
    const maskG = rng.int(32, 255);
    const maskB = rng.int(32, 255);
    const thresh = rng.int(75, 175);

    for (let y = y0; y < y0 + bh; y++) {
      for (let x = x0; x < x0 + bw; x++) {
        if (isCircle) {
          const nx = (x - cx) / rx;
          const ny = (y - cy) / ry;
          if (nx * nx + ny * ny > 1) continue;
        }
        const i = (y * w + x) * 4;
        if (op === 0) {
          px[i] = 255 - px[i];
          px[i + 1] = 255 - px[i + 1];
          px[i + 2] = 255 - px[i + 2];
        } else if (op === 1) {
          if (px[i] > thresh) px[i] = 255 - px[i];
          if (px[i + 1] > thresh) px[i + 1] = 255 - px[i + 1];
          if (px[i + 2] > thresh) px[i + 2] = 255 - px[i + 2];
        } else {
          px[i] ^= maskR;
          px[i + 1] ^= maskG;
          px[i + 2] ^= maskB;
        }
      }
    }
  }
}

// 8) mosaic bitcrush & color quantization in scattered 2d zones
function opCrushMosaic(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const zones = Math.max(3, Math.round(5 + t * 24));
  const levels = t > 0.7 ? 3 : t > 0.4 ? 5 : 8;
  const step = Math.max(1, Math.floor(255 / (levels - 1)));

  for (let z = 0; z < zones; z++) {
    const bw = Math.max(16, Math.round(w * (0.08 + rng.next() * (0.25 + t * 0.4))));
    const bh = Math.max(16, Math.round(h * (0.08 + rng.next() * (0.25 + t * 0.4))));
    const x0 = rng.int(0, Math.max(0, w - bw));
    const y0 = rng.int(0, Math.max(0, h - bh));
    const cell = rng.int(Math.max(4, Math.round(4 + t * 6)), Math.max(8, Math.round(10 + t * 28)));
    const dropChannel = rng.chance(0.35) ? rng.int(0, 2) : -1;

    for (let y = y0; y < y0 + bh; y += cell) {
      for (let x = x0; x < x0 + bw; x += cell) {
        const si = (y * w + x) * 4;
        let r = Math.round(px[si] / step) * step;
        let g = Math.round(px[si + 1] / step) * step;
        let b = Math.round(px[si + 2] / step) * step;
        if (dropChannel === 0) r = 0;
        else if (dropChannel === 1) g = 0;
        else if (dropChannel === 2) b = 0;

        for (let cy = 0; cy < cell && y + cy < y0 + bh; cy++) {
          for (let cx = 0; cx < cell && x + cx < x0 + bw; cx++) {
            const di = ((y + cy) * w + (x + cx)) * 4;
            px[di] = r;
            px[di + 1] = g;
            px[di + 2] = b;
          }
        }
      }
    }
  }
}

// 9) deepfry: crank contrast, saturation, edge crunch & noisy chromatic burn
function opDeepFry(px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng): void {
  const contrast = 1.45 + t * 2.4;
  const sat = 1.5 + t * 2.5;
  const noiseAmp = 14 + t * 58;

  for (let i = 0; i < px.length; i += 4) {
    let r = px[i];
    let g = px[i + 1];
    let b = px[i + 2];

    const avg = (r + g + b) / 3;
    r = avg + (r - avg) * sat;
    g = avg + (g - avg) * sat;
    b = avg + (b - avg) * sat;

    r = (r - 128) * contrast + 128 + (rng.next() - 0.5) * noiseAmp;
    g = (g - 128) * contrast + 128 + (rng.next() - 0.5) * noiseAmp;
    b = (b - 128) * contrast + 128 + (rng.next() - 0.5) * noiseAmp;

    px[i] = clamp(Math.round(r), 0, 255);
    px[i + 1] = clamp(Math.round(g), 0, 255);
    px[i + 2] = clamp(Math.round(b), 0, 255);
  }

  // throw in a few crispy macroblock hits
  if (t > 0.25) opCrushMosaic(px, w, h, t * 0.45, rng);
}

const ALL_2D_OPS: Array<{
  name: string;
  run: (px: Uint8ClampedArray, w: number, h: number, t: number, rng: SeededRng) => void;
}> = [
  { name: "block tear", run: opBlockTear },
  { name: "pixel sort", run: opPixelSort },
  { name: "rgb split", run: opRgbSplit },
  { name: "2d melt", run: opMelt2d },
  { name: "tile shuffle", run: opTileShuffle },
  { name: "ghost stutter", run: opStutterEcho },
  { name: "solarize xor", run: opInvertXor },
  { name: "mosaic crush", run: opCrushMosaic },
  { name: "deepfry", run: opDeepFry },
];

export interface ImageGlitch2dOutput {
  bytes: Uint8Array;
  strategy: string;
  summary: string;
  mutatedPixels: number;
}

export function applyImage2dOps(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  mode: RotMode,
  intensity: number,
  rng: SeededRng
): { usedNames: string[]; mutatedPixels: number } {
  const before = new Uint8ClampedArray(px);
  const t = Math.max(0.03, Math.min(1, intensity / 100));
  const usedNames: string[] = [];

  if (mode === "chaos" || mode === "smart") {
    // randomly pick 2 to 4 distinct 2d effects per seed so every reroll looks wildly different
    const pool = [...ALL_2D_OPS];
    const picks = mode === "chaos" ? rng.int(2, 4) : rng.int(2, 3);
    for (let i = 0; i < picks && pool.length > 0; i++) {
      const idx = rng.int(0, pool.length - 1);
      const chosen = pool.splice(idx, 1)[0];
      const scale = mode === "chaos" ? 0.55 + rng.next() * 0.55 : 0.45 + rng.next() * 0.4;
      chosen.run(px, w, h, Math.min(1, t * scale), rng);
      usedNames.push(chosen.name);
    }
  } else if (mode === "glitch2d") {
    opBlockTear(px, w, h, t, rng);
    usedNames.push("2d block tear");
  } else if (mode === "pixelsort") {
    opPixelSort(px, w, h, t, rng);
    usedNames.push("multi-axis pixel sort");
  } else if (mode === "rgbshift") {
    opRgbSplit(px, w, h, t, rng);
    usedNames.push("2d rgb prism split");
  } else if (mode === "melt") {
    opMelt2d(px, w, h, t, rng);
    usedNames.push("2d liquify & vortex melt");
  } else if (mode === "deepfry") {
    opDeepFry(px, w, h, t, rng);
    usedNames.push("deepfry crunch");
  } else if (mode === "shuffle") {
    opTileShuffle(px, w, h, t, rng);
    usedNames.push("2d tile shuffle");
  } else if (mode === "stutter") {
    opStutterEcho(px, w, h, t, rng);
    usedNames.push("2d ghost stutter");
  } else if (mode === "invert") {
    opInvertXor(px, w, h, t, rng);
    usedNames.push("solarize & xor patches");
  } else if (mode === "crush") {
    opCrushMosaic(px, w, h, t, rng);
    usedNames.push("mosaic bitcrush");
  }

  let mutatedPixels = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] !== before[i] || px[i + 1] !== before[i + 1] || px[i + 2] !== before[i + 2]) {
      mutatedPixels++;
    }
  }

  return { usedNames, mutatedPixels };
}

// applies true 2d multi-directional corruption to any browser-decodable raster image (png/jpg/webp)
export async function glitchImage2d(
  input: Uint8Array,
  mimeType: string,
  mode: RotMode,
  intensity: number,
  rng: SeededRng
): Promise<ImageGlitch2dOutput | null> {
  if (typeof document === "undefined" || typeof createImageBitmap === "undefined") return null;

  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const blob = new Blob([copy], { type: mimeType });
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  if (w <= 0 || h <= 0) {
    bmp.close();
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    return null;
  }

  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  const imgData = ctx.getImageData(0, 0, w, h);
  const t = Math.max(0.03, Math.min(1, intensity / 100));
  const { usedNames, mutatedPixels } = applyImage2dOps(imgData.data, w, h, mode, intensity, rng);

  ctx.putImageData(imgData, 0, 0);

  // encode back to original format (deepfry jpeg cranks quality brutally low for authentic macroblock crust)
  const outMime =
    mimeType === "image/jpeg" || mimeType === "image/webp" || mimeType === "image/png"
      ? mimeType
      : "image/png";
  const quality =
    mode === "deepfry"
      ? Math.max(0.04, 0.24 - t * 0.19)
      : outMime === "image/jpeg" || outMime === "image/webp"
        ? 0.9
        : undefined;

  const outBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outMime, quality));
  if (!outBlob) return null;
  const outBytes = new Uint8Array(await outBlob.arrayBuffer());

  return {
    bytes: outBytes,
    strategy: usedNames.length > 1 ? `2d combo (${usedNames.slice(0, 2).join(" + ")})` : usedNames[0] ?? "2d glitch",
    summary: `applied ${usedNames.join(" + ")} across ${mutatedPixels.toLocaleString()} pixels (${w}×${h})`,
    mutatedPixels,
  };
}
