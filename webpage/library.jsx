/* ============================================================
   文章库 — Article Library（真实数据：FLY.ARTICLES）
   ============================================================ */
function Library({ nav, params }) {
  const [filter, setFilter] = useState(params.filter || "all");
  const [sub, setSub] = useState(params.sub || ""); // 待补来源细分：human / auto
  const [time, setTime] = useState("30d");
  const [score, setScore] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => { if (params.filter) setFilter(params.filter); setSub(params.sub || ""); }, [params.filter, params.sub]);

  const STATUS_TABS = [
    ["all", "全部"], ["needs_fact_sources", "待补来源"], ["ready_for_review", "待终审"],
    ["reviewed", "已复审"], ["approved_for_publish", "批准发布"], ["published", "已发布"],
    ["rejected", "已打回"], ["archived", "已归档"],
  ];

  const counts = useMemo(() => {
    const c = { all: FLY.ARTICLES.length };
    FLY.ARTICLES.forEach(a => { c[a.status] = (c[a.status] || 0) + 1; });
    return c;
  }, [FLY.ARTICLES]);

  const rows = useMemo(() => {
    const now = Date.now();
    const span = { today: 1, "7d": 7, "30d": 30 }[time];
    return FLY.ARTICLES.filter(a => {
      if (filter !== "all" && a.status !== filter) return false;
      if (filter === "needs_fact_sources" && sub === "human" && !a.needsHuman) return false;
      if (filter === "needs_fact_sources" && sub === "auto" && a.needsHuman) return false;
      if (q && !((a.title || "").includes(q) || (a.slug || "").includes(q))) return false;
      if (time === "today" && !(a.created || "").startsWith(FLY.DAILY)) return false;
      else if (span && time !== "today") {
        const t = new Date((a.created || "").replace(" ", "T")).getTime();
        if (!isNaN(t) && now - t > span * 86400000) return false;
      }
      if (score === "q85" && a.quality < 85) return false;
      if (score === "seo80" && a.seo < 80) return false;
      if (score === "geo80" && a.geo < 80) return false;
      return true;
    });
  }, [filter, sub, q, time, score, FLY.ARTICLES]);

  const filterLabel = STATUS_TABS.find(t => t[0] === filter)?.[1];

  return (
    <div className="page fade-in">
      <div className="page-head">
        <h1 className="page-title">文章库</h1>
        <p className="page-sub">查找、筛选并进入文章详情。共 {FLY.ARTICLES.length} 篇文章。</p>
      </div>

      {/* Filters */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div className="search" style={{ flex: "1 1 240px", maxWidth: 320 }}>
            <Icon name="search" size={16} />
            <input className="inp" placeholder="搜索标题、slug…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <select className="inp" style={{ width: "auto", minWidth: 120 }} value={time} onChange={e => setTime(e.target.value)}>
            <option value="today">今天</option><option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option><option value="all">全部时间</option>
          </select>
          <select className="inp" style={{ width: "auto", minWidth: 130 }} value={score} onChange={e => setScore(e.target.value)}>
            <option value="">全部分数</option><option value="q85">质量分 ≥ 85</option>
            <option value="seo80">SEO ≥ 80</option><option value="geo80">GEO ≥ 80</option>
          </select>
          <div style={{ marginLeft: "auto", color: "var(--ink-3)", fontSize: 12.5, fontWeight: 600 }}>{rows.length} 条结果</div>
        </div>
        <div style={{ borderTop: "1px solid var(--line-soft)", padding: "10px 16px", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUS_TABS.map(([k, label]) => (
            <button key={k} onClick={() => { setFilter(k); setSub(""); }}
              className="chip" style={{ cursor: "pointer", border: filter === k ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: filter === k ? "var(--brand-50)" : "var(--mut-soft)", color: filter === k ? "var(--brand-700)" : "var(--ink-2)", fontWeight: 700 }}>
              {label}
              {counts[k] != null && <span style={{ fontSize: 11, opacity: .7 }}>{counts[k]}</span>}
            </button>
          ))}
          {filter === "needs_fact_sources" && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8, paddingLeft: 12, borderLeft: "1px solid var(--line)" }}>
              {[["", "全部"], ["human", "需人工"], ["auto", "自动补源中"]].map(([k, l]) => (
                <button key={k} onClick={() => setSub(k)} className="chip"
                  style={{ cursor: "pointer", height: 24, fontSize: 11.5, border: sub === k ? "1px solid var(--warn-line)" : "1px solid var(--line)", background: sub === k ? "var(--warn-soft)" : "var(--mut-soft)", color: sub === k ? "var(--warn)" : "var(--ink-3)", fontWeight: 700 }}>{l}</button>
              ))}
            </span>
          )}
        </div>
      </Card>

      {/* List */}
      <Card>
        {rows.length === 0 ? (
          q ? <Empty icon="search" title="没有符合当前筛选条件的文章" desc="试着调整筛选状态、时间范围或清空搜索关键词。" action={<Btn kind="ghost" onClick={() => { setQ(""); setFilter("all"); setTime("all"); }}>清空筛选</Btn>} />
            : filter === "ready_for_review" ? <Empty icon="checkCircle" title="当前没有需要人工处理的文章" desc="所有待终审文章都已处理完毕。" />
            : <Empty icon="docs" title={`暂无「${filterLabel}」状态的文章`} desc="换个筛选条件，或先运行今日流水线生成文章。" action={<Btn kind="pri" icon="home" onClick={() => nav("dashboard")}>去今日看板</Btn>} />
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>标题</th><th style={{ width: 92 }}>状态</th><th style={{ width: 66 }}>质量分</th>
              <th style={{ width: 88 }}>事实状态</th><th style={{ width: 96 }}>SEO/GEO</th>
              <th style={{ width: 116 }} title="三个发布渠道的改写稿状态：公众号 / 抖音 / 小红书">渠道稿<span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, marginLeft: 4, color: "var(--ink-4)" }}>公/抖/红</span></th><th style={{ width: 100 }}>更新时间</th><th style={{ width: 120 }}></th>
            </tr></thead>
            <tbody>
              {rows.map(a => {
                const st = FLY.artStatus(a.status);
                return (
                  <tr key={a.id} className="clickable" onClick={() => nav("detail", { id: a.id })}>
                    <td className="row-title" style={{ maxWidth: 340 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 500, marginTop: 2 }}>{a.slug}{a.priority && a.priority !== "—" ? ` · ${a.priority}` : ""}</div>
                    </td>
                    <td><Badge tone={st.tone}>{st.text}</Badge></td>
                    <td><Score value={a.quality} /></td>
                    <td>
                      <Badge tone={a.fact === "publish" ? "ok" : a.fact === "needs" ? "warn" : a.fact === "failed" ? "bad" : "mut"} dot={false}>{a.factText}</Badge>
                      {a.needsHuman && <div style={{ fontSize: 10.5, color: "var(--warn)", fontWeight: 700, marginTop: 3 }}>需人工介入</div>}
                    </td>
                    <td>{a.seo ? <span className="tnum" style={{ fontWeight: 700, fontSize: 13 }}><span style={{ color: scoreColor(a.seo) }}>{a.seo}</span><span style={{ color: "var(--ink-4)" }}> / </span><span style={{ color: scoreColor(a.geo) }}>{a.geo}</span></span> : <span style={{ color: "var(--ink-4)" }}>—</span>}</td>
                    <td><ChannelDots ch={a.channels} /></td>
                    <td className="muted mono" style={{ fontSize: 12 }}>{(a.updated || "").slice(5)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      {a.status === "ready_for_review"
                        ? <Btn kind="pri" size="sm" onClick={() => nav("detail", { id: a.id })}>终审</Btn>
                        : a.status === "rejected"
                        ? <Btn kind="ghost" size="sm" icon="flag" onClick={() => nav("detail", { id: a.id })}>打回原因</Btn>
                        : <Btn kind="ghost" size="sm" icon="eye" onClick={() => nav("detail", { id: a.id })}>查看</Btn>}
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

function ChannelDots({ ch }) {
  const map = [["wechat", "公"], ["douyin", "抖"], ["xhs", "红"]];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {map.map(([k, label]) => {
        const s = ch[k] || "pending";
        const tone = s === "success" ? "ok" : s === "fail" ? "bad" : "mut";
        const meta = FLY.CH_STATUS[s] || { text: s };
        return <span key={k} title={FLY.CHANNEL_META[k] + "：" + meta.text}
          style={{ width: 22, height: 22, borderRadius: 6, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, background: `var(--${tone}-bg)`, color: `var(--${tone})`, border: `1px solid var(--${tone}-line)` }}>{label}</span>;
      })}
    </div>
  );
}

Object.assign(window, { Library, ChannelDots });
