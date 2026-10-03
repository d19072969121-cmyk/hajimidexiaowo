/**
 * CapturePage — 拍题页（E4）
 *
 * ## 定位
 * `study` Tab 的落地页，也是「拍题 → 解析 → 错题 → 复习」整条链的**起点**。
 *
 * ## 为什么需要它（真实缺口）
 * 此前拍题的**唯一**入口是命令面板快捷键 `mod+shift+A`
 * （`command-palette/modules/chat.commands.ts:59`），手机上根本按不出来；
 * 且该命令内部走的是 `dialogOpen()` 文件对话框（`useSessionLifecycle.ts:163`），
 * 在手机上只能「从相册选」，**无法直接拍照**。
 *
 * ## 相机能力从哪来（复用上游，不自己造）
 * 项目已有经过深思的相机能力判定与实现，直接复用：
 * - 判定：`inputBarCapabilities.canCapturePhoto()`（`inputBarCapabilities.ts:42`）
 *   —— Android/iOS 直接为真；其他移动壳要求 `capture` 特性 + 移动 UA 同时成立。
 *   注释里说明了为何**不用** `enumerateDevices()`（会触发权限弹窗）
 *   也**不用** `pointer: coarse`（触摸 ≠ 有后置摄像头）。
 * - 实现：隐藏的 `<input type="file" accept="image/*" capture="environment">`
 *   （上游同款见 `InputBarUI.tsx:2695`）。`capture="environment"` 让手机 WebView
 *   直接唤起后置摄像头——**纯 Web 标准，无需任何原生插件**。
 *
 * ## 两条采集路径
 * - **拍照**：走上面的 capture input，手机唤起相机。
 * - **相册**：同一个 input 去掉 capture 属性即可（桌面端则退化为文件选择器）。
 * 二者共用同一条「读图 → 建 analysis 会话」流程。
 */

import React, { useCallback, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Loader2, Sparkles } from 'lucide-react';

import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

import {
  canCapturePhoto as detectCanCapturePhoto,
} from '@/features/chat/components/input-bar/inputBarCapabilities';

export interface CapturePageProps {
  /**
   * 提交选中的图片（File 列表）去发起解析。
   * 由宿主负责：读图 → 建 analysis 会话 → 跳解析结果页。
   */
  onSubmitImages?: (files: File[]) => void | Promise<void>;
  /** 是否正在处理（宿主侧建会话中） */
  isSubmitting?: boolean;
  /** 处理失败的原因（宿主侧传入） */
  error?: string | null;
  /** 进入普通对话（不是拍题） */
  onOpenChat?: () => void;
  className?: string;
}

/** 单次拍题允许的图片数上限（与 attachments 上限保持一致量级） */
export const CAPTURE_MAX_IMAGES = 6;

export const CapturePage: React.FC<CapturePageProps> = ({
  onSubmitImages,
  isSubmitting = false,
  error = null,
  onOpenChat,
  className,
}) => {
  const { t } = useTranslation();

  // 相机能力判定只做一次（上游同款做法，见 InputBarUI.tsx:872）
  const canCapturePhoto = React.useMemo(() => detectCanCapturePhoto(), []);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File[]>([]);

  const headerTitle = t('capture.title', '拍题');

  useMobileHeader(
    'capture',
    { title: headerTitle },
    [headerTitle],
  );

  const handlePick = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    // 追加去重（同一张重复选不重复加）
    setSelected((prev) => {
      const merged = [...prev];
      for (const img of images) {
        const dup = merged.some(
          (m) => m.name === img.name && m.size === img.size && m.lastModified === img.lastModified,
        );
        if (!dup && merged.length < CAPTURE_MAX_IMAGES) merged.push(img);
      }
      return merged;
    });
  }, []);

  /**
   * 唤起相机。每次先把 input 的 value 清空——否则「拍同一张→重选同一文件」
   * 不会触发 change 事件（浏览器对相同 value 不派发），用户会以为按钮失灵。
   * （上游 CameraClick 同款处理，见 InputBarUI.tsx:874-879）
   */
  const openCamera = useCallback(() => {
    if (cameraInputRef.current) {
      cameraInputRef.current.value = '';
      cameraInputRef.current.click();
    }
  }, []);

  const openGallery = useCallback(() => {
    if (galleryInputRef.current) {
      galleryInputRef.current.value = '';
      galleryInputRef.current.click();
    }
  }, []);

  const removeAt = useCallback((idx: number) => {
    setSelected((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSubmit = useCallback(() => {
    if (selected.length === 0 || isSubmitting) return;
    void onSubmitImages?.(selected);
  }, [selected, isSubmitting, onSubmitImages]);

  return (
    <div
      data-testid="capture-page"
      data-can-capture={String(canCapturePhoto)}
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="flex-1 truncate text-base font-medium text-foreground">{headerTitle}</h1>
        {onOpenChat && (
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="capture-open-chat"
            onClick={onOpenChat}
          >
            {t('capture.openChat', '直接对话')}
          </DsButton>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {/* 主操作：拍照 / 相册 */}
        <div className="grid gap-3">
          {canCapturePhoto && (
            <button
              type="button"
              data-testid="capture-take-photo"
              onClick={openCamera}
              disabled={isSubmitting}
              className={cn(
                'flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-2xl',
                'border-2 border-dashed border-primary/40 bg-primary/5 transition-colors',
                isSubmitting ? 'opacity-50' : 'hover:bg-primary/10 active:bg-primary/15',
              )}
            >
              <Camera className="size-9 text-primary" strokeWidth={1.6} aria-hidden="true" />
              <span className="text-sm font-medium text-foreground">
                {t('capture.takePhoto', '拍照搜题')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('capture.takePhotoHint', '对准题目拍摄，自动识别解析')}
              </span>
            </button>
          )}

          <button
            type="button"
            data-testid="capture-pick-gallery"
            onClick={openGallery}
            disabled={isSubmitting}
            className={cn(
              'flex items-center justify-center gap-2 rounded-xl border border-border py-3',
              'text-sm text-foreground transition-colors',
              isSubmitting ? 'opacity-50' : 'hover:bg-accent active:bg-accent',
            )}
          >
            <ImageIcon className="size-4" aria-hidden="true" />
            {t('capture.pickGallery', '从相册选择')}
          </button>
        </div>

        {/* 已选图片预览 */}
        {selected.length > 0 && (
          <section className="mt-4" data-testid="capture-selected">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t('capture.selectedCount', '已选 {{count}} 张', { count: selected.length })}
              </span>
              <button
                type="button"
                data-testid="capture-clear"
                onClick={() => setSelected([])}
                className="text-xs text-primary"
              >
                {t('capture.clear', '清空')}
              </button>
            </div>
            <ul className="grid grid-cols-3 gap-2">
              {selected.map((file, idx) => (
                <li
                  key={`${file.name}-${file.lastModified}-${idx}`}
                  data-testid={`capture-selected-item-${idx}`}
                  className="relative aspect-square overflow-hidden rounded-lg border border-border"
                >
                  {/* 用 object URL 预览；不引额外图片库 */}
                  <SelectedThumb file={file} />
                  <button
                    type="button"
                    aria-label={t('capture.remove', '移除')}
                    data-testid={`capture-remove-${idx}`}
                    onClick={() => removeAt(idx)}
                    className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-xs text-white"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>

            <DsButton
              className="mt-3 w-full"
              data-testid="capture-submit"
              disabled={isSubmitting}
              onClick={handleSubmit}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="mr-1.5 animate-spin" aria-hidden="true" />
                  {t('capture.submitting', '识别中…')}
                </>
              ) : (
                <>
                  <Sparkles size={16} className="mr-1.5" aria-hidden="true" />
                  {t('capture.submit', '开始解析')}
                </>
              )}
            </DsButton>
          </section>
        )}

        {error && (
          <div
            data-testid="capture-error"
            className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {selected.length === 0 && !error && (
          <p
            data-testid="capture-hint"
            className="mt-6 text-center text-xs text-muted-foreground"
          >
            {t('capture.emptyHint', '拍下或选择题目照片，AI 会识别并给出解析')}
          </p>
        )}
      </div>

      {/*
        隐藏的采集 input —— 相机能力的真正实现。
        相机：capture="environment" 让移动 WebView 直接唤起后置摄像头。
        相册：去掉 capture 即普通文件选择（桌面端自然退化为选文件）。
        两者都放在组件顶层，确保任何情况下都可用（上游同款，见 InputBarUI.tsx:2693-2695）。
      */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => handlePick(e.target.files)}
        className="hidden"
        data-testid="capture-camera-input"
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => handlePick(e.target.files)}
        className="hidden"
        data-testid="capture-gallery-input"
      />
    </div>
  );
};

/**
 * 用 object URL 做缩略图，并在卸载时释放，避免内存泄漏。
 *
 * ⚠️ 对 `URL.createObjectURL` 缺失做降级：该 API 在现代浏览器与 Android/iOS
 *    WebView 均可用，但 jsdom（测试环境）与个别受限 WebView 不实现。
 *    若直接调用会抛 TypeError 并把整个拍题页打崩——缩略图只是锦上添花，
 *    没有它也必须能拍题。故缺失时退化为占位块。
 */
const SelectedThumb: React.FC<{ file: File }> = ({ file }) => {
  const url = React.useMemo(() => {
    if (typeof URL?.createObjectURL !== 'function') return null;
    try {
      return URL.createObjectURL(file);
    } catch {
      return null;
    }
  }, [file]);

  React.useEffect(() => {
    if (!url) return;
    return () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // 释放失败不影响功能
      }
    };
  }, [url]);

  if (!url) {
    // 无预览能力时的占位：仍让用户知道「这张已选上」
    return (
      <div
        data-testid="capture-thumb-placeholder"
        className="flex size-full items-center justify-center bg-muted text-xs text-muted-foreground"
      >
        {file.name.slice(0, 8)}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      className="size-full object-cover"
      loading="lazy"
    />
  );
};

export default CapturePage;
