const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

test('route fallback skips settled annotations and still recovers missed navigation and draws', () => {
  const source = readFileSync(require.resolve('../content.js'), 'utf8');
  const watcher = source.slice(source.indexOf('  function startUrlWatcher'), source.indexOf('  function stopUrlWatcher'));
  const calls = [];
  let tick;
  const ctx = {
    IS_GMGN: true, routeWatcherId: null, TOKEN_ROUTE_RE: /\/token\//,
    document: { visibilityState: 'visible' }, location: { pathname: '/monitor' },
    settings: { dsmEnabled: true, aiNarrativeEnabled: true, trendNote: 'saved', xPostViewsEnabled: true },
    viewed: { started: false }, decision: { started: false },
    aiNarrativeVisit: null, trendNoteDrawing: null, xPost: null, xPostBadge: null,
    updateXPostBadge: () => calls.push('views'),
    updateAiNarrative: () => calls.push('ai'),
    updateTrendNote: () => calls.push('note'),
    setInterval(fn, ms) { assert.equal(ms, 500); tick = fn; return 1; }
  };
  runInNewContext(watcher + '\nstartUrlWatcher();', ctx);
  for (let i = 0; i < 120; i++) tick();
  assert.deepEqual(calls, []);
  ctx.location.pathname = '/sol/token/one';
  tick();
  assert.deepEqual(calls.splice(0), ['note', 'ai', 'views']);
  ctx.trendNoteDrawing = { route: ctx.location.pathname, node: { isConnected: true }, frame: { isConnected: true } };
  ctx.aiNarrativeVisit = { route: ctx.location.pathname, summary: 'cached', drawingKey: 'drawn' };
  tick();
  assert.deepEqual(calls.splice(0), ['views']);
  ctx.trendNoteDrawing.node.isConnected = false;
  ctx.aiNarrativeVisit.drawingKey = null;
  tick();
  assert.deepEqual(calls.splice(0), ['note', 'ai', 'views']);
  ctx.location.pathname = '/monitor';
  ctx.xPostBadge = { isConnected: true };
  tick();
  assert.deepEqual(calls, ['note', 'ai', 'views']);
});
