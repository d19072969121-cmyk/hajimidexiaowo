/**
 * 题库元数据契约（E8 · MetaPicker / bankClient.fetchQuestionBankMeta*）
 *
 * ## 这份契约保护什么
 * 「自己定类型」需要选 学科 → 年级 → 版次 → 章节/知识点。前端这层有两个
 * **只能靠外部约定维持**的接缝，一旦漂移不会有编译错误、只会静默坏掉：
 *
 * | 接缝 | 漂移后的症状 | 本契约的锁 |
 * |---|---|---|
 * | Tauri 命令名 / 参数名（`question_bank_list_meta` + `kind`） | invoke 抛「command not found」，整块维度选择不可用 | 从 Rust 源码 regex 抽取命令名与参数名再与前端调用比对 |
 * | 合法 kind 集合（`normalize_meta_kind`） | Rust 拒非法值；前端多出一种取值则**每个用户都必踩** | 从 `normalize_meta_kind` 的 match 臂抽取 + 两侧集合互含断言 |
 * | 上游响应形状（裸数组 vs `{items}`） | 页面整片空白或 `.map is not a function` | Rust 包装分支逐条核对 + 前端双形状解析 |
 *
 * ## 为什么不做成「复制一份实现来对拍」
 * 复制件会随真货漂移，测的是复制件不是真货（见 `questionBankQuotaErrorContract.test.ts`
 * 里同类事故的记录）。故这里一律 **import 真货** + **regex 读真源码**。
 *
 * ## 关于源码断言的抗噪设计
 * Rust 行号会随无关编辑位移，硬编码行号必然假红。故本文件**先正则定位锚点、
 * 再在锚点邻域内断言**；`describe('Rust 契约对齐')` 里每条断言失败时都会打印
 * 实际抓到的内容，便于定位。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import React from 'react';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ★ invoke 必须在导入被测模块**之前** mock；vi.mock 会被提升，此处顺序只为可读。
const invokeMock = vi.fn();
const invokeArgsLog: Array<{ command: string; payload: unknown }> = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, payload?: unknown) => {
    invokeArgsLog.push({ command, payload });
    return invokeMock(command, payload);
  },
}));

// 走仓内既有 i18n mock（从真实 locale 读词条 + 支持 t(key, '缺省串') 双参），
// 手搓「返回 key」的 stub 会让按文案查询失效。
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('../../ct/mocks/react-i18next')>(
    '../../ct/mocks/react-i18next',
  );
  return { ...actual, default: (actual as { default?: unknown }).default ?? actual };
});

import {
  fetchQuestionBankMeta,
  fetchQuestionBankMetaOutcome,
  type BankMetaKind,
} from '@/features/practice/questionBank/bankClient';
import { MetaPicker } from '@/features/practice/questionBank/MetaPicker';

// ============================================================================
// Rust 真源码读取与抽取
// ============================================================================

const ROOT = process.cwd();
const RUST_CMD_REL = 'src-tauri/src/cmd/question_bank.rs';
const rustCmdSrc = readFileSync(resolve(ROOT, RUST_CMD_REL), 'utf-8');
const rustCmdLines = rustCmdSrc.split('\n');

/** 1-based 行号（与 `git blame` / 编辑器一致）；找不到返回 -1 */
const lineOf = (needle: string | RegExp): number =>
  rustCmdLines.findIndex((l) =>
    typeof needle === 'string' ? l.includes(needle) : needle.test(l),
  ) + 1;

/** 从 anchor 行向后取到第一个 '}' 为止的块文本（用于锚定函数体） */
function blockAfter(anchorIdx1: number, maxLines = 80): string {
  const out: string[] = [];
  for (let i = anchorIdx1 - 1; i < Math.min(rustCmdLines.length, anchorIdx1 - 1 + maxLines); i++) {
    out.push(rustCmdLines[i]);
    if (i > anchorIdx1 - 1 && rustCmdLines[i].trim() === '}') break;
  }
  return out.join('\n');
}

/** 抽取 normalize_meta_kind 的 match 臂：`"a" | "b" => Ok("c")` */
function parseNormalizeArms(): Array<{ inputs: string[]; normalized: string }> {
  const fnIdx = lineOf('fn normalize_meta_kind(');
  expect(fnIdx, `${RUST_CMD_REL} 里找不到 fn normalize_meta_kind`).toBeGreaterThan(0);
  const body = blockAfter(fnIdx, 30);
  const arms: Array<{ inputs: string[]; normalized: string }> = [];
  const re = /^\s*((?:"[a-z_-]+"\s*\|\s*)*"[a-z_-]+")\s*=>\s*Ok\("([a-z_-]+)"\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const inputs = Array.from(m[1].matchAll(/"([a-z_-]+)"/g), (x) => x[1]);
    arms.push({ inputs, normalized: m[2] });
  }
  return arms;
}

/** `question_bank_list_meta` 命令的 (签名行号, 参数名列表, 函数体闭区间) */
function parseListMetaCommand(): {
  attrLine: number;
  fnLine: number;
  params: string[];
  bodyStart: number;
  bodyEnd: number;
} {
  const fnLine = lineOf(/pub async fn question_bank_list_meta\(/);
  expect(fnLine, `${RUST_CMD_REL} 里找不到 pub async fn question_bank_list_meta`).toBeGreaterThan(0);

  // 向上找最近的 #[tauri::command]
  let attrLine = fnLine - 1;
  while (attrLine > 0 && !rustCmdLines[attrLine - 1].includes('#[tauri::command]')) attrLine--;
  expect(rustCmdLines[attrLine - 1], 'question_bank_list_meta 缺 #[tauri::command] 属性').toContain(
    '#[tauri::command]',
  );

  // 签名参数：从 fn 行到 `) ->` 之间的 `name: Type`
  const sigEnd = (() => {
    for (let i = fnLine - 1; i < fnLine + 12; i++) {
      if (/\)\s*->/.test(rustCmdLines[i])) return i + 1;
    }
    return fnLine + 12;
  })();
  const sigText = rustCmdLines.slice(fnLine - 1, sigEnd).join('\n');
  const params = Array.from(
    sigText.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:\s*[A-Za-z<>&'_,\s]+?,\s*$/gm),
    (m) => m[1],
  );

  // 函数体：从 sigEnd 起第一个独立 '}' 
  let bodyEnd = sigEnd;
  for (let i = sigEnd - 1; i < rustCmdLines.length; i++) {
    if (rustCmdLines[i] === '}') {
      bodyEnd = i + 1;
      break;
    }
  }
  return { attrLine, fnLine, params, bodyStart: sigEnd, bodyEnd };
}

// ============================================================================
// 从 Rust 源码推导出的「真相常量」（本文件其余断言全部基于它，不再手写）
// ============================================================================

const normalizeArms = parseNormalizeArms();
const listMeta = parseListMetaCommand();

/** Rust 面向上游的规范 kind 集合 = match 臂的 Ok(...) 值 */
const RUST_CANONICAL_KINDS = normalizeArms.map((a) => a.normalized);
/** Rust 接受的全部输入拼写（含别名） */
const RUST_ACCEPTED_SPELLINGS = normalizeArms.flatMap((a) => a.inputs);

// ============================================================================
// 夹具
// ============================================================================

const SUBJECTS = [
  { id: 1, name: '语文', pinyin: null },
  { id: 2, name: '数学', pinyin: null },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeArgsLog.length = 0;
});

// ============================================================================

describe('Rust 契约对齐（qbank meta）', () => {
  it('normalize_meta_kind 的 match 臂可被解析 —— 防止正则失效导致后续断言空跑', () => {
    // 这条是防空跑的地基：若上游重写为 if/else 或改动格式，
    // RUST_CANONICAL_KINDS 会退化成 []，后面所有集合断言将「恒真」。
    expect(
      normalizeArms.length,
      `未能从 ${RUST_CMD_REL}:${lineOf('fn normalize_meta_kind(')} 的 match 中抽取任何 arms；`
        + '若 Rust 侧改了写法，请同步更新 parseNormalizeArms 而非删断言',
    ).toBeGreaterThanOrEqual(4);
    expect(RUST_CANONICAL_KINDS.length).toBe(normalizeArms.length);
    expect(RUST_ACCEPTED_SPELLINGS.length).toBeGreaterThanOrEqual(RUST_CANONICAL_KINDS.length);
  });

  it('前端 BankMetaKind 与 Rust 规范 kind 集合互含（不是单向 includes）', () => {
    // 用 bankClient 的**类型**无法在运行时取集合，故从源码里抽取 union 成员 ——
    // 这是本文件唯一读 TS 源码的地方，为的是锁住「类型层」而非只锁常量数组。
    const tsSrc = readFileSync(
      resolve(ROOT, 'src/features/practice/questionBank/bankClient.ts'),
      'utf-8',
    );
    const unionMatch = tsSrc.match(/export type BankMetaKind\s*=([\s\S]*?);/);
    expect(unionMatch, 'bankClient.ts 里找不到 export type BankMetaKind = ...').not.toBeNull();
    const tsKinds = Array.from(
      (unionMatch as RegExpMatchArray)[1].matchAll(/'([a-z_-]+)'/g),
      (m) => m[1],
    );

    expect(tsKinds.length, 'BankMetaKind 抽取为空 —— 断言会空跑').toBeGreaterThanOrEqual(4);
    // 双向互含：多一个少一个都要红。单侧 includes 抓不到「Rust 新增 kind 前端没跟」
    expect(new Set(tsKinds)).toEqual(new Set(RUST_CANONICAL_KINDS));
  });

  it('每个前端 kind 都被 Rust 接受，且归一后与自身相同（前端只传规范写法）', () => {
    for (const arm of normalizeArms) {
      expect(
        arm.inputs,
        `normalize_meta_kind 的 Ok("${arm.normalized}") 臂未接受规范拼写本身`,
      ).toContain(arm.normalized);
    }
    for (const k of RUST_CANONICAL_KINDS) {
      const owner = normalizeArms.find((a) => a.inputs.includes(k));
      expect(owner, `kind "${k}" 在 normalize_meta_kind 中无输入臂`).toBeDefined();
      expect((owner as { normalized: string }).normalized).toBe(k);
    }
  });

  it('knowledge-points 的别名（underscore / 无分隔）由 Rust 归一，前端不必也不应传', () => {
    const kp = normalizeArms.find((a) => a.normalized === 'knowledge-points');
    expect(kp, 'normalize_meta_kind 缺少 knowledge-points 归一臂').toBeDefined();
    const inputs = (kp as { inputs: string[] }).inputs;
    // 注释里承诺的三种拼写都归一（对应 Rust 源注释「统一归一」）
    expect(inputs).toContain('knowledge_points');
    expect(inputs).toContain('knowledgepoints');
    // 但前端类型里**不得**出现别名 —— 否则同一语义会出现三种取值
    const tsSrc = readFileSync(
      resolve(ROOT, 'src/features/practice/questionBank/bankClient.ts'),
      'utf-8',
    );
    const union = (tsSrc.match(/export type BankMetaKind\s*=([\s\S]*?);/) as RegExpMatchArray)[1];
    expect(union, 'BankMetaKind 混进了 knowledge_points 别名').not.toContain("'knowledge_points'");
    expect(union, 'BankMetaKind 混进了 knowledgepoints 别名').not.toContain("'knowledgepoints'");
  });

  it('命令签名与调用点一致：命令名 + kind 参数名（附源码行）', () => {
    // 签名侧
    expect(
      listMeta.params,
      `${RUST_CMD_REL}:${listMeta.fnLine} 的签名参数与预期不符`,
    ).toContain('kind');
    // 命令必须直属 #[tauri::command]，否则前端 invoke 名字不成立
    expect(rustCmdLines[listMeta.attrLine - 1]).toContain('#[tauri::command]');

    // 前端侧：真实调用形态（由下方 invoke 断言在同一文件里再次确认参数名）
    const tsSrc = readFileSync(
      resolve(ROOT, 'src/features/practice/questionBank/bankClient.ts'),
      'utf-8',
    );
    expect(tsSrc, 'bankClient 未使用 question_bank_list_meta 命令').toMatch(
      /invoke<unknown>\('question_bank_list_meta'/,
    );
  });

  it('Rust 只透传 kind（query 为空数组）—— 前端传的 subjectId 等当前到不了上游', () => {
    const body = rustCmdLines.slice(listMeta.bodyStart - 1, listMeta.bodyEnd).join('\n');
    // ⚠️ 用 [\s\S] 而不是 [^)]：实参 `state.inner()` 自带括号，[^)]* 在它前面就停了，
    // 正则永远匹配不上（第一版就是这么假红的 —— 断言写错比不写更危险）。
    // 这是**已知缺陷**的锁定断言，不是期望行为：一旦 Rust 补上 query 透传，
    // 这条会红 —— 那正是提醒我们去改 MetaPicker 注释与 error 态预期的信号。
    expect(
      body,
      'get_json 调用的 query 不再为空 —— Rust 已支持参数透传，需更新前端契约',
    ).toMatch(/get_json\([\s\S]*?&\s*\[\s*\]\s*\)/);
    expect(body).toMatch(/format!\("v1\/meta\/\{kind\}"\)/);
    // 必须真的调到了 get_json，否则上面两个断言可以被空壳函数糊弄过去
    expect(body, '函数体未调用 get_json —— 抽取边界可能失效').toMatch(/get_json\(/);
  });

  it('Rust 对两种上游形状都归一到 items（逐分支核对源码）', () => {
    const body = rustCmdLines.slice(listMeta.bodyStart - 1, listMeta.bodyEnd).join('\n');
    // 形状 A：裸数组 → 直接用
    expect(body, 'Rust 丢失了裸数组分支').toMatch(/serde_json::Value::Array\(items\)\s*=>\s*items/);
    // 形状 B：{items: [...]} → 取 items 为数组
    expect(body, 'Rust 丢失了 {items} 包装分支').toMatch(/\.get\("items"\)/);
    expect(body).toMatch(/\.and_then\(\|v\|\s*v\.as_array\(\)\)/);
    // 形状 C：其它 → 空数组（不 panic）
    expect(body, 'Rust 丢失了兜底空数组分支').toMatch(/_\s*=>\s*Vec::new\(\)/);
    // 统一包装的出口
    expect(body).toMatch(/"kind":\s*kind/);
    expect(body).toMatch(/"items":\s*items/);
  });
});

// ============================================================================

describe('bankClient.fetchQuestionBankMeta：命令/参数/双形状', () => {
  it('invoke 命令名与参数名正确（camelCase → Rust camelCase 归一）', async () => {
    invokeMock.mockResolvedValue({ kind: 'subjects', items: SUBJECTS, usedTrial: true });

    const items = await fetchQuestionBankMeta('subjects', {
      subjectId: 7,
      gradeId: 3,
      parentId: 0,
      editionId: 11,
    });

    expect(items).toEqual(SUBJECTS);
    expect(invokeArgsLog).toHaveLength(1);
    expect(invokeArgsLog[0].command).toBe('question_bank_list_meta');
    expect(invokeArgsLog[0].payload).toEqual({
      kind: 'subjects',
      subjectId: 7,
      gradeId: 3,
      parentId: 0,
      editionId: 11,
    });
    // 参数名必须是 camelCase（Tauri 自行转 snake_case）；出现 snake_case 说明调用层错了
    expect(Object.keys(invokeArgsLog[0].payload as object)).not.toContain('subject_id');
  });

  it('形状 A：Rust 已包装的 {kind, items, usedTrial} → 取 items', async () => {
    invokeMock.mockResolvedValue({ kind: 'grades', items: [{ id: 9, name: '高三' }], usedTrial: false });
    await expect(fetchQuestionBankMeta('grades')).resolves.toEqual([{ id: 9, name: '高三' }]);
  });

  it('形状 B：上游裸数组（Rust 未包装/直连上游）→ 原样取回', async () => {
    invokeMock.mockResolvedValue([{ id: 1, name: '语文', pinyin: null }]);
    await expect(fetchQuestionBankMeta('subjects')).resolves.toEqual([
      { id: 1, name: '语文', pinyin: null },
    ]);
  });

  it('形状异常：null / undefined / 非数组 items 一律降级为空数组（不抛、不崩）', async () => {
    for (const bad of [null, undefined, 'oops', 42, {}, { items: 'not-an-array' }, { items: null }]) {
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(bad);
      await expect(
        fetchQuestionBankMeta('editions'),
        `输入 ${JSON.stringify(bad)} 未降级为空数组`,
      ).resolves.toEqual([]);
    }
  });

  it('零项成功：{items: []} 与 [] 都返回空数组（zero 判定交给 Outcome 层）', async () => {
    invokeMock.mockResolvedValue({ items: [] });
    await expect(fetchQuestionBankMeta('chapters')).resolves.toEqual([]);
    invokeMock.mockResolvedValue([]);
    await expect(fetchQuestionBankMeta('chapters')).resolves.toEqual([]);
  });

  it('invoke 抛错时**向上传播**（裸取数函数不做吞错）', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await expect(fetchQuestionBankMeta('subjects')).rejects.toThrow('boom');
  });

  it('可选参数缺省时仍传四个键（形态稳定，便于后端灰度）', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    await fetchQuestionBankMeta('subjects');
    expect(invokeArgsLog[0].payload).toEqual({
      kind: 'subjects',
      subjectId: undefined,
      gradeId: undefined,
      parentId: undefined,
      editionId: undefined,
    });
  });
});

// ============================================================================

describe('bankClient.fetchQuestionBankMetaOutcome：四态分流', () => {
  it('ok：有值 → {kind:"ok", items}', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    await expect(fetchQuestionBankMetaOutcome('subjects')).resolves.toEqual({
      kind: 'ok',
      items: SUBJECTS,
    });
  });

  it('zero：成功但空数组 → {kind:"zero", metaKind}（与 error 严格分离）', async () => {
    invokeMock.mockResolvedValue({ items: [] });
    await expect(fetchQuestionBankMetaOutcome('knowledge-points')).resolves.toEqual({
      kind: 'zero',
      metaKind: 'knowledge-points',
    });
  });

  it('zero 与 error 是两种结果：同样「没有内容」，语义与后续 UI 动作不同', async () => {
    invokeMock.mockResolvedValue({ items: [] });
    const zero = await fetchQuestionBankMetaOutcome('chapters');
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error('network timeout'));
    const error = await fetchQuestionBankMetaOutcome('chapters');

    expect(zero.kind).toBe('zero');
    expect(error.kind).toBe('error');
    // zero 不带 message（无错可言）、error 必带 message（用于渲染 + 重试判断）
    expect(zero).not.toHaveProperty('message');
    expect(error).toMatchObject({ kind: 'error', message: expect.stringContaining('network timeout') });
  });

  it('unconfigured：isConfigured === false → 不发请求（零 invoke）', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    await expect(
      fetchQuestionBankMetaOutcome('subjects', undefined, { isConfigured: false }),
    ).resolves.toEqual({ kind: 'unconfigured' });
    expect(invokeArgsLog, '未配置状态下仍发了请求').toHaveLength(0);
  });

  it('unconfigured 优先于其它态：即使上游会报错也不试', async () => {
    invokeMock.mockRejectedValue(new Error('should not be reached'));
    await expect(
      fetchQuestionBankMetaOutcome('editions', { subjectId: 1 }, { isConfigured: false }),
    ).resolves.toEqual({ kind: 'unconfigured' });
    expect(invokeArgsLog).toHaveLength(0);
  });

  it('isConfigured === undefined 表示「调用方不掌握状态」→ 不拦截，交后端裁决', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    await expect(
      fetchQuestionBankMetaOutcome('subjects', undefined, { isConfigured: undefined }),
    ).resolves.toEqual({ kind: 'ok', items: SUBJECTS });
    expect(invokeArgsLog).toHaveLength(1);
  });

  it('error：Rust AppError 形态（JSON 塞在 Error.message）→ 抽出人话 message', async () => {
    // 形态来自 models.rs:936-940 AppError { error_type, message, details }，
    // 经 Tauri 序列化后落到 Error.message
    invokeMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          error_type: 'Validation',
          message: '不支持的元数据类型「foo」：可选 subjects/grades/editions/chapters/knowledge-points',
          details: null,
        }),
      ),
    );
    const outcome = await fetchQuestionBankMetaOutcome('subjects');
    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toContain('不支持的元数据类型');
    // 断言没有把整个 JSON 原样甩到界面上
    expect((outcome as { message: string }).message).not.toContain('"error_type"');
  });

  it('四态互斥且穷尽（kind 取值集合恰为 4 个）', async () => {
    const seen = new Set<string>();
    const drive = async (impl: () => Promise<unknown>, opts?: { isConfigured?: boolean }) => {
      invokeMock.mockReset();
      invokeMock.mockImplementation(impl);
      const r = await fetchQuestionBankMetaOutcome('subjects', undefined, opts);
      seen.add(r.kind);
    };
    await drive(async () => ({ items: SUBJECTS }));
    await drive(async () => ({ items: [] }));
    await drive(async () => {
      throw new Error('x');
    });
    await drive(async () => ({ items: SUBJECTS }), { isConfigured: false });

    expect(Array.from(seen).sort()).toEqual(['error', 'ok', 'unconfigured', 'zero']);
  });
});

// ============================================================================

describe('MetaPicker 渲染契约：状态 → UI', () => {
  const stateOf = (kind: BankMetaKind) =>
    document.querySelector(`[data-testid="meta-picker-${kind}"]`)?.getAttribute('data-meta-state');

  it('loading：请求在途时同帧进 loading，且是可被读屏播报的 status', async () => {
    let release: (v: unknown) => void = () => {};
    let pending: Promise<unknown> | undefined;
    invokeMock.mockImplementation(() => {
      pending = new Promise((res) => {
        release = res;
      });
      return pending;
    });
    render(<MetaPicker kind="subjects" />);

    // 同帧：dispatch 尚未 resolve，必须已是 loading
    // （这条也是「loading 不是可选修饰」的证据 —— 上游冷启动 10.6s 期间不能渲染成空列表）
    expect(stateOf('subjects')).toBe('loading');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    // ⚠️ 必须**先 await 一次调度器推进**再 release：`load()` 在 useEffect 里是
    // 异步驱动的，只有跨过一个微任务边界后，React 才把 `setState(ok)` 挂进
    // 本轮更新队列。同步 release 会让 promise 在无 act 上下文里结算，更新被
    // 丢弃，state 永远停在 loading（本用例第一版就是这么假红的 —— 是测试
    // 缺陷，不是 MetaPicker 缺陷；对照组 probe 已排除产品侧问题）。
    await waitFor(() => expect(stateOf('subjects')).toBe('loading'));

    release({ items: SUBJECTS });
    await waitFor(() => expect(stateOf('subjects')).toBe('ok'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('ok：渲染列表与计数，选中项置 aria-selected', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    render(<MetaPicker kind="subjects" value={2} />);

    await waitFor(() => expect(stateOf('subjects')).toBe('ok'));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(
      document.querySelector('[data-testid="meta-picker-subjects-option-2"]'),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      document.querySelector('[data-testid="meta-picker-subjects-option-1"]'),
    ).toHaveAttribute('aria-selected', 'false');
  });

  it('zero：渲染空态文案且**不提供重试按钮**（正常业务结果，不是故障）', async () => {
    invokeMock.mockResolvedValue({ items: [] });
    render(<MetaPicker kind="knowledge-points" />);

    await waitFor(() => expect(stateOf('knowledge-points')).toBe('zero'));
    expect(screen.getByTestId('meta-picker-knowledge-points-empty')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="meta-picker-knowledge-points-error"]')).toBeNull();
    // 关键：空态下不得出现「重试」——否则用户会对着「本来就没有」反复点
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('error：渲染 alert + 重试按钮；点击后重新取数', async () => {
    invokeMock.mockRejectedValue(new Error('network timeout'));
    render(<MetaPicker kind="grades" />);

    await waitFor(() => expect(stateOf('grades')).toBe('error'));
    expect(document.querySelector('[data-testid="meta-picker-grades-error"]')).toHaveAttribute(
      'role',
      'alert',
    );
    const callsBefore = invokeArgsLog.length;
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(invokeArgsLog.length).toBeGreaterThan(callsBefore));

    // 重试成功 → 走出 error
    invokeMock.mockResolvedValue({ items: [{ id: 9, name: '高三' }] });
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(stateOf('grades')).toBe('ok'));
  });

  it('unconfigured：isConfigured=false 时不发请求，渲染「去配置」并能回调', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    const onConfigure = vi.fn();
    render(<MetaPicker kind="editions" isConfigured={false} onConfigure={onConfigure} />);

    await waitFor(() => expect(stateOf('editions')).toBe('unconfigured'));
    expect(invokeArgsLog, '未配置时仍发了请求').toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /去配置/ }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it('选中 → onChange(id, item)；再点同一项 → onChange(null, null)（toggle 取消）', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    const onChange = vi.fn();
    const { rerender } = render(<MetaPicker kind="subjects" value={null} onChange={onChange} />);
    await waitFor(() => expect(stateOf('subjects')).toBe('ok'));

    fireEvent.click(document.querySelector('[data-testid="meta-picker-subjects-option-1"]') as Element);
    expect(onChange).toHaveBeenCalledWith(1, SUBJECTS[0]);

    onChange.mockClear();
    rerender(<MetaPicker kind="subjects" value={1} onChange={onChange} />);
    fireEvent.click(document.querySelector('[data-testid="meta-picker-subjects-option-1"]') as Element);
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  it('value 不在列表里 → 无任何 option 被选中（残留选择不高亮，也不在渲染期回调父级）', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    const onChange = vi.fn();
    render(<MetaPicker kind="subjects" value={999} onChange={onChange} />);

    await waitFor(() => expect(stateOf('subjects')).toBe('ok'));
    for (const el of screen.getAllByRole('option')) {
      expect(el).toHaveAttribute('aria-selected', 'false');
    }
    // 若实现改成「渲染期清空父状态」，React 会警告且可能成环 —— 这里锁死不发生
    expect(onChange).not.toHaveBeenCalled();
  });

  it('竞态：迟到的旧响应不得覆盖新请求（序号防护）', async () => {
    let releaseSlow: (v: unknown) => void = () => {};
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseSlow = res;
        }),
    );
    const { rerender } = render(<MetaPicker kind="subjects" />);
    await waitFor(() => expect(stateOf('subjects')).toBe('loading'));

    // 切换 kind → 第二次请求，先返回
    invokeMock.mockResolvedValue({ items: [{ id: 2, name: '数学' }] });
    rerender(<MetaPicker kind="grades" />);
    await waitFor(() => expect(stateOf('grades')).toBe('ok'));
    expect(screen.getByText('数学')).toBeInTheDocument();

    // 旧请求此刻才返回 —— 必须被丢弃
    releaseSlow({ items: [{ id: 1, name: '语文' }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('语文')).toBeNull();
    expect(screen.getByText('数学')).toBeInTheDocument();
  });

  it('params 引用变化但值相同 → 不重复取数（serializeParams 稳定比较）', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    const { rerender } = render(<MetaPicker kind="subjects" params={{ subjectId: 1 }} />);
    await waitFor(() => expect(stateOf('subjects')).toBe('ok'));
    const callsAfterFirst = invokeArgsLog.length;

    // 每次渲染新对象引用（调用方 inline 构造的常见形态）
    rerender(<MetaPicker kind="subjects" params={{ subjectId: 1 }} />);
    rerender(<MetaPicker kind="subjects" params={{ subjectId: 1 }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(invokeArgsLog.length, '参数值未变却重复取数（会无限循环）').toBe(callsAfterFirst);
  });

  it('params 值真的变化 → 重新取数（防止稳定比较把变更也吞掉）', async () => {
    invokeMock.mockResolvedValue({ items: SUBJECTS });
    const { rerender } = render(<MetaPicker kind="grades" params={{ subjectId: 1 }} />);
    await waitFor(() => expect(stateOf('grades')).toBe('ok'));
    const callsAfterFirst = invokeArgsLog.length;

    rerender(<MetaPicker kind="grades" params={{ subjectId: 2 }} />);
    await waitFor(() => expect(invokeArgsLog.length).toBeGreaterThan(callsAfterFirst));
    expect(invokeArgsLog[invokeArgsLog.length - 1].payload).toMatchObject({
      kind: 'grades',
      subjectId: 2,
    });
  });
});
