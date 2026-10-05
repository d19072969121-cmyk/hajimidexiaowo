/**
 * 「AI 总结」关键词提炼的回归测试（E10）。
 *
 * ## 为什么必须测这个
 * 用户报的原话是「点击搜索无用，题庄额度减少，但是返回看不懂」。
 * 根因是：这个模式此前**没有关键词输入框**，直接把题干前 30 字当关键词发出去，
 * 而题庄的 `keyword` 是对**知识点标签**做匹配的（实测：用某题的 `knowledges`
 * 值回搜，3/3 命中同一知识点的题）。
 * 于是「搜题干原文」→ 匹配到文字相近但知识点不同的题 → 用户看不懂，额度白扣。
 *
 * 所以这里锁死两件事：
 * 1. **有 OCR 标签时必须用标签**（标签才是知识点）
 * 2. 没有标签时，术语表要能命中，且**长词优先**
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  summarizeQuestionKeyword,
  toSearchKeyword,
} from '@/features/practice/questionBank/bankClient';

describe('summarizeQuestionKeyword', () => {
  it('有 OCR 标签时，取最长的标签（标签本身就是知识点）', () => {
    const r = summarizeQuestionKeyword({
      question: '任意题干',
      tags: ['函数', '反比例函数与一次函数的交点问题'],
    });
    expect(r.source).toBe('ocr-tags');
    // 长标签更具体 —— 「函数」太泛，搜出来会全是噪音
    expect(r.keyword).toBe('反比例函数与一次函数的交点问题');
  });

  it('标签为空数组时，降级到题干术语匹配', () => {
    const r = summarizeQuestionKeyword({
      question: '已知一次函数 y=2x+1 的图象经过点 A，求 k 的值。',
      tags: [],
    });
    expect(r.source).toBe('question-term');
    expect(r.keyword).toBe('一次函数');
  });

  it('标签为 null 时同样降级（不抛错）', () => {
    const r = summarizeQuestionKeyword({
      question: '在直角三角形中求解锐角三角函数的取值。',
      tags: null,
    });
    expect(r.keyword).toBe('锐角三角函数');
  });

  it('术语表长词优先：「反比例函数与一次函数的交点问题」胜过「一次函数」', () => {
    const r = summarizeQuestionKeyword({
      question: '反比例函数与一次函数的交点问题：求交点坐标。',
    });
    expect(r.keyword).toBe('反比例函数与一次函数的交点问题');
  });

  it('题干里没有任何术语时，兜底为题干前若干字', () => {
    const r = summarizeQuestionKeyword({
      question: '小明有 3 个苹果，给了小红 1 个，还剩几个？',
    });
    expect(r.source).toBe('fallback');
    expect(r.keyword).toBe(toSearchKeyword('小明有 3 个苹果，给了小红 1 个，还剩几个？'));
  });

  it('题干与标签都为空时返回空关键词（不抛错）', () => {
    const r = summarizeQuestionKeyword({ question: null, tags: [] });
    expect(r.keyword).toBe('');
    expect(r.source).toBe('fallback');
  });

  it('标签里的空白项被忽略', () => {
    const r = summarizeQuestionKeyword({
      question: '带二次函数',
      tags: ['   ', ''],
    });
    // 全是空标签 → 视为没有标签 → 走题干术语
    expect(r.source).toBe('question-term');
    expect(r.keyword).toBe('二次函数');
  });

  /**
   * ⚠️ 最长匹配不变量（**行为级**断言，而非检查数组书写顺序）。
   *
   * 首版靠人工维护「长词在前」，实测立刻排错
   * （「三角函数」跑到了「一元二次方程」前面）。
   * 现在由 `SUBJECT_TERMS_SORTED` 在运行时保证，
   * 所以这里只验证**结果**：含长词的题干必须命中长词。
   */
  it('最长匹配：含「锐角三角函数」时不退化为更短的「三角函数」', () => {
    const r = summarizeQuestionKeyword({ question: '在直角三角形中求解锐角三角函数的取值。' });
    expect(r.keyword).toBe('锐角三角函数');
  });

  it('最长匹配：含「反比例函数与一次函数的交点问题」时命中整词', () => {
    const r = summarizeQuestionKeyword({ question: '反比例函数与一次函数的交点问题：求交点。' });
    expect(r.keyword).toBe('反比例函数与一次函数的交点问题');
  });

  it('最长匹配：含「直角三角形的性质」时不退化为「三角形」相关短词', () => {
    const r = summarizeQuestionKeyword({ question: '利用直角三角形的性质求边长。' });
    expect(r.keyword).toBe('直角三角形的性质');
  });

  it('物理术语同样能命中', () => {
    const r = summarizeQuestionKeyword({
      question: '请对斜面上的物块进行受力分析。',
    });
    expect(r.keyword).toBe('受力分析');
  });
});

describe('toSearchKeyword（既有行为，防回归）', () => {
  it('去掉 LaTeX 与题号前缀', () => {
    // 注意：去 LaTeX 后原位置会留下一个空格（`\s+` 折叠发生在去 LaTeX **之前**），
    // 这是既有行为，不是本轮引入 —— 此处按真实输出断言，避免把现状写成理想值。
    expect(toSearchKeyword('第 3 题 已知 $x^2=4$，求 x')).toBe('已知 ，求 x');
  });

  it('超长时截断到 maxLen', () => {
    const long = '一'.repeat(100);
    expect(toSearchKeyword(long, 10)).toHaveLength(10);
  });

  it('非字符串输入返回空串', () => {
    expect(toSearchKeyword(null as unknown as string)).toBe('');
  });
});
