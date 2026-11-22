import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { AppSettings, ThemeTokens } from "../types";

export interface TerminalPaneHandle {
  copySelection: () => string | null;
  copyAll: () => string;
  pasteText: (text: string) => void;
  openFind: () => void;
  clearScrollback: () => void;
  resetTerminal: () => void;
  focus: () => void;
}

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
  settings: AppSettings;
  theme: ThemeTokens;
  registerPtyWriter: (sessionId: string, writer: ((bytes: Uint8Array) => void) | null) => void;
  drainBufferedPty: (sessionId: string) => Uint8Array[];
  onOsc7Path: (path: string) => void;
  onContextMenu: (x: number, y: number) => void;
  onAutoCopied: () => void;
  onSaveTranscript: () => void;
  onSendData?: (data: string) => void;
}

function mapCursorStyle(s: AppSettings["cursor_style"]): "bar" | "block" | "underline" {
  if (s === "block") return "block";
  if (s === "underline") return "underline";
  return "bar";
}

function buildSafeFontFamily(fontName: string | null): string {
  const fallback = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace';
  if (!fontName) return fallback;
  const sanitized = fontName.replace(/[^A-Za-z0-9 _.-]/g, "").trim();
  if (!sanitized) return fallback;
  return `"${sanitized}", Consolas, "Cascadia Mono", monospace`;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
  function TerminalPane(
    {
      sessionId,
      active,
      settings,
      theme,
      registerPtyWriter,
      drainBufferedPty,
      onOsc7Path,
      onContextMenu,
      onAutoCopied,
      onSaveTranscript,
      onSendData,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });

    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const activeRef = useRef(active);
    activeRef.current = active;
    const onOsc7Ref = useRef(onOsc7Path);
    onOsc7Ref.current = onOsc7Path;
    const onAutoCopiedRef = useRef(onAutoCopied);
    onAutoCopiedRef.current = onAutoCopied;
    const onSaveRef = useRef(onSaveTranscript);
    onSaveRef.current = onSaveTranscript;
    const onSendDataRef = useRef(onSendData);
    onSendDataRef.current = onSendData;

    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState("");
    const [findCase, setFindCase] = useState(false);
    const [findWord, setFindWord] = useState(false);
    const [findRegex, setFindRegex] = useState(false);
    const [findResult, setFindResult] = useState({ index: 0, count: 0 });
    const [findError, setFindError] = useState(false);
    const findInputRef = useRef<HTMLInputElement | null>(null);

    const openFindBar = () => {
      const selected = termRef.current?.getSelection();
      if (selected && !selected.includes("\n") && selected.length <= 256) setFindQuery(selected);
      setFindOpen(true);
      window.setTimeout(() => findInputRef.current?.select(), 10);
    };

    const closeFindBar = () => {
      setFindOpen(false);
      searchRef.current?.clearDecorations();
      termRef.current?.clearSelection();
      termRef.current?.focus();
    };

    const find = (direction: "next" | "previous") => {
      if (!findQuery || findError) return;
      const options = {
        caseSensitive: findCase,
        wholeWord: findWord,
        regex: findRegex,
        decorations: {
          matchOverviewRuler: theme.accent,
          activeMatchColorOverviewRuler: theme.textPrimary,
          matchBackground: theme.selection,
        },
      };
      if (direction === "next") searchRef.current?.findNext(findQuery, options);
      else searchRef.current?.findPrevious(findQuery, options);
    };

    useEffect(() => {
      if (!findOpen || !findQuery) {
        searchRef.current?.clearDecorations();
        setFindError(false);
        setFindResult({ index: 0, count: 0 });
        return;
      }
      if (findRegex) {
        try {
          new RegExp(findQuery);
        } catch {
          searchRef.current?.clearDecorations();
          setFindError(true);
          setFindResult({ index: 0, count: 0 });
          return;
        }
      }
      setFindError(false);
      searchRef.current?.findNext(findQuery, {
        caseSensitive: findCase,
        wholeWord: findWord,
        regex: findRegex,
        incremental: true,
        decorations: {
          matchOverviewRuler: theme.accent,
          activeMatchColorOverviewRuler: theme.textPrimary,
          matchBackground: theme.selection,
        },
      });
    }, [findOpen, findQuery, findCase, findWord, findRegex, theme]);

    const dumpBuffer = (): string => {
      const term = termRef.current;
      if (!term) return "";
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      return lines.join("\n");
    };

    const fitAndSyncResize = () => {
      const el = containerRef.current;
      const fit = fitRef.current;
      const term = termRef.current;
      if (!el || !fit || !term || el.clientWidth <= 0 || el.clientHeight <= 0) return;
      try {
        fit.fit();
        if (term.cols !== lastSizeRef.current.cols || term.rows !== lastSizeRef.current.rows) {
          lastSizeRef.current = { cols: term.cols, rows: term.rows };
          void invoke("resize_pty", { sessionId, cols: term.cols, rows: term.rows });
        }
      } catch {
        // Ignore transient layout measurements.
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        copySelection: () => {
          const sel = termRef.current?.getSelection() ?? "";
          return sel.length > 0 ? sel : null;
        },
        copyAll: dumpBuffer,
        pasteText: (text: string) => {
          // Route through xterm.paste() so bracketed paste mode protects against newline injection.
          termRef.current?.paste(text);
          termRef.current?.focus();
        },
        openFind: openFindBar,
        clearScrollback: () => {
          termRef.current?.clear();
        },
        resetTerminal: () => {
          termRef.current?.reset();
        },
        focus: () => {
          termRef.current?.focus();
        },
      }),
      [sessionId],
    );

    // Mount xterm.js + WebGL once per session.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const term = new Terminal({
        fontFamily: buildSafeFontFamily(settingsRef.current.terminal_font),
        fontSize: settingsRef.current.terminal_font_size,
        cursorStyle: mapCursorStyle(settingsRef.current.cursor_style),
        cursorBlink: true,
        scrollback: settingsRef.current.scrollback_lines,
        theme: {
          background: theme.termBg,
          foreground: theme.termFg,
          cursor: theme.cursor,
          selectionBackground: theme.selection,
          ...theme.ansi,
        },
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      // Safe external link opener: validates http/https and opens via OS browser, never window.open.
      const webLinksAddon = new WebLinksAddon((_ev, uri) => {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            void invoke("open_external_url", { url: parsed.toString() });
          }
        } catch {
          // Ignore malformed URLs.
        }
      });
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(webLinksAddon);

      term.open(el);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // Fallback to standard canvas/DOM renderer if WebGL is unavailable.
      }

      termRef.current = term;
      fitRef.current = fitAddon;
      searchRef.current = searchAddon;
      const resultsDisp = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
        setFindResult({ index: resultIndex, count: resultCount });
      });

      // Drain any early PTY chunks buffered before TerminalPane mounted, then register live writer.
      const buffered = drainBufferedPty(sessionId);
      for (const chunk of buffered) {
        term.write(chunk);
      }
      registerPtyWriter(sessionId, (bytes) => term.write(bytes));

      fitAndSyncResize();

      // Forward user keystrokes to Rust russh PTY (or broadcast handler when active).
      const dataDisp = term.onData((data) => {
        if (onSendDataRef.current) {
          onSendDataRef.current(data);
        } else {
          void invoke("send_pty_input", { sessionId, data });
        }
      });

      // Validated + debounced OSC 7 directory tracking -> sync SFTP sidebar.
      let oscTimer: number | null = null;
      const oscDisp = term.parser.registerOscHandler(7, (payload) => {
        if (payload.startsWith("file://")) {
          const rest = payload.slice("file://".length);
          const slashIdx = rest.indexOf("/");
          if (slashIdx >= 0) {
            let decoded = rest.slice(slashIdx);
            try {
              decoded = decodeURIComponent(decoded);
            } catch {
              // Use raw path if percent-decoding fails.
            }
            if (
              decoded.startsWith("/") &&
              decoded.length <= 4096 &&
              !/[\x00-\x1f\x7f]/.test(decoded)
            ) {
              if (oscTimer !== null) window.clearTimeout(oscTimer);
              oscTimer = window.setTimeout(() => {
                onOsc7Ref.current(decoded);
              }, 250);
            }
          }
        }
        return false;
      });

      // Optional copy-on-select.
      const selDisp = term.onSelectionChange(() => {
        if (!settingsRef.current.copy_on_select) return;
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          onAutoCopiedRef.current();
        }
      });

      // Keyboard shortcuts inside xterm (Ctrl+Shift+C/V/F/S, Shift+Insert).
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "c") {
          const sel = term.getSelection();
          if (sel) {
            void navigator.clipboard.writeText(sel);
            onAutoCopiedRef.current();
          }
          return false;
        }
        if (
          (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "v") ||
          (ev.shiftKey && ev.key === "Insert")
        ) {
          void navigator.clipboard.readText().then((txt) => {
            if (txt) term.paste(txt);
          });
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "f") {
          openFindBar();
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "s") {
          onSaveRef.current();
          return false;
        }
        return true;
      });

      // Auto-fit on visible container resize only (never resize hidden background tabs).
      let resizeTimer: number | null = null;
      const observer = new ResizeObserver(() => {
        if (!activeRef.current) return;
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(fitAndSyncResize, 30);
      });
      observer.observe(el);

      return () => {
        if (oscTimer !== null) window.clearTimeout(oscTimer);
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        registerPtyWriter(sessionId, null);
        observer.disconnect();
        dataDisp.dispose();
        oscDisp.dispose();
        selDisp.dispose();
        resultsDisp.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
        searchRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    // Live-update theme, font, font size, cursor style, and re-fit when becoming active.
    useEffect(() => {
      const term = termRef.current;
      if (!term) return;

      term.options.fontFamily = buildSafeFontFamily(settings.terminal_font);
      term.options.fontSize = settings.terminal_font_size;
      term.options.cursorStyle = mapCursorStyle(settings.cursor_style);
      term.options.scrollback = settings.scrollback_lines;
      term.options.theme = {
        background: theme.termBg,
        foreground: theme.termFg,
        cursor: theme.cursor,
        selectionBackground: theme.selection,
        ...theme.ansi,
      };

      if (active) {
        const timer = window.setTimeout(() => {
          fitAndSyncResize();
          termRef.current?.focus();
        }, 20);
        return () => window.clearTimeout(timer);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings, theme, active]);

    return (
      <div
        className={`relative h-full w-full ${active ? "block" : "hidden"}`}
        style={{ backgroundColor: theme.termBg }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (settings.right_click_paste) {
            void navigator.clipboard.readText().then((txt) => {
              if (txt) termRef.current?.paste(txt);
            });
            return;
          }
          onContextMenu(e.clientX, e.clientY);
        }}
      >
        <div ref={containerRef} className="h-full w-full" />

        {findOpen && (
          <div
            className="absolute right-3 top-2.5 z-20 flex items-center gap-1 rounded-lg border px-2 py-1.5 shadow-lg"
            style={{
              backgroundColor: theme.bgElevated,
              borderColor: theme.border,
              color: theme.textPrimary,
            }}
          >
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  find(e.shiftKey ? "previous" : "next");
                } else if (e.key === "Escape") {
                  closeFindBar();
                }
              }}
              placeholder="Find in terminal"
              aria-label="Find in terminal"
              className="w-44 rounded border px-2 py-0.5 text-xs outline-none"
              style={{
                backgroundColor: theme.bgBase,
                borderColor: findError ? theme.danger : theme.border,
                color: theme.textPrimary,
              }}
            />
            <span className="min-w-12 text-center text-[11px] tabular-nums" style={{ color: findError ? theme.danger : theme.textMuted }} aria-live="polite">
              {findError ? "Invalid" : !findQuery ? "" : findResult.count < 0 ? "1000+" : `${findResult.count ? findResult.index + 1 : 0}/${findResult.count}`}
            </span>
            {([
              ["Aa", "Match case", findCase, setFindCase],
              ["W", "Whole word", findWord, setFindWord],
              [".*", "Regular expression", findRegex, setFindRegex],
            ] as const).map(([label, title, enabled, setEnabled]) => (
              <button
                key={title}
                type="button"
                title={title}
                aria-label={title}
                aria-pressed={enabled}
                onClick={() => setEnabled(!enabled)}
                className="rounded px-1.5 py-1 font-mono text-[11px] hover:bg-white/10"
                style={{ backgroundColor: enabled ? theme.selection : "transparent", color: enabled ? theme.textPrimary : theme.textMuted }}
              >{label}</button>
            ))}
            <button
              onClick={() => find("previous")}
              disabled={!findQuery || findError}
              className="rounded p-1 hover:bg-white/10"
              title="Previous"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => find("next")}
              disabled={!findQuery || findError}
              className="rounded p-1 hover:bg-white/10"
              title="Next"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={closeFindBar}
              className="rounded p-1 hover:bg-white/10"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    );
  },
);
