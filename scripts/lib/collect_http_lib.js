// collect_http_lib.js — HTTP 类源采集（rss/atom/fetch_page/discover），纯内存返回，不写文件不写库
const config = require('./config_lib');
const runtime = require('./workflow_runtime_lib');

const FETCH_TIMEOUT = 12000;
const MAX_ITEMS_PER_FEED = 8;
const MAX_LINKS_PER_PAGE = 8;
const AMZ123_KX_API = 'https://api.amz123.com/ugc/v1/user_content/kx_list';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) flyfus-content-agent/0.3 source-collector';

function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch (_) {
    return '';
  }
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

async function fetchJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      redirect: 'follow',
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error('invalid JSON response');
    }
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
      sourceLane: source.lane, sourcePriority: source.priority, sourceFreshness: source.freshness,
      itemType: isAtom ? 'atom' : 'rss',
    });
  }
  return items;
}

function dailyKeyForShanghai() {
  if (process.env.ENGINE_DAILY_KEY) return process.env.ENGINE_DAILY_KEY;
  const d = runtime.engineNowDate(process.env.ENGINE_NOW);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function shanghaiDayWindow(dailyKey) {
  return {
    start: Math.floor(new Date(`${dailyKey}T00:00:00+08:00`).getTime() / 1000),
    end: Math.floor(new Date(`${dailyKey}T23:59:59+08:00`).getTime() / 1000),
  };
}

function shanghaiDateTimeFromEpoch(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function flattenAmzKxRows(data) {
  const rowMap = data && data.row_map ? data.row_map : {};
  const out = [];
  for (const value of Object.values(rowMap)) {
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      for (const item of row.kx_content || []) out.push(item);
    }
  }
  return out;
}

async function collectAmzKxApi(source) {
  const dailyKey = dailyKeyForShanghai();
  const window = shanghaiDayWindow(dailyKey);
  const body = {
    is_important: -1,
    category_id: 0,
    start_time: window.start,
    end_time: window.end,
    keyword: '',
    is_query_zb: 0,
    is_query_total_count: 1,
  };
  const json = await fetchJson(AMZ123_KX_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'app-id': '3',
      'project-id': 'ugc',
      Origin: 'https://www.amz123.com',
      Referer: 'https://www.amz123.com/',
    },
    body: JSON.stringify(body),
  });
  if (json.status !== 0) throw new Error(`AMZ123 kx API status ${json.status}: ${json.info || json.message || 'unknown'}`);
  const seen = new Set();
  const items = [];
  for (const row of flattenAmzKxRows(json.data)) {
    const id = row.id || String(row.resource_id || '');
    const url = id ? `https://www.amz123.com/kx/${id}` : '';
    const title = decodeEntities(row.title || '');
    if (!id || !url || !title || seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      publishedAt: shanghaiDateTimeFromEpoch(row.published_at),
      summary: decodeEntities(row.description || row.content || '').slice(0, 800),
      sourceName: source.name,
      sourceGroup: source.group,
      sourceCategory: source.category,
      sourceLane: source.lane,
      sourcePriority: source.priority,
      sourceFreshness: source.freshness,
      itemType: 'fetch_page',
      rawJson: { crawler: 'amz123_kx_api', dailyKey, endpoint: AMZ123_KX_API, apiItem: row },
    });
  }
  return items;
}

function parseAmzKxPage(html, source) {
  if (!/https?:\/\/(?:www\.)?amz123\.com\/kx\b/i.test(source.url || '')) return [];
  const items = [];
  const seen = new Set();
  const itemRe = /<div\b[^>]*class=["'][^"']*\bkx-item\b(?!-)[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bkx-item\b(?!-)|$)/gi;
  let m;
  while ((m = itemRe.exec(html)) && items.length < MAX_LINKS_PER_PAGE) {
    const block = m[1];
    const titleM = block.match(/<a\b(?=[^>]*class=["'][^"']*\bkx-item-title\b)[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleM) continue;
    const title = decodeEntities(titleM[2]);
    const url = absoluteUrl(titleM[1], source.url);
    if (!title || !url || seen.has(url)) continue;
    const summaryM = block.match(/<div\b(?=[^>]*class=["'][^"']*\bkx-item-description\b)[^>]*>([\s\S]*?)<\/div>/i);
    const timeM = block.match(/<div\b(?=[^>]*class=["'][^"']*\bkx-item-time\b)[^>]*>([\s\S]*?)<\/div>/i);
    seen.add(url);
    items.push({
      title, url,
      publishedAt: timeM ? decodeEntities(timeM[1]) : '',
      summary: summaryM ? decodeEntities(summaryM[1]).slice(0, 400) : '',
      sourceName: source.name, sourceGroup: source.group, sourceCategory: source.category,
      sourceLane: source.lane, sourcePriority: source.priority, sourceFreshness: source.freshness,
      itemType: 'fetch_page',
    });
  }
  return items;
}

function isAmzKxSource(source) {
  return /https?:\/\/(?:www\.)?amz123\.com\/kx\b/i.test(source.url || '');
}

function parsePage(html, source) {
  const structuredItems = parseAmzKxPage(html, source);
  if (structuredItems.length > 0) return structuredItems;

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
    href = absoluteUrl(href, source.url);
    if (!href) continue;
    if (origin && !href.startsWith(origin)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({ title: text, url: href, publishedAt: '', summary: '', sourceName: source.name, sourceGroup: source.group, sourceCategory: source.category, sourceLane: source.lane, sourcePriority: source.priority, sourceFreshness: source.freshness, itemType: 'fetch_page' });
  }
  if (items.length === 0) {
    items.push({ title: pageTitle, url: source.url, publishedAt: '', summary: '(page-level item)', sourceName: source.name, sourceGroup: source.group, sourceCategory: source.category, sourceLane: source.lane, sourcePriority: source.priority, sourceFreshness: source.freshness, itemType: 'fetch_page' });
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
        if (isAmzKxSource(s)) {
          try {
            got = await collectAmzKxApi(s);
          } catch (_) {
            const html = await fetchText(s.url);
            got = parsePage(html, s);
          }
        } else {
          const html = await fetchText(s.url);
          got = parsePage(html, s);
        }
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
