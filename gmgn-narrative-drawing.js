(() => {
  if (window.__dsmNarrativeDrawingInstalled) return;
  window.__dsmNarrativeDrawingInstalled = true;

  const drawings = new Map();
  const stableChecks = new Set();
  let stableTimer = null;
  const pendingDrawings = { narrative: new WeakMap(), trend: new WeakMap() };
  const addressPattern = /(?:^|[/:])(0x[\da-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?=\/|$)/;

  function tokenAddress(value) {
    const address = typeof value === 'string' ? value.match(addressPattern)?.[1] : undefined;
    return address?.startsWith('0x') ? address.toLowerCase() : address;
  }

  function chartAddress(chart) {
    const symbol = typeof chart.symbol === 'function' ? chart.symbol() : chart.symbol;
    const address = tokenAddress(symbol);
    if (address) return address;
    const info = typeof chart.symbolExt === 'function' ? chart.symbolExt() : chart.symbolExt;
    return tokenAddress(info?.ticker) || tokenAddress(info?.full_name) || tokenAddress(info?.name);
  }

  function invalidate(kind, request) {
    removeDrawing(request);
    drawings.delete(kind);
    window.dispatchEvent(new CustomEvent('DSM_NARRATIVE_DRAWING_FAILED', {
      detail: { key: request.key }
    }));
  }

  function isCurrent(kind, request) {
    if (drawings.get(kind) !== request) return false;
    if (location.pathname === request.route) return true;
    invalidate(kind, request);
    return false;
  }

  function removeDrawing(request) {
    clearTimeout(request.checkTimer);
    if (stableChecks.delete(request) && !stableChecks.size) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    try {
      if (request.id == null && request.unconfirmed) {
        request.id = newlyDrawnId(request.chart, request.unconfirmed.before, request.unconfirmed.text);
      }
      if (request.id != null) {
        request.chart.removeEntity(request.id);
        request.removedId = request.id;
        request.id = null;
      }
    } catch {
      // The chart can be destroyed during SPA navigation.
    }
  }

  function removeLateResult(request, id) {
    if (id == null || id === request.removedId) return;
    for (const active of drawings.values()) {
      if (active.widget !== request.widget) continue;
      if (active.id === id) return;
      if (active.id == null && active.pending) {
        active.pending.then(() => removeLateResult(request, id));
        return;
      }
      if (active.id == null && active.chart) return;
    }
    request.id = id;
    removeDrawing(request);
  }

  function findChart(address, request, allowReadyFallback = false) {
    let unidentified = null;
    for (let i = -1; i < (window.length ?? 0); i++) {
      const host = i < 0 ? window : window[i];
      for (const name of ['tradingViewApi', 'tvWidget', 'tradingViewWidget']) {
        try {
          const widget = host?.[name];
          if (request && widget?.onChartReady && !request.watchedWidgets.has(widget)) {
            request.watchedWidgets.add(widget);
            widget.onChartReady(() => {
              request.readyWidgets.add(widget);
              request.wake?.();
            });
          }
          if (request && widget?.onChartReady && !allowReadyFallback && !request.readyWidgets.has(widget)) continue;
          const chart = widget?.activeChart?.();
          if (typeof chart?.createAnchoredShape !== 'function' || typeof chart.removeEntity !== 'function') continue;
          if (!address) return { widget, chart };
          const symbolAddress = chartAddress(chart);
          if (symbolAddress === address) return { widget, chart };
          if (!symbolAddress && !unidentified) unidentified = { widget, chart };
        } catch {
          // Try the next widget if this one is unavailable or still mounting.
        }
      }
    }
    return unidentified;
  }

  // Some GMGN widgets paint the text but return undefined. Only adopt a newly
  // listed shape with our text, so cleanup can never target an existing drawing.
  function newlyDrawnId(chart, before, text) {
    if (!chart.getShapeById) return;
    try {
      const shapes = chart.getAllShapes?.();
      if (!Array.isArray(shapes)) return;
      if (!shapes.length) return null;
      if (!before) return;
      const added = shapes.filter(shape => !before.has(shape.id));
      if (!added.length) return null;
      let match = null;
      for (const shape of added) {
        const actual = chart.getShapeById(shape.id)?.getProperties?.()?.text;
        if (shape.name === 'anchored_text' && actual === text) {
          if (match !== null) return;
          match = shape.id;
        }
      }
      // A new entity with unrecognized properties may still be our text.
      if (match !== null) return match;
    } catch {
      // Some widget versions do not expose all drawing properties.
    }
  }

  // A timeframe or layout change can rebuild a chart without changing the token URL.
  function checkDrawings(requests) {
    let active;
    let shapes;
    for (const request of requests) {
      const { kind } = request;
      if (!isCurrent(kind, request)) continue;
      if (document.visibilityState !== 'hidden') {
        if (active === undefined) active = findChart(request.address);
        if (active) {
          // activeChart() may return another wrapper for the same chart.
          let missing = active.widget !== request.widget;
          if (!missing && request.unconfirmed) {
            const id = newlyDrawnId(active.chart, request.unconfirmed.before, request.unconfirmed.text);
            request.unconfirmed.emptyChecks = id === null ? request.unconfirmed.emptyChecks + 1 : 0;
            missing = id === null && (!request.pending || request.unconfirmed.emptyChecks >= 3);
            if (id != null) {
              request.id = id;
              request.unconfirmed = null;
            }
          }
          if (!missing && request.id != null) {
            try {
              if (shapes === undefined) shapes = active.chart.getAllShapes?.() ?? null;
              if (Array.isArray(shapes)) {
                missing = !shapes.some(shape => String(shape.id) === String(request.id));
                if (missing && active.chart.getShapeById) {
                  try {
                    const entity = active.chart.getShapeById(request.id);
                    if (entity) {
                      entity.getProperties?.();
                      missing = false;
                    }
                  } catch {
                    // Removed drawings may throw when accessed by ID.
                  }
                }
              } else if (active.chart === request.chart) {
                missing = false;
              }
            } catch {
              missing = false;
            }
          }
          if (missing && request.missing) {
            invalidate(kind, request);
            continue;
          }
          request.missing = missing;
        }
      }
      watchDrawing(request);
    }
  }

  function watchDrawing(request) {
    if (request.missing || request.id == null) {
      request.checkTimer = setTimeout(() => checkDrawings([request]), request.missing ? 150 : 2000);
      return;
    }

    // Both healthy annotations use the same current chart and shape list for this tick.
    stableChecks.add(request);
    if (stableTimer !== null) return;
    stableTimer = setTimeout(() => {
      stableTimer = null;
      const requests = [...stableChecks];
      stableChecks.clear();
      checkDrawings(requests);
    }, 2000);
  }

  function drawingLayout(chart, summary, kind) {
    const width = chart.getTimeScale?.()?.width?.() || Math.min(innerWidth, 700);
    const height = chart.getPanes?.()?.[0]?.getHeight?.() || Math.min(innerHeight, 400);
    const isTrend = kind === 'trend';
    const columnWidth = width * (isTrend ? 0.56 : 0.54) - 24;
    const narrativeTop = width < 1200 ? 48 : 10;
    let fontSize = 13;
    // A mounting pane can expose its API at 1px high. Its saved relative
    // anchor would remain outside the plot even after the pane grows.
    if (columnWidth < fontSize || height < narrativeTop + fontSize) throw new Error('Chart pane is mounting');
    const measure = !isTrend ? document.createElement('canvas').getContext('2d') : null;
    const wrap = () => {
      if (measure) {
        measure.font = `${fontSize}px Arial, sans-serif`;
        return summary.split(/\r?\n/).flatMap(paragraph => {
          const lines = [];
          let line = '';
          const tokens = paragraph.match(/[\p{Script=Latin}\d]+(?:[-’'][\p{Script=Latin}\d]+)*|\s+|./gu) || [];
          for (const token of tokens) {
            if (line && measure.measureText(line + token).width > columnWidth) {
              lines.push(line.trimEnd());
              line = '';
            }
            if (measure.measureText(token).width > columnWidth && token.trim()) {
              for (const character of token) {
                if (line && measure.measureText(line + character).width > columnWidth) {
                  lines.push(line);
                  line = '';
                }
                line += character;
              }
            } else {
              line += line ? token : token.trimStart();
            }
          }
          lines.push(line.trimEnd());
          return lines;
        });
      }
      const capacity = Math.max(1, Math.floor(columnWidth / fontSize));
      const columns = isTrend ? Math.min(32, capacity) : capacity;
      return summary.split(/\r?\n/).flatMap(paragraph =>
        paragraph.match(new RegExp(`.{1,${columns}}`, 'gu')) || ['']);
    };
    let lines = wrap();
    while (!isTrend && fontSize > 8 && lines.length * (fontSize + 6) > height - narrativeTop - 24) {
      fontSize -= 1;
      lines = wrap();
    }
    const longestLine = Math.max(...lines.map(line => Array.from(line).length));
    const x = isTrend ? Math.max(0.02, 1 - (longestLine * fontSize + 16) / width) : 0.46;
    const y = isTrend ? Math.max(0.02, 1 - (lines.length * 19 + 20) / height) : narrativeTop / height;
    return { position: { x, y }, text: lines.join('\n'), fontSize };
  }

  window.addEventListener('DSM_NARRATIVE_DRAWING', async event => {
    const { detail } = event;
    if (typeof detail?.key !== 'string') return;
    const kind = detail.kind === 'trend' ? 'trend' : 'narrative';
    const current = drawings.get(kind);
    if (detail.remove) {
      if (current?.key === detail.key) {
        removeDrawing(current);
        drawings.delete(kind);
      }
      return;
    }
    if (detail.route !== location.pathname || typeof detail.summary !== 'string' ||
        !detail.summary || detail.summary.length > 2400) return;
    event.preventDefault?.();
    if (current?.key === detail.key) return;
    if (current) removeDrawing(current);

    const request = { kind, key: detail.key, route: detail.route, address: tokenAddress(detail.route), chart: null, id: null };
    const trendRequest = kind === 'trend' ? request : null;
    request.watchedWidgets = new WeakSet();
    request.readyWidgets = new WeakSet();
    drawings.set(kind, request);
    const maxAttempts = trendRequest ? 32 : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!isCurrent(kind, request)) return;
      try {
        // An already-mounted widget may never replay its ready notification.
        const target = findChart(request.address, request, !trendRequest || attempt >= 2);
        if (target) {
          const { chart } = target;
          const pending = pendingDrawings[kind].get(chart);
          if (pending && request.waitedFor !== pending) {
            // Give an obsolete create time to finish its cleanup. A disposed
            // chart can leave it unresolved even when the next token is ready.
            request.waitedFor = pending;
            let timer;
            await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, 120); })]);
            clearTimeout(timer);
            attempt -= 1;
            continue;
          }
          const { position, text, fontSize } = drawingLayout(chart,
            kind === 'trend' ? `备注：${detail.summary}` : detail.summary,
            kind);
          request.chart = chart;
          request.widget = target.widget;
          clearTimeout(request.checkTimer);
          watchDrawing(request);
          // A slow creation can already be visible before TradingView returns its ID.
          const drawing = Promise.resolve().then(async () => {
            if (!isCurrent(kind, request)) return;
            try {
              request.unconfirmed = { before: null, text, emptyChecks: 0 };
              try {
                const shapes = chart.getShapeById && chart.getAllShapes?.();
                if (Array.isArray(shapes)) {
                  request.unconfirmed.before = new Set(shapes.map(shape => shape.id));
                }
              } catch {
                // The chart may allow creation before exposing its shape list.
              }
              const id = await chart.createAnchoredShape(position, {
                shape: 'anchored_text',
                text,
                disableSave: true,
                overrides: { color: '#087f89', fontsize: fontSize }
              });
              if (!isCurrent(kind, request)) {
                removeLateResult(request, id);
                return;
              }
              // Older releases return null when creation fails.
              if (id === null && request.id == null && kind !== 'trend') return false;
              if (id != null) request.id = id;
              if (request.id == null && request.unconfirmed) {
                request.id = newlyDrawnId(chart, request.unconfirmed.before, text);
              }
              if (request.id != null) request.unconfirmed = null;
              // Some widget versions resolve without an ID after painting the text.
              return true;
            } catch {
              // A rejected creation can be retried once the chart is ready.
            }
          }).finally(() => {
            request.pending = null;
            if (pendingDrawings[kind].get(chart) === drawing) pendingDrawings[kind].delete(chart);
          });
          request.pending = drawing;
          pendingDrawings[kind].set(chart, drawing);
          const created = await drawing;
          if (!isCurrent(kind, request)) return;
          if (created) return;
        }
      } catch {
        // Retry while the chart is initializing.
      }
      if (attempt + 1 < maxAttempts) await new Promise(resolve => {
        const delay = trendRequest ? (attempt === 0 ? 16 : 50) : (attempt < 3 ? 100 : 300);
        const timer = setTimeout(resolve, delay);
        request.wake = () => { clearTimeout(timer); resolve(); };
      });
      request.wake = null;
    }
    if (isCurrent(kind, request)) invalidate(kind, request);
  });
})();
