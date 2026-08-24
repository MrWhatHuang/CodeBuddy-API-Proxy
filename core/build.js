'use strict';

/**
 * 前端构建状态检测。
 *
 * 管理页需要先 `npm run build`（web/ → dist/）才能由服务端托管。
 * 用户拉取最新代码但没重新构建时，dist/ 仍存在但已过期 —— 本模块通过比较
 * web/ 源码与 dist/ 产物的最新 mtime 来判断“未构建 / 已过期 / 已是最新”。
 *
 * 结果通过短 TTL 缓存，避免每个请求都遍历目录。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');

const WEB_DIR = path.join(__dirname, '..', 'web');
// 参与源码新鲜度判断的文件；vite 会把它们打包进 dist/。
const WEB_ENTRY_FILES = ['index.html', 'vite.config.mjs'];

const CACHE_TTL_MS = 2000;

let cache = null;
let cacheAt = 0;

/** 递归求某个目录下所有文件的最新 mtime；目录不存在返回 null */
function newestMtime(dir) {
  let newest = 0;
  const walk = (cur) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      try {
        const st = fs.statSync(full);
        if (ent.isDirectory()) {
          walk(full);
        } else if (st.mtimeMs > newest) {
          newest = st.mtimeMs;
        }
      } catch { /* ignore unreadable */ }
    }
  };
  walk(dir);
  return newest || null;
}

/** 直接取单个文件的 mtime；不存在返回 null */
function fileMtime(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** 返回 { built, stale, needsBuild, webNewest, distNewest } */
function getBuildState() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  let webNewest = fileMtime(path.join(WEB_DIR, 'index.html'));
  for (const f of WEB_ENTRY_FILES) {
    const t = fileMtime(path.join(WEB_DIR, f));
    if (t != null && (webNewest == null || t > webNewest)) webNewest = t;
  }
  const srcNewest = newestMtime(path.join(WEB_DIR, 'src'));
  if (srcNewest != null && (webNewest == null || srcNewest > webNewest)) webNewest = srcNewest;
  const pubNewest = newestMtime(path.join(WEB_DIR, 'public'));
  if (pubNewest != null && (webNewest == null || pubNewest > webNewest)) webNewest = pubNewest;

  const distIndex = fileMtime(path.join(config.DIST_DIR, 'index.html'));
  const distNewest = newestMtime(config.DIST_DIR);

  const built = distIndex != null; // 有 index.html 才算构建过
  const stale = built && webNewest != null && distNewest != null && webNewest > distNewest;
  const needsBuild = !built || stale;

  cache = {
    built,
    stale,
    needsBuild,
    webNewest: webNewest != null ? Math.round(webNewest) : null,
    distNewest: distNewest != null ? Math.round(distNewest) : null,
  };
  cacheAt = now;
  return cache;
}

module.exports = { getBuildState };
