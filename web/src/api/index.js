import { createAlova } from 'alova';
import adapterFetch from 'alova/fetch';
import vueHook from 'alova/vue';

/**
 * 统一请求实例。生产环境由 server.js 同源服务，开发环境经 vite proxy 转发。
 */
export const alova = createAlova({
  statesHook: vueHook,
  requestAdapter: adapterFetch(),
  timeout: 20000,
  cacheFor: { GET: 0 },
  responded: async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = body?.error?.message || body?.error || `HTTP ${response.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return body;
  },
});

function withQuery(path, params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export const api = {
  status: () => alova.Get('/api/status'),
  config: () => alova.Get('/api/config'),
  saveConfig: (patch) => alova.Put('/api/config', patch),
  logs: (params = {}) => alova.Get(withQuery('/api/logs', params)),
  clearLogs: () => alova.Delete('/api/logs'),
  stats: () => alova.Get('/api/stats'),
  importVscode: () => alova.Get('/api/import-vscode'),
  logout: () => alova.Post('/api/logout'),
  loginState: () => alova.Get('/login/state'),
  loginStatus: (state) => alova.Get(`/login/status?state=${encodeURIComponent(state)}`),
  listAccounts: () => alova.Get('/api/accounts'),
  accountLogin: (name) => alova.Post('/api/accounts/login', { name }),
  importAccount: (payload) => alova.Post('/api/accounts/import', payload),
  accountLoginStatus: (state) => alova.Get(`/api/accounts/login/status?state=${encodeURIComponent(state)}`),
  renameAccount: (id, name) => alova.Put(`/api/accounts/${encodeURIComponent(id)}`, { name }),
  deleteAccount: (id) => alova.Delete(`/api/accounts/${encodeURIComponent(id)}`),
  getPool: () => alova.Get('/api/pool'),
  setPool: (patch) => alova.Put('/api/pool', patch),
  listModels: () => alova.Get('/api/models'),
  addModel: (model) => alova.Post('/api/models', model),
  deleteModel: (id) => alova.Delete(`/api/models/${encodeURIComponent(id)}`),
  listKeys: () => alova.Get('/api/keys'),
  addKey: (payload) => alova.Post('/api/keys', payload),
  regenerateKey: (id) => alova.Post(`/api/keys/regenerate/${encodeURIComponent(id)}`),
  deleteKey: (id) => alova.Delete(`/api/keys/${encodeURIComponent(id)}`),
  usage: (params = {}) => alova.Get(withQuery('/api/usage', params)),
  usageStats: (params = {}) => alova.Get(withQuery('/api/usage/stats', params)),
};