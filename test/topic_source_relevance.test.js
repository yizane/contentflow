const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessCandidateSourceRelevance,
  applyCandidateSourceScoreGuard,
} = require('../scripts/lib/topic_source_relevance_lib');

test('caps and rejects high-score candidates supported only by non-Amazon ecommerce sources', () => {
  const candidate = {
    topic: 'CPC 上涨、CPA 飙升时，亚马逊卖家如何用意图词重搭广告结构降 ACoS',
    score: 90,
    priority: 'P0',
    sourceUrls: [
      'https://www.amz123.com/kx/AsKo4Dp6',
      'https://www.amz123.com/kx/8jjXfYSF',
    ],
  };
  const sourceByUrl = new Map([
    ['https://www.amz123.com/kx/AsKo4Dp6', {
      source_group: 'chinese_crossborder_news',
      source_name: 'AMZ123 - 跨境快讯',
      title: '俄电商广告成本上涨：2026年Q1点击价增19% 转化成本飙升近40%',
      summary: '俄罗斯电商广告成本显著上升，Wildberries、Ozon、Yandex Market 竞争加剧。',
    }],
    ['https://www.amz123.com/kx/8jjXfYSF', {
      source_group: 'chinese_crossborder_news',
      source_name: 'AMZ123 - 跨境快讯',
      title: '俄零售媒体广告市场2025年规模首次突破8000亿卢布，Wildberries与Magnit领跑',
      summary: '俄罗斯零售媒体广告市场高速增长，Wildberries、Ozon、Yandex Market 推动。',
    }],
  ]);

  const relevance = assessCandidateSourceRelevance(candidate, sourceByUrl);
  assert.equal(relevance.hasAmazonEcommerceSource, false);
  assert.equal(relevance.hasNonAmazonEcommerceSource, true);

  const guarded = applyCandidateSourceScoreGuard(candidate, relevance);
  assert.equal(guarded.score, 59);
  assert.equal(guarded.priority, 'P2');
  assert.equal(guarded.rejected, true);
  assert.match(guarded.reason, /非亚马逊电商行业/);
});

test('keeps scores for candidates backed by Amazon marketplace sources', () => {
  const candidate = {
    topic: 'CPSC 证书电子申报 7 月生效：FBA 受管制商品如何避免入仓延误',
    score: 91,
    priority: 'P0',
    sourceUrls: ['https://www.amz123.com/kx/c5JBlfir'],
  };
  const sourceByUrl = new Map([
    ['https://www.amz123.com/kx/c5JBlfir', {
      source_group: 'chinese_crossborder_news',
      source_name: 'AMZ123 - 跨境快讯',
      title: '亚马逊美国站7月8日起实施CPSC证书电子申报要求，FBA受管制商品需提前申报',
      summary: '亚马逊美国站向所有FBA卖家发布通知，受CPSC监管范围的进口消费品必须提前申报。',
    }],
  ]);

  const relevance = assessCandidateSourceRelevance(candidate, sourceByUrl);
  assert.equal(relevance.hasAmazonEcommerceSource, true);

  const guarded = applyCandidateSourceScoreGuard(candidate, relevance);
  assert.equal(guarded.score, 91);
  assert.equal(guarded.priority, 'P0');
  assert.equal(guarded.rejected, false);
});
