import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Folder, Server, Settings } from "lucide-react";
import { ContextMenu, type ContextMenuState } from "./components/ContextMenu";
import { HostsPanel, type QuickFormValues } from "./components/HostsPanel";
import { Modals, type ActiveModal } from "./components/Modals";
import { MonitorStrip } from "./components/MonitorStrip";
import { SettingsPanel } from "./components/SettingsPanel";
import { SftpSidebar } from "./components/SftpSidebar";
import { TerminalPane, type TerminalPaneHandle } from "./components/TerminalPane";
import { Titlebar } from "./components/Titlebar";
import { Toasts } from "./components/Toasts";
import {
  THEMES,
  type AppSettings,
  type HostKeyPrompt,
  type HostProfile,
  type RemoteEntry,
  type ServerStats,
  type SessionTab,
  type SftpDockPosition,
  type SidebarTab,
  type ToastItem,
} from "./types";

const DEFAULT_SETTINGS: AppSettings = {
  theme_id: "obsidian",
  terminal_font: null,
  terminal_font_size: 14,
  cursor_style: "beam",
  scrollback_lines: 10000,
  copy_on_select: false,
  right_click_paste: false,
  show_hidden_files: true,
  follow_terminal_folder: true,
  remote_monitoring: true,
  sftp_position: "left",
};

const EMPTY_FORM: QuickFormValues = {
  name: "",
  host: "",
  port: "22",
  username: "",
  useKey: false,
  password: "",
  keyPath: "",
  passphrase: "",
};

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** Unconditionally single-quotes a remote path and strips ASCII control chars to prevent PTY injection. */
function shellQuote(path: string): string {
  const clean = path.replace(/[\x00-\x1f\x7f]/g, "");
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("hosts");
  const [sidebarWidth, setSidebarWidth] = useState(290);
  const [quickConnect, setQuickConnect] = useState("");
  const [form, setForm] = useState<QuickFormValues>(EMPTY_FORM);
  const [selectedSftpPath, setSelectedSftpPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);
  const [hostKeyPrompts, setHostKeyPrompts] = useState<HostKeyPrompt[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const termRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());
  const ptyWritersRef = useRef<Map<string, (bytes: Uint8Array) => void>>(new Map());
  const ptyBuffersRef = useRef<Map<string, Uint8Array[]>>(new Map());
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const theme = THEMES[settings.theme_id] ?? THEMES.obsidian;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const pushToast = useCallback((title: string, kind: "info" | "error" = "info", detail?: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev.slice(-3), { id, title, detail, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, kind === "error" ? 6000 : 3200);
  }, []);

  const persistSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    void invoke("save_settings", { settings: next }).catch((err: unknown) => {
      pushToast("Failed to save settings", "error", String(err));
    });
  }, [pushToast]);

  const registerPtyWriter = useCallback(
    (sessionId: string, writer: ((bytes: Uint8Array) => void) | null) => {
      if (writer) ptyWritersRef.current.set(sessionId, writer);
      else ptyWritersRef.current.delete(sessionId);
    },
    [],
  );

  const drainBufferedPty = useCallback((sessionId: string): Uint8Array[] => {
    const chunks = ptyBuffersRef.current.get(sessionId) ?? [];
    ptyBuffersRef.current.delete(sessionId);
    return chunks;
  }, []);

  // Load initial profiles & settings from Rust backend.
  useEffect(() => {
    void invoke<AppSettings>("get_settings").then(setSettings);
    void invoke<HostProfile[]>("list_profiles")
      .then(setProfiles)
      .catch((err: unknown) => pushToast("Failed to load hosts", "error", String(err)));
  }, [pushToast]);

  // Clear SFTP selection when switching tabs or directories.
  useEffect(() => {
    setSelectedSftpPath(null);
  }, [activeSessionId, activeSession?.sftpPath]);

  // Clean up any active sidebar drag listeners on unmount.
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  // Global keyboard shortcuts (Ctrl+B toggles sidebar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Subscribe to Rust push events with StrictMode-safe cancellation (zero leaks, zero polling).
  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

    const sub = <T,>(event: string, handler: (payload: T) => void) => {
      void listen<T>(event, (ev) => {
        if (!cancelled) handler(ev.payload);
      }).then((unlisten) => {
        if (cancelled) unlisten();
        else unsubs.push(unlisten);
      });
    };

    sub<{ session_id: string; data_b64: string }>("vela://pty", ({ session_id, data_b64 }) => {
      const bytes = decodeBase64ToBytes(data_b64);
      const writer = ptyWritersRef.current.get(session_id);
      if (writer) {
        writer(bytes);
      } else {
        const buf = ptyBuffersRef.current.get(session_id) ?? [];
        if (buf.length < 512) {
          buf.push(bytes);
          ptyBuffersRef.current.set(session_id, buf);
        }
      }
    });

    sub<{ session_id: string; state: "connected" | "disconnected"; initial_dir?: string }>(
      "vela://state",
      ({ session_id, state, initial_dir }) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === session_id ? { ...s, state, sftpPath: initial_dir ?? s.sftpPath } : s,
          ),
        );
      },
    );

    sub<{ session_id: string; path: string; entries: RemoteEntry[] }>(
      "vela://sftp",
      ({ session_id, path, entries }) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === session_id ? { ...s, sftpPath: path, sftpEntries: entries } : s,
          ),
        );
      },
    );

    sub<{ session_id: string; stats: ServerStats }>("vela://stats", ({ session_id, stats }) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== session_id) return s;
          const nextHist = [...s.cpuHistory, stats.cpu_percent].slice(-24);
          return { ...s, stats, cpuHistory: nextHist };
        }),
      );
    });

    sub<HostKeyPrompt>("vela://host-key", (prompt) => {
      setHostKeyPrompts((prev) => [...prev, prompt]);
    });

    sub<{ session_id: string; message: string }>("vela://notice", ({ message }) => {
      pushToast(message, "info");
    });

    sub<{ session_id: string; error: { title: string; detail: string } }>(
      "vela://error",
      ({ error }) => {
        pushToast(error.title, "error", error.detail);
      },
    );

    // Native OS drag-and-drop onto window -> upload files or folders into active SFTP directory.
    sub<{ paths: string[] }>("tauri://drag-drop", ({ paths }) => {
      const sid = activeSessionIdRef.current;
      const active = sessionsRef.current.find((s) => s.id === sid);
      if (!active || paths.length === 0) return;
      for (const localPath of paths) {
        void invoke("sftp_upload_dropped", {
          sessionId: active.id,
          localPath,
          remoteDir: active.sftpPath,
        }).catch((err: unknown) => {
          pushToast("Upload failed", "error", String(err));
        });
      }
    });

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [pushToast]);

  const connectProfile = async (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    const sessionId = crypto.randomUUID();
    const tab: SessionTab = {
      id: sessionId,
      title: profile?.name ?? "Connecting...",
      address: profile
        ? `${profile.username}@${profile.host}${profile.port !== 22 ? `:${profile.port}` : ""}`
        : "",
      state: "connecting",
      sftpPath: "/",
      sftpEntries: [],
      stats: null,
      cpuHistory: [],
    };

    // Register tab BEFORE invoking connect_profile so early MOTD/state/SFTP events are never lost.
    setSessions((prev) => [...prev, tab]);
    setActiveSessionId(sessionId);
    setSidebarTab("sftp");
    setSidebarOpen(true);

    try {
      const res = await invoke<{ session_id: string; title: string; address: string }>(
        "connect_profile",
        { sessionId, profileId, cols: 120, rows: 36 },
      );
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, title: res.title, address: res.address } : s,
        ),
      );
    } catch (err) {
      ptyBuffersRef.current.delete(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setActiveSessionId((curr) => (curr === sessionId ? null : curr));
      pushToast("Connection failed", "error", String(err));
    }
  };

  const handleSaveAndConnect = async () => {
    if (!form.host.trim() || !form.username.trim()) {
      pushToast("Missing fields", "error", "Enter both a host address and username.");
      return;
    }
    const parsedPort = Number.parseInt(form.port.trim(), 10);
    if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      pushToast("Invalid port", "error", "Port must be between 1 and 65535.");
      return;
    }
    if (form.useKey && !form.keyPath.trim()) {
      pushToast("Missing key path", "error", "Enter the path to your SSH private key.");
      return;
    }

    try {
      const created = await invoke<HostProfile>("save_profile", {
        input: {
          name: form.name,
          host: form.host,
          port: parsedPort,
          username: form.username,
          use_key: form.useKey,
          password: form.password || null,
          key_path: form.keyPath || null,
          passphrase: form.passphrase || null,
        },
      });
      setProfiles((prev) => [...prev, created]);
      setForm({ ...form, password: "", passphrase: "" });
      await connectProfile(created.id);
    } catch (err) {
      pushToast("Failed to save profile", "error", String(err));
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    try {
      await invoke("delete_profile", { profileId });
      setProfiles((prev) => prev.filter((p) => p.id !== profileId));
    } catch (err) {
      pushToast("Failed to delete host", "error", String(err));
    }
  };

  const handleCloseTab = (id: string) => {
    void invoke("disconnect_session", { sessionId: id });
    termRefs.current.delete(id);
    ptyWritersRef.current.delete(id);
    ptyBuffersRef.current.delete(id);
    setHostKeyPrompts((prev) => prev.filter((p) => p.session_id !== id));

    const remaining = sessionsRef.current.filter((s) => s.id !== id);
    setSessions(remaining);
    if (activeSessionIdRef.current === id) {
      setActiveSessionId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  };

  const handleQuickConnectSubmit = () => {
    const q = quickConnect.trim();
    if (!q) return;
    const lower = q.toLowerCase();
    const matched = profiles.find(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.host.toLowerCase().includes(lower) ||
        `${p.username}@${p.host}`.toLowerCase().includes(lower),
    );
    if (matched) {
      setQuickConnect("");
      void connectProfile(matched.id);
      return;
    }

    const atIdx = q.lastIndexOf("@");
    if (atIdx > 0 && atIdx < q.length - 1) {
      const user = q.slice(0, atIdx);
      const hostPort = q.slice(atIdx + 1);
      let host = hostPort;
      let port = "22";

      if (hostPort.startsWith("[")) {
        const closeBracket = hostPort.indexOf("]");
        if (closeBracket > 1) {
          host = hostPort.slice(1, closeBracket);
          if (hostPort[closeBracket + 1] === ":") {
            port = hostPort.slice(closeBracket + 2) || "22";
          }
        }
      } else {
        const colonIdx = hostPort.lastIndexOf(":");
        if (colonIdx > 0 && hostPort.indexOf(":") === colonIdx) {
          host = hostPort.slice(0, colonIdx);
          port = hostPort.slice(colonIdx + 1) || "22";
        }
      }

      setForm((prev) => ({ ...prev, name: host, username: user, host, port }));
      setSidebarTab("hosts");
      setSidebarOpen(true);
      pushToast(`Pre-filled ${user}@${host}:${port}`, "info");
      return;
    }

    pushToast("No matching host", "info", "Use user@host[:port] to pre-fill a new connection.");
  };

  // SFTP actions
  const selectedEntry =
    activeSession?.sftpEntries.find((e) => e.path === selectedSftpPath) ?? null;

  const sftpOpenEntry = (entry: RemoteEntry) => {
    if (!activeSession) return;
    void invoke("sftp_open_entry", { sessionId: activeSession.id, path: entry.path }).catch(
      (err: unknown) => pushToast("Failed to open entry", "error", String(err)),
    );
  };

  const sftpDownloadEntry = (entry: RemoteEntry) => {
    if (!activeSession) return;
    if (entry.kind === "directory") {
      pushToast("Select a file to download", "info");
      return;
    }
    void invoke("sftp_download_dialog", {
      sessionId: activeSession.id,
      remotePath: entry.path,
      defaultName: entry.name,
    }).catch((err: unknown) => pushToast("Download failed", "error", String(err)));
  };

  const sftpUploadPicker = () => {
    if (!activeSession) return;
    void invoke("sftp_upload_dialog", {
      sessionId: activeSession.id,
      remoteDir: activeSession.sftpPath,
    }).catch((err: unknown) => pushToast("Upload failed", "error", String(err)));
  };

  const sftpCopyPathToTerminal = (entry: RemoteEntry) => {
    if (!activeSession) return;
    const quoted = shellQuote(entry.path);
    termRefs.current.get(activeSession.id)?.pasteText(quoted);
  };

  const sftpCdInTerminal = (entry: RemoteEntry) => {
    if (!activeSession) return;
    void invoke("send_pty_input", {
      sessionId: activeSession.id,
      data: `cd ${shellQuote(entry.path)}\r`,
    });
    termRefs.current.get(activeSession.id)?.focus();
  };

  const saveActiveTranscript = () => {
    if (!activeSession) return;
    const term = termRefs.current.get(activeSession.id);
    if (!term) return;
    const content = term.copyAll();
    void invoke<boolean>("save_transcript_dialog", {
      defaultName: `${activeSession.title.replace(/[^A-Za-z0-9._-]/g, "_")}-output.log`,
      content,
    })
      .then((saved) => {
        if (saved) pushToast("Saved terminal transcript", "info");
      })
      .catch((err: unknown) => pushToast("Failed to save transcript", "error", String(err)));
  };

  const activeTerm = activeSessionId ? termRefs.current.get(activeSessionId) ?? null : null;

  const startResizeSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    resizeCleanupRef.current?.();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const isRight = sidebarTab === "sftp" && settings.sftp_position === "right";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const delta = isRight ? startX - ev.clientX : ev.clientX - startX;
      setSidebarWidth(Math.max(220, Math.min(520, startW + delta)));
    };
    const cleanup = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
  };

  const horizontalDock =
    sidebarOpen &&
    sidebarTab === "sftp" &&
    (settings.sftp_position === "top" || settings.sftp_position === "bottom");

  const sidebarBorderClass =
    sidebarTab === "sftp" && settings.sftp_position === "right"
      ? "border-l"
      : sidebarTab === "sftp" && settings.sftp_position === "top"
        ? "border-b"
        : sidebarTab === "sftp" && settings.sftp_position === "bottom"
          ? "border-t"
          : "border-r";

  const sidebarEl = (
    <div
      className={`flex shrink-0 flex-col gap-2 ${sidebarBorderClass} p-2.5`}
      style={{
        width: horizontalDock ? "100%" : sidebarWidth,
        height: horizontalDock ? 230 : "100%",
        backgroundColor: theme.bgSurface,
        borderColor: theme.border,
      }}
    >
      {!horizontalDock && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleQuickConnectSubmit();
          }}
        >
          <input
            value={quickConnect}
            onChange={(e) => setQuickConnect(e.target.value)}
            placeholder="Quick connect... (user@host)"
            className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textPrimary,
            }}
          />
        </form>
      )}

      <div className="px-0.5 text-[11px] font-medium" style={{ color: theme.textMuted }}>
        {sidebarTab === "hosts"
          ? "Sessions"
          : sidebarTab === "sftp"
            ? "SSH browser (SFTP)"
            : "Settings"}
      </div>

      <div className="min-h-0 flex-1">
        {sidebarTab === "hosts" && (
          <HostsPanel
            profiles={profiles}
            theme={theme}
            form={form}
            onChangeForm={setForm}
            onSaveAndConnect={() => void handleSaveAndConnect()}
            onConnectProfile={(id) => void connectProfile(id)}
            onDeleteProfile={(id) => void handleDeleteProfile(id)}
          />
        )}
        {sidebarTab === "sftp" && (
          <SftpSidebar
            session={activeSession}
            settings={settings}
            theme={theme}
            selectedPath={selectedSftpPath}
            onSelectEntry={(e) => setSelectedSftpPath(e.path)}
            onOpenEntry={sftpOpenEntry}
            onNavigate={(path) => {
              if (activeSession) {
                void invoke("sftp_list_dir", { sessionId: activeSession.id, path });
              }
            }}
            onGoUp={() => {
              if (activeSession) {
                void invoke("sftp_go_up", {
                  sessionId: activeSession.id,
                  currentPath: activeSession.sftpPath,
                });
              }
            }}
            onRefresh={() => {
              if (activeSession) {
                void invoke("sftp_list_dir", {
                  sessionId: activeSession.id,
                  path: activeSession.sftpPath,
                });
              }
            }}
            onDownloadSelected={() => {
              if (selectedEntry) sftpDownloadEntry(selectedEntry);
            }}
            onUploadPicker={sftpUploadPicker}
            onNewFolder={() => setActiveModal({ kind: "new_folder" })}
            onNewFile={() => setActiveModal({ kind: "new_file" })}
            onDeleteSelected={() => {
              if (selectedEntry) {
                setActiveModal({ kind: "delete_confirm", entry: selectedEntry });
              }
            }}
            onToggleHidden={() =>
              persistSettings({ ...settings, show_hidden_files: !settings.show_hidden_files })
            }
            onToggleFollowCd={(v) => persistSettings({ ...settings, follow_terminal_folder: v })}
            onToggleMonitoring={(v) => persistSettings({ ...settings, remote_monitoring: v })}
            onMiddleClickEntry={sftpCopyPathToTerminal}
            onItemContextMenu={(entry, x, y) =>
              setContextMenu({ kind: "sftp_item", entry, x, y })
            }
            onBgContextMenu={(x, y) => setContextMenu({ kind: "sftp_bg", x, y })}
          />
        )}
        {sidebarTab === "settings" && (
          <SettingsPanel
            settings={settings}
            theme={theme}
            onUpdateSettings={persistSettings}
          />
        )}
      </div>
    </div>
  );

  const resizeHandle = !horizontalDock && sidebarOpen && (
    <div
      onMouseDown={startResizeSidebar}
      className="h-full w-1 shrink-0 cursor-col-resize transition-colors hover:bg-white/15"
    />
  );

  const terminalArea = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1" style={{ backgroundColor: theme.termBg }}>
        {sessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="text-2xl font-semibold tracking-tight" style={{ color: theme.textPrimary }}>
              Vela
            </div>
            <div className="text-xs" style={{ color: theme.textMuted }}>
              Select a saved host or add your homeserver on the left to connect.
            </div>
          </div>
        ) : (
          sessions.map((s) => (
            <TerminalPane
              key={s.id}
              ref={(handle) => {
                if (handle) termRefs.current.set(s.id, handle);
                else termRefs.current.delete(s.id);
              }}
              sessionId={s.id}
              active={s.id === activeSessionId}
              settings={settings}
              theme={theme}
              registerPtyWriter={registerPtyWriter}
              drainBufferedPty={drainBufferedPty}
              onOsc7Path={(path) => {
                const live = sessionsRef.current.find((x) => x.id === s.id);
                if (settingsRef.current.follow_terminal_folder && live && path !== live.sftpPath) {
                  void invoke("sftp_list_dir", { sessionId: s.id, path });
                }
              }}
              onContextMenu={(x, y) => setContextMenu({ kind: "terminal", x, y })}
              onAutoCopied={() => pushToast("Copied selection", "info")}
              onSaveTranscript={saveActiveTranscript}
            />
          ))
        )}
      </div>

      {activeSession && settings.remote_monitoring && (
        <MonitorStrip
          stats={activeSession.stats}
          cpuHistory={activeSession.cpuHistory}
          theme={theme}
        />
      )}
    </div>
  );

  const railBtn = (tab: SidebarTab, Icon: typeof Server, title: string) => {
    const active = sidebarOpen && sidebarTab === tab;
    return (
      <button
        onClick={() => {
          if (sidebarOpen && sidebarTab === tab) setSidebarOpen(false);
          else {
            setSidebarTab(tab);
            setSidebarOpen(true);
          }
        }}
        title={title}
        className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-white/8"
        style={{
          backgroundColor: active ? theme.bgElevated : "transparent",
          color: active ? theme.textPrimary : theme.textMuted,
        }}
      >
        <Icon className="h-4 w-4" />
      </button>
    );
  };

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{ backgroundColor: theme.bgBase, color: theme.textPrimary }}
    >
      <Titlebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        theme={theme}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onSelectTab={setActiveSessionId}
        onCloseTab={handleCloseTab}
        onNewTab={() => {
          setSidebarTab("hosts");
          setSidebarOpen(true);
        }}
      />

      <div className="flex min-h-0 flex-1">
        <div
          className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r py-2"
          style={{ backgroundColor: theme.bgBase, borderColor: theme.border }}
        >
          {railBtn("hosts", Server, "Sessions")}
          {railBtn("sftp", Folder, "SFTP Browser")}
          <div className="flex-1" />
          {railBtn("settings", Settings, "Settings")}
        </div>

        {!sidebarOpen ? (
          terminalArea
        ) : sidebarTab === "sftp" && settings.sftp_position === "right" ? (
          <>
            {terminalArea}
            {resizeHandle}
            {sidebarEl}
          </>
        ) : sidebarTab === "sftp" && settings.sftp_position === "top" ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {sidebarEl}
            {terminalArea}
          </div>
        ) : sidebarTab === "sftp" && settings.sftp_position === "bottom" ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {terminalArea}
            {sidebarEl}
          </div>
        ) : (
          <>
            {sidebarEl}
            {resizeHandle}
            {terminalArea}
          </>
        )}
      </div>

      <div
        className="flex h-6 shrink-0 items-center border-t px-3 text-[11px]"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
          color: theme.textMuted,
        }}
      >
        {activeSession
          ? `${activeSession.state === "connected" ? "Connected" : activeSession.state === "connecting" ? "Connecting..." : "Disconnected"}  ·  ${activeSession.address}  ·  ${activeSession.sftpPath}`
          : "Ready  ·  Ctrl+B: Sidebar  ·  Drag files onto window to upload"}
      </div>

      <Toasts
        toasts={toasts}
        theme={theme}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />

      <ContextMenu
        menu={contextMenu}
        sftpPosition={settings.sftp_position}
        theme={theme}
        onClose={() => setContextMenu(null)}
        onOpenEntry={sftpOpenEntry}
        onDownloadEntry={sftpDownloadEntry}
        onUploadHere={sftpUploadPicker}
        onRenameEntry={(entry) => setActiveModal({ kind: "rename", entry })}
        onDeleteEntry={(entry) => setActiveModal({ kind: "delete_confirm", entry })}
        onCopyPath={(entry) => {
          const text = shellQuote(entry.path);
          void navigator.clipboard.writeText(text);
          pushToast(`Copied ${text}`, "info");
        }}
        onCopyPathToTerm={sftpCopyPathToTerminal}
        onCdInTerminal={sftpCdInTerminal}
        onChmodEntry={(entry) => setActiveModal({ kind: "chmod", entry })}
        onGoUp={() => {
          if (activeSession) {
            void invoke("sftp_go_up", {
              sessionId: activeSession.id,
              currentPath: activeSession.sftpPath,
            });
          }
        }}
        onNewFolder={() => setActiveModal({ kind: "new_folder" })}
        onNewFile={() => setActiveModal({ kind: "new_file" })}
        onRefresh={() => {
          if (activeSession) {
            void invoke("sftp_list_dir", {
              sessionId: activeSession.id,
              path: activeSession.sftpPath,
            });
          }
        }}
        onSetPosition={(pos: SftpDockPosition) =>
          persistSettings({ ...settings, sftp_position: pos })
        }
        onTermCopy={() => {
          const sel = activeTerm?.copySelection();
          if (sel) {
            void navigator.clipboard.writeText(sel);
            pushToast("Copied selection", "info");
          } else {
            pushToast("No text selected", "info");
          }
        }}
        onTermCopyAll={() => {
          const all = activeTerm?.copyAll() ?? "";
          void navigator.clipboard.writeText(all);
          pushToast("Copied terminal buffer", "info");
        }}
        onTermPaste={() => {
          void navigator.clipboard.readText().then((txt) => {
            if (txt) activeTerm?.pasteText(txt);
          });
        }}
        onTermFind={() => activeTerm?.openFind()}
        onTermFontDelta={(d) =>
          persistSettings({
            ...settings,
            terminal_font_size: Math.max(10, Math.min(24, settings.terminal_font_size + d)),
          })
        }
        onTermFontReset={() => persistSettings({ ...settings, terminal_font_size: 14 })}
        onTermClear={() => activeTerm?.clearScrollback()}
        onTermReset={() => activeTerm?.resetTerminal()}
        onTermSaveFile={saveActiveTranscript}
        onTermCtrlC={() => {
          if (activeSession) {
            void invoke("send_pty_input", { sessionId: activeSession.id, data: "\x03" });
            activeTerm?.focus();
          }
        }}
        onTermSettings={() => {
          setSidebarTab("settings");
          setSidebarOpen(true);
        }}
      />

      <Modals
        modal={activeModal}
        hostKeyPrompt={hostKeyPrompts[0] ?? null}
        theme={theme}
        onCloseModal={() => setActiveModal(null)}
        onSubmitNewFolder={(name) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_mkdir", {
              sessionId: activeSession.id,
              parentDir: activeSession.sftpPath,
              name,
            }).catch((err: unknown) => pushToast("Failed to create folder", "error", String(err)));
          }
        }}
        onSubmitNewFile={(name) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_create_file", {
              sessionId: activeSession.id,
              parentDir: activeSession.sftpPath,
              name,
            }).catch((err: unknown) => pushToast("Failed to create file", "error", String(err)));
          }
        }}
        onSubmitRename={(entry, newName) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_rename", {
              sessionId: activeSession.id,
              oldPath: entry.path,
              newName,
            }).catch((err: unknown) => pushToast("Rename failed", "error", String(err)));
          }
        }}
        onSubmitChmod={(entry, mode) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_chmod", {
              sessionId: activeSession.id,
              path: entry.path,
              mode,
            }).catch((err: unknown) => pushToast("Chmod failed", "error", String(err)));
          }
        }}
        onConfirmDelete={(entry) => {
          setActiveModal(null);
          setSelectedSftpPath(null);
          if (activeSession) {
            void invoke("sftp_delete", {
              sessionId: activeSession.id,
              path: entry.path,
            }).catch((err: unknown) => pushToast("Delete failed", "error", String(err)));
          }
        }}
        onRespondHostKey={(promptId, accepted) => {
          setHostKeyPrompts((prev) => prev.filter((p) => p.prompt_id !== promptId));
          void invoke("respond_host_key", { promptId, accepted });
        }}
      />
    </div>
  );
}
