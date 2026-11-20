/**
 * VserveTimeChamp Playwright E2E Test Helpers & Common Utilities
 * Provides resilient authentication, session injection, theme inspection,
 * and DOM locator helpers for E2E specifications.
 */

const { expect } = require('@playwright/test');

const DEFAULT_ADMIN = {
  username: 'Samuel P',
  password: 'Samuel@2026',
  displayName: 'Samuel P',
  role: 'Administrator / Lead',
  department: 'Engineering',
  team: 'Core Engineering Team',
  isAdmin: true
};

/**
 * Ensures the admin user is logged in.
 * If the login overlay is visible, fills credentials and submits.
 * If token is already present or pre-seeded, confirms overlay dismissal.
 */
async function loginAsAdmin(page, credentials = DEFAULT_ADMIN) {
  // Check if we are on the page
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank') {
    await page.goto('/');
  }

  // Check if admin overlay is visible
  const overlay = page.locator('#adminLoginOverlay');
  const isOverlayVisible = await overlay.isVisible().catch(() => false);

  if (isOverlayVisible) {
    // Fill credentials
    const usernameInput = page.locator('#adminUsername');
    const passwordInput = page.locator('#adminPassword');
    const submitBtn = page.locator('#btnAdminSubmit');

    await usernameInput.fill(credentials.username);
    await passwordInput.fill(credentials.password);
    await submitBtn.click();

    // Wait for overlay to hide or header chip to display
    await expect(overlay).toBeHidden({ timeout: 10000 });
  }

  // Verify header chip displays administrator identity
  const adminChip = page.locator('#adminHeaderChip');
  await expect(adminChip).toBeVisible({ timeout: 10000 });
}

/**
 * Pre-seeds an administrator session into localStorage via init script
 * before navigating to any page, bypassing the login modal.
 */
async function seedAdminSession(context, user = DEFAULT_ADMIN) {
  const dummyToken = 'adm_e2e_test_' + Date.now();
  await context.addInitScript(({ token, userData }) => {
    window.localStorage.setItem('vt_admin_token', token);
    window.localStorage.setItem('vt_admin_user', JSON.stringify(userData));
  }, { token: dummyToken, userData: user });
}

/**
 * Inspects the current theme state (data-theme attribute and CSS variables).
 */
async function getThemeState(page) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const dataTheme = root.getAttribute('data-theme') || body.getAttribute('data-theme') || '';
    const computed = window.getComputedStyle(root);
    const bg = computed.getPropertyValue('--bg').trim();
    const text = computed.getPropertyValue('--text').trim();
    const cardBg = computed.getPropertyValue('--card-bg').trim();
    const isDarkClass = root.classList.contains('dark') || body.classList.contains('dark');
    const isLightClass = root.classList.contains('light') || body.classList.contains('light');

    return {
      dataTheme,
      bg,
      text,
      cardBg,
      isDarkClass,
      isLightClass,
      storedTheme: window.localStorage.getItem('vt_theme') || window.localStorage.getItem('theme') || ''
    };
  });
}

/**
 * Checks if the window has a horizontal scrollbar (page content overflowing viewport).
 * @param {import('@playwright/test').Page} page
 * @param {number} [tolerance=5] Allowed subpixel/margin tolerance in pixels
 */
async function hasHorizontalOverflow(page, tolerance = 5) {
  return await page.evaluate((tol) => {
    const scrollWidth = document.documentElement.scrollWidth;
    const clientWidth = document.documentElement.clientWidth;
    return scrollWidth > (clientWidth + tol);
  }, tolerance);
}

/**
 * Resolves a locator matching multiple potential selectors (for progressive testability).
 */
function findAny(page, selectors) {
  return page.locator(selectors.join(', '));
}

module.exports = {
  DEFAULT_ADMIN,
  loginAsAdmin,
  seedAdminSession,
  getThemeState,
  hasHorizontalOverflow,
  findAny
};
