(() => {
  'use strict';

  const SETTING_KEY = 'dsmSetting_officialWalletCopyEnabled';
  const MASTER_KEY = 'dsmSetting_dsmEnabled';
  const RESULT_EVENT = 'dsm-gmgn-wallet-ca-copied';

  // GMGN 官方钱包追踪行的真实 DOM 标记（TrackerListItem.tsx）。
  const TRACKER_ROW_SELECTOR = [
    'a[data-sentry-component="TrackerListItem"][href]',
    'a[data-sentry-source-file="TrackerListItem.tsx"][href]'
  ].join(',');
  const TRACKER_SYMBOL_SELECTOR = '[data-testid="follow-tracking-row-symbol"]';
  const TRACKER_SIDE_SELECTOR = '[data-testid="follow-tracking-row-side"]';
  const TOKEN_ROUTE_RE = /\/(?:token|pump|meme|coin|pair|pool)\/([^/?#]+)/i;
  const CA_RE = /^(?:0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[EU]Q[A-Za-z0-9_-]{46})$/;
  const BUY_SIDE_RE = /建仓|加仓|买入|buy|bought|open|opened|add|added|increase/i;

  let enabled = true;
  let masterEnabled = true;
  let settingsReady = false;
  let observer = null;
  let bootstrapObserver = null;
  let observationRoot = null;
  let lifecycleTimer = null;
  let bodyReadyListener = false;
  let flushScheduled = false;
  let initialized = false;

  const pendingRows = new Set();
  const seenRows = new WeakMap();
  const copyRetries = new WeakMap();
  const recentCopies = new Map();

  function isGMGNPage() {
    return /(^|\.)gmgn\.ai$/i.test(location.hostname || '');
  }

  function normalizeCA(value) {
    const ca = String(value || '').trim().replace(/[。；，,;\])}>'"`]+$/g, '');
    if (!CA_RE.test(ca)) return '';
    return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
  }

  function caFromRow(row) {
    const href = String(row?.getAttribute?.('href') || '');
    const match = href.match(TOKEN_ROUTE_RE);
    if (!match) return '';
    try { return normalizeCA(decodeURIComponent(match[1])); } catch (error) { return normalizeCA(match[1]); }
  }

  function rowFromNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return null;
    const direct = element.matches?.(TRACKER_ROW_SELECTOR)
      ? element
      : element.closest?.(TRACKER_ROW_SELECTOR);
    if (direct && caFromRow(direct)) return direct;

    let symbol = null;
    if (element.matches?.(TRACKER_SYMBOL_SELECTOR)) symbol = element;
    else {
      try { symbol = element.querySelector?.(TRACKER_SYMBOL_SELECTOR); } catch (error) {}
    }
    const fallback = symbol?.closest?.('a[href]');
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

  function isBuyRow(row) {
    const side = String(row?.querySelector?.(TRACKER_SIDE_SELECTOR)?.textContent || '').trim();
    if (side) return BUY_SIDE_RE.test(side);
    return /(?:^|\s)(?:bg-green|text-increase|border-line-green)/i.test(String(row?.className || ''));
  }

  async function copyToClipboard(value) {
    try {
      if (navigator.clipboard?.writeText) {
        const write = navigator.clipboard.writeText(value).then(() => true).catch(() => false);
        const finished = await Promise.race([
          write,
          new Promise((resolve) => setTimeout(() => resolve(false), 180))
        ]);
        if (finished) return true;
      }
    } catch (error) {}

    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    (document.body || document.documentElement).appendChild(area);
    area.focus?.();
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (error) {}
    area.remove();
    return copied;
  }

  async function processRow(row) {
    if (!settingsReady || !enabled || !masterEnabled || !row?.isConnected) return;
    const ca = caFromRow(row);
    if (!ca) return;
    if (!isBuyRow(row)) {
      seenRows.set(row, ca);
      return;
    }
    if (seenRows.get(row) === ca) return;
    seenRows.set(row, ca);

    const previous = recentCopies.get(ca) || 0;
    if (Date.now() - previous < 1500) return;
    recentCopies.set(ca, Date.now());
    for (const [key, at] of recentCopies) if (Date.now() - at > 15000) recentCopies.delete(key);

    const copied = await copyToClipboard(ca);
    if (!copied && !copyRetries.has(row)) {
      copyRetries.set(row, true);
      seenRows.delete(row);
      recentCopies.delete(ca);
      setTimeout(() => processRow(row).catch(() => {}), 180);
      return;
    }
    copyRetries.delete(row);
    try {
      window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { ca, copied } }));
    } catch (error) {}
  }

  function enqueueRow(row) {
    if (!row || !caFromRow(row)) return;
    pendingRows.add(row);
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      const rows = Array.from(pendingRows);
      pendingRows.clear();
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

  function markRowsSeen(rows) {
    for (const row of rows) {
      const ca = caFromRow(row);
      if (ca) seenRows.set(row, ca);
    }
  }

  function seedExistingRows(root) {
    try {
      for (const row of root.querySelectorAll(TRACKER_ROW_SELECTOR)) {
        const ca = caFromRow(row);
        if (ca) seenRows.set(row, ca);
      }
      for (const symbol of root.querySelectorAll(TRACKER_SYMBOL_SELECTOR)) {
        const row = symbol.closest?.('a[href]');
        const ca = caFromRow(row);
        if (row && ca) seenRows.set(row, ca);
      }
    } catch (error) {}
  }

  function attachToTracker(row, processTrigger = false) {
    const root = trackerListRoot(row);
    if (!root) return false;
    observer?.disconnect();
    bootstrapObserver?.disconnect();
    bootstrapObserver = null;
    observationRoot = root;
    seedExistingRows(root);
    observer = new MutationObserver((mutations) => {
      const addedRows = new Set();
      const changedRows = new Set();
      let replacedRows = false;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') collectRows(mutation.target, changedRows);
        for (const node of mutation.addedNodes || []) collectRows(node, addedRows);
        for (const node of mutation.removedNodes || []) {
          if (firstRowIn(node)) replacedRows = true;
        }
      }
      // 切链或重新打开追踪面板时会批量替换历史列表，只做基线记录。
      if (replacedRows && addedRows.size > 1) markRowsSeen(addedRows);
      else for (const row of addedRows) enqueueRow(row);
      for (const row of changedRows) enqueueRow(row);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
    if (processTrigger && initialized) {
      seenRows.delete(row);
      enqueueRow(row);
    }
    initialized = true;
    return true;
  }

  function watchForTracker() {
    if (bootstrapObserver || observer || !document.body) return;
    bootstrapObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          const row = firstRowIn(node);
          if (row && attachToTracker(row, true)) return;
        }
      }
    });
    bootstrapObserver.observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    if (!settingsReady || !enabled || !masterEnabled || !isGMGNPage() || observer) return;
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
    if (row) attachToTracker(row, false);
    else watchForTracker();

    if (lifecycleTimer === null) {
      lifecycleTimer = setInterval(() => {
        if (!enabled || !masterEnabled) return;
        if (observer && observationRoot?.isConnected) return;
        observer?.disconnect();
        observer = null;
        observationRoot = null;
        const current = firstRowIn(document.body);
        if (current) attachToTracker(current, false);
        else watchForTracker();
      }, 1000);
    }
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    bootstrapObserver?.disconnect();
    bootstrapObserver = null;
    observationRoot = null;
    pendingRows.clear();
    flushScheduled = false;
    if (lifecycleTimer !== null) {
      clearInterval(lifecycleTimer);
      lifecycleTimer = null;
    }
  }

  chrome.storage.local.get([MASTER_KEY, SETTING_KEY]).then((data) => {
    masterEnabled = data[MASTER_KEY] !== false;
    enabled = data[SETTING_KEY] !== false;
    settingsReady = true;
    start();
  }).catch(() => {
    settingsReady = true;
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[MASTER_KEY]) masterEnabled = changes[MASTER_KEY].newValue !== false;
    if (changes[SETTING_KEY]) enabled = changes[SETTING_KEY].newValue !== false;
    if (enabled && masterEnabled) start();
    else stop();
  });
})();
