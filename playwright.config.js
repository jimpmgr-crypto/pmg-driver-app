const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx wrangler pages dev . --port 4179 --ip 127.0.0.1 --compatibility-date=2026-06-24',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
