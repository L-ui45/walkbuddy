// 用 GitHub API 发一次提交（本机 git 直连 github.com 常超时，走 api.github.com 更稳）
// 用法：node tools/deploy.mjs "提交说明"
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = 'L-ui45';
const REPO = 'walkbuddy';
const BRANCH = 'main';
const SKIP = new Set(['.git', 'node_modules', 'tools']);
const message = process.argv[2] || 'update';

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('凭据管理器里没找到 github.com 的 token');
  return m[1].trim();
}

const TOKEN = token();

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'walkbuddy-deploy',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).split('\\').join('/');
    if (SKIP.has(name) || SKIP.has(rel.split('/')[0])) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(rel);
  }
  return out;
}

const files = walk(ROOT);
console.log('要发布的文件:', files.join(', '));

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const head = ref.object.sha;
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${head}`);

const tree = [];
for (const path of files) {
  const content = readFileSync(join(ROOT, path), 'utf8');
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });
  tree.push({ path: posix.normalize(path), mode: '100644', type: 'blob', sha: blob.sha });
  console.log('  blob', path, blob.sha.slice(0, 8));
}

const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: commit.tree.sha, tree }),
});
const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
});
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: newCommit.sha, force: false }),
});
console.log('已推送到', BRANCH, newCommit.sha);
console.log('Pages 地址 https://l-ui45.github.io/walkbuddy/ 约 30 秒后生效');
