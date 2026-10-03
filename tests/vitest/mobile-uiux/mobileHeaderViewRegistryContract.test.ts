import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 移动端统一顶栏注册契约（2026-08 移动端 UI/UX 统一）
 *
 * - 每个 CurrentView 必须在其页面模块中以自身 viewId 调用 useMobileHeader 注册，
 *   由 App 级 UnifiedMobileHeader 统一渲染，禁止页面自绘第二条顶栏。
 * - 全仓 src 中传给 useMobileHeader 的 viewId 字面量必须属于 CurrentView 集合。
 * - App.tsx 的兜底标签表必须覆盖每个 CurrentView，避免未注册视图顶栏空白。
 */

const ROOT = process.cwd();

const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

/** 递归列出目录下所有文件，返回相对仓库根的 posix 风格路径 */
const listFiles = (dir: string): string[] => {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(relative(ROOT, fullPath).split('\\').join('/'));
      }
    }
  };
  walk(resolve(ROOT, dir));
  return files;
};

/** 从 src/types/navigation.ts 的类型联合中解析 CurrentView 字面量 */
const parseCurrentViews = (): string[] => {
  const navigationTypesSource = readSource('src/types/navigation.ts');
  const unionBlock = navigationTypesSource.match(/export type CurrentView =([\s\S]*?);/)?.[1] ?? '';
  return [...unionBlock.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
};

/** viewId → 注册 useMobileHeader('viewId', ...) 的页面模块 */
const VIEW_REGISTRY_FILES: Record<string, string> = {
  'chat-v2': 'src/features/chat/pages/useChatPageLayout.tsx',
  'sandbox-workbench': 'src/features/sandbox/pages/SandboxWorkbenchPage.tsx',
  'settings': 'src/features/settings/components/Settings.tsx',
  'dashboard': 'src/components/SOTADashboardLite.tsx',
  'data-management': 'src/components/DataImportExport.tsx',
  'task-dashboard': 'src/features/anki-tasks/AnkiTasksApp.tsx',
  'flashcards': 'src/features/flashcards/FlashcardsApp.tsx',
  'template-management': 'src/features/template-management/TemplateManagementApp.tsx',
  'ui-lab': 'src/components/style-lab/StyleDebugPage.tsx',
  'crepe-demo': 'src/components/dev/CrepeDemoPage.tsx',
  'pdf-reader': 'src/features/pdf/components/PdfReader.tsx',
  'learning-hub': 'src/features/learning-hub/LearningHubPage.tsx',
  'skills-management': 'src/components/skills-management/SkillsManagementPage.tsx',
  'todo': 'src/features/todo/components/TodoContentView.tsx',
  'chat-v2-test': 'src/features/chat/dev/IntegrationTest.tsx',
  'llm-playground': 'src/features/chat/dev/playground/LLMOutputPlayground.tsx',
  'analysis-result': 'src/components/analysis/AnalysisResultView.tsx',
  'review-hub': 'src/features/review/pages/ReviewHubPage.tsx',
  'practice-hub': 'src/features/practice/pages/PracticeHubPage.tsx',
  'capture': 'src/features/capture/pages/CapturePage.tsx',
};

/** MobileHeaderContext 的 JSDoc 里有 useMobileHeader('settings', ...) 等示例注释，排除该文件 */
const SCAN_EXCLUDED_FILES = new Set([
  'src/components/layout/MobileHeaderContext.tsx',
]);

const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx)$/;
/** 容忍 useMobileHeader(\n  'viewId' 的换行写法（如 TodoContentView） */
const USE_MOBILE_HEADER_LITERAL = /useMobileHeader\(\s*'([a-z0-9-]+)'/g;

/**
 * 全仓扫描结果缓存。
 *
 * 为什么需要：`listFiles('src') + readSource` 要对整个 src 目录递归读盘。
 * 在测试进程内并行度较高时（vitest 多个文件并行），这套同步 IO 会被
 * 拖到超过默认 5s 超时，产生**假红**——单文件跑时 2s 就能过。
 * 缓存后同进程内只扫一次，避免同一份数据被重复读取放大开销。
 *
 * 不跨进程共享（模块级变量），因此不会读到过期数据：每次 test run 都是新进程。
 */
let scannedCalls: Array<{ file: string; viewId: string }> | null = null;

function scanMobileHeaderCalls(): Array<{ file: string; viewId: string }> {
  if (scannedCalls) return scannedCalls;
  const found: Array<{ file: string; viewId: string }> = [];
  for (const file of listFiles('src')) {
    if (!CODE_FILE_PATTERN.test(file) || SCAN_EXCLUDED_FILES.has(file)) continue;
    for (const match of readSource(file).matchAll(USE_MOBILE_HEADER_LITERAL)) {
      found.push({ file, viewId: match[1] });
    }
  }
  scannedCalls = found;
  return found;
}

describe('mobile header view registry contract', () => {
  const currentViews = parseCurrentViews();

  it('parses a non-empty, duplicate-free CurrentView union from src/types/navigation.ts', () => {
    expect(currentViews.length).toBeGreaterThan(0);
    expect(currentViews).toContain('chat-v2');
    expect(new Set(currentViews).size).toBe(currentViews.length);
  });

  it('keeps the registry map keys identical to the CurrentView union', () => {
    expect(Object.keys(VIEW_REGISTRY_FILES).sort()).toEqual([...currentViews].sort());
  });

  it('registers useMobileHeader with the exact view id in every view module', () => {
    const missing = Object.entries(VIEW_REGISTRY_FILES)
      .filter(([viewId, file]) => !new RegExp(`useMobileHeader\\(\\s*'${viewId}'`).test(readSource(file)))
      .map(([viewId, file]) => `${viewId} → ${file} 缺少 useMobileHeader('${viewId}', ...) 注册`);

    expect(missing).toEqual([]);
  });

  // ⏱️ 显式超时 30s：本用例要递归遍历整个 src 目录并读取每个源码文件，
  // 是纯同步 IO。测得的正常耗时约 1.6-2.1s，但在 vitest 并行跑多个测试文件时
  // （进程 CPU 被抢），会超过默认 5s 而**假红**——单文件跑必然通过。
  // 这是测试基建的资源配置，不是被测逻辑的问题；不要把超时调小。
  it('only ever passes CurrentView literals to useMobileHeader across src', () => {
    const viewSet = new Set(currentViews);
    const found = scanMobileHeaderCalls();

    // 防空断言：全仓至少要能扫到一批真实注册调用，扫描本身失效时直接红
    expect(found.length).toBeGreaterThanOrEqual(10);

    // 无 allowlist：任何文件出现非法 viewId 都会让本测试失败
    // （历史唯一豁免 NotesHome 的非法 viewId 'notes' 已随组件删除）
    const violations = found
      .filter(({ file, viewId }) => !viewSet.has(viewId))
      .map(({ file, viewId }) => `${file} 使用了非法 viewId '${viewId}'`);

    expect(violations).toEqual([]);
  }, 30_000);

  it('keeps an App.tsx fallback label entry for every CurrentView', () => {
    const appSource = readSource('src/App.tsx');
    const labelsBlock = appSource.match(
      /const labels: Partial<Record<CurrentView, string>> = \{[\s\S]*?\};/,
    )?.[0] ?? '';

    expect(labelsBlock).not.toBe('');

    const missing = currentViews.filter((viewId) => !labelsBlock.includes(`'${viewId}':`));
    expect(missing).toEqual([]);
  });
});
