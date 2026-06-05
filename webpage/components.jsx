/* ============================================================
   Shared UI components + icon set. Exported to window.
   ============================================================ */
const { useState, useEffect, useRef, useMemo } = React;

/* ---------- Icons (stroke, no emoji) ---------- */
const ICONS = {
  home: "M3 10.8 12 3l9 7.8M5 9.5V21h5v-6h4v6h5V9.5",
  docs: "M7 3h7l5 5v13H7zM14 3v5h5M9.5 13h6M9.5 17h6",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3.5 2",
  bulb: "M9 18h6M10 21h4M8.5 14.5A6 6 0 1 1 15.5 14.5C14.8 15.2 14 16 14 17.2V18h-4v-.8c0-1.2-.8-2-1.5-2.7Z",
  sliders: "M4 6h11M4 12h8M4 18h13M17 4v4M12 10v4M19 16v4",
  rss: "M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14",
  listplus: "M4 6h10M4 12h7M4 18h7M16 15h6M19 12v6",
  sparkles: "M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4ZM18.5 14l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9Z",
  shield: "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6ZM9 12l2 2 4-4",
  share: "M16 6l-4-3-4 3M12 3v12M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6",
  gauge: "M12 13l4-4M3.5 16a9 9 0 1 1 17 0M7 16h.01M17 16h.01",
  play: "M7 4.5v15l13-7.5z",
  refresh: "M3 12a9 9 0 0 1 15.5-6.3M21 4v4h-4M21 12a9 9 0 0 1-15.5 6.3M3 20v-4h4",
  rebuild: "M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16",
  check: "M5 12.5l5 5 9-10",
  checkCircle: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 12l3 3 5-6",
  alert: "M12 3.5 22 19H2ZM12 10v4M12 17h.01",
  x: "M6 6l12 12M18 6 6 18",
  xCircle: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9 9l6 6M15 9l-6 6",
  chevR: "M9 6l6 6-6 6",
  chevD: "M6 9l6 6 6-6",
  chevL: "M15 6l-6 6 6 6",
  ext: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  copy: "M9 9h10v10a1 1 0 0 1-1 1H9zM15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  arrowL: "M19 12H5M11 6l-6 6 6 6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 7v5l3 2",
  trend: "M3 17l6-6 4 4 8-8M21 7v5h-5",
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21a7 7 0 0 1 14 0",
  dot: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  pause: "M8 5v14M16 5v14",
  layers: "M12 3 2 8.5 12 14l10-5.5zM2 13.5 12 19l10-5.5M2 16.5 12 22l10-5.5",
  code: "M9 8l-5 4 5 4M15 8l5 4-5 4",
  bolt: "M13 3 4 14h7l-1 7 9-11h-7z",
  flag: "M5 21V4M5 4c3-2 6 2 9 0s4-1 5-1v9c-1 0-2-1-5 1s-6-2-9 0",
  link: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1",
  doc2: "M7 3h7l5 5v13H7zM9.5 13h6M9.5 17h4M9.5 9h2",
  beaker: "M9 3v6l-5 9a2 2 0 0 0 1.8 3h12.4A2 2 0 0 0 20 18l-5-9V3M8 3h8M7.5 14h9",
  archive: "M3 7h18v3H3zM5 10v10h14V10M9.5 14h5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z",
  inbox: "M3 13h5l1.5 3h5L21 13M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  source: "M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14",
  zap: "M13 3 4 14h7l-1 7 9-11h-7z",
};

function Icon({ name, size = 18, className = "", style }) {
  const d = ICONS[name];
  const filled = name === "play" || name === "pause";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style}
      fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/* ---------- Status badge ---------- */
function Badge({ tone = "mut", children, dot = true, lg = false }) {
  return (
    <span className={`badge bg-${tone}${lg ? " lg" : ""}`}>
      {dot && <span className={`dot dot-${tone}`} />}
      {children}
    </span>
  );
}

function toneOfScore(s) {
  if (s >= 85) return "ok";
  if (s >= 75) return "info";
  if (s >= 60) return "warn";
  return "bad";
}
function scoreColor(s) {
  return { ok: "var(--ok-solid)", info: "var(--info-solid)", warn: "var(--warn-solid)", bad: "var(--bad-solid)" }[toneOfScore(s)];
}

/* ---------- Score chip ---------- */
function Score({ value, max = 100, label }) {
  if (value === 0 || value == null) return <span className="muted" style={{ color: "var(--ink-4)", fontWeight: 700 }}>—</span>;
  return (
    <span className="score" title={label}>
      <span className="n" style={{ color: scoreColor(value) }}>{value}</span>
      <span className="d">/{max}</span>
    </span>
  );
}

function Meter({ value, max = 100, tone }) {
  const pct = Math.round((value / max) * 100);
  const color = tone ? `var(--${tone}-solid)` : scoreColor(pct);
  return <div className="meter"><i style={{ width: pct + "%", background: color }} /></div>;
}

/* ---------- Button ---------- */
function Btn({ kind = "ghost", size, icon, iconR, children, onClick, disabled, title, style }) {
  const cls = ["btn", `btn-${kind}`, size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "", !children ? "btn-icon" : ""].filter(Boolean).join(" ");
  return (
    <button className={cls} onClick={disabled ? undefined : onClick} aria-disabled={disabled} disabled={disabled} title={title} style={style}>
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 16} />}
      {children}
      {iconR && <Icon name={iconR} size={size === "sm" ? 15 : 16} />}
    </button>
  );
}

/* ---------- Card ---------- */
function Card({ children, className = "", style, pad }) {
  return <div className={`card ${className}`} style={style}>{pad ? <div className="card-pad">{children}</div> : children}</div>;
}
function CardHead({ icon, title, hint, children }) {
  return (
    <div className="card-head">
      {icon && <span style={{ color: "var(--ink-3)", display: "flex" }}><Icon name={icon} size={17} /></span>}
      {title && <h3>{title}</h3>}
      {hint && <span className="hint">{hint}</span>}
      {children}
    </div>
  );
}

/* ---------- Modal ---------- */
function Modal({ title, onClose, children, footer, wide, tone }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className={`modal${wide ? " wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 20px 14px" }}>
          {tone && <span style={{ width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center", flex: "0 0 auto", background: `var(--${tone}-bg)`, color: `var(--${tone})` }}><Icon name={tone === "bad" ? "alert" : tone === "warn" ? "alert" : "rebuild"} size={19} /></span>}
          <h3 style={{ margin: 0, fontSize: 16.5, fontWeight: 800, letterSpacing: "-.01em" }}>{title}</h3>
          <button className="btn btn-soft btn-icon btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ padding: "0 20px 18px", color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.65 }}>{children}</div>
        {footer && <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "14px 20px", borderTop: "1px solid var(--line-soft)", background: "var(--surface-2)" }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- Toasts ---------- */
function Toasts({ items }) {
  return (
    <div className="toast-wrap">
      {items.map((t) => (
        <div className="toast" key={t.id}>
          <Icon name={t.icon || "checkCircle"} size={17} style={{ color: t.color || "var(--ok-solid)" }} />
          {t.msg}
        </div>
      ))}
    </div>
  );
}

/* ---------- Empty state ---------- */
function Empty({ icon = "inbox", title, desc, action }) {
  return (
    <div className="empty">
      <div className="ico"><Icon name={icon} size={24} /></div>
      <h4>{title}</h4>
      {desc && <p>{desc}</p>}
      {action}
    </div>
  );
}

/* ---------- Step / status helpers ---------- */
const STEP_TONE = { pending: "mut", running: "info", success: "ok", warning: "warn", failed: "bad", skipped: "mut" };
const STEP_LABEL = { pending: "等待中", running: "运行中", success: "成功", warning: "有警告", failed: "失败", skipped: "已跳过" };

function fmtDur(ms) {
  if (!ms) return "—";
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  return Math.floor(s / 60) + "分" + Math.round(s % 60) + "秒";
}

Object.assign(window, {
  Icon, Badge, Score, Meter, Btn, Card, CardHead, Modal, Toasts, Empty,
  toneOfScore, scoreColor, STEP_TONE, STEP_LABEL, fmtDur,
  useState, useEffect, useRef, useMemo,
});
