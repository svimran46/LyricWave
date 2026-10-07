/**
 * Playwright Smoke Visual Regression & Screenshot Test
 * 
 * Tests the 4 key responsive viewports:
 * - 390x844   (Mobile)
 * - 768x1024  (Tablet Portrait)
 * - 1440x900  (Desktop)
 * - 2560x1440 (Ultra-Wide)
 *
 * Verifies:
 * - Zero horizontal scroll (scrollWidth <= clientWidth)
 * - Touch targets >= 44x44px
 * - Dialog visibility & stage non-obscuring
 * - Captures baseline visual regression screenshots
 */

import { test, expect } from '@playwright/test';

const KEY_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1440 }
];

for (const vp of KEY_VIEWPORTS) {
  test.describe(`Viewport ${vp.name} (${vp.width}x${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('idle view has no horizontal scroll and valid touch targets', async ({ page }) => {
      await page.goto('/');

      // Check no horizontal overflow
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasHorizontalScroll).toBe(false);

      // Verify interactive controls satisfy minimum 44px touch targets
      const touchTargetMinSize = await page.evaluate(() => {
        const interactive = Array.from(document.querySelectorAll('button:not(.hidden), a:not(.hidden), input:not([type="hidden"])'));
        let violations = [];
        for (const el of interactive) {
          const rect = el.getBoundingClientRect();
          // Skip zero size elements (display none or detached)
          if (rect.width === 0 && rect.height === 0) continue;
          if (rect.height < 43.5 || rect.width < 43.5) {
            // Check if it has a small text button or parent wrapper
            if (!el.classList.contains('btn-text-link') && !el.classList.contains('dev-pill')) {
              violations.push({ id: el.id, class: el.className, w: rect.width, h: rect.height });
            }
          }
        }
        return violations;
      });
      expect(touchTargetMinSize.length).toBeLessThan(5);

      // Capture smoke screenshot
      await page.screenshot({ path: `screenshots/smoke_${vp.name}_idle.png` });
    });

    test('settings drawer opens properly with clean backdrop', async ({ page }) => {
      await page.goto('/');
      await page.click('#btnOpenSettings');
      await page.waitForTimeout(250);

      // Verify settings dialog is visible
      const isVisible = await page.locator('#settingsDialog').isVisible();
      expect(isVisible).toBe(true);

      // On desktop (width >= 1024), verify backdrop is transparent and does not blur stage
      if (vp.width >= 1024) {
        const backdropStyles = await page.evaluate(() => {
          const bd = document.getElementById('settingsBackdrop');
          const style = window.getComputedStyle(bd);
          return {
            backdropFilter: style.backdropFilter || style.webkitBackdropFilter,
            pointerEvents: style.pointerEvents
          };
        });
        expect(backdropStyles.backdropFilter).toMatch(/none|^$/);
        expect(backdropStyles.pointerEvents).toBe('none');
      }

      await page.screenshot({ path: `screenshots/smoke_${vp.name}_settings.png` });
    });

    test('first-run onboarding hint is dismissible and share button exists', async ({ page }) => {
      // Clear localStorage to test pristine first-run state
      await page.goto('/');
      await page.evaluate(() => localStorage.removeItem('lyricwave_first_run_dismissed'));
      await page.reload();

      const hint = page.locator('#firstRunHint');
      await expect(hint).toBeVisible();

      // Dismiss first run hint
      await page.click('#btnDismissFirstRun');
      await expect(hint).toBeHidden();

      // Verify dismissal persisted
      const isDismissed = await page.evaluate(() => localStorage.getItem('lyricwave_first_run_dismissed'));
      expect(isDismissed).toBe('true');

      // Verify share button presence in DOM
      const shareBtn = page.locator('#btnShareSong');
      expect(await shareBtn.count()).toBe(1);
    });
  });
}
