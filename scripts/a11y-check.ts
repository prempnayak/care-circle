/**
 * Accessibility gate (handoff §16): axe on the card, the dashboard and the simulator. Pass = no serious
 * or critical issues. Needs the local stack running (npm run dev). `--screenshots` also refreshes the
 * README images in docs/images/ after resetting the demo to 8:35 am.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Page } from 'playwright';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';
const SIMULATOR = process.env.SIMULATOR_URL ?? 'http://localhost:5174';
const AGENT = process.env.SIM_AGENT_URL ?? 'http://localhost:8790';
const shots = process.argv.includes('--screenshots');
const imgDir = fileURLToPath(new URL('../docs/images/', import.meta.url));
mkdirSync(imgDir, { recursive: true });

const failures: string[] = [];
async function audit(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  console.log(`${bad.length === 0 ? '✓' : '✗'} ${name}: ${result.violations.length} issue(s), ${bad.length} serious/critical`);
  for (const v of bad) failures.push(`${name}: ${v.id} (${v.impact}) — ${v.help} [${v.nodes.length} node(s)]`);
  for (const v of result.violations.filter((x) => !bad.includes(x))) console.log(`    minor: ${v.id} — ${v.help}`);
}

async function agentPost(path: string, body: unknown) {
  return fetch(`${AGENT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' });
const page = await ctx.newPage();

// 1. The card on its own (sample data) at Echo Show size.
const card = await ctx.newPage();
await card.setViewportSize({ width: 1024, height: 600 });
await card.goto(new URL('../packages/ui-card/dist/index.html', import.meta.url).href);
await audit(card, 'card (ui://care-circle/today)');
if (shots) await card.screenshot({ path: `${imgDir}card.png` });

if (shots) {
  await agentPost('/dev/reset?seed=demo', {});
  await agentPost('/dev/clock', { dayOffset: 0, at: '08:35', tz: 'America/New_York' });
}

// 2. Dashboard: sign in as Sarah through dev-auth, then audit each section.
await page.goto(DASHBOARD);
await audit(page, 'dashboard sign-in');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('button', { name: 'Sign in as Sarah' }).click();
await page.getByRole('heading', { name: "Margaret's circle" }).waitFor();
await page.getByRole('heading', { name: 'Last 14 days' }).waitFor();
await audit(page, 'dashboard timeline');
if (shots) await page.screenshot({ path: `${imgDir}dashboard-timeline.png`, fullPage: false });
for (const tab of ['Medicines', 'Family and codes', 'Email alerts', 'Check-in window', 'Account']) {
  await page.getByRole('tab', { name: tab }).click();
  await page.waitForTimeout(300);
  await audit(page, `dashboard ${tab.toLowerCase()}`);
  if (shots && tab === 'Family and codes') {
    await page.getByRole('button', { name: 'Code for a family member' }).click();
    await page.getByText('Join code').waitFor();
    await page.screenshot({ path: `${imgDir}dashboard-codes.png` });
  }
}

// 3. Simulator.
await page.goto(SIMULATOR);
await page.getByRole('button', { name: /Margaret/ }).first().waitFor();
await audit(page, 'simulator');
if (shots) {
  const sayIt = async (text: string) => {
    await page.getByLabel(/What .* says/).fill(text);
    await page.getByRole('button', { name: 'Say', exact: true }).click();
    await page.waitForTimeout(1200);
  };
  await page.getByRole('button', { name: /^Margaret/ }).click();
  await sayIt("Alexa, tell Care Circle I'm up. A bit tired today.");
  await sayIt('What pills do I have this morning?');
  await page.frameLocator('iframe[title="Care Circle card"]').getByText('metformin').waitFor({ timeout: 10_000 });
  await sayIt('I took the metformin');
  await sayIt('What pills do I have this morning?');
  await page.waitForTimeout(800);
  await audit(page, 'simulator with card');
  await page.screenshot({ path: `${imgDir}simulator-margaret.png` });
  await page.getByRole('button', { name: /^Sarah/ }).click();
  await sayIt("Alexa, ask Care Circle how Mom's doing");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${imgDir}simulator-sarah.png` });
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('PASS: no serious or critical accessibility issues');
