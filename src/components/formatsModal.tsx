import { useState } from "react";
import { Badge, Icon, Modal, Tabs } from "@/design";
import { FORMAT_HANDLERS } from "@/lib/formatRots";
import type { RotCategory } from "@/lib/types";

interface FormatsModalProps {
  open: boolean;
  onClose: () => void;
}

const CATEGORY_ORDER: Array<{ id: RotCategory; title: string }> = [
  { id: "code", title: "codebases & configs" },
  { id: "image", title: "images & pro graphics" },
  { id: "audio", title: "audio & music" },
  { id: "daw", title: "daws, synths & midi" },
  { id: "video", title: "video" },
  { id: "model3d", title: "3d models & g-code" },
  { id: "font", title: "fonts" },
  { id: "rom", title: "game roms & saves" },
  { id: "document", title: "documents, subtitles & csv" },
  { id: "text", title: "plain text & markdown" },
  { id: "binary", title: "sqlite, wasm & any binary" },
];

const SHORTCUTS: Array<[string, string]> = [
  ["r", "reroll random seed"],
  ["w", "wild full random (mode + intensity + seed)"],
  ["↑ / ↓", "switch selected file"],
  ["d", "download selected rotted file"],
  ["?", "open reference"],
  ["esc", "back to home"],
];

export function FormatsModal({ open, onClose }: FormatsModalProps) {
  const [tab, setTab] = useState<"formats" | "shortcuts">("formats");

  const groups = CATEGORY_ORDER.map((cat) => ({
    ...cat,
    items: FORMAT_HANDLERS.filter((h) => h.category === cat.id),
  })).filter((g) => g.items.length > 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <>
          <Icon name="menu_book" size={19} style={{ color: "var(--primary-hex)" }} />
          reference
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "formats", label: `formats (${FORMAT_HANDLERS.length})` },
            { id: "shortcuts", label: "shortcuts" },
          ]}
        />

        {tab === "formats" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {groups.map((g) => (
              <div key={g.id} className="wt-group-card" style={{ marginBottom: 0 }}>
                <h3 className="wt-group-title">{g.title}</h3>
                <table className="wt-preview-table" style={{ marginTop: 2 }}>
                  <tbody>
                    {g.items.map((h) => (
                      <tr key={h.id}>
                        <td style={{ width: "36%", fontWeight: 700, color: "var(--text-focus)" }}>
                          {h.label}
                        </td>
                        <td style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                          {h.notes}
                        </td>
                        <td style={{ width: "26%", textAlign: "right" }}>
                          <Badge tone="blue">{h.strategy}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {tab === "shortcuts" && (
          <div className="wt-group-card" style={{ marginBottom: 0 }}>
            <table className="wt-preview-table" style={{ marginTop: 0 }}>
              <tbody>
                {SHORTCUTS.map(([keys, desc]) => (
                  <tr key={keys}>
                    <td style={{ width: 110 }}>
                      <kbd className="tw-kbd">{keys}</kbd>
                    </td>
                    <td style={{ color: "var(--text-focus)", fontWeight: 500 }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
