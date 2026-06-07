# LangGraph Orchestration Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有 MySQL 状态、OpenClaw CLI、Viewer 契约和 npm scripts 的前提下，引入 LangGraph 作为主流程编排层，让流程结构更清楚、节点级调试更方便。

**Architecture:** MySQL 继续作为业务状态和审计事实来源；LangGraph 先作为可选 runner，复用现有 pipeline CLI/函数，不直接替换业务表和 provider。第一阶段新增 `engine:graph` 与现有 `engine:batch` 并行跑；验证一致后，再决定是否让 `engine:daily` 切到 graph runner。

**Tech Stack:** Node.js 20+, CommonJS 现有代码, ESM graph runner, `@langchain/langgraph`, optional `@langchain/core`, MySQL, OpenClaw CLI provider.

---

## 设计结论

### 为什么不是全量重写

当前系统已经有稳定生产边界：

- `scripts/engine_batch.js`：主流程编排、run 统计、补位循环。
- `scripts/lib/pipeline_lib.js`：业务步骤实现和 `callAgent`。
- `scripts/lib/providers/index.js`：模型执行器路由。
- `scripts/lib/providers/openclaw_cli.js`：生产模型执行器。
- `workflow_steps` / `workflow_events` / `model_runs`：Viewer 和调试使用的审计表。

LangGraph 应先替换“流程表达方式”，不是替换所有业务逻辑。否则会同时重写采集、选题、文章、评分、渠道、trace、run-control 和 Viewer 契约，风险过高。

### 目标结构

```text
engine_daily.js
  -> engine_batch.js                         当前稳定入口，保留
  -> scripts/graph/engine_graph.mjs          新增实验入口

engine_graph.mjs
  -> LangGraph StateGraph
  -> workflow_step_runner_lib.js             统一执行 pipeline step
  -> scripts/pipeline/*.js                   现有步骤，第一阶段继续复用
  -> workflow_steps / workflow_events        继续写 MySQL
  -> model_runs                              继续由 callAgent 写
  -> OpenClaw CLI provider                   不变
```

### LangChain 的位置

第一阶段不强行改 `callAgent`。LangChain 只在第二阶段用于把 provider 包装成 Runnable：

```text
LangChain Runnable
  -> providers.runTask()
    -> openclaw_cli
```

原因：现在 `callAgent` 已经承担模型调用、JSON 解析、`model_runs`、token 统计、workflow event。先改它会扩大风险，且对“流程结构更清楚”这个目标没有直接必要。

### Phase 2 必须兑现的 LangGraph 独有收益

如果 Phase 1 只得到一个等价的 `engine:batch` 替代品，不应该切生产入口。Phase 2 至少要兑现下面一种 LangGraph 独有能力，才有继续推进价值：

- 并行节点：`score:seo-geo` 与 `channels:generate` 在状态允许时并行，或渠道内 `wechat/douyin/xiaohongshu` 并行。
- 人工中断点：在终审、来源补全、低质量重写前使用 interrupt/checkpoint 暂停和恢复。
- 子图复用：选题 audition、每日生产、单篇 rebuild 共用同一组选题/文章子图。
- 节点 replay：从失败节点恢复，不重复采集和不重复消费候选。

---

## 文件结构

### 新增文件

- `scripts/lib/workflow_step_runner_lib.js`
  - 从 `engine_batch.js` 抽出可复用步骤执行器。
  - 负责创建/启动/结束 `workflow_steps`。
  - 负责调用 `scripts/pipeline/*.js` 子进程并解析 JSON 输出。

- `scripts/graph/engine_graph.mjs`
  - LangGraph 实验 runner。
  - 编译主流程图。
  - 支持 `--dry-run`、`--run-id`、`--daily-key`、`--limit`、`--target-ready`、`--max-attempts`、`--strategy`、`--skip-seo-geo-score`。

- `scripts/graph/graph_state.mjs`
  - 定义 graph state schema、reducers、默认值。
  - 只保存运行级摘要，不保存完整文章正文和大模型原文。

- `scripts/graph/nodes.mjs`
  - LangGraph node 定义。
  - 每个 node 调用 `workflow_step_runner_lib.js` 或轻量 DB 查询。

- `scripts/graph/openclaw_runnable.mjs`
  - 第二阶段使用。
  - 用 LangChain Runnable 包装现有 provider。

- `test/workflow_step_runner.test.js`
  - 测试 step runner 的 JSON 解析、失败输出、skipped 步骤。

- `test/engine_graph_contract.test.js`
  - 测试 dry-run plan、graph state 形状、条件分支。

### 修改文件

- `package.json`
  - 增加依赖：`@langchain/langgraph`、`@langchain/core`。
  - 增加脚本：`engine:graph`。

- `scripts/engine_batch.js`
  - 保留原入口。
  - 将本地 `runStep` 改为调用 `workflow_step_runner_lib.js`。
  - 不改变行为。

- `docs/03_workflow.md`
  - 补充 `engine:graph` 实验入口。
  - 标明 `engine:batch` 仍是生产入口，直到 parity 验证完成。

- `docs/16_architecture_workflow_diagram.html`
  - 增加 LangGraph 编排层说明。
  - 不改变 Viewer 数据契约。

---

## Task 1: 安装依赖和新增脚本

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 修改 package.json**

先确认 registry 上的真实版本，再写入 `package.json`：

```bash
npm view @langchain/langgraph version
npm view @langchain/core version
```

本计划写入时已验证：

```text
@langchain/langgraph 1.3.6
@langchain/core 1.1.48
```

增加依赖和脚本：

```json
{
  "scripts": {
    "engine:graph": "node scripts/graph/engine_graph.mjs"
  },
  "dependencies": {
    "@langchain/core": "1.1.48",
    "@langchain/langgraph": "1.3.6"
  }
}
```

注意：保持现有 `engine:daily`、`engine:batch`、`sources:*`、`topics:*` 不变。

- [ ] **Step 2: 安装依赖**

Run:

```bash
npm install @langchain/langgraph@1.3.6 @langchain/core@1.1.48
```

Expected:

```text
package-lock.json updated
node_modules contains @langchain/langgraph and @langchain/core
```

- [ ] **Step 3: 提交**

Run:

```bash
git add package.json package-lock.json
git commit -m "chore: add langgraph dependencies"
```

---

## Task 2: 抽出 workflow step runner

**Files:**
- Create: `scripts/lib/workflow_step_runner_lib.js`
- Modify: `scripts/engine_batch.js`
- Test: `test/workflow_step_runner.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/workflow_step_runner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../scripts/lib/workflow_step_runner_lib');

test('lastJson parses the final JSON object from mixed stdout', () => {
  const parsed = runner.lastJson('log line\n{"ok":true,"count":2}\n');
  assert.deepEqual(parsed, { ok: true, count: 2 });
});

test('lastJson returns null for non-json stdout', () => {
  assert.equal(runner.lastJson('plain text'), null);
});

test('stepKeyFromName maps colon names to underscore keys', () => {
  assert.equal(runner.stepKeyFromName('sources:collect'), 'sources_collect');
  assert.equal(runner.stepKeyFromName('score:seo-geo'), 'score_seo-geo');
});
```

- [ ] **Step 2: 确认测试失败**

Run:

```bash
node --test test/workflow_step_runner.test.js
```

Expected:

```text
not ok
Cannot find module '../scripts/lib/workflow_step_runner_lib'
```

- [ ] **Step 3: 创建 runner**

Create `scripts/lib/workflow_step_runner_lib.js`:

```js
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const my = require('./mysql_lib');
const logger = require('./logger_lib');

const execFileAsync = promisify(execFile);

function lastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const idx = text.lastIndexOf('\n{');
  try { return JSON.parse(idx >= 0 ? text.slice(idx + 1) : text); } catch (_) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }
}

function stepKeyFromName(name) {
  return String(name || '').replace(/[:]/g, '_');
}

function makeStepRunner({ root = my.ROOT, trace, stepOrderRef }) {
  if (!trace) throw new Error('makeStepRunner requires trace');
  if (!stepOrderRef || typeof stepOrderRef.value !== 'number') throw new Error('makeStepRunner requires stepOrderRef.value');

  return async function runStep(name, script, args = [], engineRunId, { skipped = false } = {}) {
    stepOrderRef.value += 1;
    const stepId = await trace.createWorkflowStep({
      engineRunId,
      stepKey: stepKeyFromName(name),
      stepName: name,
      stepOrder: stepOrderRef.value,
      inputSummary: { args },
    });
    if (skipped) {
      await trace.finishWorkflowStep(stepId, { status: 'skipped' });
      return { name, ok: true, skipped: true, result: null };
    }

    await trace.startWorkflowStep(stepId);
    await trace.logWorkflowEvent({
      engineRunId,
      workflowStepId: stepId,
      eventType: 'step_started',
      level: 'info',
      message: `步骤开始: ${name}`,
    });

    process.stdout.write(`\n=== [engine] ${name} ===\n`);
    logger.log(`[${engineRunId}] 步骤开始: ${name} ${args.join(' ')}`);

    let outcome;
    try {
      const { stdout } = await execFileAsync('node', [path.join(root, 'scripts', script), ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
        env: { ...process.env, ENGINE_RUN_ID: engineRunId, WORKFLOW_STEP_ID: stepId },
      });
      const out = stdout || '';
      process.stdout.write(out.trim().slice(0, 1200) + '\n');
      logger.log(`[${engineRunId}] 步骤输出 ${name}:\n${out.trim().slice(0, 3000)}`);
      outcome = { name, ok: true, result: lastJson(out) };
    } catch (err) {
      const stdout = (err.stdout || '').toString();
      const stderr = (err.stderr || '').toString();
      process.stdout.write((stdout + stderr).trim().slice(0, 1200) + '\n');
      const parsed = lastJson(stdout);
      outcome = {
        name,
        ok: false,
        result: parsed,
        error: (parsed && parsed.error) || stderr.slice(0, 300) || 'unknown error',
      };
      logger.logError(`[${engineRunId}] 步骤失败 ${name}: ${outcome.error}\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 1000)}`);
    }

    const hasWarnings = outcome.result && Array.isArray(outcome.result.warnings) && outcome.result.warnings.length > 0;
    await trace.finishWorkflowStep(stepId, {
      status: outcome.ok ? (hasWarnings ? 'warning' : 'success') : 'failed',
      outputSummary: outcome.result ? { ...outcome.result, results: undefined, items: undefined } : null,
      warnings: hasWarnings ? outcome.result.warnings.slice(0, 10) : null,
      errorMessage: outcome.ok ? null : outcome.error,
    });
    await trace.logWorkflowEvent({
      engineRunId,
      workflowStepId: stepId,
      eventType: 'step_completed',
      level: outcome.ok ? 'info' : 'error',
      message: `步骤${outcome.ok ? '完成' : '失败'}: ${name}${outcome.ok ? '' : ` - ${outcome.error}`}`,
    });
    return outcome;
  };
}

module.exports = { lastJson, stepKeyFromName, makeStepRunner };
```

- [ ] **Step 4: 修改 engine_batch.js 使用 runner**

In `scripts/engine_batch.js`:

```js
const { makeStepRunner } = require('./lib/workflow_step_runner_lib');
```

删除本地 `lastJson` 和 `runStep` 函数，替换为：

```js
let stepOrder = 0;
```

在 `main()` 里创建 trace 后增加：

```js
const runStep = makeStepRunner({
  root: ROOT,
  trace,
  stepOrderRef: {
    get value() { return stepOrder; },
    set value(v) { stepOrder = v; },
  },
});
```

- [ ] **Step 5: 验证行为不变**

Run:

```bash
npm test
npm run engine:batch -- --limit 1 --dry-run
```

Expected:

```text
tests pass
dry-run plan includes sources:collect, topics:generate, quota loop, jobs, factcheck, score, channels, db:list
```

- [ ] **Step 6: 提交**

Run:

```bash
git add scripts/lib/workflow_step_runner_lib.js scripts/engine_batch.js test/workflow_step_runner.test.js
git commit -m "refactor: share workflow step runner"
```

---

## Task 3: 定义 LangGraph state 和 dry-run graph

**Files:**
- Create: `scripts/graph/graph_state.mjs`
- Create: `scripts/graph/engine_graph.mjs`
- Test: `test/engine_graph_contract.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/engine_graph_contract.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('graph state defaults expose the required counters', async () => {
  const mod = await import('../scripts/graph/graph_state.mjs');
  const state = mod.initialGraphState({ engineRunId: 'run_test', limit: 1, targetReady: 5 });
  assert.equal(state.engineRunId, 'run_test');
  assert.equal(state.limit, 1);
  assert.equal(state.targetReady, 5);
  assert.equal(state.readyCount, 0);
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(state.errors, []);
});

test('graph dry-run plan is stable', async () => {
  const mod = await import('../scripts/graph/engine_graph.mjs');
  const plan = mod.buildGraphDryRunPlan({ limit: 1, targetReady: 5, maxAttempts: 15, strategy: 'balanced', skipSeoGeoScore: false });
  assert.deepEqual(plan.map((x) => x.name), [
    'sources:collect',
    'topics:generate',
    'quota:loop',
    'jobs:create',
    'jobs:run',
    'factcheck:run',
    'score:seo-geo',
    'channels:generate',
    'db:list',
  ]);
});
```

- [ ] **Step 2: 确认测试失败**

Run:

```bash
node --test test/engine_graph_contract.test.js
```

Expected:

```text
not ok
Cannot find module '../scripts/graph/graph_state.mjs'
```

- [ ] **Step 3: 创建 graph_state.mjs**

Create `scripts/graph/graph_state.mjs`:

```js
import { Annotation } from '@langchain/langgraph';

export const GraphAnnotation = Annotation.Root({
  engineRunId: Annotation(),
  dailyKey: Annotation(),
  runType: Annotation(),
  runScope: Annotation(),
  runMode: Annotation(),
  limit: Annotation(),
  minScore: Annotation(),
  strategy: Annotation(),
  targetReady: Annotation(),
  maxAttempts: Annotation(),
  attempts: Annotation(),
  topicsCollected: Annotation(),
  topicsSelected: Annotation(),
  articlesGenerated: Annotation(),
  articlesValidated: Annotation(),
  factChecksCompleted: Annotation(),
  channelOutputsGenerated: Annotation(),
  readyCount: Annotation(),
  qualityFailedCount: Annotation(),
  dedupeRejected: Annotation(),
  seoGeoScored: Annotation(),
  skipSeoGeoScore: Annotation(),
  noMoreCandidates: Annotation(),
  warnings: Annotation({
    reducer: (a, b) => [...(a || []), ...(b || [])],
    default: () => [],
  }),
  errors: Annotation({
    reducer: (a, b) => [...(a || []), ...(b || [])],
    default: () => [],
  }),
  nextActions: Annotation({
    reducer: (a, b) => [...(a || []), ...(b || [])],
    default: () => [],
  }),
});

export function initialGraphState(input = {}) {
  return {
    engineRunId: input.engineRunId || null,
    dailyKey: input.dailyKey || null,
    runType: input.runType || 'daily',
    runScope: input.runScope || 'batch',
    runMode: input.runMode || 'start',
    limit: Number(input.limit || 1),
    minScore: Number(input.minScore || 80),
    strategy: input.strategy || 'balanced',
    targetReady: Number(input.targetReady || input.limit || 1),
    maxAttempts: Number(input.maxAttempts || 15),
    attempts: 0,
    topicsCollected: 0,
    topicsSelected: 0,
    articlesGenerated: 0,
    articlesValidated: 0,
    factChecksCompleted: 0,
    channelOutputsGenerated: 0,
    readyCount: 0,
    qualityFailedCount: 0,
    dedupeRejected: 0,
    seoGeoScored: 0,
    skipSeoGeoScore: Boolean(input.skipSeoGeoScore),
    noMoreCandidates: false,
    warnings: [],
    errors: [],
    nextActions: [],
  };
}
```

- [ ] **Step 4: 创建 engine_graph.mjs dry-run 骨架**

Create `scripts/graph/engine_graph.mjs`:

```js
import { fileURLToPath } from 'node:url';
import { StateGraph, START, END } from '@langchain/langgraph';
import { GraphAnnotation, initialGraphState } from './graph_state.mjs';

export function buildGraphDryRunPlan(args) {
  const steps = [
    { name: 'sources:collect' },
    { name: 'topics:generate' },
    { name: 'quota:loop', targetReady: args.targetReady, maxAttempts: args.maxAttempts },
    { name: 'jobs:create' },
    { name: 'jobs:run' },
    { name: 'factcheck:run' },
    ...(args.skipSeoGeoScore ? [] : [{ name: 'score:seo-geo' }]),
    { name: 'channels:generate' },
    { name: 'db:list' },
  ];
  return steps;
}

export function buildGraph() {
  const graph = new StateGraph(GraphAnnotation);
  graph.addNode('start', async (state) => state);
  graph.addEdge(START, 'start');
  graph.addEdge('start', END);
  return graph.compile();
}

function parseArgs(argv) {
  const args = { limit: 1, minScore: 80, strategy: 'balanced', targetReady: null, maxAttempts: 15, dryRun: false, skipSeoGeoScore: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 1;
    else if (argv[i] === '--min-score') args.minScore = parseInt(argv[++i], 10) || 80;
    else if (argv[i] === '--strategy') args.strategy = argv[++i];
    else if (argv[i] === '--target-ready') args.targetReady = parseInt(argv[++i], 10) || null;
    else if (argv[i] === '--max-attempts') args.maxAttempts = parseInt(argv[++i], 10) || 15;
    else if (argv[i] === '--skip-seo-geo-score') args.skipSeoGeoScore = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  args.targetReady = args.targetReady || args.limit;
  return args;
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      runner: 'langgraph',
      plan: buildGraphDryRunPlan(args),
      state: initialGraphState(args),
    }, null, 2));
    return;
  }
  const app = buildGraph();
  const out = await app.invoke(initialGraphState(args));
  console.log(JSON.stringify({ ok: true, runner: 'langgraph', state: out }, null, 2));
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exitCode = 1;
});
```

- [ ] **Step 5: 增加 npm script**

In `package.json`:

```json
"engine:graph": "node scripts/graph/engine_graph.mjs"
```

- [ ] **Step 6: 验证 dry-run**

Run:

```bash
npm test
npm run engine:graph -- --limit 1 --target-ready 5 --dry-run
```

Expected:

```text
tests pass
"runner": "langgraph"
plan includes quota:loop
```

- [ ] **Step 7: 提交**

Run:

```bash
git add package.json scripts/graph/graph_state.mjs scripts/graph/engine_graph.mjs test/engine_graph_contract.test.js
git commit -m "feat: add langgraph dry-run runner"
```

---

## Task 4: 实现 graph nodes，复用现有 pipeline CLI

**Files:**
- Create: `scripts/graph/nodes.mjs`
- Modify: `scripts/graph/engine_graph.mjs`
- Test: `test/engine_graph_contract.test.js`

- [ ] **Step 1: 增加节点契约测试**

Append to `test/engine_graph_contract.test.js`:

```js
test('node specs map graph nodes to existing pipeline scripts', async () => {
  const mod = await import('../scripts/graph/nodes.mjs');
  assert.equal(mod.STEP_SPECS.collectSources.script, 'pipeline/sources_collect.js');
  assert.equal(mod.STEP_SPECS.generateTopics.script, 'pipeline/topics_generate.js');
  assert.equal(mod.STEP_SPECS.createJobs.script, 'pipeline/jobs_create.js');
  assert.equal(mod.STEP_SPECS.runJobs.script, 'pipeline/jobs_run.js');
  assert.equal(mod.STEP_SPECS.factcheck.script, 'pipeline/factcheck_run.js');
  assert.equal(mod.STEP_SPECS.scoreSeoGeo.script, 'pipeline/score_seo_geo.js');
  assert.equal(mod.STEP_SPECS.channels.script, 'pipeline/channels_generate.js');
});

test('candidate exhaustion is a business stop condition', async () => {
  const mod = await import('../scripts/graph/nodes.mjs');
  assert.equal(mod.isCandidateExhausted({ error: '没有符合条件的候选主题（score>=80）' }), true);
  assert.equal(mod.isCandidateExhausted({ error: '高分候选全部被组合节流（deferred 12 个）' }), true);
  assert.equal(mod.isCandidateExhausted({ error: '数据库连接失败' }), false);
});
```

- [ ] **Step 2: 创建 nodes.mjs**

Create `scripts/graph/nodes.mjs`:

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const my = require('../lib/mysql_lib');
const trace = require('../lib/trace_lib');
const { makeStepRunner } = require('../lib/workflow_step_runner_lib');

export const STEP_SPECS = {
  collectSources: { name: 'sources:collect', script: 'pipeline/sources_collect.js', args: () => [] },
  generateTopics: { name: 'topics:generate', script: 'pipeline/topics_generate.js', args: () => [] },
  createJobs: {
    name: 'jobs:create',
    script: 'pipeline/jobs_create.js',
    args: (s) => ['--limit', String(s.limit), '--min-score', String(s.minScore), '--strategy', s.strategy],
  },
  runJobs: {
    name: 'jobs:run',
    script: 'pipeline/jobs_run.js',
    args: (s) => ['--limit', String(s.limit)],
  },
  factcheck: {
    name: 'factcheck:run',
    script: 'pipeline/factcheck_run.js',
    args: (s) => ['--limit', String(Math.max(s.limit, s.targetReady))],
  },
  scoreSeoGeo: {
    name: 'score:seo-geo',
    script: 'pipeline/score_seo_geo.js',
    args: (s) => ['--status', 'ready_for_review', '--strategy', s.strategy],
  },
  channels: {
    name: 'channels:generate',
    script: 'pipeline/channels_generate.js',
    args: () => ['--status', 'ready_for_review', '--missing-only'],
  },
  dbList: { name: 'db:list', script: 'tools/db_list.js', args: () => ['--limit', '10'] },
};

export function makeGraphNodeContext({ stepOrderRef }) {
  return {
    runStep: makeStepRunner({ root: my.ROOT, trace, stepOrderRef }),
  };
}

export function isCandidateExhausted(outcome) {
  const msg = String((outcome && outcome.result && outcome.result.error) || (outcome && outcome.error) || '');
  return /没有符合条件的候选主题|高分候选全部被组合节流/.test(msg);
}

export function makeStepNode(spec, ctx) {
  return async function stepNode(state) {
    const outcome = await ctx.runStep(spec.name, spec.script, spec.args(state), state.engineRunId);
    if (!outcome.ok && spec.name === 'jobs:create' && isCandidateExhausted(outcome)) {
      return {
        noMoreCandidates: true,
        warnings: [`jobs:create: ${outcome.error}`],
      };
    }
    if (!outcome.ok) {
      return { errors: [`${spec.name}: ${outcome.error}`] };
    }
    const result = outcome.result || {};
    if (spec.name === 'sources:collect') {
      return {
        topicsCollected: result.summary ? result.summary.total || 0 : 0,
        warnings: (result.warnings || []).slice(0, 8),
      };
    }
    if (spec.name === 'topics:generate') {
      return { dedupeRejected: result.dedupeRejected || 0 };
    }
    if (spec.name === 'jobs:create') {
      const jobCount = result.jobCount || (result.selected ? result.selected.length : 0) || 0;
      return {
        topicsSelected: (state.topicsSelected || 0) + jobCount,
        noMoreCandidates: jobCount === 0,
        warnings: jobCount === 0 ? ['jobs:create 未选出候选，停止补位循环'] : [],
      };
    }
    if (spec.name === 'jobs:run') {
      const attempted = (result.succeeded || 0) + (result.failed || 0);
      return {
        attempts: (state.attempts || 0) + attempted,
        articlesGenerated: (state.articlesGenerated || 0) + attempted,
        articlesValidated: (state.articlesValidated || 0) + (result.succeeded || 0),
        warnings: (result.results || []).filter((r) => !r.ok).map((r) => `job ${r.jobId}: ${(r.failures || []).join('; ').slice(0, 200)}`),
      };
    }
    if (spec.name === 'factcheck:run') {
      return { factChecksCompleted: (state.factChecksCompleted || 0) + (result.succeeded || 0) };
    }
    if (spec.name === 'score:seo-geo') {
      return { seoGeoScored: result.scored || 0 };
    }
    if (spec.name === 'channels:generate') {
      return { channelOutputsGenerated: result.channelOutputsGenerated || 0 };
    }
    return {};
  };
}

export async function refreshArticleCounts(state) {
  const ready = (await my.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = ? AND status = 'ready_for_review'", [state.engineRunId]))[0].c;
  const qualityFailed = (await my.query("SELECT COUNT(*) c FROM articles WHERE engine_run_id = ? AND status = 'needs_quality_revision'", [state.engineRunId]))[0].c;
  return { readyCount: ready, qualityFailedCount: qualityFailed };
}
```

- [ ] **Step 3: 修改 engine_graph.mjs 接入节点**

Replace `buildGraph()` with:

```js
import { STEP_SPECS, makeGraphNodeContext, makeStepNode, refreshArticleCounts } from './nodes.mjs';
import { GraphAnnotation } from './graph_state.mjs';

export function buildGraph({ stepOrderRef = { value: 0 } } = {}) {
  const ctx = makeGraphNodeContext({ stepOrderRef });
  const graph = new StateGraph(GraphAnnotation);

  graph.addNode('collect_sources', makeStepNode(STEP_SPECS.collectSources, ctx));
  graph.addNode('generate_topics', makeStepNode(STEP_SPECS.generateTopics, ctx));
  graph.addNode('create_jobs', makeStepNode(STEP_SPECS.createJobs, ctx));
  graph.addNode('run_jobs', makeStepNode(STEP_SPECS.runJobs, ctx));
  graph.addNode('factcheck', makeStepNode(STEP_SPECS.factcheck, ctx));
  graph.addNode('refresh_counts', refreshArticleCounts);
  graph.addNode('score_seo_geo', makeStepNode(STEP_SPECS.scoreSeoGeo, ctx));
  graph.addNode('channels', makeStepNode(STEP_SPECS.channels, ctx));
  graph.addNode('db_list', makeStepNode(STEP_SPECS.dbList, ctx));

  graph.addEdge(START, 'collect_sources');
  graph.addEdge('collect_sources', 'generate_topics');
  graph.addEdge('generate_topics', 'create_jobs');
  graph.addConditionalEdges('create_jobs', (s) => s.noMoreCandidates ? 'refresh_counts' : 'run_jobs');
  graph.addEdge('run_jobs', 'factcheck');
  graph.addEdge('factcheck', 'refresh_counts');
  graph.addConditionalEdges('refresh_counts', (s) => {
    if ((s.readyCount || 0) >= s.targetReady) return s.skipSeoGeoScore ? 'channels' : 'score_seo_geo';
    if (s.noMoreCandidates) return s.skipSeoGeoScore ? 'channels' : 'score_seo_geo';
    if ((s.attempts || 0) >= s.maxAttempts) return s.skipSeoGeoScore ? 'channels' : 'score_seo_geo';
    return 'create_jobs';
  });
  graph.addEdge('score_seo_geo', 'channels');
  graph.addEdge('channels', 'db_list');
  graph.addEdge('db_list', END);
  return graph.compile();
}
```

- [ ] **Step 4: 验证 contract**

Run:

```bash
npm test
npm run engine:graph -- --limit 1 --target-ready 1 --dry-run
```

Expected:

```text
tests pass
dry-run remains stable
```

- [ ] **Step 5: 提交**

Run:

```bash
git add scripts/graph/nodes.mjs scripts/graph/engine_graph.mjs test/engine_graph_contract.test.js
git commit -m "feat: map pipeline steps to langgraph nodes"
```

---

## Task 5: engine:graph 写 engine_runs 并支持真实运行

**Files:**
- Modify: `scripts/graph/engine_graph.mjs`
- Test: manual dry-run and one-row integration run

- [ ] **Step 1: 修改 main() 创建 engine_runs**

在 `engine_graph.mjs` 中通过 `createRequire` 引入现有库：

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const my = require('../lib/mysql_lib');
const trace = require('../lib/trace_lib');
const runtime = require('../lib/workflow_runtime_lib');
```

真实运行分支中创建或接管 `engine_runs`。规则：

- 没有 `--run-id`：`engine:graph` 自己创建 batch-scope 实验 run。
- 有 `--run-id` 且库里已存在：只更新状态，不重复 insert，保留 `daily_key`、`run_scope`、`is_active` 和 `run_mode`。
- `run_mode` 只保存触发模式：`start` / `retry` / `rebuild` / `force`。
- `runner` 标识写入 `summary_json.runner`，不污染 `run_mode`。

```js
const engineRunId = args.runId || my.makeRunId('graph');
const state = initialGraphState({ ...args, engineRunId });
const existingRun = (await my.query('SELECT id FROM engine_runs WHERE id = ?', [engineRunId]))[0];
if (existingRun) {
  await my.update('engine_runs', { status: 'running', updated_at: my.now() }, 'id = ?', [engineRunId]);
} else {
  await my.insert('engine_runs', {
    id: engineRunId,
    run_type: args.runType || 'daily',
    status: 'running',
    started_at: my.now(),
    daily_key: args.dailyKey || null,
    run_scope: args.runScope || 'batch',
    run_mode: args.runMode || 'start',
    is_active: args.runScope === 'daily' ? 1 : 0,
    triggered_by: args.actor || 'cli',
    trigger_source: args.triggerSource || 'cli',
  });
}
await trace.logWorkflowEvent({
  engineRunId,
  eventType: 'engine_started',
  level: 'info',
  message: `graph engine 启动（target ${state.targetReady}, limit ${state.limit}, strategy ${state.strategy}）`,
});
const app = buildGraph();
const out = await app.invoke(state);
const businessOutcome = runtime.businessOutcome({
  readyCount: out.readyCount || 0,
  targetReady: out.targetReady,
  technicalFailed: (out.errors || []).length > 0 && (out.readyCount || 0) === 0,
});
const hasTechnicalErrors = (out.errors || []).length > 0;
const hasBusinessProgress = (out.readyCount || 0) > 0 || (out.articlesGenerated || 0) > 0 || (out.topicsSelected || 0) > 0;
const status = businessOutcome === 'target_met' && !hasTechnicalErrors
  ? 'succeeded'
  : hasTechnicalErrors && !hasBusinessProgress
    ? 'failed'
    : 'partial';
const summary = { ok: status === 'succeeded', runner: 'langgraph', engineRunId, businessOutcome, ...out };
await my.update('engine_runs', {
  status,
  finished_at: my.now(),
  topics_collected: out.topicsCollected || 0,
  topics_selected: out.topicsSelected || 0,
  articles_generated: out.articlesGenerated || 0,
  articles_validated: out.readyCount || 0,
  fact_checks_completed: out.factChecksCompleted || 0,
  channel_outputs_generated: out.channelOutputsGenerated || 0,
  summary_json: summary,
  error_message: (out.errors || []).length ? out.errors.slice(0, 5).join(' | ').slice(0, 800) : null,
}, 'id = ?', [engineRunId]);
await my.closePool();
console.log(JSON.stringify(summary, null, 2));
if (status === 'failed') process.exitCode = 1;
```

- [ ] **Step 2: 增加参数解析**

`parseArgs()` 支持：

```text
--run-id
--daily-key
--run-type
--run-scope
--run-mode
--actor
--trigger-source
--limit
--min-score
--strategy
--target-ready
--max-attempts
--skip-seo-geo-score
--dry-run
```

- [ ] **Step 3: 运行 dry-run**

Run:

```bash
npm run engine:graph -- --limit 1 --target-ready 1 --dry-run
```

Expected:

```text
"ok": true
"runner": "langgraph"
```

- [ ] **Step 4: 运行真实小流量验证**

Run:

```bash
npm run engine:graph -- --limit 1 --target-ready 1 --max-attempts 2
```

Expected:

```text
engine_runs has one graph run
workflow_steps has sources:collect/topics:generate/jobs:create/jobs:run/factcheck:run/... rows
model_runs still records OpenClaw calls
```

- [ ] **Step 5: 提交**

Run:

```bash
git add scripts/graph/engine_graph.mjs
git commit -m "feat: run daily workflow through langgraph"
```

---

## Task 6: 可选 LangChain Runnable 包装 OpenClaw provider

**Files:**
- Create: `scripts/graph/openclaw_runnable.mjs`
- Test: `test/openclaw_runnable.test.js`

- [ ] **Step 1: 写测试**

Create `test/openclaw_runnable.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('OpenClaw runnable accepts provider-compatible task input', async () => {
  const mod = await import('../scripts/graph/openclaw_runnable.mjs');
  const runnable = mod.createProviderRunnable({
    runTask: async ({ message, sessionKey }) => ({
      ok: true,
      visibleText: '{"ok":true,"message":"' + message + '","sessionKey":"' + sessionKey + '"}',
      raw: { mocked: true },
      durationMs: 1,
    }),
  });
  const out = await runnable.invoke({
    taskType: 'fact_check',
    message: 'hello',
    sessionKey: 'test-session',
    timeoutSec: 10,
  });
  assert.equal(out.ok, true);
  assert.equal(out.visibleText.includes('hello'), true);
});
```

- [ ] **Step 2: 创建 runnable**

Create `scripts/graph/openclaw_runnable.mjs`:

```js
import { createRequire } from 'node:module';
import { RunnableLambda } from '@langchain/core/runnables';

const require = createRequire(import.meta.url);
const providers = require('../lib/providers');

export function createProviderRunnable(adapter = providers) {
  return RunnableLambda.from(async (input) => {
    const taskType = input.taskType || 'fact_check';
    const message = input.message || '';
    const sessionKey = input.sessionKey || `agent:graph:${Date.now()}`;
    const timeoutSec = input.timeoutSec || 900;
    return adapter.runTask({ taskType, message, sessionKey, timeoutSec });
  });
}
```

- [ ] **Step 3: 验证**

Run:

```bash
node --test test/openclaw_runnable.test.js
```

Expected:

```text
ok
```

- [ ] **Step 4: 提交**

Run:

```bash
git add scripts/graph/openclaw_runnable.mjs test/openclaw_runnable.test.js
git commit -m "feat: add langchain runnable for model providers"
```

---

## Task 7: Parity 验证，不切生产入口

**Files:**
- Modify: `docs/03_workflow.md`
- Modify: `docs/16_architecture_workflow_diagram.html`

- [ ] **Step 1: 对比 dry-run plan**

Run:

```bash
npm test
npm run engine:batch -- --limit 1 --target-ready 1 --dry-run
npm run engine:graph -- --limit 1 --target-ready 1 --dry-run
```

Expected:

```text
npm test passes
both dry-run commands succeed
both plans contain equivalent major steps
```

- [ ] **Step 2: 真实运行只验证 trace 形状，不直接比较产出**

不要在同一份候选数据上连续跑 `engine:batch` 和 `engine:graph` 做结果对比。第一次运行会消费候选、创建 job、改变文章状态，第二次已经不是同条件输入。

真实验证采用两种方式之一：

- 方式 A：只跑 `engine:graph`，验证能完成、能写 trace、Viewer 能读。
- 方式 B：准备两个隔离 `daily_key` 的模拟数据，再分别跑 batch 和 graph。

方式 A Run:

```bash
npm run engine:graph -- --limit 1 --target-ready 1 --max-attempts 2 --daily-key 2026-06-07
```

方式 B Run:

```bash
npm run engine:batch -- --limit 1 --target-ready 1 --max-attempts 2 --daily-key 2026-06-07
npm run engine:graph -- --limit 1 --target-ready 1 --max-attempts 2 --daily-key 2026-06-08
```

Compare:

```sql
SELECT id, run_mode, status, JSON_EXTRACT(summary_json, '$.runner') runner,
       articles_validated, topics_collected, topics_selected, articles_generated
FROM engine_runs
ORDER BY started_at DESC
LIMIT 2;

SELECT engine_run_id, step_name, status, duration_ms
FROM workflow_steps
WHERE engine_run_id IN (?, ?)
ORDER BY engine_run_id, step_order;
```

Acceptance:

```text
engine:graph completes, partials, or fails for explainable reasons
workflow step names remain Viewer-compatible
model_runs still records provider=openclaw_cli
business no-candidate case exits as partial/warning, not infinite loop
```

- [ ] **Step 3: 更新 docs/03_workflow.md**

Add:

```md
## LangGraph 实验入口

`npm run engine:graph` 是与 `engine:batch` 并行的实验编排入口。它使用 LangGraph 表达节点和条件分支，但继续写入现有 `engine_runs`、`workflow_steps`、`workflow_events`、`model_runs`。生产入口仍是 `npm run engine:daily` / `npm run engine:batch`，直到 graph parity 验证通过。
```

- [ ] **Step 4: 更新 docs/16_architecture_workflow_diagram.html**

在编排层增加：

```text
engine_graph.mjs：实验 LangGraph 编排；复用现有 pipeline step、MySQL trace、OpenClaw provider。
```

- [ ] **Step 5: 提交**

Run:

```bash
git add docs/03_workflow.md docs/16_architecture_workflow_diagram.html
git commit -m "docs: document langgraph experimental runner"
```

---

## Task 8: 切换策略评审

**Files:**
- No required code change until parity results are reviewed.

- [ ] **Step 1: 判断是否切生产入口**

只有满足以下条件才允许把 `engine_daily.js` 切到 graph runner：

```text
1. engine:graph 连续 3 次真实小流量运行没有技术失败。
2. workflow_steps 的 step_key/step_name 和 Viewer 兼容。
3. model_runs 仍完整记录 prompt/raw_response/parsed_output。
4. target-ready loop 能正确补位，不会无限循环。
5. OpenClaw CLI 的 session_key、timeout、json 解析行为不变。
6. Viewer 今日看板、生产日报、运行详情三处都能正确显示 graph run。
7. graph run 保留 run_mode=start/retry/rebuild/force，runner 只写 summary_json.runner。
```

- [ ] **Step 2: 若切换，保留回滚开关**

在 `engine_daily.js` 增加环境变量：

```text
WORKFLOW_RUNNER=batch|graph
```

默认：

```text
WORKFLOW_RUNNER=batch
```

只有显式设置 `WORKFLOW_RUNNER=graph` 才走新 runner。

- [ ] **Step 3: 切换后验证**

Run:

```bash
WORKFLOW_RUNNER=graph npm run engine:daily -- --mode start --daily-key 2026-06-07 --actor codex --trigger-source cli
```

Expected:

```text
engine_runs.run_mode = start
engine_runs.summary_json.runner = langgraph
daily_key, is_active=1, run_scope=daily are set by engine_daily
Viewer can read the run
workflow_steps display normally
```

---

## 风险控制

- 不修改 Viewer SQL，除非 step_key 或 summary_json 结构发生变化。
- 不把 LangGraph checkpoint 当业务数据库；业务结果仍写 MySQL。
- 第一阶段不删除 `engine_batch.js`。
- 第一阶段不替换 `callAgent`。
- 第一阶段不引入 LangSmith 作为必需依赖；调试仍以 MySQL trace 为主。
- LangGraph checkpoint 如需落地，优先单独建表或使用官方持久化组件；不要混写业务表。
- `StateGraph` 使用 `Annotation.Root` schema 写法；该写法已按 `@langchain/langgraph@1.3.6` 包内类型和示例校验。

---

## 预计工作量

| 阶段 | 内容 | 估算 |
|---|---|---|
| Phase 1 | 依赖、step runner 抽离、dry-run graph | 1-2 天 |
| Phase 2 | 真实 graph runner、quota loop、trace 对齐 | 3-5 天 |
| Phase 3 | OpenClaw Runnable、模型调用适配评估 | 1-2 天 |
| Phase 4 | parity 测试、文档、是否切生产入口 | 2-4 天 |

总计：约 1-2 周可以得到可验证的 LangGraph 编排入口；若要完全替换 `engine_batch` 并清理旧路径，约 2-3 周。由于 `@langchain/core@1.1.48` 要求 Node `>=20`，项目运行前置条件同步提升到 Node 20+。

---

## 验收标准

- `npm test` 通过。
- `npm run engine:batch -- --limit 1 --dry-run` 通过。
- `npm run engine:graph -- --limit 1 --dry-run` 通过。
- `engine:graph` 真实运行后：
  - `engine_runs` 有记录。
  - `workflow_steps` 有完整步骤。
  - `workflow_events` 有节点事件。
  - `model_runs.model_provider` 仍记录实际 provider。
  - Viewer 不需要改就能看到 run。
- OpenClaw CLI 使用方式不变。

---

## 自检

- Spec coverage: 覆盖结构更清楚、调试更方便、OpenClaw 不受影响、现有入口保留。
- Placeholder scan: 无 TBD/TODO/以后补。
- Type consistency: `engineRunId`、`targetReady`、`maxAttempts`、`readyCount`、`noMoreCandidates`、`warnings`、`errors` 在 state、node、summary 中命名一致；`run_mode` 保留触发模式，`summary_json.runner` 标识 runner。
