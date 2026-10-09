import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createNasServer } from '../http.ts';
import { emptyActivity, localDay, DECK_ID } from '../../activity.ts';
import { scheduleReview } from '../../scheduler.ts';

const origin = 'http://127.0.0.1:8798';
const password = 'temporary-browser-test-password-only';
let directory: string;
let server: ReturnType<typeof createNasServer>;

test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'shadowing-nas-browser-'));
  server = createNasServer({ password, publicOrigin: origin, dataDir: directory, distDir: resolve('dist') });
  server.server.listen(8798, '127.0.0.1');
  await once(server.server, 'listening');
});
test.afterAll(async () => {
  await server?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function login(page: Page) {
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Private NAS practice' })).toBeVisible();
  await page.getByLabel('NAS password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start Review' })).toBeVisible();
}

test('private production app shares progress across two clients and deduplicates a lost rating response', async ({ browser }) => {
  const first = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  try {
    expect((await first.request.get(`${origin}/deck/deck.json`)).status()).toBe(401);
    await login(a);
    const deck = await (await first.request.get(`${origin}/deck/deck.json`)).json();
    const cardId = deck.cards[0].id as string;
    const imported = scheduleReview(cardId, undefined, 'again', 1000);
    const activity = emptyActivity([cardId]);
    const backup = { format: 1, deckId: DECK_ID, reviews: { [cardId]: imported }, activity };
    await a.getByText('Progress backup & NAS sync', { exact: true }).click();
    await a.getByLabel('Choose progress backup').setInputFiles({
      name: 'test-progress.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)),
    });
    await a.getByRole('button', { name: 'Import into empty NAS' }).click();
    await expect(a.getByText('Progress imported.', { exact: true })).toBeVisible();
    await login(b);
    const shared = await (await second.request.get(`${origin}/api/state`)).json();
    expect(shared.state.reviews[cardId]).toEqual(imported);
    expect(shared.state.activity.legacyCardIds).toEqual([cardId]);

    let commits = 0;
    const sent: string[] = [];
    await b.route('**/api/reviews', async (route) => {
      sent.push(route.request().postData()!);
      if (commits++ === 0) {
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed'); // Server committed, but the response was lost.
      } else await route.continue();
    });
    await b.getByRole('combobox', { name: 'Audio', exact: true }).selectOption('word');
    await b.getByRole('button', { name: 'Start Review' }).click();
    await b.getByRole('button', { name: 'Rate without recording' }).click({ timeout: 25_000 });
    await b.getByRole('button', { name: /^Good/ }).click();
    await expect(b.getByRole('button', { name: 'Retry pending good save' })).toBeVisible();
    await expect(b.getByRole('button', { name: /^Easy/ })).toBeDisabled();
    await b.getByRole('button', { name: 'Retry pending good save' }).click();
    await b.getByRole('button', { name: 'End session' }).click();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    const updated = await (await second.request.get(`${origin}/api/state`)).json();
    expect(updated.state.activity.counts[cardId]).toBe(1);
    expect(updated.state.reviews[cardId].rating).toBe('good');
    expect(updated.state.activity.days[localDay(Date.now())].reviews).toBe(1);
    expect(Object.keys(updated.state)).toEqual(['format', 'deckId', 'reviews', 'activity']);

    await a.getByRole('button', { name: 'Refresh NAS progress' }).click();
    await expect(a.getByText('1 reviewed today.', { exact: false })).toBeVisible();
    await a.getByRole('button', { name: 'View Cards', exact: true }).click();
    await expect(a.getByText('At least 2', { exact: false })).toBeVisible();
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await a.getByRole('button', { name: 'Sign out' }).click();
    await expect(a.getByRole('heading', { name: 'Private NAS practice' })).toBeVisible();
    expect((await first.request.get(`${origin}/api/state`)).status()).toBe(401);
    expect((await second.request.get(`${origin}/api/state`)).status()).toBe(200);
  } finally {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
  }
});