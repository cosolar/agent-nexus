#!/usr/bin/env node
/**
 * 从 README.md 抽取结构化项目数据，输出 data/projects.json。
 *
 * README 仍是事实来源（single source of truth），本脚本产出的是派生索引，
 * 供链接校验、Star 刷新、统计与后续静态站检索使用。
 *
 * 用法: node scripts/extract.mjs [--check]
 *   --check  仅校验解析结果，不写文件
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const OUT_DIR = path.join(ROOT, 'data');
const OUT_FILE = path.join(OUT_DIR, 'projects.json');

const CHECK_ONLY = process.argv.includes('--check');

/** 解析 Stars 单元格，如 "⭐ **415k**（11-01 实测）" -> { stars: 415000, raw, asOf } */
function parseStars(cell) {
  const raw = cell.replace(/⭐/g, '').trim();
  if (/^(—|-|新项目)/.test(raw)) {
    return { stars: null, raw, asOf: null };
  }
  // 取第一个数字（支持 27.1k / 785 / 41.5 万）
  const numMatch = raw.match(/(\d+(?:\.\d+)?)\s*(k|万)?/i);
  if (!numMatch) return { stars: null, raw, asOf: null };

  let value = parseFloat(numMatch[1]);
  const unit = (numMatch[2] || '').toLowerCase();
  if (unit === 'k') value *= 1000;
  else if (unit === '万') value *= 10000;

  // 日期标注：全角括号内的 MM-DD，年份统一按 2026 处理
  const dateMatch = raw.match(/[（(]\s*(\d{2})-(\d{2})/);
  const asOf = dateMatch ? `2026-${dateMatch[1]}-${dateMatch[2]}` : null;

  return { stars: Math.round(value), raw, asOf };
}

/** 从 URL 中提取 owner/repo */
function parseRepo(url) {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

/** 按列名建立索引，兼容「项目/模型/框架」三种首列表头 */
function buildColumnMap(headerCells) {
  const map = {};
  headerCells.forEach((name, i) => {
    const key = name.replace(/\s/g, '');
    if (/^(项目|模型|框架)$/.test(key)) map.name = i;
    else if (key === 'Stars') map.stars = i;
    else if (key === '语言') map.lang = i;
    else if (key === '出品方') map.org = i;
    else if (key.startsWith('发布')) map.meta = i;
    else if (key === '简介') map.desc = i;
  });
  return map;
}

function main() {
  // 统一换行符：Windows 检出的 CRLF 会让 /(.+)$/ 失效（. 不匹配 \r）
  const markdown = readFileSync(README, 'utf8').replace(/\r\n/g, '\n');

  // 读取上一版数据：表格中的日期标注已移除，需从历史数据继承采集日期
  const prevAsOf = new Map();
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    for (const p of prev.projects || []) {
      if (p.repo && p.stars_as_of) {
        prevAsOf.set(p.repo, { stars: p.stars, asOf: p.stars_as_of });
      }
    }
  } catch {
    // 首次生成，无历史数据可继承
  }
  const lines = markdown.split('\n');

  const projects = [];
  let category = null;
  let categoryIndex = 0;
  let tier = null;
  let cols = null;
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const h3 = line.match(/^### (.+)$/);
    if (h3) {
      category = h3[1].trim();
      categoryIndex += 1;
      tier = null;
      cols = null;
      continue;
    }

    const h4 = line.match(/^#### (.+)$/);
    if (h4) {
      tier = h4[1].trim();
      continue;
    }

    // 表头行：含 Stars 且下一行是分隔线
    if (/^\|/.test(line) && /\|\s*Stars\s*\|/.test(line) && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      cols = buildColumnMap(
        line.split('|').slice(1, -1).map((c) => c.trim())
      );
      continue;
    }

    // 数据行
    if (!cols || !/^\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;

    const nameCell = cells[cols.name ?? 0] || '';
    const linkMatch = nameCell.match(/^\[(.+?)\]\((https?:\/\/[^)]+)\)/);
    if (!linkMatch) continue;

    const name = linkMatch[1].replace(/\*\*/g, '').trim();
    const url = linkMatch[2];
    const starInfo = parseStars(cells[cols.stars ?? 1] || '');
    const repo = parseRepo(url);

    // 表格已不展示日期，采集日期从历史数据继承。
    // stars_as_of 表示「该星数最后一次采集的时间」，与星数是否变化无关，
    // 因此按 repo 无条件继承；星数刷新时由 sync-stars.mjs 同步更新该字段。
    let asOf = starInfo.asOf;
    if (!asOf && repo) {
      const prev = prevAsOf.get(repo);
      if (prev) asOf = prev.asOf;
    }

    if (!starInfo.stars && !/新项目|—/.test(starInfo.raw)) {
      warnings.push(`L${i + 1} ${name}: 星数无法解析 -> "${starInfo.raw}"`);
    }
    if (!repo && url.includes('github.com')) {
      warnings.push(`L${i + 1} ${name}: GitHub 链接无法解析 owner/repo -> ${url}`);
    }

    projects.push({
      name,
      repo,
      url,
      stars: starInfo.stars,
      stars_raw: starInfo.raw,
      stars_as_of: asOf,
      lang: cols.lang != null ? cells[cols.lang]?.replace(/\*\*/g, '').trim() || null : null,
      org: cols.org != null ? cells[cols.org]?.replace(/\*\*/g, '').trim() || null : null,
      meta: cols.meta != null ? cells[cols.meta]?.replace(/\*\*/g, '').trim() || null : null,
      category,
      category_index: categoryIndex,
      tier,
      desc: cols.desc != null ? cells[cols.desc] || null : null,
      line: i + 1,
    });
  }

  // 统计
  const withStars = projects.filter((p) => p.stars != null);
  const dated = projects.filter((p) => p.stars_as_of);
  const byCategory = {};
  for (const p of projects) {
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  }
  const dateBuckets = {};
  for (const p of dated) dateBuckets[p.stars_as_of] = (dateBuckets[p.stars_as_of] || 0) + 1;

  const summary = {
    total: projects.length,
    withStars: withStars.length,
    withoutStars: projects.length - withStars.length,
    dated: dated.length,
    undated: withStars.length - dated.length,
    categories: Object.keys(byCategory).length,
    byCategory,
    dateBuckets,
    warnings,
  };

  console.log('=== 抽取结果 ===');
  console.log(`条目总数: ${summary.total}`);
  console.log(`有星数: ${summary.withStars}  无星数(—/新项目): ${summary.withoutStars}`);
  console.log(`星数带日期: ${summary.dated}  未带日期: ${summary.undated}`);
  console.log(`分类数: ${summary.categories}`);
  console.log('日期分布:', JSON.stringify(dateBuckets, null, 0));
  if (warnings.length) {
    console.log(`\n⚠️ 解析告警 ${warnings.length} 条:`);
    for (const w of warnings.slice(0, 15)) console.log('  ' + w);
    if (warnings.length > 15) console.log(`  … 其余 ${warnings.length - 15} 条`);
  }

  if (CHECK_ONLY) return;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    JSON.stringify({ generatedAt: new Date().toISOString(), summary, projects }, null, 2),
    'utf8'
  );
  console.log(`\n已写入 ${path.relative(ROOT, OUT_FILE)}`);
}

main();
