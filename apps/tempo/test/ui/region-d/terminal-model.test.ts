import { describe, expect, it } from "vitest";
import {
  encodeBinary,
  encodeInput,
  isReadyFrame,
  isTerminalId,
  nextTerminalId,
  resizeFrame,
  TERMINAL_IDS,
  terminalAvailability,
  terminalCloseAction,
  terminalPath,
} from "~/ui/components/processes/terminal-model";

describe("terminal ids (02: ^t[1-9]$)", () => {
  it("accepts t1 to t9 only", () => {
    expect(TERMINAL_IDS).toHaveLength(9);
    expect(isTerminalId("t1")).toBe(true);
    expect(isTerminalId("t9")).toBe(true);
    expect(isTerminalId("t0")).toBe(false);
    expect(isTerminalId("t10")).toBe(false);
    expect(isTerminalId("main")).toBe(false);
  });

  it("picks the lowest id with no open tab, none after nine", () => {
    expect(nextTerminalId([])).toBe("t1");
    expect(nextTerminalId(["t1", "t3"])).toBe("t2");
    expect(nextTerminalId(TERMINAL_IDS)).toBeNull();
  });
});

describe("terminal channel frames (01, Terminal)", () => {
  it("builds the channel path with clamped sizes", () => {
    expect(terminalPath("01ABC", "t2", 120, 40)).toBe("/api/ws/terminal/01ABC/t2?cols=120&rows=40");
    expect(terminalPath("a/b", "t1", 0, 9999)).toBe("/api/ws/terminal/a%2Fb/t1?cols=10&rows=200");
    expect(terminalPath("w", "t1", Number.NaN, 30.7)).toBe("/api/ws/terminal/w/t1?cols=10&rows=30");
  });

  it("sends resize as a text frame", () => {
    expect(JSON.parse(resizeFrame(100, 30))).toEqual({ type: "resize", cols: 100, rows: 30 });
  });

  it("knows the ready frame", () => {
    expect(isReadyFrame('{"type":"ready"}')).toBe(true);
    expect(isReadyFrame('{"type":"resize"}')).toBe(false);
    expect(isReadyFrame("not json")).toBe(false);
    expect(isReadyFrame("null")).toBe(false);
  });

  it("encodes keystrokes as UTF-8 and binary input byte for byte", () => {
    expect([...encodeInput("é")]).toEqual([0xc3, 0xa9]);
    expect([...encodeBinary("\u001b[Mÿ")]).toEqual([0x1b, 0x5b, 0x4d, 0xff]);
  });
});

describe("terminal close and availability", () => {
  it("reconnects unless the shell exited or the channel says not to (02 close codes)", () => {
    expect(terminalCloseAction(1000)).toBe("exited");
    expect(terminalCloseAction(4001)).toBe("replaced");
    expect(terminalCloseAction(4404)).toBe("notFound");
    expect(terminalCloseAction(4400)).toBe("badVersion");
    expect(terminalCloseAction(1006)).toBe("reconnect");
    expect(terminalCloseAction(1011)).toBe("reconnect");
    expect(terminalCloseAction(4008)).toBe("reconnect");
  });

  it("never opens a terminal into a sleeping or archived workspace", () => {
    expect(terminalAvailability(null)).toBe("loading");
    expect(terminalAvailability("ready")).toBe("connect");
    expect(terminalAvailability("starting")).toBe("connect");
    expect(terminalAvailability("sleeping")).toBe("sleeping");
    expect(terminalAvailability("stopping")).toBe("sleeping");
    expect(terminalAvailability("archived")).toBe("archived");
    expect(terminalAvailability("archiving")).toBe("archived");
  });
});
