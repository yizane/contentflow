# ContentFlow Viewer

ContentFlow 的本地调试监控台。**自包含的 Node 区域,由 Claude 维护**;整个项目以 `workflow_py/`(Python workflow)为主,Viewer 只是旁挂的观察/操作面板。

## 定位

- **只读 MySQL 为主**:文章、选题、运行历史、评分、事实核查、审计事件全部从库里读。
- **受控写入仅三类**:人工终审标记(review)、配置文档保存(app_configs)、关键词/来源开关。
- **触发 workflow 不实现 workflow**:跑每日流水线/单步重跑/选题压测时,spawn `uv run contentflow ...`(cwd=`../workflow_py`),自己不含任何生产逻辑。
- 不暴露 `.env`/密码/RDS 地址;默认不返回完整 prompt/raw_response(仅摘要)。

## 启动

```bash
cd webpage
npm install        # 仅首次;依赖只有 dotenv + mysql2
npm start          # http://127.0.0.1:5177
PORT=5178 npm start
```

环境变量复用仓库根 `.env`(MySQL 连接,与 workflow_py 共用一套),`server.js` 按文件位置定位,不依赖启动 cwd。

## 目录

```text
webpage/
├── server.js          # HTTP 服务:只读 API + 受控运行/终审操作 + 静态托管
├── package.json       # Viewer 自己的 Node 依赖(根目录无 package.json)
├── lib/
│   ├── mysql_lib.js           # MySQL 连接层(唯一数据源,不 fallback)
│   ├── ui_api_lib.js          # 监控台聚合查询层(bootstrap/day/sources/model-runs 等)
│   ├── run_control_lib.js     # daily run 状态读取与 start/retry/rebuild 决策
│   ├── taxonomy_lib.js        # 读根 config/content_taxonomy.yaml(共享契约)
│   ├── trace_lib.js           # 审计写入(终审标记等受控操作)
│   ├── logger_lib.js          # 写根 logs/viewer-*.log
│   └── workflow_runtime_lib.js
├── public/            # 前端静态资源(React UMD + Babel standalone,无构建步骤)
│   ├── index.html
│   ├── app.jsx / dashboard.jsx / console.jsx / ...
│   └── styles.css
└── docs/
    ├── 01_product_logic.md    # 业务逻辑/工作流/数据结构(UI 设计交接)
    └── 02_ui_prd.md           # 监控台 UI PRD
```

## 与 workflow 的边界

只有三个交汇点,**不读取 workflow 任何代码文件**:

1. **MySQL 数据契约**(形状改动需 workflow 侧在交付说明标注,见根 `AGENTS.md`「与 Viewer 的契约」):
   - 表:`articles`、`topic_candidates`、`engine_runs`、`workflow_steps`、`workflow_events`、`model_runs`、`fact_checks`、`publish_packages`、`topic_audition_*`、`content_classifications`、`run_actions`、`app_configs` 等
   - `workflow_steps.step_key` 集合(下划线命名)
   - `engine_reports.report_json` 的 `qualityOverview` / `portfolioHealth` / `sourceObservationCoverage` / `sourceLanes`
   - `engine_runs.summary_json` 的 `targetReady` / `readyCount` / `qualityFailedCount` 等
2. **Python CLI**:`uv run contentflow engine daily|sources collect|jobs run|...`(单步白名单见 `server.js` 的 `STEP_CMDS`,绝不透传任意命令)
3. **共享文件**:根 `.env`(连接)、根 `config/content_taxonomy.yaml`(只读)、根 `logs/`(viewer 日志写入)

## 开发注意(踩过的坑)

- **时区**:DB DATETIME 是本地时间,JS `toISOString()` 是 UTC;SQL 比较「今天/某时刻」必须用本地分量拼串(见 `server.js` 的 `toLocalDt`、`run_control_lib.getDailyKey`),不能 `slice(0,10)`。
- **过程日志在 MySQL**:Python workflow 不写 logs/ 文件,步骤抽屉的实时进度从 `workflow_events` 查(`processEventsSince`),CLI stdout 只在结束时有一次 JSON。
- **静态资源不缓存**:html/js/jsx 返回 `no-cache`,改前端刷新即生效;静态根是 `public/`,服务端代码(`server.js`/`lib/`)不会被托管。
- **语法检查**:`npm run check`。

## 验证习惯

数据/接口改动用 SQL + curl 验证(`/api/health`、`/api/ui/bootstrap`),UI 改动才开浏览器。
