// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright Test Configuration for VserveTimeChamp UI E2E Test Suite
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: __dirname,
  /* Run tests sequentially to prevent state collisions on single-server instance */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Single worker for deterministic state against shared local test database */
  workers: 1,
  /* Maximum time one test can run for */
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../test-results/playwright-report', open: 'never' }]
  ],
  outputDir: '../../test-results/playwright-artifacts',

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.BASE_URL || 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    /* Default viewport for desktop testing */
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true
  },

  /* Configure projects for major browsers and responsive viewports */
  projects: [
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: 'Desktop Firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: 'Desktop Safari',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1280, height: 720 }
      }
    },
    /* Mobile viewports */
    {
      name: 'Mobile Chrome',
      use: {
        ...devices['Pixel 5']
      }
    },
    {
      name: 'Mobile Safari',
      use: {
        ...devices['iPhone 12']
      }
    }
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: 'node admin/server.js',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120000,
    cwd: pathResolveToRoot()
  }
});

function pathResolveToRoot() {
  const path = require('path');
  return path.resolve(__dirname, '../..');
}
