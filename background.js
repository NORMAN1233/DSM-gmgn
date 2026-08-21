'use strict';

// DSM-gmgn v2.7.0 — GMGN WSS monitoring + Edge-TTS/chrome.tts playback.
const recentSpeech = new Map();
const DEDUPE_MS = 60 * 1000;
let lastSearchTargetTabId = null;
let creatingOffscreen = null;
let offscreenReady = false;
let ttsRequestSeq = 0;

// 公共 Edge-TTS worker 的中文合成路径当前不稳定（纯中文上游报错、混合文本
// 被截断成首词碎片，2026-08-22 实测）。含中文的播报改走 chrome.tts 系统引擎，
// 纯英文文本仍走 Edge-TTS（该路径实测正常）。
const CJK_CHAR_RE = /[\u3400-\u9FFF]/;

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

function chromeTtsRate(value) {
  // chrome.tts 的 rate 是倍率（默认 1.0）；扩展设置存的是百分比（115 = +15%）。
  const percent = Number(value);
  const ratio = Number.isFinite(percent) && percent > 0 ? percent / 100 : 1.15;
  return Math.min(6, Math.max(0.5, ratio));
}

function pickChromeTtsVoice(voices, wantChinese) {
  if (!wantChinese) {
    return voices.find((v) => /en[-_]US/i.test(v.lang || '') && /Google/i.test(v.voiceName || ''))
      || voices.find((v) => /^en/i.test(v.lang || '')) || null;
  }
  return voices.find((v) => /zh[-_]CN/i.test(v.lang || '') && /Google/i.test(v.voiceName || ''))
    || voices.find((v) => /zh[-_]CN/i.test(v.lang || '') && /Xiaoxiao|Huihui|Yaoyao|Kangkang/i.test(v.voiceName || ''))
    || voices.find((v) => /zh[-_]CN/i.test(v.lang || ''))
    || voices.find((v) => /^zh/i.test(v.lang || ''))
    || null;
}

const LATIN_CHAR_RE = /[A-Za-z]/;

// 把清洗后的播报文本拆成中/英连续段：CJK 归中文段、字母归英文段；
// 数字/空格/标点为中性字符，跟随前一段（句首中性字符跟随下一段）。
function splitLanguageRuns(text) {
  const chars = Array.from(String(text || ''));
  let lastKind = null;
  const kinds = chars.map((ch) => {
    if (CJK_CHAR_RE.test(ch)) lastKind = 'zh';
    else if (LATIN_CHAR_RE.test(ch)) lastKind = 'en';
    return lastKind;
  });
  const resolved = new Array(kinds.length);
  let next = null;
  for (let i = kinds.length - 1; i >= 0; i -= 1) {
    if (kinds[i]) next = kinds[i];
    resolved[i] = kinds[i] ?? next;
  }
  const runs = [];
  for (let i = 0; i < chars.length; i += 1) {
    const kind = resolved[i];
    const tail = runs[runs.length - 1];
    if (tail && tail.kind === kind) tail.text += chars[i];
    else runs.push({ kind: kind ?? 'zh', text: chars[i] });
  }
  return runs
    .map((run) => ({ kind: run.kind, text: run.text.trim() }))
    .filter((run) => run.text);
}

function speakChromeSegment(text, message, wantChinese) {
  return new Promise((resolve) => {
    if (!chrome.tts?.speak) {
      resolve({ ok: false, reason: 'chrome-tts-unavailable' });
      return;
    }
    try {
      chrome.tts.getVoices((voices) => {
        const options = {
          enqueue: false,
          volume: Math.min(1, Math.max(0, Number(message.volume) || 0)),
          rate: chromeTtsRate(message.rate)
        };
        const voice = pickChromeTtsVoice(Array.isArray(voices) ? voices : [], wantChinese);
        if (voice?.voiceName) options.voiceName = voice.voiceName;

        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          resolve({ ok });
        };
        options.onEvent = (event) => {
          if (event.type === 'end') done(true);
          else if (['error', 'interrupted', 'cancelled'].includes(event.type)) done(false);
        };
        chrome.tts.speak(text, options);
        // 个别平台不发 end 事件：按字数估算兜底超时，避免接力链卡死。
        setTimeout(() => done(true), Math.min(30000, 4000 + text.length * 250));
      });
    } catch (error) {
      resolve({ ok: false, reason: String(error?.message || error) });
    }
  });
}

function stopEdgeTtsPlayback() {
  // 空 text + interrupt：offscreen 先停掉当前播放并清空队列，再因空文本返回。
  sendEdgeTtsCommand({
    text: '', voice: 'en-US-AvaMultilingualNeural', rate: '+0%', pitch: '+0%', volume: 0, interrupt: true
  }, 5000, false).catch(() => {});
}

// 中英分段接力播放：中文段用系统中文语音(chrome.tts)，英文段用 Edge-TTS 的
// Ava 多语言语音(实测纯英文路径稳定且发音纯正)。新播报会使旧的接力链失效。
let speakJobSeq = 0;

async function speakSequential(text, message, interrupt = false) {
  const mySeq = ++speakJobSeq;
  const segments = splitLanguageRuns(text);
  if (!segments.length) return { ok: false, reason: 'empty' };

  if (interrupt) {
    try { chrome.tts?.stop?.(); } catch (error) {}
    stopEdgeTtsPlayback();
  }

  let spokeAny = false;
  for (const seg of segments) {
    if (mySeq !== speakJobSeq) return { ok: false, reason: 'superseded' };
    if (seg.kind === 'en') {
      const result = await sendEdgeTtsCommand({
        text: seg.text,
        voice: 'en-US-AvaMultilingualNeural',
        rate: normalizeEdgeRate(message.rate),
        pitch: '+0%',
        volume: Math.min(1, Math.max(0, Number(message.volume) || 0))
      }, 20000);
      spokeAny = spokeAny || !!result?.ok;
    } else {
      const result = await speakChromeSegment(seg.text, message, true);
      spokeAny = spokeAny || !!result?.ok;
    }
  }
  return { ok: spokeAny, engine: 'hybrid', segments: segments.length };
}

function dispatchSpeak(text, message, interrupt = false) {
  return speakSequential(text, message, interrupt);
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

async function sendEdgeTtsCommand(payload = {}, timeoutMs = 20000, retry = true) {
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
        type: 'DSM_EDGE_TTS_COMMAND',
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

async function findCrossTabSearchTarget(senderTab) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://*.gmgn.ai/*'] });
  } catch (error) {
    return null;
  }

  const senderId = senderTab?.id;
  const senderWindowId = senderTab?.windowId;
  // Prefer another window for the user's dual-screen setup, but keep the
  // sender tab as a fallback so the same feature also works on a one-screen
  // MacBook with only one GMGN page open.
  const candidates = tabs.filter((tab) => tab?.id != null);
  const probed = await Promise.all(candidates.map(async (tab) => {
    const probe = await sendTabMessage(tab.id, { type: 'DSM_PROBE_GMGN_SEARCH_TARGET' }, 500);
    if (!probe?.hasGlobalSearch) return null;
    let score = 0;
    if (tab.id === lastSearchTargetTabId && tab.id !== senderId) score += 1000;
    if (senderWindowId != null && tab.windowId !== senderWindowId) score += 320;
    if (tab.id !== senderId) score += 80;
    if (tab.active) score += 160;
    if (probe.visible) score += 120;
    if (probe.focused) score += 40;
    if (/\/(?:token|pump)\//i.test(probe.href || tab.url || '')) score -= 40;
    return { tab, probe, score };
  }));
  return probed.filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
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
            'input.pi-input[placeholder*="Search name"]'
          ]);
          if (!launcher) return null;
          const rect = launcher.getBoundingClientRect();
          return rect.top >= 0 && rect.top < Math.min(180, window.innerHeight * 0.25) ? launcher : null;
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
          return null;
        };

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

async function routeCrossTabSearch(query, sender) {
  const senderTab = sender?.tab;
  const senderId = senderTab?.id;

  if (lastSearchTargetTabId != null && lastSearchTargetTabId !== senderId) {
    const probe = await sendTabMessage(lastSearchTargetTabId, { type: 'DSM_PROBE_GMGN_SEARCH_TARGET' }, 260);
    if (probe?.hasGlobalSearch) {
      const fast = await executeRealGmgnSearch(lastSearchTargetTabId, query);
      if (fast?.ok) return { ok: true, targetTabId: lastSearchTargetTabId, targetUrl: probe.href, cachedTarget: true };
    }
    lastSearchTargetTabId = null;
  }

  const target = await findCrossTabSearchTarget(senderTab);
  if (!target) return { ok: false, reason: 'no-global-token-search' };
  const result = await executeRealGmgnSearch(target.tab.id, query);
  if (!result?.ok) return { ok: false, reason: result?.reason || 'search-not-triggered' };

  lastSearchTargetTabId = target.tab.id;
  return {
    ok: true,
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
    routeCrossTabSearch(query, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error || 'route-failed') }));
    return true;
  }

  if (message.type === 'DSM_PREVIEW_TTS') {
    const text = sanitizeSpeechText(message.text || '币安 Binance 华语 发推啦', true);
    if (!text) { sendResponse({ ok: false, reason: 'empty' }); return; }
    dispatchSpeak(text, message, true)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }

  if (message.type !== 'DSM_SPEAK_TWITTER_AUTHOR') return;
  const text = sanitizeSpeechText(message.text || '', true);
  const key = String(message.key || text).trim().slice(0, 240);
  if (!text) { sendResponse({ ok: false, reason: 'empty' }); return; }

  const now = Date.now();
  pruneRecent(now);
  const previous = recentSpeech.get(key) || 0;
  if (now - previous < DEDUPE_MS) { sendResponse({ ok: true, deduped: true }); return; }
  recentSpeech.set(key, now);
  dispatchSpeak(text, message, false)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
  return true;
});
