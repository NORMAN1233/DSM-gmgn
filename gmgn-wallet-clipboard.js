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
  let observationRoot = null;
  let bodyReadyListener = false;
  let flushScheduled = false;
  let copyGeneration = 0;
  let copyQueue = Promise.resolve();

  const pendingRows = new Set();
  const rowCopies = new WeakMap();

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

  function isBuyRow(row) {
    const side = String(row?.querySelector?.(TRACKER_SIDE_SELECTOR)?.textContent || '').trim();
    if (side) return BUY_SIDE_RE.test(side);
    return /(?:^|\s)(?:bg-green|text-increase|border-line-green)/i.test(String(row?.className || ''));
  }

  async function copyToClipboard(value) {
    // 同步路径先写入，避免等待异步 API 超时；保留用户原来的焦点和选区。
    const focused = document.activeElement;
    const selection = window.getSelection();
    const ranges = [];
    for (let i = 0; selection && i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i).cloneRange());
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
    focused?.focus?.({ preventScroll: true });
    if (selection && ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    if (copied) return true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'DSM_WALLET_COPY_CA', ca: value });
      return result?.ok === true;
    } catch (error) { return false; }
  }

  async function processRow(row, capturedHref = '') {
    if (!settingsReady || !enabled || !masterEnabled || !row) return;
    const href = capturedHref || String(row.getAttribute?.('href') || '');
    const ca = caFromHref(href);
    if (!ca) return;
    // 未渲染完整的行不能提前记为已处理，后续 side 文本变更还会再检查。
    if (!isBuyRow(row)) return;
    const key = tokenKeyFromHref(href, ca);
    const previous = rowCopies.get(row);
    if (previous?.key === key && (previous.copied || previous.pending)) return;
    // 保存本次预警快照。跨链切换或虚拟列表复用节点后，旧任务仍然有效。
    const snapshot = { key, copied: false, pending: true };
    rowCopies.set(row, snapshot);
    const generation = copyGeneration;
    copyQueue = copyQueue.catch(() => {}).then(async () => {
      let copied = false;
      // 队列串行执行，上一条完成重试后才轮到下一条，不会覆盖后到的 CA。
      for (let attempt = 0; !copied && attempt < 3; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 40));
        if (generation !== copyGeneration || !enabled || !masterEnabled) return;
        try { copied = await copyToClipboard(ca); } catch (error) {}
      }
      snapshot.copied = copied;
      window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { ca, copied } }));
    }).finally(() => {
      snapshot.pending = false;
    });
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
      // GMGN 新记录在顶部：一批消息从旧到新写入，最终保留最上面的 CA。
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
        if (ca) rowCopies.set(row, { key: tokenKeyFromRow(row, ca), copied: true, pending: false });
      }
      for (const symbol of root.querySelectorAll(TRACKER_SYMBOL_SELECTOR)) {
        const row = symbol.closest?.('a[href]');
        const ca = caFromRow(row);
        if (row && ca) rowCopies.set(row, { key: tokenKeyFromRow(row, ca), copied: true, pending: false });
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
            if (mutation.oldValue && caFromHref(mutation.oldValue) && isBuyRow(changed)) {
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
    attachToTracker(row);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    observationRoot = null;
    pendingRows.clear();
    flushScheduled = false;
    copyGeneration += 1;
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
