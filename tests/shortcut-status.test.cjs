const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const code = source.slice(source.indexOf('function showWalletCopyStatus('), source.indexOf('const EDGE_TTS_VOICES'));

function setup(notifications, failTab = false) {
  let listener;
  const state = { dsmSetting_officialWalletCopyEnabled: false };
  const injections = [], logs = [], queries = [];
  const context = vm.createContext({
    SUPPORTED_TAB_URLS: ['https://gmgn.ai/*', 'https://axiom.trade/*'],
    appendRuntimeLog: (entry) => logs.push(entry),
    chrome: {
      notifications,
      runtime: { getURL: (value) => value },
      commands: { onCommand: { addListener: (fn) => { listener = fn; } } },
      storage: { local: {
        get: async () => ({ ...state }),
        set: async (value) => Object.assign(state, value)
      } },
      tabs: { query: async (query) => { queries.push(query); return [{ id: 1 }, { id: 2 }]; } },
      scripting: { executeScript: async (options) => {
        if (failTab && options.target.tabId === 1) throw new Error('tab closed');
        injections.push(options);
        return [{ result: { shown: true } }];
      } }
    }
  });
  vm.runInContext(code, context);
  return { state, injections, logs, queries, async toggle() {
    listener('toggle-wallet-copy');
    await vm.runInContext('walletCopyToggleQueue', context);
  } };
}

test('unavailable notifications cannot stop on/off page notices', async () => {
  const app = setup(undefined);
  await app.toggle();
  assert.equal(app.injections.length, 2);
  assert.match(app.injections[0].args[0], /已开启/);
  await app.toggle();
  assert.equal(app.injections.length, 4);
  assert.match(app.injections[2].args[0], /已关闭/);
  assert.equal(app.injections[2].args[1], false);
  assert.ok(app.queries[0].url.includes('https://arkm.com/*'));
});

test('pending system notification does not block the shortcut queue', { timeout: 1000 }, async () => {
  const app = setup({ create: () => new Promise(() => {}) });
  await app.toggle();
  await app.toggle();
  assert.equal(app.injections.length, 4);
  assert.equal(app.state.dsmSetting_officialWalletCopyEnabled, false);
});

test('failed tab is logged and does not prevent other tabs receiving notice', async () => {
  const app = setup({ create: async () => { throw new Error('notifications denied'); } }, true);
  await app.toggle();
  assert.equal(app.injections.length, 1);
  assert.equal(app.injections[0].target.tabId, 2);
  assert.ok(app.logs.some((log) => log.level === 'warn' && log.detail.includes('tab closed')));
});

test('master off retains truthful status and inactive color', async () => {
  const app = setup(undefined);
  app.state.dsmSetting_dsmEnabled = false;
  await app.toggle();
  assert.match(app.injections[0].args[0], /总开关已关闭/);
  assert.equal(app.injections[0].args[1], false);
  assert.equal(app.state.dsmSetting_dsmEnabled, false);
});
