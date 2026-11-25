const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

test('slow narrative drawings are never duplicated on the same widget', async () => {
  const source = readFileSync(require.resolve('../gmgn-narrative-drawing.js'), 'utf8');
  const location = { pathname: '/sol/token/first' };
  const listeners = [];
  const drawings = new Set();
  const pending = [];
  const positions = [];
  const timers = [];
  const chart = {
    createAnchoredShape(position) {
      positions.push(position);
      const id = pending.length + 1;
      drawings.add(id);
      return new Promise(resolve => pending.push(() => resolve(id)));
    },
    removeEntity(id) {
      assert.equal(drawings.delete(id), true);
    }
  };
  const context = {
    location,
    innerWidth: 700,
    innerHeight: 400,
    document: { querySelectorAll: () => [], createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 8 }) }) }) },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout(id) { if (id) timers[id - 1] = null; },
    window: {
      tradingViewApi: { activeChart: () => chart },
      addEventListener: (type, callback) => listeners.push(callback)
    }
  };
  runInNewContext(source, context);
  runInNewContext(source, context);
  assert.equal(listeners.length, 1);
  const [dispatch] = listeners;
  const request = key => dispatch({ detail: { key, route: location.pathname, summary: 'Narrative' } });
  const flush = () => new Promise(resolve => setImmediate(resolve));

  const first = request('first');
  await flush();
  assert.equal(pending.length, 1);
  assert.deepEqual(timers.map(timer => timer.delay), [2000], 'only monitor chart replacement during slow creation');

  location.pathname = '/sol/token/second';
  await dispatch({ detail: { key: 'first', remove: true } });
  const second = request('second');
  await flush();
  assert.deepEqual([...drawings], [1]);

  pending[0]();
  await first;
  await flush();
  assert.deepEqual([...drawings], [2], 'remove the stale drawing before creating its replacement');
  pending[1]();
  await second;
  await dispatch({ detail: { key: 'second', remove: true } });
  assert.equal(drawings.size, 0);

  chart.getTimeScale = () => ({ width: () => 1680 });
  const route = location.pathname;
  const note = '行情备注';
  const narrative = dispatch({ detail: { key: 'ai', route, summary: 'AI narrative' } });
  await flush();
  pending[2]();
  await narrative;
  const trend = dispatch({ detail: { key: 'note', route, summary: note, kind: 'trend' } });
  await flush();
  pending[3]();
  await trend;
  assert.equal(drawings.size, 2);
  assert.equal(positions[2].x, 0.46);
  assert.equal(positions[2].y, 10 / 400);
  assert.equal(Math.round(1680 * (1 - positions[3].x)), Array.from(`备注：${note}`).length * 13 + 16);
  assert.ok(positions[2].y < positions[3].y, 'trend note is below the AI narrative');
  await dispatch({ detail: { key: 'note', kind: 'trend', remove: true } });
  assert.deepEqual([...drawings], [3]);
});

for (const kind of ['trend', 'narrative']) {
  test(kind + ' recovers missing drawings and ignores a transient miss', async () => {
  const source = readFileSync(require.resolve('../gmgn-narrative-drawing.js'), 'utf8');
  const route = '/sol/token/first';
  const events = [];
  let check, dispatch;
  let shapes = [{ id: 42 }];
  let chart = {
    createAnchoredShape: () => 42,
    removeEntity() {},
    getAllShapes: () => shapes
  };
  runInNewContext(source, {
    location: { pathname: route }, innerWidth: 700, innerHeight: 400,
    document: { querySelectorAll: () => [], createElement: () => ({ getContext: () => null }) },
    setTimeout(callback) { check = callback; return 1; }, clearTimeout() {},
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    window: {
      tradingViewApi: { activeChart: () => chart },
      addEventListener(type, listener) { dispatch = listener; },
      dispatchEvent(event) { events.push(event.detail.key); }
    }
  });
  await dispatch({ detail: { kind, route, key: 'a', summary: 'First' } });
  shapes = [];
  check();
  chart = { ...chart, getShapeById: () => ({ getProperties: () => ({}) }) };
  check();
  check();
  assert.deepEqual(events, [], 'a live entity survives list omissions and wrapper changes');
  delete chart.getShapeById;
  shapes = [{ id: 42 }];
  check();
  assert.deepEqual(events, []);
  shapes = [];
  check();
  check();
  assert.deepEqual(events, ['a']);
  await dispatch({ detail: { kind, route, key: 'b', summary: 'First' } });
  chart = { ...chart };
  check();
  check();
  assert.deepEqual(events, ['a', 'b']);
  let creations = 0;
  chart.createAnchoredShape = () => { creations++; };
  await dispatch({ detail: { kind, route, key: 'c', summary: 'Painted without ID' } });
  check();
  check();
  assert.equal(creations, 1);
  assert.deepEqual(events, ['a', 'b']);

});
}

for (const notifyReady of [true, false]) {
test('trend draws with ready notification = ' + notifyReady, async () => {
  let dispatch, ready, chart;
  const timers = new Set();
  let creations = 0;
  const widget = { activeChart: () => chart, onChartReady: callback => { ready = callback; } };
  runInNewContext(readFileSync(require.resolve('../gmgn-narrative-drawing.js'), 'utf8'), {
    location: { pathname: '/token/one' }, innerWidth: 700, innerHeight: 400,
    document: { querySelectorAll: () => [] },
    window: { tradingViewApi: widget, addEventListener: (_, callback) => { dispatch = callback; } },
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); }
  });
  chart = { createAnchoredShape() { creations++; return 1; }, removeEntity() {} };
  const drawing = dispatch({ detail: { kind: 'trend', route: '/token/one', key: 'note', summary: 'test' } });
  await Promise.resolve();
  assert.equal(creations, 0, 'wait for the chart to finish initializing');
  if (notifyReady) ready();
  else {
    for (let i = 0; i < 2; i++) {
      const retry = timers.values().next().value;
      timers.delete(retry);
      retry();
      await Promise.resolve();
    }
  }
  await drawing;
  assert.equal(creations, 1);
});

}

const firstMint = 'Dk2Gv6Gd5hgm1q2iQr7fgdsGtRufRFA33fgzEYMUpump';
const secondMint = '3VYPCSoDs4NdjhCQCscfSj3u6N9EQV9aGSusPEHTpump';
const flush = () => new Promise(resolve => setImmediate(resolve));

function mountDrawing(chart, { inFrame = false } = {}) {
  const listener = {};
  const timers = new Map();
  const errors = [];
  const location = { pathname: '/sol/token/' + firstMint };
  const counts = { widgetReads: 0, domQueries: 0 };
  const widget = { activeChart() { counts.widgetReads++; return chart; } };
  runInNewContext(readFileSync(require.resolve('../gmgn-narrative-drawing.js'), 'utf8'), {
    location, innerHeight: 900, innerWidth: 1200, CustomEvent,
    document: {
      querySelectorAll() { counts.domQueries++; return []; },
      createElement: () => ({ getContext: () => null })
    },
    window: {
      ...(inFrame ? { length: 1, 0: { tradingViewApi: widget } } : { tradingViewApi: widget }),
      addEventListener(type, fn) { listener[type] = fn; },
      dispatchEvent(event) { errors.push(event.detail.key); }
    },
    setTimeout(fn, delay) { timers.set(fn, delay); return fn; },
    clearTimeout(fn) { timers.delete(fn); }
  });
  return {
    location, errors, counts, timers,
    draw(kind, key) {
      return listener.DSM_NARRATIVE_DRAWING({ detail: { kind, key, route: location.pathname, summary: key } });
    },
    remove(kind, key) { return listener.DSM_NARRATIVE_DRAWING({ detail: { kind, key, remove: true } }); },
    async tick(delay) {
      const entry = [...timers].find(([, ms]) => ms === delay);
      assert.ok(entry, 'Expected timer at ' + delay);
      timers.delete(entry[0]);
      entry[0]();
      await flush();
    }
  };
}

for (const kind of ['narrative']) {
  test(kind + ' waits for the new mint and retries a null legacy drawing result', async () => {
    let symbol = 'sol/' + firstMint + '/USD/MCAP';
    const calls = [];
    const page = mountDrawing({
      symbol: () => symbol,
      createAnchoredShape() { calls.push(symbol); return calls.length === 1 ? null : 'new'; },
      removeEntity() {}
    });
    page.location.pathname = '/sol/token/' + secondMint;
    const drawing = page.draw(kind, 'B');
    await flush();
    assert.equal(calls.length, 0);
    symbol = 'sol/' + secondMint + '/USD/MCAP';
    await page.tick(kind === 'trend' ? 16 : 100);
    await page.tick(kind === 'trend' ? 50 : 100);
    await drawing;
    assert.deepEqual(calls, [symbol, symbol]);
  });
}

test('stalled create on reused chart cannot block a new token or remove its drawing', async () => {
  let oldFinish;
  const removed = [];
  const page = mountDrawing({
    createAnchoredShape: (_, { text }) => text === 'A' ? new Promise(r => { oldFinish = r; }) : 'shape-B',
    removeEntity: id => removed.push(id)
  });
  const old = page.draw('narrative', 'A');
  await flush();
  page.location.pathname = '/sol/token/' + secondMint;
  const next = page.draw('narrative', 'B');
  await page.tick(120);
  await next;
  oldFinish('shape-A');
  await old;
  assert.deepEqual(removed, ['shape-A']);
  await page.remove('narrative', 'B');
  assert.deepEqual(removed, ['shape-A', 'shape-B']);
});

test('adopts uniquely matching newly painted text when wrapper returns no ID', async () => {
  const ids = new Set(['user']);
  let paintText = '';
  const page = mountDrawing({
    createAnchoredShape(_, { text }) { ids.add('plugin'); paintText = text; },
    getAllShapes: () => [...ids].map(id => ({ id, name: 'anchored_text' })),
    getShapeById: () => ({ getProperties: () => ({ text: paintText }) }),
    removeEntity(id) { assert.equal(ids.delete(id), true); }
  });
  await page.draw('narrative', 'same text');
  await page.remove('narrative', 'same text');
  assert.deepEqual([...ids], ['user']);
});

test('detects an unpainted ID-less request when the chart can enumerate entities', async () => {
  const page = mountDrawing({
    createAnchoredShape() {}, getAllShapes: () => [], getShapeById: () => null, removeEntity() {}
  });
  await page.draw('trend', 'note');
  await page.tick(2000);
  assert.deepEqual(page.errors, []);
  await page.tick(150);
  assert.deepEqual(page.errors, ['note']);
});

test('a cold chart can start reporting a failed ID-less creation after initialization', async () => {
  let ready = false;
  const page = mountDrawing({
    createAnchoredShape() {},
    getAllShapes() {
      if (!ready) throw new Error('chart is mounting');
      return [];
    },
    getShapeById: () => null,
    removeEntity() { assert.fail('there is no owned shape to remove'); }
  });
  await page.draw('narrative', 'cold');
  ready = true;
  await page.tick(2000);
  await page.tick(150);
  assert.deepEqual(page.errors, ['cold']);
});

test('waits for the new pane to lay out before saving its normalized anchor', async () => {
  let height = 1;
  const positions = [];
  const page = mountDrawing({
    getPanes: () => [{ getHeight: () => height }],
    createAnchoredShape(position) { positions.push(position); return 42; },
    removeEntity() {}
  });
  const drawing = page.draw('narrative', 'first visit');
  await flush();
  assert.equal(positions.length, 0);
  height = 500;
  await page.tick(100);
  await drawing;
  assert.equal(positions.length, 1);
  assert.equal(positions[0].y, 48 / height);
});

test('invalidates the monitor and its drawing key when it observes navigation', async () => {
  const removed = [];
  const page = mountDrawing({ createAnchoredShape: () => 7, removeEntity: id => removed.push(id) });
  await page.draw('trend', 'A');
  page.location.pathname = '/sol/token/' + secondMint;
  await page.tick(2000);
  assert.deepEqual(page.errors, ['A']);
  assert.deepEqual(removed, [7]);
});

test('superseded route releases the request even while waiting for the first chart', async () => {
  const page = mountDrawing(null);
  const drawing = page.draw('narrative', 'pending');
  page.location.pathname = '/sol/token/' + secondMint;
  await page.tick(100);
  await drawing;
  assert.deepEqual(page.errors, ['pending']);
});

test('retries a hung, empty chart only after sustained absence; preserves a reused ID', async () => {
  let finishOld, finishReplacement;
  const shapes = [];
  const removed = [];
  const chart = {
    createAnchoredShape: (_, { text }) => new Promise(resolve => {
      if (text === 'first') finishOld = resolve;
      else finishReplacement = resolve;
    }),
    getAllShapes: () => shapes,
    getShapeById: () => ({ getProperties: () => ({ text: 'replacement' }) }),
    removeEntity: id => removed.push(id)
  };
  const page = mountDrawing(chart);
  const old = page.draw('narrative', 'first');
  await flush();
  await page.tick(2000);
  await page.tick(2000);
  assert.deepEqual(page.errors, []);
  await page.tick(2000);
  await page.tick(150);
  assert.deepEqual(page.errors, ['first']);
  const replacement = page.draw('narrative', 'replacement');
  await page.tick(120);
  shapes.push({ id: 42, name: 'anchored_text' });
  finishOld(42);
  await old;
  finishReplacement(42);
  await replacement;
  assert.deepEqual(removed, []);
  await page.remove('narrative', 'replacement');
  assert.deepEqual(removed, [42]);
});

test('a still-visible drawing with a hung promise is adopted without re-creation', async () => {
  let finish;
  const shapes = [];
  const removed = [];
  const page = mountDrawing({
    createAnchoredShape() {
      shapes.push({ id: 9, name: 'anchored_text' });
      return new Promise(resolve => { finish = resolve; });
    },
    getAllShapes: () => shapes,
    getShapeById: () => ({ getProperties: () => ({ text: 'visible' }) }),
    removeEntity: id => removed.push(id)
  });
  const drawing = page.draw('narrative', 'visible');
  await flush();
  for (let i = 0; i < 4; i++) await page.tick(2000);
  assert.deepEqual(page.errors, []);
  await page.remove('narrative', 'visible');
  finish(9);
  await drawing;
  assert.deepEqual(removed, [9]);
});

test('both healthy annotations share a single chart lookup and shape list per interval', async () => {
  let lists = 0;
  const shapes = [];
  const page = mountDrawing({
    symbol: () => firstMint,
    createAnchoredShape() {
      const id = shapes.length + 1;
      shapes.push({ id });
      return id;
    },
    removeEntity() {},
    getAllShapes() { lists++; return shapes; }
  }, { inFrame: true });
  await page.draw('trend', 'note');
  await page.draw('narrative', 'ai');
  await page.tick(2000);
  await page.tick(2000);
  const readsBefore = page.counts.widgetReads;
  const listsBefore = lists;
  for (let i = 0; i < 5; i++) {
    assert.equal(page.timers.size, 1);
    await page.tick(2000);
  }
  assert.equal(page.counts.widgetReads - readsBefore, 5);
  assert.equal(lists - listsBefore, 5);
  assert.equal(page.counts.domQueries, 0);
  await page.remove('trend', 'note');
  await page.remove('narrative', 'ai');
  assert.equal(page.timers.size, 0);
  assert.deepEqual(page.errors, []);
});

test('a note painted without a returned ID stays single even with unfamiliar shape metadata', async () => {
  const shapes = [];
  let calls = 0;
  const page = mountDrawing({
    createAnchoredShape() {
      shapes.push({ id: ++calls, name: 'unknown' });
      return null;
    },
    getAllShapes: () => shapes,
    getShapeById: () => ({ getProperties: () => ({ text: '' }) }),
    removeEntity() {}
  });
  await page.draw('trend', 'note');
  for (let i = 0; i < 5; i++) await page.tick(2000);
  assert.equal(calls, 1);
  assert.deepEqual(page.errors, []);
});
