import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 首页不得渲染 analysis（拍题解析）会话 —— 用户反馈 ①
 *
 * ## 症状
 * 「首页出现本应在拍照子页面出现的视觉 OCR 识别结果」。
 *
 * ## 根因链（已逐环取证）
 * 1. 拍题链路（`App.tsx` 的 `captureToAnalysisSession`）创建 `mode: 'analysis'`
 *    会话后，调 `sessionManager.setCurrentSessionId(session.id)` 把它设为**当前会话**，
 *    再切到 `analysis-result` 视图。
 * 2. `analysis-result` 的 `onBack` 原本只 `setCurrentView('chat-v2')`——
 *    **没有清掉当前会话**。
 * 3. 于是回到首页（chat-v2）时 `currentSessionId` 仍指向那个 analysis 会话。
 * 4. `ChatContainer`（主会话内容容器）取 `displayedMode = store.mode` = `'analysis'`
 *    → `modePlugin.renderHeader` 命中 `OcrResultHeader`
 *    （`src/features/chat/plugins/modes/analysis.ts:367`）
 *    → **在内容区顶部渲染「OCR 识别结果」折叠卡片**（题目/答案）。
 *
 * ## 与既有设计的不一致（这正说明它是缺口而非有意行为）
 * 首页**侧栏**本就排除 analysis 会话
 * （`src/features/chat/hooks/useSessionManagement.ts` 的
 * `SIDEBAR_EXCLUDE_MODES = ['analysis']`），但**内容区此前没有这层过滤**。
 * 结果就是「侧栏看不到、内容区却在渲染」。
 *
 * ## 修法（两道）
 * - **治标**：`ChatV2Page` 内容区加守卫，当前会话为 analysis 时不渲染它。
 * - **治本**：`analysis-result` 的 `onBack` 清掉当前会话
 *   （`sessionManager.setCurrentSessionId(null)`），避免留下一个
 *   「存在但不可见」的当前会话。
 *
 * ## 已知局限（诚实记录）
 * 本契约是**源码级**断言（与同目录其它契约一致）：证明的是「守卫接上了」，
 * 不是「运行期真的不渲染」。运行期需真机验证（无真机环境）。
 */

const ROOT = process.cwd();
const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

/** 词法感知剥注释（避免注释里的字面量造成假绿） */
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

describe('首页不渲染 analysis 会话（用户反馈 ①）', () => {
  const chatV2 = stripComments(readSource('src/features/chat/pages/ChatV2Page.tsx'));

  it('ChatV2Page 计算了「当前会话是否 analysis」（三态，含 store 不可用）', () => {
    // 必须是三态：store 取不到时（未注册/已被 LRU 淘汰）保守判 unknown（不渲染）。
    // boolean 版在 !store 时设 false → canRender 反转成 true → 放行渲染（审查员实测的 gap 1）。
    expect(
      chatV2,
      'ChatV2Page 没有三态会话判定 —— !store 时守卫会反转成「放行渲染」',
    ).toMatch(/sessionKind/);
    expect(
      chatV2,
      '会话判定不是三态 —— 无法表达「store 不可用」这一保守态',
    ).toMatch(/'unknown'\s*\|\s*'analysis'\s*\|\s*'other'/);
    // 依据必须是 store 的 mode，而不是别的猜测信号
    expect(
      chatV2,
      'analysis 判定未读 store.mode —— 判据不可靠',
    ).toMatch(/getState\(\)\.mode\s*===\s*'analysis'|state\.mode\s*===\s*'analysis'/);
  });

  it('ChatContainer 的渲染条件带上了该守卫', () => {
    const idx = chatV2.search(/<ChatContainer/);
    expect(idx, '未找到 ChatContainer 渲染点').toBeGreaterThan(-1);
    const window = chatV2.slice(Math.max(0, idx - 400), idx);

    /**
     * ⚠️ 判据必须只取「渲染条件本身」，**不能**取窗口全文（P0 教训）
     *
     * 首版写成 `cond = window.match(/\}\s*:\s*([^?]*?)\?\s*\(\s*$/)[1]` 再
     * `cond.includes('currentSessionIsAnalysis')`。问题：`([^?]*?)` 会从
     * **窗口内最近一个 `}:`** 开始吞 —— 实测捕获到的 `cond` 是
     *     `"undefined}\n        />\n      ) : (currentSessionId && !currentSessionIsAnalysis) "`
     * 含大量前文垃圾。于是判据退化成「**400 字符窗口全文包含**该标识符」。
     *
     * 审查员实测打穿：在 `<ChatContainer` 上方放一个**无关**属性
     * `data-isanalysis={currentSessionIsAnalysis}`，同时把守卫从渲染条件里删掉
     * → 真 bug 复发（OCR 卡片重现），契约 **绿**。
     * （三种 decoy 都奏效：属性透传 / 回调里 `void` 引用 / `className={x && 'hidden'}`）
     *
     * 修法：只保留**最后一个 `:` 之后**的片段（三元条件的分支条件），
     * 并要求它以 `?` 结尾前不含 `(`、`{`、`;` 等「已进入表达式体」的信号。
     */
    const raw = window.match(/\}\s*:\s*([^?]*?)\?\s*\(\s*$/)?.[1] ?? '';
    // 只取最后一个 `:` 之后 —— 排除掉前面兄弟分支/属性里的内容
    const realCond = raw.split(':').pop()?.trim() ?? '';

    expect(raw, '未能解析出 ChatContainer 的渲染条件').not.toBe('');
    expect(
      realCond,
      `ChatContainer 的渲染条件不含守卫（解析出的条件 = ${JSON.stringify(realCond)}）`
      + ' —— 首页会渲染 analysis 会话的 OcrResultHeader（OCR 识别结果卡片）',
    ).toMatch(/currentSessionIsAnalysis|canRenderSession/);

    // 防空断言：条件不得含「已进入表达式体」的信号（否则说明又吞了前文）
    expect(
      realCond,
      `解析出的条件疑似吞入了前文（含 );/}/> 等），判据不可靠：${JSON.stringify(realCond.slice(0, 120))}`,
    ).not.toMatch(/[;{}]|\)\s*$|\/>/);

    /**
     * 求值级断言（补正则在「语义短路」前的无能）
     *
     * 审查员在二审时构造了 `(currentSessionId || canRenderSession) && !canRenderSession`
     * —— 条件里**含**守卫名（正则放行），但它恒为假（`X && !X` 型短路）→
     * 实际放行渲染 → **假绿**。纯文本判据无法识别这类语义恒等式。
     *
     * 故把条件**在受控作用域里求值**，检查真值表：
     *   - analysis 会话（canRender=false, 有 sessionId）→ 条件必须为假（不渲染）
     *   - 普通会话（canRender=true, 有 sessionId）→ 条件必须为真（渲染）
     *   - 无会话（sessionId=null）→ 条件必须为假（走空态）
     */
    const expr = realCond;
    // 只允许标识符/字面量/逻辑运算符与括号 —— 否则不求值（避免执行任意代码）
    expect(
      /^[\w$!&|()\s'"=<>?.,:[\]]+$/.test(expr),
      `渲染条件含不可安全求值的字符，跳过求值断言：${JSON.stringify(expr)}`,
    ).toBe(true);

    const evalCond = (vars: Record<string, unknown>): boolean => {
      try {
        const keys = Object.keys(vars);
        const vals = keys.map((k) => vars[k]);
        // eslint-disable-next-line no-new-func
        return Boolean(new Function(...keys, `return (${expr});`)(...vals));
      } catch {
        return false;
      }
    };

    const vars = {
      currentSessionId: 'sid',
      canRenderSession: false,
      sessionKind: 'analysis',
      currentSessionIsAnalysis: true,
    };
    expect(
      evalCond({ ...vars, currentSessionId: 'sid', canRenderSession: false }),
      'analysis 会话（canRenderSession=false）时渲染条件为真 —— 首页会渲染 OCR 卡片',
    ).toBe(false);
    expect(
      evalCond({ ...vars, currentSessionId: 'sid', canRenderSession: true }),
      '普通会话（canRenderSession=true）时渲染条件为假 —— 该会话被误挡',
    ).toBe(true);
    expect(
      evalCond({ ...vars, currentSessionId: null, canRenderSession: false }),
      '无当前会话时渲染条件为真 —— 应走空态',
    ).toBe(false);
  });

  it('守卫是响应式的（订阅 mode 变化，而非只读一次）', () => {
    // 会话切换或 mode 变更后必须更新，否则守卫会读到陈旧值
    expect(
      chatV2,
      'analysis 守卫未随会话/mode 变化更新 —— 切到普通会话后仍可能被误判',
    ).toMatch(/subscribe\([\s\S]{0,200}?mode/);
  });

  it('analysis-result 的 onBack 清掉当前会话', () => {
    const app = stripComments(readSource('src/App.tsx'));
    const block = app.match(
      /renderViewLayer\(\s*'analysis-result',[\s\S]*?\}\)\)/,
    )?.[0] ?? '';
    expect(block, "未找到 analysis-result 的 renderViewLayer 块").not.toBe('');
    expect(
      block,
      'analysis-result 的 onBack 没有清当前会话 —— 返回首页后 currentSessionId 仍指向 '
      + 'analysis 会话，会留下一个「存在但不可见」的当前会话',
    ).toMatch(/setCurrentSessionId\(\s*null\s*\)/);
    // 仍必须切回首页
    expect(block, 'onBack 未切回 chat-v2').toMatch(/setCurrentView\(\s*'chat-v2'\s*\)/);
  });

  /**
   * ⚠️ 覆盖全部出口（返工记录，最重要的一条）
   *
   * ## 首版为什么不够
   * 首版**只在 `analysis-result` 的 `onBack` 里**清会话。审查员实测证伪 ——
   * `onBack` 只是 3 条出口中的 1 条：
   *   1. **底栏 Tab**：`handleSelectTab` 函数体内 `setCurrentSessionId` 出现 **0 次**，
   *      用户从解析页点底栏回首页（最自然的操作）根本不走 onBack；
   *   2. **Android 返回键**：App 壳层 handler 走 `unifiedGoBack.goBack()` 或
   *      fallback `setCurrentView('chat-v2')`，也不清；
   *   3. `src/components/analysis/` 下 `registerBackHandler` **零命中**。
   * → 后果：**用户点底栏回首页，OCR 卡片照样出现**（症状未消失）。
   *
   * ## 现修法
   * 把清会话收口到 `App.tsx` 的 `setCurrentView` —— 它是**所有视图切换的唯一入口**
   * （底栏 Tab、Android 返回键、顶栏返回箭头、程序化导航全部经它）。
   * 本用例锁死这个收口存在且**覆盖全部出口**。
   */
  it('清会话收口在 setCurrentView（覆盖底栏/返回键/返回箭头全部出口）', () => {
    const app = stripComments(readSource('src/App.tsx'));

    const fn = app.match(/const setCurrentView = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(fn, '未找到 setCurrentView 实现').not.toBe('');

    expect(
      fn,
      'setCurrentView 里没有清 analysis 会话的收口 —— 只有 onBack 一条出口会被清理，'
      + '用户点底栏/按返回键回首页时 OCR 卡片仍会出现',
    ).toMatch(/setCurrentSessionId\(\s*null\s*\)/);

    // 必须是「离开 analysis-result」时才清（不能无条件清，否则会误伤）
    expect(
      fn,
      '收口没有限定「离开 analysis-result」的条件 —— 会误清用户自己选中的普通会话',
    ).toMatch(/prevView\s*===\s*'analysis-result'/);
    expect(
      fn,
      '收口没有限定目标视图不等于 analysis-result —— 在解析页内部重入也会被清',
    ).toMatch(/targetView\s*!==\s*'analysis-result'/);

    // 必须校验当前会话确为 analysis 模式（避免清掉普通会话）
    expect(
      fn,
      '收口未校验当前会话的 mode —— 可能清掉用户自己选中的普通会话',
    ).toMatch(/mode\s*===\s*'analysis'/);
  });

  it('三条真实出口都不绕过 setCurrentView（结构前提）', () => {
    const app = stripComments(readSource('src/App.tsx'));

    // 出口 1：底栏 Tab → handleSelectTab 必须经 handleViewChange（即 setCurrentView）
    const selectTab = app.match(/const handleSelectTab = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(selectTab, '未找到 handleSelectTab').not.toBe('');
    expect(
      selectTab,
      'handleSelectTab 没有经 handleViewChange —— 底栏 Tab 会绕过收口',
    ).toMatch(/handleViewChange\(/);

    // 出口 2：Android 返回键 → 壳层 handler 必须调 setCurrentView（而非直接改 state）
    expect(
      app,
      'Android 返回键路径未走 setCurrentView —— 会绕过收口',
    ).toMatch(/BACK_PRIORITY\.navigation[\s\S]{0,600}?setCurrentView\(/);
  });

  it('侧栏与内容区口径一致（都排除 analysis）', () => {
    const sidebar = stripComments(readSource('src/features/chat/hooks/useSessionManagement.ts'));
    expect(
      sidebar,
      '侧栏不再排除 analysis —— 与本次修法的前提不一致，需重新评估',
    ).toMatch(/SIDEBAR_EXCLUDE_MODES\s*=\s*\[[^\]]*'analysis'/);
    // 内容区守卫的存在，正是为了对齐这个口径
    expect(chatV2).toMatch(/canRenderSession|sessionKind/);
  });
});
