#!/usr/bin/env node
/**
 * 通过 GitHub API 刷新星数，并回写 README 与 data/projects.json。
 *
 * 需要网络可访问 api.github.com；建议在 CI 中运行并配置 GITHUB_TOKEN（限额 5000/h）。
 * 本地大陆网络通常无法直连，脚本会明确报错而非静默失败。
 *
 * 用法:
 *   node scripts/sync-stars.mjs --dry-run          # 只打印差异，不写文件
 *   node scripts/sync-stars.mjs --write            # 实际写入
 *   node scripts/sync-stars.mjs --limit 20         # 只处理前 20 条（调试用）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const DATA = path.join(ROOT, 'data', 'projects.json');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const LIMIT = Number((() => {
  const i = argv.indexOf('--limit');
  return i >= 0 ? argv[i + 1] : 0;
})());
const TOKEN = process.env.GITHUB_TOKEN || '';
const CONCURRENCY = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 415000 -> "415k"；119600 -> "119.6k"；785 -> "785" */
function fmtStars(n) {
  if (n >= 1000) {
    const k = n / 1000;
    const text = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '');
    return `${text}k`;
  }
  return String(n);
}

function todayStamp() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

async function fetchStars(repo, attempt = 0) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'agent-nexus-sync',
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 403 || res.status === 429) {
      // 限流：退避一次
      if (attempt < 2) {
        await sleep(3000 * (attempt + 1));
        return fetchStars(repo, attempt + 1);
      }
      return { error: `rate-limited (${res.status})` };
    }
    if (res.status === 404) return { error: 'not-found' };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return {
      stars: json.stargazers_count,
      archived: Boolean(json.archived),
      fullName: json.full_name,
    };
  } catch (err) {
    if (attempt < 1) {
      await sleep(1500);
      return fetchStars(repo, attempt + 1);
    }
    return { error: String(err?.message || err) };
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
      await sleep(120);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main() {
  const data = JSON.parse(readFileSync(DATA, 'utf8'));
  let targets = data.projects.filter((p) => p.repo);
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`准备刷新 ${targets.length} 个仓库的星数${TOKEN ? '（已认证）' : '（未认证，限额 60/h）'}…`);

  const results = await pool(targets, CONCURRENCY, async (p) => {
    const r = await fetchStars(p.repo);
    return { project: p, ...r };
  });

  const changes = [];
  const errors = [];
  for (const r of results) {
    if (r.error) {
      errors.push(`${r.project.name} (${r.project.repo}): ${r.error}`);
      continue;
    }
    if (r.stars !== r.project.stars) {
      changes.push({
        name: r.project.name,
        repo: r.project.repo,
        from: r.project.stars,
        to: r.stars,
        line: r.project.line,
      });
    }
  }

  console.log(`\n完成：变更 ${changes.length} 条，失败 ${errors.length} 条`);
  if (changes.length) {
    console.log('\n前 20 条变更：');
    for (const c of changes.slice(0, 20)) {
      console.log(`  ${c.name}: ${c.from ?? '—'} -> ${c.to}  (${c.repo})`);
    }
    if (changes.length > 20) console.log(`  … 其余 ${changes.length - 20} 条`);
  }
  if (errors.length) {
    console.log('\n失败样例：');
    for (const e of errors.slice(0, 10)) console.log('  ' + e);
    if (errors.length > 10) console.log(`  … 其余 ${errors.length - 10} 条`);
  }

  if (!WRITE) {
    console.log('\n[dry-run] 未写入文件。加 --write 生效。');
    return;
  }
  if (!changes.length) {
    console.log('\n无变更，跳过写入。');
    return;
  }

  // 1) 回写 README（按行号替换 Stars 单元格，行号不变，故可批量处理）
  const stamp = todayStamp();
  const lines = readFileSync(README, 'utf8').split('\n');
  const byLine = new Map(changes.map((c) => [c.line, c]));
  let patched = 0;

  for (let i = 0; i < lines.length; i++) {
    const change = byLine.get(i + 1);
    if (!change) continue;
    const cells = lines[i].split('|');
    if (cells.length < 3) continue;
    // 表格只展示星数，不写日期标注；采集时间记录在 data/projects.json
    const newCell = ` ⭐ **${fmtStars(change.to)}** `;
    if (!/⭐/.test(cells[2])) continue;
    cells[2] = newCell;
    lines[i] = cells.join('|');
    patched += 1;
  }

  writeFileSync(README, lines.join('\n'), 'utf8');
  console.log(`\n已更新 README 中 ${patched} 行星数`);

  // 2) 回写结构化数据
  for (const p of data.projects) {
    const hit = results.find((r) => r.project === p && !r.error);
    if (hit && hit.stars != null) {
      p.stars = hit.stars;
      p.stars_raw = `**${fmtStars(hit.stars)}**`;
      p.stars_as_of = `2026-${stamp}`;
    }
  }
  data.generatedAt = new Date().toISOString();
  mkdirSync(path.dirname(DATA), { recursive: true });
  writeFileSync(DATA, JSON.stringify(data, null, 2), 'utf8');
  console.log(`已更新 ${path.relative(ROOT, DATA)}`);
}

main().catch((err) => {
  console.error('刷新失败:', err);
  process.exit(2);
});
