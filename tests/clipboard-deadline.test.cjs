const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const ca = '0x1111111111111111111111111111111111111111';

test('delayed background initialization cannot forward an expired clipboard write', async () => {
  const source = read('background.js');
  const start = source.indexOf("  if (message.type === 'DSM_WALLET_COPY_CA') {");
  const end = source.indexOf("  if (message.type === 'DSM_CROSS_TAB_GMGN_SEARCH')", start);
  let clock = 1000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const forwarded = [];
  let respond;
  const response = new Promise((resolve) => { respond = resolve; });
  vm.runInNewContext(`(function () { ${source.slice(start, end)} })()`, {
    message: { type: 'DSM_WALLET_COPY_CA', ca, deadline: 1600 },
    sender: { url: 'https://gmgn.ai/sol' },
    Date: { now: () => clock },
    ensureOffscreenDocument: () => gate,
    chrome: { runtime: { sendMessage: (message) => { forwarded.push(message); return { ok: true }; } } },
    sendResponse: respond
  });
  clock = 1700;
  release();
  assert.equal((await response).reason, 'clipboard-timeout');
  assert.equal(forwarded.length, 0);
});

test('offscreen checks the deadline at the actual clipboard write', () => {
  let listener;
  let writes = 0;
  const source = read('offscreen.js');
  vm.runInNewContext(source.slice(source.indexOf('chrome.runtime.onMessage.addListener')), {
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    Date: { now: () => 1700 },
    document: {
      createElement: () => ({ select() {}, remove() {} }),
      body: { appendChild() {} },
      execCommand: () => { writes++; return true; }
    }
  });
  let result;
  listener({ target: 'offscreen', type: 'DSM_WALLET_COPY_CA', ca, deadline: 1600 }, {}, (value) => { result = value; });
  assert.equal(result.reason, 'clipboard-timeout');
  assert.equal(writes, 0);
  listener({ target: 'offscreen', type: 'DSM_WALLET_COPY_CA', ca, deadline: 1800 }, {}, (value) => { result = value; });
  assert.equal(result.ok, true);
  assert.equal(writes, 1);
});
