import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Tab 底栏「回根」契约（用户反馈 ④：点底栏图标应回到各自的根 UI）
 *
 * ## 问题形态（已实测）
 * 部分页面的「二级面」是**页面内部 state**，不在 CurrentView 层级上——
 * 典型是 `learning-hub` 的 `screenPosition`（left/center/right 三屏）与
 * finder 目录层级。此时：
 *     TAB_ROOT_VIEW.media === 'learning-hub' === currentView
 * → `setCurrentView` 是同值写入、React 不重渲染
 * → `VIEW_SWITCHED` 也不会派发（它只在 view 真变时广播）
 * → **页面停在二级面不动**，用户点了底栏也回不到根。
 *
 * ## 修法（本契约锁死的形状）
 * 1. `handleSelectTab`（App.tsx）**无条件**广播 `APP_EVENTS.TAB_ROOT_RESET`，
 *    载荷 { tab, view }——即使视图未变化。
 * 2. 有内部层级的页面用 `useAppEvent(TAB_ROOT_RESET, …)` 监听，
 *    比对 `detail.view` 与自身视图 id，命中则把内部状态复位到根。
 *
 * ## 为什么用「源码级契约」而不是渲染测试
 * 本仓库同类契约（mobileHeaderViewRegistryContract 等）都是源码级断言。
 * 渲染整个 App 需要 mock 大量原生依赖（Tauri invoke 等），成本远高于收益；
 * 而这三条断言恰好覆盖了「链路是否接通」的全部环节。
 *
 * ⚠️ 已知局限：源码级断言证明的是「代码写了」，不是「运行期真的复位」。
 *    运行期行为需真机验证（见文件末的说明）。
 */

const ROOT = process.cwd();

const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

/** 剥注释：避免注释里的字面量造成假绿 */
const stripComments = (src: string): string => {
  let out = '';
  let i = 0;
  type S = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let st: S = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (st === 'code') {
      if (ch === '/' && next === '/') { st = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { st = 'block'; i += 2; continue; }
      if (ch === "'") { st = 'single'; out += ch; i += 1; continue; }
      if (ch === '"') { st = 'double'; out += ch; i += 1; continue; }
      if (ch === '`') { st = 'template'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (st === 'line') {
      if (ch === '\n') { st = 'code'; out += ch; i += 1; continue; }
      i += 1; continue;
    }
    if (st === 'block') {
      if (ch === '*' && next === '/') { st = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
    if (
      (st === 'single' && ch === "'")
      || (st === 'double' && ch === '"')
      || (st === 'template' && ch === '`')
    ) { st = 'code'; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
};

/**
 * 判断某个动作是否落在**恒假条件分支**内（即永不执行）。
 *
 * ## 为什么需要（P1-5 教训）
 * 表驱动的 `mustReset` 首版只做**文本存在性**检查，审查员把整段复位塞进
 * `if (false) { selectItem(null); ... }` 后，契约实测 **6/6 全绿**
 * —— 看似接线，实际复位永不执行。
 *
 * ## 判据（保守，只拦明显恒假）
 * 取该动作之前最近的 `if (...)` 条件文本，若条件为显然的假值
 * （`false` / `0` / `''` / `null` / `undefined` / `!true`）则判为死分支。
 * 刻意不做控制流分析——那需要真正的解析器；此处只堵「明显写死」的形态。
 * 真正的可达性保证应由运行期用例承担（见文件头的已知局限）。
 */
const isInDeadBranch = (src: string, action: RegExp): boolean => {
  const m = action.exec(src);
  if (!m) return false;
  const before = src.slice(0, m.index);
  // 找最近一个未被闭合的 if 条件（简化：取最后一次出现的 if (...)）
  const condRe = /if\s*\(([^)]*)\)\s*\{/g;
  let last: RegExpExecArray | null = null;
  let hit: RegExpExecArray | null;
  while ((hit = condRe.exec(before)) !== null) last = hit;
  if (!last) return false;
  const cond = last[1].trim().replace(/\s+/g, '');
  const alwaysFalse = ['false', '0', "''", '""', 'null', 'undefined', '!true'];
  return alwaysFalse.includes(cond);
};

describe('Tab 底栏回根契约（用户反馈 ④）', () => {
  const appSrc = stripComments(readSource('src/App.tsx'));
  const eventsSrc = stripComments(readSource('src/events/app.ts'));

  it('APP_EVENTS 定义了 TAB_ROOT_RESET 事件常量', () => {
    expect(
      /TAB_ROOT_RESET\s*:\s*'[^']+'/.test(eventsSrc),
      'APP_EVENTS 缺少 TAB_ROOT_RESET —— 底栏回根没有事件通道',
    ).toBe(true);
  });

  it('TAB_ROOT_RESET 有对应的载荷类型（tab + view）', () => {
    const payload = eventsSrc.match(/interface\s+TabRootResetDetail\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(payload, '缺少 TabRootResetDetail 接口').not.toBe('');
    expect(payload, '载荷缺 tab 字段').toMatch(/\btab\s*:/);
    expect(payload, '载荷缺 view 字段（页面据此判断是否该复位自己）').toMatch(/\bview\s*:/);
    // 必须登记进 AppEventPayloads，否则 useAppEvent 的 detail 类型为 never
    expect(
      eventsSrc,
      'TAB_ROOT_RESET 未登记进 AppEventPayloads —— useAppEvent 拿不到类型',
    ).toMatch(/\[APP_EVENTS\.TAB_ROOT_RESET\]\s*:/);
  });

  it('handleSelectTab 无条件广播 TAB_ROOT_RESET（不能只在视图变化时广播）', () => {
    const fnBody = appSrc.match(/const handleSelectTab = useCallback\(\(tab: TabId\)[\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(fnBody, '未找到 handleSelectTab 实现').not.toBe('');

    // 必须派发该事件
    expect(
      fnBody,
      'handleSelectTab 没有派发 TAB_ROOT_RESET —— 视图未变时页面收不到复位信号（用户反馈 ④ 的根因）',
    ).toMatch(/dispatchAppEvent\(\s*APP_EVENTS\.TAB_ROOT_RESET/);

    // 载荷必须带上 view（页面靠它判断「复位的是不是我」）
    expect(fnBody, 'TAB_ROOT_RESET 载荷缺少 view 字段').toMatch(/TAB_ROOT_RESET[^)]*view\s*:/);

    /**
     * 「无条件」判定 —— 必须是**结构性**的，不能只看派发行（P2 教训）。
     *
     * 首版写成 `expect(dispatchLine).not.toMatch(/if\s*\(|\?|&&/)`：只检查
     * 派发行那一行。审查员实测用**逗号表达式**绕过：
     *     cond, dispatchAppEvent(APP_EVENTS.TAB_ROOT_RESET, {...});
     * 条件藏在 `,` 左侧、同一行不含 `if(`/`?`/`&&` → 契约 5/5 全绿，
     * 而派发实际被短路隐藏 —— **假绿**。
     *
     * 现改为求值级判据：把 handleSelectTab **在受控环境里跑一遍**，
     * 令守卫/依赖全为「触发」侧，断言派发**确实发生**且载荷正确；
     * 再令其处于「非触发」侧，断言仍会派发（这才是「无条件」）。
     */
    // 取出函数体（去掉 useCallback 包裹），在受控作用域里求值。
    // 目标：得到"语句序列"（不含最外层的 { }），供 new Function 使用。
    const inner = fnBody
      .replace(/^[\s\S]*?=>\s*\{/, '')          // 去掉签名与开括号
      .replace(/\}\s*,\s*\[[^\]]*\]\s*\)\s*;\s*$/, '') // 去掉 deps 与收尾
      .replace(/\}\s*;\s*$/, '')                // 去掉函数体收尾的 }
      .trim();

    // 防空断言：提取必须成功，否则后面的求值没有意义
    expect(inner, '未能提取 handleSelectTab 函数体').not.toBe('');
    expect(inner, '提取结果仍含 useCallback 包裹').not.toMatch(/useCallback/);

    const run = (opts: { tab: string; blockNavigation: boolean }) => {
      const dispatched: Array<{ name: string; detail: unknown }> = [];
      const views: string[] = [];
      // 复刻函数所依赖的最小环境
      const shouldBlockMobileNavigation = () => opts.blockNavigation;
      const handleViewChange = (v: string) => { views.push(v); };
      const dispatchAppEvent = (name: string, detail: unknown) => {
        dispatched.push({ name, detail });
      };
      const TAB_ROOT_VIEW: Record<string, string> = {
        home: 'chat-v2', study: 'capture', review: 'review-hub',
        media: 'learning-hub', me: 'settings',
      };
      const APP_EVENTS = { TAB_ROOT_RESET: 'app:tab-root-reset' };
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        'tab', 'shouldBlockMobileNavigation', 'handleViewChange',
        'dispatchAppEvent', 'TAB_ROOT_VIEW', 'APP_EVENTS',
        inner,
      );
      const ret = fn(
        opts.tab, shouldBlockMobileNavigation, handleViewChange,
        dispatchAppEvent, TAB_ROOT_VIEW, APP_EVENTS,
      );
      return { dispatched, views, ret };
    };

    // 场景 1：正常点击 me（守卫放行）→ 必须派发，且载荷 tab/view 正确
    const r1 = run({ tab: 'me', blockNavigation: false });
    expect(
      r1.dispatched.map((d) => d.name),
      '正常点击底栏没有广播 TAB_ROOT_RESET',
    ).toContain('app:tab-root-reset');
    expect(r1.dispatched[0]?.detail).toEqual({ tab: 'me', view: 'settings' });
    expect(r1.views, '未导航到该 Tab 的根视图').toEqual(['settings']);

    // 场景 2（核心）：**即使视图未变化**（当前已在根视图）也必须派发——
    // 这正是用户反馈 ④ 的场景（TAB_ROOT_VIEW[tab] === currentView）。
    // 求值层面无法直接构造「同值」，但可断言派发不依赖任何额外条件：
    // 逐个 Tab 点击，全部都要派发。
    for (const tab of ['home', 'study', 'review', 'media', 'me']) {
      const r = run({ tab, blockNavigation: false });
      expect(
        r.dispatched.length,
        `点击 ${tab} 时没有广播 TAB_ROOT_RESET —— 「无条件」语义被破坏`,
      ).toBe(1);
    }

    // 场景 3：守卫拦截时**不应**导航（保持既有契约），但这是既有行为，
    // 此处只记录不断言派发与否，避免把「守卫语义」误绑到本事件上。
    const r3 = run({ tab: 'home', blockNavigation: true });
    expect(r3.views, '守卫拦截时仍发生了导航').toEqual([]);

    // ── 结构性防线：「无条件」＝派发是**独立表达式语句**，不附着于任何条件 ──
    //
    // P2 教训：先前用「派发行不含 if(/?/&&」判定，被**逗号表达式**绕过：
    //     ((tab === 'never') || (0)), dispatchAppEvent(APP_EVENTS.TAB_ROOT_RESET, {...});
    // 条件藏在 `,` 左侧、同一行不含那些字符 → 5/5 全绿，而派发实际被短路。
    // 花括号平衡法同样拦不住（逗号表达式不在块内）。
    //
    // 可靠判据：派发语句的**前一个非空白字符**必须是语句边界（`;` `{` `}`）——
    // 若为 `(` `,` `&` `|` `?` `:` 等，说明它被并入了某个表达式/条件。
    const dispatchIdx = fnBody.search(/dispatchAppEvent\(\s*APP_EVENTS\.TAB_ROOT_RESET/);
    expect(dispatchIdx, '未找到派发语句').toBeGreaterThan(-1);
    const prevChar = fnBody.slice(0, dispatchIdx).replace(/\s+$/, '').slice(-1);
    expect(
      [';', '{', '}'].includes(prevChar),
      `TAB_ROOT_RESET 的派发不是独立语句（前一个字符是 ${JSON.stringify(prevChar)}）`
      + ` —— 它被并入了条件/逗号表达式，可能被短路。「无条件广播」要求它独占一条语句。`,
    ).toBe(true);
  });

  it('学习中心（internal 层级页）监听 TAB_ROOT_RESET 并复位内部状态', () => {
    const hub = stripComments(readSource('src/features/learning-hub/LearningHubPage.tsx'));

    expect(
      hub,
      'learning-hub 未监听 TAB_ROOT_RESET —— 点 media 底栏会停在二级面（用户反馈 ④）',
    ).toMatch(/useAppEvent\(\s*APP_EVENTS\.TAB_ROOT_RESET/);

    const handler = hub.match(/useAppEvent\(\s*APP_EVENTS\.TAB_ROOT_RESET,[\s\S]*?\},\s*\[[^\]]*\]\)/)?.[0] ?? '';
    expect(handler, '未找到 TAB_ROOT_RESET 处理器').not.toBe('');

    // 必须按 view 过滤，避免响应其它 Tab 的复位
    expect(handler, '处理器未按 detail.view 过滤').toMatch(/detail\??\.view/);
    // 必须把三屏状态复位到 center（中屏是根）
    expect(
      handler,
      "处理器未把 screenPosition 复位到 'center' —— 从 left/right 屏点底栏回不到根",
    ).toMatch(/setScreenPosition\(\s*'center'\s*\)/);
  });

  /**
   * 所有「有内部层级的 **Tab 根视图**」都必须监听 TAB_ROOT_RESET。
   *
   * ## ⚠️ 适用条件（重要，返工教训）
   * 只有**该页就是自己 Tab 的根视图**（`TAB_ROOT_VIEW[tab] === 本页`）时，
   * 底栏复位才**对用户可见**。否则点底栏会先 `setCurrentView(TAB_ROOT_VIEW[tab])`
   * 把用户切走，复位发生在已 `visibility:hidden` 的层里 —— 白写，还多一次误导航。
   *
   * 首版曾给 `todo` / `template-management` / `flashcards` 三页接线，**方向错误**：
   * - 三页都不是自己 Tab 的根视图（todo≠chat-v2、template-management≠settings、
   *   flashcards≠review-hub），复位用户看不见；
   * - `todo`：automations 子树是 ternary 替换（非保活），复位会 unmount 掉
   *   用户未保存的自动化草稿；
   * - `template-management`：复位的脏检查走 `unifiedConfirm`，它是「toast +
   *   8 秒内再点一次即放行」的两击语义（**不是模态框**）。用户点 me 见没反应、
   *   本能再点一次 → **静默丢弃未保存的模板编辑**。
   * 三处已撤销，本用例改为**只覆盖根视图**并锁死这个适用条件。
   *
   * ## 每行字段
   * - file       ：页面文件
   * - viewId     ：自身视图 id（必须 === TAB_ROOT_VIEW[tab]，下方有断言校验）
   * - tab        ：归属 Tab
   * - mustReset  ：必须复位的状态
   * - neverReset ：**刻意不复位**的状态（锁死「不打断进行中任务」的决策）
   */
  it('每个有内部层级的 Tab 根视图都接了 TAB_ROOT_RESET（表驱动，防漏网）', async () => {
    const { TAB_ROOT_VIEW } = await import('@/config/tabNavigation');

    const CASES: Array<{
      viewId: string;
      tab: 'home' | 'study' | 'review' | 'media' | 'me';
      file: string;
      mustReset: RegExp[];
      neverReset?: Array<{ pattern: RegExp; why: string }>;
    }> = [
      {
        viewId: 'chat-v2',
        tab: 'home',
        file: 'src/features/chat/pages/ChatV2Page.tsx',
        mustReset: [/setSessionSheetOpen\(\s*false\s*\)/],
        neverReset: [
          {
            pattern: /closeSandboxWorkbench|closeMobileSandbox\s*\(\)/,
            why: '右屏是用户正在查看的资源/运行中的沙箱，底栏复位不得关掉它（属功能破坏）',
          },
        ],
      },
      {
        viewId: 'learning-hub',
        tab: 'media',
        file: 'src/features/learning-hub/LearningHubPage.tsx',
        mustReset: [/setScreenPosition\(\s*'center'\s*\)/, /finderGoUpRef\.current\s*\(/],
      },
      {
        viewId: 'settings',
        tab: 'me',
        file: 'src/features/settings/components/Settings.tsx',
        mustReset: [
          /setScreenPosition\(\s*'center'\s*\)/,
          /setMobileNavView\(\s*'sections'\s*\)/,
          /setActiveTab\(/,
        ],
      },
    ];

    const violations: string[] = [];

    // ── 先校验适用条件：表里每一项都必须是自己 Tab 的根视图 ──
    for (const c of CASES) {
      if (TAB_ROOT_VIEW[c.tab] !== c.viewId) {
        violations.push(
          `${c.viewId} 不是 ${c.tab} Tab 的根视图（TAB_ROOT_VIEW[${c.tab}] = `
          + `${TAB_ROOT_VIEW[c.tab]}）—— 底栏复位对本页用户不可见，接线无效。`
          + `请从表中移除；本页二级面应走自己的顶栏返回/系统返回。`,
        );
      }
    }

    for (const c of CASES) {
      const src = stripComments(readSource(c.file));
      const handler =
        src.match(/useAppEvent\(\s*APP_EVENTS\.TAB_ROOT_RESET,[\s\S]*?\},\s*\[[^\]]*\]\)/)?.[0] ?? '';
      if (!handler) {
        violations.push(`${c.viewId}（${c.file}）未监听 TAB_ROOT_RESET —— 点底栏会停在二级面`);
        continue;
      }
      for (const re of c.mustReset) {
        // ★ 可达性检查（P1-5 教训）：必须出现在 while/if 的**体内部**才算数，
        //   首版只做「文本存在性」，审查员把复位塞进 `if (false) {}` 后仍 6/6 全绿。
        if (!re.test(handler)) {
          violations.push(`${c.viewId} 的复位处理器缺少动作 ${re}（该状态决定用户能否回根）`);
        } else if (isInDeadBranch(handler, re)) {
          violations.push(
            `${c.viewId} 的复位动作 ${re} 落在「恒假条件」分支内 —— 看似接线，实际永不执行`,
          );
        }
      }
      for (const nr of c.neverReset ?? []) {
        if (nr.pattern.test(handler)) {
          violations.push(`${c.viewId} 的复位处理器出现了被禁动作 ${nr.pattern} —— ${nr.why}`);
        }
      }
    }

    // 防空断言：表必须覆盖已知的根视图，被清空时直接红
    expect(CASES.length, '表驱动用例被清空').toBeGreaterThanOrEqual(3);
    expect(violations).toEqual([]);
  });

  it('复位是幂等的：finder 回根有循环守卫，不会死循环或过度回退', () => {
    const hub = stripComments(readSource('src/features/learning-hub/LearningHubPage.tsx'));
    const handler = hub.match(/useAppEvent\(\s*APP_EVENTS\.TAB_ROOT_RESET,[\s\S]*?\},\s*\[[^\]]*\]\)/)?.[0] ?? '';
    expect(handler, '未找到 TAB_ROOT_RESET 处理器').not.toBe('');

    // 回根循环必须有 guard 上限（异常状态下不得死循环）。
    // 上限必须落在合理范围——`guard < 999999` 这类形式上的守卫不算（P3 教训）。
    const guardMatch = handler.match(/guard\s*<\s*(\d+)/);
    expect(guardMatch, '回根 while 循环没有 guard 上限 —— 异常状态可能死循环冻结 UI').not.toBeNull();
    const guardLimit = Number(guardMatch![1]);
    expect(
      guardLimit,
      `guard 上限 ${guardLimit} 不合理（应为 1..64 的合理深度）`,
    ).toBeGreaterThan(0);
    expect(guardLimit, `guard 上限 ${guardLimit} 过大，等于没有守卫`).toBeLessThanOrEqual(64);

    // 循环条件必须基于「还有上一层」而不是恒真
    expect(
      handler,
      '回根循环条件恒真风险',
    ).toMatch(/finderBreadcrumbsRef\.current\.length\s*>\s*0|isInSubfolder/);

    // ★ 循环体必须**真的推进状态**（P3 教训：首版只做存在性断言，
    //   条件写成 length > 0 但循环体为空也能过）。
    //   取出 while 的循环体，断言其中确实调用了 goUp —— 且必须是走 ref 的实时引用
    //   （P1 教训：直接闭包捕获的 finderGoUp 会冻结在首帧的 store 桶上）。
    const whileBody = handler.match(/while\s*\([^)]*\)\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(whileBody, '未找到 while 循环体').not.toBe('');
    expect(
      whileBody,
      '回根循环体没有调用 goUp —— 循环空转，回根实际不生效',
    ).toMatch(/finderGoUpRef\.current\s*\(|finderGoUp\s*\(/);
    expect(
      whileBody,
      '回根循环用了闭包捕获的 finderGoUp —— deps:[] 会把它冻结在首帧的 store 桶上'
      + '（尺寸跨越 768px 后会打错桶）。必须走 finderGoUpRef.current()',
    ).toMatch(/finderGoUpRef\.current\s*\(/);
  });
});
