// topic_dedupe_lib.js — single topic duplicate/defer/shadow decision point.
const { jaccard, normalizedTopic } = require('./source_identity_lib');

const DEFAULT_TOPIC_DEDUPE = {
  shadow_similarity_threshold: 0.75,
  defer_similarity_threshold: 0.55,
  penalty_similarity_threshold: 0.35,
  duplicate_defer_days: 14,
};

function topicDedupePolicy(policy = {}) {
  return { ...DEFAULT_TOPIC_DEDUPE, ...(policy.topic_dedupe || policy || {}) };
}

function duplicateDeferUntil(now, days = DEFAULT_TOPIC_DEDUPE.duplicate_defer_days) {
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now || Date.now());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function topicText(row) {
  return row.topic || row.title || row.t || row.normalized || '';
}

function findMostSimilar(candidate, recentTopics = []) {
  const candidateTopic = candidate.topic || candidate.title || '';
  const candidateNorm = normalizedTopic(candidateTopic);
  let best = { similarity: 0, duplicateOfTopicCandidateId: null, duplicateOfTopic: null, exact: false };
  for (const row of recentTopics) {
    const text = topicText(row);
    if (!text) continue;
    const rowNorm = row.normalized_topic || row.normalized || normalizedTopic(text);
    const exact = candidateNorm && rowNorm && candidateNorm === rowNorm;
    const sim = exact ? 1 : Math.max(jaccard(candidateTopic, text), jaccard(candidateNorm, rowNorm));
    if (sim > best.similarity) {
      best = {
        similarity: sim,
        duplicateOfTopicCandidateId: row.id || row.topic_candidate_id || null,
        duplicateOfTopic: text,
        exact,
      };
    }
  }
  return best;
}

function decideTopicDedupe(candidate, recentTopics = [], policy = {}, options = {}) {
  const p = topicDedupePolicy(policy);
  const best = findMostSimilar(candidate, recentTopics);
  const primaryKeyword = candidate.primaryKeyword || candidate.primary_keyword || null;

  if (best.exact) {
    return {
      decision: 'shadow_duplicate',
      duplicateOfTopicCandidateId: best.duplicateOfTopicCandidateId,
      similarity: 1,
      reason: `normalized topic exact duplicate: ${String(best.duplicateOfTopic || '').slice(0, 80)}`,
      maxSimilarity: best.similarity,
    };
  }
  if (best.similarity >= p.shadow_similarity_threshold) {
    return {
      decision: 'shadow_duplicate',
      duplicateOfTopicCandidateId: best.duplicateOfTopicCandidateId,
      similarity: best.similarity,
      reason: `topic similarity ${best.similarity.toFixed(2)} >= ${p.shadow_similarity_threshold}`,
      maxSimilarity: best.similarity,
    };
  }
  if (best.similarity >= p.defer_similarity_threshold) {
    return {
      decision: 'deferred_duplicate',
      duplicateOfTopicCandidateId: best.duplicateOfTopicCandidateId,
      similarity: best.similarity,
      reason: `topic similarity ${best.similarity.toFixed(2)} >= ${p.defer_similarity_threshold}`,
      maxSimilarity: best.similarity,
    };
  }

  const keywordArticleCount = options.keywordArticleCount ?? candidate.keywordArticleCount ?? null;
  const keywordLimit = options.keywordLimit ?? policy.dedupe?.max_articles_per_primary_keyword_in_window ?? 2;
  if (!options.ignoreKeywordThrottle && primaryKeyword && keywordArticleCount != null && keywordArticleCount >= keywordLimit) {
    return {
      decision: 'deferred_keyword',
      duplicateOfTopicCandidateId: null,
      similarity: best.similarity,
      reason: `primary_keyword "${primaryKeyword}" recent article count ${keywordArticleCount} >= ${keywordLimit}`,
      maxSimilarity: best.similarity,
    };
  }

  return {
    decision: 'unique',
    duplicateOfTopicCandidateId: null,
    similarity: best.similarity,
    reason: null,
    maxSimilarity: best.similarity,
  };
}

module.exports = {
  DEFAULT_TOPIC_DEDUPE,
  topicDedupePolicy,
  duplicateDeferUntil,
  findMostSimilar,
  decideTopicDedupe,
};
