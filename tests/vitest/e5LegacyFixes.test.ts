/**
 * E5 — B 类遗留问题修复契约
 *
 * 覆盖用户反馈的三条「上游既有问题」：
 *   ⑦ 错题条目点不开（已由 e2ReviewHubClassify 覆盖交互）
 *   ③ 输出文字错位
 *   ⑭ 智能记忆没有自动提取
 *
 * 本文件锁死 ③ 与 ⑭ 的根因修复，防止回归。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const read = (p: string) => stripComments(readFileSync(resolve(process.cwd(), p), 'utf8'));

describe('E5 ③ 文字错位：解析卡片必须允许长内容换行/滚动', () => {
  const code = read('src/components/analysis/AnalysisResultView.tsx');

  it('SectionCard 容器带 min-w-0（否则长内容撑破父容器）', () => {
    // flex/grid 子项默认 min-width:auto，长公式/长英文串会把容器撑宽而非换行
    expect(code).toMatch(/min-w-0/);
  });

  it('内容区带 break-words（超长不可断词串须能换行）', () => {
    // 真实场景：`CHX2∣∣O` 这类被错误转义的化学式、长 URL、连续英文
    expect(code).toMatch(/break-words/);
  });

  it('内容区带 overflow-x-auto（无法换行的块级内容改为横滚而非被裁）', () => {
    // 父级有 overflow-hidden，若不设此项，公式/表格会被直接裁掉
    expect(code).toMatch(/overflow-x-auto/);
  });
});

describe('E5 ⑭ 智能记忆未自动提取：analysis 模式必须启用 memory 工具', () => {
  const code = read('src/features/chat/plugins/modes/analysis.ts');

  it('getEnabledTools 返回中包含 memory', () => {
    // 根因链：
    //   TauriAdapter.ts:5366  memoryEnabled = features.get('userMemory')
    //                                    ?? modeEnabledTools.includes('memory')
    //   persistence.rs:1477   memory_enabled == Some(false) → 直接 return（跳过提取）
    // 本模式此前只返回 ['rag']，导致拍题链路的记忆开关恒为 false、永不提取。
    const block = code.slice(code.indexOf('getEnabledTools'));
    const body = block.slice(0, 300);
    expect(
      /'memory'|"memory"/.test(body),
      'analysis 模式未启用 memory 工具：记忆自动提取会被后端直接跳过'
      + '（persistence.rs 在 memory_enabled == Some(false) 时 return）。',
    ).toBe(true);
  });

  it('仍保留 rag（拍题需要知识库检索）', () => {
    const block = code.slice(code.indexOf('getEnabledTools'));
    expect(block.slice(0, 300)).toMatch(/rag/);
  });

  it('与其他模式的工具名保持一致（memory 是既定名字）', () => {
    // chat.ts / textbook.ts 都用 'memory'，确认不是拼写臆造
    const chat = read('src/features/chat/plugins/modes/chat.ts');
    const textbook = read('src/features/chat/plugins/modes/textbook.ts');
    expect(chat).toMatch(/'memory'/);
    expect(textbook).toMatch(/'memory'/);
  });
});
