import { defineConfig,devices } from '@playwright/test';
export default defineConfig({
  testDir:'tests/e2e',fullyParallel:false,workers:1,timeout:60000,
  use:{baseURL:'http://localhost:3001',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{command:'npx tsx tests/harness/server.ts',url:'http://localhost:3001',reuseExistingServer:!process.env.CI,timeout:120000},
});
