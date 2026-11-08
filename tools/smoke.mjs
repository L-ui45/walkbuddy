// 用 CDP 在真 Chrome 里跑一遍：开假摄像头 → 点开始 → 发一句话 → 看回复
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_APP = process.env.APP_URL || 'http://127.0.0.1:5199/';
const PORT = 9333;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const cred = readFileSync(process.env.USERPROFILE + '/.dsh/.credentials.yaml', 'utf8');
const key = cred.match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1];
if (!key) throw new Error('no key');

const cfg = { name: '小旅伴', provider: 'deepseek', model: 'deepseek-flash', apiKey: key, base: '', tts: false, rate: 1.05, eco: false, persona: '', history: [] };

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\wb-cdp`,
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  URL_APP,
], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // chrome 还没起来
    }
    await sleep(300);
  }
  throw new Error('CDP 没连上');
}

const wsUrl = await targets();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    logs.push(`console.${msg.params.type} ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});

function cdp(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
}

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
}

await cdp('Runtime.enable');
await cdp('Page.enable');
await cdp('Network.enable');
await cdp('Network.setCacheDisabled', { cacheDisabled: true }); // Pages 给静态文件 max-age=600，不复用旧缓存

for (let i = 0; i < 40; i += 1) {
  const st = await evaluate(`location.href + '|' + document.readyState`);
  if (st.startsWith(URL_APP) && st.endsWith('complete')) break;
  await sleep(250);
}

await evaluate(`localStorage.setItem('walkbuddy.cfg.v1', ${JSON.stringify(JSON.stringify(cfg))}); 'ok'`);
await cdp('Page.reload');

// 等 app.js 真正跑起来（缓存关掉后模块加载会慢一点，不能只 sleep）
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  const st = await evaluate(`JSON.stringify({ s: document.getElementById('stateText').textContent, r: document.readyState })`);
  if (!st.includes('还没出门') && st.includes('complete')) break;
}

const booted = await evaluate(`document.getElementById('stateText').textContent`);
console.log('启动后状态:', booted);

await evaluate(`document.getElementById('btnStart').click(); 'clicked'`);
await sleep(1500);

const afterStart = await evaluate(`JSON.stringify({
  coverHidden: document.getElementById('cover').classList.contains('hide'),
  hasStream: !!document.getElementById('cam').srcObject,
  videoW: document.getElementById('cam').videoWidth,
  state: document.getElementById('stateText').textContent,
  bubble: document.getElementById('bubble').textContent,
})`);
console.log('点开始后:', afterStart);

await evaluate(`(() => {
  const i = document.getElementById('input');
  i.value = '你看到什么了？';
  document.getElementById('btnSend').click();
  return 'sent';
})()`);

let reply = '';
for (let i = 0; i < 40; i += 1) {
  await sleep(400);
  reply = await evaluate(`document.getElementById('bubble').textContent`);
  if (reply && reply.length > 4 && !(await evaluate(`document.getElementById('bubble').dataset.live === '1'`))) break;
}
console.log('回复:', reply);
console.log('状态:', await evaluate(`document.getElementById('stateText').textContent`));
console.log('历史条数:', await evaluate(`JSON.parse(localStorage.getItem('walkbuddy.cfg.v1')).history.length`));

// 再发一句，测历史与连续对话
await evaluate(`(() => { const i = document.getElementById('input'); i.value = '那要不要过去？'; document.getElementById('btnSend').click(); return 1; })()`);
let reply2 = '';
for (let i = 0; i < 40; i += 1) {
  await sleep(400);
  reply2 = await evaluate(`document.getElementById('bubble').textContent`);
  const live = await evaluate(`document.getElementById('bubble').dataset.live === '1'`);
  if (reply2 && !live) break;
}
console.log('第二句回复:', reply2);

// 点开聊天记录，看面板里有没有这几句
await evaluate(`document.getElementById('btnLog').click(); 'ok'`);
await sleep(300);
const logPanel = await evaluate(`JSON.stringify({
  open: !document.getElementById('logSheet').hidden,
  items: document.querySelectorAll('#logList .log-item').length,
  first: document.querySelector('#logList .log-item')?.textContent || '',
  last: document.querySelector('#logList .log-item:last-child')?.textContent || '',
})`);
console.log('聊天记录面板:', logPanel);

// 长按第一条 → 应该进入挑选模式
await evaluate(`(() => {
  const el = document.querySelectorAll('#logList .log-item')[0];
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 300 }));
  return 'down';
})()`);
await sleep(700);
await evaluate(`(() => {
  const el = document.querySelectorAll('#logList .log-item')[0];
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 300 }));
  return 'up';
})()`);
const pickState = await evaluate(`JSON.stringify({
  picking: document.getElementById('logList').classList.contains('pick'),
  title: document.getElementById('logTitle').textContent,
  picked: document.querySelectorAll('#logList .log-item.picked').length,
  actionsShown: !document.getElementById('logActions').hidden,
})`);
console.log('长按挑选:', pickState);

// 再勾一条，删掉这两条
await evaluate(`document.querySelectorAll('#logList .log-item')[3].click(); 'ok'`);
await sleep(150);
const pickedN = await evaluate(`JSON.stringify({ picked: document.querySelectorAll('#logList .log-item.picked').length, title: document.getElementById('logTitle').textContent })`);
console.log('勾选后:', pickedN);

const beforeDel = await evaluate(`JSON.parse(localStorage.getItem('walkbuddy.cfg.v1')).history.length`);
await evaluate(`document.getElementById('btnLogDelete').click(); 'ok'`);
await sleep(250);
const afterDel = await evaluate(`JSON.stringify({
  history: JSON.parse(localStorage.getItem('walkbuddy.cfg.v1')).history.length,
  items: document.querySelectorAll('#logList .log-item').length,
  picking: document.getElementById('logList').classList.contains('pick'),
})`);
console.log('删除后:', `历史 ${beforeDel} →`, afterDel);

await evaluate(`document.getElementById('btnLogClose').click(); 'ok'`);
console.log('面板关闭:', await evaluate(`document.getElementById('logSheet').hidden`));

// 人设：打开编辑器 → 填入诺艾儿 → 保存 → 字数回显
await evaluate(`document.getElementById('btnSettings').click(); 'ok'`);
await sleep(200);
await evaluate(`document.getElementById('btnEditPersona').click(); 'ok'`);
await sleep(200);
const editorOpen = await evaluate(`JSON.stringify({
  open: !document.getElementById('editorSheet').hidden,
  empty: document.getElementById('editorArea').value.length === 0,
})`);
console.log('人设编辑器:', editorOpen);
await evaluate(`document.getElementById('btnEditorPreset').click(); 'ok'`);
await sleep(120);
const presetLen = await evaluate(`document.getElementById('editorArea').value.length`);
await evaluate(`document.getElementById('btnEditorDone').click(); 'ok'`);
await sleep(200);
const saved = await evaluate(`JSON.stringify({
  persona: JSON.parse(localStorage.getItem('walkbuddy.cfg.v1')).persona.length,
  count: document.getElementById('personaCount').textContent,
  editorClosed: document.getElementById('editorSheet').hidden,
})`);
console.log('人设保存:', `填入 ${presetLen} 字 →`, saved);

console.log('页面错误:', logs.length ? logs : '无');
ws.close();
chrome.kill();
process.exit(0);
