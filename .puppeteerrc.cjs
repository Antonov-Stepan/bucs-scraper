const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Forces Puppeteer to download and look for Chrome inside the local project workspace
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};