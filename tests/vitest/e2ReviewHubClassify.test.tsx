/**
 * E2 — 复习入口页：归类 UI 交互测试
 *
 * 覆盖三件事（都是「手动归类」这条规格的可执行断言）：
 *   1. 加标签：点「+ 标签」→ 输入 → 回车 → 调 addTag(正确 sessionId, 正确 tag)
 *   2. 删标签：点标签上的 × → 调 removeTag
 *   3. 筛选：点击标签 chip → 只显示含该标签的条目；再点清除
 *
 * 用 mock 掉两个数据 hook（useMistakeBook / useSessionTags），
 * 因为本测试关心的是**交互到调用的映射**，不是取数（取数已由
 * a5MistakeBook.test.ts 覆盖）。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ---- mock 数据层 ----

const mockEntries = [
  {
    sessionId: 's1',
    title: '解方程',
    updatedAt: '2026-10-03T00:00:00Z',
    createdAt: '2026-10-03T00:00:00Z',
    tags: [],
  },
  {
    sessionId: 's2',
    title: '因式分解',
    updatedAt: '2026-10-02T00:00:00Z',
    createdAt: '2026-10-02T00:00:00Z',
    tags: [],
  },
];

const addTag = vi.fn(async () => {});
const removeTag = vi.fn(async () => {});
const loadTagsForSessions = vi.fn(async () => {});
const toggleFilterTag = vi.fn();
const clearFilter = vi.fn();

let tagsBySession = new Map<string, string[]>();
let selectedFilterTags = new Set<string>();

vi.mock('@/features/review/hooks/useMistakeBook', () => ({
  useMistakeBook: () => ({
    entries: mockEntries,
    isLoaded: true,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/features/chat/hooks/useSessionTags', () => ({
  useSessionTags: () => ({
    allTags: [{ tag: '代数', count: 1 }, { tag: '几何', count: 1 }],
    tagsBySession,
    loading: false,
    loadAllTags: vi.fn(),
    loadTagsForSessions,
    addTag,
    removeTag,
    selectedFilterTags,
    toggleFilterTag,
    clearFilter,
  }),
}));

vi.mock('@/components/layout/MobileHeaderContext', () => ({
  useMobileHeader: () => undefined,
}));

import { ReviewHubPage } from '@/features/review/pages/ReviewHubPage';

describe('ReviewHubPage 归类 UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tagsBySession = new Map();
    selectedFilterTags = new Set();
  });

  it('渲染四个入口（错题本 / 单词卡片 / 易错点 / 刷题）', () => {
    render(<ReviewHubPage />);
    for (const id of ['mistakes', 'flashcards', 'weak-points', 'practice']) {
      expect(screen.getByTestId(`review-hub-entry-${id}`)).toBeInTheDocument();
    }
  });

  it('四个入口各自的跳转目标正确（防止改了 view 却无感）', () => {
    // 交叉审查发现：原用例只验 testid 存在，入口的 view 从 'flashcards'
    // 改成 'practice-hub' 后语义巨变而测试完全无感。此处补上跳转断言。
    const onNavigate = vi.fn();
    render(<ReviewHubPage onNavigate={onNavigate} />);

    // 单词卡片 → flashcards
    fireEvent.click(screen.getByTestId('review-hub-entry-flashcards'));
    expect(onNavigate).toHaveBeenCalledWith('flashcards');

    // 刷题 → practice-hub（E3 起独立入口页，不再占位跳 flashcards）
    fireEvent.click(screen.getByTestId('review-hub-entry-practice'));
    expect(onNavigate).toHaveBeenCalledWith('practice-hub');

    // 易错点 → 仍是 flashcards（错因维度复用其视图，尚未独立）
    fireEvent.click(screen.getByTestId('review-hub-entry-weak-points'));
    expect(onNavigate).toHaveBeenCalledWith('flashcards');
  });

  it('条目就绪后按会话 id 批量拉取标签', () => {
    render(<ReviewHubPage />);
    expect(loadTagsForSessions).toHaveBeenCalledWith(['s1', 's2']);
  });

  it('手动归类：输入标签并回车 → 调 addTag(sessionId, tag)', () => {
    render(<ReviewHubPage />);

    fireEvent.click(screen.getByTestId('review-hub-addtag-s1'));
    const input = screen.getByTestId('review-hub-addtag-input-s1');
    fireEvent.change(input, { target: { value: '一元二次方程' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(addTag).toHaveBeenCalledWith('s1', '一元二次方程');
  });

  it('空白标签不提交（避免造出空标签）', () => {
    render(<ReviewHubPage />);

    fireEvent.click(screen.getByTestId('review-hub-addtag-s1'));
    const input = screen.getByTestId('review-hub-addtag-input-s1');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(addTag).not.toHaveBeenCalled();
  });

  it('Esc 取消输入，不进提交', () => {
    render(<ReviewHubPage />);

    fireEvent.click(screen.getByTestId('review-hub-addtag-s1'));
    const input = screen.getByTestId('review-hub-addtag-input-s1');
    fireEvent.change(input, { target: { value: '临时' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(addTag).not.toHaveBeenCalled();
  });

  it('展示已有标签，点 × 调 removeTag', () => {
    tagsBySession = new Map([['s1', ['代数']]]);
    render(<ReviewHubPage />);

    expect(screen.getByTestId('review-hub-mistake-tag-s1-代数')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('review-hub-untag-s1-代数'));

    expect(removeTag).toHaveBeenCalledWith('s1', '代数');
  });

  it('筛选：选中标签后只显示含该标签的条目', () => {
    tagsBySession = new Map([['s1', ['代数']], ['s2', ['几何']]]);
    selectedFilterTags = new Set(['代数']);

    render(<ReviewHubPage />);

    expect(screen.getByTestId('review-hub-mistake-item-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('review-hub-mistake-item-s2')).not.toBeInTheDocument();
  });

  it('筛选后无结果时显示「没有符合筛选」而非「还没有错题」', () => {
    tagsBySession = new Map([['s1', ['代数']], ['s2', ['几何']]]);
    selectedFilterTags = new Set(['不存在']);

    render(<ReviewHubPage />);

    expect(screen.getByTestId('review-hub-mistake-empty')).toHaveTextContent('没有符合筛选');
  });

  it('点击标签 chip 调 toggleFilterTag', () => {
    render(<ReviewHubPage />);
    fireEvent.click(screen.getByTestId('review-hub-filter-tag-代数'));
    expect(toggleFilterTag).toHaveBeenCalledWith('代数');
  });

  it('有筛选时出现「清除筛选」，点击调 clearFilter', () => {
    selectedFilterTags = new Set(['代数']);
    render(<ReviewHubPage />);

    fireEvent.click(screen.getByTestId('review-hub-filter-clear'));
    expect(clearFilter).toHaveBeenCalled();
  });

  it('无筛选时不显示「清除筛选」', () => {
    render(<ReviewHubPage />);
    expect(screen.queryByTestId('review-hub-filter-clear')).not.toBeInTheDocument();
  });
});
