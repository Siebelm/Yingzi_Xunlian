import { expect, test } from '@playwright/test';

test('real local assets, two Chinese clips, simulated microphone playback and persisted rating', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/');
  await expect(page.getByText(/2,501 cards/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Audio', exact: true }).selectOption('word');
  await page.getByRole('button', { name: 'Start Review' }).click();
  await expect(page.getByRole('article', { name: 'Practice card' })).toBeVisible();
  await expect(page.getByText('HSK1 · Card 1', { exact: true })).toBeVisible();
  // Exercise native browser events, not mocked Audio/MediaRecorder classes.
  await expect(page.getByText('Chinese · 2 of 2', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator('.card-image').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.getByLabel('Show Chinese & pinyin').uncheck();
  await expect(page.getByText('Chinese text and pinyin hidden')).toBeVisible();
  await expect(page.locator('.hanzi')).toHaveCount(0);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop & play back' });
  await expect(stop).toBeVisible();
  await page.waitForTimeout(500); // Capture a nonempty simulated microphone sample.
  await stop.click();
  await expect(page.getByRole('group', { name: 'Next review' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Good 3 days' }).click();
  await expect(page.getByText('HSK1 · Card 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.reload();
  await expect(page.getByText(/2500 new/)).toBeVisible();
  expect(errors).toEqual([]);
  expect(requests.every((url) => url.startsWith('http://127.0.0.1:5173/') || url.startsWith('blob:'))).toBe(true);
});

test('phone-sized layout has no horizontal overflow and skipping does not save a review', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Review' }).click();
  await expect(page.getByText('HSK1 · Card 1', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Skip for this session' }).click();
  await expect(page.getByText('HSK1 · Card 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.reload();
  await expect(page.getByText(/2501 new/)).toBeVisible();
});

test('reviewed viewer and daily/all-time statistics persist without counting viewer time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const stat = (label: string) => page.locator('.activity-stats > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
  await expect(stat('Cards reviewed today')).toHaveText('0');
  await page.getByRole('button', { name: 'View Cards', exact: true }).click();
  await expect(page.getByText('No reviewed cards yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Practice', exact: true }).click();
  await page.getByRole('combobox', { name: 'Audio', exact: true }).selectOption('word');
  await page.getByRole('button', { name: 'Start Review' }).click();
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible({ timeout: 15_000 });
  // Wait for a real persisted timer tick, rather than sleeping an arbitrary duration.
  await expect(stat('Practice time today')).not.toHaveText('0m 0s', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Rate without recording' }).click();
  await page.getByRole('button', { name: 'Good 3 days' }).click();
  await expect(page.getByText('HSK1 · Card 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('button', { name: 'View Cards', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviewed cards (1)' })).toBeVisible();
  await expect(stat('Cards reviewed today')).toHaveText('1');
  await page.locator('.reviewed-list button').click();
  const detail = page.getByRole('region', { name: 'Selected reviewed card' });
  await expect(detail.getByText('Next scheduled', { exact: true })).toBeVisible();
  await expect(detail.locator('.viewer-metadata > div').filter({ hasText: 'Times reviewed' }).locator('dd')).toHaveText('1');
  await expect(detail.locator('.card-content')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Read after the final queued write, then ensure browsing cannot accrue time.
  const readTime = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shadowing-reviews-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = db.transaction('activity').objectStore('activity').get('mandarin-hsk-1-5');
        request.onsuccess = () => resolve(Object.values(request.result.days as Record<string, { timeMs: number }>).reduce((sum, day) => sum + day.timeMs, 0));
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  const savedTime = await readTime();
  expect(savedTime).toBeGreaterThanOrEqual(4000);
  await page.reload();
  await expect(stat('Cards reviewed today')).toHaveText('1');
  await expect(stat('All-time practice time')).not.toHaveText('0m 0s');
  await page.getByRole('button', { name: 'View Cards', exact: true }).click();
  await expect(page.getByText('Reviews: 1', { exact: true })).toBeVisible();
  await page.clock.install();
  await page.clock.runFor(10_000);
  expect(await readTime()).toBe(savedTime);
});