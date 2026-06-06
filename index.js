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

    // Open the dropdown to read available options (also needed to click one)
    const dropdownOptions = await (async () => {
      try {
        await page.click('[data-filter="devision"] .selection');
        await page.waitForSelector('[data-filter="devision"] .dropdownList li', { timeout: 3000 });
        const opts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-filter="devision"] .dropdownList li'))
            .map((li) => li.textContent.trim())
        );
        // Close the dropdown without selecting anything (click elsewhere)
        await page.keyboard.press('Escape');
        return opts;
      } catch {
        return []; // No dropdown on this page — single-division league
      }
    })();

    const needsSwitch = currentDivision !== divisionToken;
    const canSwitch   = dropdownOptions.some(o => o.toLowerCase().includes(divisionToken.toLowerCase()));

    if (needsSwitch && canSwitch) {
      // Re-open and click the correct option
      await page.click('[data-filter="devision"] .selection');
      await page.waitForSelector('[data-filter="devision"] .dropdownList li', { timeout: 5000 });

      const clicked = await page.evaluate((token) => {
        const target = Array.from(
          document.querySelectorAll('[data-filter="devision"] .dropdownList li')
        ).find(li => li.textContent.trim().toLowerCase().includes(token.toLowerCase()));
        if (target) { target.click(); return target.textContent.trim(); }
        return null;
      }, divisionToken);

      console.log(`[BUCS] Switched division to: "${clicked}"`);

      await page.waitForFunction(
        (token) => {
          const sel = document.querySelector('[data-filter="devision"] .selection');
          return sel && sel.textContent.trim().toLowerCase().includes(token.toLowerCase());
        },
        { timeout: 10000, polling: 200 },
        divisionToken
      ).catch(() => console.warn(`[BUCS] .selection did not update to "${divisionToken}" — scraping anyway`));

    } else if (needsSwitch && !canSwitch) {
      // Single-division page — the table is already the one we want, no interaction needed
      console.log(`[BUCS] No dropdown for "${divisionToken}" — scraping single-division table directly`);
    }

    // ── Scrape the now-visible table ────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 2000));

    const allRows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
      );
    });

    console.log(`[BUCS] Raw rows scraped for ${tierLabel}: ${allRows.length}, first row: ${JSON.stringify(allRows[0])}`);
    if (allRows.length === 0) return [];

    const parsed = allRows
      .filter((cells) => cells.length >= 9)
      .map((cells) => {
        // Raw columns: [Pos, Team, P, W, D, L, F, A, GD, PointsTooltip, Pts]
        // The tooltip cell ("Points breakdown\n Won: X...") is invisible to users
        // but present in the DOM — strip it to find Pts as the last numeric cell.
        const lastNumericIdx = (() => {
          for (let i = cells.length - 1; i >= 0; i--) {
            if (/^-?\d+$/.test(cells[i].trim())) return i;
          }
          return cells.length - 1;
        })();
        const gdIdx = lastNumericIdx - 1;
        return {
          pos:  parseInt(cells[0], 10) || 0,
          team: cells[1] || '',
          p:    parseInt(cells[2], 10) || 0,
          w:    parseInt(cells[3], 10) || 0,
          d:    parseInt(cells[4], 10) || 0,
          l:    parseInt(cells[5], 10) || 0,
          gd:   parseInt(cells[gdIdx], 10) || 0,
          pts:  parseInt(cells[lastNumericIdx], 10) || 0,
        };
      })
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
// All LUSL divisions live on one URL with a custom dropdown to switch between them.
// divisionLabel is the text shown in the dropdown, e.g. "Premier Division", "Division 1"
async function scrapeLusl(browser, luslUrl, divisionLabel, imperialName) {
  const urlKey = luslUrl.split('/').pop(); // grab last bit of the Url  e.g (e.g. epbs7hchm7) competitive and intermediate  league
  const cacheKey = `lusl:${urlKey}:${divisionLabel}`; // cache both tables   separately
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      'KHTML, like Gecko Chrome/124.0.0.0 Safari/537.36'
    );
    await page.goto(luslUrl, { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForFunction(
      () => document.querySelectorAll('table tbody tr').length > 0,
      { timeout: 20000, polling: 500 }
    );

    // ── Read current division from the dropdown ───────────────────────────────
    // Try both the Playwaze-style [data-filter] pattern and a generic .selection
    const currentDivision = await page.evaluate(() => {
      const sel =
        document.querySelector('[data-filter="devision"] .selection') ||
        document.querySelector('[data-filter="division"] .selection') ||
        document.querySelector('.custom-dropDown .selection');
      return sel ? sel.textContent.trim() : null;
    });

    console.log(`[LUSL] Current division: "${currentDivision}", need: "${divisionLabel}"`);

    // ── Open dropdown and read all options ────────────────────────────────────
    const dropdownOptions = await (async () => {
      try {
        const trigger =
          await page.$('[data-filter="devision"] .selection') ||
          await page.$('[data-filter="division"] .selection') ||
          await page.$('.custom-dropDown .selection');
        if (!trigger) return [];
        await trigger.click();
        await page.waitForSelector('.dropdownList li', { timeout: 3000 });
        const opts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.dropdownList li'))
            .map(li => li.textContent.trim())
        );
        await page.keyboard.press('Escape');
        return opts;
      } catch {
        return [];
      }
    })();

    console.log(`[LUSL] Dropdown options:`, JSON.stringify(dropdownOptions));

    // ── Switch division if needed ─────────────────────────────────────────────
    const needsSwitch = currentDivision &&
      !currentDivision.toLowerCase().includes(divisionLabel.toLowerCase());
    const canSwitch = dropdownOptions.some(
      o => o.toLowerCase().includes(divisionLabel.toLowerCase())
    );

    if (needsSwitch && canSwitch) {
      // Re-open dropdown and click the target option
      const trigger =
        await page.$('[data-filter="devision"] .selection') ||
        await page.$('[data-filter="division"] .selection') ||
        await page.$('.custom-dropDown .selection');
      await trigger.click();
      await page.waitForSelector('.dropdownList li', { timeout: 5000 });

      const clicked = await page.evaluate((label) => {
        const target = Array.from(document.querySelectorAll('.dropdownList li'))
          .find(li => li.textContent.trim().toLowerCase().includes(label.toLowerCase()));
        if (target) { target.click(); return target.textContent.trim(); }
        return null;
      }, divisionLabel);

      console.log(`[LUSL] Switched to: "${clicked}"`);

      // Wait for the dropdown label to update as confirmation
      await page.waitForFunction(
        (label) => {
          const sel =
            document.querySelector('[data-filter="devision"] .selection') ||
            document.querySelector('[data-filter="division"] .selection') ||
            document.querySelector('.custom-dropDown .selection');
          return sel && sel.textContent.trim().toLowerCase().includes(label.toLowerCase());
        },
        { timeout: 10000, polling: 200 },
        divisionLabel
      ).catch(() => console.warn(`[LUSL] Dropdown did not update to "${divisionLabel}" — scraping anyway`));

    } else if (needsSwitch && !canSwitch) {
      console.log(`[LUSL] Division "${divisionLabel}" not in dropdown — scraping current table`);
    }

    await new Promise(r => setTimeout(r, 2000));

    // ── Scrape the table ──────────────────────────────────────────────────────
    const allRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
      )
    );

    console.log(`[LUSL] Raw rows for "${divisionLabel}": ${allRows.length}, first: ${JSON.stringify(allRows[0])}`);

    const parsed = allRows
      .filter((cells) => cells.length >= 8)
      .map((cells) => {
        const lastNumericIdx = (() => {
          for (let i = cells.length - 1; i >= 0; i--) {
            if (/^-?\d+$/.test(cells[i].trim())) return i;
          }
          return cells.length - 1;
        })();
        return {
          pos:  parseInt(cells[0], 10) || 0,
          team: cells[1] || '',
          p:    parseInt(cells[2], 10) || 0,
          w:    parseInt(cells[3], 10) || 0,
          d:    parseInt(cells[4], 10) || 0,
          l:    parseInt(cells[5], 10) || 0,
          gd:   parseInt(cells[lastNumericIdx - 1], 10) || 0,
          pts:  parseInt(cells[lastNumericIdx], 10) || 0,
        };
      })
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
    console.error(`LUSL scrape error for "${divisionLabel}":`, e.message);
    return [];
  } finally {
    await page.close();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/tables', async (req, res) => {
  const BUCS_M1_URL = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/leagues/i5p7xbti8m';
  const BUCS_M2_URL = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/Leagues/cdmdszzjypt';
  const BUCS_M3_URL = 'https://bucs.playwaze.com/bucs-football-25-26/cdkrbrt3dcl/league-display/Leagues/t39d2f4ffmxn';

  // All LUSL divisions live on the Playwaze page — navigate there then switch via the dropdown.
  // The label strings must match the dropdown text exactly (case-insensitive substring match).
  const LUSL_URL           = 'https://bucs.playwaze.com/lusl-football-25-26/61r2sreurlspdy/league-display/Leagues/smaid3mi5gbr';
  const LUSL_PREMIER_LABEL = 'Premier Division';
  const LUSL_DIV1_LABEL    = 'Division 1';
  const LUSL_DIV3_LABEL    = 'Division 3';
  const LUSL_lowerLeague_URL     = 'https://bucs.playwaze.com/lusl-football-25-26/61r2sreurlspdy/league-display/Leagues/epbs7hchm7'
  const browser = await launchBrowser();
  const safeScrape = async (fn) => {
    try { return await fn(); }
    catch (e) { console.error('Pipeline error:', e.message); return []; }
  };

  try {
    const m1Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M1_URL, 'SE 2B', 'Imperial Medics'));
    const m1Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_URL, LUSL_PREMIER_LABEL, 'Imperial Medics'));
    const m2Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M2_URL, 'SE 5C', 'Imperial Medics'));
    const m2Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_URL, LUSL_DIV1_LABEL, 'Imperial Medics'));
    const m3Bucs = await safeScrape(() => scrapeBucs(browser, BUCS_M3_URL, 'SE 7', 'Imperial Medics'));
    const m3Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_URL, LUSL_DIV3_LABEL, 'Imperial Medics'));
    const m4Lusl = await safeScrape(() => scrapeLusl(browser, LUSL_lowerLeague_URL, LUSL_DIV1_LABEL, 'Imperial Medics'));
    res.json({
      lastUpdated: new Date().toISOString(),
      teams: [
        { bucs: m1Bucs, lusl: m1Lusl },
        { bucs: m2Bucs, lusl: m2Lusl },
        { bucs: m3Bucs, lusl: m3Lusl },
        { bucs:null, lusl: m4Lusl },
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
