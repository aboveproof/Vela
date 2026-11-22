import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CornerDownLeft, Search, X } from "lucide-react";
import type { ThemeTokens } from "../types";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  subtitle?: string;
  shortcut?: string;
  icon?: ReactNode;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  theme: ThemeTokens;
  items: PaletteItem[];
  onClose: () => void;
}

function fuzzyScore(text: string, query: string): number {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 1;

  const exactIdx = hay.indexOf(needle);
  if (exactIdx === 0) return 100;
  if (exactIdx > 0) return 75 - Math.min(exactIdx, 30);

  let qi = 0;
  let consecutive = 0;
  let bestConsecutive = 0;
  let score = 0;

  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] === needle[qi]) {
      qi++;
      consecutive++;
      if (consecutive > bestConsecutive) bestConsecutive = consecutive;
      score += i === 0 || hay[i - 1] === " " || hay[i - 1] === "/" || hay[i - 1] === "-" ? 6 : 2;
    } else {
      consecutive = 0;
    }
  }

  if (qi < needle.length) return 0;
  return 10 + score + bestConsecutive * 4;
}

function scoreItem(item: PaletteItem, query: string): number {
  const labelScore = fuzzyScore(item.label, query) * 3;
  const subScore = item.subtitle ? fuzzyScore(item.subtitle, query) * 1.5 : 0;
  const groupScore = fuzzyScore(item.group, query);
  const combined = fuzzyScore(`${item.group} ${item.label} ${item.subtitle ?? ""}`, query);
  return Math.max(labelScore, subScore, groupScore, combined);
}

export function CommandPalette({ open, theme, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const filtered = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return items;
    return items
      .map((item, idx) => ({ item, idx, score: scoreItem(item, trimmed) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((entry) => entry.item);
  }, [items, query]);

  const grouped = useMemo(() => {
    const groups: { name: string; entries: { item: PaletteItem; flatIndex: number }[] }[] = [];
    const map = new Map<string, { item: PaletteItem; flatIndex: number }[]>();

    filtered.forEach((item, flatIndex) => {
      let list = map.get(item.group);
      if (!list) {
        list = [];
        map.set(item.group, list);
        groups.push({ name: item.group, entries: list });
      }
      list.push({ item, flatIndex });
    });

    return groups;
  }, [filtered]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open || filtered.length === 0) return;
    const clamped = Math.min(activeIndex, filtered.length - 1);
    const activeItem = filtered[clamped];
    if (!activeItem) return;
    const el = itemRefs.current.get(activeItem.id);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length > 0) {
          setActiveIndex((prev) => (prev + 1) % filtered.length);
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length > 0) {
          setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const clamped = Math.min(activeIndex, filtered.length - 1);
        const target = filtered[clamped];
        if (target) {
          onClose();
          target.onSelect();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, filtered, activeIndex, onClose]);

  if (!open) return null;

  const safeActiveIndex = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : -1;

  return (
    <div
      className="backdrop-enter fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[13vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
    >
      <div
        className="palette-enter flex w-full max-w-xl flex-col overflow-hidden rounded-xl border"
        style={{
          backgroundColor: theme.bgSurface,
          borderColor: theme.border,
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.45)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search header */}
        <div
          className="flex items-center gap-2.5 border-b px-3.5 py-2.5"
          style={{ borderColor: theme.border }}
        >
          <Search className="h-4 w-4 shrink-0" style={{ color: theme.textMuted }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, host, snippet, or action..."
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:opacity-55"
            style={{ color: theme.textPrimary }}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              title="Clear search"
              className="vela-focus flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-white/10"
              style={{ color: theme.textMuted }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <kbd
            className="rounded border px-1.5 py-0.5 font-mono text-[10px]"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textMuted,
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-xs" style={{ color: theme.textMuted }}>
              No matching commands for &ldquo;{query}&rdquo;
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.name} className="mb-1.5 last:mb-0">
                <div
                  className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: theme.textMuted }}
                >
                  {group.name}
                </div>
                <div className="space-y-0.5">
                  {group.entries.map(({ item, flatIndex }) => {
                    const isActive = flatIndex === safeActiveIndex;
                    return (
                      <button
                        key={item.id}
                        ref={(el) => {
                          if (el) {
                            itemRefs.current.set(item.id, el);
                          } else {
                            itemRefs.current.delete(item.id);
                          }
                        }}
                        type="button"
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onClick={() => {
                          onClose();
                          item.onSelect();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors"
                        style={{
                          backgroundColor: isActive ? theme.bgElevated : "transparent",
                          color: theme.textPrimary,
                        }}
                      >
                        {item.icon && (
                          <span
                            className="flex h-5 w-5 shrink-0 items-center justify-center"
                            style={{ color: isActive ? theme.textPrimary : theme.textMuted }}
                          >
                            {item.icon}
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">{item.label}</div>
                          {item.subtitle && (
                            <div
                              className="truncate text-[11px]"
                              style={{ color: theme.textMuted }}
                            >
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                        {item.shortcut ? (
                          <div className="flex shrink-0 items-center gap-1">
                            {item.shortcut.split("+").map((keycap, idx) => (
                              <kbd
                                key={`${item.id}-k-${idx}`}
                                className="rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none"
                                style={{
                                  backgroundColor: theme.bgBase,
                                  borderColor: theme.border,
                                  color: theme.textMuted,
                                }}
                              >
                                {keycap.trim()}
                              </kbd>
                            ))}
                          </div>
                        ) : (
                          isActive && (
                            <CornerDownLeft
                              className="h-3.5 w-3.5 shrink-0"
                              style={{ color: theme.textMuted }}
                            />
                          )
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div
          className="flex items-center justify-between border-t px-3.5 py-2 text-[10px]"
          style={{
            borderColor: theme.border,
            backgroundColor: theme.bgBase,
            color: theme.textMuted,
          }}
        >
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd
                className="rounded border px-1 py-0.5 font-mono text-[9px]"
                style={{ borderColor: theme.border, backgroundColor: theme.bgSurface }}
              >
                ↑↓
              </kbd>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd
                className="rounded border px-1 py-0.5 font-mono text-[9px]"
                style={{ borderColor: theme.border, backgroundColor: theme.bgSurface }}
              >
                ↵
              </kbd>
              Run
            </span>
            <span className="flex items-center gap-1">
              <kbd
                className="rounded border px-1 py-0.5 font-mono text-[9px]"
                style={{ borderColor: theme.border, backgroundColor: theme.bgSurface }}
              >
                Esc
              </kbd>
              Close
            </span>
          </div>
          <span className="tabular-nums">
            {filtered.length} {filtered.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
    </div>
  );
}
