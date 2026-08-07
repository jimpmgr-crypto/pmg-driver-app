const { test, expect } = require('@playwright/test');

const WORKER_URL = 'https://pmg-driver-sync.jimpmgr.workers.dev';
const APP_URL = process.env.PMG_DRIVER_APP_BASE_URL || 'http://127.0.0.1:4179';

test('Tony explicitly acknowledges the current plant alert and sees the recorded proof', async ({ page }) => {
  let acknowledged = false;
  let acknowledgementPosts = 0;
  const asset = () => ({
    id: 'plant-test-alert',
    plantNumber: 'TEST 1',
    displayName: 'Test digger',
    plantGroup: 'diggers',
    plantGroupLabel: 'Diggers',
    dueStatus: 'overdue',
    dueLabel: 'Service overdue',
    dueMeta: { state: 'overdue', dueType: 'date', dueDate: '2026-08-01', days: -6 },
    nextServiceDueDate: '2026-08-01',
    alertAcknowledgement: acknowledged
      ? { current: true, acknowledgedBy: 'Tony', acknowledgedAt: '2026-08-07T19:30:00.000Z' }
      : { current: false, acknowledgedBy: '', acknowledgedAt: '' },
  });

  await page.route(`${WORKER_URL}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/plant/alerts/plant-test-alert/acknowledge' && route.request().method() === 'POST') {
      acknowledgementPosts += 1;
      acknowledged = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, idempotent: false, asset: asset() }) });
    }
    if (url.pathname === '/plant/assets/plant-test-alert') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ asset: asset(), history: [], filterParts: [], reviewItems: [] }) });
    }
    if (url.pathname === '/plant/assets') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 'pmg-plant-state-v1', stats: { assetCount: 1, overdueCount: 1 }, assets: [asset()], reviewItems: [] }) });
    }
    if (url.pathname === '/plant/push-config') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, publicKey: '' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`${APP_URL}/plant`);
  await expect(page.getByText('Service overdue - Test digger')).toBeVisible();
  await page.getByRole('button', { name: 'I’ve seen this' }).click();
  await expect.poll(() => acknowledgementPosts).toBe(1);
  await expect(page.getByText(/Seen by Tony/)).toBeVisible();
  await expect(page.getByText(/Marked as seen by Tony/)).toBeVisible();
});
