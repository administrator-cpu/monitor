import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@cc/shared';

interface Hasher {
  name: 'bcrypt' | 'bcryptjs';
  hash(password: string, cost: number): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

/** bcrypt (native) when it loads, bcryptjs otherwise (TRD section 2). */
function loadHasher(): Hasher {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const b = require('bcrypt') as typeof import('bcrypt');
    return { name: 'bcrypt', hash: (p, c) => b.hash(p, c), compare: (p, h) => b.compare(p, h) };
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const b = require('bcryptjs') as typeof import('bcryptjs');
    return { name: 'bcryptjs', hash: (p, c) => b.hash(p, c), compare: (p, h) => b.compare(p, h) };
  }
}

const hasher = loadHasher();

/** Cost 12 per the TRD; tests use a low cost so the suite stays fast. */
export const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;

export const hasherName = hasher.name;

export function hashPassword(password: string): Promise<string> {
  return hasher.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return hasher.compare(password, hash);
}

let dummyHash: Promise<string> | null = null;

/**
 * Burns the same CPU as a real check when the username is unknown or the
 * account is disabled, so response time does not reveal which usernames exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(password, await dummyHash);
  return false;
}

/** Short deny-list (TRD section 5). Compared case-insensitively. */
const COMMON = new Set(
  [
    'password1234',
    'password12345',
    'password123456',
    'passwordpassword',
    '123456789012',
    '1234567890123',
    '111111111111',
    '000000000000',
    'qwertyuiop12',
    'qwertyuiopas',
    'qwerty123456',
    'qwertyuiop123',
    'administrator',
    'administrator1',
    'admin1234567',
    'adminadmin123',
    'welcome12345',
    'welcome123456',
    'letmein12345',
    'letmein123456',
    'changeme1234',
    'changemechangeme',
    'iloveyou1234',
    'monkey123456',
    'abcdefghijkl',
    'abc123abc123',
    'p@ssw0rd1234',
    'p@ssword1234',
    'passw0rd1234',
    'monitor12345',
    'commandcenter',
  ].map((s) => s.toLowerCase()),
);

export function passwordPolicyError(
  password: string,
  context: { username?: string } = {},
): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common.';
  if (/^(.)\1+$/.test(password)) return 'Password must not be a single repeated character.';
  if (context.username && lower === context.username.toLowerCase()) {
    return 'Password must not equal the username.';
  }
  return null;
}
