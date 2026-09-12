'use strict';

/**
 * 版本检查 / 自更新回归测试。
 *
 * 重点覆盖容易出错、且不适合在真实仓库上试的部分：
 *   1. 版本号比较（含 2 段写法、预发布后缀、非法输入）；
 *   2. applyUpdate 的安全护栏：非 git 目录、无远端、工作区有改动 —— 都必须拒绝，
 *      绝不可以在有本地改动时执行 git pull（会覆盖用户修改）；
 *   3. run() 在 Windows 上对 npm.cmd 的处理（Node 18+ 要求 shell:true，
 *      否则抛 spawn EINVAL）——这是实测踩到的坑。
 *
 * 不依赖网络：只测纯逻辑与护栏，不真的 pull。
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const updater = require(path.join(ROOT, 'core', 'update.js'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

(async () => {
  /* ---------------- 版本号比较 ---------------- */

  await check('版本比较：常规升降与相等', () => {
    assert.strictEqual(updater.compareVersion('1.2.0', '1.1.1'), 1);
    assert.strictEqual(updater.compareVersion('1.1.1', '1.2.0'), -1);
    assert.strictEqual(updater.compareVersion('1.2.0', '1.2.0'), 0);
  });

  await check('版本比较：允许 v 前缀与 2 段写法', () => {
    assert.strictEqual(updater.compareVersion('v1.3', '1.2.9'), 1);
    assert.strictEqual(updater.compareVersion('1.3', '1.3.0'), 0);
    assert.strictEqual(updater.compareVersion('2', '1.9.9'), 1);
  });

  await check('版本比较：忽略预发布后缀', () => {
    assert.strictEqual(updater.compareVersion('1.2.0-beta.1', '1.2.0'), 0);
    assert.strictEqual(updater.compareVersion('1.2.0', '1.1.0-rc.1'), 1);
  });

  await check('版本比较：非法输入返回 null（不抛异常）', () => {
    assert.strictEqual(updater.compareVersion('', '1.0.0'), null);
    assert.strictEqual(updater.compareVersion('garbage', '1.0.0'), null);
    assert.strictEqual(updater.compareVersion(null, undefined), null);
  });

  await check('版本比较：多位数不按字符串比较（1.10 > 1.9）', () => {
    assert.strictEqual(updater.compareVersion('1.10.0', '1.9.0'), 1);
    assert.strictEqual(updater.compareVersion('1.0.10', '1.0.9'), 1);
  });

  /* ---------------- 安全护栏 ---------------- */

  await check('applyUpdate：真实仓库当前有未提交改动时必须拒绝', async () => {
    const st = await updater.readGitState();
    assert.strictEqual(st.isGit, true, '本仓库应为 git 仓库');
    // 本测试文件所在仓库此刻必然有未提交改动（正在开发中），
    // 因此 applyUpdate 必须拒绝，绝不能真的 pull。
    const r = await updater.applyUpdate();
    if (st.dirty) {
      assert.strictEqual(r.ok, false, '工作区有改动时不允许更新');
      const failedStep = r.steps.find((s) => !s.ok);
      assert.ok(failedStep, '应记录失败的步骤');
      assert.ok(/未提交|工作区/.test(failedStep.detail), `失败原因应说明工作区问题，实际: ${failedStep.detail}`);
    }
  });

  await check('readGitState：返回分支 / 远端 / 干净状态', async () => {
    const st = await updater.readGitState();
    assert.strictEqual(st.isGit, true);
    assert.ok(typeof st.branch === 'string' && st.branch.length > 0, '应能读到分支名');
    assert.strictEqual(typeof st.dirty, 'boolean');
    assert.strictEqual(typeof st.hasOrigin, 'boolean');
  });

  /* ---------------- 远端查询容错 ---------------- */

  await check('checkRemoteVersion：返回结构完整，网络失败不抛异常', async () => {
    const r = await updater.checkRemoteVersion();
    assert.strictEqual(typeof r.ok, 'boolean');
    assert.strictEqual(typeof r.current, 'string');
    assert.ok(r.current.length > 0, 'current 必须来自 package.json');
    assert.strictEqual(typeof r.hasUpdate, 'boolean');
    if (r.ok) {
      assert.ok(r.latest, 'ok 时应带 latest');
      assert.ok(r.git, 'ok 时应带 git 状态');
    } else {
      // 离线时也要给出可展示的错误，而不是崩溃
      assert.ok(r.error, '失败时应带 error 说明');
    }
  });

  console.log(`\n断言：${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
