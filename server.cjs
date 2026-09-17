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
const { redactPII } = require('./lib/piiRedaction.cjs');
const LOCAL_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
app.use(cors({
  origin(origin, callback) {
    if (!origin || LOCAL_ORIGINS.has(origin)) return callback(null, true);
    return callback(new Error('This local audit server only accepts requests from the local app.'));
  },
}));
app.use(express.json({ limit: '5mb' }));

// Live request log for manual testing sessions — deliberately minimal (no
// full body/header dump, so OAuth tokens/codes never hit the console) so it
// stays safe to leave on while watching real UI clicks turn into real
// backend calls.
app.use((req, res, next) => {
  const target = req.query?.url || req.body?.storeUrl || '';
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}${target ? ` (${target})` : ''} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

const path = require('path');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    return data;
  } catch {
    return { ga4: null, gtm: null, shopify: null };
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
const LEAD_STATUSES = ['not_contacted', 'contacted', 'interested', 'not_interested', 'in_progress'];

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
  SHOPIFY_REDIRECT_URI, // e.g. http://localhost:4000/api/shopify/callback — must also be registered as an allowed redirect URL in the app's dev-dashboard configuration
  SHOPIFY_ACCESS_TOKEN, // optional: set this if you have a static custom-app token instead of using the OAuth flow below
  SHOPIFY_API_VERSION, // optional override — Shopify releases a new quarterly version (YYYY-01/04/07/10); each is supported ~12 months, so this needs bumping periodically. One place to change instead of hunting every admin/api/ URL.
} = process.env;
const shopifyApiVersion = SHOPIFY_API_VERSION || '2026-07';

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
let shopifyTokens = savedTokens.shopify; // { access_token, scope } — Shopify Admin API tokens from this flow don't expire, no refresh needed
let shopifyOauthState = null; // single-operator local app: one in-memory nonce is enough CSRF protection, no session store needed

if (ga4Tokens) oauth2Client.setCredentials(ga4Tokens);
if (gtmTokens) gtmOauth2Client.setCredentials(gtmTokens);

// OAuth2Client.request() (used for every authenticated call below) already
// refreshes an expiring access token before the request goes out — this
// just persists whatever it refreshed to, so a restart doesn't lose it.
// Spreading over the previous tokens preserves refresh_token on refreshes
// that don't return a new one (only the first authorization does).
oauth2Client.on('tokens', (tokens) => {
  ga4Tokens = { ...ga4Tokens, ...tokens };
  saveTokens({ ga4: ga4Tokens, gtm: gtmTokens, shopify: shopifyTokens });
});
gtmOauth2Client.on('tokens', (tokens) => {
  gtmTokens = { ...gtmTokens, ...tokens };
  saveTokens({ ga4: ga4Tokens, gtm: gtmTokens, shopify: shopifyTokens });
});

// ---- Storefront HTML scan (Tab 1 - No Access) ----
// Storefront password unlock — only ever used when the operator explicitly
// supplies a password they already have (their own dev store, or a client's
// staging site). Never used to guess/brute-force access. This authenticates
// viewing access only, it does not mutate any store data, so it's a
// different category from the "never click/submit/mutate" rule, which is
// about not creating carts/orders on a store's real data.
async function unlockStorefrontPassword(target, password) {
  const origin = new URL(target).origin;
  const passwordUrl = `${origin}/password`;
  await assertScannableUrl(passwordUrl);
  const body = new URLSearchParams({ form_type: 'storefront_password', password });
  const response = await fetch(passwordUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: body.toString(),
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  // Strip cookie attributes (Path/Expires/etc.), keep just the name=value pairs for reuse.
  return setCookie.split(/,(?=[^ ]+?=)/).map((c) => c.split(';')[0]).join('; ');
}

app.get('/api/scan', async (req, res) => {
  const { url, password } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  try {
    await assertScannableUrl(target);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    let unlockCookie = null;
    if (password) {
      try {
        unlockCookie = await unlockStorefrontPassword(target, password);
      } catch (err) {
        return res.status(400).json({ error: 'Could not reach the password page.', detail: err.message });
      }
    }
    // safeFetch re-validates every redirect hop, not just the original URL —
    // a same-origin-looking store that 302s to a private IP would otherwise
    // sail past the assertScannableUrl check above.
    const response = await safeFetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(unlockCookie ? { Cookie: unlockCookie } : {}),
      },
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
    // Shopify serves its password splash as a normal 200, so response.ok
    // alone can't tell "empty page, no tracking" apart from "never actually
    // reached the storefront." Detected via the final URL (fetch follows
    // redirects, response.url is the post-redirect landing page) or the
    // password form's own signature, so an empty result never gets
    // silently mistaken for "no tracking installed."
    const isPasswordPage = /\/password(\?|$)/.test(response.url) || /name=["']password["']/.test(html) && /storefront_password/.test(html);
    if (isPasswordPage) {
      return res.status(200).json({
        url: target,
        html,
        passwordProtected: true,
        error: unlockCookie
          ? 'The password did not unlock this store. Double-check it and try again.'
          : 'This store is password-protected. Enter the storefront password to scan it.',
      });
    }
    res.json({ url: target, html });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach store', detail: err.message });
  }
});

// ---- Deep scan: real headless-browser check (Tab 1 - No Access, no credentials needed) ----
app.get('/api/scan/deep', async (req, res) => {
  const { url, password } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  try {
    await assertScannableUrl(target);
    if (password) await assertScannableUrl(`${new URL(target).origin}/password`);
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
      // Broadened beyond the well-known tracking domains to also catch
      // custom-domain server-side (sGTM/Stape) proxies — a real gap: the
      // whole point of server-side tracking is often a first-party domain
      // that doesn't look like a tracking request at all (e.g.
      // "sgtm.storename.com"), so requiring one of the known-vendor
      // hostnames would silently miss it unless "collect?" also happened
      // to be in the path. Now also captures anything naming
      // stape/sgtm/server-side explicitly, or the Measurement Protocol
      // paths (/g/collect, /mp/collect) regardless of domain.
      if (/google-analytics\.com|analytics\.google\.com|googletagmanager\.com|facebook\.com\/tr|tiktok\.com\/i18n\/pixel|collect\?|stape\.io|sgtm|server-side|\/g\/collect|\/mp\/collect/i.test(u)) {
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

    if (password) {
      // Use the real storefront password form (rather than reconstructing
      // Shopify's cookie manually) so the browser's own cookie jar carries
      // the unlock through to the actual scan navigation below. Runs after
      // interception is armed so this navigation gets the same per-redirect
      // SSRF validation as the main scan.
      // Submits the form's own submit() method from inside the page, no
      // simulated pointer click — keeps this route's blanket ban on click
      // calls (tests/audit-safety.test.cjs) intact rather than carving an
      // exception into it, since that test exists precisely to catch any
      // future accidental cart/checkout click, not just this one.
      const passwordUrl = `${new URL(target).origin}/password`;
      await page.goto(passwordUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
        page.evaluate((pwd) => {
          const input = document.querySelector('input[name="password"]');
          const form = input ? input.closest('form') : document.querySelector('form[action*="password"], #login_form');
          if (input) input.value = pwd;
          if (form) form.submit();
        }, password),
      ]);
    }

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
    // Query-param-survival check — a safe proxy for "would this store lose a
    // real Google Ads gclid on the way in." Appends an obviously-synthetic
    // param (never a real ad-platform identifier, so nothing meaningful ever
    // reaches a third party) and checks whether it's still on the URL after
    // navigation/redirects settle. If a generic param gets dropped, a real
    // gclid almost certainly would too — same redirect/normalization
    // mechanism, just without ever firing a live signal at Google's own
    // conversion endpoint under someone else's ad account (see 2026-08-30
    // discussion: that direct approach was ruled out as a real safety-model
    // change, this is the safe alternative that gets the same evidence).
    const QS_TEST_PARAM = '_jsonalytics_qs_test';
    const QS_TEST_VALUE = 'v1';
    const targetWithTestParam = new URL(target);
    targetWithTestParam.searchParams.set(QS_TEST_PARAM, QS_TEST_VALUE);

    await page.goto(targetWithTestParam.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Same reasoning as /api/scan — Shopify's password splash is a normal
    // 200 page, so an empty result here needs to say WHY it's empty rather
    // than looking identical to "no tracking installed."
    let landedOnPasswordPage = false;
    try {
      landedOnPasswordPage = /\/password(\?|$)/.test(page.url());
    } catch { /* leave false */ }
    if (!landedOnPasswordPage) {
      landedOnPasswordPage = await page.evaluate(() => {
        try {
          return !!document.querySelector('input[name="password"]') && document.body.innerHTML.includes('storefront_password');
        } catch { return false; }
      }).catch(() => false);
    }
    if (landedOnPasswordPage) {
      await browser.close();
      return res.status(200).json({
        url: target,
        dataLayer: null,
        dataLayerPresent: false,
        consent: { found: false, raw: null },
        nativeBannerShouldShow: null,
        trackingRequestsSeen: [],
        eventEvidence: [],
        trackingSignals: { ga4Requests: 0, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] },
        observedIds: { ga4: [], gtm: [], meta: [], tiktok: [], ads: [] },
        queryParamPreservedThroughLoad: false,
        passwordProtected: true,
        error: password
          ? 'The password did not unlock this store. Double-check it and try again.'
          : 'This store is password-protected. Enter the storefront password to scan it.',
        note: 'Read-only page-load inspection. It does not click Add to Cart, submit forms, create carts, or validate purchase/CAPI/deduplication. Those require intentional test-checkout or imported evidence.',
      });
    }

    let queryParamPreservedThroughLoad = false;
    try {
      queryParamPreservedThroughLoad = new URL(page.url()).searchParams.get(QS_TEST_PARAM) === QS_TEST_VALUE;
    } catch { /* leave false — couldn't read the final URL, treat as unproven not as a pass */ }

    // Redacted immediately after capture, before it's used to derive
    // eventEvidence or sent anywhere — PII never leaves this scope raw.
    // See lib/piiRedaction.cjs for what's covered and why this exists.
    const dataLayerContents = redactPII(await page.evaluate(() => {
      try { return Array.isArray(window.dataLayer) ? window.dataLayer.slice(0, 25) : null; }
      catch { return null; }
    }));

    const consentSignals = redactPII(await page.evaluate(() => {
      try {
        // Google's real gtag.js does `dataLayer.push(arguments)` — arguments
        // is array-LIKE (numeric keys + length), not a true array, so
        // Array.isArray(e) was false for every real gtag consent call and
        // this never fired. Checking e[0] directly works for both a true
        // array and an arguments-shaped object, and plain dataLayer pushes
        // (e.g. {event: 'purchase', ...}) have no '0' key so they're
        // naturally excluded without needing the Array.isArray guard at all.
        const dl = Array.isArray(window.dataLayer) ? window.dataLayer : [];
        const consentEvent = dl.find(e => e && e[0] === 'consent');
        return { found: !!consentEvent, raw: consentEvent || null };
      } catch { return { found: false, raw: null }; }
    }));

    // Shopify's own Customer Privacy API — window.Shopify.customerPrivacy —
    // exposes shouldShowBanner(), a real, documented method, confirmed live
    // against shopify.dev, not guessed. Turns the old "check Admin manually"
    // hedge for the native-banner possibility into actual measured evidence.
    // Caveat kept deliberately: shouldShowBanner() reflects whether THIS
    // visitor's detected region is one Shopify's regional privacy rules are
    // configured to show a banner to — a false here can mean either "not
    // configured anywhere" or "correctly configured for other regions, just
    // not the one this scan's own server IP geolocates to." Same class of
    // scan-origin dependency as the GA4 network-timing flakiness elsewhere in
    // this file — real evidence, not a universal yes/no.
    const nativeBannerShouldShow = await page.evaluate(() => {
      try {
        if (window.Shopify?.customerPrivacy?.shouldShowBanner) {
          return window.Shopify.customerPrivacy.shouldShowBanner();
        }
        return null;
      } catch { return null; }
    }).catch(() => null);

    // Intentionally read-only: no clicks, form submissions, cart mutations, or checkout navigation.
    // Events below are only evidence observed during the initial page load.
    const eventEvidence = (dataLayerContents || []).flatMap((entry) => {
      const event = typeof entry?.event === 'string' ? entry.event : (Array.isArray(entry) && entry[0] === 'event' ? entry[1] : null);
      if (!event || typeof event !== 'string') return [];
      const ecommerce = entry?.ecommerce;
      return [{ event, ecommerceFields: ecommerce && typeof ecommerce === 'object' ? Object.keys(ecommerce) : [], evidence: 'observed-on-page-load' }];
    });
    // The actual signal for "server-side tracking" is a domain that ISN'T
    // one of the well-known vendor domains — that's the whole point of
    // server-side tracking, routing collection through a first-party/
    // custom domain to avoid ad-blockers and ITP. Matching on "/g/collect"
    // or "/collect?" alone (the previous behavior) caught legitimate
    // Google/DoubleClick requests that just happen to share that path
    // convention — confirmed live on drinkzyn.com and treatyjewellery.com,
    // where analytics.google.com/doubleclick.net/merchant-center-analytics
    // domains were being mislabeled as "server-side candidates" alongside
    // a genuinely custom one (treatyjewellery.com's own
    // "cantstopme.treatyjewellery.com" subdomain). Excluding the known
    // vendor domains leaves only the domains actually worth flagging.
    //
    // Bare "/collect?" was STILL too loose even after that fix — caught
    // live 2026-09-12 on wilsondorset.com: swymrelay.com (Swym, a wishlist/
    // back-in-stock app, nothing to do with tag management) has its own
    // internal API at /api/v2/provider/collect?pid=..., which isn't a
    // known tracking vendor so it sailed past the exclusion list above and
    // got mislabeled as server-side tag tracking. The real problem: "any
    // domain using the word collect in a path" is true of lots of unrelated
    // SaaS APIs, not just tracking infrastructure, no exclusion list can
    // keep up with every third-party app that happens to use that word.
    // Dropped the bare pattern entirely — "/g/collect" and "/mp/collect"
    // are specific enough (GA4's actual Measurement Protocol path
    // convention) to keep without the same collision risk.
    const KNOWN_TRACKING_VENDOR_HOSTS = /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|google\.com|googlesyndication\.com|merchant-center-analytics\.goog|facebook\.com|facebook\.net|tiktok\.com|pinimg\.com|sc-static\.net|snapchat\.com|bing\.com)$/i;
    const serverSideEndpointCandidates = [...new Set(capturedRequests
      .filter((u) => /stape\.io|sgtm|server-side|\/g\/collect|\/mp\/collect/i.test(u))
      .map((u) => new URL(u).origin)
      .filter((origin) => !KNOWN_TRACKING_VENDOR_HOSTS.test(new URL(origin).hostname)))];
    if (serverSideEndpointCandidates.length > 0) {
      console.log(`[${new Date().toISOString()}] [sGTM] server-side endpoint detected for ${target}: ${serverSideEndpointCandidates.join(', ')}`);
    }

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
    // Meta's base pixel always fires to facebook.com/tr?id=<PIXEL_ID> — the id
    // param IS the pixel ID (documented Meta behavior), not an internal token.
    const observedMetaIds = [...new Set(capturedRequests.flatMap((u) => {
      if (!/facebook\.com\/tr/i.test(u)) return [];
      try {
        const id = new URL(u).searchParams.get('id');
        return id && /^\d{6,}$/.test(id) ? [id] : [];
      } catch { return []; }
    }))];
    // TikTok's Shopify-channel pixel loader (analytics.tiktok.com/i18n/pixel/
    // shopify.js?sdkid=...) — confirmed via TikTok's own docs that sdkid IS the
    // Pixel ID, not a separate SDK/session token, before relying on it here.
    const observedTiktokIds = [...new Set(capturedRequests.flatMap((u) => {
      if (!/tiktok\.com\/i18n\/pixel/i.test(u)) return [];
      try {
        const sdkid = new URL(u).searchParams.get('sdkid');
        return sdkid ? [sdkid] : [];
      } catch { return []; }
    }))];
    // Same tid= param as GA4 above, but AW- prefixed — Google Ads conversion
    // IDs share the collect endpoint with GA4, filtered the other direction.
    const observedAdsIds = [...new Set(capturedRequests.flatMap((u) => {
      try {
        const tid = new URL(u).searchParams.get('tid');
        return tid && /^AW-/i.test(tid) ? [tid] : [];
      } catch { return []; }
    }))];

    await browser.close();

    res.json({
      url: target,
      dataLayer: dataLayerContents,
      dataLayerPresent: !!dataLayerContents,
      consent: consentSignals,
      nativeBannerShouldShow,
      trackingRequestsSeen: [...new Set(capturedRequests)],
      eventEvidence,
      trackingSignals: {
        // Bare "/collect?" dropped 2026-09-12 — same false-positive class as
        // the server-side detector below: any unrelated third-party app
        // (Swym's wishlist relay, confirmed live) with "collect" in its own
        // API path inflated this count, which feeds anyObservedRequest and
        // the GA4-confirmed check in diagnosticEngine.ts. "/g/collect" alone
        // is GA4's actual Measurement Protocol path, specific enough to keep.
        ga4Requests: capturedRequests.filter((u) => /google-analytics\.com|\/g\/collect/i.test(u)).length,
        gtmRequests: capturedRequests.filter((u) => /googletagmanager\.com\/gtm\.js/i.test(u)).length,
        metaBrowserRequests: capturedRequests.filter((u) => /facebook\.com\/tr/i.test(u)).length,
        tiktokBrowserRequests: capturedRequests.filter((u) => /tiktok\.com\/i18n\/pixel/i.test(u)).length,
        pinterestBrowserRequests: capturedRequests.filter((u) => /s\.pinimg\.com/i.test(u)).length,
        snapchatBrowserRequests: capturedRequests.filter((u) => /sc-static\.net|tr\.snapchat\.com/i.test(u)).length,
        microsoftUetBrowserRequests: capturedRequests.filter((u) => /bat\.bing\.com/i.test(u)).length,
        serverSideEndpointCandidates,
      },
      observedIds: { ga4: observedGa4Ids, gtm: observedGtmIds, meta: observedMetaIds, tiktok: observedTiktokIds, ads: observedAdsIds },
      queryParamPreservedThroughLoad,
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
async function getShopifyAccessToken() {
  // A static custom-app token, if supplied, wins — some setups still have
  // one. Otherwise use whatever the real OAuth flow below (/api/shopify/auth
  // -> /api/shopify/callback) obtained and persisted to tokens.json. There
  // is no client_credentials fallback here anymore — confirmed via live
  // testing this session that Shopify's Admin API rejects that grant type
  // outright (a Cloudflare challenge page, not a Shopify error), so a
  // fallback that can never succeed was worse than no fallback at all.
  if (SHOPIFY_ACCESS_TOKEN) {
    return SHOPIFY_ACCESS_TOKEN;
  }
  if (shopifyTokens?.access_token) {
    return shopifyTokens.access_token;
  }
  throw new Error('Shopify is not connected yet. Visit /api/shopify/auth first, or set SHOPIFY_ACCESS_TOKEN in .env if you have a static custom-app token.');
}

app.get('/api/shopify/orders', async (req, res) => {
  try {
    const token = await getShopifyAccessToken();

    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';
    const params = new URLSearchParams({ status: 'any', limit: '250' });
    if (startDate) params.set('created_at_min', `${startDate}T00:00:00Z`);
    if (endDate) params.set('created_at_max', `${endDate}T23:59:59Z`);
    let nextUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${shopifyApiVersion}/orders.json?${params}`;
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

app.get('/api/shopify/products/count', async (req, res) => {
  try {
    const token = await getShopifyAccessToken();
    // Count-only, not a catalog pull: three lightweight requests regardless
    // of catalog size (10 products or 100,000), so this is safe to run
    // automatically without a rate-limit or timeout concern. Summing
    // active+draft+archived explicitly rather than relying on the
    // no-status-param default, which is undocumented behavior.
    const statuses = ['active', 'draft', 'archived'];
    const counts = await Promise.all(statuses.map(async (status) => {
      const countRes = await fetchWithRateLimitRetry(
        `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${shopifyApiVersion}/products/count.json?status=${status}`,
        { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
      );
      if (!countRes.ok) throw new Error(`Shopify product count request failed (${countRes.status})`);
      const data = await countRes.json();
      return [status, data.count || 0];
    }));
    const byStatus = Object.fromEntries(counts);
    const total = byStatus.active + byStatus.draft + byStatus.archived;
    res.json({ total, active: byStatus.active, draft: byStatus.draft, archived: byStatus.archived });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch Shopify product count', detail: err.message });
  }
});

// ---- Shopify OAuth (Tab 2 - With Access) ----
// Standard Shopify authorization-code flow — the only grant type that
// actually works for this Admin API (see getShopifyAccessToken's comment).
// Mirrors the GA4/GTM OAuth pattern directly below: /auth redirects to the
// provider's approval screen, /callback exchanges the returned code for a
// token and persists it to tokens.json.
app.get('/api/shopify/auth', (req, res) => {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_REDIRECT_URI) {
    return res.status(500).send('Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_REDIRECT_URI in .env.');
  }
  shopifyOauthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: SHOPIFY_CLIENT_ID,
    // read_orders alone caps accessible order history at the last 60 days —
    // there's no self-service scope to lift that (Shopify requires a
    // Protected Customer Data review to get extended order history, not a
    // scope string an app can just request). Disclosed honestly in the
    // scope notes rather than silently claiming "any date range" works.
    scope: 'read_orders,read_products',
    redirect_uri: SHOPIFY_REDIRECT_URI,
    state: shopifyOauthState,
  });
  res.redirect(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/authorize?${params}`);
});

app.get('/api/shopify/callback', async (req, res) => {
  const { code, state, shop, hmac } = req.query;

  // CSRF guard: state must match what /auth generated for this session.
  if (!state || state !== shopifyOauthState) {
    return res.status(403).send('Shopify auth failed: state mismatch. Start over at /api/shopify/auth.');
  }
  shopifyOauthState = null; // one-time use

  // Confirm this callback is for the store this app is actually configured
  // for, not a forged request naming a different shop.
  if (shop && shop !== SHOPIFY_STORE_DOMAIN) {
    return res.status(403).send(`Shopify auth failed: callback was for ${shop}, not the configured ${SHOPIFY_STORE_DOMAIN}.`);
  }

  // HMAC guard: Shopify signs every callback with SHOPIFY_CLIENT_SECRET —
  // verifying it proves this request genuinely came from Shopify.
  if (hmac) {
    const message = Object.keys(req.query)
      .filter((key) => key !== 'hmac' && key !== 'signature')
      .sort()
      .map((key) => `${key}=${req.query[key]}`)
      .join('&');
    const computed = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(message).digest('hex');
    const computedBuf = Buffer.from(computed, 'utf8');
    const receivedBuf = Buffer.from(String(hmac), 'utf8');
    if (computedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(computedBuf, receivedBuf)) {
      return res.status(403).send('Shopify auth failed: HMAC verification failed.');
    }
  }

  try {
    const tokenRes = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text();
      return res.status(502).send(`Shopify token exchange failed (${tokenRes.status}): ${detail}`);
    }
    const tokenData = await tokenRes.json();
    shopifyTokens = { access_token: tokenData.access_token, scope: tokenData.scope };
    saveTokens({ ga4: ga4Tokens, gtm: gtmTokens, shopify: shopifyTokens });
    res.send('Shopify connected! You can close this tab.');
  } catch (err) {
    console.error('Shopify auth error:', err);
    res.status(500).send('Shopify auth failed');
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
    saveTokens({ ga4: ga4Tokens, gtm: gtmTokens, shopify: shopifyTokens });
    res.send('GA4 connected! You can close this tab.');
  } catch (err) {
    console.error('GA4 auth error:', err);
    res.status(500).send('GA4 auth failed');
  }
});

// Lists every GA4 property the connected Google account can see — not
// scoped to one store. Uses the Analytics Admin API, which the existing
// analytics.readonly scope already covers (no new consent screen needed).
// Only surfaces properties already shared with this account; it can't
// discover a property nobody's granted access to.
app.get('/api/ga4/properties', async (req, res) => {
  if (!ga4Tokens) return res.status(401).json({ error: 'GA4 not connected yet, visit /api/ga4/auth first' });
  try {
    oauth2Client.setCredentials(ga4Tokens);
    const response = await oauth2Client.request({
      url: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
      method: 'GET',
    });
    const properties = (response.data.accountSummaries || []).flatMap((account) =>
      (account.propertySummaries || []).map((prop) => ({
        propertyId: (prop.property || '').replace('properties/', ''),
        displayName: prop.displayName || prop.property,
        accountName: account.displayName || '',
      }))
    );
    res.json({ properties });
  } catch (err) {
    console.error('GA4 properties list error:', err.message);
    res.status(500).json({ error: 'Could not list GA4 properties', detail: err.message });
  }
});

app.get('/api/ga4/report', async (req, res) => {
  const { propertyId, startDate = '30daysAgo', endDate = 'today' } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'Missing propertyId param' });
  if (!ga4Tokens) return res.status(401).json({ error: 'GA4 not connected yet, visit /api/ga4/auth first' });

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
    saveTokens({ ga4: ga4Tokens, gtm: gtmTokens, shopify: shopifyTokens });
    res.send('GTM connected! You can close this tab.');
  } catch (err) {
    console.error('GTM auth error:', err);
    res.status(500).send('GTM auth failed');
  }
});

app.get('/api/gtm/containers', async (req, res) => {
  if (!gtmTokens) return res.status(401).json({ error: 'GTM not connected yet, visit /api/gtm/auth first' });

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
  // "configured" means real access exists (static token or completed OAuth)
  // — not just that client_id/secret are present, which proved misleading:
  // an app can have valid-looking credentials and still not be installed.
  res.json({ ga4: { connected: Boolean(ga4Tokens) }, gtm: { connected: Boolean(gtmTokens) }, shopify: { configured: Boolean(SHOPIFY_STORE_DOMAIN && (SHOPIFY_ACCESS_TOKEN || shopifyTokens?.access_token)) } });
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

// ---- Meta Ad Library search (lead sourcing) ----
// Requires META_AD_LIBRARY_TOKEN in .env — a user access token with
// ads_read scope, generated after completing Meta's identity verification
// for Ad Library API access (developers.facebook.com, not something this
// server can obtain on its own). No SSRF guard needed here — this only ever
// calls Meta's own fixed host with server-constructed params, it never
// takes an arbitrary operator-supplied URL the way /api/scan does.
app.get('/api/adlibrary/search', async (req, res) => {
  const { searchTerms, countries = 'US,CA,AU,NZ,GB' } = req.query;
  if (!searchTerms) return res.status(400).json({ error: 'Missing searchTerms param' });
  if (!process.env.META_AD_LIBRARY_TOKEN) {
    return res.status(401).json({ error: 'Meta Ad Library not configured, set META_AD_LIBRARY_TOKEN in .env (see README for the identity-verification setup steps)' });
  }

  const countryList = String(countries).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  // ad_creative_link_captions/titles carry the advertiser's actual
  // destination domain text far more often than page_name does — page_name
  // is the Facebook Page's display name, not the store URL.
  const fields = [
    'page_name',
    'page_id',
    'ad_snapshot_url',
    'ad_creative_link_captions',
    'ad_creative_link_titles',
    'ad_creative_link_descriptions',
    'ad_delivery_start_time',
  ].join(',');

  const url = new URL('https://graph.facebook.com/v19.0/ads_archive');
  url.searchParams.set('search_terms', String(searchTerms));
  url.searchParams.set('ad_type', 'ALL');
  url.searchParams.set('ad_active_status', 'ACTIVE');
  url.searchParams.set('ad_reached_countries', JSON.stringify(countryList));
  url.searchParams.set('fields', fields);
  url.searchParams.set('limit', '5');
  url.searchParams.set('access_token', process.env.META_AD_LIBRARY_TOKEN);

  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Meta Ad Library request failed', detail: data.error || data });
    }
    res.json(data);
  } catch (err) {
    console.error('Ad Library search error:', err.message);
    res.status(500).json({ error: 'Ad Library search failed', detail: err.message });
  }
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
    status: status || 'not_contacted',
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
  // as-is rather than deep-validated field by field. Before overwriting,
  // shift the outgoing lastScan into previousScan — one level of history,
  // enough to catch tracking that broke between two scans of the same store
  // (theme update, app uninstall, etc.) without building a full audit trail.
  // Skipped on a lead's first-ever scan (lead.lastScan is still null then),
  // so previousScan never gets set to a meaningless null.
  if (lastScan !== undefined) {
    if (lead.lastScan) lead.previousScan = lead.lastScan;
    lead.lastScan = lastScan;
  }
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
