// Flyfus Trace Console — 本地只读 Viewer 前端（vanilla JS）
const $ = (s) => document.querySelector(s);
const api = (p) => fetch(p).then((r) => r.json());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const st = (s) => `<span class="status ${esc(s)}">${esc(s)}</span>`;
const dur = (ms) => (ms == null ? '-' : ms > 60000 ? (ms / 60000).toFixed(1) + 'm' : (ms / 1000).toFixed(1) + 's');

let latestRunId = null;

// ---------- tabs ----------
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

// ---------- Articles ----------
async function loadArticles() {
  const d = await api('/api/articles?limit=50');
  $('#article-list').innerHTML = d.articles.map((a) => `
    <div class="item" onclick="showArticle('${a.id}', this)">
      <div class="t">${esc(a.title)}</div>
      <div class="m">${st(a.status)} 质量 ${a.quality_score ?? '-'} · SEO ${a.seo_score ?? '-'} · GEO ${a.geo_score ?? '-'}</div>
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
    <p>${st(a.status)} slug: <code>${esc(a.slug)}</code> · 主关键词: ${esc(a.primary_keyword)}</p>
    <p class="m">质量 ${a.quality_score ?? '-'} · SEO ${a.seo_score ?? '-'} · GEO ${a.geo_score ?? '-'} · 核查 ${esc(a.fact_publish_readiness ?? '-')}</p>
    <h3>渠道版本</h3>
    ${d.channels.length ? d.channels.map((c) => `${st(c.status)} ${esc(c.channel)}（${c.len} 字符）`).join('　') : '<span class="hint">无</span>'}
    <h3>Trace：状态流转</h3>
    ${t.status_transitions.map((x) => `<div class="evt">${esc(x.created_at)} 〔${esc(x.entity_type)}〕 ${esc(x.from_status ?? '∅')} → <b>${esc(x.to_status)}</b> <span class="hint">${esc(x.reason ?? '')}（${esc(x.actor)}）</span></div>`).join('') || '<span class="hint">无记录</span>'}
    <h3>Trace：模型调用（摘要，默认不展示 prompt/raw_response 全文）</h3>
    <table><tr><th>任务</th><th>状态</th><th>prompt 字符</th><th>response 字符</th><th>错误</th></tr>
    ${t.model_runs_summary.map((m) => `<tr><td>${esc(m.task_type)}</td><td>${st(m.status)}</td><td>${m.prompt_chars ?? '-'}</td><td>${m.response_chars ?? '-'}</td><td>${esc(m.error_message ?? '')}</td></tr>`).join('')}</table>
    <h3>Trace：事实核查历史</h3>
    ${t.fact_checks_history.map((f) => `<div class="evt">${esc(f.created_at)} ${st(f.publish_readiness)} claims ${f.claims_count} / high ${f.high_risk_count} / mustFix ${f.must_fix_count}</div>`).join('') || '<span class="hint">无</span>'}
    <h3>Trace：来源补全汇总</h3>
    ${t.source_resolutions_summary.map((r) => `${st(r.resolved_status)} ×${r.c}`).join('　') || '<span class="hint">无</span>'}
    <h3>Trace：相关事件</h3>
    ${t.workflow_events.slice(-20).map((e) => `<div class="evt"><span class="lv ${esc(e.level)}">${esc(e.level)}</span>${esc(e.created_at)} ${esc(e.message)}</div>`).join('') || '<span class="hint">无</span>'}
    <details><summary>⚠ 查看正文（内部数据，默认折叠）</summary><pre class="markdown-body">${esc(v ? v.markdown : '')}</pre></details>
  `;
};

// ---------- Engine Runs ----------
async function loadRuns() {
  const d = await api('/api/engine-runs?limit=15');
  if (d.runs[0]) latestRunId = d.runs[0].id;
  $('#run-list').innerHTML = d.runs.map((r) => `
    <div class="item" onclick="showRun('${r.id}', this)">
      <div class="t">${esc(r.id)} ${r.is_active ? '' : '<span class="status skipped">superseded</span>'}</div>
      <div class="m">${st(r.status)} ${esc(r.run_scope)}/${esc(r.run_mode)} ${r.daily_key ? '· ' + esc(r.daily_key) : ''} · via ${esc(r.trigger_source ?? 'cli')} · 文章 ${r.articles_validated} · ${dur(r.duration_ms)}</div>
    </div>`).join('');
}

window.showRun = async (id, el) => {
  document.querySelectorAll('#run-list .item').forEach((x) => x.classList.remove('sel'));
  if (el) el.classList.add('sel');
  const d = await api('/api/engine-runs/' + id);
  const srcLine = d.source_collection_summary.map((s) => `${st(s.status)} ×${s.c}（found ${s.found ?? 0} / inserted ${s.inserted ?? 0}）`).join('　');
  $('#run-detail').innerHTML = `
    <h2>${esc(id)} ${st(d.engine_run.status)} ${d.engine_run.superseded_by ? `<span class="hint">superseded by ${esc(d.engine_run.superseded_by)}</span>` : ''}</h2>
    ${(d.run_actions || []).length ? '<h3>Run Actions</h3>' + d.run_actions.map((a) => `<div class="evt">${st(a.status)} ${esc(a.action)}（${esc(a.actor)}/${esc(a.trigger_source)}）${esc(a.created_at)}${a.error_message ? ' — ' + esc(a.error_message) : ''}</div>`).join('') : ''}
    ${(d.status_transitions || []).length ? '<h3>状态流转</h3>' + d.status_transitions.map((t) => `<div class="evt">〔${esc(t.entity_type)}〕${esc(t.from_status ?? '∅')} → <b>${esc(t.to_status)}</b> <span class="hint">${esc(t.reason ?? '')}</span></div>`).join('') : ''}
    <h3>步骤时间线</h3>
    <div class="timeline">
    ${d.workflow_steps.map((s) => `<div class="step">${st(s.status)} <b>${esc(s.step_name)}</b>
      ${s.warnings && s.warnings.length ? `<span class="hint">⚠ ${s.warnings.length} warnings</span>` : ''}
      ${s.error_message ? `<span class="hint" style="color:#d64545">${esc(s.error_message.slice(0, 80))}</span>` : ''}
      <span class="dur">${dur(s.duration_ms)}</span></div>`).join('') || '<span class="hint">无步骤记录（早期 run）</span>'}
    </div>
    <h3>采集总览</h3><p>${srcLine || '<span class="hint">无</span>'}</p>
    <h3>失败的模型调用</h3>
    ${d.failed_model_runs.map((m) => `<div class="evt"><span class="lv error">error</span>${esc(m.task_type)}: ${esc(m.error)}</div>`).join('') || '<span class="hint">无</span>'}
    <h3>相关文章</h3>
    ${d.related_articles.map((a) => `<div class="evt">${st(a.status)} ${esc(a.title)}（质量 ${a.quality_score ?? '-'}）</div>`).join('') || '<span class="hint">无</span>'}
    <h3>最新事件</h3>
    ${d.workflow_events_latest.map((e) => `<div class="evt"><span class="lv ${esc(e.level)}">${esc(e.level)}</span>${esc(e.created_at)} ${esc(e.message)}</div>`).join('')}
  `;
};

// ---------- Sources ----------
async function loadSources() {
  if (!latestRunId) {
    const d = await api('/api/engine-runs?limit=1');
    latestRunId = d.runs[0] ? d.runs[0].id : null;
  }
  if (!latestRunId) {
    $('#source-table').innerHTML = '<p class="hint">还没有 engine run</p>';
    return;
  }
  const status = $('#src-status').value;
  const group = $('#src-group').value.trim();
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (group) q.set('source_group', group);
  const d = await api(`/api/engine-runs/${latestRunId}/sources?` + q);
  $('#source-table').innerHTML = `<p class="hint">run: ${esc(latestRunId)}（${d.sources.length} 条）</p>
  <table><tr><th>source</th><th>group</th><th>type</th><th>状态</th><th>HTTP</th><th>found</th><th>inserted</th><th>耗时</th><th>错误/样例</th></tr>
  ${d.sources.map((s) => `<tr><td>${esc(s.source_name)}</td><td>${esc(s.source_group)}</td><td>${esc(s.source_type)}</td><td>${st(s.status)}</td><td>${s.http_status ?? '-'}</td><td>${s.items_found}</td><td>${s.items_inserted}</td><td>${dur(s.duration_ms)}</td>
  <td>${s.error_message ? `<span style="color:#d64545">${esc(s.error_message.slice(0, 60))}</span>` : esc((s.sample_titles || []).slice(0, 2).join(' / ').slice(0, 80))}</td></tr>`).join('')}</table>`;
}
$('#src-refresh').onclick = loadSources;

// ---------- Reports ----------
async function loadReport() {
  const d = await api('/api/report/latest');
  if (!d.report) {
    $('#report-view').innerHTML = '<p class="hint">还没有 engine report</p>';
    return;
  }
  $('#report-view').innerHTML = `<p class="hint">report ${esc(d.report.id)} · ${esc(d.report.created_at)}（来自 MySQL engine_reports）</p><pre class="markdown-body">${esc(d.report.markdown)}</pre>`;
}

// ---------- Run Control ----------
async function loadRunControl() {
  const d = await api('/api/run-control/today');
  const r = d.run;
  $('#rc-status').innerHTML = r
    ? `<b>Today (${esc(d.dailyKey)})</b>　${st(r.status)} ${r.isActive ? '<span class="status running">active</span>' : '<span class="status skipped">superseded</span>'}
       mode:${esc(r.runMode)} · 采集 ${r.topicsCollected} · 文章 ${r.articlesGenerated} · 待终审 ${r.readyForReview}
       <br><span class="hint">${esc(r.startedAt ?? '')} → ${esc(r.finishedAt ?? '进行中')}　${esc(d.message)}</span>`
    : `<b>Today (${esc(d.dailyKey)})</b>　<span class="hint">今天还没有 daily run。${esc(d.message)}</span>`;
  $('#rc-run').disabled = !d.availableActions.start;
  $('#rc-retry').disabled = !d.availableActions.retry;
  $('#rc-rebuild').disabled = !d.availableActions.rebuild;
  const acts = await api('/api/run-actions?limit=5');
  $('#rc-actions').innerHTML = acts.actions.map((a) => `<span class="evt">${st(a.status)} ${esc(a.action)} <span class="hint">${esc(a.created_at)}${a.error_message ? ' — ' + esc(a.error_message.slice(0, 50)) : ''}</span></span>`).join('');
}

async function rcPost(mode, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  const r = await fetch('/api/run-control/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, actor: 'local-viewer' }) }).then((x) => x.json());
  alert(r.ok ? r.message : `已拒绝：${r.reason || r.error}`);
  loadRunControl();
}
$('#rc-run').onclick = () => rcPost('start');
$('#rc-retry').onclick = () => rcPost('retry');
$('#rc-rebuild').onclick = () => rcPost('rebuild', 'Rebuild 会归档今天的旧 run 数据（不物理删除）并完整重跑。确定？');
$('#rc-report').onclick = async () => {
  alert('请在终端运行 npm run engine:report（Viewer 保持只读查询 + run 触发两类操作）');
};
setInterval(loadRunControl, 15000);
loadRunControl();
loadArticles();
