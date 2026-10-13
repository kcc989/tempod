import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProcNetTcp, PortScanner, previewPorts } from "../src/ports.ts";
import { cleanupDirs, tmpDir } from "./helpers.ts";

afterAll(cleanupDirs);

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1B9E 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0BB8 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 1003 1 0000000000000000 20 4 30 10 -1
   3: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1004 1 0000000000000000 100 0 0 10 0
   4: 0100007F:E4A1 0100007F:0BB8 06 00000000:00000000 03:00000F9B 00000000     0        0 0 3 0000000000000000
`;

const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2001 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2002 1 0000000000000000 100 0 0 10 0
   2: 00000000000000000000000000000000:FFFF 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2003 1 0000000000000000 100 0 0 10 0
`;

describe("/proc/net/tcp parsing", () => {
  test("finds LISTEN sockets only", () => {
    expect(parseProcNetTcp(TCP).sort((a, b) => a - b)).toEqual([80, 3000, 7070]);
    expect(parseProcNetTcp(TCP6).sort((a, b) => a - b)).toEqual([3000, 8000, 65535]);
  });
  test("handles empty and malformed input", () => {
    expect(parseProcNetTcp("")).toEqual([]);
    expect(parseProcNetTcp("header only\n")).toEqual([]);
    expect(parseProcNetTcp("h\n garbage line\n 0: nocolon 0 0A\n")).toEqual([]);
  });
  test("preview ports: 1024 to 65535, without 7070, deduplicated and sorted", () => {
    expect(previewPorts([TCP, TCP6], [7070])).toEqual([3000, 8000, 65535]);
  });
});

describe("port scanner", () => {
  test("emits on the first scan and then only when the set changes; missing files are quiet", () => {
    const dir = tmpDir();
    const file = join(dir, "tcp");
    writeFileSync(file, TCP);
    const seen: number[][] = [];

    const scanner = new PortScanner({
      intervalMs: 60_000,
      exclude: () => [7070],
      onChange: (p) => seen.push(p),
      files: [file, join(dir, "missing-tcp6")],
    });

    scanner.scan();
    scanner.scan();
    expect(seen).toEqual([[3000]]);
    writeFileSync(file, TCP.replace("0BB8 00000000:0000 0A", "0BB9 00000000:0000 0A"));
    scanner.scan();
    expect(seen).toEqual([[3000], [3001]]);
  });
  test("real /proc/net/tcp sees a Bun listener", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });

    try {
      const seen: number[][] = [];

      const scanner = new PortScanner({
        intervalMs: 60_000,
        exclude: () => [7070],
        onChange: (p) => seen.push(p),
      });

      scanner.scan();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(server.port!);
    } finally {
      await server.stop(true);
    }
  });
});
