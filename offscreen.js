'use strict';

const EDGE_TTS_ENDPOINT = 'https://cloudflare-edge-tts.tech-melon.workers.dev/tts';
let activePlayback = null;
let playbackQueue = Promise.resolve();
let playbackGeneration = 0;

function stopActivePlayback() {
  const active = activePlayback;
  activePlayback = null;
  if (!active) return;
  try { active.audio.pause(); } catch (error) {}
  try { active.audio.removeAttribute('src'); active.audio.load(); } catch (error) {}
  try { URL.revokeObjectURL(active.url); } catch (error) {}
  active.finish({ ok: false, reason: 'interrupted' });
}

async function fetchSpeech(payload) {
  const controller = new AbortController();
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

async function generateAndPlay(payload, generation) {
  if (!String(payload.text || '').trim()) return { ok: false, reason: 'empty' };
  if (generation !== playbackGeneration) return { ok: false, reason: 'interrupted' };
  const blob = await fetchSpeech(payload);
  return playBlob(blob, payload.volume, generation);
}

function enqueueSpeech(payload) {
  if (payload.interrupt) {
    playbackGeneration += 1;
    stopActivePlayback();
    playbackQueue = Promise.resolve();
  }
  const generation = playbackGeneration;
  const job = playbackQueue.catch(() => {}).then(() => generateAndPlay(payload, generation));
  playbackQueue = job.catch(() => {});
  return job;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'DSM_EDGE_TTS_COMMAND' || message?.target !== 'offscreen') return;
  enqueueSpeech(message.payload || {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
  return true;
});
