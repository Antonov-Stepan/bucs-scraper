const express = require('express');
const puppeteer = require('puppeteer');

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
  const options = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return puppeteer.launch(options);
}

// ─── BUCS Play scraper ────────────────────────────────────────────────────────
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

    // Wait for either the table or a dropdown container to load dynamically
    try {
      await page.waitForSelector('table tbody tr', { timeout: 8000 });
    } catch (e) {
      await page.waitForSelector('select, [role="listbox"], .league-select', { timeout: 5000 }).catch(() => {});
    }

    // Try to click/select the right tier if a dropdown is present, but do not crash if missing
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
      await new Promise((r) => setTimeout(r, 2000)); // Settle time for re-render
    } catch (dropdownErr) {
      console.log(`Dropdown interaction skipped for ${tierLabel}:`, dropdownErr.message);
    }

    // Direct confirmation check for table rows
    await page.waitForSelector('table tbody tr', { timeout: 10000 });

    // Extract all row text contents
    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map((tr) => {
        return Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim());
      });
    });

    if (allRows.length === 0) throw new Error('No table rows found matching schema');

    // Parse rows with dynamic index matching based on trailing elements
    const parsed = allRows
      .filter((cells) => cells.length >= 8)
      .map((cells) => ({
        pos: parseInt(cells[0]) || 0,
        team: cells[1] || '',
        p: parseInt(cells[2]) || 0,
        w: parseInt(cells[3]) || 0,
        d: parseInt(cells[4]) || 0,
        l: parseInt(cells[5]) || 0,
        gd: parseInt(cells[cells.length - 2]) || 0,  // Always second-to-last column
        pts: parseInt(cells[cells.length - 1]) || 0, // Always final column
      }));

    // Locate the target team row position
    const imperialIdx = parsed.findIndex((r) =>
      r.team.toLowerCase().includes(imperialName.toLowerCase())
    );

    if (imperialIdx === -1) {
      // If team isn't found in this specific tier slice, return whole parsed table instead of failing
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
    await browser.close();
  }
}

// ─── LUSL scraper ─────────────────────────────────────────────────────────────
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
    await browser.close();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    await browser.close();
    res.json({ ok: true, title, chromiumPath: 'Auto-bundled Chrome' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/debug-bucs', async (req, res) => {
  const url = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/leagues/i5p7xbti8m';
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const info = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select')).map(sel => ({
        id: sel.id,
        options: Array.from(sel.options).map(o => o.text.trim())
      }));
      const tables = Array.from(document.querySelectorAll('table')).map(t => ({
        headers: Array.from(t.querySelectorAll('th')).map(th => th.innerText.trim()),
        rows: t.querySelectorAll('tbody tr').length,
      }));
      return { selects, tables, bodySnippet: document.body.innerText.slice(0, 1000) };
    });

    await browser.close();
    res.json({ ok: true, url, ...info });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /tables
app.get('/tables', async (req, res) => {
  // Base token URL for M1
  const BUCS_M1_URL = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/leagues/i5p7xbti8m';
  
  // Tip: If M2 and M3 fail to find rows, swap these strings out with their specific direct Playwaze URL tokens
  const BUCS_M2_URL = BUCS_M1_URL; 
  const BUCS_M3_URL = BUCS_M1_URL;

  const LUSL_PREMIER  = 'https://www.lusl.co.uk/league-table/premier-division';
  const LUSL_DIV1     = 'https://www.lusl.co.uk/league-table/division-1';
  const LUSL_DIV3     = 'https://www.lusl.co.uk/league-table/division-3';

  const safe = async (fn) => {
    try { return await fn(); }
    catch (e) { console.error('Scrape error:', e.message); return []; }
  };

  const [
    m1Bucs, m1Lusl,
    m2Bucs, m2Lusl,
    m3Bucs, m3Lusl,
  ] = await Promise.all([
    safe(() => scrapeBucs(BUCS_M1_URL, 'SE 2B', 'Imperial Medics 1')),
    safe(() => scrapeLusl(LUSL_PREMIER, 'Imperial Medics 1')),
    safe(() => scrapeBucs(BUCS_M2_URL, 'SE 5C', 'Imperial Medics 2')),
    safe(() => scrapeLusl(LUSL_DIV1, 'Imperial Medics 2')),
    safe(() => scrapeBucs(BUCS_M3_URL, 'SE 7',  'Imperial Medics 3')),
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
