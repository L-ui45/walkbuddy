import { grabFrame, openCamera, stopStream } from './lib/vision.js?v=3';
import { chat, PROVIDERS } from './lib/providers.js?v=3';
import { buildSystem, shouldAttachImage, trimHistory } from './lib/prompt.js?v=3';
import { createRecognizer, makeSentenceSplitter, speak, speechSupported, stopSpeaking, ttsSupported } from './lib/speech.js?v=3';

const $ = (id) => document.getElementById(id);

const video = $('cam');
const input = $('input');
const bubble = $('bubble');
const userLine = $('userLine');
const dot = $('dot');
const stateText = $('stateText');
const btnMic = $('btnMic');

const STORE_KEY = 'walkbuddy.cfg.v1';

const DEFAULTS = {
  name: '小旅伴',
  provider: 'deepseek',
  model: 'deepseek-flash',
  apiKey: '',
  base: '',
  tts: true,
  rate: 1.05,
  eco: false,
  persona: '',
  history: [],
};

let cfg = { ...DEFAULTS, ...load() };
let facing = 'environment';
let busy = false;
let abortCtrl = null;
let sendSeq = 0;
let wakeLock = null;
let listening = false;

/* ---------- 配置 ---------- */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
  } catch {
    // 无痕模式写不进去，这趟能用就行
  }
}

/* ---------- 界面 ---------- */

function setState(s) {
  dot.className = s;
  stateText.textContent =
    { idle: '在身边', listening: '听着', thinking: '在想', speaking: '在说' }[s] ?? '在身边';
}

function showBubble(text) {
  bubble.hidden = false;
  bubble.textContent = text;
  bubble.scrollIntoView?.({ block: 'end' });
}

function showUser(text) {
  userLine.hidden = !text;
  userLine.textContent = text || '';
}

let toastTimer = null;
function toast(text) {
  if (!text) return;
  showBubble(text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (!bubble.dataset.live) bubble.hidden = true;
  }, 4000);
}

/* ---------- 朗读队列 ---------- */

const ttsQueue = [];
let ttsBusy = false;

function clearSpeech() {
  ttsQueue.length = 0;
  ttsBusy = false;
  stopSpeaking();
}

function drainSpeech() {
  if (ttsBusy) return;
  const next = ttsQueue.shift();
  if (!next) {
    setState('idle');
    return;
  }
  ttsBusy = true;
  setState('speaking');
  speak(next, {
    rate: cfg.rate,
    onEnd: () => {
      ttsBusy = false;
      drainSpeech();
    },
  });
}

function say(text) {
  if (!cfg.tts || !ttsSupported()) {
    setState('idle');
    return;
  }
  ttsQueue.push(text);
  drainSpeech();
}

/* ---------- 会话 ---------- */

async function send(textRaw) {
  const text = (textRaw ?? input.value).trim();
  if (!text) return;

  clearSpeech();
  input.value = '';
  showUser(text);

  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const seq = ++sendSeq;
  const mine = () => seq === sendSeq;

  const wantsEyes = shouldAttachImage(text, cfg.eco);
  const image = wantsEyes ? grabFrame(video) : null;

  bubble.hidden = false;
  bubble.dataset.live = '1';
  bubble.textContent = '';
  setState('thinking');
  busy = true;

  const splitter = makeSentenceSplitter();
  let full = '';

  try {
    const stream = chat(cfg, {
      system: buildSystem({ name: cfg.name, persona: cfg.persona, eco: !image }),
      history: trimHistory(cfg.history, 8),
      userText: text,
      image,
      signal: abortCtrl.signal,
    });

    for await (const chunk of stream) {
      if (!mine()) return;
      full += chunk;
      bubble.textContent = full;
      for (const sentence of splitter.push(chunk)) say(sentence);
    }
    if (!mine()) return;
    for (const sentence of splitter.flush()) say(sentence);

    if (!full.trim()) {
      bubble.textContent = '……（没吭声，再说一次？）';
      setState('idle');
    } else {
      cfg.history.push({ role: 'user', text: `${text}${image ? '（附了一张你眼前画面的截图）' : ''}` });
      cfg.history.push({ role: 'assistant', text: full.trim() });
      cfg.history = trimHistory(cfg.history, 16);
      save();
    }
  } catch (err) {
    if (err.name === 'AbortError' || !mine()) return;
    bubble.textContent = err.message || '出错了';
    setState('idle');
  } finally {
    if (mine()) {
      busy = false;
      delete bubble.dataset.live;
    }
  }
}

/* ---------- 语音 ---------- */

const recognizer = speechSupported()
  ? createRecognizer({
      onPartial: (t) => {
        input.value = t;
      },
      onFinal: (t) => {
        input.value = t;
        send(t);
      },
      onError: (msg) => {
        listening = false;
        btnMic.classList.remove('live');
        setState('idle');
        toast(msg);
      },
      onEnd: () => {
        listening = false;
        btnMic.classList.remove('live');
        if (!busy) setState('idle');
      },
    })
  : null;

function startListen() {
  if (!recognizer) {
    toast('这个浏览器不支持语音识别，用键盘上的小话筒打字吧');
    return;
  }
  if (listening) return;
  clearSpeech();
  listening = true;
  btnMic.classList.add('live');
  setState('listening');
  recognizer.start();
}

function stopListen() {
  if (!listening) return;
  recognizer.stop();
}

/* ---------- 摄像头 ---------- */

async function startCamera(nextFacing = facing) {
  facing = nextFacing;
  try {
    await openCamera(video, { facing });
    video.style.opacity = '1';
  } catch (err) {
    toast(err.message || '打不开摄像头');
    throw err;
  }
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request?.('screen');
  } catch {
    // 不支持就算了
  }
}

/* ---------- 设置面板 ---------- */

function fillSheet() {
  $('cfgName').value = cfg.name;
  $('cfgProvider').value = cfg.provider;
  $('cfgModel').value = cfg.model;
  $('cfgKey').value = cfg.apiKey;
  $('cfgBase').value = cfg.base;
  $('cfgTts').checked = cfg.tts;
  $('cfgRate').value = String(cfg.rate);
  $('cfgEco').checked = cfg.eco;
  $('cfgPersona').value = cfg.persona;
  $('cfgKey').placeholder = PROVIDERS[cfg.provider]?.keyHint ?? '';
}

function openSheet() {
  stopListen();
  fillSheet();
  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
}

/* ---------- 聊天记录 ---------- */

function renderLog() {
  const list = $('logList');
  list.textContent = '';
  const rows = (cfg.history || []).filter((m) => m && m.text);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'log-empty';
    p.textContent = '这趟还没开口。';
    list.append(p);
    return;
  }
  for (const m of rows) {
    const el = document.createElement('div');
    el.className = `log-item ${m.role === 'user' ? 'me' : 'her'}`;
    el.textContent = m.text;
    list.append(el);
  }
}

function openLog() {
  stopListen();
  renderLog();
  $('logSheet').hidden = false;
  const inner = $('logSheet').querySelector('.sheet-inner');
  inner.scrollTop = inner.scrollHeight;
}

function closeLog() {
  $('logSheet').hidden = true;
}

function readSheet() {
  cfg.name = $('cfgName').value.trim() || '小旅伴';
  cfg.provider = $('cfgProvider').value;
  cfg.model = $('cfgModel').value.trim() || PROVIDERS[cfg.provider].model;
  cfg.apiKey = $('cfgKey').value.trim();
  cfg.base = $('cfgBase').value.trim();
  cfg.tts = $('cfgTts').checked;
  cfg.rate = Number($('cfgRate').value) || 1.05;
  cfg.eco = $('cfgEco').checked;
  cfg.persona = $('cfgPersona').value;
  save();
  $('buddyName').textContent = cfg.name;
}

/* ---------- 绑定 ---------- */

$('btnStart').addEventListener('click', async () => {
  $('btnStart').disabled = true;
  try {
    await startCamera('environment');
    $('cover').classList.add('hide');
    keepAwake();
    setState('idle');
    showBubble(`${cfg.name}：走吧，我们先往哪边走？`);
  } catch {
    $('btnStart').disabled = false;
    $('coverHint').textContent =
      '摄像头没打开。手机浏览器要 https 才能用，先用局域网或者托管地址打开这个页面试试。';
  }
});

btnMic.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startListen();
});
btnMic.addEventListener('pointerup', stopListen);
btnMic.addEventListener('pointercancel', stopListen);
btnMic.addEventListener('pointerleave', stopListen);

$('btnSend').addEventListener('click', () => send());
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    send();
  }
});

$('btnFlip').addEventListener('click', async () => {
  const next = facing === 'environment' ? 'user' : 'environment';
  try {
    await startCamera(next);
  } catch {
    facing = next === 'user' ? 'environment' : 'user';
  }
});

$('btnSettings').addEventListener('click', openSheet);
$('btnClose').addEventListener('click', closeSheet);
$('btnSave').addEventListener('click', () => {
  readSheet();
  closeSheet();
  toast('记住了');
});
$('btnClear').addEventListener('click', () => {
  cfg.history = [];
  save();
  clearSpeech();
  showUser('');
  bubble.hidden = true;
  closeSheet();
  toast('这趟就当刚碰面');
});

$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) closeSheet();
});

$('btnLog').addEventListener('click', openLog);
$('btnLogClose').addEventListener('click', closeLog);
$('logSheet').addEventListener('click', (e) => {
  if (e.target === $('logSheet')) closeLog();
});

$('cfgProvider').addEventListener('change', () => {
  const p = PROVIDERS[$('cfgProvider').value];
  if (p) {
    $('cfgModel').value = p.model;
    $('cfgKey').placeholder = p.keyHint;
    $('cfgBase').placeholder = p.base;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopListen();
    clearSpeech();
    wakeLock?.release?.().catch(() => {});
    wakeLock = null;
  } else {
    if (!$('cover').classList.contains('hide')) return;
    // 很多手机切后台会掐断摄像头，回来重新要一次
    if (!video.srcObject || video.paused) startCamera(facing).catch(() => {});
    keepAwake();
  }
});

window.addEventListener('beforeunload', () => {
  stopStream(video);
  stopSpeaking();
});

/* ---------- 启动 ---------- */

$('buddyName').textContent = cfg.name;
setState('idle');

if (!speechSupported()) {
  btnMic.style.opacity = '0.45';
}

if (cfg.apiKey && !cfg.history?.length) {
  $('coverHint').textContent = '已经配好了，直接开始就行。';
}
