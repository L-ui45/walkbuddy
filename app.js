import { grabFrame, openCamera, stopStream } from './lib/vision.js?v=5';
import { chat, PROVIDERS } from './lib/providers.js?v=5';
import { buildSystem, shouldAttachImage, trimHistory } from './lib/prompt.js?v=5';
import { NOEL_WALK } from './lib/persona.js?v=5';
import { createRecognizer, makeSentenceSplitter, speak, speechSupported, stopSpeaking, ttsSupported } from './lib/speech.js?v=5';

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
  // 走完的每一趟：{ id, startedAt, endedAt, rows: [{role,text,t}] }，新的在前
  trips: [],
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
      cfg.history.push({ role: 'user', text: `${text}${image ? '（附了一张你眼前画面的截图）' : ''}`, t: Date.now() });
      cfg.history.push({ role: 'assistant', text: full.trim(), t: Date.now() });
      // 记录一直留着（只给记录页面看），发给模型时另由 trimHistory 截最近 8 轮；
      // 这里只加一个很宽的上限，防止 localStorage 被撑爆（大约几千轮才碰得到）。
      if (cfg.history.length > 4000) cfg.history = cfg.history.slice(-4000);
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
  $('cfgKey').placeholder = PROVIDERS[cfg.provider]?.keyHint ?? '';
  refreshPersonaCount();
}

function refreshPersonaCount() {
  const n = (cfg.persona || '').trim().length;
  $('personaCount').textContent = n ? `${n} 字` : '默认';
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

let picking = false;
const picked = new Set();
let pressTimer = null;
let pressFrom = null;
let suppressClick = 0;
let suppressItem = -1;
// null = 看当前这一趟；否则是某趟走完的 id（只读回看，也能挑着删）
let viewTrip = null;

function tripById(id) {
  return (cfg.trips || []).find((t) => t.id === id) || null;
}

function rowsOf() {
  const rows = viewTrip ? tripById(viewTrip)?.rows || [] : cfg.history || [];
  return rows.map((m, i) => ({ m, i })).filter(({ m }) => m && m.text);
}

function tripLabel(trip) {
  const d = new Date(trip.startedAt || trip.endedAt || Date.now());
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = (trip.rows || []).filter((m) => m && m.text).length;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh} · ${n} 句`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hh : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}`;
}

function renderTabs() {
  const tabs = $('logTabs');
  tabs.textContent = '';
  const items = [{ id: null, label: '这一趟' }].concat(
    (cfg.trips || []).map((t) => ({ id: t.id, label: tripLabel(t) })),
  );
  const now = viewTrip || null;
  for (const it of items) {
    const b = document.createElement('button');
    b.className = `tab${now === it.id ? ' on' : ''}`;
    b.textContent = it.label;
    b.addEventListener('click', () => {
      viewTrip = it.id;
      picking = false;
      picked.clear();
      renderLog();
    });
    tabs.append(b);
  }
}

function renderLog() {
  const list = $('logList');
  list.textContent = '';
  list.classList.toggle('pick', picking);
  renderTabs();
  const rows = rowsOf();
  const old = Boolean(viewTrip);
  $('logTitle').textContent = picking ? `已选 ${picked.size} 条` : old ? '那趟说过的话' : '这趟说的话';
  $('btnLogPick').hidden = picking || !rows.length;
  $('logActions').hidden = !picking;
  $('logFoot').hidden = picking;
  $('logHint').hidden = picking;

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'log-empty';
    p.textContent = old ? '那趟没留下话。' : '这趟还没开口。';
    list.append(p);
    return;
  }

  let lastTs = 0;
  for (const { m, i } of rows) {
    // 隔了二十分钟以上就插一个时间，方便找回「哪天说的」
    if (m.t && (!lastTs || m.t - lastTs > 20 * 60 * 1000)) {
      const d = document.createElement('div');
      d.className = 'log-day';
      d.textContent = dayLabel(m.t);
      list.append(d);
    }
    if (m.t) lastTs = m.t;
    const el = document.createElement('div');
    el.className = `log-item ${m.role === 'user' ? 'me' : 'her'}${picked.has(i) ? ' picked' : ''}`;
    el.dataset.i = String(i);
    el.textContent = m.text;
    list.append(el);
  }
}

function enterPick(startIndex) {
  picking = true;
  picked.clear();
  if (Number.isInteger(startIndex)) picked.add(startIndex);
  // 长按抬手后浏览器还会补一个 click，别让它把刚选中的那条又取消掉
  suppressItem = Number.isInteger(startIndex) ? startIndex : -1;
  suppressClick = Date.now() + 500;
  navigator.vibrate?.(10);
  renderLog();
}

function exitPick() {
  picking = false;
  picked.clear();
  renderLog();
}

function openLog() {
  stopListen();
  picking = false;
  picked.clear();
  viewTrip = null;
  renderLog();
  $('logSheet').hidden = false;
  const inner = $('logSheet').querySelector('.sheet-inner');
  inner.scrollTop = inner.scrollHeight;
}

function closeLog() {
  $('logSheet').hidden = true;
  picking = false;
  picked.clear();
  viewTrip = null;
}

// 把这趟封存起来（记录不丢，之后还能翻回去看），然后从空的开始下一趟
function startNewTrip() {
  const rows = (cfg.history || []).filter((m) => m && m.text);
  if (rows.length) {
    cfg.trips = cfg.trips || [];
    cfg.trips.unshift({
      id: String(Date.now()),
      startedAt: rows[0].t || Date.now(),
      endedAt: Date.now(),
      rows: rows.slice(-1000),
    });
    // 躺太多趟也是负担，留最近的
    if (cfg.trips.length > 60) cfg.trips.length = 60;
  }
  cfg.history = [];
  save();
  viewTrip = null;
  picking = false;
  picked.clear();
  closeLog();
  clearSpeech();
  showUser('');
  bubble.hidden = true;
  toast('换一趟，往哪边走？');
}

/* ---------- 人设编辑器 ---------- */

function updateEditorCount() {
  const n = $('editorArea').value.trim().length;
  $('editorCount').textContent = n ? `${n} 字` : '默认';
}

function openEditor() {
  stopListen();
  $('editorArea').value = cfg.persona || '';
  updateEditorCount();
  $('editorSheet').hidden = false;
  $('editorArea').focus();
}

function closeEditor() {
  $('editorSheet').hidden = true;
  $('editorArea').blur();
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

$('btnLogPick').addEventListener('click', () => enterPick());
$('btnLogCancel').addEventListener('click', exitPick);
$('btnLogDelete').addEventListener('click', () => {
  const n = picked.size;
  if (!n) {
    exitPick();
    return;
  }
  const trip = viewTrip ? tripById(viewTrip) : null;
  if (trip) {
    trip.rows = (trip.rows || []).filter((_, i) => !picked.has(i));
  } else {
    cfg.history = (cfg.history || []).filter((_, i) => !picked.has(i));
  }
  save();
  picking = false;
  picked.clear();
  renderLog();
  toast(`删了 ${n} 条`);
});

$('btnNewTrip').addEventListener('click', startNewTrip);

const logList = $('logList');

logList.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.log-item');
  if (!el || picking) return;
  pressFrom = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    pressFrom = null;
    enterPick(Number(el.dataset.i));
  }, 450);
});

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
  pressFrom = null;
}

logList.addEventListener('pointerup', cancelPress);
logList.addEventListener('pointercancel', cancelPress);
logList.addEventListener('pointermove', (e) => {
  if (!pressFrom) return;
  if (Math.abs(e.clientX - pressFrom.x) > 10 || Math.abs(e.clientY - pressFrom.y) > 10) cancelPress();
});
logList.addEventListener('contextmenu', (e) => e.preventDefault());

logList.addEventListener('click', (e) => {
  if (!picking) return;
  const el = e.target.closest('.log-item');
  if (!el) return;
  const i = Number(el.dataset.i);
  if (i === suppressItem && Date.now() < suppressClick) return;
  suppressItem = -1;
  if (picked.has(i)) picked.delete(i);
  else picked.add(i);
  renderLog();
});

/* ---------- 人设编辑器绑定 ---------- */

$('btnEditPersona').addEventListener('click', openEditor);
$('btnEditorClose').addEventListener('click', closeEditor);
$('btnEditorCancel').addEventListener('click', closeEditor);
$('editorSheet').addEventListener('click', (e) => {
  if (e.target === $('editorSheet')) closeEditor();
});
$('editorArea').addEventListener('input', updateEditorCount);

$('btnEditorPreset').addEventListener('click', () => {
  $('editorArea').value = NOEL_WALK;
  $('editorCount').textContent = `已填入 ${NOEL_WALK.trim().length} 字`;
});

$('btnEditorClear').addEventListener('click', () => {
  $('editorArea').value = '';
  updateEditorCount();
});

$('btnEditorImport').addEventListener('click', () => $('filePersona').click());

$('filePersona').addEventListener('change', async () => {
  const file = $('filePersona').files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    $('editorArea').value = text.replace(/\r\n/g, '\n').trim();
    $('editorCount').textContent = `已导入 ${file.name}`;
  } catch {
    $('editorCount').textContent = '这个文件读不出来，试试 .md 或 .txt';
  } finally {
    $('filePersona').value = '';
  }
});

$('btnEditorDone').addEventListener('click', () => {
  cfg.persona = $('editorArea').value.trim();
  save();
  refreshPersonaCount();
  closeEditor();
  toast(cfg.persona ? '人设换好了' : '人设清空了');
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
