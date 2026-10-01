import { expect, test } from '@playwright/test';

test('opens and closes the explanation by keyboard without moving focus', async ({ page }) => {
  await page.goto('/?demo=lab');
  const trigger = page.locator('.about-demo > summary');
  await trigger.focus();
  await trigger.press('Enter');
  await expect(page.locator('.about-copy')).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(page.locator('.about-copy')).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('makes the full request keyboard-scrollable', async ({ page }) => {
  await page.goto('/?demo=lab');
  const request = page.getByLabel('Exact AI_DECIDE request JSON', { exact: true });
  await expect(request).toBeVisible();
  await expect(request).toHaveAttribute('tabindex', '0');
  await request.focus();
  await request.press('End');
  await expect(request).toBeFocused();
  await expect
    .poll(() =>
      request.evaluate((element) =>
        'scrollTop' in element && typeof element.scrollTop === 'number' ? element.scrollTop : 0
      )
    )
    .toBeGreaterThan(0);
});

test('machine inspection works by keyboard and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?demo=lab');
  const machine = page.getByRole('button', { name: /^Inspect AN-02:/ });
  await machine.focus();
  await machine.press('Enter');
  await expect(machine).toBeFocused();
  await expect(machine).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Selected machine details', { exact: true })).toContainText('AN-02');
  const transitionDuration = await page.evaluate<string>(
    'getComputedStyle(document.querySelector(".machine-button[aria-pressed=true]")).transitionDuration'
  );
  expect(Math.max(...transitionDuration.split(',').map((duration) => parseFloat(duration)))).toBeLessThanOrEqual(0.001);
});
