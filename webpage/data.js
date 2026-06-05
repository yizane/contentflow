/* ============================================================
   Flyfus 真实数据层 — 从 view_server API 取数，整形为页面需要的结构。
   挂到 window.FLY：静态字典 + 动态数据 + API 封装。
   ============================================================ */
(function () {
  // ---------- 静态字典 ----------
  const STEP_DEFS = [
    { key: "collect",  n: 1, title: "采集选题源",  icon: "rss",     enter: "采集源明细" },
    { key: "topics",   n: 2, title: "生成主题池",  icon: "bulb",    enter: "选题池" },
    { key: "tasks",    n: 3, title: "创建文章任务", icon: "listplus",enter: "选题池" },
    { key: "generate", n: 4, title: "生成文章",    icon: "sparkles",enter: "文章详情" },
    { key: "factcheck",n: 5, title: "事实核查",    icon: "shield",  enter: "核查报告" },
    { key: "channels", n: 6, title: "渠道改写",    icon: "share",   enter: "渠道稿" },
    { key: "score",    n: 7, title: "SEO/GEO 评分",icon: "gauge",   enter: "评分明细" },
  ];

  const ART_STATUS = {
    generated:           { text: "已生成",     tone: "info" },
    article_validated:   { text: "已过质量门", tone: "ok" },
    validation_failed:   { text: "校验失败",   tone: "bad" },
    needs_fact_sources:  { text: "待补来源",   tone: "warn" },
    fact_checked:        { text: "已核查",     tone: "ok" },
    ready_for_review:    { text: "待终审",     tone: "warn" },
    reviewed:            { text: "已复审",     tone: "ok" },
    approved_for_publish:{ text: "批准发布",   tone: "ok" },
    published:           { text: "已发布",     tone: "ok" },
    rejected:            { text: "已打回",     tone: "bad" },
    fact_check_failed:   { text: "核查未过",   tone: "bad" },
    archived:            { text: "已归档",     tone: "mut" },
  };
  const artStatus = (s) => ART_STATUS[s] || { text: s || "未知", tone: "mut" };

  const STATUS_FLOW = ["article_validated", "needs_fact_sources", "ready_for_review", "reviewed", "approved_for_publish", "published"];

  const CHANNEL_META = { wechat: "公众号", douyin: "抖音", xhs: "小红书" };
  const CH_STATUS = { success: { text: "成功", tone: "ok" }, pending: { text: "待生成", tone: "mut" }, fail: { text: "失败", tone: "bad" } };

  const RUN_STATUS = {
    running:    { text: "运行中",   tone: "info" },
    success:    { text: "成功",     tone: "ok" },
    partial:    { text: "部分成功", tone: "warn" },
    failed:     { text: "失败",     tone: "bad" },
    superseded: { text: "已被替代", tone: "mut" },
  };
  const runStatus = (s) => RUN_STATUS[s] || { text: s || "未知", tone: "mut" };
  const MODE_META = { start: "首次运行", retry: "重试失败", rebuild: "重建", force: "强制" };

  const TOPIC_STATUS = {
    candidate: { text: "候选", tone: "info" },
    selected:  { text: "已选中", tone: "brand" },
    generated: { text: "已生成", tone: "ok" },
    rejected:  { text: "被拒", tone: "mut" },
  };
  const topicStatus = (s) => TOPIC_STATUS[s] || { text: s || "未知", tone: "mut" };

  const ZH_ACTION = {
    start_daily: "启动今日运行", retry_daily: "重试今日", rebuild_daily: "重建今日",
    force_daily: "强制运行", generate_report: "生成报告", mark: "终审标记",
  };
  const ZH_TASK = {
    article_generation: "文章生成", article_draft: "文章初稿", fact_check: "事实核查",
    source_resolution: "来源补全", article_revision: "文章修订", channel_repurpose: "渠道改写",
    seo_geo_score: "SEO/GEO 评分", seo_score: "SEO 评分", geo_score: "GEO 评分",
    topic_generation: "主题生成", quality_gate: "质量门", serp_gap: "SERP 差距分析",
  };

  // ---------- 时间格式化 ----------
  const pad = (n) => String(n).padStart(2, "0");
  function fmtDT(iso) { // YYYY-MM-DD HH:mm（本地时区）
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 16);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtHM(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? "—" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtHMS(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? "—" : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ---------- Markdown → HTML（移植自旧 viewer，先转义再转换，防注入）----------
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function mdToHtml(md) {
    if (!md) return "";
    const lines = esc(md).split("\n");
    const out = [];
    let inCode = false, inList = null, inQuote = false, tableBuf = [];

    const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
    const closeQuote = () => { if (inQuote) { out.push("</blockquote>"); inQuote = false; } };
    const flushTable = () => {
      if (!tableBuf.length) return;
      const rows = tableBuf.filter((r) => !/^\|?[\s:|-]+\|?$/.test(r));
      const html = rows.map((r, i) => {
        const cells = r.replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        const tag = i === 0 ? "th" : "td";
        return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
      }).join("");
      out.push(`<table>${html}</table>`);
      tableBuf = [];
    };
    const inline = (s) => s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    for (const line of lines) {
      if (/^```/.test(line.trim())) {
        flushTable(); closeList(); closeQuote();
        out.push(inCode ? "</code></pre>" : "<pre><code>");
        inCode = !inCode;
        continue;
      }
      if (inCode) { out.push(line); continue; }
      if (/^\|.*\|/.test(line.trim())) { closeList(); closeQuote(); tableBuf.push(line.trim()); continue; }
      flushTable();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); closeQuote(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      if (/^(\*{3,}|-{3,})\s*$/.test(line.trim())) { closeList(); closeQuote(); out.push("<hr>"); continue; }
      const q2 = line.match(/^&gt;\s?(.*)$/);
      if (q2) { closeList(); if (!inQuote) { out.push("<blockquote>"); inQuote = true; } out.push(inline(q2[1]) + "<br>"); continue; }
      closeQuote();
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) { if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
      const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
      if (ol) { if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
      closeList();
      if (line.trim() === "") continue;
      out.push(`<p>${inline(line)}</p>`);
    }
    flushTable(); closeList(); closeQuote();
    if (inCode) out.push("</code></pre>");
    return out.join("\n");
  }

  // ---------- API ----------
  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok && data.ok !== true) {
      const err = new Error(data.error || data.reason || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  // ---------- 整形 ----------
  function adaptSteps(steps) {
    if (!steps) return null;
    const byKey = {};
    steps.forEach((s) => { byKey[s.key] = s; });
    return STEP_DEFS.map((d) => {
      const s = byKey[d.key] || { status: "pending", summary: "等待中", dur: 0, metrics: [] };
      return { ...d, ...s };
    });
  }

  function adaptToday(b) {
    const t = b.today || {};
    return {
      state: t.state || "not_started",
      run: t.run ? {
        ...t.run,
        startedHM: fmtHM(t.run.started), finishedHM: fmtHM(t.run.finished),
      } : null,
      steps: adaptSteps(t.steps),
      meta: t.meta || { items: 0, topics: 0, articles: 0, review: 0 },
      availableActions: t.availableActions || {},
      message: t.message || "",
      firstArticleId: t.firstArticleId || null,
    };
  }

  // ---------- 动态加载 ----------
  const FLY = {
    // 静态
    STEP_DEFS, ART_STATUS, artStatus, STATUS_FLOW, CHANNEL_META, CH_STATUS,
    RUN_STATUS, runStatus, MODE_META, TOPIC_STATUS, topicStatus, ZH_ACTION, ZH_TASK,
    fmtDT, fmtHM, fmtHMS, mdToHtml,
    // 动态（load 后填充）
    DAILY: "—", TODAY: { state: "not_started", steps: null, meta: {}, availableActions: {} },
    ARTICLES: [], RUNS: [], TOPICS: [], TOPICS_SCOPE: "today", TREND: [],
    KEYWORDS: [], CONFIG_SOURCES: [], POLICIES: [],
    COUNTS: { readyForReview: 0, needsFactSources: 0 }, CHRONIC: [],
    LOADED: false,

    async load() {
      const b = await api("/api/ui/bootstrap");
      FLY.DAILY = b.dailyKey;
      FLY.TODAY = adaptToday(b);
      FLY.ARTICLES = (b.articles || []).map((a) => ({ ...a, created: fmtDT(a.created), updated: fmtDT(a.updated) }));
      FLY.RUNS = (b.runs || []).map((r) => ({
        ...r,
        started: fmtHMS(r.started) || "—", finished: fmtHMS(r.finished) || "—",
        dur: window.fmtDur ? window.fmtDur(r.durMs) : (r.durMs ? Math.round(r.durMs / 1000) + "s" : "—"),
      }));
      FLY.TOPICS = (b.topics || []).map((t) => ({ ...t, created: fmtHM(t.created) }));
      FLY.TOPICS_SCOPE = b.topicsScope || "today";
      FLY.TREND = b.trend || [];
      FLY.KEYWORDS = (b.config && b.config.keywords) || [];
      FLY.CONFIG_SOURCES = (b.config && b.config.sources) || [];
      FLY.POLICIES = ((b.config && b.config.policies) || []).map((p) => ({ ...p, updated: fmtDT(p.updated) }));
      FLY.COUNTS = b.counts || { readyForReview: 0, needsFactSources: 0 };
      FLY.CHRONIC = b.chronicSources || [];
      FLY.LOADED = true;
      return FLY;
    },

    _articleCache: {},
    async loadArticle(id, force) {
      if (!force && FLY._articleCache[id]) return FLY._articleCache[id];
      const r = await api(`/api/ui/article/${encodeURIComponent(id)}`);
      const a = r.article;
      a.created = fmtDT(a.created); a.updated = fmtDT(a.updated);
      a.versions.forEach((v) => { v.created = fmtHM(v.created) || "—"; });
      a.history.forEach((h) => { h.t = fmtDT(h.t) || "—"; });
      a.factRounds.forEach((f) => { f.at = fmtDT(f.at); });
      if (a.rejectAt) a.rejectAt = fmtDT(a.rejectAt);
      FLY._articleCache[id] = a;
      return a;
    },

    _runCache: {},
    async loadRun(id, force) {
      if (!force && FLY._runCache[id]) return FLY._runCache[id];
      const r = await api(`/api/ui/run/${encodeURIComponent(id)}`);
      const d = {
        run: {
          ...r.run,
          started: fmtHMS(r.run.started) || "—", finished: fmtHMS(r.run.finished) || "—",
          dur: window.fmtDur ? window.fmtDur(r.run.durMs) : "—",
        },
        steps: adaptSteps(r.steps),
        sources: r.sources || [],
        actions: (r.actions || []).map((x) => ({ ...x, t: fmtDT(x.t) })),
        failedModelRuns: (r.failedModelRuns || []).map((x) => ({ ...x, t: fmtDT(x.t) })),
        transitions: (r.transitions || []).map((x) => ({ ...x, t: fmtDT(x.t) })),
      };
      FLY._runCache[id] = d;
      return d;
    },

    // 运行控制：mode = start | retry | rebuild
    runControl(mode, actor) {
      return post("/api/run-control/start", { mode, actor: actor || "web" });
    },
    // 终审：status = reviewed | rejected | approved_for_publish | ready_for_review | archived
    review(id, status, note, actor) {
      delete FLY._articleCache[id];
      return post(`/api/articles/${encodeURIComponent(id)}/review`, { status, note, actor: actor || "web" });
    },
    toggleConfig(kind, id, enabled) {
      return post(`/api/config/${kind}/${encodeURIComponent(id)}/toggle`, { enabled });
    },

    _docCache: {},
    async loadConfigDoc(key) {
      if (FLY._docCache[key]) return FLY._docCache[key];
      const r = await api(`/api/ui/config/doc?key=${encodeURIComponent(key)}`);
      const d = r.doc;
      d.updated = fmtDT(d.updated);
      FLY._docCache[key] = d;
      return d;
    },
  };

  window.FLY = FLY;
})();
