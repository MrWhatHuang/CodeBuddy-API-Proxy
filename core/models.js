'use strict';

/**
 * 模型目录与 /v1/models 响应。
 *
 * 内置目录（MODEL_CATALOG）逆向自腾讯云 CodeBuddy 插件
 * tencent-cloud.coding-copilot 的 product.json / product.external.json，
 * 并补充 webview 静态数组中腾讯 token 套餐（tencent-token-plan / -pro / -lite /
 * -hy、tencent-coding、glm-coding、kimi-cn、minimax-cn、deepseek）下的国内模型。
 * 字段映射：supportsToolCall -> tools, supportsImages -> vision,
 *           maxInputTokens / maxOutputTokens 原样保留, supportsReasoning -> reasoning。
 *
 * 仅保留国内（region: 'cn'）模型，国际模型（Claude/GPT/Gemini/kimi-intl/minimax-intl 等）
 * 已按需移除。
 *
 * 用户可在管理页新增的自定义模型存储于 SQLite（见 store.js），
 * 通过 allModels() 与内置目录合并后对外暴露。
 */

/** 内置默认模型目录（逆向自插件，仅国内模型） */
const MODEL_CATALOG = [
  // —— 默认 / 腾讯 coding ——
  { id: 'default', name: 'Default（自动）', maxInputTokens: 168000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: false, region: 'cn', isDefault: true },
  { id: 'tc-code-latest', name: 'Auto（腾讯 coding）', maxInputTokens: 168000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'hunyuan-2.0-instruct', name: 'Tencent HY 2.0 Instruct', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  { id: 'hunyuan-2.0-thinking', name: 'Tencent HY 2.0 Think', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'hunyuan-t1', name: 'Hunyuan-T1', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'hunyuan-turbos', name: 'Hunyuan-TurboS', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  // —— GLM ——
  { id: 'glm-5', name: 'GLM-5', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1000000, maxOutputTokens: 131072, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-4.7', name: 'GLM-4.7', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  { id: 'glm-4.6v', name: 'GLM-4.6V', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: true, region: 'cn' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', maxInputTokens: 200000, maxOutputTokens: 64000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  // —— Kimi ——
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: true, reasoning: true, region: 'cn' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: true, reasoning: true, region: 'cn' },
  { id: 'kimi-k2-0905-preview', name: 'Kimi-K2-0905-Preview', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  { id: 'kimi-k2-turbo-preview', name: 'Kimi-K2-Turbo-Preview', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  { id: 'kimi-k2-instruct-taiji', name: 'Kimi-K2', maxInputTokens: 31000, maxOutputTokens: 8192, tools: true, vision: false, region: 'cn' },
  // —— MiniMax ——
  { id: 'minimax-m2.5', name: 'MiniMax-M2.5', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'minimax-m3', name: 'MiniMax-M3', maxInputTokens: 1000000, maxOutputTokens: 524288, tools: true, vision: true, reasoning: true, region: 'cn' },
  { id: 'minimax-m2.5-highspeed', name: 'MiniMax-M2.5-Highspeed', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  { id: 'minimax-m2.1', name: 'MiniMax-M2.1', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  { id: 'minimax-m2.1-highspeed', name: 'MiniMax-M2.1-Highspeed', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  { id: 'minimax-m2', name: 'MiniMax-M2', maxInputTokens: 0, maxOutputTokens: 0, tools: true, vision: false, region: 'cn' },
  // —— DeepSeek ——
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'deepseek-v4-flash-202605', name: 'DeepSeek-V4-Flash 原厂直供', maxInputTokens: 1000000, maxOutputTokens: 384000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'deepseek-v4-pro-202606', name: 'DeepSeek-V4-Pro 原厂直供', maxInputTokens: 1000000, maxOutputTokens: 384000, tools: true, vision: false, reasoning: true, region: 'cn' },
  // —— 混元 / 补全类 ——
  { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'hy3-preview', name: 'Hy3 preview', maxInputTokens: 192000, maxOutputTokens: 64000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'hunyuan-turbos-vision', name: 'Hunyuan Turbo Vision', maxInputTokens: 16000, maxOutputTokens: 16000, tools: true, vision: true, region: 'cn' },
  { id: 'hunyuan-t1-vision', name: 'Hunyuan T1 Vision', maxInputTokens: 16000, maxOutputTokens: 24000, tools: true, vision: true, region: 'cn' },
  { id: 'hunyuan-3b', name: 'Hunyuan-3B', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
  { id: 'hunyuan-7b-dense', name: 'Hunyuan-7B', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
  // —— 其它补全 / 通用 ——
  { id: 'chat-1.0', name: 'Chat-1.0', maxInputTokens: 0, maxOutputTokens: 32000, tools: true, vision: false, region: 'cn' },
  { id: 'enhance-1.0', name: 'Enhance-1.0', maxInputTokens: 0, maxOutputTokens: 32000, tools: true, vision: false, region: 'cn' },
  { id: 'auto-chat', name: 'Auto Chat', maxInputTokens: 32000, maxOutputTokens: 8192, tools: true, vision: false, region: 'cn' },
  { id: 'completion-gf', name: 'Completion-GF', maxInputTokens: 200000, maxOutputTokens: 8192, tools: true, vision: false, region: 'cn' },
  { id: 'completion-1.0', name: 'Completion-1.0', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
  { id: 'completion-1.2', name: 'Completion-1.2', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
  { id: 'nes-1.0', name: 'NES-1.0', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
  { id: 'nes-1.1', name: 'NES-1.1', maxInputTokens: 0, maxOutputTokens: 8192, tools: false, vision: false, region: 'cn' },
  { id: 'nes-1.2', name: 'NES-1.2', maxInputTokens: 0, maxOutputTokens: 32000, tools: true, vision: true, region: 'cn' },
  { id: 'nes-v1-14b', name: 'NES-V1-14B', maxInputTokens: 0, maxOutputTokens: 8192, tools: false, vision: false, region: 'cn' },
  { id: 'codewise-navi-v1-2-taco', name: 'Codewise-Navi-V1-2-Taco', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
];

/**
 * 把内置目录与数据库中的自定义模型合并（自定义模型覆盖同 id 内置项）。
 * hiddenIds：被隐藏的模型 id 集合（含内置与自定义）。被隐藏的模型标记 hidden:true，
 * 并按稳定顺序排到列表末尾（其余模型保持原顺序）。
 *
 * /api/* 管理接口返回全部（含 hidden 标记）；/v1/models 与 /models 通过
 * modelsResponse() 过滤掉 hidden 项后再对外返回。
 */
function allModels(customModels, hiddenIds) {
  const custom = customModels || [];
  const hidden = new Set(Array.isArray(hiddenIds) ? hiddenIds : []);
  const byId = new Map();
  for (const m of MODEL_CATALOG) byId.set(m.id, { ...m, builtin: true });
  for (const m of custom) byId.set(m.id, { ...m, builtin: false });
  const list = Array.from(byId.values()).map((m) => ({
    ...m,
    hidden: hidden.has(m.id),
  }));
  // 稳定排序：仅把 hidden 项移到末尾，不改变其它项的原始相对顺序
  const visible = list.filter((m) => !m.hidden);
  const hiddenList = list.filter((m) => m.hidden);
  return visible.concat(hiddenList);
}

function modelsResponse(customModels, hiddenIds) {
  const now = Math.floor(Date.now() / 1000);
  const data = allModels(customModels, hiddenIds)
    .filter((m) => !m.hidden)
    .map((m) => ({
      id: m.id, object: 'model', created: now, owned_by: 'codebuddy',
      name: m.name, is_default: !!m.isDefault,
    }));
  return { object: 'list', data };
}

module.exports = { MODEL_CATALOG, allModels, modelsResponse };
