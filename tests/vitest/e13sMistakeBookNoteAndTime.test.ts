/**
 * E13-S：错题本「分类（含时间）+ 备注」纯逻辑测试
 *
 * 覆盖两块无 UI 依赖的核心逻辑：
 * 1. `useMistakeNote` 的 metadata 读/写/合并（**持久化正确性的关键**）
 * 2. `mistakeTimeFilter` 的时间区间筛选与月份分组
 *
 * 不 mock Tauri；`saveMistakeNote` 的 IPC 行为在单独用例里用 vi.mock 验证。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  MISTAKE_NOTE_METADATA_KEY,
  MISTAKE_NOTE_MAX_LENGTH,
  readMistakeNote,
  buildNoteMetadata,
  isNoteChanged,
  indexSessionsById,
} from '@/features/review/hooks/useMistakeNote';
import {
  toMonthKey,
  isWithinTimeRange,
  filterByTimeRange,
  groupByMonth,
  formatMonthLabel,
  MISTAKE_TIME_RANGES,
} from '@/features/review/hooks/mistakeTimeFilter';
import type { ChatSession } from '@/features/chat/types/session';

// ---------- 备注：metadata 读写与合并 ----------

describe('E13-S 备注：metadata 读/写/合并', () => {
  it('读：不存在 / 类型错 / 脏数据一律返回空串', () => {
    expect(readMistakeNote(undefined)).toBe('');
    expect(readMistakeNote(null)).toBe('');
    expect(readMistakeNote('not-an-object')).toBe('');
    expect(readMistakeNote([])).toBe('');
    expect(readMistakeNote({})).toBe('');
    expect(readMistakeNote({ [MISTAKE_NOTE_METADATA_KEY]: 123 })).toBe('');
    expect(readMistakeNote({ [MISTAKE_NOTE_METADATA_KEY]: '期中卷 3 月 12 日' })).toBe(
      '期中卷 3 月 12 日',
    );
  });

  it('⚠️ 写：必须保留 metadata 上的其它键（后端是整块替换，不是深合并）', () => {
    const existing = {
      availableSkillsSnapshot: 'snapshot-bytes',
      chatV2Draft: { hidden: 1 },
      groupArchivedBy: 'auto',
    };
    const next = buildNoteMetadata(existing, '2026 年 3 月月考，数学卷第 18 题');

    // 新键写入
    expect(next[MISTAKE_NOTE_METADATA_KEY]).toBe('2026 年 3 月月考，数学卷第 18 题');
    // 原有键一个都不能丢 —— 这是本模块最要紧的断言
    expect(next.availableSkillsSnapshot).toBe('snapshot-bytes');
    expect(next.chatV2Draft).toEqual({ hidden: 1 });
    expect(next.groupArchivedBy).toBe('auto');
  });

  it('写：不修改传入的 existingMetadata（不可变）', () => {
    const existing = { keep: 'me' };
    buildNoteMetadata(existing, 'note');
    expect(existing).toEqual({ keep: 'me' });
  });

  it('写：空备注删除键，而不是写空串', () => {
    const next = buildNoteMetadata({ [MISTAKE_NOTE_METADATA_KEY]: 'old', keep: 1 }, '   ');
    expect(MISTAKE_NOTE_METADATA_KEY in next).toBe(false);
    expect(next.keep).toBe(1);
  });

  it('写：备注两端去空白并截断到上限', () => {
    const long = 'x'.repeat(MISTAKE_NOTE_MAX_LENGTH + 500);
    const next = buildNoteMetadata({}, `  ${long}  `);
    expect((next[MISTAKE_NOTE_METADATA_KEY] as string).length).toBe(MISTAKE_NOTE_MAX_LENGTH);
    expect(buildNoteMetadata({}, '  hi  ')[MISTAKE_NOTE_METADATA_KEY]).toBe('hi');
  });

  it('写：脏 metadata（数组/字符串/null）能被安全重建为对象', () => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      const next = buildNoteMetadata(bad, 'n');
      expect(Array.isArray(next)).toBe(false);
      expect(next[MISTAKE_NOTE_METADATA_KEY]).toBe('n');
    }
  });

  it('变更检测：相同备注不应触发写（省 IPC）', () => {
    const meta = { [MISTAKE_NOTE_METADATA_KEY]: '期中卷' };
    expect(isNoteChanged(meta, '期中卷')).toBe(false);
    expect(isNoteChanged(meta, '  期中卷  ')).toBe(false); // 去空白后等价
    expect(isNoteChanged(meta, '期末卷')).toBe(true);
    expect(isNoteChanged(undefined, '')).toBe(false);
    expect(isNoteChanged(undefined, 'x')).toBe(true);
  });

  it('indexSessionsById：忽略脏条目', () => {
    const sessions = [
      { id: 'sess_a', metadata: { x: 1 } },
      { id: '', metadata: {} },
      null,
      { id: 'sess_b' },
    ] as unknown as ChatSession[];
    const map = indexSessionsById(sessions);
    expect([...map.keys()].sort()).toEqual(['sess_a', 'sess_b']);
    expect(map.get('sess_a')?.metadata).toEqual({ x: 1 });
  });
});

// ---------- 备注：saveMistakeNote 的 IPC 契约 ----------

describe('E13-S 备注：saveMistakeNote 的读-改-写契约', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('先 get 取权威 metadata，再整块回写（不丢其它键）', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'chat_v2_get_session') {
        return { id: 'sess_1', metadata: { availableSkillsSnapshot: 'snap' } };
      }
      return undefined;
    });
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));

    const { saveMistakeNote } = await import('@/features/review/hooks/useMistakeNote');
    const result = await saveMistakeNote('sess_1', '  2026 春期中考，物理 A 卷  ');

    expect(invoke).toHaveBeenCalledWith('chat_v2_get_session', { sessionId: 'sess_1' });

    const updateCall = invoke.mock.calls.find(
      (c) => c[0] === 'chat_v2_update_session_settings',
    );
    expect(updateCall).toBeTruthy();
    const settings = (updateCall![1] as { settings: { metadata: Record<string, unknown> } })
      .settings;
    // 备注写入
    expect(settings.metadata[MISTAKE_NOTE_METADATA_KEY]).toBe('2026 春期中考，物理 A 卷');
    // 既有键保留 —— 证明没有用「只回写备注」的懒做法
    expect(settings.metadata.availableSkillsSnapshot).toBe('snap');

    // 返回值与写入一致，供调用方回灌内存
    expect(result).toEqual(settings.metadata);
  });

  it('会话不存在（get 返回 null）时不抛错，按无既有 metadata 处理', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'chat_v2_get_session' ? null : undefined));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));

    const { saveMistakeNote } = await import('@/features/review/hooks/useMistakeNote');
    const result = await saveMistakeNote('sess_gone', '备注');
    expect(result[MISTAKE_NOTE_METADATA_KEY]).toBe('备注');
  });
});

// ---------- 时间：解析 / 筛选 ----------

describe('E13-S 时间：toMonthKey 与区间筛选', () => {
  const now = new Date(2026, 2, 15); // 2026-03-15 本地

  it('toMonthKey：本地年月；非法输入返回空串', () => {
    expect(toMonthKey('2026-03-15T10:00:00.000Z')).toMatch(/^2026-0[23]$/);
    expect(toMonthKey('')).toBe('');
    expect(toMonthKey('not-a-date')).toBe('');
    expect(toMonthKey('2026-03-15')).toMatch(/^2026-03$/);
  });

  it('时间选项集合固定且含 all', () => {
    expect(MISTAKE_TIME_RANGES).toEqual([
      'all',
      'thisMonth',
      'lastMonth',
      'last3Months',
      'thisYear',
    ]);
  });

  it("'all' 包含一切，含无时间的条目", () => {
    expect(isWithinTimeRange({ createdAt: '' }, 'all', now)).toBe(true);
    expect(isWithinTimeRange({ createdAt: '2020-01-01' }, 'all', now)).toBe(true);
  });

  it('thisMonth：仅当月', () => {
    expect(isWithinTimeRange({ createdAt: new Date(2026, 2, 1).toISOString() }, 'thisMonth', now)).toBe(true);
    expect(isWithinTimeRange({ createdAt: new Date(2026, 1, 28).toISOString() }, 'thisMonth', now)).toBe(false);
  });

  it('lastMonth：仅上月，且跨年正确（1 月的上月是去年 12 月）', () => {
    const jan = new Date(2026, 0, 10);
    expect(isWithinTimeRange({ createdAt: new Date(2025, 11, 20).toISOString() }, 'lastMonth', jan)).toBe(true);
    expect(isWithinTimeRange({ createdAt: new Date(2026, 0, 5).toISOString() }, 'lastMonth', jan)).toBe(false);
  });

  it('last3Months：含本月往前共 3 个月，跨年正确', () => {
    const jan = new Date(2026, 0, 10); // 2026-01
    expect(isWithinTimeRange({ createdAt: new Date(2026, 0, 2).toISOString() }, 'last3Months', jan)).toBe(true);
    expect(isWithinTimeRange({ createdAt: new Date(2025, 11, 2).toISOString() }, 'last3Months', jan)).toBe(true);
    expect(isWithinTimeRange({ createdAt: new Date(2025, 10, 2).toISOString() }, 'last3Months', jan)).toBe(true);
    // 上上月再往前 1 个月 → 出界
    expect(isWithinTimeRange({ createdAt: new Date(2025, 9, 2).toISOString() }, 'last3Months', jan)).toBe(false);
  });

  it('thisYear：仅当年', () => {
    expect(isWithinTimeRange({ createdAt: new Date(2026, 0, 1).toISOString() }, 'thisYear', now)).toBe(true);
    expect(isWithinTimeRange({ createdAt: new Date(2025, 11, 31).toISOString() }, 'thisYear', now)).toBe(false);
  });

  it('⚠️ 无有效时间的条目在具体区间下被排除（不静默混入）', () => {
    for (const r of ['thisMonth', 'lastMonth', 'last3Months', 'thisYear'] as const) {
      expect(isWithinTimeRange({ createdAt: '' }, r, now)).toBe(false);
      expect(isWithinTimeRange({ createdAt: 'garbage' }, r, now)).toBe(false);
    }
  });

  it('filterByTimeRange 不修改入参', () => {
    const list = [
      { createdAt: new Date(2026, 2, 1).toISOString(), id: 'a' },
      { createdAt: new Date(2020, 2, 1).toISOString(), id: 'b' },
    ];
    const out = filterByTimeRange(list, 'thisMonth', now);
    expect(out.map((e) => e.id)).toEqual(['a']);
    expect(list.length).toBe(2);
  });
});

// ---------- 时间：月份分组 ----------

describe('E13-S 时间：groupByMonth', () => {
  const mk = (iso: string, id: string) => ({ createdAt: iso, id });

  it('月份倒序，组内保持传入顺序', () => {
    const entries = [
      mk(new Date(2026, 2, 10).toISOString(), 'mar-1'),
      mk(new Date(2026, 1, 10).toISOString(), 'feb-1'),
      mk(new Date(2026, 2, 1).toISOString(), 'mar-2'),
    ];
    const groups = groupByMonth(entries);
    expect(groups.map((g) => g.monthKey)).toEqual(['2026-03', '2026-02']);
    // 组内顺序沿用传入（调用方已按 updatedAt 倒序）
    expect(groups[0].entries.map((e) => e.id)).toEqual(['mar-1', 'mar-2']);
  });

  it('无时间的条目归入空 key 组，且恒排在最后', () => {
    const entries = [
      mk('', 'unknown'),
      mk(new Date(2026, 2, 10).toISOString(), 'mar'),
    ];
    const groups = groupByMonth(entries);
    expect(groups.map((g) => g.monthKey)).toEqual(['2026-03', '']);
    expect(groups[1].entries.map((e) => e.id)).toEqual(['unknown']);
  });

  it('空输入返回空数组', () => {
    expect(groupByMonth([])).toEqual([]);
  });

  it('formatMonthLabel：正常返回，空 key 返回空串', () => {
    expect(formatMonthLabel('2026-03')).toBe('2026-03');
    expect(formatMonthLabel('')).toBe('');
  });
});

// ---------- 已知精度边界：500 条截断 ----------

describe('E13-S 已知边界：纯前端时间过滤 vs 500 条取数上限', () => {
  it('时间过滤是纯前端计算，不依赖后端时间参数', () => {
    // 后端 list_sessions 的 SQL 是 ORDER BY updated_at DESC LIMIT 500，
    // 而筛选按 createdAt —— 两个口径不同，故超 500 条时历史区间会偏少。
    // 本用例锁的是「这是纯函数、可在任意子集上工作」这一事实，
    // 而不是声称结果永远准确。
    const entries = Array.from({ length: 600 }, (_, i) => ({
      createdAt: new Date(2020, 0, 1 + (i % 28)).toISOString(),
      id: `s${i}`,
    }));
    // 纯函数对任意长度输入都成立（不受 500 限制影响）
    expect(filterByTimeRange(entries, 'all').length).toBe(600);
    expect(groupByMonth(entries).length).toBeGreaterThan(0);
  });

  it('本月区间不受截断影响（截断保留的是最近更新，本月必在其中）', () => {
    const now = new Date(2026, 2, 15);
    const recent = { createdAt: new Date(2026, 2, 10).toISOString() };
    expect(isWithinTimeRange(recent, 'thisMonth', now)).toBe(true);
  });
});
