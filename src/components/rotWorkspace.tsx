import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Icon } from "@/design";
import { randomSeed } from "@/lib/prng";
import type { RotFileItem, RotMode, RotSettings } from "@/lib/types";

interface RotWorkspaceProps {
  items: RotFileItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpdateSettings: (id: string, patch: Partial<RotSettings>) => void;
  onApplyToAll: (settings: RotSettings) => void;
  onRerollAll: () => void;
  onResetSelected: () => void;
  onRemove: (id: string) => void;
  onDownloadOne: (item: RotFileItem) => void;
  onDownloadAll: () => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onPickZip: () => void;
  onBack: () => void;
}

const MODES: Array<{ id: RotMode; label: string; icon: string }> = [
  { id: "chaos", label: "chaos", icon: "cyclone" },
  { id: "smart", label: "smart", icon: "auto_awesome" },
  { id: "glitch2d", label: "block tear", icon: "broken_image" },
  { id: "pixelsort", label: "pixel sort", icon: "waterfall_chart" },
  { id: "rgbshift", label: "rgb split", icon: "palette" },
  { id: "melt", label: "melt", icon: "waves" },
  { id: "deepfry", label: "deepfry", icon: "local_fire_department" },
  { id: "shuffle", label: "tile swap", icon: "grid_view" },
  { id: "stutter", label: "stutter", icon: "repeat" },
  { id: "invert", label: "invert xor", icon: "invert_colors" },
  { id: "crush", label: "crush", icon: "grain" },
  { id: "byteflip", label: "byte flip", icon: "bolt" },
];

function randomFullRot(): Partial<RotSettings> {
  const mode = MODES[Math.floor(Math.random() * MODES.length)].id;
  const intensity = Math.floor(Math.random() * 72) + 18;
  return { mode, intensity, seed: randomSeed() };
}

const INTENSITY_PRESETS: Array<{ label: string; value: number }> = [
  { label: "subtle", value: 10 },
  { label: "cursed", value: 30 },
  { label: "fried", value: 65 },
  { label: "nuclear", value: 95 },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kb`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} mb`;
}

function categoryIcon(cat: RotFileItem["category"]): { name: string; color: string } {
  switch (cat) {
    case "code":
      return { name: "code", color: "var(--accent-blue)" };
    case "image":
      return { name: "image", color: "var(--accent-pink)" };
    case "audio":
      return { name: "graphic_eq", color: "var(--accent-green)" };
    case "daw":
      return { name: "piano", color: "var(--accent-violet)" };
    case "video":
      return { name: "movie", color: "var(--accent-blue)" };
    case "model3d":
      return { name: "view_in_ar", color: "var(--accent-cyan)" };
    case "font":
      return { name: "font_download", color: "var(--accent-pink)" };
    case "rom":
      return { name: "sports_esports", color: "var(--accent-green)" };
    case "document":
      return { name: "description", color: "var(--accent-amber)" };
    case "text":
      return { name: "article", color: "var(--accent-blue)" };
    default:
      return { name: "memory", color: "var(--text-muted)" };
  }
}

// builds a small hex diff preview highlighting mutated bytes between original and rotted buffers
function buildHexPreview(orig: Uint8Array, rotted: Uint8Array): Array<{ offset: string; cells: Array<{ hex: string; changed: boolean }> }> {
  const rows: Array<{ offset: string; cells: Array<{ hex: string; changed: boolean }> }> = [];
  // jump to the first changed byte so the preview immediately shows active corruption
  let firstDiff = 0;
  const maxScan = Math.min(orig.length, rotted.length, 65536);
  for (let i = 0; i < maxScan; i++) {
    if (orig[i] !== rotted[i]) {
      firstDiff = Math.max(0, (i & ~15) - 16);
      break;
    }
  }

  for (let r = 0; r < 6; r++) {
    const base = firstDiff + r * 16;
    if (base >= rotted.length) break;
    const cells: Array<{ hex: string; changed: boolean }> = [];
    for (let c = 0; c < 16; c++) {
      const idx = base + c;
      if (idx >= rotted.length) break;
      const b = rotted[idx];
      cells.push({
        hex: b.toString(16).padStart(2, "0"),
        changed: idx >= orig.length || orig[idx] !== b,
      });
    }
    rows.push({ offset: base.toString(16).padStart(6, "0"), cells });
  }
  return rows;
}

export function RotWorkspace({
  items,
  selectedId,
  onSelect,
  onUpdateSettings,
  onApplyToAll,
  onRerollAll,
  onResetSelected,
  onRemove,
  onDownloadOne,
  onDownloadAll,
  onPickFiles,
  onPickFolder,
  onPickZip,
  onBack,
}: RotWorkspaceProps) {
  const [previewMode, setPreviewMode] = useState<"rotted" | "original">("rotted");
  const [imgBroken, setImgBroken] = useState(false);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  );

  // create object urls for live image/audio/video preview and revoke cleanly on change
  const previewUrls = useMemo(() => {
    if (!selected) return { orig: null as string | null, rot: null as string | null };
    if (selected.category !== "image" && selected.category !== "audio" && selected.category !== "video") {
      return { orig: null, rot: null };
    }
    const copyA = new Uint8Array(selected.originalBuffer.byteLength);
    copyA.set(selected.originalBuffer);
    const copyB = new Uint8Array(selected.rottedBuffer.byteLength);
    copyB.set(selected.rottedBuffer);
    return {
      orig: URL.createObjectURL(new Blob([copyA], { type: selected.mimeType })),
      rot: URL.createObjectURL(new Blob([copyB], { type: selected.mimeType })),
    };
  }, [selected?.id, selected?.rottedBuffer, selected?.originalBuffer, selected?.mimeType, selected?.category]);

  useEffect(() => {
    setImgBroken(false);
    return () => {
      if (previewUrls.orig) URL.revokeObjectURL(previewUrls.orig);
      if (previewUrls.rot) URL.revokeObjectURL(previewUrls.rot);
    };
  }, [previewUrls]);

  const textSnippet = useMemo(() => {
    if (!selected) return null;
    const isTextLike =
      selected.category === "text" ||
      selected.category === "code" ||
      selected.handlerId === "svg" ||
      selected.handlerId === "subtitles" ||
      selected.handlerId === "csv" ||
      selected.handlerId === "gcode" ||
      selected.handlerId === "reaper" ||
      selected.filename.toLowerCase().endsWith(".obj") ||
      selected.filename.toLowerCase().endsWith(".vital");
    if (!isTextLike) return null;
    const target = previewMode === "rotted" ? selected.rottedBuffer : selected.originalBuffer;
    return new TextDecoder().decode(target.subarray(0, 2200));
  }, [selected, previewMode]);

  const hexRows = useMemo(() => {
    if (!selected) return [];
    if (selected.category === "image" || selected.category === "audio" || selected.category === "text" || selected.category === "code") return [];
    return buildHexPreview(selected.originalBuffer, selected.rottedBuffer);
  }, [selected]);

  if (!selected) return null;

  const pct = selected.fileSize > 0
    ? Math.min(100, (selected.mutatedBytes / selected.fileSize) * 100)
    : 0;
  const activeUrl = previewMode === "rotted" ? previewUrls.rot : previewUrls.orig;

  return (
    <div className="wt-editor">
      <div className="wt-editor-grid">
        {/* left column: live preview + file list */}
        <div className="wt-editor-left">
          <section className="wt-panel" aria-label="live preview">
            <div className="wt-panel-head">
              <h2 className="wt-panel-title">
                <Icon
                  name={categoryIcon(selected.category).name}
                  size={18}
                  style={{ color: categoryIcon(selected.category).color }}
                />
                <span className="wt-truncate">{selected.filename}</span>
              </h2>
              <div className="wt-segmented" role="tablist" aria-label="preview source">
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewMode === "rotted"}
                  className={`wt-seg-btn ${previewMode === "rotted" ? "is-active" : ""}`}
                  onClick={() => setPreviewMode("rotted")}
                >
                  rotted
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewMode === "original"}
                  className={`wt-seg-btn ${previewMode === "original" ? "is-active" : ""}`}
                  onClick={() => setPreviewMode("original")}
                >
                  original
                </button>
              </div>
            </div>

            <div className="wt-panel-body">
              {selected.category === "image" && activeUrl && (
                <div className="wt-preview-stage">
                  {imgBroken && previewMode === "rotted" ? (
                    <div className="wt-preview-broken">
                      <Icon name="broken_image" size={32} style={{ color: "var(--accent-pink)" }} />
                      <div>too corrupted to decode this roll</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button
                          size="sm"
                          onClick={() => onUpdateSettings(selected.id, { seed: randomSeed() })}
                        >
                          <Icon name="casino" size={15} />
                          reroll
                        </Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            onUpdateSettings(selected.id, {
                              intensity: Math.max(5, Math.round(selected.settings.intensity * 0.5)),
                              seed: randomSeed(),
                            })
                          }
                        >
                          lower intensity
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <img
                      key={`${selected.id}-${previewMode}-${selected.settings.seed}-${selected.mutatedBytes}`}
                      src={activeUrl}
                      alt={`${previewMode} preview of ${selected.filename}`}
                      className="wt-preview-img"
                      onError={() => {
                        if (previewMode === "rotted") setImgBroken(true);
                      }}
                    />
                  )}
                </div>
              )}

              {selected.category === "audio" && activeUrl && (
                <div className="wt-audio-stage">
                  <div className="wt-audio-badge">
                    <Icon name="graphic_eq" size={22} style={{ color: "var(--primary-hex)" }} />
                    <span>{previewMode === "rotted" ? "playing rotted audio" : "playing original audio"}</span>
                  </div>
                  <audio
                    key={`${selected.id}-${previewMode}-${selected.settings.seed}-${selected.mutatedBytes}`}
                    controls
                    src={activeUrl}
                    className="wt-audio-player"
                  />
                </div>
              )}

              {selected.category === "video" && activeUrl && (
                <div className="wt-preview-stage">
                  <video
                    key={`${selected.id}-${previewMode}-${selected.settings.seed}-${selected.mutatedBytes}`}
                    controls
                    src={activeUrl}
                    className="wt-preview-img"
                  />
                </div>
              )}

              {textSnippet !== null && selected.category !== "image" && (
                <pre className="wt-text-preview">{textSnippet}</pre>
              )}

              {hexRows.length > 0 && textSnippet === null && (
                <div className="wt-hex-preview" aria-label="hex diff preview">
                  <div className="wt-hex-caption">
                    <span>hex diff preview</span>
                    <span>highlighted = mutated bytes</span>
                  </div>
                  {hexRows.map((row) => (
                    <div key={row.offset} className="wt-hex-row">
                      <span className="wt-hex-off">{row.offset}</span>
                      <span className="wt-hex-bytes">
                        {row.cells.map((cell, idx) => (
                          <span key={idx} className={cell.changed ? "is-mut" : ""}>
                            {cell.hex}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="wt-rot-meta-line">
                <Badge tone="blue">{selected.lastStrategy}</Badge>
                <span className="wt-rot-summary">{selected.lastSummary}</span>
              </div>
            </div>
          </section>

          <div className="wt-panel">
            <div className="wt-panel-head">
              <h3 className="wt-panel-title">
                <Icon name="folder_open" size={17} style={{ color: "var(--primary-hex)" }} />
                files ({items.length})
              </h3>
              <div className="wt-tracks-head-right">
                <button type="button" className="wt-micro-link" onClick={onPickFiles}>+files</button>
                <button type="button" className="wt-micro-link" onClick={onPickFolder}>+folder</button>
                <button type="button" className="wt-micro-link" onClick={onPickZip}>+.zip</button>
              </div>
            </div>

            <div className="wt-panel-body">
              <div className="wt-file-list" role="listbox" aria-label="loaded files">
                {items.map((item) => {
                  const isSel = item.id === selected.id;
                  const ico = categoryIcon(item.category);
                  return (
                    <div
                      key={item.id}
                      role="option"
                      tabIndex={0}
                      aria-selected={isSel}
                      className={`wt-file-row ${isSel ? "is-selected" : ""}`}
                      onClick={() => onSelect(item.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(item.id);
                        }
                      }}
                    >
                      <span className="wt-row-status">
                        <Icon name={ico.name} size={16} style={{ color: ico.color }} />
                      </span>
                      <span className="wt-row-main" title={item.relativePath ?? item.filename}>
                        {item.relativePath ?? item.filename}
                      </span>
                      <span className="wt-row-meta">
                        {formatBytes(item.fileSize)}
                      </span>
                      <span className="wt-row-quick" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="wt-micro-icon"
                          onClick={() => onDownloadOne(item)}
                          title={`download rotted ${item.filename}`}
                          aria-label={`download rotted ${item.filename}`}
                        >
                          <Icon name="download" size={16} />
                        </button>
                        <button
                          type="button"
                          className="wt-micro-icon"
                          onClick={() => onRemove(item.id)}
                          title={`remove ${item.filename}`}
                          aria-label={`remove ${item.filename}`}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* right column: rot controls */}
        <section className="wt-panel" aria-label="corruption controls">
          <div className="wt-panel-head">
            <h3 className="wt-panel-title">
              <Icon name="tune" size={18} style={{ color: "var(--primary-hex)" }} />
              rot controls
            </h3>
            <Badge tone="blue">{selected.handlerLabel}</Badge>
          </div>

          <div className="wt-panel-body wt-controls-stack">
            <div className="wt-ctrl-block">
              <div className="wt-ctrl-label">corruption mode</div>
              <div className="wt-mode-grid">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`wt-mode-btn ${selected.settings.mode === m.id ? "is-active" : ""}`}
                    onClick={() => onUpdateSettings(selected.id, { mode: m.id })}
                  >
                    <Icon name={m.icon} size={17} />
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="wt-ctrl-block">
              <div className="wt-ctrl-row">
                <label className="wt-ctrl-label" htmlFor="wt-intensity">
                  chaos / intensity
                </label>
                <span className="wt-ctrl-val">{selected.settings.intensity}%</span>
              </div>
              <input
                id="wt-intensity"
                type="range"
                min={1}
                max={100}
                value={selected.settings.intensity}
                className="wt-slider"
                onChange={(e) => onUpdateSettings(selected.id, { intensity: Number(e.target.value) })}
              />
              <div className="wt-chip-row">
                {INTENSITY_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`wt-chip ${selected.settings.intensity === p.value ? "is-active" : ""}`}
                    onClick={() => onUpdateSettings(selected.id, { intensity: p.value })}
                  >
                    {p.label} ({p.value}%)
                  </button>
                ))}
              </div>
            </div>

            <div className="wt-ctrl-block">
              <div className="wt-ctrl-row">
                <label className="wt-ctrl-label" htmlFor="wt-seed">
                  seed
                </label>
                <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
                  same seed = identical rot
                </span>
              </div>
              <div className="wt-seed-row">
                <input
                  id="wt-seed"
                  type="number"
                  className="tw-input tw-input--mono"
                  value={selected.settings.seed}
                  onChange={(e) => onUpdateSettings(selected.id, { seed: Number(e.target.value) || 1 })}
                />
                <Button
                  variant="primary"
                  onClick={() => onUpdateSettings(selected.id, { seed: randomSeed() })}
                >
                  <Icon name="casino" size={17} />
                  reroll
                </Button>
                <Button
                  onClick={() => onUpdateSettings(selected.id, randomFullRot())}
                  title="randomize mode, intensity, and seed"
                >
                  <Icon name="shuffle" size={17} style={{ color: "var(--accent-pink)" }} />
                  wild
                </Button>
              </div>
            </div>

            <div className="wt-ctrl-block">
              <label className="wt-guard-toggle">
                <input
                  type="checkbox"
                  className="tw-checkbox"
                  checked={selected.settings.preserveHeader}
                  onChange={(e) => onUpdateSettings(selected.id, { preserveHeader: e.target.checked })}
                />
                <div>
                  <div className="wt-guard-title">header guard (keep file openable)</div>
                  <div className="wt-guard-sub">
                    skips file headers &amp; structure markers — turn off for total nuke corruption
                  </div>
                </div>
              </label>

              {selected.handlerId === "binary" && selected.settings.preserveHeader && (
                <div style={{ marginTop: 8 }}>
                  <div className="wt-ctrl-row">
                    <label className="wt-ctrl-label" htmlFor="wt-skip">
                      protected header bytes
                    </label>
                    <span className="wt-ctrl-val">{selected.settings.headerSkipBytes} b</span>
                  </div>
                  <input
                    id="wt-skip"
                    type="range"
                    min={0}
                    max={4096}
                    step={32}
                    value={selected.settings.headerSkipBytes}
                    className="wt-slider"
                    onChange={(e) => onUpdateSettings(selected.id, { headerSkipBytes: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>

            <div className="wt-stats-grid">
              <div className="wt-stat-box">
                <span className="wt-stat-k">file size</span>
                <span className="wt-stat-v">{formatBytes(selected.fileSize)}</span>
              </div>
              <div className="wt-stat-box">
                <span className="wt-stat-k">mutated</span>
                <span className="wt-stat-v">{selected.mutatedBytes.toLocaleString()} b</span>
              </div>
              <div className="wt-stat-box">
                <span className="wt-stat-k">rot ratio</span>
                <span className="wt-stat-v">{pct < 0.01 && selected.mutatedBytes > 0 ? "<0.01%" : `${pct.toFixed(2)}%`}</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <nav className="wt-action-bar" aria-label="rot actions">
        <div className="wt-action-group">
          <Button size="sm" onClick={() => onUpdateSettings(selected.id, { seed: randomSeed() })}>
            <Icon name="casino" size={16} style={{ color: "var(--primary-hex)" }} />
            reroll
          </Button>
          <Button size="sm" onClick={() => onUpdateSettings(selected.id, randomFullRot())}>
            <Icon name="cyclone" size={16} style={{ color: "var(--accent-pink)" }} />
            full random
          </Button>
          {items.length > 1 && (
            <>
              <Button size="sm" onClick={() => onApplyToAll(selected.settings)}>
                <Icon name="done_all" size={16} style={{ color: "var(--accent-green)" }} />
                apply settings to all ({items.length})
              </Button>
              <Button size="sm" onClick={onRerollAll}>
                <Icon name="shuffle" size={16} style={{ color: "var(--accent-pink)" }} />
                reroll all
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={onResetSelected}>
            <Icon name="restart_alt" size={16} />
            reset
          </Button>
        </div>

        <div className="wt-action-group">
          <Button
            size="sm"
            variant="primary"
            onClick={() => (items.length === 1 ? onDownloadOne(selected) : onDownloadAll())}
          >
            <Icon name="download" size={16} />
            {items.length === 1 ? "download rotted" : `export .zip (${items.length})`}
          </Button>
          <Button size="sm" variant="ghost" onClick={onBack}>
            <Icon name="arrow_back" size={16} />
            close
          </Button>
        </div>
      </nav>
    </div>
  );
}
