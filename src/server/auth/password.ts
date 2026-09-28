/**
 * Password hashing.
 *
 * scrypt from Node's own crypto rather than bcrypt or argon2. Two reasons,
 * both honest:
 *
 *  - It is a memory-hard KDF in the scrypt paper's own parameterisation, not a
 *    hand-rolled substitute. The defaults here (N=16384, r=8, p=1, 64-byte
 *    output) are the interactive-login profile.
 *  - It removes a native dependency from a project whose real subject is the
 *    database. Swapping in argon2id later is a one-function change, and the
 *    stored format is versioned so old hashes stay verifiable.
 *
 * The encoded form carries its parameters:
 *   scrypt$N$r$p$<salt-b64>$<hash-b64>
 * which is what allows the cost to be raised later without invalidating
 * existing credentials -- re-hash on next successful login.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * An explicit promise wrapper rather than `promisify(scrypt)`.
 *
 * `scrypt` is overloaded, and `promisify` binds to the first signature it finds
 * -- the one without an options parameter -- so the cost settings silently fall
 * outside the type system. Writing it out keeps the options typed.
 */
function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Bounds for parameters read back out of a stored hash.
 *
 * `verifyPassword` trusts the cost figures encoded in the row, which makes them
 * attacker-influenced input: a tampered or corrupt hash claiming N = 2^30 would
 * allocate gigabytes and hang the process. Verification must therefore never
 * honour an unbounded cost -- it only needs to reproduce the hash that was
 * written, and anything outside the supported profile is rejected instead.
 */
const LIMITS = { minN: 2 ** 14, maxN: 2 ** 20, minR: 1, maxR: 32, minP: 1, maxP: 16 } as const;

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await deriveKey(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    // scrypt needs roughly 128 * N * r bytes; the default 32MB cap is not
    // always enough on constrained hosts, so it is raised explicitly.
    maxmem: 256 * 1024 * 1024,
  });

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !isPowerOfTwo(N) ||
    N < LIMITS.minN ||
    N > LIMITS.maxN ||
    !Number.isInteger(r) ||
    r < LIMITS.minR ||
    r > LIMITS.maxR ||
    !Number.isInteger(p) ||
    p < LIMITS.minP ||
    p > LIMITS.maxP
  ) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  let actual: Buffer;
  try {
    actual = await deriveKey(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }

  // Constant-time: a length or byte-wise early return would leak the hash
  // through response timing.
  return timingSafeEqual(actual, expected);
}
