/**
 * E4 交叉验证修复 — 拍题链路契约
 *
 * ## 为什么需要这份测试（致命缺口备忘）
 * 交叉审查发现：拍题链路**曾经是断的**。
 *
 * `captureToAnalysisSession` 从 App 层直接调 `sessionManager.setCurrentSessionId`，
 * 而 `ChatV2Page` 对 sessionManager 是**单向写、从不订阅**：
 *   - `ChatContainer sessionId={currentSessionId}` 取的是 ChatV2Page 的**本地 state**
 *   - 本地 state 不知情 → prop 不变 → useTauriAdapter 不为新会话 setup
 *   - → `initSession`/`onInit` 不执行 → **OCR 与解析永不发起**
 *   - → 新 store 的 `isDataLoaded` 初值 false → 解析页**永久转圈**
 *
 * 当时 219 个用例全绿却没拦住它——因为测试只断言了接线字符串与组件行为，
 * **从未断言「OCR 真的会跑起来」**。本文件专门补这个盲区。
 *
 * 覆盖方式（不渲染整个 ChatV2Page，成本过高）：
 *   1. 源码契约：ChatV2Page 必须订阅 current-session-changed
 *   2. 源码契约：订阅的回调必须落到包装版 setCurrentSessionId（而非只读 sessionManager）
 *   3. 源码契约：拍题路径必须先 setCurrentSessionId 再切视图
 *   4. 行为验证：initConfig 确实被存进了 sessionManager 的 meta（链路起点成立）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chatPageSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'),
  'utf8',
);
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

/**
 * 剥离注释后的源码。
 *
 * ⚠️ 必须剥离：交叉审查实测证明，「用原始源码做字符串匹配」的契约可被注释规避——
 *    把接线整段注释掉、字面量仍在，断言照样通过。E3 的 `onStartPractice` 死 prop
 *    与 E4 的 `onSubmitImages` 都被这样绕过。任何源码级断言都应先过这个函数。
 */
function stripComments(src: string): string {
  return src
    // 块注释（含 JSX 注释 {/* ... */}）
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 行注释（避免误伤 http:// 这类，要求 // 前不是冒号）
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const chatPageCode = stripComments(chatPageSource);
const appCode = stripComments(appSource);

describe('E4 拍题链路契约：外部驱动的会话切换必须能传到 ChatContainer', () => {
  it('ChatV2Page 订阅了 sessionManager（曾经零订阅 → 链路断裂）', () => {
    // 这是本契约的核心：若此断言失败，说明「App 层直接改 sessionManager」
    // 的路径又断开了，拍题后 OCR 不会发起、解析页永久转圈。
    expect(
      chatPageCode.includes('sessionManager.subscribe'),
      'ChatV2Page 未订阅 sessionManager：外部驱动的会话切换无法传到本地 state，'
      + 'ChatContainer 的 sessionId prop 不会更新，adapter 不会为新会话 setup，'
      + 'initSession/onInit 不执行 → OCR 与解析永不发起。',
    ).toBe(true);
  });

  it('订阅回调处理的是 current-session-changed 事件', () => {
    const subIdx = chatPageCode.indexOf('sessionManager.subscribe');
    expect(subIdx).toBeGreaterThan(-1);
    const block = chatPageCode.slice(subIdx, subIdx + 700);
    expect(block).toMatch(/current-session-changed/);
  });

  it('订阅回调调用包装版 setCurrentSessionId（而非绕过它直接改 sessionManager）', () => {
    const subIdx = chatPageCode.indexOf('sessionManager.subscribe');
    const block = chatPageCode.slice(subIdx, subIdx + 700);
    // 包装版会 setState → ChatContainer 换 sessionId → adapter setup。
    // 若只调 sessionManager 自己，state 不变，等同于没接。
    expect(block).toMatch(/setCurrentSessionId\(/);
  });

  it('订阅回调有相等守卫（防自身写入的回声循环）', () => {
    const subIdx = chatPageCode.indexOf('sessionManager.subscribe');
    const block = chatPageCode.slice(subIdx, subIdx + 700);
    // 无守卫时：本效果调 setCurrentSessionId → 写 sessionManager → 再触发本效果 → 死循环
    expect(block).toMatch(/currentSessionIdRef\.current/);
  });

  it('订阅回调在初始加载期不接管（避免与 loadSessions/draft 竞争）', () => {
    const subIdx = chatPageCode.indexOf('sessionManager.subscribe');
    const block = chatPageCode.slice(subIdx, subIdx + 700);
    expect(block).toMatch(/initialLoadingRef\.current/);
  });
});

describe('E4 拍题链路契约：captureToAnalysisSession 的正确顺序', () => {
  const block = appCode.slice(appCode.indexOf('const captureToAnalysisSession'));

  it('先 setCurrentSessionId 再 setCurrentView（顺序错则解析页永久空态/加载态）', () => {
    const setIdx = block.indexOf('sessionManager.setCurrentSessionId(session.id)');
    const viewIdx = block.indexOf("setCurrentView('analysis-result')");
    expect(setIdx).toBeGreaterThan(-1);
    expect(viewIdx).toBeGreaterThan(-1);
    expect(
      setIdx,
      'setCurrentSessionId 必须在 setCurrentView 之前：'
      + '解析页的 useActiveChatStore 经 getCurrentSessionId() 取 store，'
      + '顺序颠倒会拿不到会话。',
    ).toBeLessThan(viewIdx);
  });

  it('建的会话 mode 是 analysis（错题本据此筛选，OCR/自动解析据此启用）', () => {
    expect(block).toMatch(/mode:\s*'analysis'/);
  });

  it('把 images 放进 initConfig（onInit 从这里取图并触发 OCR）', () => {
    expect(block).toMatch(/initConfig:\s*\{\s*images\s*\}/);
  });
});

describe('E4 拍题链路契约：链路起点——initConfig 必须能到达 sessionManager meta', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createSessionWithDefaults 把 initConfig 透传给 getOrCreate（后续由 initSession 消费）', async () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/features/chat/core/session/createSessionWithDefaults.ts'),
      'utf8',
    );
    // getOrCreate 里存 meta.pendingInitConfig，最终由 TauriAdapter.setup 读到并调 initSession
    expect(src).toMatch(/getOrCreate\(session\.id,\s*\{[\s\S]*?initConfig:\s*options\.initConfig/);
  });

  it('sessionManager.getOrCreate 会把 initConfig 存进 meta.pendingInitConfig', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/features/chat/core/session/sessionManager.ts'),
      'utf8',
    );
    expect(src).toMatch(/meta\.pendingInitConfig\s*=\s*options\.initConfig/);
  });

  it('TauriAdapter.setup 会读 pendingInitConfig 并调 initSession', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/features/chat/adapters/TauriAdapter.ts'),
      'utf8',
    );
    expect(src).toMatch(/meta\?\.pendingInitConfig/);
    expect(src).toMatch(/initSession\(mode,\s*initConfig\)/);
  });

  it('analysis 模式的 onInit 里确实会跑 OCR 并发首轮解析', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/features/chat/plugins/modes/analysis.ts'),
      'utf8',
    );
    // 这是「OCR 真会跑」的最终依据：onInit → performOcr → autoSendFirstMessage
    expect(src).toMatch(/onInit:\s*async/);
    expect(src).toMatch(/performOcr\(/);
    expect(src).toMatch(/autoSendFirstMessage\(/);
    expect(src).toMatch(/autoStartFirstMessage:\s*true/);
  });
});
