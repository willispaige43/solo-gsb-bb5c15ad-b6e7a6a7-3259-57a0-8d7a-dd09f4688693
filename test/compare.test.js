'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, PIECE_SORT_STRATEGIES } = require('../src/packer');
const { layoutCompare, normalizeObjective } = require('../src/compare');

const EPS = 1e-6;

// 各策略在该输入上的指标（经模糊搜索构造的分歧用例）：
//   area-desc/longest-edge-desc：12 件 / 17762 mm² / 17 刀
//   aspect-diff-desc          ：11 件 / 17186 mm² / 16 刀
const DIVERGENT_INPUT = {
  paperW: 98, paperH: 229, kerf: 3,
  products: [
    { width: 75, height: 166, quantity: 8 },
    { width: 42, height: 134, quantity: 5 },
    { width: 40, height: 151, quantity: 4 },
    { width: 14, height: 32, quantity: 8 },
    { width: 16, height: 32, quantity: 6 },
  ],
};

// 件数相同（均 5 件）、刀数不同的用例：
//   area-desc/longest-edge-desc：8262 mm² / 6 刀
//   aspect-diff-desc          ：8091 mm² / 7 刀
const SAME_PIECES_DIFF_CUTS = {
  paperW: 129, paperH: 80, kerf: 3,
  products: [
    { width: 57, height: 29, quantity: 5 },
    { width: 57, height: 26, quantity: 10 },
    { width: 10, height: 36, quantity: 7 },
    { width: 97, height: 57, quantity: 8 },
  ],
};

test('返回全部三种策略候选及其指标与完整布局', () => {
  const r = layoutCompare(DIVERGENT_INPUT);
  assert.deepStrictEqual(
    r.candidates.map((c) => c.strategy),
    PIECE_SORT_STRATEGIES.map((s) => s.id)
  );
  assert.deepStrictEqual(
    r.candidates.map((c) => c.label),
    ['面积降序', '最长边降序', '宽高差降序']
  );
  for (const cand of r.candidates) {
    // 指标与各策略单独调用 layout() 完全一致
    const direct = layout(DIVERGENT_INPUT, { sortStrategy: cand.strategy });
    assert.strictEqual(cand.metrics.piecesPlaced, direct.stats.piecesPlaced);
    assert.strictEqual(cand.metrics.placedArea, direct.stats.placedArea);
    assert.strictEqual(cand.metrics.cutsTotal, direct.stats.cutsTotal);
    assert.strictEqual(cand.metrics.piecesTotal, direct.stats.piecesTotal);
    assert.strictEqual(cand.metrics.areaRatio, direct.stats.areaRatio);
    assert.strictEqual(cand.layout.stats.piecesPlaced, cand.metrics.piecesPlaced);
    assert.ok(cand.layout.items.length >= 0);
    assert.strictEqual(typeof cand.best, 'boolean');
  }
  // 恰有一个最佳项
  assert.strictEqual(r.candidates.filter((c) => c.best).length, 1);
  assert.strictEqual(r.paper.width, 98);
  assert.strictEqual(r.paper.height, 229);
  assert.strictEqual(r.paper.kerf, 3);
});

test('每个候选布局都遵守断头台/刀缝/旋转/纹向规则', () => {
  const r = layoutCompare({
    paperW: 300, paperH: 300, kerf: 3, paperGrain: 'along-height',
    products: [
      { width: 120, height: 90, quantity: 8, grain: 'along-height' },
      { width: 80, height: 60, quantity: 10 },
      { width: 200, height: 50, quantity: 4, grain: 'along-width' },
    ],
  });
  for (const cand of r.candidates) {
    for (const it of cand.layout.items) {
      assert.ok(it.x >= -EPS && it.y >= -EPS);
      assert.ok(it.x + it.w <= 300 + EPS && it.y + it.h <= 300 + EPS);
      assert.strictEqual(it.grainOk, true);
    }
    for (const c of cand.layout.cuts) {
      if (c.orient === 'v') {
        assert.ok(Math.abs(c.band.w - 3) < EPS);
        assert.ok(Math.abs(c.band.h - c.region.h) < EPS);
      } else {
        assert.ok(Math.abs(c.band.h - 3) < EPS);
        assert.ok(Math.abs(c.band.w - c.region.w) < EPS);
      }
    }
  }
});

test('优先多排：按已排件数决胜（少排一件的策略即使刀更少也落选）', () => {
  const r = layoutCompare({ ...DIVERGENT_INPUT, objective: 'more-pieces' });
  assert.strictEqual(r.objective, 'more-pieces');
  assert.strictEqual(r.objectiveLabel, '优先多排');
  assert.strictEqual(r.best, 'area-desc');
  assert.ok(r.candidates[0].best);
  assert.ok(!r.candidates[2].best);
  // 首项依据即件数：12 件两策略存活，11 件被淘汰
  const first = r.decision.steps[0];
  assert.strictEqual(first.criterion, 'piecesPlaced');
  assert.strictEqual(first.direction, 'desc');
  assert.deepStrictEqual(first.eliminated, ['aspect-diff-desc']);
  assert.deepStrictEqual(first.kept.sort(), ['area-desc', 'longest-edge-desc']);
  assert.strictEqual(r.decision.excludeEmpty, false);
});

test('优先多排：件数并列时按已排面积，再并列按刀数，最后策略顺序', () => {
  // area-desc 与 longest-edge-desc 在该用例指标完全相同 → 走到策略顺序
  const r = layoutCompare({ ...DIVERGENT_INPUT, objective: 'more-pieces' });
  const crits = r.decision.steps.map((s) => s.criterion);
  assert.deepStrictEqual(crits, ['piecesPlaced', 'placedArea', 'cutsTotal', 'seq']);
  const seqStep = r.decision.steps[3];
  assert.deepStrictEqual(seqStep.kept, ['area-desc']);
  assert.deepStrictEqual(seqStep.eliminated, ['longest-edge-desc']);
});

test('优先省刀：排除空方案后按刀数决胜（16 刀胜过 17 刀，即使件数更少）', () => {
  const r = layoutCompare({ ...DIVERGENT_INPUT, objective: 'fewer-cuts' });
  assert.strictEqual(r.objective, 'fewer-cuts');
  assert.strictEqual(r.best, 'aspect-diff-desc');
  assert.strictEqual(r.decision.excludeEmpty, true);
  assert.deepStrictEqual(r.decision.excluded, []);
  const first = r.decision.steps[0];
  assert.strictEqual(first.criterion, 'cutsTotal');
  assert.strictEqual(first.direction, 'asc');
  assert.deepStrictEqual(first.kept, ['aspect-diff-desc']);
  assert.deepStrictEqual(first.eliminated.sort(), ['area-desc', 'longest-edge-desc']);
});

test('优先省刀：件数相同时刀数少者胜，再依次比面积、件数', () => {
  const r = layoutCompare({ ...SAME_PIECES_DIFF_CUTS, objective: 'fewer-cuts' });
  assert.strictEqual(r.best, 'area-desc');
  assert.strictEqual(r.decision.steps[0].criterion, 'cutsTotal');
  assert.deepStrictEqual(r.decision.steps[0].eliminated, ['aspect-diff-desc']);
});

test('三种策略全部排不进：不指定最佳项并沿用未排原因', () => {
  const input = {
    paperW: 100, paperH: 100, kerf: 2, objective: 'fewer-cuts',
    products: [
      { width: 200, height: 200, quantity: 3 },
      { width: 150, height: 80, quantity: 2 },
    ],
  };
  const r = layoutCompare(input);
  assert.strictEqual(r.best, null);
  assert.ok(r.candidates.every((c) => c.best === false));
  assert.ok(r.candidates.every((c) => c.metrics.piecesPlaced === 0));
  // 省刀目标：三种均作为空方案被排除，且不产生决胜步骤
  assert.deepStrictEqual(r.decision.excluded.sort(), [
    'area-desc', 'aspect-diff-desc', 'longest-edge-desc',
  ]);
  assert.strictEqual(r.decision.steps.length, 0);
  // 顶层沿用单张未排原因
  assert.strictEqual(r.unplaced.length, 2);
  assert.strictEqual(r.unplaced.reduce((s, u) => s + u.quantity, 0), 5);
  assert.ok(r.unplaced.every((u) => u.grainBlocked === false));

  // 多排目标同样不指定最佳项
  const r2 = layoutCompare({ ...input, objective: 'more-pieces' });
  assert.strictEqual(r2.best, null);
  assert.deepStrictEqual(r2.decision.excluded, []);
  assert.strictEqual(r2.unplaced.length, 2);
});

test('纹向受阻时未排原因标记 grainBlocked（沿用单张诊断）', () => {
  // 成品仅允许的朝向（不旋转 200 宽）放不进纸宽 120；旋转几何可行
  // （60×200 在 120×220 内）但纹向不允许 → 纹向受阻
  const r = layoutCompare({
    paperW: 120, paperH: 220, kerf: 0, paperGrain: 'along-width',
    objective: 'more-pieces',
    products: [{ width: 200, height: 60, quantity: 1, grain: 'along-width' }],
  });
  assert.strictEqual(r.best, null);
  assert.strictEqual(r.unplaced.length, 1);
  assert.strictEqual(r.unplaced[0].grainBlocked, true);
  for (const cand of r.candidates) {
    assert.strictEqual(cand.layout.unplaced[0].grainBlocked, true);
  }
});

test('三策略结果完全一致时：多排目标首选面积降序，省刀目标按同指标取面积降序', () => {
  // 单一品种规整网格，件序策略之间无分歧
  const r1 = layoutCompare({
    paperW: 300, paperH: 200, kerf: 0,
    products: [{ width: 100, height: 100, quantity: 20 }],
  });
  assert.strictEqual(r1.best, 'area-desc');
  assert.ok(r1.candidates.every((c) => c.metrics.piecesPlaced === 6));
  const r2 = layoutCompare({
    paperW: 300, paperH: 200, kerf: 0, objective: 'fewer-cuts',
    products: [{ width: 100, height: 100, quantity: 20 }],
  });
  assert.strictEqual(r2.best, 'area-desc');
});

test('objective 规范化与校验', () => {
  assert.strictEqual(normalizeObjective(undefined), 'more-pieces');
  assert.strictEqual(normalizeObjective(''), 'more-pieces');
  assert.strictEqual(normalizeObjective('fewer-cuts'), 'fewer-cuts');
  assert.throws(() => normalizeObjective('xxx'), /比选目标/);
  assert.throws(
    () => layoutCompare({ ...SAME_PIECES_DIFF_CUTS, objective: 'cheap' }),
    /比选目标/
  );
});

test('纸张/成品参数非法时抛出（沿用 layout 校验）', () => {
  assert.throws(() => layoutCompare({ paperW: 0, paperH: 100, kerf: 1, products: [] }));
  assert.throws(() => layoutCompare({ paperW: 100, paperH: 100, kerf: -1, products: [] }));
  assert.throws(() => layoutCompare({
    paperW: 100, paperH: 100, kerf: 1,
    products: [{ width: -5, height: 10, quantity: 1 }],
  }));
});
