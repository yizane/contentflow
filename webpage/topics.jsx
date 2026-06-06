/* ============================================================
   选题池 — Topic Pool（真实数据：FLY.TOPICS）
   ============================================================ */
/* Topic Audition 摘要：最近一次选题压力测试（未来 N 天会写什么） */
function AuditionPanel() {
  const [latest, setLatest] = useState(null);
  const [detail, setDetail] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    FLY.loadAuditions().then((list) => { if (alive && list.length) setLatest(list[0]); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!open || !latest || detail) return;
    let alive = true;
    FLY.loadAudition(latest.id).then((d) => { if (alive) setDetail(d); }).catch(() => {});
    return () => { alive = false; };
  }, [open, latest]);
  if (!latest) return null;
  const verdictOk = (latest.readyVerdict || "").startsWith("✅");
  return (
    <Card style={{ marginBottom: 16 }}>
      <CardHead icon="trend" title="选题压力测试（Topic Audition）" hint={`最近一次 ${latest.created} · ${latest.rounds} 轮 × ${latest.limitPerRound} 篇`}>
        <Btn kind="ghost" size="sm" iconR={open ? "chevD" : "chevR"} onClick={() => setOpen(!open)}>{open ? "收起" : "展开未来选题"}</Btn>
      </CardHead>
      <div style={{ padding: "12px 18px", display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12.5 }}>覆盖分类 <b className="tnum">{latest.categoriesCovered}</b></span>
        <span style={{ fontSize: 12.5 }}>Alexa/Listing 占比 <b className="tnum">{latest.alexaListingShare}</b></span>
        <span style={{ fontSize: 12.5 }}>平均价值分 <b className="tnum" style={{ color: latest.avgContentValueScore >= 80 ? "var(--ok)" : "var(--warn)" }}>{latest.avgContentValueScore}</b></span>
        <Badge tone={latest.repetitionRisk === "low" ? "ok" : latest.repetitionRisk === "medium" ? "warn" : "bad"} dot={false}>重复风险 {latest.repetitionRisk}</Badge>
        <Badge tone={verdictOk ? "ok" : "warn"} dot={false}>{verdictOk ? "可开始生成" : "需先调优"}</Badge>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--line-soft)", padding: "12px 18px", maxHeight: 320, overflowY: "auto" }}>
          {!detail ? <div style={{ color: "var(--ink-3)", fontSize: 12.5 }}>加载中…</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(detail.summary.days || []).map((d) => d.picks.map((pk, i) => (
                <div key={`${d.round}-${i}`} style={{ display: "flex", gap: 10, fontSize: 12.5, alignItems: "baseline" }}>
                  <span className="mono" style={{ color: "var(--ink-4)", flex: "0 0 52px" }}>Day {d.round}</span>
                  <span className="chip" style={{ height: 18, fontSize: 10.5, padding: "0 7px", flex: "0 0 auto", background: "var(--brand-50)", borderColor: "var(--brand-200)", color: "var(--brand-700)" }}>{FLY.taxLabel("businessCategories", pk.businessCategory)}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pk.topic}>{pk.topic}</span>
                  <span className="tnum" style={{ color: pk.contentValueScore >= 80 ? "var(--ok)" : "var(--warn)", fontWeight: 700, flex: "0 0 auto" }}>{pk.contentValueScore ?? "-"}</span>
                </div>
              )))}
              {detail.summary.recommendations && detail.summary.recommendations.length > 0 && (
                <div style={{ marginTop: 8, padding: "9px 12px", background: "var(--mut-soft)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
                  {detail.summary.recommendations.slice(0, 4).map((r, i) => <div key={i}>· {r}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* 今日组合决策面板：为什么选了 A、为什么 B 被延期 */
function PortfolioPanel() {
  const p = FLY.PORTFOLIO;
  if (!p || (p.deferredCount === 0 && p.lastSelected.length === 0)) return null;
  return (
    <Card style={{ marginBottom: 16 }}>
      <CardHead icon="layers" title="组合决策" hint="选题不是分数最高者胜：选择分 = 价值分×0.55 + 原始分×0.25 ± 组合奖惩" />
      <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        {p.lastSelected.length > 0 && (
          <div style={{ display: "flex", gap: 9, padding: "10px 13px", background: "var(--ok-soft)", border: "1px solid var(--ok-line)", borderRadius: 9 }}>
            <Icon name="check" size={15} style={{ color: "var(--ok)", flex: "0 0 auto", marginTop: 2 }} />
            <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
              <b style={{ color: "var(--ok)" }}>最近选中</b>
              {p.lastSelected.map((s, i) => (
                <div key={i}>「{s.topic.slice(0, 40)}…」原始分 {s.rawScore} → 选择分 <b>{s.selectionScore}</b>（{FLY.taxLabel("businessCategories", s.businessCategory)}{s.topicCluster ? ` / ${FLY.taxLabel("topicClusters", s.topicCluster)}` : ""}）</div>
              ))}
            </div>
          </div>
        )}
        {p.deferredCount > 0 && (
          <div style={{ display: "flex", gap: 9, padding: "10px 13px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 9 }}>
            <Icon name="clock" size={15} style={{ color: "var(--warn)", flex: "0 0 auto", marginTop: 2 }} />
            <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
              <b style={{ color: "var(--warn)" }}>{p.deferredCount} 个高分候选被延期</b>（主题近期已饱和，窗口期后自动回池，不是被拒）
              {p.deferred.slice(0, 4).map((d, i) => (
                <div key={i} style={{ marginTop: 2 }}>「{d.topic.slice(0, 36)}…」原始分 {d.rawScore} → {d.selectionScore}　<span style={{ color: "var(--ink-3)" }}>{(d.reason || "").slice(0, 50)}</span></div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function TopicPool({ nav, params }) {
  const [filter, setFilter] = useState("all");
  const [bcat, setBcat] = useState("");   // 业务分类标签导航
  const [ctype, setCtype] = useState(""); // 内容类型标签导航
  const TABS = [["all", "全部"], ["candidate", "候选"], ["selected", "已选中"], ["generated", "已生成"], ["deferred", "延期"], ["rejected", "被拒"]];
  const counts = useMemo(() => {
    const c = { all: FLY.TOPICS.length };
    FLY.TOPICS.forEach(t => c[t.status] = (c[t.status] || 0) + 1);
    return c;
  }, [FLY.TOPICS]);
  const bcatCounts = useMemo(() => {
    const c = {};
    FLY.TOPICS.forEach(t => { if (t.businessCategory) c[t.businessCategory] = (c[t.businessCategory] || 0) + 1; });
    return c;
  }, [FLY.TOPICS]);
  const ctypeCounts = useMemo(() => {
    const c = {};
    FLY.TOPICS.forEach(t => { if (t.contentType) c[t.contentType] = (c[t.contentType] || 0) + 1; });
    return c;
  }, [FLY.TOPICS]);
  const rows = FLY.TOPICS.filter(t =>
    (filter === "all" || t.status === filter) &&
    (!bcat || t.businessCategory === bcat) &&
    (!ctype || t.contentType === ctype)
  );

  return (
    <div className="page fade-in">
      <div className="page-head">
        <h1 className="page-title">选题池</h1>
        <p className="page-sub">
          理解今天为什么写这篇 —— 候选选题、评分与拒绝原因。
          {FLY.TOPICS_SCOPE === "today" ? `${FLY.DAILY} 共 ${FLY.TOPICS.length} 个候选。` : `今日暂无候选，展示最近 ${FLY.TOPICS.length} 个。`}
        </p>
      </div>

      <AuditionPanel />
      <PortfolioPanel />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
        {[["候选选题", counts.candidate || 0, "bulb", "info"], ["已选中", counts.selected || 0, "check", "brand"], ["已生成文章", counts.generated || 0, "file", "ok"], ["被拒选题", counts.rejected || 0, "x", "mut"]].map(([l, v, ic, tone]) => (
          <Card key={l} pad>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 34, height: 34, borderRadius: 9, background: `var(--${tone === "brand" ? "brand-50" : tone + "-bg"})`, color: `var(--${tone === "brand" ? "brand-600" : tone})`, display: "grid", placeItems: "center", flex: "0 0 auto" }}><Icon name={ic} size={18} /></span>
              <div>
                <div className="tnum" style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{v}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{l}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <div style={{ borderBottom: "1px solid var(--line-soft)", padding: "11px 16px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className="chip"
              style={{ cursor: "pointer", border: filter === k ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: filter === k ? "var(--brand-50)" : "var(--mut-soft)", color: filter === k ? "var(--brand-700)" : "var(--ink-2)", fontWeight: 700 }}>
              {l}<span style={{ fontSize: 11, opacity: .7 }}>{counts[k] || 0}</span>
            </button>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-3)", fontWeight: 600 }}>{rows.length} 条 · 按分数排序</span>
        </div>
        <div style={{ borderBottom: "1px solid var(--line-soft)" }}>
          <TaxTabs label="业务分类" kind="businessCategories" counts={bcatCounts} value={bcat} onChange={setBcat} />
          <TaxTabs label="内容类型" kind="contentTypes" counts={ctypeCounts} value={ctype} onChange={setCtype} />
        </div>
        {rows.length === 0 ? (
          <Empty icon="bulb" title="暂无该状态的选题" desc="运行今日流水线后，候选选题会出现在这里。" />
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>选题标题</th><th style={{ width: 90 }}>分数</th><th style={{ width: 68 }}>优先级</th>
              <th style={{ width: 84 }}>状态</th><th style={{ width: 64 }}>来源</th><th>拒绝/备注</th><th style={{ width: 90 }}></th>
            </tr></thead>
            <tbody>
              {rows.map((t) => {
                const st = FLY.topicStatus(t.status);
                const rejected = t.status === "rejected";
                return (
                  <tr key={t.id} style={{ opacity: rejected ? .72 : 1 }}>
                    <td className="row-title" style={{ maxWidth: 380 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.title}>{t.title}</div>
                      {(t.contentType || t.businessCategory) && (
                        <div style={{ display: "flex", gap: 5, marginTop: 3 }}>
                          {t.contentType && <span className="chip" style={{ height: 17, fontSize: 10, padding: "0 6px" }}>{FLY.taxLabel("contentTypes", t.contentType)}</span>}
                          {t.businessCategory && <span className="chip" style={{ height: 17, fontSize: 10, padding: "0 6px", background: "var(--brand-50)", borderColor: "var(--brand-200)", color: "var(--brand-700)" }}>{FLY.taxLabel("businessCategories", t.businessCategory)}</span>}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="tnum" style={{ fontWeight: 800, fontSize: 15, color: scoreColor(t.score), width: 24 }}>{t.score}</span>
                        <div style={{ width: 40 }}><Meter value={t.score} /></div>
                      </div>
                      {t.selectionScore != null && t.selectionScore !== t.score && (
                        <div className="tnum" style={{ fontSize: 10.5, color: t.selectionScore > t.score ? "var(--ok)" : "var(--warn)", fontWeight: 700, marginTop: 2 }} title="选择分 = 价值分×0.55 + 原始分×0.25 ± 组合奖惩">选择分 {t.selectionScore}</div>
                      )}
                    </td>
                    <td><span className="chip" style={{ height: 22, fontSize: 11.5, fontWeight: 700, color: t.priority === "P0" ? "var(--bad)" : t.priority === "P1" ? "var(--warn)" : "var(--ink-3)" }}>{t.priority}</span></td>
                    <td><Badge tone={st.tone} dot={st.tone !== "brand"}>{st.text}</Badge></td>
                    <td className="muted mono tnum" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{t.srcCount ? `${t.srcCount} 篇` : "—"}</td>
                    <td style={{ fontSize: 12, color: rejected || t.status === "deferred" ? "var(--ink-2)" : "var(--ink-4)", maxWidth: 240 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.skipReason || t.reason}>{t.skipReason || t.reason || "—"}</div>
                      {t.status === "deferred" && t.deferredUntil && <div style={{ fontSize: 10.5, color: "var(--warn)" }}>{FLY.fmtDT(t.deferredUntil).slice(0, 10)} 回池</div>}
                    </td>
                    <td>
                      {t.articleId ? <Btn kind="ghost" size="sm" iconR="chevR" onClick={() => nav("detail", { id: t.articleId })}>看文章</Btn> : <span style={{ color: "var(--ink-4)", fontSize: 12 }}>—</span>}
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

Object.assign(window, { TopicPool });
