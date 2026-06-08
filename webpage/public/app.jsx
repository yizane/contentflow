/* ============================================================
   App shell — sidebar, router, run control（真实 API）, modals, toasts
   ============================================================ */
const NAV = [
  { id: "dashboard", label: "生产日报", icon: "home" },
  { id: "library", label: "文章库", icon: "docs" },
  { id: "sources", label: "数据源", icon: "rss" },
  { id: "topics", label: "选题池", icon: "bulb" },
  { id: "runs", label: "运行历史", icon: "history" },
  { id: "config", label: "配置管理", icon: "sliders" },
];

const PAGE_TITLE = {
  dashboard: "生产日报", library: "文章库", detail: "文章详情", sources: "数据源",
  runs: "运行历史", runDetail: "运行详情", topics: "选题池", config: "配置管理",
};

function Placeholder({ title }) {
  return <div className="page fade-in"><Card><Empty icon="settings" title={title + " · 建设中"} desc="该页面即将上线。" /></Card></div>;
}

function LoadFail({ error, onRetry }) {
  return (
    <div style={{ height: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, margin: "0 auto 16px", background: "var(--bad-bg)", color: "var(--bad)", display: "grid", placeItems: "center" }}><Icon name="xCircle" size={26} /></div>
        <h3 style={{ margin: "0 0 8px" }}>无法连接数据服务</h3>
        <p style={{ color: "var(--ink-3)", fontSize: 13, lineHeight: 1.6, margin: "0 0 16px" }}>{String(error && error.message || error)}<br />请确认已运行 <code className="mono">cd webpage && npm start</code> 且 MySQL 可达。</p>
        <Btn kind="pri" icon="refresh" onClick={onRetry}>重试连接</Btn>
      </div>
    </div>
  );
}

function Booting() {
  return (
    <div style={{ height: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--ink-3)", fontWeight: 600 }}>
        <span className="spin" style={{ display: "flex" }}><Icon name="refresh" size={18} /></span>
        正在加载真实数据…
      </div>
    </div>
  );
}

function App({ onReload }) {
  const [page, setPage] = useState("dashboard");
  const [params, setParams] = useState({});
  const [modal, setModal] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [, setTick] = useState(0); // FLY 重载后强制刷新
  const pollRef = useRef(null);

  const runState = FLY.TODAY.state;

  function nav(p, pr = {}) {
    setParams(pr);
    setPage(p);
    document.querySelector(".scroll") && (document.querySelector(".scroll").scrollTop = 0);
  }
  function toast(msg, opts = {}) {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, ...opts }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), opts.dur || 3200);
  }

  // ---- 数据刷新 ----
  async function reload() {
    try {
      await FLY.load();
      setTick(t => t + 1);
    } catch (e) {
      toast("刷新失败：" + e.message, { icon: "xCircle", color: "var(--bad-solid)" });
    }
  }

  // 运行中自动轮询
  useEffect(() => {
    if (runState === "running") {
      pollRef.current = setInterval(async () => {
        await FLY.load().catch(() => {});
        setTick(t => t + 1);
        if (FLY.TODAY.state !== "running") {
          clearInterval(pollRef.current);
          const st = FLY.TODAY.state;
          const m = {
            success: ["今日流水线运行成功", "checkCircle", "var(--ok-solid)"],
            partial: ["运行完成 · 部分步骤失败", "alert", "var(--warn-solid)"],
            failed: ["运行失败，请查看运行详情", "xCircle", "var(--bad-solid)"],
          }[st];
          if (m) toast(m[0], { icon: m[1], color: m[2] });
        }
      }, 4000);
      return () => clearInterval(pollRef.current);
    }
  }, [runState]);

  // ---- 运行控制（真实 API）----
  async function doRunControl(mode, label) {
    try {
      const r = await FLY.runControl(mode);
      if (r.accepted || r.ok) {
        toast(`${label}已受理，后台执行中`, { icon: "play", color: "var(--info-solid)" });
        FLY.TODAY.state = "running";
        setTick(t => t + 1);
        setTimeout(reload, 2500);
      }
    } catch (e) {
      const reason = (e.data && e.data.reason) || e.message;
      toast(`${label}被拒绝：${reason}`, { icon: "xCircle", color: "var(--bad-solid)", dur: 5200 });
    }
  }

  function onAction(key) {
    if (key === "run") doRunControl("start", "今日运行");
    else if (key === "retry") setModal({ type: "retry" });
    else if (key === "rebuild") setModal({ type: "rebuild" });
    else if (key === "refresh") reload();
  }

  const reviewCount = FLY.COUNTS.readyForReview;

  const PageComp = (() => {
    switch (page) {
      case "dashboard": return <Dashboard state={runState} nav={nav} onAction={onAction} toast={toast} />;
      case "library": return window.Library ? <window.Library nav={nav} params={params} /> : <Placeholder title="文章库" />;
      case "sources": return window.SourcesPage ? <window.SourcesPage nav={nav} params={params} toast={toast} /> : <Placeholder title="数据源" />;
      case "detail": return window.ArticleDetail ? <window.ArticleDetail nav={nav} params={params} toast={toast} setModal={setModal} onChanged={reload} /> : <Placeholder title="文章详情" />;
      case "runs": return window.RunHistory ? <window.RunHistory nav={nav} params={params} /> : <Placeholder title="运行历史" />;
      case "runDetail": return window.RunDetail ? <window.RunDetail nav={nav} params={params} toast={toast} onAction={onAction} /> : <Placeholder title="运行详情" />;
      case "topics": return window.TopicPool ? <window.TopicPool nav={nav} params={params} /> : <Placeholder title="选题池" />;
      case "config": return window.ConfigMgmt ? <window.ConfigMgmt nav={nav} params={params} toast={toast} setModal={setModal} /> : <Placeholder title="配置管理" />;
      default: return <Placeholder title="页面" />;
    }
  })();

  const crumbBase = page === "detail" ? "library" : page === "runDetail" ? "runs" : page;
  const todayApproved = FLY.ARTICLES.filter(a => ["approved_for_publish", "published"].includes(a.status) && (a.created || "").startsWith(FLY.DAILY)).length;

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="rail">
        <div className="rail-brand">
          <div className="rail-logo"><Icon name="zap" size={19} /></div>
          <div>
            <div className="name">ContentFlow</div>
          </div>
        </div>
        <nav className="rail-nav">
          {NAV.map(n => (
            <button key={n.id} className={`nav-item${(page === n.id || crumbBase === n.id) ? " active" : ""}`} onClick={() => nav(n.id)}>
              <Icon name={n.icon} size={18} />
              {n.label}
              {n.id === "library" && reviewCount > 0 && <span className="nv-count">{reviewCount}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <div className="rail-user">
            <div className="avatar">运</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>内容运营</div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>ContentFlow</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <span>{NAV.find(n => n.id === crumbBase)?.label || "ContentFlow"}</span>
            {(page === "detail" || page === "runDetail") && <><Icon name="chevR" size={14} /><b>{PAGE_TITLE[page]}</b></>}
          </div>
          <div className="topbar-sp" />
          <Btn kind="ghost" size="sm" icon="refresh" onClick={reload}>刷新数据</Btn>
        </header>
        <div className="scroll">{PageComp}</div>
      </div>

      {/* Modals */}
      {modal && modal.type === "rebuild" && (
        <Modal tone="bad" title="重建今天？" wide onClose={() => setModal(null)}
          footer={<>
            <Btn kind="ghost" onClick={() => setModal(null)}>取消</Btn>
            <Btn kind="danger-solid" icon="rebuild" onClick={() => { setModal(null); doRunControl("rebuild", "重建"); }}>确认重建</Btn>
          </>}>
          <p style={{ margin: "0 0 12px" }}>重建会<b style={{ color: "var(--ink)" }}>归档今天已有的运行数据</b>并完整重跑全部 7 个步骤。旧数据会被标记为「已被替代」，<b style={{ color: "var(--ink)" }}>不会被物理删除</b>，仍可在运行历史中查看。</p>
          {todayApproved > 0 && (
            <div style={{ display: "flex", gap: 9, padding: "11px 13px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 9 }}>
              <Icon name="alert" size={16} style={{ color: "var(--warn)", flex: "0 0 auto", marginTop: 1 }} />
              <div style={{ fontSize: 12.5, color: "var(--warn)", lineHeight: 1.5 }}>今天有 <b>{todayApproved} 篇已批准/已发布</b>的文章，重建<b>不会自动归档已发布内容</b>，请确认是否需要保留。</div>
            </div>
          )}
        </Modal>
      )}
      {modal && modal.type === "retry" && (
        <Modal tone="warn" title="重试失败步骤？" onClose={() => setModal(null)}
          footer={<>
            <Btn kind="ghost" onClick={() => setModal(null)}>取消</Btn>
            <Btn kind="warn" icon="refresh" onClick={() => { setModal(null); doRunControl("retry", "重试"); }}>重试失败</Btn>
          </>}>
          <p style={{ margin: 0 }}>重试<b style={{ color: "var(--ink)" }}>只补失败的步骤</b>，不会重复已成功的步骤。重试后仍归属今日运行（{FLY.DAILY}），可在运行详情中查看 retry 记录。</p>
        </Modal>
      )}

      <Toasts items={toasts} />
    </div>
  );
}

function Root() {
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [error, setError] = useState(null);

  const boot = () => {
    setPhase("loading");
    FLY.load().then(() => setPhase("ready")).catch((e) => { setError(e); setPhase("error"); });
  };
  useEffect(boot, []);

  if (phase === "loading") return <Booting />;
  if (phase === "error") return <LoadFail error={error} onRetry={boot} />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);
