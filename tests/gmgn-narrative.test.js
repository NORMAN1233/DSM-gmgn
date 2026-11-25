const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

test('GMGN narrative recovers slow text and follows the visible token on navigation', () => {
  const source = readFileSync(resolve(__dirname, '../content.js'), 'utf8');
  const narrative = source.slice(
    source.indexOf('  const AI_NARRATIVE_FOOTER'),
    source.indexOf('  function startUrlWatcher')
  );
  const drawings = [];
  const location = { pathname: '/sol/token/first' };
  const settings = { dsmEnabled: true, aiNarrativeEnabled: true };
  let preview;
  let name;
  let iconVisible = true;
  let now = 0;
  const hoverEvents = [];
  let pointerOnIcon = false;
  const enter = ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"];
  const icon = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 16, height: 16 }),
    isConnected: true,
    closest: () => null,
    getClientRects: () => iconVisible ? [{}] : [],
    matches: () => pointerOnIcon,
    getAttribute: () => null,
    dispatchEvent: event => {
      hoverEvents.push(event.type);
      if (event.type === "pointermove") {
        assert.equal(event.clientX, 18);
        assert.equal(event.clientY, 28);
      }
    }
  };
  class HoverEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  let notify;
  let queuedScan;
  let scheduledScans = 0;
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  function runTimer(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, 'expected scheduled timer of ' + delay);
    timers.delete(entry[0]);
    entry[1].callback();
  }
  const update = runInNewContext(narrative + '\nupdateAiNarrative;', {
    IS_GMGN: true,
    TOKEN_ROUTE_RE: /\/token\/([^/]+)/,
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
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
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
        if (selector.startsWith('[data-testid="token-detail-symbol"]')) return name ? [name] : [];
        if (selector.startsWith('[data-icon=')) return [{getClientRects: () => []}, icon];
        return selector === '.narrative-tooltip' && preview ? [
          {textContent: 'Hidden stale text. Disclaimer: AI-generated', getClientRects: () => []},
          preview
        ] : [];
      }
    },
    window: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      dispatchEvent: event => { drawings.push(event.detail); event.defaultPrevented = true; }
    }
  });

  update();
  now = 20000;
  update();
  assert.equal(drawings.length, 0);
  assert.deepEqual(hoverEvents, enter);
  assert.equal(listeners.has('keydown'), false);
  assert.equal(listeners.has('keyup'), false);
  preview = {
    textContent: 'First narrative. Disclaimer: AI-generated',
    getClientRects: () => [{}],
    closest: selector => selector.startsWith('[hidden]') ? null : preview
  };
  const records = [{ target: { nodeType: 3, parentElement: preview }, addedNodes: [] }];
  for (let i = 0; i < 100; i++) notify(records);
  assert.equal(scheduledScans, 1);
  queuedScan();
  assert.deepEqual(hoverEvents, [...enter, 'pointerout', 'mouseout', 'pointerleave', 'mouseleave']);
  assert.equal(drawings.at(-1).summary, 'First narrative.');
  preview = { ...preview }; // The outgoing portal can remount before the header changes.
  location.pathname = '/sol/token/second';
  update();
  assert.equal(drawings.length, 2);
  assert.equal(drawings.at(-1).remove, true);
  preview = { ...preview }; // React can recreate the same stale text after navigation as well.
  update();
  assert.equal(drawings.length, 2, 'a replacement tooltip containing the previous token must not draw');
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
  pointerOnIcon = true;
  const beforeStationaryHover = hoverEvents.length;
  update();
  assert.deepEqual(hoverEvents.slice(beforeStationaryHover), enter);
  assert.equal(drawings.at(-1).remove, true);
  pointerOnIcon = false;
  runTimer(2000);
  runTimer(4000);
  runTimer(4000);
  // The next native request has eight seconds to finish.
  runTimer(8000);
  runTimer(8000);
  preview = {
    textContent: 'Late third narrative. Disclaimer: AI-generated',
    getClientRects: () => [{}], closest: () => null
  };
  // Existing preview becomes visible without a DOM notification.
  runTimer(16000);
  assert.equal(drawings.at(-1).summary, 'Late third narrative.');
  assert.equal([...timers.values()].some(timer => timer.delay > 0), false);

  const link = {href: 'https://pump.fun/coin/third', getClientRects: () => [{}]};
  const group = { parentElement: {querySelectorAll: () => [link]}, nextElementSibling: {
    querySelectorAll: () => [{ getClientRects: () => [] }, icon]
  } };
  name = {getClientRects: () => [{}], parentElement: {parentElement: {parentElement: group}}};
  location.pathname = '/sol/token/fourth';
  preview.textContent = 'Old header updated its tooltip. Disclaimer: AI-generated';
  const hoverCount = hoverEvents.length;
  update();
  assert.equal(hoverEvents.length, hoverCount);
  assert.equal(drawings.at(-1).remove, true, 'never cache old text under the new URL');
  link.href = 'https://pump.fun/coin/fourth';
  iconVisible = false;
  runTimer(500);
  iconVisible = true; // No child or text mutation on a responsive layout change.
  runTimer(1000);
  assert.equal(drawings.at(-1).remove, true, 'ignore the outgoing portal after the new header commits');
  assert.equal(hoverEvents.length, hoverCount + enter.length);
  preview.textContent = 'Fourth narrative. Disclaimer: AI-generated';
  update();
  assert.equal(drawings.at(-1).summary, 'Fourth narrative.');
});

test('cold detail header selects its icon when a visible sidebar icon is mounted first', () => {
  const source = readFileSync(require.resolve('../content.js'), 'utf8');
  const detail = { getClientRects: () => [{}] };
  const sidebar = { getClientRects: () => [{}] };
  let localIcons = [detail];
  const link = { getClientRects: () => [{}], parentElement: { contains: node => localIcons.includes(node) } };
  const lookup = runInNewContext(source.slice(source.indexOf('  function aiNarrativeIcon('),
    source.indexOf('  function findAiNarrativeTooltip(')) + '\naiNarrativeIcon', {
    TOKEN_ROUTE_RE: /\/token\/([^/]+)/, AI_NARRATIVE_ICON: '[data-icon="narrative"]',
    document: { querySelectorAll(selector) {
      if (selector.startsWith('[data-testid=')) return [];
      if (selector.startsWith('[data-icon=')) return [sidebar, detail];
      return selector.includes('/coin/current"') ? [link] : [];
    } }
  });
  assert.equal(lookup('/sol/token/current'), detail);
  assert.equal(lookup('/sol/token/other'), null);
  localIcons = [sidebar, detail];
  assert.equal(lookup('/sol/token/current'), null);
});

test('retries an unreceived note and cached narrative when the drawing listener starts late', () => {
  const code = readFileSync(require.resolve('../content.js'), 'utf8');
  const section = (start, end) => code.slice(code.indexOf(start), code.indexOf(end));
  const route = '/token/test';
  const target = new EventTarget();
  const context = {
    window: target, CustomEvent, crypto: require('node:crypto'), location: { pathname: route },
    settings: { dsmEnabled: true, trendNote: 'saved' }, TOKEN_ROUTE_RE: /token/,
    stopAiNarrativeCapture() {}
  };
  const api = runInNewContext(section('  function sendChartDrawing', '  function updateAiNarrative()') +
    section('  let trendNoteDrawing;', '  function startUrlWatcher()') +
    '\n({updateTrendNote, showAiNarrative})', context);
  const visit = {route, summary: 'cached'};
  api.updateTrendNote();
  api.showAiNarrative(visit, visit.summary);
  assert.equal(visit.drawingKey, null);
  const received = [];
  target.addEventListener('DSM_NARRATIVE_DRAWING', event => {
    received.push(event.detail.summary);
    event.preventDefault();
  });
  api.updateTrendNote();
  api.updateTrendNote();
  api.showAiNarrative(visit, visit.summary);
  assert.ok(visit.drawingKey);
  assert.deepEqual(received, ['saved', 'cached']);
});

test('automatic hover reaches the native wrapper and sends a positioned move', () => {
  const code = readFileSync(require.resolve('../content.js'), 'utf8');
  const wrapper = { childElementCount: 2 };
  let open = false;
  let loaded = false;
  wrapper.dispatchEvent = event => { if (event.type === 'mouseenter') open = true; };
  const icon = {
    parentElement: wrapper,
    getBoundingClientRect: () => ({left: 10, top: 20, width: 16, height: 16}),
    dispatchEvent(event) {
      if (open && event.type === 'pointermove' && event.clientX === 18 && event.clientY === 28) loaded = true;
    }
  };
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const send = runInNewContext(code.slice(code.indexOf('  function dispatchNarrativeHover('),
    code.indexOf('  function releaseAiNarrativeHover(')) + '\ndispatchNarrativeHover',
    { document: { body: {} }, PointerEvent: Event, MouseEvent: Event });
  send(icon, true);
  assert.equal(loaded, true);
});
