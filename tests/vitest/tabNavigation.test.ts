/**
 * Tab 路由映射表契约（A3 轮次 · 阶段 0）
 *
 * 锁定 tests/vitest/tabNavigation.test.ts 所依赖的四条不变量：
 * 1. VIEW_TO_TABS 的键集必须与 src/types/navigation.ts 的 CurrentView 联合逐字相等
 *    （防「加了视图忘了加映射」导致 Tab 高亮错乱）；
 * 2. 每个映射数组非空、无重复项、成员全是合法 TabId；
 * 3. TAB_ROOT_VIEW 的每个值都必须落在 canonicalView 的 CANONICAL_VIEWS 内
 *    （否则该 Tab 的默认落地会被 canonicalizeView 静默兜底回 chat-v2）；
 * 4. resolveTab 必须走 canonicalizeView（即 'dashboard' 这类废弃别名要先被重定向
 *    再查表），而不是裸字符串直查。
 *
 * 解析 CurrentView 的正则与 tests/vitest/mobile-uiux/mobileReachabilityContract.test.ts
 * 的 parseCurrentViews() 同款（该文件是本仓既有惯例）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CANONICAL_VIEWS, canonicalizeView } from '@/app/navigation/canonicalView';
import {
  FALLBACK_TAB,
  TAB_IDS,
  TAB_ORDER,
  TAB_ROOT_VIEW,
  VIEW_TO_TABS,
  isTabId,
  isAmbiguousView,
  resolveTab,
  viewBelongsToTab,
  type TabId,
} from '@/config/tabNavigation';

const readSource = (relPath: string): string =>
  readFileSync(resolve(process.cwd(), relPath), 'utf-8');

/** 从 src/types/navigation.ts 的类型联合中解析 CurrentView 字面量 */
const parseCurrentViews = (): string[] => {
  const navigationTypesSource = readSource('src/types/navigation.ts');
  const unionBlock = navigationTypesSource.match(/export type CurrentView =([\s\S]*?);/)?.[1] ?? '';
  return [...unionBlock.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
};

describe('tabNavigation: TabId 基础契约', () => {
  it('声明恰好 5 个 Tab，且顺序稳定', () => {
    expect(TAB_IDS).toHaveLength(5);
    expect([...TAB_IDS]).toEqual(['home', 'study', 'review', 'media', 'me']);
  });

  it('TAB_ORDER 与 TAB_IDS 同源（渲染顺序只有一个真相源）', () => {
    expect(TAB_ORDER).toBe(TAB_IDS);
  });

  it('TAB_ROOT_VIEW 覆盖全部 Tab', () => {
    expect(Object.keys(TAB_ROOT_VIEW).sort()).toEqual([...TAB_IDS].sort());
  });

  it('FALLBACK_TAB 是合法 TabId', () => {
    expect(isTabId(FALLBACK_TAB)).toBe(true);
  });

  it('isTabId 只接受 5 个字面量', () => {
    expect(isTabId('home')).toBe(true);
    expect(isTabId('me')).toBe(true);
    // 常见误用：把 CurrentView 当 TabId
    expect(isTabId('chat-v2')).toBe(false);
    expect(isTabId('learning-hub')).toBe(false);
    expect(isTabId('')).toBe(false);
    expect(isTabId(null)).toBe(false);
    expect(isTabId(undefined)).toBe(false);
    expect(isTabId(42)).toBe(false);
  });
});

describe('tabNavigation: VIEW_TO_TABS 覆盖完整性', () => {
  const currentViews = parseCurrentViews();

  it('从源码解析出的 CurrentView 非空且含 chat-v2', () => {
    // 防空断言：正则失效时直接红，而不是让下面的键集比较空转通过
    expect(currentViews.length).toBeGreaterThan(0);
    expect(currentViews).toContain('chat-v2');
    expect(new Set(currentViews).size).toBe(currentViews.length);
  });

  it('VIEW_TO_TABS 键集与 CurrentView 联合逐字相等', () => {
    expect(Object.keys(VIEW_TO_TABS).sort()).toEqual([...currentViews].sort());
  });

  it('每个视图至少归属 1 个 Tab，且数组无重复、成员全是合法 TabId', () => {
    const violations: string[] = [];

    for (const [view, tabs] of Object.entries(VIEW_TO_TABS)) {
      if (!Array.isArray(tabs) || tabs.length === 0) {
        violations.push(`${view} 映射为空数组`);
        continue;
      }
      if (new Set(tabs).size !== tabs.length) {
        violations.push(`${view} 映射含重复 TabId: ${tabs.join(',')}`);
      }
      for (const tab of tabs) {
        if (!isTabId(tab)) violations.push(`${view} 含非法 TabId: ${String(tab)}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('chat-v2 同时归属 home 与 study（一对一映射是错的）', () => {
    // 这是 task-1 约束 2 的核心断言：若有人把映射表改成 Record<CurrentView, TabId>，
    // 这条会立刻红。
    expect(VIEW_TO_TABS['chat-v2']).toEqual(['home', 'study']);
    expect(VIEW_TO_TABS['chat-v2'].length).toBeGreaterThan(1);
    expect(isAmbiguousView('chat-v2')).toBe(true);
  });

  it('除 chat-v2 外其余视图均为单一归属（当前设计事实）', () => {
    const multi = Object.entries(VIEW_TO_TABS)
      .filter(([view, tabs]) => view !== 'chat-v2' && tabs.length > 1)
      .map(([view, tabs]) => `${view} → ${tabs.join(',')}`);

    // 不是「禁止」多归属，而是「新增多归属必须是有意识的决定」：
    // 一旦有人顺手加了第二个 Tab，这条会红，逼迫其在本文件更新预期。
    expect(multi).toEqual([]);
  });
});

describe('tabNavigation: 分组语义', () => {
  it('review Tab 挂 flashcards 与 task-dashboard', () => {
    expect(VIEW_TO_TABS['flashcards']).toEqual(['review']);
    expect(VIEW_TO_TABS['task-dashboard']).toEqual(['review']);
  });

  it('media Tab 挂 learning-hub / sandbox-workbench / pdf-reader', () => {
    expect(VIEW_TO_TABS['learning-hub']).toEqual(['media']);
    expect(VIEW_TO_TABS['sandbox-workbench']).toEqual(['media']);
    expect(VIEW_TO_TABS['pdf-reader']).toEqual(['media']);
  });

  it('me Tab 挂设置与治理类视图', () => {
    expect(VIEW_TO_TABS['settings']).toEqual(['me']);
    expect(VIEW_TO_TABS['data-management']).toEqual(['me']);
    expect(VIEW_TO_TABS['skills-management']).toEqual(['me']);
    expect(VIEW_TO_TABS['template-management']).toEqual(['me']);
    expect(VIEW_TO_TABS['ui-lab']).toEqual(['me']);
  });

  it('home Tab 挂 chat-v2 与 todo', () => {
    expect(viewBelongsToTab('chat-v2', 'home')).toBe(true);
    expect(VIEW_TO_TABS['todo']).toEqual(['home']);
  });

  it('每个 Tab 都至少有一个视图归属（无空 Tab）', () => {
    const empty = TAB_IDS.filter(
      (tab) => !Object.values(VIEW_TO_TABS).some((tabs) => tabs.includes(tab)),
    );
    expect(empty).toEqual([]);
  });
});

describe('tabNavigation: TAB_ROOT_VIEW 合法性', () => {
  it('每个 Tab 的默认落地视图都在 CANONICAL_VIEWS 内', () => {
    const invalid = Object.entries(TAB_ROOT_VIEW)
      .filter(([, view]) => !CANONICAL_VIEWS.has(view))
      .map(([tab, view]) => `${tab} → ${view}`);

    // 若某个 root view 不在 CANONICAL_VIEWS，canonicalizeView 会静默把它变成
    // 'chat-v2'（canonicalView.ts:55），表现为「点这个 Tab 却跳到会话」。
    expect(invalid).toEqual([]);
  });

  it('每个 Tab 的默认落地视图确实归属该 Tab', () => {
    const mismatched = (Object.entries(TAB_ROOT_VIEW) as Array<[TabId, string]>)
      .filter(([tab, view]) => !viewBelongsToTab(view, tab))
      .map(([tab, view]) => `${tab} → ${view} 不在该 Tab 的映射里`);

    expect(mismatched).toEqual([]);
  });
});

describe('tabNavigation: resolveTab 行为', () => {
  it('确定性映射：单归属视图直接命中', () => {
    expect(resolveTab('flashcards')).toBe('review');
    expect(resolveTab('task-dashboard')).toBe('review');
    expect(resolveTab('learning-hub')).toBe('media');
    expect(resolveTab('settings')).toBe('me');
    expect(resolveTab('todo')).toBe('home');
  });

  it('非法/未知视图字符串兜底到 FALLBACK_TAB（不抛错）', () => {
    expect(resolveTab('不存在的视图')).toBe(FALLBACK_TAB);
    expect(resolveTab('')).toBe(FALLBACK_TAB);
    expect(resolveTab('mindmap')).toBe(FALLBACK_TAB);
  });

  it('preferred 命中时保持当前 Tab（消歧 chat-v2）', () => {
    expect(resolveTab('chat-v2', 'home')).toBe('home');
    expect(resolveTab('chat-v2', 'study')).toBe('study');
  });

  it('preferred 未命中时回落到数组首项', () => {
    expect(resolveTab('chat-v2', 'review')).toBe('home');
    expect(resolveTab('flashcards', 'home')).toBe('review');
  });

  it('preferred 为 null/undefined 时回落到数组首项', () => {
    expect(resolveTab('chat-v2')).toBe('home');
    expect(resolveTab('chat-v2', null)).toBe('home');
    expect(resolveTab('chat-v2', undefined)).toBe('home');
  });

  it('走 canonicalizeView：dashboard 被重定向到 data-management 后落到 me', () => {
    // 这是「dashboard 归属搁置」的证明：本表虽为它留了键（TS Record 穷尽要求），
    // 但 canonicalizeView 会在查表前把它折叠成 'data-management'，
    // 因此该键在运行时永远不会被读到。
    expect(canonicalizeView('dashboard')).toBe('data-management');
    expect(resolveTab('dashboard')).toBe('me');
    // 值本身也必须与重定向目标一致，才不构成独立归属决策
    expect(VIEW_TO_TABS['dashboard']).toEqual(VIEW_TO_TABS['data-management']);
  });

  it('dashboard 是死键：resolveTab 结果与它自己的值无关', () => {
    // 若哪天 canonicalizeView 的 dashboard 重定向被移除，这条会红——
    // 那正说明该键「复活」了，需要用户重新裁定归属。
    expect(resolveTab('dashboard')).toBe(resolveTab('data-management'));
    expect(resolveTab('dashboard')).toBe(resolveTab(canonicalizeView('dashboard')));
  });

  it('走 canonicalizeView：历史别名同样被折叠', () => {
    expect(resolveTab('analysis')).toBe(resolveTab(canonicalizeView('analysis')));
    expect(resolveTab('notes')).toBe(resolveTab(canonicalizeView('notes')));
    expect(resolveTab('review')).toBe(resolveTab(canonicalizeView('review')));
    expect(resolveTab('exam-sheet')).toBe(resolveTab(canonicalizeView('exam-sheet')));
  });

  it('返回值恒为合法 TabId（遍历全表 + 别名）', () => {
    const probes = [
      ...Object.keys(VIEW_TO_TABS),
      'dashboard',
      'analysis',
      'chat',
      'notes',
      'review',
      'exam-sheet',
      'batch',
      'library',
      'nonsense-string',
      '',
    ];

    const invalid = probes
      .map((view) => [view, resolveTab(view)] as const)
      .filter(([, tab]) => !isTabId(tab))
      .map(([view, tab]) => `${view} → ${String(tab)}`);

    expect(invalid).toEqual([]);
  });
});

describe('tabNavigation: viewBelongsToTab', () => {
  it('对多归属视图两个 Tab 都返回 true', () => {
    expect(viewBelongsToTab('chat-v2', 'home')).toBe(true);
    expect(viewBelongsToTab('chat-v2', 'study')).toBe(true);
  });

  it('对非归属 Tab 返回 false', () => {
    expect(viewBelongsToTab('chat-v2', 'review')).toBe(false);
    expect(viewBelongsToTab('flashcards', 'home')).toBe(false);
  });

  it('对未知视图返回 false（不抛错，且不被 canonicalizeView 兜底污染）', () => {
    // 关键：canonicalizeView('nonsense-string') 会静默兜底成 'chat-v2'，
    // 而 chat-v2 归属 home。若不做兜底识别，任意垃圾字符串问 home 都会得到
    // true，本函数就失去意义。见 tabNavigation.ts 的 FALLBACK_VIEW 处理。
    expect(viewBelongsToTab('nonsense-string', 'home')).toBe(false);
    expect(viewBelongsToTab('nonsense-string', 'study')).toBe(false);
    expect(viewBelongsToTab('', 'home')).toBe(false);
    expect(viewBelongsToTab('mindmap', 'home')).toBe(false);
  });

  it('但真正的 chat-v2 仍然归属 home（兜底识别不能误伤）', () => {
    expect(viewBelongsToTab('chat-v2', 'home')).toBe(true);
  });

  it('内部走 canonicalizeView：dashboard 等价于 data-management', () => {
    expect(viewBelongsToTab('dashboard', 'me')).toBe(
      viewBelongsToTab(canonicalizeView('dashboard'), 'me'),
    );
    expect(viewBelongsToTab('dashboard', 'me')).toBe(true);
  });
});

describe('tabNavigation: 模块隔离约束', () => {
  const source = readSource('src/config/tabNavigation.ts');

  it('不 import React / zustand / 任何 store', () => {
    // 本模块被设计为纯数据 + 纯函数，必须可被测试直接 import 而不触发渲染依赖。
    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/from ['"]zustand['"]/);
    expect(source).not.toMatch(/@\/stores\//);
  });

  it('不写 currentView，不碰 App.tsx', () => {
    expect(source).not.toContain('setCurrentView');
    expect(source).not.toContain('useViewStore');
  });

  it('官方入口只依赖 types/navigation 与 canonicalView（复用规范化逻辑而非重写）', () => {
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['@/app/navigation/canonicalView', '@/types/navigation']);
  });
});
