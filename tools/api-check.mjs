import { readFileSync } from 'node:fs';
import { chat } from '../lib/providers.js';
import { buildSystem } from '../lib/prompt.js';

const cred = readFileSync(process.env.USERPROFILE + '/.dsh/.credentials.yaml', 'utf8');
const key = cred.match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1];
if (!key) throw new Error('no key');

// 造一张 32x32 的纯色 jpeg 当「画面」，只为验证带图的请求体能被接受
const jpeg = (() => {
  const b64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAgACABAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  return Buffer.from(b64, 'base64');
})();

const cfg = { provider: 'deepseek', model: 'deepseek-flash', apiKey: key, base: '' };

async function run(label, { system, history, userText, image }) {
  const t0 = Date.now();
  let first = 0;
  let out = '';
  for await (const chunk of chat(cfg, { system, history, userText, image })) {
    if (!first) first = Date.now() - t0;
    out += chunk;
  }
  console.log(`\n=== ${label} ===`);
  console.log(`首字 ${first}ms / 全程 ${Date.now() - t0}ms / ${out.length} 字`);
  console.log(out.trim());
  return out;
}

const system = buildSystem({ name: '小旅伴', persona: '' });
await run('纯文字', { system, history: [], userText: '我刚下班，出来走走。' });
await run('带图', {
  system: buildSystem({ name: '小旅伴', persona: '', eco: false }),
  history: [],
  userText: '看看我这儿有什么',
  image: jpeg.toString('base64'),
});
await run('带历史', {
  system,
  history: [
    { role: 'user', text: '我在便利店门口' },
    { role: 'assistant', text: '玻璃门反光得厉害，里面灯倒是亮堂。' },
  ],
  userText: '要不要进去买点喝的',
});
