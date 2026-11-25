(() => {
  if (window.__dsmNarrativeDrawingInstalled) return;
  window.__dsmNarrativeDrawingInstalled = true;

  const drawings = new Map();
  const pendingDrawings = new WeakMap();

  function removeDrawing(request) {
    clearTimeout(request.checkTimer);
    try {
      if (request.id != null) {
        request.chart.removeEntity(request.id);
        request.id = null;
      }
    } catch {
      // The chart can be destroyed during SPA navigation.
    }
  }

  function findChart() {
    const frames = Array.from(document.querySelectorAll('iframe'), frame => frame.contentWindow);
    for (const host of [window, ...frames]) {
      for (const name of ['tradingViewApi', 'tvWidget', 'tradingViewWidget']) {
        try {
          const widget = host?.[name];
          const chart = widget?.activeChart?.();
          if (typeof chart?.createAnchoredShape === 'function' &&
              typeof chart.removeEntity === 'function') return { widget, chart };
        } catch {
          // Try the next widget if this one is unavailable or still mounting.
        }
      }
    }
    return null;
  }

  // A timeframe or layout change can rebuild a chart without changing the token URL.
  function watchNarrativeChart(request, route) {
    function check() {
      if (drawings.get('narrative') !== request || location.pathname !== route) return;
      if (document.visibilityState !== 'hidden') {
        const active = findChart();
        if (active) {
          let missing = active.chart !== request.chart;
          if (!missing && request.id != null) {
            try {
              const shapes = active.chart.getAllShapes?.();
              missing = Array.isArray(shapes) && !shapes.some(shape => shape.id === request.id);
            } catch {
              // TradingView may briefly reject reads while loading a layout.
            }
          }
          if (missing && request.missing) {
            removeDrawing(request);
            drawings.delete('narrative');
            window.dispatchEvent(new CustomEvent('DSM_NARRATIVE_DRAWING_FAILED', {
              detail: { key: request.key }
            }));
            return;
          }
          request.missing = missing;
        }
      }
      request.checkTimer = setTimeout(check, 2000);
    }
    request.checkTimer = setTimeout(check, 2000);
  }

  function drawingLayout(chart, summary, kind) {
    const width = chart.getTimeScale?.()?.width?.() || Math.min(innerWidth, 700);
    const height = chart.getPanes?.()?.[0]?.getHeight?.() || Math.min(innerHeight, 400);
    const isTrend = kind === 'trend';
    const columnWidth = width * (isTrend ? 0.56 : 0.54) - 24;
    const narrativeTop = 10;
    let fontSize = 13;
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
    const y = isTrend ? Math.max(0.02, 1 - (lines.length * 19 + 12) / height) : narrativeTop / height;
    return { position: { x, y }, text: lines.join('\n'), fontSize };
  }

  window.addEventListener('DSM_NARRATIVE_DRAWING', async ({ detail }) => {
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
        !detail.summary || detail.summary.length > 2400 || current?.key === detail.key) return;
    if (current) removeDrawing(current);

    const request = { key: detail.key, chart: null, id: null };
    drawings.set(kind, request);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (drawings.get(kind) !== request || location.pathname !== detail.route) return;
      try {
        const target = findChart();
        if (target) {
          const { chart } = target;
          const pending = pendingDrawings.get(chart);
          if (pending) {
            await pending;
            attempt -= 1;
            continue;
          }
          const { position, text, fontSize } = drawingLayout(chart,
            kind === 'trend' ? `趋势备注：${detail.summary}` : detail.summary,
            kind);
          request.chart = chart;
          if (kind === 'narrative') {
            clearTimeout(request.checkTimer);
            watchNarrativeChart(request, detail.route);
          }
          // A slow creation can already be visible before TradingView returns its ID.
          const drawing = Promise.resolve().then(async () => {
            if (drawings.get(kind) !== request || location.pathname !== detail.route) return;
            try {
              request.id = await chart.createAnchoredShape(position, {
                shape: 'anchored_text',
                text,
                disableSave: true,
                overrides: { color: '#087f89', fontsize: fontSize }
              });
              if (drawings.get(kind) !== request || location.pathname !== detail.route) removeDrawing(request);
              return request.id != null;
            } catch {
              // A rejected creation can be retried once the chart is ready.
            }
          }).finally(() => pendingDrawings.delete(chart));
          pendingDrawings.set(chart, drawing);
          const created = await drawing;
          if (drawings.get(kind) !== request || location.pathname !== detail.route) return;
          if (created) return;
        }
      } catch {
        // Retry while the chart is initializing.
      }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, attempt < 3 ? 100 : 300));
    }
    if (drawings.get(kind) === request && location.pathname === detail.route) {
      removeDrawing(request);
      drawings.delete(kind);
      window.dispatchEvent(new CustomEvent('DSM_NARRATIVE_DRAWING_FAILED', {
        detail: { key: request.key }
      }));
    }
  });
})();
