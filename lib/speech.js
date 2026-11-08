// 语音：能拿到浏览器自带识别就用它（快、零成本），拿不到就老老实实打字。

export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function ttsSupported() {
  return typeof window.speechSynthesis !== 'undefined';
}

export function createRecognizer({ lang = 'zh-CN', onPartial, onFinal, onError, onEnd } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalized = false;

  rec.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const r = event.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim && onPartial) onPartial(interim);
    if (final && !finalized) {
      finalized = true;
      onFinal?.(final.trim());
    }
  };

  rec.onerror = (e) => {
    const map = {
      'not-allowed': '麦克风没给权限',
      'service-not-allowed': '麦克风没给权限',
      'no-speech': '没听到声音',
      network: '语音识别要联网，网络断了',
      aborted: '',
    };
    const msg = map[e.error] ?? `识别出错：${e.error}`;
    if (msg) onError?.(msg);
  };

  rec.onend = () => {
    onEnd?.();
  };

  return {
    start() {
      finalized = false;
      try {
        rec.start();
      } catch {
        // 上一次还没结束，忽略
      }
    },
    stop() {
      try {
        rec.stop();
      } catch {
        // 已经停了
      }
    },
    abort() {
      try {
        rec.abort();
      } catch {
        // 已经停了
      }
    },
  };
}

let currentVoice = null;

function pickVoice() {
  if (!ttsSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (currentVoice) return currentVoice;
  const zh = voices.filter((v) => /zh|Chinese|中文|普通话/i.test(`${v.lang} ${v.name}`));
  if (!zh.length) return null;
  // 优先本地合成（不联网、延迟低），其次大陆普通话
  currentVoice =
    zh.find((v) => v.localService && /zh[-_]CN/i.test(v.lang)) ??
    zh.find((v) => /zh[-_]CN/i.test(v.lang)) ??
    zh[0];
  return currentVoice;
}

if (ttsSupported()) {
  window.speechSynthesis.onvoiceschanged = () => {
    currentVoice = null;
    pickVoice();
  };
}

// 一句一句念，边说边流式进来也不卡
export function speak(text, { rate = 1.05, onStart, onEnd } = {}) {
  if (!ttsSupported() || !text.trim()) {
    onEnd?.();
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.lang = voice?.lang || 'zh-CN';
  u.rate = rate;
  u.pitch = 1.02;
  u.onstart = () => onStart?.();
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

// 流式文本切成能念的句子
export function makeSentenceSplitter() {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const out = [];
      let idx;
      const re = /[。！？!?…\n]/;
      while ((idx = pending.search(re)) !== -1) {
        const head = pending.slice(0, idx + 1).trim();
        pending = pending.slice(idx + 1);
        if (head) out.push(head);
      }
      return out;
    },
    flush() {
      const rest = pending.trim();
      pending = '';
      return rest ? [rest] : [];
    },
  };
}
