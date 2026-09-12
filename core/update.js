'use strict';

/**
 * 版本检查与自更新。
 *
 * - checkRemoteVersion()：从 GitHub 读取远端 package.json 的 version（只读，无副作用）
 * - applyUpdate()：git pull → pnpm install（仅依赖变化时）→ pnpm run build
 * - restartService()：类 Unix 上原地重启进程；Windows 上拒绝并让用户手动重启
 *
 * 安全约束：
 *   1. 所有外部命令都用 execFile + 参数数组，绝不拼 shell 字符串（避免命令注入）。
 *   2. 只在「干净的 git 工作区」上执行 pull：有未提交改动时直接拒绝，
 *      避免把用户本地修改冲掉（这是自更新最危险的一步）。
 *   3. 重启只支持 Linux/macOS：Windows 上子进程与父进程的端口/句柄继承关系容易
 *      产生孤儿进程与端口占用（EADDRINUSE），因此不自动重启，由用户手动重启。
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

/** 单条命令超时：git pull 与依赖安装可能较慢，给足时间 */
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

/**
 * 依赖安装命令。本仓库统一用 pnpm（唯一锁文件是 pnpm-lock.yaml）。
 * Windows 上可执行文件是 pnpm.cmd，直接 execFile('pnpm') 会 ENOENT
 * （run() 里也会对 .cmd 自动加 shell）。
 */
function pnpmCmd() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

/** pnpm 是否可用（未安装时回退到 npm，避免更新直接失败） */
async function detectPkgManager() {
  const r = await run(pnpmCmd(), ['--version'], { timeoutMs: 20000 });
  if (r.code === 0) return 'pnpm';
  return 'npm';
}

/** 按包管理器返回安装命令（含 Windows 后缀） */
function installCmdFor(pm) {
  if (pm === 'pnpm') return pnpmCmd();
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** 按包管理器返回安装参数：pnpm 用 --frozen-lockfile 保证锁文件一致 */
function installArgsFor(pm) {
  if (pm === 'pnpm') return ['install', '--frozen-lockfile'];
  return ['install', '--no-audit', '--no-fund'];
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
 * 执行更新：git pull → 必要时 pnpm install → pnpm run build。
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
    push('检查 git 仓库', false, '当前目录不是 git 仓库，无法自动更新。请手动下载最新代码后运行 pnpm install && pnpm run build。');
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

  // 优先 pnpm（本仓库的唯一锁文件是 pnpm-lock.yaml）；未安装时回退 npm
  const pm = await detectPkgManager();

  if (depsChanged) {
    const inst = await run(installCmdFor(pm), installArgsFor(pm), { timeoutMs: NPM_TIMEOUT_MS });
    const instOut = (inst.stdout + inst.stderr).trim();
    if (inst.code !== 0) {
      const label = `${pm} install`;
      push(label, false, inst.timedOut ? `${label} 超时` : (instOut || inst.error || `${label} 失败`));
      return { ok: false, steps };
    }
    push(`${pm} install`, true, instOut.split('\n').slice(-6).join('\n') || '依赖已安装');
  } else {
    push(`${pm} install`, true, 'package.json 未变化，跳过');
  }

  const build = await run(installCmdFor(pm), ['run', 'build'], { timeoutMs: NPM_TIMEOUT_MS });
  const buildOut = (build.stdout + build.stderr).trim();
  if (build.code !== 0) {
    push(`${pm} run build`, false, build.timedOut ? '构建超时' : (buildOut || build.error || '构建失败'));
    return { ok: false, steps };
  }
  push(`${pm} run build`, true, buildOut.split('\n').slice(-6).join('\n') || '构建完成');

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

/**
 * 是否被 systemd 托管。
 *
 * systemd 会为每个 unit 注入 INVOCATION_ID / JOURNAL_STREAM，这两个变量在普通
 * shell 里不存在，是最可靠的判据（比检查父进程 pid 更稳，也不依赖 cgroup 解析）。
 */
function isUnderSystemd() {
  return !!(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
}

/**
 * 是否支持自动重启。
 *
 * 仅 Linux / macOS，且**不能**在 systemd 之类的进程管理器下自动重启：
 * 我们的做法是 spawn 新进程再让主进程退出，而 systemd 看到主进程退出会按
 * Restart=always 再拉起一个，于是两个进程抢同一端口（EADDRINUSE）；
 * 且 spawn 出来的新进程脱离了 unit 的 cgroup，日志也不再进 journald。
 * 这种情况必须交给管理器自己重启（systemctl restart）。
 */
function supportsAutoRestart() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  if (isUnderSystemd()) return false;
  return true;
}

/** 提供给前端展示的「该如何重启」提示 */
function restartHint() {
  if (isUnderSystemd()) return { mode: 'systemd', command: 'sudo systemctl restart codebuddy-proxy' };
  if (process.platform === 'win32') return { mode: 'manual', command: 'npm start' };
  return { mode: 'auto', command: '' };
}

/**
 * 原地重启服务：spawn 一个新的 node 进程（继承原 argv/cwd/env），然后退出当前进程。
 *
 * 关键点：
 *   - 用 detached + stdio:'inherit' 让新进程脱离当前进程组并接管原终端输出，
 *     这样即使本进程随后退出，新进程也不会被一起带走。
 *   - 必须先把 HTTP server 关掉再退出，否则新进程会 EADDRINUSE（端口还没释放）。
 *   - 只在 Linux/macOS 上执行；Windows 直接返回 unsupported，由调用方提示用户手动重启。
 *
 * @param {object} opts
 * @param {import('http').Server} [opts.server] 需要优雅关闭的 HTTP server
 * @param {number} [opts.exitDelayMs] 关闭后延迟多久退出（给响应写回留时间）
 * @returns {Promise<{ok:boolean, supported:boolean, reason?:string}>}
 */
async function restartService({ server, exitDelayMs = 800 } = {}) {
  if (isUnderSystemd()) {
    return {
      ok: false,
      supported: false,
      reason: '服务由 systemd 托管，请执行 sudo systemctl restart codebuddy-proxy 重启',
    };
  }
  if (!supportsAutoRestart()) {
    return { ok: false, supported: false, reason: '当前系统不支持自动重启，请手动重启服务' };
  }

  // 1) 先停掉监听，释放端口，避免新进程 EADDRINUSE
  if (server && typeof server.close === 'function') {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        server.close(finish);
      } catch { finish(); }
      // 有 keep-alive 长连接时 close() 不会立刻回调，兜底 3s
      setTimeout(finish, 3000).unref?.();
    });
  }

  // 2) 拉起新进程：必须等到响应写回之后再退出，因此这里 spawn 后延迟退出
  const { spawn } = require('child_process');
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: 'inherit',
    });
    child.unref();
    logger.log('info', 'system', `已拉起新进程 (pid ${child.pid})，当前进程即将退出`);

    setTimeout(() => {
      // 正常退出：新进程已在监听同一端口
      process.exit(0);
    }, exitDelayMs).unref?.();

    return { ok: true, supported: true, pid: child.pid };
  } catch (e) {
    logger.log('error', 'system', `重启失败: ${e.message}`);
    return { ok: false, supported: true, reason: e.message };
  }
}

module.exports = {
  checkRemoteVersion,
  applyUpdate,
  restartService,
  supportsAutoRestart,
  isUnderSystemd,
  restartHint,
  compareVersion,
  parseVersion,
  readGitState,
  VERSION_URL,
};
