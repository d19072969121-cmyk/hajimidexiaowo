/**
 * A4-P0 接线契约：App 挂载解析结果页时必须传入真实会话 store
 *
 * ## 为什么需要这份测试
 * `AnalysisResultPage` 的 `store` 是可选参数（默认 `null`），而 `store=null`
 * 在 `useAnalysisResultData` 里走「无会话 → 空态」，是一个**合法但静默**的
 * 分支。因此「App 忘了传 store」不会报错、不会崩、类型也通过——页面只是
 * 永远空白。A4-P0 就是这么潜伏下来的。
 *
 * `analysisResultPage.test.tsx` 测的是「传了 store 之后渲染对不对」，
 * 对「App 传没传」零覆盖。本文件专门堵这个缺口：
 *   1) 源码级：App.tsx 的 `<LazyAnalysisResultPage>` 必须绑定 store 属性
 *   2) 行为级：桥接 hook 在会话 store 入场后确实能把它交出来
 *
 * 形态参照 a3WiringContract.test.tsx 的「接线契约」写法。
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { useActiveChatStore } from '@/features/chat/hooks/useActiveChatStore';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type { ChatStore } from '@/features/chat/core/types';
import type { StoreApi } from 'zustand';

// ============================================================================
// ① 源码级契约：App 渲染解析页时必须绑定 store
// ============================================================================

describe('A4-P0 接线契约：App 挂载解析结果页时传入了 store', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

  it('App.tsx 导入了 useActiveChatStore 桥接 hook', () => {
    expect(appSource).toMatch(/import\s*\{[^}]*useActiveChatStore[^}]*\}\s*from\s*'\.\/features\/chat\/hooks\/useActiveChatStore'/);
  });

  it('App.tsx 在组件顶层调用了 useActiveChatStore()', () => {
    expect(appSource).toMatch(/const\s+\w*[Ss]tore\w*\s*=\s*useActiveChatStore\(\)/);
  });

  it('<LazyAnalysisResultPage> 绑定了 store 属性（不再裸挂）', () => {
    // 截出该 JSX 元素本体（从标签名到其闭合），断言其中出现 store=
    const tag = appSource.match(/<LazyAnalysisResultPage[\s\S]{0,400}?\/>/)?.[0] ?? '';
    expect(tag, '未在 App.tsx 找到 <LazyAnalysisResultPage> 的渲染点').not.toBe('');
    expect(tag).toMatch(/store=\{/);
  });
});

// ============================================================================
// ② 行为级：桥接 hook 真能把会话 store 交出来
// ============================================================================

/** 探针组件：把 hook 的返回值渲染成可断言的字面量 */
function Probe({ sessionId }: { sessionId?: string | null }) {
  const store = useActiveChatStore(sessionId);
  return (
    <div data-testid="probe">
      {store ? (store.getState().sessionId || 'EMPTY_ID') : 'NULL'}
    </div>
  );
}

describe('A4-P0 桥接：useActiveChatStore 响应会话 store 的入场与离场', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无任何会话时返回 null（而不是抛错）', () => {
    vi.spyOn(sessionManager, 'getCurrentSessionId').mockReturnValue(null);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('NULL');
  });

  it('当前会话不存在 store 时返回 null（只读不创建）', () => {
    vi.spyOn(sessionManager, 'getCurrentSessionId').mockReturnValue('ghost-session');
    vi.spyOn(sessionManager, 'get').mockReturnValue(undefined);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('NULL');
  });

  it('当前会话 store 已存在时把它交出来', () => {
    const fakeStore = {
      getState: () => ({ sessionId: 'sess-live' }),
    } as unknown as StoreApi<ChatStore>;

    vi.spyOn(sessionManager, 'getCurrentSessionId').mockReturnValue('sess-live');
    vi.spyOn(sessionManager, 'get').mockReturnValue(fakeStore);

    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('sess-live');
  });

  it('store 在挂载后才入场（session-created）时，会从 null 过渡到可用', () => {
    // 模拟真实时序：解析会话先创建 → store 后异步落位
    let currentId: string | null = null;
    const fakeStore = {
      getState: () => ({ sessionId: 'sess-late' }),
    } as unknown as StoreApi<ChatStore>;

    let notify: (() => void) | null = null;

    vi.spyOn(sessionManager, 'getCurrentSessionId').mockImplementation(() => currentId);
    vi.spyOn(sessionManager, 'get').mockImplementation((id: string) =>
      (id === 'sess-late' ? fakeStore : undefined),
    );
    vi.spyOn(sessionManager, 'subscribe').mockImplementation((listener) => {
      notify = () => listener({
        type: 'session-created',
        sessionId: 'sess-late',
      });
      return () => { notify = null; };
    });

    render(<Probe />);
    // 入场前：空态
    expect(screen.getByTestId('probe')).toHaveTextContent('NULL');

    // 会话真正创建 → 通知订阅者
    act(() => {
      currentId = 'sess-late';
      notify?.();
    });

    // 入场后：store 可用（页面不再卡在空态）
    expect(screen.getByTestId('probe')).toHaveTextContent('sess-late');
  });

  it('显式指定 sessionId 时优先于「当前会话」（历史会话回看）', () => {
    const fakeStore = {
      getState: () => ({ sessionId: 'sess-history' }),
    } as unknown as StoreApi<ChatStore>;

    vi.spyOn(sessionManager, 'getCurrentSessionId').mockReturnValue('sess-current');
    vi.spyOn(sessionManager, 'get').mockImplementation((id: string) =>
      (id === 'sess-history' ? fakeStore : undefined),
    );

    render(<Probe sessionId="sess-history" />);
    expect(screen.getByTestId('probe')).toHaveTextContent('sess-history');
  });

  it('非会话生命周期事件（streaming-change）不触发重取', () => {
    const getSpy = vi.spyOn(sessionManager, 'getCurrentSessionId').mockReturnValue(null);
    let notify: (() => void) | null = null;
    vi.spyOn(sessionManager, 'subscribe').mockImplementation((listener) => {
      notify = () => listener({ type: 'streaming-change', sessionId: 'x', isStreaming: true });
      return () => { notify = null; };
    });

    render(<Probe />);
    const callsBefore = getSpy.mock.calls.length;

    act(() => { notify?.(); });

    // streaming-change 不改变「当前会话 ID」，不应引发新一轮读取
    expect(getSpy.mock.calls.length).toBe(callsBefore);
  });
});
