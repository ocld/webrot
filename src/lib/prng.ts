export interface SeededRng {
  next: () => number;
  int: (min: number, max: number) => number;
  chance: (p: number) => boolean;
  pick: <T>(arr: readonly T[]) => T;
}

// mulberry32 deterministic prng so a seed always reproduces the same rot
export function createRng(seed: number): SeededRng {
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: <T>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)],
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 899999) + 100000;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function pipeStream(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const res = new Response(new Blob([copy]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  return pipeStream(data, new DecompressionStream("gzip"));
}

export function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  return pipeStream(data, new CompressionStream("gzip"));
}

export function zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
  return pipeStream(data, new DecompressionStream("deflate"));
}

export function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  return pipeStream(data, new CompressionStream("deflate"));
}
