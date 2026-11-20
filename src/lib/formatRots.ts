import JSZip from "jszip";
import { mutateByteRange } from "./byteEngines";
import { applyImage2dOps, glitchImage2d } from "./imageGlitch";
import {
  rotCode,
  rotConfig,
  rotCsv,
  rotFont,
  rotGameRom,
  rotGcode,
  rotGlb,
  rotImageExtra,
  rotJson,
  rotMarkup,
  rotReaper,
  rotShader,
  rotSoundFont,
  rotSqliteOrWasm,
  rotStylesheet,
  rotSubtitles,
} from "./extraRots";
import {
  crc32,
  createRng,
  zlibCompress,
  zlibDecompress,
  type SeededRng,
} from "./prng";
import type { RotCategory, RotFormatSpec, RotMode, RotResult, RotSettings } from "./types";

interface FormatHandler extends RotFormatSpec {
  detect?: (buf: Uint8Array, ext: string) => boolean;
  rot: (buf: Uint8Array, settings: RotSettings, rng: SeededRng, filename: string) => Promise<RotResult> | RotResult;
}

function readU32BE(b: Uint8Array, o: number): number {
  return (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
}

function readU32LE(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
}

function writeU32BE(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

function asciiAt(b: Uint8Array, o: number, len: number): string {
  let out = "";
  for (let i = 0; i < len && o + i < b.length; i++) out += String.fromCharCode(b[o + i]);
  return out;
}

// jpeg: 2d multi-directional glitch & deepfry when header-guarded, or raw sos scan-data bend in byteflip/nuke mode
async function rotJpeg(buf: Uint8Array, settings: RotSettings, rng: SeededRng): Promise<RotResult> {
  if (settings.preserveHeader && settings.mode !== "byteflip") {
    try {
      const fx = await glitchImage2d(buf, "image/jpeg", settings.mode, settings.intensity, rng);
      if (fx) {
        return {
          buffer: fx.bytes,
          mutatedBytes: fx.mutatedPixels,
          strategy: fx.strategy,
          summary: fx.summary,
        };
      }
    } catch {
      // fall through to raw sos scan-data bend
    }
  }

  const out = new Uint8Array(buf);
  let scanStart = Math.min(out.length, settings.headerSkipBytes);
  let scanEnd = out.length - 2;

  if (settings.preserveHeader) {
    let i = 2;
    while (i + 4 < out.length) {
      if (out[i] !== 0xff) {
        i++;
        continue;
      }
      while (i < out.length && out[i] === 0xff) i++;
      if (i >= out.length) break;
      const marker = out[i++];
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > out.length) break;
      const segLen = (out[i] << 8) | out[i + 1];
      if (marker === 0xda) {
        scanStart = i + segLen + 8;
        break;
      }
      i += segLen;
    }
    for (let j = out.length - 2; j > scanStart; j--) {
      if (out[j] === 0xff && out[j + 1] === 0xd9) {
        scanEnd = j - 2;
        break;
      }
    }
  } else {
    scanStart = 2;
    scanEnd = out.length;
  }

  const jpegIntensity = Math.max(2, settings.intensity * 0.32);
  const mutated = mutateByteRange(out, scanStart, scanEnd, "byteflip", jpegIntensity, rng, { avoidByte: 0xff });

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "jpeg sos scan-data bend",
    summary: `bent ${mutated} bytes inside jpeg scan payload (headers preserved)`,
  };
}

// png: 2d multi-directional glitch when header-guarded, or raw idat filter/scanline databend in byteflip/nuke mode
async function rotPng(buf: Uint8Array, settings: RotSettings, rng: SeededRng): Promise<RotResult> {
  if (settings.preserveHeader && settings.mode !== "byteflip") {
    try {
      const fx = await glitchImage2d(buf, "image/png", settings.mode, settings.intensity, rng);
      if (fx) {
        return {
          buffer: fx.bytes,
          mutatedBytes: fx.mutatedPixels,
          strategy: fx.strategy,
          summary: fx.summary,
        };
      }
    } catch {
      // fall through to raw idat scanline bend
    }
  }

  if (!settings.preserveHeader) {
    const out = new Uint8Array(buf);
    const mutated = mutateByteRange(out, 8, out.length, settings.mode, settings.intensity, rng);
    return { buffer: out, mutatedBytes: mutated, strategy: "raw png byte rot", summary: `corrupted ${mutated} raw bytes` };
  }

  try {
    let width = 0;
    let height = 0;
    let bitDepth = 8;
    let colorType = 6;
    const chunksBefore: Uint8Array[] = [];
    const chunksAfter: Uint8Array[] = [];
    const idatParts: Uint8Array[] = [];
    let seenIdat = false;

    let pos = 8;
    while (pos + 12 <= buf.length) {
      const length = readU32BE(buf, pos);
      const type = asciiAt(buf, pos + 4, 4);
      const chunkTotal = 12 + length;
      if (pos + chunkTotal > buf.length) break;

      if (type === "IHDR" && length >= 13) {
        width = readU32BE(buf, pos + 8);
        height = readU32BE(buf, pos + 12);
        bitDepth = buf[pos + 16];
        colorType = buf[pos + 17];
      }

      if (type === "IDAT") {
        seenIdat = true;
        idatParts.push(buf.subarray(pos + 8, pos + 8 + length));
      } else {
        const chunkBytes = buf.subarray(pos, pos + chunkTotal);
        if (!seenIdat) chunksBefore.push(chunkBytes);
        else chunksAfter.push(chunkBytes);
      }
      pos += chunkTotal;
      if (type === "IEND") break;
    }

    if (idatParts.length === 0 || width <= 0 || height <= 0) {
      throw new Error("missing png idat");
    }

    const totalIdat = idatParts.reduce((s, p) => s + p.length, 0);
    const mergedIdat = new Uint8Array(totalIdat);
    let offset = 0;
    for (const part of idatParts) {
      mergedIdat.set(part, offset);
      offset += part.length;
    }

    const inflated = await zlibDecompress(mergedIdat);
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
    const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
    const stride = 1 + Math.ceil((width * channels * bitDepth) / 8);

    const t = settings.intensity / 100;
    let mutated = 0;

    // mutate png filter bytes (0..4) for authentic diagonal paeth/sub/up streaks
    if (inflated.length >= stride * height) {
      const filterProb = settings.mode === "smart" ? 0.04 + t * 0.35 : 0.02 + t * 0.2;
      for (let row = 0; row < height; row++) {
        const rowStart = row * stride;
        if (rng.chance(filterProb)) {
          const nextFilter = rng.int(0, 4);
          if (inflated[rowStart] !== nextFilter) {
            inflated[rowStart] = nextFilter;
            mutated++;
          }
        }
      }
    }

    // also bend pixel scanline bytes inside the inflated buffer
    const bodyMode: RotMode = settings.mode === "smart" ? (rng.chance(0.5) ? "melt" : "shuffle") : settings.mode;
    mutated += mutateByteRange(inflated, stride, inflated.length, bodyMode, settings.intensity * 0.55, rng, {
      blockAlign: bpp,
    });

    // clamp every row filter byte back to valid 0..4 so png decoders never reject the image
    if (inflated.length >= stride * height) {
      for (let row = 0; row < height; row++) {
        const f = inflated[row * stride];
        if (f > 4) inflated[row * stride] = f % 5;
      }
    }

    const recompressed = await zlibCompress(inflated);
    const newIdat = new Uint8Array(12 + recompressed.length);
    writeU32BE(newIdat, 0, recompressed.length);
    newIdat[4] = 73; // I
    newIdat[5] = 68; // D
    newIdat[6] = 65; // A
    newIdat[7] = 84; // T
    newIdat.set(recompressed, 8);
    writeU32BE(newIdat, 8 + recompressed.length, crc32(newIdat, 4, 8 + recompressed.length));

    const outLen =
      8 +
      chunksBefore.reduce((s, c) => s + c.length, 0) +
      newIdat.length +
      chunksAfter.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(outLen);
    out.set(buf.subarray(0, 8), 0);
    let w = 8;
    for (const c of chunksBefore) {
      out.set(c, w);
      w += c.length;
    }
    out.set(newIdat, w);
    w += newIdat.length;
    for (const c of chunksAfter) {
      out.set(c, w);
      w += c.length;
    }

    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "png idat scanline & filter bend",
      summary: `warped ${mutated} scanline & filter bytes with valid crc-32`,
    };
  } catch {
    const out = new Uint8Array(buf);
    const mutated = mutateByteRange(out, 64, out.length - 12, "byteflip", settings.intensity * 0.2, rng);
    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "png fallback bend",
      summary: `bent ${mutated} bytes in png payload`,
    };
  }
}

// bmp: true 2d pixel-grid corruption for 24/32-bit bmps, or raw pixel-array byte bend in byteflip/nuke mode
function rotBmp(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  const pixelOffset = settings.preserveHeader && out.length >= 54 ? Math.min(out.length, readU32LE(out, 10)) : 54;

  if (settings.preserveHeader && settings.mode !== "byteflip" && out.length >= 54) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const w = dv.getInt32(18, true);
    const rawH = dv.getInt32(22, true);
    const h = Math.abs(rawH);
    const bpp = dv.getUint16(28, true);
    const compression = dv.getUint32(30, true);
    if (compression === 0 && (bpp === 24 || bpp === 32) && w > 0 && h > 0 && w <= 8192 && h <= 8192) {
      const bytesPerPx = bpp / 8;
      const rowStride = Math.ceil((w * bytesPerPx) / 4) * 4;
      if (pixelOffset + rowStride * h <= out.length) {
        const rgba = new Uint8ClampedArray(w * h * 4);
        const topDown = rawH < 0;
        for (let y = 0; y < h; y++) {
          const bmpRow = topDown ? y : h - 1 - y;
          const rowOff = pixelOffset + bmpRow * rowStride;
          for (let x = 0; x < w; x++) {
            const si = rowOff + x * bytesPerPx;
            const di = (y * w + x) * 4;
            rgba[di] = out[si + 2];
            rgba[di + 1] = out[si + 1];
            rgba[di + 2] = out[si];
            rgba[di + 3] = bytesPerPx === 4 ? out[si + 3] : 255;
          }
        }
        const { usedNames, mutatedPixels } = applyImage2dOps(rgba, w, h, settings.mode, settings.intensity, rng);
        for (let y = 0; y < h; y++) {
          const bmpRow = topDown ? y : h - 1 - y;
          const rowOff = pixelOffset + bmpRow * rowStride;
          for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            const di = rowOff + x * bytesPerPx;
            out[di] = rgba[si + 2];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si];
            if (bytesPerPx === 4) out[di + 3] = rgba[si + 3];
          }
        }
        return {
          buffer: out,
          mutatedBytes: mutatedPixels * bytesPerPx,
          strategy: usedNames.length > 1 ? `2d bmp (${usedNames.slice(0, 2).join(" + ")})` : usedNames[0] ?? "2d bmp glitch",
          summary: `applied ${usedNames.join(" + ")} across ${mutatedPixels.toLocaleString()} pixels (${w}×${h} bmp)`,
        };
      }
    }
  }

  const mode: RotMode = settings.mode === "smart" ? "melt" : settings.mode;
  const mutated = mutateByteRange(out, pixelOffset, out.length, mode, settings.intensity, rng, { blockAlign: 3 });
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "bmp pixel-array bend",
    summary: `distorted ${mutated} pixel bytes after dib header (${pixelOffset} b)`,
  };
}

// webp: 2d multi-directional glitch when header-guarded, or raw vp8/vp8l payload bend
async function rotWebp(buf: Uint8Array, settings: RotSettings, rng: SeededRng): Promise<RotResult> {
  if (settings.preserveHeader && settings.mode !== "byteflip") {
    try {
      const fx = await glitchImage2d(buf, "image/webp", settings.mode, settings.intensity, rng);
      if (fx) {
        return {
          buffer: fx.bytes,
          mutatedBytes: fx.mutatedPixels,
          strategy: fx.strategy,
          summary: fx.summary,
        };
      }
    } catch {
      // fall through to raw webp payload bend
    }
  }
  return rotBinary(buf, { ...settings, headerSkipBytes: Math.max(96, settings.headerSkipBytes) }, rng, "webp payload bend");
}

// gif: scramble global color table rgb entries and lightly bend sub-blocks
function rotGif(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  let mutated = 0;

  if (settings.preserveHeader && out.length > 13) {
    const packed = out[10];
    const hasGct = (packed & 0x80) !== 0;
    const gctSize = hasGct ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
    if (gctSize > 0 && 13 + gctSize < out.length) {
      mutated += mutateByteRange(out, 13, 13 + gctSize, settings.mode === "smart" ? "shuffle" : settings.mode, settings.intensity, rng, {
        blockAlign: 3,
      });
    }
    const payloadStart = 13 + gctSize + 24;
    if (payloadStart < out.length - 2 && settings.intensity > 35) {
      mutated += mutateByteRange(out, payloadStart, out.length - 2, "byteflip", (settings.intensity - 30) * 0.12, rng);
    }
  } else {
    mutated = mutateByteRange(out, 13, out.length - 1, settings.mode, settings.intensity * 0.2, rng);
  }

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "gif palette & frame bend",
    summary: `scrambled ${mutated} color table & frame bytes`,
  };
}

// svg: jitter numeric coordinates and mutate hex colors while keeping valid xml
function rotSvg(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;

  let next = text.replace(/#([0-9a-fA-F]{6})\b/g, (full, hex: string) => {
    if (!rng.chance(0.2 + t * 0.65)) return full;
    mutated += 6;
    const r = (parseInt(hex.slice(0, 2), 16) + rng.int(-Math.round(t * 180), Math.round(t * 180)) + 256) & 0xff;
    const g = (parseInt(hex.slice(2, 4), 16) + rng.int(-Math.round(t * 180), Math.round(t * 180)) + 256) & 0xff;
    const b = (parseInt(hex.slice(4, 6), 16) + rng.int(-Math.round(t * 180), Math.round(t * 180)) + 256) & 0xff;
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  });

  next = next.replace(/(\b(?:d|points|cx|cy|x1|y1|x2|y2)=")([^"]+)(")/g, (_m, pre: string, body: string, suf: string) => {
    const warped = body.replace(/-?\d+(?:\.\d+)?/g, (numStr) => {
      if (!rng.chance(0.18 + t * 0.6)) return numStr;
      const val = Number(numStr);
      if (!Number.isFinite(val)) return numStr;
      const spread = Math.max(1.5, Math.abs(val) * t * 0.35 + t * 14);
      const delta = (rng.next() - 0.5) * 2 * spread;
      mutated += numStr.length;
      return (val + delta).toFixed(numStr.includes(".") ? 2 : 1);
    });
    return `${pre}${warped}${suf}`;
  });

  return {
    buffer: new TextEncoder().encode(next),
    mutatedBytes: mutated,
    strategy: "svg path & palette warp",
    summary: `warped ${mutated} vector coordinate & color chars`,
  };
}

// wav / aiff: keep riff/fmt headers intact and bend pcm audio samples directly
function rotWavAiff(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  let dataStart = 44;
  let dataEnd = out.length;
  let align = 4;

  const magic = asciiAt(out, 0, 4);
  if (settings.preserveHeader && magic === "RIFF" && out.length > 44) {
    let pos = 12;
    while (pos + 8 <= out.length) {
      const id = asciiAt(out, pos, 4);
      const size = readU32LE(out, pos + 4);
      if (id === "fmt " && pos + 22 <= out.length) {
        const blockAlign = out[pos + 20] | (out[pos + 21] << 8);
        if (blockAlign >= 1 && blockAlign <= 16) align = blockAlign;
      }
      if (id === "data") {
        dataStart = pos + 8;
        dataEnd = Math.min(out.length, dataStart + size);
        break;
      }
      pos += 8 + size + (size % 2);
    }
  } else if (settings.preserveHeader && magic === "FORM" && out.length > 54) {
    let pos = 12;
    while (pos + 8 <= out.length) {
      const id = asciiAt(out, pos, 4);
      const size = readU32BE(out, pos + 4);
      if (id === "SSND") {
        dataStart = pos + 16;
        dataEnd = Math.min(out.length, pos + 8 + size);
        break;
      }
      pos += 8 + size + (size % 2);
    }
  }

  const mode: RotMode = settings.mode === "smart" ? "stutter" : settings.mode;
  const mutated = mutateByteRange(out, dataStart, dataEnd, mode, settings.intensity, rng, { blockAlign: align });
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: `${magic === "FORM" ? "aiff" : "wav"} pcm ${mode}`,
    summary: `glitched ${mutated} pcm sample bytes (header intact, playable)`,
  };
}

// mp3: skip id3v2 header, locate mpeg frame sync headers, shuffle/stutter/bend frame payloads
function rotMp3(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  let pos = 0;

  if (settings.preserveHeader && asciiAt(out, 0, 3) === "ID3" && out.length >= 10) {
    const tagSize =
      ((out[6] & 0x7f) << 21) |
      ((out[7] & 0x7f) << 14) |
      ((out[8] & 0x7f) << 7) |
      (out[9] & 0x7f);
    pos = Math.min(out.length, 10 + tagSize);
  }

  // scan for mpeg audio frame sync markers (0xff 0xe0..0xff)
  const frameStarts: number[] = [];
  for (let i = pos; i + 4 < out.length; i++) {
    if (out[i] === 0xff && (out[i + 1] & 0xe0) === 0xe0 && (out[i + 1] & 0x06) !== 0) {
      frameStarts.push(i);
      i += 120; // jump past sync header to avoid false positives inside payload
    }
  }

  let mutated = 0;
  const t = settings.intensity / 100;
  if (settings.preserveHeader && frameStarts.length >= 6 && (settings.mode === "smart" || settings.mode === "shuffle" || settings.mode === "stutter")) {
    const ops = Math.max(2, Math.round(frameStarts.length * t * 0.4));
    for (let k = 0; k < ops; k++) {
      const idxA = rng.int(1, frameStarts.length - 2);
      const idxB = rng.int(1, frameStarts.length - 2);
      const startA = frameStarts[idxA] + 4;
      const lenA = Math.min(256, frameStarts[idxA + 1] - startA);
      const startB = frameStarts[idxB] + 4;
      const lenB = Math.min(256, frameStarts[idxB + 1] - startB);
      const copyLen = Math.min(lenA, lenB);
      if (copyLen < 16) continue;
      if (settings.mode === "stutter") {
        out.copyWithin(startB, startA, startA + copyLen);
        mutated += copyLen;
      } else {
        const tmp = out.slice(startA, startA + copyLen);
        out.copyWithin(startA, startB, startB + copyLen);
        out.set(tmp, startB);
        mutated += copyLen * 2;
      }
    }
  } else {
    mutated = mutateByteRange(out, Math.max(pos + 64, 64), out.length - 128, settings.mode, settings.intensity * 0.5, rng);
  }

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "mp3 mpeg frame glitch",
    summary: `glitched ${mutated} bytes across ${frameStarts.length} mpeg frames`,
  };
}

function readI32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
}

function writeI32LE(b: Uint8Array, o: number, v: number): void {
  const n = v | 0;
  b[o] = n & 0xff;
  b[o + 1] = (n >>> 8) & 0xff;
  b[o + 2] = (n >>> 16) & 0xff;
  b[o + 3] = (n >>> 24) & 0xff;
}

// fl studio (.flp): verified PyFLP event-stream rot for audio clips, playlist items, piano roll notes, mixer eq/pan & tempo
function rotFlp(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  if (!settings.preserveHeader || asciiAt(out, 0, 4) !== "FLhd" || out.length < 24) {
    const mutated = mutateByteRange(out, Math.min(out.length, 64), out.length, settings.mode, settings.intensity * 0.35, rng);
    return { buffer: out, mutatedBytes: mutated, strategy: "flp raw payload bend", summary: `mutated ${mutated} bytes` };
  }

  const hdrLen = readU32LE(out, 4);
  const dtPos = 8 + hdrLen;
  if (hdrLen < 6 || dtPos + 8 > out.length || asciiAt(out, dtPos, 4) !== "FLdt") {
    const mutated = mutateByteRange(out, Math.min(out.length, 64), out.length, settings.mode, settings.intensity * 0.35, rng);
    return { buffer: out, mutatedBytes: mutated, strategy: "flp payload bend", summary: `mutated ${mutated} bytes` };
  }

  const dtLen = readU32LE(out, dtPos + 4);
  const dtEnd = Math.min(out.length, dtPos + 8 + dtLen);
  const t = settings.intensity / 100;
  const activeMode: RotMode =
    settings.mode === "chaos"
      ? rng.pick(["smart", "melt", "shuffle", "pixelsort", "stutter", "invert", "deepfry"])
      : settings.mode;

  let pos = dtPos + 8;
  let mutated = 0;
  let notesWarped = 0;
  let clipsWarped = 0;
  let channelsWarped = 0;
  let mixerWarped = 0;
  let panFlip = rng.chance(0.5) ? 1 : -1;

  while (pos < dtEnd) {
    const ev = out[pos++];
    if (ev < 64) {
      // skip byte events (contain channel type enums & internal switches that crash FL if out-of-range)
      if (pos + 1 > dtEnd) break;
      pos += 1;
    } else if (ev < 128) {
      if (pos + 2 > dtEnd) break;
      if (ev === 66 && rng.chance(0.75 + t * 0.2)) {
        // legacy whole-number BPM tempo
        const cur = out[pos] | (out[pos + 1] << 8);
        if (cur >= 10 && cur <= 522) {
          const bpm = Math.max(45, Math.min(260, Math.round(cur + (rng.next() - 0.5) * 95 * t)));
          out[pos] = bpm & 0xff;
          out[pos + 1] = (bpm >> 8) & 0xff;
          mutated += 2;
        }
      } else if (ev === 86 && rng.chance(0.3 + t * 0.45)) {
        // ChannelID.Pogo (WORD + 22): audio clip pitch-pogo bend (0..256)
        const pogo = rng.int(Math.round(24 * t), Math.min(256, Math.round(70 + t * 150)));
        out[pos] = pogo & 0xff;
        out[pos + 1] = (pogo >> 8) & 0xff;
        mutated += 2;
        channelsWarped++;
      } else if (ev === 97 && rng.chance(0.45 + t * 0.45)) {
        // ChannelID.Swing (WORD + 33): channel swing (0..128)
        const swing = rng.int(0, Math.min(128, Math.round(32 + t * 96)));
        out[pos] = swing & 0xff;
        out[pos + 1] = (swing >> 8) & 0xff;
        mutated += 2;
      }
      pos += 2;
    } else if (ev < 192) {
      if (pos + 4 > dtEnd) break;
      if (ev === 156 && rng.chance(0.8 + t * 0.18)) {
        // ProjectID.Tempo (fine tempo in BPM * 1000)
        const cur = readU32LE(out, pos);
        if (cur >= 10000 && cur <= 522000) {
          const delta = (rng.next() - 0.5) * Math.max(18000, cur * 0.65) * Math.max(0.25, t);
          const nextTempo = Math.max(45000, Math.min(250000, Math.round(cur + delta)));
          writeI32LE(out, pos, nextTempo);
          mutated += 4;
        }
      } else if (ev === 142 && rng.chance(0.55 + t * 0.4)) {
        // ChannelID.FineTune (DWORD + 14): -100..+100 cents
        const cur = readI32LE(out, pos);
        if (cur >= -100 && cur <= 100) {
          const nextFt = Math.max(-100, Math.min(100, Math.round(cur + (rng.next() - 0.5) * 200 * t)));
          writeI32LE(out, pos, nextFt);
          mutated += 4;
          channelsWarped++;
        }
      } else if (ev === 128 && out[pos + 3] === 0 && rng.chance(0.4 + t * 0.5)) {
        // ChannelID.Color (RGB0)
        out[pos] = rng.int(24, 240);
        out[pos + 1] = rng.int(24, 240);
        out[pos + 2] = rng.int(24, 240);
        mutated += 3;
      }
      pos += 4;
    } else {
      // variable-length data event (unsigned VLQ without 32-bit signed shift overflow)
      let len = 0;
      let mult = 1;
      while (pos < dtEnd) {
        const byte = out[pos++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
        if ((byte & 0x80) === 0) break;
      }
      if (len < 0 || pos + len > dtEnd) break;

      // 1) ChannelID.Levels (DATA + 11 = 219): pan(0..12800, 6400=center), volume(0..12800), pitch_shift(-4800..4800 cents)
      if (ev === 219 && len >= 12) {
        const curPan = readI32LE(out, pos);
        const curVol = readU32LE(out, pos + 4);
        const curPitch = readI32LE(out, pos + 8);
        if (curPan >= 0 && curPan <= 12800 && curVol <= 16000 && curPitch >= -4800 && curPitch <= 4800) {
          if (rng.chance(0.6 + t * 0.35)) {
            // alternate left/right bias so tracks scatter wildly across both ears instead of piling onto one side
            panFlip = -panFlip;
            const mag = Math.round((1400 + rng.next() * 3800) * Math.max(0.35, t));
            const nextPan = Math.max(900, Math.min(11900, 6400 + panFlip * mag));
            writeI32LE(out, pos, nextPan);
            mutated += 4;
          }
          if (rng.chance(0.45 + t * 0.45)) {
            const nextVol = Math.max(4200, Math.min(12800, Math.round(curVol * (0.65 + rng.next() * (0.7 + t * 0.4)))));
            writeI32LE(out, pos + 4, nextVol);
            mutated += 4;
          }
          if (rng.chance(0.65 + t * 0.32)) {
            const maxCents = activeMode === "melt" ? 450 + t * 1400 : 300 + t * 2200;
            const shift =
              activeMode === "deepfry" || activeMode === "crush"
                ? rng.pick([-1200, -700, -500, 500, 700, 1200])
                : Math.round((rng.next() - 0.5) * 2 * maxCents);
            const nextPitch = Math.max(-3600, Math.min(3600, curPitch + shift));
            writeI32LE(out, pos + 8, nextPitch);
            mutated += 4;
          }
          channelsWarped++;
        }
      }

      // 2) ChannelID.Parameters (DATA + 7 = 215): only bend stretching.pitch (+100..+103) so audio clips always load & play cleanly
      if (ev === 215 && len >= 104) {
        const curStretchPitch = readI32LE(out, pos + 100);
        if (curStretchPitch >= -4800 && curStretchPitch <= 4800 && rng.chance(0.55 + t * 0.4)) {
          const pitchDelta = Math.round((rng.next() - 0.5) * (500 + t * 2000));
          const nextP = Math.max(-2400, Math.min(2400, curStretchPitch + pitchDelta));
          writeI32LE(out, pos + 100, nextP);
          mutated += 4;
          channelsWarped++;
        }
      }

      // 3) ArrangementID.Playlist (DATA + 25 = 233): rearrange/jitter positions & gently chop lengths without touching start_offset
      if (ev === 233 && len >= 32) {
        const itemSize = len % 60 === 0 ? 60 : len % 32 === 0 ? 32 : 0;
        if (itemSize > 0) {
          const itemCount = len / itemSize;
          const pBase = out[pos + 4] | (out[pos + 5] << 8);
          if (pBase === 20480 && itemCount > 0) {
            if ((activeMode === "shuffle" || activeMode === "glitch2d" || activeMode === "smart") && itemCount > 1) {
              const swaps = Math.max(1, Math.round(itemCount * (0.2 + t * 0.55)));
              for (let s = 0; s < swaps; s++) {
                const a = pos + rng.int(0, itemCount - 1) * itemSize;
                const b = pos + rng.int(0, itemCount - 1) * itemSize;
                if (a === b) continue;
                const posA = readU32LE(out, a);
                const posB = readU32LE(out, b);
                writeI32LE(out, a, posB);
                writeI32LE(out, b, posA);
                mutated += 8;
                clipsWarped += 2;
              }
            }

            for (let c = 0; c < itemCount; c++) {
              if (!rng.chance(0.32 + t * 0.58)) continue;
              const base = pos + c * itemSize;
              const curPos = readU32LE(out, base);
              const curLen = readU32LE(out, base + 8);

              if (curPos < 2_000_000 && rng.chance(0.55 + t * 0.35)) {
                const maxShift = Math.max(24, Math.round((72 + t * 576) * (activeMode === "stutter" ? 0.45 : 1)));
                const nextPos = Math.max(0, curPos + rng.int(-maxShift, maxShift));
                writeI32LE(out, base, nextPos);
                mutated += 4;
              }
              // keep clip length >= 45% of original (min 48 ticks) so audio clips stay visible and playable
              if (curLen > 96 && curLen < 2_000_000 && rng.chance(0.45 + t * 0.4)) {
                const factor = activeMode === "stutter" || activeMode === "crush"
                  ? 0.45 + rng.next() * 0.45
                  : 0.55 + rng.next() * (0.85 + t * 0.55);
                const nextLen = Math.max(48, Math.round(curLen * factor));
                writeI32LE(out, base + 8, nextLen);
                mutated += 4;
              }
              clipsWarped++;
            }
          }
        }
      }

      // 4) MixerID.Params (DATA + 17 = 225): 12-byte mixer insert params — NEVER pan Master (insertIdx === 0)!
      if (ev === 225 && len >= 12 && len % 12 === 0) {
        const count = len / 12;
        for (let m = 0; m < count; m++) {
          const base = pos + m * 12;
          const pid = out[base + 4];
          const chData = out[base + 6] | (out[base + 7] << 8);
          const insertIdx = (chData >> 6) & 0x7f;
          if (!rng.chance(0.45 + t * 0.5)) continue;
          if (pid === 193 && insertIdx > 0) {
            // individual insert pan (-6400..6400), alternating L/R bias so the mix splits across both ears
            panFlip = -panFlip;
            const mag = Math.round((1200 + rng.next() * 4000) * Math.max(0.35, t));
            writeI32LE(out, base + 8, panFlip * mag);
            mutated += 4;
            mixerWarped++;
          } else if (pid === 194 && insertIdx > 0) {
            // stereo separation (-64..64)
            writeI32LE(out, base + 8, Math.round((rng.next() - 0.5) * 120 * t));
            mutated += 4;
            mixerWarped++;
          } else if (pid === 208 || pid === 209 || pid === 210) {
            // 3-band EQ gain (-1800..1800); keep Master milder so audio doesn't disappear
            const range = insertIdx === 0 ? 900 : 1800;
            writeI32LE(out, base + 8, Math.round((rng.next() - 0.5) * 2 * range * Math.max(0.35, t)));
            mutated += 4;
            mixerWarped++;
          }
        }
      }

      // 5) PatternID.Notes (DATA + 16 = 224): exact verified 24-byte PyFLP NotesEvent layout
      // +0 pos(u32), +4 flags(u16), +6 rack_ch(u16), +8 len(u32), +12 key(u16), +14 group(u16),
      // +16 fine_pitch(u8 0..240), +17 u1, +18 release(u8 0..128), +19 midi_ch(u8 0..15),
      // +20 pan(u8 0..128), +21 vel(u8 0..128), +22 mod_x(u8), +23 mod_y(u8)
      if (ev === 224 && len >= 24 && len % 24 === 0) {
        const noteCount = len / 24;
        let validBlock = true;
        for (let n = 0; n < noteCount; n++) {
          const base = pos + n * 24;
          if (
            out[base + 12] > 131 ||
            out[base + 13] !== 0 ||
            out[base + 16] > 240 ||
            out[base + 19] > 15 ||
            out[base + 20] > 128 ||
            out[base + 21] > 128
          ) {
            validBlock = false;
            break;
          }
        }

        if (validBlock) {
          const spread = Math.max(2, Math.round(t * 24));

          if (activeMode === "pixelsort" && noteCount > 2) {
            const keys: number[] = [];
            for (let n = 0; n < noteCount; n++) keys.push(out[pos + n * 24 + 12]);
            keys.sort(rng.chance(0.5) ? (a, b) => a - b : (a, b) => b - a);
            for (let n = 0; n < noteCount; n++) {
              const base = pos + n * 24;
              if (out[base + 12] !== keys[n]) {
                out[base + 12] = keys[n];
                mutated++;
                notesWarped++;
              }
            }
          } else if (activeMode === "shuffle" && noteCount > 1) {
            const swaps = Math.max(1, Math.round(noteCount * (0.35 + t * 0.65)));
            for (let s = 0; s < swaps; s++) {
              const a = pos + rng.int(0, noteCount - 1) * 24;
              const b = pos + rng.int(0, noteCount - 1) * 24;
              if (a === b) continue;
              const tk = out[a + 12];
              out[a + 12] = out[b + 12];
              out[b + 12] = tk;
              const tv = out[a + 21];
              out[a + 21] = out[b + 21];
              out[b + 21] = tv;
              mutated += 4;
              notesWarped += 2;
            }
          }

          for (let n = 0; n < noteCount; n++) {
            if (!rng.chance(0.32 + t * 0.65)) continue;
            const base = pos + n * 24;
            const curKey = out[base + 12];

            if (activeMode === "invert") {
              out[base + 12] = Math.max(24, Math.min(108, 120 - curKey));
              out[base + 20] = 128 - out[base + 20];
              mutated += 2;
              notesWarped++;
            } else if (activeMode === "stutter" && n > 0) {
              out[base + 12] = out[base - 24 + 12];
              const curLen = readU32LE(out, base + 8);
              if (curLen > 48 && curLen < 1_000_000) {
                writeI32LE(out, base + 8, Math.max(24, Math.floor(curLen * (0.25 + rng.next() * 0.5))));
                mutated += 4;
              }
              mutated++;
              notesWarped++;
            } else if (activeMode === "melt") {
              const wave = Math.sin(n * (0.35 + t * 0.6));
              out[base + 16] = Math.max(0, Math.min(240, Math.round(120 + wave * 105 * t)));
              out[base + 20] = Math.max(0, Math.min(128, Math.round(64 + Math.cos(n * 0.5) * 60 * t)));
              out[base + 22] = Math.max(0, Math.min(255, Math.round(128 + wave * 120 * t)));
              mutated += 3;
              notesWarped++;
            } else if (activeMode === "deepfry" || activeMode === "crush") {
              out[base + 12] = Math.max(24, Math.min(108, Math.round(curKey / 5) * 5 + rng.pick([-12, 0, 12])));
              out[base + 21] = rng.int(112, 128);
              out[base + 22] = rng.pick([0, 255]);
              out[base + 23] = rng.pick([0, 255]);
              mutated += 4;
              notesWarped++;
            } else {
              out[base + 12] = Math.max(24, Math.min(108, curKey + rng.int(-spread, spread)));
              out[base + 16] = Math.max(0, Math.min(240, 120 + rng.int(-Math.round(t * 95), Math.round(t * 95))));
              out[base + 20] = rng.int(0, 128);
              out[base + 21] = rng.int(24, 128);
              out[base + 22] = rng.int(0, 255);
              out[base + 23] = rng.int(0, 255);
              mutated += 6;
              notesWarped++;
            }
          }
        }
      }
      pos += len;
    }
  }

  const parts: string[] = [];
  if (notesWarped > 0) parts.push(`${notesWarped} notes`);
  if (clipsWarped > 0) parts.push(`${clipsWarped} playlist clips`);
  if (channelsWarped > 0) parts.push(`${channelsWarped} channels`);
  if (mixerWarped > 0) parts.push(`${mixerWarped} mixer eq/pan`);
  const detail = parts.length > 0 ? parts.join(", ") : `${mutated} event bytes`;

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: `fl studio ${activeMode} rot`,
    summary: `warped ${detail} (${mutated} safe bytes)`,
  };
}

// midi (.mid/.midi): walk MThd/MTrk tracks and scramble note pitches, velocities, instruments, and pitch bends
function rotMidi(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  if (!settings.preserveHeader || asciiAt(out, 0, 4) !== "MThd" || out.length < 14) {
    const mutated = mutateByteRange(out, 14, out.length, settings.mode, settings.intensity * 0.4, rng);
    return { buffer: out, mutatedBytes: mutated, strategy: "midi raw bend", summary: `mutated ${mutated} bytes` };
  }

  const t = settings.intensity / 100;
  const pitchSpread = Math.max(2, Math.round(t * 24));
  let pos = 8 + readU32BE(out, 4);
  let mutated = 0;
  let notesWarped = 0;

  while (pos + 8 <= out.length) {
    const chunkId = asciiAt(out, pos, 4);
    const chunkLen = readU32BE(out, pos + 4);
    const end = Math.min(out.length, pos + 8 + chunkLen);
    let p = pos + 8;

    if (chunkId === "MTrk") {
      let runningStatus = 0;
      const pitchShiftMap = new Map<number, number>();

      while (p < end) {
        // skip vlq delta time
        while (p < end && (out[p++] & 0x80) !== 0) {
          // continue reading vlq
        }
        if (p >= end) break;

        let status = out[p];
        if (status >= 0x80) {
          p++;
          if (status < 0xf0) runningStatus = status;
        } else {
          status = runningStatus;
        }

        if (status === 0xff) {
          // meta event: type + vlq len + data
          if (p >= end) break;
          p++;
          let len = 0;
          while (p < end) {
            const b = out[p++];
            len = (len << 7) | (b & 0x7f);
            if ((b & 0x80) === 0) break;
          }
          p = Math.min(end, p + len);
        } else if (status === 0xf0 || status === 0xf7) {
          let len = 0;
          while (p < end) {
            const b = out[p++];
            len = (len << 7) | (b & 0x7f);
            if ((b & 0x80) === 0) break;
          }
          p = Math.min(end, p + len);
        } else {
          const type = status & 0xf0;
          const ch = status & 0x0f;
          if (type === 0xc0 || type === 0xd0) {
            // program change (random gm instrument!) or channel pressure
            if (p < end && type === 0xc0 && ch !== 9 && rng.chance(0.4 + t * 0.55)) {
              out[p] = rng.int(0, 127);
              mutated++;
            }
            p += 1;
          } else if (type >= 0x80 && type <= 0xe0) {
            if (p + 2 > end) break;
            if (type === 0x90 && out[p + 1] > 0) {
              const origNote = out[p];
              const key = (ch << 8) | origNote;
              if (ch !== 9 && rng.chance(0.22 + t * 0.7)) {
                const nextNote = Math.max(12, Math.min(118, origNote + rng.int(-pitchSpread, pitchSpread)));
                pitchShiftMap.set(key, nextNote);
                out[p] = nextNote;
                out[p + 1] = Math.max(20, Math.min(127, out[p + 1] + rng.int(-Math.round(t * 50), Math.round(t * 50))));
                mutated += 2;
                notesWarped++;
              } else {
                pitchShiftMap.delete(key);
              }
            } else if (type === 0x80 || (type === 0x90 && out[p + 1] === 0)) {
              // match note-off pitch to its shifted note-on so notes never hang forever
              const key = (ch << 8) | out[p];
              const shifted = pitchShiftMap.get(key);
              if (shifted !== undefined) {
                out[p] = shifted;
                mutated++;
              }
            } else if (type === 0xe0 && rng.chance(0.4 + t * 0.5)) {
              out[p] = rng.int(0, 127);
              out[p + 1] = rng.int(0, 127);
              mutated += 2;
            }
            p += 2;
          } else {
            break;
          }
        }
      }
    }
    pos = end;
  }

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "midi note & instrument rot",
    summary: `scrambled ${notesWarped} notes & ${mutated} midi bytes (tracks & note-offs balanced)`,
  };
}

// mp4 / mov / m4v: locate mdat media box so moov/ftyp container atoms stay playable
function rotVideo(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  let start = Math.min(out.length, 4096);
  let end = out.length;

  if (settings.preserveHeader) {
    let pos = 0;
    while (pos + 8 <= out.length) {
      let size = readU32BE(out, pos);
      const type = asciiAt(out, pos + 4, 4);
      let hdr = 8;
      if (size === 1 && pos + 16 <= out.length) {
        size = readU32BE(out, pos + 12);
        hdr = 16;
      }
      if (size < 8) break;
      if (type === "mdat") {
        start = Math.min(out.length, pos + hdr + 256);
        end = Math.min(out.length, pos + size);
        break;
      }
      pos += size;
    }
  }

  const mutated = mutateByteRange(out, start, end, settings.mode, settings.intensity * 0.3, rng);
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "video mdat datamosh",
    summary: `bent ${mutated} bytes inside media data box (container atoms intact)`,
  };
}

// 3d models (.obj / binary .stl): warp vertex coordinates while preserving face indices
function rot3dModel(buf: Uint8Array, settings: RotSettings, rng: SeededRng, filename: string): RotResult {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const t = settings.intensity / 100;

  if (ext === "stl" && buf.length > 84 && !asciiAt(buf, 0, 5).startsWith("solid")) {
    const out = new Uint8Array(buf);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const triCount = readU32LE(out, 80);
    let mutated = 0;
    for (let i = 0; i < triCount; i++) {
      const base = 84 + i * 50;
      if (base + 48 > out.length) break;
      if (!rng.chance(0.2 + t * 0.7)) continue;
      for (let v = 0; v < 3; v++) {
        for (let axis = 0; axis < 3; axis++) {
          const off = base + 12 + v * 12 + axis * 4;
          const cur = view.getFloat32(off, true);
          if (!Number.isFinite(cur)) continue;
          const delta = (rng.next() - 0.5) * Math.max(0.5, Math.abs(cur) * 0.45) * t;
          view.setFloat32(off, cur + delta, true);
          mutated += 4;
        }
      }
    }
    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "binary stl vertex melt",
      summary: `melted ${mutated / 4} float32 vertex coordinates across ${triCount} triangles`,
    };
  }

  const text = new TextDecoder().decode(buf);
  let mutated = 0;
  const next = text.replace(/^(v\s+)(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/gm, (full, pre, x, y, z) => {
    if (!rng.chance(0.2 + t * 0.75)) return full;
    const warp = (s: string) => {
      const v = Number(s);
      const spread = Math.max(0.08, Math.abs(v) * 0.4) * t;
      return (v + (rng.next() - 0.5) * 2 * spread).toFixed(4);
    };
    mutated += 12;
    return `${pre}${warp(x)} ${warp(y)} ${warp(z)}`;
  });

  return {
    buffer: new TextEncoder().encode(next),
    mutatedBytes: mutated,
    strategy: "3d mesh vertex melt",
    summary: `displaced ${Math.round(mutated / 12)} mesh vertices (faces preserved)`,
  };
}

// office & epub zip-xml containers: glitch visible text inside inner xml/xhtml without breaking markup
async function rotZipDoc(buf: Uint8Array, settings: RotSettings, rng: SeededRng): Promise<RotResult> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const t = settings.intensity / 100;
    let mutated = 0;
    const glitchChars = ["▓", "░", "▒", "¤", "¿", "§", "ø", "æ", "∆", "≈", "¬"];

    const targets = Object.keys(zip.files).filter(
      (p) =>
        !zip.files[p].dir &&
        (p.startsWith("word/document") ||
          p.startsWith("ppt/slides/slide") ||
          p.startsWith("xl/sharedStrings") ||
          p.endsWith(".xhtml") ||
          p.endsWith(".html") ||
          p === "content.xml")
    );

    for (const path of targets) {
      const content = await zip.files[path].async("string");
      // only mutate text nodes between > and < so xml structure never breaks
      const rotted = content.replace(/>([^<]+)</g, (full, inner: string) => {
        if (!inner.trim()) return full;
        const chars = Array.from(inner);
        let changed = false;
        for (let i = 0; i < chars.length; i++) {
          if (chars[i] === " " || chars[i] === "\n" || chars[i] === "&") continue;
          if (!rng.chance(t * 0.35)) continue;
          changed = true;
          mutated++;
          if (rng.chance(0.5) && i + 1 < chars.length && chars[i + 1] !== "&") {
            const tmp = chars[i];
            chars[i] = chars[i + 1];
            chars[i + 1] = tmp;
          } else if (rng.chance(0.45)) {
            chars[i] = rng.pick(glitchChars);
          } else {
            chars[i] = chars[i] === chars[i].toUpperCase() ? chars[i].toLowerCase() : chars[i].toUpperCase();
          }
        }
        return changed ? `>${chars.join("")}<` : full;
      });
      zip.file(path, rotted);
    }

    const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "document xml text rot",
      summary: `glitched ${mutated} characters across ${targets.length} document xml file(s)`,
    };
  } catch {
    const out = new Uint8Array(buf);
    const mutated = mutateByteRange(out, 128, out.length, settings.mode, settings.intensity * 0.25, rng);
    return { buffer: out, mutatedBytes: mutated, strategy: "archive raw bend", summary: `bent ${mutated} bytes` };
  }
}

// pdf: mutate literal text strings in-place with identical byte lengths so xref offsets remain 100% valid
function rotPdf(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  const t = settings.intensity / 100;
  let mutated = 0;
  let inString = false;
  let depth = 0;

  for (let i = 16; i < out.length - 32; i++) {
    const c = out[i];
    if (c === 0x5c) {
      i++;
      continue;
    }
    if (c === 0x28) {
      inString = true;
      depth++;
      continue;
    }
    if (c === 0x29 && inString) {
      depth--;
      if (depth <= 0) inString = false;
      continue;
    }
    if (inString && c >= 0x21 && c <= 0x7e && c !== 0x28 && c !== 0x29 && c !== 0x5c && rng.chance(t * 0.4)) {
      out[i] = rng.int(0x21, 0x7e);
      if (out[i] === 0x28 || out[i] === 0x29 || out[i] === 0x5c) out[i] = 0x3f;
      mutated++;
    }
  }

  // if pdf streams were compressed, gently bend stream bytes past the header
  if (mutated === 0) {
    mutated = mutateByteRange(out, Math.min(out.length, 256), Math.max(256, out.length - 512), "byteflip", settings.intensity * 0.15, rng);
  }

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "pdf length-safe string rot",
    summary: `scrambled ${mutated} bytes while keeping pdf xref offsets intact`,
  };
}

// text / markdown: multi-mode glitch rot (chaos combo, zalgo, pixel-sort chars, invert/reverse, deepfry, stutter)
function rotText(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  const glitch = ["▓", "░", "▒", "¿", "§", "ø", "∆", "≈", "◊", "¬", "¥"];
  const combining = ["\u0301", "\u0308", "\u0336", "\u0338", "\u0303", "\u0327", "\u030a", "\u0332"];
  const activeMode: RotMode =
    settings.mode === "chaos"
      ? rng.pick(["glitch2d", "pixelsort", "melt", "deepfry", "shuffle", "stutter", "invert", "crush"])
      : settings.mode;

  // line-level chaos for glitch2d / shuffle
  let working = text;
  let mutated = 0;
  if (activeMode === "glitch2d" || activeMode === "invert") {
    const lines = working.split("\n");
    const hits = Math.max(1, Math.round(lines.length * t * 0.45));
    for (let i = 0; i < hits && lines.length > 1; i++) {
      const a = rng.int(0, lines.length - 1);
      if (activeMode === "invert") {
        lines[a] = Array.from(lines[a]).reverse().join("");
        mutated += lines[a].length;
      } else {
        const b = rng.int(0, lines.length - 1);
        const tmp = lines[a];
        lines[a] = lines[b];
        lines[b] = tmp;
        mutated += lines[a].length;
      }
    }
    working = lines.join("\n");
  }

  const chars = Array.from(working);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n" || ch === "\r" || ch === "\t" || ch === " ") continue;
    if (!rng.chance(t * 0.38)) continue;
    mutated++;
    if (activeMode === "melt" || activeMode === "deepfry") {
      const stacks = activeMode === "deepfry" ? rng.int(2, 4) : 1;
      let next = activeMode === "deepfry" ? ch.toUpperCase() : ch;
      for (let s = 0; s < stacks; s++) next += rng.pick(combining);
      chars[i] = next;
    } else if (activeMode === "pixelsort" && i + 8 < chars.length) {
      const span = rng.int(4, 12);
      const sub = chars.slice(i, Math.min(chars.length, i + span));
      if (!sub.includes("\n")) {
        sub.sort();
        for (let k = 0; k < sub.length; k++) chars[i + k] = sub[k];
        i += sub.length - 1;
      }
    } else if (activeMode === "shuffle" && i + 2 < chars.length && chars[i + 1] !== "\n") {
      const tmp = chars[i];
      chars[i] = chars[i + 1];
      chars[i + 1] = tmp;
    } else if (activeMode === "stutter") {
      chars[i] = ch.repeat(rng.int(2, 4));
    } else if (activeMode === "crush") {
      chars[i] = rng.pick(glitch);
    } else if (activeMode === "rgbshift") {
      chars[i] = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    } else {
      chars[i] = rng.chance(0.5) ? rng.pick(glitch) : ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    }
  }

  return {
    buffer: new TextEncoder().encode(chars.join("")),
    mutatedBytes: mutated,
    strategy: `text ${activeMode} glitch`,
    summary: `glitched ${mutated} characters (${activeMode})`,
  };
}

// generic binary / containers (webp, flac, ogg, tracker, lmms, anything else)
function rotBinary(buf: Uint8Array, settings: RotSettings, rng: SeededRng, label = "header-guarded binary rot"): RotResult {
  const out = new Uint8Array(buf);
  const skip = settings.preserveHeader
    ? Math.min(Math.floor(out.length * 0.25), Math.max(64, settings.headerSkipBytes))
    : 0;
  const mutated = mutateByteRange(out, skip, out.length, settings.mode, settings.intensity, rng);
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: label,
    summary: `mutated ${mutated} bytes${skip > 0 ? ` (skipped ${skip} b header)` : " (full file)"}`,
  };
}

export const FORMAT_HANDLERS: FormatHandler[] = [
  // codebases & config
  {
    id: "source-code",
    label: "source code (.ts / .tsx / .js / .py / .rs / .go / .c / .cpp / .java / .astro / ...)",
    category: "code",
    extensions: [
      "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp", "cc", "h", "hpp",
      "cs", "php", "rb", "swift", "kt", "kts", "scala", "lua", "sh", "bash", "zsh", "ps1", "sql",
      "astro", "vue", "svelte", "dart", "zig", "r", "ex", "exs", "erl", "hs", "ml", "pl", "pm",
    ],
    strategy: "syntax-safe coderot",
    notes: "warps strings, numbers, booleans & operators while keeping imports intact",
    rot: rotCode,
  },
  {
    id: "stylesheet",
    label: "stylesheets (.css / .scss / .sass / .less)",
    category: "code",
    extensions: ["css", "scss", "sass", "less", "styl"],
    strategy: "css color & layout warp",
    notes: "shifts hex colors and layout units (px/rem/deg) while staying valid css",
    rot: rotStylesheet,
  },
  {
    id: "json",
    label: "json & lottie (.json / .jsonc / .lottie / .mcmeta)",
    category: "code",
    extensions: ["json", "jsonc", "lottie", "webmanifest", "mcmeta"],
    strategy: "schema-safe json rot",
    notes: "mutates values recursively while keeping valid parseable json",
    rot: rotJson,
  },
  {
    id: "markup",
    label: "html / xml / plist (.html / .xml / .plist / .xhtml)",
    category: "code",
    extensions: ["html", "htm", "xml", "plist", "xhtml", "rss", "atom", "xaml"],
    strategy: "markup text & color rot",
    notes: "glitches visible text nodes & hex fills while keeping tags balanced",
    rot: rotMarkup,
  },
  {
    id: "config",
    label: "configs (.yaml / .yml / .toml / .ini / .env)",
    category: "code",
    extensions: ["yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties"],
    strategy: "config value rot",
    notes: "preserves keys & comments while corrupting config values",
    rot: rotConfig,
  },
  {
    id: "shader",
    label: "shaders (.glsl / .vert / .frag / .wgsl / .hlsl)",
    category: "code",
    extensions: ["glsl", "vert", "frag", "wgsl", "hlsl", "shader"],
    strategy: "shader float & swizzle rot",
    notes: "warps float constants and .rgb/.xyz channel swizzles",
    rot: rotShader,
  },

  // images & graphics
  {
    id: "jpeg",
    label: "jpeg (.jpg / .jpeg)",
    category: "image",
    extensions: ["jpg", "jpeg"],
    strategy: "sos scan-data databend",
    notes: "keeps markers & headers valid for classic glitch bars",
    detect: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    rot: rotJpeg,
  },
  {
    id: "png",
    label: "png (.png)",
    category: "image",
    extensions: ["png"],
    strategy: "idat scanline & filter warp",
    notes: "mutates row filters (paeth/sub/up) + recomputes crc-32",
    detect: (b) => b.length >= 8 && b[0] === 0x89 && asciiAt(b, 1, 3) === "PNG",
    rot: rotPng,
  },
  {
    id: "bmp",
    label: "bmp (.bmp)",
    category: "image",
    extensions: ["bmp"],
    strategy: "raw pixel-array bend",
    notes: "preserves dib header and bends raw rgb rows",
    detect: (b) => b.length >= 2 && asciiAt(b, 0, 2) === "BM",
    rot: rotBmp,
  },
  {
    id: "gif",
    label: "gif (.gif)",
    category: "image",
    extensions: ["gif"],
    strategy: "palette & frame bend",
    notes: "scrambles color table + frame data",
    detect: (b) => b.length >= 6 && asciiAt(b, 0, 3) === "GIF",
    rot: rotGif,
  },
  {
    id: "webp",
    label: "webp (.webp)",
    category: "image",
    extensions: ["webp"],
    strategy: "2d glitch & vp8/vp8l bend",
    notes: "multi-directional 2d glitch or raw riff/webp payload bend",
    detect: (b) => b.length >= 12 && asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "WEBP",
    rot: rotWebp,
  },
  {
    id: "svg",
    label: "svg (.svg)",
    category: "image",
    extensions: ["svg"],
    strategy: "vector path & color melt",
    notes: "warps path coordinates and hex fills while keeping valid xml",
    rot: rotSvg,
  },
  {
    id: "image-extra",
    label: "raw & pro graphics (.psd / .aseprite / .tga / .tiff / .ico / .avif / .heic / .ppm)",
    category: "image",
    extensions: ["psd", "psb", "ase", "aseprite", "tga", "tif", "tiff", "ico", "cur", "avif", "heic", "heif", "jxl", "ppm", "pgm", "pbm"],
    strategy: "format-aware pixel bend",
    notes: "preserves format headers (8BPS/TGA/ISO-BMFF/Netpbm) while bending pixels",
    rot: rotImageExtra,
  },

  // audio & music
  {
    id: "wav",
    label: "wav / aiff (.wav / .aiff)",
    category: "audio",
    extensions: ["wav", "aif", "aiff"],
    strategy: "pcm sample glitch dsp",
    notes: "keeps riff/fmt intact — playable stutter, crush & melt",
    detect: (b) =>
      b.length >= 12 &&
      ((asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "WAVE") ||
        (asciiAt(b, 0, 4) === "FORM" && asciiAt(b, 8, 3) === "AIF")),
    rot: rotWavAiff,
  },
  {
    id: "mp3",
    label: "mp3 (.mp3)",
    category: "audio",
    extensions: ["mp3"],
    strategy: "mpeg frame shuffle & stutter",
    notes: "skips id3v2 and glitches frames between sync headers",
    detect: (b, ext) => ext === "mp3" || asciiAt(b, 0, 3) === "ID3",
    rot: rotMp3,
  },
  {
    id: "audio-other",
    label: "flac / ogg / opus / m4a / aac / caf",
    category: "audio",
    extensions: ["flac", "ogg", "opus", "m4a", "aac", "wma", "caf"],
    strategy: "container-safe audio payload bend",
    notes: "preserves container headers and bends audio frames",
    rot: (b, s, r) => rotBinary(b, { ...s, headerSkipBytes: Math.max(1024, s.headerSkipBytes) }, r, "audio frame payload bend"),
  },

  // daw projects, synths & midi
  {
    id: "flp",
    label: "fl studio (.flp / .fst)",
    category: "daw",
    extensions: ["flp", "fst"],
    strategy: "FLhd/FLdt event-stream rot",
    notes: "warps audio clips, playlist, piano-roll notes, mixer eq/pan & bpm safely",
    detect: (b) => b.length >= 4 && asciiAt(b, 0, 4) === "FLhd",
    rot: rotFlp,
  },
  {
    id: "reaper",
    label: "reaper (.rpp)",
    category: "daw",
    extensions: ["rpp"],
    strategy: "reaper chunk & midi rot",
    notes: "warps tempo, playrate & inline midi events while staying loadable",
    rot: rotReaper,
  },
  {
    id: "midi",
    label: "midi (.mid / .midi)",
    category: "daw",
    extensions: ["mid", "midi"],
    strategy: "MThd/MTrk note & instrument rot",
    notes: "warps pitches, velocities, pitch bends & random gm instruments",
    detect: (b) => b.length >= 4 && asciiAt(b, 0, 4) === "MThd",
    rot: rotMidi,
  },
  {
    id: "soundfont",
    label: "soundfont 2 (.sf2)",
    category: "daw",
    extensions: ["sf2"],
    strategy: "sf2 sample pool glitch",
    notes: "glitches 16-bit smpl waveforms while keeping presets & keymaps intact",
    detect: (b) => b.length >= 12 && asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "sfbk",
    rot: rotSoundFont,
  },
  {
    id: "synth-preset",
    label: "synth presets (.vital / .fxp / .fxb / .h2p)",
    category: "daw",
    extensions: ["vital", "fxp", "fxb", "h2p"],
    strategy: "synth patch parameter rot",
    notes: "mutates vital json oscillators/filters or vst preset params",
    rot: (b, s, r, fn) => {
      if (fn.toLowerCase().endsWith(".vital")) return rotJson(b, s, r, fn);
      return rotBinary(b, { ...s, headerSkipBytes: Math.max(60, s.headerSkipBytes) }, r, "vst preset parameter rot");
    },
  },
  {
    id: "tracker",
    label: "tracker & lmms (.mmp / .mmpz / .mod / .xm / .it / .s3m)",
    category: "daw",
    extensions: ["mmp", "mmpz", "mod", "xm", "it", "s3m"],
    strategy: "pattern & sample bend",
    notes: "bends tracker patterns/samples or lmms xml notes",
    rot: (b, s, r, fn) => {
      if (fn.toLowerCase().endsWith(".mmp")) return rotMarkup(b, s, r);
      return rotBinary(b, { ...s, headerSkipBytes: Math.max(1084, s.headerSkipBytes) }, r, "tracker sample & pattern bend");
    },
  },

  // video
  {
    id: "video",
    label: "video (.mp4 / .mov / .m4v / .webm / .mkv / .avi)",
    category: "video",
    extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"],
    strategy: "mdat payload datamosh",
    notes: "keeps ftyp/moov intact and corrupts media payload",
    rot: rotVideo,
  },

  // 3d & cad
  {
    id: "glb",
    label: "gltf binary (.glb)",
    category: "model3d",
    extensions: ["glb"],
    strategy: "glb bin-chunk vertex melt",
    notes: "melts BIN chunk float32 vertices while keeping glTF json intact",
    detect: (b) => b.length >= 4 && asciiAt(b, 0, 4) === "glTF",
    rot: rotGlb,
  },
  {
    id: "model3d",
    label: "3d meshes (.obj / .stl / .ply / .dae / .fbx)",
    category: "model3d",
    extensions: ["obj", "stl", "ply", "dae", "fbx"],
    strategy: "mesh vertex melt",
    notes: "displaces 3d vertices while keeping faces loadable",
    rot: (b, s, r, fn) => {
      const ext = fn.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "fbx") return rotBinary(b, { ...s, headerSkipBytes: Math.max(512, s.headerSkipBytes) }, r, "fbx mesh payload bend");
      return rot3dModel(b, s, r, fn);
    },
  },
  {
    id: "gcode",
    label: "3d print g-code (.gcode / .nc)",
    category: "model3d",
    extensions: ["gcode", "nc"],
    strategy: "g-code toolpath wobble",
    notes: "wobbles X/Y nozzle moves while keeping extrusion & headers safe",
    rot: rotGcode,
  },

  // fonts
  {
    id: "font",
    label: "fonts (.ttf / .otf / .woff / .woff2)",
    category: "font",
    extensions: ["ttf", "otf", "woff", "woff2"],
    strategy: "sfnt glyph table warp",
    notes: "warps glyf/CFF/kern tables & recomputes opentype checksums",
    detect: (b) => {
      if (b.length < 4) return false;
      const t = asciiAt(b, 0, 4);
      return t === "OTTO" || t === "wOFF" || t === "wOF2" || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0);
    },
    rot: rotFont,
  },

  // game roms & saves
  {
    id: "rom",
    label: "game roms (.nes / .gb / .gbc / .gba / .sfc / .smc / .n64 / .z64 / .nds / .md)",
    category: "rom",
    extensions: ["nes", "gb", "gbc", "gba", "sfc", "smc", "n64", "z64", "v64", "nds", "md", "gen", "sms", "gg", "pce"],
    strategy: "rom bank & tile corrupter",
    notes: "preserves console headers (and fixes game boy checksums) so emulators boot",
    detect: (b) => b.length >= 4 && asciiAt(b, 0, 4) === "NES\x1a",
    rot: rotGameRom,
  },
  {
    id: "save-file",
    label: "game saves & nbt (.sav / .srm / .nbt / .dat)",
    category: "rom",
    extensions: ["sav", "srm", "nbt", "dat"],
    strategy: "save-data chaos rot",
    notes: "bends save state payloads past headers",
    rot: (b, s, r) => rotBinary(b, { ...s, headerSkipBytes: Math.max(64, s.headerSkipBytes) }, r, "save-file payload rot"),
  },

  // documents & data
  {
    id: "ooxml",
    label: "office & epub (.docx / .pptx / .xlsx / .epub / .odt)",
    category: "document",
    extensions: ["docx", "pptx", "xlsx", "epub", "odt", "ods", "odp"],
    strategy: "zip-safe inner xml text rot",
    notes: "glitches document text while preserving valid zip/xml",
    rot: rotZipDoc,
  },
  {
    id: "pdf",
    label: "pdf (.pdf)",
    category: "document",
    extensions: ["pdf"],
    strategy: "length-safe string rot",
    notes: "mutates text in-place without breaking xref byte offsets",
    detect: (b) => b.length >= 5 && asciiAt(b, 0, 5) === "%PDF-",
    rot: rotPdf,
  },
  {
    id: "subtitles",
    label: "subtitles & lyrics (.srt / .vtt / .ass / .ssa / .lrc)",
    category: "document",
    extensions: ["srt", "vtt", "ass", "ssa", "lrc"],
    strategy: "subtitle dialogue glitch",
    notes: "glitches dialogue lines while keeping every timestamp intact",
    rot: rotSubtitles,
  },
  {
    id: "csv",
    label: "spreadsheets (.csv / .tsv)",
    category: "document",
    extensions: ["csv", "tsv"],
    strategy: "csv/tsv table rot",
    notes: "preserves column headers while mutating data cells & numbers",
    rot: rotCsv,
  },

  // text
  {
    id: "text",
    label: "plain text & markdown (.txt / .md / .mdx / .log / .rtf)",
    category: "text",
    extensions: ["txt", "md", "mdx", "log", "rtf", "gitignore", "license"],
    strategy: "unicode & token glitch",
    notes: "char swaps, zalgo melt, block glitch & stutter",
    rot: rotText,
  },

  // sqlite, wasm & any raw binary
  {
    id: "sqlite-wasm",
    label: "sqlite & wasm (.sqlite / .db / .wasm)",
    category: "binary",
    extensions: ["sqlite", "sqlite3", "db", "wasm"],
    strategy: "container-safe binary rot",
    notes: "protects sqlite/wasm headers while bending payload pages/sections",
    detect: (b) =>
      (b.length >= 15 && asciiAt(b, 0, 15) === "SQLite format 3") ||
      (b.length >= 4 && b[0] === 0x00 && asciiAt(b, 1, 3) === "asm"),
    rot: rotSqliteOrWasm,
  },
  {
    id: "binary",
    label: "any other file (raw binary)",
    category: "binary",
    extensions: ["*"],
    strategy: "header-guarded byte rot",
    notes: "skips safe header bytes and bends the payload of any file",
    rot: (b, s, r) => rotBinary(b, s, r),
  },
];

export function detectHandler(filename: string, buf: Uint8Array): FormatHandler {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  for (const h of FORMAT_HANDLERS) {
    if (h.id !== "binary" && h.extensions.includes(ext)) return h;
  }
  for (const h of FORMAT_HANDLERS) {
    if (h.detect && h.detect(buf, ext)) return h;
  }
  // detect extensionless text/code files (e.g., Makefile, Dockerfile, LICENSE) heuristically
  if (buf.length > 0 && buf.length < 512 * 1024) {
    let binaryBytes = 0;
    const sampleLen = Math.min(buf.length, 512);
    for (let i = 0; i < sampleLen; i++) {
      const c = buf[i];
      if (c === 0 || (c < 7 && c !== 0) || (c > 13 && c < 32)) binaryBytes++;
    }
    if (binaryBytes === 0) {
      return FORMAT_HANDLERS.find((h) => h.id === "text") ?? FORMAT_HANDLERS[FORMAT_HANDLERS.length - 1];
    }
  }
  return FORMAT_HANDLERS[FORMAT_HANDLERS.length - 1];
}

export function guessMimeType(filename: string, category: RotCategory): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    bmp: "image/bmp",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    avif: "image/avif",
    wav: "audio/wav",
    aif: "audio/aiff",
    aiff: "audio/aiff",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    ogg: "audio/ogg",
    opus: "audio/opus",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
    mid: "audio/midi",
    midi: "audio/midi",
  };
  if (map[ext]) return map[ext];
  if (category === "text" || category === "code") return "text/plain";
  return "application/octet-stream";
}

export async function runRot(
  filename: string,
  originalBuffer: Uint8Array,
  settings: RotSettings
): Promise<{ handler: FormatHandler; result: RotResult }> {
  const handler = detectHandler(filename, originalBuffer);
  const rng = createRng(settings.seed);
  const result = await handler.rot(originalBuffer, settings, rng, filename);
  return { handler, result };
}
