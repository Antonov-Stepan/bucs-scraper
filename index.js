const express = require('express');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Resolve Chrome executable ────────────────────────────────────────────────
function findChrome() {
  // 1. Explicit override via env var (set this in Render dashboard if needed)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  // 2. Puppeteer's own downloaded Chrome (installed by `npx puppeteer browsers install chrome`)
  try {
    const { executablePath } = require('puppeteer');
    const p = executablePath();
    require('fs').accessSync(p);
    console.log(`Using Puppeteer bundled Chrome: ${p}`);
    return p;
  } catch (_) {}
  // 3. Common system paths as last resort
  for (const p of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    try { require('fs').accessSync(p); console.log(`Using system Chrome: ${p}`); return p; }
    catch (_) {}
  }
  // 4. Ask the shell
  try { return execSync('which chromium || which google-chrome || which chromium-browser').toString().trim(); }
  catch (_) {}
  return null; // Let Puppeteer try its default as final fallback
}

const CHROME_PATH = findChrome();

// ─── Simple in-memory cache (refreshes every 3 hours) ────────────────────────
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const cache = {};
function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.data;
}
function setCache(key, data) { cache[key] = { data, timestamp: Date.now() }; }

// ─── Shared browser launcher ──────────────────────────────────────────────────
async function launchBrowser() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  };
  if (CHROME_PATH) opts.executablePath = CHROME_PATH;
  return puppeteer.launch(opts);
}

// ─── BUCS Play scraper ────────────────────────────────────────────────────────
async function scrapeBucs(browser, leagueUrl, tierLabel, imperialName) {
  const cacheKey = `bucs:${tierLabel}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // tierLabel is the division suffix shown in the dropdown, e.g. "2B", "5C", "7"
  // Strip any leading "SE " prefix so we match the raw dropdown text like "2B"
  const divisionToken = tierLabel.replace(/^SE\s*/i, '').trim();

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      'KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36'
    );
    await page.goto(leagueUrl, { waitUntil: 'networkidle0', timeout: 45000 });

    // Wait for the table-view tab and initial table to appear
    await page.waitForFunction(
      () => document.querySelectorAll('table tbody tr').length > 0,
      { timeout: 20000, polling: 500 }
    );

    // ── Check whether we're already on the right division ──────────────────
    // The active division is shown in:  div.custom-dropDown[data-filter="devision"] div.selection
    // Note: Playwaze has a typo — "devision" not "division"
    const currentDivision = await page.$eval(
      '[data-filter="devision"] .selection',
      (el) => el.textContent.trim()
    ).catch(() => null);

    console.log(`[BUCS] Current division on page: "${currentDivision}", need: "${divisionToken}"`);

    if (currentDivision && currentDivision !== divisionToken) {
      // 1. Click the dropdown to open the <ul class="dropdownList">
      await page.click('[data-filter="devision"] .selection');
      await page.waitForSelector('[data-filter="devision"] .dropdownList li', { timeout: 5000 });

      // 2. Log all dropdown options so we know exactly what text they contain
      const dropdownOptions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-filter="devision"] .dropdownList li'))
          .map((li) => li.textContent.trim())
      );
      console.log(`[BUCS] Dropdown options:`, JSON.stringify(dropdownOptions));

      // 3. Find and click the <li> whose text *contains* our division token
      //    (the full text may be e.g. "Men's SE Tier 2B" — exact match would miss it)
      const clicked = await page.evaluate((token) => {
        const items = Array.from(
          document.querySelectorAll('[data-filter="devision"] .dropdownList li')
        );
        const target = items.find(
          (li) => li.textContent.trim().toLowerCase().includes(token.toLowerCase())
        );
        if (target) { target.click(); return target.textContent.trim(); }
        return null;
      }, divisionToken);

      if (!clicked) {
        console.error(`[BUCS] Could not find division "${divisionToken}" in dropdown options: ${JSON.stringify(dropdownOptions)}`);
      } else {
        console.log(`[BUCS] Clicked dropdown item: "${clicked}"`);
      }

      // 3. Wait for the table to re-render with new data.
      //    We wait for the current first-row team text to change, which confirms
      //    the table has actually swapped — a plain delay is unreliable.
      const prevFirstTeam = await page.$eval(
        'table tbody tr:first-child td:nth-child(2)',
        (el) => el.textContent.trim()
      ).catch(() => '');

      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector('table tbody tr:first-child td:nth-child(2)');
          return el && el.textContent.trim() !== prev;
        },
        { timeout: 10000, polling: 300 },
        prevFirstTeam
      ).catch(() => {
        console.warn('[BUCS] Table may not have refreshed after dropdown change');
      });
    }

    // ── Scrape the now-visible table ────────────────────────────────────────
    // The active tab is div.table-view.tab-view.active — scrape only from that
    const allRows = await page.evaluate(() => {
      const container = document.querySelector('.table-view.active') || document.body;
      return Array.from(container.querySelectorAll('table tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
      );
    });

    if (allRows.length === 0) return [];

    const parsed = allRows
      .filter((cells) => cells.length >= 9)
      .map((cells) => ({
        pos:  parseInt(cells[0], 10) || 0,
        team: cells[1] || '',
        p:    parseInt(cells[2], 10) || 0,
        w:    parseInt(cells[3], 10) || 0,
        d:    parseInt(cells[4], 10) || 0,
        l:    parseInt(cells[5], 10) || 0,
        gd:   parseInt(cells[cells.length - 2], 10) || 0,
        pts:  parseInt(cells[cells.length - 1], 10) || 0,
      }))
      .filter((r) => r.pos > 0);

    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    if (imperialIdx === -1) {
      return parsed.slice(0, 5).map((row, i) => ({
        ...row,
        promote:  i === 0 ? true : undefined,
        relegate: i === 4 ? true : undefined,
      }));
    }

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

    const allRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
      )
    );

    const parsed = allRows
      .filter((cells) => cells.length >= 8)
      .map((cells) => ({
        pos:  parseInt(cells[0], 10) || 0,
        team: cells[1] || '',
        p:    parseInt(cells[2], 10) || 0,
        w:    parseInt(cells[3], 10) || 0,
        d:    parseInt(cells[4], 10) || 0,
        l:    parseInt(cells[5], 10) || 0,
        gd:   parseInt(cells[cells.length - 2], 10) || 0,
        pts:  parseInt(cells[cells.length - 1], 10) || 0,
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
  const BUCS_M1_URL = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/leagues/i5p7xbti8m';
  const BUCS_M2_URL = process.env.BUCS_M2_LEAGUE_URL || BUCS_M1_URL;
  const BUCS_M3_URL = process.env.BUCS_M3_LEAGUE_URL || BUCS_M1_URL;

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

app.listen(PORT, () => {
  console.log(`bucs-scraper listening on port ${PORT}`);
  console.log(`Chrome path resolved to: ${CHROME_PATH || '(puppeteer default)'}`);
});
