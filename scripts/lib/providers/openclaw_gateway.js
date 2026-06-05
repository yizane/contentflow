// providers/openclaw_gateway.js — OpenClaw Gateway 远程执行器【预留 · 协议待定，未实现】
// 规划：远程 OpenClaw 集群网关，支持会话路由与配额；接口契约确定后在此实现。
// 启用前置条件：models.yaml providers.openclaw_gateway: { enabled: true, base_url, api_key_env }

async function run({ providerCfg }) {
  return {
    ok: false,
    error: `openclaw_gateway 执行器为预留能力，尚未实现（协议待定）。配置位: base_url=${providerCfg.base_url || '(未配置)'}`,
    visibleText: null, raw: null, durationMs: 0,
  };
}

module.exports = { run };
