/**
 * A5 复习入口：错题本取数单测
 *
 * 目标：验证「错题 = mode==='analysis' 的 chat 会话」这一**筛选口径**本身，
 * 而不是 mock invoke 的调用次数。
 *
 * 关键断言：
 *   - 只收 mode==='analysis'，普通对话会话不得混入
 *   - 已归档/已删除会话不进错题本
 *   - 按 updatedAt 倒序（最近拍的在最前）
 *   - 去重、缺字段容错不抛异常
 */

import { describe, it, expect } from 'vitest';

import { toMistakeEntries, ANALYSIS_MODE } from '@/features/review/hooks/useMistakeBook';
import type { ChatSession } from '@/features/chat/types/session';

function session(over: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    mode: 'chat',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  } as ChatSession;
}

describe('toMistakeEntries：错题筛选口径', () => {
  it('只收 mode=analysis 的会话，普通对话被排除', () => {
    const entries = toMistakeEntries([
      session({ id: 'a1', mode: ANALYSIS_MODE, title: '拍题1' }),
      session({ id: 'c1', mode: 'chat', title: '普通聊天' }),
      session({ id: 'a2', mode: ANALYSIS_MODE, title: '拍题2' }),
    ]);

    expect(entries.map((e) => e.sessionId)).toEqual(['a1', 'a2']);
  });

  it('已归档 / 已删除的会话不进错题本', () => {
    const entries = toMistakeEntries([
      session({ id: 'a1', mode: ANALYSIS_MODE, persistStatus: 'active' }),
      session({ id: 'a2', mode: ANALYSIS_MODE, persistStatus: 'archived' }),
      session({ id: 'a3', mode: ANALYSIS_MODE, persistStatus: 'deleted' }),
    ]);

    expect(entries.map((e) => e.sessionId)).toEqual(['a1']);
  });

  it('按 updatedAt 倒序排列（最近拍的在最前）', () => {
    const entries = toMistakeEntries([
      session({ id: 'old', mode: ANALYSIS_MODE, updatedAt: '2026-09-01T00:00:00Z' }),
      session({ id: 'new', mode: ANALYSIS_MODE, updatedAt: '2026-10-03T00:00:00Z' }),
      session({ id: 'mid', mode: ANALYSIS_MODE, updatedAt: '2026-09-20T00:00:00Z' }),
    ]);

    expect(entries.map((e) => e.sessionId)).toEqual(['new', 'mid', 'old']);
  });

  it('同一会话 id 只出现一次（去重）', () => {
    const entries = toMistakeEntries([
      session({ id: 'dup', mode: ANALYSIS_MODE }),
      session({ id: 'dup', mode: ANALYSIS_MODE }),
    ]);

    expect(entries).toHaveLength(1);
  });

  it('标题缺失时回落为「未命名错题」，不渲染空标题', () => {
    const entries = toMistakeEntries([
      session({ id: 'a1', mode: ANALYSIS_MODE, title: undefined }),
      session({ id: 'a2', mode: ANALYSIS_MODE, title: '   ' }),
    ]);

    expect(entries.map((e) => e.title)).toEqual(['未命名错题', '未命名错题']);
  });

  it('对畸形输入全防御：null / 非对象 / 缺 id 一律跳过，不抛异常', () => {
    const entries = toMistakeEntries([
      null as unknown as ChatSession,
      undefined as unknown as ChatSession,
      { mode: ANALYSIS_MODE } as unknown as ChatSession, // 缺 id
      session({ id: 'ok', mode: ANALYSIS_MODE }),
    ]);

    expect(entries.map((e) => e.sessionId)).toEqual(['ok']);
  });

  it('tags 当前恒为空数组（列表命令不回传 tags，不臆造归类数据）', () => {
    const entries = toMistakeEntries([session({ id: 'a1', mode: ANALYSIS_MODE })]);
    expect(entries[0].tags).toEqual([]);
  });

  it('空输入返回空数组', () => {
    expect(toMistakeEntries([])).toEqual([]);
  });
});
