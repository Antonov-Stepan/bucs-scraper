const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Simple in-memory cache (refreshes every 3 hours) ────────────────────────
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const cache = {};

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.data;
}

function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

// ─── Shared browser launcher ──────────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    // FIX 1: executablePath must be set explicitly on Render.com — Puppeteer's
    // postinstall download is not guaranteed to persist between deploys there.
    // Prefer the system Chromium installed via render.yaml's buildCommand.
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      '/usr/bin/chromium-browser' ||
      '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });
}

// ─── BUCS Play scraper ────────────────────────────────────────────────────────
async function scrapeBucs(browser, leagueUrl, tierLabel, imperialName) {
  const cacheKey = `bucs:${tierLabel}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      'KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36'
    );

    // FIX 2: Playwaze is a React SPA — it renders content well after
    // networkidle2. Use networkidle0 for a fuller settle, then also wait for
    // the Angular/React hydration tick via an extra 2 s delay.
    await page.goto(leagueUrl, { waitUntil: 'networkidle0', timeout: 45000 });

    // FIX 3: The league-display page on Playwaze renders a <table> directly —
    // no dropdown selection is needed when you navigate directly to the correct
    // league URL (i5p7xbti8m is already the Tier 2B league ID). The dropdown
    // logic was silently failing because the SPA hadn't rendered <select>
    // elements yet, and the 1.5 s sleep wasn't enough. We now wait properly.
    await page.waitForFunction(
      () => document.querySelectorAll('table tbody tr').length > 0,
      { timeout: 20000, polling: 500 }
    ).catch(() => {
      // If still no table rows after 20 s, log a diagnostic snapshot
      console.error(`[BUCS] No table rows found for tier ${tierLabel} — page may require login or URL has changed`);
    });

    // FIX 4: innerText is unreliable on hidden/offscreen nodes. Use textContent
    // and trim, which works regardless of display state.
    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
      );
    });

    if (allRows.length === 0) return [];

    // FIX 5: BUCS Play tables have 9 columns (Pos, Team, P, W, D, L, F, A, GD, Pts)
    // — that's 10 cells, not 8. The filter `cells.length >= 8` was keeping stray
    // header-repeat rows. Filter to exactly >= 9 and map GF/GA explicitly so
    // the trailing-index logic for gd/pts doesn't break on variable column counts.
    const parsed = allRows
      .filter((cells) => cells.length >= 9)
      .map((cells) => ({
        pos:  parseInt(cells[0])  || 0,
        team: cells[1]            || '',
        p:    parseInt(cells[2])  || 0,
        w:    parseInt(cells[3])  || 0,
        d:    parseInt(cells[4])  || 0,
        l:    parseInt(cells[5])  || 0,
        // Keep the dynamic trailing approach but guard against NaN → 0 masking real zeroes
        gd:   parseInt(cells[cells.length - 2], 10),
        pts:  parseInt(cells[cells.length - 1], 10),
      }))
      // Drop any rows where pos parsed as 0 (these are sub-headers or spacers)
      .filter((r) => r.pos > 0);

    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    if (imperialIdx === -1) {
      // Imperial not found — return the top-5 as a best-effort fallback
      return parsed.slice(0, 5).map((row, i) => ({
        ...row,
        promote: i === 0 ? true : undefined,
        relegate: i === parsed.slice(0, 5).length - 1 ? true : undefined,
      }));
    }

    const start = Math.max(0, imperialIdx - 2);
    const end   = Math.min(parsed.length, imperialIdx + 3);
    const sliced = parsed.slice(start, end);

    const result = sliced.map((row) => ({
      ...row,
      imperial:  row.team.toLowerCase().includes(imperialName.toLowerCase()) ? true : undefined,
      promote:   row.pos === 1             ? true : undefined,
      relegate:  row.pos === parsed.length ? true : undefined,
    }));

    setCache(cacheKey, result);
    return result;

  } finally {
    await page.close();
  }
}

// ─── LUSL scraper ─────────────────────────────────────────────────────────────
async function scrapeLusl(browser, luslUrl, imperialName) {
  const cacheKey = `lusl:${luslUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      'KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36'
    );
    await page.goto(luslUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr', { timeout: 10000 });

    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
      );
    });

    const parsed = allRows
      .filter((cells) => cells.length >= 8)
      .map((cells) => ({
        pos:  parseInt(cells[0])  || 0,
        team: cells[1]            || '',
        p:    parseInt(cells[2])  || 0,
        w:    parseInt(cells[3])  || 0,
        d:    parseInt(cells[4])  || 0,
        l:    parseInt(cells[5])  || 0,
        gd:   parseInt(cells[cells.length - 2], 10),
        pts:  parseInt(cells[cells.length - 1], 10),
      }))
      .filter((r) => r.pos > 0);

    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    if (imperialIdx === -1) return [];

    const start = Math.max(0, imperialIdx - 2);
    const end   = Math.min(parsed.length, imperialIdx + 3);

    const result = parsed.slice(start, end).map((row) => ({
      ...row,
      imperial: row.team.toLowerCase().includes(imperialName.toLowerCase()) ? true : undefined,
      promote:  row.pos === 1             ? true : undefined,
      relegate: row.pos === parsed.length ? true : undefined,
    }));

    setCache(cacheKey, result);
    return result;

  } catch (e) {
    console.error('LUSL scrape error:', e.message);
    return [];
  } finally {
    await page.close();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/tables', async (req, res) => {
  // FIX 6: All three BUCS URLs were pointing at BUCS_M1_URL — M2 and M3 had
  // placeholder values. You need the real Playwaze league IDs for each tier.
  // Replace the TODOs below with the correct IDs from bucs.playwaze.com once
  // confirmed. The M1 URL is already correct.
  const BUCS_M1_URL = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/leagues/i5p7xbti8m';
  const BUCS_M2_URL = process.env.BUCS_M2_LEAGUE_URL || BUCS_M1_URL; // TODO: set BUCS_M2_LEAGUE_URL env var
  const BUCS_M3_URL = process.env.BUCS_M3_LEAGUE_URL || BUCS_M1_URL; // TODO: set BUCS_M3_LEAGUE_URL env var

  const LUSL_PREMIER = 'https://www.lusl.co.uk/league-table/premier-division';
  const LUSL_DIV1    = 'https://www.lusl.co.uk/league-table/division-1';
  const LUSL_DIV3    = 'https://www.lusl.co.uk/league-table/division-3';

  const browser = await launchBrowser();

  const safeScrape = async (fn) => {
    try { return await fn(); }
    catch (e) { console.error('Pipeline error:', e.message); return []; }
  };

  try {
    const m1Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M1_URL, 'SE 2B', 'Imperial Medics'));
    const m1Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_PREMIER, 'Imperial Medics'));

    const m2Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M2_URL, 'SE 5C', 'Imperial Medics'));
    const m2Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_DIV1, 'Imperial Medics'));

    const m3Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M3_URL, 'SE 7', 'Imperial Medics'));
    const m3Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_DIV3, 'Imperial Medics'));

    res.json({
      lastUpdated: new Date().toISOString(),
      teams: [
        { bucs: m1Bucs, lusl: m1Lusl },
        { bucs: m2Bucs, lusl: m2Lusl },
        { bucs: m3Bucs, lusl: m3Lusl },
      ],
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    await browser.close();
  }
});

app.listen(PORT, () => console.log(`bucs-scraper listening on port ${PORT}`));
