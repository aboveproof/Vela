import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const termRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());
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
    void invoke("save_settings", { settings: next });
  }, []);

  // Load initial profiles & settings from Rust backend.
  useEffect(() => {
    void invoke<AppSettings>("get_settings").then(setSettings);
    void invoke<HostProfile[]>("list_profiles")
      .then(setProfiles)
      .catch((err: unknown) => pushToast("Failed to load hosts", "error", String(err)));
  }, [pushToast]);

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

  // Subscribe to Rust push events (zero polling!).
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    void listen<{
      session_id: string;
      state: "connected" | "disconnected";
      initial_dir?: string;
    }>("vela://state", (ev) => {
      const { session_id, state, initial_dir } = ev.payload;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === session_id
            ? { ...s, state, sftpPath: initial_dir ?? s.sftpPath }
            : s,
        ),
      );
    }).then((u) => unsubs.push(u));

    void listen<{ session_id: string; path: string; entries: RemoteEntry[] }>(
      "vela://sftp",
      (ev) => {
        const { session_id, path, entries } = ev.payload;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === session_id ? { ...s, sftpPath: path, sftpEntries: entries } : s,
          ),
        );
      },
    ).then((u) => unsubs.push(u));

    void listen<{ session_id: string; stats: ServerStats }>("vela://stats", (ev) => {
      const { session_id, stats } = ev.payload;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== session_id) return s;
          const nextHist = [...s.cpuHistory, stats.cpu_percent].slice(-24);
          return { ...s, stats, cpuHistory: nextHist };
        }),
      );
    }).then((u) => unsubs.push(u));

    void listen<HostKeyPrompt>("vela://host-key", (ev) => {
      setHostKeyPrompt(ev.payload);
    }).then((u) => unsubs.push(u));

    void listen<{ session_id: string; message: string }>("vela://notice", (ev) => {
      pushToast(ev.payload.message, "info");
    }).then((u) => unsubs.push(u));

    void listen<{ session_id: string; error: { title: string; detail: string } }>(
      "vela://error",
      (ev) => {
        pushToast(ev.payload.error.title, "error", ev.payload.error.detail);
      },
    ).then((u) => unsubs.push(u));

    // Native OS drag-and-drop onto window -> upload into active SFTP directory.
    void listen<{ paths: string[] }>("tauri://drag-drop", (ev) => {
      const sid = activeSessionIdRef.current;
      const active = sessionsRef.current.find((s) => s.id === sid);
      if (!active) return;
      for (const localPath of ev.payload.paths) {
        void invoke("sftp_upload", {
          sessionId: active.id,
          localPath,
          remoteDir: active.sftpPath,
        });
      }
    }).then((u) => unsubs.push(u));

    return () => {
      for (const u of unsubs) u();
    };
  }, [pushToast]);

  const connectProfile = async (profileId: string) => {
    try {
      const res = await invoke<{ session_id: string; title: string; address: string }>(
        "connect_profile",
        { profileId, cols: 120, rows: 36 },
      );
      const tab: SessionTab = {
        id: res.session_id,
        title: res.title,
        address: res.address,
        state: "connecting",
        sftpPath: "/",
        sftpEntries: [],
        stats: null,
        cpuHistory: [],
      };
      setSessions((prev) => [...prev, tab]);
      setActiveSessionId(res.session_id);
      setSidebarTab("sftp");
      setSidebarOpen(true);
    } catch (err) {
      pushToast("Connection failed", "error", String(err));
    }
  };

  const handleSaveAndConnect = async () => {
    if (!form.host.trim() || !form.username.trim()) {
      pushToast("Missing fields", "error", "Enter both a host address and username.");
      return;
    }
    try {
      const created = await invoke<HostProfile>("save_profile", {
        input: {
          name: form.name,
          host: form.host,
          port: parseInt(form.port, 10) || 22,
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
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeSessionId === id) {
        setActiveSessionId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
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
    if (q.includes("@")) {
      const [user, hostPort] = q.split("@");
      const [host, port = "22"] = hostPort.split(":");
      setForm((prev) => ({ ...prev, name: host, username: user, host, port }));
      setSidebarTab("hosts");
      setSidebarOpen(true);
      pushToast(`Pre-filled ${user}@${host}:${port}`, "info");
    }
  };

  // SFTP actions
  const selectedEntry =
    activeSession?.sftpEntries.find((e) => e.path === selectedSftpPath) ?? null;

  const sftpOpenEntry = (entry: RemoteEntry) => {
    if (!activeSession) return;
    if (entry.kind === "directory" || entry.kind === "symlink") {
      void invoke("sftp_list_dir", { sessionId: activeSession.id, path: entry.path });
    } else {
      void invoke("sftp_edit_locally", { sessionId: activeSession.id, remotePath: entry.path });
    }
  };

  const sftpDownloadEntry = async (entry: RemoteEntry) => {
    if (!activeSession) return;
    if (entry.kind === "directory") {
      pushToast("Select a file to download", "info");
      return;
    }
    const localPath = await saveDialog({ defaultPath: entry.name });
    if (localPath) {
      void invoke("sftp_download", {
        sessionId: activeSession.id,
        remotePath: entry.path,
        localPath,
      });
    }
  };

  const sftpUploadPicker = async () => {
    if (!activeSession) return;
    const picked = await openDialog({ multiple: true });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    for (const localPath of files) {
      void invoke("sftp_upload", {
        sessionId: activeSession.id,
        localPath,
        remoteDir: activeSession.sftpPath,
      });
    }
  };

  const sftpCopyPathToTerminal = (entry: RemoteEntry) => {
    if (!activeSession) return;
    const quoted = entry.path.includes(" ")
      ? `'${entry.path.replace(/'/g, "'\\''")}'`
      : entry.path;
    void invoke("send_pty_input", { sessionId: activeSession.id, data: quoted });
    termRefs.current.get(activeSession.id)?.focus();
  };

  const activeTerm = activeSessionId ? termRefs.current.get(activeSessionId) ?? null : null;

  const startResizeSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const isRight = sidebarTab === "sftp" && settings.sftp_position === "right";
    const onMove = (ev: MouseEvent) => {
      const delta = isRight ? startX - ev.clientX : ev.clientX - startX;
      setSidebarWidth(Math.max(220, Math.min(520, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const horizontalDock =
    sidebarOpen &&
    sidebarTab === "sftp" &&
    (settings.sftp_position === "top" || settings.sftp_position === "bottom");

  const sidebarEl = (
    <div
      className="flex shrink-0 flex-col gap-2 border-r p-2.5"
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
              if (selectedEntry) void sftpDownloadEntry(selectedEntry);
            }}
            onUploadPicker={() => void sftpUploadPicker()}
            onNewFolder={() => setActiveModal({ kind: "new_folder" })}
            onNewFile={() => setActiveModal({ kind: "new_file" })}
            onDeleteSelected={() => {
              if (activeSession && selectedEntry) {
                void invoke("sftp_delete", {
                  sessionId: activeSession.id,
                  path: selectedEntry.path,
                  isDir: selectedEntry.kind === "directory",
                });
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
              onOsc7Path={(path) => {
                if (settingsRef.current.follow_terminal_folder && path !== s.sftpPath) {
                  void invoke("sftp_list_dir", { sessionId: s.id, path });
                }
              }}
              onContextMenu={(x, y) => setContextMenu({ kind: "terminal", x, y })}
              onAutoCopied={() => pushToast("Copied selection", "info")}
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
        {/* Far-left vertical activity rail */}
        <div
          className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r py-2"
          style={{ backgroundColor: theme.bgBase, borderColor: theme.border }}
        >
          {railBtn("hosts", Server, "Sessions")}
          {railBtn("sftp", Folder, "SFTP Browser")}
          <div className="flex-1" />
          {railBtn("settings", Settings, "Settings")}
        </div>

        {/* Main workspace with dockable SFTP position */}
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

      {/* Minimal status bar (no Theme button) */}
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
        onDownloadEntry={(e) => void sftpDownloadEntry(e)}
        onUploadHere={() => void sftpUploadPicker()}
        onRenameEntry={(entry) => setActiveModal({ kind: "rename", entry })}
        onDeleteEntry={(entry) => {
          if (activeSession) {
            void invoke("sftp_delete", {
              sessionId: activeSession.id,
              path: entry.path,
              isDir: entry.kind === "directory",
            });
          }
        }}
        onCopyPath={(entry) => {
          void navigator.clipboard.writeText(entry.path);
          pushToast(`Copied ${entry.path}`, "info");
        }}
        onCopyPathToTerm={sftpCopyPathToTerminal}
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
        onTermSaveFile={() => {
          if (!activeSession || !activeTerm) return;
          const content = activeTerm.copyAll();
          void saveDialog({ defaultPath: `${activeSession.title}-output.log` }).then((path) => {
            if (path) {
              void invoke("save_text_file", { path, content })
                .then(() => pushToast("Saved terminal transcript", "info"))
                .catch((err: unknown) => pushToast("Failed to save file", "error", String(err)));
            }
          });
        }}
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
        hostKeyPrompt={hostKeyPrompt}
        theme={theme}
        onCloseModal={() => setActiveModal(null)}
        onSubmitNewFolder={(name) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_mkdir", {
              sessionId: activeSession.id,
              parentDir: activeSession.sftpPath,
              name,
            });
          }
        }}
        onSubmitNewFile={(name) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_create_file", {
              sessionId: activeSession.id,
              parentDir: activeSession.sftpPath,
              name,
            });
          }
        }}
        onSubmitRename={(entry, newName) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_rename", {
              sessionId: activeSession.id,
              oldPath: entry.path,
              newName,
            });
          }
        }}
        onSubmitChmod={(entry, mode) => {
          setActiveModal(null);
          if (activeSession) {
            void invoke("sftp_chmod", {
              sessionId: activeSession.id,
              path: entry.path,
              mode,
            });
          }
        }}
        onRespondHostKey={(promptId, accepted) => {
          setHostKeyPrompt(null);
          void invoke("respond_host_key", { promptId, accepted });
        }}
      />
    </div>
  );
}
