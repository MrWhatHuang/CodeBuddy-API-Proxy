'use strict';

/**
 * 模型目录与 /v1/models 响应。
 *
 * 内置目录（MODEL_CATALOG）逆向自腾讯云 CodeBuddy 插件
 * tencent-cloud.coding-copilot 的 product.json / product.external.json，
 * 并补充 webview 静态数组中腾讯 token 套餐下的 deepseek 模型。
 * 字段映射：supportsToolCall -> tools, supportsImages -> vision,
 *           maxInputTokens / maxOutputTokens 原样保留, supportsReasoning -> reasoning。
 *
 * 用户可在管理页新增的自定义模型存储于 SQLite（见 store.js），
 * 通过 allModels() 与内置目录合并后对外暴露。
 */

/** 内置默认模型目录（逆向自插件，含 deepseek-v4-pro 等） */
const MODEL_CATALOG = [
  { id: 'default', name: 'Default（自动）', maxInputTokens: 168000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: false, region: 'cn', isDefault: true },
  // —— 国内 / 腾讯系 ——
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'deepseek-v4-flash-202605', name: 'DeepSeek-V4-Flash 原厂直供', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'deepseek-v4-pro-202606', name: 'DeepSeek-V4-Pro 原厂直供', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', maxInputTokens: 200000, maxOutputTokens: 64000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'kimi-k2-instruct-taiji', name: 'Kimi-K2', maxInputTokens: 31000, maxOutputTokens: 8192, tools: true, vision: false, region: 'cn' },
  { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'hunyuan-turbos-vision', name: 'Hunyuan Turbo Vision', maxInputTokens: 16000, maxOutputTokens: 16000, tools: true, vision: true, region: 'cn' },
  { id: 'hunyuan-t1-vision', name: 'Hunyuan T1 Vision', maxInputTokens: 16000, maxOutputTokens: 24000, tools: true, vision: true, region: 'cn' },
  { id: 'hunyuan-3b', name: 'Hunyuan-3B', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
  { id: 'hunyuan-7b-dense', name: 'Hunyuan-7B', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'cn' },
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
  { id: 'gemini-2.5-flash', name: 'Gemini-2.5-Flash', maxInputTokens: 1000000, maxOutputTokens: 16384, tools: true, vision: true, region: 'cn' },
  { id: 'gemini-2.5-pro', name: 'Gemini-2.5-Pro', maxInputTokens: 1000000, maxOutputTokens: 16384, tools: true, vision: true, region: 'cn' },
  // —— 国际版 ——
  { id: 'claude-3.7', name: 'Claude-3.7-Sonnet', maxInputTokens: 200000, maxOutputTokens: 8192, tools: true, vision: true, region: 'intl' },
  { id: 'claude-4.0', name: 'Claude-4.0-Sonnet', maxInputTokens: 200000, maxOutputTokens: 24000, tools: true, vision: true, region: 'intl', isDefault: true },
  { id: 'default-1.1', name: 'Claude-3.7-Sonnet', maxInputTokens: 200000, maxOutputTokens: 8192, tools: true, vision: true, region: 'intl' },
  { id: 'default-1.2', name: 'Claude-4.0-Sonnet', maxInputTokens: 200000, maxOutputTokens: 24000, tools: true, vision: true, region: 'intl' },
  { id: 'gpt-5', name: 'GPT-5', maxInputTokens: 272000, maxOutputTokens: 128000, tools: true, vision: true, region: 'intl' },
  { id: 'gpt-5-mini', name: 'GPT-5-Mini', maxInputTokens: 272000, maxOutputTokens: 128000, tools: true, vision: true, region: 'intl' },
  { id: 'gpt-5-nano', name: 'GPT-5-Nano', maxInputTokens: 272000, maxOutputTokens: 128000, tools: true, vision: true, region: 'intl' },
  { id: 'o4-mini', name: 'GPT-4o-mini', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, region: 'intl' },
  { id: 'codewise-7b-021', name: 'Codewise-7B-021', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'intl' },
  { id: 'codewise-completions', name: 'Codewise-Completions', maxInputTokens: 0, maxOutputTokens: 256, tools: false, vision: false, region: 'intl' },
];

/** 把内置目录与数据库中的自定义模型合并（自定义模型覆盖同 id 内置项） */
function allModels(customModels) {
  const custom = customModels || [];
  const byId = new Map();
  for (const m of MODEL_CATALOG) byId.set(m.id, { ...m, builtin: true });
  for (const m of custom) byId.set(m.id, { ...m, builtin: false });
  return Array.from(byId.values());
}

function modelsResponse(customModels) {
  const now = Math.floor(Date.now() / 1000);
  const data = allModels(customModels).map((m) => ({
    id: m.id, object: 'model', created: now, owned_by: 'codebuddy',
    name: m.name, is_default: !!m.isDefault,
  }));
  return { object: 'list', data };
}

module.exports = { MODEL_CATALOG, allModels, modelsResponse };
