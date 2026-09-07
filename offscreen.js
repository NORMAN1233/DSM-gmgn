'use strict';

const EDGE_TTS_ENDPOINT = 'https://cloudflare-edge-tts.tech-melon.workers.dev/tts';
let activePlayback = null;
let playbackQueue = Promise.resolve();
let playbackGeneration = 0;
const synthControllers = new Set();

function stopActivePlayback() {
  const active = activePlayback;
  activePlayback = null;
  for (const controller of synthControllers) {
    try { controller.abort(); } catch (error) {}
  }
  synthControllers.clear();
  if (!active) return;
  try { active.audio.pause(); } catch (error) {}
  try { active.audio.removeAttribute('src'); active.audio.load(); } catch (error) {}
  try { URL.revokeObjectURL(active.url); } catch (error) {}
  active.finish({ ok: false, reason: 'interrupted' });
}

async function fetchSpeech(payload, controller = new AbortController()) {
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(EDGE_TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: String(payload.text || '').trim(),
        voice: String(payload.voice || 'zh-CN-XiaoxiaoNeural'),
        rate: String(payload.rate || '+15%'),
        pitch: String(payload.pitch || '+0%')
      }),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit'
    });
    if (!response.ok) throw new Error(`edge-tts-http-${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.toLowerCase().includes('audio/')) throw new Error(`edge-tts-invalid-content-type:${type || 'unknown'}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('edge-tts-empty-audio');
    return blob;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('edge-tts-fetch-timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function playBlob(blob, volume, generation) {
  return new Promise((resolve) => {
    if (generation !== playbackGeneration) {
      resolve({ ok: false, reason: 'interrupted' });
      return;
    }

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, Number(volume) || 0));
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activePlayback?.audio === audio) activePlayback = null;
      audio.onended = null;
      audio.onerror = null;
      try { URL.revokeObjectURL(url); } catch (error) {}
      resolve(result);
    };

    activePlayback = { audio, url, finish };
    audio.onended = () => finish({ ok: true, engine: 'edge-tts', playback: 'html-audio' });
    audio.onerror = () => finish({ ok: false, reason: 'audio-playback-failed' });
    audio.play().catch((error) => finish({ ok: false, reason: `audio-playback:${error?.message || error}` }));
  });
}

// v2.9.2：合成与播放解耦。fetch 在入队瞬间就并行发起，串行队列只排播放——
// 上一条语音在喇叭里放的时候，下一条音频已在网络合成，突发多条推文不再以
// 「合成+播放」总时长逐条排队。
function enqueueSpeech(payload) {
  if (payload.interrupt) {
    playbackGeneration += 1;
    stopActivePlayback();
    playbackQueue = Promise.resolve();
  }
  const generation = playbackGeneration;
  if (!String(payload.text || '').trim()) {
    return Promise.resolve({ ok: false, reason: 'empty' });
  }
  const controller = new AbortController();
  synthControllers.add(controller);
  const synth = fetchSpeech(payload, controller)
    .finally(() => synthControllers.delete(controller));
  // interrupt 可能让我们永远不 await 这条合成；提前挂空 catch 防未处理拒绝。
  synth.catch(() => {});
  const job = playbackQueue.catch(() => {}).then(async () => {
    if (generation !== playbackGeneration) return { ok: false, reason: 'interrupted' };
    const blob = await synth;
    return playBlob(blob, payload.volume, generation);
  });
  playbackQueue = job.catch(() => {});
  return job;
}

// ============================================================
// 倒计时配音声道：与推文播报完全独立——数字每秒一拍，不能在
// 推文长语音后面排队。片段（5·4·3·2·1、「时间到」）首次合成后
// 持久缓存，之后逐秒即时播放；同声道新请求会顶掉上一拍。
// ============================================================
const COUNTDOWN_STORAGE_KEY = 'dsmCountdownClipsV1';
// bucket(`${voice}|${rate}`) -> { clips: Map(clipKey -> Blob), persistedLoaded }
const countdownBuckets = new Map();
const countdownInflight = new Map();
let countdownAudio = null;
let countdownUrl = null;
let countdownPersistChain = Promise.resolve();

function countdownClipText(key) {
  if (key === 'timeout') return '时间到';
  const value = Number(String(key).slice(1));
  return String(Math.min(60, Math.max(1, Number.isFinite(value) ? value : 1)));
}

async function loadPersistedCountdownClips(bucket, voice, rate) {
  try {
    const data = await chrome.storage.local.get(COUNTDOWN_STORAGE_KEY);
    const stored = data[COUNTDOWN_STORAGE_KEY];
    if (!stored || stored.voice !== voice || stored.rate !== rate || !stored.clips) return;
    for (const [key, base64] of Object.entries(stored.clips)) {
      if (typeof base64 !== 'string' || !base64 || bucket.clips.has(key)) continue;
      bucket.clips.set(key, base64ToBlob(base64));
    }
  } catch (error) {
    // 缓存读取失败只影响首拍延迟，不影响功能
  }
}

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/mpeg' });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// 只持久化当前音色的一组片段；换音色后整组替换，存储不随历史音色增长
function persistCountdownBucket(bucket, voice, rate) {
  const run = countdownPersistChain.then(async () => {
    const clips = {};
    for (const [key, blob] of bucket.clips) clips[key] = await blobToBase64(blob);
    await chrome.storage.local.set({ [COUNTDOWN_STORAGE_KEY]: { voice, rate, clips } });
  });
  countdownPersistChain = run.catch(() => {});
  return run;
}

async function ensureCountdownClip(voice, rate, key) {
  const bucketKey = `${voice}|${rate}`;
  let bucket = countdownBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { clips: new Map(), persistedLoaded: false };
    countdownBuckets.set(bucketKey, bucket);
  }
  const hit = bucket.clips.get(key);
  if (hit) return hit;

  if (!bucket.persistedLoaded) {
    bucket.persistedLoaded = true;
    await loadPersistedCountdownClips(bucket, voice, rate);
    const persisted = bucket.clips.get(key);
    if (persisted) return persisted;
  }

  const inflightKey = `${bucketKey}|${key}`;
  const existingJob = countdownInflight.get(inflightKey);
  if (existingJob) return existingJob;
  const job = fetchSpeech({ text: countdownClipText(key), voice, rate, pitch: '+0%' })
    .then(async (blob) => {
      bucket.clips.set(key, blob);
      persistCountdownBucket(bucket, voice, rate).catch(() => {});
      return blob;
    })
    .finally(() => countdownInflight.delete(inflightKey));
  countdownInflight.set(inflightKey, job);
  return job;
}

function stopCountdownAudio() {
  if (countdownAudio) {
    try { countdownAudio.pause(); } catch (error) {}
    try { countdownAudio.removeAttribute('src'); countdownAudio.load(); } catch (error) {}
    countdownAudio = null;
  }
  if (countdownUrl) {
    try { URL.revokeObjectURL(countdownUrl); } catch (error) {}
    countdownUrl = null;
  }
}

async function playCountdownClip(blob, volume) {
  // 上一拍还没放完就被下一拍顶掉：数字每秒一拍，宁可截断也不堆积
  stopCountdownAudio();
  countdownUrl = URL.createObjectURL(blob);
  const audio = new Audio(countdownUrl);
  audio.volume = Math.min(1, Math.max(0, Number(volume) || 0));
  countdownAudio = audio;
  audio.onended = () => { if (countdownAudio === audio) stopCountdownAudio(); };
  audio.onerror = () => { if (countdownAudio === audio) stopCountdownAudio(); };
  await audio.play().catch(() => { if (countdownAudio === audio) stopCountdownAudio(); });
}

async function handleCountdownCommand(payload = {}) {
  const voice = String(payload.voice || 'zh-CN-XiaoxiaoNeural');
  const rate = String(payload.rate || '+15%');

  if (payload.prefetch) {
    // 按当前设定秒数预合成 n1..nN + 超时片段（已缓存的直接跳过）
    const maxValue = Math.min(60, Math.max(1, Number(payload.maxValue) || 5));
    const keys = [];
    for (let value = maxValue; value >= 1; value -= 1) keys.push(`n${value}`);
    keys.push('timeout');
    await Promise.allSettled(keys.map((key) => ensureCountdownClip(voice, rate, key)));
    return { ok: true, prefetch: true, synthesized: keys.length };
  }

  const key = payload.kind === 'timeout' ? 'timeout' : `n${Math.min(60, Math.max(1, Number(payload.value) || 0))}`;
  const blob = await ensureCountdownClip(voice, rate, key);
  await playCountdownClip(blob, payload.volume);
  return { ok: true, engine: 'edge-tts', channel: 'countdown' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;
  if (message.type === 'DSM_EDGE_TTS_COMMAND') {
    enqueueSpeech(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (message.type === 'DSM_COUNTDOWN_COMMAND') {
    handleCountdownCommand(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
});
