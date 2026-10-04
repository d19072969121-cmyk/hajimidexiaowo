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

// ───────────────────────────────────────────────────────────────────────────
// 顶栏配置静态解析 helper（本文件两个用例共用，勿各自实现——判据漂移会导致
// 同一字面量在不同用例里得出相反结论，首版就踩过这个坑）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 词法感知地剥离注释。
 *
 * ## 为什么不能用裸正则
 * 朴素实现（用行注释正则一刀切）会把**字符串或正则字面量里的双斜杠**
 * 当注释起点切断。审查员实测本仓库已触发：
 *   `DataImportExport.tsx:944` 的 `lower.startsWith('content' + '://')`
 *   被切成 `lower.startsWith('content:'`（该行落在块内，只因属性在截断点
 *   之前才未致误判——**是运气不是设计**）。
 *
 * ## 做法
 * 单趟扫描，维护字符串/模板串/注释状态。只清注释，其余原样保留。
 * （刻意不做正则字面量识别——斜杠的二义性需要更重的判据；本文件的断言
 *   都不依赖被切掉的片段，故遇到可疑斜杠一律保守地保留。）
 *
 * ## ⚠️ 已知边界（审查员确认，当前未触发，勿当已覆盖）
 * 本函数**不处理字符串/正则字面量内部的内容**，于是 `callRe`
 * （`useMobileHeader\('<viewId>'`，在本函数之后执行）理论上可被字符串劫持：
 * 若某处源码写了形如
 *     const s = "useMobileHeader('chat-v2', { suppressGlobalBackButton: true })";
 * 的**字符串**（如 lint 规则、文档串、测试辅助），`callRe` 会命中该假位置并
 * **静默读错块** → 判定基于字符串内容而非真实调用 → 假绿。
 *
 * 实测现状：全仓 `useMobileHeader` 相关文本只有 import/注释形态，
 * **无任何字符串或正则含具体 viewId 字面量**，故当前不触发。
 * 触发条件仅在「新增含该字面量的字符串」时成立——届时请改为词法感知定位。
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

/**
 * 抽取 `useMobileHeader('viewId', <配置>, <deps>)` 的**每一个**配置对象字面量。
 *
 * ## 为什么是「每一个」而不是「第一个块」
 * 首版实现取「从调用点到下一个 `useMobileHeader(` 之前」的整段当作一个块，
 * 对**单调用多分支**写法完全失效——`useChatPageLayout.tsx`（chat-v2）写成
 *   `useMobileHeader('chat-v2', condA ? {...} : condB ? {...} : {...})`
 * 只有一个 `useMobileHeader(`，于是块从调用点**吞到文件尾**（实测 4915 字符），
 * 而 `readFlag` 只 match 第一个匹配 → 永远读到**第一个分支**的
 * `showBackArrow: true`，与真正生效的分支无关。
 * 审查员据此实测假绿：删掉默认分支的 showMenu/showBackArrow 后仍 7/7 全绿。
 *
 * ## 做法：花括号配对，收集所有顶层对象字面量
 * 从 `useMobileHeader('viewId'` 起，扫描逗号分隔的实参；对每个处于深度 0 的
 * `{` 起始的对象字面量做配对抽取。这样多分支写法会得到 N 个块（每个分支一个），
 * 由调用方**逐块判定**（任一分支不合规即违规）。
 */
const extractHeaderConfigBlocks = (src: string, viewId: string): string[] => {
  const stripped = stripComments(src);
  const callRe = new RegExp(`useMobileHeader\\(\\s*'${viewId}'\\s*,`);
  const m = callRe.exec(stripped);
  if (!m) return [];

  const blocks: string[] = [];
  let i = m.index + m[0].length;
  let parenDepth = 0; // 调用实参内的圆括号深度（含条件表达式的括号）
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '(') { parenDepth += 1; i += 1; continue; }
    if (ch === ')') {
      if (parenDepth === 0) break; // 调用结束
      parenDepth -= 1; i += 1; continue;
    }
    if (ch === '{') {
      // 花括号配对抽取该对象字面量
      let depth = 0;
      const start = i;
      for (; i < stripped.length; i += 1) {
        if (stripped[i] === '{') depth += 1;
        else if (stripped[i] === '}') {
          depth -= 1;
          if (depth === 0) { i += 1; break; }
        }
      }
      blocks.push(stripped.slice(start, Math.min(i, stripped.length)));
      continue;
    }
    i += 1;
  }
  return blocks;
};

/**
 * 从配置块里读某个 flag 的**静态可判定取值**。
 *
 * 只认字面量 `true` / `false`；其余（条件表达式、标识符、未声明）→ `unknown`。
 * 刻意剥掉取值尾部的 `}` / 空白：对象内联单行写法 `{ title, showMenu: true }`
 * 里，取值捕获会带上结尾的 `}`，首版因此让 `"true }" !== "true"` 产生假红。
 */
const readFlag = (block: string, prop: string): 'true' | 'false' | 'unknown' => {
  const raw = readExpr(block, prop);
  if (raw === null) return 'unknown';
  const v = raw.trim().replace(/[\s})]+$/, '');
  if (v === 'true') return 'true';
  if (v === 'false') return 'false';
  return 'unknown';
};

/** 块里是否存在某个属性的赋值（用于校验 onMenuClick 这类「必须提供」的回调） */
const hasProp = (block: string, prop: string): boolean => readExpr(block, prop) !== null;

/**
 * 取配置块里**深度 1**（配置对象的直接属性）的某个属性表达式。
 *
 * ## 为什么必须限定深度
 * 朴素正则 `prop\s*:\s*([^,\n]*)` 会匹配到**嵌套对象里**的同名键。实测：
 *   `{ title: 'a', style: { showMenu: foo }, showBackArrow: x === 'b', ... }`
 * 会读到内层的 `foo`，导致判定基于一个完全无关的值。
 * 本仓库的配置块普遍含嵌套对象（`rightActions: <DsButton .../>` 的 JSX 属性、
 * `style={{...}}`），故此风险是现实存在的。
 *
 * ## 做法
 * 单趟扫描块内字符，跟踪花括号/圆括号/方括号深度与字符串态；
 * 只在**配置对象自身那层**（深度归 1，即最外层 `{` 之内）匹配属性名。
 */
const readExpr = (block: string, prop: string): string | null => {
  // 定位最外层 `{`（配置对象起点）
  const outer = block.indexOf('{');
  if (outer < 0) return null;

  let depth = 0; // 花括号深度，配置对象自身为 1
  let i = outer;
  type S = 'code' | 'single' | 'double' | 'template';
  let st: S = 'code';
  const propRe = new RegExp(`^${prop}\\s*:`);

  while (i < block.length) {
    const ch = block[i];
    if (st === 'code') {
      if (ch === "'") { st = 'single'; i += 1; continue; }
      if (ch === '"') { st = 'double'; i += 1; continue; }
      if (ch === '`') { st = 'template'; i += 1; continue; }
      if (ch === '{') { depth += 1; i += 1; continue; }
      if (ch === '}') { depth -= 1; i += 1; continue; }
      // 仅深度 1 且位于「属性名位置」（串首或紧跟 , { 或空白）时尝试匹配
      if (depth === 1 && propRe.test(block.slice(i))) {
        // 取该属性的值：到深度 1 的下一个顶层逗号或对象闭合为止
        let j = i + prop.length;
        while (j < block.length && block[j] !== ':') j += 1;
        j += 1; // 跳过冒号
        let d = 1;
        let k = j;
        let st2: S = 'code';
        for (; k < block.length; k += 1) {
          const c = block[k];
          if (st2 === 'code') {
            if (c === "'") { st2 = 'single'; continue; }
            if (c === '"') { st2 = 'double'; continue; }
            if (c === '`') { st2 = 'template'; continue; }
            if (c === '(' || c === '[') d += 1;
            if (c === ')' || c === ']') d -= 1;
            if (c === '{') d += 1;
            if (c === '}') {
              d -= 1;
              if (d === 0) break;
            }
            if (c === ',' && d === 1) break;
          } else if (c === '\\') { k += 1; continue; }
          else if (
            (st2 === 'single' && c === "'")
            || (st2 === 'double' && c === '"')
            || (st2 === 'template' && c === '`')
          ) st2 = 'code';
        }
        return block.slice(j, k).trim();
      }
      i += 1;
      continue;
    }
    if (ch === '\\') { i += 2; continue; }
    if (
      (st === 'single' && ch === "'")
      || (st === 'double' && ch === '"')
      || (st === 'template' && ch === '`')
    ) st = 'code';
    i += 1;
  }
  return null;
};

/**
 * 判定**单个配置块**在运行期是否会落入统一顶栏的兜底分支（即渲染全局返回箭头）。
 *
 * 复刻 `UnifiedMobileHeader.tsx:72-77` 的判据：
 *   showBackArrowButton = showBackArrow && onMenuClick
 *   showMenuButton      = !showBackArrowButton && showMenu && onMenuClick
 *   showGlobalNavigation = !suppressGlobalBackButton && !showBackArrowButton && !showMenuButton
 *
 * ⚠️ `onMenuClick` 必须参与判定：只写 `showBackArrow: true` 而不给回调时，
 *    `true && undefined = falsy`，分支**不成立**，照样掉兜底。
 *
 * ## 静态判定的边界（必须诚实）
 * 只认字面量 `true`/`false`。条件式（`viewMode !== 'browser'`）判为 unknown——
 * 但有一种条件式是**可证安全的**：同一块内 `showBackArrow` 与 `showMenu` 的
 * 条件是**互补**的（`x` 与 `!x`），则两者必有一个为真，加上 onMenuClick 存在
 * 即可保证不落兜底。chat-v2 默认分支正是此形态：
 *   showMenu: viewMode !== 'browser',  showBackArrow: viewMode === 'browser'
 * 若不识别它，就会误报 chat-v2——**误报会逼后人去写无意义的 suppress**。
 *
 * 返回 'safe'（恒不落兜底）| 'unsafe'（恒落兜底）| 'unknown'（静态不可判定）
 */
const judgeBlock = (block: string): 'safe' | 'unsafe' | 'unknown' => {
  // suppressGlobalBackButton: true → 恒安全（无条件成立）
  if (readFlag(block, 'suppressGlobalBackButton') === 'true') return 'safe';

  const back = readFlag(block, 'showBackArrow');
  const menu = readFlag(block, 'showMenu');
  const hasMenuClick = hasProp(block, 'onMenuClick');

  // 有回调且 showBackArrow 恒真 → 走页内返回箭头分支
  if (back === 'true' && hasMenuClick) return 'safe';
  // 有回调且 showMenu 恒真（showBackArrow 非恒真）→ 走菜单按钮分支
  if (menu === 'true' && hasMenuClick) return 'safe';

  // 两者都恒假 → 必然掉兜底（除非 suppress，已排除）
  if (back === 'false' && menu === 'false') return 'unsafe';
  // back 恒真但无回调 → 分支不成立；menu 恒真但无回调同理
  if (back === 'true' && !hasMenuClick && menu !== 'true') return 'unsafe';
  if (menu === 'true' && !hasMenuClick && back !== 'true') return 'unsafe';

  // 互补条件式：两块 flag 都存在、都有回调，且两个条件是互斥补集
  // （一个形如 `X`，另一个形如 `!X` / `X === false`）→ 必有一个成立
  if (hasMenuClick && back === 'unknown' && menu === 'unknown') {
    const eBack = readExpr(block, 'showBackArrow');
    const eMenu = readExpr(block, 'showMenu');
    if (areComplementary(eBack, eMenu)) return 'safe';
  }

  return 'unknown';
};

/** 归一化表达式：去空白，便于比较 */
const norm = (e: string | null): string =>
  e ? e.replace(/\s+/g, '') : '';

/**
 * 判断两个条件表达式是否互补（恒有且只有一个为真）。
 *
 * ## 为什么必须先做「纯比较式」形态校验（P0 教训）
 * 首版只做**字符串形态**比较（lhs/rhs 相同 + 互斥操作符），不看外层包裹。
 * 审查员实测构造出假绿：
 *   showMenu:      isWide(viewMode !== 'browser')
 *   showBackArrow: isWide(viewMode === 'browser')
 * 二者 lhs/rhs 相同、操作符互斥 → 被判互补 → `safe`。
 * **但这是错的**：若 `isWide(v) = v && screenPosition === 'left'`，当
 * `screenPosition !== 'left'` 时**两者同时为假** → 掉兜底箭头，契约全绿。
 * 实测该形态下测试 7/7 全过（真实文件级复现）。
 *
 * ## 做法：白名单 — 只接受纯比较式
 * 两个操作数都必须是「标识符 / 成员访问 / 字面量 / 括号分组」的简单式，
 * 整式除比较操作符外不得含函数调用、三元、箭头、其它运算符。
 * 识别不出 → 返回 false（判 unknown，交由人工登记）——
 * **宁可要求人工确认，也不要误判 safe 制造假绿。**
 *
 * 覆盖本仓库的真实写法：
 *   `viewMode !== 'browser'` 与 `viewMode === 'browser'`（chat-v2 默认分支）
 *   `X` 与 `!X`
 */
const areComplementary = (a: string | null, b: string | null): boolean => {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;

  // ── 形态白名单：拒绝一切被包裹/复合的表达式 ──────────────────────────
  /**
   * 简单式：标识符 / 成员访问（可带下标）/ 引号字面量 / 数字。
   *
   * ⚠️ **只允许整串被一对括号完整包裹**（如 `(a)`），绝不允许「标识符后跟
   *    未闭合括号」——首版用 `^(.+?)(===|!==...)(.+)$` 先切分再逐侧剥括号，
   *    于是 `isWide(a !== 'b')` 被切成 `isWide(a` / `b)`，两侧各自剥括号后
   *    变成 `isWide(a`→`isWidea`？不——是 `isWide(a` 通过 `[A-Za-z_$][\w$]*`
   *    匹配了 `isWide` 后**剩余 `(a` 被忽略**（因为用了 `SIMPLE.test` 的
   *    **非锚定**判断），造成函数包裹假绿（审查员实测：真实文件级 7/7 全绿）。
   *    故此处**逐字符校验括号配对**，任何含未配对括号的操作数一律否决。
   */
  const isSimpleOperand = (s: string): boolean => {
    // 完整包裹的一对括号：剥掉后可继续判
    if (s.startsWith('(') && s.endsWith(')')) {
      const inner = s.slice(1, -1);
      // 括号必须真配对（多一层也要继续剥）
      let d = 0;
      let balanced = true;
      for (const c of s) {
        if (c === '(') d += 1;
        else if (c === ')') { d -= 1; if (d === 0 && s.indexOf(c) !== s.length - 1) balanced = false; }
      }
      if (balanced && d === 0) return isSimpleOperand(inner);
      return false;
    }
    // 任何括号都视为「调用/分组」→ 只在整串是括号分组时允许（上面已处理）
    if (s.includes('(') || s.includes(')')) return false;
    return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*$/.test(s)
      || /^'[^']*'$|^"[^"]*"$|^\d+$/.test(s);
  };
  /** 整式必须是「简单式 比较符 简单式」，且不含 调用/三元/箭头/逻辑与或 */
  const isPlainComparison = (s: string): boolean => {
    if (/=>|\?|&&|\|\||\bfunction\b/.test(s)) return false;
    const m = s.match(/^(.+?)(===|!==|==|!=|>=|<=|>|<)(.+)$/);
    if (!m) return false;
    const lhs = m[1].trim();
    const rhs = m[3].trim();
    if (/[,+{}]/.test(lhs) || /[,+{}]/.test(rhs)) return false;
    return isSimpleOperand(lhs) && isSimpleOperand(rhs);
  };

  /**
   * 取反形态：`!X` 对 `X`，其中 X 允许是纯比较式或简单式。
   *
   * 三种写法都算：
   *   `!cond`       对 `cond`          （简单式取反）
   *   `!(a === 'x')` 对 `(a === 'x')`   （**包裹式取反**，审查员指出这是常见真互补
   *                                      写法却会被判 unknown → 有「误报逼人加无意义
   *                                      suppress」的雪崩风险，故纳入）
   *   `!a.b`        对 `a.b`
   */
  const negationPair = (notted: string, plain: string): boolean => {
    if (notted.startsWith('!')) {
      const inner = notted.slice(1).trim();
      // 直接取反
      if (inner === plain) return isPlainComparison(inner) || isSimpleOperand(inner);
      // 括号包裹取反：`!(...)` 对 `(...)` 或对 `...`
      if (inner.startsWith('(') && inner.endsWith(')')) {
        const unwrapped = inner.slice(1, -1).trim();
        if (unwrapped === plain) return isPlainComparison(unwrapped) || isSimpleOperand(unwrapped);
        const plainUnwrapped =
          plain.startsWith('(') && plain.endsWith(')') ? plain.slice(1, -1).trim() : plain;
        if (unwrapped === plainUnwrapped) {
          return isPlainComparison(unwrapped) || isSimpleOperand(unwrapped);
        }
      }
    }
    return false;
  };
  if (negationPair(na, nb) || negationPair(nb, na)) return true;

  // 形态 2：A op1 L 对 A op2 L（两侧都必须是纯比较式）
  if (!isPlainComparison(na) || !isPlainComparison(nb)) return false;
  const cmp = (s: string): { lhs: string; op: string; rhs: string } => {
    const m = s.match(/^(.+?)(===|!==|==|!=|>=|<=|>|<)(.+)$/)!;
    return {
      lhs: m[1].replace(/[()]/g, '').trim(),
      op: m[2],
      rhs: m[3].replace(/[()]/g, '').trim(),
    };
  };
  const ca = cmp(na);
  const cb = cmp(nb);
  if (ca.lhs !== cb.lhs || ca.rhs !== cb.rhs) return false;
  const negPairs = new Set(['!==|===', '===|!==', '!=|==', '==|!=']);
  // 注意：`>|<` / `>=|<` 等**不是**互补（宽松比较），刻意不列入
  return negPairs.has(`${ca.op}|${cb.op}`);
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
  'practice-session': 'src/features/practice/pages/PracticeSessionPage.tsx',
  'capture': 'src/features/capture/pages/CapturePage.tsx',
  'knowledge-cards': 'src/features/review/pages/KnowledgeCardsPage.tsx',
  'weak-points': 'src/features/review/pages/WeakPointsPage.tsx',
  // E6：错题详情独立页。由 review-hub 推入的二级页（点开某条错题）。
  // 差异化于 knowledge-cards/weak-points：本页**有**真实上一页语义
  // （去处 = review-hub），故走 showBackArrow 分支，**不进** hub 白名单。
  'mistake-detail': 'src/features/review/pages/MistakeDetailPage.tsx',
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
    // ⏱️ 60s 预算：本用例要**递归遍历整个 src 并逐个读源文件**（同步 IO）。
    // 实测耗时随机器负载剧烈波动：
    //   - 单独跑：约 4.7~5.1s
    //   - 与 20 个测试文件并行（本仓库全量跑时就是这种负载）：曾超 30s
    // 30s 曾够用，但并行压力更大时仍会**假红**（单独跑必然通过）。
    // 这是测试基建的资源配置，不是被测逻辑的问题——不要为了「跑得快」调小。
    // 若将来要根治，应把「读全仓」改成构建期静态收集（如 import.meta.glob），
    // 但那会改变测试的加载语义，需单独评估。
  }, 60_000);

  it('keeps an App.tsx fallback label entry for every CurrentView', () => {
    const appSource = readSource('src/App.tsx');
    const labelsBlock = appSource.match(
      /const labels: Partial<Record<CurrentView, string>> = \{[\s\S]*?\};/,
    )?.[0] ?? '';

    expect(labelsBlock).not.toBe('');

    const missing = currentViews.filter((viewId) => !labelsBlock.includes(`'${viewId}':`));
    expect(missing).toEqual([]);
  });

  /**
   * Tab 根页不得渲染全局返回箭头。
   *
   * ## 为什么单独成条（bug class，已复现 4 次）
   * `UnifiedMobileHeader.tsx` 的兜底分支：
   *   `showGlobalNavigation = !suppressGlobalBackButton && !showBackArrowButton && !showMenuButton`
   * 其中 `showBackArrowButton = config.showBackArrow && config.onMenuClick`
   *     `showMenuButton = !showBackArrowButton && config.showMenu && config.onMenuClick`
   *
   * 三个都为 false 时 `showGlobalNavigation` 为真 → 渲染全局返回按钮。
   * 对「没有上一页」的 Tab 根页，这就是左上角一个点了不知道去哪的箭头。
   *
   * 历史实例：capture（已修）、review-hub（漏）、practice-hub（漏）、
   * knowledge-cards / weak-points（已修，非根页但同样无返回语义）。
   *
   * ## 判据：不是「必须 suppress」，而是「不得落入兜底分支」
   * `suppressGlobalBackButton: true` 与「**有效**的页内返回/菜单」等价：
   *   - 纯根页（capture / review-hub / practice-hub …）
   *     → 无页内返回语义 → 用 `suppressGlobalBackButton: true`
   *   - 多态宿主（settings / chat-v2 / learning-hub）
   *     → **有**真实页内返回语义（settings 逐级面包屑回退、learning-hub 目录
   *       层级回退、chat-v2 沙箱/资源预览态返回）→ 靠 `showBackArrow`
   *       或 `showMenu` 成立，**不要**硬加 suppress（那会让用户无法逐级回退）
   *
   * ## ⚠️ 判据为什么必须解析「取值」而不是「字面量存在」
   * 首版本用例写成 `/showBackArrow\s*:/` 即放行 —— **实测假绿**：
   * review-hub 修复前正是 `showBackArrow: Boolean(onBack)`（onBack 未传，运行时
   * 恒为 false），字面量存在但分支不成立，首版契约照样全绿、抓不到它。
   * 故此处**枚举白名单式**判定：
   *   - `suppressGlobalBackButton: true`  → 通过（无条件成立）
   *   - `showBackArrow: <真值>` 或 `showMenu: <真值>` → 通过
   *   - 其余（条件表达式 / 未声明 / 显式 false）→ **违规**
   *
   * ## 已知局限（诚实记录，勿当成已覆盖）
   * - 纯源码判定，不做运行时渲染判定。静态不可判定的条件式一律从严判「违规」，
   *   宁可要求显式写清，也不放行。
   * - 源码注释里的字面量会干扰判定，故匹配前先剥注释。
   */
  it('keeps every Tab root view out of the unified-header back-button fallback', async () => {
    const { TAB_ROOT_VIEW } = await import('@/config/tabNavigation');
    const rootViews = [...new Set(Object.values(TAB_ROOT_VIEW))];

    // 防空断言：根页集合必须来自真实映射表，表被清空时直接红
    expect(rootViews.length, 'TAB_ROOT_VIEW 未解析出任何根页').toBeGreaterThanOrEqual(5);

    /**
     * 多态宿主：**确实需要**全局返回箭头的 Tab 根页。
     *
     * 这些页面的部分屏幕状态（learning-hub 左屏根、settings 分区列表态）
     * **期望**统一顶栏给出全局返回。它们的 showBackArrow 依赖运行态变量
     * （screenPosition / subviewChrome / 模块内常量），静态判为 unknown，
     * 故显式豁免，而不是强行改成恒真（那会破坏真实的层级回退语义）。
     *
     * ⚠️ 这是**人工信任边界**：断言只能保证「豁免页真的走到了豁免分支」
     *    （防腐烂），**不能**验证豁免理由为真（防滥用）。新增豁免必须写明
     *    为什么该页需要全局返回，并自行确认其返回箭头有真实去处。
     */
    const MULTI_STATE_HOST_VIEWS = new Set<string>([
      // 左屏根态无页内返回；中屏子目录/右屏/子视图才用页内返回。
      // 全局返回在左屏根态是正确的（回到进入 learning-hub 之前的位置）。
      'learning-hub',
      // `showBackArrow: showSettingsBackArrow`（模块内常量 = true，且
      // onMenuClick: handleMobileHeaderBack 提供真实回退链）。静态看不清
      // 该常量 → unknown；其返回箭**有**去处，不属本 bug class。
      'settings',
    ]);

    /** 每个根页的实际判定结果（用于豁免计数与诊断信息） */
    const judged: Array<{
      viewId: string;
      problems: string[];
      verdicts?: Array<'safe' | 'unsafe' | 'unknown'>;
    }> = [];

    for (const viewId of rootViews) {
      const file = VIEW_REGISTRY_FILES[viewId];
      if (!file) {
        judged.push({ viewId, problems: [`${viewId} 是 Tab 根页，但未登记在 VIEW_REGISTRY_FILES`] });
        continue;
      }
      const blocks = extractHeaderConfigBlocks(readSource(file), viewId);
      if (blocks.length === 0) {
        judged.push({
          viewId,
          problems: [`${viewId} → ${file} 缺少 useMobileHeader('${viewId}', ...) 配置对象`],
        });
        continue;
      }

      // 逐分支判定：**每个**分支都必须不落兜底——多分支宿主里只要有一个
      // 分支会掉兜底，用户处在那个状态时就会看到多余箭头。
      //
      // ⚠️ 首版这里写成「任一分支 unsafe 才报」，被审查员实测证伪：
      //    chat-v2 删掉默认分支的 showMenu/showBackArrow 后，其余 4 个分支
      //    都是 safe，`verdicts.includes('unsafe')` 为假 → 整页放行（假绿）。
      //    改为「所有分支都须 safe」后，该攻击被判违规。
      const problems: string[] = [];
      const verdicts = blocks.map((b) => judgeBlock(b));
      const notSafe = verdicts
        .map((v, idx) => ({ v, idx }))
        .filter(({ v }) => v !== 'safe');

      if (notSafe.length > 0 && !MULTI_STATE_HOST_VIEWS.has(viewId)) {
        const detail = notSafe
          .map(({ v, idx }) => `分支#${idx}=${v}`)
          .join(', ');
        problems.push(
          `${viewId}（${file}）有 ${notSafe.length}/${blocks.length} 个配置分支`
          + `不能静态确认会渲染出有效按钮（${detail}）`
          + `——这些分支运行时会落入统一顶栏兜底分支，渲染一个无去处的全局返回箭头`
          + `。纯根页请加 suppressGlobalBackButton: true；`
          + `多态宿主请加入 MULTI_STATE_HOST_VIEWS 并写明理由。`,
        );
      }
      judged.push({ viewId, problems, verdicts });
    }

    const violations = judged.flatMap((j) => j.problems);

    // 防空断言：豁免名单不得凭空存在（页被删/改名后须同步清理）
    for (const view of MULTI_STATE_HOST_VIEWS) {
      if (!rootViews.includes(view)) {
        violations.push(
          `MULTI_STATE_HOST_VIEWS 里的 ${view} 已不是 Tab 根页（或视图已删除）`
          + `——请从豁免名单移除，避免豁免名单腐烂`,
        );
      }
    }

    expect(violations).toEqual([]);
    // 豁免必须是「被实际用到的」：名单里的页面都应真的需要豁免
    const exemptHits = judged.filter(
      (j) => j.problems.length === 0 && MULTI_STATE_HOST_VIEWS.has(j.viewId),
    );
    expect(
      exemptHits.length,
      `豁免名单里的 ${MULTI_STATE_HOST_VIEWS.size} 个页面中只有 ${exemptHits.length} 个`
      + `仍需要豁免——说明其余已可静态判定为安全，请从名单移除`,
    ).toBe(MULTI_STATE_HOST_VIEWS.size);
  });

  /**
   * 无返回语义的聚合页（hub）不得渲染全局返回箭头，**且不得让用户无路可退**。
   *
   * ## 为什么不能只查 Tab 根页
   * `practice-hub` 不是 Tab 根页（它在 `VIEW_TO_TABS` 里属 review，根页是
   * review-hub），但它同样是「点进去就停在那」的入口页，没有上一页语义。
   * 只锁根页会漏掉它——而它现实里就漏了。
   *
   * ## 两个必须同时成立的约束（第二版补的）
   * 首版只查「有没有 suppressGlobalBackButton: true」，被审查员指出：
   * 这会**用绿色测试固化一个用户退不出去的设计**。因此本用例对每个 hub 页
   * 要求「退出途径」被显式声明并校验：
   *   - `global`   ：由本页抑制全局返回，退出走 Tab 栏/页内自绘按钮
   *   - `inline`   ：本页抑制全局返回，且**页内自绘**返回按钮（需 onBack 真传入）
   * 两者都要求 suppressGlobalBackButton: true；区别在于 `inline` 额外断言
   * 页内确实消费了 onBack，避免「抑制了全局返回、页内又没按钮」的死路。
   *
   * ⚠️ 新增聚合入口页时把它加进来，并明确声明 exit 类型。
   */
  it('suppresses the global back button on back-semantics-free hub views', () => {
    const HUB_VIEWS_WITHOUT_BACK: Record<
      string,
      { file: string; exit: 'global' | 'inline'; note: string }
    > = {
      // 复习入口页：review Tab 根页。四张卡片是终点；退出靠底部 Tab 栏。
      'review-hub': {
        file: 'src/features/review/pages/ReviewHubPage.tsx',
        exit: 'global',
        note: 'Tab 根页，退出走 Tab 栏；页内自绘按钮被 {onBack && …} gate（App 未传 onBack）',
      },
      // 刷题入口页：从 review-hub 进入，页内有自绘返回按钮（App:3269 真传 onBack）。
      'practice-hub': {
        file: 'src/features/practice/pages/PracticeHubPage.tsx',
        exit: 'inline',
        note: '页内 header 自绘返回按钮，onBack 由 App 传入（去处 = review-hub）',
      },
      // 拍题页：study Tab 根页。退出走 Tab 栏。
      'capture': {
        file: 'src/features/capture/pages/CapturePage.tsx',
        exit: 'global',
        note: 'study Tab 根页，退出走 Tab 栏',
      },
      // 知识卡片：从 review-hub 进入的终端页。App 未传 onBack，页内无自绘返回，
      // 退出只能靠 Tab 栏 —— 这是既定设计（与 KnowledgeCardsPage 无 header 一致）。
      'knowledge-cards': {
        file: 'src/features/review/pages/KnowledgeCardsPage.tsx',
        exit: 'global',
        note: 'review Tab 内终端页；App:3246 未传 onBack，页内无自绘返回，退出走 Tab 栏',
      },
      // 易错点：同上（App:3257 未传 onBack）。
      'weak-points': {
        file: 'src/features/review/pages/WeakPointsPage.tsx',
        exit: 'global',
        note: 'review Tab 内终端页；App:3257 未传 onBack，页内无自绘返回，退出走 Tab 栏',
      },
    };

    const violations: string[] = [];
    for (const [viewId, { file, exit, note }] of Object.entries(HUB_VIEWS_WITHOUT_BACK)) {
      const src = readSource(file);
      const blocks = extractHeaderConfigBlocks(src, viewId);
      if (blocks.length === 0) {
        violations.push(`${viewId} → ${file} 缺少 useMobileHeader('${viewId}', ...) 配置对象`);
        continue;
      }
      // 逐分支：每个分支都必须抑制全局返回（否则某个状态下会冒出箭头）
      const bad = blocks.filter(
        (b) => readFlag(b, 'suppressGlobalBackButton') !== 'true',
      );
      if (bad.length > 0) {
        violations.push(
          `${viewId}（${file}）有 ${bad.length}/${blocks.length} 个配置分支未置`
          + ` suppressGlobalBackButton: true——统一顶栏兜底分支会渲染一个`
          + `点了不知道去哪的全局返回箭头`,
        );
      }

      // 「退出途径」校验：inline 型必须真的消费 onBack（否则抑制后无路可退）
      //
      // ⚠️ 判据刻意放宽（P1 教训）：首版只认字面量 `onClick={onBack}`，审查员
      //    实测把按钮改成**功能等价且更安全**的 `onClick={() => onBack?.()}`
      //    就报「用户将无路可退」——等于逼后人写回不安全写法（测试恶化代码）。
      //    改为「页面内存在对 onBack 的任意调用/透传点」：
      //      - 直接调用：`onBack(`（含 `onBack?.(`）
      //      - 透传：`onClick={...onBack...}`（箭头包裹/断言/别名）
      //    正则永远追不上写法演化，故只做「存在性」粗判——它拦的是
      //    「声明了 onBack 却完全没用」这种真实的死路，不追求形式精确。
      if (exit === 'inline') {
        const stripped = stripComments(src);
        // 组件须从 props 解构 onBack（`onBack,` 或 `onBack }` 或 `{ onBack }`）
        const destructures = /\bonBack\b\s*[,}\n]/.test(stripped)
          && /\{[^}]*\bonBack\b/.test(stripped);
        // 任一消费点：直接调用 或 在 onClick/handler 里透传
        const consumed = /onBack\s*\??\.?\s*\(/.test(stripped)
          || /onClick=\{[^}]*\bonBack\b/.test(stripped)
          || /=\s*\{\s*onBack\s*\}/.test(stripped)
          || /\bonBack\s*\?\?|\bonBack\s*\|\|/.test(stripped);
        if (!destructures || !consumed) {
          violations.push(
            `${viewId}（${file}）声明 exit: 'inline'（页内自绘返回），但`
            + `组件未消费 onBack（解构=${destructures}，消费点=${consumed}）`
            + `——抑制全局返回后用户将无路可退。请改为 exit: 'global' 或补页内按钮。`,
          );
        }
      }
      // 记录 note 供人复核（不参与断言，仅在失败信息里可见）
      void note;
    }

    // 防空断言：名单必须非空，避免用例被清空后恒过
    expect(Object.keys(HUB_VIEWS_WITHOUT_BACK).length).toBeGreaterThanOrEqual(5);
    expect(violations).toEqual([]);
  });
});
