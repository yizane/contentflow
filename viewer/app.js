// Flyfus 控制台前端（全中文 + 工作流可视化）
const $ = (s) => document.querySelector(s);
const api = (p) => fetch(p).then((r) => r.json());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ===== 中文字典 =====
const ZH_STATUS = {
  succeeded: '成功', success: '成功', failed: '失败', running: '运行中', partial: '部分成功',
  warning: '有警告', skipped: '已跳过', pending: '等待中', rejected: '已拒绝', accepted: '已受理',
  superseded: '已被替代', cancelled: '已取消', archived: '已归档', generated: '已生成',
  validated: '已校验', validation_failed: '校验失败', candidate: '候选', selected: '已选中',
  ready_for_review: '待终审', needs_fact_sources: '待补来源', article_validated: '已过质量门',
  fact_check_failed: '核查未过', fact_checked: '已核查', reviewed: '已复审',
  approved_for_publish: '批准发布', published: '已发布', missing_article: '缺文章',
  ready_after_minor_edits: '微调后可发', not_ready: '未就绪', active: '生效中',
  low: '低', medium: '中', high: '高', publish: '可发布', revise: '需修改', reject: '不通过',
};
const ZH_ACTION = {
  start_daily: '启动今日运行', retry_daily: '重试今日', rebuild_daily: '重建今日',
  force_daily: '强制运行', generate_report: '生成报告', mark: '终审标记',
};
const ZH_STEP = {
  'collect:sources': '采集选题源', 'run:topic-generation': '生成主题池', 'jobs:create-articles': '创建文章任务',
  'jobs:run-articles': '生成文章', 'jobs:run-fact-check': '事实核查', 'channels:generate': '渠道改写',
  'run:seo-geo-score': 'SEO/GEO 评分', 'db:list': '数据快照',
};
const ZH_TASK = {
  article_generation: '文章生成', fact_check: '事实核查', source_resolution: '来源补全',
  article_revision: '文章修订', channel_repurpose: '渠道改写', seo_geo_score: 'SEO/GEO 评分',
  topic_generation: '主题生成', search_collection: '搜索采集', quality_gate: '质量门',
};
const ZH_ENTITY = {
  article: '文章', article_version: '文章版本', article_job: '文章任务', topic_candidate: '候选主题',
  channel_output: '渠道稿', publish_package: '发布包', engine_run: '引擎运行',
};
const ZH_CHANNEL = { wechat: '公众号', douyin: '抖音口播', xiaohongshu: '小红书' };

const zh = (dict, k) => dict[k] || k;
const st = (s) => `<span class="status ${esc(s)}">${esc(zh(ZH_STATUS, s))}</span>`;
const dur = (ms) => (ms == null ? '-' : ms > 60000 ? (ms / 60000).toFixed(1) + ' 分钟' : (ms / 1000).toFixed(1) + ' 秒');
// 时间格式化：去掉 GMT 长串 → "06-05 11:39"
function fmt(t, withYear = false) {
  if (!t) return '-';
  const d = new Date(t);
  if (isNaN(d)) return String(t).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${withYear ? d.getFullYear() + '-' : ''}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let latestRunId = null;

// ===== tab 切换 =====
document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#tab-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'runs') loadRuns();
    if (b.dataset.tab === 'sources') loadSources();
    if (b.dataset.tab === 'reports') loadReport();
  };
});

// ===== 工作流流程条 =====
const PIPELINE = ['collect:sources', 'run:topic-generation', 'jobs:create-articles', 'jobs:run-articles', 'jobs:run-fact-check', 'channels:generate', 'run:seo-geo-score'];
function pipelineBar(steps) {
  const byName = {};
  for (const s of steps || []) byName[s.step_name] = s;
  return `<div class="pipeline">${PIPELINE.map((key, i) => {
    const s = byName[key];
    const status = s ? s.status : 'pending';
    const time = s && s.duration_ms != null ? dur(s.duration_ms) : '';
    return `${i > 0 ? '<span class="pipe-arrow">→</span>' : ''}<span class="pipe-node ${esc(status)}" title="${esc(zh(ZH_STEP, key))}：${esc(zh(ZH_STATUS, status))}${s && s.error_message ? '\n' + esc(s.error_message) : ''}">
      <span class="pipe-dot"></span>${esc(zh(ZH_STEP, key))}${time ? `<span class="pipe-time">${time}</span>` : ''}</span>`;
  }).join('')}</div>`;
}

// ===== 今日运行控制 =====
async function loadRunControl() {
  const d = await api('/api/run-control/today');
  const r = d.run;
  let pipelineHtml = '';
  if (r) {
    try {
      const detail = await api('/api/engine-runs/' + r.id);
      pipelineHtml = pipelineBar(detail.workflow_steps);
    } catch (_) { /* ignore */ }
  }
  $('#rc-status').innerHTML = r
    ? `<b>今日（${esc(d.dailyKey)}）</b>　${st(r.status)} ${r.isActive ? '<span class="status running">生效中</span>' : '<span class="status skipped">已被替代</span>'}
       　采集 ${r.topicsCollected} 条 · 生成文章 ${r.articlesGenerated} 篇 · 待终审 ${r.readyForReview} 篇
       <br><span class="hint">${fmt(r.startedAt)} 开始 → ${r.finishedAt ? fmt(r.finishedAt) + ' 结束' : '进行中…'}</span>
       ${pipelineHtml}`
    : `<b>今日（${esc(d.dailyKey)}）</b>　<span class="hint">今天还没有运行。点击「跑今天」开始。</span>`;

  // 按钮启停 + 置灰原因（悬停可见 + 文字说明）
  const reasons = [];
  const btn = (id, enabled, disabledReason) => {
    const el = $(id);
    el.disabled = !enabled;
    el.title = enabled ? '' : disabledReason;
    if (!enabled && disabledReason) reasons.push(`${el.textContent}：${disabledReason}`);
  };
  btn('#rc-run', d.availableActions.start, r ? (r.status === 'running' ? '今日运行进行中' : '今日已完成，重复执行不会创建新数据') : '');
  btn('#rc-retry', d.availableActions.retry, !r ? '今天还没跑过，请先「跑今天」' : (r.status === 'succeeded' ? '今日已成功完成，没有失败步骤可重试' : r.status === 'running' ? '运行中，不能重试' : ''));
  btn('#rc-rebuild', d.availableActions.rebuild, '今天没有运行记录，直接「跑今天」即可');
  $('#rc-reason').innerHTML = reasons.length ? `<span class="hint">ⓘ 灰色按钮原因：${reasons.map(esc).join('；')}</span>` : '';

  const acts = await api('/api/run-actions?limit=5');
  $('#rc-actions').innerHTML = '<b class="hint">最近操作：</b>' + (acts.actions.map((a) =>
    `<span class="evt">${st(a.status)} ${esc(zh(ZH_ACTION, a.action))} <span class="hint">${fmt(a.created_at)} 来自${a.trigger_source === 'viewer' ? '页面' : '命令行'}${a.error_message ? ' — ' + esc(a.error_message.slice(0, 40)) + '…' : ''}</span></span>`
  ).join('') || '<span class="hint">无</span>');
}

async function rcPost(mode, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  const r = await fetch('/api/run-control/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, actor: 'local-viewer' }) }).then((x) => x.json());
  alert(r.ok ? r.message : `已拒绝：${r.reason || r.error}`);
  loadRunControl();
}
$('#rc-run').onclick = () => rcPost('start');
$('#rc-retry').onclick = () => rcPost('retry');
$('#rc-rebuild').onclick = () => rcPost('rebuild', '重建会把今天的旧数据归档（不会物理删除），然后完整重跑一遍。确定吗？');
$('#rc-report').onclick = () => alert('请在终端运行：npm run engine:report\n（报告会写入数据库，本页「报告」tab 可查看）');

// ===== 文章 =====
async function loadArticles() {
  const d = await api('/api/articles?limit=50');
  $('#article-list').innerHTML = d.articles.map((a) => `
    <div class="item" onclick="showArticle('${a.id}', this)">
      <div class="t">${esc(a.title)}</div>
      <div class="m">${st(a.status)} 质量 ${a.quality_score ?? '-'} 分 · SEO ${a.seo_score ?? '-'} · GEO ${a.geo_score ?? '-'} · ${fmt(a.created_at)}</div>
    </div>`).join('');
}

window.showArticle = async (id, el) => {
  document.querySelectorAll('#article-list .item').forEach((x) => x.classList.remove('sel'));
  if (el) el.classList.add('sel');
  const [d, t] = await Promise.all([api('/api/articles/' + id), api(`/api/articles/${id}/trace`)]);
  const a = d.article;
  const v = d.latest_version;
  $('#article-detail').innerHTML = `
    <h2>${esc(a.title)}</h2>
    <p>${st(a.status)}　链接名：<code>${esc(a.slug)}</code>　主关键词：${esc(a.primary_keyword)}</p>
    <p class="m">质量 ${a.quality_score ?? '-'} 分 · SEO ${a.seo_score ?? '-'} · GEO ${a.geo_score ?? '-'} · 核查结论：${esc(zh(ZH_STATUS, a.fact_publish_readiness ?? '-'))}</p>
    <h3>渠道稿</h3>
    ${d.channels.length ? d.channels.map((c) => `${st(c.status)} ${esc(zh(ZH_CHANNEL, c.channel))}（${c.len} 字）`).join('　') : '<span class="hint">还没有渠道稿</span>'}
    <h3>状态变化历史</h3>
    ${t.status_transitions.map((x) => `<div class="evt">${fmt(x.created_at)}〔${esc(zh(ZH_ENTITY, x.entity_type))}〕${esc(zh(ZH_STATUS, x.from_status) ?? '新建')} → <b>${esc(zh(ZH_STATUS, x.to_status))}</b> <span class="hint">${esc(x.reason ?? '')}</span></div>`).join('') || '<span class="hint">无</span>'}
    <h3>AI 调用记录（只显示摘要，不含完整内容）</h3>
    <table><tr><th>任务</th><th>状态</th><th>提示词字数</th><th>回复字数</th><th>错误</th></tr>
    ${t.model_runs_summary.map((m) => `<tr><td>${esc(zh(ZH_TASK, m.task_type))}</td><td>${st(m.status)}</td><td>${m.prompt_chars ?? '-'}</td><td>${m.response_chars ?? '-'}</td><td>${esc(m.error_message ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="hint">无（旧数据未关联）</td></tr>'}</table>
    <h3>事实核查历史</h3>
    ${t.fact_checks_history.map((f) => `<div class="evt">${fmt(f.created_at)} ${st(f.publish_readiness)} 共 ${f.claims_count} 条表述 / 高风险 ${f.high_risk_count} / 待修 ${f.must_fix_count}</div>`).join('') || '<span class="hint">无</span>'}
    <h3>来源补全情况</h3>
    ${t.source_resolutions_summary.map((r) => `${st(r.resolved_status)} ×${r.c}`).join('　') || '<span class="hint">无</span>'}
    <h3>版本历史</h3>
    ${(t.versions || []).map((x) => `<div class="evt">${esc(x.version_label)}（${x.generation_mode === 'fact_checked_revision' ? '修订版' : '初稿'}）${st(x.status)} ${fmt(x.created_at)}</div>`).join('')}
    <details><summary>📄 查看文章正文（点击展开）</summary><pre class="markdown-body">${esc(v ? v.markdown : '')}</pre></details>
  `;
};

// ===== 引擎运行 =====
async function loadRuns() {
  const d = await api('/api/engine-runs?limit=15');
  if (d.runs[0]) latestRunId = d.runs[0].id;
  $('#run-list').innerHTML = d.runs.map((r) => `
    <div class="item" onclick="showRun('${r.id}', this)">
      <div class="t">${esc(r.daily_key || '')} ${r.run_scope === 'daily' ? '每日运行' : '手动批量'} ${r.is_active ? '' : '<span class="status skipped">已被替代</span>'}</div>
      <div class="m">${st(r.status)} ${r.trigger_source === 'viewer' ? '页面触发' : '命令行'} · 文章 ${r.articles_validated} 篇 · 耗时 ${dur(r.duration_ms)} · ${fmt(r.started_at)}</div>
    </div>`).join('');
}

window.showRun = async (id, el) => {
  document.querySelectorAll('#run-list .item').forEach((x) => x.classList.remove('sel'));
  if (el) el.classList.add('sel');
  const d = await api('/api/engine-runs/' + id);
  const srcLine = d.source_collection_summary.map((s) => `${st(s.status)} ×${s.c}（发现 ${s.found ?? 0} / 入库 ${s.inserted ?? 0}）`).join('　');
  $('#run-detail').innerHTML = `
    <h2>${esc(d.engine_run.daily_key || '')} ${d.engine_run.run_scope === 'daily' ? '每日运行' : '批量运行'} ${st(d.engine_run.status)}</h2>
    <p class="hint">${esc(id)}${d.engine_run.superseded_by ? `　已被 ${esc(d.engine_run.superseded_by)} 替代` : ''}</p>
    <h3>工作流</h3>
    ${pipelineBar(d.workflow_steps)}
    <h3>步骤明细</h3>
    <div class="timeline">
    ${d.workflow_steps.map((s) => `<div class="step">${st(s.status)} <b>${esc(zh(ZH_STEP, s.step_name))}</b>
      ${s.warnings && s.warnings.length ? `<span class="hint">⚠ ${s.warnings.length} 条警告</span>` : ''}
      ${s.error_message ? `<span class="hint" style="color:#d64545">${esc(s.error_message.slice(0, 80))}</span>` : ''}
      <span class="dur">${dur(s.duration_ms)}</span></div>`).join('') || '<span class="hint">无步骤记录（早期运行）</span>'}
    </div>
    <h3>采集结果</h3><p>${srcLine || '<span class="hint">无</span>'}</p>
    ${(d.run_actions || []).length ? '<h3>触发记录</h3>' + d.run_actions.map((a) => `<div class="evt">${st(a.status)} ${esc(zh(ZH_ACTION, a.action))}（${a.trigger_source === 'viewer' ? '页面' : '命令行'}）${fmt(a.created_at)}</div>`).join('') : ''}
    <h3>失败的 AI 调用</h3>
    ${d.failed_model_runs.map((m) => `<div class="evt"><span class="lv error">错误</span>${esc(zh(ZH_TASK, m.task_type))}: ${esc(m.error)}</div>`).join('') || '<span class="hint">无</span>'}
    <h3>本次产出文章</h3>
    ${d.related_articles.map((a) => `<div class="evt">${st(a.status)} ${esc(a.title)}（质量 ${a.quality_score ?? '-'} 分）</div>`).join('') || '<span class="hint">无</span>'}
    <h3>最近事件</h3>
    ${d.workflow_events_latest.slice(0, 15).map((e) => `<div class="evt"><span class="lv ${esc(e.level)}">${e.level === 'error' ? '错误' : e.level === 'warning' ? '警告' : '信息'}</span>${fmt(e.created_at)} ${esc(e.message)}</div>`).join('')}
  `;
};

// ===== 采集源 =====
async function loadSources() {
  if (!latestRunId) {
    const d = await api('/api/engine-runs?limit=1');
    latestRunId = d.runs[0] ? d.runs[0].id : null;
  }
  if (!latestRunId) {
    $('#source-table').innerHTML = '<p class="hint">还没有运行记录</p>';
    return;
  }
  const status = $('#src-status').value;
  const group = $('#src-group').value.trim();
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (group) q.set('source_group', group);
  const d = await api(`/api/engine-runs/${latestRunId}/sources?` + q);
  $('#source-table').innerHTML = `<p class="hint">最近一次运行（${esc(latestRunId)}）的采集明细，共 ${d.sources.length} 条</p>
  <table><tr><th>来源</th><th>分组</th><th>类型</th><th>状态</th><th>HTTP</th><th>抓到</th><th>入库</th><th>耗时</th><th>错误 / 内容示例</th></tr>
  ${d.sources.map((s) => `<tr><td>${esc(s.source_name)}</td><td>${esc(s.source_group)}</td><td>${esc(s.source_type)}</td><td>${st(s.status)}</td><td>${s.http_status ?? '-'}</td><td>${s.items_found}</td><td>${s.items_inserted}</td><td>${dur(s.duration_ms)}</td>
  <td>${s.error_message ? `<span style="color:#d64545">${esc(s.error_message.slice(0, 60))}</span>` : esc((s.sample_titles || []).slice(0, 2).join(' / ').slice(0, 80))}</td></tr>`).join('')}</table>`;
}
$('#src-refresh').onclick = loadSources;

// ===== 报告 =====
async function loadReport() {
  const d = await api('/api/report/latest');
  if (!d.report) {
    $('#report-view').innerHTML = '<p class="hint">还没有报告。终端运行 npm run engine:report 生成。</p>';
    return;
  }
  $('#report-view').innerHTML = `<p class="hint">最新报告 · ${fmt(d.report.created_at, true)}（存于数据库 engine_reports 表）</p><pre class="markdown-body">${esc(d.report.markdown)}</pre>`;
}

setInterval(loadRunControl, 15000);
loadRunControl();
loadArticles();
