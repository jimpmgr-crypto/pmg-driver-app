const API_KEY = 'pmg2026driver';
const WORKER_BUILD_ID = '20260730-geoapify-address-pricing-worker-v4';
const DRIVER_API_CONTRACT = 'pmg-driver-api-v2';
const HT_BASE = 'https://httms.azurewebsites.net';
const DEFAULT_TMS = 'd80fd468-e802-492d-b73c-e09ab51bee88';
const PLANT_SNAPSHOT_KEY = 'plant:snapshot:v1';
const PLANT_MANUAL_EVENTS_KEY = 'plant:manual-events:v1';
const PLANT_ASSET_OVERRIDES_KEY = 'plant:asset-overrides:v1';
const PLANT_FILTER_OVERRIDES_KEY = 'plant:filter-overrides:v1';
const PLANT_PUSH_SUBSCRIPTIONS_KEY = 'plant:push-subscriptions:v1';
const PLANT_PUSH_LAST_RUN_KEY = 'plant:push-last-run:v1';
const HAULTECH_REFRESH_HEALTH_KEY = 'haultech-refresh-health:v1';
const HAULTECH_AUTH_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_PLANT_SERVICE_INTERVAL_HOURS = 500;
const PLANT_SERVICE_INTERVAL_HOURS = new Set([250, 500, 750, 1000]);
const DEFAULT_VEHICLE_SERVICE_INTERVAL_MILES = 10000;
const VEHICLE_SERVICE_INTERVAL_MILES = new Set([6000, 10000, 12000, 15000, 20000]);
const PLANT_SERVICE_INTERVAL_MONTHS = 12;
const PLANT_DATE_DUE_SOON_DAYS = 30;
const PLANT_HOURS_DUE_SOON = 50;
const VEHICLE_MILEAGE_DUE_SOON = 1000;
const DEFAULT_WHEEL_TORQUE_NM = 625;
const PLANT_PUSH_PUBLIC_KEY = 'BBrGpBo1MQlimftjiJvZMfQEf4UK78_fb0_As8BqmVeyCCubZOlcK1SxS18NEVGkCm4jnBzBdkfQ9dQ10d1pe4Y';
const PLANT_PUSH_SUBJECT = 'mailto:info@pm-groundworks.co.uk';
const PLANT_PUSH_CRON = '*/30 6-8 * * *';
const PLANT_PUSH_ALERT_DAYS = new Set([30, 15, 2, 0]);
const HAULTECH_CUSTOMERS_KEY = 'customers';
const HAULTECH_CUSTOMERS_HEALTH_KEY = 'haultech-customers-health:v1';
const ANDRE_OLD_CUSTOMER_ID = 'e7e107bf-3f3a-4596-83a6-caf3ea9995ac';
const ANDRE_BUSINESS_CUSTOMER_ID = '843a4757-786b-4d67-bc3c-c3b1e563c2fa';
const ANDRE_BUSINESS_NAME = 'Andrews Paving and Landscaping Limited';
const IAN_CARTER_CUSTOMER_ID = '39ba827d-b6da-4903-94c8-fdec4b76cced';
const IAN_CARTER_ALIASES = ["Carter's Landscapes", 'Carters Landscapes', 'Carter Landscapes'];
const W_ROBINSON_CUSTOMER_ID = '0424b2a9-2b2c-4ad3-86b5-c2fbcd84d915';
const W_ROBINSON_ALIASES = ['W Robinson', 'Robbies', 'Robbings'];
const YARD_CUSTOMERS_PIN = '2312';
const JOB_TYPE_STD = '4cbd566c-7fd6-41e2-b11a-29a5116457e2';
const SERVICE_LEVEL_STD = '6c19efc0-0664-41df-a2f3-ad2375659a66';
const YARD_ADDRESS = {
  line1: 'PM Groundworks Yard, Sower Carr Lane, FY6 9DJ',
  line3: 'Hambleton',
  line4: 'Lancashire',
  postcode: 'FY6 9DJ',
  country: 'United Kingdom',
};

let haultechAuthCache = null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PMG-Key, X-PMG-Admin-Key',
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

function unauthorized() {
  return corsResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
}

function hasAdminKey(request, env) {
  const expected = String(env.PMG_DRIVER_SYNC_ADMIN_KEY || '').trim();
  const supplied = String(request.headers.get('X-PMG-Admin-Key') || '').trim();
  return Boolean(expected) && supplied === expected;
}

function notFound() {
  return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
}

function safeJsonParse(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function badStoredData(name) {
  return corsResponse(JSON.stringify({ error: `bad_${name}_data` }), 500);
}

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '');
}

function safePathParam(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value || '');
  } catch {
    return null;
  }
  if (!decoded || decoded.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(decoded)) return null;
  return decoded;
}

function queryPath(path, params) {
  const qs = new URLSearchParams(params);
  return `${path}?${qs.toString()}`;
}

function jobStatusIndexKey(date) {
  return `job-status-index:${date}`;
}

function cleanText(value, maxLen = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function extractAddedByFromText(value) {
  const text = cleanText(value, 2000);
  if (!text) return '';
  const match = text.match(/\badded\s+by\s+([^|:/]+(?:\s+[^|:/]+)*?)(?:\s*\/\s*[^|:]*)?(?:\s*(?:\||:|$))/i);
  return match ? cleanText(match[1], 120) : '';
}

function extractVehicleFromText(value) {
  const text = cleanText(value, 2000).toUpperCase();
  if (!text) return '';
  const known = Object.keys(DRIVER_APP_VEHICLE_IDS_BY_REG || {}).find(reg => text.includes(reg));
  if (known) return known;
  const match = text.match(/\b[A-Z]{2}\d{2}[A-Z]{3}\b/);
  return match ? match[0] : '';
}

const DRIVER_APP_DRIVER_IDS_BY_NAME = {
  'john bowman': 'f5c31070-2945-408a-bc7a-0245159a191a',
  'richard whittaker': '201938f2-da93-4987-bd42-32342fcce78f',
  'andrew whittaker': 'd6795d54-a5f4-441b-b09a-df06558f7154',
  'neil antony': '42374caa-5cf2-446e-823e-a40e9d2a2d28',
  'neil anthony': '42374caa-5cf2-446e-823e-a40e9d2a2d28',
  'neil may': '42374caa-5cf2-446e-823e-a40e9d2a2d28',
  'ian slater': '0c472976-88ac-4610-bccb-e5b9ffde707c',
};

const DRIVER_APP_VEHICLE_IDS_BY_REG = {
  EY15BOV: '3acf3f0b-462d-4b75-9072-3f0890ea036a',
  BT66ZJO: 'b4db6d54-b090-4274-9799-7ac1812ba3a7',
  YJ13GRF: 'fdc27b69-6da3-41fc-8492-d349a2538191',
  PN25FLF: '695b915e-d817-476c-b3e1-a1768233edd9',
  PN25AMU: '31aa7aef-e40a-4095-b796-e8ed80639aa8',
  LL21HJJ: '112689c0-e2f4-4e32-9bfb-8e4fa24bb422',
};

const VOLUMETRIC_CONCRETE_VEHICLES = new Set(['LL21HJJ', 'PN25FLF']);
const INTERNAL_PMG_EIGHT_WHEELER_VEHICLES = new Set(['PN25AMU', 'YJ13GRF']);
const INTERNAL_PMG_ARTIC_VEHICLES = new Set(['BT66ZJO']);
const CONCRETE_RATES = {
  recycled: { over3: 135, under3: 155 },
  quarried: { over3: 145, under3: 165 },
};
const CONCRETE_SMALL_LOAD_THRESHOLD_M3 = 3.5;
const CONCRETE_PRICE_API = 'https://pmg-concrete-price.jimpmgr.workers.dev/api/quote';
const GEOAPIFY_AUTOCOMPLETE_URL = 'https://api.geoapify.com/v1/geocode/autocomplete';
const ADDRESS_SEARCH_DAILY_LIMIT = 2500;

function compactToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normaliseUkPostcode(value) {
  const compact = cleanText(value, 16).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)) return '';
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function normaliseStructuredAddress(body, kind, fallbackText = '') {
  const source = body?.[`${kind}Address`];
  const address = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const prefix = kind === 'collection' ? 'collection' : 'delivery';
  const line1 = cleanText(address.line1 || body?.[`${prefix}AddressLine1`] || fallbackText, 240);
  const line2 = cleanText(address.line2 || body?.[`${prefix}AddressLine2`], 240);
  const line3 = cleanText(address.line3 || body?.[`${prefix}AddressLine3`], 120);
  const line4 = cleanText(address.line4 || body?.[`${prefix}AddressLine4`], 120);
  const postcode = normaliseUkPostcode(address.postcode || body?.[`${prefix}Postcode`]);
  const country = cleanText(address.country || body?.[`${prefix}Country`] || 'United Kingdom', 80);
  const formattedAddress = cleanText(address.formattedAddress || body?.[`${prefix}FormattedAddress`] || fallbackText, 500);
  const placeId = cleanText(address.placeId || body?.[`${prefix}PlaceId`], 220);
  return { line1, line2, line3, line4, postcode, country, formattedAddress, placeId };
}

function structuredAddressFromGeoapifyPlace(place) {
  const streetAddress = cleanText([place?.housenumber, place?.street].filter(Boolean).join(' '), 240);
  const line1 = cleanText(place?.name || place?.address_line1 || streetAddress, 240);
  const line2 = place?.name && streetAddress && line1.toLowerCase() !== streetAddress.toLowerCase()
    ? streetAddress
    : '';
  return {
    line1,
    line2,
    line3: cleanText(place?.town || place?.village || place?.city || place?.suburb, 120),
    line4: cleanText(place?.county || place?.state, 120),
    postcode: normaliseUkPostcode(place?.postcode),
    country: cleanText(place?.country || 'United Kingdom', 80),
    formattedAddress: cleanText(place?.formatted, 500),
    placeId: cleanText(place?.place_id || place?.datasource?.raw?.place_id || place?.datasource?.raw?.osm_id, 220),
    latitude: Number(place?.lat) || null,
    longitude: Number(place?.lon) || null,
  };
}

async function reserveAddressSearchUsage(env) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `address-search-count:${day}`;
  const count = Number(await env.PMG_DATA.get(key)) || 0;
  if (count >= ADDRESS_SEARCH_DAILY_LIMIT) return false;
  await env.PMG_DATA.put(key, String(count + 1), { expirationTtl: 3 * 24 * 60 * 60 });
  return true;
}

async function geoapifyRequest(env, input) {
  const apiKey = cleanText(env.GEOAPIFY_API_KEY, 300);
  if (!apiKey) return { ok: false, status: 503, error: 'address_search_not_configured' };
  if (!await reserveAddressSearchUsage(env)) {
    return { ok: false, status: 429, error: 'address_search_daily_limit' };
  }
  const url = new URL(GEOAPIFY_AUTOCOMPLETE_URL);
  url.searchParams.set('text', input);
  url.searchParams.set('format', 'json');
  url.searchParams.set('filter', 'countrycode:gb');
  url.searchParams.set('bias', 'proximity:-2.94882,53.885484');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', '6');
  url.searchParams.set('apiKey', apiKey);
  const response = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
  const payload = safeJsonParse(await response.text(), {});
  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 429 ? 429 : 502,
      error: cleanText(payload?.message || payload?.error || `geoapify_http_${response.status}`, 300),
    };
  }
  return { ok: true, payload };
}

async function concreteDeliveryPrice(body, quantity, concreteType, basePrice) {
  const delivery = normaliseStructuredAddress(body, 'delivery', body.to);
  if (!delivery.postcode) return basePrice;
  try {
    const response = await fetch(CONCRETE_PRICE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postcode: delivery.postcode,
        concreteSource: concreteType,
        quantityM3: quantity,
        wagonVisits: Math.max(1, Math.min(20, Math.round(Number(body.wagonVisits) || 1))),
        chargeableWaitingMinutes: Math.max(0, Math.min(600, Number(body.chargeableWaitingMinutes) || 0)),
        specialAccess: body.specialAccess === true,
      }),
    });
    const quote = safeJsonParse(await response.text(), {});
    if (!response.ok) {
      return { quotedPrice: 0, useQuotedPrice: false, note: `Concrete route price needs office review: ${cleanText(quote.error || `HTTP ${response.status}`, 180)}` };
    }
    const total = Number(quote?.calculation?.totalExVat);
    if (quote?.calculation?.officeReviewRequired || !Number.isFinite(total) || total <= 0) {
      return { quotedPrice: 0, useQuotedPrice: false, note: `Concrete route price needs office review: ${cleanText(quote?.calculation?.deliveryBand?.label || 'special access', 180)}` };
    }
    return {
      quotedPrice: Math.round(total * 100) / 100,
      useQuotedPrice: true,
      note: `Auto-priced ${concreteType} concrete to ${delivery.postcode}: ${quote.route?.oneWayMinutes ?? '?'} minutes / ${quote.calculation.deliveryBand?.label || 'route checked'} = £${total.toFixed(2)} ex VAT (${cleanText(quote.pricingVersion, 80)})`,
    };
  } catch {
    return { quotedPrice: 0, useQuotedPrice: false, note: 'Concrete route price needs office review: pricing service unavailable' };
  }
}

function isVolumetricConcreteVehicle(value) {
  const token = compactToken(value);
  return VOLUMETRIC_CONCRETE_VEHICLES.has(token) || token.includes('LL21') || token.includes('FLF');
}

function normaliseDriverAddedUpsertPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const cleaned = { ...payload };
  const addedBy = cleanText(
    cleaned.addedBy || cleaned.sourceDriverName || cleaned.driverName || extractAddedByFromText([cleaned.accountNotes, cleaned.trafficNotes, cleaned.specialInstructions].filter(Boolean).join(' | ')),
    120
  );
  const vehicle = cleanText(cleaned.addedByVehicle || cleaned.vehicle || cleaned.vehicleRegistration, 60);
  const inferredVehicle = vehicle || extractVehicleFromText([cleaned.accountNotes, cleaned.trafficNotes, cleaned.specialInstructions, cleaned.notes, cleaned.driverNotes].filter(Boolean).join(' | '));
  const addedByDriverId = cleanText(
    cleaned.addedByDriverId || cleaned.deliveryDriverId || DRIVER_APP_DRIVER_IDS_BY_NAME[addedBy.toLowerCase()],
    80
  );
  const addedByVehicleId = cleanText(
    cleaned.addedByVehicleId || cleaned.deliveryVehicleId || DRIVER_APP_VEHICLE_IDS_BY_REG[compactToken(inferredVehicle)],
    80
  );
  delete cleaned.addedBy;
  delete cleaned.addedByDriverId;
  delete cleaned.addedByVehicle;
  delete cleaned.addedByVehicleId;
  delete cleaned.sourceDriverName;
  if (!addedBy) return cleaned;

  if (addedByDriverId && !cleaned.deliveryDriverId) cleaned.deliveryDriverId = addedByDriverId;
  if (addedByVehicleId && !cleaned.deliveryVehicleId) cleaned.deliveryVehicleId = addedByVehicleId;

  const stamp = inferredVehicle ? `Added by ${addedBy} / ${inferredVehicle}` : `Added by ${addedBy}`;
  const lowerStampNeedle = `added by ${addedBy.toLowerCase()}`;
  const trafficNotes = cleanText(cleaned.trafficNotes, 2000);
  const accountNotes = cleanText(cleaned.accountNotes, 2000);
  if (!accountNotes.toLowerCase().includes(lowerStampNeedle)) {
    cleaned.accountNotes = accountNotes ? `${stamp} | ${accountNotes}` : stamp;
  }
  if (trafficNotes) cleaned.trafficNotes = trafficNotes;
  return cleaned;
}

function normalisedLookupText(value) {
  return cleanText(value, 240).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normaliseDriverAddedMaterialLabel(value) {
  return cleanText(value, 240).replace(/\s+/g, ' ').trim();
}

function driverAddedSourceNote({ driverName, vehicle, weightText, fromText, toText }) {
  const parts = [driverName, vehicle, weightText, `${fromText} to ${toText}`].filter(Boolean);
  return parts.length ? `Driver app source: ${parts.join(' / ')}` : '';
}

function cleanDriverAddedReference(value) {
  const text = cleanText(value, 180);
  if (!text || /^(driver|local)-\d+$/i.test(text)) return '';
  return text;
}

function isLocalPhoneRowId(value) {
  return /^local-\d+$/i.test(cleanText(value, 180));
}

function titleReference(value) {
  return cleanText(value, 180).toUpperCase().replace(/\s+/g, ' ');
}

function driverAddedFallbackReference({ customerName, material, from, to, notes, sourceId }) {
  const rawSourceId = cleanText(sourceId, 40);
  const sourceSuffix = isLocalPhoneRowId(rawSourceId) ? '' : rawSourceId.replace(/^driver-/i, '');
  const base = [
    customerName,
    material,
    from && to ? `${from} to ${to}` : (from || to),
    notes,
  ]
    .map(titleReference)
    .find(part => part && part !== 'A1' && !/^DRIVER-\d+$/i.test(part));
  if (base) {
    return sourceSuffix ? cleanText(`${base} ${sourceSuffix.slice(-4)}`, 180) : base;
  }
  return sourceSuffix ? `DRIVER ROW ${sourceSuffix.slice(-6)}` : `DRIVER ROW ${Date.now()}`;
}

function driverAddedCustomerReference(rawRef, customerName, useA1Fallback) {
  const customer = cleanText(customerName, 120);
  const ref = cleanText(rawRef, 180);
  if (!useA1Fallback || !customer) return ref;
  if (!ref) return customer;
  const lowerRef = ref.toLowerCase();
  if (lowerRef.includes(customer.toLowerCase())) return ref;
  return cleanText(`${customer} - ${ref}`, 180);
}

function canDriverSetPrice(driverName) {
  return cleanText(driverName, 120).toLowerCase() === 'richard whittaker';
}

function internalPmgReferenceText(...values) {
  const text = values.map(value => String(value || '')).join(' ');
  return /\b(?:PM\s*GROUNDWORKS|PM\s*G|PMG)\b/i.test(text);
}

function driverAddedInternalPmgPrice(body, ref = '') {
  const vehicle = compactToken(body.vehicle || body.vehicleRegistration);
  let quotedPrice = 0;
  let vehicleType = '';
  if (INTERNAL_PMG_EIGHT_WHEELER_VEHICLES.has(vehicle)) {
    quotedPrice = 100;
    vehicleType = 'eight-wheeler';
  } else if (INTERNAL_PMG_ARTIC_VEHICLES.has(vehicle)) {
    quotedPrice = 150;
    vehicleType = 'artic';
  } else {
    return { quotedPrice: 0, useQuotedPrice: false, note: '' };
  }
  if (!internalPmgReferenceText(ref, body.customer, body.customerName, body.consignee)) {
    return { quotedPrice: 0, useQuotedPrice: false, note: '' };
  }
  return {
    quotedPrice,
    useQuotedPrice: true,
    note: `Auto-priced internal PM Groundworks ${vehicleType}: £${quotedPrice.toFixed(2)}`,
  };
}

function inferConcreteType(body) {
  const explicit = cleanText(body.concreteType || body.concrete_type, 40).toLowerCase();
  if (explicit.startsWith('q')) return 'quarried';
  if (explicit.startsWith('r')) return 'recycled';

  const material = compactToken([body.material, body.goodsDescription, body.notes, body.driverNotes].filter(Boolean).join(' '));
  if (!material) return '';
  if (
    material.includes('QUARRIED')
    || material.includes('QUARRY')
    || /(?:^|[^A-Z])QU(?:[^A-Z]|$)/i.test(String(body.material || body.goodsDescription || ''))
    || /(?:C|RC)\d{2}Q\b/.test(material)
    || /^Q\d/.test(material)
  ) {
    return 'quarried';
  }
  if (material.includes('RREC') || material.includes('RECYCLED') || /\bREC\b/i.test(String(body.material || body.goodsDescription || ''))) {
    return 'recycled';
  }
  return '';
}

function concreteQuantityFromText(...values) {
  const text = values.map(value => String(value || '')).join(' ');
  const explicitMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:m3|m³|cube|cubes)\b/i);
  if (explicitMatch) {
    const qty = Number(explicitMatch[1]);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  }
  const splitMatch = text.match(/\b(\d+)\s+(\d)\s*m\b/i);
  if (splitMatch) {
    const qty = Number(`${splitMatch[1]}.${splitMatch[2]}`);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  }
  const metreMatch = text.match(/\b(\d+(?:\.\d+)?)\s*m\b/i);
  if (!metreMatch) return 0;
  const qty = Number(metreMatch[1]);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function driverAddedQuantityAndUnit(body, material = '') {
  const rawQuantity = Number(body.quantity || body.weight || 0) || 0;
  const rawUnit = cleanText(body.unit, 20) || 't';
  if (rawQuantity > 0) return { quantity: rawQuantity, unit: rawUnit };
  const inferredQuantity = concreteQuantityFromText(body.notes, body.driverNotes, body.accountNotes, body.trafficNotes, material, body.goodsDescription);
  if (inferredQuantity > 0) return { quantity: inferredQuantity, unit: 'm3' };
  return { quantity: rawQuantity, unit: rawUnit };
}

async function driverAddedConcreteAutoPrice(body, quantity) {
  const material = cleanText(body.material || body.goodsDescription, 240).toLowerCase();
  const quantityInfo = driverAddedQuantityAndUnit(body, material);
  const unit = cleanText(quantityInfo.unit, 20).toLowerCase();
  const customer = cleanText(body.customer || body.customerName || body.consignee, 200).toLowerCase().replace(/\s+/g, ' ').trim();
  if (customer === 'wyre building supplies' || customer === 'wyre building supplies limited') {
    return { quotedPrice: 0, useQuotedPrice: false, note: '' };
  }
  if (!['m3', 'm³', 'cube', 'cubes'].includes(unit)) {
    return { quotedPrice: 0, useQuotedPrice: false, note: '' };
  }
  const qty = Number(quantityInfo.quantity || quantity) || 0;
  if (!Number.isFinite(qty) || qty <= 0) {
    return { quotedPrice: 0, useQuotedPrice: false, note: '' };
  }
  if (internalPmgReferenceText(
    body.reference,
    body.customerReference,
    body.customer,
    body.customerName,
    body.consignee,
    body.to,
    body.deliveryAddress?.formattedAddress
  )) {
    const quotedPrice = Math.round(qty * 40 * 100) / 100;
    return {
      quotedPrice,
      useQuotedPrice: true,
      note: `Auto-priced internal PM Groundworks concrete saving: ${qty}m3 @ £40.00/m3 = £${quotedPrice.toFixed(2)}`,
    };
  }
  const concreteType = inferConcreteType(body);
  if (!concreteType || !CONCRETE_RATES[concreteType]) {
    return { quotedPrice: 0, useQuotedPrice: false, note: '' };
  }
  const rate = qty > CONCRETE_SMALL_LOAD_THRESHOLD_M3 ? CONCRETE_RATES[concreteType].over3 : CONCRETE_RATES[concreteType].under3;
  const quotedPrice = Math.round(qty * rate * 100) / 100;
  const basePrice = {
    quotedPrice,
    useQuotedPrice: true,
    note: `Auto-priced PMG ${concreteType} concrete: ${qty <= CONCRETE_SMALL_LOAD_THRESHOLD_M3 ? '3.5m3 or under' : 'over 3.5m3'} @ £${rate.toFixed(2)}/m3 = £${quotedPrice.toFixed(2)}`,
  };
  return concreteDeliveryPrice(body, qty, concreteType, basePrice);
}

async function driverAddedQuotedPrice(body, driverName, quantity, unit, ref = '') {
  const fixedInternalPrice = driverAddedInternalPmgPrice(body, ref);
  if (fixedInternalPrice.useQuotedPrice) return fixedInternalPrice;
  if (!canDriverSetPrice(driverName)) return driverAddedConcreteAutoPrice(body, quantity);
  const explicit = Number(body.quotedPrice || body.price || 0);
  const mode = cleanText(body.priceMode, 20).toLowerCase() === 'fixed' ? 'fixed' : 'rate';
  const input = Number(body.priceInput || body.rate || body.unitRate || 0);
  let quotedPrice = 0;
  let note = '';
  if (Number.isFinite(explicit) && explicit > 0) {
    quotedPrice = explicit;
    if (Number.isFinite(input) && input > 0 && mode === 'rate') {
      note = `Priced by Richard: £${input.toFixed(2)}/${unit || 'unit'} = £${quotedPrice.toFixed(2)}`;
    } else if (Number.isFinite(input) && input > 0 && mode === 'fixed') {
      note = `Priced by Richard: fixed £${quotedPrice.toFixed(2)}`;
    } else {
      note = `Priced by Richard: £${quotedPrice.toFixed(2)}`;
    }
  } else if (Number.isFinite(input) && input > 0) {
    quotedPrice = mode === 'fixed' ? input : input * (Number(quantity) || 0);
    note = mode === 'fixed'
      ? `Priced by Richard: fixed £${quotedPrice.toFixed(2)}`
      : `Priced by Richard: £${input.toFixed(2)}/${unit || 'unit'} = £${quotedPrice.toFixed(2)}`;
  }
  quotedPrice = Math.round((Number(quotedPrice) || 0) * 100) / 100;
  if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) return driverAddedConcreteAutoPrice(body, quantity);
  return { quotedPrice, useQuotedPrice: true, note };
}

function findCustomerMatch(customers, customerName) {
  const target = normalisedLookupText(customerName);
  if (!target) return { customer: null, score: 0 };
  let best = { customer: null, score: 0 };
  for (const customer of safeArray(customers)) {
    const name = cleanText(customer?.name || customer?.companyName, 240);
    const id = cleanText(customer?.id, 80);
    if (!name || !id) continue;
    const lookupParts = [name, customer?.code, ...(Array.isArray(customer?.aliases) ? customer.aliases : [])]
      .map(part => normalisedLookupText(part))
      .filter(Boolean);
    let score = 0;
    for (const lookup of lookupParts) {
      if (lookup === target) score = Math.max(score, 1);
      else if (lookup.includes(target) || target.includes(lookup)) score = Math.max(score, 0.88);
    }
    if (score > best.score) best = { customer: { ...customer, name, id }, score };
  }
  return best;
}

function firstConsignment(job) {
  return safeArray(job?.consignments || job?.Consignments)[0] || {};
}

function jobCustomerReference(job) {
  return cleanText(job?.customerReference || job?.customerreference || firstConsignment(job)?.consignmentReference, 200);
}

function jobGoodsDescription(job) {
  const consignment = firstConsignment(job);
  return cleanText(
    job?.goodsDescription || job?.goodsdescription || consignment?.goodsDescription || consignment?.goodsdescription,
    2000
  );
}

function jobQuantity(job) {
  const consignment = firstConsignment(job);
  const value = job?.quantity || job?.weight || consignment?.quantity || consignment?.weight || 0;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

function driverAddSignatureFromPayload(payload) {
  const consignment = safeArray(payload?.consignments)[0] || {};
  return [
    cleanText(payload?.customerReference, 200),
    normalisedLookupText(consignment.goodsDescription || payload?.goodsDescription),
    jobQuantity(payload),
  ].join('|');
}

function driverAddSignatureFromJob(job) {
  return [
    jobCustomerReference(job),
    normalisedLookupText(jobGoodsDescription(job)),
    jobQuantity(job),
  ].join('|');
}

function cleanDriverNote(value) {
  return cleanText(value, 1200)
    .replace(/^(driver\s+note\s*:\s*)+/i, '')
    .replace(/^(note\s*:\s*)+/i, '')
    .replace(/^(reason\s*:\s*)+/i, '')
    .trim();
}

function isA1CustomerName(value) {
  return compactToken(value) === 'A1';
}

function normaliseA1PaymentStatus(body = {}) {
  if (typeof body.a1Paid === 'boolean') return body.a1Paid ? 'Paid' : 'Not paid';
  if (typeof body.customerPaid === 'boolean') return body.customerPaid ? 'Paid' : 'Not paid';
  if (typeof body.paid === 'boolean') return body.paid ? 'Paid' : 'Not paid';
  const raw = cleanText(body.a1PaymentStatus || body.paymentStatus || body.payment_status || body.paid, 40).toLowerCase();
  if (!raw) return '';
  if (['paid', 'yes', 'y', 'true', '1', 'cash paid'].includes(raw)) return 'Paid';
  if (['not_paid', 'not paid', 'unpaid', 'no', 'n', 'false', '0', 'cash not paid'].includes(raw)) return 'Not paid';
  return '';
}

async function buildDriverAddedHaultechPayload(env, body) {
  const date = maybeIsoDate(body.date) || new Date().toISOString().slice(0, 10);
  const customerName = cleanText(body.customer || body.customerName || body.consignee, 200);
  if (!customerName) return { error: 'customer_required', status: 400 };
  const material = cleanText(body.material || body.goodsDescription, 240);
  const quantityInfo = driverAddedQuantityAndUnit(body, material);
  const weight = quantityInfo.quantity;
  const unit = quantityInfo.unit;
  const from = cleanText(body.from || body.collectionAddressLine1, 240);
  const to = cleanText(body.to || body.deliveryAddressLine1, 240);
  const collectionAddress = normaliseStructuredAddress(body, 'collection', from);
  const deliveryAddress = normaliseStructuredAddress(body, 'delivery', to);
  const driverName = cleanText(body.driver || body.driverName || body.addedBy || body.createdBy, 120);
  const vehicle = cleanText(body.vehicle || body.vehicleRegistration, 60);
  const sourceId = cleanText(body.id || body.ticketNo, 180);
  const rawRef = cleanDriverAddedReference(body.reference || body.customerReference || body.ticketNo);
  const notes = cleanDriverNote(body.notes || body.driverNotes);
  const exactA1Customer = isA1CustomerName(customerName);
  const a1PaymentStatus = exactA1Customer ? (normaliseA1PaymentStatus(body) || 'Not paid') : normaliseA1PaymentStatus(body);
  if (exactA1Customer && !rawRef) {
    return { error: 'a1_reference_required', message: 'A1 rows need a customer name/reference', status: 400 };
  }

  const customers = await getKvJson(env, HAULTECH_CUSTOMERS_KEY, []);
  let customerLookup = findCustomerMatch(customers, customerName);
  let useA1Fallback = false;
  if (!customerLookup.customer || customerLookup.score < 0.75) {
    const a1Lookup = findCustomerMatch(customers, 'A1');
    if (!a1Lookup.customer || a1Lookup.score < 0.75) {
      return { error: 'customer_not_found', message: `Could not match customer ${customerName}`, status: 400 };
    }
    customerLookup = a1Lookup;
    useA1Fallback = true;
  }

  const dt = new Date(date + 'T00:00:00Z');
  const epoch = Math.floor(dt.getTime() / 1000) + 43200;
  const iso = `${date}T00:00:00.0000000`;
  const baseRef = rawRef || driverAddedFallbackReference({ customerName, material, from, to, notes, sourceId });
  const ref = driverAddedCustomerReference(baseRef, customerName, useA1Fallback);
  const fromText = from || YARD_ADDRESS.line1;
  const toText = to || customerName;
  const weightText = weight ? `${weight}${unit}` : '';
  const goodsDescription = normaliseDriverAddedMaterialLabel(material);
  const pricing = await driverAddedQuotedPrice(body, driverName, weight, unit, ref);
  const accountParts = [];
  const trafficParts = [];
  const sourceNote = driverAddedSourceNote({ driverName, vehicle, weightText, fromText, toText });
  if (sourceNote) accountParts.push(sourceNote);
  if (useA1Fallback) {
    accountParts.push(`Typed customer/site: ${customerName}`);
  }
  if (sourceId && sourceId !== ref && !isLocalPhoneRowId(sourceId)) accountParts.push(`Phone source: ${sourceId}`);
  if (notes) accountParts.push(`Driver note: ${notes}`);
  if (a1PaymentStatus) accountParts.push(`${exactA1Customer ? 'A1' : 'Customer'} payment: ${a1PaymentStatus}`);
  if (a1PaymentStatus) trafficParts.push(a1PaymentStatus);
  if (notes) trafficParts.push(notes);
  if (pricing.note) accountParts.push(pricing.note);
  if (body.wtn || body.wasteTransferNote) accountParts.push('Waste transfer note saved in PMG driver app');

  const payload = normaliseDriverAddedUpsertPayload({
    active: true,
    customerId: customerLookup.customer.id,
    jobTypeId: JOB_TYPE_STD,
    serviceLevelId: customerLookup.customer.defaultServiceLevelId || SERVICE_LEVEL_STD,
    customerReference: ref,
    trafficNotes: trafficParts.join(' | '),
    accountNotes: accountParts.join(' | '),
    specialInstructions: '',
    quotedPrice: pricing.quotedPrice,
    useQuotedPrice: pricing.useQuotedPrice,
    collectionRequired: false,
    deliveryDateEpoch: epoch,
    collectionDateEpoch: epoch,
    deliveryDate: iso,
    collectionDate: iso,
    weight,
    quantity: weight,
    onOrBy: 'B',
    collectionStatus: 'None',
    deliveryStatus: 'Scheduled',
    addedBy: driverName,
    addedByVehicle: vehicle,
    consignments: [{
      active: true,
      collection: false,
      delivery: true,
      goodsDescription,
      consignmentReference: ref,
      weight,
      quantity: weight,
      collectionAddressLine1: collectionAddress.line1 || YARD_ADDRESS.line1,
      collectionAddressLine2: collectionAddress.line2,
      collectionAddressLine3: collectionAddress.line1 ? collectionAddress.line3 : YARD_ADDRESS.line3,
      collectionAddressLine4: collectionAddress.line1 ? collectionAddress.line4 : YARD_ADDRESS.line4,
      collectionPostcode: collectionAddress.line1 ? collectionAddress.postcode : YARD_ADDRESS.postcode,
      collectionCountry: collectionAddress.country || YARD_ADDRESS.country,
      deliveryAddressLine1: deliveryAddress.line1 || customerName,
      deliveryAddressLine2: deliveryAddress.line2,
      deliveryAddressLine3: deliveryAddress.line3,
      deliveryAddressLine4: deliveryAddress.line4,
      deliveryPostcode: deliveryAddress.postcode,
      deliveryCountry: deliveryAddress.country || 'United Kingdom',
    }],
  });

  return { date, ref, sourceId, payload, customerName, useA1Fallback, a1PaymentStatus };
}

function cleanMultiline(value, maxLen = 5000) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, maxLen);
}

function maybeIsoDate(value) {
  const text = cleanText(value, 20);
  return isValidIsoDate(text) ? text : '';
}

function addIsoDays(date, offsetDays) {
  const base = maybeIsoDate(date);
  if (!base) return '';
  const dt = new Date(base + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

function uniqueIsoDates(values) {
  const dates = [];
  for (const value of values || []) {
    const date = maybeIsoDate(value);
    if (date && !dates.includes(date)) dates.push(date);
  }
  return dates;
}

function maybeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

function normaliseVehicleRef(value) {
  return cleanText(value, 80).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function assetVehicleRefs(asset) {
  const refs = [
    asset?.id,
    asset?.plantNumber,
    asset?.displayName,
    asset?.registration,
    asset?.regNo,
    asset?.vehicleRegistration,
    asset?.numberPlate,
  ].map(normaliseVehicleRef).filter(Boolean);
  return Array.from(new Set(refs));
}

function assetMatchesVehicle(asset, vehicleRef) {
  const target = normaliseVehicleRef(vehicleRef);
  if (!target) return false;
  return assetVehicleRefs(asset).some(ref => ref === target || ref.includes(target) || target.includes(ref));
}

function torqueEventText(event) {
  return [
    event?.serviceType,
    event?.description,
    event?.workDone,
    event?.anomalies,
    event?.category,
  ].map(value => cleanText(value, 1000)).filter(Boolean).join(' ').toLowerCase();
}

function isWheelTorqueRequiredEvent(event) {
  if (event?.torqueCheckRequired === true) return true;
  const text = torqueEventText(event);
  if (!text) return false;
  if (/\b(re-?torque|torque\s+re-?check|wheel\s+torque)\b/i.test(text)) return true;
  return /\bwheel(s)?\b/i.test(text) && /\b(off|removed|refit|refitted|changed|changed over)\b/i.test(text);
}

function torqueNmFromEvent(event) {
  const explicit = maybeNumber(event?.torqueNm || event?.torqueNM || event?.torque);
  if (explicit) return explicit;
  const match = torqueEventText(event).match(/\b(\d{3,4})\s*(?:n\s*m|nm|newton)/i);
  if (match) {
    const parsed = maybeNumber(match[1]);
    if (parsed) return parsed;
  }
  return DEFAULT_WHEEL_TORQUE_NM;
}

function maybePlantServiceIntervalHours(value) {
  const num = maybeNumber(value);
  return PLANT_SERVICE_INTERVAL_HOURS.has(num) ? num : null;
}

function maybeVehicleServiceIntervalMiles(value) {
  const num = maybeNumber(value);
  return VEHICLE_SERVICE_INTERVAL_MILES.has(num) ? num : null;
}

function looksLikeVehicleReg(value) {
  return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(normaliseVehicleRef(value));
}

function isVehicleAsset(asset) {
  const text = [
    asset?.assetType,
    asset?.category,
    asset?.vehicleType,
    asset?.displayName,
    asset?.machineType,
    asset?.plantNumber,
    asset?.registration,
    asset?.regNo,
    asset?.vehicleRegistration,
    asset?.numberPlate,
  ].filter(Boolean).join(' ').toLowerCase();
  if (looksLikeVehicleReg(asset?.registration || asset?.regNo || asset?.vehicleRegistration || asset?.numberPlate || asset?.plantNumber)) return true;
  return /\b(vehicle|van|car|hgv|lorry|wagon|truck|transit|sprinter|tipper|pickup|daf|scania|volvo|ford|trailer|low loader|kassbohrer|nooteboom)\b/.test(text);
}

function categoryFromPlantServiceType(value) {
  const lower = cleanText(value, 160).toLowerCase();
  if (lower.includes('torque') || lower.includes('wheel off')) return 'inspection';
  if (lower.includes('schedule review')) return 'inspection';
  if (lower.includes('hire check')) return 'inspection';
  if (lower.includes('inspection')) return 'inspection';
  if (lower.includes('repair')) return 'repair';
  if (lower.includes('parts')) return 'parts';
  return 'service';
}

function plantEventHasScheduleUpdate(event) {
  if (!event) return false;
  return Boolean(maybeIsoDate(event.nextDueDate))
    || (event.nextDueHours !== null && event.nextDueHours !== undefined && event.nextDueHours !== '')
    || (event.nextDueMileage !== null && event.nextDueMileage !== undefined && event.nextDueMileage !== '');
}

function applyPlantServiceSchedule(asset, event, options = {}) {
  if (event.nextDueDate) {
    asset.nextServiceDueDate = event.nextDueDate;
    const basis = event.category === 'service'
      ? cleanText(event.nextDueDateBasis || 'manual', 80)
      : cleanText(event.nextDueDateBasis || 'manual_schedule_review', 80);
    asset.nextServiceDueBasis = basis === '12_month_service_rule' && event.category !== 'service'
      ? 'manual_schedule_review'
      : basis;
  }
  if (event.nextDueHours !== null && event.nextDueHours !== undefined && event.nextDueHours !== '') {
    asset.nextServiceDueHours = event.nextDueHours;
  } else if (options.clearMissingHours) {
    delete asset.nextServiceDueHours;
  }
  if (event.nextDueMileage !== null && event.nextDueMileage !== undefined && event.nextDueMileage !== '') {
    asset.nextServiceDueMileage = event.nextDueMileage;
  } else if (options.clearMissingMileage) {
    delete asset.nextServiceDueMileage;
  }
}

function plantGroupForAsset(asset) {
  if (isVehicleAsset(asset)) {
    return { key: 'vehicles', label: 'Vehicles' };
  }
  const text = [
    asset?.displayName,
    asset?.machineType,
    asset?.plantNumber,
    asset?.serialNumber,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/(dumper|thwaites|benford|pt3000|pt6000|pt9000|hd1000|hd1001)/.test(text)) {
    return { key: 'dumpers', label: 'Dumpers' };
  }
  if (/\b(breaker|saw|stihl|hilti|bosch|pecker|borer|auger|drill|laser|pump|generator|grinder|mixer|jib|bucket|attachment|tool)\b/.test(text)) {
    return { key: 'tools', label: 'Tools' };
  }
  if (/\b(roller|telehandler|loader|forklift|tractor|mower|barrow|wacker|plate|compactor|rammer|roller)\b/.test(text)) {
    return { key: 'small_plant', label: 'Small plant' };
  }
  if (/(excavator|digger|kubota|kx\d|kx-|k008|u10|cat\s*3\d{2}|hyundai|mecalac)/.test(text)) {
    return { key: 'diggers', label: 'Diggers' };
  }
  return { key: 'other', label: 'Other' };
}

function withPlantGroup(asset) {
  const group = plantGroupForAsset(asset);
  return { ...asset, plantGroup: group.key, plantGroupLabel: group.label };
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlToBytes(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return {};
  try {
    const body = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    return JSON.parse(atob(body));
  } catch {
    return {};
  }
}

function authDiagnostics(auth) {
  if (!auth || auth === false) return { present: Boolean(auth), badData: auth === false };
  const claims = decodeJwtPayload(auth.token);
  return {
    present: true,
    hasToken: Boolean(auth.token),
    tokenLength: String(auth.token || '').length,
    hasRefreshToken: Boolean(auth.refreshToken),
    refreshTokenLength: String(auth.refreshToken || '').length,
    hasClientId: Boolean(auth.clientId),
    hasTenantId: Boolean(auth.tenantId),
    tmsId: cleanText(auth.tmsId || DEFAULT_TMS, 80),
    claims: {
      aud: cleanText(claims.aud, 160),
      azp: cleanText(claims.azp, 160),
      appid: cleanText(claims.appid, 160),
      tid: cleanText(claims.tid, 160),
      scp: cleanText(claims.scp, 300),
      exp: claims.exp || null,
      expIso: claims.exp ? new Date(claims.exp * 1000).toISOString() : '',
    },
  };
}

function plantIdFromValue(value) {
  const text = cleanText(value, 128);
  if (!text) return null;
  if (/^\d+$/.test(text)) return `plant-${Number(text)}`;
  if (/^[A-Za-z0-9._:-]+$/.test(text)) return text;
  return null;
}

function newPlantId(seed) {
  const base = cleanText(seed, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : String(Date.now());
  return `plant-${base || 'manual'}-${suffix}`;
}

async function getKvJson(env, key, fallback) {
  const val = await env.PMG_DATA.get(key);
  if (!val) return cloneValue(fallback);
  const parsed = safeJsonParse(val);
  if (parsed === null || parsed === undefined) return cloneValue(fallback);
  return parsed;
}

async function putKvJson(env, key, value) {
  await env.PMG_DATA.put(key, JSON.stringify(value));
}

async function getHaultechAuth(env, options = {}) {
  const now = Date.now();
  if (
    !options.force &&
    haultechAuthCache?.auth &&
    now - haultechAuthCache.loadedAt < HAULTECH_AUTH_CACHE_MS
  ) {
    return haultechAuthCache.auth;
  }
  const authVal = await env.PMG_DATA.get('haultech-auth');
  if (!authVal) return null;
  const auth = safeJsonParse(authVal);
  if (!auth) return false;
  haultechAuthCache = { auth, loadedAt: now };
  return auth;
}

function setHaultechAuthCache(auth) {
  haultechAuthCache = auth ? { auth, loadedAt: Date.now() } : null;
}

function latestDate(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return a > b ? a : b;
}

function latestTimestamp(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return String(a) > String(b) ? String(a) : String(b);
}

function plantEventActivityAt(event) {
  return cleanText(event?.createdAt || event?.updatedAt || event?.date || '', 80);
}

function addCalendarMonths(value, months) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const targetMonthIndex = monthIndex + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function serviceDueDateInfo(asset) {
  if (isValidIsoDate(asset.nextServiceDueDate)) {
    return {
      date: asset.nextServiceDueDate,
      basis: cleanText(asset.nextServiceDueBasis || 'manual', 80),
    };
  }
  const date = addCalendarMonths(asset.lastServiceDate, PLANT_SERVICE_INTERVAL_MONTHS);
  return date ? { date, basis: '12_month_service_rule' } : { date: '', basis: '' };
}

function plantDateDueStatus(asset, today) {
  const info = serviceDueDateInfo(asset);
  if (!info.date) return null;
  const dueTime = Date.parse(`${info.date}T00:00:00Z`);
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const days = Math.round((dueTime - todayTime) / 86400000);
  const labelPrefix = info.basis === '12_month_service_rule' ? '12-month' : 'Date';
  if (days < 0) return { state: 'overdue', label: `${labelPrefix} due`, days, dueDate: info.date, dueBasis: info.basis, dueType: 'date' };
  if (days <= PLANT_DATE_DUE_SOON_DAYS) return { state: 'due-soon', label: `${labelPrefix} soon`, days, dueDate: info.date, dueBasis: info.basis, dueType: 'date' };
  return { state: 'scheduled', label: `${labelPrefix} set`, days, dueDate: info.date, dueBasis: info.basis, dueType: 'date' };
}

function plantHoursDueStatus(asset) {
  if (asset.nextServiceDueHours && asset.lastKnownHours) {
    const remaining = asset.nextServiceDueHours - asset.lastKnownHours;
    if (remaining <= 0) return { state: 'overdue', label: 'Hours due', hoursRemaining: remaining, dueType: 'hours' };
    if (remaining <= PLANT_HOURS_DUE_SOON) return { state: 'due-soon', label: 'Hours soon', hoursRemaining: remaining, dueType: 'hours' };
    return { state: 'scheduled', label: 'Hours set', hoursRemaining: remaining, dueType: 'hours' };
  }
  return null;
}

function plantMileageDueStatus(asset) {
  if (asset.nextServiceDueMileage && asset.lastKnownMileage) {
    const remaining = asset.nextServiceDueMileage - asset.lastKnownMileage;
    if (remaining <= 0) return { state: 'overdue', label: 'Mileage due', mileageRemaining: remaining, dueType: 'mileage' };
    if (remaining <= VEHICLE_MILEAGE_DUE_SOON) return { state: 'due-soon', label: 'Mileage soon', mileageRemaining: remaining, dueType: 'mileage' };
    return { state: 'scheduled', label: 'Mileage set', mileageRemaining: remaining, dueType: 'mileage' };
  }
  return null;
}

function comparePlantDueCandidates(a, b) {
  const order = { overdue: 0, 'due-soon': 1, scheduled: 2 };
  const stateDiff = (order[a.state] ?? 9) - (order[b.state] ?? 9);
  if (stateDiff) return stateDiff;
  if (a.dueType === 'date' && b.dueType === 'date') return a.days - b.days;
  if (a.dueType === 'hours' && b.dueType === 'hours') return a.hoursRemaining - b.hoursRemaining;
  if (a.dueType === 'mileage' && b.dueType === 'mileage') return a.mileageRemaining - b.mileageRemaining;
  if (a.state === 'scheduled') return a.dueType === 'date' ? -1 : 1;
  return ['hours', 'mileage'].includes(a.dueType) ? -1 : 1;
}

function plantDueStatus(asset) {
  const today = new Date().toISOString().slice(0, 10);
  const candidates = [plantHoursDueStatus(asset), plantMileageDueStatus(asset), plantDateDueStatus(asset, today)].filter(Boolean);
  if (candidates.length) return candidates.sort(comparePlantDueCandidates)[0];
  if (asset.lastInspectionDate) return { state: 'watch', label: 'No service date' };
  return { state: 'unknown', label: 'Needs first setup' };
}

function plantPushAlertForAsset(asset) {
  const meta = asset.dueMeta || plantDueStatus(asset);
  if (!meta) return null;
  if (meta.dueType === 'hours') {
    if (meta.state === 'overdue') {
      return {
        plantNumber: asset.plantNumber || '',
        displayName: asset.displayName || asset.id,
        status: 'hours_overdue',
        label: 'Hours service overdue',
        detail: 'Service hours are overdue.',
        dueType: 'hours',
        hoursRemaining: meta.hoursRemaining,
      };
    }
    return null;
  }
  if (meta.dueType === 'mileage') {
    if (meta.state === 'overdue') {
      return {
        plantNumber: asset.plantNumber || '',
        displayName: asset.displayName || asset.id,
        status: 'mileage_overdue',
        label: 'Mileage service overdue',
        detail: 'Service mileage is overdue.',
        dueType: 'mileage',
        mileageRemaining: meta.mileageRemaining,
      };
    }
    return null;
  }
  if (meta.dueType !== 'date' || !Number.isFinite(Number(meta.days))) return null;
  const days = Number(meta.days);
  if (days < 0) {
    return {
      plantNumber: asset.plantNumber || '',
      displayName: asset.displayName || asset.id,
      status: 'overdue',
      label: 'Service overdue',
      detail: `Due date was ${meta.dueDate}.`,
      dueType: 'date',
      dueDate: meta.dueDate,
      days,
    };
  }
  if (!PLANT_PUSH_ALERT_DAYS.has(days)) return null;
  return {
    plantNumber: asset.plantNumber || '',
    displayName: asset.displayName || asset.id,
    status: days === 0 ? 'due_today' : `due_in_${days}_days`,
    label: days === 0 ? 'Service due today' : `Service due in ${days} days`,
    detail: `Due date ${meta.dueDate}.`,
    dueType: 'date',
    dueDate: meta.dueDate,
    days,
  };
}

function plantPushAlertsFromState(state) {
  return safeArray(state.assets)
    .map(asset => ({ assetId: asset.id, ...plantPushAlertForAsset(asset) }))
    .filter(alert => alert.label)
    .sort((a, b) => {
      const ad = Number.isFinite(Number(a.days)) ? Number(a.days) : -9999;
      const bd = Number.isFinite(Number(b.days)) ? Number(b.days) : -9999;
      if (ad !== bd) return ad - bd;
      return String(a.plantNumber || '').localeCompare(String(b.plantNumber || ''), undefined, { numeric: true });
    });
}

function normalisePushSubscription(body) {
  const endpoint = cleanText(body?.endpoint, 2000);
  if (!endpoint || !endpoint.startsWith('https://')) return null;
  const keys = safeObject(body?.keys);
  const p256dh = cleanText(keys.p256dh, 300);
  const auth = cleanText(keys.auth, 160);
  return {
    endpoint,
    expirationTime: body?.expirationTime || null,
    keys: { p256dh, auth },
    timezone: cleanText(body?.timezone, 80),
    userAgent: cleanText(body?.userAgent, 240),
    role: cleanText(body?.role || 'tony', 40),
    enabled: body?.enabled !== false,
  };
}

function ukDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function isPlantPushWindow(now = new Date()) {
  const uk = ukDateParts(now);
  return uk.hour === 8 && uk.minute < 30;
}

function vapidPublicJwk() {
  const raw = base64UrlToBytes(PLANT_PUSH_PUBLIC_KEY);
  if (raw.length !== 65 || raw[0] !== 4) return null;
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(raw.slice(1, 33)),
    y: bytesToBase64Url(raw.slice(33, 65)),
  };
}

function derEcdsaToJose(signature) {
  const bytes = new Uint8Array(signature);
  if (bytes.length === 64) return bytesToBase64Url(bytes);
  if (bytes[0] !== 0x30) return bytesToBase64Url(bytes);
  let offset = 2;
  if (bytes[1] & 0x80) offset = 2 + (bytes[1] & 0x7f);
  if (bytes[offset] !== 0x02) return bytesToBase64Url(bytes);
  const rLength = bytes[offset + 1];
  let r = bytes.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (bytes[offset] !== 0x02) return bytesToBase64Url(bytes);
  const sLength = bytes[offset + 1];
  let s = bytes.slice(offset + 2, offset + 2 + sLength);
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  const out = new Uint8Array(64);
  out.set(r.slice(-32), 32 - Math.min(32, r.length));
  out.set(s.slice(-32), 64 - Math.min(32, s.length));
  return bytesToBase64Url(out);
}

async function vapidAuthHeader(env, endpoint) {
  const privateKey = cleanText(env.WEB_PUSH_PRIVATE_KEY, 120);
  const publicJwk = vapidPublicJwk();
  if (!privateKey || !publicJwk) return null;
  const audience = new URL(endpoint).origin;
  const header = bytesToBase64Url(utf8Bytes(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToBase64Url(utf8Bytes(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: PLANT_PUSH_SUBJECT,
  })));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...publicJwk, d: privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8Bytes(signingInput));
  return `vapid t=${signingInput}.${derEcdsaToJose(signature)}, k=${PLANT_PUSH_PUBLIC_KEY}`;
}

async function sendPlantPush(env, subscription) {
  try {
    const authHeader = await vapidAuthHeader(env, subscription.endpoint);
    if (!authHeader) return { ok: false, status: 0, error: 'web_push_secret_missing' };
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        Urgency: 'normal',
        Topic: 'pmg-plant-service-alert',
        Authorization: authHeader,
      },
    });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, expired: [404, 410].includes(response.status) };
  } catch (error) {
    return { ok: false, status: 0, error: cleanText(error?.message || error, 300) };
  }
}

async function runScheduledPlantPushAlerts(env, event) {
  const uk = ukDateParts();
  const status = {
    checkedAt: new Date().toISOString(),
    ukDate: uk.date,
    ukHour: uk.hour,
    ukMinute: uk.minute,
    cron: event?.cron || '',
    status: 'skipped',
    alertCount: 0,
    subscriptionCount: 0,
    sent: 0,
    failed: 0,
  };
  if (!isPlantPushWindow()) {
    await putKvJson(env, PLANT_PUSH_LAST_RUN_KEY, status);
    return status;
  }
  const previous = await getKvJson(env, PLANT_PUSH_LAST_RUN_KEY, {});
  if (previous.ukDate === uk.date && ['sent', 'no_alerts', 'no_subscriptions', 'secret_missing'].includes(previous.status)) {
    return previous;
  }
  const state = await loadPlantData(env);
  const alerts = plantPushAlertsFromState(state);
  status.alertCount = alerts.length;
  status.alerts = alerts.slice(0, 10);
  if (!alerts.length) {
    status.status = 'no_alerts';
    await putKvJson(env, PLANT_PUSH_LAST_RUN_KEY, status);
    return status;
  }
  if (!cleanText(env.WEB_PUSH_PRIVATE_KEY, 120)) {
    status.status = 'secret_missing';
    await putKvJson(env, PLANT_PUSH_LAST_RUN_KEY, status);
    return status;
  }
  const subscriptions = safeObject(await getKvJson(env, PLANT_PUSH_SUBSCRIPTIONS_KEY, {}));
  const enabled = Object.entries(subscriptions).filter(([, subscription]) => subscription?.enabled && subscription?.endpoint);
  status.subscriptionCount = enabled.length;
  if (!enabled.length) {
    status.status = 'no_subscriptions';
    await putKvJson(env, PLANT_PUSH_LAST_RUN_KEY, status);
    return status;
  }
  const expiredIds = [];
  const results = [];
  for (const [id, subscription] of enabled) {
    const result = await sendPlantPush(env, subscription);
    results.push({ id, ...result });
    if (result.ok) status.sent += 1;
    else status.failed += 1;
    if (result.expired) expiredIds.push(id);
  }
  for (const id of expiredIds) delete subscriptions[id];
  if (expiredIds.length) await putKvJson(env, PLANT_PUSH_SUBSCRIPTIONS_KEY, subscriptions);
  status.status = status.sent ? 'sent' : 'failed';
  status.results = results.slice(0, 20);
  await putKvJson(env, PLANT_PUSH_LAST_RUN_KEY, status);
  return status;
}

function normaliseFilterPart(part, assetId, source) {
  const type = cleanText(part?.type || part?.label || 'Service/parts note', 120);
  const code = cleanText(part?.code || part?.partNumber || '', 160);
  const notes = cleanText(part?.notes || '', 600);
  const idSeed = `${assetId}|${type}|${code}|${notes}|${source?.row || ''}`;
  return {
    id: cleanText(part?.id, 140) || `part-${idSeed.split('').reduce((sum, ch) => ((sum * 31) + ch.charCodeAt(0)) >>> 0, 7).toString(16)}`,
    assetId,
    type,
    code,
    notes,
    source,
  };
}

function mergePlantData(snapshot, manualEvents, assetOverrides, filterOverrides) {
  const baseSnapshot = safeObject(snapshot);
  const assetMap = new Map();
  const history = safeArray(baseSnapshot.history).map(item => ({ ...item, origin: item.origin || 'workbook' }));
  const reviewItems = safeArray(baseSnapshot.reviewItems);
  const filterParts = {};

  for (const asset of safeArray(baseSnapshot.assets)) {
    if (asset && asset.id) assetMap.set(asset.id, { ...asset });
  }

  for (const [assetId, override] of Object.entries(safeObject(assetOverrides))) {
    const existing = assetMap.get(assetId) || {
      id: assetId,
      plantNumber: cleanText(override.plantNumber) || assetId.replace(/^plant-/, ''),
      displayName: cleanText(override.displayName) || cleanText(override.machineType) || assetId,
      machineType: '',
      serialNumber: '',
      year: '',
      site: '',
      scheduleNotes: [],
      sources: [],
    };
    assetMap.set(assetId, { ...existing, ...safeObject(override), id: assetId, origin: 'manual' });
  }

  for (const [assetId, parts] of Object.entries(safeObject(baseSnapshot.filterParts))) {
    filterParts[assetId] = safeArray(parts).map(part => normaliseFilterPart(part, assetId, part.source || { type: 'workbook' }));
  }
  for (const [assetId, parts] of Object.entries(safeObject(filterOverrides))) {
    filterParts[assetId] = [
      ...(filterParts[assetId] || []),
      ...safeArray(parts).map(part => normaliseFilterPart(part, assetId, part.source || { type: 'manual' })),
    ];
  }

  for (const event of safeArray(manualEvents)) {
    if (!event || !event.assetId) continue;
    history.push({ ...event, origin: 'mechanic_app' });
    const asset = assetMap.get(event.assetId) || {
      id: event.assetId,
      plantNumber: event.plantNumber || event.assetId.replace(/^plant-/, ''),
      displayName: event.plantNumber ? `Plant ${event.plantNumber}` : event.assetId,
      machineType: '',
      serialNumber: '',
      year: '',
      site: '',
      scheduleNotes: [],
      sources: [],
    };
    asset.lastKnownHours = Math.max(asset.lastKnownHours || 0, event.hours || 0) || asset.lastKnownHours || null;
    asset.lastKnownMileage = Math.max(asset.lastKnownMileage || 0, event.mileage || event.odometer || 0) || asset.lastKnownMileage || null;
    if (event.category === 'service') {
      asset.lastServiceDate = latestDate(asset.lastServiceDate, event.date);
      if (event.hours) asset.lastServiceHours = event.hours;
      if (event.mileage || event.odometer) asset.lastServiceMileage = event.mileage || event.odometer;
      applyPlantServiceSchedule(asset, event, { clearMissingHours: true, clearMissingMileage: true });
    } else if (plantEventHasScheduleUpdate(event)) {
      applyPlantServiceSchedule(asset, event);
      asset.lastServiceScheduleReviewDate = latestDate(asset.lastServiceScheduleReviewDate, event.date);
      asset.lastServiceScheduleReviewType = cleanText(event.serviceType || event.category, 120);
    }
    if (event.category === 'inspection') asset.lastInspectionDate = latestDate(asset.lastInspectionDate, event.date);
    asset.latestMechanicEntryAt = latestTimestamp(asset.latestMechanicEntryAt, plantEventActivityAt(event));
    asset.lastWorkedAt = latestTimestamp(asset.lastWorkedAt, plantEventActivityAt(event));
    assetMap.set(event.assetId, asset);

    if (event.filterParts?.length) {
      filterParts[event.assetId] = [
        ...(filterParts[event.assetId] || []),
        ...event.filterParts.map(part => normaliseFilterPart(part, event.assetId, { type: 'mechanic_app', eventId: event.id })),
      ];
    }
  }

  const historyByAsset = {};
  for (const event of history) {
    if (!event.assetId) continue;
    historyByAsset[event.assetId] = historyByAsset[event.assetId] || [];
    historyByAsset[event.assetId].push(event);
  }
  for (const events of Object.values(historyByAsset)) {
    events.sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
  }

  const reviewByAsset = {};
  for (const item of reviewItems) {
    if (!item.assetId) continue;
    reviewByAsset[item.assetId] = reviewByAsset[item.assetId] || [];
    reviewByAsset[item.assetId].push(item);
  }

  const assets = Array.from(assetMap.values()).map(asset => {
    const status = plantDueStatus(asset);
    const latestHistoryAt = safeArray(historyByAsset[asset.id]).reduce((latest, event) => latestTimestamp(latest, plantEventActivityAt(event)), '');
    const lastWorkedAt = [
      asset.lastWorkedAt,
      asset.latestMechanicEntryAt,
      latestHistoryAt,
      asset.updatedAt,
      asset.lastServiceDate,
      asset.lastInspectionDate,
      asset.lastServiceScheduleReviewDate,
      asset.lastCostDate,
    ].reduce((latest, value) => latestTimestamp(latest, value), '');
    return withPlantGroup({
      ...asset,
      lastWorkedAt,
      latestHistoryAt,
      dueStatus: status.state,
      dueLabel: status.label,
      dueMeta: status,
      historyCount: (historyByAsset[asset.id] || []).length,
      filterPartCount: (filterParts[asset.id] || []).length,
      reviewCount: (reviewByAsset[asset.id] || []).length,
    });
  });

  assets.sort((a, b) => {
    const an = /^\d+$/.test(String(a.plantNumber || '')) ? Number(a.plantNumber) : Number.POSITIVE_INFINITY;
    const bn = /^\d+$/.test(String(b.plantNumber || '')) ? Number(b.plantNumber) : Number.POSITIVE_INFINITY;
    if (an !== bn) return an - bn;
    return String(a.displayName || a.id).localeCompare(String(b.displayName || b.id));
  });

  const baseStats = safeObject(baseSnapshot.stats);
  const stats = {
    assetCount: assets.length,
    historyEventCount: history.length,
    filterPartCount: Object.values(filterParts).reduce((sum, parts) => sum + parts.length, 0),
    reviewItemCount: reviewItems.length,
    unusedSchedulePlantNumberCount: baseStats.unusedSchedulePlantNumberCount || 0,
    serviceDateScheduleCount: assets.filter(asset => {
      const info = serviceDueDateInfo(asset);
      return info.date && info.basis === '12_month_service_rule';
    }).length,
    dueSoonCount: assets.filter(asset => asset.dueStatus === 'due-soon').length,
    overdueCount: assets.filter(asset => asset.dueStatus === 'overdue').length,
    manualEventCount: safeArray(manualEvents).length,
    plantGroupCounts: assets.reduce((counts, asset) => {
      const key = asset.plantGroup || 'other';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    importedAt: baseSnapshot.importedAt || '',
    generatedAt: baseSnapshot.generatedAt || '',
  };

  return {
    schema: 'pmg-plant-state-v1',
    sharePointEvidenceRoot: baseSnapshot.sharePointEvidenceRoot || 'SHARED/Plant and Tool Service Records',
    sources: safeObject(baseSnapshot.sources),
    plantOnlyRules: safeObject(baseSnapshot.plantOnlyRules),
    assets,
    history,
    historyByAsset,
    filterParts,
    reviewItems,
    reviewByAsset,
    stats,
  };
}

async function loadPlantData(env) {
  const snapshot = await getKvJson(env, PLANT_SNAPSHOT_KEY, {});
  const manualEvents = await getKvJson(env, PLANT_MANUAL_EVENTS_KEY, []);
  const assetOverrides = await getKvJson(env, PLANT_ASSET_OVERRIDES_KEY, {});
  const filterOverrides = await getKvJson(env, PLANT_FILTER_OVERRIDES_KEY, {});
  return mergePlantData(snapshot, manualEvents, assetOverrides, filterOverrides);
}

function torqueTaskFromEvent(event, asset, vehicleRef) {
  const eventId = cleanText(event?.id, 140);
  const activityAt = plantEventActivityAt(event);
  const taskId = cleanText(event?.torqueTaskId, 140) || `torque-${eventId || normaliseVehicleRef(asset?.id || vehicleRef)}-${cleanText(activityAt || event?.date || Date.now(), 40).replace(/[^A-Za-z0-9]/g, '')}`;
  return {
    taskId,
    eventId,
    assetId: cleanText(asset?.id, 140),
    vehicle: normaliseVehicleRef(vehicleRef || asset?.plantNumber || asset?.displayName),
    displayVehicle: cleanText(asset?.plantNumber || asset?.displayName || vehicleRef, 120),
    date: maybeIsoDate(event?.date),
    createdAt: cleanText(event?.createdAt || activityAt, 80),
    torqueNm: torqueNmFromEvent(event),
    sourceName: cleanText(event?.sourceName || event?.createdBy || 'Mechanic app', 120),
    createdBy: cleanText(event?.createdBy || event?.sourceName || 'Mechanic app', 120),
    note: cleanText(event?.description || event?.anomalies || event?.serviceType || 'Wheel torque re-check required', 500),
  };
}

function ticketTorqueConfirmations(ticket) {
  return [
    ...safeArray(ticket?.torqueChecks),
    ...safeArray(ticket?.torqueConfirmations),
    ...(ticket?.torqueCheck ? [ticket.torqueCheck] : []),
  ].filter(item => item && typeof item === 'object');
}

function ticketConfirmsTorqueTask(ticket, task) {
  if (ticket?.type !== 'driver_walkaround') return false;
  if (normaliseVehicleRef(ticket?.vehicle) !== normaliseVehicleRef(task.vehicle)) return false;
  const ticketAt = cleanText(ticket?.completedAt || ticket?.createdAt || '', 80);
  const taskAt = cleanText(task.createdAt || task.date || '', 80);
  if (ticketAt && taskAt && ticketAt < taskAt) return false;
  return ticketTorqueConfirmations(ticket).some(confirmation => {
    if (confirmation.confirmed !== true) return false;
    const confirmationTask = cleanText(confirmation.taskId, 140);
    const confirmationEvent = cleanText(confirmation.eventId, 140);
    return (confirmationTask && confirmationTask === task.taskId)
      || (confirmationEvent && confirmationEvent === task.eventId)
      || (!confirmationTask && !confirmationEvent);
  });
}

async function listStoredTickets(env) {
  const tickets = [];
  let cursor;
  do {
    const list = await env.PMG_DATA.list({ prefix: 'ticket:', cursor });
    const page = await Promise.all(list.keys.map(async ({ name }) => {
      const val = await env.PMG_DATA.get(name);
      return safeJsonParse(val);
    }));
    tickets.push(...page.filter(Boolean));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return tickets;
}

async function openTorqueTasksForVehicle(env, vehicleRef) {
  const state = await loadPlantData(env);
  const assets = state.assets.filter(asset => assetMatchesVehicle(asset, vehicleRef));
  if (!assets.length) return { state, assets, tasks: [] };
  const tickets = await listStoredTickets(env);
  const tasks = [];
  for (const asset of assets) {
    for (const event of safeArray(state.historyByAsset[asset.id])) {
      if (!isWheelTorqueRequiredEvent(event)) continue;
      const task = torqueTaskFromEvent(event, asset, vehicleRef);
      if (!tickets.some(ticket => ticketConfirmsTorqueTask(ticket, task))) {
        tasks.push(task);
      }
    }
  }
  tasks.sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')));
  return { state, assets, tasks };
}

async function appendPlantEvent(env, event) {
  const events = await getKvJson(env, PLANT_MANUAL_EVENTS_KEY, []);
  const next = [...safeArray(events), event].slice(-2000);
  await putKvJson(env, PLANT_MANUAL_EVENTS_KEY, next);
}

// ── Haultech token auto-refresh via Microsoft ROPC refresh_token flow ────────
async function refreshHaultechToken(env) {
  const auth = await getHaultechAuth(env, { force: true });
  if (!auth || auth === false) return null;
  if (!auth.refreshToken || !auth.clientId || !auth.tenantId) return null;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
    scope: `${auth.clientId}/access_as_user offline_access`,
  });

  try {
    const resp = await fetch(`https://login.microsoftonline.com/${auth.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://app.httms.uk',
        'User-Agent': 'Mozilla/5.0',
      },
      body: params.toString(),
    });
    const result = await resp.json();
    if (result.access_token) {
      // Update stored auth with new tokens
      auth.token = result.access_token;
      if (result.refresh_token) auth.refreshToken = result.refresh_token;
      await env.PMG_DATA.put('haultech-auth', JSON.stringify(auth));
      setHaultechAuthCache(auth);
      return result.access_token;
    }
  } catch (e) {}
  return null;
}

async function recordHaultechRefreshHealth(env, status) {
  const payload = {
    checkedAt: new Date().toISOString(),
    ...status,
  };
  await putKvJson(env, HAULTECH_REFRESH_HEALTH_KEY, payload);
  return payload;
}

async function runScheduledHaultechRefresh(env, event) {
  const newToken = await refreshHaultechToken(env);
  const status = await recordHaultechRefreshHealth(env, {
    ok: Boolean(newToken),
    refreshed: Boolean(newToken),
    source: 'cloudflare-scheduled',
    cron: event?.cron || '',
    error: newToken ? '' : 'refresh_failed',
  });
  if (!newToken) throw new Error('haultech_refresh_failed');
  return status;
}

async function fetchHaultechCustomerPage(env, continuationToken = '') {
  const auth = await getHaultechAuth(env);
  if (!auth || auth === false) throw new Error('no_haultech_auth');
  const qs = { take: '1000' };
  if (continuationToken) qs.continuationToken = continuationToken;
  const url = `${HT_BASE}${queryPath('/api/Customer/GetCustomerPaginated', qs)}`;
  const headers = {
    'Authorization': `Bearer ${auth.token}`,
    'oauthTmsId': auth.tmsId || DEFAULT_TMS,
    'Accept': 'application/json',
  };
  let resp = await fetch(url, { headers });
  if (resp.status === 401 && auth.refreshToken) {
    const newToken = await refreshHaultechToken(env);
    if (newToken) resp = await fetch(url, { headers: { ...headers, 'Authorization': `Bearer ${newToken}` } });
  }
  if (!resp.ok) throw new Error(`haultech_customers_http_${resp.status}`);
  const rows = await resp.json();
  return {
    rows: Array.isArray(rows) ? rows : [],
    continuationToken: resp.headers.get('continuationtoken') || '',
  };
}

async function fetchLiveHaultechCustomers(env) {
  const customers = [];
  let continuationToken = '';
  do {
    const page = await fetchHaultechCustomerPage(env, continuationToken);
    customers.push(...page.rows);
    continuationToken = page.continuationToken;
  } while (continuationToken);

  const seen = new Set();
  const out = [];
  const hasAndreBusinessAccount = customers.some(customer => cleanText(customer?.id, 80) === ANDRE_BUSINESS_CUSTOMER_ID);
  for (const customer of customers) {
    if (customer?.active === false) continue;
    const id = cleanText(customer?.id, 80);
    if (hasAndreBusinessAccount && id === ANDRE_OLD_CUSTOMER_ID) continue;
    let name = cleanText(customer?.companyName, 200);
    if (!name || !id) continue;
    let code = cleanText(customer?.customerCode, 120);
    let aliases = [];
    if (id === ANDRE_BUSINESS_CUSTOMER_ID) {
      name = ANDRE_BUSINESS_NAME;
      code = 'Andre';
      aliases = ['Andre', 'Andrei', 'Andrews Paving', 'Andrews Paving and Landscaping'];
    } else if (id === IAN_CARTER_CUSTOMER_ID || name.toLowerCase() === 'ian carter') {
      aliases = IAN_CARTER_ALIASES.slice();
    } else if (id === W_ROBINSON_CUSTOMER_ID || name.toLowerCase() === 'w.robinson') {
      aliases = W_ROBINSON_ALIASES.slice();
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      name,
      code,
      aliases,
      defaultServiceLevelId: cleanText(customer?.defaultServiceLevelId, 80),
      active: true,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function refreshHaultechCustomers(env, event) {
  const customers = await fetchLiveHaultechCustomers(env);
  if (customers.length < 100) throw new Error(`suspicious_customer_count_${customers.length}`);
  await putKvJson(env, HAULTECH_CUSTOMERS_KEY, customers);
  const status = {
    ok: true,
    refreshedAt: new Date().toISOString(),
    source: 'haultech-live',
    cron: event?.cron || '',
    count: customers.length,
  };
  await putKvJson(env, HAULTECH_CUSTOMERS_HEALTH_KEY, status);
  return status;
}

// ── Haultech proxy helper ────────────────────────────────────────────────────
async function htFetch(env, apiPath, opts = {}) {
  const auth = await getHaultechAuth(env);
  if (!auth) return corsResponse(JSON.stringify({ error: 'no_haultech_auth' }), 401);
  if (auth === false) return corsResponse(JSON.stringify({ error: 'bad_auth_data' }), 500);

  let token = auth.token;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'oauthTmsId': auth.tmsId || DEFAULT_TMS,
    'Accept': 'application/json',
  };
  if (opts.body && typeof opts.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const resp = await fetch(`${HT_BASE}${apiPath}`, {
    method: opts.method || 'GET',
    headers: { ...headers, ...(opts.headers || {}) },
    body: opts.body,
  });

  // If 401, try one token refresh and retry
  if (resp.status === 401 && auth.refreshToken) {
    const newToken = await refreshHaultechToken(env);
    if (newToken) {
      const retryResp = await fetch(`${HT_BASE}${apiPath}`, {
        method: opts.method || 'GET',
        headers: { ...headers, 'Authorization': `Bearer ${newToken}`, ...(opts.headers || {}) },
        body: opts.body,
      });
      return corsResponse(await retryResp.text(), retryResp.status);
    }
  }

  const data = await resp.text();
  return corsResponse(data, resp.status);
}

async function mergeJobStatusOverrides(env, date, jobs) {
  const statusIndex = safeObject(await getKvJson(env, jobStatusIndexKey(date), {}));
  return jobs.map((job) => {
    const c = (job.consignments || [])[0] || null;
    const ids = [job.id, job._id, c?.id, job.jobId, c?.consignmentId]
      .filter(Boolean)
      .map(String);
    for (const id of ids) {
      const statusData = safeObject(statusIndex[id]);
      if (statusData.status) {
        const status = cleanText(statusData.status, 60);
        const merged = { ...job, status };
        if (['scheduled', 'not_started', 'not-started'].includes(status.toLowerCase())) {
          merged.deliveryStatus = 'Scheduled';
          merged.collectionStatus = 'None';
        }
        return merged;
      }
    }
    return job;
  });
}

function haultechJobIds(job) {
  const consignments = safeArray(job?.consignments || job?.Consignments);
  const ids = [job?.id, job?._id, job?.jobId, job?.jobNumber];
  for (const consignment of consignments) {
    ids.push(
      consignment?.id,
      consignment?._id,
      consignment?.consignmentId,
      consignment?.jobId,
      consignment?.jobNumber
    );
  }
  return ids.filter(Boolean).map(String);
}

function findHaultechJobById(jobs, jobId) {
  const target = String(jobId || '');
  return safeArray(jobs).find(job => haultechJobIds(job).includes(target)) || null;
}

function mergeDriverNoteText(existing, driverNote) {
  const note = cleanDriverNote(driverNote);
  const base = cleanText(existing, 4000);
  if (!note) return base;
  const baseLower = base.toLowerCase();
  if (baseLower.includes(note.toLowerCase())) return base;
  return base ? `${base} | ${note}` : note;
}

function titleCaseTypedCustomerName(value) {
  return cleanText(value, 120)
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.length <= 2 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function mergePlainNoteText(existing, note) {
  const cleanNote = cleanText(note, 500);
  const base = cleanText(existing, 4000);
  if (!cleanNote) return base;
  if (base.toLowerCase().includes(cleanNote.toLowerCase())) return base;
  return base ? `${cleanNote} | ${base}` : cleanNote;
}

function driverAddedJobHasPhoneSource(job) {
  const notes = [job?.accountNotes, job?.accountnotes, job?.trafficNotes, job?.trafficnotes].filter(Boolean).join(' | ').toLowerCase();
  return notes.includes('phone source:') || notes.includes('driver app source:') || notes.includes('added by ');
}

function mergePaymentTrafficNotes(existing, paymentStatus) {
  const status = normaliseA1PaymentStatus({ paymentStatus });
  const parts = cleanText(existing, 4000)
    .split('|')
    .map(part => cleanText(part, 1200))
    .filter(Boolean)
    .filter(part => !/^(?:paid|not paid)$/i.test(part));
  return status ? [status, ...parts].join(' | ') : parts.join(' | ');
}

function mergePaymentAccountNotes(existing, paymentStatus) {
  const status = normaliseA1PaymentStatus({ paymentStatus });
  const parts = cleanText(existing, 4000)
    .split('|')
    .map(part => cleanText(part, 1200))
    .filter(Boolean);
  let replaced = false;
  const updated = parts.map(part => {
    const match = part.match(/^(A1|Customer)\s+payment\s*:/i);
    if (!match) return part;
    replaced = true;
    return `${match[1].toUpperCase() === 'A1' ? 'A1' : 'Customer'} payment: ${status}`;
  });
  if (status && !replaced) updated.push(`Customer payment: ${status}`);
  return updated.join(' | ');
}

function applyDriverPaymentStatusToHaultechJob(job, paymentStatus) {
  const status = normaliseA1PaymentStatus({ paymentStatus });
  if (!status) return { job, changed: false, error: 'bad_payment_status' };
  if (!driverAddedJobHasPhoneSource(job)) {
    return { job, changed: false, error: 'payment_update_not_driver_added' };
  }
  const trafficNotes = mergePaymentTrafficNotes(job.trafficNotes || job.trafficnotes || '', status);
  const accountNotes = mergePaymentAccountNotes(job.accountNotes || job.accountnotes || '', status);
  const changed = trafficNotes !== cleanText(job.trafficNotes || job.trafficnotes || '', 4000)
    || accountNotes !== cleanText(job.accountNotes || job.accountnotes || '', 4000);
  return {
    job: { ...job, trafficNotes, accountNotes },
    changed,
    paymentStatus: status,
  };
}

function storedDriverJobIds(job) {
  return [job?.id, job?.jobId, job?.ticketNo, job?.jobNumber]
    .filter(Boolean)
    .map(String);
}

function updateStoredDriverJobPaymentPayload(payload, jobId, paymentStatus) {
  const target = String(jobId || '');
  const status = normaliseA1PaymentStatus({ paymentStatus });
  let found = false;
  const updateRow = row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    if (!storedDriverJobIds(row).includes(target)) return row;
    found = true;
    const storedStatus = status === 'Paid' ? 'paid' : 'not_paid';
    const next = {
      ...row,
      paymentStatus: storedStatus,
      a1PaymentStatus: storedStatus,
    };
    if (Object.prototype.hasOwnProperty.call(row, 'notes')) {
      next.notes = mergePaymentTrafficNotes(row.notes, status);
    }
    if (Object.prototype.hasOwnProperty.call(row, '_notes')) {
      next._notes = mergePaymentTrafficNotes(row._notes, status);
    }
    return next;
  };
  let updated = payload;
  if (Array.isArray(payload)) {
    updated = payload.map(updateRow);
  } else if (payload && typeof payload === 'object') {
    updated = updateRow(payload);
    if (!found) {
      updated = { ...payload };
      for (const [key, value] of Object.entries(payload)) {
        if (Array.isArray(value)) updated[key] = value.map(updateRow);
      }
    }
  }
  return { payload: updated, found, paymentStatus: status };
}

async function updateStoredDriverJobPaymentStatus(env, date, jobId, paymentStatus) {
  const key = `jobs:${date}`;
  const raw = await env.PMG_DATA.get(key);
  if (!raw) return { found: false, updated: false };
  const payload = safeJsonParse(raw);
  if (!payload) return { found: false, updated: false, error: 'bad_jobs_data' };
  const result = updateStoredDriverJobPaymentPayload(payload, jobId, paymentStatus);
  if (!result.found) return { found: false, updated: false };
  await env.PMG_DATA.put(key, JSON.stringify(result.payload));
  return { found: true, updated: true, paymentStatus: result.paymentStatus };
}

function applyTypedCustomerToDriverAddedReference(job, typedCustomerName, originalReference) {
  const typedName = titleCaseTypedCustomerName(typedCustomerName);
  if (!typedName || !driverAddedJobHasPhoneSource(job)) return { job, changed: false, reference: '' };
  const existingRef = jobCustomerReference(job);
  if (!existingRef) return { job, changed: false, reference: '' };
  if (existingRef.toLowerCase().includes(typedName.toLowerCase())) return { job, changed: false, reference: existingRef };
  const baseRef = cleanText(originalReference, 120) || existingRef;
  if (!/^\d{2,8}$/.test(baseRef) && baseRef.toLowerCase() !== 'a1' && baseRef.toLowerCase() !== 'unknown') {
    return { job, changed: false, reference: existingRef };
  }
  const reference = cleanText(`${typedName} - ${baseRef}`, 180);
  const updatedJob = {
    ...job,
    customerReference: reference,
    accountNotes: mergePlainNoteText(
      mergePlainNoteText(job.accountNotes || job.accountnotes || '', `Typed customer/site: ${typedName}`),
      `Original driver app reference: ${baseRef}`
    ),
    trafficNotes: job.trafficNotes || job.trafficnotes || '',
  };
  if (Array.isArray(job?.consignments) && job.consignments.length) {
    updatedJob.consignments = job.consignments.map((consignment, index) => (
      index === 0 ? { ...consignment, consignmentReference: reference } : consignment
    ));
  }
  return { job: updatedJob, changed: true, reference };
}

function applyDriverQuantityToHaultechJob(job, quantity) {
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) return { job, changed: false };
  const updatedJob = { ...job, weight: numericQuantity, quantity: numericQuantity };
  if (Array.isArray(job?.consignments) && job.consignments.length) {
    updatedJob.consignments = job.consignments.map((consignment, index) => (
      index === 0
        ? { ...consignment, weight: numericQuantity, quantity: numericQuantity }
        : consignment
    ));
  }
  return { job: updatedJob, changed: true };
}

async function fetchHaultechJobsByDate(env, date) {
  const resp = await htFetch(env, queryPath('/api/Display/GetJobsByDatePaginated', {
    selectFromDate: date,
    selectToDate: date,
    take: '200',
  }));
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: text || `haultech_jobs_http_${resp.status}` };
  }
  const payload = safeJsonParse(text);
  if (!payload) return { ok: false, error: 'bad_haultech_jobs_data' };
  const jobs = Array.isArray(payload) ? payload : (payload.items || payload.data || payload.jobs || []);
  return { ok: true, jobs };
}

async function applyDriverCompletionUpdateToHaultechJob(env, jobId, dateOrDates, { driverNotes = '', quantity = null, consigneeName = '', originalReference = '', paymentStatus = '' } = {}) {
  const note = cleanText(driverNotes, 1200);
  const numericQuantity = Number(quantity);
  const typedCustomer = cleanText(consigneeName, 120);
  const normalizedPaymentStatus = normaliseA1PaymentStatus({ paymentStatus });
  if (!note && !typedCustomer && !normalizedPaymentStatus && (!Number.isFinite(numericQuantity) || numericQuantity <= 0)) {
    return { ok: true, skipped: true };
  }
  const requestedDates = uniqueIsoDates(Array.isArray(dateOrDates) ? dateOrDates : [dateOrDates]);
  const primaryDate = requestedDates[0] || new Date().toISOString().slice(0, 10);
  const lookupDates = uniqueIsoDates([
    ...requestedDates,
    addIsoDays(primaryDate, -1),
    addIsoDays(primaryDate, 1),
    new Date().toISOString().slice(0, 10),
  ]);
  let lastError = '';
  let job = null;
  for (const lookupDate of lookupDates) {
    const jobLookup = await fetchHaultechJobsByDate(env, lookupDate);
    if (!jobLookup.ok) {
      lastError = jobLookup.error || '';
      continue;
    }
    job = findHaultechJobById(jobLookup.jobs, jobId);
    if (job) break;
  }
  if (!job) {
    return {
      ok: false,
      error: `haultech_job_not_found_for_driver_update:${lookupDates.join(',')}${lastError ? ':' + lastError : ''}`,
    };
  }

  const currentNotes = job.trafficNotes || job.trafficnotes || '';
  const mergedNotes = mergeDriverNoteText(currentNotes, note);
  let updatedJob = { ...job };
  let changed = false;
  if (mergedNotes !== cleanText(currentNotes, 4000)) {
    updatedJob.trafficNotes = mergedNotes;
    changed = true;
  }

  const quantityUpdate = applyDriverQuantityToHaultechJob(updatedJob, numericQuantity);
  updatedJob = quantityUpdate.job;
  changed = changed || quantityUpdate.changed;
  const customerUpdate = applyTypedCustomerToDriverAddedReference(updatedJob, typedCustomer, originalReference);
  updatedJob = customerUpdate.job;
  changed = changed || customerUpdate.changed;
  let paymentUpdate = { job: updatedJob, changed: false, paymentStatus: '' };
  if (normalizedPaymentStatus) {
    paymentUpdate = applyDriverPaymentStatusToHaultechJob(updatedJob, normalizedPaymentStatus);
    if (paymentUpdate.error) return { ok: false, error: paymentUpdate.error };
    updatedJob = paymentUpdate.job;
    changed = changed || paymentUpdate.changed;
  }

  if (!changed) return { ok: true, notes: mergedNotes, paymentStatus: paymentUpdate.paymentStatus, unchanged: true };

  const upsertResp = await htFetch(env, '/api/Job/UpsertJob?formId=', {
    method: 'POST',
    body: JSON.stringify(updatedJob),
  });
  const upsertText = await upsertResp.text();
  if (!upsertResp.ok) {
    return { ok: false, error: `driver_update_failed: ${upsertText || upsertResp.status}` };
  }
  return {
    ok: true,
    notes: updatedJob.trafficNotes || mergedNotes,
    quantity: quantityUpdate.changed ? numericQuantity : undefined,
    reference: customerUpdate.changed ? customerUpdate.reference : undefined,
    paymentStatus: paymentUpdate.paymentStatus || undefined,
  };
}

async function resolveHaultechJobGuidForCompletion(env, jobId, dateOrDates) {
  const input = cleanText(jobId, 120);
  if (!input) return { ok: false, error: 'bad_job_id' };
  const requestedDates = uniqueIsoDates(Array.isArray(dateOrDates) ? dateOrDates : [dateOrDates]);
  const primaryDate = requestedDates[0] || new Date().toISOString().slice(0, 10);
  const lookupDates = uniqueIsoDates([
    ...requestedDates,
    addIsoDays(primaryDate, -1),
    addIsoDays(primaryDate, 1),
    new Date().toISOString().slice(0, 10),
  ]);
  let lastError = '';
  for (const lookupDate of lookupDates) {
    const jobLookup = await fetchHaultechJobsByDate(env, lookupDate);
    if (!jobLookup.ok) {
      lastError = jobLookup.error || '';
      continue;
    }
    const job = findHaultechJobById(jobLookup.jobs, input);
    if (job) {
      const guid = cleanText(job.id || job._id, 120);
      if (guid) return { ok: true, guid, job };
    }
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return { ok: true, guid: input, fallback: true };
  }
  return {
    ok: false,
    error: `haultech_job_guid_not_found:${lookupDates.join(',')}${lastError ? ':' + lastError : ''}`,
  };
}

async function mergeDriverNotesIntoHaultechJob(env, jobId, dateOrDates, driverNotes) {
  return applyDriverCompletionUpdateToHaultechJob(env, jobId, dateOrDates, { driverNotes });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Public, read-only liveness/compatibility check. It exposes no tokens,
    // customer data or KV contents and lets monitoring detect split releases.
    if (path === '/health' && request.method === 'GET') {
      return corsResponse(JSON.stringify({
        ok: true,
        service: 'pmg-driver-sync',
        workerBuildId: WORKER_BUILD_ID,
        driverApiContract: DRIVER_API_CONTRACT,
      }), 200, { 'Cache-Control': 'no-store' });
    }

    // GET /customers-public?pin=2312 — customer names for the PMG yard ticket picker.
    if (path === '/customers-public' && request.method === 'GET') {
      if (url.searchParams.get('pin') !== YARD_CUSTOMERS_PIN) return unauthorized();
      const val = await env.PMG_DATA.get(HAULTECH_CUSTOMERS_KEY);
      return corsResponse(val ?? '[]');
    }

    // Auth check for everything else
    const key = request.headers.get('X-PMG-Key');
    if (key !== API_KEY) {
      return unauthorized();
    }
    const isAuth = true;

    // Geoapify stays server-side: the browser never receives the API key.
    // Search is UK-only, bounded, and falls back cleanly if the free service
    // is unavailable.
    if (path === '/address/autocomplete' && request.method === 'POST') {
      const body = safeJsonParse(await request.text(), {}) || {};
      const input = cleanText(body.input, 120);
      if (input.length < 3) return corsResponse(JSON.stringify({ suggestions: [] }));
      const result = await geoapifyRequest(env, input);
      if (!result.ok) return corsResponse(JSON.stringify({ error: result.error }), result.status);
      const suggestions = safeArray(result.payload?.results).slice(0, 6).map(place => {
        const address = structuredAddressFromGeoapifyPlace(place);
        return {
          placeId: address.placeId,
          text: address.formattedAddress,
          mainText: address.line1,
          secondaryText: [address.line2, address.line3, address.line4, address.postcode].filter(Boolean).join(', '),
          address,
        };
      }).filter(item => item.text && item.address.postcode);
      return corsResponse(JSON.stringify({ suggestions }), 200, { 'Cache-Control': 'private, max-age=30' });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // HAULTECH PROXY ENDPOINTS — /ht/*
    // ══════════════════════════════════════════════════════════════════════════

    // POST /haultech-refresh — force token refresh
    if (path === '/haultech-refresh' && request.method === 'POST') {
      if (!hasAdminKey(request, env)) {
        return corsResponse(JSON.stringify({ error: 'admin_key_required' }), 403);
      }
      const newToken = await refreshHaultechToken(env);
      await recordHaultechRefreshHealth(env, {
        ok: Boolean(newToken),
        refreshed: Boolean(newToken),
        source: 'manual-api',
        error: newToken ? '' : 'refresh_failed',
      });
      if (newToken) return corsResponse(JSON.stringify({ ok: true, refreshed: true }));
      return corsResponse(JSON.stringify({ error: 'refresh_failed' }), 500);
    }

    // GET /ht/jobs?date=YYYY-MM-DD — fetch live jobs from Haultech
    // Add raw=true to bypass local status overlays for diary writeback checks.
    if (path === '/ht/jobs' && request.method === 'GET') {
      const date = url.searchParams.get('date');
      if (!date) return corsResponse(JSON.stringify({ error: 'date required' }), 400);
      if (!isValidIsoDate(date)) return corsResponse(JSON.stringify({ error: 'bad_date' }), 400);
      const raw = url.searchParams.get('raw') === 'true' || url.searchParams.get('merge') === 'false';
      const resp = await htFetch(env, queryPath('/api/Display/GetJobsByDatePaginated', {
        selectFromDate: date,
        selectToDate: date,
        take: '200',
      }));
      if (!resp.ok) return resp;
      const text = await resp.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return corsResponse(text, resp.status);
      }
      if (raw) return corsResponse(JSON.stringify(payload), resp.status);
      const jobs = Array.isArray(payload) ? payload : (payload.items || payload.data || []);
      const merged = await mergeJobStatusOverrides(env, date, jobs);
      if (Array.isArray(payload)) return corsResponse(JSON.stringify(merged), resp.status);
      if (Array.isArray(payload.items)) return corsResponse(JSON.stringify({ ...payload, items: merged }), resp.status);
      if (Array.isArray(payload.data)) return corsResponse(JSON.stringify({ ...payload, data: merged }), resp.status);
      return corsResponse(JSON.stringify(payload), resp.status);
    }

    // PATCH /ht/receive/{consignmentId} — disabled: Start/In Transit is local only.
    const receiveMatch = path.match(/^\/ht\/receive\/([^/]+)$/);
    if (receiveMatch && request.method === 'PATCH') {
      return corsResponse(JSON.stringify({ error: 'start_is_local_only' }), 410);
    }

    // PATCH /ht/note/{jobId} — merge a driver-entered note into Haultech Traffic Notes.
    const noteMatch = path.match(/^\/ht\/note\/([^/]+)$/);
    if (noteMatch && request.method === 'PATCH') {
      const jobId = safePathParam(noteMatch[1]);
      if (!jobId) return corsResponse(JSON.stringify({ error: 'bad_job_id' }), 400);
      const body = safeJsonParse(await request.text(), {}) || {};
      const driverNotes = cleanText(body.driverNotes || body.notes, 1200);
      if (!driverNotes) return corsResponse(JSON.stringify({ ok: true, skipped: true }));
      const requestedDates = uniqueIsoDates(Array.isArray(body.lookupDates) ? body.lookupDates : []);
      const noteDate = maybeIsoDate(body.date) || requestedDates[0] || new Date().toISOString().slice(0, 10);
      const noteResult = await mergeDriverNotesIntoHaultechJob(
        env,
        jobId,
        [noteDate, ...requestedDates].filter(Boolean),
        driverNotes
      );
      if (!noteResult.ok) {
        return corsResponse(JSON.stringify({
          error: 'driver_note_write_failed',
          message: noteResult.error || 'Could not write driver note to Haultech',
        }), 502);
      }
      return corsResponse(JSON.stringify({ ok: true, notes: noteResult.notes || '', unchanged: !!noteResult.unchanged }));
    }

    // PATCH /ht/payment/{jobId} — set Paid / Not paid on a driver-added job.
    // Haultech is updated first; the driver-app KV copy follows only after that succeeds.
    const paymentMatch = path.match(/^\/ht\/payment\/([^/]+)$/);
    if (paymentMatch && request.method === 'PATCH') {
      const jobId = safePathParam(paymentMatch[1]);
      if (!jobId) return corsResponse(JSON.stringify({ error: 'bad_job_id' }), 400);
      const body = safeJsonParse(await request.text(), {}) || {};
      const paymentStatus = normaliseA1PaymentStatus(body);
      if (!paymentStatus) return corsResponse(JSON.stringify({ error: 'bad_payment_status' }), 400);
      const requestedDates = uniqueIsoDates(Array.isArray(body.lookupDates) ? body.lookupDates : []);
      const paymentDate = maybeIsoDate(body.date) || requestedDates[0] || new Date().toISOString().slice(0, 10);
      const paymentResult = await applyDriverCompletionUpdateToHaultechJob(
        env,
        jobId,
        [paymentDate, ...requestedDates].filter(Boolean),
        { paymentStatus }
      );
      if (!paymentResult.ok) {
        const status = paymentResult.error === 'payment_update_not_driver_added' ? 403 : 502;
        return corsResponse(JSON.stringify({
          error: paymentResult.error || 'driver_payment_write_failed',
          message: paymentResult.error === 'payment_update_not_driver_added'
            ? 'Payment can only be changed on rows added through the driver app'
            : 'Could not update payment in Haultech',
        }), status);
      }
      const stored = await updateStoredDriverJobPaymentStatus(env, paymentDate, jobId, paymentStatus);
      return corsResponse(JSON.stringify({
        ok: true,
        paymentStatus,
        unchanged: !!paymentResult.unchanged,
        storedUpdated: !!stored.updated,
      }));
    }

    // PATCH /ht/complete/{jobId} — QuickCompleteJob (Complete)
    const completeMatch = path.match(/^\/ht\/complete\/([^/]+)$/);
    if (completeMatch && request.method === 'PATCH') {
      const jobId = safePathParam(completeMatch[1]);
      if (!jobId) return corsResponse(JSON.stringify({ error: 'bad_job_id' }), 400);
      const body = safeJsonParse(await request.text(), {}) || {};
      const driverNotes = cleanText(body.driverNotes || body.notes, 1200);
      const driverQuantity = Number(body.quantity || body.weight || 0) || 0;
      const consigneeName = cleanText(body.consigneeName || body.customerName || body.customer, 120);
      const originalReference = cleanText(body.originalReference || body.reference || body.customerReference, 120);
      const requestedDates = uniqueIsoDates(Array.isArray(body.lookupDates) ? body.lookupDates : []);
      const noteDate = maybeIsoDate(body.date) || requestedDates[0] || new Date().toISOString().slice(0, 10);
      if (driverNotes || driverQuantity > 0 || consigneeName) {
        const noteResult = await applyDriverCompletionUpdateToHaultechJob(
          env,
          jobId,
          [noteDate, ...requestedDates].filter(Boolean),
          { driverNotes, quantity: driverQuantity, consigneeName, originalReference }
        );
        if (!noteResult.ok) {
          return corsResponse(JSON.stringify({
            error: 'driver_update_failed',
            message: noteResult.error || 'Could not write driver update before completing job',
          }), 502);
        }
      }
      const guidResult = await resolveHaultechJobGuidForCompletion(
        env,
        jobId,
        [noteDate, ...requestedDates].filter(Boolean)
      );
      if (!guidResult.ok) {
        return corsResponse(JSON.stringify({
          error: 'haultech_job_guid_not_found',
          message: guidResult.error || 'Could not resolve Haultech job GUID before completing job',
        }), 502);
      }
      return htFetch(env, queryPath('/api/Job/QuickCompleteJob', { id: guidResult.guid }), { method: 'PATCH' });
    }

    // POST /ht/driver-add — restricted live write for rows added by lads on phones.
    // The phone can create a real Haultech row, but the worker owns customer
    // matching, blank pricing and duplicate checks.
    if (path === '/ht/driver-add' && request.method === 'POST') {
      const body = safeJsonParse(await request.text(), {}) || {};
      const built = await buildDriverAddedHaultechPayload(env, body);
      if (built.error) {
        return corsResponse(JSON.stringify({ error: built.error, message: built.message || built.error }), built.status || 400);
      }

      const existingLookup = await fetchHaultechJobsByDate(env, built.date);
      if (!existingLookup.ok) {
        return corsResponse(JSON.stringify({
          error: 'haultech_lookup_failed',
          message: existingLookup.error || 'Could not check existing Haultech jobs before adding driver row',
        }), 502);
      }

      const existing = safeArray(existingLookup.jobs);
      const existingRef = existing.find(job => jobCustomerReference(job) === built.ref);
      if (existingRef) {
        const exact = driverAddSignatureFromJob(existingRef) === driverAddSignatureFromPayload(built.payload);
        return corsResponse(JSON.stringify({
          ok: true,
          alreadyPresent: true,
          exact,
          ref: built.ref,
          jobId: haultechJobIds(existingRef)[0] || '',
          message: exact ? 'Driver row already exists in Haultech' : 'Reference already exists in Haultech; not duplicated',
        }));
      }

      const upsertResp = await htFetch(env, '/api/Job/UpsertJob?formId=', {
        method: 'POST',
        body: JSON.stringify(built.payload),
      });
      const upsertText = await upsertResp.text();
      if (!upsertResp.ok) {
        return corsResponse(JSON.stringify({
          error: 'haultech_driver_add_failed',
          message: upsertText || `Haultech HTTP ${upsertResp.status}`,
        }), 502);
      }
      const upsertPayload = safeJsonParse(upsertText, {}) || {};
      return corsResponse(JSON.stringify({
        ok: true,
        alreadyPresent: false,
        ref: built.ref,
        customerName: built.customerName,
        a1Fallback: !!built.useA1Fallback,
        a1PaymentStatus: built.a1PaymentStatus || '',
        jobId: upsertPayload.id || upsertPayload.jobId || upsertPayload.jobNumber || '',
        haultech: upsertPayload,
      }));
    }

    // POST /ht/upsert — UpsertJob (Add new job to Haultech)
    if (path === '/ht/upsert' && request.method === 'POST') {
      if (!hasAdminKey(request, env)) {
        return corsResponse(JSON.stringify({ error: 'admin_key_required' }), 403);
      }
      const body = await request.text();
      const parsed = safeJsonParse(body);
      const upsertBody = parsed && typeof parsed === 'object'
        ? JSON.stringify(normaliseDriverAddedUpsertPayload(parsed))
        : body;
      return htFetch(env, '/api/Job/UpsertJob?formId=', { method: 'POST', body: upsertBody });
    }

    // POST /ht/mpod/{consignmentId} — MakeImageMpod (upload POD photo)
    const mpodMatch = path.match(/^\/ht\/mpod\/([^/]+)$/);
    if (mpodMatch && request.method === 'POST') {
      const trackerId = safePathParam(mpodMatch[1]);
      if (!trackerId) return corsResponse(JSON.stringify({ error: 'bad_tracker_id' }), 400);
      const auth = await getHaultechAuth(env);
      if (!auth) return corsResponse(JSON.stringify({ error: 'no_haultech_auth' }), 401);
      if (auth === false) return corsResponse(JSON.stringify({ error: 'bad_auth_data' }), 500);
      // Forward raw body (image data) to Haultech
      const body = await request.arrayBuffer();
      const ct = request.headers.get('Content-Type') || 'image/jpeg';
      const mpodUrl = `${HT_BASE}${queryPath('/api/Job/MakeImageMpod', { trackerId })}`;
      const mpodHeaders = {
        'Authorization': `Bearer ${auth.token}`,
        'oauthTmsId': auth.tmsId || DEFAULT_TMS,
        'Content-Type': ct,
      };
      let resp = await fetch(mpodUrl, {
        method: 'POST',
        headers: mpodHeaders,
        body,
      });
      if (resp.status === 401 && auth.refreshToken) {
        const newToken = await refreshHaultechToken(env);
        if (newToken) {
          resp = await fetch(mpodUrl, {
            method: 'POST',
            headers: { ...mpodHeaders, 'Authorization': `Bearer ${newToken}` },
            body,
          });
        }
      }
      const data = await resp.text();
      return corsResponse(data, resp.status);
    }

    // GET /ht/signatures/{consignmentId} — GetSignatureImages
    const sigMatch = path.match(/^\/ht\/signatures\/([^/]+)$/);
    if (sigMatch && request.method === 'GET') {
      const consignmentId = safePathParam(sigMatch[1]);
      if (!consignmentId) return corsResponse(JSON.stringify({ error: 'bad_consignment_id' }), 400);
      return htFetch(env, queryPath('/api/Job/GetSignatureImages', { consignmentId }));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AUTH MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════════

    // PUT /haultech-auth — store Haultech auth token
    if (path === '/haultech-auth' && request.method === 'PUT') {
      if (!hasAdminKey(request, env)) {
        return corsResponse(JSON.stringify({ error: 'admin_key_required' }), 403);
      }
      const body = await request.text();
      await env.PMG_DATA.put('haultech-auth', body);
      const auth = safeJsonParse(body);
      setHaultechAuthCache(auth && typeof auth === 'object' ? auth : null);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // GET /haultech-auth-admin — return FULL auth including refresh token (for token-refresh script)
    if (path === '/haultech-auth-admin' && request.method === 'GET') {
      if (!hasAdminKey(request, env)) {
        return corsResponse(JSON.stringify({ error: 'admin_key_required' }), 403);
      }
      const val = await env.PMG_DATA.get('haultech-auth');
      if (!val) return corsResponse(JSON.stringify({ error: 'no_auth' }), 404);
      return corsResponse(val);
    }

    // GET /haultech-auth-status — token metadata only, no secrets.
    if (path === '/haultech-auth-status' && request.method === 'GET') {
      if (!isAuth) return unauthorized();
      const auth = await getHaultechAuth(env, { force: true });
      return corsResponse(JSON.stringify(authDiagnostics(auth)));
    }

    // GET /haultech-refresh-status — cloud scheduled refresh health, no secrets.
    if (path === '/haultech-refresh-status' && request.method === 'GET') {
      if (!isAuth) return unauthorized();
      const val = await env.PMG_DATA.get(HAULTECH_REFRESH_HEALTH_KEY);
      if (!val) return corsResponse(JSON.stringify({ ok: false, error: 'no_refresh_status' }), 404);
      return corsResponse(val);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CUSTOMERS
    // ══════════════════════════════════════════════════════════════════════════

    // GET /customers — return customer list from KV
    if (path === '/customers' && request.method === 'GET') {
      const val = await env.PMG_DATA.get(HAULTECH_CUSTOMERS_KEY);
      return corsResponse(val ?? '[]');
    }

    // PUT /customers — store customer list in KV
    if (path === '/customers' && request.method === 'PUT') {
      if (!hasAdminKey(request, env)) {
        return corsResponse(JSON.stringify({ error: 'admin_key_required' }), 403);
      }
      const body = await request.text();
      await env.PMG_DATA.put(HAULTECH_CUSTOMERS_KEY, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // POST /customers/refresh — pull customer list from live Haultech into KV
    if (path === '/customers/refresh' && request.method === 'POST') {
      if (!hasAdminKey(request, env)) {
        return corsResponse(JSON.stringify({ error: 'admin_key_required' }), 403);
      }
      const status = await refreshHaultechCustomers(env, { cron: 'manual-api' });
      return corsResponse(JSON.stringify(status));
    }

    // GET /customers/refresh-status — last Haultech customer refresh health
    if (path === '/customers/refresh-status' && request.method === 'GET') {
      const val = await env.PMG_DATA.get(HAULTECH_CUSTOMERS_HEALTH_KEY);
      if (!val) return corsResponse(JSON.stringify({ ok: false, error: 'no_customer_refresh_status' }), 404);
      return corsResponse(val);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PLANT INFORMATION HUB
    // ══════════════════════════════════════════════════════════════════════════

    // GET /plant/push-config — public browser push setup for Tony's phone.
    if (path === '/plant/push-config' && request.method === 'GET') {
      return corsResponse(JSON.stringify({
        schema: 'pmg-plant-push-config-v1',
        publicKey: PLANT_PUSH_PUBLIC_KEY,
        enabled: Boolean(PLANT_PUSH_PUBLIC_KEY),
      }));
    }

    // GET /plant/push-status — current service alert/push state for build checks.
    if (path === '/plant/push-status' && request.method === 'GET') {
      const state = await loadPlantData(env);
      const subscriptions = safeObject(await getKvJson(env, PLANT_PUSH_SUBSCRIPTIONS_KEY, {}));
      const lastRun = await getKvJson(env, PLANT_PUSH_LAST_RUN_KEY, {});
      return corsResponse(JSON.stringify({
        schema: 'pmg-plant-push-status-v1',
        enabled: Boolean(PLANT_PUSH_PUBLIC_KEY && cleanText(env.WEB_PUSH_PRIVATE_KEY, 120)),
        subscriptionCount: Object.values(subscriptions).filter(subscription => subscription?.enabled).length,
        currentAlerts: plantPushAlertsFromState(state),
        lastRun,
      }));
    }

    // POST /plant/push-subscriptions — save this phone/browser for service alerts.
    if (path === '/plant/push-subscriptions' && request.method === 'POST') {
      const body = safeJsonParse(await request.text());
      const subscription = normalisePushSubscription(body);
      if (!subscription) return corsResponse(JSON.stringify({ error: 'bad_push_subscription' }), 400);
      const id = await sha256Base64Url(subscription.endpoint);
      const subscriptions = safeObject(await getKvJson(env, PLANT_PUSH_SUBSCRIPTIONS_KEY, {}));
      subscriptions[id] = {
        ...(subscriptions[id] || {}),
        ...subscription,
        id,
        updatedAt: new Date().toISOString(),
      };
      await putKvJson(env, PLANT_PUSH_SUBSCRIPTIONS_KEY, subscriptions);
      return corsResponse(JSON.stringify({ ok: true, id, enabled: true }));
    }

    // DELETE /plant/push-subscriptions — disable notifications for this browser.
    if (path === '/plant/push-subscriptions' && request.method === 'DELETE') {
      const body = safeJsonParse(await request.text());
      const endpoint = cleanText(body?.endpoint, 2000);
      if (!endpoint) return corsResponse(JSON.stringify({ error: 'endpoint_required' }), 400);
      const id = await sha256Base64Url(endpoint);
      const subscriptions = safeObject(await getKvJson(env, PLANT_PUSH_SUBSCRIPTIONS_KEY, {}));
      if (subscriptions[id]) subscriptions[id] = { ...subscriptions[id], enabled: false, updatedAt: new Date().toISOString() };
      await putKvJson(env, PLANT_PUSH_SUBSCRIPTIONS_KEY, subscriptions);
      return corsResponse(JSON.stringify({ ok: true, id, enabled: false }));
    }

    // PUT /plant/import-snapshot — weekly Katie workbook import feed.
    if (path === '/plant/import-snapshot' && request.method === 'PUT') {
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      if (body.schema !== 'pmg-plant-snapshot-v1') return corsResponse(JSON.stringify({ error: 'bad_plant_snapshot_schema' }), 400);
      if (!Array.isArray(body.assets)) return corsResponse(JSON.stringify({ error: 'assets_required' }), 400);
      if (body.plantOnlyRules?.ignoredSheets) return corsResponse(JSON.stringify({ error: 'ignored_sheet_names_must_not_be_stored' }), 400);
      const importedAt = new Date().toISOString();
      const snapshot = { ...body, importedAt, importedBy: 'plant_import.py' };
      await putKvJson(env, PLANT_SNAPSHOT_KEY, snapshot);
      return corsResponse(JSON.stringify({ ok: true, importedAt, stats: snapshot.stats || {} }));
    }

    // GET /plant/import-snapshot — current raw import state for build/admin checks.
    if (path === '/plant/import-snapshot' && request.method === 'GET') {
      const snapshot = await getKvJson(env, PLANT_SNAPSHOT_KEY, {});
      return corsResponse(JSON.stringify(snapshot));
    }

    // GET /plant/driver-torque?vehicle=EY15BOV — open wheel torque checks for the driver pre-start gate.
    if (path === '/plant/driver-torque' && request.method === 'GET') {
      const vehicle = normaliseVehicleRef(url.searchParams.get('vehicle'));
      if (!vehicle) return corsResponse(JSON.stringify({ error: 'vehicle_required' }), 400);
      const { assets, tasks } = await openTorqueTasksForVehicle(env, vehicle);
      return corsResponse(JSON.stringify({
        schema: 'pmg-driver-torque-v1',
        vehicle,
        checkedAt: new Date().toISOString(),
        matchedAssets: assets.map(asset => ({
          assetId: asset.id,
          displayName: asset.displayName || asset.plantNumber || asset.id,
          plantNumber: asset.plantNumber || '',
        })),
        openTasks: tasks,
      }));
    }

    // GET /plant/assets — joined plant list with service status and counts.
    if (path === '/plant/assets' && request.method === 'GET') {
      const state = await loadPlantData(env);
      const role = cleanText(url.searchParams.get('role'), 20).toLowerCase();
      const body = {
        schema: state.schema,
        stats: state.stats,
        sharePointEvidenceRoot: state.sharePointEvidenceRoot,
        plantOnlyRules: state.plantOnlyRules,
        assets: state.assets,
        reviewItems: role === 'tony' ? [] : state.reviewItems,
      };
      return corsResponse(JSON.stringify(body));
    }

    // POST /plant/assets — Tony can add a plant/tool item that is not yet in Katie's feed.
    if (path === '/plant/assets' && request.method === 'POST') {
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      const requestedPlantNumber = cleanText(body.plantNumber, 80);
      const requestedDisplayName = cleanText(body.displayName, 180);
      const requestedMachineType = cleanText(body.machineType, 180);
      const requestedSerialNumber = cleanText(body.serialNumber, 180);
      const requestedRegistration = normaliseVehicleRef(body.registration || body.regNo || body.vehicleRegistration || body.numberPlate || '');
      if (!requestedPlantNumber && !requestedDisplayName && !requestedMachineType && !requestedSerialNumber && !requestedRegistration) {
        return corsResponse(JSON.stringify({ error: 'plant_identity_required' }), 400);
      }
      const assetId = plantIdFromValue(body.assetId) || plantIdFromValue(requestedPlantNumber) || plantIdFromValue(requestedRegistration) || newPlantId(requestedDisplayName || requestedMachineType || requestedSerialNumber || requestedRegistration);
      const overrides = await getKvJson(env, PLANT_ASSET_OVERRIDES_KEY, {});
      const snapshot = await getKvJson(env, PLANT_SNAPSHOT_KEY, {});
      const imported = safeArray(snapshot.assets).find(item => item?.id === assetId) || {};
      const existing = { ...safeObject(imported), ...safeObject(overrides[assetId]) };
      const plantNumber = cleanText(requestedPlantNumber || existing.plantNumber || requestedRegistration || assetId.replace(/^plant-/, ''), 80);
      const displayName = cleanText(requestedDisplayName || existing.displayName || (plantNumber ? `Plant ${plantNumber}` : requestedMachineType || assetId), 180);
      const asset = {
        ...existing,
        id: assetId,
        plantNumber,
        displayName,
        machineType: cleanText(requestedMachineType || existing.machineType, 180),
        serialNumber: cleanText(requestedSerialNumber || existing.serialNumber, 180),
        registration: requestedRegistration || cleanText(existing.registration || existing.regNo || existing.vehicleRegistration || existing.numberPlate, 40),
        assetType: cleanText(body.assetType || existing.assetType || (requestedRegistration ? 'vehicle' : ''), 40),
        year: cleanText(body.year || existing.year, 20),
        site: cleanText(body.site || existing.site, 180),
        scheduleNotes: safeArray(existing.scheduleNotes),
        sharePointEvidencePath: cleanText(body.sharePointEvidencePath || existing.sharePointEvidencePath || `SHARED/Plant and Tool Service Records/${displayName}`, 300),
        updatedAt: new Date().toISOString(),
        updatedBy: cleanText(body.updatedBy || body.createdBy || 'plant-app', 120),
      };
      overrides[assetId] = asset;
      await putKvJson(env, PLANT_ASSET_OVERRIDES_KEY, overrides);

      if (Array.isArray(body.filterParts)) {
        const filterOverrides = await getKvJson(env, PLANT_FILTER_OVERRIDES_KEY, {});
        filterOverrides[assetId] = body.filterParts.map(part => normaliseFilterPart(part, assetId, { type: 'manual_asset_add' }));
        await putKvJson(env, PLANT_FILTER_OVERRIDES_KEY, filterOverrides);
      }

      return corsResponse(JSON.stringify({ ok: true, asset: withPlantGroup(asset) }));
    }

    // GET /plant/assets/{assetId} — full joined plant record.
    const plantAssetMatch = path.match(/^\/plant\/assets\/([^/]+)$/);
    if (plantAssetMatch && request.method === 'GET') {
      const assetId = safePathParam(plantAssetMatch[1]);
      if (!assetId) return corsResponse(JSON.stringify({ error: 'bad_asset_id' }), 400);
      const state = await loadPlantData(env);
      const asset = state.assets.find(item => item.id === assetId);
      if (!asset) return notFound();
      const role = cleanText(url.searchParams.get('role'), 20).toLowerCase();
      return corsResponse(JSON.stringify({
        schema: 'pmg-plant-record-v1',
        asset,
        history: state.historyByAsset[assetId] || [],
        filterParts: state.filterParts[assetId] || [],
        reviewItems: role === 'tony' ? [] : (state.reviewByAsset[assetId] || []),
        sharePointEvidenceRoot: state.sharePointEvidenceRoot,
      }));
    }

    // PATCH /plant/assets/{assetId} — update plant identity/location header fields.
    if (plantAssetMatch && request.method === 'PATCH') {
      const assetId = safePathParam(plantAssetMatch[1]);
      if (!assetId) return corsResponse(JSON.stringify({ error: 'bad_asset_id' }), 400);
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      const overrides = await getKvJson(env, PLANT_ASSET_OVERRIDES_KEY, {});
      let existing = safeObject(overrides[assetId]);
      if (!existing.id && !existing.plantNumber && !existing.displayName && !existing.machineType && !existing.serialNumber) {
        const snapshot = await getKvJson(env, PLANT_SNAPSHOT_KEY, {});
        existing = safeArray(snapshot.assets).find(item => item?.id === assetId) || {};
      }
      if (!existing.id && !existing.plantNumber && !existing.displayName && !existing.machineType && !existing.serialNumber) {
        return notFound();
      }
      const updated = {
        ...existing,
        id: assetId,
        plantNumber: cleanText(body.plantNumber ?? existing.plantNumber, 80),
        displayName: cleanText(body.displayName ?? existing.displayName, 180),
        machineType: cleanText(body.machineType ?? existing.machineType, 180),
        serialNumber: cleanText(body.serialNumber ?? existing.serialNumber, 180),
        registration: normaliseVehicleRef(body.registration ?? existing.registration ?? existing.regNo ?? existing.vehicleRegistration ?? existing.numberPlate ?? ''),
        assetType: cleanText(body.assetType ?? existing.assetType, 40),
        year: cleanText(body.year ?? existing.year, 20),
        site: cleanText(body.site ?? existing.site, 180),
        sharePointEvidencePath: cleanText(body.sharePointEvidencePath ?? existing.sharePointEvidencePath, 300),
        updatedAt: new Date().toISOString(),
        updatedBy: cleanText(body.updatedBy || 'plant-app', 120),
        origin: existing.origin || 'manual',
      };
      overrides[assetId] = updated;
      await putKvJson(env, PLANT_ASSET_OVERRIDES_KEY, overrides);
      return corsResponse(JSON.stringify({ ok: true, asset: withPlantGroup(updated) }));
    }

    // DELETE /plant/assets/{assetId} — remove a manual plant/tool override only.
    if (plantAssetMatch && request.method === 'DELETE') {
      const assetId = safePathParam(plantAssetMatch[1]);
      if (!assetId) return corsResponse(JSON.stringify({ error: 'bad_asset_id' }), 400);
      const overrides = await getKvJson(env, PLANT_ASSET_OVERRIDES_KEY, {});
      if (!safeObject(overrides)[assetId]) return notFound();
      delete overrides[assetId];
      await putKvJson(env, PLANT_ASSET_OVERRIDES_KEY, overrides);
      const filterOverrides = await getKvJson(env, PLANT_FILTER_OVERRIDES_KEY, {});
      if (safeObject(filterOverrides)[assetId]) {
        delete filterOverrides[assetId];
        await putKvJson(env, PLANT_FILTER_OVERRIDES_KEY, filterOverrides);
      }
      return corsResponse(JSON.stringify({ ok: true, deleted: assetId }));
    }

    // PUT /plant/filter-parts/{assetId} — update the known filters/parts list.
    const plantFiltersMatch = path.match(/^\/plant\/filter-parts\/([^/]+)$/);
    if (plantFiltersMatch && request.method === 'PUT') {
      const assetId = safePathParam(plantFiltersMatch[1]);
      if (!assetId) return corsResponse(JSON.stringify({ error: 'bad_asset_id' }), 400);
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      const parts = Array.isArray(body) ? body : safeArray(body.filterParts);
      const filterOverrides = await getKvJson(env, PLANT_FILTER_OVERRIDES_KEY, {});
      filterOverrides[assetId] = parts.map(part => normaliseFilterPart(part, assetId, { type: 'manual_filter_update' }));
      await putKvJson(env, PLANT_FILTER_OVERRIDES_KEY, filterOverrides);
      return corsResponse(JSON.stringify({ ok: true, filterParts: filterOverrides[assetId] }));
    }

    // POST /plant/service-events — Tony service/repair/check sheet entry.
    if (path === '/plant/service-events' && request.method === 'POST') {
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      const assetId = plantIdFromValue(body.assetId) || plantIdFromValue(body.plantNumber);
      if (!assetId) return corsResponse(JSON.stringify({ error: 'asset_required' }), 400);
      const date = maybeIsoDate(body.date);
      if (!date) return corsResponse(JSON.stringify({ error: 'bad_date' }), 400);
      const eventSeed = { ...body, description: body.description || body.workDone };
      const torqueCheckRequired = body.torqueCheckRequired === true || isWheelTorqueRequiredEvent(eventSeed);
      const requestedCategory = cleanText(body.category, 40).toLowerCase();
      const category = torqueCheckRequired
        ? 'inspection'
        : ['service', 'repair', 'inspection', 'parts', 'anomaly'].includes(requestedCategory)
        ? requestedCategory
        : categoryFromPlantServiceType(body.serviceType);
      const state = await loadPlantData(env);
      const asset = state.assets.find(item => item.id === assetId) || {};
      const eventAsset = {
        ...asset,
        assetType: body.assetType || asset.assetType,
        plantNumber: body.plantNumber || asset.plantNumber,
        displayName: body.displayName || asset.displayName,
        machineType: body.machineType || asset.machineType,
        registration: body.registration || body.regNo || body.vehicleRegistration || body.numberPlate || asset.registration,
      };
      const eventIsVehicle = isVehicleAsset(eventAsset);
      const eventSuffix = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(16).slice(2);
      const eventId = plantIdFromValue(body.id) || `manual-${Date.now()}-${eventSuffix}`;
      const checklist = safeArray(body.checklist).map(item => ({
        item: cleanText(item?.item, 160),
        status: cleanText(item?.status, 40),
        note: cleanText(item?.note, 500),
      })).filter(item => item.item);
      const filterParts = safeArray(body.filterParts).map(part => normaliseFilterPart(part, assetId, { type: 'mechanic_app', eventId }));
      const hours = maybeNumber(body.hours);
      const mileage = maybeNumber(body.mileage ?? body.odometer);
      const nextServiceIntervalHours = maybePlantServiceIntervalHours(body.nextServiceIntervalHours)
        ?? (category === 'service' && !eventIsVehicle ? DEFAULT_PLANT_SERVICE_INTERVAL_HOURS : null);
      const nextServiceIntervalMiles = maybeVehicleServiceIntervalMiles(body.nextServiceIntervalMiles ?? (eventIsVehicle ? body.nextServiceIntervalHours : null))
        ?? (category === 'service' && eventIsVehicle ? DEFAULT_VEHICLE_SERVICE_INTERVAL_MILES : null);
      const submittedNextDueHours = eventIsVehicle ? null : maybeNumber(body.nextDueHours);
      const nextDueHours = submittedNextDueHours ?? ((hours !== null && nextServiceIntervalHours !== null) ? hours + nextServiceIntervalHours : null);
      const submittedNextDueMileage = maybeNumber(body.nextDueMileage ?? (eventIsVehicle ? body.nextDueHours : null));
      const nextDueMileage = submittedNextDueMileage ?? ((mileage !== null && nextServiceIntervalMiles !== null) ? mileage + nextServiceIntervalMiles : null);
      const submittedNextDueDate = maybeIsoDate(body.nextDueDate);
      const derivedNextDueDate = category === 'service' ? addCalendarMonths(date, PLANT_SERVICE_INTERVAL_MONTHS) : '';
      const nextDueDate = submittedNextDueDate || derivedNextDueDate;
      const requestedNextDueDateBasis = cleanText(body.nextDueDateBasis, 80);
      const nextDueDateBasis = nextDueDate ? (requestedNextDueDateBasis || (submittedNextDueDate ? 'manual' : '12_month_service_rule')) : '';
      const event = {
        id: eventId,
        assetId,
        plantNumber: cleanText(body.plantNumber || asset.plantNumber || assetId.replace(/^plant-/, ''), 80),
        date,
        category,
        sourceName: cleanText(body.sourceName || body.createdBy || 'Tony mechanic app', 120),
        createdBy: cleanText(body.createdBy || 'Tony', 120),
        createdAt: new Date().toISOString(),
        hours,
        mileage,
        nextDueDate,
        nextDueDateBasis,
        nextDueHours,
        nextServiceIntervalHours,
        nextDueMileage,
        nextServiceIntervalMiles,
        serviceType: cleanText(body.serviceType, 120),
        description: cleanMultiline(body.description || body.workDone, 5000),
        anomalies: cleanMultiline(body.anomalies, 5000),
        torqueCheckRequired,
        torqueNm: torqueCheckRequired ? (maybeNumber(body.torqueNm) || DEFAULT_WHEEL_TORQUE_NM) : null,
        checklist,
        filterParts,
        sharePointEvidencePath: cleanText(body.sharePointEvidencePath || asset.sharePointEvidencePath || `SHARED/Plant and Tool Service Records/${asset.displayName || assetId}`, 300),
        sharePointWriteState: 'queued_for_sharepoint_evidence',
      };
      await appendPlantEvent(env, event);
      return corsResponse(JSON.stringify({ ok: true, event }));
    }

    // PATCH /plant/service-events/{eventId} — internal correction for a saved mechanic entry.
    const plantServiceEventMatch = path.match(/^\/plant\/service-events\/([^/]+)$/);
    if (plantServiceEventMatch && request.method === 'PATCH') {
      const eventId = safePathParam(plantServiceEventMatch[1]);
      if (!eventId) return corsResponse(JSON.stringify({ error: 'bad_event_id' }), 400);
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      const requestedCategoryPatch = Object.prototype.hasOwnProperty.call(body, 'category')
        ? cleanText(body.category, 40).toLowerCase()
        : '';
      if (requestedCategoryPatch && !['service', 'repair', 'inspection', 'parts', 'anomaly'].includes(requestedCategoryPatch)) {
        return corsResponse(JSON.stringify({ error: 'bad_category' }), 400);
      }
      const events = safeArray(await getKvJson(env, PLANT_MANUAL_EVENTS_KEY, []));
      let updatedEvent = null;
      const updatedEvents = events.map(event => {
        if (event.id !== eventId) return event;
        const next = { ...event };
        if (requestedCategoryPatch) next.category = requestedCategoryPatch;
        if (Object.prototype.hasOwnProperty.call(body, 'serviceType')) next.serviceType = cleanText(body.serviceType, 120);
        if (Object.prototype.hasOwnProperty.call(body, 'description')) next.description = cleanMultiline(body.description, 5000);
        if (Object.prototype.hasOwnProperty.call(body, 'anomalies')) next.anomalies = cleanMultiline(body.anomalies, 5000);
        if (Object.prototype.hasOwnProperty.call(body, 'hours')) next.hours = maybeNumber(body.hours);
        if (Object.prototype.hasOwnProperty.call(body, 'mileage') || Object.prototype.hasOwnProperty.call(body, 'odometer')) {
          next.mileage = maybeNumber(body.mileage ?? body.odometer);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'nextDueDate')) {
          next.nextDueDate = maybeIsoDate(body.nextDueDate);
          next.nextDueDateBasis = next.nextDueDate ? cleanText(body.nextDueDateBasis || next.nextDueDateBasis || 'manual', 80) : '';
        } else if (Object.prototype.hasOwnProperty.call(body, 'nextDueDateBasis')) {
          next.nextDueDateBasis = next.nextDueDate ? cleanText(body.nextDueDateBasis, 80) : '';
        }
        if (Object.prototype.hasOwnProperty.call(body, 'nextDueHours')) next.nextDueHours = maybeNumber(body.nextDueHours);
        if (Object.prototype.hasOwnProperty.call(body, 'nextServiceIntervalHours')) {
          next.nextServiceIntervalHours = maybePlantServiceIntervalHours(body.nextServiceIntervalHours);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'nextDueMileage')) next.nextDueMileage = maybeNumber(body.nextDueMileage);
        if (Object.prototype.hasOwnProperty.call(body, 'nextServiceIntervalMiles')) {
          next.nextServiceIntervalMiles = maybeVehicleServiceIntervalMiles(body.nextServiceIntervalMiles);
        }
        next.correctedAt = new Date().toISOString();
        next.correctedBy = cleanText(body.correctedBy || body.updatedBy || 'plant-app', 120);
        next.correctionReason = cleanText(body.correctionReason || 'mechanic_entry_correction', 300);
        updatedEvent = next;
        return next;
      });
      if (!updatedEvent) return notFound();
      await putKvJson(env, PLANT_MANUAL_EVENTS_KEY, updatedEvents);
      return corsResponse(JSON.stringify({ ok: true, event: updatedEvent }));
    }

    // GET /plant/sharepoint-export — pending mechanic facts for the SharePoint evidence writer.
    if (path === '/plant/sharepoint-export' && request.method === 'GET') {
      const state = await loadPlantData(env);
      const pendingEvents = safeArray(await getKvJson(env, PLANT_MANUAL_EVENTS_KEY, []))
        .filter(event => event.sharePointWriteState !== 'linked');
      return corsResponse(JSON.stringify({
        schema: 'pmg-plant-sharepoint-export-v1',
        sharePointEvidenceRoot: state.sharePointEvidenceRoot,
        pendingEvents,
      }));
    }

    // POST /plant/evidence-links — attach a confirmed SharePoint evidence path/link.
    if (path === '/plant/evidence-links' && request.method === 'POST') {
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      const eventId = cleanText(body.eventId, 160);
      if (!eventId) return corsResponse(JSON.stringify({ error: 'event_id_required' }), 400);
      const events = safeArray(await getKvJson(env, PLANT_MANUAL_EVENTS_KEY, []));
      let found = false;
      const updatedEvents = events.map(event => {
        if (event.id !== eventId) return event;
        found = true;
        return {
          ...event,
          sharePointEvidencePath: cleanText(body.sharePointEvidencePath || event.sharePointEvidencePath, 400),
          sharePointEvidenceUrl: cleanText(body.sharePointEvidenceUrl || event.sharePointEvidenceUrl, 800),
          sharePointWriteState: 'linked',
          sharePointLinkedAt: new Date().toISOString(),
        };
      });
      if (!found) return notFound();
      await putKvJson(env, PLANT_MANUAL_EVENTS_KEY, updatedEvents);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // EXISTING ENDPOINTS (unchanged)
    // ══════════════════════════════════════════════════════════════════════════

    // GET /config
    if (path === '/config' && request.method === 'GET') {
      const val = await env.PMG_DATA.get('config');
      return corsResponse(val ?? '{}');
    }

    // PUT /config
    if (path === '/config' && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put('config', body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // GET /jobs/{date}
    const jobsMatch = path.match(/^\/jobs\/(\d{4}-\d{2}-\d{2})$/);
    if (jobsMatch && request.method === 'GET') {
      const val = await env.PMG_DATA.get(`jobs:${jobsMatch[1]}`);
      return corsResponse(val ?? '{}');
    }

    // PUT /jobs/{date}
    if (jobsMatch && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put(`jobs:${jobsMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // GET /export/{date}
    const exportMatch = path.match(/^\/export\/(\d{4}-\d{2}-\d{2})$/);
    if (exportMatch && request.method === 'GET') {
      const date = exportMatch[1];
      const val = await env.PMG_DATA.get(`jobs:${date}`);
      const jobs = val ? safeJsonParse(val) : {};
      if (!jobs) return badStoredData('jobs');
      const rows = ['Driver,Customer,Material,From,To,Quantity,Price,Notes,Status'];
      for (const [driver, driverJobs] of Object.entries(jobs)) {
        for (const job of driverJobs) {
          const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
          rows.push([esc(driver), esc(job.customer), esc(job.material), esc(job.from), esc(job.to), esc(job.quantity), esc(job.price), esc(job.notes), esc(job.status)].join(','));
        }
      }
      return new Response(rows.join('\n'), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="pmg-jobs-${date}.csv"` },
      });
    }

    // PUT /photos/{id}
    const photoMatch = path.match(/^\/photos\/([^/]+)$/);
    if (photoMatch && request.method === 'PUT') {
      const photoId = safePathParam(photoMatch[1]);
      if (!photoId) return corsResponse(JSON.stringify({ error: 'bad_photo_id' }), 400);
      const body = await request.arrayBuffer();
      await env.PMG_DATA.put(`photo:${photoId}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // GET /photos/{id}
    if (photoMatch && request.method === 'GET') {
      const photoId = safePathParam(photoMatch[1]);
      if (!photoId) return corsResponse(JSON.stringify({ error: 'bad_photo_id' }), 400);
      const val = await env.PMG_DATA.get(`photo:${photoId}`, { type: 'arrayBuffer' });
      if (!val) return notFound();
      return new Response(val, { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'image/jpeg' } });
    }

    // PUT /ticket/{id}
    const ticketMatch = path.match(/^\/ticket\/([^/]+)$/);
    if (ticketMatch && request.method === 'PUT') {
      const ticketId = safePathParam(ticketMatch[1]);
      if (!ticketId) return corsResponse(JSON.stringify({ error: 'bad_ticket_id' }), 400);
      const body = await request.text();
      await env.PMG_DATA.put(`ticket:${ticketId}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // GET /tickets
    if (path === '/tickets' && request.method === 'GET') {
      const tickets = [];
      let cursor;
      do {
        const list = await env.PMG_DATA.list({ prefix: 'ticket:', cursor });
        const page = await Promise.all(list.keys.map(async ({ name }) => {
          const val = await env.PMG_DATA.get(name);
          return safeJsonParse(val);
        }));
        tickets.push(...page.filter(Boolean));
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
      return corsResponse(JSON.stringify(tickets.filter(Boolean)));
    }

    // GET /haultech-jobs/{date} (legacy — cached diary from KV)
    const htJobsMatch = path.match(/^\/haultech-jobs\/(\d{4}-\d{2}-\d{2})$/);
    if (htJobsMatch && request.method === 'GET') {
      const date = htJobsMatch[1];
      const val = await env.PMG_DATA.get(`haultech-diary:${date}`);
      if (!val) return corsResponse('[]');
      const jobs = safeJsonParse(val);
      if (!jobs) return badStoredData('haultech_jobs');
      const merged = await mergeJobStatusOverrides(env, date, jobs);
      return corsResponse(JSON.stringify(merged));
    }

    // POST /job-status/{jobId}
    const jobStatusMatch = path.match(/^\/job-status\/([^/]+)$/);
    if (jobStatusMatch && request.method === 'POST') {
      const jobId = safePathParam(jobStatusMatch[1]);
      if (!jobId) return corsResponse(JSON.stringify({ error: 'bad_job_id' }), 400);
      const body = safeJsonParse(await request.text());
      if (!body || typeof body !== 'object') return corsResponse(JSON.stringify({ error: 'bad_json' }), 400);
      const { status, driver, date } = body;
      if (!status || typeof status !== 'string') return corsResponse(JSON.stringify({ error: 'status required' }), 400);
      if (!isValidIsoDate(date)) return corsResponse(JSON.stringify({ error: 'bad_date' }), 400);
      const statusData = {
        status,
        driver: cleanText(driver, 120),
        date,
        reason: cleanText(body.reason, 500),
        note: cleanText(body.note, 500),
        updatedAt: new Date().toISOString(),
      };
      const statusIndex = safeObject(await getKvJson(env, jobStatusIndexKey(date), {}));
      statusIndex[jobId] = statusData;
      await Promise.all([
        putKvJson(env, jobStatusIndexKey(date), statusIndex),
        env.PMG_DATA.put(`job-status:${date}:${jobId}`, JSON.stringify(statusData)),
      ]);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // PUT /haultech-diary/{date}
    const htDiaryMatch = path.match(/^\/haultech-diary\/(\d{4}-\d{2}-\d{2})$/);
    if (htDiaryMatch && request.method === 'PUT') {
      if (!hasAdminKey(request, env)) {
        return corsResponse(JSON.stringify({ error: 'admin_key_required' }), 403);
      }
      const body = await request.text();
      await env.PMG_DATA.put(`haultech-diary:${htDiaryMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    return notFound();
  },

  scheduled(event, env, ctx) {
    if (event?.cron === PLANT_PUSH_CRON) {
      ctx.waitUntil(runScheduledPlantPushAlerts(env, event));
      return;
    }
    ctx.waitUntil(runScheduledHaultechRefresh(env, event));
    ctx.waitUntil(refreshHaultechCustomers(env, event));
    ctx.waitUntil(runScheduledPlantPushAlerts(env, event));
  },
};
