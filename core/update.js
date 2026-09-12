'use strict';

/**
 * 版本检查与自更新。
 *
 * - checkRemoteVersion()：从 GitHub 读取远端 package.json 的 version（只读，无副作用）
 * - applyUpdate()：git pull → npm install（仅依赖变化时）→ npm run build
 *
 * 安全约束：
 *   1. 所有外部命令都用 execFile + 参数数组，绝不拼 shell 字符串（避免命令注入）。
 *   2. 只在「干净的 git 工作区」上执行 pull：有未提交改动时直接拒绝，
 *      避免把用户本地修改冲掉（这是自更新最危险的一步）。
 *   3. 不自动重启进程：core/ 的改动需要重启才生效，由用户手动重启，
 *      避免在 Windows 上产生孤儿进程 / 端口占用。
 */

const path = require('path');
const { execFile } = require('child_process');

const config = require('./config');
const logger = require('./logger');

/** 项目根目录（core/ 的上一级） */
const ROOT = path.join(__dirname, '..');

/** 远端版本来源：raw.githubusercontent.com 读 main 分支的 package.json */
const REPO = 'MrWhatHuang/CodeBuddy-API-Proxy';
const BRANCH = process.env.CODEBUDDY_UPDATE_BRANCH || 'main';
const VERSION_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`;

/** 单条命令超时：git pull 与 npm install 可能较慢，给足时间 */
const GIT_TIMEOUT_MS = 120000;
const NPM_TIMEOUT_MS = 600000;

/** 自更新是否可用：必须是非空目录下的 git 仓库 */
let cachedGitRoot = null;

/** 执行外部命令，返回 { code, stdout, stderr, timedOut }（不抛异常） */
function run(cmd, args, { cwd = ROOT, timeoutMs = 60000, env } = {}) {
  return new Promise((resolve) => {
    // Windows 上 .cmd/.bat 不能在 Node 18+ 直接用 execFile 启动
    // （CVE-2024-27980 之后要求 shell:true），否则抛 spawn EINVAL。
    // npm 在 Windows 上就是 npm.cmd，必须走这个分支。
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    execFile(cmd, args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      shell: needsShell,
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!(err && err.killed),
        error: err ? String(err.message || err) : '',
      });
    });
  });
}

/** npm 在 Windows 上是 npm.cmd，直接 execFile('npm') 会 ENOENT */
function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * 解析版本号为可比较的数字数组，忽略预发布后缀（如 -beta.1）。
 * 容忍 2 段写法（如 `1.3` 视为 1.3.0），因为手写 package.json 时常见。
 */
function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** a > b 返回 1，a < b 返回 -1，相等返回 0，无法解析返回 null */
function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** 当前是否在一个 git 仓库里；返回仓库根目录，否则 null */
async function detectGitRoot() {
  if (cachedGitRoot !== null) return cachedGitRoot || null;
  const r = await run('git', ['rev-parse', '--show-toplevel'], { timeoutMs: 15000 });
  cachedGitRoot = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : '';
  return cachedGitRoot || null;
}

/** 读取当前 git 状态：分支、是否有未提交改动、本地是否有远端引用 */
async function readGitState() {
  const root = await detectGitRoot();
  if (!root) return { isGit: false };

  const [branchR, statusR, remoteR] = await Promise.all([
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 15000 }),
    run('git', ['status', '--porcelain'], { timeoutMs: 15000 }),
    run('git', ['remote'], { timeoutMs: 15000 }),
  ]);

  const branch = branchR.code === 0 ? branchR.stdout.trim() : '';
  const dirty = statusR.code === 0 ? statusR.stdout.trim().length > 0 : false;
  const remotes = remoteR.code === 0 ? remoteR.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  return { isGit: true, root, branch, dirty, remotes, hasOrigin: remotes.includes('origin') };
}

/**
 * 查询远端最新版本。只读，不修改任何文件。
 * 返回 { ok, current, latest, hasUpdate, error?, source? }
 */
async function checkRemoteVersion() {
  const current = config.VERSION;
  const git = await readGitState();

  let latest = '';
  let source = 'package.json@' + BRANCH;
  try {
    const u = new URL(VERSION_URL);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    latest = await new Promise((resolve, reject) => {
      const req = mod.request(u, {
        method: 'GET',
        timeout: 12000,
        headers: { 'User-Agent': 'codebuddy-proxy', 'Cache-Control': 'no-cache' },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(String(JSON.parse(text).version || '')); }
          catch { reject(new Error('远端 package.json 解析失败')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('请求 GitHub 超时')));
      req.on('error', reject);
      req.end();
    });
  } catch (e) {
    return { ok: false, current, latest: '', hasUpdate: false, error: e.message, git: { ...git, root: undefined } };
  }

  const cmp = compareVersion(latest, current);
  return {
    ok: true,
    current,
    latest,
    hasUpdate: cmp === 1,
    upToDate: cmp === 0,
    // 本地比远端还新（例如刚提交未推送）
    ahead: cmp === -1,
    source,
    git: { isGit: git.isGit, branch: git.branch, dirty: git.dirty, hasOrigin: git.hasOrigin },
  };
}

/**
 * 执行更新：git pull → 必要时 npm install → npm run build。
 * 返回分步结果，任一步失败即中止后续步骤。
 */
async function applyUpdate() {
  const steps = [];
  const push = (name, ok, detail) => {
    steps.push({ name, ok, detail: String(detail || '').slice(0, 4000) });
    return ok;
  };

  const git = await readGitState();
  if (!git.isGit) {
    push('检查 git 仓库', false, '当前目录不是 git 仓库，无法自动更新。请手动下载最新代码后运行 npm install && npm run build。');
    return { ok: false, steps };
  }
  if (!git.hasOrigin) {
    push('检查 git 远端', false, '未配置 origin 远端，无法自动更新。');
    return { ok: false, steps };
  }
  if (git.dirty) {
    push('检查工作区', false, '工作区有未提交的本地改动，为避免覆盖你的修改已中止。请先提交或 git stash 后再试。');
    return { ok: false, steps };
  }
  push('检查工作区', true, `分支 ${git.branch}，工作区干净`);

  // 记录更新前的 package.json 内容，用于判断依赖是否变化
  const fs = require('fs');
  const pkgPath = path.join(ROOT, 'package.json');
  let pkgBefore = '';
  try { pkgBefore = fs.readFileSync(pkgPath, 'utf8'); } catch { /* ignore */ }

  const pull = await run('git', ['pull', '--ff-only', 'origin', git.branch || BRANCH], { timeoutMs: GIT_TIMEOUT_MS });
  const pullOut = (pull.stdout + pull.stderr).trim();
  if (pull.code !== 0) {
    push('git pull', false, pull.timedOut ? 'git pull 超时' : (pullOut || pull.error || 'git pull 失败'));
    return { ok: false, steps };
  }
  push('git pull', true, pullOut || '已是最新');

  let pkgAfter = '';
  try { pkgAfter = fs.readFileSync(pkgPath, 'utf8'); } catch { /* ignore */ }
  const depsChanged = pkgBefore !== pkgAfter;

  if (depsChanged) {
    const inst = await run(npmCmd(), ['install', '--no-audit', '--no-fund'], { timeoutMs: NPM_TIMEOUT_MS });
    const instOut = (inst.stdout + inst.stderr).trim();
    if (inst.code !== 0) {
      push('npm install', false, inst.timedOut ? 'npm install 超时' : (instOut || inst.error || 'npm install 失败'));
      return { ok: false, steps };
    }
    push('npm install', true, instOut.split('\n').slice(-6).join('\n') || '依赖已安装');
  } else {
    push('npm install', true, 'package.json 未变化，跳过');
  }

  const build = await run(npmCmd(), ['run', 'build'], { timeoutMs: NPM_TIMEOUT_MS });
  const buildOut = (build.stdout + build.stderr).trim();
  if (build.code !== 0) {
    push('npm run build', false, build.timedOut ? '构建超时' : (buildOut || build.error || '构建失败'));
    return { ok: false, steps };
  }
  push('npm run build', true, buildOut.split('\n').slice(-6).join('\n') || '构建完成');

  // 读取更新后的版本号（package.json 已在磁盘上变化，但 config.VERSION 是启动时读的）
  let newVersion = '';
  try { newVersion = String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || ''); } catch { /* ignore */ }

  logger.log('info', 'system', `自更新完成：代码已拉取并构建${newVersion ? ` (v${newVersion})` : ''}，需重启服务生效`);
  return {
    ok: true,
    steps,
    // 强调：core/ 已更新但进程内仍是旧代码，必须重启
    restartRequired: true,
    runningVersion: config.VERSION,
    newVersion,
  };
}

module.exports = {
  checkRemoteVersion,
  applyUpdate,
  compareVersion,
  parseVersion,
  readGitState,
  VERSION_URL,
};
