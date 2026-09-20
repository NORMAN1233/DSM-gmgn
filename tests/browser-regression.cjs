// Run with DSM_PLAYWRIGHT_MODULE and DSM_CHROMIUM pointing to a local browser runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.DSM_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const extension = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-regression-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.DSM_CHROMIUM, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const reports = [];
  let clipboardBefore, page, lastCopied;
  try {
    await context.route('https://gmgn.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="tracker"></main><input id="typing"></body></html>' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.storage.local.set({
      dsmSetting_twitterVoiceEnabled: false, dsmSetting_decisionEnabled: false,
      dsmSetting_dsmEnabled: true, dsmSetting_officialWalletCopyEnabled: true
    }));
    const extensionId = new URL(worker.url()).host;
    page = await context.newPage();
    await page.goto('https://gmgn.ai/sol');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gmgn.ai' });
    clipboardBefore = await page.evaluate(() => navigator.clipboard.readText());

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('[data-open="socialScreen"]').click();
    await popup.locator('#configureWalletCopyShortcut').click();
    await popup.keyboard.press('Control+Shift+Y');
    await popup.waitForFunction(() => document.getElementById('walletCopyShortcut').textContent.includes('Ctrl + Shift + Y'));
    await page.bringToFront();
    await page.keyboard.press('Control+Shift+Y');
    await page.waitForFunction(() => document.getElementById('dsm-shortcut-status-toast')?.shadowRoot.textContent.includes('已关闭'));
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('dsmSetting_officialWalletCopyEnabled')).dsmSetting_officialWalletCopyEnabled), false);
    await page.keyboard.press('Control+Shift+Y');
    await page.waitForFunction(() => document.getElementById('dsm-shortcut-status-toast')?.shadowRoot.textContent.includes('已开启'));
    assert.equal(await page.locator('#dsm-shortcut-status-toast').isVisible(), true);
    await page.screenshot({ path: path.join(profile, 'shortcut-on.png') });
    await page.locator('#typing').focus();
    await page.keyboard.press('Control+Shift+Y');
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('dsmSetting_officialWalletCopyEnabled')).dsmSetting_officialWalletCopyEnabled), true);
    await page.locator('#typing').evaluate((el) => el.blur());
    reports.push('PASS: real popup shortcut recording → keydown → background state → visible ON/OFF popover; ignores text inputs');

    const addresses = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    await page.evaluate((addresses) => {
      window.copyResults = [];
      window.addEventListener('dsm-gmgn-wallet-ca-copied', (event) => window.copyResults.push({ ...event.detail, at: performance.now() }));
      window.batchStarted = performance.now();
      const rows = addresses.map((ca, i) => {
        const a = document.createElement('a');
        a.setAttribute('data-sentry-component', 'TrackerListItem');
        a.href = `/bsc/token/${ca}`;
        a.innerHTML = `<span data-testid="follow-tracking-row-symbol">TOKEN</span><span data-testid="follow-tracking-row-side">${i % 2 ? 'Sell' : 'Buy'}</span>`;
        return a;
      });
      document.getElementById('tracker').prepend(...rows);
    }, addresses);
    await page.waitForFunction(() => window.copyResults.length === 1);
    const batch = await page.evaluate(() => ({ results: window.copyResults, ms: performance.now() - window.batchStarted }));
    assert.equal(batch.results.every((result) => result.copied), true);
    assert.deepEqual(batch.results.map((result) => result.ca), [addresses[0]]);
    lastCopied = addresses[0];
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()) === lastCopied, true, 'actual clipboard must contain the newest CA');
    reports.push(`PASS: 30-row update copies only the latest official top CA, ${Math.round(batch.ms)} ms`);

    // Force background transport without replacing extension APIs or clipboard writes.
    const bgAddress = '0x' + 'f'.repeat(40);
    await page.evaluate((ca) => {
      document.hasFocus = () => false;
      const a = document.createElement('a');
      a.setAttribute('data-sentry-component', 'TrackerListItem');
      a.href = `/eth/token/${ca}`;
      a.innerHTML = '<span data-testid="follow-tracking-row-symbol">TOKEN</span>';
      document.getElementById('tracker').prepend(a);
    }, bgAddress);
    await page.waitForFunction((ca) => window.copyResults.some((r) => r.ca === ca && r.copied), bgAddress);
    lastCopied = bgAddress;
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()) === lastCopied, true, 'offscreen clipboard copy must complete');
    reports.push('PASS: unfocused-page background → real offscreen → actual clipboard');

    await page.evaluate(() => {
      const list = document.getElementById('tracker');
      list.append(list.lastElementChild.cloneNode(true));
      list.replaceChildren(...[...list.children].map((row) => row.cloneNode(true)));
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.copyResults.length), 2);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()) === lastCopied, true);
    reports.push('PASS: historical append and whole-list clone do not change clipboard');

    if (process.env.DSM_TRACKER_HTML) {
      const markup = fs.readFileSync(process.env.DSM_TRACKER_HTML, 'utf8');
      await page.evaluate((markup) => {
        const holder = document.createElement('div');
        // Reconstruct nested anchors as React DOM does, without HTML parser repair.
        holder.innerHTML = markup.replace(/<a(?=[\s>])/g, '<dsm-a').replace(/<\/a>/g, '</dsm-a>');
        for (const node of [...holder.querySelectorAll('dsm-a')].reverse()) {
          const a = document.createElement('a');
          for (const attr of node.attributes) a.setAttribute(attr.name, attr.value);
          a.append(...node.childNodes); node.replaceWith(a);
        }
        document.getElementById('tracker').prepend(holder.firstElementChild);
      }, markup);
      const ca = '9HR5Uvyf95jgusXkEyoLipHMtw5FynKu1m8v9Nm9y7Kx';
      await page.waitForFunction((ca) => window.copyResults.some((result) => result.ca === ca && result.copied), ca);
      lastCopied = ca;
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()) === ca, true);
      reports.push('PASS: supplied real GMGN row HTML → correct token CA in actual clipboard');
    }
    console.log(reports.join('\n'));
    console.log(`Evidence: ${profile}/shortcut-on.png`);
  } finally {
    if (page && clipboardBefore !== undefined && lastCopied) {
      await page.evaluate(async ({ before, expected }) => {
        if (await navigator.clipboard.readText() === expected) await navigator.clipboard.writeText(before);
      }, { before: clipboardBefore, expected: lastCopied }).catch(() => {});
    }
    await context.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
