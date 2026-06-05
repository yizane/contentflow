# 06 — Operations（排查手册）

## 日常命令

```bash
npm run engine:daily          # 每日 1 篇
npm run fix:sources -- --limit 5
npm run engine:report
npm run viewer                # 本地只读 Trace Console（http://127.0.0.1:5177）
```

## 排查指南（数据都在 MySQL）

| 症状 | 查什么 |
|---|---|
| 采集失败 | `source_collection_logs WHERE status='failed'`（看 http_status / error_message；403=反爬，timeout=网络/代理）；Viewer → Sources tab 筛 failed |
| OpenClaw 失败 | `model_runs WHERE status='failed'`（error_message 含 `network connection error` = 代理/Provider 断；`无法解析 JSON` = 模型输出不合规，看 raw_response）；`workflow_events WHERE event_type='openclaw_call_failed'` |
| source fix 未通过 | `fact_checks` 最新一条的 must_fix_json；`source_resolutions WHERE resolved_status='needs_manual_review'`（这些需要人工资料，如 Seller Central 登录态内容、Flyfus 内部佐证） |
| needs_fact_sources 堆积 | `articles WHERE status='needs_fact_sources'` → 逐篇 `npm run fix:sources -- --article-id <id>`；连续 2 轮不收敛就看 mustFix 是否为人工项 |
| channel 缺失 | Viewer → Article Detail 渠道区；`npm run channels:generate -- --status ready_for_review --missing-only` |
| export package 不完整 | `publish_packages.metadata_json.channelStatus.missing`；`ready_for_publish_package=0` 的看 metadata 的 suggestedCommand |
| trace 写入失败 | engine run `summary_json.traceFailures` > 0；engine_report nextActions 会提示 |

## 已知环境问题

- 代理 Fake-IP（198.18.0.0/15）：OpenClaw web_fetch 需 `tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange=true`
- SearXNG JSON API 需在其 settings.yml 开启 `search.formats: [html, json]`
- 代理节点抖动会导致 `LLM request failed: network connection error` —— 换节点后重跑即可（trace 中有完整失败记录）

## Run Control 操作

```bash
npm run engine:daily                       # start（今天已有 active run 会被拒绝）
npm run engine:daily -- --mode retry       # 只在 failed/partial 时允许
npm run engine:daily -- --mode rebuild     # 归档旧数据后重跑（需确认场景）
npm run engine:daily -- --plan-only        # 只评估是否允许，不执行
```

排查：`run_actions` 表记录每次触发与拒绝原因；被拒绝时按 `availableActions` 提示选 retry/rebuild。**不要绕过控制直接反复跑 engine:batch --run-type daily。**
