/**
 * useAutoClassify — 解析完成后台自动归类（E2）
 *
 * ## 触发时机
 * 「解析完成后**后台异步**打标」——不阻断用户看解析。
 *
 * 完成信号取自 `useAnalysisResultData` 的推导结果，而非自己订阅 store：
 * `phase === 'ready' && !isStreaming` 即「已有正文且正文块不再活跃」，
 * 这正是 `deriveAnalysisResultState` 里 `ready` + `isStreaming` 双证据的语义
 * （见 useAnalysisResultData.ts:208 的 `streaming && isMessageBlockActive`）。
 *
 * 不另起一套订阅的原因：完成判定已有单一真相源，重复实现必然漂移。
 *
 * ## 幂等
 * 同一 sessionId 在一次会话生命周期内只归类一次（`classifiedRef`）。
 * 之所以需要：`ready` 态会随 store 更新反复 render，若每次都触发，
 * 会给同一会话重复调 LLM（token 成本）并重复写标签。
 *
 * 注意 `classifiedRef` 存的是 Set，**不随会话切换重置**——这是刻意的：
 * 用户从错题本点回一个已归类过的旧会话时，不该再打一次标。
 * 代价是内存里留下 sessionId 字符串（每条约 40 字节，可忽略）。
 */

import { useEffect, useRef, useState } from 'react';

import { classifySession } from '../classify/autoClassify';

export interface UseAutoClassifyParams {
  sessionId: string | null | undefined;
  /** 是否已进入「有正文且不再流式」的完成态 */
  isComplete: boolean;
  question: string | null | undefined;
  answer: string | null | undefined;
  /**
   * 用户当前已有的标签（归类时的**首选池**）。
   *
   * E5：归类改为三层优先级（用户已有标签 > 体系固定项 > 才允许新增），
   * 故必须把用户现有标签传下去，否则模型会另造新词、标签库无限膨胀。
   */
  userTags?: readonly string[];
  /** 本会话已打过的标签（去重，避免重复 IPC） */
  existingTags?: readonly string[];
  /** 总开关；false 时完全不动作（便于测试与将来的设置项） */
  enabled?: boolean;
}

export interface UseAutoClassifyResult {
  /** 正在后台归类 */
  isClassifying: boolean;
  /** 本次归类实际写入的标签（供 UI 提示「已自动归类：xxx」） */
  appliedTags: string[];
  /** 归类失败原因（LLM 调用失败 / 解析不出标签）；成功为 null */
  error: string | null;
}

export function useAutoClassify({
  sessionId,
  isComplete,
  question,
  answer,
  userTags = [],
  existingTags = [],
  enabled = true,
}: UseAutoClassifyParams): UseAutoClassifyResult {
  const [isClassifying, setIsClassifying] = useState(false);
  const [appliedTags, setAppliedTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const classifiedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  /**
   * 用 ref 镜像 userTags / existingTags，**不进 effect 依赖**。
   *
   * 原因：这两个是数组，父组件每次渲染都可能传入新引用。若写成依赖，
   * effect 会因引用变化反复执行（虽然 classifiedRef 挡住了重复归类，
   * 但每次都会重算依赖并可能触发多余的渲染/日志）。
   * 归类是「读一次当下值」的语义，用 ref 取最新值即可。
   */
  const userTagsRef = useRef<readonly string[]>(userTags);
  userTagsRef.current = userTags;
  const existingTagsRef = useRef<readonly string[]>(existingTags);
  existingTagsRef.current = existingTags;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 会话切换时清空本会话的展示态（已归类集合不清，见文件头说明）
  useEffect(() => {
    setAppliedTags([]);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!enabled) return;
    if (!sessionId) return;
    if (!isComplete) return;

    // 幂等：同一会话只跑一次
    if (classifiedRef.current.has(sessionId)) return;

    // 题干与解析全空时没有归类依据，不调模型（避免白花 token）。
    //
    // ⚠️ 此处**不标记已处理**，因此后续正文流入（answer 从空变为有值）时
    //    本 effect 会因 answer 变化重跑，仍能触发归类——这是刻意的。
    //    反之，一旦进入下面的 try 分支就立刻标记，所以：
    //    **归类失败（LLM 报错 / 解析不出标签）不会自动重试。**
    //    这是有意的取舍：自动归类是后台增强，失败重试会反复烧 token，
    //    而用户可以在错题本里手动打标兜底。
    if (!(question ?? '').trim() && !(answer ?? '').trim()) return;

    classifiedRef.current.add(sessionId);
    setIsClassifying(true);

    let cancelled = false;

    void (async () => {
      try {
        const tags = await classifySession({
          sessionId,
          question: question ?? '',
          answer: answer ?? '',
          userTags: userTagsRef.current,
          existingTags: existingTagsRef.current,
        });
        if (cancelled || !mountedRef.current) return;
        setAppliedTags(tags);
      } catch (err) {
        // classifySession 内部已吞掉预期错误；能到这里说明是意外异常。
        // 仍不抛出——自动归类失败绝不能影响解析结果页。
        if (cancelled || !mountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && mountedRef.current) setIsClassifying(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId, isComplete, question, answer]);

  return { isClassifying, appliedTags, error };
}

export default useAutoClassify;
