/* ============================================================
   选题池 — Topic Pool（真实数据：FLY.TOPICS）
   ============================================================ */
function TopicPool({ nav, params }) {
  const [filter, setFilter] = useState("all");
  const TABS = [["all", "全部"], ["candidate", "候选"], ["selected", "已选中"], ["generated", "已生成"], ["rejected", "被拒"]];
  const counts = useMemo(() => {
    const c = { all: FLY.TOPICS.length };
    FLY.TOPICS.forEach(t => c[t.status] = (c[t.status] || 0) + 1);
    return c;
  }, [FLY.TOPICS]);
  const rows = FLY.TOPICS.filter(t => filter === "all" || t.status === filter);

  return (
    <div className="page fade-in">
      <div className="page-head">
        <h1 className="page-title">选题池</h1>
        <p className="page-sub">
          理解今天为什么写这篇 —— 候选选题、评分与拒绝原因。
          {FLY.TOPICS_SCOPE === "today" ? `${FLY.DAILY} 共 ${FLY.TOPICS.length} 个候选。` : `今日暂无候选，展示最近 ${FLY.TOPICS.length} 个。`}
        </p>
      </div>

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
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-3)", fontWeight: 600 }}>按分数排序</span>
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
                    <td className="row-title" style={{ maxWidth: 380 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.title}>{t.title}</div></td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="tnum" style={{ fontWeight: 800, fontSize: 15, color: scoreColor(t.score), width: 24 }}>{t.score}</span>
                        <div style={{ width: 40 }}><Meter value={t.score} /></div>
                      </div>
                    </td>
                    <td><span className="chip" style={{ height: 22, fontSize: 11.5, fontWeight: 700, color: t.priority === "P0" ? "var(--bad)" : t.priority === "P1" ? "var(--warn)" : "var(--ink-3)" }}>{t.priority}</span></td>
                    <td><Badge tone={st.tone} dot={st.tone !== "brand"}>{st.text}</Badge></td>
                    <td className="muted mono tnum" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{t.srcCount ? `${t.srcCount} 篇` : "—"}</td>
                    <td style={{ fontSize: 12, color: rejected ? "var(--ink-2)" : "var(--ink-4)", maxWidth: 240 }}><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.reason}>{t.reason || "—"}</div></td>
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
