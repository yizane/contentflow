// collect_http_lib.js — HTTP 类源采集（rss/atom/fetch_page/discover），纯内存返回，不写文件不写库
const config = require('./config_lib');

const FETCH_TIMEOUT = 12000;
const MAX_ITEMS_PER_FEED = 8;
const MAX_LINKS_PER_PAGE = 8;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) flyfus-content-agent/0.3 source-collector';

function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).slice(0, 1_500_000);
  } finally {
    clearTimeout(timer);
  }
}

function parseFeed(xml, source) {
  const items = [];
  const isAtom = /<feed[\s>]/.test(xml) && !/<rss[\s>]/.test(xml);
  const blocks = isAtom ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [] : xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const block of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const pick = (tags) => {
      for (const tag of tags) {
        const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        if (m) return decodeEntities(m[1]);
      }
      return '';
    };
    let link = '';
    if (isAtom) {
      const lm = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
      link = lm ? decodeEntities(lm[1]) : '';
    } else {
      link = pick(['link', 'guid']);
    }
    const title = pick(['title']);
    if (!title && !link) continue;
    items.push({
      title, url: link, publishedAt: pick(['pubDate', 'published', 'updated', 'dc:date']),
      summary: pick(['description', 'summary', 'content']).slice(0, 400),
      sourceName: source.name, sourceGroup: source.group, sourceCategory: source.category,
      itemType: isAtom ? 'atom' : 'rss',
    });
  }
  return items;
}

function parsePage(html, source) {
  const items = [];
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleM ? decodeEntities(titleM[1]) : source.name;
  let origin = '';
  try { origin = new URL(source.url).origin; } catch (_) { /* */ }
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href=["']([^"'#?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) && items.length < MAX_LINKS_PER_PAGE) {
    let href = m[1];
    const text = decodeEntities(m[2]);
    if (!text || text.length < 12 || text.length > 160) continue;
    try { href = new URL(href, source.url).toString(); } catch (_) { continue; }
    if (origin && !href.startsWith(origin)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({ title: text, url: href, publishedAt: '', summary: '', sourceName: source.name, sourceGroup: source.group, sourceCategory: source.category, itemType: 'fetch_page' });
  }
  if (items.length === 0) {
    items.push({ title: pageTitle, url: source.url, publishedAt: '', summary: '(page-level item)', sourceName: source.name, sourceGroup: source.group, sourceCategory: source.category, itemType: 'fetch_page' });
  }
  return items;
}

// HTTP 源采集（search_query 由 pipeline_lib 走 OpenClaw）
// 返回 perSource：每个源的采集明细（供 source_collection_logs）
async function collectHttpSources() {
  const warnings = [];
  const summary = { total: 0, rss: 0, atom: 0, fetchPage: 0, searchQuery: 0, skipped: 0, failed: 0 };
  const items = [];
  const perSource = [];
  const sources = config.getSourceItems().filter((s) => s.type !== 'search_query');

  await Promise.all(sources.map(async (s) => {
    const started = Date.now();
    if (s.requires_auth === 'true') {
      summary.skipped++;
      warnings.push(`skipped（requires_auth）: ${s.name}`);
      perSource.push({ source: s, status: 'skipped', httpStatus: null, itemsFound: 0, durationMs: 0, warningMessage: 'requires_auth=true，自动采集跳过' });
      return;
    }
    try {
      let got = [];
      if (s.type === 'rss' || s.type === 'atom' || s.type === 'discover_feed_or_fetch') {
        const text = await fetchText(s.url);
        if (/<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/.test(text.slice(0, 2000))) {
          got = parseFeed(text, s);
          got.forEach((it) => (it.itemType === 'atom' ? summary.atom++ : summary.rss++));
        } else {
          got = parsePage(text, s);
          summary.fetchPage += got.length;
        }
      } else if (s.type === 'fetch_page') {
        const html = await fetchText(s.url);
        got = parsePage(html, s);
        summary.fetchPage += got.length;
      }
      items.push(...got);
      perSource.push({
        source: s, status: got.length > 0 ? 'success' : 'partial', httpStatus: 200,
        itemsFound: got.length, durationMs: Date.now() - started,
        sampleTitles: got.slice(0, 3).map((g) => g.title.slice(0, 80)),
        warningMessage: got.length === 0 ? '抓取成功但未提取到条目' : null,
      });
    } catch (err) {
      summary.failed++;
      const msg = err.name === 'AbortError' ? 'timeout' : err.message;
      const httpM = String(msg).match(/HTTP (\d+)/);
      warnings.push(`failed: ${s.name} — ${msg}`);
      perSource.push({ source: s, status: 'failed', httpStatus: httpM ? parseInt(httpM[1], 10) : null, itemsFound: 0, durationMs: Date.now() - started, errorMessage: msg });
    }
  }));

  return { items, summary, warnings, perSource };
}

module.exports = { collectHttpSources };
