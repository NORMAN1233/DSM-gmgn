(() => {
  'use strict';

  // GMGN 官方钱包通知会在页面上以 toast / notification 节点动态出现。
  // 这个脚本只处理新出现的通知，不扫描历史列表，避免刷新页面时覆盖用户剪贴板。
  const SETTING_KEY = 'dsmSetting_officialWalletCopyEnabled';
  const MASTER_KEY = 'dsmSetting_dsmEnabled';
  const RESULT_EVENT = 'dsm-gmgn-wallet-ca-copied';
  const CA_RE = /^(?:0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|[EU]Q[A-Za-z0-9_-]{46})$/;
  const GENERIC_ADDRESS_RE = /^(?=.*\d)[A-Za-z0-9_-]{24,128}$/;
  const CA_MATCH_RE = /0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|[EU]Q[A-Za-z0-9_-]{46}/g;
  const WALLET_MARKER_RE = /官方\s*钱包|钱包监控|钱包动态|钱包提醒|wallet(?:[-_\s]*(?:monitor|activity|alert|watch|notification|message|event))?|smart[-_\s]*money|copy[-_\s]*trade|跟单|交易提醒|新交易|买入|卖出|swap|bought|sold|received|sent/i;
  const WALLET_HINT_RE = /官方|wallet[-_\s]*(?:monitor|activity|alert|watch|notification|message|event)|smart[-_\s]*money|copy[-_\s]*trade|钱包|跟单|交易提醒/i;
  const POPUP_MARKER_RE = /toast|notification|notify|alert|popup|snackbar|live[-_]?region/i;
  const POPUP_SELECTOR = [
    '[role="alert"]', '[aria-live="polite"]', '[aria-live="assertive"]',
    '[data-testid*="toast" i]', '[data-testid*="notification" i]',
    '[data-testid*="wallet" i]', '[data-sentry-component*="Notification" i]',
    '[class*="toast" i]', '[class*="notification" i]', '[class*="notify" i]',
    '[class*="popup" i]', '[class*="wallet" i]', '[class*="message" i]'
  ].join(',');
  const MONITOR_PATH_RE = /(?:wallet|monitor|follow|watch|tracker|copy-trade|smart-money)/i;

  let enabled = true;
  let masterEnabled = true;
  let observer = null;
  let toastTimer = null;
  let flushTimer = null;
  let bodyReadyListener = false;
  let scopeTimer = null;
  let walletMonitorActive = false;
  let walletScope = null;
  let observationRoot = null;
  const seenMessages = new WeakSet();
  const recentCopies = new Map();
  const pendingNodes = new Set();

  function cleanText(value) {
    return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function normalizeCA(value, allowUnknown = false) {
    const ca = cleanText(value).replace(/[。；，,;\])}>'"`]+$/g, '');
    if (!CA_RE.test(ca) && !(allowUnknown && GENERIC_ADDRESS_RE.test(ca))) return '';
    return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
  }

  function candidateParts(value) {
    const parts = String(value || '').split(/[/?#=&\s:()[\]{}<>"'`]+/);
    const typed = parts.map((part) => normalizeCA(part)).filter(Boolean);
    if (typed.length) return typed;
    return parts.map((part) => normalizeCA(part, true)).filter(Boolean);
  }

  function refreshWalletScope() {
    if (!document.body) return null;
    if (!MONITOR_PATH_RE.test(location.pathname)) {
      const pageText = cleanText(document.body.textContent).slice(0, 3200);
      if (/钱包|wallet/i.test(pageText) && /追踪|购买|买入|卖出|MC\s*[:：$]|follow|buy|sell|market\s*cap/i.test(pageText)) {
        walletMonitorActive = true;
      }
    } else {
      walletMonitorActive = true;
    }
    if (!walletMonitorActive) return null;

    const tabs = Array.from(document.querySelectorAll(
      'button,[role="tab"],[role="button"],[data-testid*="wallet" i],[class*="wallet" i]'
    ));
    const walletTab = tabs.find((element) => /钱包|wallet/i.test(cleanText(element.textContent)));
    if (!walletTab) return walletScope;

    let current = walletTab;
    for (let depth = 0; current && current !== document.body && depth < 7; depth += 1, current = current.parentElement) {
      const text = cleanText(current.textContent).slice(0, 2600);
      if (!/追踪|购买|买入|卖出|MC\s*[:：$]/i.test(text)) continue;
      let linkCount = 0;
      try { linkCount = current.querySelectorAll('a[href]').length; } catch (error) {}
      if (linkCount > 0) {
        walletScope = current;
        break;
      }
    }
    return walletScope;
  }

  function isInsideWalletScope(element) {
    return !!walletScope?.isConnected && (walletScope === element || walletScope.contains?.(element));
  }

  function extractCA(root) {
    if (!root) return '';
    const nodes = [];
    if (root.nodeType === 1) nodes.push(root);
    try { nodes.push(...root.querySelectorAll('[data-address],[data-ca],[data-mint],[data-token-address],[data-contract-address]')); } catch (error) {}
    for (const node of nodes) {
      for (const attr of ['data-address', 'data-ca', 'data-mint', 'data-token-address', 'data-contract-address']) {
        const direct = normalizeCA(node.getAttribute?.(attr), true);
        if (direct) return direct;
      }
    }

    const links = [];
    if (root.matches?.('a[href]')) links.push(root);
    try { links.push(...root.querySelectorAll('a[href]')); } catch (error) {}
    for (const link of links) {
      const candidates = candidateParts(link.getAttribute('href'));
      if (candidates.length) return candidates[0];
    }

    // 文本兜底：只在已经确认是通知/钱包消息的容器中使用，降低误识别普通长文本的风险。
    const text = String(root.textContent || '');
    const exactTextCandidates = candidateParts(text);
    if (exactTextCandidates.length) return exactTextCandidates[0];
    const matches = text.match(CA_MATCH_RE) || [];
    for (const match of matches) {
      const ca = normalizeCA(match);
      if (ca) return ca;
    }
    return '';
  }

  function visible(element) {
    if (!element?.isConnected) return false;
    try {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
    } catch (error) {
      return true;
    }
  }

  function hintText(element) {
    return [
      element?.id, element?.className, element?.getAttribute?.('role'),
      element?.getAttribute?.('aria-label'), element?.getAttribute?.('data-testid'),
      element?.getAttribute?.('data-sentry-component')
    ].filter((value) => typeof value === 'string').join(' ');
  }

  function isMonitorContext(element) {
    if (walletMonitorActive && isInsideWalletScope(element)) return true;
    if (MONITOR_PATH_RE.test(location.pathname)) return true;
    const text = `${hintText(element)} ${cleanText(element?.textContent).slice(0, 1200)}`;
    return WALLET_MARKER_RE.test(text);
  }

  function popupScore(element) {
    const hints = hintText(element);
    let score = 0;
    if (POPUP_MARKER_RE.test(hints)) score += 3;
    if (WALLET_HINT_RE.test(hints)) score += 4;
    if (element.getAttribute?.('role') === 'alert' || element.hasAttribute?.('aria-live')) score += 4;
    try {
      if (getComputedStyle(element).position === 'fixed') score += 2;
    } catch (error) {}
    return score;
  }

  function findMessageRoot(node) {
    let current = node?.nodeType === 1 ? node : node?.parentElement;
    let best = null;
    let bestScore = 0;
    for (let depth = 0; current && current !== document.body && depth < 9; depth += 1, current = current.parentElement) {
      if (!visible(current)) continue;
      const score = popupScore(current) + (isMonitorContext(current) ? 3 : 0);
      if (score > bestScore) {
        best = current;
        bestScore = score;
      }
      if (bestScore >= 7) break;
    }
    return bestScore >= 3 ? best : null;
  }

  function isOwnNode(node) {
    return !!node?.closest?.('#dsm-gmgn-wallet-copy-toast,[data-dsm-wallet-copy]')
      || node?.id === 'dsm-gmgn-wallet-copy-toast';
  }

  function isPotentialNode(node) {
    if (!node || node.nodeType !== 1 || isOwnNode(node)) return false;
    const hints = hintText(node);
    if (POPUP_MARKER_RE.test(hints) || WALLET_HINT_RE.test(hints)
        || node.getAttribute?.('role') === 'alert' || node.hasAttribute?.('aria-live')) return true;
    if (node.matches?.('a[href]') && candidateParts(node.getAttribute('href')).length) return true;
    for (const attr of ['data-address', 'data-ca', 'data-mint', 'data-token-address', 'data-contract-address']) {
      if (normalizeCA(node.getAttribute?.(attr), true)) return true;
    }
    if (walletMonitorActive && (isInsideWalletScope(node) || !walletScope) && node.childElementCount <= 32) {
      try {
        const link = node.matches?.('a[href]') ? node : node.querySelector('a[href]');
        if (link && candidateParts(link.getAttribute('href')).length) return true;
        const addressNode = node.querySelector('[data-address],[data-ca],[data-mint],[data-token-address],[data-contract-address]');
        if (addressNode && ['data-address', 'data-ca', 'data-mint', 'data-token-address', 'data-contract-address']
          .some((attr) => normalizeCA(addressNode.getAttribute(attr), true))) return true;
      } catch (error) {}
    }
    const text = String(node.textContent || '');
    CA_MATCH_RE.lastIndex = 0;
    const hasTypedCA = CA_MATCH_RE.test(text);
    CA_MATCH_RE.lastIndex = 0;
    return text.length <= 1200 && (hasTypedCA || candidateParts(text).length);
  }

  function enqueueNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element || isOwnNode(element)) return;
    if (isPotentialNode(element)) {
      pendingNodes.add(element);
    } else if (element.childElementCount && element.childElementCount <= 80) {
      // A notification can be inserted inside a small wrapper in one mutation.
      // Probe only the first marked descendant; never enumerate the whole page.
      try {
        const nested = element.querySelector(POPUP_SELECTOR);
        if (nested) pendingNodes.add(nested);
      } catch (error) {}
    }
    if (!pendingNodes.size || flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const nodes = Array.from(pendingNodes);
      pendingNodes.clear();
      const roots = new Set();
      for (const candidate of nodes) {
        const root = findMessageRoot(candidate);
        if (root) roots.add(root);
      }
      for (const root of roots) processMessage(root).catch(() => {});
    }, 0);
  }

  function showCopyToast(ca, ok) {
    const id = 'dsm-gmgn-wallet-copy-toast';
    document.getElementById(id)?.remove();
    const toast = document.createElement('div');
    toast.id = id;
    toast.dataset.dsmWalletCopy = '1';
    toast.textContent = ok ? `官方钱包 CA 已复制：${ca.slice(0, 8)}…${ca.slice(-6)}` : '官方钱包 CA 复制失败';
    toast.style.cssText = 'position:fixed;z-index:2147483647;right:18px;top:72px;max-width:360px;padding:9px 12px;border:1px solid ' + (ok ? '#79d99a' : '#ff7b86') + ';background:#0c1719ee;color:' + (ok ? '#b9ffd0' : '#ffb5bc') + ';font:12px/1.4 system-ui,sans-serif;pointer-events:none;box-shadow:0 5px 18px #0008;';
    (document.documentElement || document.body).appendChild(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 2400);
  }

  async function copyToClipboard(value) {
    try {
      if (navigator.clipboard?.writeText) {
        const write = navigator.clipboard.writeText(value).then(() => true).catch(() => false);
        const finished = await Promise.race([
          write,
          new Promise((resolve) => setTimeout(() => resolve(false), 350))
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

  async function processMessage(root) {
    if (!enabled || !masterEnabled || !root || seenMessages.has(root)) return;
    const ca = extractCA(root);
    if (!ca || !isMonitorContext(root)) return;
    seenMessages.add(root);
    const previous = recentCopies.get(ca) || 0;
    if (Date.now() - previous < 1500) return;
    recentCopies.set(ca, Date.now());
    for (const [key, at] of recentCopies) if (Date.now() - at > 15000) recentCopies.delete(key);
    const copied = await copyToClipboard(ca);
    showCopyToast(ca, copied);
    try {
      window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { ca, copied } }));
    } catch (error) {}
  }

  function seedExistingMessages() {
    try {
      for (const node of document.querySelectorAll(POPUP_SELECTOR)) {
        const root = findMessageRoot(node);
        if (root && extractCA(root)) seenMessages.add(root);
      }
    } catch (error) {}
    if (!walletScope) return;
    try {
      for (const link of walletScope.querySelectorAll('a[href]')) {
        if (!candidateParts(link.getAttribute('href')).length) continue;
        const root = findMessageRoot(link) || link;
        seenMessages.add(root);
      }
    } catch (error) {}
  }

  function start() {
    if (observer || !enabled || !masterEnabled || !document.documentElement) return;
    refreshWalletScope();
    observationRoot = walletScope || document.body;
    if (!observationRoot) {
      if (!bodyReadyListener) {
        bodyReadyListener = true;
        document.addEventListener('DOMContentLoaded', () => {
          bodyReadyListener = false;
          start();
        }, { once: true });
      }
      return;
    }
    seedExistingMessages();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          enqueueNode(node);
        }
      }
    });
    observer.observe(observationRoot, { childList: true, subtree: true });
    if (scopeTimer === null && walletMonitorActive) {
      scopeTimer = setInterval(() => {
        if (!observer || !enabled || !masterEnabled) return;
        const previous = observationRoot;
        refreshWalletScope();
        const next = walletScope || document.body;
        if (next && next !== previous) {
          observer.disconnect();
          observationRoot = next;
          observer.observe(observationRoot, { childList: true, subtree: true });
          seedExistingMessages();
        }
      }, 3000);
    }
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingNodes.clear();
    if (scopeTimer !== null) {
      clearInterval(scopeTimer);
      scopeTimer = null;
    }
    observationRoot = null;
  }

  chrome.storage.local.get([MASTER_KEY, SETTING_KEY]).then((data) => {
    masterEnabled = data[MASTER_KEY] !== false;
    enabled = data[SETTING_KEY] !== false;
    start();
  }).catch(() => start());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[MASTER_KEY]) masterEnabled = changes[MASTER_KEY].newValue !== false;
    if (changes[SETTING_KEY]) enabled = changes[SETTING_KEY].newValue !== false;
    if (enabled && masterEnabled) start();
    else stop();
  });
})();
