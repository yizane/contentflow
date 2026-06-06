/* ============================================================
   Web 控制台组件 — 模型调用 I/O 查看器
   数据：GET /api/ui/model-runs（列表）+ /api/ui/model-runs/:id（全文）
   用途：验证每一步 AI 的输入（prompt）和输出（raw/parsed）质量
   ============================================================ */

const MR_STATUS = { succeeded: { text: "成功", tone: "ok" }, failed: { text: "失败", tone: "bad" }, running: { text: "运行中", tone: "info" } };

function CopyBtn({ text, label = "复制" }) {
  const [done, setDone] = useState(false);
  return (
    <Btn kind="ghost" size="sm" icon={done ? "check" : "copy"} onClick={() => {
      navigator.clipboard.writeText(text || "").then(() => { setDone(true); setTimeout(() => setDone(false), 1500); });
    }}>{done ? "已复制" : label}</Btn>
  );
}

/* 全文区块：mono 滚动 + 复制 */
function IOBlock({ title, text, mono = true, maxH = 280 }) {
  if (!text) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <b style={{ fontSize: 12.5 }}>{title}</b>
        <span className="hint">{(text.length).toLocaleString()} 字符</span>
        <span style={{ marginLeft: "auto" }}><CopyBtn text={text} /></span>
      </div>
      <pre className={mono ? "mono" : ""} style={{ margin: 0, padding: "11px 13px", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 9, maxHeight: maxH, overflowY: "auto", color: "var(--ink-2)" }}>{text}</pre>
    </div>
  );
}

function ModelRunsModal({ task, articleId, onClose }) {
  const [list, setList] = useState(null);      // {byType, items}
  const [filter, setFilter] = useState(task || "");
  const [detail, setDetail] = useState(null);  // null | "loading" | modelRun
  useEffect(() => {
    let alive = true;
    setList(null);
    FLY.loadModelRuns({ task: filter, article: articleId, limit: 50 }).then((r) => { if (alive) setList(r); }).catch(() => { if (alive) setList({ byType: {}, items: [] }); });
    return () => { alive = false; };
  }, [filter, articleId]);

  const openDetail = async (id) => {
    setDetail("loading");
    try { setDetail(await FLY.loadModelRun(id)); } catch (_) { setDetail(null); }
  };

  const byType = (list && list.byType) || {};

  return (
    <Modal title={detail && detail !== "loading" ? `模型调用 · ${FLY.ZH_TASK[detail.taskType] || detail.taskType}` : "模型调用记录"} wide onClose={onClose}
      footer={<>
        {detail && detail !== "loading" && <Btn kind="ghost" icon="chevR" style={{ transform: "rotate(180deg)" }} onClick={() => setDetail(null)} />}
        {detail && detail !== "loading" && <Btn kind="ghost" onClick={() => setDetail(null)}>返回列表</Btn>}
        <Btn kind="ghost" onClick={onClose} style={{ marginLeft: "auto" }}>关闭</Btn>
      </>}>
      {detail === "loading" ? (
        <div style={{ padding: "28px 0", textAlign: "center", color: "var(--ink-3)", fontWeight: 600 }}>正在加载全文…</div>
      ) : detail ? (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <Badge tone={(MR_STATUS[detail.status] || {}).tone || "mut"}>{(MR_STATUS[detail.status] || {}).text || detail.status}</Badge>
            <span className="chip" style={{ height: 22, fontSize: 11 }}>{detail.provider || "?"} · {detail.model || "?"}</span>
            {detail.durMs > 0 && <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>耗时 {fmtDur(detail.durMs)}</span>}
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{FLY.fmtDT(detail.started)}</span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginLeft: "auto" }}>{detail.id}</span>
          </div>
          {detail.error && (
            <div style={{ padding: "10px 13px", marginBottom: 12, background: "var(--bad-soft)", border: "1px solid var(--bad-line)", borderRadius: 9, fontSize: 12.5, color: "var(--bad)" }}>{detail.error}</div>
          )}
          <IOBlock title="输入 · 提示词" text={detail.prompt} />
          <IOBlock title="输出 · 原始回复" text={detail.response} />
          {detail.parsed && <IOBlock title="输出 · 解析结果（入库）" text={JSON.stringify(detail.parsed, null, 2)} maxH={240} />}
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>
            <button onClick={() => setFilter("")} className="chip"
              style={{ cursor: "pointer", fontWeight: 700, border: !filter ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: !filter ? "var(--brand-50)" : "var(--mut-soft)", color: !filter ? "var(--brand-700)" : "var(--ink-2)" }}>
              全部 {Object.values(byType).reduce((a, b) => a + b, 0)}
            </button>
            {Object.entries(byType).map(([k, c]) => (
              <button key={k} onClick={() => setFilter(filter === k ? "" : k)} className="chip"
                style={{ cursor: "pointer", fontWeight: 600, border: filter === k ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: filter === k ? "var(--brand-50)" : "var(--mut-soft)", color: filter === k ? "var(--brand-700)" : "var(--ink-2)" }}>
                {FLY.ZH_TASK[k] || k} {c}
              </button>
            ))}
          </div>
          {!list ? (
            <div style={{ padding: "24px 0", textAlign: "center", color: "var(--ink-3)", fontWeight: 600 }}>正在加载…</div>
          ) : !list.items.length ? (
            <Empty icon="inbox" title="没有模型调用记录" desc="该任务类型还没有 AI 调用，跑一次对应步骤后这里会出现完整的输入输出。" />
          ) : (
            <div style={{ maxHeight: "52vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {list.items.map((r) => {
                const st = MR_STATUS[r.status] || { text: r.status, tone: "mut" };
                return (
                  <button key={r.id} onClick={() => openDetail(r.id)}
                    style={{ textAlign: "left", border: "1px solid var(--line)", background: "var(--surface)", borderRadius: 9, padding: "9px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 9 }}
                    onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--brand-300)"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "var(--line)"}>
                    <Badge tone={st.tone} dot={false}>{st.text}</Badge>
                    <span style={{ fontWeight: 700, fontSize: 12.5 }}>{FLY.ZH_TASK[r.taskType] || r.taskType}</span>
                    <span className="tnum" style={{ fontSize: 11, color: "var(--ink-3)" }}>入 {(r.promptLen / 1000).toFixed(1)}k · 出 {(r.responseLen / 1000).toFixed(1)}k 字符</span>
                    {r.durMs > 0 && <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{fmtDur(r.durMs)}</span>}
                    {r.error && <span style={{ fontSize: 11, color: "var(--bad)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{r.error}</span>}
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginLeft: "auto", flex: "0 0 auto" }}>{FLY.fmtDT(r.started)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ============================================================
   单步运行日志抽屉 — 终端风格，实时轮询 /api/step/log/:step
   ============================================================ */
function StepLogDrawer({ initialStep, onClose }) {
  const [steps, setSteps] = useState({});       // 全部单步任务状态（chips 切换）
  const [cur, setCur] = useState(initialStep || null);
  const [data, setData] = useState(null);       // {label, running, exitCode, log}
  const boxRef = useRef(null);
  const stickRef = useRef(true);                // 是否吸附底部（用户上翻则暂停自动滚动）

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await FLY.stepStatus().catch(() => null);
      if (!alive) return;
      if (s) {
        setSteps(s.steps || {});
        // 没选中时自动选一个（优先运行中的，其次最近开始的）
        if (!cur) {
          const ks = Object.keys(s.steps || {});
          const running = ks.find((k) => s.steps[k].running);
          const latest = ks.sort((a, b) => String(s.steps[b].startedAt).localeCompare(String(s.steps[a].startedAt)))[0];
          if (running || latest) setCur(running || latest);
        }
      }
      if (cur) {
        const d = await FLY.stepLog(cur).catch(() => null);
        if (alive && d) setData(d);
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [cur]);

  // 自动滚底（除非用户主动上翻）
  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  const keys = Object.keys(steps);
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 80, height: "40vh", display: "flex", flexDirection: "column", background: "#15171c", borderTop: "1px solid #2c3038", boxShadow: "0 -12px 32px rgba(0,0,0,.25)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid #262a31", flexWrap: "wrap" }}>
        <Icon name="history" size={14} style={{ color: "#8b93a1" }} />
        <b style={{ fontSize: 12.5, color: "#e7eaf0" }}>单步运行日志</b>
        {keys.length === 0 && <span style={{ fontSize: 11.5, color: "#8b93a1" }}>还没有单步运行记录，点任意「重跑」按钮开始</span>}
        {keys.map((k) => {
          const j = steps[k];
          const active = cur === k;
          return (
            <button key={k} onClick={() => { setCur(k); setData(null); stickRef.current = true; }}
              style={{ cursor: "pointer", border: active ? "1px solid #6366F1" : "1px solid #343943", background: active ? "rgba(99,102,241,.18)" : "transparent", color: active ? "#c3c6ff" : "#aab2c0", borderRadius: 7, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5 }}>
              {j.running ? <span className="spin" style={{ display: "flex" }}><Icon name="refresh" size={10} /></span>
                : <span style={{ width: 7, height: 7, borderRadius: "50%", background: j.exitCode === 0 ? "#34d399" : "#f87171" }} />}
              {j.label}
              {!j.running && j.exitCode != null && <span style={{ fontWeight: 500, opacity: .75 }}>exit {j.exitCode}</span>}
            </button>
          );
        })}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {data && <span style={{ fontSize: 10.5, color: "#6f7886" }} className="mono">{(data.log || []).length} 行</span>}
          <button onClick={onClose} style={{ cursor: "pointer", border: "1px solid #343943", background: "transparent", color: "#aab2c0", borderRadius: 7, padding: "3px 10px", fontSize: 11.5, fontWeight: 700 }}>关闭</button>
        </span>
      </div>
      <div ref={boxRef} onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="mono" style={{ flex: 1, overflowY: "auto", padding: "10px 16px", fontSize: 11.5, lineHeight: 1.6, color: "#c8cdd6" }}>
        {!cur ? <div style={{ color: "#6f7886" }}>（暂无日志）</div>
          : !data ? <div style={{ color: "#6f7886" }}>正在加载…</div>
          : (data.log || []).length === 0 ? <div style={{ color: "#6f7886" }}>进程已启动，等待输出…</div>
          : data.log.map((ln, i) => (
            <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: /error|失败|Error|FAIL/i.test(ln) ? "#f8a5a5" : /warn|警告/i.test(ln) ? "#f5d08a" : "#c8cdd6" }}>{ln}</div>
          ))}
        {data && !data.running && data.exitCode != null && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #343943", color: data.exitCode === 0 ? "#34d399" : "#f87171", fontWeight: 700 }}>
            ▌进程结束 · 退出码 {data.exitCode}{data.exitCode === 0 ? "（成功）" : "（失败）"}
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ModelRunsModal, CopyBtn, IOBlock, StepLogDrawer });
