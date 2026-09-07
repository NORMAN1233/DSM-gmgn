'use strict';

// DSM-gmgn v2.9.5 — GMGN/Axiom trading helpers + GMGN Edge-TTS playback.
const recentSpeech = new Map();
const DEDUPE_MS = 60 * 1000;
let lastSearchTargetTabId = null;
let creatingOffscreen = null;
let offscreenReady = false;
let ttsRequestSeq = 0;
const LOG_KEY = 'dsmRuntimeLogsV1';
const LOG_LIMIT = 120;
let logWriteQueue = Promise.resolve();
const SUPPORTED_TAB_URLS = [
  'https://gmgn.ai/*',
  'https://*.gmgn.ai/*',
  'https://axiom.trade/*',
  'https://*.axiom.trade/*'
];
const AXIOM_TAB_URLS = [
  'https://axiom.trade/*',
  'https://*.axiom.trade/*'
];
const TOKEN_CA_RE = /^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

function normalizeTokenCA(value) {
  const ca = String(value || '').trim();
  if (!TOKEN_CA_RE.test(ca)) return '';
  return /^0x/i.test(ca) ? ca.toLowerCase() : ca;
}

function appendRuntimeLog(entry = {}) {
  const record = {
    at: Date.now(),
    level: ['success', 'warn', 'error', 'info'].includes(entry.level) ? entry.level : 'info',
    category: String(entry.category || '系统').slice(0, 20),
    title: String(entry.title || '运行事件').slice(0, 80),
    detail: String(entry.detail || '').slice(0, 240)
  };
  // 串行、限量写入；日志只在关键事件发生时记录，不增加页面轮询或 DOM 工作。
  logWriteQueue = logWriteQueue.then(async () => {
    const data = await chrome.storage.local.get(LOG_KEY);
    const logs = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
    logs.push(record);
    await chrome.storage.local.set({ [LOG_KEY]: logs.slice(-LOG_LIMIT) });
  }).catch(() => {});
}

const EDGE_TTS_VOICES = new Set([
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-XiaoyiNeural',
  'en-US-AvaMultilingualNeural'
]);

function pruneRecent(now) {
  for (const [key, ts] of recentSpeech) {
    if (now - ts > DEDUPE_MS) recentSpeech.delete(key);
  }
}

// v2.9.3 同文冷却（跨标签/跨帧兜底）：同一条推文会以不同指纹从不同标签页/帧
// 反复到达，60s 的 key 去重挡不住；同一句播报文本在冷却窗内再次出现必是重发，
// 直接静默。判断要在合成开始前做，顺序与 recentSpeech 一致。
const recentTexts = new Map();
const TEXT_COOLDOWN_MS = 25 * 1000;

function shouldSpeakText(text, now) {
  for (const [spoken, ts] of recentTexts) {
    if (now - ts > TEXT_COOLDOWN_MS) recentTexts.delete(spoken);
  }
  if (recentTexts.has(text)) return false;
  recentTexts.set(text, now);
  return true;
}

const GREEK_CAPS_TO_LATIN = {
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K',
  'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  // Ξ（Xi，三横）在花式昵称里视觉上替代的是 E（如 DΞGEN=DEGEN），不是 X。
  'Ξ': 'E', 'Λ': 'A'
};

function normalizeLatinNamePronunciation(value) {
  let text = String(value || '');
  // Stylized names often swap Greek capitals for Latin lookalikes (e.g.
  // "DΞGEN"). Normalize them first or the voice spells the odd characters.
  text = text.replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧΞΛ]/g, (ch) => GREEK_CAPS_TO_LATIN[ch] || ch);
  // Stylized display names such as "D E G E N" make Edge-TTS announce every
  // letter. Join runs of 3+ isolated letters before applying normal casing.
  text = text.replace(
    /(^|[\s，、])((?:[A-Za-z][\s._-]+){2,}[A-Za-z])(?=$|[\s，。！？、,.!?：:；;])/g,
    (match, prefix, letters) => `${prefix}${letters.replace(/[^A-Za-z]/g, '')}`
  );
  // Chinese voices mishandle bare CJK-Latin junctions ("PEPE king发推啦");
  // keep a single space so each script segments and reads as words.
  text = text.replace(/([A-Za-z])([\u3400-\u9FFF])/g, '$1 $2')
    .replace(/([\u3400-\u9FFF])([A-Za-z])/g, '$1 $2');
  // Azure/Edge voices commonly treat ALL-CAPS words as acronyms and spell them
  // letter by letter. Title-case caps tokens of 3+ chars (digits allowed after
  // the first letter, e.g. FOMO3 → Fomo3) so they sound like words. Short forms
  // such as AI remain untouched.
  return text.replace(/\b[A-Z][A-Z0-9]{2,}\b/g, (word) => `${word[0]}${word.slice(1).toLowerCase()}`);
}

function sanitizeSpeechText(value, keepPauses = false) {
  let text = String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, ' ');
  try {
    const emojiCluster = /(?:[0-9#*]\uFE0F?\u20E3|[\p{Regional_Indicator}]{2}|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/gu;
    text = text.replace(emojiCluster, ' ').replace(
      keepPauses ? /[^\p{L}\p{N}\s，。！？、,.!?：:；;]/gu : /[^\p{L}\p{N}\s]/gu,
      ' '
    );
  } catch (error) {
    text = text.replace(/[0-9#*]\uFE0F?\u20E3/g, ' ')
      .replace(/[\u2600-\u27BF]/g, ' ')
      .replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]/g, ' ')
      .replace(keepPauses
        ? /[^A-Za-z0-9\u3400-\u9FFF\s，。！？、,.!?：:；;]/g
        : /[^A-Za-z0-9\u3400-\u9FFF\s]/g, ' ');
  }
  text = normalizeLatinNamePronunciation(text.replace(/\s+/g, ' ').trim());
  if (keepPauses) {
    // NFKC converts full-width commas to ASCII. Restore Chinese pause marks so
    // Chinese voices reliably leave a beat around the display name.
    text = text.replace(/,/g, '，').replace(/!/g, '！').replace(/\?/g, '？')
      .replace(/:/g, '：').replace(/;/g, '；');
  }
  return text.slice(0, keepPauses ? 120 : 80);
}

function normalizeEdgeVoice(value) {
  const voice = String(value || '').trim();
  return EDGE_TTS_VOICES.has(voice) ? voice : 'zh-CN-XiaoxiaoNeural';
}

function normalizeEdgeRate(value) {
  let percent = Number(value);
  if (!Number.isFinite(percent)) percent = 115;
  if (percent > 0 && percent < 3) percent *= 100;
  percent = Math.min(200, Math.max(50, Math.round(percent)));
  const delta = percent - 100;
  return `${delta >= 0 ? '+' : ''}${delta}%`;
}

async function ensureOffscreenDocument() {
  // Fast path: avoid enumerating extension contexts for every spoken name.
  if (offscreenReady) return true;
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) { offscreenReady = true; return true; }
  } catch (error) {
    // Chrome <116 fallback: createDocument will fail harmlessly if one already exists.
  }
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play Cloudflare Edge-TTS MP3 alerts while the GMGN tab is in the background.'
  }).then(() => { offscreenReady = true; return true; }).catch(async (error) => {
    if (/single offscreen|already exists/i.test(String(error?.message || error))) { offscreenReady = true; return true; }
    throw error;
  }).finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

async function sendEdgeTtsCommand(payload = {}, timeoutMs = 20000, retry = true, messageType = 'DSM_EDGE_TTS_COMMAND') {
  await ensureOffscreenDocument();
  const requestId = `tts-${Date.now()}-${++ttsRequestSeq}`;
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value || { ok: false, reason: 'empty-response' });
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'edge-tts-timeout' }), timeoutMs);
    try {
      chrome.runtime.sendMessage({
        type: messageType,
        target: 'offscreen',
        requestId,
        payload
      }, (response) => {
        if (chrome.runtime.lastError) {
          done({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        done(response);
      });
    } catch (error) {
      done({ ok: false, reason: String(error?.message || error) });
    }
  });
  // Chrome may reclaim an idle offscreen page. Recreate and retry once.
  if (retry && !result?.ok && /receiving end|message port|context invalid|offscreen/i.test(String(result?.reason || ''))) {
    offscreenReady = false;
    return sendEdgeTtsCommand(payload, timeoutMs, false);
  }
  return result;
}

async function speakEdgeTts(text, message, preview = false) {
  const clean = sanitizeSpeechText(text, true);
  if (!clean) return { ok: false, reason: 'empty' };
  // 实测排查入口：Service Worker 控制台可见最终送进 TTS 的文本。
  console.debug('[DSM-TTS]', JSON.stringify(clean), preview ? '(preview)' : '');
  return sendEdgeTtsCommand({
    text: clean,
    voice: normalizeEdgeVoice(message.voiceName),
    rate: normalizeEdgeRate(message.rate),
    pitch: '+0%',
    volume: Math.min(1, Math.max(0, Number(message.volume) || 0)),
    interrupt: preview || message.enqueue === false
  }, 20000);
}

// ---------- 倒计时配音（5·4·3·2·1 与「时间到」，offscreen 独立声道） ----------
const COUNTDOWN_LOG_THROTTLE_MS = 30000;
let lastCountdownLogAt = 0;

function countdownClipText(kind, value) {
  if (kind === 'timeout') return '时间到';
  return String(Math.min(60, Math.max(1, Number(value) || 0)));
}

async function handleCountdownMessage(message) {
  const payload = {
    voice: normalizeEdgeVoice(message.voiceName),
    rate: normalizeEdgeRate(message.rate),
    pitch: '+0%',
    volume: Math.min(1, Math.max(0, Number(message.volume) || 0))
  };
  if (message.type === 'DSM_COUNTDOWN_PREFETCH') {
    // 进 K 线页时按当前设定秒数预合成 n1..nN 全部片段；已缓存的由 offscreen 侧跳过
    payload.prefetch = true;
    payload.maxValue = Math.min(60, Math.max(1, Number(message.maxValue) || 5));
    await sendEdgeTtsCommand(payload, 20000, true, 'DSM_COUNTDOWN_COMMAND');
    return;
  }
  payload.kind = message.kind === 'timeout' ? 'timeout' : 'number';
  payload.value = Number(message.value) || 0;
  payload.text = countdownClipText(payload.kind, payload.value);
  const result = await sendEdgeTtsCommand(payload, 20000, true, 'DSM_COUNTDOWN_COMMAND');
  if (!result?.ok) {
    // 每秒一拍的配音不逐条进日志；失败按 30s 节流记录，避免刷爆 120 条上限
    const now = Date.now();
    if (now - lastCountdownLogAt >= COUNTDOWN_LOG_THROTTLE_MS) {
      lastCountdownLogAt = now;
      appendRuntimeLog({
        level: 'error',
        category: '倒计时配音',
        title: '配音播放失败',
        detail: `${payload.text} · ${result?.reason || '未知原因'}`
      });
    }
  }
}

function sendTabMessage(tabId, message, timeoutMs = 650) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { done(null); return; }
        done(response || null);
      });
    } catch (error) {
      clearTimeout(timer);
      done(null);
    }
  });
}

async function findCrossTabSearchTarget(senderTab, preferredPlatform = 'gmgn') {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SUPPORTED_TAB_URLS });
  } catch (error) {
    return { target: null, probes: [] };
  }

  const senderId = senderTab?.id;
  const senderWindowId = senderTab?.windowId;
  // Prefer another window for the user's dual-screen setup, but keep the
  // sender tab as a fallback so the same feature also works on a one-screen
  // MacBook with only one GMGN page open.
  const candidates = tabs.filter((tab) => tab?.id != null);
  const probed = await Promise.all(candidates.map(async (tab) => {
    const probe = await sendTabMessage(tab.id, { type: 'DSM_PROBE_GMGN_SEARCH_TARGET' }, 500);
    const matched = !!probe?.hasGlobalSearch && probe.platform === preferredPlatform;
    let score = -1;
    if (matched) {
      score = 0;
      if (tab.id === lastSearchTargetTabId && tab.id !== senderId) score += 1000;
      if (senderWindowId != null && tab.windowId !== senderWindowId) score += 320;
      if (tab.id !== senderId) score += 80;
      if (tab.active) score += 160;
      if (probe.visible) score += 120;
      if (probe.focused) score += 40;
      if (/\/(?:token|pump|meme|t|trade)\//i.test(probe.href || tab.url || '')) score -= 40;
    }
    // v2.9.5：连同未命中的标签页一起返回探测摘要——失败时日志能写明是哪一屏
    // 没响应（重载扩展后的孤儿脚本，刷新即愈）还是哪一页真没有搜索框。
    return { tab, probe: probe || null, score, matched };
  }));
  const target = probed.filter((entry) => entry.matched).sort((a, b) => b.score - a.score)[0] || null;
  const probes = probed.map((entry) => ({
    responded: !!entry.probe,
    hasGlobalSearch: entry.probe?.hasGlobalSearch === true,
    platform: entry.probe?.platform || '',
    href: entry.probe?.href || entry.tab.url || '',
    piInputCount: entry.probe?.piInputCount
  }));
  // v2.9.5：探针全灭时的尽力目标。重载扩展后 GMGN 标签页里的旧内容脚本会
  // 变成孤儿——探针不应答、但 chrome.scripting 注入不依赖内容脚本，照样能
  // 搜；目标选择交给注入函数自带的启动器判定兜底。
  const isGmgnTab = (tab) => {
    try {
      return /(^|\.)gmgn\.ai$/i.test(new URL(tab.url || '').hostname);
    } catch (error) {
      return false;
    }
  };
  const rankBestEffort = (entry) => (entry.tab.id === lastSearchTargetTabId ? 800 : 0)
    + (entry.tab.id !== senderId ? 80 : 0)
    + (senderWindowId != null && entry.tab.windowId !== senderWindowId ? 320 : 0)
    + (entry.tab.active ? 160 : 0);
  const bestEffortTab = preferredPlatform === 'gmgn'
    ? probed.filter((entry) => isGmgnTab(entry.tab)).sort((a, b) => rankBestEffort(b) - rankBestEffort(a))[0]?.tab || null
    : null;
  return { target, probes, bestEffortTab };
}

async function findAxiomNavigationTarget(senderTab) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: AXIOM_TAB_URLS });
  } catch (error) {
    return null;
  }

  const senderId = senderTab?.id;
  const senderWindowId = senderTab?.windowId;
  const scored = tabs.filter((tab) => tab?.id != null).map((tab) => {
    let score = 0;
    if (tab.id === lastSearchTargetTabId && tab.id !== senderId) score += 1000;
    if (senderWindowId != null && tab.windowId !== senderWindowId) score += 320;
    if (tab.id !== senderId) score += 80;
    if (tab.active) score += 160;
    if (tab.status === 'complete') score += 20;
    return { tab, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0] || null;
}

async function navigateAxiomTokenDetails(target, ca) {
  if (!target?.tab?.id || !ca) return { ok: false, action: 'detail', platform: 'axiom', reason: 'invalid-axiom-navigation' };
  try {
    // Keep the already authenticated Axiom document alive. A direct tabs.update
    // to /meme/{CA} performs a full document request, which can land on Axiom's
    // Cloudflare shell as a blank page. Activate the tab, then let Axiom's own
    // search result drive its client-side router to the canonical detail URL.
    await chrome.tabs.update(target.tab.id, { active: true });
    const routed = await executeRealAxiomSearch(target.tab.id, ca, true);
    if (!routed?.ok || !routed?.opened) {
      return {
        ok: false,
        action: 'detail',
        platform: 'axiom',
        reason: routed?.reason || 'axiom-detail-navigation-failed'
      };
    }
    return {
      ok: true,
      action: 'detail',
      platform: 'axiom',
      targetTabId: target.tab.id,
      targetWindowId: target.tab.windowId,
      targetUrl: routed.url || '',
      resolvedHref: routed.resolvedHref || ''
    };
  } catch (error) {
    return { ok: false, action: 'detail', platform: 'axiom', reason: String(error?.message || error || 'axiom-navigation-failed') };
  }
}

async function executeRealGmgnSearch(tabId, query) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [query],
      func: async (rawQuery) => {
        const q = String(rawQuery || '').trim().slice(0, 80);
        if (!q) return { ok: false, reason: 'empty' };

        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (el) => {
          if (!el || !el.isConnected) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 20 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const firstVisible = (selectors) => {
          for (const selector of selectors) {
            const node = Array.from(document.querySelectorAll(selector)).find(visible);
            if (node) return node;
          }
          return null;
        };

        // The small header field is only the launcher. The real controlled
        // search field lives inside GMGN's pi-modal-body after the launcher is
        // activated (DOM supplied by user, 2026-08):
        // <input name="new-search-input" placeholder="搜名称, 代码, 合约地址, KOL昵称或推特号">
        const findLauncher = () => {
          const launcher = firstVisible([
            '[data-sentry-component="Search"] input.pi-input[placeholder*="搜索代币名"][placeholder*="合约"][placeholder*="钱包"]',
            '[data-sentry-component="Search"] input.pi-input[placeholder*="Search name"]',
            'input.pi-input[placeholder*="搜索代币名"]',
            'input.pi-input[placeholder*="Search name"]',
            // v2.9.5 兜底：GMGN 改占位词时，搜索组件标记仍在即可识别。
            '[data-sentry-component="Search"] input'
          ]);
          if (!launcher) return null;
          // v2.9.4：不再强求页头位置（top<180）。目标页滚动后头部非吸顶、或被
          // 搜索弹窗遮挡时旧判定直接哑火；占位词本身已足以锁定 GMGN 搜索框。
          return launcher;
        };
        const modalInputCandidates = () => Array.from(document.querySelectorAll([
          '.pi-modal-body input[name="new-search-input"]',
          '[role="dialog"] input[name="new-search-input"]',
          '.pi-modal-body input[placeholder*="搜名称"]',
          '[role="dialog"] input[placeholder*="搜名称"]'
        ].join(','))).filter(visible);
        const modalRootFor = (input) => input?.closest('.pi-modal-body, [role="dialog"]') || null;

        const nativeSet = (input, value) => {
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const oldValue = input.value;
          if (setter) setter.call(input, value);
          else input.value = value;
          try { input._valueTracker?.setValue?.(oldValue); } catch (error) {}
          return oldValue;
        };
        const findReactHandler = (input, handlerName) => {
          try {
            // First inspect the real DOM input and a few host parents. Depending
            // on the GMGN build, onChange can live on the input itself or on a
            // small wrapper component.
            let dom = input;
            for (let depth = 0; dom && depth < 4; depth += 1, dom = dom.parentElement) {
              const keys = Object.keys(dom);
              const propsKey = keys.find((name) => name.startsWith('__reactProps$'));
              const direct = propsKey ? dom[propsKey] : null;
              if (typeof direct?.[handlerName] === 'function') return direct[handlerName];

              const fiberKey = keys.find((name) => name.startsWith('__reactFiber$'));
              let fiber = fiberKey ? dom[fiberKey] : null;
              for (let i = 0; fiber && i < 8; i += 1, fiber = fiber.return) {
                if (typeof fiber.memoizedProps?.[handlerName] === 'function') {
                  return fiber.memoizedProps[handlerName];
                }
                if (typeof fiber.pendingProps?.[handlerName] === 'function') {
                  return fiber.pendingProps[handlerName];
                }
              }
            }
          } catch (error) {}
          return null;
        };
        const callReact = (input, handlerName, nativeEvent) => {
          const fn = findReactHandler(input, handlerName);
          if (typeof fn !== 'function') return false;
          try {
            fn({
              type: nativeEvent?.type || handlerName.slice(2).toLowerCase(),
              target: input,
              currentTarget: input,
              nativeEvent,
              bubbles: true,
              cancelable: true,
              defaultPrevented: false,
              timeStamp: performance.now(),
              preventDefault() {},
              stopPropagation() {},
              persist() {},
              isDefaultPrevented: () => false,
              isPropagationStopped: () => false
            });
            return true;
          } catch (error) {
            return false;
          }
        };
        const focusElement = (input) => {
          try { input.focus({ preventScroll: true }); } catch (error) { try { input.focus(); } catch (e) {} }
          try { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true })); } catch (error) {}
          try { input.click(); } catch (error) {}
          try { callReact(input, 'onFocus', new FocusEvent('focus')); } catch (error) {}
        };
        const editLikeUser = (input, value) => {
          // Chromium's editing command runs through the browser's normal text
          // editing pipeline and is considerably closer to actual typing than
          // assigning input.value. It also fires the input event React expects.
          focusElement(input);
          try { input.select(); } catch (error) {}
          try { input.setSelectionRange(0, input.value.length); } catch (error) {}
          let ok = false;
          try { ok = !!document.execCommand('insertText', false, value); } catch (error) {}
          return ok && input.value === value;
        };
        const dispatchControlledValue = (input, value, data = null) => {
          const oldValue = nativeSet(input, value);
          let beforeEvent = null;
          let inputEvent = null;
          try {
            beforeEvent = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              composed: true,
              inputType: 'insertText',
              data
            });
            input.dispatchEvent(beforeEvent);
          } catch (error) {}
          try {
            inputEvent = new InputEvent('input', {
              bubbles: true,
              composed: true,
              inputType: 'insertText',
              data
            });
            input.dispatchEvent(inputEvent);
          } catch (error) {
            inputEvent = new Event('input', { bubbles: true, composed: true });
            input.dispatchEvent(inputEvent);
          }
          const reactInput = callReact(input, 'onInput', inputEvent);
          const reactChange = callReact(input, 'onChange', inputEvent);
          return { oldValue, reactHandled: reactInput || reactChange };
        };
        const openSearchModal = async () => {
          const launcher = findLauncher();
          if (!launcher) return null;
          const previousInputs = new Set(modalInputCandidates());
          const previousRoots = new Set(Array.from(previousInputs, modalRootFor).filter(Boolean));
          const previouslyActive = document.activeElement;
          const wrapper = launcher.closest('.pi-input-inside-wrap') || launcher.closest('.pi-input-wrap') || launcher.parentElement || launcher;
          try { wrapper.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', button: 0 })); } catch (error) {}
          try { wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, button: 0 })); } catch (error) {}
          focusElement(launcher);

          // Only accept an input/root that appears after activating the exact
          // top Search component. A scan-chain `new-search-input` that was
          // already visible before the click is therefore never selected.
          for (let i = 0; i < 30; i += 1) {
            const modal = modalInputCandidates().find((candidate) => {
              const root = modalRootFor(candidate);
              return !previousInputs.has(candidate)
                || (root && !previousRoots.has(root))
                || (document.activeElement === candidate && candidate !== previouslyActive);
            });
            if (modal) return modal;
            await wait(i < 8 ? 20 : 45);
          }
          // v2.9.4：上一次搜索留下的结果弹窗还开着时，重新激活启动器不会挂载
          // 「新」输入框，焦点也未必自动落进去，上面的严格判定必失败——真机
          // 日志连续 8 条 modal-search-input-not-found 即此形态（首次成功后
          // 弹窗保持打开）。退而接受点击后仍可见的弹窗输入框，把新关键词直接
          // 打进现有弹窗；结果面板本来就该保持打开给另一屏看。
          return modalInputCandidates().find((candidate) => {
            const root = modalRootFor(candidate);
            return !!root && visible(root);
          }) || null;
        };

        if (!findLauncher()) return { ok: false, reason: 'gmgn-search-launcher-not-found' };
        let input = await openSearchModal();
        if (!input) return { ok: false, reason: 'modal-search-input-not-found' };
        focusElement(input);

        const modalRoot = modalRootFor(input) || input.parentElement;
        let resultMutations = 0;
        let resultObserver = null;
        try {
          resultObserver = new MutationObserver((records) => {
            // Ignore mutations whose only target is the input itself. Search
            // result/loading DOM updates elsewhere in the modal count as proof
            // that GMGN consumed the query.
            for (const record of records) {
              if (record.target !== input && !input.contains?.(record.target)) {
                resultMutations += 1;
                break;
              }
            }
          });
          if (modalRoot) resultObserver.observe(modalRoot, { childList: true, subtree: true, characterData: true });
        } catch (error) {}

        // First choice: use Chromium's normal text editing pipeline. This is the
        // closest extension-safe equivalent to the user selecting the field and
        // typing the query, and fixes GMGN builds that ignore synthetic input.
        let browserEdited = editLikeUser(input, q);
        let sent = { reactHandled: false };

        if (!browserEdited || input.value !== q) {
          // Controlled-input fallback. Reset React's value tracker, dispatch a
          // real InputEvent and directly invoke the nearest React handler.
          dispatchControlledValue(input, '', null);
          await wait(4);
          sent = dispatchControlledValue(input, q, q);
        }

        // Direct handler is harmless if the native editing path already updated
        // state, and essential on builds where a wrapper owns the onChange prop.
        const finalInputEvent = (() => {
          try { return new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: q }); }
          catch (error) { return new Event('input', { bubbles: true, composed: true }); }
        })();
        const directInput = callReact(input, 'onInput', finalInputEvent);
        const directChange = callReact(input, 'onChange', finalInputEvent);
        sent.reactHandled = sent.reactHandled || directInput || directChange;
        try { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: q })); } catch (error) {}
        try { input.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (error) {}

        // GMGN debounces network search and can remount the controlled field.
        // Re-resolve once; if it reset, retry using a short character-by-character
        // controlled path. This runs only on failure and therefore does not add
        // steady-state cost to GMGN.
        await wait(140);
        const remounted = modalRoot
          ? Array.from(modalRoot.querySelectorAll('input[name="new-search-input"], input[placeholder*="搜名称"]')).find(visible)
          : null;
        if (remounted) input = remounted;
        if (input.value !== q) {
          focusElement(input);
          dispatchControlledValue(input, '', null);
          let prefix = '';
          for (const ch of Array.from(q)) {
            prefix += ch;
            let keyDown = null;
            try {
              keyDown = new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true });
              input.dispatchEvent(keyDown);
            } catch (error) {}
            sent = dispatchControlledValue(input, prefix, ch);
            callReact(input, 'onKeyDown', keyDown || new Event('keydown'));
            await wait(3);
          }
        }

        // Give GMGN's debounce enough time to begin updating its results. Do not
        // press Enter: doing so can navigate the first result instead of showing
        // the search list the user asked for.
        for (let i = 0; i < 18 && resultMutations === 0; i += 1) await wait(50);
        try { resultObserver?.disconnect(); } catch (error) {}

        const valueAccepted = !!input && input.isConnected && input.value === q;
        // Do not call a search successful just because the controlled input now
        // contains the query. The user's real failure mode was exactly that:
        // modal opened + value visible, but GMGN never consumed it. Require an
        // observable result/loading DOM update inside the modal before returning
        // success to the monitor tab.
        const searchConsumed = resultMutations > 0;
        return {
          ok: valueAccepted && searchConsumed,
          value: input?.value || '',
          browserEdited,
          reactHandled: !!sent?.reactHandled,
          resultMutations,
          field: input?.name || '',
          reason: !valueAccepted ? 'controlled-input-reset' : (searchConsumed ? '' : 'search-results-did-not-update')
        };
      }
    });
    return results?.[0]?.result || { ok: false, reason: 'no-result' };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error || 'execute-failed') };
  }
}

async function executeRealAxiomSearch(tabId, query, openFirstResult = false) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [query, openFirstResult],
      func: async (rawQuery, shouldOpenFirstResult) => {
        const q = String(rawQuery || '').trim().slice(0, 80);
        if (!q) return { ok: false, reason: 'empty' };

        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const initialHref = location.href;
        const visible = (element) => {
          if (!element || !element.isConnected) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 20 && rect.height > 0
            && style.display !== 'none' && style.visibility !== 'hidden'
            && Number(style.opacity || 1) !== 0;
        };
        const searchText = /search|token|ticker|symbol|contract|address|mint|搜索|合约/i;
        const findInput = () => {
          const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea'))
            .filter((input) => {
              if (!visible(input)) return false;
              const hint = `${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-label') || ''}`;
              return searchText.test(hint);
            });
          return inputs.sort((a, b) => {
            const aDialog = a.closest('[role="dialog"],[aria-modal="true"]') ? 1 : 0;
            const bDialog = b.closest('[role="dialog"],[aria-modal="true"]') ? 1 : 0;
            return bDialog - aDialog || a.getBoundingClientRect().top - b.getBoundingClientRect().top;
          })[0] || null;
        };
        const findLauncher = () => {
          const input = findInput();
          if (input) return input;
          const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
          const labelled = buttons.find((button) => /search|搜索/i.test([
            button.getAttribute('aria-label'),
            button.getAttribute('title'),
            button.dataset?.tooltip,
            button.textContent
          ].filter(Boolean).join(' ')));
          if (labelled) return labelled;
          return buttons.find((button) => {
            const rect = button.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            return rect.top >= 0 && rect.bottom <= 70
              && rect.width >= 24 && rect.width <= 56
              && rect.height >= 24 && rect.height <= 56
              && centerX >= window.innerWidth * .55 && centerX <= window.innerWidth * .70;
          }) || null;
        };
        const activate = (element) => {
          try { element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', button: 0 })); } catch (error) {}
          try { element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, button: 0 })); } catch (error) {}
          try { element.focus({ preventScroll: true }); } catch (error) { try { element.focus(); } catch (e) {} }
          try { element.click(); } catch (error) {}
        };
        const setValue = (input, value) => {
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const oldValue = input.value;
          if (setter) setter.call(input, value);
          else input.value = value;
          try { input._valueTracker?.setValue?.(oldValue); } catch (error) {}
          try { input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: value })); } catch (error) {}
          try { input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value })); }
          catch (error) { input.dispatchEvent(new Event('input', { bubbles: true, composed: true })); }
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        };
        const currentRouteMatches = () => {
          try {
            const url = new URL(location.href);
            const containsCA = decodeURIComponent(`${url.pathname}${url.search}${url.hash}`).includes(q);
            // Accept Axiom route-shape changes as long as navigation left the
            // original page and the resulting URL carries the exact CA. Known
            // detail routes also count when C is pressed for the already-open CA.
            return containsCA && (location.href !== initialHref || /\/(?:meme|token|trade)\//i.test(url.pathname));
          } catch (error) {
            return false;
          }
        };
        const sameOriginDetailHref = (element) => {
          const link = element?.matches?.('a[href]') ? element : element?.closest?.('a[href]');
          if (!link) return '';
          try {
            const url = new URL(link.href, location.href);
            const decoded = decodeURIComponent(`${url.pathname}${url.search}${url.hash}`);
            return url.origin === location.origin && decoded.includes(q) ? url.href : '';
          } catch (error) {
            return '';
          }
        };
        const clickableFor = (element) => {
          if (!element) return null;
          const owner = element.closest?.('a[href],button,[role="button"]');
          if (owner && visible(owner)) return owner;
          const child = Array.from(element.querySelectorAll?.('a[href],button,[role="button"]') || []).find(visible);
          return child || (visible(element) ? element : null);
        };
        const findExactTokenResult = (currentInput) => {
          // Strongest signal: Axiom's own same-origin result link contains the
          // complete CA. This automatically follows route changes (slug/pool
          // suffixes included) instead of guessing /meme/{CA} ourselves.
          const links = Array.from(document.querySelectorAll('a[href]')).filter(visible);
          const exactLink = links.find((link) => sameOriginDetailHref(link));
          if (exactLink) return { target: exactLink, href: sameOriginDetailHref(exactLink) };

          // Current builds also expose the full address on result-row data/title
          // attributes even when visible text truncates it.
          const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(q) : q.replace(/["\\]/g, '\\$&');
          for (const selector of [
            `[data-address="${escaped}"]`, `[data-ca="${escaped}"]`,
            `[data-mint="${escaped}"]`, `[data-token-address="${escaped}"]`,
            `[title="${escaped}"]`
          ]) {
            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(selector)); } catch (error) {}
            const node = nodes.find((candidate) => visible(candidate) || visible(clickableFor(candidate)));
            const target = clickableFor(node);
            if (target) return { target, href: sameOriginDetailHref(target) };
          }

          // Text fallback for layouts that render the complete CA in a row.
          const rows = Array.from(document.querySelectorAll('a[href],button,[role="button"],li,tr'))
            .filter((row) => visible(row) && String(row.textContent || '').includes(q));
          if (rows.length) {
            const target = clickableFor(rows[0]);
            if (target) return { target, href: sameOriginDetailHref(target) };
          }

          // Last-resort structural fallback: choose the first non-loading row in
          // the result panel, but click its real nested control when present.
          const panel = currentInput?.parentElement?.parentElement;
          const resultList = panel?.lastElementChild;
          const row = Array.from(resultList?.children || []).find((candidate) =>
            visible(candidate)
              && !candidate.querySelector('.animate-pulse')
              && !/no results/i.test(String(candidate.textContent || ''))
              && String(candidate.textContent || '').trim());
          const target = clickableFor(row);
          return target ? { target, href: sameOriginDetailHref(target) } : null;
        };

        const launcher = findLauncher();
        if (!launcher) return { ok: false, reason: 'axiom-search-launcher-not-found' };
        activate(launcher);

        let input = launcher instanceof HTMLInputElement || launcher instanceof HTMLTextAreaElement
          ? launcher
          : null;
        for (let i = 0; i < 24; i += 1) {
          const candidate = findInput();
          if (candidate) { input = candidate; break; }
          await wait(i < 8 ? 25 : 50);
        }
        if (!input) return { ok: false, reason: 'axiom-search-input-not-found' };

        // Axiom 会记住 Wallets 搜索筛选；C 打开 CA 时必须切回代币搜索，
        // 否则有效 CA 也会显示 No results found。普通跨屏搜索不改用户筛选。
        if (shouldOpenFirstResult) {
          const walletFilter = Array.from(document.querySelectorAll('button,[role="button"]')).find((button) =>
            visible(button) && button.getAttribute('aria-pressed') === 'true'
              && /^Wallets$/i.test(String(button.textContent || '').trim()));
          if (walletFilter) {
            activate(walletFilter);
            for (let i = 0; i < 24; i += 1) {
              const candidate = findInput();
              if (candidate && /Search by name, ticker, or CA/i.test(candidate.getAttribute('placeholder') || '')) {
                input = candidate;
                break;
              }
              await wait(i < 8 ? 25 : 50);
            }
          }
        }

        activate(input);
        try { input.select(); } catch (error) {}
        try { input.setSelectionRange(0, input.value.length); } catch (error) {}
        let browserEdited = false;
        try { browserEdited = !!document.execCommand('insertText', false, q); } catch (error) {}
        if (!browserEdited || input.value !== q) setValue(input, q);

        await wait(180);
        const current = findInput();
        if (current) input = current;
        if (input.value !== q) {
          activate(input);
          setValue(input, q);
        }
        await wait(260);

        const accepted = input.isConnected && input.value === q;
        if (accepted && shouldOpenFirstResult) {
          if (currentRouteMatches()) {
            return { ok: true, value: q, browserEdited, opened: true, url: location.href, alreadyOpen: true };
          }
          let resolvedHref = '';
          let lastClickAt = 0;
          for (let i = 0; i < 100; i += 1) {
            if (currentRouteMatches()) {
              return { ok: true, value: q, browserEdited, opened: true, url: location.href, resolvedHref };
            }
            const currentInput = findInput();
            const result = findExactTokenResult(currentInput);
            if (result?.target && (lastClickAt === 0 || Date.now() - lastClickAt >= 650)) {
              resolvedHref = result.href || resolvedHref;
              lastClickAt = Date.now();
              activate(result.target);
            }
            await wait(i < 30 ? 50 : 90);
          }

          // Keyboard-selection fallback for Axiom builds whose result rows do not
          // expose an anchor/clickable role. Success still requires route proof.
          try {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, composed: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, composed: true }));
          } catch (error) {}
          for (let i = 0; i < 30; i += 1) {
            if (currentRouteMatches()) {
              return { ok: true, value: q, browserEdited, opened: true, url: location.href, resolvedHref, usedEnter: true };
            }
            await wait(60);
          }
          return {
            ok: false,
            value: input.value || '',
            browserEdited,
            resolvedHref,
            reason: resolvedHref ? 'axiom-route-not-confirmed' : 'axiom-token-result-not-found'
          };
        }
        return {
          ok: accepted,
          value: input.value || '',
          browserEdited,
          reason: accepted ? '' : 'axiom-controlled-input-reset'
        };
      }
    });
    return results?.[0]?.result || { ok: false, reason: 'no-result' };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error || 'execute-failed') };
  }
}

async function executeAxiomXPreview(tabId, action) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [action],
      func: (requestedAction) => {
        const stateKey = '__DSM_AXIOM_X_PREVIEW_LINK__';
        const dispatchEscape = () => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, composed: true }));
          document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, composed: true }));
        };
        const close = () => {
          const link = window[stateKey];
          window[stateKey] = null;
          if (link?.isConnected) {
            const rect = link.getBoundingClientRect();
            const base = {
              bubbles: true, cancelable: true, composed: true,
              clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
              relatedTarget: document.body, view: window
            };
            try { link.dispatchEvent(new PointerEvent('pointerout', { ...base, pointerType: 'mouse' })); } catch (error) {}
            try { link.dispatchEvent(new PointerEvent('pointerleave', { ...base, bubbles: false, pointerType: 'mouse' })); } catch (error) {}
            try { link.dispatchEvent(new MouseEvent('mouseout', base)); } catch (error) {}
            try { link.dispatchEvent(new MouseEvent('mouseleave', { ...base, bubbles: false })); } catch (error) {}
            try { link.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true, relatedTarget: document.body })); } catch (error) {}
            try { link.blur(); } catch (error) {}
          }
          dispatchEscape();
        };

        close();
        if (requestedAction !== 'open') return { ok: true, closed: true };
        const links = Array.from(document.querySelectorAll('a[href]')).filter((link) => {
          try {
            const url = new URL(link.href);
            const rect = link.getBoundingClientRect();
            return /(^|\.)(x|twitter)\.com$/i.test(url.hostname)
              && !/^\/(?:search|home|explore|notifications|messages)(?:\/|$)/i.test(url.pathname)
              && rect.width > 0 && rect.height > 0;
          } catch (error) { return false; }
        });
        const link = links.find((candidate) => /\/status\/\d+/i.test(candidate.href))
          || links.find((candidate) => {
            try { return !/^\/axiomexchange\/?$/i.test(new URL(candidate.href).pathname); }
            catch (error) { return false; }
          });
        if (!link) return { ok: false, reason: 'axiom-x-link-not-found' };

        const rect = link.getBoundingClientRect();
        const base = {
          bubbles: true, cancelable: true, composed: true,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          view: window
        };
        try { link.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerType: 'mouse' })); } catch (error) {}
        try { link.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false, pointerType: 'mouse' })); } catch (error) {}
        try { link.dispatchEvent(new MouseEvent('mouseover', base)); } catch (error) {}
        try { link.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false })); } catch (error) {}
        try { link.dispatchEvent(new MouseEvent('mousemove', base)); } catch (error) {}
        try { link.focus({ preventScroll: true }); } catch (error) { try { link.focus(); } catch (e) {} }
        try { link.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true })); } catch (error) {}
        window[stateKey] = link;
        return { ok: true, opened: true };
      }
    });
    return results?.[0]?.result || { ok: false, reason: 'no-result' };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error || 'execute-failed') };
  }
}

function executePlatformSearch(tabId, query, platform) {
  return platform === 'axiom'
    ? executeRealAxiomSearch(tabId, query)
    : executeRealGmgnSearch(tabId, query);
}

async function routeCrossTabSearch(query, sender, preferAxiom = false) {
  const senderTab = sender?.tab;
  const senderId = senderTab?.id;
  const preferredPlatform = preferAxiom ? 'axiom' : 'gmgn';

  // A CA is already an unambiguous token identity. Sending it through Axiom's
  // search UI leaves the user on a result modal and depends on controlled-input
  // behavior. Navigate the selected Axiom tab straight to its canonical K-line
  // detail route instead. Names and tickers continue to use global search.
  const axiomCA = preferAxiom ? normalizeTokenCA(query) : '';
  if (axiomCA) {
    const target = await findAxiomNavigationTarget(senderTab);
    if (!target) return { ok: false, action: 'detail', platform: 'axiom', reason: 'no-axiom-page' };
    const result = await navigateAxiomTokenDetails(target, axiomCA);
    if (result?.ok) lastSearchTargetTabId = target.tab.id;
    return result;
  }

  if (lastSearchTargetTabId != null && lastSearchTargetTabId !== senderId) {
    const probe = await sendTabMessage(lastSearchTargetTabId, { type: 'DSM_PROBE_GMGN_SEARCH_TARGET' }, 260);
    if (probe?.hasGlobalSearch && probe.platform === preferredPlatform) {
      const fast = await executePlatformSearch(lastSearchTargetTabId, query, probe.platform);
      if (fast?.ok) return { ok: true, platform: probe.platform, targetTabId: lastSearchTargetTabId, targetUrl: probe.href, cachedTarget: true };
    }
    lastSearchTargetTabId = null;
  }

  const { target, probes, bestEffortTab } = await findCrossTabSearchTarget(senderTab, preferredPlatform);
  if (!target) {
    // v2.9.5：失败原因带逐页探测摘要——「未响应」= 该标签页还在跑重载扩展前
    // 的孤儿内容脚本，刷新即可；「无搜索框」= 页面确实找不到，对照 pi-input
    // 数量可判断是 GMGN 改版（N>0）还是页面状态问题（N=0）。
    const summary = probes.map((p) => {
      const site = String(p.href || '').replace(/^https?:\/\//, '').slice(0, 28) || '未知页';
      if (!p.responded) return `${site} 未响应(请刷新该标签页)`;
      if (!p.hasGlobalSearch) return `${site} 无搜索框(pi-input×${Number.isFinite(p.piInputCount) ? p.piInputCount : '?'})`;
      return `${site} 平台不符(${p.platform || '?'})`;
    }).join('，');
    // v2.9.5：GMGN 路径探针全灭时仍向最可能的标签页尽力注入——孤儿脚本只挡
    // 探针不挡 chrome.scripting；若注入也失败，会给出启动器级别的精确原因。
    if (bestEffortTab) {
      const result = await executePlatformSearch(bestEffortTab.id, query, 'gmgn');
      if (result?.ok) {
        lastSearchTargetTabId = bestEffortTab.id;
        return { ok: true, platform: 'gmgn', targetTabId: bestEffortTab.id, bestEffort: true };
      }
      return {
        ok: false,
        platform: 'gmgn',
        reason: `no-gmgn-search-page · ${summary || '无可选标签页'} · ${result?.reason || 'search-not-triggered'}`
      };
    }
    return {
      ok: false,
      platform: preferredPlatform,
      reason: (preferAxiom ? 'no-axiom-search-page' : 'no-gmgn-search-page') + (summary ? ` · ${summary}` : '')
    };
  }
  const result = await executePlatformSearch(target.tab.id, query, target.probe?.platform);
  if (!result?.ok) return { ok: false, reason: result?.reason || 'search-not-triggered' };

  lastSearchTargetTabId = target.tab.id;
  return {
    ok: true,
    platform: target.probe?.platform || 'gmgn',
    targetTabId: target.tab.id,
    targetWindowId: target.tab.windowId,
    targetUrl: target.probe?.href
  };
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  // Messages explicitly targeted at the offscreen document must not be answered
  // by the service worker; otherwise the caller can receive the wrong responder.
  if (message.target === 'offscreen') return;

  if (message.type === 'DSM_CROSS_TAB_GMGN_SEARCH') {
    const query = String(message.query || '').trim().slice(0, 80);
    if (!query) { sendResponse({ ok: false, reason: 'empty-query' }); return; }
    routeCrossTabSearch(query, sender, message.preferAxiom === true).then((result) => {
      const detailRoute = result?.action === 'detail';
      appendRuntimeLog({
        level: result?.ok ? 'success' : 'error', category: detailRoute ? 'K线跳转' : '跨屏搜索',
        title: detailRoute
          ? (result?.ok ? 'Axiom K线已打开' : 'Axiom K线跳转失败')
          : (result?.ok ? '关键词已发送' : '关键词发送失败'),
        detail: result?.ok ? query : `${query} · ${result?.reason || '未知原因'}`
      });
      sendResponse(result);
    }).catch((error) => {
      const reason = String(error?.message || error || 'route-failed');
      appendRuntimeLog({ level: 'error', category: '跨屏搜索', title: '关键词发送异常', detail: reason });
      sendResponse({ ok: false, reason });
    });
    return true;
  }

  if (message.type === 'DSM_AXIOM_X_PREVIEW') {
    const host = (() => { try { return new URL(sender?.url || '').hostname; } catch (error) { return ''; } })();
    if (!Number.isInteger(sender?.tab?.id) || (host !== 'axiom.trade' && !host.endsWith('.axiom.trade'))) {
      sendResponse({ ok: false, reason: 'axiom-page-required' });
      return;
    }
    executeAxiomXPreview(sender.tab.id, message.action === 'open' ? 'open' : 'close').then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: String(error?.message || error || 'axiom-x-preview-failed') });
    });
    return true;
  }

  if (message.type === 'DSM_GET_LOGS') {
    chrome.storage.local.get(LOG_KEY).then((data) => {
      sendResponse({ ok: true, logs: Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [] });
    }).catch(() => sendResponse({ ok: false, logs: [] }));
    return true;
  }

  if (message.type === 'DSM_CLEAR_LOGS') {
    chrome.storage.local.remove(LOG_KEY).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'DSM_KEEPALIVE') {
    // v2.9.2：GMGN 页面 20s 心跳。保持 SW 常驻并提前建好 offscreen 文档，
    // 播报免去 ~0.1-0.6s 的冷启动；语音关闭时 content 侧不会发本消息。
    ensureOffscreenDocument().catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'DSM_ADD_LOG') {
    appendRuntimeLog(message);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'DSM_PREVIEW_TTS') {
    const text = sanitizeSpeechText(message.text || '币安 Binance 华语 发推啦', true);
    if (!text) { sendResponse({ ok: false, reason: 'empty' }); return; }
    speakEdgeTts(text, message, true).then((result) => {
      appendRuntimeLog({ level: result?.ok ? 'success' : 'error', category: '语音试听', title: result?.ok ? '试听播放成功' : '试听播放失败', detail: result?.reason || text });
      sendResponse(result);
    }).catch((error) => {
      const reason = String(error?.message || error);
      appendRuntimeLog({ level: 'error', category: '语音试听', title: '试听播放异常', detail: reason });
      sendResponse({ ok: false, reason });
    });
    return true;
  }

  if (message.type === 'DSM_COUNTDOWN_SPEAK' || message.type === 'DSM_COUNTDOWN_PREFETCH') {
    // content 侧不等响应（fire-and-forget），这里同步应答、后台异步处理
    handleCountdownMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (message.type !== 'DSM_SPEAK_TWITTER_AUTHOR') return;
  const text = sanitizeSpeechText(message.text || '', true);
  const key = String(message.key || text).trim().slice(0, 240);
  if (!text) { sendResponse({ ok: false, reason: 'empty' }); return; }

  const now = Date.now();
  pruneRecent(now);
  const previous = recentSpeech.get(key) || 0;
  if (now - previous < DEDUPE_MS) { sendResponse({ ok: true, deduped: true }); return; }
  if (!shouldSpeakText(text, now)) { sendResponse({ ok: true, deduped: true }); return; }
  recentSpeech.set(key, now);
  speakEdgeTts(text, message, false).then((result) => {
    // 等待耗时随日志落盘，弹窗日志可直接对证每条播报的 content 侧延迟。
    const wait = Math.round(Number(message.waitMs));
    const waitTag = Number.isFinite(wait) ? `｜等${Math.max(0, wait)}ms` : '';
    appendRuntimeLog({ level: result?.ok ? 'success' : 'error', category: '推特播报', title: result?.ok ? '播报成功' : '播报失败', detail: result?.ok ? `${text}${waitTag}` : `${text}${waitTag} · ${result?.reason || '未知原因'}` });
    sendResponse(result);
  }).catch((error) => {
    const reason = String(error?.message || error);
    appendRuntimeLog({ level: 'error', category: '推特播报', title: '播报异常', detail: `${text} · ${reason}` });
    sendResponse({ ok: false, reason });
  });
  return true;
});
