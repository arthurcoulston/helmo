import { launchBrowser } from './browser.mjs';

const [url = 'http://127.0.0.1:4400', output = 'docs/dashboard.png'] = process.argv.slice(2);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: output });
  console.log(`Screenshot: ${output}`);
} finally {
  await browser.close();
}
