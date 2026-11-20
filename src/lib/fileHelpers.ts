import JSZip from "jszip";
import type { RotFileItem } from "./types";

export interface RawFileEntry {
  file: File;
  relativePath?: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".astro",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  "coverage",
  ".idea",
  ".vscode",
]);

const IGNORED_FILES = new Set([
  ".ds_store",
  "thumbs.db",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
]);

export function shouldSkipRepoPath(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) return true;
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORED_DIRS.has(parts[i])) return true;
  }
  const base = parts[parts.length - 1].toLowerCase();
  if (IGNORED_FILES.has(base)) return true;
  if (parts.some((p) => p === "__MACOSX")) return true;
  return false;
}

// recursively extracts files from dragged folders via webkitGetAsEntry, skipping heavy build/vcs directories
export async function collectFilesFromDataTransfer(dt: DataTransfer): Promise<RawFileEntry[]> {
  const entries: RawFileEntry[] = [];
  const items = Array.from(dt.items ?? []);

  const walkEntry = async (entry: FileSystemEntry, prefix = ""): Promise<void> => {
    if (entry.isDirectory) {
      if (IGNORED_DIRS.has(entry.name) || entry.name === "__MACOSX") return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await new Promise<FileSystemEntry[]>((resolve) => {
        const all: FileSystemEntry[] = [];
        const readBatch = () => {
          reader.readEntries(
            (batch) => {
              if (batch.length === 0) resolve(all);
              else {
                all.push(...batch);
                readBatch();
              }
            },
            () => resolve(all)
          );
        };
        readBatch();
      });
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of children) {
        await walkEntry(child, nextPrefix);
      }
    } else if (entry.isFile) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (shouldSkipRepoPath(rel)) return;
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(
          (f) => resolve(f),
          () => resolve(null)
        );
      });
      if (file) {
        entries.push({ file, relativePath: rel });
      }
    }
  };

  let usedEntries = false;
  for (const item of items) {
    const fsEntry = item.webkitGetAsEntry?.();
    if (fsEntry) {
      usedEntries = true;
      await walkEntry(fsEntry);
    }
  }

  if (!usedEntries) {
    for (const file of Array.from(dt.files ?? [])) {
      entries.push({ file, relativePath: file.name });
    }
  }

  return entries;
}

export function rottedFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename}_rotted`;
  return `${filename.slice(0, dot)}_rotted${filename.slice(dot)}`;
}

export function downloadBytes(bytes: Uint8Array, filename: string, mimeType = "application/octet-stream"): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportAllAsZip(items: RotFileItem[]): Promise<void> {
  const zip = new JSZip();
  // preserve exact paths for folders/codebases so the exported zip can be unzipped and run directly
  const isFolderExport = items.some((i) => i.relativePath && i.relativePath.includes("/"));
  for (const item of items) {
    const targetName = isFolderExport
      ? (item.relativePath ?? item.filename)
      : rottedFilename(item.filename);
    zip.file(targetName, item.rottedBuffer);
  }
  const blob = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  downloadBytes(blob, isFolderExport ? "webrot-codebase.zip" : "webrot-export.zip", "application/zip");
}
