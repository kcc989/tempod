export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};

export const formatRelative = (at: number, now: number = Date.now()): string => {
  const diff = Math.max(0, now - at);
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(at).toLocaleDateString();
};

export const formatTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const formatDateTime = (at: number): string =>
  new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;
};

export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Script output is shown as plain text: strip ANSI escapes and carriage-return redraws. */
export const stripAnsi = (s: string): string =>
  s
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      const i = line.lastIndexOf("\r");
      return i >= 0 && i < line.length - 1 ? line.slice(i + 1) : line.replace(/\r$/, "");
    })
    .join("\n");

/** FNV-1a 32-bit, as hex. Used for the `Mark as viewed` diff hash. */
export const hashString = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

export const pluralize = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
