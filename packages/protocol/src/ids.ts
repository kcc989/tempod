import { Schema } from "effect";
import { monotonicFactory } from "ulid";

export const ULID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;

export const Id = Schema.String.check(Schema.isPattern(ULID_PATTERN));
export type Id = typeof Id.Type;

const factory = monotonicFactory();

export const newId = (): string => factory().toLowerCase();

export const TerminalId = Schema.String.check(Schema.isPattern(/^t[1-9]$/));
export type TerminalId = typeof TerminalId.Type;

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const randomToken = (length: number, alphabet: string = TOKEN_ALPHABET): string => {
  const out: string[] = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < max && out.length < length) out.push(alphabet[b % alphabet.length]!);
    }
  }
  return out.join("");
};
