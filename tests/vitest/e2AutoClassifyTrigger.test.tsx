/**
 * E2 — useAutoClassify 触发逻辑测试
 *
 * 关键断言（都是「后台异步打标」这条规格的实际风险点）：
 *   1. 仅在完成态触发（未完成/流式中不触发）
 *   2. 同一 sessionId 只跑一次（幂等，防重复烧 token）
 *   3. 题干解析全空时不触发
 *   4. 归类失败不影响组件（不抛、不阻塞）
 *   5. enabled=false 完全不动作
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

import { useAutoClassify } from '@/features/review/hooks/useAutoClassify';

/** 让 mock 对 LLM 调用返回给定标签，对 add_tag 返回 undefined */
function stubLlm(tags: string[]) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'call_llm_for_boundary') {
      return { assistant_message: JSON.stringify(tags) };
    }
    return undefined as never;
  });
}

describe('useAutoClassify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('完成态时触发并写入标签', async () => {
    stubLlm(['一元二次方程']);

    const { result } = renderHook(() =>
      useAutoClassify({
        sessionId: 's1',
        isComplete: true,
        question: '解方程',
        answer: '因式分解',
      }),
    );

    await waitFor(() => {
      expect(result.current.appliedTags).toEqual(['一元二次方程']);
    });
    expect(mockInvoke).toHaveBeenCalledWith('chat_v2_add_tag', {
      sessionId: 's1',
      tag: '一元二次方程',
    });
  });

  it('未完成时不触发（不调 LLM）', async () => {
    stubLlm(['x']);

    renderHook(() =>
      useAutoClassify({
        sessionId: 's1',
        isComplete: false,
        question: '解方程',
        answer: '解析中',
      }),
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('题干与解析全空时不触发', async () => {
    stubLlm(['x']);

    renderHook(() =>
      useAutoClassify({ sessionId: 's1', isComplete: true, question: '  ', answer: '' }),
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('enabled=false 时完全不动作', async () => {
    stubLlm(['x']);

    renderHook(() =>
      useAutoClassify({
        sessionId: 's1',
        isComplete: true,
        question: 'q',
        answer: 'a',
        enabled: false,
      }),
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('无 sessionId 时不触发', async () => {
    stubLlm(['x']);

    renderHook(() =>
      useAutoClassify({ sessionId: null, isComplete: true, question: 'q', answer: 'a' }),
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('同一会话重复渲染只归类一次（幂等，防重复烧 token）', async () => {
    stubLlm(['代数']);

    const { rerender } = renderHook(
      ({ q }: { q: string }) =>
        useAutoClassify({ sessionId: 's1', isComplete: true, question: q, answer: 'a' }),
      { initialProps: { q: '解方程' } },
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('call_llm_for_boundary', expect.anything());
    });

    const llmCallsAfterFirst = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'call_llm_for_boundary',
    ).length;

    // 多次 rerender（模拟 store 更新导致的重复 render）
    rerender({ q: '解方程（题干更新）' });
    rerender({ q: '解方程（再更新）' });
    await new Promise((r) => setTimeout(r, 30));

    const llmCallsAfter = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'call_llm_for_boundary',
    ).length;

    expect(llmCallsAfter).toBe(llmCallsAfterFirst);
  });

  it('归类失败不影响 hook 使用（不抛异常，error 可读）', async () => {
    // classifySession 内部吞掉 LLM 错误，返回空数组——此处验证 hook 不崩
    mockInvoke.mockRejectedValue(new Error('模型不可用'));

    const { result } = renderHook(() =>
      useAutoClassify({ sessionId: 's1', isComplete: true, question: 'q', answer: 'a' }),
    );

    await waitFor(() => {
      expect(result.current.isClassifying).toBe(false);
    });
    expect(result.current.appliedTags).toEqual([]);
  });

  it('归类失败不自动重试（有意取舍：后台增强失败不反复烧 token）', async () => {
    // classifySession 内部吞掉 LLM 错误并返回 []，hook 视为「已处理完成」
    mockInvoke.mockRejectedValue(new Error('模型不可用'));

    const { rerender } = renderHook(
      ({ q }: { q: string }) =>
        useAutoClassify({ sessionId: 's1', isComplete: true, question: q, answer: 'a' }),
      { initialProps: { q: '题1' } },
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalled();
    });

    const callsAfterFirst = mockInvoke.mock.calls.length;

    // 选题变化触发重渲染
    rerender({ q: '题1（更新）' });
    rerender({ q: '题1（再更新）' });
    await new Promise((r) => setTimeout(r, 40));

    expect(mockInvoke.mock.calls.length).toBe(callsAfterFirst);
  });

  it('初始状态：未归类、无标签、无错误', () => {
    stubLlm([]);
    const { result } = renderHook(() =>
      useAutoClassify({ sessionId: null, isComplete: false, question: null, answer: null }),
    );
    expect(result.current.isClassifying).toBe(false);
    expect(result.current.appliedTags).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
