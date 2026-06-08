/* ============================================================
   生产日报 — 日期胶囊条 + 正序流水线（采集→…→拍板）+ 大事记（默认折叠）
   数据：GET /api/ui/days（胶囊条）+ GET /api/ui/day/:date（单日全景，含 7 步执行状态）
   ============================================================ */

/* ---------- 日期胶囊条：最新在左，只看 7 天 ---------- */
function DayStrip({ days, value, onChange }) {
  const list = [...days].reverse(); // 后端旧→新，这里翻成 新→旧（今天最左）
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "stretch", overflowX: "auto", paddingBottom: 2 }}>
      {list.map((d) => {
        const active = d.date === value;
        const isToday = d.date === FLY.DAILY;
        const rs = d.runStatus && FLY.runStatus(d.runStatus);
        const hasData = d.sources + d.topics + d.articles > 0;
        return (
          <button key={d.date} onClick={() => onChange(d.date)}
            style={{
              flex: "0 0 auto", minWidth: 76, textAlign: "left", padding: "8px 11px", borderRadius: 11,
              border: active ? "1.5px solid var(--brand-500)" : "1px solid var(--line)",
              background: active ? "var(--brand-50)" : hasData ? "var(--surface)" : "var(--mut-soft)",
              boxShadow: active ? "0 0 0 3px var(--brand-50)" : "none",
              opacity: hasData || isToday ? 1 : .55, transition: "all .12s", cursor: "pointer",
            }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: rs ? `var(--${rs.tone}-solid)` : "var(--mut-line)" }}
                title={rs ? `日更运行：${rs.text}` : "当日无日更运行"} />
              <span className="mono" style={{ fontSize: 12, fontWeight: 800, color: active ? "var(--brand-700)" : "var(--ink)" }}>
                {isToday ? "今天" : d.date.slice(5).replace("-", "/")}
              </span>
            </div>
            <div className="tnum" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 3, whiteSpace: "nowrap" }}>
              {hasData ? `${d.articles}文 ${d.topics}题 ${d.sources}源` : "无数据"}
            </div>
          </button>
        );
      })}
    </div>
  );
}

const VERDICT_META = {
  ready_for_review: { text: "进入待终审", tone: "ok", icon: "flag" },
  needs_quality_revision: { text: "被质量门禁拦下", tone: "bad", icon: "xCircle" },
  approved_for_publish: { text: "批准发布", tone: "ok", icon: "checkCircle" },
  published: { text: "已发布", tone: "ok", icon: "checkCircle" },
  rejected: { text: "被打回", tone: "bad", icon: "xCircle" },
  fact_check_failed: { text: "核查未过", tone: "bad", icon: "xCircle" },
};

/* ---------- 流水线行：挂在左侧时间轴轨道上的阶段节点 ---------- */
function FlowRow({ icon, n, title, tone = "mut", headline, unit, sub, desc, steps, open, onToggle, jump, problem, hero, children }) {
  const abnormal = (steps || []).filter((s) => s.status !== "success" && s.status !== "pending");
  const skipped = abnormal.length > 0 && abnormal.every((s) => s.status === "skipped");
  const zero = headline === 0 || headline === "0" || headline === "—" || headline === "+0";
  const numColor = problem ? "var(--bad)" : zero ? "var(--ink-4)" : hero ? `var(--${tone})` : "var(--ink)";
  return (
    <div>
      <button onClick={onToggle}
        style={{
          width: "100%", textAlign: "left", border: "none", borderRadius: 10, cursor: "pointer",
          background: open ? "var(--brand-50)" : problem ? "var(--bad-soft)" : "transparent",
          padding: hero ? "11px 6px 11px 0" : "7px 6px 7px 0", display: "flex", alignItems: "center", gap: 11,
          opacity: skipped && !open ? .55 : 1, transition: "background .12s, opacity .12s",
        }}
        onMouseEnter={(e) => { if (!open && !problem) e.currentTarget.style.background = "var(--surface-2)"; }}
        onMouseLeave={(e) => { if (!open && !problem) e.currentTarget.style.background = "transparent"; }}>
        {/* 轨道节点 */}
        <span style={{ width: 32, height: 32, flex: "0 0 auto", display: "grid", placeItems: "center" }}>
          <span style={{
            width: hero ? 32 : 26, height: hero ? 32 : 26, borderRadius: "50%", display: "grid", placeItems: "center",
            background: skipped ? "var(--mut-bg)" : `var(--${tone}-bg)`, color: skipped ? "var(--ink-4)" : `var(--${tone})`,
            boxShadow: "0 0 0 3px var(--surface)",
            border: problem ? "1.5px solid var(--bad-solid)" : hero ? `1.5px solid var(--${tone}-line)` : "none",
          }}>
            <Icon name={icon} size={hero ? 15 : 13} />
          </span>
        </span>
        <div style={{ flex: "0 0 192px", minWidth: 0, display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ink-4)", flex: "0 0 auto" }}>{n}</span>
          <span style={{ fontWeight: hero ? 800 : 700, fontSize: hero ? 13.5 : 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        </div>
        <div style={{ flex: "0 0 92px", textAlign: "right", whiteSpace: "nowrap" }}>
          <span className="tnum" style={{ fontSize: hero ? 22 : 16, fontWeight: 800, color: numColor }}>{headline}</span>
          {unit && <span style={{ fontSize: 10.5, color: "var(--ink-4)", marginLeft: 3 }}>{unit}</span>}
        </div>
        <div style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11.5, color: skipped || zero ? "var(--ink-4)" : "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
        {/* 异常的步骤：失败/警告亮徽章，跳过只给一句灰字 */}
        <div style={{ flex: "0 0 auto", display: "flex", gap: 6, alignItems: "center" }}>
          {abnormal.map((s) => s.status === "skipped" ? (
            <span key={s.key} title={`${s.title}：已跳过${s.reason ? `\n${s.reason}` : ""}`}
              style={{ fontSize: 10.5, color: "var(--ink-4)", fontWeight: 600 }}>{s.short ? `${s.short}·` : ""}已跳过</span>
          ) : (
            <span key={s.key} title={`${s.title}：${STEP_LABEL[s.status]}${s.dur ? ` · ${fmtDur(s.dur)}` : ""}${s.error ? `\n${s.error}` : ""}`}
              className="chip" style={{ height: 21, fontSize: 10.5, gap: 4, background: `var(--${STEP_TONE[s.status]}-bg)`, borderColor: `var(--${STEP_TONE[s.status]}-line)`, color: `var(--${STEP_TONE[s.status]})`, fontWeight: 700 }}>
              {s.status === "running" ? <span className="spin" style={{ display: "flex" }}><Icon name="refresh" size={10} /></span>
                : <Icon name={s.status === "failed" ? "x" : "alert"} size={10} />}
              {(s.short ? s.short + "·" : "") + STEP_LABEL[s.status]}
            </span>
          ))}
        </div>
        <Icon name={open ? "chevD" : "chevR"} size={13} style={{ flex: "0 0 auto", color: "var(--ink-4)" }} />
      </button>
      {open && (
        <div className="fade-in" style={{ margin: "2px 6px 9px 43px", padding: "12px 14px", background: "var(--surface-2)", border: "1px solid var(--line-soft)", borderRadius: 10, fontSize: 12.5, maxHeight: 340, overflowY: "auto" }}>
          {desc && <div style={{ fontSize: 11.5, color: "var(--ink-4)", marginBottom: 9, lineHeight: 1.55, paddingBottom: 8, borderBottom: "1px dashed var(--line)" }}>{desc}</div>}
          {(steps || []).filter((s) => s.error).map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, padding: "9px 11px", background: "var(--bad-soft)", border: "1px solid var(--bad-line)", borderRadius: 8, marginBottom: 9 }}>
              <Icon name="alert" size={14} style={{ color: "var(--bad)", flex: "0 0 auto", marginTop: 1 }} />
              <div style={{ fontSize: 12, color: "var(--bad)" }}><b>{s.title}失败</b> · {s.error}</div>
            </div>
          ))}
          {children}
          {jump && <div style={{ marginTop: 10, display: "flex", gap: 8 }}>{jump}</div>}
        </div>
      )}
    </div>
  );
}

/* 主题的来源线索：同域名合并为 host ×N（同站多篇文章），tooltip 列出每篇 URL */
function SourceChips({ sources }) {
  if (!sources || !sources.length) return null;
  const byHost = {};
  sources.forEach((s) => { (byHost[s.host] = byHost[s.host] || []).push(s.url); });
  return (
    <span style={{ marginLeft: 4 }}>
      {Object.entries(byHost).map(([host, urls]) => (
        <a key={host} href={urls[0]} target="_blank" rel="noreferrer" className="chip" onClick={(e) => e.stopPropagation()}
          style={{ height: 17, fontSize: 10, marginLeft: 4, textDecoration: "none", color: "var(--info)", borderColor: "var(--info-line)", background: "var(--info-soft)" }}
          title={urls.length > 1 ? `该站 ${urls.length} 篇文章：\n` + urls.join("\n") : urls[0]}>
          {host}{urls.length > 1 ? ` ×${urls.length}` : ""}</a>
      ))}
    </span>
  );
}

/* ---------- 单日全景（倒排）---------- */
function DayReport({ date, nav, toast }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [srcDetail, setSrcDetail] = useState(null); // null | "loading" | {sources:[...]}
  const [openSrc, setOpenSrc] = useState(null);
  const [mrModal, setMrModal] = useState(null);     // {task} → 模型调用查看器
  const [logStep, setLogStep] = useState(null);     // step → 打开日志抽屉
  const [running, setRunning] = useState({});       // step → true（单步重跑中）
  const pollRef = useRef(null);
  const isToday = date === FLY.DAILY;

  // 单步重跑 + 轮询直到全部结束，然后刷新当日数据
  const startPoll = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const s = await FLY.stepStatus().catch(() => null);
      if (!s) return;
      const still = {};
      let failed = null;
      Object.entries(s.steps || {}).forEach(([k, v]) => {
        if (v.running) still[k] = true;
        else if (v.exitCode != null && v.exitCode !== 0) failed = `${v.label} 退出码 ${v.exitCode}：${(v.lastLines || []).slice(-1)[0] || ""}`;
      });
      setRunning(still);
      if (!Object.keys(still).length) {
        clearInterval(pollRef.current); pollRef.current = null;
        if (toast) toast(failed ? `单步重跑有失败 · ${failed.slice(0, 90)}` : "单步重跑完成，已刷新当日数据",
          failed ? { icon: "xCircle", color: "var(--bad-solid)", dur: 6000 } : { icon: "checkCircle", color: "var(--ok-solid)" });
        FLY.loadDay(date).then(setD).catch(() => {});
      }
    }, 4000);
  };
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  const rerun = async (step, label) => {
    try {
      await FLY.runStep(step);
      if (toast) toast(`「${label}」已开始重跑，完成后自动刷新`, { icon: "play", color: "var(--info-solid)" });
      setRunning((r) => ({ ...r, [step]: true }));
      setLogStep(step); // 立即打开实时日志抽屉
      startPoll();
    } catch (e) {
      if (toast) toast(`重跑被拒：${(e.data && e.data.error) || e.message}`, { icon: "xCircle", color: "var(--bad-solid)", dur: 5000 });
    }
  };
  // 行内控制按钮：重跑作用于「当前数据状态」，任何日期都可用；
  // 例外：历史日的采集禁用（重新采集只会产生今天的新观察，改写不了历史）——禁用而非隐藏，保持布局可预期
  const Rerun = ({ step, label }) => {
    const blocked = !isToday && step === "collect";
    return (
      <Btn kind="ghost" size="sm" icon="refresh" disabled={blocked || !!running[step]}
        title={blocked ? "历史日不可重新采集：采集只作用于今天，回到「今天」再跑"
          : isToday ? undefined : `产物计入今天（${FLY.DAILY}），不会改写正在查看的历史日`}
        onClick={() => !blocked && rerun(step, label)}>
        {running[step] ? "重跑中…" : `重跑${label}`}
      </Btn>
    );
  };
  const AiBtn = ({ task }) => (
    <Btn kind="ghost" size="sm" icon="sparkles" onClick={() => setMrModal({ task: task || "" })}>模型调用</Btn>
  );
  useEffect(() => {
    let alive = true;
    setD(null); setError(null); setOpen(null); setShowLog(false); setSrcDetail(null); setOpenSrc(null);
    FLY.loadDay(date).then((x) => { if (alive) setD(x); }).catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [date]);
  // 采集行展开时才拉来源明细（按来源分组，页面内浏览）
  useEffect(() => {
    if (open === 6 && srcDetail == null) {
      setSrcDetail("loading");
      FLY.loadDaySources(date).then(setSrcDetail).catch(() => setSrcDetail({ sources: [], failed: true }));
    }
  }, [open]);

  if (error) return <Card><Empty icon="xCircle" title="日报加载失败" desc={String(error.message || error)} /></Card>;
  if (!d) return <Card><Empty icon="clock" title={`正在加载 ${date} 的生产日报…`} desc="按天聚合采集/选题/生成/拍板数据。" /></Card>;

  const noData = d.collect.total === 0 && d.topics.created === 0 && d.articlesBorn.length === 0 && d.timeline.length === 0 && d.runs.length === 0;
  if (noData) return <Card><Empty icon="inbox" title={`${date} 没有生产活动`} desc="当天没有采集、选题、生成或状态推进记录。" /></Card>;

  const tg = (i) => () => setOpen(open === i ? null : i);
  // 7 步执行状态按 key 索引，补充中文标题
  const stepBy = {};
  (d.steps || []).forEach((s) => {
    const def = FLY.STEP_DEFS.find((x) => x.key === s.key);
    stepBy[s.key] = { ...s, title: def ? def.title : s.key };
  });
  const st = (key, short) => stepBy[key] ? [{ ...stepBy[key], short }] : [];
  const failed = (key) => stepBy[key] && stepBy[key].status === "failed";
  // 跳过的步骤：把跳过原因直接当 sub 显示，回溯时一眼看到断点
  const skipReason = (key) => {
    const s = stepBy[key];
    return s && s.status === "skipped" ? (s.reason || "已跳过：上游无产出") : null;
  };

  // 拍板汇总：终局分布 + 是否有坏结局
  const verdictBreakdown = {};
  d.verdicts.forEach((v) => { const m = VERDICT_META[v.to]; if (m) verdictBreakdown[m.text] = (verdictBreakdown[m.text] || 0) + 1; });
  const verdictBad = d.verdicts.some((v) => VERDICT_META[v.to] && VERDICT_META[v.to].tone === "bad");
  const logCount = d.timeline.length + d.warnings.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 当日 runs 头 */}
      <Card>
        <div style={{ padding: "12px 18px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mono" style={{ fontWeight: 800, fontSize: 15 }}>{date}</span>
          {d.runs.length === 0 ? <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>当天无引擎运行（仅有数据推进）</span> :
            d.runs.map((r) => {
              const rs = FLY.runStatus(r.status);
              return (
                <button key={r.id} className="chip" onClick={() => nav("runDetail", { id: r.id })}
                  style={{ cursor: "pointer", height: 24, gap: 6 }} title={r.id}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: `var(--${rs.tone}-solid)` }} />
                  {r.scope === "daily" ? "日更" : r.scope === "batch" ? "批跑" : r.scope}·{rs.text}
                  {r.runner === "langgraph" && <span className="mono" style={{ fontSize: 9.5, color: "var(--brand-600)", fontWeight: 700 }}>langgraph</span>}
                  {r.started && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{FLY.fmtHM(r.started)}</span>}
                </button>
              );
            })}
          <button className="chip" onClick={() => setLogStep(logStep ? null : "_any")}
            style={{ cursor: "pointer", height: 24, marginLeft: "auto", gap: 5 }} title="单步重跑的实时输出">
            <Icon name="history" size={12} />运行日志
          </button>
          {d.warnings.length > 0 && (
            <button className="chip" onClick={() => setShowLog(!showLog)}
              style={{ cursor: "pointer", height: 24, background: "var(--warn-soft)", borderColor: "var(--warn-line)", color: "var(--warn)" }}>
              <Icon name="alert" size={12} />{d.warnings.length} 条警告/错误
            </button>
          )}
        </div>
      </Card>

      {/* 正序流水线：一条轨道串起 7 个阶段，采集在顶，拍板收尾 */}
      <Card>
        <div style={{ position: "relative", padding: "12px 16px" }}>
          {/* 时间轴轨道 */}
          <span aria-hidden style={{ position: "absolute", left: 31, top: 34, bottom: 34, width: 2, background: "var(--line)", borderRadius: 1 }} />

          <FlowRow icon="rss" n="①" title="采集来源" tone="info" steps={st("collect")} problem={failed("collect")}
            headline={d.collect.total} unit={d.collect.basis === "observations" ? "次观察" : "条资讯"}
            sub={d.collect.failures.length ? `${d.collect.failures.length} 个源异常`
              : d.collect.observed ? ["new_source", "seen_source", "reactivated_source", "ignored"].filter((k) => d.collect.observed[k]).map((k) => `${FLY.obsStatus(k).text} ${d.collect.observed[k]}`).join(" · ")
              : Object.entries(d.collect.byCategory).slice(0, 4).map(([k, c]) => `${FLY.taxLabel("businessCategories", k)} ${c}`).join(" · ")}
            open={open === 0} desc={"从已启用的数据源抓取当天材料：RSS/网页走规则采集，搜索类源才调 OpenClaw；采集后自动做内容分类 → 写入 source_items、采集日志、内容分类"}
            onToggle={tg(0)}
            jump={<><Rerun step="collect" label="采集" /><AiBtn task="" /><Btn kind="ghost" size="sm" iconR="chevR" onClick={() => nav("sources", { day: date })}>数据源总览</Btn></>}>
            {/* 观察判定分布（去重采集：新源 / 重复 / 复活 / 忽略）*/}
            {d.collect.observed && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 700, flex: "0 0 52px" }}>观察判定</span>
                {["new_source", "seen_source", "reactivated_source", "ignored"].map((k) => {
                  const os = FLY.obsStatus(k);
                  return <span key={k} className="chip" style={{ height: 20, fontSize: 10.5, background: `var(--${os.tone}-bg)`, borderColor: `var(--${os.tone}-line)`, color: `var(--${os.tone})`, fontWeight: 700 }}>{os.text} {d.collect.observed[k] || 0}</span>;
                })}
              </div>
            )}
            {/* 三线健康（当日 engine_report）*/}
            {d.sourceReport && d.sourceReport.lanes && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 700, flex: "0 0 52px" }}>三线健康</span>
                {d.sourceReport.lanes.news && <span className="chip" style={{ height: 20, fontSize: 10.5 }}>新闻线 72h 新鲜 {d.sourceReport.lanes.news.fresh72h ?? "—"}</span>}
                {d.sourceReport.lanes.policy && <span className="chip" style={{ height: 20, fontSize: 10.5 }}>政策线 7 天新鲜 {d.sourceReport.lanes.policy.fresh7d ?? "—"} · 复活 {d.sourceReport.lanes.policy.reactivated ?? 0}</span>}
                {d.sourceReport.lanes.knowledge && <span className="chip" style={{ height: 20, fontSize: 10.5 }}>知识线 未用 {d.sourceReport.lanes.knowledge.unused ?? "—"} · 最久 {d.sourceReport.lanes.knowledge.oldestUnusedDays ?? "—"} 天</span>}
                {d.sourceReport.coverage && <span className="chip" style={{ height: 20, fontSize: 10.5 }}>素材库共 {d.sourceReport.coverage.canonicalSourcesSeen ?? "—"} 条</span>}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 700, flex: "0 0 52px" }}>业务分类</span>
              {Object.entries(d.collect.byCategory).map(([k, c]) => <span key={k} className="chip" style={{ height: 20, fontSize: 10.5 }}>{FLY.taxLabel("businessCategories", k)} {c}</span>)}
            </div>
            {d.collect.byType && Object.keys(d.collect.byType).length > 0 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 700, flex: "0 0 52px" }}>内容类型</span>
                {Object.entries(d.collect.byType).map(([k, c]) => <span key={k} className="chip" style={{ height: 20, fontSize: 10.5 }}>{FLY.taxLabel("contentTypes", k)} {c}</span>)}
              </div>
            )}
            {/* 按来源浏览：当页展开，不跳页 */}
            <div style={{ marginTop: 6, borderTop: "1px dashed var(--line)", paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink-3)", marginBottom: 5 }}>
                按来源浏览{srcDetail && srcDetail.sources ? `（${srcDetail.sources.length} 个来源）` : ""}
                {srcDetail && srcDetail.truncated && <span style={{ fontWeight: 500, color: "var(--ink-4)", marginLeft: 6 }}>条目超过 600，仅显示前 600</span>}
              </div>
              {srcDetail === "loading" && <div style={{ fontSize: 12, color: "var(--ink-4)" }}>正在加载来源明细…</div>}
              {srcDetail && srcDetail.failed && <div style={{ fontSize: 12, color: "var(--bad)" }}>来源明细加载失败</div>}
              {srcDetail && srcDetail.sources && srcDetail.sources.map((s) => {
                const bad = s.log && s.log.status !== "success";
                const so = openSrc === s.name;
                return (
                  <div key={s.name}>
                    <button onClick={() => setOpenSrc(so ? null : s.name)}
                      style={{ width: "100%", textAlign: "left", border: "none", background: so ? "var(--surface)" : "transparent", borderRadius: 7, cursor: "pointer", padding: "4px 6px", display: "flex", alignItems: "center", gap: 7 }}>
                      <Icon name={so ? "chevD" : "chevR"} size={11} style={{ color: "var(--ink-4)", flex: "0 0 auto" }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: bad ? "var(--bad)" : "var(--ink)" }}>{s.name}</span>
                      <span className="tnum" style={{ fontSize: 11, color: "var(--ink-3)" }}>×{s.count}</span>
                      {s.group && <span className="chip" style={{ height: 16, fontSize: 9.5, padding: "0 6px" }}>{FLY.sourceGroup(s.group)}</span>}
                      {bad && <span style={{ fontSize: 10.5, color: "var(--bad)" }}>✗ {s.log.http || s.log.status}{s.log.error ? ` ${s.log.error}` : ""}</span>}
                    </button>
                    {so && (
                      <div style={{ margin: "1px 0 5px 24px" }}>
                        {s.items.map((it, i) => (
                          <div key={i} style={{ fontSize: 11.5, padding: "2px 0", display: "flex", gap: 7, alignItems: "baseline" }}>
                            <span className="mono" style={{ color: "var(--ink-4)", flex: "0 0 34px", fontSize: 10.5 }}>{FLY.fmtHM(it.t)}</span>
                            {it.obsStatus && it.obsStatus !== "seen_source" && (
                              <span style={{ fontSize: 10, fontWeight: 700, flex: "0 0 auto", color: `var(--${FLY.obsStatus(it.obsStatus).tone})` }}>{FLY.obsStatus(it.obsStatus).text}</span>
                            )}
                            <a href={it.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink-2)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              onMouseEnter={(e) => e.currentTarget.style.color = "var(--brand-600)"} onMouseLeave={(e) => e.currentTarget.style.color = "var(--ink-2)"}>{it.title}</a>
                            {it.lane && <span style={{ fontSize: 10, color: `var(--${FLY.laneMeta(it.lane).tone})`, flex: "0 0 auto" }}>{FLY.laneMeta(it.lane).text}</span>}
                            {it.category && <span style={{ fontSize: 10, color: "var(--ink-4)", flex: "0 0 auto" }}>{FLY.taxLabel("businessCategories", it.category)}</span>}
                          </div>
                        ))}
                        {s.count > s.items.length && <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>… 共 {s.count} 条，仅显示前 {s.items.length} 条</div>}
                        {!s.items.length && <div style={{ fontSize: 11, color: "var(--ink-4)" }}>该来源当日没有入库条目</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </FlowRow>

          <FlowRow icon="bulb" n="②" title="生成主题池" tone="brand"
            steps={st("topics")} problem={failed("topics")}
            headline={`+${d.topics.created}`} unit="候选"
            sub={skipReason("topics") || `当日新增 ${d.topics.created} 个候选主题`}
            desc={"把来源材料提炼成候选主题（OpenClaw）：组装 source/关键词/近期已写主题，校验 JSON、分类、来源 URL、重复与关键词节流 → 写入 topic_candidates、model_runs。注意：这里的分数是『选题分』（这个题值不值得写），不是文章分——文章在 ④ 生成后才有质量评分。"}
            open={open === 1} onToggle={tg(1)}
            jump={<><Rerun step="topics" label="主题池" /><AiBtn task="topic_generation" /></>}>
            {d.topics.top.length > 0 && (
              <div>
                <b style={{ fontSize: 11.5, color: "var(--ink-3)" }}>当日高分候选</b>
                {d.topics.top.slice(0, 5).map((t, i) => (
                  <div key={i} style={{ fontSize: 11.5, marginTop: 3 }}>
                    <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)" }}>{(FLY.fmtDT(t.t) || "").slice(5)}</span>{" "}
                    <span className="tnum">{t.score}</span> 分 [{FLY.taxLabel("businessCategories", t.businessCategory)}] {t.topic.slice(0, 38)}
                    <SourceChips sources={t.sources} />
                  </div>
                ))}
              </div>
            )}
            {!d.topics.top.length && <span style={{ color: "var(--ink-4)" }}>当日没有新增候选主题</span>}
          </FlowRow>

          <FlowRow icon="listplus" n="③" title="选题入选（排队待写）" tone="brand"
            steps={st("tasks")} problem={failed("tasks")}
            headline={d.topics.selected.length} unit="个待写"
            sub={skipReason("tasks") || `选中 ${d.topics.selected.length} · 延期 ${d.topics.deferredCount}`}
            desc={"从候选主题里选出今天要写的题：按分数、来源支撑、分类配额、重复风险做组合选择（纯规则，不调模型）→ 写入 article_writing_tasks（写作排队）、状态流转"}
            open={open === 2} onToggle={tg(2)}
            jump={<><Rerun step="select" label="选题入选" />{date === FLY.DAILY && <Btn kind="ghost" size="sm" iconR="chevR" onClick={() => nav("topics")}>选题池</Btn>}</>}>
            {d.topics.selected.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <b style={{ color: "var(--ok)", fontSize: 11.5 }}>选中</b>
                {d.topics.selected.map((t, i) => (
                  <div key={i} style={{ fontSize: 11.5, marginTop: 3 }}>
                    ✓ [{FLY.taxLabel("businessCategories", t.businessCategory)}] {t.topic.slice(0, 36)}<span className="tnum" style={{ color: "var(--ink-3)" }}>（原始 {t.raw} · 价值 {t.value}）</span>
                    <SourceChips sources={t.sources} />
                  </div>
                ))}
              </div>
            )}
            {d.topics.deferredCount > 0 && (
              <div style={{ marginBottom: 8 }}>
                <b style={{ color: "var(--warn)", fontSize: 11.5 }}>延期 {d.topics.deferredCount} 个</b>
                <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 6 }}>近期写过同类，到期自动回池：{Object.entries(d.topics.deferReasons).map(([k, c]) => `${k}×${c}`).join("、")}</span>
                {d.topics.deferredSample.map((x, i) => <div key={i} style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>⏸ {x.topic}…（{x.reason}）</div>)}
              </div>
            )}
            {!d.topics.selected.length && !d.topics.deferredCount && <span style={{ color: "var(--ink-4)" }}>当日没有组合选题动作</span>}
          </FlowRow>

          <FlowRow icon="sparkles" n="④" title="生成文章" tone="ok" steps={st("generate")} problem={failed("generate")}
            headline={d.articlesBorn.length} unit="篇新文章"
            sub={skipReason("generate") || d.articlesBorn.map((x) => x.title.slice(0, 16)).join("；") || "当日无新文章"}
            open={open === 3} desc={"根据文章任务生成正文和结构化文章 JSON（OpenClaw 按策略写稿，本地校验字段与质量报告；不合格重试）→ 写入 articles、article_versions、quality_reports"}
            onToggle={tg(3)}
            jump={<><Rerun step="generate" label="生成" /><AiBtn task="article_generation" /><Btn kind="ghost" size="sm" iconR="chevR" onClick={() => nav("library", { day: date })}>在文章库查看该日</Btn></>}>
            {d.articlesBorn.map((x) => (
              <div key={x.id} className="clickable" onClick={() => nav("detail", { id: x.id })}
                style={{ padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 6, cursor: "pointer" }}>
                <div style={{ fontWeight: 700, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.title}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  质量门 {x.quality ?? "-"} · 主评分 <b style={{ color: x.articleQuality == null ? "var(--ink-4)" : x.articleQuality >= 80 ? "var(--ok)" : "var(--bad)" }}>{x.articleQuality ?? "未评"}</b> · {FLY.artStatus(x.status).text}
                </div>
              </div>
            ))}
            {!d.articlesBorn.length && <span style={{ color: "var(--ink-4)" }}>当日无新文章。往上看选题/采集是否有产出。</span>}
          </FlowRow>

          <FlowRow icon="shield" n="⑤" title="事实核查" tone="warn" steps={st("factcheck")} problem={failed("factcheck")}
            headline={d.factChecks} unit="次核查"
            sub={skipReason("factcheck") || "风险等级 · 缺来源点 · 必修项"}
            open={open === 4} desc={"检查文章里的事实、数字、结论和来源支撑（OpenClaw 输出风险等级、缺来源点、必修项）→ 写入 fact_checks、source_resolutions；文章进入待审/待补来源/核查失败"}
            onToggle={tg(4)}
            jump={<><Rerun step="factcheck" label="核查" /><AiBtn task="fact_check" /></>}>
            {!d.factChecks && <span style={{ color: "var(--ink-4)" }}>当日无核查活动</span>}
          </FlowRow>

          <FlowRow icon="user" n="⑥" title="补来源与修订" tone="warn" steps={st("sourcesfix")}
            headline={d.versionsNew.length} unit="个新版本"
            sub={d.versionsNew.length ? d.versionsNew.map((v) => v.label).join("、") : "当日无补源/修订动作"}
            desc={"修复事实核查指出的缺来源与高风险表达：补权威来源、局部改写、重新核查；多轮不收敛转人工 → 写入新版 article_versions、补源记录"}
            open={open === 5} onToggle={tg(5)}
            jump={<><Rerun step="sourcesfix" label="补源" /><AiBtn task="source_resolution" /></>}>
            {d.versionsNew.map((v, i) => (
              <div key={i} style={{ fontSize: 11.5, marginTop: 3 }} className="clickable" onClick={() => nav("detail", { id: v.articleId })}>
                <span className="mono" style={{ fontWeight: 700 }}>{v.label}</span> {v.title}… <span style={{ color: "var(--ink-4)" }}>{v.mode === "fact_checked_revision" ? "补源修订" : "初稿"}</span>
              </div>
            ))}
            {!d.versionsNew.length && <span style={{ color: "var(--ink-4)" }}>当日没有产生新版本。事实核查发现缺来源时，这一步补权威来源并修订正文。</span>}
          </FlowRow>

          <FlowRow icon="share" n="⑦" title="渠道改写" tone="info" steps={st("channels")} problem={failed("channels")}
            headline={d.channelsNew.length} unit="篇渠道稿"
            sub={skipReason("channels") || "公众号 / 抖音 / 小红书"}
            open={open === 6} desc={"把已就绪文章改写成渠道稿：按公众号、抖音、小红书的结构分别生成，检查渠道结构与禁词 → 写入 channel_outputs"}
            onToggle={tg(6)}
            jump={<><Rerun step="channels" label="渠道" /><AiBtn task="channel_repurpose" /></>}>
            {d.channelsNew.map((c, i) => (
              <div key={i} style={{ fontSize: 11.5, marginTop: 3 }}>
                <Badge tone={c.status === "success" ? "ok" : "bad"} dot={false}>{FLY.CHANNEL_META[c.channel] || c.channel}</Badge> {c.title}…
              </div>
            ))}
            {!d.channelsNew.length && <span style={{ color: "var(--ink-4)" }}>当日无渠道稿</span>}
          </FlowRow>

          <FlowRow icon="gauge" n="⑧" title="SEO/GEO 评分" tone="info" steps={st("score")} problem={failed("score")}
            headline={stepBy.score && stepBy.score.metrics && stepBy.score.metrics.length ? stepBy.score.metrics[0][1] : "—"} unit="篇"
            sub={skipReason("score") || (stepBy.score ? stepBy.score.summary : "建议线，不拦发布")}
            open={open === 7} desc={"给文章做搜索与 AI 引用友好度评估（SEO/GEO/事实分/业务契合/可读性）：辅助终审与优化方向，不覆盖质量主门禁 → 写入 seo_geo_scores"}
            onToggle={tg(7)}
            jump={<><Rerun step="score" label="评分" /><AiBtn task="seo_geo_score" /></>}>
            {stepBy.score ? (
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {(stepBy.score.metrics || []).map(([k, v]) => <span key={k} className="tnum" style={{ fontSize: 12 }}>{k} <b>{v}</b></span>)}
                {(stepBy.score.warnings || []).map((w, i) => <div key={i} style={{ flexBasis: "100%", color: "var(--warn)", fontSize: 11.5 }}>⚠ {w}</div>)}
              </div>
            ) : <span style={{ color: "var(--ink-4)" }}>无执行记录。SEO/GEO 只处理待终审文章。</span>}
          </FlowRow>

          <FlowRow icon="flag" n="终" title="拍板 · 最终产出" hero
            tone={verdictBad ? "bad" : d.verdicts.length ? "ok" : "mut"} problem={verdictBad}
            headline={d.verdicts.length} unit="个终局" open={open === 8} onToggle={tg(8)}
            sub={Object.entries(verdictBreakdown).map(([k, c]) => `${k}×${c}`).join(" · ") || "当日无文章终局变化"}
            jump={<><Btn kind="ghost" size="sm" iconR="chevR" onClick={() => nav("library", { day: date })}>在文章库查看该日</Btn><AiBtn task="" /></>}>
            {d.verdicts.map((v, i) => {
              const m = VERDICT_META[v.to] || { text: v.to, tone: "mut", icon: "dot" };
              return (
                <div key={i} className="clickable" onClick={() => nav("detail", { id: v.articleId })}
                  style={{ padding: "8px 10px", border: `1px solid var(--${m.tone}-line)`, background: `var(--${m.tone}-soft)`, borderRadius: 8, marginBottom: 6, cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Icon name={m.icon} size={13} style={{ color: `var(--${m.tone})` }} />
                    <b style={{ fontSize: 12, color: `var(--${m.tone})` }}>{m.text}</b>
                    {v.bornDay && v.bornDay !== date && <span className="chip" style={{ height: 17, fontSize: 10 }}>生于 {v.bornDay.slice(5)}</span>}
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginLeft: "auto" }}>{FLY.fmtHM(v.t)}</span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.title}</div>
                  {v.reason && <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{v.reason.slice(0, 90)}</div>}
                </div>
              );
            })}
            {!d.verdicts.length && <span style={{ color: "var(--ink-4)" }}>当日没有文章到达终局（待终审/批准/打回等）。往上看卡在哪一步。</span>}
            {d.advancedArticles.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <b style={{ fontSize: 11.5, color: "var(--ink-3)" }}>当日推进的存量文章（跨天追踪）</b>
                {d.advancedArticles.map((x) => (
                  <div key={x.articleId} className="clickable" onClick={() => nav("detail", { id: x.articleId })} style={{ cursor: "pointer", padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, marginTop: 6 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontWeight: 700, fontSize: 12 }}>{x.title}</span>
                      {x.bornDay && <span className="chip" style={{ height: 17, fontSize: 10 }}>生于 {x.bornDay.slice(5)}</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 3 }}>
                      {x.moves.map((mv, i) => (
                        <span key={i}>{i > 0 && "　"}{FLY.fmtHM(mv.t)} {FLY.artStatus(mv.from).text}→<b style={{ color: `var(--${FLY.artStatus(mv.to).tone})` }}>{FLY.artStatus(mv.to).text}</b></span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </FlowRow>
        </div>
      </Card>

      {/* 大事记：默认折叠 */}
      {logCount > 0 && (
        <Card>
          <button onClick={() => setShowLog(!showLog)}
            style={{ width: "100%", textAlign: "left", border: "none", background: "transparent", cursor: "pointer", padding: "13px 18px", display: "flex", alignItems: "center", gap: 9 }}>
            <Icon name="history" size={15} style={{ color: "var(--ink-3)" }} />
            <span style={{ fontWeight: 700, fontSize: 13 }}>当日大事记</span>
            <span className="hint">{d.timeline.length} 条状态流转 · {d.warnings.length} 条警告/错误</span>
            <Icon name={showLog ? "chevD" : "chevR"} size={14} style={{ marginLeft: "auto", color: "var(--ink-4)" }} />
          </button>
          {showLog && (
            <div className="fade-in" style={{ borderTop: "1px solid var(--line-soft)", padding: "12px 18px", maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
              {[...d.timeline.map(t => ({ ...t, _k: "t" })), ...d.warnings.map(w => ({ ...w, _k: "w" }))]
                .sort((a, b) => (a.t || "").localeCompare(b.t || ""))
                .map((e, i) => e._k === "t" ? (
                  <div key={i} style={{ display: "flex", gap: 9, fontSize: 12, alignItems: "baseline" }}>
                    <span className="mono" style={{ color: "var(--ink-4)", flex: "0 0 40px" }}>{FLY.fmtHM(e.t)}</span>
                    <span style={{ flex: "0 0 auto", fontWeight: 600 }}>{e.title || e.entityId}</span>
                    <span style={{ color: "var(--ink-3)" }}>{FLY.artStatus(e.from).text}→<b style={{ color: `var(--${FLY.artStatus(e.to).tone})` }}>{FLY.artStatus(e.to).text}</b></span>
                    <span style={{ color: "var(--ink-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.reason}</span>
                  </div>
                ) : (
                  <div key={i} style={{ display: "flex", gap: 9, fontSize: 12, alignItems: "baseline" }}>
                    <span className="mono" style={{ color: "var(--ink-4)", flex: "0 0 40px" }}>{FLY.fmtHM(e.t)}</span>
                    <Icon name="alert" size={12} style={{ color: e.level === "error" ? "var(--bad)" : "var(--warn)", flex: "0 0 auto", alignSelf: "center" }} />
                    <span style={{ color: e.level === "error" ? "var(--bad)" : "var(--warn)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.message}</span>
                  </div>
                ))}
            </div>
          )}
        </Card>
      )}

      {/* 模型调用 I/O 查看器 */}
      {mrModal && window.ModelRunsModal && <window.ModelRunsModal task={mrModal.task} onClose={() => setMrModal(null)} />}
      {/* 单步运行日志抽屉（终端风格，实时轮询）*/}
      {logStep && window.StepLogDrawer && <window.StepLogDrawer initialStep={logStep === "_any" ? null : logStep} onClose={() => setLogStep(null)} />}
    </div>
  );
}

Object.assign(window, { DayStrip, DayReport });
