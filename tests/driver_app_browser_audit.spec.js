const { test, expect } = require('@playwright/test');

const WORKER_URL = 'https://pmg-driver-sync.jimpmgr.workers.dev';
const FLEET_URL = 'https://pmg-fleet-live.jimpmgr.workers.dev';
const APP_URL = process.env.PMG_DRIVER_APP_BASE_URL || 'http://127.0.0.1:4179';
const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

async function installInlineCameraStub(page) {
  await page.addInitScript(() => {
    window.__inlineCameraStarts = 0;
    window.__inlineCameraStops = 0;
    const stream = new MediaStream();
    stream.getTracks = () => [{ stop: () => { window.__inlineCameraStops += 1; } }];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.__inlineCameraStarts += 1;
          return stream;
        },
      },
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
    HTMLMediaElement.prototype.play = async () => {};
    CanvasRenderingContext2D.prototype.drawImage = () => {};
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
      callback(new Blob(['walkaround-camera-test'], { type: 'image/jpeg' }));
    };
  });
}

async function stubExternalApis(page, { torqueTasks = [], haultechJobs = [], captured = null } = {}) {
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
      if (url.includes('/ht/payment/')) {
        captured.paymentUpdates = captured.paymentUpdates || [];
        captured.paymentUpdates.push({
          url,
          body: JSON.parse(route.request().postData() || '{}'),
        });
      }
    }
    if (url.includes('/address/autocomplete')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          suggestions: [{
            placeId: 'geo-test-place',
            text: 'High View, Sower Carr Lane, Hambleton, FY6 9DJ',
            mainText: 'High View',
            secondaryText: 'Sower Carr Lane, Hambleton, FY6 9DJ',
            address: {
              line1: 'High View',
              line2: 'Sower Carr Lane',
              line3: 'Hambleton',
              line4: 'Lancashire',
              postcode: 'FY6 9DJ',
              country: 'United Kingdom',
              formattedAddress: 'High View, Sower Carr Lane, Hambleton, FY6 9DJ',
              placeId: 'geo-test-place',
            },
          }],
        }),
      });
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
        body: JSON.stringify({ items: haultechJobs }),
      });
    }
    if (url.includes('/ht/driver-add')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, ref: 'Phil Smith', jobId: 'Phil Smith' }),
      });
    }
    if (url.includes('/ht/payment/')) {
      const paymentStatus = JSON.parse(route.request().postData() || '{}').paymentStatus || 'not_paid';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, paymentStatus, storedUpdated: true }),
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

  test('one inline camera session advances through consecutive walkaround photos', async ({ page }) => {
    await installInlineCameraStub(page);
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU'));
    await page.reload();
    await page.locator('#start-walkaround-btn').click();
    await page.locator('.walk-photo-btn[data-photo-slot="front_left"]').click();
    await expect(page.locator('#walkaround-inline-camera')).toBeVisible();
    await expect(page.locator('#walkaround-camera-capture')).toHaveText(/Front left/);
    await page.locator('#walkaround-camera-capture').click();
    await expect(page.locator('[data-photo-slot="front_left"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    await expect(page.locator('#walkaround-camera-capture')).toHaveText(/Rear left/);
    await page.locator('#walkaround-camera-capture').click();
    await expect(page.locator('[data-photo-slot="rear_left"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    await expect(page.locator('#walkaround-camera-capture')).toHaveText(/Rear right/);
    await page.locator('#walkaround-camera-capture').click();
    await expect(page.locator('[data-photo-slot="rear_right"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    await expect(page.locator('#walkaround-camera-capture')).toHaveText(/Front right/);
    await page.locator('#walkaround-camera-capture').click();
    await expect(page.locator('[data-photo-slot="front_right"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    await expect(page.locator('#walkaround-inline-camera')).toBeHidden();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    expect(await page.evaluate(() => window.__inlineCameraStarts)).toBe(1);
    expect(await page.evaluate(() => window.__inlineCameraStops)).toBe(1);
  });

  test('camera permission denial leaves a reusable native camera fallback', async ({ page }) => {
    await page.addInitScript(() => {
      window.__inlineCameraFailures = 0;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            window.__inlineCameraFailures += 1;
            throw new DOMException('Camera permission denied', 'NotAllowedError');
          },
        },
      });
    });
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU'));
    await page.reload();
    await page.locator('#start-walkaround-btn').click();
    await page.locator('.walk-photo-btn[data-photo-slot="front_left"]').click();
    await expect(page.locator('#walkaround-camera-status')).toContainText('Use phone camera');
    await page.locator('#walkaround-native-camera-btn').click();
    await page.locator('#walkaround-native-photo-input').setInputFiles({
      name: 'camera.jpg',
      mimeType: 'image/png',
      buffer: TEST_PNG,
    });
    await expect(page.locator('[data-photo-slot="front_left"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    await page.locator('.walk-photo-btn[data-photo-slot="rear_left"]').click();
    await page.locator('#walkaround-native-photo-input').setInputFiles({
      name: 'camera.jpg',
      mimeType: 'image/png',
      buffer: TEST_PNG,
    });
    await expect(page.locator('[data-photo-slot="rear_left"] .walkaround-photo-state')).toHaveText('Saved on this phone');
    expect(await page.evaluate(() => window.__inlineCameraFailures)).toBe(1);
  });

  test('walkaround photo capture stays in the walkaround and resumes from draft', async ({ page }) => {
    await stubExternalApis(page);
    await page.goto(`${APP_URL}/?driver=john`);
    await page.evaluate(() => localStorage.setItem('pmg_driver_vehicle_f5c31070-2945-408a-bc7a-0245159a191a', 'PN25AMU'));
    await page.reload();
    await page.locator('#start-walkaround-btn').click();
    await expect(page.locator('#walkaround-screen')).toBeVisible();
    await page.locator('.walk-photo-btn[data-photo-slot="front_left"]').click();
    await page.locator('#walkaround-native-photo-input').setInputFiles({
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
      await page.locator(`.walk-photo-btn[data-photo-slot="${slot}"]`).click();
      await page.locator('#walkaround-native-photo-input').setInputFiles({
        name: 'camera.jpg',
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
    expect(captured.ticketSaves[0].body.photoCaptureModes).toEqual(Object.fromEntries(order.map(slot => [slot, 'native_camera'])));
    expect(captured.ticketSaves[0].body.appBuildId).toBeTruthy();
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
    await page.locator('#f-payment-paid').check();
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
    expect(captured.driverAddRequests[0].body.paymentStatus).toBe('paid');
    expect(captured.driverAddRequests[0].body.notes).toBe('Leave cones by the gate');
  });

  test('concrete row selects a full address and sends postcode pricing inputs', async ({ page }) => {
    const captured = { workerRequests: [], photoUploads: [], ticketSaves: [], driverAddRequests: [] };
    await stubExternalApis(page, { captured });
    await page.goto(`${APP_URL}/?driver=ian`);
    await page.locator('#add-job-btn').click();
    await page.locator('#f-vehicle').selectOption('PN25FLF');
    await page.locator('#f-customer').fill('Test Customer');
    await page.locator('#f-material').fill('Concrete');
    await expect(page.locator('#concrete-type-fields')).toBeVisible();
    await page.locator('#f-concrete-type').selectOption('recycled');
    await page.locator('#f-wagon-visits').fill('2');
    await page.locator('#f-waiting-minutes').fill('15');
    await page.locator('#f-from').fill('Yard');
    await page.locator('#f-to').fill('High View Sow');
    await expect(page.locator('#f-to-address-dropdown')).toBeVisible();
    await page.locator('#f-to-address-dropdown .address-suggestion').first().click();
    await expect(page.locator('#f-to-address-status')).toContainText('FY6 9DJ');
    await page.locator('#f-qty').fill('4');
    await page.locator('#f-ref').fill('CONCRETE-ADDRESS');
    await page.locator('#f-notes').fill('Recycled concrete delivery');
    await page.locator('#add-job-submit').click();

    await expect(page.locator('#job-confirm-modal')).toBeVisible();
    expect(captured.driverAddRequests).toHaveLength(1);
    const body = captured.driverAddRequests[0].body;
    expect(body.concreteType).toBe('recycled');
    expect(body.wagonVisits).toBe(2);
    expect(body.chargeableWaitingMinutes).toBe(15);
    expect(body.specialAccess).toBe(false);
    expect(body.deliveryAddress.postcode).toBe('FY6 9DJ');
    expect(body.deliveryAddress.line1).toBe('High View');
  });

  test('driver can change a saved driver row between Paid and Not paid', async ({ page }) => {
    const captured = { workerRequests: [], photoUploads: [], ticketSaves: [], driverAddRequests: [], paymentUpdates: [] };
    const jobId = '8549ee7f-4def-466e-84d3-3267d2b9fe5c';
    await stubExternalApis(page, {
      captured,
      haultechJobs: [{
        jobId: 9555,
        id: jobId,
        customerId: 'cust-1',
        customerReference: 'Cleveleys landscapes',
        deliveryStatus: 'Completed',
        trafficNotes: 'Not paid | 10mm no fines Paid £355 cash',
        accountNotes: 'Added by John Bowman / EY15BOV | Driver app source: John Bowman / EY15BOV / 2.8m3 / Yard to Thornton | A1 payment: Not paid',
        consignments: [{
          id: '11111111-2222-4333-8444-555555555556',
          jobId,
          delivery: true,
          goodsDescription: 'Concrete',
          weight: 2.8,
          deliveryAddressLine1: 'Thornton',
        }],
      }],
    });
    await page.goto(`${APP_URL}/?driver=john`);
    await expect(page.locator('.job-card')).toHaveCount(1);
    await page.locator('.job-card').click();
    await expect(page.locator('#job-payment-panel')).toBeVisible();
    await expect(page.locator('.job-payment-option[data-status="not_paid"]')).toHaveClass(/active/);
    await page.locator('.job-payment-option[data-status="paid"]').click();
    await expect.poll(() => captured.paymentUpdates.length).toBe(1);
    expect(captured.paymentUpdates[0].url).toContain(`/ht/payment/${jobId}`);
    expect(captured.paymentUpdates[0].body.paymentStatus).toBe('paid');
    await expect(page.locator('.job-payment-option[data-status="paid"]')).toHaveClass(/active/);
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
