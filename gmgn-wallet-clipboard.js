(() => {
  'use strict';

  // 监听 GMGN 官方钱包/追踪面板中新出现的购买信息，只处理新行，
  // 不扫描历史列表，避免刷新页面时覆盖用户剪贴板。
  const SETTING_KEY = 'dsmSetting_officialWalletCopyEnabled';
  const MASTER_KEY = 'dsmSetting_dsmEnabled';
  const RESULT_EVENT = 'dsm-gmgn-wallet-ca-copied';
  const CA_RE = /^(?:0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|[EU]Q[A-Za-z0-9_-]{46})$/;
  const GENERIC_ADDRESS_RE = /^(?=.*\d)[A-Za-z0-9_-]{24,128}$/;
  const CA_MATCH_RE = /0x[a-fA-F0-9]{40,128}|[1-9A-HJ-NP-Za-km-z]{32,44}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|[EU]Q[A-Za-z0-9_-]{46}/g;
  const TOKEN_ROUTE_RE = /\/(?:token|pump|meme|coin|pair|pool)(?:\/|$)|[?&#](?:token|mint|contract|ca)=/i;
  const WALLET_ROUTE_RE = /\/(?:address|wallet|user|account|profile|trader|follow|watchlist)(?:\/|$)/i;
  const TOKEN_ATTRS = ['data-ca', 'data-mint', 'data-token-address', 'data-contract-address'];
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
  let flushTimer = null;
  let bodyReadyListener = false;
  let scopeTimer = null;
  let walletMonitorActive = false;
  let walletScope = null;
  let observationRoot = null;
  // 以“行节点 -> 最近一次 CA”去重；GMGN 会复用同一行节点更新下一笔交易。
  const seenMessages = new WeakMap();
  const recentCopies = new Map();
  const pendingNodes = new Set();

  function cleanText(value) {
    return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function isGMGNPage() {
    return /(^|\.)gmgn\.ai$/i.test(location.hostname || '');
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
    const pathSuggestsMonitor = MONITOR_PATH_RE.test(location.pathname);
    if (!pathSuggestsMonitor && walletScope?.isConnected) {
      walletMonitorActive = true;
      return walletScope;
    }
    const tabs = Array.from(document.querySelectorAll(
      'button,[role="tab"],[role="button"],[data-testid*="wallet" i],[data-testid*="follow" i],[class*="wallet" i],[class*="follow" i]'
    ));
    const walletTab = tabs.find((element) => /钱包|wallet/i.test(cleanText(element.textContent)));
    const tabContext = cleanText(walletTab?.parentElement?.textContent).slice(0, 2600);
    const tabSuggestsMonitor = /追踪|购买|买入|卖出|MC\s*[:：$]|follow|buy|sell|market\s*cap/i.test(tabContext);
    walletMonitorActive = pathSuggestsMonitor || tabSuggestsMonitor;
    if (!walletMonitorActive) {
      walletScope = null;
      return null;
    }
    if (!walletTab) {
      if (pathSuggestsMonitor) {
        walletScope = null;
        return null;
      }
      walletMonitorActive = false;
      walletScope = null;
      return null;
    }

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

    // GMGN 每条购买信息通常同时包含“钱包地址链接”和“代币链接”。
    // data-address 优先指向钱包，只有明确位于代币节点/代币链接下时才允许使用。
    for (const node of nodes) {
      for (const attr of TOKEN_ATTRS) {
        const direct = normalizeCA(node.getAttribute?.(attr), true);
        if (direct) return direct;
      }
      const walletAddress = normalizeCA(node.getAttribute?.('data-address'), true);
      if (walletAddress) {
        const ownerLink = node.closest?.('a[href]');
        const nodeHints = `${hintText(node)} ${hintText(node.parentElement)}`;
        if (ownerLink && TOKEN_ROUTE_RE.test(ownerLink.getAttribute('href') || '')) return walletAddress;
        if (/token|mint|contract|coin|pair|pool/i.test(nodeHints)) return walletAddress;
      }
    }

    const links = [];
    if (root.matches?.('a[href]')) links.push(root);
    try { links.push(...root.querySelectorAll('a[href]')); } catch (error) {}
    const tokenLinks = links
      .filter((link) => TOKEN_ROUTE_RE.test(link.getAttribute('href') || ''))
      .sort((left, right) => {
        const leftHints = hintText(left);
        const rightHints = hintText(right);
        return Number(/token|mint|contract|coin|pair|pool/i.test(rightHints))
          - Number(/token|mint|contract|coin|pair|pool/i.test(leftHints));
      });
    for (const link of tokenLinks) {
      const candidates = candidateParts(link.getAttribute('href'));
      if (candidates.length) return candidates[0];
    }

    // 文本兜底只接受严格 CA，并排除钱包链接中的地址；如果剩余多个候选则放弃，
    // 宁可不复制，也不能把钱包地址误当成代币 CA。
    const text = String(root.textContent || '');
    const blocked = new Set();
    for (const link of links) {
      if (!WALLET_ROUTE_RE.test(link.getAttribute('href') || '')) continue;
      for (const candidate of candidateParts(link.getAttribute('href'))) blocked.add(candidate);
    }
    const exactTextCandidates = [...new Set((text.match(CA_MATCH_RE) || [])
      .map((match) => normalizeCA(match)).filter(Boolean))]
      .filter((candidate) => !blocked.has(candidate));
    return exactTextCandidates.length === 1 ? exactTextCandidates[0] : '';
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

  function tokenLinksIn(root) {
    const links = [];
    if (root?.matches?.('a[href]') && TOKEN_ROUTE_RE.test(root.getAttribute('href') || '')) links.push(root);
    try {
      for (const link of root?.querySelectorAll?.('a[href]') || []) {
        if (TOKEN_ROUTE_RE.test(link.getAttribute('href') || '')) links.push(link);
        if (links.length > 2) break;
      }
    } catch (error) {}
    return links;
  }

  function findMessageRoot(node) {
    let current = node?.nodeType === 1 ? node : node?.parentElement;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1, current = current.parentElement) {
      const tokenLinks = tokenLinksIn(current);
      // 返回代币链接本身，避免把整个钱包面板当成一条消息。
      if (tokenLinks.length === 1) return tokenLinks[0];
      if (current === walletScope) break;
    }
    // Toast/通知可能不在钱包面板内，保留一个轻量的上下文兜底。
    current = node?.nodeType === 1 ? node : node?.parentElement;
    for (let depth = 0; current && current !== document.body && depth < 6; depth += 1, current = current.parentElement) {
      if (tokenLinksIn(current).length && (popupScore(current) >= 3 || isMonitorContext(current))) return current;
    }
    return null;
  }

  function isOwnNode(node) {
    return !!node?.closest?.('[data-dsm-wallet-copy]') || node?.hasAttribute?.('data-dsm-wallet-copy');
  }

  function isPotentialNode(node) {
    if (!node || node.nodeType !== 1 || isOwnNode(node)) return false;
    const hints = hintText(node);
    if (POPUP_MARKER_RE.test(hints) || (!walletScope && WALLET_HINT_RE.test(hints))
        || node.getAttribute?.('role') === 'alert' || node.hasAttribute?.('aria-live')) return true;
    if (node.matches?.('a[href]') && TOKEN_ROUTE_RE.test(node.getAttribute('href') || '')
        && candidateParts(node.getAttribute('href')).length) return true;
    for (const attr of TOKEN_ATTRS) {
      if (normalizeCA(node.getAttribute?.(attr), true)) return true;
    }
    if (normalizeCA(node.getAttribute?.('data-address'), true)) {
      const ownerLink = node.closest?.('a[href]');
      if (ownerLink && TOKEN_ROUTE_RE.test(ownerLink.getAttribute('href') || '')) return true;
    }
    if (walletMonitorActive && (isInsideWalletScope(node) || !walletScope) && node.childElementCount <= 32) {
      try {
        const link = node.matches?.('a[href]') && TOKEN_ROUTE_RE.test(node.getAttribute('href') || '')
          ? node
          : Array.from(node.querySelectorAll('a[href]')).find((candidate) => TOKEN_ROUTE_RE.test(candidate.getAttribute('href') || ''));
        if (link && candidateParts(link.getAttribute('href')).length) return true;
        const addressNode = node.querySelector('[data-address],[data-ca],[data-mint],[data-token-address],[data-contract-address]');
        if (addressNode && TOKEN_ATTRS
          .some((attr) => normalizeCA(addressNode.getAttribute(attr), true))) return true;
      } catch (error) {}
    }
    const text = String(node.textContent || '');
    CA_MATCH_RE.lastIndex = 0;
    const hasTypedCA = CA_MATCH_RE.test(text);
    CA_MATCH_RE.lastIndex = 0;
    return text.length <= 1200 && hasTypedCA;
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

  async function copyToClipboard(value) {
    try {
      if (navigator.clipboard?.writeText) {
        const write = navigator.clipboard.writeText(value).then(() => true).catch(() => false);
        const finished = await Promise.race([
          write,
          // Clipboard API 在 GMGN 页面通常会立即完成；失败时尽快切到同步兜底，
          // 避免自动复制被无响应的权限请求拖慢。
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

  async function processMessage(root) {
    if (!enabled || !masterEnabled || !root) return;
    const ca = extractCA(root);
    if (!ca || !isMonitorContext(root)) return;
    if (seenMessages.get(root) === ca) return;
    seenMessages.set(root, ca);
    const previous = recentCopies.get(ca) || 0;
    if (Date.now() - previous < 1500) return;
    recentCopies.set(ca, Date.now());
    for (const [key, at] of recentCopies) if (Date.now() - at > 15000) recentCopies.delete(key);
    const copied = await copyToClipboard(ca);
    try {
      window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { ca, copied } }));
    } catch (error) {}
  }

  function seedExistingMessages() {
    try {
      for (const node of document.querySelectorAll(POPUP_SELECTOR)) {
        const root = findMessageRoot(node);
        const ca = root && extractCA(root);
        if (root && ca) seenMessages.set(root, ca);
      }
    } catch (error) {}
    if (!walletScope) return;
    try {
      for (const link of walletScope.querySelectorAll('a[href]')) {
        if (!TOKEN_ROUTE_RE.test(link.getAttribute('href') || '')
            || !candidateParts(link.getAttribute('href')).length) continue;
        const root = findMessageRoot(link) || link;
        const ca = extractCA(root);
        if (ca) seenMessages.set(root, ca);
      }
    } catch (error) {}
  }

  function start() {
    if (observer || !enabled || !masterEnabled || !document.documentElement || !isGMGNPage()) return;
    refreshWalletScope();
    if (!walletMonitorActive) {
      if (scopeTimer === null) {
        scopeTimer = setInterval(() => {
          if (!enabled || !masterEnabled || observer) return;
          refreshWalletScope();
          if (walletMonitorActive) start();
        }, 3000);
      }
      return;
    }
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
        if (mutation.type === 'attributes') enqueueNode(mutation.target);
      }
    });
    observer.observe(observationRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-ca', 'data-mint', 'data-token-address', 'data-contract-address', 'data-address']
    });
    if (scopeTimer === null) {
      scopeTimer = setInterval(() => {
        if (!enabled || !masterEnabled) return;
        const previous = observationRoot;
        refreshWalletScope();
        const next = walletMonitorActive ? (walletScope || (MONITOR_PATH_RE.test(location.pathname) ? document.body : null)) : null;
        if (next && next !== previous) {
          observer.disconnect();
          observer = null;
          observationRoot = next;
          start();
        } else if (!next && observer) {
          observer.disconnect();
          observer = null;
          observationRoot = null;
          pendingNodes.clear();
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
