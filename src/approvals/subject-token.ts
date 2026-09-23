import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 40 random bits as 8 lowercase base32 chars (a-z2-7). */
export function newSubjectToken(): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of randomBytes(5)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return out;
}
