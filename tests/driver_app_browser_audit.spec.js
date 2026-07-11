const { test, expect } = require('@playwright/test');

const WORKER_URL = 'https://pmg-driver-sync.jimpmgr.workers.dev';
const FLEET_URL = 'https://pmg-fleet-live.jimpmgr.workers.dev';
const APP_URL = process.env.PMG_DRIVER_APP_BASE_URL || 'http://127.0.0.1:4179';
const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

async function stubExternalApis(page, { torqueTasks = [], captured = null } = {}) {
  await page.route(`${WORKER_URL}/**`, async route => {
    const url = route.request().url();
    if (captured) {
      captured.workerRequests.push({ method: route.request().method(), url });
      if (url.includes('/photos/')) captured.photoUploads.push(url);
      if (url.includes('/ticket/')) {
        captured.ticketSaves.push({
          url,
          body: JSON.parse(route.request().postData() || '{}'),
        });
      }
      if (url.includes('/ht/driver-add')) {
        captured.driverAddRequests.push({
          url,
          body: JSON.parse(route.request().postData() || '{}'),
        });
      }
    }
    if (url.includes('/customers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'cust-1', name: 'Test Customer', code: 'TST' }]),
      });
    }
    if (url.includes('/ht/jobs')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    }
    if (url.includes('/ht/driver-add')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, ref: 'Phil Smith', jobId: 'Phil Smith' }),
      });
    }
    if (url.includes('/jobs/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route(`${FLEET_URL}/**`, async route => {
    const url = route.request().url();
    if (url.includes('/api/driver-torque')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, openTasks: torqueTasks, checkedAt: new Date().toISOString() }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

test.describe('driver app route audit', () => {
  for (const routeName of ['john', 'andrew', 'neil', 'ian', 'richard']) {
    test(`/${routeName} opens driver app without PIN bounce`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await stubExternalApis(page);
      await page.goto(`${APP_URL}/?driver=${routeName}`);
      await expect(page.locator('#jobs-screen')).toBeVisible();
      await expect(page.locator('#pin-screen')).toBeHidden();
      await expect(page.locator('#add-job-btn')).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test('saved driver session reopens jobs screen without PIN', async ({ page }) => {
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/`);
    await page.evaluate(() => localStorage.setItem('pmg-user', 'john'));
    await page.reload();
    await expect(page.locator('#jobs-screen')).toBeVisible();
    await expect(page.locator('#pin-screen')).toBeHidden();
  });

  test('clear live torque response hides wheel torque wording and clears stale cache', async ({ page }) => {
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => {
      localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'EY15BOV');
      localStorage.setItem('pmg_driver_torque_EY15BOV', JSON.stringify({
        tasks: [{ taskId: 'stale', eventId: 'stale', vehicle: 'EY15BOV', torqueNm: 625, createdAt: '2026-01-01T00:00:00Z' }],
      }));
    });
    await page.reload();
    await expect(page.locator('.torque-gate.clear')).toHaveCount(0);
    await expect(page.locator('.torque-gate.required')).toHaveCount(0);
    await expect(page.getByText('No wheel-off torque re-check is open')).toHaveCount(0);
  });

  test('PN25AMU stale cached torque never shows before live Fleet confirms it', async ({ page }) => {
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => {
      localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU');
      localStorage.setItem('pmg_driver_torque_PN25AMU', JSON.stringify({
        tasks: [{ taskId: 'bad-cache', eventId: 'bad-cache', vehicle: 'PN25AMU', torqueNm: 625, createdAt: '2026-01-01T00:00:00Z' }],
      }));
    });
    await page.reload();
    await expect(page.locator('.torque-gate.required')).toHaveCount(0);
    await expect(page.getByText(/Wheel torque/i)).toHaveCount(0);
    await page.locator('#start-walkaround-btn').click();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await expect(page.getByText(/Wheel torque/i)).toHaveCount(0);
  });

  test('walkaround photo capture stays in the walkaround and resumes from draft', async ({ page }) => {
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU'));
    await page.reload();
    await page.locator('#start-walkaround-btn').click();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await page.locator('#walk-photo-front_left').setInputFiles({
      name: 'front-left.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
    });
    await expect(page.locator('[data-photo-slot="front_left"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    await expect(page.locator('.walkaround-photo[data-photo-slot="rear_left"]')).toHaveClass(/next/);
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await page.reload();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await expect(page.locator('[data-photo-slot="front_left"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    await expect(page.locator('.walkaround-photo[data-photo-slot="rear_left"]')).toHaveClass(/next/);
  });

  test('camera bounce before file return reopens the walkaround draft, not loads', async ({ page }) => {
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU'));
    await page.reload();
    await page.locator('#start-walkaround-btn').click();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await page.locator('.walk-photo-btn[data-photo-slot="front_left"]').click();
    await page.reload();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await expect(page.locator('#jobs-screen')).toBeHidden();
    await expect(page.locator('.walkaround-photo[data-photo-slot="front_left"]')).toHaveClass(/next/);
    await expect(page.locator('[data-photo-slot="front_left"] .walkaround-photo-state')).toHaveText('Take this next');
  });

  test('walkaround cannot complete until every required truck photo is captured', async ({ page }) => {
    const captured = { workerRequests: [], photoUploads: [], ticketSaves: [], driverAddRequests: [] };
    await stubExternalApis(page, { captured });
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU'));
    await page.reload();
    await page.locator('#start-walkaround-btn').click();
    await page.locator('#walkaround-check-all').click();
    await expect(page.locator('#walkaround-check-list')).toBeHidden();
    await expect(page.locator('#walkaround-check-summary')).toContainText('All daily checks confirmed');
    await expect(page.locator('#walkaround-sig-canvas')).toBeHidden();
    await page.locator('#walkaround-complete-btn').click();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await expect(page.locator('#walkaround-photo-progress')).toHaveText('0 of 4 required photos saved');
    expect(captured.photoUploads).toHaveLength(0);
    expect(captured.ticketSaves).toHaveLength(0);
  });

  test('full fake John walkaround stores photos in round-the-wagon order and returns to loads clear', async ({ page }) => {
    const captured = { workerRequests: [], photoUploads: [], ticketSaves: [], driverAddRequests: [] };
    await stubExternalApis(page, { captured });
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU'));
    await page.reload();
    await expect(page.locator('#jobs-screen')).toBeVisible();
    await expect(page.locator('.torque-gate.required')).toHaveCount(0);
    await expect(page.getByText(/Wheel torque/i)).toHaveCount(0);
    await page.locator('#start-walkaround-btn').click();
    await expect(page.locator('#walkaround-screen')).toBeVisible();

    const order = ['front_left', 'rear_left', 'rear_right', 'front_right'];
    for (let i = 0; i < order.length; i += 1) {
      const slot = order[i];
      await expect(page.locator(`.walkaround-photo[data-photo-slot="${slot}"]`)).toHaveClass(/next/);
      await page.locator(`#walk-photo-${slot}`).setInputFiles({
        name: `${slot}.png`,
        mimeType: 'image/png',
        buffer: TEST_PNG,
      });
      await expect(page.locator(`[data-photo-slot="${slot}"] .walkaround-photo-state`)).toHaveText('Saved on this phone');
      if (i + 1 < order.length) {
        await expect(page.locator(`.walkaround-photo[data-photo-slot="${order[i + 1]}"]`)).toHaveClass(/next/);
      }
    }

    await page.locator('#walkaround-check-all').click();
    await page.locator('#walkaround-complete-btn').click();
    await expect(page.locator('#jobs-screen')).toBeVisible();
    await expect(page.locator('#walkaround-screen')).toBeHidden();
    await expect(page.locator('#walkaround-card')).toHaveClass(/done/);
    await expect(page.locator('#start-walkaround-btn')).toHaveText(/Review \/ do another walkaround/);

    expect(captured.photoUploads.map(url => {
      const assetId = url.match(/photos\/([^/?]+)/)?.[1] || '';
      return order.find(slot => assetId.includes(`waasset-${slot}-`));
    })).toEqual(order);
    expect(captured.ticketSaves).toHaveLength(1);
    expect(captured.ticketSaves[0].body.photoSlots).toEqual(order);
    expect(captured.ticketSaves[0].body.photoSlotsExpected).toEqual(order);
    expect(captured.ticketSaves[0].body.torqueChecks).toEqual([]);
    expect(captured.ticketSaves[0].body.vehicle).toBe('PN25AMU');
  });

  test('driver-added row sends typed name reference and plain driver note', async ({ page }) => {
    const captured = { workerRequests: [], photoUploads: [], ticketSaves: [], driverAddRequests: [] };
    await stubExternalApis(page, { captured });
    await page.goto(`${APP_URL}/?driver=john`);
    await expect(page.locator('#jobs-screen')).toBeVisible();

    await page.locator('#add-job-btn').click();
    await expect(page.locator('#add-row-more-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('#f-sig-canvas')).toBeHidden();
    await expect(page.locator('#add-job-modal')).toBeVisible();
    await page.locator('#f-vehicle').selectOption('EY15BOV');
    await page.locator('#f-customer').fill('A1');
    await expect(page.locator('#a1-payment-fields')).toBeVisible();
    await page.locator('#f-a1-paid').check();
    await page.locator('#f-material').fill('MOT');
    await page.locator('#f-from').fill('Yard');
    await page.locator('#f-to').fill('Nottend');
    await page.locator('#f-qty').fill('2');
    await page.locator('#f-ref').fill('Phil Smith');
    await page.locator('#f-notes').fill('Leave cones by the gate');
    await page.locator('#add-job-submit').click();

    await expect(page.locator('#job-confirm-modal')).toBeVisible();
    await expect(page.locator('#job-confirm-details')).toContainText('Phil Smith');
    await expect(page.locator('#job-confirm-details')).toContainText('Paid');
    expect(captured.driverAddRequests).toHaveLength(1);
    expect(captured.driverAddRequests[0].body.customer).toBe('A1');
    expect(captured.driverAddRequests[0].body.reference).toBe('Phil Smith');
    expect(captured.driverAddRequests[0].body.a1PaymentStatus).toBe('paid');
    expect(captured.driverAddRequests[0].body.notes).toBe('Leave cones by the gate');
  });

  test('manual day-sheet row keeps reference and office notes required', async ({ page }) => {
    const captured = { workerRequests: [], photoUploads: [], ticketSaves: [], driverAddRequests: [] };
    await stubExternalApis(page, { captured });
    await page.goto(`${APP_URL}/?driver=john`);
    await page.locator('#add-job-btn').click();
    await page.locator('#f-vehicle').selectOption('EY15BOV');
    await page.locator('#f-customer').fill('Test Customer');
    await page.locator('#f-material').fill('MOT');
    await page.locator('#f-from').fill('Yard');
    await page.locator('#f-to').fill('Site');
    await page.locator('#f-qty').fill('2');
    await expect(page.locator('#f-ref')).toHaveAttribute('required', '');
    await expect(page.locator('#f-notes')).toHaveAttribute('required', '');
    await page.locator('#add-job-submit').click();
    await expect(page.locator('#add-job-modal')).toBeVisible();
    expect(captured.driverAddRequests).toHaveLength(0);
  });

  test('open Fleet Live torque task has an obvious tick action', async ({ page }) => {
    await stubExternalApis(page, {
      torqueTasks: [{
        taskId: 'TORQUE-1',
        eventId: 'TORQUE-1',
        vehicle: 'EY15BOV',
        vehicleLabel: 'EY15BOV',
        position: 'Front axle',
        torqueNm: 625,
        createdAt: '2026-06-18T08:00:00Z',
        notes: 'Wheel off',
      }],
    });
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'EY15BOV'));
    await page.reload();
    await expect(page.locator('.torque-gate.required')).toBeVisible();
    await page.locator('#start-walkaround-btn').click();
    await expect(page.getByRole('button', { name: /Tick confirmed at 625 Nm/i })).toBeVisible();
  });
});
