# 18 — 可观测性 Review（基于 2026-06-08 daily run）

> 作者：Claude（Viewer 维护方）。本文是一次跑通真实 daily run 后对**运行时日志 + 输入/输出可追溯性**的评估。
> 2026-06-08 Codex 已处理 workflow 侧问题；本文保留问题背景，并以当前状态为准。

> **✅ 2026-06-08 已由 Codex 修复并验证**（66 pytest 全过 + CLI dry-run + 历史 JSON 残留扫描）：
> - P0 生成 model_run 回填 → 两条 article_generation 均挂上 article_id+version_id；文章详情现可见 `article_generation, fact_check`（之前只有 fact_check）。
> - run 孤儿态 → `run_batch` 拆 `_run_batch_impl` + 异常 finalize，新 run 正常落 `failed`/`finished_at`。
> - 长步骤心跳 → openclaw provider 每 30s 发 `openclaw_call_progress`，本次 run 22 条。
> - run-id 时区 → `make_run_id`/`daily_key` 统一用 `BUSINESS_TZ`(Asia/Shanghai)，run-id 现为 `20260608`，与 Viewer 本地 daily_key 对齐。
> - `db list` 序列化 → `print_json` 加 `json_default` 统一转 datetime，命令恢复可用。
>
> **仍开着**：多轮 step 折叠的 Viewer 展开（workflow 已在 summary 落 `round` 字段，Viewer 侧待展开）。
> **2026-06-08 Codex 追加修复**：配额循环在 `articles_factcheck` 后发现 `needs_fact_sources` 会先跑 `sources_fix`；`archive_run_data` 与 retry/force supersede 会补 `finished_at`；`topics_select.output_summary_json` 统一为 `writingTaskCount`，历史 `jobCount/jobsCount` 由 migration 014 清理。
>
> **Viewer 侧（Claude）**：
> - ✅ 已同步业务语义重命名（2026-06-08）：`STEP_KEY_MAP` 改用 `topics_select`/`articles_generate`/`articles_factcheck`（删除旧通用节点，不兼容历史 run）；`server.js` 单步白名单 CLI 改 `topics select`/`articles generate`/`articles factcheck`；`stepSummary` 的 tasks 分支读 `writingTaskCount`、factcheck 分支读 `succeeded`（原查 checked/completed 对不上）。Workflow 表名已改为 `article_writing_tasks`，summary 字段为 `attemptedWritingTasks`。
> - ✅ 已修：DATETIME 列存 UTC 但显示慢 8 小时 → `webpage/lib/mysql_lib.js` 加 `timezone:'Z'`（mysql2 按 UTC 解析），`server.js` 的 `dt()` 统一输出 UTC ISO，前端本地 getter 显示成 Asia/Shanghai。已验证 engine-runs/articles 时间正确（09:xx 而非 01:xx）。
> - ⬜ 待办：按本地日过滤 UTC 列的边界偏移——`ui_api_lib.js` 多处 `WHERE created_at >= '${dailyKey} 00:00:00'` 与 `DATE(created_at)` 分组直接拿本地日比 UTC 列，凌晨 0–8 点的数据可能被归错日/漏算。需把本地日边界换算成 UTC 区间（如 `new Date(`${day}T00:00:00+08:00`).toISOString()`）。比"显示"更深、每个按日视图要单独验证，单独一轮处理；与 workflow 的 daily_key=本地 语义已对齐，方向明确。

## 一、这次 run 的事实

- run：`engine_20260607_224526_f79b`，daily_key=`2026-06-08`，target-ready 5
- 配额循环跑了 3 轮：`topics_select×3`、`articles_generate×3`、`articles_factcheck×2`
- 产出：`article_validated×1` + `needs_fact_sources×2`（质量分 91，但缺事实来源）
- model_runs：topic_generation 1、article_generation 2、fact_check 2，**prompt/response 全文都已入库**（44k/14k 字级别）
- 事件：每步都有 `step_started`/`step_completed`，每次 AI 调用都有 `openclaw_call_started`/`completed`

整体观测底座是好的：步骤有起止、AI 调用有起止、prompt 与 raw_response 全量留存。问题集中在**链路串联**和**长步骤的过程可见性**。

> 效果评估补充：跑到第 4 轮时 3 篇文章质量分都到 91，但全部停在 `needs_fact_sources`，`ready_for_review` 仍是 0。已修：配额循环现在会在 `articles_factcheck` 后检测当前 run 的 `needs_fact_sources`，先执行 `sources_fix` 补证据、修订并复核，再决定是否继续生成新篇。

## 二、当前状态

### 已修 — 生成链路追溯
`domains/production/article_generation.py: generate_article_from_writing_task()` 已在插入 article/version 后回填胜出 `model_runs.article_id/article_version_id`。文章详情可以追溯到「生成 prompt → 生成 response → 事实核查 → 评分」。

### 已修 — 长 AI 步骤心跳
OpenClaw provider 已在长调用期间定期写 `openclaw_call_progress`，避免 `topics_generate`、`articles_generate`、`articles_factcheck` 运行 1–3 分钟时界面没有事件。

### P1 — 配额循环的多轮被 Viewer 折叠，看不到「补位」过程
[Viewer + 契约] 一个 run 内 `topics_select/articles_generate/articles_factcheck` 各出现多次（本次 3 轮），但 `ui_api_lib.realSteps()` 按 `step_key` 建 `byKey` 映射，**后一轮覆盖前一轮**，7 步流水线视图只显示最后一次。用户无法在运行历史里看到「为凑够 5 篇试了 3 轮、哪轮失败、哪轮补上」。

当前方案：workflow 在 `output_summary_json.round` 标出轮次；Viewer 后续把重复 step_key 聚合成「N 轮」并展开每轮结果。

### 已修 — output_summary 结构化
`topics_select.output_summary_json` 已统一为结构化字段，写作任务计数读 `writingTaskCount`。历史 `jobCount/jobsCount` 已由 migration 014 清理。

### 已修 — 连接中断会把 run 留成孤儿态「running」（本次真实发生）
本次 daily run 进程退出码 0，但引擎最后一步抛 `(2013, 'Lost connection to MySQL server during query')`，结果：`engine_runs.summary_json` 没写成、`finished_at` 为空、status 永远停在 `running`。后果——Viewer Run Control 的 `canStartDaily` 看到「今天有 active run」会**挡住新的 start**，运行历史里这条 run 永远显示进行中。

> 起因更正：当时 RDS 真实抖动了几分钟（Python `db ping` 和 Node Viewer 同时连不上，随后一起恢复），**不是 `max_allowed_packet`**。`model_runs.raw_response` 已截到 4MB，本次最大也才几万字，没撞包大小。所以重点是「中途断连不要孤儿化 run」，不是改包参数。

当前处理：`run_batch` 异常会尽量把当前 run 落为 `failed` 并写 `finished_at`；rebuild/retry/force 归档也会补 `finished_at`，避免 active running 孤儿挡住新 run。

- [Viewer 可选] Run Control 对「`running` 且 `started_at` 超过 N 小时」的 run 视为 stale，提示可 rebuild，作为兜底——即便 workflow 没落终态，也不会被孤儿 run 永久挡住。

### 已修 — 补位循环空转
事实核查后如果当前 run 有 `needs_fact_sources`，daily 补位循环会先执行 `sources_fix` 补证据、修订并复核，再决定是否继续生成新文章。

## 三、顺手发现的 bug（workflow，与本次主题相关）

1. **`contentflow db list` datetime 序列化**：已修，CLI JSON 输出会统一序列化 datetime。
2. **run-id 与 daily_key 时区**：已定契约，`daily_key` 使用 Asia/Shanghai 本地业务日；MySQL `DATETIME` 按 UTC 存储，Viewer 按本地日过滤时需换算 UTC 区间。

## 四、结论

- **「每步有运行时 log」基本达标**：步骤级、AI 调用级起止事件齐全，prompt/response 全量留存。
- **「追溯到输入与输出」已补齐**：从文章可直达「生成 prompt → 生成 response → 事实核查 → 评分」完整链路。
- **过程可见性已补齐 workflow 侧事件**：长 AI 调用会写心跳事件，运行中界面不再只等头尾事件。
- Viewer 侧剩余工作是多轮 step 展开，以及按本地日过滤 UTC 时间列。
