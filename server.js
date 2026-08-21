#!/usr/bin/env node
/**
 * CodeBuddy API Proxy — 入口
 * ---------------------------
 * 把本地 VSCode 里腾讯云 CodeBuddy 插件的登录态/API 代理成一个 OpenAI 兼容接口。
 *
 * 逻辑已拆分到 core/ 目录，本文件只负责启动。详见 README.md。
 */

'use strict';

require('./core').start();
