/* ============================================================
   配置管理 — Config Management（真实数据：config_keywords / config_sources / app_configs）
   ============================================================ */
function ConfigMgmt({ nav, params, toast }) {
  const [sub, setSub] = useState("keywords");
  const SUBS = [["keywords", "关键词库", "bulb"], ["policies", "策略文档", "doc2"]];
  return (
    <div className="page fade-in">
      <div className="page-head">
        <h1 className="page-title">配置管理</h1>
        <p className="page-sub">维护关键词与策略文档。采集源的启用/停用在「数据源 → 采集源配置」。配置修改在下一次运行生效。</p>
      </div>
      <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
        <div style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", gap: 3, position: "sticky", top: 0 }}>
          {SUBS.map(([k, l, ic]) => (
            <button key={k} className={`nav-item${sub === k ? " active" : ""}`} onClick={() => setSub(k)}><Icon name={ic} size={17} />{l}</button>
          ))}
          <div style={{ marginTop: 8, padding: "11px 12px", background: "var(--info-soft)", border: "1px solid var(--info-line)", borderRadius: 10, fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            <Icon name="dot" size={14} style={{ color: "var(--info)", verticalAlign: "middle" }} /> 配置变更将在下一次 engine run 生效。
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {sub === "keywords" && <Keywords toast={toast} />}
          {sub === "policies" && <Policies toast={toast} />}
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, busy, onClick }) {
  return (
    <button onClick={busy ? undefined : onClick} style={{ width: 38, height: 22, borderRadius: 999, border: "none", padding: 2, cursor: busy ? "wait" : "pointer", opacity: busy ? .6 : 1, background: on ? "var(--brand-500)" : "var(--mut-line)", transition: "background .15s", flex: "0 0 auto" }}>
      <span style={{ display: "block", width: 18, height: 18, borderRadius: "50%", background: "#fff", boxShadow: "var(--sh-xs)", transform: on ? "translateX(16px)" : "translateX(0)", transition: "transform .15s" }} />
    </button>
  );
}

const PRIORITY_COLOR = { P0: "var(--bad)", P1: "var(--warn)", P2: "var(--ink-3)" };
const INTENT_ZH = { informational: "信息型", transactional: "交易型", navigational: "导航型", commercial: "商业型" };

function Keywords({ toast }) {
  const [list, setList] = useState(FLY.KEYWORDS);
  const [busyId, setBusyId] = useState(null);
  // 「刷新数据」全局重载后同步最新配置（FLY.load 会替换数组引用）
  useEffect(() => { setList(FLY.KEYWORDS); }, [FLY.KEYWORDS]);
  const toggle = async (k) => {
    setBusyId(k.id);
    try {
      await FLY.toggleConfig("keywords", k.id, !k.enabled);
      const next = list.map(x => x.id === k.id ? { ...x, enabled: !x.enabled } : x);
      setList(next);
      FLY.KEYWORDS = next;
      toast(`已${!k.enabled ? "启用" : "停用"}「${k.word}」，下次运行生效`, { icon: "checkCircle", color: "var(--ok-solid)" });
    } catch (e) {
      toast("操作失败：" + e.message, { icon: "xCircle", color: "var(--bad-solid)" });
    } finally {
      setBusyId(null);
    }
  };
  return (
    <Card>
      <CardHead icon="bulb" title="关键词库" hint={`${list.filter(k => k.enabled).length} / ${list.length} 启用`} />
      <table className="tbl">
        <thead><tr><th>关键词</th><th style={{ width: 150 }}>词簇</th><th style={{ width: 84 }}>意图</th><th style={{ width: 70 }}>优先级</th><th style={{ width: 80 }}>启用</th></tr></thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id} style={{ opacity: k.enabled ? 1 : .55 }}>
              <td className="row-title">{k.word}</td>
              <td><span className="chip mono" style={{ height: 22, fontSize: 11 }}>{k.group}</span></td>
              <td className="muted" style={{ fontSize: 12 }}>{INTENT_ZH[k.intent] || k.intent || "—"}</td>
              <td><span className="chip" style={{ height: 22, fontSize: 11.5, fontWeight: 700, color: PRIORITY_COLOR[k.priority] || "var(--ink-3)" }}>{k.priority || "—"}</span></td>
              <td><Toggle on={k.enabled} busy={busyId === k.id} onClick={() => toggle(k)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// counts：可选，{来源名: 库内素材数}（数据源页传入，配置时能看到每个源实际贡献了多少素材）
function Sources({ toast, counts }) {
  const [list, setList] = useState(FLY.CONFIG_SOURCES);
  const [busyId, setBusyId] = useState(null);
  const [grp, setGrp] = useState("");   // 分组过滤
  const [en, setEn] = useState("");     // 启用状态过滤："" | "on" | "off"
  // 「刷新数据」全局重载后同步最新配置
  useEffect(() => { setList(FLY.CONFIG_SOURCES); }, [FLY.CONFIG_SOURCES]);
  const HEALTH = { ok: ["健康", "ok"], warn: ["不稳定", "warn"], bad: ["持续失败", "bad"], mut: ["未采集", "mut"] };

  // 分组聚合（带计数），按数量降序
  const groupFacet = useMemo(() => {
    const m = {};
    list.forEach((s) => { if (s.group) m[s.group] = (m[s.group] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [list]);
  const onCount = list.filter((s) => s.enabled).length;

  // 过滤 + 排序：启用的在前，未启用的排后面；组内按分组、名称稳定排
  const rows = useMemo(() => list
    .filter((s) => (!grp || s.group === grp) && (en === "" || (en === "on" ? s.enabled : !s.enabled)))
    .slice()
    .sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0)
      || String(a.group || "").localeCompare(String(b.group || ""))
      || String(a.name).localeCompare(String(b.name))),
  [list, grp, en]);
  const toggle = async (s) => {
    setBusyId(s.id);
    try {
      await FLY.toggleConfig("sources", s.id, !s.enabled);
      const next = list.map(x => x.id === s.id ? { ...x, enabled: !x.enabled } : x);
      setList(next);
      FLY.CONFIG_SOURCES = next;
      toast(`已${!s.enabled ? "启用" : "停用"}「${s.name}」，下次运行生效`, { icon: "checkCircle", color: "var(--ok-solid)" });
    } catch (e) {
      toast("操作失败：" + e.message, { icon: "xCircle", color: "var(--bad-solid)" });
    } finally {
      setBusyId(null);
    }
  };
  return (
    <Card>
      <CardHead icon="rss" title="采集源" hint={`${onCount} / ${list.length} 启用 · 停用后下次运行不再采集`} />
      {/* 过滤：启用状态 + 分组 */}
      <div style={{ padding: "9px 16px", display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
        {[["", `全部 ${list.length}`], ["on", `已启用 ${onCount}`], ["off", `未启用 ${list.length - onCount}`]].map(([k, label]) => (
          <button key={k} onClick={() => setEn(k)} className="chip"
            style={{ cursor: "pointer", height: 24, fontWeight: 700, border: en === k ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: en === k ? "var(--brand-50)" : "var(--mut-soft)", color: en === k ? "var(--brand-700)" : "var(--ink-2)" }}>
            {label}
          </button>
        ))}
        <span style={{ borderLeft: "1px solid var(--line)", height: 18, margin: "0 5px" }} />
        <button onClick={() => setGrp("")} className="chip"
          style={{ cursor: "pointer", height: 24, fontWeight: 700, border: !grp ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: !grp ? "var(--brand-50)" : "var(--mut-soft)", color: !grp ? "var(--brand-700)" : "var(--ink-2)" }}>
          全部分组
        </button>
        {groupFacet.map(([g, c]) => (
          <button key={g} onClick={() => setGrp(grp === g ? "" : g)} className="chip"
            style={{ cursor: "pointer", height: 24, fontWeight: 600, border: grp === g ? "1px solid var(--brand-300)" : "1px solid var(--line)", background: grp === g ? "var(--brand-50)" : "var(--mut-soft)", color: grp === g ? "var(--brand-700)" : "var(--ink-2)" }}>
            {FLY.sourceGroup(g)}<span style={{ opacity: .6, marginLeft: 3 }}>{c}</span>
          </button>
        ))}
      </div>
      <table className="tbl">
        <thead><tr><th>源名称</th><th style={{ width: 150 }}>分组</th><th style={{ width: 120 }}>类型</th>{counts && <th style={{ width: 84 }} title="该来源在素材库（canonical 去重后）的条数">库内素材</th>}<th style={{ width: 96 }}>健康度</th><th style={{ width: 72 }}>启用</th></tr></thead>
        <tbody>
          {rows.map((s) => {
            const h = HEALTH[s.health] || HEALTH.mut;
            const n = counts ? (counts[s.name] || 0) : null;
            return (
              <tr key={s.id} style={{ opacity: s.enabled ? 1 : .55 }}>
                <td className="row-title">{s.name}</td>
                <td><span className="chip" style={{ height: 22, fontSize: 11 }} title={s.group}>{FLY.sourceGroup(s.group)}</span></td>
                <td className="muted mono" style={{ fontSize: 11 }}>{s.type}</td>
                {counts && <td className="tnum" style={{ fontWeight: 700, color: n > 0 ? "var(--ink)" : "var(--ink-4)" }}>{n}</td>}
                <td><Badge tone={h[1]} dot={h[1] !== "mut"}>{h[0]}</Badge></td>
                <td><Toggle on={s.enabled} busy={busyId === s.id} onClick={() => toggle(s)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/* 每个策略文档的中文用途说明 */
const POLICY_DESC = {
  "prompt:article_writer.md": "文章生成：根据选中选题与采集素材撰写文章初稿（含标题、正文、FAQ、内链建议）",
  "prompt:article_revision.md": "文章修订：根据事实核查与来源补全结果，对正文做针对性修订并产出新版本",
  "prompt:quality_gate.md": "质量门：对初稿做 7 维度评分（搜索意图/信息增量/可操作性等），决定可发布、需修订还是不通过",
  "prompt:fact_check.md": "事实核查：逐条抽取文中事实性表述，定风险级别，给出保留/弱化/删除/需引用的处理建议",
  "prompt:source_resolution.md": "来源补全：为高风险表述自动寻找权威来源，给出带来源的改写建议",
  "prompt:channel_repurpose.md": "渠道改写：把终稿改写为公众号长文、抖音口播稿、小红书笔记三种渠道稿",
  "prompt:seo_evaluator.md": "SEO 评分：从关键词定位、标题结构、内链等 9 个维度评估搜索引擎友好度",
  "prompt:geo_evaluator.md": "GEO 评分：从答案前置、可提取结构、引用就绪度等 8 个维度评估 AI 搜索引擎友好度",
  "prompt:serp_gap.md": "SERP 差距分析：分析目标关键词搜索结果页，找出现有内容未覆盖的空缺点",
  "prompt:topic_generator.md": "主题生成：从当日采集的资讯中聚合提炼候选选题（含内容角度与业务角度）",
  "prompt:topic_score.md": "选题评分：给候选选题打 0-100 分并定 P0/P1/P2 优先级，去重拒绝重复选题",
  "prompt:openclaw_article_agent.md": "OpenClaw 执行层总控：文章生成 Agent 的系统提示词，约束执行环境与工具使用",
  "schema:article.schema.json": "文章输出契约：校验生成文章的字段结构（标题/slug/正文/FAQ/内链/结构化数据）",
  "schema:revised_article.schema.json": "修订文章输出契约：校验修订版文章的字段结构",
  "schema:quality.schema.json": "质量门输出契约：校验评分、维度分解、问题清单、必修项的结构",
  "schema:dual_quality.schema.json": "双评分输出契约：校验 SEO+GEO 综合评分结果的结构",
  "schema:fact_check.schema.json": "事实核查输出契约：校验逐条表述、风险级别、处理建议的结构",
  "schema:source_resolution.schema.json": "来源补全输出契约：校验来源链接、可信度、建议改写的结构",
  "schema:channel_outputs.schema.json": "渠道稿输出契约：校验三渠道改写稿的字段结构",
  "schema:seo_score.schema.json": "SEO 评分输出契约：校验 9 维度分解与改进建议的结构",
  "schema:geo_score.schema.json": "GEO 评分输出契约：校验 8 维度分解与改进建议的结构",
  "schema:topic_candidates.schema.json": "候选选题输出契约：校验选题、关键词、角度、来源引用的结构",
  production_policy: "生产策略：质量分阈值、自动补源最大轮数、渠道清单、重试规则等流水线运行参数",
  internal_claims: "内部事实声明库：Flyfus 产品相关的可直接引用事实，核查时视为可信来源",
  models: "模型路由：每类任务（生成/核查/评分…）使用哪个模型，以及超时与重试配置",
  sources_yaml: "采集源清单源文件：config_sources 表的同步来源（YAML）",
  keywords_csv: "关键词库源文件：config_keywords 表的同步来源（CSV）",
};

function PolicyViewer({ doc, name, onClose, toast, onSaved }) {
  const isPrompt = doc && doc.type === "prompt";
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const startEdit = () => { setText(doc.content); setEdit(true); };
  const save = async () => {
    setSaving(true);
    try {
      const r = await FLY.saveDoc(doc.key, text);
      toast && toast(`已保存 v${r.version} · 下一次任务启动即生效`, { icon: "checkCircle", color: "var(--ok-solid)", dur: 4500 });
      setEdit(false);
      onSaved && onSaved({ ...doc, content: text, version: `v${r.version}`, by: "web" });
    } catch (e) {
      toast && toast(`保存失败：${(e.data && e.data.error) || e.message}`, { icon: "xCircle", color: "var(--bad-solid)", dur: 5500 });
    } finally { setSaving(false); }
  };
  return (
    <Modal title={name} wide onClose={onClose}
      footer={edit ? <>
        <Btn kind="ghost" onClick={() => setEdit(false)} disabled={saving}>取消编辑</Btn>
        <Btn kind="pri" icon="check" onClick={save} disabled={saving || !text.trim() || text === doc.content}>{saving ? "保存中…" : "保存（下次任务生效）"}</Btn>
      </> : <>
        {doc && <Btn kind="ghost" icon="sliders" onClick={startEdit}>编辑</Btn>}
        <Btn kind="ghost" onClick={onClose} style={{ marginLeft: "auto" }}>关闭</Btn>
      </>}>
      {!doc ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "30px 0", justifyContent: "center", color: "var(--ink-3)", fontWeight: 600 }}>
          <span className="spin" style={{ display: "flex" }}><Icon name="refresh" size={16} /></span>正在加载文档内容…
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span className="chip" style={{ height: 22, fontSize: 11.5 }}>{{ prompt: "Prompt", schema: "Schema", yaml_doc: "Policy" }[doc.type] || doc.type}</span>
            <span className="mono tnum" style={{ fontSize: 12, fontWeight: 700 }}>{doc.version}</span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>更新 {doc.updated} · {doc.by === "web" ? "Web 修改" : doc.by}</span>
            {doc.by === "web" && <span className="chip" style={{ height: 20, fontSize: 10.5, background: "var(--warn-soft)", borderColor: "var(--warn-line)", color: "var(--warn)" }}>已被 Web 修改 · sync 不覆盖</span>}
            <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)", marginLeft: "auto" }}>{(edit ? text : doc.content).length.toLocaleString()} 字符</span>
          </div>
          {POLICY_DESC[doc.key] && !edit && (
            <div style={{ display: "flex", gap: 9, padding: "10px 13px", marginBottom: 12, background: "var(--brand-50)", border: "1px solid var(--brand-200)", borderRadius: 9, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
              <Icon name="bulb" size={15} style={{ color: "var(--brand-600)", flex: "0 0 auto", marginTop: 1 }} />
              {POLICY_DESC[doc.key]}
            </div>
          )}
          {edit && (
            <div style={{ display: "flex", gap: 9, padding: "9px 13px", marginBottom: 10, background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 9, fontSize: 12, color: "var(--warn)", lineHeight: 1.5 }}>
              <Icon name="alert" size={14} style={{ flex: "0 0 auto", marginTop: 1 }} />
              直接编辑生产提示词：保存后下一次任务启动即生效；config:sync 不会覆盖 Web 修改，恢复仓库文件版本需 config:sync --force。
            </div>
          )}
          {edit ? (
            <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
              style={{ width: "100%", height: "52vh", padding: "14px 16px", fontSize: 12.5, lineHeight: 1.6, border: "1px solid var(--brand-300)", borderRadius: 10, background: "var(--surface)", color: "var(--ink)", resize: "vertical", boxSizing: "border-box", outline: "none" }} />
          ) : (
            <div style={{ maxHeight: "52vh", overflow: "auto", border: "1px solid var(--line)", borderRadius: 10, background: isPrompt ? "var(--surface)" : "var(--surface-2)" }}>
              {isPrompt
                ? <div className="prose" style={{ padding: "14px 18px", fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: FLY.mdToHtml(doc.content) }} />
                : <pre className="mono" style={{ margin: 0, padding: "14px 16px", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--ink-2)" }}>{doc.content}</pre>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Policies({ toast }) {
  const [viewing, setViewing] = useState(null); // { name, doc|null }
  const openDoc = async (p) => {
    setViewing({ name: p.name, doc: null });
    try {
      const doc = await FLY.loadConfigDoc(p.name);
      setViewing(v => (v && v.name === p.name ? { name: p.name, doc } : v));
    } catch (e) {
      setViewing(null);
      toast && toast("文档加载失败：" + e.message, { icon: "xCircle", color: "var(--bad-solid)" });
    }
  };
  return (
    <Card>
      <CardHead icon="doc2" title="策略文档" hint="prompt / schema / policy 版本（来自 app_configs）" />
      <div style={{ margin: "12px 16px 0", display: "flex", gap: 9, padding: "10px 13px", background: "var(--mut-soft)", border: "1px solid var(--line)", borderRadius: 9, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        <Icon name="dot" size={15} style={{ color: "var(--ink-3)", flex: "0 0 auto", marginTop: 1 }} />
        点击任意文档查看与<b>在线编辑</b>。运行时从数据库读取：Web 保存后下一次任务启动即生效；config:sync 不覆盖 Web 修改。
      </div>
      <table className="tbl">
        <thead><tr><th>文档 / 用途</th><th style={{ width: 76 }}>类型</th><th style={{ width: 56 }}>版本</th><th style={{ width: 120 }}>更新时间</th><th style={{ width: 80 }}></th></tr></thead>
        <tbody>
          {FLY.POLICIES.map((p, i) => (
            <tr key={i} className="clickable" onClick={() => openDoc(p)}>
              <td>
                <div className="row-title mono" style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 7 }}>
                  {p.name}{p.risk && <span className="badge bg-warn" style={{ height: 18, fontSize: 10 }}>高风险</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3, lineHeight: 1.45 }}>{POLICY_DESC[p.name] || "—"}</div>
              </td>
              <td><span className="chip" style={{ height: 22, fontSize: 11.5 }}>{p.kind}</span></td>
              <td className="mono tnum" style={{ fontWeight: 700 }}>{p.version}</td>
              <td className="muted mono" style={{ fontSize: 12 }}>{p.updated}</td>
              <td onClick={e => e.stopPropagation()}>
                <Btn kind="ghost" size="sm" icon="eye" onClick={() => openDoc(p)}>查看</Btn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {viewing && <PolicyViewer doc={viewing.doc} name={viewing.name} toast={toast}
        onSaved={(doc) => setViewing((v) => (v ? { ...v, doc } : v))}
        onClose={() => setViewing(null)} />}
    </Card>
  );
}

Object.assign(window, { ConfigMgmt, Sources });
