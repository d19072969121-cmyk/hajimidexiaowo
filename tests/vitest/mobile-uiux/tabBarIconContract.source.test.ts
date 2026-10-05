/**
 * 移动端底栏图标契约（E13-Z）
 *
 * 背景：本轮把「拍题」Tab 的图标从魔法棒（StudyMagicWandIcon）换成了相机
 * （StudyCameraIcon）。这类改动**没有编译期保护**——图标名换了但若图形相同、
 * 或日后被人改回魔法棒，TypeScript 不会报错，任何单测也不会红。
 *
 * 历史上踩过的坑：`me` 与 `study` 曾同用 StudyMagicWandIcon，底栏出现重复图案。
 * 因此本契约的核心是**用实际渲染的 path 字符串比对，而不是图标名或 import 名**
 * —— 名字不同但图形相同，正是那个坑的形态。
 *
 * 断言对象是源码文本（source contract），不渲染组件：跑得快、与样式重构解耦。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string): string =>
  readFileSync(resolve(process.cwd(), file), 'utf8');

const TAB_BAR_SOURCE = 'src/components/navigation/MobileTabBar.tsx';
const SIDEBAR_ICONS_SOURCE = 'src/components/icons/StudySidebarIcons.tsx';

/**
 * 从 StudySidebarIcons.tsx 解析出「图标名 → { regular, bold }」的 path 映射。
 *
 * 该文件的每个图标都由 `createStudySidebarIcon({ regular: '...', bold: '...' })`
 * 定义，故按 export 分块后用 'M...' 字符串捕获即可稳定提取。
 */
function parseIconPaths(source: string): Map<string, { regular: string; bold: string }> {
  const result = new Map<string, { regular: string; bold: string }>();
  const exportRe = /export const (\w+)\s*=\s*createStudySidebarIcon\(\{([\s\S]*?)\n\}\);/gu;

  for (const match of source.matchAll(exportRe)) {
    const [, name, body] = match;
    const regular = body.match(/regular:\s*\n?\s*'(M[^']+)'/u)?.[1];
    const bold = body.match(/bold:\s*\n?\s*'(M[^']+)'/u)?.[1];
    if (regular && bold) result.set(name, { regular, bold });
  }
  return result;
}

/** 从 MobileTabBar.tsx 的 TAB_ICON 表中解析「tabId → 图标组件名」。 */
function parseTabIconMap(source: string): Map<string, string> {
  const table = source.match(/const TAB_ICON[^{]*\{([\s\S]*?)\n\};/u)?.[1];
  if (!table) throw new Error('未在 MobileTabBar.tsx 找到 TAB_ICON 表');

  const map = new Map<string, string>();
  // 跳过注释行，只取 `key: ComponentName,` 形式
  for (const line of table.split('\n')) {
    const cleaned = line.replace(/\/\/.*$/u, '').trim();
    const entry = cleaned.match(/^(\w+):\s*(\w+),?$/u);
    if (entry) map.set(entry[1], entry[2]);
  }
  return map;
}

const iconPaths = parseIconPaths(readSource(SIDEBAR_ICONS_SOURCE));
const tabIconMap = parseTabIconMap(readSource(TAB_BAR_SOURCE));

describe('移动端底栏 · TAB_ICON 表契约', () => {
  it('TAB_ICON 表可被解析出 5 个 Tab', () => {
    expect([...tabIconMap.keys()].sort()).toEqual(['home', 'me', 'media', 'review', 'study']);
  });

  it('「拍题」(study) 使用相机图标 StudyCameraIcon，而非魔法棒', () => {
    // 用户明确要求：拍题 Tab 表意要清楚 → 相机；魔法棒语义不清。
    expect(tabIconMap.get('study')).toBe('StudyCameraIcon');
    expect(tabIconMap.get('study')).not.toBe('StudyMagicWandIcon');
  });

  it('五个 Tab 图标两两不同（按实际 path 比对，不是按图标名）', () => {
    const entries = [...tabIconMap.entries()];
    expect(entries).toHaveLength(5);

    // 先把每个 tab 解析成 path，任一图标缺失即失败（防止改名后静默跳过）
    const resolved = entries.map(([tabId, iconName]) => {
      const paths = iconPaths.get(iconName);
      expect(paths, `TAB_ICON.${tabId} 引用的 ${iconName} 在 StudySidebarIcons.tsx 中不存在`).toBeDefined();
      return { tabId, iconName, paths: paths! };
    });

    for (let i = 0; i < resolved.length; i += 1) {
      for (let j = i + 1; j < resolved.length; j += 1) {
        const a = resolved[i];
        const b = resolved[j];

        // 历史坑的三种形态全部覆盖：regular 相同 / bold 相同 / 任一 path 交集
        expect(
          a.paths.regular === b.paths.regular,
          `${a.tabId}(${a.iconName}) 与 ${b.tabId}(${b.iconName}) 的 regular path 相同`,
        ).toBe(false);
        expect(
          a.paths.bold === b.paths.bold,
          `${a.tabId}(${a.iconName}) 与 ${b.tabId}(${b.iconName}) 的 bold path 相同`,
        ).toBe(false);
        expect(
          a.paths.regular === b.paths.bold || a.paths.bold === b.paths.regular,
          `${a.tabId}(${a.iconName}) 与 ${b.tabId}(${b.iconName}) 跨权重 path 重复`,
        ).toBe(false);
      }
    }
  });

  it('底栏不再引用 StudyMagicWandIcon（避免与 skills 语义混淆）', () => {
    const tabBarSource = readSource(TAB_BAR_SOURCE);
    // 允许注释中提及历史，但不得出现在 TAB_ICON 表的取值位置
    expect([...tabIconMap.values()]).not.toContain('StudyMagicWandIcon');
    // 且不再 import 它
    expect(tabBarSource).not.toMatch(/import\s*\{[^}]*StudyMagicWandIcon[^}]*\}/u);
  });
});

describe('StudyMagicWandIcon · 保留与消费方契约', () => {
  it('图标本身仍然导出（被其它模块使用，不可删除）', () => {
    expect(iconPaths.has('StudyMagicWandIcon')).toBe(true);
  });

  it('仍被 3 个生产模块引用', () => {
    // 这三个消费方是删除该图标会直接编译失败的原因，必须锁死。
    const consumers = [
      'src/components/layout/MobileSidebarNavigation.tsx',
      'src/config/navigation.ts',
      'src/features/review/pages/ReviewHubPage.tsx',
    ];

    for (const file of consumers) {
      const source = readSource(file);
      expect(source, `${file} 应仍引用 StudyMagicWandIcon`).toContain('StudyMagicWandIcon');
      expect(source).toMatch(/import\s*\{[\s\S]*?StudyMagicWandIcon[\s\S]*?\}\s*from/u);
    }
  });
});

describe('StudyCameraIcon · 结构契约', () => {
  it('与同文件其它图标同口径导出（regular + bold 双权重）', () => {
    const camera = iconPaths.get('StudyCameraIcon');
    expect(camera).toBeDefined();
    expect(camera!.regular.startsWith('M')).toBe(true);
    expect(camera!.bold.startsWith('M')).toBe(true);
    expect(camera!.regular.length).toBeGreaterThan(0);
    expect(camera!.bold.length).toBeGreaterThan(0);
  });

  it('由 createStudySidebarIcon 工厂创建（继承 256 viewBox / currentColor）', () => {
    const source = readSource(SIDEBAR_ICONS_SOURCE);
    expect(source).toMatch(/export const StudyCameraIcon\s*=\s*createStudySidebarIcon\(/u);
    // 工厂统一口径：256 viewBox + currentColor，保证换色/换主题一致
    expect(source).toContain('viewBox="0 0 256 256"');
    expect(source).toContain('fill="currentColor"');
  });
});
