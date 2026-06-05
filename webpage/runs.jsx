/* ============================================================
   运行历史 — Run History & Run Detail（真实数据）
   ============================================================ */
function RunHistory({ nav, params }) {
  const [mode, setMode] = useState("all");
  const rows = FLY.RUNS.filter(r => mode === "all" || r.mode === mode);
  const trendMax = Math.max(2.5, ...FLY.TREND.map(d => Math.max(d.articles, d.review))) + 0.5;

  return (
    <div className="page fade-in">
      <div className="page-head">
        <h1 className="page-title">运行历史</h1>
        <p className="page-sub">查看每次流水线执行是否稳定、是否失败、是否被重建替代。</p>
      </div>

      {/* 7-day trend */}
      <Card style={{ marginBottom: 16 }}>
        <CardHead icon="trend" title="近 7 天产能" hint="生成文章 / 进入终审 / 当日运行结果" />
        <div style={{ padding: "20px 22px 14px", display: "flex", alignItems: "stretch", gap: 12 }}>
          {FLY.TREND.map((d, i) => {
            const rs = d.runStatus && FLY.runStatus(d.runStatus);
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ height: 132, width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 5 }}>
                  {[["articles", "var(--brand-500)", "生成"], ["review", "var(--ok-solid)", "终审"]].map(([k, color, label]) => (
                    <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 20 }}>
                      <span className="tnum" style={{ fontSize: 11, fontWeight: 800, color: d[k] ? "var(--ink-2)" : "var(--ink-4)", lineHeight: 1 }}>{d[k] || ""}</span>
                      <div style={{ width: 16, height: `${(d[k] / trendMax) * 104}px`, minHeight: d[k] ? 8 : 3, background: d[k] ? color : "var(--mut-bg)", borderRadius: "4px 4px 0 0" }} title={`${label} ${d[k]} 篇`} />
                    </div>
                  ))}
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{d.d}</span>
                {/* 当日运行结果标记：成功绿 / 部分成功黄 / 失败红 / 未运行灰 */}
                <span title={rs ? `当日运行：${rs.text}` : "当日未运行"}
                  style={{ width: 7, height: 7, borderRadius: "50%", background: rs ? `var(--${rs.tone}-solid)` : "var(--mut-bg)" }} />
              </div>
            );
          })}
          <div style={{ display: "flex", flexDirection: "column", gap: 7, paddingLeft: 14, borderLeft: "1px solid var(--line-soft)", alignSelf: "center" }}>
            <span style={{ fontSize: 11.5, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: "var(--brand-500)" }} />生成文章</span>
            <span style={{ fontSize: 11.5, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: "var(--ok-solid)" }} />进入终审</span>
            <span style={{ fontSize: 11.5, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok-solid)" }} />
              <i style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--warn-solid)", marginLeft: -2 }} />
              <i style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--bad-solid)", marginLeft: -2 }} />
              当日运行结果
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead icon="history" title="运行记录" hint={`共 ${FLY.RUNS.length} 次`}>
          <div className="seg" style={{ marginLeft: "auto" }}>
            {[["all", "全部"], ["start", "首次"], ["retry", "重试"], ["rebuild", "重建"]].map(([k, l]) => (
              <button key={k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>{l}</button>
            ))}
          </div>
        </CardHead>
        {rows.length === 0 ? (
          <Empty icon="history" title="暂无运行记录" desc="运行今日流水线后，记录会出现在这里。" />
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>日期 / run id</th><th style={{ width: 96 }}>状态</th><th style={{ width: 88 }}>模式</th>
              <th style={{ width: 76 }}>触发</th><th style={{ width: 90 }}>触发人</th><th style={{ width: 170 }}>产出</th>
              <th style={{ width: 96 }}>耗时</th><th style={{ width: 100 }}></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = FLY.runStatus(r.status);
                const superseded = r.status === "superseded";
                return (
                  <tr key={r.id} className="clickable" onClick={() => nav("runDetail", { id: r.id })} style={{ opacity: superseded ? .62 : 1 }}>
                    <td>
                      <span className="mono row-title" style={{ fontSize: 13 }}>{r.key}</span>
                      <span className="mono muted" style={{ fontSize: 11, marginLeft: 6 }}>{(r.started || "").slice(0, 5)}</span>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{r.id}{r.note ? ` · ${r.note}` : ""}</div>
                    </td>
                    <td><Badge tone={st.tone}>{st.text}</Badge></td>
                    <td><span className="chip" style={{ height: 22, fontSize: 11.5 }}>{FLY.MODE_META[r.mode] || r.mode}</span></td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{r.trigger}</td>
                    <td style={{ fontSize: 12.5 }}>{r.actor}</td>
                    <td className="muted" style={{ fontSize: 12 }}><span className="tnum">资讯 {r.topics} · 文章 {r.articles} · 渠道 {r.channels}</span></td>
                    <td className="mono muted" style={{ fontSize: 12 }}>{r.dur || "—"}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <Btn kind="ghost" size="sm" iconR="chevR" onClick={() => nav("runDetail", { id: r.id })}>详情</Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/* ---------- Run detail ---------- */
function RunDetail({ nav, params, toast, onAction }) {
  const [tab, setTab] = useState(params.tab || "steps");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true; // 防止快速切换时旧请求后到覆盖新页面
    setTab(params.tab || "steps");
    setData(null); setError(null);
    FLY.loadRun(params.id || FLY.DAILY)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [params.id, params.tab]);

  if (error) return (
    <div className="page fade-in">
      <button className="btn btn-soft btn-sm" style={{ marginBottom: 14 }} onClick={() => nav("runs")}><Icon name="arrowL" size={15} />返回运行历史</button>
      <Card><Empty icon="xCircle" title="运行记录加载失败" desc={String(error.message || error)} /></Card>
    </div>
  );
  if (!data) return (
    <div className="page fade-in">
      <Card><Empty icon="clock" title="正在加载运行详情…" desc="从数据库读取流水线步骤与采集日志。" /></Card>
    </div>
  );

  const { run, steps, sources, actions, failedModelRuns, transitions } = data;
  const isToday = run.key === FLY.DAILY && FLY.TODAY.run && FLY.TODAY.run.id === run.id;
  const canRetry = isToday && (run.status === "failed" || run.status === "partial");
  const TABS = [["steps", "流水线步骤", "layers"], ["sources", `采集源明细`, "rss"], ["actions", "操作记录", "user"]];

  return (
    <div className="page fade-in">
      <button className="btn btn-soft btn-sm" style={{ marginBottom: 14 }} onClick={() => nav("runs")}><Icon name="arrowL" size={15} />返回运行历史</button>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ padding: "18px 22px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 17, fontWeight: 700 }}>{run.key}</span>
              <Badge tone={FLY.runStatus(run.status).tone} lg>{FLY.runStatus(run.status).text}</Badge>
              <span className="chip" style={{ height: 24 }}>{FLY.MODE_META[run.mode] || run.mode}</span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{run.id}</span>
            </div>
            <div style={{ display: "flex", gap: 18, color: "var(--ink-2)", fontSize: 12.5, fontWeight: 600, flexWrap: "wrap" }}>
              <span>触发 <b style={{ color: "var(--ink)" }}>{run.trigger} · {run.actor}</b></span>
              <span>开始 <b className="mono" style={{ color: "var(--ink)" }}>{run.started}</b></span>
              <span>结束 <b className="mono" style={{ color: "var(--ink)" }}>{run.finished}</b></span>
              <span>耗时 <b style={{ color: "var(--ink)" }}>{run.dur || "—"}</b></span>
            </div>
          </div>
          {canRetry && <Btn kind="warn" icon="refresh" style={{ marginLeft: "auto" }} onClick={() => onAction && onAction("retry")}>重试失败步骤</Btn>}
        </div>
        {run.error && (
          <div style={{ margin: "0 22px 16px", display: "flex", gap: 9, padding: "11px 13px", background: "var(--bad-soft)", border: "1px solid var(--bad-line)", borderRadius: 9 }}>
            <Icon name="alert" size={16} style={{ color: "var(--bad)", flex: "0 0 auto", marginTop: 1 }} />
            <div style={{ fontSize: 12.5, color: "var(--bad)", lineHeight: 1.5 }}><b>失败原因</b> · {run.error}</div>
          </div>
        )}
      </Card>

      <Card>
        <div style={{ padding: "0 8px" }}><div className="tabs">
          {TABS.map(([k, l, ic]) => <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}><Icon name={ic} size={15} />{l}</button>)}
        </div></div>
        <div style={{ padding: "20px 22px" }}>
          {tab === "steps" && <><RunSteps steps={steps} nav={nav} /><FailedModelRuns runs={failedModelRuns} /></>}
          {tab === "sources" && <SourceLogs sources={sources} classification={data.sourceClassification} />}
          {tab === "actions" && <><ActionLog actions={actions} /><RunTransitions transitions={transitions} nav={nav} /></>}
        </div>
      </Card>
    </div>
  );
}

function RunSteps({ steps, nav }) {
  const synthetic = steps.some(s => s.synthetic);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {synthetic && (
        <div style={{ display: "flex", gap: 9, padding: "10px 13px", background: "var(--mut-soft)", border: "1px solid var(--line)", borderRadius: 9, fontSize: 12.5, color: "var(--ink-2)" }}>
          <Icon name="dot" size={15} style={{ color: "var(--ink-3)", flex: "0 0 auto", marginTop: 1 }} />
          本次运行未记录步骤级日志，以下状态由运行统计推断。
        </div>
      )}
      {steps.map((s) => {
        const tone = STEP_TONE[s.status];
        return (
          <div key={s.key} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, background: s.status === "failed" ? "var(--bad-soft)" : "var(--surface)" }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-4)", fontWeight: 700, width: 22 }}>0{s.n}</span>
            <span style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flex: "0 0 auto", background: `var(--${tone}-bg)`, color: `var(--${tone})` }}>
              {s.status === "success" || s.status === "warning" ? <Icon name="check" size={16} /> : s.status === "failed" ? <Icon name="x" size={16} /> : s.status === "skipped" ? <Icon name="dot" size={16} /> : <Icon name={s.icon} size={15} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{s.title}</span>
                <Badge tone={tone} dot={false}>{STEP_LABEL[s.status]}</Badge>
              </div>
              <div style={{ fontSize: 12.5, color: s.error ? "var(--bad)" : "var(--ink-2)", marginTop: 3 }}>{s.error || s.reason || s.summary}</div>
              {s.warnings && s.warnings.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 3, lineHeight: 1.5 }}>{s.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
              )}
            </div>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)", flex: "0 0 auto" }}>{fmtDur(s.dur)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* 采集内容分类统计条 */
function SourceClassificationStats({ classification }) {
  if (!classification) return null;
  const cts = Object.entries(classification.byContentType || {}).sort((a, b) => b[1] - a[1]);
  const bcs = Object.entries(classification.byBusinessCategory || {}).sort((a, b) => b[1] - a[1]);
  if (!cts.length && !bcs.length && !classification.unclassified) return null;
  return (
    <div style={{ marginBottom: 14, padding: "11px 14px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-2)" }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>本次采集内容分类</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {cts.map(([k, c]) => <span key={k} className="chip" style={{ height: 22, fontSize: 11.5 }}>{FLY.taxLabel("contentTypes", k)} <b className="tnum">{c}</b></span>)}
        {bcs.length > 0 && <span style={{ width: 1, height: 16, background: "var(--line)", margin: "0 4px" }} />}
        {bcs.slice(0, 8).map(([k, c]) => <span key={k} className="chip" style={{ height: 22, fontSize: 11.5, background: "var(--brand-50)", borderColor: "var(--brand-200)", color: "var(--brand-700)" }}>{FLY.taxLabel("businessCategories", k)} <b className="tnum">{c}</b></span>)}
        {classification.unclassified > 0 && <span className="chip" style={{ height: 22, fontSize: 11.5, color: "var(--ink-4)" }}>未分类 {classification.unclassified}</span>}
      </div>
    </div>
  );
}

function SourceLogs({ sources, classification }) {
  const [status, setStatus] = useState("all");
  const [group, setGroup] = useState("all");
  if (!sources || sources.length === 0) {
    return (
      <div>
        <SourceClassificationStats classification={classification} />
        <Empty icon="rss" title="本次运行没有采集源日志" desc="较早的运行没有记录采集明细，或该运行未执行采集步骤。" />
      </div>
    );
  }
  const groups = ["all", ...Array.from(new Set(sources.map(s => s.group)))];
  const SS = { success: ["成功", "ok"], partial: ["部分成功", "warn"], failed: ["失败", "bad"], skipped: ["跳过", "mut"] };
  const rows = sources.filter(s => (status === "all" || s.status === status) && (group === "all" || s.group === group));
  const failCount = sources.filter(s => s.status === "failed").length;
  const chronicCount = sources.filter(s => s.chronicFail).length;

  return (
    <div>
      <SourceClassificationStats classification={classification} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        {failCount > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "var(--bad-soft)", border: "1px solid var(--bad-line)", borderRadius: 9, fontSize: 12.5, color: "var(--bad)", fontWeight: 600 }}>
            <Icon name="alert" size={15} />{failCount} 个源采集失败{chronicCount > 0 ? `，其中 ${chronicCount} 个多次失败` : ""}
          </div>
        )}
        <select className="inp btn-sm" style={{ width: "auto", height: 32, marginLeft: "auto" }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">全部状态</option><option value="success">成功</option><option value="partial">部分成功</option><option value="failed">失败</option><option value="skipped">跳过</option>
        </select>
        <select className="inp btn-sm" style={{ width: "auto", height: 32 }} value={group} onChange={e => setGroup(e.target.value)}>
          {groups.map(g => <option key={g} value={g}>{g === "all" ? "全部分组" : g}</option>)}
        </select>
      </div>
      <table className="tbl">
        <thead><tr>
          <th>源名称</th><th style={{ width: 130 }}>分组</th><th style={{ width: 90 }}>类型</th>
          <th style={{ width: 88 }}>状态</th><th style={{ width: 56 }}>HTTP</th><th style={{ width: 76 }}>抓取/入库</th>
          <th style={{ width: 60 }}>耗时</th><th>失败原因 / 示例标题</th>
        </tr></thead>
        <tbody>
          {rows.map((s, i) => {
            const ss = SS[s.status] || [s.status, "mut"];
            return (
              <tr key={i}>
                <td className="row-title">
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>{s.name}{s.chronicFail && <span className="badge bg-bad" style={{ height: 18, fontSize: 10.5 }}>持续失败</span>}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 500, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.url}</div>
                </td>
                <td className="muted mono" style={{ fontSize: 11 }}>{s.group}</td>
                <td className="muted mono" style={{ fontSize: 11 }}>{s.type}</td>
                <td><Badge tone={ss[1]} dot={false}>{ss[0]}</Badge></td>
                <td className="mono tnum" style={{ fontSize: 12, color: s.http >= 400 ? "var(--bad)" : s.http ? "var(--ink-2)" : "var(--ink-4)" }}>{s.http || "—"}</td>
                <td className="mono tnum" style={{ fontSize: 12 }}>{s.found}/{s.inserted}</td>
                <td className="mono tnum muted" style={{ fontSize: 11.5 }}>{s.dur ? (s.dur / 1000).toFixed(1) + "s" : "—"}</td>
                <td style={{ fontSize: 12, color: s.error ? "var(--bad)" : "var(--ink-3)", maxWidth: 280 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.error || s.samples[0] || ""}>{s.error || (s.samples[0] ? "例：" + s.samples[0] : "—")}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* 失败模型调用摘要（步骤 Tab 下方） */
function FailedModelRuns({ runs }) {
  if (!runs || runs.length === 0) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10, display: "flex", alignItems: "center", gap: 7 }}>
        <Icon name="code" size={15} style={{ color: "var(--bad)" }} />失败模型调用（{runs.length}）
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {runs.map((m, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 13px", background: "var(--bad-soft)", border: "1px solid var(--bad-line)", borderRadius: 9 }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--bad)", flex: "0 0 auto" }}>{FLY.ZH_TASK[m.task] || m.task}</span>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5, flex: 1 }}>{m.error}</span>
            <span className="mono muted" style={{ fontSize: 11, flex: "0 0 auto" }}>{m.model}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* 状态变更记录（操作记录 Tab 下方） */
function RunTransitions({ transitions, nav }) {
  if (!transitions || transitions.length === 0) return null;
  const ENTITY_ZH = { article: "文章", article_version: "文章版本", topic_candidate: "候选选题", engine_run: "引擎运行", channel_output: "渠道稿" };
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10, display: "flex", alignItems: "center", gap: 7 }}>
        <Icon name="history" size={15} style={{ color: "var(--ink-3)" }} />状态变更记录（{transitions.length}）
      </div>
      <table className="tbl">
        <thead><tr><th style={{ width: 130 }}>时间</th><th style={{ width: 90 }}>对象</th><th style={{ width: 200 }}>状态流转</th><th>原因</th></tr></thead>
        <tbody>
          {transitions.map((t, i) => {
            const to = FLY.artStatus(t.to);
            return (
              <tr key={i} className={t.entity === "article" ? "clickable" : ""} onClick={() => t.entity === "article" && nav("detail", { id: t.entityId })}>
                <td className="mono muted" style={{ fontSize: 12 }}>{t.t}</td>
                <td style={{ fontSize: 12.5 }}>{ENTITY_ZH[t.entity] || t.entity}</td>
                <td style={{ fontSize: 12.5 }}>
                  {t.from !== "—" && <span className="muted">{FLY.artStatus(t.from).text} <Icon name="chevR" size={11} style={{ verticalAlign: "middle" }} /> </span>}
                  <b style={{ color: `var(--${to.tone})` }}>{to.text}</b>
                </td>
                <td className="muted" style={{ fontSize: 12.5, maxWidth: 320 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.reason}>{t.reason || "—"}</div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActionLog({ actions }) {
  if (!actions || actions.length === 0) {
    return <Empty icon="user" title="暂无操作记录" desc="启动 / 重试 / 重建等操作会记录在这里。" />;
  }
  const TONE = { accepted: "info", running: "info", success: "ok", rejected: "bad", failed: "bad" };
  const ZH_ST = { accepted: "已受理", running: "运行中", success: "成功", rejected: "被拒绝", failed: "失败" };
  return (
    <table className="tbl">
      <thead><tr><th style={{ width: 130 }}>时间</th><th style={{ width: 90 }}>操作人</th><th style={{ width: 130 }}>动作</th><th style={{ width: 84 }}>结果</th><th>说明</th></tr></thead>
      <tbody>
        {actions.map((a, i) => (
          <tr key={i}>
            <td className="mono muted" style={{ fontSize: 12 }}>{a.t}</td>
            <td style={{ fontSize: 13, fontWeight: 600 }}>{a.actor}</td>
            <td><Badge tone={TONE[a.status] || "mut"} dot={false}>{FLY.ZH_ACTION[a.action] || a.action}</Badge></td>
            <td style={{ fontSize: 12.5, color: a.status === "rejected" || a.status === "failed" ? "var(--bad)" : "var(--ink-2)", fontWeight: 600 }}>{ZH_ST[a.status] || a.status}</td>
            <td className="muted" style={{ fontSize: 12.5 }}>{a.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

Object.assign(window, { RunHistory, RunDetail });
