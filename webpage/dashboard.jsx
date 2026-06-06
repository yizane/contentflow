/* ============================================================
   Today Dashboard — 今日看板（真实数据：FLY.TODAY）
   ============================================================ */
function StatusBar({ state, onAction }) {
  const t = FLY.TODAY;
  const run = t.run;
  const running = state === "running";
  const stateMeta = {
    not_started: { label: "未开始", color: "mut" },
    running: { label: "运行中", color: "info" },
    success: { label: "成功", color: "ok" },
    partial: { label: "部分成功", color: "warn" },
    failed: { label: "失败", color: "bad" },
  }[state] || { label: state, color: "mut" };

  const primary = (() => {
    if (state === "not_started") return { key: "run", kind: "pri", icon: "play", label: "跑今天" };
    if (state === "running") return { key: "running", kind: "soft", icon: "clock", label: "运行中…", disabled: true };
    if (state === "failed" || state === "partial") return { key: "retry", kind: "warn", icon: "refresh", label: "重试失败" };
    return { key: "done", kind: "soft", icon: "check", label: "今天已运行", disabled: true };
  })();

  const summary = [
    ["资讯", t.meta.items, "条"], ["候选选题", t.meta.topics, "个"],
    ["生成文章", t.meta.articles, "篇"], ["待终审", t.meta.review, "篇"],
  ];

  return (
    <Card className="fade-in" style={{ overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 18, padding: "20px 22px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9, whiteSpace: "nowrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-3)" }}>今日</span>
            <span className="mono" style={{ fontSize: 15, fontWeight: 700, letterSpacing: ".02em" }}>{FLY.DAILY}</span>
            <Badge tone={stateMeta.color} lg>
              {running && <span className="spin" style={{ display: "flex" }}><Icon name="refresh" size={12} /></span>}
              {stateMeta.label}
            </Badge>
          </div>
          <div style={{ display: "flex", gap: 22, color: "var(--ink-2)", fontSize: 12.5, fontWeight: 600, flexWrap: "wrap" }}>
            <span style={{ whiteSpace: "nowrap" }}>开始 <b className="mono" style={{ color: "var(--ink)" }}>{(run && run.startedHM) || "—"}</b></span>
            <span style={{ whiteSpace: "nowrap" }}>结束 <b className="mono" style={{ color: "var(--ink)" }}>{(run && run.finishedHM) || "—"}</b></span>
            <span style={{ whiteSpace: "nowrap" }}>耗时 <b style={{ color: "var(--ink)" }}>{running ? "进行中" : run && run.durMs ? fmtDur(run.durMs) : "—"}</b></span>
            {run && <span style={{ whiteSpace: "nowrap" }}>run <b className="mono" style={{ color: "var(--ink-3)", fontWeight: 500 }}>{run.id}</b></span>}
          </div>
        </div>

        <div style={{ display: "flex", gap: 9, alignItems: "center", flex: "0 0 auto" }}>
          {(state === "success" || state === "partial" || state === "failed") && (
            <Btn kind="ghost" icon="rebuild" onClick={() => onAction("rebuild")}>重建今天</Btn>
          )}
          <Btn kind={primary.kind} icon={primary.icon} disabled={primary.disabled}
            onClick={() => !primary.disabled && onAction(primary.key)} size="lg"
            title={primary.disabled && state !== "running" ? FLY.TODAY.message : undefined}>
            {primary.label}
          </Btn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", borderTop: "1px solid var(--line-soft)" }}>
        {summary.map(([label, val, unit], i) => (
          <div key={label} className="stat" style={{ padding: "15px 22px", borderLeft: i ? "1px solid var(--line-soft)" : "none" }}>
            <div className="label">{label}</div>
            <div className="val tnum">{val ?? 0}<span className="u">{unit}</span></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- 待我处理 / 系统处理中 ---------- */
function TodoCell({ it, i, spin }) {
  return (
    <button onClick={it.go}
      style={{ textAlign: "left", border: "none", background: "transparent", padding: "16px 18px", cursor: "pointer", borderLeft: i ? "1px solid var(--line-soft)" : "none", borderTop: "none", transition: "background .12s" }}
      onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: "grid", placeItems: "center", background: `var(--${it.tone}-bg)`, color: `var(--${it.tone})`, flex: "0 0 auto" }} className={spin ? "pulse" : ""}><Icon name={it.icon} size={17} /></span>
        <Icon name="chevR" size={15} style={{ marginLeft: "auto", color: "var(--ink-4)" }} />
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, letterSpacing: "-.02em", color: `var(--${it.tone})` }} className="tnum">{it.n}</div>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 7 }}>{it.label}</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.hint}</div>
    </button>
  );
}

function TodoBoard({ state, nav }) {
  const c = FLY.COUNTS;
  const runId = FLY.TODAY.run && FLY.TODAY.run.id;
  const failedSteps = (FLY.TODAY.steps || []).filter(s => s.status === "failed");

  // 需要人工动手的事项
  const mine = [
    { icon: "flag", tone: "warn", n: c.readyForReview, label: "待终审文章", hint: "需要人工通过或打回", go: () => nav("library", { filter: "ready_for_review" }), show: c.readyForReview > 0 },
    { icon: "user", tone: "warn", n: c.needsHumanSources, label: "需人工补来源", hint: "多轮自动补源未补齐，需人工判断", go: () => nav("library", { filter: "needs_fact_sources", sub: "human" }), show: c.needsHumanSources > 0 },
  ];
  if (state === "failed") mine.push({ icon: "xCircle", tone: "bad", n: failedSteps.length || 1, label: "运行失败", hint: failedSteps[0] ? failedSteps[0].title + "失败" : "查看运行详情", go: () => nav("runDetail", { id: runId }), show: !!runId });
  if (state === "partial") mine.push({ icon: "alert", tone: "bad", n: failedSteps.length || 1, label: "部分步骤失败", hint: failedSteps.map(s => s.title).join("、") || "查看运行详情", go: () => nav("runDetail", { id: runId }), show: !!runId });
  if (FLY.CHRONIC.length > 0) mine.push({ icon: "rss", tone: "warn", n: FLY.CHRONIC.length, label: "采集源持续失败", hint: FLY.CHRONIC.slice(0, 2).join("、") + (FLY.CHRONIC.length > 2 ? " 等" : ""), go: () => runId ? nav("runDetail", { id: runId, tab: "sources" }) : nav("config"), show: true });
  const mineItems = mine.filter(x => x.show);

  // 系统自动处理中的事项（无需人工干预，仅告知）
  const sys = [
    { icon: "refresh", tone: "info", n: c.autoResolving, label: "自动补源中", hint: "系统正在为表述补权威来源", go: () => nav("library", { filter: "needs_fact_sources", sub: "auto" }), show: c.autoResolving > 0 },
  ];
  if (state === "running" && c.runningStepKey) {
    const step = FLY.STEP_DEFS.find(d => d.key === c.runningStepKey);
    if (step) sys.push({ icon: step.icon, tone: "info", n: 1, label: `${step.title}进行中`, hint: "今日流水线正在执行", go: () => nav("runDetail", { id: runId }), show: !!runId });
  }
  const sysItems = sys.filter(x => x.show);

  if (mineItems.length === 0 && sysItems.length === 0) {
    return (
      <Card>
        <CardHead icon="inbox" title="待我处理" />
        <Empty icon="checkCircle" title="今天还没有需要处理的事项"
          desc={state === "not_started" ? "今天还没有运行流水线，点击右上角「跑今天」开始生产。" : "所有文章都已处理完毕，干得漂亮。"} />
      </Card>
    );
  }

  return (
    <Card>
      <CardHead icon="inbox" title="待我处理">
        <span className="hint">{mineItems.length > 0 ? `共 ${mineItems.length} 类需要你动手` : "暂无需要人工处理的事项"}</span>
      </CardHead>
      {mineItems.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(mineItems.length, 4)}, 1fr)`, gap: 0 }}>
          {mineItems.map((it, i) => <TodoCell key={i} it={it} i={i} />)}
        </div>
      ) : (
        <div style={{ padding: "14px 18px", fontSize: 13, color: "var(--ink-3)" }}>没有需要人工介入的事项。</div>
      )}
      {sysItems.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 18px 0", borderTop: "1px solid var(--line-soft)" }}>
            <span className="spin" style={{ display: "flex", color: "var(--info)" }}><Icon name="refresh" size={13} /></span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em" }}>系统处理中 · 无需人工干预</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(sysItems.length, 4)}, 1fr)`, gap: 0 }}>
            {sysItems.map((it, i) => <TodoCell key={i} it={it} i={i} spin />)}
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------- 最近文章 ---------- */
function RecentArticles({ state, nav }) {
  const todayArts = FLY.ARTICLES.filter(a => (a.created || "").startsWith(FLY.DAILY));
  const arts = (todayArts.length ? todayArts : FLY.ARTICLES).slice(0, 5);
  if (arts.length === 0) {
    return (
      <Card>
        <CardHead icon="docs" title="最近文章" />
        <Empty icon="docs" title="还没有生成文章"
          desc={state === "failed" ? "生成文章步骤失败，请先重试失败步骤。" : "运行今日流水线后，生成的文章会出现在这里。"} />
      </Card>
    );
  }
  return (
    <Card>
      <CardHead icon="docs" title={todayArts.length ? "今日文章" : "最近文章"}>
        <button className="hint link" style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => nav("library")}>查看全部 →</button>
      </CardHead>
      <table className="tbl">
        <thead><tr><th>标题</th><th style={{ width: 96 }}>状态</th><th style={{ width: 72 }}>质量分</th><th style={{ width: 110 }}>SEO/GEO</th><th style={{ width: 96 }}>事实核查</th><th style={{ width: 130 }}></th></tr></thead>
        <tbody>
          {arts.map(a => {
            const st = FLY.artStatus(a.status);
            return (
              <tr key={a.id} className="clickable" onClick={() => nav("detail", { id: a.id })}>
                <td className="row-title" style={{ maxWidth: 360 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</div></td>
                <td><Badge tone={st.tone}>{st.text}</Badge></td>
                <td><Score value={a.quality} /></td>
                <td>{a.seo ? <span className="tnum" style={{ fontWeight: 700, fontSize: 13 }}><span style={{ color: scoreColor(a.seo) }}>{a.seo}</span><span style={{ color: "var(--ink-4)" }}> / </span><span style={{ color: scoreColor(a.geo) }}>{a.geo}</span></span> : <span style={{ color: "var(--ink-4)" }}>—</span>}</td>
                <td><Badge tone={a.fact === "publish" ? "ok" : a.fact === "needs" ? "warn" : a.fact === "failed" ? "bad" : "mut"} dot={false}>{a.factText}</Badge></td>
                <td onClick={e => e.stopPropagation()}>
                  {a.status === "ready_for_review"
                    ? <Btn kind="pri" size="sm" onClick={() => nav("detail", { id: a.id })}>终审</Btn>
                    : <Btn kind="ghost" size="sm" icon="eye" onClick={() => nav("detail", { id: a.id })}>查看</Btn>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Dashboard({ state, nav, onAction }) {
  const [days, setDays] = useState([]);
  const [day, setDay] = useState(FLY.DAILY);
  useEffect(() => {
    let alive = true;
    FLY.loadDays(7).then((d) => { if (alive) setDays(d); }).catch(() => {});
    return () => { alive = false; };
  }, [FLY.DAILY]);

  const isToday = day === FLY.DAILY;

  return (
    <div className="page fade-in">
      <div className="page-head" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <h1 className="page-title">生产日报</h1>
          <p className="page-sub">{isToday ? "从最终产出往回看：先看拍板了什么，再逐级回溯找问题。" : `回放 ${day}：最上面是当日最终产出，向下逐级回溯到采集（只读）。`}</p>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {days.length > 0 && <DayStrip days={days} value={day} onChange={setDay} />}
        {isToday ? (
          <>
            <StatusBar state={state} onAction={onAction} />
            <TodoBoard state={state} nav={nav} />
            <DayReport date={day} nav={nav} />
          </>
        ) : (
          <DayReport date={day} nav={nav} />
        )}
      </div>
    </div>
  );
}

Object.assign(window, { Dashboard });
