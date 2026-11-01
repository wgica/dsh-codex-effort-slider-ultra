#!/usr/bin/env node
/**
 * pack.mjs — 打一个可以直接发给别人 / 挂到 Release 的发布压缩包。
 *
 * 产物：dist/<package.json 的 name>-<version>.zip
 *   - zip 里 package.json 在**根目录**（没有外层文件夹），解压即可用；
 *   - 内容 = 仓库根目录下除 node_modules / .git / dist 之外的全部文件；
 *   - 顺带跳过 Thumbs.db / desktop.ini / .DS_Store 这类系统垃圾文件。
 *
 * 用法：
 *   npm run pack
 *   node scripts/pack.mjs
 *   node scripts/pack.mjs --out D:\tmp\plugin.zip
 *
 * 选项：
 *   --out <file>   指定输出文件（默认 dist/<name>-<version>.zip）
 *   --root <dir>   仓库根目录（默认是本脚本所在目录的上一级）
 *   --quiet        只打印最终结果
 *   -h, --help     显示本帮助
 *
 * 零依赖：只用 node 内置模块自己写 zip（deflate + store），不需要安装任何东西，
 * 也不需要 PowerShell / Compress-Archive / zip 命令，Windows、macOS、Linux 都能跑。
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist']);
const EXCLUDE_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

function usage() {
  console.log([
    'pack.mjs — 生成发布压缩包 dist/<name>-<version>.zip',
    '',
    '用法：',
    '  npm run pack',
    '  node scripts/pack.mjs [--out <file>] [--root <dir>] [--quiet]',
    '',
    '选项：',
    '  --out <file>   输出文件路径（默认 dist/<name>-<version>.zip）',
    '  --root <dir>   仓库根目录（默认是本脚本所在目录的上一级）',
    '  --quiet        只打印最终结果',
    '  -h, --help     显示本帮助',
    '',
    '打包内容：仓库根目录下除 node_modules / .git / dist 之外的全部文件，',
    'zip 里 package.json 位于根目录（没有外层文件夹）。',
  ].join('\n'));
}

function fail(message) {
  console.error('× ' + message);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, out: '', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const value = argv[++i];
      if (!value) fail('--out 后面缺少文件路径');
      opts.out = value;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) fail('--root 后面缺少目录');
      opts.root = path.resolve(value);
    } else if (arg === '--quiet' || arg === '-q') {
      opts.quiet = true;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      fail('未知参数：' + arg + '（用 --help 查看用法）');
    }
  }
  return opts;
}

// ── 收集文件 ────────────────────────────────────────────────────────────────

async function walk(dir, root, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      await walk(abs, root, out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name.toLowerCase())) continue;
      out.push({ abs, rel });
    }
    // 符号链接一律跳过：避免递归成环 / 把仓库外的东西打进包里
  }
}

// ── zip 写入（不依赖任何外部库） ────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = Math.min(Math.max(date.getMonth() + 1, 1), 12);
  const day = Math.min(Math.max(date.getDate(), 1), 31);
  const hours = Math.min(Math.max(date.getHours(), 0), 23);
  const minutes = Math.min(Math.max(date.getMinutes(), 0), 59);
  const seconds = Math.min(Math.max(Math.floor(date.getSeconds() / 2), 0), 29);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.rel, 'utf8');
    const data = file.data;
    let method = 0;
    let payload = data;
    if (data.length > 0) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }
    const crc = crc32(data);
    const stamp = dosDateTime(file.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 file names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, v2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.root;

  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    fail('读不了 ' + path.join(root, 'package.json') + '：' + error.message);
  }
  if (!pkg.name || !pkg.version) fail('package.json 缺少 name 或 version');

  const outPath = opts.out ? path.resolve(opts.out) : path.join(root, 'dist', pkg.name + '-' + pkg.version + '.zip');

  const found = [];
  await walk(root, root, found);
  if (found.length === 0) fail('仓库根目录下没有可打包的文件：' + root);

  const files = [];
  let totalBytes = 0;
  for (const file of found) {
    const info = await stat(file.abs);
    const data = await readFile(file.abs);
    files.push({ rel: file.rel, data, mtime: info.mtime });
    totalBytes += data.length;
  }

  const zip = buildZip(files);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, zip);

  const has = (name) => files.some((file) => file.rel === name);
  if (!opts.quiet) {
    console.log('');
    console.log('=== pack：生成发布压缩包 ===');
    console.log('  仓库根目录 : ' + root);
    console.log('  排除目录   : node_modules/  .git/  dist/');
    console.log('  文件数     : ' + files.length);
    console.log('  未压缩大小 : ' + human(totalBytes));
    console.log('  压缩后大小 : ' + human(zip.length) + '（' + Math.round((zip.length / Math.max(totalBytes, 1)) * 100) + '%）');
    console.log('  包内前 10 项：');
    for (const file of files.slice(0, 10)) {
      console.log('    ' + file.rel + '  (' + human(file.data.length) + ')');
    }
    if (files.length > 10) console.log('    … 其余 ' + (files.length - 10) + ' 个文件');
  }
  console.log('');
  console.log('√ ' + path.relative(process.cwd(), outPath).split(path.sep).join('/') + '  (' + human(zip.length) + ')');
  if (has('package.json')) {
    console.log('  package.json 在 zip 根目录 √' + (has('README.md') ? '，README.md √' : '，README.md 缺失 （警告）') + (has('LICENSE') ? '，LICENSE √' : '，LICENSE 缺失 （警告）'));
  } else {
    fail('内部错误：package.json 没有被打进包里');
  }
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
