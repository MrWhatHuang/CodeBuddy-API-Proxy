'use strict';

/** 模型目录与 /v1/models 响应 */

const MODEL_CATALOG = [
  { id: 'default', name: 'Default（自动）', maxInputTokens: 168000, maxOutputTokens: 32000, tools: true, vision: false, isDefault: true, region: 'cn' },
  { id: 'default-1.1', name: 'Claude 3.7 Sonnet', maxInputTokens: 200000, maxOutputTokens: 8192, tools: true, vision: true, region: 'cn' },
  { id: 'default-1.2', name: 'Claude 4.0 Sonnet', maxInputTokens: 200000, maxOutputTokens: 24000, tools: true, vision: true, region: 'cn' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: false, region: 'cn' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', maxInputTokens: 200000, maxOutputTokens: 64000, tools: true, vision: false, region: 'cn' },
  { id: 'kimi-k2-instruct-taiji', name: 'Kimi K2', maxInputTokens: 31000, maxOutputTokens: 8192, tools: true, vision: false, region: 'cn' },
  { id: 'hunyuan-turbos-vision', name: 'Hunyuan Turbo Vision', maxInputTokens: 16000, maxOutputTokens: 16000, tools: true, vision: true, region: 'cn' },
  { id: 'hunyuan-t1-vision', name: 'Hunyuan T1 Vision', maxInputTokens: 16000, maxOutputTokens: 24000, tools: true, vision: true, region: 'cn' },
  { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, tools: true, vision: false, region: 'cn' },
  // 国际版
  { id: 'claude-3.7', name: 'Claude 3.7', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, region: 'intl' },
  { id: 'claude-4.0', name: 'Claude 4.0', maxInputTokens: 200000, maxOutputTokens: 64000, tools: true, vision: true, region: 'intl' },
  { id: 'gpt-5', name: 'GPT-5', maxInputTokens: 128000, maxOutputTokens: 32000, tools: true, vision: true, region: 'intl' },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', maxInputTokens: 128000, maxOutputTokens: 16000, tools: true, vision: true, region: 'intl' },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', maxInputTokens: 128000, maxOutputTokens: 8000, tools: true, vision: true, region: 'intl' },
  { id: 'o4-mini', name: 'o4-mini', maxInputTokens: 128000, maxOutputTokens: 32000, tools: true, vision: true, region: 'intl' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', maxInputTokens: 1000000, maxOutputTokens: 64000, tools: true, vision: true, region: 'intl' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', maxInputTokens: 1000000, maxOutputTokens: 64000, tools: true, vision: true, region: 'intl' },
  { id: 'auto-chat', name: 'Auto Chat', maxInputTokens: 168000, maxOutputTokens: 32000, tools: true, vision: true, region: 'intl' },
];

function modelsResponse() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: MODEL_CATALOG.map((m) => ({
      id: m.id, object: 'model', created: now, owned_by: 'codebuddy',
      name: m.name, is_default: !!m.isDefault,
    })),
  };
}

module.exports = { MODEL_CATALOG, modelsResponse };
