import { readFileSync } from "node:fs";

const LISTEN = "0A";

/** Ports of LISTEN sockets in a /proc/net/tcp or /proc/net/tcp6 file. */
export const parseProcNetTcp = (text: string): number[] => {
  const ports = new Set<number>();
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[1]!;
    if (fields[3]!.toUpperCase() !== LISTEN) continue;
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const port = parseInt(local.slice(colon + 1), 16);
    if (Number.isFinite(port)) ports.add(port);
  }
  return [...ports];
};

/** Preview ports: 1024 to 65535, without tempod's own ports, sorted. */
export const previewPorts = (texts: ReadonlyArray<string>, exclude: ReadonlyArray<number>): number[] => {
  const all = new Set<number>();
  for (const t of texts) for (const p of parseProcNetTcp(t)) all.add(p);
  return [...all].filter((p) => p >= 1024 && p <= 65535 && !exclude.includes(p)).sort((a, b) => a - b);
};

const readQuiet = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

export class PortScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: string | null = null;

  constructor(
    private readonly opts: {
      intervalMs: number;
      exclude: () => ReadonlyArray<number>;
      onChange: (ports: number[]) => void;
      files?: ReadonlyArray<string>;
    },
  ) {}

  scan(): void {
    const files = this.opts.files ?? ["/proc/net/tcp", "/proc/net/tcp6"];
    const ports = previewPorts(files.map(readQuiet), this.opts.exclude());
    const key = ports.join(",");
    if (key === this.last) return;
    this.last = key;
    this.opts.onChange(ports);
  }

  start(): void {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.last = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
