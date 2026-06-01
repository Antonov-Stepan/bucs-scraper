const express = require('express');
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

// Find Chromium wherever it lives on this machine
function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/local/bin/chromium',
  ];
  for (const p of candidates) {
    try {
      execSync(`test -f ${p}`);
      return p;
    } catch {}
  }
  // Last resort — ask the OS
  try { return execSync('which chromium-browser').toString().trim(); } catch {}
  try { return execSync('which chromium').toString().trim(); } catch {}
  try { return execSync('which google-chrome').toString().trim(); } catch {}
  return null;
}

const CHROMIUM_PATH = findChromium();
console.log('Chromium path:', CHROMIUM_PATH);

const app = express();
const PORT = process.env.PORT || 3000;

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
  if (!CHROMIUM_PATH) throw new Error('No Chromium executable found on this system');
  return puppeteer.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });
}

// ─── BUCS Play scraper ────────────────────────────────────────────────────────
// BUCS Play renders tables via JavaScript after a tier dropdown selection.
// We open the page, wait for the dropdown, select the right tier, then
// extract the table rows.
//
// leagueUrl  — base BUCS Play competition URL
// tierLabel  — exact text of the dropdown option, e.g. "SE 2B"
// imperialName — substring to match Imperial's row (e.g. "Imperial")
async function scrapeBucs(leagueUrl, tierLabel, imperialName) {
  const cacheKey = `bucs:${tierLabel}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.goto(leagueUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for the tier dropdown to appear
    await page.waitForSelector('select, [role="listbox"], .league-select', {
      timeout: 15000,
    });

    // Try to find and select the correct tier from any dropdown on the page
    const selected = await page.evaluate((label) => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const opts = Array.from(sel.options);
        const match = opts.find(
          (o) => o.text.trim().toLowerCase().includes(label.toLowerCase())
        );
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return match.text;
        }
      }
      return null;
    }, tierLabel);

    if (!selected) {
      throw new Error(`Could not find tier "${tierLabel}" in any dropdown`);
    }

    // Wait for table to re-render after selection
    await page.waitForSelector('table tbody tr', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1500)); // extra settle time

    // Extract all rows from the league table
    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) =>
          td.innerText.trim()
        );
        return cells;
      });
    });

    if (allRows.length === 0) throw new Error('No table rows found after tier selection');

    // Parse rows into structured objects
    const parsed = allRows
      .filter((cells) => cells.length >= 8)
      .map((cells) => ({
        pos: parseInt(cells[0]) || 0,
        team: cells[1] || '',
        p: parseInt(cells[2]) || 0,
        w: parseInt(cells[3]) || 0,
        d: parseInt(cells[4]) || 0,
        l: parseInt(cells[5]) || 0,
        gd: parseInt(cells[6]) || 0,
        pts: parseInt(cells[7]) || 0,
      }));

    // Find Imperial's position
    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    // Slice 2 above + Imperial + 2 below (clamped to array bounds)
    const start = Math.max(0, imperialIdx - 2);
    const end = Math.min(parsed.length, imperialIdx + 3);
    const sliced = parsed.slice(start, end);

    // Tag rows
    const result = sliced.map((row, i) => {
      const isFirst = row.pos === 1;
      const isLast = row.pos === parsed.length;
      return {
        ...row,
        imperial: row.team.toLowerCase().includes(imperialName.toLowerCase())
          ? true
          : undefined,
        promote: isFirst ? true : undefined,
        relegate: isLast ? true : undefined,
      };
    });

    setCache(cacheKey, result);
    return result;
  } finally {
    await browser.close();
  }
}

// ─── LUSL scraper ─────────────────────────────────────────────────────────────
// LUSL uses a simpler static or server-rendered table page.
//
// luslUrl      — direct URL to the division table page
// imperialName — substring to match Imperial's row
async function scrapeLusl(luslUrl, imperialName) {
  const cacheKey = `lusl:${luslUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.goto(luslUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr', { timeout: 15000 });

    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) =>
          td.innerText.trim()
        );
        return cells;
      });
    });

    const parsed = allRows
      .filter((cells) => cells.length >= 8)
      .map((cells) => ({
        pos: parseInt(cells[0]) || 0,
        team: cells[1] || '',
        p: parseInt(cells[2]) || 0,
        w: parseInt(cells[3]) || 0,
        d: parseInt(cells[4]) || 0,
        l: parseInt(cells[5]) || 0,
        gd: parseInt(cells[6]) || 0,
        pts: parseInt(cells[7]) || 0,
      }));

    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    const start = Math.max(0, imperialIdx - 2);
    const end = Math.min(parsed.length, imperialIdx + 3);
    const sliced = parsed.slice(start, end);

    const result = sliced.map((row) => ({
      ...row,
      imperial: row.team.toLowerCase().includes(imperialName.toLowerCase())
        ? true
        : undefined,
      promote: row.pos === 1 ? true : undefined,
      relegate: row.pos === parsed.length ? true : undefined,
    }));

    setCache(cacheKey, result);
    return result;
  } finally {
    await browser.close();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

// Debug route — tests whether Chromium can launch at all
app.get('/debug', async (req, res) => {
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    await browser.close();
    res.json({ ok: true, title, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
  }
});

// Returns all three teams' tables in one request so the app makes one fetch
// GET /tables
app.get('/tables', async (req, res) => {
  const BUCS_BASE =
    'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/leagues';

  // ── Update these URLs once you confirm the LUSL division page URLs ──────────
  const LUSL_PREMIER  = 'https://www.lusl.co.uk/league-table/premier-division';
  const LUSL_DIV1     = 'https://www.lusl.co.uk/league-table/division-1';
  const LUSL_DIV3     = 'https://www.lusl.co.uk/league-table/division-3';
  // ───────────────────────────────────────────────────────────────────────────

  // ── Update BUCS_BASE to the correct competition page URL if needed ──────────
  const BUCS_URL = `${BUCS_BASE}`;
  // ───────────────────────────────────────────────────────────────────────────

  const safe = async (fn) => {
    try { return await fn(); }
    catch (e) { console.error('Scrape error:', e.message); return []; }
  };

  const [
    m1Bucs, m1Lusl,
    m2Bucs, m2Lusl,
    m3Bucs, m3Lusl,
  ] = await Promise.all([
    safe(() => scrapeBucs(BUCS_URL, 'SE 2B', 'Imperial Medics 1')),
    safe(() => scrapeLusl(LUSL_PREMIER, 'Imperial Medics 1')),
    safe(() => scrapeBucs(BUCS_URL, 'SE 5C', 'Imperial Medics 2')),
    safe(() => scrapeLusl(LUSL_DIV1, 'Imperial Medics 2')),
    safe(() => scrapeBucs(BUCS_URL, 'SE 7',  'Imperial Medics 3')),
    safe(() => scrapeLusl(LUSL_DIV3, 'Imperial Medics 3')),
  ]);

  res.json({
    lastUpdated: new Date().toISOString(),
    teams: [
      { bucs: m1Bucs, lusl: m1Lusl },
      { bucs: m2Bucs, lusl: m2Lusl },
      { bucs: m3Bucs, lusl: m3Lusl },
    ],
  });
});

app.listen(PORT, () => console.log(`bucs-scraper listening on port ${PORT}`));
