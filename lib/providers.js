// 把「系统提示 + 历史 + 这一句（可能带图）」拼成各家的请求体。
// 三家都吃 OpenAI 那套 messages 形状，只有 Ollama 的图是单独的 images 字段。

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    base: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyHint: 'sk-…（platform.deepseek.com 申请）',
    needsKey: true,
  },
  siliconflow: {
    label: '硅基流动',
    base: 'https://api.siliconflow.cn',
    model: 'Qwen/Qwen2.5-VL-7B-Instruct',
    keyHint: 'sk-…（cloud.siliconflow.cn 申请）',
    needsKey: true,
  },
  ollama: {
    label: '本机 Ollama',
    base: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:2b',
    keyHint: '不用填',
    needsKey: false,
  },
};

export class ApiError extends Error {
  constructor(message, { status = 0, raw = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.raw = raw;
  }
}

function friendly(status, raw) {
  if (status === 401) return new ApiError('Key 不对，或者没填。点设置里检查一下。', { status, raw });
  if (status === 402) return new ApiError('余额不够了，去充一点再回来。', { status, raw });
  if (status === 429) return new ApiError('请求太快被限流了，缓一下再发。', { status, raw });
  if (status === 404) return new ApiError('模型名或地址不对，设置里改一下。', { status, raw });
  if (status >= 500) return new ApiError('对面服务器出问题了，等会儿再试。', { status, raw });
  return new ApiError(`请求失败（${status}）${raw ? '：' + raw.slice(0, 120) : ''}`, { status, raw });
}

async function* readSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 半截包，丢掉
      }
    }
  }
}

async function* readNDJSON(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const json = JSON.parse(t);
        if (json.error) throw new ApiError(String(json.error), { raw: t });
        const delta = json.message?.content;
        if (delta) yield delta;
        if (json.done) return;
      } catch (err) {
        if (err instanceof ApiError) throw err;
      }
    }
  }
}

function openAIMessages(system, history, userText, imageBase64) {
  const msgs = [{ role: 'system', content: system }];
  for (const turn of history) msgs.push({ role: turn.role, content: turn.text });
  if (imageBase64) {
    msgs.push({
      role: 'user',
      content: [
        { type: 'text', text: userText || '看看我这儿。' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ],
    });
  } else {
    msgs.push({ role: 'user', content: userText });
  }
  return msgs;
}

function pickBase(cfg) {
  const preset = PROVIDERS[cfg.provider] ?? PROVIDERS.deepseek;
  const base = (cfg.base || preset.base).replace(/\/+$/, '');
  return base;
}

export async function* chat(cfg, { system, history, userText, image, signal }) {
  const preset = PROVIDERS[cfg.provider] ?? PROVIDERS.deepseek;
  const model = cfg.model || preset.model;
  const base = pickBase(cfg);

  if (cfg.provider === 'ollama') {
    const messages = [{ role: 'system', content: system }];
    for (const turn of history) messages.push({ role: turn.role, content: turn.text });
    const last = { role: 'user', content: userText || '看看我这儿。' };
    if (image) last.images = [image];
    messages.push(last);

    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { temperature: 1.05 } }),
      signal,
    }).catch((e) => {
      if (e.name === 'AbortError') throw e;
      throw new ApiError('连不上本机 Ollama，确认它在跑、并且允许跨域。', { raw: String(e) });
    });
    if (!res.ok) throw friendly(res.status, await res.text().catch(() => ''));
    yield* readNDJSON(res);
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body = {
    model,
    stream: true,
    temperature: 1.05,
    max_tokens: 320,
    messages: openAIMessages(system, history, userText, image),
  };

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }).catch((e) => {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('网络不通，检查一下手机的网络。', { raw: String(e) });
  });
  if (!res.ok) throw friendly(res.status, await res.text().catch(() => ''));
  yield* readSSE(res);
}

export async function ping(cfg) {
  const started = performance.now();
  let got = false;
  for await (const chunk of chat(cfg, {
    system: '只回一个字。',
    history: [],
    userText: '在吗',
  })) {
    got = got || !!chunk;
    if (got) break;
  }
  return Math.round(performance.now() - started);
}
