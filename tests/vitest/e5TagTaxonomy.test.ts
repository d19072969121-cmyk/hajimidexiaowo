/**
 * E5 — 错题标签体系契约
 *
 * ## 背景（用户反馈）
 * 「你预设的标签都是什么鬼」——旧实现让模型自由发明标签（提示词只给
 * 「如一元二次方程」这种例子），导致每题标签都不同、无法筛选。
 *
 * ## 新体系（用户指定）
 * 三层优先级，严格按顺序：
 *   ① 用户已有标签（最高）② 体系内固定项 ③ 才允许新增
 * 学科固定为九类：语数英物化生政史地
 *
 * 本契约把这三层钉死，防止回归到「模型自由发挥」。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SUBJECT_TAGS,
  KNOWLEDGE_TYPE_TAGS,
  ERROR_CAUSE_TAGS,
  SYSTEM_TAGS,
  buildClassifyPrompt,
  MAX_AUTO_TAGS,
} from '@/features/review/classify/tagTaxonomy';

describe('E5 标签体系：学科固定九类', () => {
  it('恰好是用户指定的九科：语数英物化生政史地', () => {
    expect([...SUBJECT_TAGS]).toEqual([
      '语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理',
    ]);
  });

  it('知识点类型与错误原因非空且互不重复', () => {
    expect(KNOWLEDGE_TYPE_TAGS.length).toBeGreaterThan(0);
    expect(ERROR_CAUSE_TAGS.length).toBeGreaterThan(0);
    const all = [...SUBJECT_TAGS, ...KNOWLEDGE_TYPE_TAGS, ...ERROR_CAUSE_TAGS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('SYSTEM_TAGS 是三组的并集', () => {
    expect(SYSTEM_TAGS).toHaveLength(
      SUBJECT_TAGS.length + KNOWLEDGE_TYPE_TAGS.length + ERROR_CAUSE_TAGS.length,
    );
  });
});

describe('E5 标签提示词：三层优先级', () => {
  it('把「用户已有标签」列为第一优先', () => {
    const prompt = buildClassifyPrompt('解方程', '因式分解', ['数学', '我的自定义标签']);
    // 用户标签必须出现在提示词里，且被标为优先
    expect(prompt).toContain('我的自定义标签');
    expect(prompt).toContain('优先');
  });

  it('无用户标签时明确说明，而不是留空让人猜', () => {
    const prompt = buildClassifyPrompt('解方程', '因式分解', []);
    expect(prompt).toMatch(/还没有任何标签|无.*标签/);
  });

  it('提示词里列出了固定体系（学科/知识点类型/错误原因）', () => {
    const prompt = buildClassifyPrompt('q', 'a', []);
    for (const t of SUBJECT_TAGS) expect(prompt).toContain(t);
    for (const t of KNOWLEDGE_TYPE_TAGS) expect(prompt).toContain(t);
    for (const t of ERROR_CAUSE_TAGS) expect(prompt).toContain(t);
  });

  it('明确「能不加就不加」（抑制标签库膨胀）', () => {
    const prompt = buildClassifyPrompt('q', 'a', []);
    expect(prompt).toMatch(/能不加就不加|不建议新增|才允许新增/);
  });

  it('要求纯 JSON 输出（便于解析）', () => {
    const prompt = buildClassifyPrompt('q', 'a', []);
    expect(prompt).toContain('JSON');
  });

  it('限制数量', () => {
    const prompt = buildClassifyPrompt('q', 'a', []);
    expect(prompt).toContain(String(MAX_AUTO_TAGS));
  });

  it('超长输入被截断（避免撑爆 prompt）', () => {
    const huge = 'x'.repeat(10000);
    const prompt = buildClassifyPrompt(huge, huge, []);
    expect(prompt.length).toBeLessThan(6000);
  });

  it('用户标签去重后进入提示词', () => {
    const prompt = buildClassifyPrompt('q', 'a', ['数学', '数学', '物理']);
    // 注意两点，否则断言会误判：
    //   1.「数学」在固定体系列表（SUBJECT_TAGS）里也有，不能对全文计数；
    //   2.「用户已有的标签」这一措辞在**规则段**里也出现（① 优先从…选），
    //     故要匹配带括号的**数据段**（「用户已有的标签（**优先从这里选**）：」）。
    const block = prompt.match(/用户已有的标签（[^）]*）：\n(.+)/)?.[1] ?? '';
    expect(block, '未找到用户标签数据段').not.toBe('');
    expect(block.split('数学').length - 1).toBe(1);
    expect(block.split('物理').length - 1).toBe(1);
  });

  it('空输入不抛异常', () => {
    expect(() => buildClassifyPrompt('', '', [])).not.toThrow();
  });
});

describe('E5 标签体系：classifySession 必须接收用户标签', () => {
  const code = readFileSync(
    resolve(process.cwd(), 'src/features/review/classify/autoClassify.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('classifySession 的参数含 userTags（否则模型无从「优先选已有」）', () => {
    expect(code).toMatch(/userTags/);
  });

  it('提示词构造把 userTags 传下去', () => {
    expect(code).toMatch(/buildClassifyPrompt\([^)]*userTags/);
  });

  it('已存在的标签被跳过（不重复写入）', () => {
    expect(code).toMatch(/existingTags/);
    expect(code).toMatch(/continue/);
  });
});

describe('E5 标签体系：消费方必须真的传入用户标签', () => {
  it('AnalysisResultPage 从 useSessionTags 取全库标签并传给归类', () => {
    const code = readFileSync(
      resolve(process.cwd(), 'src/components/analysis/AnalysisResultPage.tsx'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // 必须真的取标签池并传下去——只声明参数不传等于没做
    expect(code).toMatch(/useSessionTags/);
    expect(code).toMatch(/userTags/);
  });
});
