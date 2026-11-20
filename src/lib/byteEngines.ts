import type { SeededRng } from "./prng";
import type { RotMode } from "./types";

export interface ByteMutationOptions {
  avoidByte?: number;
  blockAlign?: number;
}

// clamps byte replacement so formats like jpeg never accidentally get a 0xff marker injected
function safeByte(val: number, avoid?: number): number {
  const b = val & 0xff;
  if (avoid !== undefined && b === avoid) return (b ^ 0x55) & 0xff;
  return b;
}

function hasAvoidByte(buf: Uint8Array, start: number, len: number, avoid?: number): boolean {
  if (avoid === undefined) return false;
  for (let k = 0; k < len; k++) {
    if (buf[start + k] === avoid) return true;
  }
  return false;
}

const CHAOS_POOL: RotMode[] = [
  "glitch2d",
  "pixelsort",
  "rgbshift",
  "melt",
  "deepfry",
  "shuffle",
  "stutter",
  "invert",
  "crush",
  "byteflip",
];

export function mutateByteRange(
  buf: Uint8Array,
  start: number,
  end: number,
  mode: RotMode,
  intensity: number,
  rng: SeededRng,
  opts: ByteMutationOptions = {}
): number {
  const s = Math.max(0, Math.min(start, buf.length));
  const e = Math.max(s, Math.min(end, buf.length));
  const len = e - s;
  if (len <= 0) return 0;

  const t = Math.max(0.01, Math.min(1, intensity / 100));
  const align = Math.max(1, opts.blockAlign ?? 1);
  const avoid = opts.avoidByte;

  // chaos chains 2 to 4 randomized sub-modes on scattered random sub-ranges
  if (mode === "chaos") {
    const steps = rng.int(2, 4);
    let total = 0;
    for (let step = 0; step < steps; step++) {
      const subMode = rng.pick(CHAOS_POOL);
      // pick either the whole span or a random sub-island so corruption hits arbitrary spots
      const useIsland = rng.chance(0.7);
      const subLen = useIsland ? Math.max(align * 4, Math.floor(len * (0.12 + rng.next() * 0.55))) : len;
      const maxOffset = Math.max(0, len - subLen);
      const subStart = s + (useIsland ? Math.floor(rng.int(0, maxOffset) / align) * align : 0);
      const subIntensity = Math.max(4, intensity * (0.45 + rng.next() * 0.55));
      total += mutateByteRange(buf, subStart, Math.min(e, subStart + subLen), subMode, subIntensity, rng, opts);
    }
    return total;
  }

  let mutated = 0;

  // byteflip / smart: scattered islands + irregular bursts (not uniform top-to-bottom)
  if (mode === "byteflip" || mode === "smart") {
    const islands = Math.max(2, Math.round(4 + t * 26));
    const totalBudget = Math.max(2, Math.round(len * (0.0005 + t * t * 0.032)));
    const perIsland = Math.max(1, Math.ceil(totalBudget / islands));
    for (let isl = 0; isl < islands; isl++) {
      const center = s + rng.int(0, len - 1);
      const spread = Math.max(8, Math.min(len, rng.int(16, Math.max(32, Math.floor(len * (0.04 + rng.next() * 0.22))))));
      for (let i = 0; i < perIsland; i++) {
        const idx = Math.max(s, Math.min(e - 1, center + rng.int(-spread, spread)));
        if (avoid !== undefined && buf[idx] === avoid) continue;
        const roll = rng.next();
        const next =
          roll < 0.4
            ? buf[idx] ^ (1 << rng.int(0, 7))
            : roll < 0.75
              ? rng.int(0, 255)
              : buf[idx] + rng.int(-48, 48);
        const v = safeByte(next, avoid);
        if (v !== buf[idx]) {
          buf[idx] = v;
          mutated++;
        }
      }
    }
    return mutated;
  }

  // glitch2d: irregular variable-size chunk teleportation + random reversal
  if (mode === "glitch2d") {
    const hits = Math.max(2, Math.round(5 + t * 44));
    for (let i = 0; i < hits; i++) {
      const maxChunk = Math.max(align * 4, Math.min(8192, Math.floor(len * (0.008 + rng.next() * 0.07))));
      const chunkLen = Math.max(align, Math.floor(rng.int(align * 2, maxChunk) / align) * align);
      if (chunkLen >= len) continue;
      const src = s + Math.floor(rng.int(0, len - chunkLen) / align) * align;
      const dst = s + Math.floor(rng.int(0, len - chunkLen) / align) * align;
      if (hasAvoidByte(buf, src, chunkLen, avoid) || hasAvoidByte(buf, dst, chunkLen, avoid)) continue;
      const slice = buf.slice(src, src + chunkLen);
      if (rng.chance(0.35)) slice.reverse();
      if (rng.chance(0.35)) {
        const xorMask = rng.int(1, 254);
        for (let k = 0; k < slice.length; k++) slice[k] = safeByte(slice[k] ^ xorMask, avoid);
      }
      buf.set(slice, dst);
      mutated += chunkLen;
    }
    return mutated;
  }

  // pixelsort: sorts random byte runs ascending or descending for rising/falling sweeps
  if (mode === "pixelsort") {
    const runs = Math.max(3, Math.round(6 + t * 55));
    const maxRun = Math.max(align * 8, Math.min(4096, Math.floor(len * (0.01 + t * 0.055))));
    for (let r = 0; r < runs; r++) {
      const runLen = Math.max(align * 4, Math.min(len, rng.int(align * 4, maxRun)));
      const pos = s + Math.floor(rng.int(0, Math.max(0, len - runLen)) / align) * align;
      if (hasAvoidByte(buf, pos, runLen, avoid)) continue;
      const slice = buf.slice(pos, pos + runLen);
      const asc = rng.chance(0.5);
      slice.sort(asc ? (a, b) => a - b : (a, b) => b - a);
      buf.set(slice, pos);
      mutated += runLen;
    }
    return mutated;
  }

  // rgbshift: offsets interleaved byte lanes independently (splits RGB/stereo channels out of phase)
  if (mode === "rgbshift") {
    const stride = align >= 2 ? align : rng.pick([2, 3, 4]);
    const bands = Math.max(2, Math.round(4 + t * 32));
    const maxBand = Math.max(stride * 16, Math.min(16384, Math.floor(len * (0.02 + t * 0.14))));
    for (let b = 0; b < bands; b++) {
      const bandLen = Math.min(len, Math.floor(rng.int(stride * 12, maxBand) / stride) * stride);
      if (bandLen < stride * 4) continue;
      const pos = s + Math.floor(rng.int(0, len - bandLen) / stride) * stride;
      const lane = rng.int(0, stride - 1);
      const shiftSteps = rng.int(2, Math.max(3, Math.floor((bandLen / stride) * (0.1 + t * 0.35))));
      const dir = rng.chance(0.5) ? 1 : -1;
      const copy = buf.slice(pos, pos + bandLen);
      const count = Math.floor(bandLen / stride);
      for (let i = 0; i < count; i++) {
        const srcI = (i + dir * shiftSteps + count * 4) % count;
        const dstIdx = pos + i * stride + lane;
        const val = copy[srcI * stride + lane];
        if (avoid !== undefined && (buf[dstIdx] === avoid || val === avoid)) continue;
        if (buf[dstIdx] !== val) {
          buf[dstIdx] = val;
          mutated++;
        }
      }
    }
    return mutated;
  }

  // deepfry: aggressive bit-shift + gain overdrive + high-contrast noise bursts
  if (mode === "deepfry") {
    const bursts = Math.max(4, Math.round(10 + t * 75));
    const maxBurst = Math.max(align * 4, Math.min(3072, Math.floor(len * (0.008 + t * 0.05))));
    for (let b = 0; b < bursts; b++) {
      const burstLen = Math.min(len, rng.int(align * 2, maxBurst));
      const pos = s + rng.int(0, Math.max(0, len - burstLen));
      const gain = 1.6 + t * 2.8;
      for (let k = 0; k < burstLen; k++) {
        const idx = pos + k;
        if (avoid !== undefined && buf[idx] === avoid) continue;
        const centered = buf[idx] - 128;
        const boosted = Math.max(0, Math.min(255, Math.round(centered * gain + 128 + rng.int(-24, 24))));
        const crushed = safeByte(boosted & 0xf0, avoid);
        if (crushed !== buf[idx]) {
          buf[idx] = crushed;
          mutated++;
        }
      }
    }
    return mutated;
  }

  // invert: random bitwise inversions, XOR masks & reversed islands
  if (mode === "invert") {
    const patches = Math.max(3, Math.round(6 + t * 48));
    const maxPatch = Math.max(align * 4, Math.min(4096, Math.floor(len * (0.01 + t * 0.065))));
    for (let p = 0; p < patches; p++) {
      const patchLen = Math.min(len, Math.floor(rng.int(align * 2, maxPatch) / align) * align);
      if (patchLen <= 0) continue;
      const pos = s + rng.int(0, Math.max(0, len - patchLen));
      const op = rng.int(0, 2);
      const mask = op === 0 ? 0xff : rng.int(0x11, 0xee);
      if (op === 2 && !hasAvoidByte(buf, pos, patchLen, avoid)) {
        const rev = buf.slice(pos, pos + patchLen).reverse();
        buf.set(rev, pos);
        mutated += patchLen;
      } else {
        for (let k = 0; k < patchLen; k++) {
          const idx = pos + k;
          if (avoid !== undefined && buf[idx] === avoid) continue;
          const v = safeByte(buf[idx] ^ mask, avoid);
          if (v !== buf[idx]) {
            buf[idx] = v;
            mutated++;
          }
        }
      }
    }
    return mutated;
  }

  if (mode === "shuffle") {
    const rawBlock = Math.max(align * 4, Math.min(4096, Math.floor(len / rng.int(18, 64))));
    const blockSize = Math.max(align, Math.floor(rawBlock / align) * align);
    const numBlocks = Math.floor(len / blockSize);
    if (numBlocks < 2) return mutateByteRange(buf, s, e, "byteflip", intensity, rng, opts);

    const swaps = Math.max(1, Math.round(numBlocks * t * 0.6));
    const tmp = new Uint8Array(blockSize);
    for (let i = 0; i < swaps; i++) {
      const a = s + rng.int(0, numBlocks - 1) * blockSize;
      const b = s + rng.int(0, numBlocks - 1) * blockSize;
      if (a === b) continue;
      if (hasAvoidByte(buf, a, blockSize, avoid) || hasAvoidByte(buf, b, blockSize, avoid)) continue;
      tmp.set(buf.subarray(a, a + blockSize));
      buf.copyWithin(a, b, b + blockSize);
      buf.set(tmp, b);
      mutated += blockSize * 2;
    }
    return mutated;
  }

  if (mode === "stutter") {
    const rawBlock = Math.max(align * 8, Math.min(8192, Math.floor(len / rng.int(24, 72))));
    const blockSize = Math.max(align, Math.floor(rawBlock / align) * align);
    const hits = Math.max(1, Math.round((len / blockSize) * t * 0.45));
    for (let i = 0; i < hits; i++) {
      const src = s + rng.int(0, Math.max(0, len - blockSize * 2));
      const repeats = rng.int(2, 7);
      const slice = buf.slice(src, src + blockSize);
      if (avoid !== undefined && slice.includes(avoid)) continue;
      const dir = rng.chance(0.7) ? 1 : -1;
      for (let r = 1; r < repeats; r++) {
        const dst = src + dir * r * blockSize;
        if (dst < s || dst + blockSize > e) break;
        if (hasAvoidByte(buf, dst, blockSize, avoid)) continue;
        buf.set(slice, dst);
        mutated += blockSize;
      }
    }
    return mutated;
  }

  if (mode === "crush") {
    const runs = Math.max(2, Math.round(12 + t * 90));
    const maxRun = Math.max(align * 4, Math.min(2048, Math.floor(len * (0.01 + t * 0.06))));
    const mask = t > 0.65 ? 0xc0 : t > 0.35 ? 0xe0 : 0xf0;
    for (let r = 0; r < runs; r++) {
      const startIdx = s + rng.int(0, Math.max(0, len - 1));
      const runLen = Math.min(e - startIdx, rng.int(align * 2, maxRun));
      for (let k = 0; k < runLen; k++) {
        const idx = startIdx + k;
        if (avoid !== undefined && buf[idx] === avoid) continue;
        const next = safeByte(buf[idx] & mask, avoid);
        if (next !== buf[idx]) {
          buf[idx] = next;
          mutated++;
        }
      }
    }
    return mutated;
  }

  // melt mode applies randomized multi-frequency wave drift across scattered islands
  const bands = Math.max(2, Math.round(6 + t * 48));
  const bandLen = Math.max(align * 8, Math.min(4096, Math.floor(len / (bands * 2))));
  const amp = Math.max(4, Math.round(t * 96));
  for (let b = 0; b < bands; b++) {
    const pos = s + rng.int(0, Math.max(0, len - bandLen));
    const phase = rng.next() * Math.PI * 2;
    const freq = 0.015 + rng.next() * 0.18;
    const freq2 = 0.005 + rng.next() * 0.07;
    for (let k = 0; k < bandLen && pos + k < e; k++) {
      const idx = pos + k;
      if (avoid !== undefined && buf[idx] === avoid) continue;
      const delta = Math.round((Math.sin(phase + k * freq) * 0.7 + Math.cos(phase * 1.3 + k * freq2) * 0.3) * amp);
      const next = safeByte(buf[idx] + delta, avoid);
      if (next !== buf[idx]) {
        buf[idx] = next;
        mutated++;
      }
    }
  }
  return mutated;
}
