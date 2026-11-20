import { Icon } from "@/design";

interface DropZoneProps {
  onPickFiles: () => void;
  onPickFolder: () => void;
  onPickZip: () => void;
}

export function DropZone({
  onPickFiles,
  onPickFolder,
  onPickZip,
}: DropZoneProps) {
  return (
    <div className="wt-home-actions">
      <div
        className="wt-drop-card wt-clickable"
        role="button"
        tabIndex={0}
        onClick={onPickFiles}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPickFiles();
          }
        }}
        aria-label="drop or browse any file or codebase to corrupt"
      >
        <div className="wt-drop-icon" aria-hidden="true">
          <Icon name="upload_file" size={24} />
        </div>

        <div className="wt-drop-copy">
          <div className="wt-drop-title">drop any file or folder here, or click to browse</div>
          <div className="wt-drop-sub">
            codebases · photos · audio · .flp · .mid · fonts · roms · 3d
          </div>
        </div>

        <button
          type="button"
          className="tw-btn tw-btn--primary"
          onClick={(e) => {
            e.stopPropagation();
            onPickFiles();
          }}
        >
          <Icon name="folder_open" size={17} />
          browse
        </button>
      </div>

      <div className="wt-tools-row" aria-label="quick actions">
        <button type="button" className="wt-tool-pill wt-tool-pill--blue" onClick={onPickFolder}>
          <Icon name="folder_code" size={18} />
          <span>open folder / codebase</span>
        </button>

        <button type="button" className="wt-tool-pill wt-tool-pill--amber" onClick={onPickZip}>
          <Icon name="folder_zip" size={18} />
          <span>unpack .zip</span>
        </button>
      </div>
    </div>
  );
}

export function FullWindowDragOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="wt-drag-overlay" aria-hidden="true">
      <div className="wt-drag-overlay-box">
        <div className="wt-drop-icon wt-drop-icon--lg">
          <Icon name="upload_file" size={30} />
        </div>
        <div className="wt-drag-overlay-title">drop to corrupt &amp; databend</div>
        <div className="wt-drag-overlay-sub">
          codebases · photos · audio · fl studio · midi · fonts · roms · 3d · video · anything
        </div>
      </div>
    </div>
  );
}
