const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const code = source.slice(source.indexOf('function showWalletCopyStatus('), source.indexOf('const EDGE_TTS_VOICES'));
function setup(result, url = 'https://gmgn.ai/sol') {
  let listener;
  const updates = [], notices = [];
  const context = vm.createContext({
    URL,
    appendRuntimeLog: () => {},
    sendTabMessage: async (id, message) => {
      assert.equal(id, 17);
      assert.equal(message.type, 'DSM_WALLET_CLICK_LATEST');
      return result;
    },
    chrome: {
      commands: { onCommand: { addListener: (fn) => { listener = fn; } } },
      tabs: {
        query: async (query) => { assert.equal(query.active, true); assert.equal(query.currentWindow, true); return [{ id: 17, url }]; },
        update: async (id, options) => updates.push({ id, ...options })
      },
      scripting: { executeScript: async (options) => notices.push(options.args[0]) }
    }
  });
  vm.runInContext(code, context);
  return { updates, notices, async press() { listener('toggle-wallet-copy'); await vm.runInContext('walletCopyToggleQueue', context); } };
}
test('existing shortcut asks the page to click without updating the tab URL', async () => {
  const url = 'https://gmgn.ai/robinhood/token/0x1111111111111111111111111111111111111111';
  const app = setup({ ok: true, url });
  await app.press();
  assert.deepEqual(app.updates, []);
});
test('missing notifications or disabled feature show the reason without navigating', async () => {
  const app = setup({ ok: false, reason: '尚未收到新的钱包通知' });
  await app.press();
  assert.deepEqual(app.updates, []);
  assert.deepEqual(app.notices, ['尚未收到新的钱包通知']);
});
test('shortcut does nothing outside GMGN and rejects foreign destinations', async () => {
  for (const [sourceUrl, target] of [['https://axiom.trade', 'https://gmgn.ai/sol'], ['https://gmgn.ai/sol', 'https://evil.example/sol']]) {
    const app = setup({ ok: true, url: target }, sourceUrl);
    await app.press();
    assert.deepEqual(app.updates, []);
  }
});
