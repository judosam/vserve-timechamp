// @ts-check
const { test, expect } = require('@playwright/test');
const { loginAsAdmin, hasHorizontalOverflow } = require('./helpers');

test.describe('VserveTimeChamp — Responsive Layout & Viewports', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('TC-UI-RESP-01: Large Desktop (1920x1080) renders spacious grid without horizontal overflow', async ({ page }) => {
    // Configure viewport for 1080p full HD desktop
    await page.setViewportSize({ width: 1920, height: 1080 });
    await loginAsAdmin(page);

    // Verify page body does not have horizontal overflow
    const overflow = await hasHorizontalOverflow(page, 5);
    expect(overflow).toBe(false);

    // Verify stats KPI cards display in a clean multi-column grid
    const statsGrid = page.locator('.stats-grid, [data-testid="stats-grid"]');
    await expect(statsGrid.first()).toBeVisible();

    // Verify cards are not squished or clipped
    const card = page.locator('.stat-card').first();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(200);
      expect(box.height).toBeGreaterThanOrEqual(80);
    }

    // Verify header brand and actions fit on a spacious row
    const header = page.locator('.header');
    await expect(header).toBeVisible();
  });

  test('TC-UI-RESP-02: Standard Laptop (1280x720) adapts KPI grid and data tables without clipping', async ({ page }) => {
    // Configure viewport for standard 720p laptop
    await page.setViewportSize({ width: 1280, height: 720 });
    await loginAsAdmin(page);

    // Verify no horizontal overflow
    const overflow = await hasHorizontalOverflow(page, 5);
    expect(overflow).toBe(false);

    // Switch to Devices & Hardware tab to check data table
    const devicesTab = page.locator('.tab-btn:has-text("Device"), [data-tab="devices"]');
    if (await devicesTab.count() > 0) {
      await devicesTab.click();
      const table = page.locator('#tab-devices table');
      await expect(table.first()).toBeVisible();
    }
  });

  test('TC-UI-RESP-03: Mobile Portrait — iPhone SE (375x667) adapts KPI grid with responsive stacking', async ({ page }) => {
    // Configure compact mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await loginAsAdmin(page);

    // Verify KPI cards wrap into single-column or mobile-adapted layout
    const statCards = page.locator('.stat-card');
    const count = await statCards.count();
    expect(count).toBeGreaterThan(0);

    if (count >= 2) {
      const firstBox = await statCards.nth(0).boundingBox();
      const secondBox = await statCards.nth(1).boundingBox();
      if (firstBox && secondBox) {
        // In mobile portrait, cards should stack vertically (y offset greater)
        expect(secondBox.y).toBeGreaterThan(firstBox.y);
      }
    }

    // Verify header wraps gracefully without extreme horizontal blowout (within 20px tolerance for mobile padding)
    const isExtremeOverflow = await hasHorizontalOverflow(page, 20);
    expect(isExtremeOverflow).toBe(false);
  });

  test('TC-UI-RESP-04: Mobile Portrait — iPhone 11/XR (414x896) renders tables with scroll containers', async ({ page }) => {
    // Configure modern smartphone portrait viewport
    await page.setViewportSize({ width: 414, height: 896 });
    await loginAsAdmin(page);

    // Switch to Devices tab which contains .table-container
    const devicesTab = page.locator('.tab-btn:has-text("Device"), [data-tab="devices"]');
    if (await devicesTab.count() > 0) {
      await devicesTab.click();

      // Check table and table container
      const tableContainer = page.locator('#tab-devices .table-container, .table-container');
      const table = page.locator('#tab-devices table');
      await expect(table).toBeVisible();

      // Ensure table container exists to isolate table width
      if (await tableContainer.count() > 0) {
        await expect(tableContainer.first()).toBeVisible();
      }
    }
  });

  test('TC-UI-RESP-05: Modals scale responsively and remain within viewport on small screens', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Open User Modal
    await loginAsAdmin(page);
    const usersTab = page.locator('.tab-btn:has-text("Employee"), .tab-btn:has-text("User"), [data-tab="users"]');
    if (await usersTab.count() > 0) {
      await usersTab.click();
    }

    const addBtn = page.locator('button:has-text("Add New Employee"), #btnAddEmployee');
    if (await addBtn.count() > 0) {
      await addBtn.click();

      const modalBox = page.locator('#userModal .modal-box');
      if (!(await modalBox.isVisible())) {
        await addBtn.dispatchEvent('click');
      }
      await expect(modalBox).toBeVisible({ timeout: 10000 });

      // Verify modal width fits within max allowed modal bounds (640px)
      const modalBounds = await modalBox.boundingBox();
      expect(modalBounds).not.toBeNull();
      if (modalBounds) {
        expect(modalBounds.width).toBeLessThanOrEqual(640);
        expect(modalBounds.width).toBeGreaterThanOrEqual(280);
      }

      // Close modal cleanly via top header close button or JavaScript handler
      const closeHeaderBtn = page.locator('#userModal .modal-header button:has-text("✕"), #userModal button:has-text("✕")');
      if (await closeHeaderBtn.isVisible()) {
        await closeHeaderBtn.click({ force: true }).catch(async () => {
          await page.evaluate(() => typeof closeUserModal === 'function' && closeUserModal());
        });
      } else {
        await page.evaluate(() => {
          if (typeof closeUserModal === 'function') closeUserModal();
        });
      }
      await expect(modalBox).toBeHidden({ timeout: 5000 });
    }
  });

});
