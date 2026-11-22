import { useState } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw, Upload } from "lucide-react";
import type { SshKeyInfo, ThemeTokens } from "../types";

interface KeysPanelProps {
  keys: SshKeyInfo[];
  hasActiveSession: boolean;
  activeHostLabel?: string;
  theme: ThemeTokens;
  onRefresh: () => void;
  onGenerateKey: (name: string, comment: string) => void;
  onCopyPublicKey: (pubKey: string) => void;
  onDeployKey: (pubKey: string) => void;
}

function truncateFingerprint(fp: string): string {
  if (fp.length <= 28) return fp;
  return `${fp.slice(0, 18)}…${fp.slice(-8)}`;
}

export function KeysPanel({
  keys,
  hasActiveSession,
  activeHostLabel,
  theme,
  onRefresh,
  onGenerateKey,
  onCopyPublicKey,
  onDeployKey,
}: KeysPanelProps) {
  const [keyName, setKeyName] = useState("id_ed25519_vela");
  const [comment, setComment] = useState("vela@desktop");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const inputStyle = {
    backgroundColor: theme.bgBase,
    borderColor: theme.border,
    color: theme.textPrimary,
  };

  const canGenerate = keyName.trim().length > 0;

  const handleCopy = (keyInfo: SshKeyInfo) => {
    onCopyPublicKey(keyInfo.public_key);
    setCopiedPath(keyInfo.public_path);
    window.setTimeout(() => {
      setCopiedPath((cur) => (cur === keyInfo.public_path ? null : cur));
    }, 1400);
  };

  const handleGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canGenerate) return;
    onGenerateKey(keyName.trim(), comment.trim());
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5">
      {/* Header row */}
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className="text-[10px] font-medium uppercase tracking-wider"
            style={{ color: theme.textMuted }}
          >
            ~/.ssh Keys
          </span>
          <span
            className="rounded border px-1.5 py-0.5 text-[10px] tabular-nums"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textMuted,
            }}
          >
            {keys.length}
          </span>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          title="Rescan ~/.ssh directory"
          className="vela-focus flex h-6 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors hover:bg-white/5"
          style={{
            borderColor: theme.border,
            color: theme.textMuted,
          }}
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {/* Keys list */}
      <div className="space-y-2">
        {keys.length === 0 ? (
          <div
            className="rounded-xl border px-3 py-5 text-center text-xs"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textMuted,
            }}
          >
            <KeyRound className="mx-auto mb-1.5 h-4 w-4 opacity-60" />
            No public keys found in ~/.ssh. Generate one below.
          </div>
        ) : (
          keys.map((k) => {
            const isCopied = copiedPath === k.public_path;
            const badgeLabel = k.key_type.replace(/^ssh-/i, "").toUpperCase();
            return (
              <div
                key={k.public_path}
                className="rounded-xl border p-2.5"
                style={{
                  backgroundColor: theme.bgElevated,
                  borderColor: theme.border,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <KeyRound
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: theme.textMuted }}
                    />
                    <span
                      className="truncate text-xs font-medium"
                      style={{ color: theme.textPrimary }}
                      title={k.private_path}
                    >
                      {k.name}
                    </span>
                  </div>
                  <span
                    className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-medium tracking-wide"
                    style={{
                      backgroundColor: theme.bgBase,
                      borderColor: theme.border,
                      color: theme.accent,
                    }}
                  >
                    {badgeLabel}
                  </span>
                </div>

                <div
                  className="mt-1.5 truncate rounded-md border px-2 py-1 font-mono text-[10px]"
                  style={{
                    backgroundColor: theme.bgBase,
                    borderColor: theme.border,
                    color: theme.textMuted,
                  }}
                  title={k.fingerprint}
                >
                  {truncateFingerprint(k.fingerprint)}
                </div>

                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCopy(k)}
                    title="Copy public key to clipboard"
                    className="vela-focus flex flex-1 items-center justify-center gap-1 rounded-lg border py-1.5 text-[11px] font-medium transition-colors hover:bg-white/5"
                    style={{
                      borderColor: theme.border,
                      color: isCopied ? theme.success : theme.textPrimary,
                    }}
                  >
                    {isCopied ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {isCopied ? "Copied" : "Copy Pub"}
                  </button>

                  <button
                    type="button"
                    disabled={!hasActiveSession}
                    onClick={() => onDeployKey(k.public_key)}
                    title={
                      hasActiveSession
                        ? `Install key onto ${activeHostLabel ?? "active server"} (ssh-copy-id)`
                        : "Connect to a server to deploy this key"
                    }
                    className="vela-focus flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    style={{
                      backgroundColor: theme.textPrimary,
                      color: theme.bgBase,
                    }}
                  >
                    <Upload className="h-3 w-3" />
                    Deploy
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Generate Ed25519 Key form */}
      <form
        onSubmit={handleGenerate}
        className="mt-auto space-y-2 rounded-xl border p-3"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
        }}
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: theme.textPrimary }}>
          <Plus className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
          Generate Ed25519 Key
        </div>

        <div className="space-y-1">
          <label className="block text-[10px]" style={{ color: theme.textMuted }}>
            Filename (in ~/.ssh)
          </label>
          <input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="id_ed25519_vela"
            className="w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs outline-none"
            style={inputStyle}
          />
        </div>

        <div className="space-y-1">
          <label className="block text-[10px]" style={{ color: theme.textMuted }}>
            Comment
          </label>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="vela@desktop"
            className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
            style={inputStyle}
          />
        </div>

        <button
          type="submit"
          disabled={!canGenerate}
          className="vela-focus w-full rounded-lg py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            backgroundColor: theme.textPrimary,
            color: theme.bgBase,
          }}
        >
          Generate Keypair
        </button>
      </form>
    </div>
  );
}
