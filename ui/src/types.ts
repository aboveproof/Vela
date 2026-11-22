export type ThemeId = "obsidian" | "catppuccin_mocha" | "tokyo_night" | "nord";
export type CursorStyle = "beam" | "block" | "underline";
export type SftpDockPosition = "left" | "right" | "bottom" | "top";
export type SidebarTab = "hosts" | "sftp" | "snippets" | "tunnels" | "keys" | "settings";

export interface AppSettings {
  theme_id: ThemeId;
  terminal_font: string | null;
  terminal_font_size: number;
  cursor_style: CursorStyle;
  scrollback_lines: number;
  copy_on_select: boolean;
  right_click_paste: boolean;
  show_hidden_files: boolean;
  follow_terminal_folder: boolean;
  remote_monitoring: boolean;
  sftp_position: SftpDockPosition;
}

export type AuthMethod =
  | { type: "password" }
  | { type: "private_key"; path: string }
  | { type: "agent" };

export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  folder?: string | null;
  default_remote_path?: string | null;
  keepalive_secs: number;
  bookmarks: string[];
}

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  permissions: number;
  modified_epoch?: number | null;
}

export interface DiskUsage {
  mount: string;
  used_pct: number;
}

export interface ServerStats {
  hostname: string;
  cpu_percent: number;
  mem_used_gb: number;
  mem_total_gb: number;
  net_tx_mbps: number;
  net_rx_mbps: number;
  uptime_text: string;
  users_count: number;
  disks: DiskUsage[];
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  folder?: string | null;
  auto_execute: boolean;
}

export interface SshKeyInfo {
  name: string;
  private_path: string;
  public_path: string;
  public_key: string;
  fingerprint: string;
  key_type: string;
}

export interface TunnelInfo {
  id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  active_connections: number;
}

export interface FilePreview {
  path: string;
  name: string;
  content: string;
  truncated: boolean;
  size: number;
}

export interface SessionTab {
  id: string;
  profileId?: string;
  title: string;
  address: string;
  state: "connecting" | "connected" | "disconnected";
  sftpPath: string;
  sftpEntries: RemoteEntry[];
  stats: ServerStats | null;
  cpuHistory: number[];
  tunnels: TunnelInfo[];
}

export interface HostKeyPrompt {
  prompt_id: string;
  session_id: string;
  host: string;
  port: number;
  status:
    | { kind: "unknown"; fingerprint: string }
    | { kind: "mismatch"; expected: string; actual: string }
    | { kind: "trusted" };
}

export interface ToastItem {
  id: string;
  title: string;
  detail?: string;
  kind: "info" | "error";
}

export interface ThemeTokens {
  label: string;
  bgBase: string;
  bgSurface: string;
  bgElevated: string;
  border: string;
  textPrimary: string;
  textMuted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  termBg: string;
  termFg: string;
  cursor: string;
  selection: string;
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export const THEMES: Record<ThemeId, ThemeTokens> = {
  obsidian: {
    label: "Vela Obsidian",
    bgBase: "#121315",
    bgSurface: "#18191c",
    bgElevated: "#23252a",
    border: "#2c2f36",
    textPrimary: "#e4e6ea",
    textMuted: "#8a8f98",
    accent: "#a4aebe",
    success: "#62b87e",
    warning: "#d4a74a",
    danger: "#d66068",
    termBg: "#101113",
    termFg: "#e0e2e6",
    cursor: "#e4e6ea",
    selection: "#38404e",
    ansi: {
      black: "#282a30",
      red: "#d66068",
      green: "#62b87e",
      yellow: "#dab258",
      blue: "#689ad4",
      magenta: "#b280ce",
      cyan: "#5cb2ba",
      white: "#c8ccd4",
      brightBlack: "#626872",
      brightRed: "#e87a80",
      brightGreen: "#7cce94",
      brightYellow: "#ecc670",
      brightBlue: "#84b2e8",
      brightMagenta: "#c69ae0",
      brightCyan: "#76cad2",
      brightWhite: "#eef0f4",
    },
  },
  catppuccin_mocha: {
    label: "Catppuccin Mocha",
    bgBase: "#11111b",
    bgSurface: "#181825",
    bgElevated: "#232334",
    border: "#313244",
    textPrimary: "#cdd6f4",
    textMuted: "#9399b2",
    accent: "#89b4fa",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
    termBg: "#14141f",
    termFg: "#cdd6f4",
    cursor: "#f5e0dc",
    selection: "#45475a",
    ansi: {
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  tokyo_night: {
    label: "Tokyo Night",
    bgBase: "#16161e",
    bgSurface: "#1a1b26",
    bgElevated: "#24283b",
    border: "#343b58",
    textPrimary: "#c0caf5",
    textMuted: "#787c99",
    accent: "#7aa2f7",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    termBg: "#1a1b26",
    termFg: "#c0caf5",
    cursor: "#c0caf5",
    selection: "#33467c",
    ansi: {
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  nord: {
    label: "Nord",
    bgBase: "#242933",
    bgSurface: "#2e3440",
    bgElevated: "#3b4252",
    border: "#4c566a",
    textPrimary: "#eceff4",
    textMuted: "#93a1b5",
    accent: "#88c0d0",
    success: "#a3be8c",
    warning: "#ebcb8b",
    danger: "#bf616a",
    termBg: "#2e3440",
    termFg: "#d8dee9",
    cursor: "#d8dee9",
    selection: "#434c5e",
    ansi: {
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
};

export function formatBytes(bytes: number, isDir: boolean): string {
  if (isDir) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${bytes} B` : `${val.toFixed(1)} ${units[idx]}`;
}
