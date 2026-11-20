import { mutateByteRange } from "./byteEngines";
import type { SeededRng } from "./prng";
import type { RotResult, RotSettings } from "./types";

function asciiAt(buf: Uint8Array, offset: number, len: number): string {
  let out = "";
  const end = Math.min(buf.length, offset + len);
  for (let i = offset; i < end; i++) out += String.fromCharCode(buf[i]);
  return out;
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function writeU32BE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

const GLITCH_CHARS = ["▓", "░", "▒", "¿", "§", "ø", "∆", "≈", "◊", "¬"];
const COMBINING = ["\u0301", "\u0308", "\u0336", "\u0338", "\u0303", "\u0327"];

function glitchString(input: string, t: number, mode: RotSettings["mode"], rng: SeededRng): { text: string; count: number } {
  const activeMode =
    mode === "chaos"
      ? rng.pick(["glitch2d", "pixelsort", "melt", "deepfry", "shuffle", "stutter", "invert", "crush"] as const)
      : mode;

  if (activeMode === "invert" && input.length > 2) {
    const rev = Array.from(input).reverse().join("");
    return { text: rev, count: rev.length };
  }

  const chars = Array.from(input);
  let count = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n" || ch === "\r" || ch === "\t" || ch === " " || ch === "\\" || ch === "\"" || ch === "'") continue;
    if (!rng.chance(0.08 + t * 0.45)) continue;
    count++;
    if (activeMode === "melt" || activeMode === "deepfry") {
      chars[i] = (activeMode === "deepfry" ? ch.toUpperCase() : ch) + rng.pick(COMBINING);
    } else if (activeMode === "pixelsort" && i + 5 < chars.length) {
      const sub = chars.slice(i, i + 5).sort();
      for (let k = 0; k < sub.length; k++) chars[i + k] = sub[k];
      i += 4;
    } else if ((activeMode === "shuffle" || activeMode === "glitch2d") && i + 1 < chars.length && chars[i + 1] !== "\\" && chars[i + 1] !== "\n") {
      const tmp = chars[i];
      chars[i] = chars[i + 1];
      chars[i + 1] = tmp;
    } else if (activeMode === "stutter") {
      chars[i] = ch + ch;
    } else if (activeMode === "crush") {
      chars[i] = rng.pick(GLITCH_CHARS);
    } else {
      chars[i] = rng.chance(0.45) ? rng.pick(GLITCH_CHARS) : ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    }
  }
  return { text: chars.join(""), count };
}

function warpNumber(raw: string, t: number, rng: SeededRng): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const isFloat = raw.includes(".");
  const mag = Math.max(1, Math.abs(n));
  const delta = (rng.next() - 0.5) * 2 * mag * (0.15 + t * 0.9);
  const next = n + delta;
  return isFloat ? next.toFixed(Math.min(4, raw.split(".")[1]?.length ?? 2)) : String(Math.round(next));
}

function shiftHexColor(hex: string, t: number, rng: SeededRng): string {
  const raw = hex.slice(1);
  if (raw.length !== 3 && raw.length !== 6) return hex;
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  const spread = Math.round(40 + t * 215);
  const ch = [0, 2, 4].map((o) => {
    const v = parseInt(full.slice(o, o + 2), 16);
    const nv = (v + rng.int(-spread, spread) + 256) & 0xff;
    return nv.toString(16).padStart(2, "0");
  });
  return `#${ch.join("")}`;
}

// syntax-aware source code rotter: warps strings, numbers, booleans & operators while preserving imports/structure
export function rotCode(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;

  if (!settings.preserveHeader) {
    const res = glitchString(text, Math.min(1, t * 1.15), settings.mode, rng);
    return {
      buffer: new TextEncoder().encode(res.text),
      mutatedBytes: res.count,
      strategy: "raw source code nuke",
      summary: `glitched ${res.count} characters across entire source file`,
    };
  }

  let mutated = 0;
  let stringsHit = 0;
  let numbersHit = 0;
  let logicFlips = 0;

  // line-by-line so import/require/export-from module specifiers stay intact
  const lines = text.split("\n");
  const cursedComments = ["// coderotted", "// do not remove", "// haunted", "// works on my machine", "// idk why"];

  const outLines = lines.map((line) => {
    const trimmed = line.trimStart();
    const isImportLine =
      trimmed.startsWith("import ") ||
      trimmed.startsWith("from ") ||
      trimmed.startsWith("export ") && trimmed.includes(" from ") ||
      trimmed.startsWith("#include") ||
      trimmed.startsWith("use ") ||
      trimmed.startsWith("package ") ||
      trimmed.startsWith("require(");

    if (isImportLine) return line;

    // 1) mutate string literals (single & double quotes, skipping escape sequences & url/paths at low chaos)
    let next = line.replace(/(["'])((?:\\.|(?!\1)[^\\\n]){2,80})\1/g, (full, quote: string, inner: string) => {
      if (t < 0.75 && (/^[./@a-zA-Z0-9_-]+\/[./@a-zA-Z0-9_-]+$/.test(inner) || inner.startsWith("http"))) {
        return full;
      }
      if (!rng.chance(0.18 + t * 0.6)) return full;
      const g = glitchString(inner, t * 0.85, settings.mode, rng);
      if (g.count === 0) return full;
      stringsHit++;
      mutated += g.count;
      return `${quote}${g.text}${quote}`;
    });

    // 2) tweak standalone numeric literals
    next = next.replace(/(?<![\w.#$])(-?\d+(?:\.\d+)?)(?![\w])/g, (full, numStr: string) => {
      if ((numStr === "0" || numStr === "1") && t < 0.45) return full;
      if (!rng.chance(0.12 + t * 0.45)) return full;
      const warped = warpNumber(numStr, t, rng);
      if (warped === numStr) return full;
      numbersHit++;
      mutated += warped.length;
      return warped;
    });

    // 3) flip occasional booleans and comparison operators at medium/high intensity
    if (t >= 0.22) {
      next = next.replace(/\b(true|false)\b/g, (full) => {
        if (!rng.chance(t * 0.32)) return full;
        logicFlips++;
        mutated += 4;
        return full === "true" ? "false" : "true";
      });
    }
    if (t >= 0.42) {
      next = next.replace(/(===|!==|<=|>=)/g, (op) => {
        if (!rng.chance((t - 0.3) * 0.35)) return op;
        logicFlips++;
        mutated += op.length;
        if (op === "===") return "!==";
        if (op === "!==") return "===";
        return op === "<=" ? ">=" : "<=";
      });
    }

    // 4) sprinkle rare cursed inline comments on code lines ending with ;
    if (t >= 0.5 && trimmed.endsWith(";") && !line.includes("//") && rng.chance((t - 0.45) * 0.14)) {
      const note = rng.pick(cursedComments);
      mutated += note.length;
      next = `${next} ${note}`;
    }

    return next;
  });

  return {
    buffer: new TextEncoder().encode(outLines.join("\n")),
    mutatedBytes: mutated,
    strategy: "syntax-safe coderot",
    summary: `rotted ${stringsHit} strings, ${numbersHit} numbers & ${logicFlips} logic tokens (imports safe)`,
  };
}

// stylesheets (.css / .scss / .less / .sass): warp hex colors, rgb values & numeric units while keeping valid css
export function rotStylesheet(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;
  let colors = 0;
  let units = 0;

  let next = text.replace(/#[0-9a-fA-F]{3,6}\b/g, (hex) => {
    if (!rng.chance(0.3 + t * 0.65)) return hex;
    colors++;
    mutated += hex.length;
    return shiftHexColor(hex, t, rng);
  });

  next = next.replace(/(-?\d+(?:\.\d+)?)(px|rem|em|vh|vw|%|deg|ms|s)\b/g, (full, num: string, unit: string) => {
    if (!rng.chance(0.22 + t * 0.58)) return full;
    const warped = warpNumber(num, t * 0.75, rng);
    units++;
    mutated += warped.length;
    return `${warped}${unit}`;
  });

  return {
    buffer: new TextEncoder().encode(next),
    mutatedBytes: mutated,
    strategy: "css color & layout warp",
    summary: `shifted ${colors} hex colors & ${units} layout units (valid css syntax)`,
  };
}

// json / vital synth patches / lottie animations: mutate values while producing 100% valid json
export function rotJson(buf: Uint8Array, settings: RotSettings, rng: SeededRng, filename: string): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  const isVital = filename.toLowerCase().endsWith(".vital");

  if (settings.preserveHeader) {
    try {
      const parsed = JSON.parse(text);
      let mutated = 0;

      const walk = (val: unknown, keyName = ""): unknown => {
        if (typeof val === "number") {
          if (!rng.chance(0.22 + t * 0.62)) return val;
          mutated += 4;
          if (isVital) {
            // keep vital oscillator/filter parameters inside playable synth ranges
            const span = Math.max(0.15, Math.abs(val) * 0.55) * t;
            return Number((val + (rng.next() - 0.5) * 2 * span).toFixed(4));
          }
          const mag = Math.max(1, Math.abs(val));
          const next = val + (rng.next() - 0.5) * 2 * mag * (0.15 + t * 0.8);
          return Number.isInteger(val) ? Math.round(next) : Number(next.toFixed(3));
        }
        if (typeof val === "boolean") {
          if (rng.chance(t * 0.35)) {
            mutated += 4;
            return !val;
          }
          return val;
        }
        if (typeof val === "string") {
          // keep version/dependency semver strings and short ids safe in package.json unless chaos is high
          if (t < 0.7 && (keyName === "version" || keyName === "type" || keyName === "main" || val.startsWith("^") || val.startsWith("~"))) {
            return val;
          }
          if (!rng.chance(0.2 + t * 0.58)) return val;
          const g = glitchString(val, t * 0.8, settings.mode, rng);
          mutated += g.count;
          return g.text;
        }
        if (Array.isArray(val)) {
          return val.map((item) => walk(item, keyName));
        }
        if (val && typeof val === "object") {
          const outObj: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            outObj[k] = walk(v, k);
          }
          return outObj;
        }
        return val;
      };

      const rottedObj = walk(parsed);
      const pretty = text.includes("\n") ? JSON.stringify(rottedObj, null, 2) : JSON.stringify(rottedObj);
      return {
        buffer: new TextEncoder().encode(pretty),
        mutatedBytes: mutated,
        strategy: isVital ? "vital synth patch rot" : "schema-safe json rot",
        summary: `mutated ${mutated} values while keeping ${isVital ? ".vital synth" : "json"} 100% parseable`,
      };
    } catch {
      // fall through to regex rot for jsonc / trailing commas
    }
  }

  return rotCode(buf, settings, rng);
}

// html / xml / plist / xhtml: glitch visible text nodes & inline hex colors while keeping tags balanced
export function rotMarkup(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;

  let next = text.replace(/>([^<]+)</g, (full, inner: string) => {
    if (!inner.trim()) return full;
    const g = glitchString(inner, t * 0.85, settings.mode, rng);
    mutated += g.count;
    return g.count > 0 ? `>${g.text}<` : full;
  });

  next = next.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => {
    if (!rng.chance(0.25 + t * 0.6)) return hex;
    mutated += 6;
    return shiftHexColor(hex, t, rng);
  });

  return {
    buffer: new TextEncoder().encode(next),
    mutatedBytes: mutated,
    strategy: "markup text & color rot",
    summary: `glitched ${mutated} characters inside text nodes (html/xml tags intact)`,
  };
}

// yaml / toml / ini / env: preserve keys & comments, mutate values only
export function rotConfig(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;

  const lines = text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("[")) return line;
    const m = line.match(/^(\s*[\w.-]+\s*[:=]\s*)(.+)$/);
    if (!m) return line;
    const [, prefix, val] = m;
    if (!rng.chance(0.25 + t * 0.6)) return line;
    if (/^-?\d+(?:\.\d+)?$/.test(val.trim())) {
      const warped = warpNumber(val.trim(), t, rng);
      mutated += warped.length;
      return `${prefix}${warped}`;
    }
    if (val.trim() === "true" || val.trim() === "false") {
      mutated += 4;
      return `${prefix}${val.trim() === "true" ? "false" : "true"}`;
    }
    const g = glitchString(val, t * 0.75, settings.mode, rng);
    mutated += g.count;
    return `${prefix}${g.text}`;
  });

  return {
    buffer: new TextEncoder().encode(lines.join("\n")),
    mutatedBytes: mutated,
    strategy: "config value rot",
    summary: `mutated ${mutated} config value chars (keys & structure preserved)`,
  };
}

// shaders (.glsl / .vert / .frag / .wgsl / .hlsl): warp floats & rgb/xyz swizzles
export function rotShader(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;

  let next = text.replace(/\b(-?\d+\.\d+f?)\b/g, (full) => {
    if (!rng.chance(0.22 + t * 0.62)) return full;
    const suffix = full.endsWith("f") ? "f" : "";
    const warped = warpNumber(suffix ? full.slice(0, -1) : full, t, rng);
    mutated += warped.length;
    return `${warped}${suffix}`;
  });

  const swizzles3 = ["rgb", "gbr", "brg", "rbg", "bgr", "grb"];
  const swizzles2 = ["xy", "yx", "xx", "yy"];
  next = next.replace(/\.(rgb|xyz|xy)\b/g, (full, sw: string) => {
    if (!rng.chance(0.2 + t * 0.5)) return full;
    mutated += sw.length;
    if (sw === "rgb") return `.${rng.pick(swizzles3)}`;
    if (sw === "xyz") return `.${rng.pick(["xyz", "yzx", "zxy", "zyx", "xzy"])}`;
    return `.${rng.pick(swizzles2)}`;
  });

  return {
    buffer: new TextEncoder().encode(next),
    mutatedBytes: mutated,
    strategy: "shader float & swizzle rot",
    summary: `warped ${mutated} shader constants & channel swizzles`,
  };
}

// truetype / opentype fonts (.ttf / .otf): mutate glyf / CFF / kern / hmtx tables and recompute sfnt checksums
export function rotFont(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  if (out.length < 28) {
    return { buffer: out, mutatedBytes: 0, strategy: "font raw bend", summary: "file too small" };
  }

  const sfntTag = readU32BE(out, 0);
  const isSfnt = sfntTag === 0x00010000 || sfntTag === 0x4f54544f || sfntTag === 0x74727565; // \0\1\0\0, OTTO, true
  if (!isSfnt || !settings.preserveHeader) {
    const mutated = mutateByteRange(out, settings.preserveHeader ? 256 : 0, out.length, settings.mode, settings.intensity * 0.4, rng);
    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "font payload bend",
      summary: `bent ${mutated} font bytes`,
    };
  }

  const numTables = (out[4] << 8) | out[5];
  const targetTags = new Set(["glyf", "CFF ", "CFF2", "kern", "hmtx"]);
  let mutated = 0;
  const hitTables: string[] = [];

  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > out.length) break;
    const tag = asciiAt(out, rec, 4);
    const offset = readU32BE(out, rec + 8);
    const length = readU32BE(out, rec + 12);
    if (!targetTags.has(tag) || offset + length > out.length || length < 32) continue;

    // skip first 24 bytes of each glyph/metric table to keep subheaders intact
    const start = offset + Math.min(24, Math.floor(length * 0.1));
    const end = offset + length;
    const scale = tag === "glyf" ? 0.32 : 0.25;
    const m = mutateByteRange(out, start, end, settings.mode, settings.intensity * scale, rng);
    mutated += m;
    hitTables.push(tag.trim());

    // recompute sfnt table checksum (sum of uint32 big-endian words)
    let sum = 0;
    const padded = (length + 3) & ~3;
    for (let p = offset; p < offset + padded && p + 3 < out.length; p += 4) {
      sum = (sum + readU32BE(out, p)) >>> 0;
    }
    writeU32BE(out, rec + 4, sum);
  }

  if (mutated === 0) {
    mutated = mutateByteRange(out, Math.min(out.length, 512), out.length, settings.mode, settings.intensity * 0.25, rng);
  }

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "sfnt glyph table warp",
    summary: `warped ${mutated} bytes in ${hitTables.length ? hitTables.join(", ") : "font"} table(s) & recomputed checksums`,
  };
}

// game roms (.gb / .gbc / .nes / .gba / .sfc / .n64 / .nds / .md): real header guard + game boy checksum fix
export function rotGameRom(buf: Uint8Array, settings: RotSettings, rng: SeededRng, filename: string): RotResult {
  const out = new Uint8Array(buf);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if ((ext === "gb" || ext === "gbc") && out.length >= 0x8000 && settings.preserveHeader) {
    // preserve 0x0000-0x014F (boot vectors, nintendo logo & cart header)
    const start = 0x0400;
    const mutated = mutateByteRange(out, start, out.length, settings.mode, settings.intensity * 0.28, rng);

    // recompute game boy header checksum (0x014D) & 16-bit global checksum (0x014E-0x014F) so emulators boot it
    let hchk = 0;
    for (let i = 0x0134; i <= 0x014c; i++) hchk = (hchk - out[i] - 1) & 0xff;
    out[0x014d] = hchk;

    let gchk = 0;
    for (let i = 0; i < out.length; i++) {
      if (i === 0x014e || i === 0x014f) continue;
      gchk = (gchk + out[i]) & 0xffff;
    }
    out[0x014e] = (gchk >>> 8) & 0xff;
    out[0x014f] = gchk & 0xff;

    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "game boy rom corrupter",
      summary: `corrupted ${mutated} rom bytes (nintendo logo safe & checksums recalculated)`,
    };
  }

  if (ext === "nes" && out.length > 32 && asciiAt(out, 0, 4) === "NES\x1a" && settings.preserveHeader) {
    const prgSize = out[4] * 16384;
    const chrSize = out[5] * 8192;
    const hasTrainer = (out[6] & 0x04) !== 0;
    const prgStart = 16 + (hasTrainer ? 512 : 0);
    const chrStart = prgStart + prgSize;
    let mutated = 0;

    // target CHR-ROM graphics/sprites first so the game stays playable while sprites explode
    if (chrSize > 0 && chrStart < out.length) {
      mutated += mutateByteRange(out, chrStart, Math.min(out.length, chrStart + chrSize), settings.mode, settings.intensity * 0.65, rng);
    }
    if (settings.intensity >= 35 || chrSize === 0) {
      mutated += mutateByteRange(out, prgStart + 64, Math.min(out.length, prgStart + prgSize - 16), settings.mode, settings.intensity * 0.14, rng);
    }
    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "nes ines chr/prg corrupter",
      summary: `corrupted ${mutated} bytes (${chrSize > 0 ? "chr-rom tiles & " : ""}prg-rom, 16b ines header intact)`,
    };
  }

  // gba / snes / n64 / nds / genesis header guard
  const headerSkip = !settings.preserveHeader
    ? 0
    : ext === "gba"
      ? 0x200
      : ext === "n64" || ext === "z64" || ext === "v64"
        ? 0x1000
        : ext === "nds"
          ? 0x4000
          : 0x200;

  const mutated = mutateByteRange(out, Math.min(out.length, headerSkip), out.length, settings.mode, settings.intensity * 0.25, rng);
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: `${ext.toUpperCase() || "rom"} bank corrupter`,
    summary: `corrupted ${mutated} rom bytes (skipped 0x${headerSkip.toString(16)} header)`,
  };
}

// reaper project (.rpp): warp tempo, volpan, playrate & midi note events while keeping project loadable
export function rotReaper(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;

  let next = text.replace(/(TEMPO\s+)(\d+(?:\.\d+)?)/g, (full, pre: string, bpm: string) => {
    if (!rng.chance(0.45 + t * 0.5)) return full;
    const v = Number(bpm);
    const warped = Math.max(25, Math.min(340, v * (1 + (rng.next() - 0.5) * t * 1.1)));
    mutated += 4;
    return `${pre}${warped.toFixed(2)}`;
  });

  next = next.replace(/(PLAYRATE\s+)(\d+(?:\.\d+)?)/g, (full, pre: string, rate: string) => {
    if (!rng.chance(0.35 + t * 0.55)) return full;
    const v = Number(rate);
    const warped = Math.max(0.25, Math.min(4.0, v * (1 + (rng.next() - 0.5) * t * 0.9)));
    mutated += 4;
    return `${pre}${warped.toFixed(5)}`;
  });

  // reaper midi item events: `E <offset> 90 <noteHex> <velHex>`
  next = next.replace(/^(\s*E\s+\d+\s+)(9[0-9a-fA-F])\s+([0-9a-fA-F]{2})\s+([0-9a-fA-F]{2})/gm, (full, pre, st, noteHex, velHex) => {
    if (!rng.chance(0.25 + t * 0.65)) return full;
    const note = parseInt(noteHex, 16);
    const spread = Math.max(2, Math.round(t * 24));
    const nextNote = Math.max(12, Math.min(115, note + rng.int(-spread, spread)));
    mutated += 2;
    return `${pre}${st} ${nextNote.toString(16).padStart(2, "0")} ${velHex}`;
  });

  return {
    buffer: new TextEncoder().encode(next),
    mutatedBytes: mutated,
    strategy: "reaper project chunk rot",
    summary: `warped ${mutated} tempo, playrate & midi event bytes (project structure intact)`,
  };
}

// soundfont 2 (.sf2): locate RIFF sfbk -> sdta -> smpl 16-bit pcm pool and bend instrument samples
export function rotSoundFont(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  let start = Math.min(out.length, 4096);
  let end = out.length;

  if (settings.preserveHeader && out.length > 24 && asciiAt(out, 0, 4) === "RIFF" && asciiAt(out, 8, 4) === "sfbk") {
    let pos = 12;
    while (pos + 8 <= out.length) {
      const id = asciiAt(out, pos, 4);
      const size = readU32LE(out, pos + 4);
      if (id === "LIST" && pos + 12 <= out.length && asciiAt(out, pos + 8, 4) === "sdta") {
        let sub = pos + 12;
        const listEnd = Math.min(out.length, pos + 8 + size);
        while (sub + 8 <= listEnd) {
          const sid = asciiAt(out, sub, 4);
          const ssize = readU32LE(out, sub + 4);
          if (sid === "smpl") {
            start = sub + 8;
            end = Math.min(listEnd, sub + 8 + ssize);
            break;
          }
          sub += 8 + ssize + (ssize & 1);
        }
        break;
      }
      pos += 8 + size + (size & 1);
    }
  }

  const mutated = mutateByteRange(out, start, end, settings.mode, settings.intensity * 0.75, rng, { blockAlign: 2 });
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "sf2 sample pool glitch",
    summary: `glitched ${mutated} pcm waveform bytes inside smpl chunk (presets & keymaps intact)`,
  };
}

// gltf binary (.glb): preserve 12-byte header + JSON chunk, warp BIN vertex floats
export function rotGlb(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const out = new Uint8Array(buf);
  if (out.length < 28 || asciiAt(out, 0, 4) !== "glTF" || !settings.preserveHeader) {
    const mutated = mutateByteRange(out, settings.preserveHeader ? 256 : 0, out.length, settings.mode, settings.intensity * 0.35, rng);
    return { buffer: out, mutatedBytes: mutated, strategy: "glb raw bend", summary: `bent ${mutated} bytes` };
  }

  let pos = 12;
  let binStart = 0;
  let binEnd = 0;
  while (pos + 8 <= out.length) {
    const len = readU32LE(out, pos);
    const type = readU32LE(out, pos + 4);
    if (type === 0x004e4942) {
      // "BIN\0"
      binStart = pos + 8;
      binEnd = Math.min(out.length, pos + 8 + len);
      break;
    }
    pos += 8 + len;
  }

  if (binEnd <= binStart) {
    return { buffer: out, mutatedBytes: 0, strategy: "glb vertex melt", summary: "no BIN buffer chunk found" };
  }

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const t = settings.intensity / 100;
  let mutated = 0;
  for (let off = binStart; off + 4 <= binEnd; off += 4) {
    if (!rng.chance(0.06 + t * 0.35)) continue;
    const v = view.getFloat32(off, true);
    // only warp reasonable vertex/normal/uv floats so index buffers aren't corrupted
    if (!Number.isFinite(v) || Math.abs(v) > 50000 || (Math.abs(v) > 0 && Math.abs(v) < 1e-6)) continue;
    const spread = Math.max(0.05, Math.abs(v) * 0.45) * t;
    view.setFloat32(off, v + (rng.next() - 0.5) * 2 * spread, true);
    mutated += 4;
  }

  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "glb bin-chunk vertex melt",
    summary: `melted ${mutated / 4} float32 vertices inside BIN chunk (glTF json intact)`,
  };
}

// 3d printer g-code (.gcode / .nc): wobble X/Y/Z toolpath coordinates
export function rotGcode(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;

  const lines = text.split("\n").map((line) => {
    if (!/^\s*G[01]\s/i.test(line)) return line;
    return line.replace(/([XY])(-?\d+(?:\.\d+)?)/g, (full, axis: string, val: string) => {
      if (!rng.chance(0.2 + t * 0.6)) return full;
      const n = Number(val);
      const next = n + (rng.next() - 0.5) * (1.2 + t * 8.5);
      mutated += 4;
      return `${axis}${next.toFixed(3)}`;
    });
  });

  return {
    buffer: new TextEncoder().encode(lines.join("\n")),
    mutatedBytes: mutated,
    strategy: "g-code toolpath wobble",
    summary: `wobbled ${mutated / 4} X/Y toolpath coordinates (extrusion & headers safe)`,
  };
}

// subtitles (.srt / .vtt / .ass / .lrc): preserve timestamps while glitching dialogue lines
export function rotSubtitles(buf: Uint8Array, settings: RotSettings, rng: SeededRng): RotResult {
  const text = new TextDecoder().decode(buf);
  const t = settings.intensity / 100;
  let mutated = 0;

  const lines = text.split("\n").map((line) => {
    const tr = line.trim();
    if (
      !tr ||
      tr === "WEBVTT" ||
      /^\d+$/.test(tr) ||
      tr.includes("-->") ||
      tr.startsWith("[") && !tr.startsWith("[0") && !tr.startsWith("[1") ||
      tr.startsWith("Style:") ||
      tr.startsWith("Format:")
    ) {
      return line;
    }
    const g = glitchString(line, t * 0.85, settings.mode, rng);
    mutated += g.count;
    return g.text;
  });

  return {
    buffer: new TextEncoder().encode(lines.join("\n")),
    mutatedBytes: mutated,
    strategy: "subtitle dialogue glitch",
    summary: `glitched ${mutated} dialogue chars (all timecodes preserved)`,
  };
}

// csv / tsv: keep header row 0 intact and rot data cells
export function rotCsv(buf: Uint8Array, settings: RotSettings, rng: SeededRng, filename: string): RotResult {
  const text = new TextDecoder().decode(buf);
  const sep = filename.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const t = settings.intensity / 100;
  const lines = text.split("\n");
  let mutated = 0;

  const outLines = lines.map((line, idx) => {
    if ((idx === 0 && settings.preserveHeader) || !line.trim()) return line;
    const cells = line.split(sep).map((cell) => {
      if (!rng.chance(0.2 + t * 0.6)) return cell;
      if (/^-?\d+(?:\.\d+)?$/.test(cell.trim())) {
        const w = warpNumber(cell.trim(), t, rng);
        mutated += w.length;
        return w;
      }
      const g = glitchString(cell, t * 0.75, settings.mode, rng);
      mutated += g.count;
      return g.text;
    });
    return cells.join(sep);
  });

  return {
    buffer: new TextEncoder().encode(outLines.join("\n")),
    mutatedBytes: mutated,
    strategy: "csv/tsv table rot",
    summary: `mutated ${mutated} data cell chars (column headers preserved)`,
  };
}

// extra image formats: tga, ico/cur, tiff, psd/psb, aseprite, netpbm (ppm/pgm/pbm), avif/heic/jxl
export function rotImageExtra(buf: Uint8Array, settings: RotSettings, rng: SeededRng, filename: string): RotResult {
  const out = new Uint8Array(buf);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  let skip = 128;
  let label = `${ext || "image"} payload bend`;

  if (!settings.preserveHeader) {
    skip = 0;
  } else if (ext === "tga" && out.length > 18) {
    const idLen = out[0];
    const hasCmap = out[1] === 1;
    const cmapLen = hasCmap ? (out[5] | (out[6] << 8)) * Math.ceil(out[7] / 8) : 0;
    skip = Math.min(out.length, 18 + idLen + cmapLen);
    label = "tga raw pixel bend";
  } else if (ext === "ppm" || ext === "pgm" || ext === "pbm") {
    // skip magic + width + height (+ maxval for ppm/pgm) whitespace tokens
    let tokens = 0;
    const target = ext === "pbm" ? 3 : 4;
    let i = 0;
    while (i < out.length && tokens < target) {
      while (i < out.length && (out[i] === 0x20 || out[i] === 0x0a || out[i] === 0x0d || out[i] === 0x09)) i++;
      if (out[i] === 0x23) {
        while (i < out.length && out[i] !== 0x0a) i++;
        continue;
      }
      while (i < out.length && out[i] > 0x20) i++;
      tokens++;
    }
    skip = Math.min(out.length, i + 1);
    label = "netpbm pixel-stream bend";
  } else if (ext === "psd" || ext === "psb") {
    skip = Math.min(out.length, 4096);
    label = "photoshop composite pixel bend";
  } else if (ext === "ase" || ext === "aseprite") {
    skip = Math.min(out.length, 144);
    label = "aseprite cel data bend";
  } else if (ext === "ico" || ext === "cur") {
    skip = Math.min(out.length, 64);
    label = "icon bitmap bend";
  } else if (ext === "avif" || ext === "heic" || ext === "heif" || ext === "jxl") {
    // locate ISO-BMFF mdat box if present
    let pos = 0;
    skip = Math.min(out.length, 512);
    while (pos + 8 <= out.length) {
      const sz = readU32BE(out, pos);
      const tp = asciiAt(out, pos + 4, 4);
      if (sz < 8) break;
      if (tp === "mdat") {
        skip = Math.min(out.length, pos + 24);
        break;
      }
      pos += sz;
    }
    label = `${ext} bitstream bend`;
  } else if (ext === "tif" || ext === "tiff") {
    skip = Math.min(out.length, 256);
    label = "tiff strip pixel bend";
  }

  const mutated = mutateByteRange(out, skip, out.length, settings.mode, settings.intensity * 0.5, rng);
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: label,
    summary: `bent ${mutated} pixel/stream bytes (${skip} b header protected)`,
  };
}

// sqlite / wasm binary formats
export function rotSqliteOrWasm(buf: Uint8Array, settings: RotSettings, rng: SeededRng, filename: string): RotResult {
  const out = new Uint8Array(buf);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const isSqlite = asciiAt(out, 0, 15) === "SQLite format 3" || ext === "sqlite" || ext === "sqlite3" || ext === "db";

  if (isSqlite) {
    const skip = settings.preserveHeader ? Math.min(out.length, 512) : 0;
    const mutated = mutateByteRange(out, skip, out.length, settings.mode, settings.intensity * 0.25, rng);
    return {
      buffer: out,
      mutatedBytes: mutated,
      strategy: "sqlite page-payload rot",
      summary: `mutated ${mutated} bytes past sqlite header`,
    };
  }

  // wasm: preserve 8-byte header + skip section id/size
  const skip = settings.preserveHeader ? Math.min(out.length, 64) : 0;
  const mutated = mutateByteRange(out, skip, out.length, settings.mode, settings.intensity * 0.2, rng);
  return {
    buffer: out,
    mutatedBytes: mutated,
    strategy: "wasm section payload rot",
    summary: `mutated ${mutated} wasm payload bytes (\0asm header intact)`,
  };
}
