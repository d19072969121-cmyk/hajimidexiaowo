import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 首页不得渲染 analysis（拍题解析）会话 —— 用户反馈 ①
 *
 * ## 症状
 * 「首页出现本应在拍照子页面出现的视觉 OCR 识别结果」。
 *
 * ## 根因链（已逐环取证）
 * 1. 拍题链路（`App.tsx` 的 `captureToAnalysisSession`）创建 `mode: 'analysis'`
 *    会话后，调 `sessionManager.setCurrentSessionId(session.id)` 把它设为**当前会话**，
 *    再切到 `analysis-result` 视图。
 * 2. `analysis-result` 的 `onBack` 原本只 `setCurrentView('chat-v2')`——
 *    **没有清掉当前会话**。
 * 3. 于是回到首页（chat-v2）时 `currentSessionId` 仍指向那个 analysis 会话。
 * 4. `ChatContainer`（主会话内容容器）取 `displayedMode = store.mode` = `'analysis'`
 *    → `modePlugin.renderHeader` 命中 `OcrResultHeader`
 *    （`src/features/chat/plugins/modes/analysis.ts:367`）
 *    → **在内容区顶部渲染「OCR 识别结果」折叠卡片**（题目/答案）。
 *
 * ## 与既有设计的不一致（这正说明它是缺口而非有意行为）
 * 首页**侧栏**本就排除 analysis 会话
 * （`src/features/chat/hooks/useSessionManagement.ts` 的
 * `SIDEBAR_EXCLUDE_MODES = ['analysis']`），但**内容区此前没有这层过滤**。
 * 结果就是「侧栏看不到、内容区却在渲染」。
 *
 * ## 修法（两道）
 * - **治标**：`ChatV2Page` 内容区加守卫，当前会话为 analysis 时不渲染它。
 * - **治本**：`analysis-result` 的 `onBack` 清掉当前会话
 *   （`sessionManager.setCurrentSessionId(null)`），避免留下一个
 *   「存在但不可见」的当前会话。
 *
 * ## 已知局限（诚实记录）
 * 本契约是**源码级**断言（与同目录其它契约一致）：证明的是「守卫接上了」，
 * 不是「运行期真的不渲染」。运行期需真机验证（无真机环境）。
 */

const ROOT = process.cwd();
const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

/** 词法感知剥注释（避免注释里的字面量造成假绿） */
const stripComments = (src: string): string => {
  let out = '';
  let i = 0;
  type S = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let st: S = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (st === 'code') {
      if (ch === '/' && next === '/') { st = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { st = 'block'; i += 2; continue; }
      if (ch === "'") { st = 'single'; out += ch; i += 1; continue; }
      if (ch === '"') { st = 'double'; out += ch; i += 1; continue; }
      if (ch === '`') { st = 'template'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (st === 'line') {
      if (ch === '\n') { st = 'code'; out += ch; i += 1; continue; }
      i += 1; continue;
    }
    if (st === 'block') {
      if (ch === '*' && next === '/') { st = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
    if (
      (st === 'single' && ch === "'")
      || (st === 'double' && ch === '"')
      || (st === 'template' && ch === '`')
    ) { st = 'code'; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
};

describe('首页不渲染 analysis 会话（用户反馈 ①）', () => {
  const chatV2 = stripComments(readSource('src/features/chat/pages/ChatV2Page.tsx'));

  it('ChatV2Page 计算了「当前会话是否 analysis」', () => {
    expect(
      chatV2,
      'ChatV2Page 没有计算当前会话的 analysis 状态 —— 首页会渲染 OCR 结果卡片',
    ).toMatch(/currentSessionIsAnalysis/);
    // 依据必须是 store 的 mode，而不是别的猜测信号
    expect(
      chatV2,
      'analysis 判定未读 store.mode —— 判据不可靠',
    ).toMatch(/getState\(\)\.mode\s*===\s*'analysis'|state\.mode\s*===\s*'analysis'/);
  });

  it('ChatContainer 的渲染条件带上了该守卫（不能只看 currentSessionId）', () => {
    // 取出渲染 ChatContainer 的那一小段（含它的三元条件）
    const idx = chatV2.search(/<ChatContainer/);
    expect(idx, '未找到 ChatContainer 渲染点').toBeGreaterThan(-1);
    // 条件写在 `<ChatContainer` 之前的多行 JSX 里，取前 400 字符窗口内的
    // 「... : <条件> ? (」片段
    const window = chatV2.slice(Math.max(0, idx - 400), idx);
    const condMatch = window.match(/\}\s*:\s*([^?]*?)\?\s*\(\s*$/);
    const cond = condMatch?.[1] ?? '';
    expect(
      cond,
      `未能在 ChatContainer 前解析出渲染条件（窗口片段：${JSON.stringify(window.slice(-120))}）`,
    ).not.toBe('');
    expect(
      cond,
      'ChatContainer 的渲染条件只判 currentSessionId —— 未排除 analysis 会话，'
      + '首页仍会渲染 OcrResultHeader（OCR 识别结果卡片）',
    ).toMatch(/currentSessionIsAnalysis/);
  });

  it('守卫是响应式的（订阅 mode 变化，而非只读一次）', () => {
    // 会话切换或 mode 变更后必须更新，否则守卫会读到陈旧值
    expect(
      chatV2,
      'analysis 守卫未随会话/mode 变化更新 —— 切到普通会话后仍可能被误判',
    ).toMatch(/subscribe\([\s\S]{0,200}?mode/);
  });

  it('analysis-result 的 onBack 清掉当前会话（治本，避免「存在但不可见」的会话）', () => {
    const app = stripComments(readSource('src/App.tsx'));
    const block = app.match(
      /renderViewLayer\(\s*'analysis-result',[\s\S]*?\}\)\)/,
    )?.[0] ?? '';
    expect(block, "未找到 analysis-result 的 renderViewLayer 块").not.toBe('');
    expect(
      block,
      'analysis-result 的 onBack 没有清当前会话 —— 返回首页后 currentSessionId 仍指向 '
      + 'analysis 会话，会留下一个「存在但不可见」的当前会话',
    ).toMatch(/setCurrentSessionId\(\s*null\s*\)/);
    // 仍必须切回首页
    expect(block, 'onBack 未切回 chat-v2').toMatch(/setCurrentView\(\s*'chat-v2'\s*\)/);
  });

  it('侧栏与内容区口径一致（都排除 analysis）', () => {
    const sidebar = stripComments(readSource('src/features/chat/hooks/useSessionManagement.ts'));
    expect(
      sidebar,
      '侧栏不再排除 analysis —— 与本次修法的前提不一致，需重新评估',
    ).toMatch(/SIDEBAR_EXCLUDE_MODES\s*=\s*\[[^\]]*'analysis'/);
    // 内容区守卫的存在，正是为了对齐这个口径
    expect(chatV2).toMatch(/currentSessionIsAnalysis/);
  });
});
