/* ============================================================
   数据源 — canonical 素材库（三线：资讯/政策/知识）+ 观察记录
   数据：GET /api/ui/sources（overview + canonical 列表）
        GET /api/ui/observations（每日采集真相，按日/状态过滤）
   ============================================================ */

/* 顶部覆盖统计：最近一次运行的源覆盖 + 三线健康 */
function SourcesOverview({ ov }) {
  if (!ov) return null;
  const cov = ov.coverage || {};
  const lanes = ov.lanes || {};
  const cards = [
    { label: "素材库总量", val: ov.canonicalTotal ?? cov.canonicalSourcesSeen ?? 0, unit: "条", hint: "canonical 去重后的素材（同一 URL 只存一条）", tone: "brand" },
    { label: "新闻线 · 72h 新鲜", val: (lanes.news && lanes.news.fresh72h) ?? "—", unit: "条", hint: `共 ${(ov.laneCounts.news && ov.laneCounts.news.total) || 0} 条 · 本次进 prompt ${(lanes.news && lanes.news.inPrompt) ?? 0}`, tone: "info" },
    { label: "政策线 · 7天新鲜", val: (lanes.policy && lanes.policy.fresh7d) ?? "—", unit: "条", hint: `共 ${(ov.laneCounts.policy && ov.laneCounts.policy.total) || 0} 条 · 复活启用 ${(lanes.policy && lanes.policy.reactivated) ?? 0}`, tone: "warn" },
    { label: "知识线 · 未使用", val: (lanes.knowledge && lanes.knowledge.unused) ?? "—", unit: "条", hint: `已用 ${(lanes.knowledge && lanes.knowledge.used) ?? 0} · 最久未用 ${(lanes.knowledge && lanes.knowledge.oldestUnusedDays) ?? "—"} 天`, tone: "ok" },
  ];
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {cards.map((c, i) => (
          <div key={c.label} style={{ padding: "14px 18px", borderLeft: i ? "1px solid var(--line-soft)" : "none" }}>
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", fontWeight: 600 }}>{c.label}</div>
            <div className="tnum" style={{ fontSize: 24, fontWeight: 800, marginTop: 3, color: `var(--${c.tone})` }}>{c.val}<span style={{ fontSize: 11, color: "var(--ink-4)", marginLeft: 3, fontWeight: 600 }}>{c.unit}</span></div>
            <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 3 }}>{c.hint}</div>
          </div>
        ))}
      </div>
      <div style={{ borderTop: "1px solid var(--line-soft)", padding: "9px 18px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 11.5, color: "var(--ink-3)" }}>
        <span style={{ fontWeight: 700 }}>最近一次运行的源观察</span>
        <span>观察 <b className="tnum">{cov.observations ?? 0}</b></span>
        <span style={{ color: "var(--ok)" }}>新源 <b className="tnum">{cov.newSources ?? 0}</b></span>
        <span>重复 <b className="tnum">{cov.seenSources ?? 0}</b></span>
        <span style={{ color: "var(--info)" }}>复活 <b className="tnum">{cov.reactivatedSources ?? 0}</b></span>
        <span style={{ color: "var(--warn)" }}>忽略 <b className="tnum">{cov.ignored ?? 0}</b></span>
        {ov.reportAt && <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-4)" }}>报告时间 {FLY.fmtDT(ov.reportAt)}</span>}
      </div>
    </Card>
  );
}

/* 素材库 tab：线别 + 来源 + 使用状态过滤，canonical 列表 */
function CanonicalTable({ data, lane, setLane, usage, setUsage, src, setSrc, loading }) {
  const laneCounts = (data && data.overview && data.overview.laneCounts) || {};
  const total = (data && data.overview && data.overview.canonicalTotal) || 0;
  const LANE_TABS = [["", `全部 ${total}`], ...["news", "policy", "knowledge"].map((k) => [k, `${FLY.laneMeta(k).text} ${(laneCounts[k] && laneCounts[k].total) || 0}`])];
  const items = (data && data.items) || [];
  const facet = (data && data.sourceFacet) || [];
  return (
    <>
      <div style={{ padding: "10px 16px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
        {LANE_TABS.map(([k, label]) => (
          <button key={k} onClick={() => setLane(k)} className="chip"
            style={{ cursor: "pointer", fontWeight: 700, border: lane === k ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: lane === k ? "var(--brand-50)" : "var(--mut-soft)", color: lane === k ? "var(--brand-700)" : "var(--ink-2)" }}>
            {label}
          </button>
        ))}
        <select className="inp" style={{ width: "auto", minWidth: 110, marginLeft: "auto", height: 30 }} value={usage} onChange={(e) => setUsage(e.target.value)}>
          <option value="">全部状态</option>
          <option value="unused">未使用</option>
          <option value="used">已使用</option>
          <option value="soft_expired">软过期</option>
        </select>
      </div>
      {/* 来源筛选：直接点选，不藏在下拉里 */}
      <div style={{ padding: "8px 16px", display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
        <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 700, flex: "0 0 auto" }}>来源</span>
        <button onClick={() => setSrc("")} className="chip"
          style={{ cursor: "pointer", height: 22, fontSize: 11, fontWeight: 700, border: !src ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: !src ? "var(--brand-50)" : "var(--mut-soft)", color: !src ? "var(--brand-700)" : "var(--ink-2)" }}>
          全部
        </button>
        {facet.map((f) => (
          <button key={f.name} onClick={() => setSrc(src === f.name ? "" : f.name)} className="chip"
            style={{ cursor: "pointer", height: 22, fontSize: 11, fontWeight: 600, border: src === f.name ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: src === f.name ? "var(--brand-50)" : "var(--mut-soft)", color: src === f.name ? "var(--brand-700)" : "var(--ink-2)" }}>
            {f.name}<span style={{ opacity: .6, marginLeft: 3 }}>{f.count}</span>
          </button>
        ))}
      </div>
      {loading ? <Empty icon="clock" title="正在加载素材库…" /> : !items.length ? <Empty icon="inbox" title="没有符合条件的素材" desc="换个线别、来源或使用状态试试。" /> : (
        <table className="tbl">
          <thead><tr>
            <th>素材</th><th style={{ width: 150 }}>来源</th><th style={{ width: 70 }}>线别</th><th style={{ width: 72 }}>使用状态</th>
            <th style={{ width: 56 }} title="同一 URL 被各采集源观察到的总次数">被看见</th>
            <th style={{ width: 64 }} title="进入选题 prompt 的次数">进 prompt</th>
            <th style={{ width: 84 }}>首次发现</th><th style={{ width: 84 }}>最近看见</th><th style={{ width: 84 }}>复活时间</th>
          </tr></thead>
          <tbody>
            {items.map((x) => {
              const lm = FLY.laneMeta(x.lane);
              const us = FLY.usageStatus(x.usageStatus);
              return (
                <tr key={x.hash}>
                  <td style={{ maxWidth: 330 }}>
                    <a href={x.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none", fontWeight: 600, fontSize: 12.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      onMouseEnter={(e) => e.currentTarget.style.color = "var(--brand-600)"} onMouseLeave={(e) => e.currentTarget.style.color = "var(--ink)"} title={x.url}>{x.title}</a>
                    {x.summary && <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.summary}</div>}
                  </td>
                  <td>
                    <button onClick={() => setSrc(src === x.sourceName ? "" : x.sourceName)} title={src === x.sourceName ? "取消按此来源筛选" : "只看这个来源"}
                      style={{ border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left", color: src === x.sourceName ? "var(--brand-700)" : "var(--ink-2)", fontWeight: 600, fontSize: 12, display: "block", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {x.sourceName || "未知来源"}
                    </button>
                    {x.sourceGroup && <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 1 }}>{FLY.sourceGroup(x.sourceGroup)}</div>}
                  </td>
                  <td><Badge tone={lm.tone} dot={false}>{lm.text}</Badge></td>
                  <td><Badge tone={us.tone} dot={false}>{us.text}</Badge></td>
                  <td className="tnum" style={{ fontWeight: 700 }}>{x.seenCount}</td>
                  <td className="tnum" style={{ fontWeight: 700, color: x.timesInPrompt > 0 ? "var(--ok)" : "var(--ink-4)" }}>{x.timesInPrompt}</td>
                  <td className="muted mono" style={{ fontSize: 11 }}>{(FLY.fmtDT(x.firstSeen) || "").slice(5, 16)}</td>
                  <td className="muted mono" style={{ fontSize: 11 }}>{(FLY.fmtDT(x.lastSeen) || "").slice(5, 16)}</td>
                  <td className="muted mono" style={{ fontSize: 11 }}>{x.reactivatedAt ? (FLY.fmtDT(x.reactivatedAt) || "").slice(5, 16) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/* 观察记录 tab：每日采集真相 */
function ObservationTable({ obs, date, setDate, status, setStatus, loading }) {
  const byStatus = (obs && obs.byStatus) || {};
  const totalAll = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const STATUS_TABS = [["", `全部 ${totalAll}`], ...Object.keys(FLY.OBS_STATUS).map((k) => [k, `${FLY.obsStatus(k).text} ${byStatus[k] || 0}`])];
  const items = (obs && obs.items) || [];
  return (
    <>
      <div style={{ padding: "10px 16px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
        <input type="date" className="inp" style={{ width: "auto", height: 30 }} value={date} onChange={(e) => setDate(e.target.value)} />
        {date && <button className="chip" style={{ cursor: "pointer" }} onClick={() => setDate("")}>看全部日期 ✕</button>}
        <span style={{ borderLeft: "1px solid var(--line)", height: 18, margin: "0 4px" }} />
        {STATUS_TABS.map(([k, label]) => (
          <button key={k} onClick={() => setStatus(k)} className="chip"
            style={{ cursor: "pointer", fontWeight: 700, border: status === k ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: status === k ? "var(--brand-50)" : "var(--mut-soft)", color: status === k ? "var(--brand-700)" : "var(--ink-2)" }}>
            {label}
          </button>
        ))}
      </div>
      {loading ? <Empty icon="clock" title="正在加载观察记录…" /> : !items.length ? (
        <Empty icon="inbox" title="没有观察记录"
          desc={date ? `${date} 没有采集观察。新的去重采集结构上线后，每次日更运行才会写入观察记录。` : "新的去重采集结构上线后，每次日更运行会把「看到了什么、是新是旧」写进观察记录。"} />
      ) : (
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 96 }}>时间</th><th style={{ width: 84 }}>判定</th><th style={{ width: 70 }}>线别</th>
            <th>条目</th><th style={{ width: 200 }}>重复原因</th>
          </tr></thead>
          <tbody>
            {items.map((x) => {
              const os = FLY.obsStatus(x.status);
              const lm = FLY.laneMeta(x.lane);
              return (
                <tr key={x.id}>
                  <td className="muted mono" style={{ fontSize: 11 }}>{(FLY.fmtDT(x.t) || "").slice(5, 16)}</td>
                  <td><Badge tone={os.tone} dot={false}>{os.text}</Badge></td>
                  <td>{x.lane ? <Badge tone={lm.tone} dot={false}>{lm.text}</Badge> : <span style={{ color: "var(--ink-4)" }}>—</span>}</td>
                  <td style={{ maxWidth: 360 }}>
                    <a href={x.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none", fontWeight: 600, fontSize: 12.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      onMouseEnter={(e) => e.currentTarget.style.color = "var(--brand-600)"} onMouseLeave={(e) => e.currentTarget.style.color = "var(--ink)"} title={x.url}>{x.title}</a>
                    <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 2 }}>{x.sourceName}{x.sourceGroup ? ` · ${FLY.sourceGroup(x.sourceGroup)}` : ""}</div>
                  </td>
                  <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{x.dupReason || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function SourcesPage({ nav, params, toast }) {
  const [tab, setTab] = useState(params.tab || "canonical"); // canonical | observations | config
  const [cfgCounts, setCfgCounts] = useState(null); // {来源名: 库内素材数}，采集源配置 tab 用
  const [lane, setLane] = useState(params.lane || "");
  const [usage, setUsage] = useState("");
  const [src, setSrc] = useState("");
  const [data, setData] = useState(null);
  const [loadingC, setLoadingC] = useState(true);
  const [obsDate, setObsDate] = useState(params.day || FLY.DAILY);
  const [obsStatus, setObsStatus] = useState("");
  const [obs, setObs] = useState(null);
  const [loadingO, setLoadingO] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadingC(true);
    FLY.loadSources({ lane, status: usage, source: src }).then((r) => { if (alive) { setData(r); setLoadingC(false); } })
      .catch(() => { if (alive) setLoadingC(false); });
    return () => { alive = false; };
  }, [lane, usage, src]);

  useEffect(() => {
    if (tab !== "observations") return;
    let alive = true;
    setLoadingO(true);
    FLY.loadObservations({ date: obsDate, status: obsStatus }).then((r) => { if (alive) { setObs(r); setLoadingO(false); } })
      .catch(() => { if (alive) setLoadingO(false); });
    return () => { alive = false; };
  }, [tab, obsDate, obsStatus]);

  // 采集源配置 tab：拉一次全量来源聚合，给每个源标注库内素材数
  useEffect(() => {
    if (tab !== "config" || cfgCounts != null) return;
    let alive = true;
    FLY.loadSources({ limit: 1 }).then((r) => {
      if (alive) setCfgCounts(Object.fromEntries((r.sourceFacet || []).map((f) => [f.name, f.count])));
    }).catch(() => { if (alive) setCfgCounts({}); });
    return () => { alive = false; };
  }, [tab]);

  return (
    <div className="page fade-in">
      <div className="page-head">
        <h1 className="page-title">数据源</h1>
        <p className="page-sub">素材按 URL 去重存一份（素材库），每天「看见了什么」记在观察记录里。三线管理：新闻走时效、政策可复活、知识按库存轮转。</p>
      </div>

      <SourcesOverview ov={data && data.overview} />

      <Card>
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--line-soft)" }}>
          {[["canonical", "素材库"], ["observations", "观察记录"], ["config", "采集源配置"]].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ border: "none", background: "transparent", cursor: "pointer", padding: "12px 18px", fontWeight: 700, fontSize: 13, color: tab === k ? "var(--brand-700)" : "var(--ink-3)", borderBottom: tab === k ? "2px solid var(--brand-500)" : "2px solid transparent", marginBottom: -1 }}>
              {label}
            </button>
          ))}
        </div>
        {tab === "canonical" && <CanonicalTable data={data} lane={lane} setLane={setLane} usage={usage} setUsage={setUsage} src={src} setSrc={setSrc} loading={loadingC} />}
        {tab === "observations" && <ObservationTable obs={obs} date={obsDate} setDate={setObsDate} status={obsStatus} setStatus={setObsStatus} loading={loadingO} />}
        {tab === "config" && (window.Sources
          ? <div style={{ padding: "4px 0 0" }}><window.Sources toast={toast} counts={cfgCounts || {}} /></div>
          : <Empty icon="settings" title="配置组件未加载" />)}
      </Card>
    </div>
  );
}

Object.assign(window, { SourcesPage });
