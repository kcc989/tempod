import { describe, expect, it } from "vitest";
import {
  deviceOutcomeText,
  formatUserCode,
  loginErrorText,
  normalizeUserCode,
  safeRedirect,
  sessionLabel,
} from "~/ui/auth";
import { canManage, slugFromName } from "~/ui/organizations";

describe("auth helpers", () => {
  it("follows only same-site paths after sign-in", () => {
    expect(safeRedirect("/w/01h?x=1")).toBe("/w/01h?x=1");
    expect(safeRedirect("/device?user_code=ABCD")).toBe("/device?user_code=ABCD");
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
  });

  it("shows the owner-check message for ?error=forbidden", () => {
    expect(loginErrorText("forbidden")).toBe("You don't have access to this.");
    expect(loginErrorText("state_mismatch")).toBe("Something went wrong.");
    expect(loginErrorText(undefined)).toBeNull();
  });

  it("normalizes and formats device codes", () => {
    expect(normalizeUserCode(" abcd-efgh ")).toBe("ABCDEFGH");
    expect(formatUserCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(formatUserCode("abc")).toBe("ABC");
  });

  it("has a sentence for every device outcome", () => {
    expect(deviceOutcomeText({ ok: true, status: "approved", clientId: null })).toMatch(/signed in/);
    expect(deviceOutcomeText({ ok: true, status: "denied", clientId: null })).toMatch(/denied/);
    expect(deviceOutcomeText({ ok: false, reason: "expired" })).toMatch(/expired/);
    expect(deviceOutcomeText({ ok: false, reason: "invalid" })).toMatch(/not valid/);
    expect(deviceOutcomeText({ ok: false, reason: "processed" })).toMatch(/already used/);
    expect(deviceOutcomeText({ ok: false, reason: "error" })).toBe("Something went wrong.");
  });

  it("names sessions by browser and OS", () => {
    expect(sessionLabel(null)).toBe("Unknown device");
    expect(
      sessionLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ),
    ).toBe("Safari on macOS");
    expect(
      sessionLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"),
    ).toBe("Chrome on Linux");
    expect(sessionLabel("Tempo/1.0 (Mac OS X 15.0)")).toBe("Tempo for Mac");
  });
});

describe("organization helpers (04, /organizations)", () => {
  it("suggests a slug the server accepts and recognizes managing roles", () => {
    expect(slugFromName("Acme Labs!")).toBe("acme-labs");
    expect(slugFromName("  --Ünïcode  Team--")).toBe("n-code-team");
    expect(slugFromName("a".repeat(50))).toBe("a".repeat(39));
    expect(slugFromName(`${"a".repeat(38)}-b`)).toBe("a".repeat(38));
    expect(canManage("member, admin")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage(undefined)).toBe(false);
  });
});
