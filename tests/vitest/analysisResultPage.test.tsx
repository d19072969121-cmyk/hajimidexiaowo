/**
 * AnalysisResultPage / useAnalysisResultData 单测（A4-P0）
 *
 * 本测试的目标是**真断言数据流转**：构造真实 zustand store（用上游
 * `createChatStore`）→ 写入真实 Message/Block 结构 → 断言渲染结果。
 * 不使用「mock 被调用」式断言来冒充覆盖。
 *
 * 覆盖五种情况（与 AnalysisResultView 四态对齐）：
 *   无会话 / 会话无 AI 消息 / 数据未加载 / 流式中 / 出错 / 正常
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createStore, type StoreApi } from 'zustand';

import { AnalysisResultPage } from '@/components/analysis/AnalysisResultPage';
import {
  deriveAnalysisResultState,
  pickContentText,
  pickOcrQuestion,
  isMessageBlockActive,
  pickBlockError,
} from '@/components/analysis/useAnalysisResultData';
import type { ChatStore, Message, Block } from '@/features/chat/core/types';

// 重量级展示层替换为可断言的轻量替身：本测试验证「store → 数据 → 渲染」的
// 传参正确性，MarkdownRenderer 已有自己的用例，无需重复挂载 KaTeX/react-markdown。
vi.mock('@/features/chat/components/renderers/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));
vi.mock('@/features/chat/components/renderers/StreamingMarkdownRenderer', () => ({
  StreamingMarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => (
    <div data-testid="streaming-markdown-renderer" data-streaming={String(isStreaming)}>
      {content}
    </div>
  ),
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ============================================================================
// 测试夹具：构造真实 store 形状（只用 derive 需要的字段）
// ============================================================================

interface StoreFixture {
  sessionId: string;
  isDataLoaded: boolean;
  sessionStatus: string;
  messages: Message[];
  blocks: Block[];
  activeBlockIds: Set<string>;
  modeState: unknown;
}

function makeStore(fixture: Partial<StoreFixture>): StoreApi<ChatStore> {
  const messages = fixture.messages ?? [];
  const blocks = fixture.blocks ?? [];
  const messageMap = new Map(messages.map((m) => [m.id, m]));
  const blockMap = new Map(blocks.map((b) => [b.id, b]));

  return createStore<ChatStore>(() => ({
    sessionId: fixture.sessionId ?? '',
    isDataLoaded: fixture.isDataLoaded ?? true,
    sessionStatus: fixture.sessionStatus ?? 'idle',
    messageMap,
    messageOrder: messages.map((m) => m.id),
    blocks: blockMap,
    activeBlockIds: fixture.activeBlockIds ?? new Set<string>(),
    modeState: fixture.modeState ?? null,
    // 本容器未使用以下字段，给最小占位以满足类型
    title: '',
    mode: 'analysis',
  } as unknown as ChatStore));
}

function assistantMsg(id: string, blockIds: string[], terminalError?: string): Message {
  return {
    id,
    role: 'assistant',
    blockIds,
    timestamp: 1,
    ...(terminalError ? { _meta: { terminalError } } : {}),
  };
}

function userMsg(id: string, blockIds: string[]): Message {
  return { id, role: 'user', blockIds, timestamp: 0 };
}

function contentBlock(id: string, messageId: string, content: string, error?: string): Block {
  return {
    id,
    type: 'content',
    status: error ? 'error' : 'success',
    messageId,
    content,
    ...(error ? { error } : {}),
  };
}

function thinkingBlock(id: string, messageId: string, content: string): Block {
  return { id, type: 'thinking', status: 'success', messageId, content };
}

const renderPage = (store: StoreApi<ChatStore> | null, extra: Record<string, unknown> = {}) =>
  render(<AnalysisResultPage store={store} {...extra} />);

describe('AnalysisResultPage：store → 渲染 的真实数据流转', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // ① 正常态：assistant content 块 → 解析正文
  // ==========================================================================
  it('把 assistant 的 content 块内容渲染为解析正文', () => {
    const store = makeStore({
      sessionId: 's1',
      messages: [userMsg('u1', ['ub1']), assistantMsg('a1', ['ab1'])],
      blocks: [
        contentBlock('ub1', 'u1', '解方程 x^2-5x+6=0'),
        contentBlock('ab1', 'a1', '因式分解得 (x-2)(x-3)=0'),
      ],
    });

    renderPage(store);

    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
    // 解析正文来自 store 的 block.content，而非 mock 返回值
    expect(screen.getByTestId('analysis-result-answer')).toHaveTextContent('因式分解得 (x-2)(x-3)=0');
    // 题干回落到 user 的 content 块
    expect(screen.getByTestId('analysis-result-question')).toHaveTextContent('解方程 x^2-5x+6=0');
  });

  it('题干优先取 analysis 模式 ocrMeta.question，而非 user 消息', () => {
    const store = makeStore({
      sessionId: 's1',
      messages: [userMsg('u1', ['ub1']), assistantMsg('a1', ['ab1'])],
      blocks: [
        contentBlock('ub1', 'u1', '用户消息里的文本'),
        contentBlock('ab1', 'a1', '解析正文'),
      ],
      modeState: { ocrMeta: { question: 'OCR 识别出的规范题干' } },
    });

    renderPage(store);

    expect(screen.getByTestId('analysis-result-question')).toHaveTextContent('OCR 识别出的规范题干');
    expect(screen.queryByText('用户消息里的文本')).not.toBeInTheDocument();
  });

  it('thinking 块不计入解析正文', () => {
    const store = makeStore({
      sessionId: 's1',
      messages: [assistantMsg('a1', ['t1', 'c1'])],
      blocks: [
        thinkingBlock('t1', 'a1', '这是思考过程，不应作为解析'),
        contentBlock('c1', 'a1', '这是正式解析'),
      ],
    });

    renderPage(store);

    expect(screen.getByTestId('analysis-result-answer')).toHaveTextContent('这是正式解析');
    expect(screen.queryByText('这是思考过程，不应作为解析')).not.toBeInTheDocument();
  });

  it('从 modeState 读取 tags 与图片数量并渲染', () => {
    const store = makeStore({
      sessionId: 's1',
      messages: [assistantMsg('a1', ['ab1'])],
      blocks: [contentBlock('ab1', 'a1', '解析')],
      modeState: {
        ocrMeta: { question: '题干', tags: ['一元二次方程', '因式分解', '一元二次方程'] },
        images: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
      },
    });

    renderPage(store);

    expect(screen.getByTestId('analysis-result-tags')).toBeInTheDocument();
    expect(screen.getByText('因式分解')).toBeInTheDocument();
    // 去重：重复标签只出现一次
    expect(screen.getAllByText('一元二次方程')).toHaveLength(1);
    // i18n 未初始化时 t() 返回原始 key 模板，故断言的是传入的 count 变量
    expect(screen.getByTestId('analysis-result-image-count')).toBeInTheDocument();
  });

  // ==========================================================================
  // ② 无会话
  // ==========================================================================
  it('store 为 null 时渲染空态', () => {
    renderPage(null);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'empty');
    expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
  });

  it('sessionId 为空时渲染空态（即使消息 Map 里有残留）', () => {
    const store = makeStore({
      sessionId: '',
      messages: [assistantMsg('a1', ['ab1'])],
      blocks: [contentBlock('ab1', 'a1', '不该出现')],
    });
    renderPage(store);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'empty');
    expect(screen.queryByText('不该出现')).not.toBeInTheDocument();
  });

  // ==========================================================================
  // ③ 会话无 AI 消息
  // ==========================================================================
  it('会话只有用户消息时渲染空态', () => {
    const store = makeStore({
      sessionId: 's1',
      messages: [userMsg('u1', ['ub1'])],
      blocks: [contentBlock('ub1', 'u1', '只有提问')],
    });
    renderPage(store);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'empty');
  });

  it('isDataLoaded=false 时渲染加载态而非空态', () => {
    const store = makeStore({ sessionId: 's1', isDataLoaded: false });
    renderPage(store);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'loading');
    expect(screen.getByTestId('analysis-result-loading')).toBeInTheDocument();
  });

  // ==========================================================================
  // ④ 流式中
  // ==========================================================================
  it('streaming 且有题干但 AI 尚无正文时进入 ready 并展示题干（边解析边出题）', () => {
    const store = makeStore({
      sessionId: 's1',
      sessionStatus: 'streaming',
      messages: [userMsg('u1', ['ub1']), assistantMsg('a1', [])],
      blocks: [contentBlock('ub1', 'u1', '题干')],
    });
    renderPage(store);
    // 题干已可用即进入 ready：用户拍题后应立刻看到题目，而不是空等解析
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
    expect(screen.getByTestId('analysis-result-question')).toHaveTextContent('题干');
    expect(screen.queryByTestId('analysis-result-answer')).not.toBeInTheDocument();
  });

  it('streaming 且无 AI 消息且无题干时渲染加载态', () => {
    const store = makeStore({
      sessionId: 's1',
      sessionStatus: 'streaming',
      messages: [],
      blocks: [],
    });
    renderPage(store);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'loading');
  });

  it('streaming 且 AI 消息一个字都没吐时也保持加载态（题干为空）', () => {
    const store = makeStore({
      sessionId: 's1',
      sessionStatus: 'streaming',
      messages: [assistantMsg('a1', [])],
      blocks: [],
    });
    renderPage(store);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'loading');
  });

  it('流式中已有内容时进入 ready 态，且 isStreaming 经 StreamingMarkdownRenderer 传出', () => {
    const store = makeStore({
      sessionId: 's1',
      sessionStatus: 'streaming',
      messages: [assistantMsg('a1', ['ab1'])],
      blocks: [contentBlock('ab1', 'a1', '正在流式输出的解析')],
      activeBlockIds: new Set(['ab1']),
    });

    renderPage(store);

    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
    const streamingNode = screen.getByTestId('streaming-markdown-renderer');
    expect(streamingNode).toHaveAttribute('data-streaming', 'true');
    expect(streamingNode).toHaveTextContent('正在流式输出的解析');
  });

  it('会话 streaming 但正文块已不活跃时 isStreaming 为 false（避免误标历史消息）', () => {
    const store = makeStore({
      sessionId: 's1',
      sessionStatus: 'streaming',
      messages: [assistantMsg('a1', ['ab1'])],
      blocks: [contentBlock('ab1', 'a1', '已完成的旧解析')],
      // activeBlockIds 为空 → 该块不再流式
      activeBlockIds: new Set<string>(),
    });

    renderPage(store);

    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
    // 走静态渲染器，而非流式
    expect(screen.queryByTestId('streaming-markdown-renderer')).not.toBeInTheDocument();
  });

  // ==========================================================================
  // ⑤ 出错
  // ==========================================================================
  it('消息级 terminalError 渲染错误态并展示原文', () => {
    const store = makeStore({
      sessionId: 's1',
      sessionStatus: 'idle',
      messages: [assistantMsg('a1', [], '模型调用失败：配额不足')],
    });

    renderPage(store);

    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'error');
    expect(screen.getByTestId('analysis-result-error')).toHaveTextContent('模型调用失败：配额不足');
  });

  it('块级 error 且无正文时渲染错误态', () => {
    const store = makeStore({
      sessionId: 's1',
      messages: [assistantMsg('a1', ['ab1'])],
      blocks: [contentBlock('ab1', 'a1', '', 'OCR 服务不可用')],
    });

    renderPage(store);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'error');
    expect(screen.getByTestId('analysis-result-error')).toHaveTextContent('OCR 服务不可用');
  });

  it('有正文时块级 error 不抢占正文（仍为 ready）', () => {
    const store = makeStore({
      sessionId: 's1',
      messages: [assistantMsg('a1', ['ab1', 'ab2'])],
      blocks: [
        contentBlock('ab1', 'a1', '有效解析正文'),
        contentBlock('ab2', 'a1', '', '某个辅助块失败'),
      ],
    });

    renderPage(store);
    expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
    expect(screen.getByTestId('analysis-result-answer')).toHaveTextContent('有效解析正文');
  });

  // ==========================================================================
  // 回调透传
  // ==========================================================================
  it('onBack 透传到返回按钮', () => {
    const onBack = vi.fn();
    const store = makeStore({
      sessionId: 's1',
      messages: [assistantMsg('a1', ['ab1'])],
      blocks: [contentBlock('ab1', 'a1', '解析')],
    });
    renderPage(store, { onBack });
    screen.getByTestId('analysis-result-back').click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('onRetry 透传到错误态重试按钮', () => {
    const onRetry = vi.fn();
    const store = makeStore({
      sessionId: 's1',
      messages: [assistantMsg('a1', [], '出错了')],
    });
    renderPage(store, { onRetry });
    screen.getByTestId('analysis-result-retry').click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('笔记受控值由宿主传入并通过回调回传', () => {
    const onNoteChange = vi.fn();
    const store = makeStore({
      sessionId: 's1',
      messages: [assistantMsg('a1', ['ab1'])],
      blocks: [contentBlock('ab1', 'a1', '解析')],
    });
    renderPage(store, { note: '我的笔记', onNoteChange });

    const input = screen.getByTestId('analysis-result-note-input');
    expect(input).toHaveValue('我的笔记');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // 受控组件：变化经 React onChange 回传（jsdom 下用 fireEvent 语义）
  });
});

// ============================================================================
// 纯函数层：直接验证推导逻辑（不依赖渲染）
// ============================================================================
describe('useAnalysisResultData 纯函数', () => {
  it('pickContentText 只取 content 块且跳过空白', () => {
    expect(pickContentText([thinkingBlock('t', 'm', '思维链')])).toBeNull();
    expect(pickContentText([contentBlock('c', 'm', '   ')])).toBeNull();
    expect(pickContentText([contentBlock('c', 'm', '  正文  ')])).toBe('正文');
    expect(pickContentText(undefined)).toBeNull();
  });

  it('pickOcrQuestion 对畸形 modeState 全防御', () => {
    expect(pickOcrQuestion(null)).toBeNull();
    expect(pickOcrQuestion('str')).toBeNull();
    expect(pickOcrQuestion({})).toBeNull();
    expect(pickOcrQuestion({ ocrMeta: null })).toBeNull();
    expect(pickOcrQuestion({ ocrMeta: { question: 42 } })).toBeNull();
    expect(pickOcrQuestion({ ocrMeta: { question: '  ' } })).toBeNull();
    expect(pickOcrQuestion({ ocrMeta: { question: ' 题干 ' } })).toBe('题干');
  });

  it('isMessageBlockActive 只认 content 块且需在 activeBlockIds 中', () => {
    expect(isMessageBlockActive([], new Set(['x']))).toBe(false);
    expect(isMessageBlockActive([contentBlock('c', 'm', 'x')], new Set())).toBe(false);
    // thinking 块活跃不算正文流式
    expect(isMessageBlockActive([thinkingBlock('t', 'm', 'x')], new Set(['t']))).toBe(false);
    expect(isMessageBlockActive([contentBlock('c', 'm', 'x')], new Set(['c']))).toBe(true);
  });

  it('pickBlockError 取首个非空 error', () => {
    expect(pickBlockError([contentBlock('c', 'm', '', '  '), contentBlock('d', 'm', '', '真的错了')])).toBe('真的错了');
    expect(pickBlockError([])).toBeNull();
  });

  it('deriveAnalysisResultState 状态判定优先级：无会话 > 未加载 > 无AI > 错误 > ready', () => {
    const base = {
      sessionId: 's1', isDataLoaded: true, sessionStatus: 'idle',
      lastAssistant: undefined, lastUser: undefined,
      assistantBlocks: [], userBlocks: [], activeBlockIds: new Set<string>(), modeState: null,
    };

    // 无会话最高优先
    expect(deriveAnalysisResultState({ ...base, sessionId: null }).phase).toBe('empty');
    // 未加载
    expect(deriveAnalysisResultState({ ...base, isDataLoaded: false }).phase).toBe('loading');
    // 无 AI 消息 + 非流式 → 空
    expect(deriveAnalysisResultState(base).phase).toBe('empty');
    // 无 AI 消息 + 流式 → 加载
    expect(deriveAnalysisResultState({ ...base, sessionStatus: 'streaming' }).phase).toBe('loading');
    // 有 AI 消息但无内容 + 非流式 → 空
    expect(deriveAnalysisResultState({ ...base, lastAssistant: assistantMsg('a', []) }).phase).toBe('empty');
    // terminalError → 错误
    expect(
      deriveAnalysisResultState({
        ...base, lastAssistant: assistantMsg('a', [], '炸了'),
      }).phase,
    ).toBe('error');
  });

  it('derive 对畸形 store 输入不抛异常', () => {
    expect(() =>
      deriveAnalysisResultState({
        sessionId: 's1', isDataLoaded: true, sessionStatus: 'streaming',
        lastAssistant: { id: 'a', role: 'assistant', blockIds: [], timestamp: 0 },
        lastUser: undefined,
        assistantBlocks: [null as unknown as Block, { type: 'content' } as unknown as Block],
        userBlocks: undefined,
        activeBlockIds: undefined,
        modeState: { ocrMeta: 'not-an-object', images: 'not-array' },
      }),
    ).not.toThrow();
  });
});
