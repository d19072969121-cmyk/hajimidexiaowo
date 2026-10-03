/**
 * E3 交叉审查修复 — App 层接线契约
 *
 * ## 为什么需要
 * 交叉审查（reviewer-adversarial）发现 `<LazyPracticeHubPage>` 从未传入
 * `onStartPractice`——两个刷题入口点了完全没反应（死 prop）。
 *
 * 而当时 e3QuestionBankConfig.test.tsx 里是这样测的：
 * ```tsx
 * render(<PracticeHubPage onStartPractice={vi.fn()} />)   // ← 自己造回调
 * ```
 * 组件测试**自造**了回调，于是「App 到底传没传」这一层**完全没被覆盖**。
 * 组件测得很对，接线是断的，两者互不感知。
 *
 * 本文件专门堵这个缺口：直接从 App.tsx 源码断言接线。
 * 形态参照 a3WiringContract.test.tsx（源码级接线契约）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

/** 截取某个 lazy 组件标签的完整 JSX（从标签名到自闭合的 `/>`） */
function extractJsx(source: string, tag: string): string {
  const idx = source.indexOf(`<${tag}`);
  if (idx === -1) return '';
  const rest = source.slice(idx);
  const end = rest.indexOf('/>');
  return end === -1 ? rest.slice(0, 800) : rest.slice(0, end + 2);
}

describe('E3 App 接线契约：PracticeHubPage 的三个回调必须都接上', () => {
  const jsx = extractJsx(appSource, 'LazyPracticeHubPage');

  it('App.tsx 渲染了 LazyPracticeHubPage（防空断言）', () => {
    expect(jsx, '未在 App.tsx 找到 <LazyPracticeHubPage> 渲染点').not.toBe('');
  });

  it('传入了 onBack', () => {
    expect(jsx).toMatch(/onBack=\{/);
  });

  it('传入了 onStartPractice（曾漏传 → 两个刷题入口点了没反应）', () => {
    expect(
      jsx,
      'onStartPractice 未接线：PracticeHubPage 内是 onStartPractice?.(mode) 可选调用，'
      + '漏传会静默 no-op，用户点「温故新知/自己定类型」毫无反应，且不报错。',
    ).toMatch(/onStartPractice=\{/);
  });

  it('传入了 onConfigureQuestionBank', () => {
    expect(jsx).toMatch(/onConfigureQuestionBank=\{/);
  });
});

describe('E3 App 接线契约：题库配置跳转必须深链到 models Tab', () => {
  const jsx = extractJsx(appSource, 'LazyPracticeHubPage');

  it('onConfigureQuestionBank 走 setPendingSettingsRoute（而非只 setCurrentView）', () => {
    // 背景：题库配置区挂在 ModelsTab 内。若只 setCurrentView('settings')，
    // 用户落在设置首屏而不是「模型」Tab，看不到配置区。
    // 项目既有深链机制是 setPendingSettingsRoute + SETTINGS_NAVIGATE_TAB
    // （见 App.tsx 的 OPEN_CLOUD_STORAGE_SETTINGS 处理，10+ 处同款用法）。
    expect(jsx).toMatch(/setPendingSettingsRoute\(/);
  });

  it('onConfigureQuestionBank 派发 SETTINGS_NAVIGATE_TAB 事件', () => {
    expect(jsx).toMatch(/SETTINGS_NAVIGATE_TAB/);
  });

  it('深链目标是 models Tab', () => {
    expect(jsx).toMatch(/tab:\s*'models'/);
  });
});
