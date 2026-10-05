/**
 * useMistakeNote — 错题备注（E13-S）
 *
 * ## 为什么备注放 metadata 而不是新列
 * 错题 = `mode` 属 analysis 族的 chat 会话（见 `useMistakeBook.ts` 头部）。
 * 会话表 `chat_v2_sessions` 已有 `metadata_json` 列，且
 * `chat_v2_update_session_settings` 命令**已注册**、`SessionSettings.metadata`
 * 已是 `Option<Option<Value>>` —— 即「写会话 metadata」这条路**后端早已通电**，
 * 无需新增 Rust 命令、无需改表、无需迁移。
 *
 * 因此备注走 `metadata.mistakeNote`，与会话同库同事务落盘，**重启不丢**
 * （这正是 task-12 关心的持久化根因的同一条链路，不是旁路存储）。
 *
 * ## ⚠️ merge 语义：整对象替换，不是深合并
 * 后端 `merge_session_metadata`（manage_session.rs:1162）的实现是：
 * ```rust
 * Some(Some(metadata)) => Some(metadata.clone()),  // 整块替换
 * Some(None)            => None,
 * None                  => existing_metadata,      // 不动
 * ```
 * **它不是深合并**。所以写入前必须先取「当前会话的完整 metadata」，
 * 只改 `mistakeNote` 一个键，再整体回写 —— 否则会把 `availableSkillsSnapshot`、
 * `chatV2Draft`、`groupArchivedBy` 等别的键**抹掉**。
 * 这是本模块最要紧的约束，详见 `buildNoteMetadata`。
 *
 * ## 为什么不用 SessionSettings.title 之类的既有字段
 * `title` 会被自动摘要覆盖（除非 title_locked），`description` 是自动生成的
 * 简介 —— 都不是用户自由文本的落点。备注必须是不被任何自动化改写的用户资产。
 */

import type { ChatSession } from '@/features/chat/types/session';

/** 会话 metadata 里存放错题备注的键 */
export const MISTAKE_NOTE_METADATA_KEY = 'mistakeNote';

/** 备注长度上限（后端无限制，这里防手滑粘贴整本书；与 UI maxLength 一致） */
export const MISTAKE_NOTE_MAX_LENGTH = 2000;

/**
 * 从会话 metadata 里读备注。
 *
 * 防御式：metadata 可能是 null / 非对象 / 键不存在 / 键不是字符串
 * （历史数据、别的写入方污染）。一律返回空串，让 UI 呈现「无备注」。
 */
export function readMistakeNote(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const raw = (metadata as Record<string, unknown>)[MISTAKE_NOTE_METADATA_KEY];
  return typeof raw === 'string' ? raw : '';
}

/**
 * 构造回写用的 metadata：**保留其它所有键**，只替换 `mistakeNote`。
 *
 * 空备注视为「删除该键」（而不是写空串）—— 保持 metadata 干净，
 * 也便于将来用 `json_extract(...) IS NOT NULL` 筛「有备注的错题」。
 *
 * ⚠️ 必须传入**完整**的现有 metadata。传 `{}` 或只传备注会导致
 * 后端整块替换时丢掉其它键（见文件头 merge 语义说明）。
 */
export function buildNoteMetadata(
  existingMetadata: unknown,
  note: string,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {};

  const trimmed = note.trim();
  if (trimmed) {
    base[MISTAKE_NOTE_METADATA_KEY] = trimmed.slice(0, MISTAKE_NOTE_MAX_LENGTH);
  } else {
    delete base[MISTAKE_NOTE_METADATA_KEY];
  }
  return base;
}

/** 备注是否发生变化（用于避免无谓 IPC） */
export function isNoteChanged(existingMetadata: unknown, nextNote: string): boolean {
  return readMistakeNote(existingMetadata) !== nextNote.trim().slice(0, MISTAKE_NOTE_MAX_LENGTH);
}

/** 从会话列表里按 id 建索引，供 UI 取「该会话当前的完整 metadata」 */
export function indexSessionsById(
  sessions: readonly ChatSession[],
): Map<string, ChatSession> {
  const map = new Map<string, ChatSession>();
  for (const s of sessions) {
    if (s && typeof s === 'object' && s.id) map.set(s.id, s);
  }
  return map;
}

/**
 * 保存备注到会话 metadata（持久化）。
 *
 * ## 为什么先 get 再 update（读-改-写）
 * 后端 `merge_session_metadata` 是**整对象替换**（见文件头）。若直接回写
 * `{ mistakeNote }`，会把会话上其它 metadata 键全部抹掉。因此这里先
 * `chat_v2_get_session` 取权威 metadata，再合并回写。
 *
 * ## 为什么用 get 而不是信任调用方传入的 metadata
 * UI 手里的 metadata 可能是旧的（列表拉取后别的写入方改过，例如
 * `availableSkillsSnapshot` 冻结、草稿隐藏标记）。备注写入是低频用户动作，
 * 多一次 IPC 换取「不误删他人键」是划算的。**不要在调用点省掉这次读。**
 *
 * @returns 写入后的完整 metadata（调用方可回灌内存，保持与持久化一致）
 */
export async function saveMistakeNote(
  sessionId: string,
  note: string,
): Promise<Record<string, unknown>> {
  const { invoke } = await import('@tauri-apps/api/core');

  const session = await invoke<ChatSession | null>('chat_v2_get_session', { sessionId });
  const nextMetadata = buildNoteMetadata(session?.metadata, note);

  await invoke('chat_v2_update_session_settings', {
    sessionId,
    // Option<Option<Value>>：Some(Some(v)) → 整块替换为 nextMetadata。
    // 这里传完整对象（已含原有全部键），符合上面的 merge 语义。
    settings: { metadata: nextMetadata },
  });

  return nextMetadata;
}
