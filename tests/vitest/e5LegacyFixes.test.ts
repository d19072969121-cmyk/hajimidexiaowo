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

  it('getEnabledTools 的返回数组中真的包含 memory（不接受注释/无关字样）', () => {
    // 根因链：
    //   TauriAdapter.ts:5366  memoryEnabled = features.get('userMemory')
    //                                    ?? modeEnabledTools.includes('memory')
    //   persistence.rs:1477   memory_enabled == Some(false) → 直接 return（跳过提取）
    // 本模式此前只返回 ['rag']，导致拍题链路的记忆开关恒为 false、永不提取。
    //
    // ## 断言严格性的两次教训（都是实测踩出来的）
    // ① 太松：最初写 `code.slice(idx, idx+300)` 里 `/memory/` 即通过——
    //    开发者把实现改成 `return ['rag']; // memory（注释保留字面量）` 时
    //    **注释里的 memory 让它照样绿**（假阴性）。
    // ② 太紧：改为只认 `return [...]` 字面量后，审查员把实现改成
    //    `const ENABLED_TOOLS = ['rag','memory']; return ENABLED_TOOLS;`
    //    ——功能完全正确却**误报红**（假阳性）。
    //
    // 因此现在：**剥离注释后**，在函数体内查找所有数组字面量，
    // 只要其中任一数组含 memory 即通过。既不认注释，也不强求写法。
    const fnIdx = code.indexOf('getEnabledTools');
    expect(fnIdx, '未找到 getEnabledTools').toBeGreaterThan(-1);
    const body = code.slice(fnIdx, fnIdx + 400);
    const arrays = [...body.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(arrays.length, 'getEnabledTools 内未找到任何数组字面量').toBeGreaterThan(0);
    const allTools = arrays
      .flatMap((a) => a.split(','))
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(
      allTools,
      'analysis 模式未启用 memory 工具：记忆自动提取会被后端直接跳过'
      + '（persistence.rs 在 memory_enabled == Some(false) 时 return）。',
    ).toContain('memory');
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

describe('E5 ① 拍题不污染首页：列表与计数必须同口径', () => {
  const repo = read('src-tauri/src/chat_v2/repo.rs');
  const handler = read('src-tauri/src/chat_v2/handlers/manage_session.rs');

  it('list 与 count 都支持 exclude_modes', () => {
    // 若只有 list 支持而 count 不支持：「列表已排除 analysis、计数没排除」
    // → 总数偏大 → 前端 hasMore/总数错误 → 用户可能翻到空页。
    expect(repo).toMatch(/fn list_sessions_with_conn\([\s\S]{0,200}exclude_modes/);
    expect(repo).toMatch(/fn count_sessions_with_conn\([\s\S]{0,200}exclude_modes/);
  });

  it('两个 handler 都暴露了 exclude_modes 参数', () => {
    expect(handler).toMatch(/fn chat_v2_list_sessions\([\s\S]{0,300}exclude_modes/);
    expect(handler).toMatch(/fn chat_v2_count_sessions\([\s\S]{0,300}exclude_modes/);
  });

  it('前端侧栏的**每一处** list/count 调用都传了 excludeModes（含分页）', () => {
    // ⚠️ 这条断言曾经太松（只 `expect(mgmt).toMatch(/excludeModes/)`，
    //    任意一处命中即通过），结果漏掉了分页调用——
    //    表现为「首屏干净、翻第二页 analysis 会话又出现」，是修复不完整
    //    最典型的形态。交叉审查 P1 抓到过。现改为**遍历每一处调用**。
    for (const file of [
      'src/features/chat/hooks/useSessionManagement.ts',
      'src/features/chat/pages/useSessionLifecycle.ts',
    ]) {
      const src = read(file);
      // 截取每个调用点到其闭合 `})` 为止的片段（取足够窗口，覆盖参数字面量）
      const calls = src.match(/chat_v2_(?:list|count)_sessions'[\s\S]{0,260}?\}\)/g) ?? [];
      expect(calls.length, `${file} 未找到任何调用`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          call,
          `${file} 有调用未带 excludeModes（分页漏改会导致拍题会话重新出现）：\n${call.slice(0, 160)}`,
        ).toMatch(/excludeModes/);
      }
    }
  });

  it('错题本不排除 analysis（否则它查不到自己的数据）', () => {
    const book = read('src/features/review/hooks/useMistakeBook.ts');
    const listCall = book.match(/chat_v2_list_sessions[\s\S]{0,300}?\}\)/)?.[0] ?? '';
    expect(listCall, '未找到错题本的列表调用').not.toBe('');
    expect(listCall, '错题本不得排除 analysis——那正是它要查的模式').not.toMatch(/excludeModes/);
  });
});
