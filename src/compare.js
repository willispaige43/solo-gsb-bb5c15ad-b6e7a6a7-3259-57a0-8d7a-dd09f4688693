'use strict';

/**
 * 单张方案比选
 *
 * 对同一输入分别运行三种确定性件序策略（面积降序 / 最长边降序 /
 * 宽高差降序）的单张排样——每种策略仍完全遵守断头台二分、刀缝占位、
 * 旋转与纹向规则，仅“下一件优先排谁”的顺序不同。
 *
 * 用户目标（objective）：
 *  - 'more-pieces'（优先多排，缺省）：
 *    已排件数 ↓ → 已排面积 ↓ → 刀数 ↑ → 策略顺序；
 *  - 'fewer-cuts'（优先省刀）：先排除一件都排不进的空方案，再按
 *    刀数 ↑ → 已排面积 ↓ → 已排件数 ↓ → 策略顺序。
 * 三种策略全部排不进时不指定最佳项（best 为 null），顶层 unplaced
 * 沿用单张排样的未排原因（尺寸不足 / 纹向受限）。
 */

const { layout, PIECE_SORT_STRATEGIES } = require('./packer');

const EPS = 1e-6;

const OBJECTIVES = {
  'more-pieces': {
    label: '优先多排',
    excludeEmpty: false,
    criteria: [
      { key: 'piecesPlaced', dir: 'desc', label: '已排件数多者优先' },
      { key: 'placedArea', dir: 'desc', label: '已排成品面积大者优先' },
      { key: 'cutsTotal', dir: 'asc', label: '总刀数少者优先' },
      { key: 'seq', dir: 'asc', label: '策略顺序优先（面积降序 → 最长边降序 → 宽高差降序）' },
    ],
  },
  'fewer-cuts': {
    label: '优先省刀',
    excludeEmpty: true,
    criteria: [
      { key: 'cutsTotal', dir: 'asc', label: '总刀数少者优先' },
      { key: 'placedArea', dir: 'desc', label: '已排成品面积大者优先' },
      { key: 'piecesPlaced', dir: 'desc', label: '已排件数多者优先' },
      { key: 'seq', dir: 'asc', label: '策略顺序优先（面积降序 → 最长边降序 → 宽高差降序）' },
    ],
  },
};

/** 规范化比选目标：缺省优先多排 */
function normalizeObjective(value) {
  if (value == null || value === '') return 'more-pieces';
  const s = String(value);
  if (!OBJECTIVES[s]) {
    throw new Error('比选目标（objective）必须是 more-pieces（优先多排）或 fewer-cuts（优先省刀）');
  }
  return s;
}

function metricOf(candidate, key) {
  return key === 'seq' ? candidate.seq : candidate.metrics[key];
}

/**
 * 逐步淘汰决胜：每一步按一个指标筛出并列最优者（EPS 容差），
 * 直到只剩一个候选；策略顺序（seq）是最后一道决胜，必然收敛。
 * @returns { best, excluded, steps }
 *   best 为 null 表示无可参选（空方案被全部排除）；
 *   excluded 为因空方案被排除的策略 id（仅省刀目标可能非空）；
 *   steps 为逐项选择依据（每步的各候选取值、存活与淘汰名单）。
 */
function selectBest(candidates, spec) {
  let pool = spec.excludeEmpty
    ? candidates.filter((c) => c.metrics.piecesPlaced > 0)
    : [...candidates];
  const excluded = spec.excludeEmpty
    ? candidates.filter((c) => c.metrics.piecesPlaced === 0).map((c) => c.strategy)
    : [];
  const steps = [];
  for (const crit of spec.criteria) {
    if (pool.length <= 1) break;
    const values = pool.map((c) => metricOf(c, crit.key));
    const bestVal = crit.dir === 'desc' ? Math.max(...values) : Math.min(...values);
    const inEps = (v) => Math.abs(v - bestVal) <= EPS;
    const kept = pool.filter((c, i) => inEps(values[i]));
    steps.push({
      criterion: crit.key,
      label: crit.label,
      direction: crit.dir,
      values: pool.map((c, i) => ({ strategy: c.strategy, value: values[i] })),
      kept: kept.map((c) => c.strategy),
      eliminated: pool.filter((c, i) => !inEps(values[i])).map((c) => c.strategy),
    });
    pool = kept;
  }
  return { best: pool[0] || null, excluded, steps };
}

/**
 * 主入口
 * @param {object} input  同 layout()，另可选 objective: 'more-pieces' | 'fewer-cuts'
 * @returns {{
 *   objective: string, objectiveLabel: string, paper: object,
 *   best: string|null,           // 最佳策略 id；全部排不进为 null
 *   decision: { excludeEmpty, excluded, steps },  // 逐项选择依据
 *   candidates: Array,           // 三策略各自的指标与完整布局（含 best 标记）
 *   unplaced?: Array             // 仅全部排不进时返回，沿用单张未排原因
 * }}
 */
function layoutCompare(input) {
  const objective = normalizeObjective(input.objective);
  const spec = OBJECTIVES[objective];

  // 同一输入 × 三种确定性件序策略（断头台/刀缝/旋转/纹向规则完全一致）
  const candidates = PIECE_SORT_STRATEGIES.map((s, idx) => {
    const result = layout(input, { sortStrategy: s.id });
    return {
      strategy: s.id,
      label: s.label,
      seq: idx,
      metrics: {
        piecesPlaced: result.stats.piecesPlaced,
        piecesTotal: result.stats.piecesTotal,
        placedArea: result.stats.placedArea,
        cutsTotal: result.stats.cutsTotal,
        areaRatio: result.stats.areaRatio,
      },
      layout: result,
    };
  });

  // 三种策略全部排不进：不指定最佳项，沿用现有未排原因。
  // （此时各候选均未放置任何件，自由区域同为整张纸，unplaced 完全一致）
  const allEmpty = candidates.every((c) => c.metrics.piecesPlaced === 0);
  let best = null;
  let excluded = [];
  let steps = [];
  if (!allEmpty) {
    ({ best, excluded, steps } = selectBest(candidates, spec));
  } else if (spec.excludeEmpty) {
    excluded = candidates.map((c) => c.strategy);
  }

  return {
    objective,
    objectiveLabel: spec.label,
    paper: candidates[0].layout.paper,
    best: best ? best.strategy : null,
    decision: {
      excludeEmpty: spec.excludeEmpty,
      excluded,
      steps,
    },
    candidates: candidates.map((c) => ({
      strategy: c.strategy,
      label: c.label,
      metrics: c.metrics,
      best: !!best && best.strategy === c.strategy,
      layout: c.layout,
    })),
    ...(allEmpty ? { unplaced: candidates[0].layout.unplaced } : {}),
  };
}

module.exports = { layoutCompare, normalizeObjective, OBJECTIVES };
