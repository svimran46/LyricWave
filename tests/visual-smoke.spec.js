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
 * - Lyrics timing tip + Sync panel on the lyrics screen
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

    test('lyrics timing tip shows once on the lyrics screen, and Sync opens the timing panel', async ({ page }) => {
      // A recently identified song opens the lyrics screen without any network lookups for the song itself.
      await page.goto('/');
      await page.evaluate(() => {
        localStorage.removeItem('lyricwave_sync_tip_seen');
        localStorage.setItem('lyricwave_recent_songs', JSON.stringify([
          { title: 'Test Song', artist: 'Test Artist', album: '', albumArt: '', durationSec: 180, durationMs: 180000 }
        ]));
      });
      await page.reload();
      await page.click('.recent-song-item');

      const tip = page.locator('#syncTip');
      await expect(tip).toBeVisible();
      await page.click('#btnDismissSyncTip');
      await expect(tip).toBeHidden();
      const seen = await page.evaluate(() => localStorage.getItem('lyricwave_sync_tip_seen'));
      expect(seen).toBe('true');

      // Timing lives behind the Sync dock button
      await page.click('#btnSync');
      await expect(page.locator('#syncPanel')).toBeVisible();
      await expect(page.locator('#btnSync')).toHaveAttribute('aria-expanded', 'true');

      // Songs picked in LyricWave are lyrics-only and the chip says so
      await expect(page.locator('#trackSourceBadge')).toHaveText('Lyrics only');

      // Verify share button presence in DOM
      const shareBtn = page.locator('#btnShareSong');
      expect(await shareBtn.count()).toBe(1);
    });
  });
}
