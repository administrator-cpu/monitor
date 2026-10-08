import readline from 'node:readline';
import dotenv from 'dotenv';
import { createUserSchema, usernameSchema } from '@cc/shared';
import { z } from 'zod';
import { hashPassword, passwordPolicyError } from './auth/password';
import { Users } from './auth/users';
import { migrate, openDb } from './db';

/**
 * Creates the first admin. No account is ever seeded, so no default credentials exist.
 *
 *   pnpm --filter @cc/backend create-admin -- --username owner --email me@example.com --name "Owner"
 *
 * The password is prompted for (hidden). For scripted use, set CC_ADMIN_PASSWORD.
 */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i += 1;
      } else {
        out[a.slice(2)] = 'true';
      }
    }
  }
  return out;
}

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (hidden) {
      // Suppress echo of everything typed after the prompt has been written.
      const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
      const original = rlAny._writeToOutput.bind(rl);
      let prompted = false;
      rlAny._writeToOutput = (s: string) => {
        if (!prompted) {
          prompted = true;
          original(s);
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  dotenv.config({ path: process.env.CC_ENV_FILE, quiet: true });
  const args = parseArgs(process.argv.slice(2));

  const sqlitePath =
    process.env.SQLITE_PATH ??
    (process.platform === 'win32'
      ? 'C:\\monitor\\data\\monitor.db'
      : `${process.cwd()}/data/monitor.db`);

  const username = args.username ?? (await ask('Username: ', false));
  const email = args.email ?? (await ask('Email: ', false));
  const displayName = args.name ?? (await ask('Display name: ', false));

  const usernameCheck = usernameSchema.safeParse(username);
  if (!usernameCheck.success) {
    console.error(`Invalid username: ${usernameCheck.error.issues[0]?.message}`);
    process.exit(1);
  }
  if (!z.string().email().safeParse(email.trim()).success) {
    console.error('Invalid email address.');
    process.exit(1);
  }

  let password = process.env.CC_ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (min 12 characters): ', true);
    const confirm = await ask('Repeat password: ', true);
    if (password !== confirm) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }
  const problem = passwordPolicyError(password, { username });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  const parsed = createUserSchema.safeParse({
    username,
    displayName: displayName || username,
    email,
    role: 'admin',
    password,
    mustChangePassword: false,
  });
  if (!parsed.success) {
    console.error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
    process.exit(1);
  }

  const db = openDb(sqlitePath);
  migrate(db);
  const users = new Users(db);
  if (users.getByUsername(parsed.data.username)) {
    console.error(`User "${parsed.data.username}" already exists.`);
    process.exit(1);
  }
  const { password: pw, ...rest } = parsed.data;
  const row = users.create({ ...rest, passwordHash: await hashPassword(pw) });
  console.log(`Created admin "${row.username}" (id ${row.id}) in ${sqlitePath}`);
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
