const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

test('GMGN narrative requests lazy text once per visit without loading another page', () => {
  const source = readFileSync(resolve(__dirname, '../content.js'), 'utf8');
  const narrative = source.slice(
    source.indexOf('  const AI_NARRATIVE_FOOTER'),
    source.indexOf('  function startUrlWatcher')
  );
  const drawings = [];
  const location = { pathname: '/sol/token/first' };
  const settings = { dsmEnabled: true, aiNarrativeEnabled: true };
  let preview;
  let now = 0;
  const hoverEvents = [];
  const icon = {
    isConnected: true,
    closest: () => null,
    matches: () => false,
    getAttribute: () => null,
    dispatchEvent: event => hoverEvents.push(event.type)
  };
  class HoverEvent {
    constructor(type) { this.type = type; }
  }
  let notify;
  let queuedScan;
  let scheduledScans = 0;
  const listeners = new Map();
  const update = runInNewContext(narrative + '\nupdateAiNarrative;', {
    IS_GMGN: true,
    TOKEN_ROUTE_RE: /\/token\//,
    X_PREVIEW_PANEL: '[role="tooltip"]',
    location,
    settings,
    Date: { now: () => now },
    crypto: require('node:crypto'),
    CustomEvent: class {
      constructor(type, options) {
        assert.equal(type, 'DSM_NARRATIVE_DRAWING');
        this.detail = options.detail;
      }
    },
    PointerEvent: HoverEvent,
    MouseEvent: HoverEvent,
    setTimeout: (callback, delay) => {
      if (delay === 0) { scheduledScans += 1; queuedScan = callback; }
      return scheduledScans + 1;
    },
    clearTimeout: () => {},
    MutationObserver: class {
      constructor(callback) { notify = callback; }
      observe() {}
      disconnect() {}
    },
    document: {
      body: {},
      querySelector: selector => selector.startsWith('[data-icon=') ? icon : null,
      createElement: tag => assert.fail(`narrative capture must not create a ${tag}`),
      visibilityState: 'visible',
      querySelectorAll(selector) {
        if (selector.startsWith('[data-icon=')) return [icon];
        return selector === '.narrative-tooltip' && preview ? [preview] : [];
      }
    },
    window: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      dispatchEvent: event => drawings.push(event.detail)
    }
  });

  update();
  now = 20000;
  update();
  assert.equal(drawings.length, 0);
  assert.deepEqual(hoverEvents, ['pointerover', 'mouseover', 'pointerenter', 'mouseenter']);
  assert.equal(listeners.has('keydown'), false);
  assert.equal(listeners.has('keyup'), false);
  preview = {
    textContent: 'First narrative. Disclaimer: AI-generated',
    getBoundingClientRect: () => ({ width: 250, height: 60 }),
    closest: () => preview
  };
  const records = [{ target: { nodeType: 3, parentElement: preview }, addedNodes: [] }];
  for (let i = 0; i < 100; i++) notify(records);
  assert.equal(scheduledScans, 1);
  queuedScan();
  assert.deepEqual(hoverEvents, ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointerout', 'mouseout', 'pointerleave', 'mouseleave']);
  assert.equal(drawings.at(-1).summary, 'First narrative.');
  location.pathname = '/sol/token/second';
  update();
  assert.equal(drawings.length, 2);
  assert.equal(drawings.at(-1).remove, true);
  preview.textContent = 'Second narrative. Disclaimer: AI-generated';
  update();
  assert.equal(drawings.at(-1).summary, 'Second narrative.');

  preview = null;
  location.pathname = '/sol/token/first';
  update();
  assert.equal(drawings.at(-1).summary, 'First narrative.');
  settings.aiNarrativeEnabled = false;
  update();
  assert.equal(drawings.at(-1).remove, true);

  settings.aiNarrativeEnabled = true;
  location.pathname = '/sol/token/third';
  update();
  assert.equal(drawings.at(-1).remove, true);
});
