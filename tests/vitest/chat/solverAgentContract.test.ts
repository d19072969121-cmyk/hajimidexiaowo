import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 拍题解题 agent（solver 模式）契约 —— 用户反馈 ②
 *
 * ## 用户原话
 * 「应设定不同的 agent；拍题 agent 需增加检查——**做题前校验思路、做题后检查答案**」
 *
 * ## 本契约要防的三类失效（都属「静默失效」）
 * 1. **模式没注册**：只导出对象不调 `modeRegistry.register` →
 *    `getResolved('solver')` 返回 undefined → 会话退化成无模式普通 chat，
 *    四步提示词**根本不会生效**，且**无任何报错**（最难发现的一种）。
 * 2. **步骤链缺段**：用户要的两件事（验思路 / 查答案）分别对应第 2、4 步。
 *    若提示词里少了哪一段，功能等于没做，但测试若不看内容就发现不了。
 * 3. **拍题链路没用新 agent**：`App.tsx` 仍用 `mode: 'analysis'` →
 *    建了 agent 但没人用。
 *
 * ## 为什么是源码级断言
 * 与同目录其它契约一致（渲染整条 Chat 链路需 mock 大量原生依赖）。
 * 但本契约**额外直接调用纯函数** `solverSystemPrompt` 断言输出内容 ——
 * 那部分是**求值级**的，比读源码更可靠。
 */

const ROOT = process.cwd();
const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

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

describe('拍题解题 agent（solver 模式）契约 — 用户反馈 ②', () => {
  it('solver 模式已注册（只导出对象不注册 = 静默失效）', () => {
    const src = stripComments(readSource('src/features/chat/plugins/modes/solver.ts'));
    expect(
      src,
      'solver 未调用 modeRegistry.register —— getResolved("solver") 会返回 undefined，'
      + '会话退化成无模式普通 chat，四步提示词静默不生效',
    ).toMatch(/modeRegistry\.register\(\s*SOLVER_MODE/);
  });

  it('modes/index.ts 导入了 solver（导入即注册）', () => {
    const src = stripComments(readSource('src/features/chat/plugins/modes/index.ts'));
    expect(
      src,
      'modes/index.ts 未 import "./solver" —— 注册代码永远不会执行',
    ).toMatch(/import\s+['"]\.\/solver['"]/);
  });

  it('solver 继承 analysis（复用 OCR 流水线，不重复实现）', () => {
    const src = stripComments(readSource('src/features/chat/plugins/modes/solver.ts'));
    expect(
      src,
      "solver 未 extends 'analysis' —— OCR 前置流水线、Header、笔记能力都会缺失",
    ).toMatch(/extends:\s*'analysis'/);
  });

  it('工具集含 memory（E5 教训：缺失会让自动记忆提取永不触发）', () => {
    const src = stripComments(readSource('src/features/chat/plugins/modes/solver.ts'));
    const tools = src.match(/getEnabledTools[\s\S]{0,200}?\[([^\]]*)\]/)?.[1] ?? '';
    expect(tools, 'solver 的 getEnabledTools 未返回 memory').toMatch(/'memory'/);
    expect(tools, 'solver 的 getEnabledTools 未返回 rag').toMatch(/'rag'/);
  });

  it('拍题链路使用 SOLVER_MODE（建了 agent 必须有人用）', () => {
    const app = stripComments(readSource('src/App.tsx'));
    // 拍题会话创建点在 captureToAnalysisSession 内
    const fn = app.match(/const captureToAnalysisSession = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(fn, '未找到 captureToAnalysisSession').not.toBe('');
    expect(
      fn,
      '拍题会话仍用 mode: \'analysis\' —— 新建的 solver agent 无人使用（用户反馈 ② 未生效）',
    ).toMatch(/mode:\s*SOLVER_MODE/);
  });

  // ==========================================================================
  // 提示词内容 —— 这部分是**求值级**断言（直接调纯函数，比读源码可靠）
  // ==========================================================================

  it('提示词含四步流程，且顺序正确', async () => {
    const { solverSystemPrompt, SOLVER_STEP_HEADINGS } = await import(
      '@/features/chat/plugins/modes/solverPrompt'
    );
    const prompt = solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: null });

    const order = [
      SOLVER_STEP_HEADINGS.restate,
      SOLVER_STEP_HEADINGS.plan,
      SOLVER_STEP_HEADINGS.solve,
      SOLVER_STEP_HEADINGS.check,
    ];
    const positions = order.map((h) => prompt.indexOf(h));
    expect(positions.every((p) => p >= 0), `四步标题有缺失：${JSON.stringify(positions)}`).toBe(true);
    expect(
      positions,
      '四步顺序错乱 —— 用户要的是「先验思路再作答」，顺序错了流程就不对',
    ).toEqual([...positions].sort((a, b) => a - b));
  });

  it('第 2 步是「先验思路」—— 对应用户「做题前校验思路」', async () => {
    const { solverSystemPrompt, SOLVER_STEP_HEADINGS } = await import(
      '@/features/chat/plugins/modes/solverPrompt'
    );
    const prompt = solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: null });
    const planIdx = prompt.indexOf(SOLVER_STEP_HEADINGS.plan);
    const solveIdx = prompt.indexOf(SOLVER_STEP_HEADINGS.solve);
    expect(planIdx, '缺少「先验思路」段').toBeGreaterThan(-1);

    const planSection = prompt.slice(planIdx, solveIdx);
    // 「先不要计算」是关键约束 —— 否则模型会直接算完，验思路这一段的语义就没了
    expect(
      planSection,
      '「先验思路」段未禁止在本步计算 —— 模型会直接算完，失去「先验思路」的意义',
    ).toMatch(/先不要计算|不要计算/);
    expect(
      planSection,
      '「先验思路」段未要求写明知识点/公式',
    ).toMatch(/知识点|公式/);
  });

  it('第 4 步是「自检」且为必做 —— 对应用户「做题后检查答案」', async () => {
    const { solverSystemPrompt, SOLVER_STEP_HEADINGS } = await import(
      '@/features/chat/plugins/modes/solverPrompt'
    );
    const prompt = solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: null });
    const checkIdx = prompt.indexOf(SOLVER_STEP_HEADINGS.check);
    expect(checkIdx, '缺少「自检」段').toBeGreaterThan(-1);

    const checkSection = prompt.slice(checkIdx);
    expect(
      checkSection,
      '自检段未标注「必须输出」—— 模型会跳过它，用户反馈的核心诉求就落空了',
    ).toMatch(/必须输出|不能跳过/);
    // 至少覆盖回代/量纲/边界中的一类
    expect(
      checkSection,
      '自检段未给出可执行的校验手段（回代/量纲/边界）',
    ).toMatch(/回代|量纲|单位|边界|极端值/);
  });

  it('自检发现矛盾时要求纠正，而非硬圆', async () => {
    const { solverSystemPrompt } = await import('@/features/chat/plugins/modes/solverPrompt');
    const prompt = solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: null });
    expect(
      prompt,
      '未要求「发现矛盾要纠正」—— 拍题场景错答案比不答更伤',
    ).toMatch(/纠正|不要强行圆场|无法验证/);
  });

  it('仍禁止重述题目原文（E5 的教训不能丢）', async () => {
    const { solverSystemPrompt } = await import('@/features/chat/plugins/modes/solverPrompt');
    const prompt = solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: null });
    expect(
      prompt,
      '未禁止重述原文 —— E5 实测过：模型会把题目原样转录而不解题',
    ).toMatch(/不要重述|不要抄写/);
  });

  it('OCR 文本定位为「以图片为准」的辅助参考', async () => {
    const { solverSystemPrompt } = await import('@/features/chat/plugins/modes/solverPrompt');
    const prompt = solverSystemPrompt({
      sessionId: 's1',
      mode: 'solver',
      modeState: { ocrMeta: { question: '题干', answer: '', questionType: '选择题' } },
    });
    expect(prompt, '未注入 OCR 文本').toContain('题干');
    expect(
      prompt,
      '未强调「以图片为准」—— OCR 对公式/上下标经常出错，模型会照着错误文本作答',
    ).toMatch(/以图片为准|以图片内容为准/);
    // 注入的 OCR 文本必须带「可能有错」的免责说明
    expect(prompt).toMatch(/可能有识别错误|可能存在/);
  });

  it('无 OCR 时也能构建提示（防御空态）', async () => {
    const { solverSystemPrompt } = await import('@/features/chat/plugins/modes/solverPrompt');
    expect(() => solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: null })).not.toThrow();
    expect(() => solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: {} })).not.toThrow();
    const p = solverSystemPrompt({ sessionId: 's1', mode: 'solver', modeState: null });
    expect(p.length, '无 OCR 时提示词为空').toBeGreaterThan(100);
  });
});
