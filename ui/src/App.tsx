import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Cable,
  Code2,
  Columns2,
  Folder,
  KeyRound,
  Palette,
  Radio,
  Server,
  Settings,
  Terminal,
} from "lucide-react";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { ContextMenu, type ContextMenuState } from "./components/ContextMenu";
import { FilePreviewModal } from "./components/FilePreviewModal";
import { HostsPanel, type QuickFormValues } from "./components/HostsPanel";
import { KeysPanel } from "./components/KeysPanel";
import { Modals, type ActiveModal } from "./components/Modals";
import { MonitorStrip } from "./components/MonitorStrip";
import { SettingsPanel } from "./components/SettingsPanel";
import { SftpSidebar } from "./components/SftpSidebar";
import { SnippetsPanel } from "./components/SnippetsPanel";
import { TerminalPane, type TerminalPaneHandle } from "./components/TerminalPane";
import { Titlebar } from "./components/Titlebar";
import { Toasts } from "./components/Toasts";
import { TunnelsPanel } from "./components/TunnelsPanel";
import {
  THEMES,
  type AppSettings,
  type FilePreview,
  type HostKeyPrompt,
  type HostProfile,
  type RemoteEntry,
  type ServerStats,
  type SessionTab,
  type SftpDockPosition,
  type SidebarTab,
  type Snippet,
  type SshKeyInfo,
  type ThemeId,
  type ToastItem,
  type TunnelInfo,
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
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKeyInfo[]>([]);
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [splitSessionId, setSplitSessionId] = useState<string | null>(null);
  const [broadcastEnabled, setBroadcastEnabled] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("hosts");
  const [focusHostField, setFocusHostField] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(296);
  const [sftpDockHeight, setSftpDockHeight] = useState(300);
  const [quickConnect, setQuickConnect] = useState("");
  const [form, setForm] = useState<QuickFormValues>(EMPTY_FORM);
  const [selectedSftpPath, setSelectedSftpPath] = useState<string | null>(null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);
  const [hostKeyPrompts, setHostKeyPrompts] = useState<HostKeyPrompt[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const termRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());
  const ptyWritersRef = useRef<Map<string, (bytes: Uint8Array) => void>>(new Map());
  const ptyBuffersRef = useRef<Map<string, Uint8Array[]>>(new Map());
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const broadcastRef = useRef(broadcastEnabled);
  broadcastRef.current = broadcastEnabled;

  const theme = THEMES[settings.theme_id] ?? THEMES.obsidian;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeProfile = activeSession?.profileId
    ? profiles.find((p) => p.id === activeSession.profileId) ?? null
    : null;
  const totalTunnels = sessions.reduce((acc, s) => acc + s.tunnels.length, 0);
  const connectedSessions = sessions.filter((s) => s.state === "connected");

  const pushToast = useCallback(
    (title: string, kind: "info" | "error" = "info", detail?: string) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev.slice(-3), { id, title, detail, kind }]);
      window.setTimeout(
        () => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        },
        kind === "error" ? 6000 : 3200,
      );
    },
    [],
  );

  const persistSettings = useCallback(
    (next: AppSettings) => {
      setSettings(next);
      void invoke("save_settings", { settings: next }).catch((err: unknown) => {
        pushToast("Failed to save settings", "error", String(err));
      });
    },
    [pushToast],
  );

  const refreshSshKeys = useCallback(() => {
    void invoke<SshKeyInfo[]>("list_ssh_keys")
      .then(setSshKeys)
      .catch((err: unknown) => pushToast("Failed to scan SSH keys", "error", String(err)));
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

  // Load initial profiles, snippets, SSH keys, and settings from Rust backend.
  useEffect(() => {
    void invoke<AppSettings>("get_settings").then(setSettings);
    void invoke<HostProfile[]>("list_profiles")
      .then(setProfiles)
      .catch((err: unknown) => pushToast("Failed to load hosts", "error", String(err)));
    void invoke<Snippet[]>("list_snippets")
      .then(setSnippets)
      .catch((err: unknown) => pushToast("Failed to load snippets", "error", String(err)));
    refreshSshKeys();
  }, [pushToast, refreshSshKeys]);

  // Clear SFTP selection when switching tabs or directories.
  useEffect(() => {
    setSelectedSftpPath(null);
  }, [activeSessionId, activeSession?.sftpPath]);

  useEffect(() => {
    if (!focusHostField || !sidebarOpen || sidebarTab !== "hosts") return;
    document.querySelector<HTMLInputElement>('.vela-sidebar input[aria-label="Host address"]')?.focus();
    setFocusHostField(false);
  }, [focusHostField, sidebarOpen, sidebarTab]);

  // Turn off split/broadcast if session count drops below 2.
  useEffect(() => {
    if (sessions.filter((s) => s.state === "connected").length < 2) {
      setSplitSessionId(null);
      setBroadcastEnabled(false);
    } else if (splitSessionId && !sessions.some((s) => s.id === splitSessionId)) {
      setSplitSessionId(null);
    }
  }, [sessions, splitSessionId]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  // Global keyboard shortcuts (Ctrl+B sidebar, Ctrl+K / Ctrl+Shift+P command palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (
        (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "k") ||
        (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p")
      ) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Subscribe to Rust push events with StrictMode-safe cancellation.
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

    sub<{ session_id: string; tunnels: TunnelInfo[] }>(
      "vela://tunnels",
      ({ session_id, tunnels }) => {
        setSessions((prev) => prev.map((s) => (s.id === session_id ? { ...s, tunnels } : s)));
      },
    );

    sub<{ session_id: string; preview: FilePreview }>("vela://preview", ({ preview: p }) => {
      setPreview(p);
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

  const connectProfile = useCallback(
    async (profileId: string) => {
      const profile = profiles.find((p) => p.id === profileId);
      const sessionId = crypto.randomUUID();
      const tab: SessionTab = {
        id: sessionId,
        profileId,
        title: profile?.name ?? "Connecting...",
        address: profile
          ? `${profile.username}@${profile.host}${profile.port !== 22 ? `:${profile.port}` : ""}`
          : "",
        state: "connecting",
        sftpPath: "/",
        sftpEntries: [],
        stats: null,
        cpuHistory: [],
        tunnels: [],
      };

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
    },
    [profiles, pushToast],
  );

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

  const handleImportSshConfig = async () => {
    try {
      const imported = await invoke<HostProfile[]>("import_ssh_config");
      if (imported.length === 0) {
        pushToast("No new hosts found in ~/.ssh/config", "info");
      } else {
        setProfiles((prev) => [...prev, ...imported]);
        pushToast(`Imported ${imported.length} host(s) from ~/.ssh/config`, "info");
      }
    } catch (err) {
      pushToast("Import failed", "error", String(err));
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
    if (splitSessionId === id) setSplitSessionId(null);
    if (activeSessionIdRef.current === id) {
      setActiveSessionId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  };

  const handleToggleSplit = useCallback(() => {
    if (splitSessionId) {
      setSplitSessionId(null);
      return;
    }
    const other = sessions.find((s) => s.id !== activeSessionId);
    if (other) {
      setSplitSessionId(other.id);
    }
  }, [splitSessionId, sessions, activeSessionId]);

  const handleRunSnippet = useCallback(
    (snippet: Snippet, broadcast: boolean) => {
      const payload = snippet.auto_execute ? `${snippet.command}\r` : snippet.command;
      const targets = broadcast
        ? sessionsRef.current.filter((s) => s.state === "connected").map((s) => s.id)
        : activeSessionIdRef.current
          ? [activeSessionIdRef.current]
          : [];
      for (const sid of targets) {
        void invoke("send_pty_input", { sessionId: sid, data: payload });
      }
      if (activeSessionIdRef.current) {
        termRefs.current.get(activeSessionIdRef.current)?.focus();
      }
    },
    [],
  );

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

  // Command Palette items
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    for (const p of profiles) {
      items.push({
        id: `host:${p.id}`,
        group: "Connect to Host",
        label: p.name,
        subtitle: `${p.username}@${p.host}${p.port !== 22 ? `:${p.port}` : ""}`,
        icon: <Server className="h-3.5 w-3.5" />,
        onSelect: () => void connectProfile(p.id),
      });
    }

    if (activeSession) {
      for (const s of snippets) {
        items.push({
          id: `snippet:${s.id}`,
          group: "Run Snippet",
          label: s.name,
          subtitle: s.command,
          icon: <Code2 className="h-3.5 w-3.5" />,
          onSelect: () => handleRunSnippet(s, false),
        });
      }
    }

    items.push(
      {
        id: "act:sidebar",
        group: "Workspace",
        label: sidebarOpen ? "Hide Sidebar" : "Show Sidebar",
        shortcut: "Ctrl+B",
        icon: <Folder className="h-3.5 w-3.5" />,
        onSelect: () => setSidebarOpen((v) => !v),
      },
      {
        id: "act:files",
        group: "Workspace",
        label: "Open remote files",
        icon: <Folder className="h-3.5 w-3.5" />,
        onSelect: () => { setSidebarTab("sftp"); setSidebarOpen(true); },
      },
      {
        id: "act:tunnels",
        group: "Workspace",
        label: "Open Port Forwarding / Tunnels",
        icon: <Cable className="h-3.5 w-3.5" />,
        onSelect: () => {
          setSidebarTab("tunnels");
          setSidebarOpen(true);
        },
      },
      {
        id: "act:keys",
        group: "Workspace",
        label: "Open SSH Key Manager",
        icon: <KeyRound className="h-3.5 w-3.5" />,
        onSelect: () => {
          setSidebarTab("keys");
          setSidebarOpen(true);
        },
      },
      {
        id: "act:snippets",
        group: "Workspace",
        label: "Open Saved Snippets",
        icon: <Code2 className="h-3.5 w-3.5" />,
        onSelect: () => {
          setSidebarTab("snippets");
          setSidebarOpen(true);
        },
      },
      {
        id: "act:settings",
        group: "Workspace",
        label: "Open Settings",
        icon: <Settings className="h-3.5 w-3.5" />,
        onSelect: () => {
          setSidebarTab("settings");
          setSidebarOpen(true);
        },
      },
    );

    for (const position of ["left", "right", "bottom", "top"] as SftpDockPosition[]) {
      items.push({
        id: `dock:${position}`,
        group: "Remote files",
        label: `Dock file browser ${position}`,
        icon: <Folder className="h-3.5 w-3.5" />,
        onSelect: () => {
          persistSettings({ ...settings, sftp_position: position });
          setSidebarTab("sftp");
          setSidebarOpen(true);
        },
      });
    }

    if (connectedSessions.length > 1) {
      items.push(
        {
          id: "act:split",
          group: "Workspace",
          label: splitSessionId ? "Close Split View" : "Split View Side-by-Side",
          icon: <Columns2 className="h-3.5 w-3.5" />,
          onSelect: handleToggleSplit,
        },
        {
          id: "act:broadcast",
          group: "Workspace",
          label: broadcastEnabled ? "Disable Broadcast Input" : "Enable Broadcast Input (All Tabs)",
          icon: <Radio className="h-3.5 w-3.5" />,
          onSelect: () => setBroadcastEnabled((v) => !v),
        },
      );
    }

    if (activeSession) {
      items.push({
        id: "act:find",
        group: "Terminal",
        label: "Find in Terminal",
        shortcut: "Ctrl+Shift+F",
        icon: <Terminal className="h-3.5 w-3.5" />,
        onSelect: () => termRefs.current.get(activeSession.id)?.openFind(),
      });
    }

    for (const id of Object.keys(THEMES) as ThemeId[]) {
      items.push({
        id: `theme:${id}`,
        group: "Themes",
        label: `Switch Theme: ${THEMES[id].label}`,
        icon: <Palette className="h-3.5 w-3.5" />,
        onSelect: () => persistSettings({ ...settings, theme_id: id }),
      });
    }

    return items;
  }, [
    profiles,
    snippets,
    activeSession,
    sidebarOpen,
    connectedSessions.length,
    splitSessionId,
    broadcastEnabled,
    settings,
    connectProfile,
    handleRunSnippet,
    handleToggleSplit,
    persistSettings,
  ]);

  // SFTP actions
  const selectedEntry =
    activeSession?.sftpEntries.find((e) => e.path === selectedSftpPath) ?? null;

  const sftpOpenEntry = (entry: RemoteEntry) => {
    if (!activeSession) return;
    void invoke("sftp_open_entry", { sessionId: activeSession.id, path: entry.path }).catch(
      (err: unknown) => pushToast("Failed to open entry", "error", String(err)),
    );
  };

  const sftpPreviewEntry = (entry: RemoteEntry) => {
    if (!activeSession) return;
    void invoke("sftp_read_preview", { sessionId: activeSession.id, path: entry.path }).catch(
      (err: unknown) => pushToast("Preview failed", "error", String(err)),
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
    termRefs.current.get(activeSession.id)?.pasteText(shellQuote(entry.path));
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

  const startResizeSidebar = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeCleanupRef.current?.();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = sidebarRef.current?.clientWidth ?? sidebarWidth;
    const startH = sidebarRef.current?.clientHeight ?? sftpDockHeight;
    const isRight = sidebarTab === "sftp" && settings.sftp_position === "right";
    const isBottom = sidebarTab === "sftp" && settings.sftp_position === "bottom";
    const availableWidth = workspaceRef.current?.clientWidth ?? window.innerWidth - 60;
    const availableHeight = workspaceRef.current?.clientHeight ?? window.innerHeight - 90;
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      if (horizontalDock) {
        const delta = isBottom ? startY - ev.clientY : ev.clientY - startY;
        setSftpDockHeight(Math.max(180, Math.min(520, availableHeight - 140, startH + delta)));
      } else {
        const delta = isRight ? startX - ev.clientX : ev.clientX - startX;
        setSidebarWidth(Math.max(220, Math.min(520, availableWidth - 300, startW + delta)));
      }
    };
    const cleanup = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  };

  const horizontalDock =
    sidebarOpen &&
    sidebarTab === "sftp" &&
    (settings.sftp_position === "top" || settings.sftp_position === "bottom");

  const dockAtEnd = sidebarTab === "sftp" &&
    (settings.sftp_position === "right" || settings.sftp_position === "bottom");

  const sidebarTitles: Record<SidebarTab, string> = {
    hosts: "Connections",
    sftp: "Remote files",
    snippets: "Snippets",
    tunnels: "Port forwarding",
    keys: "SSH keys",
    settings: "Settings",
  };

  const sidebarEl = (
    <div
      ref={sidebarRef}
      className={`vela-sidebar flex min-h-0 min-w-0 shrink-0 flex-col gap-2.5 overflow-hidden rounded-xl border p-3 ${horizontalDock ? "vela-sidebar-horizontal" : ""}`}
      style={{
        width: horizontalDock ? "100%" : sidebarWidth,
        maxWidth: horizontalDock ? "100%" : "calc(100% - 300px)",
        height: horizontalDock ? sftpDockHeight : "100%",
        maxHeight: horizontalDock ? "calc(100% - 140px)" : "100%",
        backgroundColor: theme.bgSurface,
        borderColor: theme.border,
        order: dockAtEnd ? 3 : 1,
        display: sidebarOpen ? "flex" : "none",
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
            placeholder="Connect with user@host"
            aria-label="Quick connect by address or saved host"
            className="w-full rounded-xl border px-3 py-2.5 text-xs outline-none"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textPrimary,
            }}
          />
        </form>
      )}

      <div className="px-0.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: theme.textMuted }}>
        {sidebarTitles[sidebarTab]}
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
            onImportSshConfig={() => void handleImportSshConfig()}
          />
        )}
        {sidebarTab === "sftp" && (
          <SftpSidebar
            horizontal={horizontalDock}
            session={activeSession}
            bookmarks={activeProfile?.bookmarks ?? []}
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
            onToggleBookmark={(path) => {
              if (!activeSession?.profileId) return;
              const pid = activeSession.profileId;
              void invoke<string[]>("toggle_bookmark", { profileId: pid, path })
                .then((updated) => {
                  setProfiles((prev) =>
                    prev.map((p) => (p.id === pid ? { ...p, bookmarks: updated } : p)),
                  );
                })
                .catch((err: unknown) => pushToast("Bookmark failed", "error", String(err)));
            }}
            onToggleFollowCd={(v) => persistSettings({ ...settings, follow_terminal_folder: v })}
            onToggleMonitoring={(v) => persistSettings({ ...settings, remote_monitoring: v })}
            onSetDockPosition={(position) => persistSettings({ ...settings, sftp_position: position })}
            onMiddleClickEntry={sftpCopyPathToTerminal}
            onItemContextMenu={(entry, x, y) =>
              setContextMenu({ kind: "sftp_item", entry, x, y })
            }
            onBgContextMenu={(x, y) => setContextMenu({ kind: "sftp_bg", x, y })}
          />
        )}
        {sidebarTab === "snippets" && (
          <SnippetsPanel
            snippets={snippets}
            hasActiveSession={Boolean(activeSession)}
            sessionCount={connectedSessions.length}
            theme={theme}
            onRunSnippet={handleRunSnippet}
            onCreateSnippet={(name, command, autoExecute) => {
              void invoke<Snippet>("save_snippet", {
                name,
                command,
                folder: null,
                autoExecute,
              })
                .then((created) => {
                  setSnippets((prev) => [...prev, created]);
                  pushToast(`Saved snippet "${created.name}"`, "info");
                })
                .catch((err: unknown) => pushToast("Failed to save snippet", "error", String(err)));
            }}
            onDeleteSnippet={(snippetId) => {
              void invoke("delete_snippet", { snippetId })
                .then(() => setSnippets((prev) => prev.filter((s) => s.id !== snippetId)))
                .catch((err: unknown) =>
                  pushToast("Failed to delete snippet", "error", String(err)),
                );
            }}
          />
        )}
        {sidebarTab === "tunnels" && (
          <TunnelsPanel
            session={activeSession}
            theme={theme}
            onStartTunnel={(localPort, remoteHost, remotePort) => {
              if (!activeSession) return;
              void invoke("start_local_tunnel", {
                sessionId: activeSession.id,
                localPort,
                remoteHost,
                remotePort,
              }).catch((err: unknown) => pushToast("Tunnel failed", "error", String(err)));
            }}
            onStopTunnel={(tunnelId) => {
              if (!activeSession) return;
              void invoke("stop_local_tunnel", {
                sessionId: activeSession.id,
                tunnelId,
              }).catch((err: unknown) => pushToast("Stop tunnel failed", "error", String(err)));
            }}
            onCopyAddress={(addr) => {
              void navigator.clipboard.writeText(addr);
              pushToast(`Copied ${addr}`, "info");
            }}
          />
        )}
        {sidebarTab === "keys" && (
          <KeysPanel
            keys={sshKeys}
            hasActiveSession={Boolean(activeSession)}
            activeHostLabel={activeSession?.title}
            theme={theme}
            onRefresh={refreshSshKeys}
            onGenerateKey={(name, comment) => {
              void invoke<SshKeyInfo>("generate_ssh_key", { name, comment })
                .then((created) => {
                  setSshKeys((prev) => [...prev, created]);
                  pushToast(`Generated Ed25519 key ${created.name}`, "info");
                })
                .catch((err: unknown) => pushToast("Key generation failed", "error", String(err)));
            }}
            onCopyPublicKey={(pubKey) => {
              void navigator.clipboard.writeText(pubKey);
              pushToast("Copied public key", "info");
            }}
            onDeployKey={(publicKey) => {
              if (!activeSession) return;
              void invoke("deploy_public_key", {
                sessionId: activeSession.id,
                publicKey,
              }).catch((err: unknown) => pushToast("Key deploy failed", "error", String(err)));
            }}
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

  const resizeHandle = (
    <div
      role="separator"
      aria-label={horizontalDock ? "Resize file browser height" : "Resize sidebar width"}
      aria-orientation={horizontalDock ? "horizontal" : "vertical"}
      aria-valuemin={horizontalDock ? 180 : 220}
      aria-valuemax={horizontalDock ? 520 : 520}
      aria-valuenow={horizontalDock ? sidebarRef.current?.clientHeight ?? sftpDockHeight : sidebarRef.current?.clientWidth ?? sidebarWidth}
      tabIndex={sidebarOpen ? 0 : -1}
      onPointerDown={startResizeSidebar}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 60 : 20;
        if (e.key === "Home") {
          e.preventDefault();
          if (horizontalDock) setSftpDockHeight(300);
          else setSidebarWidth(296);
        } else if (horizontalDock && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          const direction = (settings.sftp_position === "bottom" ? e.key === "ArrowUp" : e.key === "ArrowDown") ? 1 : -1;
          setSftpDockHeight((height) => Math.max(180, Math.min(520, height + step * direction)));
        } else if (!horizontalDock && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          const direction = (settings.sftp_position === "right" && sidebarTab === "sftp" ? e.key === "ArrowLeft" : e.key === "ArrowRight") ? 1 : -1;
          setSidebarWidth((width) => Math.max(220, Math.min(520, width + step * direction)));
        }
      }}
      onDoubleClick={() => horizontalDock ? setSftpDockHeight(300) : setSidebarWidth(296)}
      className={`vela-resize-handle shrink-0 ${horizontalDock ? "h-2 w-full cursor-row-resize" : "h-full w-2 cursor-col-resize"}`}
      style={{ order: 2, display: sidebarOpen ? "block" : "none" }}
      title="Drag to resize; double-click to reset"
    />
  );

  const terminalArea = (
    <div className="vela-workspace flex min-h-0 min-w-0 flex-1 flex-col p-1" style={{ order: dockAtEnd ? 1 : 3 }}>
      <div
        className={`vela-terminal-shell relative flex min-h-0 flex-1 overflow-hidden rounded-2xl border ${splitSessionId ? "divide-x" : ""}`}
        style={{ backgroundColor: theme.termBg, borderColor: theme.border }}
      >
        {sessions.length === 0 ? (
          <div className="vela-empty flex h-full w-full flex-col items-center justify-center px-6 text-center">
            <div className="vela-empty-mark mb-7 flex h-16 w-16 items-center justify-center rounded-2xl border" style={{ borderColor: theme.border, backgroundColor: theme.bgElevated }}>
              <Terminal className="h-7 w-7" strokeWidth={1.5} style={{ color: theme.accent }} />
            </div>
            <h1 className="text-[25px] font-semibold tracking-[-0.045em]" style={{ color: theme.textPrimary }}>Connect to a host</h1>
            <p className="mt-2 max-w-sm text-[13px] leading-6" style={{ color: theme.textMuted }}>
              Add a connection or import your SSH config. The terminal and remote files open together.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
              <button className="vela-empty-action rounded-xl px-4 py-2.5 text-xs font-semibold" style={{ color: theme.bgBase, backgroundColor: theme.textPrimary }} onClick={() => { setSidebarTab("hosts"); setSidebarOpen(true); setFocusHostField(true); }}>Add connection</button>
              <button className="rounded-xl border px-4 py-2.5 text-xs font-medium" style={{ borderColor: theme.border, color: theme.textPrimary, backgroundColor: theme.bgElevated }} onClick={() => void handleImportSshConfig()}>Import SSH config</button>
            </div>
            <p className="mt-8 text-[11px]" style={{ color: theme.textMuted }}>Press <kbd className="rounded-md border px-1.5 py-1" style={{ borderColor: theme.border, backgroundColor: theme.bgElevated }}>Ctrl K</kbd> to find a command</p>
          </div>
        ) : (
          sessions.map((s) => {
            const isVisible = s.id === activeSessionId || s.id === splitSessionId;
            return (
              <div
                key={s.id}
                onMouseDown={() => {
                  if (s.id !== activeSessionId) setActiveSessionId(s.id);
                }}
                className={isVisible ? "relative min-h-0 min-w-0 flex-1" : "hidden"}
                style={{ borderColor: theme.border }}
              >
                <TerminalPane
                  ref={(handle) => {
                    if (handle) termRefs.current.set(s.id, handle);
                    else termRefs.current.delete(s.id);
                  }}
                  sessionId={s.id}
                  active={isVisible}
                  settings={settings}
                  theme={theme}
                  registerPtyWriter={registerPtyWriter}
                  drainBufferedPty={drainBufferedPty}
                  onOsc7Path={(path) => {
                    const live = sessionsRef.current.find((x) => x.id === s.id);
                    if (
                      settingsRef.current.follow_terminal_folder &&
                      live &&
                      path !== live.sftpPath
                    ) {
                      void invoke("sftp_list_dir", { sessionId: s.id, path });
                    }
                  }}
                  onContextMenu={(x, y) => {
                    setActiveSessionId(s.id);
                    setContextMenu({ kind: "terminal", x, y });
                  }}
                  onAutoCopied={() => pushToast("Copied selection", "info")}
                  onSaveTranscript={saveActiveTranscript}
                  onSendData={(data) => {
                    if (broadcastRef.current) {
                      for (const sess of sessionsRef.current.filter((item) => item.state === "connected")) {
                        void invoke("send_pty_input", { sessionId: sess.id, data });
                      }
                    } else {
                      void invoke("send_pty_input", { sessionId: s.id, data });
                    }
                  }}
                />
              </div>
            );
          })
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

  const railBtn = (
    tab: SidebarTab,
    Icon: typeof Server,
    title: string,
    badge?: number,
  ) => {
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
        aria-label={title}
        aria-pressed={active}
        className="vela-rail-button relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors hover:bg-white/8"
        style={{
          backgroundColor: active ? theme.bgElevated : "transparent",
          color: active ? theme.textPrimary : theme.textMuted,
        }}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
        {badge !== undefined && badge > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums"
            style={{ backgroundColor: theme.success, color: theme.bgBase }}
          >
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      className="vela-app flex h-screen w-screen flex-col overflow-hidden"
      style={{ backgroundColor: theme.bgBase, color: theme.textPrimary, "--vela-border": theme.border, "--vela-surface": theme.bgSurface, "--vela-elevated": theme.bgElevated, "--vela-accent": theme.accent, "--vela-muted": theme.textMuted } as React.CSSProperties}
    >
      <Titlebar
        sessions={sessions}
        connectedCount={connectedSessions.length}
        activeSessionId={activeSessionId}
        splitSessionId={splitSessionId}
        broadcastEnabled={broadcastEnabled}
        theme={theme}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onSelectTab={setActiveSessionId}
        onCloseTab={handleCloseTab}
        onNewTab={() => {
          setSidebarTab("hosts");
          setSidebarOpen(true);
        }}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleSplit={handleToggleSplit}
        onToggleBroadcast={() => setBroadcastEnabled((v) => !v)}
      />

      <div className="flex min-h-0 flex-1 gap-1.5 p-1.5 pl-0">
        <div
          className="vela-rail flex w-[60px] shrink-0 flex-col items-center gap-1.5 border-r py-4"
          style={{ backgroundColor: theme.bgBase, borderColor: theme.border }}
        >
          {railBtn("hosts", Server, "Sessions")}
          {railBtn("sftp", Folder, "SFTP Browser")}
          {railBtn("snippets", Code2, "Saved Snippets")}
          {railBtn("tunnels", Cable, "Port forwarding", totalTunnels)}
          {railBtn("keys", KeyRound, "SSH Key Manager")}
          <div className="flex-1" />
          {railBtn("settings", Settings, "Settings")}
        </div>

        <div
          ref={workspaceRef}
          className={`flex min-h-0 min-w-0 flex-1 gap-0.5 ${horizontalDock ? "flex-col" : "flex-row"}`}
        >
          {/* Keep these siblings mounted in the same order. Remounting TerminalPane loses xterm scrollback. */}
          {sidebarEl}
          {resizeHandle}
          {terminalArea}
        </div>
      </div>

      <div
        className="vela-status flex h-8 shrink-0 items-center justify-between border-t px-4 text-[11px]"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
          color: theme.textMuted,
        }}
      >
        <span className="truncate">
          {activeSession
            ? `${activeSession.state === "connected" ? "Connected" : activeSession.state === "connecting" ? "Connecting…" : "Disconnected"}  ·  ${activeSession.address}  ·  ${activeSession.sftpPath}`
            : "Ready  ·  Ctrl+K: commands  ·  Ctrl+B: sidebar"}
        </span>
        {broadcastEnabled && (
          <span className="shrink-0 font-medium" style={{ color: theme.warning }}>
            Broadcasting to {connectedSessions.length} terminals
          </span>
        )}
      </div>

      <Toasts
        toasts={toasts}
        theme={theme}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />

      <CommandPalette
        open={paletteOpen}
        theme={theme}
        items={paletteItems}
        onClose={() => setPaletteOpen(false)}
      />

      <FilePreviewModal
        preview={preview}
        theme={theme}
        onClose={() => setPreview(null)}
        onEditLocally={(path) => {
          setPreview(null);
          if (activeSession) {
            void invoke("sftp_edit_locally", { sessionId: activeSession.id, remotePath: path });
          }
        }}
        onCopyContent={(content) => {
          void navigator.clipboard.writeText(content);
          pushToast("Copied file contents", "info");
        }}
      />

      <ContextMenu
        menu={contextMenu}
        sftpPosition={settings.sftp_position}
        theme={theme}
        onClose={() => setContextMenu(null)}
        onOpenEntry={sftpOpenEntry}
        onPreviewEntry={sftpPreviewEntry}
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
