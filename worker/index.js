const API_KEY = 'pmg2026driver';
const HT_BASE = 'https://httms.azurewebsites.net';
const DEFAULT_TMS = 'd80fd468-e802-492d-b73c-e09ab51bee88';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PMG-Key',
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

function notFound() {
  return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
}

// ── Haultech token auto-refresh via Microsoft ROPC refresh_token flow ────────
async function refreshHaultechToken(env) {
  const authVal = await env.PMG_DATA.get('haultech-auth');
  if (!authVal) return null;
  let auth;
  try { auth = JSON.parse(authVal); } catch { return null; }
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const result = await resp.json();
    if (result.access_token) {
      // Update stored auth with new tokens
      auth.token = result.access_token;
      if (result.refresh_token) auth.refreshToken = result.refresh_token;
      await env.PMG_DATA.put('haultech-auth', JSON.stringify(auth));
      return result.access_token;
    }
  } catch (e) {}
  return null;
}

// ── Haultech proxy helper ────────────────────────────────────────────────────
async function htFetch(env, apiPath, opts = {}) {
  const authVal = await env.PMG_DATA.get('haultech-auth');
  if (!authVal) return corsResponse(JSON.stringify({ error: 'no_haultech_auth' }), 401);
  let auth;
  try { auth = JSON.parse(authVal); } catch { return corsResponse(JSON.stringify({ error: 'bad_auth_data' }), 500); }

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Public endpoints (no API key needed) ─────────────────────────────────

    // GET /haultech-token — return cached Haultech auth for direct API calls
    if (path === '/haultech-token' && request.method === 'GET') {
      const val = await env.PMG_DATA.get('haultech-auth');
      if (!val) return corsResponse(JSON.stringify({ error: 'no_auth_token' }), 401);
      return corsResponse(val);
    }

    // Auth check for everything else
    const key = request.headers.get('X-PMG-Key');
    if (key !== API_KEY) {
      return unauthorized();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // HAULTECH PROXY ENDPOINTS — /ht/*
    // ══════════════════════════════════════════════════════════════════════════

    // POST /haultech-refresh — force token refresh
    if (path === '/haultech-refresh' && request.method === 'POST') {
      if (!isAuth) return unauthorized();
      const newToken = await refreshHaultechToken(env);
      if (newToken) return corsResponse(JSON.stringify({ ok: true, refreshed: true }));
      return corsResponse(JSON.stringify({ error: 'refresh_failed' }), 500);
    }

    // GET /ht/jobs?date=YYYY-MM-DD — fetch live jobs from Haultech
    if (path === '/ht/jobs' && request.method === 'GET') {
      const date = url.searchParams.get('date');
      if (!date) return corsResponse(JSON.stringify({ error: 'date required' }), 400);
      return htFetch(env, `/api/Display/GetJobsByDatePaginated?selectFromDate=${date}&selectToDate=${date}&take=200`);
    }

    // PATCH /ht/receive/{consignmentId} — QuickReceiveJob (Depart)
    const receiveMatch = path.match(/^\/ht\/receive\/([^/]+)$/);
    if (receiveMatch && request.method === 'PATCH') {
      return htFetch(env, `/api/Job/QuickReceiveJob?id=${receiveMatch[1]}`, { method: 'PATCH' });
    }

    // PATCH /ht/complete/{consignmentId} — QuickCompleteJob (Complete)
    const completeMatch = path.match(/^\/ht\/complete\/([^/]+)$/);
    if (completeMatch && request.method === 'PATCH') {
      return htFetch(env, `/api/Job/QuickCompleteJob?id=${completeMatch[1]}`, { method: 'PATCH' });
    }

    // POST /ht/upsert — UpsertJob (Add new job to Haultech)
    if (path === '/ht/upsert' && request.method === 'POST') {
      const body = await request.text();
      return htFetch(env, '/api/Job/UpsertJob?formId=', { method: 'POST', body });
    }

    // POST /ht/mpod/{consignmentId} — MakeImageMpod (upload POD photo)
    const mpodMatch = path.match(/^\/ht\/mpod\/([^/]+)$/);
    if (mpodMatch && request.method === 'POST') {
      const authVal = await env.PMG_DATA.get('haultech-auth');
      if (!authVal) return corsResponse(JSON.stringify({ error: 'no_haultech_auth' }), 401);
      const auth = JSON.parse(authVal);
      // Forward raw body (image data) to Haultech
      const body = await request.arrayBuffer();
      const ct = request.headers.get('Content-Type') || 'image/jpeg';
      const resp = await fetch(`${HT_BASE}/api/Job/MakeImageMpod?trackerId=${mpodMatch[1]}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'oauthTmsId': auth.tmsId || DEFAULT_TMS,
          'Content-Type': ct,
        },
        body,
      });
      const data = await resp.text();
      return corsResponse(data, resp.status);
    }

    // GET /ht/signatures/{consignmentId} — GetSignatureImages
    const sigMatch = path.match(/^\/ht\/signatures\/([^/]+)$/);
    if (sigMatch && request.method === 'GET') {
      return htFetch(env, `/api/Job/GetSignatureImages?consignmentId=${sigMatch[1]}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AUTH MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════════

    // PUT /haultech-auth — store Haultech auth token
    if (path === '/haultech-auth' && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put('haultech-auth', body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CUSTOMERS
    // ══════════════════════════════════════════════════════════════════════════

    // GET /customers — return customer list from KV
    if (path === '/customers' && request.method === 'GET') {
      const val = await env.PMG_DATA.get('customers');
      return corsResponse(val ?? '[]');
    }

    // PUT /customers — store customer list in KV
    if (path === '/customers' && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put('customers', body);
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
      const jobs = val ? JSON.parse(val) : {};
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
      const body = await request.arrayBuffer();
      await env.PMG_DATA.put(`photo:${photoMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // GET /photos/{id}
    if (photoMatch && request.method === 'GET') {
      const val = await env.PMG_DATA.get(`photo:${photoMatch[1]}`, { type: 'arrayBuffer' });
      if (!val) return notFound();
      return new Response(val, { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'image/jpeg' } });
    }

    // PUT /ticket/{id}
    const ticketMatch = path.match(/^\/ticket\/([^/]+)$/);
    if (ticketMatch && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put(`ticket:${ticketMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // GET /tickets
    if (path === '/tickets' && request.method === 'GET') {
      const list = await env.PMG_DATA.list({ prefix: 'ticket:' });
      const tickets = await Promise.all(list.keys.map(async ({ name }) => {
        const val = await env.PMG_DATA.get(name);
        return val ? JSON.parse(val) : null;
      }));
      return corsResponse(JSON.stringify(tickets.filter(Boolean)));
    }

    // GET /haultech-jobs/{date} (legacy — cached diary from KV)
    const htJobsMatch = path.match(/^\/haultech-jobs\/(\d{4}-\d{2}-\d{2})$/);
    if (htJobsMatch && request.method === 'GET') {
      const date = htJobsMatch[1];
      const val = await env.PMG_DATA.get(`haultech-diary:${date}`);
      if (!val) return corsResponse('[]');
      const jobs = JSON.parse(val);
      const merged = await Promise.all(jobs.map(async (job) => {
        const statusVal = await env.PMG_DATA.get(`job-status:${date}:${job.id}`);
        if (statusVal) {
          const statusData = JSON.parse(statusVal);
          return { ...job, status: statusData.status };
        }
        return job;
      }));
      return corsResponse(JSON.stringify(merged));
    }

    // POST /job-status/{jobId}
    const jobStatusMatch = path.match(/^\/job-status\/([^/]+)$/);
    if (jobStatusMatch && request.method === 'POST') {
      const body = await request.json();
      const { status, driver, date } = body;
      await env.PMG_DATA.put(`job-status:${date}:${jobStatusMatch[1]}`, JSON.stringify({ status, driver, date, updatedAt: new Date().toISOString() }));
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // PUT /haultech-diary/{date}
    const htDiaryMatch = path.match(/^\/haultech-diary\/(\d{4}-\d{2}-\d{2})$/);
    if (htDiaryMatch && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put(`haultech-diary:${htDiaryMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    return notFound();
  },
};
