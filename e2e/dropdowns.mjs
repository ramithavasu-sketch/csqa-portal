// Full UI check on the demo build: every page for every role, every dropdown opened and its options picked,
// search inside long lists, a few dialogs, theme switch and feedback. Reports page errors and dropdowns
// whose chosen option didn't stick.   Run: npm run build:demo && PW_EXEC=<chrome> node e2e/dropdowns.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dist-demo/index.html', import.meta.url));
const srv = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(4175);
const browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined });
const B = 'http://localhost:4175/#';
const problems = [];
let checked = 0, picked = 0;

const PAGES = {
  super_admin: ['/', '/evaluations', '/parameters', '/reports', '/downloads', '/appeals', '/feedback-sessions', '/my-audits', '/notifications',
    '/admin/users', '/admin/teams', '/admin/scoring', '/admin/periods', '/admin/emails', '/admin/import', '/admin/audit', '/admin/feedback'],
  evaluator: ['/', '/evaluations', '/parameters', '/reports', '/downloads', '/appeals', '/feedback-sessions', '/my-audits', '/notifications', '/admin/periods', '/admin/emails'],
  admin: ['/', '/evaluations', '/parameters', '/reports', '/downloads', '/appeals', '/feedback-sessions', '/notifications'],
  manager: ['/', '/evaluations', '/parameters', '/reports', '/downloads', '/appeals', '/feedback-sessions', '/notifications'],
  user: ['/', '/evaluations', '/parameters', '/reports', '/downloads', '/appeals', '/feedback-sessions', '/notifications'],
};

async function signIn(page, email) {
  await page.goto(B + '/login'); await page.waitForSelector('#login-email');
  await page.fill('#login-email', email); await page.fill('#login-password', 'Demo@2026'); await page.click('button[type=submit]');
  await page.waitForSelector('main h1', { timeout: 15000 });
}

/** Opens every dropdown on the page and picks up to `max` of its options (first, middle, last …). */
async function exerciseDropdowns(page, where, max = 4) {
  const sel = (await page.locator('[role=dialog]').isVisible().catch(() => false)) ? '[role=dialog] [role=combobox]' : 'main [role=combobox]';
  const n = await page.locator(sel).count();
  for (let i = 0; i < n; i++) {
    const box = () => page.locator(sel).nth(i);
    if (!(await box().isVisible().catch(() => false)) || (await box().isDisabled())) continue;
    const name = (await box().getAttribute('aria-label')) || (await box().getAttribute('id')) || `#${i}`;
    await box().scrollIntoViewIfNeeded(); await box().click();
    const list = page.locator('[role=listbox]');
    if (!(await list.isVisible({ timeout: 2000 }).catch(() => false))) { problems.push(`${where} · ${name}: list did not open`); continue; }
    checked++;
    const labels = (await list.locator('[role=option]').allInnerTexts()).map((t) => t.trim().split('\n').pop().trim());   // drop avatar initials
    if (!labels.length) problems.push(`${where} · ${name}: no options`);
    // search box in long lists must filter
    const search = page.locator('[aria-label="Search options"]');
    if (await search.isVisible().catch(() => false)) {
      const word = labels[labels.length - 1].slice(0, 4);
      await search.fill(word);
      const hits = await list.locator('[role=option]').count();
      if (!hits) problems.push(`${where} · ${name}: search "${word}" found nothing`);
      await search.fill('');
    }
    await page.keyboard.press('Escape');
    const idx = [...new Set([0, Math.floor(labels.length / 2), labels.length - 1, 1].filter((x) => x >= 0 && x < labels.length))].slice(0, max);
    for (const k of idx) {
      if (!(await box().isVisible().catch(() => false))) break;   // the page changed (e.g. a view switched)
      await box().click();
      if (!(await list.isVisible({ timeout: 2000 }).catch(() => false))) { problems.push(`${where} · ${name}: list did not reopen`); break; }
      const opt = list.locator('[role=option]').nth(k);
      if ((await opt.getAttribute('aria-disabled')) === 'true') { await page.keyboard.press('Escape'); continue; }
      await opt.click(); picked++;
      await page.waitForTimeout(250);
      // a confirmation dialog may open (e.g. moving a CAM): cancel it
      const cancel = page.locator('[role=dialog] button:has-text("Cancel")');
      if (sel.startsWith('main') && await cancel.isVisible().catch(() => false)) await cancel.click();
      // the same dropdown (found again by its label — lists re-sort after a change) must show the choice within 2 s
      const again = name.startsWith('#') ? box() : page.locator(`[aria-label="${name}"], [id="${name}"]`).first();
      let shown = '';
      for (let t = 0; t < 8; t++) {
        if (!(await again.isVisible().catch(() => false))) break;
        shown = (await again.innerText()).trim().split('\n').pop().trim();
        if (shown.includes(labels[k].slice(0, 12))) break;
        await page.waitForTimeout(250);
      }
      if (shown) {
        if (labels[k] && !shown.includes(labels[k].slice(0, 12)) && !/Add an unassigned|choose|Remove from team/i.test(labels[k]) && !/^Add CAM/.test(name)) problems.push(`${where} · ${name}: picked "${labels[k]}" but it shows "${shown}"`);
      }
    }
  }
}

async function roleRun(email, role) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${role}] page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) problems.push(`[${role}] console: ${m.text().slice(0, 160)}`); });
  await signIn(page, email);
  for (const p of PAGES[role]) {
    await page.goto(B + p); await page.waitForTimeout(700);
    const h1 = (await page.locator('main h1').first().textContent().catch(() => '')) || '';
    if (/not found|no access|not allowed/i.test(h1)) problems.push(`[${role}] ${p}: "${h1}"`);
    const dupIds = await page.evaluate(() => { const c = {}; document.querySelectorAll('[id]').forEach((e) => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.keys(c).filter((k) => c[k] > 1); });
    if (dupIds.length) problems.push(`[${role}] ${p}: duplicate ids ${dupIds.join(', ')}`);
    await exerciseDropdowns(page, `[${role}] ${p}`);
    // tabs on the page
    const tabs = page.locator('main [role=tab]');
    for (let t = 0; t < (await tabs.count()); t++) { await tabs.nth(t).click(); await page.waitForTimeout(250); }
    if (await tabs.count()) await exerciseDropdowns(page, `[${role}] ${p} (after tabs)`, 2);
  }
  // theme switch
  await page.click('[aria-label=Theme]'); await page.click('[role=menuitemradio]:has-text("Dark")');
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') problems.push(`[${role}] dark theme did not apply`);
  await page.click('[aria-label=Theme]'); await page.click('[role=menuitemradio]:has-text("Light")');
  // feedback dialog: two choices
  await page.click('button[title="Send feedback about the portal"]');
  const kinds = await page.locator('[role=dialog] [aria-pressed]').allInnerTexts();
  if (kinds.join('|') !== 'Something isn’t working|Idea or suggestion') problems.push(`[${role}] feedback options: ${kinds.join(', ')}`);
  await page.keyboard.press('Escape');
  console.log(`${role}: done`);
  return { ctx, page };
}

// Super Admin first, also dialogs and making a Team Manager for the next run
{
  const { ctx, page } = await roleRun('maya.raman@demo.csqa.test', 'super_admin');
  await page.goto(B + '/admin/users'); await page.waitForTimeout(600);
  await page.locator('tr:has-text("Omar Haddad") button:has-text("Edit")').click();
  await exerciseDropdowns(page, '[super_admin] Edit user dialog', 2);
  await page.keyboard.press('Escape');
  await page.locator('tr:has-text("Omar Haddad") button:has-text("Edit")').click();
  await page.click('#u-role'); await page.getByRole('option', { name: /Team Manager/ }).click();
  await page.click('[role=dialog] button:has-text("Save")'); await page.waitForTimeout(600);
  const omar = await page.locator('tr:has-text("Omar Haddad")').innerText();
  if (!/Team Manager/.test(omar)) problems.push('[super_admin] could not make Omar a Team Manager: ' + omar.replace(/\s+/g, ' ').slice(0, 120));
  await page.goto(B + '/admin/teams'); await page.waitForTimeout(600);
  const edit = page.locator('main button:has-text("Edit team"), main button:has-text("Edit")').first();
  if (await edit.isVisible().catch(() => false)) { await edit.click(); await exerciseDropdowns(page, '[super_admin] Edit team dialog', 2); await page.keyboard.press('Escape'); }
  // the demo keeps its data in this browser: hand it to the next sign-ins
  const state = await ctx.storageState();
  await ctx.close();
  for (const [email, role] of [['theo.grant@demo.csqa.test', 'evaluator'], ['daniel.brooks@demo.csqa.test', 'admin'], ['omar.haddad@demo.csqa.test', 'manager'], ['ava.thompson@demo.csqa.test', 'user']]) {
    const c2 = await browser.newContext({ viewport: { width: 1400, height: 950 }, storageState: state });
    const p2 = await c2.newPage();
    const run = async () => {
      p2.on('pageerror', (e) => problems.push(`[${role}] page error: ${e.message}`));
      await signIn(p2, email);
      for (const p of PAGES[role]) {
        await p2.goto(B + p); await p2.waitForTimeout(700);
        const h1 = (await p2.locator('main h1').first().textContent().catch(() => '')) || '';
        if (!h1 || /not found|no access|not allowed/i.test(h1)) problems.push(`[${role}] ${p}: "${h1}"`);
        const dupIds = await p2.evaluate(() => { const c = {}; document.querySelectorAll('[id]').forEach((e) => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.keys(c).filter((k) => c[k] > 1); });
        if (dupIds.length) problems.push(`[${role}] ${p}: duplicate ids ${dupIds.join(', ')}`);
        await exerciseDropdowns(p2, `[${role}] ${p}`);
        const tabs = p2.locator('main [role=tab]');
        for (let t = 0; t < (await tabs.count()); t++) { await tabs.nth(t).click(); await p2.waitForTimeout(250); }
      }
      if (role === 'user') {   // CAM books a feedback slot in the portal
        await p2.goto(B + '/feedback-sessions'); await p2.waitForTimeout(700);
        const slot = p2.locator('main button:has-text(":00")').first();
        if (await slot.isVisible().catch(() => false)) {
          await p2.locator('main button:has-text("Thu"), main button:has-text("Fri"), main button:has-text("Mon")').first().click(); await p2.waitForTimeout(300);
          await p2.locator('main button:has-text(":00")').first().click();
          await p2.locator('main button:has-text("Book ")').first().click(); await p2.waitForTimeout(500);
          if (!(await p2.locator('main :text("Booked for")').count())) problems.push('[user] feedback booking did not show as booked');
        } else problems.push('[user] no feedback slot picker');
      }
      console.log(`${role}: done`);
    };
    await run(); await c2.close();
  }
}

console.log(`\nDropdowns opened: ${checked} · options picked: ${picked}`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n- ` + [...new Set(problems)].join('\n- ') : 'No problems found');
process.exitCode = problems.length ? 1 : 0;
await browser.close(); srv.close();
