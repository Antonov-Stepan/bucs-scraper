# bucs-scraper

Express API that scrapes BUCS Play and LUSL league tables for Imperial Medics football and returns the results as JSON.

## Endpoints

### `GET /health`
Returns `{ "ok": true }` — used to confirm the service is running.

### `GET /tables`
Scrapes and returns league table rows for Imperial Medics' three football teams (M1, M2, M3) from both BUCS and LUSL. Each team object contains the **full league table** (every team, in table order), with Imperial Medics' row flagged.

**Response shape:**
```json
{
  "lastUpdated": "2025-01-01T12:00:00.000Z",
  "teams": [
    {
      "bucs": [ { "pos": 1, "team": "...", "p": 10, "w": 8, "d": 1, "l": 1, "gd": 20, "pts": 25, "imperial": true } ],
      "lusl": [ ... ]
    },
    { "bucs": [...], "lusl": [...] },
    { "bucs": [...], "lusl": [...] }
  ]
}
```

Row flags (only present when `true`):
- `imperial` — this is the Imperial Medics row (only rows whose name contains "Imperial Medics")
- `promote` — this team is in a promotion position
- `relegate` — this team is in a relegation position

Results are cached in memory for 3 hours.

## Setup

```bash
npm install
node index.js
```

The server runs on port `3000` by default (override with the `PORT` env var).

Puppeteer downloads its own Chrome on `npm install` via the `postinstall` script. To use a system Chrome instead, set `PUPPETEER_EXECUTABLE_PATH`.

## Deployment

Deployed on [Render](https://render.com) via `render.yaml`. The build command installs dependencies and downloads Chrome; the start command runs `node index.js`.
