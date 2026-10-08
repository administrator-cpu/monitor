import { defineConfig, devices } from '@playwright/test';

const WEB = 'http://127.0.0.1:3100';
const API = 'http://127.0.0.1:4100';

// Build the UI first against the test API:  NEXT_PUBLIC_API_BASE=http://127.0.0.1:4100 pnpm build
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    launchOptions: {
      // Set when a browser is pre-installed (e.g. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium)
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/serve-backend.mjs',
      url: `${API}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // Lets serve-backend.mjs stop its PM2 daemon and delete its temp folders.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      command: 'npx next start -H 127.0.0.1 -p 3100',
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
