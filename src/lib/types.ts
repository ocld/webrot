export type RotCategory =
  | "code"
  | "image"
  | "audio"
  | "daw"
  | "video"
  | "model3d"
  | "font"
  | "rom"
  | "document"
  | "text"
  | "binary";

export type RotMode =
  | "chaos"
  | "smart"
  | "glitch2d"
  | "pixelsort"
  | "rgbshift"
  | "melt"
  | "deepfry"
  | "shuffle"
  | "stutter"
  | "invert"
  | "crush"
  | "byteflip";

export interface RotSettings {
  mode: RotMode;
  intensity: number; // 1..100
  seed: number;
  preserveHeader: boolean;
  headerSkipBytes: number;
}

export interface RotResult {
  buffer: Uint8Array;
  mutatedBytes: number;
  strategy: string;
  summary: string;
}

export interface RotFormatSpec {
  id: string;
  label: string;
  category: RotCategory;
  extensions: string[];
  strategy: string;
  notes: string;
}

export interface RotFileItem {
  id: string;
  filename: string;
  relativePath?: string;
  originalBuffer: Uint8Array;
  rottedBuffer: Uint8Array;
  mimeType: string;
  category: RotCategory;
  handlerId: string;
  handlerLabel: string;
  fileSize: number;
  settings: RotSettings;
  mutatedBytes: number;
  lastStrategy: string;
  lastSummary: string;
  isProcessing: boolean;
}

export function createDefaultSettings(seed?: number): RotSettings {
  return {
    mode: "chaos",
    intensity: 34,
    seed: seed ?? Math.floor(Math.random() * 899999) + 100000,
    preserveHeader: true,
    headerSkipBytes: 256,
  };
}
