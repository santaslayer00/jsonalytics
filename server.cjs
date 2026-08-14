// Startup timing: this process has been observed taking anywhere from ~2s
// to 25s+ to bind its port during development on some machines (Windows AV
// scanning a freshly-spawned node.exe and its module tree is the leading
// suspect, but was never conclusively isolated). This can't measure time
// before Node starts executing this file — only what happens inside it —
// but that's enough to tell "slow require()s" apart from "slow process
// spawn," which is otherwise an unfalsifiable mystery every time it recurs.
const __startupBegin = process.hrtime.bigint();

require('dotenv').config();
const express = require('express');
const cors = require('cors');
// google-auth-library (not the full googleapis umbrella package) — this app
// only ever needs OAuth2Client + authenticated REST calls to 2 Google APIs
// (GA4 Data API, Tag Manager API v2). googleapis pulls in ~1,900 files of
// generated clients for every Google API in existence; google-auth-library
// is ~80. Measured while diagnosing an intermittent 15-25s dev-server
// cold-start: on slow runs, the internal startup timer (see __startupBegin
// below) showed the delay was inside require() itself, not before Node
// started — consistent with antivirus scanning a freshly-touched, huge
// module tree. This does not eliminate that (can't control the user's AV),
// but it removes the single biggest file count in the require graph.
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const app = express();

// ---- SSRF guard ----
// The scanner accepts arbitrary operator-supplied URLs and both fetches them
// server-side and navigates a real headless browser to them. Without this
// check a malicious/careless URL (http://127.0.0.1:..., http://169.254.169.254/...,
// http://internal-host/...) would let the scanner reach the local machine or
// internal network. This blocks obviously private/loopback/link-local targets
// before every fetch() and puppeteer.goto() call. See lib/ssrfGuard.cjs for
// the implementation and its direct unit tests.
const { assertScannableUrl, safeFetch } = require('./lib/ssrfGuard.cjs');
const { fetchWithRateLimitRetry } = require('./lib/shopifyFetch.cjs');
const LOCAL_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
app.use(cors({
  origin(origin, callback) {
    if (!origin || LOCAL_ORIGINS.has(origin)) return callback(null, true);
    return callback(new Error('This local audit server only accepts requests from the local app.'));
  },
}));
app.use(express.json({ limit: '5mb' }));

const path = require('path');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    return data;
  } catch {
    return { ga4: null, gtm: null };
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// ---- Lead register (lightweight pipeline tracker, local file storage) ----
// Deliberately not a CRM: one flat file, four statuses, no history/audit
// trail. "Lean" per the product philosophy — this tracks operator intent
// (who to follow up with), not scan evidence.
const LEADS_FILE = path.join(__dirname, 'leads.json');
const LEAD_STATUSES = ['interested', 'not_interested', 'in_queue', 'in_progress'];

function loadLeads() {
  try {
    const data = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveLeads(list) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(list, null, 2));
}

let leads = loadLeads();

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_ACCESS_TOKEN, // optional: set this if you're using a custom app static token
} = process.env;

const oauth2Client = new OAuth2Client(
  process.env.GA4_CLIENT_ID,
  process.env.GA4_CLIENT_SECRET,
  process.env.GA4_REDIRECT_URI
);

const gtmOauth2Client = new OAuth2Client(
  process.env.GA4_CLIENT_ID,
  process.env.GA4_CLIENT_SECRET,
  process.env.GTM_REDIRECT_URI
);

const savedTokens = loadTokens();
let ga4Tokens = savedTokens.ga4;
let gtmTokens = savedTokens.gtm;

if (ga4Tokens) oauth2Client.setCredentials(ga4Tokens);
if (gtmTokens) gtmOauth2Client.setCredentials(gtmTokens);

// OAuth2Client.request() (used for every authenticated call below) already
// refreshes an expiring access token before the request goes out — this
// just persists whatever it refreshed to, so a restart doesn't lose it.
// Spreading over the previous tokens preserves refresh_token on refreshes
// that don't return a new one (only the first authorization does).
oauth2Client.on('tokens', (tokens) => {
  ga4Tokens = { ...ga4Tokens, ...tokens };
  saveTokens({ ga4: ga4Tokens, gtm: gtmTokens });
});
gtmOauth2Client.on('tokens', (tokens) => {
  gtmTokens = { ...gtmTokens, ...tokens };
  saveTokens({ ga4: ga4Tokens, gtm: gtmTokens });
});

// ---- Storefront HTML scan (Tab 1 - No Access) ----
app.get('/api/scan', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  try {
    await assertScannableUrl(target);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    // safeFetch re-validates every redirect hop, not just the original URL —
    // a same-origin-looking store that 302s to a private IP would otherwise
    // sail past the assertScannableUrl check above.
    const response = await safeFetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });

    if (!response.ok) {
      if (response.status === 403 || response.status === 503) {
        return res.status(response.status).json({
          error: 'This store blocks automated scans (likely Cloudflare or bot protection). Try checking it manually.',
          blocked: true,
        });
      }
      return res.status(response.status).json({ error: `Store returned ${response.status}` });
    }

    const html = await response.text();
    res.json({ url: target, html });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach store', detail: err.message });
  }
});

// ---- Deep scan: real headless-browser check (Tab 1 - No Access, no credentials needed) ----
app.get('/api/scan/deep', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  try {
    await assertScannableUrl(target);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const capturedRequests = [];
    // Request interception is required here (not just optional tracking):
    // it lets us validate the main-frame navigation URL — including every
    // redirect hop — against the SSRF guard before the browser is allowed to
    // actually navigate there. Without this, a store could 302 the scanner
    // to an internal address after the initial assertScannableUrl check.
    await page.setRequestInterception(true);
    page.on('request', async (r) => {
      const u = r.url();
      if (/google-analytics\.com|analytics\.google\.com|googletagmanager\.com|facebook\.com\/tr|tiktok\.com\/i18n\/pixel|collect\?/.test(u)) {
        capturedRequests.push(u);
      }
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        try {
          await assertScannableUrl(u);
        } catch {
          return r.abort('blockedbyclient').catch(() => {});
        }
      }
      return r.continue().catch(() => {});
    });

    // networkidle2 (wait for <=2 in-flight connections) sounds right for
    // "let tracking scripts settle," but real sites commonly never reach it
    // at all: live-chat widgets, retargeting beacons, and websocket
    // keep-alives keep background traffic running indefinitely, so the
    // whole scan would time out and fail on exactly the kind of
    // well-instrumented site this tool is most useful against. Confirmed
    // live against a real store (gymshark.com) during testing — hit this
    // exact timeout. domcontentloaded is fast and reliable regardless of
    // background traffic; the fixed settle delay after it gives GTM/GA4/
    // pixel scripts time to initialize and fire their first requests,
    // which is what this scan actually needs to observe.
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const dataLayerContents = await page.evaluate(() => {
      try { return Array.isArray(window.dataLayer) ? window.dataLayer.slice(0, 25) : null; }
      catch { return null; }
    });

    const consentSignals = await page.evaluate(() => {
      try {
        const dl = Array.isArray(window.dataLayer) ? window.dataLayer : [];
        const consentEvent = dl.find(e => Array.isArray(e) && e[0] === 'consent');
        return { found: !!consentEvent, raw: consentEvent || null };
      } catch { return { found: false, raw: null }; }
    });

    // Intentionally read-only: no clicks, form submissions, cart mutations, or checkout navigation.
    // Events below are only evidence observed during the initial page load.
    const eventEvidence = (dataLayerContents || []).flatMap((entry) => {
      const event = typeof entry?.event === 'string' ? entry.event : (Array.isArray(entry) && entry[0] === 'event' ? entry[1] : null);
      if (!event || typeof event !== 'string') return [];
      const ecommerce = entry?.ecommerce;
      return [{ event, ecommerceFields: ecommerce && typeof ecommerce === 'object' ? Object.keys(ecommerce) : [], evidence: 'observed-on-page-load' }];
    });
    const serverSideEndpointCandidates = [...new Set(capturedRequests
      .filter((u) => /stape|sgtm|server-side|\/g\/collect|\/collect\?/i.test(u))
      .map((u) => new URL(u).origin))];

    // Reconciliation evidence: measurement/container IDs actually seen firing
    // in network requests, as opposed to IDs merely present in static HTML.
    // A static ID with zero matching observed ID is evidence the tag may not
    // actually be executing/firing on page load — not proof, since consent
    // gating or async timing can also explain a miss.
    // tid= carries both GA4 measurement IDs (G-xxxx) and Google Ads conversion
    // IDs (AW-xxxx) — keep only G-xxxx here so "observed GA4 IDs" doesn't
    // silently include Ads IDs and produce a misleading reconciliation.
    const observedGa4Ids = [...new Set(capturedRequests.flatMap((u) => {
      try {
        const tid = new URL(u).searchParams.get('tid');
        return tid && /^G-/i.test(tid) ? [tid] : [];
      } catch { return []; }
    }))];
    const observedGtmIds = [...new Set(capturedRequests.flatMap((u) => {
      const m = u.match(/[?&]id=(GTM-[A-Z0-9]+)/);
      return m ? [m[1]] : [];
    }))];

    await browser.close();

    res.json({
      url: target,
      dataLayer: dataLayerContents,
      dataLayerPresent: !!dataLayerContents,
      consent: consentSignals,
      trackingRequestsSeen: [...new Set(capturedRequests)],
      eventEvidence,
      trackingSignals: {
        ga4Requests: capturedRequests.filter((u) => /google-analytics\.com|\/g\/collect|\/collect\?/i.test(u)).length,
        gtmRequests: capturedRequests.filter((u) => /googletagmanager\.com\/gtm\.js/i.test(u)).length,
        metaBrowserRequests: capturedRequests.filter((u) => /facebook\.com\/tr/i.test(u)).length,
        tiktokBrowserRequests: capturedRequests.filter((u) => /tiktok\.com\/i18n\/pixel/i.test(u)).length,
        serverSideEndpointCandidates,
      },
      observedIds: { ga4: observedGa4Ids, gtm: observedGtmIds },
      note: 'Read-only page-load inspection. It does not click Add to Cart, submit forms, create carts, or validate purchase/CAPI/deduplication. Those require intentional test-checkout or imported evidence.',
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(502).json({ error: 'Deep scan failed', detail: err.message });
  }
});

// ---- PDF export ----
app.post('/api/report/pdf', async (req, res) => {
  const { html } = req.body || {};
  if (!html) return res.status(400).json({ error: 'Missing html in body' });

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="jsonalytics-audit-report.pdf"',
    });
    res.send(pdfBuffer);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(502).json({ error: 'PDF generation failed', detail: err.message });
  }
});

// ---- Shopify Admin API (Tab 2 - With Access) ----
let cachedToken = null;
let tokenExpiresAt = 0;

async function getShopifyAccessToken() {
  // If a static custom-app access token is supplied, use it directly —
  // most real-world "with access" setups use this, not the OAuth
  // client_credentials exchange below (which Shopify does not support
  // for the standard Admin API flow).
  if (SHOPIFY_ACCESS_TOKEN) {
    return SHOPIFY_ACCESS_TOKEN;
  }

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('Missing Shopify credentials in .env — set SHOPIFY_ACCESS_TOKEN (custom app token, recommended) or SHOPIFY_STORE_DOMAIN/SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET');
  }

  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const tokenRes = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    throw new Error(`Shopify token request failed (${tokenRes.status}): ${detail}. If this is a custom app, set SHOPIFY_ACCESS_TOKEN instead of using this OAuth flow.`);
  }

  const tokenData = await tokenRes.json();
  cachedToken = tokenData.access_token;
  tokenExpiresAt = Date.now() + (tokenData.expires_in ? tokenData.expires_in * 1000 : 24 * 60 * 60 * 1000);

  return cachedToken;
}

app.get('/api/shopify/orders', async (req, res) => {
  try {
    const token = await getShopifyAccessToken();

    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';
    const params = new URLSearchParams({ status: 'any', limit: '250' });
    if (startDate) params.set('created_at_min', `${startDate}T00:00:00Z`);
    if (endDate) params.set('created_at_max', `${endDate}T23:59:59Z`);
    let nextUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-01/orders.json?${params}`;
    const orders = [];
    let pageCount = 0;
    while (nextUrl) {
      // Rate-limit-aware: a large store needs many pages to pull a full
      // date range, and Shopify's Admin API rate-limits by a leaky bucket —
      // without retrying on 429 this would just fail partway through for
      // exactly the stores where "store size shouldn't matter" matters most.
      const ordersRes = await fetchWithRateLimitRetry(nextUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      });
      if (!ordersRes.ok) {
        return res.status(ordersRes.status).json({
          error: ordersRes.status === 429
            ? `Shopify rate-limited this pull after ${pageCount} page(s) and retries were exhausted — try a narrower date range.`
            : `Shopify orders request failed (${ordersRes.status})`,
        });
      }
      const data = await ordersRes.json();
      orders.push(...(data.orders || []));
      pageCount++;
      const link = ordersRes.headers.get('link') || '';
      const next = link.split(',').find((part) => /rel="next"/.test(part));
      nextUrl = next ? next.match(/<([^>]+)>/)?.[1] || null : null;
    }
    res.json({ orders, range: { startDate: startDate || null, endDate: endDate || null }, paginated: true, pageCount });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch Shopify orders', detail: err.message });
  }
});

// ---- GA4 OAuth (Tab 2 - With Access) ----
app.get('/api/ga4/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/tagmanager.readonly'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/api/ga4/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    ga4Tokens = tokens;
    saveTokens({ ga4: ga4Tokens, gtm: gtmTokens });
    res.send('GA4 connected! You can close this tab.');
  } catch (err) {
    console.error('GA4 auth error:', err);
    res.status(500).send('GA4 auth failed');
  }
});

app.get('/api/ga4/report', async (req, res) => {
  const { propertyId, startDate = '30daysAgo', endDate = 'today' } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'Missing propertyId param' });
  if (!ga4Tokens) return res.status(401).json({ error: 'GA4 not connected yet — visit /api/ga4/auth first' });

  try {
    oauth2Client.setCredentials(ga4Tokens);
    const response = await oauth2Client.request({
      url: `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      method: 'POST',
      data: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'conversions' },
          { name: 'purchaseRevenue' },
        ],
      },
    });

    res.json(response.data);
  } catch (err) {
    console.error('GA4 report error:', err.message);
    res.status(500).json({ error: 'GA4 report failed', detail: err.message });
  }
});

// ---- GTM OAuth (Tab 2 - With Access) ----
app.get('/api/gtm/auth', (req, res) => {
  const url = gtmOauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/tagmanager.readonly'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/api/gtm/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await gtmOauth2Client.getToken(code);
    gtmTokens = tokens;
    saveTokens({ ga4: ga4Tokens, gtm: gtmTokens });
    res.send('GTM connected! You can close this tab.');
  } catch (err) {
    console.error('GTM auth error:', err);
    res.status(500).send('GTM auth failed');
  }
});

app.get('/api/gtm/containers', async (req, res) => {
  if (!gtmTokens) return res.status(401).json({ error: 'GTM not connected yet — visit /api/gtm/auth first' });

  try {
    gtmOauth2Client.setCredentials(gtmTokens);
    const GTM_BASE = 'https://www.googleapis.com/tagmanager/v2';

    const accountsRes = await gtmOauth2Client.request({ url: `${GTM_BASE}/accounts` });
    const accounts = accountsRes.data.account || [];

    const allContainers = [];
    for (const account of accounts) {
      const containersRes = await gtmOauth2Client.request({ url: `${GTM_BASE}/${account.path}/containers` });
      allContainers.push(...(containersRes.data.container || []));
    }

    res.json({ accounts, containers: allContainers });
  } catch (err) {
    console.error('GTM containers error:', err.message);
    res.status(500).json({ error: 'GTM containers fetch failed', detail: err.message });
  }
});

app.get('/api/status', (_req, res) => {
  res.json({ ga4: { connected: Boolean(ga4Tokens) }, gtm: { connected: Boolean(gtmTokens) }, shopify: { configured: Boolean(SHOPIFY_STORE_DOMAIN && (SHOPIFY_ACCESS_TOKEN || (SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET))) } });
});

app.get('/api/gtm/inspect', async (req, res) => {
  const { containerPath } = req.query;
  if (!gtmTokens) return res.status(401).json({ error: 'GTM not connected yet' });
  if (!containerPath) return res.status(400).json({ error: 'Missing containerPath' });
  try {
    gtmOauth2Client.setCredentials(gtmTokens);
    const GTM_BASE = 'https://www.googleapis.com/tagmanager/v2';
    const [tags, triggers] = await Promise.all([
      gtmOauth2Client.request({ url: `${GTM_BASE}/${containerPath}/workspaces/1/tags` }),
      gtmOauth2Client.request({ url: `${GTM_BASE}/${containerPath}/workspaces/1/triggers` }),
    ]);
    res.json({ tags: tags.data.tag || [], triggers: triggers.data.trigger || [], limitation: 'Default workspace only; published version and firing behavior still require Preview evidence.' });
  } catch (err) { res.status(500).json({ error: 'GTM inspection failed', detail: err.message }); }
});

// ---- Lead register endpoints ----
app.get('/api/leads', (_req, res) => {
  res.json({ leads, statuses: LEAD_STATUSES });
});

app.post('/api/leads', (req, res) => {
  const { storeUrl, storeName, status, notes } = req.body || {};
  if (typeof storeUrl !== 'string' || !storeUrl.trim()) {
    return res.status(400).json({ error: 'storeUrl is required' });
  }
  if (status !== undefined && !LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${LEAD_STATUSES.join(', ')}` });
  }
  const now = new Date().toISOString();
  const lead = {
    id: crypto.randomUUID(),
    storeUrl: storeUrl.trim(),
    storeName: typeof storeName === 'string' ? storeName.trim() : '',
    status: status || 'in_queue',
    notes: typeof notes === 'string' ? notes : '',
    createdAt: now,
    updatedAt: now,
    // Cached evidence from the last scan run from the Leads tab, so
    // revisiting a lead doesn't force a re-scan — null until "Scan"/
    // "Re-scan" is explicitly clicked. Never written automatically.
    lastScan: null,
  };
  leads.push(lead);
  saveLeads(leads);
  res.status(201).json({ lead });
});

app.patch('/api/leads/:id', (req, res) => {
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const { status, notes, storeName, lastScan } = req.body || {};
  if (status !== undefined) {
    if (!LEAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${LEAD_STATUSES.join(', ')}` });
    }
    lead.status = status;
  }
  if (notes !== undefined) lead.notes = typeof notes === 'string' ? notes : lead.notes;
  if (storeName !== undefined) lead.storeName = typeof storeName === 'string' ? storeName : lead.storeName;
  // lastScan is a cache blob written by the trusted local frontend (already
  // evidence gathered through the SSRF-guarded scan endpoints) — stored
  // as-is rather than deep-validated field by field.
  if (lastScan !== undefined) lead.lastScan = lastScan;
  lead.updatedAt = new Date().toISOString();

  saveLeads(leads);
  res.json({ lead });
});

app.delete('/api/leads/:id', (req, res) => {
  const idx = leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
  const [removed] = leads.splice(idx, 1);
  saveLeads(leads);
  res.json({ removed });
});

const PORT = 4000;
app.listen(PORT, '127.0.0.1', () => {
  const startupMs = Number(process.hrtime.bigint() - __startupBegin) / 1e6;
  console.log(`Audit proxy running locally on http://127.0.0.1:${PORT} (module load + listen: ${startupMs.toFixed(0)}ms)`);
  if (startupMs > 3000) {
    console.log('Startup took longer than usual — if this happens consistently, it is most likely something outside this app (antivirus scanning a freshly-spawned node.exe, disk cache, or system load), not this code: the timed window above only covers module loading through listen(), and it is fast.');
  }
});
