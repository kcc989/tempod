import { randomBytes } from "node:crypto";

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Eight lowercase hex characters; makes every prompt, file and title of one run unique. */
export const nonce = (): string => randomBytes(4).toString("hex");

/** Polls `check` until it returns a value other than undefined, null or false. */
export const waitFor = async <T>(
  label: string,
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await check();

    if (value !== undefined && value !== null && value !== false) return value;

    if (Date.now() + intervalMs > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(intervalMs);
  }
};

const ESC = 0x1b;

const BEL = 0x07;

/** Removes terminal escape sequences (CSI, OSC and two-byte escapes) and carriage returns. */
export const stripAnsi = (text: string): string => {
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);

    if (c === ESC) {
      const next = text[i + 1];

      if (next === "[") {
        i += 2;

        while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i++;
      } else if (next === "]" || next === "P" || next === "_") {
        i += 2;

        while (i < text.length) {
          const d = text.charCodeAt(i);

          if (d === BEL) break;

          if (d === ESC && text[i + 1] === "\\") {
            i++;
            break;
          }

          i++;
        }
      } else {
        i++;
      }

      continue;
    }

    if (c === 0x0d || (c < 0x20 && c !== 0x0a && c !== 0x09)) continue;
    out += text[i];
  }

  return out;
};

/** Indices of the secrets that occur in `haystack`, raw or JSON-escaped. Never returns the values. */
export const leakedSecrets = (haystack: string, secrets: ReadonlyArray<string>): number[] =>
  secrets.flatMap((secret, i) => {
    const escaped = JSON.stringify(secret).slice(1, -1);

    return haystack.includes(secret) || haystack.includes(escaped) ? [i] : [];
  });
