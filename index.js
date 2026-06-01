const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS headers globally so your React Native app can safely ingest the data
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote'
    ],
  });
}

// ─── BUCS Play scraper (Accepts active browser instance) ─────────────────────
async function scrapeBucs(browser, leagueUrl, tierLabel, imperialName) {
  const cacheKey = `bucs:${tierLabel}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Open a single temporary tab inside the shared browser instance
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.goto(leagueUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
      await page.waitForSelector('table tbody tr', { timeout: 6000 });
    } catch (e) {
      await page.waitForSelector('select, [role="listbox"], .league-select', { timeout: 4000 }).catch(() => {});
    }

    try {
      await page.evaluate((label) => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const sel of selects) {
          const opts = Array.from(sel.options);
          const match = opts.find(
            (o) => o.text.trim().toLowerCase().includes(label.toLowerCase())
          );
          if (match && sel.value !== match.value) {
            sel.value = match.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, tierLabel);
      await new Promise((r) => setTimeout(r, 1500));
    } catch (dropdownErr) {
      console.log(`Dropdown option selection bypassed for ${tierLabel}`);
    }

    await page.waitForSelector('table tbody tr', { timeout: 6000 });

    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map((tr) => {
        return Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim());
      });
    });

    if (allRows.length === 0) return [];

    const parsed = allRows
      .filter((cells) => cells.length >= 8)
      .map((cells) => ({
        pos: parseInt(cells[0]) || 0,
        team: cells[1] || '',
        p: parseInt(cells[2]) || 0,
        w: parseInt(cells[3]) || 0,
        d: parseInt(cells[4]) || 0,
        l: parseInt(cells[5]) || 0,
        gd: parseInt(cells[cells.length - 2]) || 0,  // Dynamic trailing column parsing
        pts: parseInt(cells[cells.length - 1]) || 0, // Dynamic trailing column parsing
      }));

    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    if (imperialIdx === -1) {
      return parsed.slice(0, 5).map((row, i) => ({ ...row, promote: i === 0, relegate: i === 4 }));
    }

    const start = Math.max(0, imperialIdx - 2);
    const end = Math.min(parsed.length, imperialIdx + 3);
    const sliced = parsed.slice(start, end);

    const result = sliced.map((row) => {
      const isFirst = row.pos === 1;
      const isLast = row.pos === parsed.length;
      return {
        ...row,
        imperial: row.team.toLowerCase().includes(imperialName.toLowerCase()) ? true : undefined,
        promote: isFirst ? true : undefined,
        relegate: isLast ? true : undefined,
      };
    });

    setCache(cacheKey, result);
    return result;
  } finally {
    await page.close(); // Dispose of the tab immediately to free RAM
  }
}

// ─── LUSL scraper (Accepts active browser instance) ──────────────────────────
async function scrapeLusl(browser, luslUrl, imperialName) {
  const cacheKey = `lusl:${luslUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.goto(luslUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr', { timeout: 10000 });

    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map((tr) => {
        return Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim());
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
        gd: parseInt(cells[cells.length - 2]) || 0,
        pts: parseInt(cells[cells.length - 1]) || 0,
      }));

    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    if (imperialIdx === -1) return [];

    const start = Math.max(0, imperialIdx - 2);
    const end = Math.min(parsed.length, imperialIdx + 3);
    const sliced = parsed.slice(start, end);

    const result = sliced.map((row) => ({
      ...row,
      imperial: row.team.toLowerCase().includes(imperialName.toLowerCase()) ? true : undefined,
      promote: row.pos === 1 ? true : undefined,
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

// GET /tables
app.get('/tables', async (req, res) => {
  const BUCS_M1_URL = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/leagues/i5p7xbti8m';
  const BUCS_M2_URL = BUCS_M1_URL; 
  const BUCS_M3_URL = BUCS_M1_URL;

  const LUSL_PREMIER  = 'https://www.lusl.co.uk/league-table/premier-division';
  const LUSL_DIV1     = 'https://www.lusl.co.uk/league-table/division-1';
  const LUSL_DIV3     = 'https://www.lusl.co.uk/league-table/division-3';

  // Instantiate exactly ONE single browser context for the request lifecycle
  const browser = await launchBrowser();

  const safeScrape = async (scrapperFn) => {
    try { return await scrapperFn(); }
    catch (e) { console.error('Isolated target pipeline error:', e.message); return []; }
  };

  try {
    // Run sequentially down the line to keep the engine resource consumption near zero
    const m1Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M1_URL, 'SE 2B', 'Imperial Medics 1'));
    const m1Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_PREMIER, 'Imperial Medics 1'));
    
    const m2Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M2_URL, 'SE 5C', 'Imperial Medics 2'));
    const m2Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_DIV1, 'Imperial Medics 2'));
    
    const m3Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M3_URL, 'SE 7',  'Imperial Medics 3'));
    const m3Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_DIV3, 'Imperial Medics 3'));

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
    // Safely tear down the core browser instance
    await browser.close();
  }
});

app.listen(PORT, () => console.log(`bucs-scraper listening on port ${PORT}`));