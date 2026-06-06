#!/usr/bin/env node
// package_export.js — 发布包写入 publish_packages 表（DB-only，不再生成 output/packages）
// 用法:
//   npm run package:export -- --status ready_for_review [--require-channels] [--with-channels]
//   npm run package:export -- --article-id <id> [--with-channels]
const my = require('../lib/mysql_lib');
const { generateChannelsForArticle, CHANNELS } = require('../lib/pipeline_lib');

function parseArgs(argv) {
  const args = { articleId: null, slug: null, status: null, limit: 10, requireChannels: false, withChannels: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--article-id') args.articleId = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--status') args.status = argv[++i];
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10) || 10;
    else if (argv[i] === '--require-channels') args.requireChannels = true;
    else if (argv[i] === '--with-channels') args.withChannels = true;
  }
  return args;
}

async function exportArticle(article, opts, warnings) {
  const ver = await my.latestVersion(article.id);
  if (!ver) return { articleId: article.id, ok: false, error: '无版本' };

  // --with-channels：先补齐缺失渠道
  if (opts.withChannels) {
    const existing = (await my.query('SELECT channel FROM channel_outputs WHERE article_id = ?', [article.id])).map((c) => c.channel);
    if (CHANNELS.some((c) => !existing.includes(c))) {
      const r = await generateChannelsForArticle(article, { engineRunId: null, missingOnly: true, force: false });
      if (r.failed.length) warnings.push(`${article.id} 渠道补齐部分失败: ${r.failed.map((f) => f.channel).join(',')}`);
    }
  }

  const channels = await my.query('SELECT channel, title, content_markdown, content_json, status FROM channel_outputs WHERE article_id = ? ORDER BY channel', [article.id]);
  const existingChannels = channels.map((c) => c.channel);
  const missingChannels = CHANNELS.filter((c) => !existingChannels.includes(c));
  const channelStatus = { required: CHANNELS, existing: existingChannels, missing: missingChannels, ready: missingChannels.length === 0 };

  const latestScore = (await my.query('SELECT * FROM seo_geo_scores WHERE article_id = ? ORDER BY created_at DESC LIMIT 1', [article.id]))[0];
  const latestFc = (await my.query('SELECT must_fix_json FROM fact_checks WHERE article_id = ? ORDER BY created_at DESC LIMIT 1', [article.id]))[0];
  const mustFix = latestFc ? my.asJson(latestFc.must_fix_json) || [] : [];
  const srStats = await my.query('SELECT resolved_status, COUNT(*) c FROM source_resolutions WHERE article_id = ? AND article_version_id = ? GROUP BY resolved_status', [article.id, ver.id]);

  const ready = article.status === 'ready_for_review' && channelStatus.ready;
  const visualPlan = my.asJson(ver.visual_plan_json) || (my.asJson(ver.article_json) || {}).visualPlan || [];
  const articleQuality = my.asJson(ver.article_quality_json) || null;
  const metadata = {
    articleId: article.id, title: article.title, slug: article.slug, status: article.status,
    contentType: article.content_type || null, businessCategory: article.business_category || null,
    topicCluster: article.topic_cluster || null,
    articleQualityScore: article.article_quality_score ?? null,
    visualPlanCount: visualPlan.length,
    requiredVisuals: visualPlan.filter((v) => v.required).length,
    hasVisualPlan: visualPlan.length > 0,
    primaryKeyword: article.primary_keyword, qualityScore: article.quality_score,
    publishRecommendation: article.publish_recommendation, factOverallRisk: article.fact_overall_risk,
    factPublishReadiness: article.fact_publish_readiness,
    latestSeoScore: latestScore ? latestScore.seo_score : null, latestGeoScore: latestScore ? latestScore.geo_score : null,
    latestOverallScore: latestScore ? latestScore.overall_score : null, scoreStrategy: latestScore ? latestScore.strategy : null,
    sourceResolutionStatsLatest: Object.fromEntries(srStats.map((s) => [s.resolved_status, s.c])),
    channelStatus, readyForPublishPackage: ready, remainingMustFix: mustFix,
    suggestedCommand: missingChannels.length ? `npm run channels:generate -- --article-id ${article.id} --missing-only` : null,
    generatedAt: new Date().toISOString(),
  };

  const readme = `# 发布包：${article.title}

- **status**: \`${article.status}\`　|　质量门 ${article.quality_score}/${article.publish_recommendation}　|　核查 ${article.fact_overall_risk || '-'}/${article.fact_publish_readiness || '-'}
- SEO/GEO: ${latestScore ? `SEO ${latestScore.seo_score} / GEO ${latestScore.geo_score} / 综合 ${latestScore.overall_score}（${latestScore.strategy}）` : '（未评分）'}
- 渠道: ${existingChannels.join(' / ') || '（无）'}${missingChannels.length ? `　缺失: ${missingChannels.join('/')}` : ' ✅'}
- **可进入人工终审**: ${ready ? '✅' : `❌（${article.status}${missingChannels.length ? '，渠道不全' : ''}）`}
${missingChannels.length ? `\n> 渠道不全：仍可用于官网文章，但不算完整多渠道发布包。补齐：\`${metadata.suggestedCommand}\`\n` : ''}
## 文章质量主评分

${article.article_quality_score != null ? `**${article.article_quality_score}/100**（${articleQuality ? articleQuality.qualityRecommendation : '-'}）${article.article_quality_score < 80 ? ' ⚠️ 低于 80，不得进入终审/发布' : ' ✅'}` : '（未评分：npm run score:article-quality -- --article-id ' + article.id + '）'}

## 视觉规划（发布前${visualPlan.length ? '需按以下 brief 补图' : '⚠️ 缺失视觉规划'}）

${visualPlan.length ? visualPlan.map((v, i) => `${i + 1}. **[${v.visualType}] ${v.title}**（${v.placement}${v.required ? '，必需' : ''}）\n   - 用途: ${v.purpose}\n   - brief: ${v.description}\n   - caption: ${v.caption}\n   - alt: ${v.altText}\n   - 生图提示: ${v.imagePrompt}`).join('\n') : '- 无（旧版本文章；修订时会补全）'}

## 仍需人工检查项

${mustFix.length ? mustFix.map((m, i) => `${i + 1}. ${m}`).join('\n') : '（无遗留 mustFix）'}

> 本发布包完整内容在 MySQL publish_packages 表中；Web 项目直接读取该表。`;

  const channelsJson = {};
  for (const c of channels) channelsJson[c.channel] = { title: c.title, contentMarkdown: c.content_markdown, json: my.asJson(c.content_json), status: c.status };

  const now = my.now();
  const existing = (await my.query('SELECT id FROM publish_packages WHERE article_id = ? AND article_version_id = ?', [article.id, ver.id]))[0];
  const fields = {
    slug: article.slug, status: article.status, metadata_json: metadata, readme_markdown: readme,
    article_markdown: ver.article_markdown, article_json: my.asJson(ver.article_json),
    quality_json: my.asJson(ver.quality_json), fact_check_json: my.asJson(ver.fact_check_json),
    source_resolution_json: my.asJson(ver.source_resolution_json), channels_json: channelsJson,
    visual_plan_json: visualPlan.length ? visualPlan : null,
    article_quality_json: articleQuality,
    ready_for_publish_package: ready ? 1 : 0, updated_at: now,
  };
  let pkgId;
  const trace = require('../lib/trace_lib');
  if (existing) {
    pkgId = existing.id;
    await my.update('publish_packages', fields, 'id = ?', [pkgId]);
  } else {
    pkgId = my.makeId('pkg');
    await my.insert('publish_packages', { id: pkgId, article_id: article.id, article_version_id: ver.id, created_at: now, ...fields });
    await trace.logStatusTransition({ entityType: 'publish_package', entityId: pkgId, fromStatus: null, toStatus: article.status, data: { ready } });
  }
  await trace.logWorkflowEvent({ engineRunId: process.env.ENGINE_RUN_ID || null, workflowStepId: process.env.WORKFLOW_STEP_ID || null, eventType: 'package_created', level: 'info', message: `发布包 ${existing ? '更新' : '创建'}: ${article.slug}（ready=${ready}）`, relatedType: 'publish_package', relatedId: pkgId });
  return { articleId: article.id, ok: true, packageId: pkgId, slug: article.slug, channelStatus, readyForPublishPackage: ready };
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    const articles = await my.findArticles({ articleId: args.articleId, slug: args.slug, status: args.status, limit: args.limit });
    if (articles.length === 0) {
      const cond = args.articleId || args.slug || `status=${args.status || '(未指定)'}`;
      console.log(JSON.stringify({ ok: true, exported: 0, message: `没有符合条件的文章（${cond}）——这不是错误`, packages: [] }, null, 2));
      return;
    }
    const warnings = [];
    const packages = [];
    for (const a of articles) packages.push(await exportArticle(a, args, warnings));
    const out = { ok: true, exported: packages.filter((p) => p.ok).length, packages, warnings };
    if (args.requireChannels) {
      const incomplete = packages.filter((p) => p.ok && !p.channelStatus.ready);
      if (incomplete.length) out.incompletePackages = incomplete.map((p) => ({ slug: p.slug, missing: p.channelStatus.missing }));
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await my.closePool();
  }
}

main();
