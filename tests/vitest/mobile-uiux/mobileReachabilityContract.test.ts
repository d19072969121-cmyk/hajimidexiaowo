import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 移动端可达性契约（2026-08 移动端 UI/UX 统一）
 *
 * 每个 CurrentView 必须至少落入以下三桶之一，杜绝“进不去/出不来”的孤岛视图：
 * 1) F1 抽屉导航：config/navigation.ts 共享导航项 + MOBILE_APP_LAUNCHER_VIEWS
 *    （2026-09 启动器收口后的移动抽屉二行三列入口）+ MobileSidebarNavigation 手工项；
 * 2) 命令面板：src/command-palette 各 module 中 deps.navigate('view') 的跳转目标；
 * 3) 上下文/DEV 入口 allowlist：由其他视图内的按钮或 DEV 工具跳转抵达。
 *
 * 废弃别名例外：仍留在 CurrentView 联合里、但已被 canonicalizeView 字符串级
 * 重定向的视图（如 dashboard → data-management，2026-09 启动器收口时废弃）
 * 不是孤岛——任何 navigate('dashboard') 都会落到可达的规范视图。这类视图
 * 不要求自有入口，但其重定向目标必须可达。
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

const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx)$/;

/**
 * 上下文/DEV 入口 allowlist：这些视图没有（也不需要）抽屉/命令面板常驻入口，
 * 依靠页面内上下文按钮或 DEV 工具抵达。新增视图默认不进此桶——
 * 要么加进抽屉/命令面板，要么在这里登记并说明入口。
 */
const CONTEXTUAL_ENTRY_VIEWS = new Set([
  'pdf-reader',            // 学习资源/文件上下文打开 PDF 阅读器
  'sandbox-workbench',     // Chat 沙箱上下文入口
  'crepe-demo',            // DEV：Crepe 编辑器演示
  'chat-v2-test',          // DEV：Chat V2 集成测试页
  'llm-playground',        // DEV：LLM 输出模拟游乐场
  // A3-P0：解析结果全屏任务页。由「拍题/答疑」流程推入（拍题 → 解析 → 错题 → 复习），
  // 是任务流中间态而非常驻目的地，故不进抽屉/命令面板——与 pdf-reader 同性质。
  'analysis-result',
  // A5/E3：复习入口页与刷题入口页。二者都是 review Tab 根视图推入的下一层，
  // 同属任务流中间态（与 analysis-result 同性质），不占抽屉/命令面板格子。
  // ⚠️ 漏登记会让本契约报红「unreachable」——E1 的 review-hub 曾因此长期红灯，
  //    E3 的 practice-hub 是第二例，一并补齐。
  'review-hub',
  'practice-hub',
  // E4：拍题页。study Tab 的落地视图（TAB_ROOT_VIEW.study='capture'），
  // 本身就是一格 Tab 的根，不经抽屉/命令面板，故登记在此。
  'capture',
  // E5：知识卡片 / 易错点。由 review-hub 推入的二级页，同 analysis-result 性质。
  'knowledge-cards',
  'weak-points',
  // E6：错题详情独立页。由 review-hub 的错题条目推入（App.tsx 的
  // `onOpenMistake` → setCurrentView('mistake-detail')），是任务流中间态，
  // 不占抽屉/命令面板格子 —— 与 analysis-result / review-hub 同性质。
  // ⚠️ 漏登记会让本契约报红「unreachable」：契约只认「抽屉 / 命令面板 /
  //    本白名单」三桶，App 内的 setCurrentView 调用**不被**它识别
  //    （正则只扫 command-palette 的 deps.navigate 与导航项的 view:）。
  //    E1 的 review-hub、E3 的 practice-hub 都因此长期红灯，本页是第三例。
  'mistake-detail',
]);

/** 匹配 view: 'xxx'（含 view: 'xxx' as CurrentView / as NavViewType） */
const NAV_ITEM_VIEW_LITERAL = /view:\s*'([a-z0-9-]+)'/g;
/** 匹配命令面板里的 deps.navigate('xxx') */
const PALETTE_NAVIGATE_LITERAL = /deps\.navigate\(\s*'([a-z0-9-]+)'/g;

const collectMatches = (source: string, pattern: RegExp): string[] =>
  [...source.matchAll(pattern)].map((match) => match[1]);

/**
 * 词法感知地剥离注释（只清注释，字符串/模板串原样保留）。
 *
 * 为什么需要：本文件若干断言要「在源码里抽字面量」，而注释里常**说明性地**
 * 点名某些视图名（例如「新视图不能叫 review」）。不剥注释就会把说明文字
 * 当成真实代码 → 假违规。判据必须建立在真实代码上。
 *
 * 与 `mobileHeaderViewRegistryContract.test.ts` 的同名 helper 是同一套做法
 * （单趟扫描 + 状态机），此处按最小必要实现——本文件不需要处理模板串嵌套。
 */
const stripComments = (src: string): string => {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'") { state = 'single'; out += ch; i += 1; continue; }
      if (ch === '"') { state = 'double'; out += ch; i += 1; continue; }
      if (ch === '`') { state = 'template'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; i += 1; continue; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    // 字符串态：处理转义，避免 `\'` 提前收尾
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
    if (
      (state === 'single' && ch === "'")
      || (state === 'double' && ch === '"')
      || (state === 'template' && ch === '`')
    ) {
      state = 'code'; out += ch; i += 1; continue;
    }
    out += ch; i += 1;
  }
  return out;
};

/** 解析 config/navigation.ts 的 MOBILE_APP_LAUNCHER_VIEWS 数组（移动抽屉启动器入口） */
const parseLauncherViews = (sharedNavSource: string): string[] => {
  const block = sharedNavSource.match(/MOBILE_APP_LAUNCHER_VIEWS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return collectMatches(block, /'([a-z0-9-]+)'/g);
};

/**
 * 解析 canonicalView.ts 的 DEPRECATED_VIEW_MAP：仍留在 CurrentView 联合里的
 * 废弃别名 → 重定向目标。键可能不带引号（analysis: 'chat-v2'）或带引号
 * （'llm-usage-stats': 'data-management'）。
 */
const parseDeprecatedViewMap = (canonicalSource: string): Map<string, string> => {
  const block = canonicalSource.match(/DEPRECATED_VIEW_MAP[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
  return new Map(
    [...block.matchAll(/'?([a-z0-9-]+)'?\s*:\s*'([a-z0-9-]+)'/g)].map(
      (match) => [match[1], match[2]] as const,
    ),
  );
};

describe('mobile reachability contract', () => {
  const currentViews = parseCurrentViews();

  const sharedNavSource = readSource('src/config/navigation.ts');
  const mobileSidebarSource = readSource('src/components/layout/MobileSidebarNavigation.tsx');
  const canonicalSource = readSource('src/app/navigation/canonicalView.ts');

  const drawerViews = new Set([
    ...collectMatches(sharedNavSource, NAV_ITEM_VIEW_LITERAL),
    ...parseLauncherViews(sharedNavSource),
    ...collectMatches(mobileSidebarSource, NAV_ITEM_VIEW_LITERAL),
  ]);

  const deprecatedViewMap = parseDeprecatedViewMap(canonicalSource);

  const paletteViews = new Set(
    listFiles('src/command-palette')
      .filter((file) => CODE_FILE_PATTERN.test(file))
      .flatMap((file) => collectMatches(readSource(file), PALETTE_NAVIGATE_LITERAL)),
  );

  const isReachable = (view: string): boolean =>
    drawerViews.has(view) || paletteViews.has(view) || CONTEXTUAL_ENTRY_VIEWS.has(view);

  it('keeps the mobile drawer launcher entry for data-management (dashboard deprecated)', () => {
    // F1 后续（2026-09 启动器收口 86212dbbd）：dashboard 视图已废弃，
    // canonicalizeView 字符串级重定向到 data-management；移动端入口统一收口进
    // MOBILE_APP_LAUNCHER_VIEWS，抽屉只保留「数据」一格，不再有独立「总览」入口。
    expect(mobileSidebarSource).toContain('MOBILE_APP_LAUNCHER_VIEWS');
    expect(deprecatedViewMap.get('dashboard')).toBe('data-management');
    expect(drawerViews.has('data-management')).toBe(true);
    expect(drawerViews.has('dashboard')).toBe(false);
  });

  it('parses non-empty drawer and command palette buckets', () => {
    // 防空断言：解析失效时直接红，而不是让主断言空转通过
    expect(drawerViews.size).toBeGreaterThan(0);
    expect(paletteViews.size).toBeGreaterThan(0);
    expect(drawerViews.has('chat-v2')).toBe(true);
    expect(drawerViews.has('settings')).toBe(true);
  });

  it('only targets valid CurrentView ids from drawer, palette, and contextual allowlist', () => {
    const viewSet = new Set(currentViews);

    const invalidDrawer = [...drawerViews].filter((view) => !viewSet.has(view));
    const invalidPalette = [...paletteViews].filter((view) => !viewSet.has(view));
    // allowlist 条目过期（视图已删除）时必须同步清理
    const staleContextual = [...CONTEXTUAL_ENTRY_VIEWS].filter((view) => !viewSet.has(view));

    expect(invalidDrawer).toEqual([]);
    expect(invalidPalette).toEqual([]);
    expect(staleContextual).toEqual([]);
  });

  it('makes every CurrentView reachable via drawer, command palette, or contextual allowlist', () => {
    // 废弃别名（dashboard 等）由 canonicalizeView 重定向，不算孤岛；
    // 但其重定向目标必须可达，否则历史记录里的旧视图会落到空白页。
    const unreachable = currentViews.filter(
      (view) => !deprecatedViewMap.has(view) && !isReachable(view),
    );
    const orphanedRedirects = currentViews.filter(
      (view) => deprecatedViewMap.has(view) && !isReachable(deprecatedViewMap.get(view)!),
    );

    expect(unreachable).toEqual([]);
    expect(orphanedRedirects).toEqual([]);
  });

  /**
   * 复活视图不得同时留在 DEPRECATED_VIEW_MAP（E6 新增，锁死一类静默失效）。
   *
   * ## 为什么单独立一条（这是真踩到的坑，不是假想）
   * `canonicalizeView` 的实现是**先查重定向表、再查规范集**：
   * ```ts
   * const mapped = DEPRECATED_VIEW_MAP[view] ?? view;
   * return CANONICAL_VIEWS.has(mapped) ? mapped : 'chat-v2';
   * ```
   * 于是「把一个历史废弃视图名复活成真实视图」时，如果只做了
   * `BASE_CANONICAL_VIEWS.push(view)` 而**忘了删重定向键**，运行时会先命中
   * 重定向、把用户悄悄送到 `chat-v2`。
   *
   * E6 的 `mistake-detail` 正是这种情形：它原本在重定向表里指向 chat-v2。
   * 本用例把「已登记进 canonical 的视图**必须不在**重定向表里」写成断言，
   * 使这类「登记了但被重定向吞掉」的失效**无法再逃过 CI**。
   *
   * 反向约束（重定向的键不应出现在 canonical 集里）**刻意不写**：
   * `dashboard` 这类历史别名同时存在于两处是有意为之（见 canonicalView.ts
   * 注释与上方 dashboard 用例），一刀切会误报。
   */
  it('keeps revived canonical views out of the deprecated redirect map', () => {
    const canonicalSource = readSource('src/app/navigation/canonicalView.ts');
    const baseBlock = canonicalSource.match(
      /BASE_CANONICAL_VIEWS[^=]*=\s*\[([\s\S]*?)\];/,
    )?.[1] ?? '';

    // 防空断言：解析失效时直接红，而不是让下面的断言空转通过
    expect(baseBlock, 'BASE_CANONICAL_VIEWS 未解析出内容').not.toBe('');

    /**
     * ⚠️ 必须**先剥注释**再抽字面量（本用例首版栽在这里）。
     * 该数组块里的注释会点名历史废弃视图名（如「不能叫 review，它在重定向表里」），
     * 不剥注释就会把这些**说明性提及**当成真实成员，报出假违规。
     * 判据只能建立在真实代码上——与 mobileHeaderViewRegistryContract 同款教训。
     */
    const baseViews = collectMatches(stripComments(baseBlock), /'([a-z0-9-]+)'/g);
    expect(baseViews.length).toBeGreaterThan(10);

    const selfRedirected = baseViews.filter((view) => deprecatedViewMap.has(view));

    expect(selfRedirected).toEqual([]);
  });
});
