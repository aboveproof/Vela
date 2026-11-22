import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  onOsc7Path: (path: string) => void;
  onContextMenu: (x: number, y: number) => void;
  onAutoCopied: () => void;
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function mapCursorStyle(s: AppSettings["cursor_style"]): "bar" | "block" | "underline" {
  if (s === "block") return "block";
  if (s === "underline") return "underline";
  return "bar";
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
  function TerminalPane(
    { sessionId, active, settings, theme, onOsc7Path, onContextMenu, onAutoCopied },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState("");
    const findInputRef = useRef<HTMLInputElement | null>(null);

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

    useImperativeHandle(ref, () => ({
      copySelection: () => {
        const sel = termRef.current?.getSelection() ?? "";
        return sel.length > 0 ? sel : null;
      },
      copyAll: dumpBuffer,
      pasteText: (text: string) => {
        void invoke("send_pty_input", { sessionId, data: text });
        termRef.current?.focus();
      },
      openFind: () => {
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.focus(), 10);
      },
      clearScrollback: () => {
        termRef.current?.clear();
      },
      resetTerminal: () => {
        termRef.current?.reset();
      },
      focus: () => {
        termRef.current?.focus();
      },
    }));

    // Mount xterm.js + WebGL once per session.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const fontFamily = settingsRef.current.terminal_font
        ? `"${settingsRef.current.terminal_font}", Consolas, "Cascadia Mono", monospace`
        : 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace';

      const term = new Terminal({
        fontFamily,
        fontSize: settingsRef.current.terminal_font_size,
        cursorStyle: mapCursorStyle(settingsRef.current.cursor_style),
        cursorBlink: true,
        scrollback: settingsRef.current.scrollback_lines,
        allowProposedApi: true,
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
      const webLinksAddon = new WebLinksAddon();
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

      fitAddon.fit();
      void invoke("resize_pty", { sessionId, cols: term.cols, rows: term.rows });

      termRef.current = term;
      fitRef.current = fitAddon;
      searchRef.current = searchAddon;

      // Forward user keystrokes to Rust russh PTY.
      const dataDisp = term.onData((data) => {
        void invoke("send_pty_input", { sessionId, data });
      });

      // OSC 7 directory tracking -> sync SFTP sidebar.
      const oscDisp = term.parser.registerOscHandler(7, (payload) => {
        if (payload.startsWith("file://")) {
          const rest = payload.slice("file://".length);
          const slashIdx = rest.indexOf("/");
          if (slashIdx >= 0) {
            try {
              const decoded = decodeURIComponent(rest.slice(slashIdx));
              onOsc7Path(decoded);
            } catch {
              onOsc7Path(rest.slice(slashIdx));
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
          onAutoCopied();
        }
      });

      // Keyboard shortcuts inside xterm (Ctrl+Shift+C/V/F).
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "c") {
          const sel = term.getSelection();
          if (sel) {
            void navigator.clipboard.writeText(sel);
            onAutoCopied();
          }
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "v") {
          void navigator.clipboard.readText().then((txt) => {
            if (txt) void invoke("send_pty_input", { sessionId, data: txt });
          });
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "f") {
          setFindOpen(true);
          setTimeout(() => findInputRef.current?.focus(), 10);
          return false;
        }
        return true;
      });

      // Subscribe to push PTY output from Rust (zero polling!).
      let unlisten: (() => void) | null = null;
      void listen<{ session_id: string; data_b64: string }>("vela://pty", (event) => {
        if (event.payload.session_id === sessionId) {
          term.write(decodeBase64ToBytes(event.payload.data_b64));
        }
      }).then((fn) => {
        unlisten = fn;
      });

      // Auto-fit on container resize.
      let resizeTimer: number | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if (!fitRef.current || !termRef.current) return;
          try {
            fitRef.current.fit();
            void invoke("resize_pty", {
              sessionId,
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            });
          } catch {
            // Ignore resize while hidden.
          }
        }, 30);
      });
      observer.observe(el);

      return () => {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        observer.disconnect();
        if (unlisten) unlisten();
        dataDisp.dispose();
        oscDisp.dispose();
        selDisp.dispose();
        term.dispose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    // Live-update theme, font, font size, cursor style without restarting the terminal.
    useEffect(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term) return;

      term.options.fontFamily = settings.terminal_font
        ? `"${settings.terminal_font}", Consolas, "Cascadia Mono", monospace`
        : 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace';
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

      if (fit && active) {
        try {
          fit.fit();
          void invoke("resize_pty", { sessionId, cols: term.cols, rows: term.rows });
        } catch {
          // Ignore while transitioning.
        }
      }
    }, [settings, theme, active, sessionId]);

    // Re-fit & focus when switching tabs.
    useEffect(() => {
      if (!active) return;
      const timer = window.setTimeout(() => {
        try {
          fitRef.current?.fit();
          if (termRef.current) {
            void invoke("resize_pty", {
              sessionId,
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            });
            termRef.current.focus();
          }
        } catch {
          // Ignore.
        }
      }, 20);
      return () => window.clearTimeout(timer);
    }, [active, sessionId]);

    return (
      <div
        className={`relative h-full w-full ${active ? "block" : "hidden"}`}
        style={{ backgroundColor: theme.termBg }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (settings.right_click_paste) {
            void navigator.clipboard.readText().then((txt) => {
              if (txt) void invoke("send_pty_input", { sessionId, data: txt });
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
              onChange={(e) => {
                setFindQuery(e.target.value);
                if (e.target.value) searchRef.current?.findNext(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (e.shiftKey) searchRef.current?.findPrevious(findQuery);
                  else searchRef.current?.findNext(findQuery);
                } else if (e.key === "Escape") {
                  setFindOpen(false);
                  termRef.current?.focus();
                }
              }}
              placeholder="Find in terminal..."
              className="w-44 rounded border px-2 py-0.5 text-xs outline-none"
              style={{
                backgroundColor: theme.bgBase,
                borderColor: theme.border,
                color: theme.textPrimary,
              }}
            />
            <button
              onClick={() => searchRef.current?.findPrevious(findQuery)}
              className="rounded p-1 hover:bg-white/10"
              title="Previous"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => searchRef.current?.findNext(findQuery)}
              className="rounded p-1 hover:bg-white/10"
              title="Next"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => {
                setFindOpen(false);
                termRef.current?.focus();
              }}
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
