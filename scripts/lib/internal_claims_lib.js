// internal_claims_lib.js — 解析 config/internal_claims.yaml 并生成可注入 OpenClaw 任务的摘要块
const config = require('./config_lib');

function stripQuotes(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function loadInternalClaims() {
  const result = { allowedClaims: [], forbiddenClaims: [], preferredCta: [], disclaimer: '', policyRules: [] };
  const lines = config.getDoc('internal_claims').split('\n');

  let section = null; // allowed_claims | forbidden_claims | preferred_cta | disclaimer | claim_policy
  let subsection = null;
  let current = null;

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = line.length - line.trimStart().length;

    if (ind === 0 && t.endsWith(':')) {
      section = t.slice(0, -1);
      subsection = null;
      current = null;
      continue;
    }

    if (section === 'claim_policy' && ind === 2 && t === 'rules:') {
      subsection = 'rules';
      continue;
    }
    if (section === 'claim_policy' && subsection === 'rules' && t.startsWith('- ')) {
      result.policyRules.push(stripQuotes(t.slice(2)));
      continue;
    }

    if (section === 'allowed_claims') {
      if (t.startsWith('- id:')) {
        current = { id: stripQuotes(t.slice(5)) };
        result.allowedClaims.push(current);
        continue;
      }
      if (current) {
        const m = t.match(/^([\w]+)\s*:\s*(.+)$/);
        if (m) current[m[1]] = stripQuotes(m[2]);
      }
      continue;
    }

    if (section === 'forbidden_claims' && t.startsWith('- ')) {
      result.forbiddenClaims.push(stripQuotes(t.slice(2)));
      continue;
    }

    if (section === 'preferred_cta') {
      if (t === 'soft:') {
        subsection = 'soft';
        continue;
      }
      if (subsection === 'soft' && t.startsWith('- ')) {
        result.preferredCta.push(stripQuotes(t.slice(2)));
      }
      continue;
    }

    if (section === 'disclaimer') {
      const m = t.match(/^public_safe_wording\s*:\s*(.+)$/);
      if (m) result.disclaimer = stripQuotes(m[1]);
    }
  }
  return result;
}

// 生成注入 OpenClaw 任务的 Markdown 摘要块
function internalClaimsBlock() {
  const c = loadInternalClaims();
  return `## Flyfus 内部产品能力白名单（internal_claims registry，必须遵守）

凡是 Flyfus 产品能力相关 claim，必须对照本白名单处理，**不要用 web_search 找公开来源**（产品能力是内部事实）。

### 处理规则

1. claim 命中下方 allowed_claims → category=flyfus_product_claim，recommendedSourceGroup=internal_flyfus_data，action=keep 或 soften（用对应 public_wording 表述），sourceTrust=internal_product_claim，source.url 留空，notes/evidenceSummary 写明命中的 claim id。risk 不应为 high（除非表述含保证效果/排名/推荐）。
2. claim 不在 allowed_claims → action=soften 或 remove，resolvedStatus=needs_manual_review，notes 说明"不在 internal claims 白名单"。
3. claim 命中 forbidden_claims → 必须 remove，且 publishRecommendation 不得为 publish。
4. 禁止编造白名单之外的 Flyfus 能力。

### allowed_claims（可公开表述的产品能力）

${c.allowedClaims.map((a) => `- **${a.id}**: ${a.public_wording}${a.notes ? `（注意: ${a.notes}）` : ''}`).join('\n')}

### forbidden_claims（绝对禁止的表述）

${c.forbiddenClaims.map((f) => `- ${f}`).join('\n')}

### CTA 规范

Flyfus CTA 必须克制，优先使用以下表达之一（或同等克制的改写），**不得删除 CTA**：

${c.preferredCta.map((s) => `- ${s}`).join('\n')}

安全兜底表述：${c.disclaimer}`;
}

module.exports = { loadInternalClaims, internalClaimsBlock };
