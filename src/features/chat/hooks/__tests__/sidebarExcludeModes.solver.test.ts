/**
 * E13-R 回归测试：首页侧栏排除模式必须覆盖整个「拍题家族」
 *
 * 缺陷（已修）：SIDEBAR_EXCLUDE_MODES 曾写死 `['analysis']`，漏掉 E8 的
 * `solver`（拍题解题 agent）。后果：solver 拍题会话混进首页常规会话列表，
 * 而错题本（useMistakeBook 走 isAnalysisFamilyMode）也收录它 ——
 * 同一会话在两处归属不一致。
 *
 * 本测试锁死：排除集必须来自单一真相源 ANALYSIS_FAMILY_MODES，
 * 且必须包含全部拍题族模式；新增解析类模式时自动跟随。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ANALYSIS_FAMILY_MODES,
  isAnalysisFamilyMode,
} from '@/features/chat/plugins/modes/modeFamily';

const HOOK_PATH = resolve(
  process.cwd(),
  'src/features/chat/hooks/useSessionManagement.ts'
);

describe('E13-R 侧栏排除模式（solver 回归）', () => {
  it('ANALYSIS_FAMILY_MODES 覆盖 analysis 与 solver', () => {
    expect(ANALYSIS_FAMILY_MODES).toContain('analysis');
    expect(ANALYSIS_FAMILY_MODES).toContain('solver');
  });

  it('SIDEBAR_EXCLUDE_MODES 由族常量派生，未写死字符串', () => {
    const src = readFileSync(HOOK_PATH, 'utf8');
    expect(src).toContain(
      'const SIDEBAR_EXCLUDE_MODES = [...ANALYSIS_FAMILY_MODES];'
    );
    // 反向断言：不得再出现写死的模式数组（注释里的示例除外）
    expect(src).not.toMatch(/const SIDEBAR_EXCLUDE_MODES = \['analysis'\]/);
  });

  it('排除集包含全部拍题族模式（solver 不会漏排除）', () => {
    // 模拟运行期取值：本项不依赖常量字面量，而是验证语义契约
    const excluded = [...ANALYSIS_FAMILY_MODES];
    for (const mode of ['analysis', 'solver']) {
      expect(excluded).toContain(mode);
      expect(isAnalysisFamilyMode(mode)).toBe(true);
    }
  });

  it('普通会话模式不被排除（避免误伤）', () => {
    const excluded = [...ANALYSIS_FAMILY_MODES];
    expect(excluded).not.toContain('chat');
    expect(excluded).not.toContain('textbook');
    expect(excluded).not.toContain('review');
  });
});
