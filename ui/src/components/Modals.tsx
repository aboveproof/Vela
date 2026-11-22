import { useEffect, useState } from "react";
import type { HostKeyPrompt, RemoteEntry, ThemeTokens } from "../types";

export type ActiveModal =
  | { kind: "new_folder" }
  | { kind: "new_file" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "chmod"; entry: RemoteEntry }
  | { kind: "delete_confirm"; entry: RemoteEntry };

interface ModalsProps {
  modal: ActiveModal | null;
  hostKeyPrompt: HostKeyPrompt | null;
  theme: ThemeTokens;
  onCloseModal: () => void;
  onSubmitNewFolder: (name: string) => void;
  onSubmitNewFile: (name: string) => void;
  onSubmitRename: (entry: RemoteEntry, newName: string) => void;
  onSubmitChmod: (entry: RemoteEntry, mode: number) => void;
  onConfirmDelete: (entry: RemoteEntry) => void;
  onRespondHostKey: (promptId: string, accepted: boolean) => void;
}

export function Modals({
  modal,
  hostKeyPrompt,
  theme,
  onCloseModal,
  onSubmitNewFolder,
  onSubmitNewFile,
  onSubmitRename,
  onSubmitChmod,
  onConfirmDelete,
  onRespondHostKey,
}: ModalsProps) {
  useEffect(() => {
    if (!modal && !hostKeyPrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (hostKeyPrompt) {
          onRespondHostKey(hostKeyPrompt.prompt_id, false);
        } else if (modal) {
          onCloseModal();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, hostKeyPrompt, onCloseModal, onRespondHostKey]);

  if (hostKeyPrompt) {
    const isMismatch = hostKeyPrompt.status.kind === "mismatch";
    const borderColor = isMismatch ? theme.danger : theme.warning;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
        <div
          className="w-full max-w-md rounded-xl border p-5 shadow-2xl"
          style={{ backgroundColor: theme.bgSurface, borderColor }}
        >
          <h3 className="text-sm font-semibold" style={{ color: borderColor }}>
            {isMismatch
              ? `WARNING: Host key changed for ${hostKeyPrompt.host}:${hostKeyPrompt.port}`
              : `Trust host ${hostKeyPrompt.host}:${hostKeyPrompt.port}?`}
          </h3>
          {isMismatch && (
            <p className="mt-2 text-xs leading-relaxed" style={{ color: theme.danger }}>
              Someone could be intercepting this connection (MITM attack), or the server was
              reinstalled. Only replace the stored key if you expect this change.
            </p>
          )}
          <div
            className="mt-3 whitespace-pre-wrap break-all rounded-lg border p-3 font-mono text-[11px]"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textPrimary,
            }}
          >
            {hostKeyPrompt.status.kind === "unknown"
              ? `First connection to this server.\nSHA-256 fingerprint:\n${hostKeyPrompt.status.fingerprint}`
              : hostKeyPrompt.status.kind === "mismatch"
                ? `Expected:\n${hostKeyPrompt.status.expected}\n\nReceived:\n${hostKeyPrompt.status.actual}`
                : ""}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            {isMismatch ? (
              <>
                <button
                  onClick={() => onRespondHostKey(hostKeyPrompt.prompt_id, true)}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
                  style={{ borderColor: theme.danger, color: theme.danger }}
                >
                  Replace Key Anyway
                </button>
                <button
                  autoFocus
                  onClick={() => onRespondHostKey(hostKeyPrompt.prompt_id, false)}
                  className="rounded-lg px-3.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
                  style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
                >
                  Reject Connection
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => onRespondHostKey(hostKeyPrompt.prompt_id, false)}
                  className="rounded-lg border px-3.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
                  style={{ borderColor: theme.border, color: theme.danger }}
                >
                  Reject
                </button>
                <button
                  autoFocus
                  onClick={() => onRespondHostKey(hostKeyPrompt.prompt_id, true)}
                  className="rounded-lg px-3.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
                  style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
                >
                  Trust & Continue
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!modal) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onCloseModal}
    >
      <div
        className="w-full max-w-sm rounded-xl border p-5 shadow-2xl"
        style={{ backgroundColor: theme.bgSurface, borderColor: theme.border }}
        onClick={(e) => e.stopPropagation()}
      >
        {modal.kind === "new_folder" && (
          <TextModalBody
            key="new_folder"
            title="New Directory"
            placeholder="Directory name"
            initial=""
            theme={theme}
            onCancel={onCloseModal}
            onSubmit={onSubmitNewFolder}
          />
        )}
        {modal.kind === "new_file" && (
          <TextModalBody
            key="new_file"
            title="New Empty File"
            placeholder="File name (e.g. compose.yml)"
            initial=""
            theme={theme}
            onCancel={onCloseModal}
            onSubmit={onSubmitNewFile}
          />
        )}
        {modal.kind === "rename" && (
          <TextModalBody
            key={`rename:${modal.entry.path}`}
            title={`Rename ${modal.entry.name}`}
            placeholder="New name"
            initial={modal.entry.name}
            theme={theme}
            onCancel={onCloseModal}
            onSubmit={(val) => onSubmitRename(modal.entry, val)}
          />
        )}
        {modal.kind === "chmod" && (
          <ChmodModalBody
            key={`chmod:${modal.entry.path}`}
            entry={modal.entry}
            theme={theme}
            onCancel={onCloseModal}
            onSubmit={(mode) => onSubmitChmod(modal.entry, mode)}
          />
        )}
        {modal.kind === "delete_confirm" && (
          <div>
            <h3 className="text-sm font-medium" style={{ color: theme.danger }}>
              Delete {modal.entry.kind === "directory" ? "directory" : "file"}?
            </h3>
            <p className="mt-2 break-all text-xs" style={{ color: theme.textMuted }}>
              {modal.entry.kind === "directory"
                ? `This will permanently delete "${modal.entry.path}" and all files inside it.`
                : `This will permanently delete "${modal.entry.path}".`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCloseModal}
                className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                style={{ borderColor: theme.border, color: theme.textMuted }}
              >
                Cancel
              </button>
              <button
                autoFocus
                type="button"
                onClick={() => onConfirmDelete(modal.entry)}
                className="rounded-lg px-3.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
                style={{ backgroundColor: theme.danger, color: "#ffffff" }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TextModalBody({
  title,
  placeholder,
  initial,
  theme,
  onCancel,
  onSubmit,
}: {
  title: string;
  placeholder: string;
  initial: string;
  theme: ThemeTokens;
  onCancel: () => void;
  onSubmit: (val: string) => void;
}) {
  const [val, setVal] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (val.trim()) onSubmit(val.trim());
      }}
    >
      <h3 className="truncate text-sm font-medium" style={{ color: theme.textPrimary }}>
        {title}
      </h3>
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={placeholder}
        className="mt-3 w-full rounded-lg border px-3 py-2 text-xs outline-none"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
          color: theme.textPrimary,
        }}
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
          style={{ borderColor: theme.border, color: theme.textMuted }}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-lg px-3.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
          style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function ChmodModalBody({
  entry,
  theme,
  onCancel,
  onSubmit,
}: {
  entry: RemoteEntry;
  theme: ThemeTokens;
  onCancel: () => void;
  onSubmit: (mode: number) => void;
}) {
  const initialMode = entry.permissions & 0o7777;
  const [mode, setMode] = useState(initialMode);
  const [octal, setOctal] = useState(initialMode.toString(8).padStart(4, "0"));

  const toggle = (bit: number) => {
    const next = mode ^ bit;
    setMode(next);
    setOctal(next.toString(8).padStart(4, "0"));
  };

  const rows: [string, number][] = [
    ["Owner", 6],
    ["Group", 3],
    ["Other", 0],
  ];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(mode & 0o7777);
      }}
    >
      <h3 className="truncate text-sm font-medium" style={{ color: theme.textPrimary }}>
        Permissions: {entry.name}
      </h3>
      <div className="mt-3 space-y-2.5 text-xs">
        {rows.map(([label, shift]) => (
          <div key={label} className="flex items-center justify-between">
            <span className="w-16" style={{ color: theme.textMuted }}>
              {label}
            </span>
            {[
              ["Read", 4],
              ["Write", 2],
              ["Exec", 1],
            ].map(([name, bit]) => (
              <label key={name as string} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={((mode >> shift) & (bit as number)) !== 0}
                  onChange={() => toggle((bit as number) << shift)}
                  className="rounded accent-zinc-300"
                />
                <span>{name}</span>
              </label>
            ))}
          </div>
        ))}
        <div className="flex items-center gap-2 pt-2">
          <span style={{ color: theme.textMuted }}>Octal:</span>
          <input
            value={octal}
            onChange={(e) => {
              const raw = e.target.value;
              setOctal(raw);
              if (/^[0-7]{1,4}$/.test(raw.trim())) {
                setMode(parseInt(raw.trim(), 8) & 0o7777);
              }
            }}
            className="w-20 rounded-lg border px-2.5 py-1 font-mono text-xs outline-none"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textPrimary,
            }}
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
          style={{ borderColor: theme.border, color: theme.textMuted }}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-lg px-3.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
          style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
        >
          Apply
        </button>
      </div>
    </form>
  );
}
