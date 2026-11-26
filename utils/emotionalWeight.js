// =================================================================
// emotional_weight 归一化与时间衰减
//
// 0 是有效分值：Scribe 的评分锚定把 0.0 定义为「纯事实，零情绪」。
// 只有 null / undefined / 空串 / 非有限数才使用默认值。
// =================================================================

const DEFAULT_EMOTIONAL_WEIGHT = 0.5;

function isMissingEmotionalWeight(value) {
  if (value === null || value === undefined || value === '') return true;
  const n = typeof value === 'number' ? value : Number(value);
  return !Number.isFinite(n);
}

function normalizeEmotionalWeight(value, fallback = DEFAULT_EMOTIONAL_WEIGHT) {
  if (isMissingEmotionalWeight(value)) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Math.min(1, Math.max(0, n));
}

// 时间衰减：半衰期由 emotional_weight 决定
// ew ≥ 0.8 → λ=0.005 (140天半衰期)  重要记忆持久
// ew ≥ 0.6 → λ=0.01  (70天半衰期)   标准
// ew ≥ 0.4 → λ=0.02  (35天半衰期)   轻度记忆较快消退
// ew  < 0.4 → λ=0.04  (17天半衰期)   琐碎信息快速沉底
function getDecayLambda(emotionalWeight) {
  const ew = normalizeEmotionalWeight(emotionalWeight);
  if (ew >= 0.8) return 0.005;
  if (ew >= 0.6) return 0.01;
  if (ew >= 0.4) return 0.02;
  return 0.04;
}

// 分段衰减（Ombre Brain 启发）：前3天新鲜度主导，3天后情绪强度主导
// 短线：timeWeight=0.7 emotionWeight=0.3 → 新鲜事优先浮现
// 长线：timeWeight=0.3 emotionWeight=0.7 → 高ew记忆顽强存活，低ew琐碎快速沉底
const STM_TIME_WEIGHT = 0.7;     // ≤3天：时间新鲜度权重
const LTM_EMOTION_WEIGHT = 0.7;  // >3天：情绪强度权重
const SEGMENT_DAYS = 3;          // 分段切换天数

function segmentedDecay(days, emotionalWeight) {
  const ew = normalizeEmotionalWeight(emotionalWeight);
  const lambda = getDecayLambda(ew);
  // 纯时间衰减
  const timeDecay = Math.exp(-lambda * days);
  // 情绪保留：越高ew记忆越不容易被时间冲淡
  const emotionRetention = 0.3 + ew * 0.7;

  if (days <= SEGMENT_DAYS) {
    // 短期：新鲜度为王。近期发生的事即使分量轻也值得浮现
    return STM_TIME_WEIGHT * timeDecay + (1 - STM_TIME_WEIGHT) * emotionRetention;
  }
  // 长期：情绪接管。3天后时间不再是最重要的——ew=0.8的记忆可能比ew=0.3的存活长4倍
  return (1 - LTM_EMOTION_WEIGHT) * timeDecay + LTM_EMOTION_WEIGHT * emotionRetention;
}

module.exports = {
  DEFAULT_EMOTIONAL_WEIGHT,
  isMissingEmotionalWeight,
  normalizeEmotionalWeight,
  getDecayLambda,
  segmentedDecay,
  STM_TIME_WEIGHT,
  LTM_EMOTION_WEIGHT,
  SEGMENT_DAYS,
};
