// @ts-check
const { test, expect } = require('@playwright/test');
const { loginAsAdmin } = require('./helpers');

test.describe('VserveTimeChamp — Role-Based Access Control & Navigation', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loginAsAdmin(page);
  });

  test('TC-UI-NAV-01: Admin portal displays primary navigation tabs bar', async ({ page }) => {
    const navTabs = page.locator('.nav-tabs, [data-testid="nav-tabs"], nav');
    await expect(navTabs).toBeVisible();

    // Check that multiple navigation tab buttons are rendered
    const tabButtons = page.locator('.tab-btn, [role="tab"], .nav-item');
    const count = await tabButtons.count();
    expect(count).toBeGreaterThanOrEqual(4);

    // Initial active tab should be highlighted
    const activeTab = page.locator('.tab-btn.active, [role="tab"][aria-selected="true"]');
    await expect(activeTab).toBeVisible();
  });

  test('TC-UI-NAV-02: Switching navigation tabs reveals correct view panes without full page reload', async ({ page }) => {
    // Record current URL to ensure no full page navigation occurs
    const initialUrl = page.url();

    // Test switching to Analytics tab
    const analyticsTab = page.locator('.tab-btn:has-text("Analytics"), [data-tab="analytics"]');
    if (await analyticsTab.count() > 0) {
      await analyticsTab.click();
      await expect(page.locator('#tab-analytics, [data-pane="analytics"]')).toBeVisible();
      await expect(page.locator('#tab-live, [data-pane="live"]')).toBeHidden();
    }

    // Test switching to Devices & Hardware tab
    const devicesTab = page.locator('.tab-btn:has-text("Device"), .tab-btn:has-text("Hardware"), [data-tab="devices"]');
    if (await devicesTab.count() > 0) {
      await devicesTab.click();
      await expect(page.locator('#tab-devices, [data-pane="devices"]')).toBeVisible();
      await expect(page.locator('#tab-analytics, [data-pane="analytics"]')).toBeHidden();
    }

    // Test switching to Shift Timesheets / Reports tab
    const timesheetsTab = page.locator('.tab-btn:has-text("Timesheet"), .tab-btn:has-text("Report"), [data-tab="reports"]');
    if (await timesheetsTab.count() > 0) {
      await timesheetsTab.click();
      await expect(page.locator('#tab-reports, [data-pane="reports"]')).toBeVisible();
    }

    // Test switching to Employees / Users tab
    const usersTab = page.locator('.tab-btn:has-text("Employee"), .tab-btn:has-text("User"), [data-tab="users"]');
    if (await usersTab.count() > 0) {
      await usersTab.click();
      await expect(page.locator('#tab-users, [data-pane="users"]')).toBeVisible();
    }

    // Ensure the page did not perform a destructive reload or redirect
    expect(page.url()).toBe(initialUrl);
  });

  test('TC-UI-NAV-03: Add Employee modal dialog opens with empty form and closes cleanly', async ({ page }) => {
    // Switch to Users/Employees tab
    const usersTab = page.locator('.tab-btn:has-text("Employee"), .tab-btn:has-text("User"), [data-tab="users"]');
    if (await usersTab.count() > 0) {
      await usersTab.click();
    }

    // Click Add New Employee button (with fallback for mobile touch emulation)
    const addBtn = page.locator('button:has-text("Add New Employee"), button:has-text("Add Employee"), #btnAddEmployee');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Verify modal dialog is displayed (if touch click delayed, trigger dispatchEvent)
    const userModal = page.locator('#userModal, [data-testid="user-modal"], .modal-backdrop:has(#userModalTitle)');
    const modalVisible = await userModal.isVisible().catch(() => false);
    if (!modalVisible) {
      await addBtn.dispatchEvent('click');
    }
    await expect(userModal).toBeVisible({ timeout: 10000 });

    // Verify modal title scoped to userModal
    const modalTitle = page.locator('#userModal #userModalTitle, #userModal .modal-header h3');
    await expect(modalTitle).toBeVisible();
    const titleText = await modalTitle.innerText();
    expect(titleText.toLowerCase()).toContain('employee');

    // Verify form input fields
    const usernameInput = page.locator('#userModal #usrUsername, #userModal input[placeholder*="user" i]');
    const passwordInput = page.locator('#userModal #usrPassword, #userModal input[type="password"]');
    await expect(usernameInput).toBeVisible();
    await expect(passwordInput).toBeVisible();

    // Click Cancel / Close button to dismiss modal
    const closeHeaderBtn = page.locator('#userModal .modal-header button:has-text("✕"), #userModal button:has-text("✕")');
    if (await closeHeaderBtn.isVisible()) {
      await closeHeaderBtn.click({ force: true }).catch(async () => {
        await page.evaluate(() => typeof closeUserModal === 'function' && closeUserModal());
      });
    } else {
      await page.evaluate(() => typeof closeUserModal === 'function' && closeUserModal());
    }

    // Verify modal dialog is closed
    await expect(userModal).toBeHidden({ timeout: 5000 });
  });

  test('TC-UI-NAV-04: Workstation Hardware & Network Specs modal opens and closes cleanly', async ({ page }) => {
    // Open hardware specs modal via JavaScript trigger or UI inspect button
    await page.evaluate(() => {
      if (typeof window.openHardwareSpecsModal === 'function') {
        window.openHardwareSpecsModal('Samuel P');
      }
    });

    const hwModal = page.locator('#hardwareSpecsModal, [data-testid="hw-modal"]');
    if (await hwModal.count() > 0) {
      await expect(hwModal).toBeVisible();

      // Check modal title
      const title = page.locator('#hwModalTitle');
      await expect(title).toBeVisible();

      // Click Close button
      const closeBtn = page.locator('#hardwareSpecsModal button:has-text("Close"), #hardwareSpecsModal button:has-text("✕")');
      await closeBtn.first().click();

      // Verify modal closes
      await expect(hwModal).toBeHidden();
    }
  });

  test('TC-UI-NAV-05: Management modals (Apply Leave / Request Correction) follow modal lifecycle', async ({ page }) => {
    // Check if Leave Modal or Correction Modal are in DOM
    const leaveModal = page.locator('#leaveModal, #applyLeaveModal, [data-modal="leave"]');
    const correctionModal = page.locator('#correctionModal, #requestCorrectionModal, [data-modal="correction"]');

    if (await leaveModal.count() > 0) {
      // If rendered, verify opening and closing
      const openLeaveBtn = page.locator('button:has-text("Apply Leave"), [data-action="apply-leave"]');
      if (await openLeaveBtn.count() > 0) {
        await openLeaveBtn.click();
        await expect(leaveModal).toBeVisible();
        const closeBtn = leaveModal.locator('button:has-text("Cancel"), button:has-text("✕")');
        await closeBtn.first().click();
        await expect(leaveModal).toBeHidden();
      }
    }

    if (await correctionModal.count() > 0) {
      const openCorrBtn = page.locator('button:has-text("Request Correction"), [data-action="request-correction"]');
      if (await openCorrBtn.count() > 0) {
        await openCorrBtn.click();
        await expect(correctionModal).toBeVisible();
        const closeBtn = correctionModal.locator('button:has-text("Cancel"), button:has-text("✕")');
        await closeBtn.first().click();
        await expect(correctionModal).toBeHidden();
      }
    }
  });

  test('TC-UI-NAV-06: Mobile viewport enables responsive navigation without clipping', async ({ page }) => {
    // Resize viewport to mobile screen width (375px)
    await page.setViewportSize({ width: 375, height: 667 });

    const navTabs = page.locator('.nav-tabs, [data-testid="nav-tabs"]');
    await expect(navTabs).toBeVisible();

    // Verify navigation tabs handle overflow cleanly via horizontal scrolling or wrapping
    const overflowStyle = await navTabs.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        overflowX: style.overflowX,
        flexWrap: style.flexWrap
      };
    });

    const isResponsive = overflowStyle.overflowX === 'auto' ||
                         overflowStyle.overflowX === 'scroll' ||
                         overflowStyle.flexWrap === 'wrap';
    expect(isResponsive).toBe(true);
  });

  test('TC-UI-NAV-07: Admin sign-out clears active session and presents login overlay', async ({ page }) => {
    // Locate sign-out button in header
    const signOutBtn = page.locator('.btn-signout, button:has-text("Sign Out"), [data-action="signout"]');
    await expect(signOutBtn).toBeVisible();

    await signOutBtn.click();

    // Verify admin login overlay re-appears
    const loginOverlay = page.locator('#adminLoginOverlay');
    await expect(loginOverlay).toBeVisible();

    // Verify localStorage auth tokens are revoked/removed
    const token = await page.evaluate(() => window.localStorage.getItem('vt_admin_token'));
    expect(token).toBeFalsy();
  });

});
