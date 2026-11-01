#!/usr/bin/env node
/**
 * set-repo.mjs — 把本仓库的「仓库身份」统一改写成 <owner>/<repo>。
 *
 * 只改两个文件，别的都不碰：
 *   - package.json : repository.url / bugs.url / homepage
 *   - README.md    : raw.githubusercontent.com/<owner>/<repo>/ 前缀（本仓库自己的截图、在线试玩链接）
 *
 * 幂等：目标状态就是当前状态时，一个字节都不写。
 * 出处/致谢里的上游仓库链接（github.com/Microqian2th/...）不会被改：只处理 raw 资源前缀，
 * 且只处理「仓库名与本仓库同名、或只差 -ultra 后缀」的 raw 地址，第三方图片地址原样保留。
 *
 * 用法：
 *   node scripts/set-repo.mjs <owner> <repo>
 *   node scripts/set-repo.mjs <owner> <repo> --dry-run
 *   node scripts/set-repo.mjs wgica/dsh-codex-effort-slider-ultra --dry-run
 *
 * 选项：
 *   --dry-run      只打印将要做的修改，不写任何文件
 *   --root <dir>   仓库根目录（默认是本脚本所在目录的上一级）
 *   -h, --help     显示本帮助
 *
 * 零依赖，只用 node 内置模块；需要 Node.js >= 18。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const RAW_PREFIX_RE = /https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\//g;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function usage() {
  console.log(`
set-repo.mjs — 统一改写本仓库的仓库身份（package.json 元数据 + README 的 raw 前缀）

用法：
  node scripts/set-repo.mjs <owner> <repo> [--dry-run]
  node scripts/set-repo.mjs <owner>/<repo> [--dry-run]

选项：
  --dry-run      只打印将要做的修改，不写任何文件
  --root <dir>   仓库根目录（默认是本脚本所在目录的上一级）
  -h, --help     显示本帮助

示例：
  node scripts/set-repo.mjs wgica dsh-codex-effort-slider-ultra --dry-run
  node scripts/set-repo.mjs wgica dsh-codex-effort-slider-ultra

改写的字段：
  package.json  repository.url → git+https://github.com/<owner>/<repo>.git
                bugs.url       → https://github.com/<owner>/<repo>/issues
                homepage       → https://github.com/<owner>/<repo>#readme
  README.md     https://raw.githubusercontent.com/<旧 owner>/<旧 repo>/…
                → https://raw.githubusercontent.com/<owner>/<repo>/…

幂等：已经是目标状态时不写文件，退出码 0。
`);
}

function fail(message) {
  console.error('× ' + message);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { dryRun: false, root: DEFAULT_ROOT, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') {
      opts.dryRun = true;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) fail('--root 后面缺少目录');
      opts.root = path.resolve(value);
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      fail('未知选项：' + arg + '（用 --help 查看用法）');
    } else {
      opts.positional.push(arg);
    }
  }
  if (opts.positional.length === 1 && opts.positional[0].includes('/')) {
    const parts = opts.positional[0].split('/');
    if (parts.length !== 2) fail('仓库坐标格式应为 <owner>/<repo>');
    opts.owner = parts[0];
    opts.repo = parts[1];
  } else if (opts.positional.length === 2) {
    opts.owner = opts.positional[0];
    opts.repo = opts.positional[1];
  } else {
    usage();
    fail('需要 <owner> <repo> 两个参数（或用 --help 查看用法）');
  }
  if (!OWNER_RE.test(opts.owner)) fail('owner 不是合法的 GitHub 用户名：' + opts.owner);
  if (!REPO_RE.test(opts.repo)) fail('repo 不是合法的 GitHub 仓库名：' + opts.repo);
  return opts;
}

/** 去掉 "ultra" 变体后缀后的仓库名，用来识别「同一个仓库的 Ultra 分支」的老地址。 */
function baseName(name) {
  return String(name).toLowerCase().replace(/-ultra$/, '');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), bom: true } : { text, bom: false };
}

async function readJson(file) {
  const raw = await readFile(file, 'utf8');
  return JSON.parse(stripBom(raw).text);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { owner, repo, dryRun, root } = opts;

  const packagePath = path.join(root, 'package.json');
  const readmePath = path.join(root, 'README.md');

  let pkg;
  try {
    pkg = await readJson(packagePath);
  } catch (error) {
    fail('读不了 ' + packagePath + '：' + error.message);
  }
  if (!pkg || typeof pkg !== 'object') fail(packagePath + ' 不是合法的 JSON 对象');

  const target = {
    repositoryUrl: 'git+https://github.com/' + owner + '/' + repo + '.git',
    bugsUrl: 'https://github.com/' + owner + '/' + repo + '/issues',
    homepage: 'https://github.com/' + owner + '/' + repo + '#readme',
    rawPrefix: 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/',
  };

  // 从现有元数据里认出「旧坐标」，只改本仓库自己的 raw 地址（含上游同名 Ultra 变体）。
  const oldUrl = (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url) || pkg.homepage || '';
  const oldMatch = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?]|$)/.exec(oldUrl);
  const oldOwner = oldMatch ? oldMatch[1] : '';
  const oldRepo = oldMatch ? oldMatch[2] : '';
  const knownNames = new Set([baseName(repo), baseName(pkg.name || '')]);
  if (oldRepo) knownNames.add(baseName(oldRepo));

  const relevantRawRepo = (rawRepo) => knownNames.has(baseName(rawRepo));

  console.log('');
  console.log('=== set-repo：统一仓库身份 ===');
  console.log('  目标仓库   : ' + owner + '/' + repo);
  console.log('  仓库根目录 : ' + root);
  console.log('  模式       : ' + (dryRun ? 'dry-run（只预览，不写文件）' : '写入'));
  if (oldOwner || oldRepo) console.log('  旧坐标     : ' + (oldOwner || '?') + '/' + (oldRepo || '?'));
  console.log('');

  // ── package.json ────────────────────────────────────────────────────────
  const pkgChanges = [];
  const nextPkg = { ...pkg };

  const currentRepoUrl = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || '';
  if (currentRepoUrl !== target.repositoryUrl) {
    pkgChanges.push(['repository.url', currentRepoUrl || '(缺失)', target.repositoryUrl]);
  }
  nextPkg.repository = { type: 'git', url: target.repositoryUrl };

  const currentBugs = typeof pkg.bugs === 'string' ? pkg.bugs : (pkg.bugs && pkg.bugs.url) || '';
  if (currentBugs !== target.bugsUrl) {
    pkgChanges.push(['bugs.url', currentBugs || '(缺失)', target.bugsUrl]);
  }
  nextPkg.bugs = { url: target.bugsUrl };

  const currentHomepage = pkg.homepage || '';
  if (currentHomepage !== target.homepage) {
    pkgChanges.push(['homepage', currentHomepage || '(缺失)', target.homepage]);
  }
  nextPkg.homepage = target.homepage;

  console.log('package.json');
  if (pkgChanges.length === 0) {
    console.log('  √ 已是目标状态');
  } else {
    for (const [field, from, to] of pkgChanges) console.log('  ' + field + '\n      ' + from + '\n   → ' + to);
  }
  console.log('');

  // ── README.md ───────────────────────────────────────────────────────────
  let readmeChanges = 0;
  let nextReadme = null;
  const readmeSamples = [];
  try {
    const raw = await readFile(readmePath, 'utf8');
    const { text, bom } = stripBom(raw);
    const lines = text.split('\n');
    const rewritten = lines.map((line, index) => {
      return line.replace(RAW_PREFIX_RE, (match, rawOwner, rawRepo) => {
        if (rawOwner === owner && rawRepo === repo) return match; // 已经是目标地址
        if (!relevantRawRepo(rawRepo)) return match; // 第三方资源，保留原样
        readmeChanges += 1;
        if (readmeSamples.length < 6) {
          readmeSamples.push({ line: index + 1, from: 'raw.githubusercontent.com/' + rawOwner + '/' + rawRepo + '/', to: 'raw.githubusercontent.com/' + owner + '/' + repo + '/' });
        }
        return target.rawPrefix;
      });
    });
    if (readmeChanges > 0) nextReadme = (bom ? '\ufeff' : '') + rewritten.join('\n');

    console.log('README.md');
    if (readmeChanges === 0) {
      console.log('  √ 没有需要改写的 raw 前缀');
    } else {
      console.log('  改写 raw 前缀 ' + readmeChanges + ' 处 → ' + target.rawPrefix);
      for (const sample of readmeSamples) console.log('    行 ' + sample.line + ': ' + sample.from + ' → ' + sample.to);
      if (readmeChanges > readmeSamples.length) console.log('    … 其余 ' + (readmeChanges - readmeSamples.length) + ' 处相同规则');
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log('README.md');
      console.log('  （警告） 未找到 README.md，跳过');
    } else {
      fail('读不了 ' + readmePath + '：' + error.message);
    }
  }
  console.log('');

  const touched = (pkgChanges.length > 0 ? 1 : 0) + (readmeChanges > 0 ? 1 : 0);
  if (touched === 0) {
    console.log('√ 仓库身份已是目标状态，无需修改。');
    return;
  }
  if (dryRun) {
    console.log('√ dry-run 结束：' + touched + ' 个文件需要修改（未写入）。去掉 --dry-run 再运行即可落盘。');
    return;
  }
  if (pkgChanges.length > 0) {
    await writeFile(packagePath, JSON.stringify(nextPkg, null, 2) + '\n', 'utf8');
    console.log('√ 已写入 package.json');
  }
  if (readmeChanges > 0) {
    await writeFile(readmePath, nextReadme, 'utf8');
    console.log('√ 已写入 README.md（' + readmeChanges + ' 处 raw 前缀）');
  }
  console.log('完成：' + touched + ' 个文件已更新。');
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
