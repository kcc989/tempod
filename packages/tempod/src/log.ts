import { redact, type LogLevel } from "@tempo/protocol";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type LogData = Record<string, unknown>;
export type LogSink = (level: LogLevel, msg: string, data: LogData | undefined) => void;

/** JSON lines on stderr, always through the redact helper. `warn` and up also go to `onEvent`. */
export class Logger {
  private readonly write: (line: string) => void;
  private readonly minLevel: number;
  private sink: LogSink | undefined;
  private early: Array<[LogLevel, string, LogData | undefined]> = [];

  constructor(opts: { write?: (line: string) => void; minLevel?: LogLevel } = {}) {
    this.write = opts.write ?? ((line) => process.stderr.write(line + "\n"));
    this.minLevel = ORDER[opts.minLevel ?? "info"];
  }

  /** Where `warn` and up go as `log` events; warnings logged before this are delivered now. */
  set onEvent(sink: LogSink | undefined) {
    this.sink = sink;
    if (!sink) return;
    for (const [level, msg, data] of this.early.splice(0)) sink(level, msg, data);
  }

  log(level: LogLevel, msg: string, data?: LogData): void {
    const clean = data === undefined ? undefined : (redact(data) as LogData);
    if (ORDER[level] >= this.minLevel) {
      try {
        this.write(JSON.stringify({ ts: Date.now(), level, msg, ...clean }));
      } catch {
        // stderr closed; nothing else to do
      }
    }
    if (ORDER[level] < ORDER.warn) return;
    if (!this.sink) {
      if (this.early.length < 100) this.early.push([level, msg, clean]);
      return;
    }
    try {
      this.sink(level, msg, clean);
    } catch {
      // never let logging break the caller
    }
  }

  debug(msg: string, data?: LogData): void {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: LogData): void {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: LogData): void {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: LogData): void {
    this.log("error", msg, data);
  }
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
