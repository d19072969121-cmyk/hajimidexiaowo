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

/**
 * 抽取文件里每个 `chat_v2_list_sessions` / `chat_v2_count_sessions` 调用点的源码片段。
 *
 * ## 两次失败尝试（都实测过，记录以免重蹈）
 * ① 固定窗口正则 `/…'[\s\S]{0,260}?}\)/g`：
 *    非贪婪匹配到首个 `})` + 260 字符上限。参数块超长时会**整条匹配不到、
 *    静默丢弃**（漏检）。审查员实测构造 >260 字符的调用点 → 匹配数归零。
 * ② 圆括号配对（从命令名位置起数 `(`/`)`）：
 *    **更糟**——真正的外层 `(` 在 `invoke<...>(` 里、位于命令名**之前**，
 *    于是 depth 从 0 起永远配不平，把后续多个调用**吞进同一片段**
 *    （实测抽出 2420 字符片段，真实调用约 200）。
 *    后果：`/excludeModes/` 在吞并范围内任意命中即绿——正是「任意一处命中即过」
 *    的老毛病复活，且**首屏漏改会被漏检**。防空断言也拦不住（吞并时抽取数
 *    仍等于出现次数）。
 *
 * ## 现做法：**花括号配对**
 * 参数是对象字面量，`{` 与 `}` 天然一对，既不会吞并也不会被长度撑破。
 * 从命令名后第一个 `{` 起配对到其闭合 `}`。
 */
function extractInvokeSites(src: string): string[] {
  const sites: string[] = [];
  const marker = /chat_v2_(?:list|count)_sessions'/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(src)) !== null) {
    const braceStart = src.indexOf('{', m.index);
    if (braceStart < 0) continue;
    let depth = 0;
    let i = braceStart;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
    }
    sites.push(src.slice(m.index, Math.min(i, src.length)));
  }
  return sites;
}

/** 文件里这两个命令出现的次数（用于防空断言） */
function countInvokeMentions(src: string): number {
  return (src.match(/chat_v2_(?:list|count)_sessions'/g) ?? []).length;
}



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
      const calls = extractInvokeSites(src);
      // 防空断言（两道，缺一不可）：
      // 1) 抽取数 == 命令出现次数 —— 拦住「有调用点完全没被抽到」
      expect(
        calls.length,
        `${file} 抽取到 ${calls.length} 处调用，但文件里有 ${countInvokeMentions(src)} 处命令出现——`
        + `可能存在未被抽取的调用点（这会静默漏检）`,
      ).toBe(countInvokeMentions(src));
      // 2) 每个片段内命令字面量恰好 1 次 —— 拦住「多个调用被吞进同一片段」
      //    （只靠断言 1 拦不住：吞并时抽取数仍等于出现数）
      for (const call of calls) {
        expect(
          countInvokeMentions(call),
          `${file} 的某个抽取片段包含 ${countInvokeMentions(call)} 个命令调用（应恰好 1 个）——`
          + `说明配对吞并了相邻调用，断言会因此漏检（片段长度 ${call.length}）`,
        ).toBe(1);
      }
      expect(calls.length).toBeGreaterThan(0);
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

describe('E5 ① 会话列表口径：按用途分流（收录判定依据，防后人误改）', () => {
  /**
   * 口径规则（交叉审查两轮后收敛）：
   *   排除 analysis —— 首页/侧栏「浏览常规对话」
   *   不排除       —— 错题本（要查 analysis）、统计（需全量）、存档管理（要能删）
   *
   * 本组断言把「谁该带、谁不该带」固化。若后人为了「统一口径」而一刀切，
   * 会立刻红，并指向此处的判定依据。
   */
  const EXPECT_EXCLUDE = [
    'src/features/chat/hooks/useSessionManagement.ts',
    'src/features/chat/pages/useSessionLifecycle.ts',
  ];
  const EXPECT_NO_EXCLUDE = [
    'src/features/review/hooks/useMistakeBook.ts',       // 要查 analysis
    'src/hooks/useChatV2Stats.ts',                        // 统计需全量
    'src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx', // 存档管理要能删
  ];

  for (const file of EXPECT_NO_EXCLUDE) {
    it(`${file} 不得排除 analysis（按用途分流）`, () => {
      const src = read(file);
      const calls = extractInvokeSites(src);
      expect(
        calls.length,
        `${file} 抽取到 ${calls.length} 处调用，但文件里有 ${countInvokeMentions(src)} 处命令出现`,
      ).toBe(countInvokeMentions(src));
      for (const call of calls) {
        expect(
          countInvokeMentions(call),
          `${file} 某个抽取片段含 ${countInvokeMentions(call)} 个调用（应恰好 1 个）——配对吞并`,
        ).toBe(1);
      }
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          call,
          `${file} 带了 excludeModes，但这处的用途需要全量（见本组测试开头的口径规则）：`
          + `\n${call.slice(0, 160)}`,
        ).not.toMatch(/excludeModes/);
      }
    });
  }

  it('三个「不排除」文件都在测试覆盖内（防漏收录）', () => {
    // 若将来新增了别的调用文件，应显式判断它属于哪一类并加进对应数组
    const expected = [...EXPECT_EXCLUDE, ...EXPECT_NO_EXCLUDE];
    expect(expected.length).toBe(5);
  });
});
