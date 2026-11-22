import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, FileCode2, X } from "lucide-react";
import { formatBytes } from "../types";
import type { FilePreview, ThemeTokens } from "../types";

interface FilePreviewModalProps {
  preview: FilePreview | null;
  theme: ThemeTokens;
  onClose: () => void;
  onEditLocally: (path: string) => void;
  onCopyContent: (content: string) => void;
}

export function FilePreviewModal({
  preview,
  theme,
  onClose,
  onEditLocally,
  onCopyContent,
}: FilePreviewModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!preview) return;
    setCopied(false);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview, onClose]);

  const lines = useMemo(() => {
    if (!preview) return [];
    return preview.content.split(/\r?\n/);
  }, [preview]);

  if (!preview) return null;

  const handleCopy = () => {
    onCopyContent(preview.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const gutterDigits = Math.max(2, String(lines.length).length);

  return (
    <div
      className="backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${preview.name}`}
    >
      <div
        className="modal-enter flex h-[75vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border"
        style={{
          backgroundColor: theme.bgSurface,
          borderColor: theme.border,
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.45)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-3 border-b px-4 py-3"
          style={{ borderColor: theme.border }}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
              style={{
                backgroundColor: theme.bgElevated,
                borderColor: theme.border,
                color: theme.textMuted,
              }}
            >
              <FileCode2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3
                  className="truncate text-sm font-medium"
                  style={{ color: theme.textPrimary }}
                >
                  {preview.name}
                </h3>
                <span
                  className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
                  style={{
                    backgroundColor: theme.bgBase,
                    borderColor: theme.border,
                    color: theme.textMuted,
                  }}
                >
                  {formatBytes(preview.size, false)}
                </span>
                <span
                  className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
                  style={{
                    backgroundColor: theme.bgBase,
                    borderColor: theme.border,
                    color: theme.textMuted,
                  }}
                >
                  {lines.length} {lines.length === 1 ? "line" : "lines"}
                </span>
                {preview.truncated && (
                  <span
                    className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: theme.bgBase,
                      borderColor: theme.warning,
                      color: theme.warning,
                    }}
                  >
                    Truncated at 256 KB
                  </span>
                )}
              </div>
              <div
                className="truncate font-mono text-[11px]"
                style={{ color: theme.textMuted }}
                title={preview.path}
              >
                {preview.path}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopy}
              title="Copy file content"
              className="vela-focus flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{
                borderColor: theme.border,
                color: copied ? theme.success : theme.textPrimary,
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>

            <button
              type="button"
              onClick={() => onEditLocally(preview.path)}
              title="Download and edit in local editor"
              className="vela-focus flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
              style={{
                backgroundColor: theme.textPrimary,
                color: theme.bgBase,
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Edit in Local Editor
            </button>

            <button
              type="button"
              onClick={onClose}
              title="Close (Esc)"
              className="vela-focus flex h-7 w-7 items-center justify-center rounded-lg border transition-colors hover:bg-white/5"
              style={{
                borderColor: theme.border,
                color: theme.textMuted,
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Monospace code viewer with line-number gutter */}
        <div
          className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-5"
          style={{
            backgroundColor: theme.termBg,
            color: theme.termFg,
          }}
        >
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, index) => (
                <tr key={index} className="hover:bg-white/[0.025]">
                  <td
                    className="sticky left-0 select-none border-r px-3 py-0 text-right align-top tabular-nums"
                    style={{
                      width: `${gutterDigits + 3}ch`,
                      minWidth: `${gutterDigits + 3}ch`,
                      backgroundColor: theme.bgBase,
                      borderColor: theme.border,
                      color: theme.textMuted,
                    }}
                  >
                    {index + 1}
                  </td>
                  <td className="whitespace-pre px-4 py-0 align-top">
                    {line.length > 0 ? line : "\u00A0"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
