import { isAnalysisFamilyMode } from './modeFamily';
/**
 * Chat V2 - 题目分析模式插件
 *
 * OCR 串行前置的题目分析模式
 * 自执行注册：import 即注册
 *
 * 流程：
 * 1. 用户上传图片
 * 2. 串行执行 OCR → 生成 ocrMeta
 * 3. OCR 完成后显示输入框
 * 4. 自动发起首轮分析
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { modeRegistry, type ModeConfig, type SystemPromptContext, type ModeInitConfig } from '../../registry';
import { OcrResultHeader } from './components/OcrResultHeader';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ChatStore } from '../../core/types';
// 🔧 P0-14 修复：导入 VFS 上传和资源 API
import { uploadAttachment, type VfsContextRefData } from '../../context';
import { resourceStoreApi, type ContextRef } from '../../resources';
import { IMAGE_TYPE_ID } from '../../context/definitions/image';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * OCR 状态
 */
export type OcrStatus = 'idle' | 'pending' | 'running' | 'success' | 'error';

/**
 * OCR 识别结果元数据
 */
export interface OcrMeta {
  /** 识别出的题目文本 */
  question: string;
  /** 识别出的答案/解析 */
  answer?: string;
  /**
   * ★ 向后兼容：科目（旧数据/旧测试可能包含）
   *
   * 文档28清理后不再作为核心字段，但保留可选以兼容历史数据与测试用例。
   */
  subject?: string;
  /** 题目类型 */
  questionType?: string;
  /** 原始 OCR 文本 */
  rawText: string;
  /** 识别出的标签 */
  tags?: string[];
}

/**
 * 分析模式状态（存储在 store.modeState）
 */
export interface AnalysisModeState {
  /** OCR 状态 */
  ocrStatus: OcrStatus;
  /** OCR 进度 0-100 */
  ocrProgress: number;
  /** OCR 结果 */
  ocrMeta: OcrMeta | null;
  /** OCR 错误信息 */
  ocrError: string | null;
  /** 原始图片（base64 或 URL） */
  images: string[];
  /** 是否已自动发送首条消息 */
  autoMessageSent: boolean;
  /** 学习笔记内容（持久化） */
  note?: string | null;
  /** 笔记保存错误 */
  noteError?: string | null;
}

/**
 * 分析模式初始化配置
 */
// ★ 文档28清理：subject 已从 Chat V2 彻底移除
export interface AnalysisInitConfig {
  /** 图片列表（base64 或文件路径） */
  images: string[];
}

// ============================================================================
// 模式配置
// ============================================================================

/**
 * 分析模式配置
 */
const ANALYSIS_MODE_CONFIG: ModeConfig = {
  requiresOcr: true,
  ocrTiming: 'before', // OCR 串行前置
  autoStartFirstMessage: true, // OCR 完成后自动发起分析
};

// ============================================================================
// 初始化状态工厂
// ============================================================================

/**
 * 创建初始分析模式状态
 */
export function createInitialAnalysisModeState(
  images: string[],
  existingNote?: string | null
): AnalysisModeState {
  return {
    ocrStatus: 'idle',
    ocrProgress: 0,
    ocrMeta: null,
    ocrError: null,
    images,
    autoMessageSent: false,
    note: existingNote ?? null,
    noteError: null,
  };
}

// ============================================================================
// OCR 执行器（TODO: 需要对接实际的 OCR API）
// ============================================================================

/**
 * OCR 进度回调
 */
type OcrProgressCallback = (progress: number) => void;

/**
 * 执行 OCR 识别
 *
 * 调用后端 chat_v2_perform_ocr 命令执行纯 OCR 识别
 * 该命令只做 OCR，不创建会话或保存图片
 */
// ★ 文档28清理：subject 已从 Chat V2 彻底移除
async function performOcr(
  images: string[],
  onProgress?: OcrProgressCallback
): Promise<OcrMeta> {
  try {
    // 通知开始
    onProgress?.(10);

    // 准备请求参数
    // 确保图片是 base64 格式（支持 data:image/... 和纯 base64）
    const normalizedImages = images.map((img) => {
      if (img.startsWith('data:')) {
        return img; // 已经是 data URL
      }
      // 假设是纯 base64，添加前缀
      return `data:image/jpeg;base64,${img}`;
    });

    onProgress?.(30);

    // 调用新的 Chat V2 OCR 命令
    const response = await invoke<{
      ocr_text: string;
      tags: string[];
      mistake_type: string;
    }>('chat_v2_perform_ocr', {
      request: {
        images: normalizedImages,
      },
    });

    onProgress?.(90);
    onProgress?.(100);

    return {
      question: response.ocr_text || '',
      answer: undefined,
      questionType: response.mistake_type || undefined,
      rawText: response.ocr_text || '',
      tags: response.tags,
    };
  } catch (error: unknown) {
    console.error('[Analysis Mode] OCR failed:', getErrorMessage(error));
    throw error;
  }
}

// ============================================================================
// 模式插件注册
// ============================================================================

/**
 * 题目分析模式插件
 *
 * 特点：
 * - OCR 串行前置：必须先完成 OCR 才能发送消息
 * - 自动首轮分析：OCR 完成后自动发起分析请求
 * - 支持 OCR 重试
 * - renderHeader 显示 OCR 结果
 */
modeRegistry.register('analysis', {
  name: 'analysis',
  extends: 'chat', // 继承 chat 的所有面板能力
  config: ANALYSIS_MODE_CONFIG,

  /**
   * 模式初始化
   *
   * @param store - ChatStore 实例
   * @param initConfig - 初始化配置（可选，包含 images 等）
   */
  onInit: async (store: ChatStore, initConfig?: ModeInitConfig) => {
    // 🔧 P0修复：优先从 initConfig 获取 images，回退到 modeState
    const existingState = store.modeState as unknown as Partial<AnalysisModeState> | null;
    const images = initConfig?.images || existingState?.images || [];
    // ★ 文档28清理：subject 已从 Chat V2 彻底移除
    // 🔧 保留已有笔记内容
    const existingNote = existingState?.note;

    // 如果没有图片，只设置初始状态（保留已有笔记）
    if (images.length === 0) {
      store.setModeState(createInitialAnalysisModeState([], existingNote) as unknown as Record<string, unknown>);
      return;
    }

    // 设置初始状态（保留已有笔记）
    store.setModeState({
      ocrStatus: 'pending',
      ocrProgress: 0,
      ocrMeta: null,
      ocrError: null,
      images,
      autoMessageSent: false,
      note: existingNote ?? null,
      noteError: null,
    } as unknown as Record<string, unknown>);

    // 执行 OCR
    try {
      // 更新为 running 状态
      store.updateModeState({ ocrStatus: 'running' });

      // 执行 OCR 并更新进度
      // ★ 文档28清理：subject 已从 Chat V2 彻底移除
      const ocrResult = await performOcr(
        images,
        (progress) => {
          store.updateModeState({ ocrProgress: progress });
        }
      );

      // OCR 成功
      store.updateModeState({
        ocrStatus: 'success',
        ocrMeta: ocrResult,
        ocrProgress: 100,
      });

      // 自动发起首轮分析
      if (ANALYSIS_MODE_CONFIG.autoStartFirstMessage) {
        await autoSendFirstMessage(store, images);
      }
    } catch (error: unknown) {
      // OCR 失败
      store.updateModeState({
        ocrStatus: 'error',
        ocrError: getErrorMessage(error),
      });
    }
  },

  /**
   * 发送消息时的回调
   * 可用于注入 OCR 结果到消息上下文
   */
  onSendMessage: (store: ChatStore, _content: string) => {
    const modeState = store.modeState as unknown as AnalysisModeState | null;

    // 如果 OCR 正在进行中，阻止发送
    if (
      modeState &&
      (modeState.ocrStatus === 'pending' || modeState.ocrStatus === 'running')
    ) {
      // ★ 测试/极端场景兜底：i18n 未初始化时不要抛空消息
      const translated = i18n.t('chatV2:mode.analysis.ocrInProgress');
      throw new Error(translated && translated.trim() ? translated : 'OCR 正在进行中');
    }
  },

  /**
   * 构建系统提示
   * 注入 OCR 识别结果到系统提示中
   *
   * ## 提示词修订说明（E5）
   * 修订前的主要问题是**用户在真机上拍整页题时，模型会把题目原样转录回来而不解题**。
   * 根因有三处（均为提示词层面，非模型能力问题）：
   *  1. 未说明「图里可能有多道题」——模型面对整页题目不知如何组织输出，
   *     退化为逐字抄写；
   *  2. 未禁止「重述题目」——「仔细阅读题目内容」这句容易被模型理解为
   *     「先把题目写出来」，于是输出成了转录；
   *  3. OCR 文本以「【识别到的题目内容】」形式注在末尾，模型易把自己
   *     当成续写 OCR 的转录器，且在 OCR 有错时**以错误文本为准**。
   *
   * 现在明确三件事：多题自适应、不要重述原文、以图片为准（OCR 仅辅助）。
   */
  buildSystemPrompt: (context: SystemPromptContext): string => {
    const modeState = context.modeState as unknown as AnalysisModeState | null;
    const ocrMeta = modeState?.ocrMeta;

    let systemPrompt = `你是一个专业的题目解答助手。用户会给你一张（或几张）题目照片，请**直接解答**。

【最重要的一条】
**不要重述、不要转录题目原文。** 直接从「答案」开始给出解答。
如果图片里有多道题，请**逐题解答并保留题号**（如「第1题」「第2题」）；
只有一道题时就直接解这一道。

解答要求：
1. 先给**明确答案**（选择题给出选项字母），再给解析
2. 写出关键步骤与所用知识点/公式
3. 一题多解时简要列出其他思路
4. 指出易错点
5. 题目若模糊不清，说明你的理解后再作答；不要靠臆测补齐`;

    // 注入 OCR 识别结果
    //
    // ⚠️ 定位：**辅助参考，不是唯一依据**。OCR 对公式、上下标、图表的还原
    //    经常出错（实测出现过 LaTeX 转义乱码）。必须明确告诉模型以图片为准，
    //    否则它会照着错误的 OCR 文本作答。
    if (ocrMeta) {
      systemPrompt += `\n\n【OCR 辅助文本（仅供参考，可能有识别错误）】`
        + `\n以下文字由 OCR 从图片中提取，**可能存在公式或符号错误**。`
        + `请以图片内容为准；若文字与图片不符，以图片为准。\n`
        + ocrMeta.question;
      if (ocrMeta.answer) {
        systemPrompt += `\n\n【参考答案（可能不完整）】\n${ocrMeta.answer}`;
      }
      if (ocrMeta.subject) {
        systemPrompt += `\n【科目】${ocrMeta.subject}`;
      }
      if (ocrMeta.questionType) {
        systemPrompt += `\n【题型】${ocrMeta.questionType}`;
      }
    }

    return systemPrompt;
  },

  /**
   * 获取启用的工具列表。
   *
   * ## 为什么必须包含 'memory'（E5 修复）
   * 用户反馈「记忆没有自动提取」。排查发现：`TauriAdapter.ts:5366` 用
   * `modeEnabledTools.includes('memory')` 决定是否把 `memory_enabled` 传给后端，
   * 而后端 `trigger_auto_memory_extraction` 在 `memory_enabled == Some(false)`
   * 时**直接跳过**（`persistence.rs:1477`）。
   *
   * 本模式此前只返回 `['rag']`，于是拍题链路上的记忆开关恒为 false，
   * 自动提取永远不触发。而拍题恰恰是最该沉淀记忆的场景——它直接暴露
   * 用户的知识薄弱点。
   */
  getEnabledTools: (_store: ChatStore): string[] => {
    return ['rag', 'memory'];
  },

  /**
   * 自定义 Header 组件
   * 显示 OCR 结果
   */
  renderHeader: OcrResultHeader,
});

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 自动发送首条分析消息
 *
 * 🔧 P0-14 修复：将图片上传到 VFS 并创建 ContextRef
 * 原问题：后端已移除 attachments 字段，图片无法传递给模型
 * 解决方案：使用 VFS 引用模式，先上传图片再发送消息
 */
async function autoSendFirstMessage(
  store: ChatStore,
  images: string[]
): Promise<void> {
  const modeState = store.modeState as unknown as AnalysisModeState | null;

  // 防止重复发送
  if (modeState?.autoMessageSent) {
    return;
  }

  // 标记已发送
  store.updateModeState({ autoMessageSent: true });

  // 🔧 P0-14 修复：上传图片到 VFS 并创建 ContextRef
  try {
    for (let index = 0; index < images.length; index++) {
      const image = images[index];

      // 从 data URL 中提取 MIME 类型和 base64 内容
      let mimeType = 'image/png';
      let base64Content = image;

      if (image.startsWith('data:')) {
        const match = image.match(/^data:([^;,]+)[;,]/);
        if (match) {
          mimeType = match[1];
        }
        // 提取 base64 内容
        const base64Match = image.match(/base64,(.+)$/);
        if (base64Match) {
          base64Content = base64Match[1];
        }
      }

      const fileName = `OCR 图片 ${index + 1}`;

      // 1. 上传到 VFS attachments 表
      const uploadResult = await uploadAttachment({
        name: fileName,
        mimeType,
        base64Content,
        type: 'image',
      });

      console.log('[Analysis Mode] Uploaded image to VFS:', uploadResult.sourceId);

      // 2. 构造 VfsContextRefData
      const refData: VfsContextRefData = {
        refs: [
          {
            sourceId: uploadResult.sourceId,
            resourceHash: uploadResult.resourceHash,
            type: 'image',
            name: fileName,
          },
        ],
        totalCount: 1,
        truncated: false,
      };

      // 3. 存储到 resources 表
      const resourceResult = await resourceStoreApi.createOrReuse({
        type: 'image' as import('../../resources').ResourceType,
        data: JSON.stringify(refData),
        sourceId: uploadResult.sourceId,
        metadata: {
          name: fileName,
          mimeType,
          size: uploadResult.attachment.size,
          vfsRefMode: true,
        },
      });

      console.log('[Analysis Mode] Created resource:', resourceResult.resourceId);

      // 4. 构建 ContextRef 并添加到 store
      const contextRef: ContextRef = {
        resourceId: resourceResult.resourceId,
        hash: resourceResult.hash,
        typeId: IMAGE_TYPE_ID,
      };

      store.addContextRef(contextRef);
      console.log('[Analysis Mode] Added context ref:', resourceResult.resourceId);
    }

    // 发送解答请求。
    //
    // ⚠️ 措辞很关键（E5）：原为「请分析这道题目」——「分析」一词容易被模型
    //    理解为「解析图片内容」而非「解答题目」，实测在整页多题时退化为转录。
    //    改为明确的「解答」并提示可能多题，与 buildSystemPrompt 的约束呼应。
    await store.sendMessage('请解答图片中的题目（可能有多道，请逐题作答，不要重述题目原文）');
  } catch (error: unknown) {
    // 如果发送失败，重置标记以允许重试
    store.updateModeState({ autoMessageSent: false });
    console.error('[Analysis Mode] Auto send failed:', error);
  }
}

// ============================================================================
// 辅助 Hook：检查是否可以发送消息
// ============================================================================

/**
 * 检查 analysis 模式是否允许发送消息
 *
 * @param store - ChatStore 实例
 * @returns 是否允许发送
 */
export function canSendInAnalysisMode(store: ChatStore): boolean {
  if (!isAnalysisFamilyMode(store.mode)) {
    return true;
  }

  const modeState = store.modeState as unknown as AnalysisModeState | null;
  if (!modeState) {
    return true;
  }

  // OCR 进行中时不允许发送
  if (modeState.ocrStatus === 'pending' || modeState.ocrStatus === 'running') {
    return false;
  }

  // 其他情况允许发送
  return true;
}

/**
 * 获取 analysis 模式的 OCR 状态
 *
 * @param store - ChatStore 实例
 * @returns OCR 状态或 null
 */
export function getAnalysisOcrStatus(store: ChatStore): OcrStatus | null {
  if (!isAnalysisFamilyMode(store.mode)) {
    return null;
  }

  const modeState = store.modeState as unknown as AnalysisModeState | null;
  return modeState?.ocrStatus || null;
}

/**
 * 手动触发 OCR 重试
 *
 * @param store - ChatStore 实例
 * @param images - 可选的新图片列表
 */
export async function retryOcr(
  store: ChatStore,
  images?: string[]
): Promise<void> {
  if (!isAnalysisFamilyMode(store.mode)) {
    throw new Error(i18n.t('chatV2:mode.analysis.retryOnlyInAnalysis'));
  }

  const modeState = store.modeState as unknown as AnalysisModeState | null;

  // 🔧 P2修复：检查 OCR 是否正在进行，防止并发请求
  if (modeState?.ocrStatus === 'pending' || modeState?.ocrStatus === 'running') {
    console.warn('[Analysis Mode] OCR already in progress, ignoring retry request');
    return;
  }

  const targetImages = images || modeState?.images || [];

  if (targetImages.length === 0) {
    throw new Error(i18n.t('chatV2:mode.analysis.noImagesToOcr'));
  }

  // 重置状态并重新执行 OCR
  store.updateModeState({
    ocrStatus: 'pending',
    ocrProgress: 0,
    ocrError: null,
    autoMessageSent: false,
    images: targetImages,
  });

  // 重新触发初始化（会执行 OCR）
  const modePlugin = modeRegistry.getResolved('analysis');
  if (modePlugin?.onInit) {
    await modePlugin.onInit(store);
  }
}

// ============================================================================
// 导出
// ============================================================================

export const ANALYSIS_MODE = 'analysis';
