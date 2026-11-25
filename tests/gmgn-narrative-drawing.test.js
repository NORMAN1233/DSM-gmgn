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
  const note = '¹Û²ìÁ¿ÄÜ';
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
  assert.equal(Math.round(1680 * (1 - positions[3].x)), Array.from(`è¶‹åŠ¿å¤‡æ³¨ï¼š${note}`).length * 13 + 16);
  assert.ok(positions[2].y < positions[3].y, 'trend note is below the AI narrative');
  await dispatch({ detail: { key: 'note', kind: 'trend', remove: true } });
  assert.deepEqual([...drawings], [3]);
});

test('narrative detects a missing drawing and a replaced chart, and ignores a transient miss', async () => {
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
  await dispatch({ detail: { route, key: 'a', summary: 'First' } });
  shapes = [];
  check();
  shapes = [{ id: 42 }];
  check();
  assert.deepEqual(events, []);
  shapes = [];
  check();
  check();
  assert.deepEqual(events, ['a']);
  await dispatch({ detail: { route, key: 'b', summary: 'First' } });
  chart = { ...chart };
  check();
  check();
  assert.deepEqual(events, ['a', 'b']);
});
