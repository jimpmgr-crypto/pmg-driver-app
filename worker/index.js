const API_KEY = 'pmg2026driver';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Auth check
    const key = request.headers.get('X-PMG-Key');
    if (key !== API_KEY) {
      return unauthorized();
    }

    // ── GET /config ──────────────────────────────────────────────────────────
    if (path === '/config' && request.method === 'GET') {
      const val = await env.PMG_DATA.get('config');
      return corsResponse(val ?? '{}');
    }

    // ── PUT /config ──────────────────────────────────────────────────────────
    if (path === '/config' && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put('config', body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // ── GET /jobs/{date} ─────────────────────────────────────────────────────
    const jobsMatch = path.match(/^\/jobs\/(\d{4}-\d{2}-\d{2})$/);
    if (jobsMatch && request.method === 'GET') {
      const val = await env.PMG_DATA.get(`jobs:${jobsMatch[1]}`);
      return corsResponse(val ?? '{}');
    }

    // ── PUT /jobs/{date} ─────────────────────────────────────────────────────
    if (jobsMatch && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put(`jobs:${jobsMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // ── GET /export/{date} ───────────────────────────────────────────────────
    const exportMatch = path.match(/^\/export\/(\d{4}-\d{2}-\d{2})$/);
    if (exportMatch && request.method === 'GET') {
      const date = exportMatch[1];
      const val = await env.PMG_DATA.get(`jobs:${date}`);
      const jobs = val ? JSON.parse(val) : {};
      const rows = ['Driver,Customer,Material,From,To,Quantity,Price,Notes,Status'];
      for (const [driver, driverJobs] of Object.entries(jobs)) {
        for (const job of driverJobs) {
          const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
          rows.push([
            esc(driver),
            esc(job.customer),
            esc(job.material),
            esc(job.from),
            esc(job.to),
            esc(job.quantity),
            esc(job.price),
            esc(job.notes),
            esc(job.status),
          ].join(','));
        }
      }
      return new Response(rows.join('\n'), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="pmg-jobs-${date}.csv"`,
        },
      });
    }

    // ── PUT /photos/{id} ─────────────────────────────────────────────────────
    const photoMatch = path.match(/^\/photos\/([^/]+)$/);
    if (photoMatch && request.method === 'PUT') {
      const body = await request.arrayBuffer();
      await env.PMG_DATA.put(`photo:${photoMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // ── GET /photos/{id} ─────────────────────────────────────────────────────
    if (photoMatch && request.method === 'GET') {
      const val = await env.PMG_DATA.get(`photo:${photoMatch[1]}`, { type: 'arrayBuffer' });
      if (!val) return notFound();
      return new Response(val, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'image/jpeg' },
      });
    }

    // ── PUT /ticket/{id} ─────────────────────────────────────────────────────
    const ticketMatch = path.match(/^\/ticket\/([^/]+)$/);
    if (ticketMatch && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put(`ticket:${ticketMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // ── GET /tickets ─────────────────────────────────────────────────────────
    if (path === '/tickets' && request.method === 'GET') {
      const list = await env.PMG_DATA.list({ prefix: 'ticket:' });
      const tickets = await Promise.all(
        list.keys.map(async ({ name }) => {
          const val = await env.PMG_DATA.get(name);
          return val ? JSON.parse(val) : null;
        })
      );
      return corsResponse(JSON.stringify(tickets.filter(Boolean)));
    }

    // ── GET /haultech-jobs/{date} ─────────────────────────────────────────────
    const htJobsMatch = path.match(/^\/haultech-jobs\/(\d{4}-\d{2}-\d{2})$/);
    if (htJobsMatch && request.method === 'GET') {
      const date = htJobsMatch[1];
      const val = await env.PMG_DATA.get(`haultech-diary:${date}`);
      if (!val) return corsResponse('[]');
      const jobs = JSON.parse(val);
      // Merge in any status overrides
      const merged = await Promise.all(
        jobs.map(async (job) => {
          const statusVal = await env.PMG_DATA.get(`job-status:${date}:${job.id}`);
          if (statusVal) {
            const statusData = JSON.parse(statusVal);
            return { ...job, status: statusData.status };
          }
          return job;
        })
      );
      return corsResponse(JSON.stringify(merged));
    }

    // ── POST /job-status/{jobId} ──────────────────────────────────────────────
    const jobStatusMatch = path.match(/^\/job-status\/([^/]+)$/);
    if (jobStatusMatch && request.method === 'POST') {
      const body = await request.json();
      const { status, driver, date } = body;
      await env.PMG_DATA.put(
        `job-status:${date}:${jobStatusMatch[1]}`,
        JSON.stringify({ status, driver, date, updatedAt: new Date().toISOString() })
      );
      return corsResponse(JSON.stringify({ ok: true }));
    }

    // ── PUT /haultech-diary/{date} ────────────────────────────────────────────
    const htDiaryMatch = path.match(/^\/haultech-diary\/(\d{4}-\d{2}-\d{2})$/);
    if (htDiaryMatch && request.method === 'PUT') {
      const body = await request.text();
      await env.PMG_DATA.put(`haultech-diary:${htDiaryMatch[1]}`, body);
      return corsResponse(JSON.stringify({ ok: true }));
    }

    return notFound();
  },
};
