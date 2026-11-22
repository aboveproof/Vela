import { X } from "lucide-react";
import type { ThemeTokens, ToastItem } from "../types";

interface ToastsProps {
  toasts: ToastItem[];
  theme: ThemeTokens;
  onDismiss: (id: string) => void;
}

export function Toasts({ toasts, theme, onDismiss }: ToastsProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 top-12 z-50 flex w-[300px] flex-col gap-2">
      {toasts.map((t) => {
        const stripe = t.kind === "error" ? theme.danger : theme.success;
        return (
          <div
            key={t.id}
            className="toast-enter pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg"
            style={{
              backgroundColor: theme.bgElevated,
              borderColor: theme.border,
            }}
          >
            <div
              className="mt-0.5 h-4 w-0.5 shrink-0 rounded-full"
              style={{ backgroundColor: stripe }}
            />
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-xs font-medium"
                style={{ color: t.kind === "error" ? theme.danger : theme.textPrimary }}
              >
                {t.title}
              </div>
              {t.detail && (
                <div className="mt-0.5 break-words text-[11px]" style={{ color: theme.textMuted }}>
                  {t.detail}
                </div>
              )}
            </div>
            <button
              onClick={() => onDismiss(t.id)}
              className="rounded p-0.5 opacity-60 transition-opacity hover:bg-white/10 hover:opacity-100"
              style={{ color: theme.textMuted }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
