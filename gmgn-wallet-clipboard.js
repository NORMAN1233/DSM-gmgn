(() => {
  'use strict';

  const SETTING_KEY = 'dsmSetting_officialWalletCopyEnabled';
  const MASTER_KEY = 'dsmSetting_dsmEnabled';

  // GMGN 官方钱包追踪行的真实 DOM 标记（TrackerListItem.tsx）。
  const TRACKER_ROW_SELECTOR = [
    'a[data-sentry-component="TrackerListItem"][href]',
    'a[data-sentry-source-file="TrackerListItem.tsx"][href]'
  ].join(',');
  const TRACKER_SYMBOL_SELECTOR = '[data-testid="follow-tracking-row-symbol"]';
  const TOKEN_ROUTE_RE = /\/(?:token|pump|meme|coin|pair|pool)\/([^/?#]+)/i;
  const CA_RE = /^(?:0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[EU]Q[A-Za-z0-9_-]{46})$/;


  let enabled = true;
  let masterEnabled = true;
  let settingsReady = false;
  let observer = null;
  let observationRoot = null;
  let bodyReadyListener = false;
  let flushScheduled = false;
  let latestToken = null;
  const changedSettings = new Set();

  const pendingRows = new Set();
  const rowTokens = new WeakMap();

  function isGMGNPage() {
    return /(^|\.)gmgn\.ai$/i.test(location.hostname || '');
  }

  function normalizeCA(value) {
    const ca = String(value || '').trim().replace(/[。；，,;\])}>'"`]+$/g, '');
    if (!CA_RE.test(ca)) return '';
    return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
  }

  function caFromRow(row) {
    return caFromHref(row?.getAttribute?.('href'));
  }

  function caFromHref(value) {
    const href = String(value || '');
    const match = href.match(TOKEN_ROUTE_RE);
    if (!match) return '';
    try { return normalizeCA(decodeURIComponent(match[1])); } catch (error) { return normalizeCA(match[1]); }
  }

  function tokenKeyFromRow(row, ca) {
    // 身份包含链接里的链路径；不能用当前页面的链，也不能只按 CA 去重。
    const href = String(row?.getAttribute?.('href') || '');
    try {
      const path = new URL(href, location.href).pathname;
      return `${path.split(TOKEN_ROUTE_RE)[0].toLowerCase()}|${ca}`;
    } catch (error) {
      return `${href}|${ca}`;
    }
  }

  function tokenKeyFromHref(href, ca) {
    try {
      const path = new URL(href, location.href).pathname;
      return `${path.split(TOKEN_ROUTE_RE)[0].toLowerCase()}|${ca}`;
    } catch (error) {
      return `${href}|${ca}`;
    }
  }

  function rowFromNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return null;
    const direct = element.matches?.(TRACKER_ROW_SELECTOR)
      ? element
      : element.closest?.(TRACKER_ROW_SELECTOR);
    if (direct && caFromRow(direct)) return direct;

    const symbol = element.closest?.(TRACKER_SYMBOL_SELECTOR);
    const fallback = symbol?.closest?.('a[href]') || element.closest?.('a[href]');
    if (!symbol && !fallback?.querySelector?.(TRACKER_SYMBOL_SELECTOR)) return null;
    return fallback && caFromRow(fallback) ? fallback : null;
  }

  function firstRowIn(root) {
    if (!root) return null;
    const direct = rowFromNode(root);
    if (direct) return direct;
    try {
      const row = root.querySelector?.(TRACKER_ROW_SELECTOR);
      if (row && caFromRow(row)) return row;
      const symbol = root.querySelector?.(TRACKER_SYMBOL_SELECTOR);
      const fallback = symbol?.closest?.('a[href]');
      return fallback && caFromRow(fallback) ? fallback : null;
    } catch (error) {
      return null;
    }
  }

  function trackerListRoot(row) {
    let current = row?.parentElement;
    const fallback = current;
    for (let depth = 0; current && current !== document.body && depth < 5; depth += 1, current = current.parentElement) {
      try {
        if (current.querySelectorAll(TRACKER_ROW_SELECTOR).length > 1) return current;
      } catch (error) {}
    }
    return fallback || row?.parentElement || null;
  }

  async function processRow(row, capturedHref = '') {
    if (!settingsReady || !enabled || !masterEnabled || !row) return;
    const href = capturedHref || String(row.getAttribute?.('href') || '');
    const ca = caFromHref(href);
    if (!ca) return;
    let url;
    try { url = new URL(href, location.href); } catch { return; }
    if (url.protocol !== 'https:' || !/(^|\.)gmgn\.ai$/i.test(url.hostname)) return;
    const key = tokenKeyFromHref(href, ca);
    if (rowTokens.get(row)?.key === key) return;
    rowTokens.set(row, { key });
    latestToken = { ca, url: url.href };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'DSM_WALLET_LATEST_TOKEN') return;
    if (!settingsReady || !masterEnabled || !enabled) {
      sendResponse({ ok: false, reason: '请先开启插件和钱包快捷跳转' });
    } else if (!latestToken) {
      sendResponse({ ok: false, reason: '尚未收到新的钱包通知，请等待新消息' });
    } else {
      sendResponse({ ok: true, ...latestToken });
    }
  });

  function isEditing(element) {
    return !!(element?.isContentEditable || element?.closest?.(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]'
    ));
  }

  let opening = false;
  window.addEventListener('keydown', (event) => {
    if (!isGMGNPage() || !settingsReady || !enabled || !masterEnabled || opening
        || event.code !== 'KeyC' || event.repeat || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || event.composedPath().some(isEditing) || isEditing(document.activeElement)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    opening = true;
    Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'DSM_WALLET_OPEN_LATEST' }))
      .catch(() => {}).finally(() => { opening = false; });
  }, true);

  function enqueueRow(row) {
    if (!row || !caFromRow(row)) return;
    pendingRows.add(row);
    if (!settingsReady) return;
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      const rows = Array.from(pendingRows);
      pendingRows.clear();
      // GMGN 新记录在顶部：从旧到新识别，最终保留最上面的详情链接。
      rows.sort((a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1));
      for (const candidate of rows) processRow(candidate).catch(() => {});
    });
  }

  function collectRows(node, rows) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return;
    const direct = rowFromNode(element);
    if (direct) rows.add(direct);
    try {
      for (const row of element.querySelectorAll?.(TRACKER_ROW_SELECTOR) || []) rows.add(row);
      for (const symbol of element.querySelectorAll?.(TRACKER_SYMBOL_SELECTOR) || []) {
        const row = symbol.closest?.('a[href]');
        if (row && caFromRow(row)) rows.add(row);
      }
    } catch (error) {}
  }

  function seedExistingRows(root) {
    try {
      for (const row of root.querySelectorAll(TRACKER_ROW_SELECTOR)) {
        const ca = caFromRow(row);
        if (ca) rowTokens.set(row, { key: tokenKeyFromRow(row, ca) });
      }
      for (const symbol of root.querySelectorAll(TRACKER_SYMBOL_SELECTOR)) {
        const row = symbol.closest?.('a[href]');
        const ca = caFromRow(row);
        if (row && ca) rowTokens.set(row, { key: tokenKeyFromRow(row, ca) });
      }
    } catch (error) {}
  }

  function attachToTracker(row) {
    const root = row ? trackerListRoot(row) : null;
    observer?.disconnect();
    observationRoot = root;
    seedExistingRows(document.body);
    observer = new MutationObserver((mutations) => {
      const addedRows = new Set();
      const changedRows = new Set();
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'href') {
          const changed = rowFromNode(mutation.target);
          if (changed) {
            // href 可能在同一 MutationObserver 批次内连续改写；oldValue 是中间预警的唯一快照。
            if (settingsReady && mutation.oldValue && caFromHref(mutation.oldValue)) {
              processRow(changed, mutation.oldValue).catch(() => {});
            }
            changedRows.add(changed);
          }
        } else if (mutation.type === 'attributes' || mutation.type === 'characterData' || mutation.type === 'childList') {
          const changed = rowFromNode(mutation.target);
          if (changed) changedRows.add(changed);
        }
        for (const node of mutation.addedNodes || []) collectRows(node, addedRows);
      }
      // 重建列表也可能夹带新交易，按从旧到新的顺序处理，不能整批标记已读。
      for (const row of addedRows) enqueueRow(row);
      for (const row of changedRows) enqueueRow(row);
      if (!observationRoot?.isConnected) {
        const current = Array.from(addedRows).find((candidate) => candidate.isConnected);
        observationRoot = current ? trackerListRoot(current) : null;
      }
    });
    // 连续接收新增节点，不再通过 1 秒轮询恢复监听；只解析官方追踪行。
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'class', 'data-testid', 'data-sentry-component', 'data-sentry-source-file'],
      attributeOldValue: true
    });
    return true;
  }

  function start() {
    if (!enabled || !masterEnabled || !isGMGNPage() || observer) return;
    if (!document.body) {
      if (!bodyReadyListener) {
        bodyReadyListener = true;
        document.addEventListener('DOMContentLoaded', () => {
          bodyReadyListener = false;
          start();
        }, { once: true });
      }
      return;
    }

    const row = firstRowIn(document.body);
    attachToTracker(row);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    observationRoot = null;
    pendingRows.clear();
    flushScheduled = false;
    latestToken = null;
  }

  // Observe while settings load, retaining only new notifications.
  start();
  chrome.storage.local.get([MASTER_KEY, SETTING_KEY, 'dsmSettings']).then((data) => {
    if (!changedSettings.has(MASTER_KEY)) masterEnabled = (data[MASTER_KEY] ?? data.dsmSettings?.dsmEnabled) !== false;
    if (!changedSettings.has(SETTING_KEY)) enabled = (data[SETTING_KEY] ?? data.dsmSettings?.officialWalletCopyEnabled) !== false;
  }).catch(() => {}).finally(() => {
    settingsReady = true;
    if (!enabled || !masterEnabled) { stop(); return; }
    start();
    for (const row of pendingRows) enqueueRow(row);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of [MASTER_KEY, SETTING_KEY]) if (changes[key]) changedSettings.add(key);
    if (changes[MASTER_KEY]) masterEnabled = changes[MASTER_KEY].newValue !== false;
    if (changes[SETTING_KEY]) enabled = changes[SETTING_KEY].newValue !== false;
    if (enabled && masterEnabled) start();
    else stop();
  });
})();
