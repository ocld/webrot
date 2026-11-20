import JSZip from "jszip";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, ToastStack, type ToastItem } from "@/design";
import {
  collectFilesFromDataTransfer,
  downloadBytes,
  exportAllAsZip,
  rottedFilename,
  shouldSkipRepoPath,
  type RawFileEntry,
} from "@/lib/fileHelpers";
import { guessMimeType, runRot } from "@/lib/formatRots";
import { randomSeed } from "@/lib/prng";
import { createDefaultSettings, type RotFileItem, type RotSettings } from "@/lib/types";
import { DropZone, FullWindowDragOverlay } from "./dropZone";
import { FormatsModal } from "./formatsModal";
import { RotWorkspace } from "./rotWorkspace";
import { WebrotLogo } from "./webrotLogo";
import "./webrotApp.css";

export function WebrotApp() {
  const [items, setItems] = useState<RotFileItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nightMode, setNightMode] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [formatsOpen, setFormatsOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    setNightMode(document.documentElement.dataset.theme === "night");
  }, []);

  const toggleTheme = useCallback(() => {
    setNightMode((prev) => {
      const next = !prev;
      if (next) {
        document.documentElement.dataset.theme = "night";
        try { localStorage.setItem("webrot-theme", "night"); } catch {}
      } else {
        delete document.documentElement.dataset.theme;
        try { localStorage.setItem("webrot-theme", "day"); } catch {}
      }
      return next;
    });
  }, []);

  const pushToast = useCallback((message: string, tone: ToastItem["tone"] = "info") => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { id, message: message.toLowerCase(), tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3400);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const ingestEntries = useCallback(
    async (entries: RawFileEntry[], unpackZips = false) => {
      if (entries.length === 0) return;
      setBusyLabel("rotting files...");
      try {
        const expanded: Array<{ filename: string; relativePath?: string; buffer: Uint8Array }> = [];

        let skippedCount = 0;

        for (const entry of entries) {
          if (entry.relativePath && shouldSkipRepoPath(entry.relativePath)) {
            skippedCount++;
            continue;
          }
          const buf = new Uint8Array(await entry.file.arrayBuffer());
          if (unpackZips && entry.file.name.toLowerCase().endsWith(".zip")) {
            const zip = await JSZip.loadAsync(buf);
            for (const [path, zf] of Object.entries(zip.files)) {
              if (zf.dir || shouldSkipRepoPath(path)) {
                if (!zf.dir) skippedCount++;
                continue;
              }
              const inner = await zf.async("uint8array");
              expanded.push({ filename: path.split("/").pop() ?? path, relativePath: path, buffer: inner });
            }
          } else {
            expanded.push({ filename: entry.file.name, relativePath: entry.relativePath, buffer: buf });
          }
        }

        const loaded: RotFileItem[] = [];
        for (const f of expanded) {
          const settings = createDefaultSettings();
          const { handler, result } = await runRot(f.filename, f.buffer, settings);
          loaded.push({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            filename: f.filename,
            relativePath: f.relativePath,
            originalBuffer: f.buffer,
            rottedBuffer: result.buffer,
            mimeType: guessMimeType(f.filename, handler.category),
            category: handler.category,
            handlerId: handler.id,
            handlerLabel: handler.label,
            fileSize: f.buffer.byteLength,
            settings,
            mutatedBytes: result.mutatedBytes,
            lastStrategy: result.strategy,
            lastSummary: result.summary,
            isProcessing: false,
          });
        }

        if (loaded.length > 0) {
          setItems((prev) => [...prev, ...loaded]);
          setSelectedId((prev) => prev ?? loaded[0].id);
          const skipNote = skippedCount > 0 ? ` (skipped ${skippedCount} build/vcs files)` : "";
          pushToast(`rotted ${loaded.length} file${loaded.length === 1 ? "" : "s"}${skipNote}`, "success");
        }
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "failed to load files", "error");
      } finally {
        setBusyLabel(null);
      }
    },
    [pushToast]
  );

  // recompute rotted output for a single file whenever its settings change
  const handleUpdateSettings = useCallback((id: string, patch: Partial<RotSettings>) => {
    setItems((prev) => {
      const target = prev.find((i) => i.id === id);
      if (!target) return prev;
      const nextSettings: RotSettings = { ...target.settings, ...patch };
      void runRot(target.filename, target.originalBuffer, nextSettings).then(({ result }) => {
        setItems((cur) =>
          cur.map((item) =>
            item.id === id
              ? {
                  ...item,
                  settings: nextSettings,
                  rottedBuffer: result.buffer,
                  mutatedBytes: result.mutatedBytes,
                  lastStrategy: result.strategy,
                  lastSummary: result.summary,
                  isProcessing: false,
                }
              : item
          )
        );
      });
      return prev.map((item) =>
        item.id === id ? { ...item, settings: nextSettings, isProcessing: true } : item
      );
    });
  }, []);

  const handleApplyToAll = useCallback(
    async (template: RotSettings) => {
      setBusyLabel("applying settings to all files...");
      try {
        const nextItems = await Promise.all(
          items.map(async (item) => {
            const nextSettings: RotSettings = { ...template, seed: item.settings.seed };
            const { result } = await runRot(item.filename, item.originalBuffer, nextSettings);
            return {
              ...item,
              settings: nextSettings,
              rottedBuffer: result.buffer,
              mutatedBytes: result.mutatedBytes,
              lastStrategy: result.strategy,
              lastSummary: result.summary,
            };
          })
        );
        setItems(nextItems);
        pushToast(`applied settings to ${nextItems.length} files`, "success");
      } finally {
        setBusyLabel(null);
      }
    },
    [items, pushToast]
  );

  const handleRerollAll = useCallback(async () => {
    setBusyLabel("rerolling all files...");
    try {
      const nextItems = await Promise.all(
        items.map(async (item) => {
          const nextSettings: RotSettings = { ...item.settings, seed: randomSeed() };
          const { result } = await runRot(item.filename, item.originalBuffer, nextSettings);
          return {
            ...item,
            settings: nextSettings,
            rottedBuffer: result.buffer,
            mutatedBytes: result.mutatedBytes,
            lastStrategy: result.strategy,
            lastSummary: result.summary,
          };
        })
      );
      setItems(nextItems);
      pushToast(`rerolled ${nextItems.length} files`, "info");
    } finally {
      setBusyLabel(null);
    }
  }, [items, pushToast]);

  const handleResetSelected = useCallback(() => {
    if (!selectedId) return;
    handleUpdateSettings(selectedId, createDefaultSettings());
    pushToast("reset settings", "info");
  }, [selectedId, handleUpdateSettings, pushToast]);

  const handleRemove = useCallback((id: string) => {
    setItems((prev) => {
      const remaining = prev.filter((i) => i.id !== id);
      setSelectedId((cur) => (cur === id ? (remaining[0]?.id ?? null) : cur));
      return remaining;
    });
  }, []);

  const handleDownloadOne = useCallback(
    (item: RotFileItem) => {
      const outName = rottedFilename(item.filename);
      downloadBytes(item.rottedBuffer, outName, item.mimeType);
      pushToast(`downloaded ${outName}`, "success");
    },
    [pushToast]
  );

  const handleDownloadAll = useCallback(async () => {
    setBusyLabel("packaging zip...");
    try {
      await exportAllAsZip(items);
      pushToast(`exported ${items.length} rotted files to webrot-export.zip`, "success");
    } finally {
      setBusyLabel(null);
    }
  }, [items, pushToast]);

  const handleClear = useCallback(() => {
    setItems([]);
    setSelectedId(null);
  }, []);

  // track dragenter/dragleave depth with a counter so child transitions do not flicker the overlay
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setIsDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      if (!e.dataTransfer) return;
      const entries = await collectFilesFromDataTransfer(e.dataTransfer);
      void ingestEntries(entries, false);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [ingestEntries]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (inInput) return;

      if (e.key === "?") {
        e.preventDefault();
        setFormatsOpen((v) => !v);
        return;
      }

      if (items.length === 0) return;

      if (e.key === "Escape" && !formatsOpen) {
        e.preventDefault();
        handleClear();
      } else if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey && selectedId) {
        e.preventDefault();
        handleUpdateSettings(selectedId, { seed: randomSeed() });
      } else if (e.key.toLowerCase() === "w" && !e.metaKey && !e.ctrlKey && selectedId) {
        e.preventDefault();
        const allModes = [
          "chaos", "smart", "glitch2d", "pixelsort", "rgbshift", "melt",
          "deepfry", "shuffle", "stutter", "invert", "crush", "byteflip",
        ] as const;
        handleUpdateSettings(selectedId, {
          mode: allModes[Math.floor(Math.random() * allModes.length)],
          intensity: Math.floor(Math.random() * 72) + 18,
          seed: randomSeed(),
        });
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey && selectedId) {
        const cur = items.find((i) => i.id === selectedId);
        if (cur) {
          e.preventDefault();
          handleDownloadOne(cur);
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = items.findIndex((i) => i.id === selectedId);
        const next = e.key === "ArrowDown"
          ? (idx + 1 + items.length) % items.length
          : (idx - 1 + items.length) % items.length;
        setSelectedId(items[next].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, selectedId, formatsOpen, handleClear, handleUpdateSettings, handleDownloadOne]);

  const isEditing = items.length > 0;

  return (
    <div className={`wt-app ${isEditing ? "is-editing" : ""}`}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []).map((file) => ({ file }));
          void ingestEntries(list, false);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error non-standard directory picker attribute supported by browsers
        webkitdirectory=""
        directory=""
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []).map((file) => ({
            file,
            relativePath: file.webkitRelativePath || file.name,
          }));
          void ingestEntries(list, false);
          e.target.value = "";
        }}
      />
      <input
        ref={zipInputRef}
        type="file"
        multiple
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []).map((file) => ({ file }));
          void ingestEntries(list, true);
          e.target.value = "";
        }}
      />

      {!isEditing ? (
        <div className="wt-corner-tools" aria-label="page controls">
          <button
            type="button"
            className="wt-corner-btn"
            onClick={() => setFormatsOpen(true)}
            aria-label="supported formats and shortcuts"
          >
            <Icon name="menu_book" size={16} className="wt-c-accent" />
            <span>formats</span>
          </button>
          <button
            type="button"
            className="wt-corner-btn wt-corner-btn--icon"
            onClick={toggleTheme}
            title={nightMode ? "switch to day theme" : "switch to night theme"}
            aria-label={nightMode ? "switch to day theme" : "switch to night theme"}
          >
            <Icon
              name={nightMode ? "light_mode" : "dark_mode"}
              size={17}
              className={nightMode ? "wt-c-amber" : "wt-c-violet"}
            />
          </button>
        </div>
      ) : (
        <header className="wt-topbar">
          <div className="wt-topbar-inner">
            <div className="wt-topbar-left">
              <button
                type="button"
                className="wt-topbar-brand"
                onClick={handleClear}
                aria-label="webrot — return to start"
              >
                <WebrotLogo compact />
              </button>
              <span className="wt-topbar-stat">
                {items.length} file{items.length === 1 ? "" : "s"}
              </span>
            </div>
            <nav className="wt-topbar-right" aria-label="workspace toolbar">
              <button type="button" className="wt-top-btn" onClick={() => fileInputRef.current?.click()}>
                <Icon name="add" size={16} className="wt-c-accent" />
                <span>add files</span>
              </button>
              <button type="button" className="wt-top-btn" onClick={() => setFormatsOpen(true)}>
                <Icon name="menu_book" size={16} className="wt-c-amber" />
                <span>ref</span>
              </button>
              <button
                type="button"
                className="wt-top-btn wt-top-btn--icon"
                onClick={toggleTheme}
                title={nightMode ? "switch to day theme" : "switch to night theme"}
                aria-label={nightMode ? "switch to day theme" : "switch to night theme"}
              >
                <Icon
                  name={nightMode ? "light_mode" : "dark_mode"}
                  size={16}
                  className={nightMode ? "wt-c-amber" : "wt-c-violet"}
                />
              </button>
            </nav>
          </div>
        </header>
      )}

      <main id="main-content" className="wt-stage">
        {!isEditing ? (
          <div className="wt-home-shell">
            <div className="wt-brand-header">
              <h1 className="wt-hero-h1">
                <WebrotLogo interactive />
              </h1>
              <p className="wt-tagline">
                <span>corrupt, databend, and glitch any file or codebase</span>
                <span className="wt-hint-dot" aria-hidden="true">·</span>
                <button type="button" className="wt-inline-link" onClick={() => setFormatsOpen(true)}>
                  header-safe for 35+ formats
                </button>
              </p>
            </div>

            {busyLabel && (
              <div className="wt-progress-card" role="status" aria-live="polite">
                <div className="wt-progress-meta">
                  <strong style={{ color: "var(--text-focus)" }}>{busyLabel}</strong>
                </div>
                <div className="tw-progress-bar is-indeterminate" />
              </div>
            )}

            <DropZone
              onPickFiles={() => fileInputRef.current?.click()}
              onPickFolder={() => folderInputRef.current?.click()}
              onPickZip={() => zipInputRef.current?.click()}
            />
          </div>
        ) : (
          <div className="wt-workspace-shell">
            {busyLabel && (
              <div className="wt-progress-card" role="status" aria-live="polite">
                <div className="wt-progress-meta">
                  <strong style={{ color: "var(--text-focus)" }}>{busyLabel}</strong>
                </div>
                <div className="tw-progress-bar is-indeterminate" />
              </div>
            )}

            <RotWorkspace
              items={items}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onUpdateSettings={handleUpdateSettings}
              onApplyToAll={(s) => void handleApplyToAll(s)}
              onRerollAll={() => void handleRerollAll()}
              onResetSelected={handleResetSelected}
              onRemove={handleRemove}
              onDownloadOne={handleDownloadOne}
              onDownloadAll={() => void handleDownloadAll()}
              onPickFiles={() => fileInputRef.current?.click()}
              onPickFolder={() => folderInputRef.current?.click()}
              onPickZip={() => zipInputRef.current?.click()}
              onBack={handleClear}
            />
          </div>
        )}
      </main>

      <footer className="wt-minimal-footer">
        <span>
          by{" "}
          <a href="https://github.com/ocld" target="_blank" rel="noopener noreferrer">
            ocld
          </a>
        </span>
        <span className="wt-hint-dot" aria-hidden="true">|</span>
        <a href="https://github.com/ocld/webrot" target="_blank" rel="noopener noreferrer">
          source code
        </a>
        <span className="wt-hint-dot" aria-hidden="true">|</span>
        <button type="button" className="wt-inline-link" onClick={() => setFormatsOpen(true)}>
          reference
        </button>
      </footer>

      <FullWindowDragOverlay active={isDragging} />

      <FormatsModal open={formatsOpen} onClose={() => setFormatsOpen(false)} />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
