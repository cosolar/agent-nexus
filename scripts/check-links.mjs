#!/usr/bin/env node
/**
 * 校验 README 中的链接可达性。
 *
 * 用法:
 *   node scripts/check-links.mjs                # 检查并输出报告
 *   node scripts/check-links.mjs --json         # 额外输出 reports/link-check.json
 *   node scripts/check-links.mjs --only=github  # 只检查 GitHub 链接
 *   node scripts/check-links.mjs --concurrency 3 --timeout 12000
 *
 * 退出码: 0 全部可达 / 1 存在失效链接
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const REPORT_DIR = path.join(ROOT, 'reports');

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CONCURRENCY = Number(getArg('--concurrency', 3));
const TIMEOUT = Number(getArg('--timeout', 12000));
const ONLY = (getArg('--only', '') || '').toLowerCase();
const WRITE_JSON = argv.includes('--json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 提取链接，并记录所在行号与所属项目名，便于定位 */
function extractLinks(markdown) {
  const lines = markdown.split('\n');
  const seen = new Map();
  const urlRe = /https?:\/\/[^\s)|\]"'<>]+/g;

  lines.forEach((line, idx) => {
    const nameMatch = line.match(/^\|\s*\[\*\*([^*\]]+)\*\*\]/);
    const context = nameMatch ? nameMatch[1].trim() : '';
    for (const raw of line.match(urlRe) || []) {
      const url = raw.replace(/[.,;:，。；：]+$/, '');
      if (!seen.has(url)) seen.set(url, { url, line: idx + 1, context });
    }
  });
  return [...seen.values()];
}

async function checkOne(item, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(item.url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 agent-nexus-linkcheck',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timer);
    // 不消费响应体，避免拉取整页内容
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    const redirected = res.url && res.url !== item.url;
    return {
      ...item,
      status: res.status,
      ok: res.ok,
      finalUrl: redirected ? res.url : null,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err?.name === 'AbortError';
    // 超时不重试：慢站点重试只会成倍放大耗时；仅对瞬时网络错误重试一次
    if (!isTimeout && attempt < 1) {
      await sleep(900);
      return checkOne(item, attempt + 1);
    }
    return {
      ...item,
      status: 0,
      ok: false,
      error: isTimeout ? 'timeout' : String(err?.message || err),
    };
  }
}

async function pool(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
      done += 1;
      onProgress?.(done, items.length, results[i]);
      await sleep(250); // 温和限速，避免触发目标站点风控
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 结果分类：
 *   ok      —— 2xx/3xx，可达
 *   invalid —— 404/410，确定不存在
 *   unknown —— 403/429/5xx/网络错误，无法判定（反爬、限流、墙）
 * 只有 invalid 才算真正失效，避免把网络问题误报为死链。
 */
function classify(r) {
  if (r.ok) return 'ok';
  if (r.status === 404 || r.status === 410) return 'invalid';
  return 'unknown';
}

function buildReport(all, checkedAt, skippedGithub = 0) {
  const buckets = { ok: [], invalid: [], unknown: [] };
  for (const r of all) buckets[classify(r)].push(r);
  const redirects = buckets.ok.filter((r) => r.finalUrl);

  const lines = [
    '# 链接校验报告',
    '',
    `- 检查时间：${checkedAt}`,
    `- 检查链接：${all.length} 个（去重后）`,
    `- 可达：${buckets.ok.length} 个`,
    `- **确定失效（404/410）：${buckets.invalid.length} 个**`,
    `- 无法判定（403/429/5xx/超时）：${buckets.unknown.length} 个`,
    `- 重定向：${redirects.length} 个`,
  ];
  if (skippedGithub) {
    lines.push(
      `- 跳过 GitHub 链接：${skippedGithub} 个（本地网络无法直连 github.com，需在 CI 中校验）`
    );
  }
  lines.push('');

  if (buckets.invalid.length) {
    lines.push('## ❌ 确定失效', '', '| 状态 | 项目 | 链接 | 位置 |', '| :---: | :--- | :--- | :---: |');
    for (const f of buckets.invalid) {
      lines.push(`| ${f.status} | ${f.context || '—'} | ${f.url} | L${f.line} |`);
    }
    lines.push('');
  }

  if (buckets.unknown.length) {
    lines.push(
      '## ⚠️ 无法判定（需人工复核）',
      '',
      '> 403/429/521 多为站点反爬或限流，超时多为本地网络不可达，**不等于链接失效**。',
      '',
      '| 状态 | 项目 | 链接 | 说明 |',
      '| :---: | :--- | :--- | :--- |'
    );
    for (const f of buckets.unknown) {
      const reason = f.error ? f.error : `HTTP ${f.status}`;
      lines.push(`| ${f.status || 'ERR'} | ${f.context || '—'} | ${f.url} | ${reason} |`);
    }
    lines.push('');
  }

  if (redirects.length) {
    lines.push('## ↪️ 发生重定向（建议更新为最终地址）', '', '| 项目 | 原链接 | 最终地址 |', '| :--- | :--- | :--- |');
    for (const r of redirects) {
      lines.push(`| ${r.context || '—'} | ${r.url} | ${r.finalUrl} |`);
    }
    lines.push('');
  }

  if (!buckets.invalid.length) lines.push('## ✅ 无确定失效链接', '');

  return { text: lines.join('\n'), buckets };
}

/** 探测站点是否可达（用于判断本地网络能否访问 GitHub） */
async function probe(url, timeout = 8000) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'Mozilla/5.0 agent-nexus-linkcheck' },
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  const markdown = await readFile(README, 'utf8');
  let links = extractLinks(markdown);

  if (ONLY === 'github') links = links.filter((l) => l.url.includes('github.com'));
  if (ONLY === 'external') links = links.filter((l) => !l.url.includes('github.com'));

  // 本地网络（尤其大陆网络）常无法直连 github.com，此时跳过而非误报失效
  let skippedGithub = 0;
  if (ONLY !== 'external') {
    const ghReachable = await probe('https://github.com');
    if (!ghReachable) {
      const before = links.length;
      links = links.filter((l) => !l.url.includes('github.com'));
      skippedGithub = before - links.length;
      console.warn(
        `⚠️  无法访问 github.com，已跳过 ${skippedGithub} 个 GitHub 链接。\n` +
          `    完整校验请在 GitHub Actions 中运行（见 .github/workflows/link-check.yml）。\n`
      );
    }
  }

  console.log(`开始校验 ${links.length} 个链接（并发 ${CONCURRENCY}，超时 ${TIMEOUT}ms）…\n`);

  const results = await pool(links, CONCURRENCY, checkOne, (done, total, r) => {
    if (done % 25 === 0 || done === total) {
      process.stdout.write(`  进度 ${done}/${total}  最近: ${r.ok ? 'OK' : 'FAIL'} ${r.url.slice(0, 60)}\n`);
    }
  });

  const checkedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const { text, buckets } = buildReport(results, checkedAt, skippedGithub);

  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, 'link-check.md');
  await writeFile(reportPath, text, 'utf8');
  if (WRITE_JSON) {
    await writeFile(
      path.join(REPORT_DIR, 'link-check.json'),
      JSON.stringify(
        {
          checkedAt,
          total: results.length,
          skippedGithub,
          ok: buckets.ok.length,
          invalid: buckets.invalid,
          unknown: buckets.unknown,
        },
        null,
        2
      ),
      'utf8'
    );
  }

  console.log(
    `\n完成：${results.length} 个链接 | 可达 ${buckets.ok.length} | 确定失效 ${buckets.invalid.length} | 无法判定 ${buckets.unknown.length}`
  );
  console.log(`报告：${path.relative(ROOT, reportPath)}`);
  if (buckets.invalid.length) {
    console.log('\n确定失效清单：');
    for (const f of buckets.invalid.slice(0, 30)) {
      console.log(`  [${f.status}] ${f.context || '—'}  ${f.url}`);
    }
    if (buckets.invalid.length > 30) console.log(`  … 其余 ${buckets.invalid.length - 30} 条见报告`);
  }

  process.exit(buckets.invalid.length ? 1 : 0);
}

main().catch((err) => {
  console.error('校验失败:', err);
  process.exit(2);
});
