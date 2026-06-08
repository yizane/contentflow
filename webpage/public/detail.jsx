/* ============================================================
   文章详情 — Article Detail (review hub)，数据来自 /api/ui/article/:id
   ============================================================ */
function StatusFlow({ status }) {
  const flow = FLY.STATUS_FLOW;
  const isRejected = status === "rejected" || status === "fact_check_failed" || status === "validation_failed";
  const isArchived = status === "archived";
  let curIdx = flow.indexOf(status);
  if (isRejected || isArchived) curIdx = flow.indexOf("ready_for_review");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
      {flow.map((s, i) => {
        const m = FLY.artStatus(s);
        const done = i < curIdx, cur = i === curIdx && !isRejected && !isArchived;
        return (
          <React.Fragment key={s}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999,
              background: cur ? "var(--ok-bg)" : "transparent",
              color: cur ? "var(--ok)" : done ? "var(--ink-2)" : "var(--ink-4)",
              fontWeight: cur ? 800 : 600, fontSize: 12.5, border: cur ? "1px solid var(--ok-line)" : "1px solid transparent" }}>
              {done && <Icon name="check" size={13} />}{m.text}
            </span>
            {i < flow.length - 1 && <Icon name="chevR" size={13} style={{ color: "var(--ink-4)", margin: "0 1px" }} />}
          </React.Fragment>
        );
      })}
      {(isRejected || isArchived) && <>
        <Icon name="chevR" size={13} style={{ color: "var(--bad)", margin: "0 4px" }} />
        <span className={`badge ${isArchived ? "bg-mut" : "bg-bad"}`}>{FLY.artStatus(status).text}</span>
      </>}
    </div>
  );
}

function SummaryHead({ a }) {
  const st = FLY.artStatus(a.status);
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
          <Badge tone={st.tone} lg>{st.text}</Badge>
          {a.topicScore != null && <span className="chip" style={{ height: 24, whiteSpace: "nowrap" }}>{a.priority} · 选题 {a.topicScore} 分</span>}
          {a.contentType && <span className="chip" style={{ height: 24, whiteSpace: "nowrap" }} title="内容类型">{FLY.taxLabel("contentTypes", a.contentType)}</span>}
          {a.businessCategory && <span className="chip" style={{ height: 24, whiteSpace: "nowrap", background: "var(--brand-50)", borderColor: "var(--brand-200)", color: "var(--brand-700)" }} title="业务分类">{FLY.taxLabel("businessCategories", a.businessCategory)}</span>}
          {a.topicCluster && <span className="chip" style={{ height: 24, whiteSpace: "nowrap" }} title="主题簇">{FLY.taxLabel("topicClusters", a.topicCluster)}</span>}
          <span className="mono" style={{ fontSize: 12, color: "var(--ink-4)" }}>{a.slug}</span>
        </div>
        {a.classification && (
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 9, lineHeight: 1.5 }}>
            分类{a.classification.classifierType === "rules" ? "（规则判定）" : a.classification.classifierType === "openclaw" ? "（AI 判定）" : a.classification.classifierType === "inherited" ? "（继承自选题）" : ""}
            {a.classification.confidence != null && <>　置信度 <b className="tnum" style={{ color: a.classification.confidence >= 0.8 ? "var(--ok)" : a.classification.confidence >= 0.6 ? "var(--warn)" : "var(--bad)" }}>{(a.classification.confidence * 100).toFixed(0)}%</b></>}
            {a.classification.reason && <>　· {a.classification.reason}</>}
          </div>
        )}
        <h1 style={{ margin: "0 0 14px", fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.3, textWrap: "pretty" }}>{a.title}</h1>
        <StatusFlow status={a.status} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 0, marginTop: 16, border: "1px solid var(--line)", borderRadius: 11, overflow: "hidden" }}>
          {[
            ["主评分", a.articleQualityScore != null
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Score value={a.articleQualityScore} />{a.articleQualityScore < 80 && <Icon name="alert" size={13} style={{ color: "var(--bad)" }} title="低于 80，不得进入终审" />}</span>
              : <span style={{ color: "var(--ink-4)", fontWeight: 700 }}>未评</span>],
            ["质量门", <Score value={a.quality} />],
            ["事实核查", <Badge tone={a.fact === "publish" ? "ok" : a.fact === "needs" ? "warn" : a.fact === "failed" ? "bad" : "mut"} dot={false}>{a.factText}</Badge>],
            ["SEO / GEO", a.seo ? <span className="tnum" style={{ fontWeight: 800, fontSize: 15 }}><span style={{ color: scoreColor(a.seo) }}>{a.seo}</span> / <span style={{ color: scoreColor(a.geo) }}>{a.geo}</span></span> : <span style={{ color: "var(--ink-4)", fontWeight: 700 }}>未评分</span>],
            ["综合分", a.overall ? <Score value={a.overall} /> : <span style={{ color: "var(--ink-4)", fontWeight: 700 }}>—</span>],
            ["字数", <span className="tnum" style={{ fontWeight: 800, fontSize: 15 }}>{(a.words || 0).toLocaleString()}</span>],
            ["版本", <span className="tnum" style={{ fontWeight: 800, fontSize: 15 }}>{a.versions[0].label}</span>],
          ].map(([label, val], i) => (
            <div key={i} style={{ padding: "11px 16px", borderLeft: i ? "1px solid var(--line-soft)" : "none" }}>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", fontWeight: 600, marginBottom: 5 }}>{label}</div>
              <div>{val}</div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/* ---------- Review action bar ---------- */
function ReviewBar({ busy, onPass, onReject, gotoChannels }) {
  return (
    <div style={{ position: "sticky", bottom: 0, marginTop: 16, background: "var(--surface)", border: "1px solid var(--brand-200)", borderRadius: 14, boxShadow: "var(--sh-lg)", padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, zIndex: 10 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--brand-50)", color: "var(--brand-600)", display: "grid", placeItems: "center", flex: "0 0 auto" }}><Icon name="flag" size={18} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>这篇文章待你终审</div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>阅读正文与渠道稿后，选择通过或打回。打回需填写原因。</div>
      </div>
      <Btn kind="ghost" icon="share" onClick={gotoChannels}>查看渠道稿</Btn>
      <Btn kind="danger" icon="x" disabled={busy} onClick={onReject}>打回</Btn>
      <Btn kind="pri" icon="check" disabled={busy} onClick={onPass}>通过</Btn>
    </div>
  );
}

function ArticleDetail({ nav, params, toast, onChanged }) {
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(params.tab || "body");
  const [version, setVersion] = useState(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [reject, setReject] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true; // 防止快速切换时旧请求后到覆盖新页面
    setA(null); setError(null); setTab(params.tab || "body");
    FLY.loadArticle(params.id).then((art) => {
      if (!alive) return;
      setA(art);
      setVersion((art.versions.find(v => v.current) || art.versions[0]).label);
    }).catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [params.id]);

  if (error) return (
    <div className="page fade-in" style={{ maxWidth: 1080 }}>
      <button className="btn btn-soft btn-sm" style={{ marginBottom: 14 }} onClick={() => nav("library")}><Icon name="arrowL" size={15} />返回文章库</button>
      <Card><Empty icon="xCircle" title="文章加载失败" desc={String(error.message || error)} action={<Btn kind="pri" onClick={() => nav("library")}>返回文章库</Btn>} /></Card>
    </div>
  );
  if (!a) return (
    <div className="page fade-in" style={{ maxWidth: 1080 }}>
      <Card><Empty icon="clock" title="正在加载文章…" desc="从数据库读取文章详情。" /></Card>
    </div>
  );

  const TABS = [
    ["body", "正文", "doc2"],
    ["quality", "质量报告", "checkCircle"],
    ["visual", "视觉规划", "eye", (a.visualPlan || []).length || null],
    ["fact", "事实核查", "shield", a.fact === "needs" ? a.sources.filter(s => s.status !== "resolved").length : null],
    ["sources", "来源补全", "link"],
    ["channels", "渠道稿", "share"],
    ["score", "SEO/GEO", "gauge"],
    ["history", "历史", "history"],
    ["ai", "AI 调用记录", "code"],
  ];

  const curVer = a.versions.find(v => v.label === version) || a.versions[0];
  const showReview = a.status === "ready_for_review";

  async function mark(status, note) {
    setBusy(true);
    try {
      await FLY.review(a.id, status, note);
      const updated = await FLY.loadArticle(a.id, true);
      setA(updated);
      onChanged && onChanged();
      toast(status === "rejected" ? "已打回 · " + (note || "") : "已通过 · 文章标记为已复审",
        { icon: status === "rejected" ? "xCircle" : "checkCircle", color: status === "rejected" ? "var(--bad-solid)" : "var(--ok-solid)" });
    } catch (e) {
      toast("操作失败：" + e.message, { icon: "xCircle", color: "var(--bad-solid)" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page fade-in" style={{ maxWidth: 1080 }}>
      <button className="btn btn-soft btn-sm" style={{ marginBottom: 14 }} onClick={() => nav("library")}><Icon name="arrowL" size={15} />返回文章库</button>

      <SummaryHead a={a} />

      {a.status === "rejected" && a.rejectNote != null && (
        <div className="fade-in" style={{ display: "flex", gap: 11, padding: "14px 16px", marginBottom: 16, background: "var(--bad-soft)", border: "1px solid var(--bad-line)", borderRadius: 12 }}>
          <Icon name="xCircle" size={18} style={{ color: "var(--bad)", flex: "0 0 auto", marginTop: 1 }} />
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
            <b style={{ color: "var(--bad)" }}>已打回</b> <span className="muted">— {a.rejectBy || "审核人"} · {a.rejectAt || ""}</span>
            <div style={{ marginTop: 3 }}>{a.rejectNote || "未填写打回说明"}</div>
          </div>
        </div>
      )}

      <Card>
        <div style={{ padding: "0 8px", overflowX: "auto" }}>
          <div className="tabs" style={{ minWidth: 720 }}>
            {TABS.map(([k, label, icon, count]) => (
              <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>
                <Icon name={icon} size={15} />{label}
                {count != null && count > 0 && <span className="t-count">{count}</span>}
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding: "22px 24px" }}>
          {tab === "body" && <BodyTab a={a} version={version} setVersion={setVersion} curVer={curVer} />}
          {tab === "quality" && <QualityTab a={a} />}
          {tab === "visual" && <VisualPlanTab a={a} toast={toast} />}
          {tab === "fact" && <FactTab a={a} />}
          {tab === "sources" && <SourcesTab a={a} />}
          {tab === "channels" && <ChannelsTab a={a} toast={toast} />}
          {tab === "score" && <ScoreTab a={a} />}
          {tab === "history" && <HistoryTab a={a} />}
          {tab === "ai" && <AiTab a={a} open={debugOpen} setOpen={setDebugOpen} />}
        </div>
      </Card>

      {showReview && <ReviewBar busy={busy}
        gotoChannels={() => setTab("channels")}
        onPass={() => mark("reviewed")}
        onReject={() => setReject(true)} />}

      {reject && <RejectModal onClose={() => setReject(false)} onConfirm={(reason, note) => { setReject(false); mark("rejected", note ? `${reason}：${note}` : reason); }} />}
    </div>
  );
}

/* ---------- Body ---------- */
function BodyTab({ a, version, setVersion, curVer }) {
  const html = useMemo(() => FLY.mdToHtml(curVer.body), [curVer.label, a.id]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-3)" }}>版本</span>
        <div className="seg">
          {a.versions.map(v => (
            <button key={v.label} className={version === v.label ? "on" : ""} onClick={() => setVersion(v.label)}>
              {v.label}{v.current ? " · 最新" : ""}
            </button>
          ))}
        </div>
        <span className="mono" style={{ fontSize: 12, color: "var(--ink-4)" }}>{curVer.strategy} · {curVer.created} · {(curVer.words || 0).toLocaleString()} 字</span>
      </div>
      {curVer.body
        ? <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        : <Empty icon="docs" title="该版本暂无正文" desc="文章正文尚未生成或未入库。" />}
    </div>
  );
}

/* ---------- Quality ---------- */
function QualityTab({ a }) {
  const verdict = { publish: ["可发布", "ok"], revise: ["建议修订", "warn"], reject: ["不通过", "bad"] }[a.qualityVerdict] || [a.qualityVerdict, "mut"];
  if (!a.qualityDims.length && !a.articleQuality) return <Empty icon="checkCircle" title="暂无质量报告" desc="该文章尚未经过质量评估。" />;
  return (
    <div>
      {a.articleQuality && (
        <div style={{ marginBottom: 26, padding: "16px 18px", border: `1px solid ${a.articleQuality.score >= 80 ? "var(--ok-line)" : "var(--bad-line)"}`, borderRadius: 12, background: a.articleQuality.score >= 80 ? "var(--ok-soft)" : "var(--bad-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800, fontSize: 14 }}>文章质量主评分</span>
            <span className="tnum" style={{ fontSize: 30, fontWeight: 800, color: scoreColor(a.articleQuality.score) }}>{a.articleQuality.score}</span>
            <Badge tone={a.articleQuality.score >= 88 ? "ok" : a.articleQuality.score >= 80 ? "ok" : a.articleQuality.score >= 70 ? "warn" : "bad"} dot={false}>
              {{ excellent: "优秀", good: "良好", revise: "需修订", reject: "不通过" }[a.articleQuality.recommendation] || a.articleQuality.recommendation}
            </Badge>
            <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>主评分 ≥ 80 才能进终审；SEO/GEO 是辅助建议线，不能覆盖质量不足</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "9px 26px" }}>
            {a.articleQuality.breakdown.map(([dim, score, max]) => (
              <div key={dim} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12.5, width: 92, color: "var(--ink-2)" }}>{dim}</span>
                <div style={{ flex: 1 }}><Meter value={score} max={max} /></div>
                <span className="tnum" style={{ fontSize: 12, fontWeight: 700, width: 38, textAlign: "right" }}>{score}/{max}</span>
              </div>
            ))}
          </div>
          {a.articleQuality.mustFix.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--bad)", lineHeight: 1.6 }}>
              <b>必须修复：</b>{a.articleQuality.mustFix.map((m, i) => <div key={i}>· {m}</div>)}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 22, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span className="tnum" style={{ fontSize: 44, fontWeight: 800, letterSpacing: "-.03em", color: scoreColor(a.quality) }}>{a.quality}</span>
          <span style={{ color: "var(--ink-4)", fontWeight: 700 }}>/100</span>
        </div>
        <div>
          <Badge tone={verdict[1]} lg>结论：{verdict[0]}</Badge>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>{a.qualityDims.length} 个维度综合评估</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 28px", marginBottom: 22 }}>
        {a.qualityDims.map(([dim, score, max]) => (
          <div key={dim}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{dim}</span>
              <span className="tnum" style={{ fontWeight: 800, color: scoreColor(Math.round(score / max * 100)) }}>{score}<span style={{ color: "var(--ink-4)", fontWeight: 600 }}>/{max}</span></span>
            </div>
            <Meter value={score} max={max} />
          </div>
        ))}
      </div>
      {a.qualityIssues.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>问题清单</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {a.qualityIssues.map((iss, i) => (
              <div key={i} style={{ display: "flex", gap: 9, padding: "10px 13px", background: `var(--${iss.level}-soft)`, border: `1px solid var(--${iss.level}-line)`, borderRadius: 9 }}>
                <Icon name={iss.level === "bad" ? "xCircle" : iss.level === "warn" ? "alert" : "dot"} size={16} style={{ color: `var(--${iss.level === "info" ? "info" : iss.level})`, flex: "0 0 auto", marginTop: 1 }} />
                <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{iss.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Fact check ---------- */
function FactTab({ a }) {
  if (!a.factRounds.length) return <Empty icon="shield" title="暂无事实核查记录" desc="该文章尚未进入事实核查环节。" />;
  return (
    <div>
      {a.sourceAuto && (
        <div style={{ display: "flex", gap: 11, padding: "13px 15px", marginBottom: 18, background: "var(--info-soft)", border: "1px solid var(--info-line)", borderRadius: 11 }}>
          <span className="spin" style={{ display: "flex", color: "var(--info)", flex: "0 0 auto", marginTop: 1 }}><Icon name="refresh" size={17} /></span>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
            <b style={{ color: "var(--info)" }}>来源补全进行中（第 {a.sourceAuto.round} / {a.sourceAuto.max} 轮）</b>
            <div style={{ marginTop: 2 }}>{a.sourceAuto.note}</div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {a.factRounds.map((r, i) => (
          <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", background: r.ready ? "var(--ok-soft)" : "var(--surface-2)" }}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>{r.v}</span>
              <Badge tone={r.ready ? "ok" : "warn"} dot={false}>{r.ready ? "发布就绪" : "待补来源"}</Badge>
              {r.at && <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{r.at}</span>}
              <div style={{ marginLeft: "auto", display: "flex", gap: 18 }}>
                {[["表述总数", r.total, "mut"], ["高风险", r.high, r.high > 0 ? "bad" : "mut"], ["必修", r.must, r.must > 0 ? "warn" : "mut"]].map(([k, v, tone]) => (
                  <div key={k} style={{ textAlign: "center" }}>
                    <div className="tnum" style={{ fontWeight: 800, fontSize: 17, color: v > 0 && tone !== "mut" ? `var(--${tone})` : "var(--ink)" }}>{v}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-3)", fontWeight: 600 }}>{k}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: "11px 16px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>{r.note}</div>
          </div>
        ))}
      </div>
      {a.sources.some(s => s.status === "needs_human") && (
        <div style={{ display: "flex", gap: 11, padding: "13px 15px", marginTop: 16, background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 11 }}>
          <Icon name="user" size={17} style={{ color: "var(--warn)", flex: "0 0 auto", marginTop: 1 }} />
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
            <b style={{ color: "var(--warn)" }}>需要人工介入</b>
            <div style={{ marginTop: 2 }}>有 {a.sources.filter(s => s.status === "needs_human").length} 条表述无法自动补齐权威来源，请到「来源补全」处理或在终审时判断。</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Sources ---------- */
function SourcesTab({ a }) {
  if (a.sources.length === 0) return <Empty icon="checkCircle" title="无需补充来源" desc="本文没有待补来源的表述记录。" />;
  const SS = { resolved: ["已补齐", "ok"], resolving: ["补源中", "info"], needs_human: ["需人工", "warn"] };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {a.sources.map((s, i) => {
        const ss = SS[s.status] || [s.status, "mut"];
        return (
          <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
              <Badge tone={ss[1]}>{ss[0]}</Badge>
              <span style={{ fontSize: 11.5, color: "var(--ink-4)", fontWeight: 600 }}>待修表述 #{i + 1}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: "9px 14px", fontSize: 13, lineHeight: 1.55 }}>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>原表述</span><span style={{ color: "var(--ink)" }}>{s.claim}</span>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>权威来源</span>
              <span style={{ color: s.found === "—" ? "var(--ink-4)" : "var(--ink)" }}>
                {s.found === "—" ? "未找到可核实来源" : (s.url ? <a href={s.url} target="_blank" rel="noopener" className="link">{s.found} <Icon name="ext" size={12} style={{ verticalAlign: "-1px" }} /></a> : s.found)}
              </span>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>建议改写</span><span style={{ color: "var(--ink-2)" }}>{s.suggest}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Channels ---------- */
function ChannelsTab({ a, toast }) {
  const [active, setActive] = useState(a.channelOutputs[0].ch);
  const cur = a.channelOutputs.find(c => c.ch === active) || a.channelOutputs[0];
  const copyBody = () => {
    navigator.clipboard.writeText(cur.body || "").then(
      () => toast("已复制到剪贴板", { icon: "copy", color: "var(--info-solid)" }),
      () => toast("复制失败", { icon: "xCircle", color: "var(--bad-solid)" })
    );
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {a.channelOutputs.map(c => {
          const ss = FLY.CH_STATUS[c.status] || { text: c.status, tone: "mut" };
          return (
            <button key={c.ch} onClick={() => setActive(c.ch)}
              style={{ flex: "1 1 150px", textAlign: "left", border: active === c.ch ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: active === c.ch ? "var(--brand-50)" : "var(--surface)", borderRadius: 11, padding: "12px 14px", cursor: "pointer", transition: "all .12s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.name}</span>
                <Badge tone={ss.tone} dot={false}>{ss.text}</Badge>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{c.status === "success" ? `${c.words} 字` : c.status === "fail" ? "生成失败" : "尚未生成"}</div>
            </button>
          );
        })}
      </div>
      {cur.status === "success" ? (
        <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line-soft)", background: "var(--surface-2)" }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{cur.title || cur.name}</span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)", marginLeft: "auto" }}>{cur.words} 字</span>
            <Btn kind="ghost" size="sm" icon="copy" onClick={copyBody}>复制</Btn>
          </div>
          <div className="prose" style={{ padding: "16px" }} dangerouslySetInnerHTML={{ __html: FLY.mdToHtml(cur.body) }} />
        </div>
      ) : cur.status === "fail" ? (
        <div style={{ border: "1px solid var(--bad-line)", borderRadius: 12, padding: "20px 18px", background: "var(--bad-soft)", display: "flex", gap: 11 }}>
          <Icon name="xCircle" size={18} style={{ color: "var(--bad)", flex: "0 0 auto", marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 700, color: "var(--bad)", fontSize: 13.5 }}>{cur.name}生成失败</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>{cur.error || "渠道改写调用失败。"}该失败<b>仅影响本渠道</b>，其他渠道与正文不受影响。可通过 <code className="mono">npm run channels:generate</code> 重新生成。</div>
          </div>
        </div>
      ) : (
        <Empty icon="clock" title={`${cur.name}尚未生成`} desc="文章通过事实核查后，渠道稿会自动生成。" />
      )}
    </div>
  );
}

/* ---------- 视觉规划 ---------- */
const VISUAL_TYPE_ZH = {
  diagram: "示意图", table_image: "表格图", checklist_card: "清单卡片", process_flow: "流程图",
  comparison_chart: "对比图", screenshot_placeholder: "截图占位", data_chart: "数据图表",
};
function VisualPlanTab({ a, toast }) {
  const vp = a.visualPlan || [];
  if (!vp.length) return <Empty icon="eye" title="暂无视觉规划" desc="旧版本文章缺 visualPlan；下次修订（sources:fix）会自动补全 ≥2 个视觉规划。新生成的文章会自带。" />;
  const copy = (text) => navigator.clipboard.writeText(text).then(
    () => toast("imagePrompt 已复制", { icon: "copy", color: "var(--info-solid)" }),
    () => toast("复制失败", { icon: "xCircle", color: "var(--bad-solid)" }));
  return (
    <div>
      <div style={{ display: "flex", gap: 9, padding: "11px 14px", marginBottom: 16, background: "var(--info-soft)", border: "1px solid var(--info-line)", borderRadius: 10, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        <Icon name="eye" size={15} style={{ color: "var(--info)", flex: "0 0 auto", marginTop: 1 }} />
        共 {vp.length} 个视觉规划（{vp.filter(v => v.required).length} 个必需）。系统只输出 brief / alt / caption / 生图提示，不自动生成图片——交给设计师或 AI 生图工具。正文中的「[配图建议 …]」引用块即对应占位。
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {vp.map((v, i) => (
          <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 15px", background: "var(--surface-2)", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)", fontWeight: 700 }}>{v.id}</span>
              <span className="chip" style={{ height: 22, fontSize: 11.5, background: "var(--brand-50)", borderColor: "var(--brand-200)", color: "var(--brand-700)" }}>{VISUAL_TYPE_ZH[v.visualType] || v.visualType}</span>
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>{v.title}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{v.placement}</span>
              {v.required && <Badge tone="warn" dot={false}>必需</Badge>}
              <Btn kind="ghost" size="sm" icon="copy" style={{ marginLeft: "auto" }} onClick={() => copy(v.imagePrompt || "")}>复制生图提示</Btn>
            </div>
            <div style={{ padding: "13px 15px", display: "grid", gridTemplateColumns: "88px 1fr", gap: "8px 14px", fontSize: 13, lineHeight: 1.55 }}>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>用途</span><span>{v.purpose}</span>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>内容描述</span><span style={{ color: "var(--ink-2)" }}>{v.description}</span>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>caption</span><span style={{ color: "var(--ink-2)" }}>{v.caption}</span>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>altText</span><span style={{ color: "var(--ink-2)" }}>{v.altText}</span>
              <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>生图提示</span><span className="mono" style={{ fontSize: 12, color: "var(--ink-2)", background: "var(--mut-soft)", padding: "6px 9px", borderRadius: 6 }}>{v.imagePrompt}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- SEO/GEO ---------- */
function ScoreTab({ a }) {
  if (a.seoSkip) return (
    <div style={{ border: "1px dashed var(--line-strong)", borderRadius: 12, padding: "28px 22px", textAlign: "center", background: "var(--mut-soft)" }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: "var(--mut-bg)", color: "var(--ink-4)", display: "grid", placeItems: "center", margin: "0 auto 12px" }}><Icon name="gauge" size={22} /></div>
      <Badge tone="mut">已跳过评分</Badge>
      <p style={{ margin: "10px auto 0", maxWidth: 360, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>{a.seoSkip}</p>
    </div>
  );
  return (
    <div>
      <div style={{ display: "flex", gap: 0, marginBottom: 22, border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
        {[["SEO 总分", a.seo], ["GEO 总分", a.geo], ["综合分", a.overall]].map(([k, v], i) => (
          <div key={k} style={{ flex: 1, padding: "16px 18px", borderLeft: i ? "1px solid var(--line-soft)" : "none", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 600, marginBottom: 4 }}>{k}</div>
            <span className="tnum" style={{ fontSize: 30, fontWeight: 800, color: v ? scoreColor(v) : "var(--ink-4)" }}>{v || "—"}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
        {[["SEO 明细", a.seoItems], ["GEO 明细", a.geoItems]].map(([title, items]) => (
          <div key={title}>
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 12 }}>{title}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {items.map(([dim, s, max]) => (
                <div key={dim} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12.5, width: 90, color: "var(--ink-2)" }}>{dim}</span>
                  <div style={{ flex: 1 }}><Meter value={s} max={max} /></div>
                  <span className="tnum" style={{ fontSize: 12, fontWeight: 700, width: 38, textAlign: "right", color: s / max >= .8 ? "var(--ok)" : s / max >= .6 ? "var(--warn)" : "var(--bad)" }}>{s}/{max}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {a.seoDeduct.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>关键扣分项</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {a.seoDeduct.map((d, i) => <span key={i} className="chip" style={{ background: "var(--warn-soft)", border: "1px solid var(--warn-line)", color: "var(--warn)", height: "auto", padding: "5px 10px", whiteSpace: "normal", lineHeight: 1.4 }}><Icon name="alert" size={13} style={{ flex: "0 0 auto" }} />{d}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- History ---------- */
function HistoryTab({ a }) {
  if (!a.history.length) return <Empty icon="history" title="暂无状态历史" desc="该文章还没有状态流转记录。" />;
  return (
    <div style={{ position: "relative", paddingLeft: 8 }}>
      {a.history.map((h, i) => {
        const m = FLY.artStatus(h.to);
        const isLast = i === a.history.length - 1;
        return (
          <div key={i} style={{ display: "flex", gap: 14, position: "relative" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto" }}>
              <span style={{ width: 11, height: 11, borderRadius: "50%", background: `var(--${m.tone || "mut"}-solid)`, border: "2px solid var(--surface)", boxShadow: "0 0 0 1.5px var(--line)", zIndex: 1, marginTop: 4 }} />
              {!isLast && <span style={{ width: 2, flex: 1, background: "var(--line)", minHeight: 26 }} />}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 18, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 600 }}>{h.t}</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{h.actor}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                  {h.from !== "—" && <>{FLY.artStatus(h.from).text} <Icon name="chevR" size={11} style={{ verticalAlign: "middle" }} /> </>}
                  <b style={{ color: `var(--${m.tone || "mut"})` }}>{m.text}</b>
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 3 }}>{h.reason}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- AI runs (debug, collapsed) ---------- */
function AiTab({ a, open, setOpen }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 11, padding: "13px 15px", marginBottom: 16, background: "var(--mut-soft)", border: "1px solid var(--line)", borderRadius: 11 }}>
        <Icon name="code" size={17} style={{ color: "var(--ink-3)", flex: "0 0 auto", marginTop: 1 }} />
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, flex: 1 }}>
          <b style={{ color: "var(--ink)" }}>高级信息 · 仅调试/管理员可见</b>
          <div style={{ marginTop: 2 }}>此处仅展示模型调用摘要。prompt 全文与原始回复默认不展示。</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>{open ? "收起" : "展开摘要"}<Icon name={open ? "chevD" : "chevR"} size={14} /></button>
      </div>
      {a.modelRuns.length === 0 ? (
        <Empty icon="code" title="暂无模型调用记录" desc="该文章没有关联到 model_runs 记录。" />
      ) : open ? (
        <table className="tbl">
          <thead><tr><th>任务类型</th><th>模型</th><th style={{ width: 72 }}>状态</th><th style={{ width: 64 }}>耗时</th><th style={{ width: 90 }}>prompt 字数</th><th style={{ width: 110 }}>response 字数</th></tr></thead>
          <tbody>
            {a.modelRuns.map((m, i) => (
              <tr key={i}>
                <td style={{ fontSize: 12.5, fontWeight: 600 }}>{FLY.ZH_TASK[m.task] || m.task}<div className="mono muted" style={{ fontSize: 10.5 }}>{m.task}</div></td>
                <td className="mono muted" style={{ fontSize: 12 }}>{m.model}</td>
                <td><Badge tone={m.status === "success" || m.status === "succeeded" ? "ok" : "bad"} dot={false}>{m.status === "success" || m.status === "succeeded" ? "成功" : "失败"}</Badge></td>
                <td className="mono" style={{ fontSize: 12 }}>{m.dur}</td>
                <td className="mono tnum muted" style={{ fontSize: 12 }}>{(m.pin || 0).toLocaleString()}</td>
                <td className="mono tnum muted" style={{ fontSize: 12 }}>{m.pout ? m.pout.toLocaleString() : <span style={{ color: "var(--bad)" }}>{m.error || "0"}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ textAlign: "center", padding: "20px", color: "var(--ink-4)", fontSize: 13 }}>共 {a.modelRuns.length} 条模型调用记录，点击「展开摘要」查看。</div>
      )}
    </div>
  );
}

/* ---------- Reject modal ---------- */
function RejectModal({ onClose, onConfirm }) {
  const QUICK = ["事实不充分", "表达不合适", "选题不适合", "结构问题", "其他"];
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  return (
    <Modal tone="bad" title="打回文章" wide onClose={onClose}
      footer={<>
        <Btn kind="ghost" onClick={onClose}>取消</Btn>
        <Btn kind="danger-solid" icon="x" disabled={!reason} onClick={() => reason && onConfirm(reason, note)}>确认打回</Btn>
      </>}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)", marginBottom: 9 }}>打回原因 <span style={{ color: "var(--bad)" }}>*</span></div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {QUICK.map(r => (
            <button key={r} onClick={() => setReason(r)} className="chip"
              style={{ cursor: "pointer", border: reason === r ? "1px solid var(--bad-line)" : "1px solid var(--line)", background: reason === r ? "var(--bad-soft)" : "var(--mut-soft)", color: reason === r ? "var(--bad)" : "var(--ink-2)", fontWeight: 700 }}>{r}</button>
          ))}
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)", marginBottom: 8 }}>详细说明</div>
        <textarea className="inp" style={{ height: 84, padding: "9px 12px", resize: "vertical", lineHeight: 1.5 }} placeholder="补充说明打回理由，便于后续修订…" value={note} onChange={e => setNote(e.target.value)} />
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 12 }}>确认后文章将进入「已打回」状态，并写入审计记录。</div>
    </Modal>
  );
}

Object.assign(window, { ArticleDetail });
