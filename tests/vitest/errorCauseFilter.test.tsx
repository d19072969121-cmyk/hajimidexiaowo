/**
 * 错因筛选器契约（A4 轮 · task-4）
 *
 * 三组不变量：
 * 1. **受控契约**：selected 进 / onChange 出，组件不持有状态；
 * 2. **筛选语义**：多选 OR、空选=全通过、前三个错因互斥、stale 可叠加；
 * 3. **规则不漂移**（关键）：共享判定与 `ReviewQuestionsView` 内实现的
 *    判定结果对同一输入必须逐项相同。
 *
 * 第 3 组的实现方式：在测试内**逐字转写** `ReviewQuestionsView.tsx:41-64`
 * 的实现作为参考，用同一批边界输入对拍。上游改了规则而共享模块没跟，
 * 或反之，本组直接变红。
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ErrorCauseFilter } from '@/components/review/ErrorCauseFilter';
import {
  ERROR_CAUSE_ORDER,
  STALE_DAYS,
  getErrorCauses,
  matchesErrorCauseFilter,
  type ErrorCause,
} from '@/components/review/errorCauseRules';
import type { Question } from '@/api/questionBankApi';

/**
 * 用仓内既有 i18n mock（tests/ct/mocks/react-i18next.tsx）而不是手搓 stub：
 * 它从真实 locale 文件读词条，因此测试用的是**真的中文标签**
 * （`review:questions.errorCause.*` → 「从未答对」等），
 * 也让 `getByRole('button', { name: '反复出错' })` 这类按文案查询可行。
 * 手搓「返回 key」的 stub 会让按文案查询全部失效。
 */
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('../ct/mocks/react-i18next')>(
    '../ct/mocks/react-i18next',
  );
  return { ...actual, default: actual.default ?? actual };
});

const DAY = 86_400_000;

/** 构造题目：只填判定用到的三个字段 */
const makeQuestion = (over: Partial<Question> = {}): Question =>
  ({
    id: 'q1',
    questionLabel: 'Q1',
    content: 'content',
    questionType: 'single_choice',
    ...over,
  }) as Question;

/** 相对当前时间的 ISO 时间戳 */
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();

describe('errorCauseRules: getErrorCauses 判定规则', () => {
  it('neverCorrect：答过但从未答对', () => {
    expect(getErrorCauses(makeQuestion({ attemptCount: 1, correctCount: 0 }))).toEqual(['neverCorrect']);
  });

  it('neverCorrect 优先于 repeatedErrors（else-if 链）', () => {
    // 错 5 次且从未答对 → 只出 neverCorrect，不出 repeatedErrors
    expect(getErrorCauses(makeQuestion({ attemptCount: 5, correctCount: 0 }))).toEqual(['neverCorrect']);
  });

  it('repeatedErrors：错误 ≥3 且答对过', () => {
    expect(getErrorCauses(makeQuestion({ attemptCount: 4, correctCount: 1 }))).toEqual(['repeatedErrors']);
  });

  it('highErrorRate：尝试 ≥2 且错误率 ≥60%（且未触发前两档）', () => {
    // 2 次错 2 次中的一半答对 → 错误 1 次 <3，走 highErrorRate：1/2=0.5 <0.6 → 不命中
    expect(getErrorCauses(makeQuestion({ attemptCount: 2, correctCount: 1 }))).toEqual([]);
    // 3 次里错 2 次 = 0.667 ≥0.6 → 命中
    expect(getErrorCauses(makeQuestion({ attemptCount: 3, correctCount: 1 }))).toEqual(['highErrorRate']);
  });

  it('三者互斥：任何输入最多命中前三个中的一个', () => {
    const inputs: Array<Partial<Question>> = [
      { attemptCount: 0, correctCount: 0 },
      { attemptCount: 1, correctCount: 0 },
      { attemptCount: 1, correctCount: 1 },
      { attemptCount: 2, correctCount: 1 },
      { attemptCount: 3, correctCount: 1 },
      { attemptCount: 5, correctCount: 0 },
      { attemptCount: 10, correctCount: 9 },
      { attemptCount: 4, correctCount: 1 },
    ];
    const firstThree: ErrorCause[] = ['neverCorrect', 'repeatedErrors', 'highErrorRate'];

    for (const over of inputs) {
      const hits = getErrorCauses(makeQuestion(over)).filter((c) => firstThree.includes(c));
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });

  it('stale：距上次作答 >14 天，且可与前三个叠加', () => {
    expect(getErrorCauses(makeQuestion({ attemptCount: 1, correctCount: 0, lastAttemptAt: daysAgo(15) })))
      .toEqual(['neverCorrect', 'stale']);
    // 边界：恰好 14 天不算 stale（上游是 > 严格大于）
    expect(getErrorCauses(makeQuestion({ attemptCount: 1, correctCount: 0, lastAttemptAt: daysAgo(14) })))
      .toEqual(['neverCorrect']);
  });

  it('stale 单独成立：答对过且无前三个错因', () => {
    expect(getErrorCauses(makeQuestion({ attemptCount: 3, correctCount: 3, lastAttemptAt: daysAgo(30) })))
      .toEqual(['stale']);
  });

  it('无作答记录时返回空数组（不含 stale，因 lastAttemptAt 缺失）', () => {
    expect(getErrorCauses(makeQuestion())).toEqual([]);
  });

  it('数据异常（correctCount > attemptCount，errors 为负）不抛错且不误判', () => {
    expect(getErrorCauses(makeQuestion({ attemptCount: 1, correctCount: 5 }))).toEqual([]);
  });

  it('STALE_DAYS 常量与上游同值', () => {
    expect(STALE_DAYS).toBe(14);
  });
});

// ============================================================================
// 关键组：规则漂移检测
// ============================================================================

/**
 * ⚠️ 参考实现：**逐字转写**自 `src/components/ReviewQuestionsView.tsx:41-64`。
 *
 * 不要「顺手简化」它——它的价值就在于与上游源码保持形态一致。
 * 上游若改了规则，本文件不会自动跟随，于是对拍失败 → 被发现。
 * 这是复制方案的漂移防线（见 errorCauseRules.ts 顶部说明）。
 */
const referenceGetErrorCauses = (question: Question): ErrorCause[] => {
  const attempts = question.attemptCount || 0;
  const correct = question.correctCount || 0;
  const errors = attempts - correct;
  const causes: ErrorCause[] = [];

  if (attempts > 0 && correct === 0) {
    causes.push('neverCorrect');
  } else if (errors >= 3) {
    causes.push('repeatedErrors');
  } else if (attempts >= 2 && errors / attempts >= 0.6) {
    causes.push('highErrorRate');
  }

  if (question.lastAttemptAt) {
    const diffDays = (Date.now() - new Date(question.lastAttemptAt).getTime()) / 86400000;
    if (diffDays > 14) causes.push('stale');
  }
  return causes;
};

describe('errorCauseRules: 与 ReviewQuestionsView 的规则一致性（防漂移）', () => {
  /** 覆盖所有分支与边界的输入矩阵 */
  const matrix: Array<Partial<Question>> = [];
  for (const attempts of [0, 1, 2, 3, 4, 5, 10]) {
    for (const correct of [0, 1, 2, 3, 5, 9]) {
      matrix.push({ attemptCount: attempts, correctCount: correct });
      matrix.push({ attemptCount: attempts, correctCount: correct, lastAttemptAt: daysAgo(1) });
      matrix.push({ attemptCount: attempts, correctCount: correct, lastAttemptAt: daysAgo(14) });
      matrix.push({ attemptCount: attempts, correctCount: correct, lastAttemptAt: daysAgo(15) });
      matrix.push({ attemptCount: attempts, correctCount: correct, lastAttemptAt: daysAgo(400) });
    }
  }

  it('输入矩阵非空（防空断言）', () => {
    expect(matrix.length).toBeGreaterThan(100);
  });

  it('共享判定与上游转写实现对全部输入产出相同结果', () => {
    const mismatches: string[] = [];

    for (const over of matrix) {
      const q = makeQuestion(over);
      const mine = getErrorCauses(q);
      const reference = referenceGetErrorCauses(q);
      if (JSON.stringify(mine) !== JSON.stringify(reference)) {
        mismatches.push(
          `${JSON.stringify(over)} → 共享=${JSON.stringify(mine)} 参考=${JSON.stringify(reference)}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('上游源码里的关键常量与分支仍在（防止上游静默改规则）', () => {
    // 转写实现会随上游漂移而失真，所以额外直接读上游源码，锁定几条形态特征。
    // 这条红了不代表共享模块错——代表**上游被改过**，需要人工核对两边。
    const upstream = readFileSync(
      resolve(process.cwd(), 'src/components/ReviewQuestionsView.tsx'),
      'utf-8',
    );

    expect(upstream).toContain('const STALE_DAYS = 14;');
    expect(upstream).toContain("type ErrorCause = 'neverCorrect' | 'repeatedErrors' | 'highErrorRate' | 'stale'");
    expect(upstream).toMatch(/if \(attempts > 0 && correct === 0\)/);
    expect(upstream).toMatch(/errors >= 3/);
    expect(upstream).toMatch(/errors \/ attempts >= 0\.6/);
  });
});

describe('errorCauseRules: matchesErrorCauseFilter 筛选语义（多选 OR）', () => {
  const neverCorrectQ = makeQuestion({ id: 'a', attemptCount: 1, correctCount: 0 });
  const repeatedQ = makeQuestion({ id: 'b', attemptCount: 4, correctCount: 1 });
  const staleQ = makeQuestion({ id: 'c', attemptCount: 3, correctCount: 3, lastAttemptAt: daysAgo(30) });
  const bothQ = makeQuestion({ id: 'd', attemptCount: 4, correctCount: 1, lastAttemptAt: daysAgo(30) });
  const cleanQ = makeQuestion({ id: 'e', attemptCount: 3, correctCount: 3 });

  it('空选择 = 全通过（不是全不通过）', () => {
    for (const q of [neverCorrectQ, repeatedQ, staleQ, cleanQ]) {
      expect(matchesErrorCauseFilter(q, [])).toBe(true);
      expect(matchesErrorCauseFilter(q, new Set())).toBe(true);
    }
  });

  it('单选：只放行命中该错因的题', () => {
    expect(matchesErrorCauseFilter(neverCorrectQ, ['neverCorrect'])).toBe(true);
    expect(matchesErrorCauseFilter(repeatedQ, ['neverCorrect'])).toBe(false);
    expect(matchesErrorCauseFilter(cleanQ, ['neverCorrect'])).toBe(false);
  });

  it('多选是 OR：命中任一即通过', () => {
    const sel: ErrorCause[] = ['neverCorrect', 'stale'];
    expect(matchesErrorCauseFilter(neverCorrectQ, sel)).toBe(true);
    expect(matchesErrorCauseFilter(staleQ, sel)).toBe(true);
    // bothQ 同时命中 repeatedErrors + stale，选 stale 应放行
    expect(matchesErrorCauseFilter(bothQ, sel)).toBe(true);
    // repeatedQ 只命中 repeatedErrors，不在选择里 → 过滤掉
    expect(matchesErrorCauseFilter(repeatedQ, sel)).toBe(false);
  });

  it('AND 语义必然产空集的组合，在 OR 下仍能放行（设计意图验证）', () => {
    // 「从未答对」与「反复错」互斥，若用 AND 则永远为空。
    // OR 语义下：neverCorrectQ 命中第一项即通过。
    expect(matchesErrorCauseFilter(neverCorrectQ, ['neverCorrect', 'repeatedErrors'])).toBe(true);
  });

  it('接受 Set 与数组两种入参，结果一致', () => {
    const arr: ErrorCause[] = ['stale'];
    const set = new Set<ErrorCause>(arr);
    for (const q of [neverCorrectQ, repeatedQ, staleQ, cleanQ]) {
      expect(matchesErrorCauseFilter(q, arr)).toBe(matchesErrorCauseFilter(q, set));
    }
  });

  it('叠加错因：选 stale 能同时捞出纯 stale 与「反复错+久未复习」', () => {
    expect(matchesErrorCauseFilter(staleQ, ['stale'])).toBe(true);
    expect(matchesErrorCauseFilter(bothQ, ['stale'])).toBe(true);
  });
});

describe('ErrorCauseFilter: 渲染与受控契约', () => {
  const renderFilter = (props: Partial<React.ComponentProps<typeof ErrorCauseFilter>> = {}) => {
    const onChange = vi.fn();
    const utils = render(
      <ErrorCauseFilter selected={[]} onChange={onChange} {...props} />,
    );
    return { onChange, ...utils };
  };

  it('渲染 4 个错因，顺序与 ERROR_CAUSE_ORDER 一致', () => {
    const { container } = renderFilter();
    const buttons = [...container.querySelectorAll('[data-error-cause]')];
    expect(buttons.map((b) => b.getAttribute('data-error-cause'))).toEqual([...ERROR_CAUSE_ORDER]);
  });

  it('无选中时不渲染清除按钮', () => {
    const { container } = renderFilter({ selected: [] });
    expect(container.querySelector('[data-error-cause-clear]')).toBeNull();
  });

  it('有选中时渲染清除按钮，点击回调空数组', () => {
    const { onChange, container } = renderFilter({ selected: ['stale'] });
    const clear = container.querySelector('[data-error-cause-clear]');
    expect(clear).not.toBeNull();
    fireEvent.click(clear!);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('选中态反映在 aria-pressed 与 data-active 上', () => {
    const { container } = renderFilter({ selected: ['repeatedErrors'] });
    const active = container.querySelector('[data-error-cause="repeatedErrors"]')!;
    const inactive = container.querySelector('[data-error-cause="stale"]')!;
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(active.getAttribute('data-active')).toBe('true');
    expect(inactive.getAttribute('aria-pressed')).toBe('false');
    expect(inactive.getAttribute('data-active')).toBeNull();
  });

  it('点击未选中项 → 追加；回调收到新数组', () => {
    const { onChange } = renderFilter({ selected: ['stale'] });
    fireEvent.click(screen.getByRole('button', { name: '反复出错' }));
    expect(onChange).toHaveBeenCalledWith(['repeatedErrors', 'stale']);
  });

  it('点击已选中项 → 取消', () => {
    const { onChange } = renderFilter({ selected: ['stale', 'neverCorrect'] });
    fireEvent.click(screen.getByRole('button', { name: '久未复习' }));
    expect(onChange).toHaveBeenCalledWith(['neverCorrect']);
  });

  it('取消最后一项后回调空数组（回到「不筛选」）', () => {
    const { onChange } = renderFilter({ selected: ['stale'] });
    fireEvent.click(screen.getByRole('button', { name: '久未复习' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('回调中的数组顺序恒为 ERROR_CAUSE_ORDER，与点击顺序无关', () => {
    const { onChange } = renderFilter({ selected: ['stale'] });
    // 先点最后一项的顺序位置更靠前的项，验证重排
    fireEvent.click(screen.getByRole('button', { name: '从未答对' }));
    expect(onChange).toHaveBeenCalledWith(['neverCorrect', 'stale']);
  });

  it('不修改入参数组（受控组件无副作用）', () => {
    const selected: ErrorCause[] = ['stale'];
    const snapshot = [...selected];
    const { onChange } = renderFilter({ selected });
    fireEvent.click(screen.getByRole('button', { name: '反复出错' }));
    expect(selected).toEqual(snapshot);
    expect(onChange.mock.calls[0][0]).not.toBe(selected);
  });

  it('受控：selected 不变时点击不改变自身渲染状态', () => {
    const { container } = renderFilter({ selected: ['stale'] });
    fireEvent.click(container.querySelector('[data-error-cause="neverCorrect"]')!);
    // 组件完全受控，父级没改 selected，高亮不应变化
    expect(container.querySelector('[data-error-cause="neverCorrect"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-error-cause="stale"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('disabled：所有按钮 disabled，点击不触发回调', () => {
    const { onChange, container } = renderFilter({ selected: ['stale'], disabled: true });
    for (const btn of container.querySelectorAll('[data-error-cause]')) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(container.querySelector('[data-error-cause="neverCorrect"]')!);
    expect(onChange).not.toHaveBeenCalled();

    // 清除按钮也必须禁用
    const clear = container.querySelector('[data-error-cause-clear]');
    expect((clear as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(clear!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('空列表场景：counts 全为 0 时仍渲染 4 个格子（筛选器不因无数据消失）', () => {
    const { container } = renderFilter({ counts: { neverCorrect: 0, repeatedErrors: 0, highErrorRate: 0, stale: 0 } });
    expect(container.querySelectorAll('[data-error-cause]')).toHaveLength(4);
  });

  it('counts 传入时渲染角标数字', () => {
    const { container } = renderFilter({ counts: { stale: 7 } });
    expect(container.querySelector('[data-error-cause="stale"]')!.textContent).toContain('7');
  });

  it('不传 counts 时不渲染角标（避免出现 undefined）', () => {
    const { container } = renderFilter();
    expect(container.textContent).not.toContain('undefined');
  });

  it('暴露 data-selected-count 供宿主/调试定位', () => {
    const { container } = renderFilter({ selected: ['stale', 'highErrorRate'] });
    expect(container.querySelector('[data-error-cause-filter]')!.getAttribute('data-selected-count')).toBe('2');
  });

  it('每格是 <button type="button">（防止在表单内误提交）', () => {
    const { container } = renderFilter();
    for (const btn of container.querySelectorAll('[data-error-cause]')) {
      expect(btn.getAttribute('type')).toBe('button');
    }
  });

  it('触控目标达 44px 底线（min-h-11，与 MobileTabBar 同口径）', () => {
    const { container } = renderFilter();
    for (const btn of container.querySelectorAll('[data-error-cause]')) {
      expect(btn.className).toContain('min-h-11');
    }
  });

  it('i18n：使用上游既有键，不硬编码中文', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/review/ErrorCauseFilter.tsx'),
      'utf-8',
    );
    expect(source).toContain('review:questions.errorCause.');
    // 不应出现裸中文标签字面量（注释除外，故只查 JSX 文本形态）
    expect(source).not.toMatch(/>\s*[\u4e00-\u9fa5]+\s*</);
  });
});
