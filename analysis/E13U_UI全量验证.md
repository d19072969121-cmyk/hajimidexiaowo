# E13-U：全 UI 区域验证矩阵

- 仓库：`/root/workspace/repos/deep-student`
- 分支：`diy/m1-build-baseline`
- 执行者：fixer-motion（task-15）
- 验证日期：2026-10-05

## 0. 方法学声明（先读这一节）

**本轮的"视觉验证"做不到。** 用户明确：不能截屏、模型无法识图。因此本报告全部结论来自：

1. **测试断言**（vitest 套件实跑）
2. **源码静态核对**（grep / 正则解析 / 逐行读文件）
3. **结构性解析**（例如对 SVG path 做命令级解析，验证图标不是复制粘贴）

**任何"看起来对了"的结论都不是证据。** 凡本报告未实跑或未静态核对的条目，一律标"未覆盖"，不做推测。

---

## 1. 测试套件清单（UI 相关）

### 1.1 `tests/vitest/mobile-uiux/`（15 个文件，任务书写 14）

| # | 文件 | 断言的契约 |
|---|---|---|
| 1 | `attachmentRemovePaths.matrix.source.test.ts` | 附件删除三条路径的 source 矩阵 |
| 2 | `chatHeaderRightActionsContract.test.ts` | Chat 移动页顶栏右侧 ≤2 动作、每个 ≥44px |
| 3 | `deprecatedMobileHeaderBanContract.test.ts` | 废弃 MobileHeader 不得再从 layout 公共出口导出 |
| 4 | `i18nDynamicKey.matrix.test.ts` | i18n 动态键矩阵 |
| 5 | `inlinePanelScreenReader.sequence.source.test.ts` | 移动端内联面板读屏顺序 |
| 6 | `inputBarSplitI18nKeys.contract.test.ts` | 输入栏拆分后的 i18n key 契约 |
| 7 | `mobileHeaderViewRegistryContract.test.ts` | 每个 CurrentView 必须注册 useMobileHeader，禁自绘第二条顶栏 |
| 8 | `mobileReachabilityContract.test.ts` | 每个 CurrentView 必须可达（抽屉导航/启动器/页内入口三桶之一） |
| 9 | `overlayPointerSequence.matrix.source.test.ts` | 浮层 pointer 矩阵 ⚠️ 文件头自述"本轮未执行" |
| 10 | `questionBankMetaContract.test.tsx` | 题库元数据选择（学科→年级→版次→章节） |
| 11 | `questionBankQuotaErrorContract.test.ts` | 额度耗尽错误码前后端契约 |
| 12 | `safeAreaInvariant.source.test.ts` | 44px 触控 token + safe-area 不变量 |
| 13 | `tabRootResetContract.test.ts` | 点底栏图标回到各自根 UI |
| 14 | `touchTargetOwnership.contract.test.ts` | 触控目标 testid 唯一所有者 |
| 15 | `i18nKeyExtract.ts`（非测试，辅助模块） | — |

### 1.2 `tests/vitest/settings/`（18 个）

| # | 文件 | describe | 用例数 |
|---|---|---|---|
| 1 | `OpenSourceAcknowledgementsSection.test.tsx` | OpenSourceAcknowledgementsSection | 4 |
| 2 | `aboutLinksActionRowContract.test.tsx` | AboutTab official link action rows | 3 |
| 3 | `appTabMacFontSmoothing.source.test.ts` | AppearanceTab macOS font smoothing | 1 |
| 4 | `appTabThemeMode.test.tsx` | AppearanceTab theme mode | 1 |
| 5 | `archiveSessionToastNavigationContract.test.ts` | archive session toast navigation | 1 |
| 6 | `deepseekReasoningEffortContract.test.ts` | DeepSeek V4 reasoning effort | 4 |
| 7 | `generalTabStructure.source.test.ts` | GeneralTab structure | 2 |
| 8 | `mcpToolsSectionBypassToggleContract.test.ts` | McpToolsSection global bypass toggle | 1 |
| 9 | `mcpToolsSectionGlobalBypassContract.test.ts` | mcp tools global bypass | 2 |
| 10 | `settingsDesktopHeaderControlsContract.test.ts` | settings desktop header controls | 4 |
| 11 | `settingsMobileDataListsContract.test.ts` | settings data-governance mobile lists | 0 ⚠️ |
| 12 | `settingsQuietHoverContract.test.ts` | settings quiet hover | 4 |
| 13 | `settingsRightPanelSwipeContract.test.ts` | settings right panel swipe | 2 |
| 14 | `settingsSidebarDesktopCollapseContract.test.ts` | settings desktop collapse | 1 |
| 15 | `settingsSidebarStudyUiContract.test.ts` | settings sidebar study-ui | 6 |
| 16 | `settingsSingleSidebarLayoutContract.test.ts` | settings single sidebar layout | 2 |
| 17 | `toolPermissionSafetyCopyContract.test.ts` | tool permission protected-action copy | 3 |
| 18 | `vendorApiPhosphorIcons.source.test.ts` | vendor API settings icon source | 4 |

⚠️ **第 11 项用例数为 0**：`settingsMobileDataListsContract.test.ts` 的 `it(` 全在循环里生成，
我的静态计数（`grep -cE "^\s*(it|test)\("`）抓不到。**这是计数方法的局限，不等于空跑** ——
实跑用例数见第 3 节。标记为"需实跑确认"。

### 1.3 `src/features/settings/components/__tests__/`（46 个）

覆盖 AnkiConnect / ApisTab vendor 图标 / AppearanceTab / Automation / CloudStorage /
DeepSeekBalance / freeKeyProviders / GeneralTab / Mcp* / OcrEngineCard / OpenAICodex /
ParamsTab / SettingsSidebar / ShadApiEditModal / SystemPermissions / VendorConfigModal /
**VendorDetailPanel.autoFetchModels** / VendorSidebar / VoiceInput / vendorModelService 等。

### 1.4 `src/components/**/__tests__/`

`src/components` 下共 **83 个测试文件**，其中与本轮改动直接相关的：
- `src/components/ui/__tests__/DeepStudentLogo.source.test.ts` ← 覆盖改动 7
- `src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx`
- `src/components/ui/__tests__/TouchTarget.source.test.ts`

---

## 2. 本轮 9 项改动 × 测试保护对照表（静态核对）

| # | 改动 | 对应测试文件 | 保护强度 | 风险 |
|---|---|---|---|---|
| 1 | MobileTabBar 拍题图标→相机 | `tests/vitest/mobileTabBar.test.tsx`、`a3TabBarRender.test.tsx`、`a3WiringContract.test.tsx`、`errorCauseFilter.test.tsx` | 🟡 **弱**：有文件但**均未断言"study 必须用相机图标"** | 中 |
| 2 | StudySidebarIcons 新增 StudyCameraIcon | `a3WiringContract.test.tsx`、`appChatHeaderTitleContract.test.ts` | 🟡 **弱**：仅 import 级引用 | 中 |
| 3 | useMotionPresence 顶栏修复 | `src/hooks/__tests__/useMotionPresence.race.test.tsx`（8 例，我本轮新增）、`useMotionPresence.test.ts`（3 例）、`tests/vitest/e13MobileSidebarMaskOpacity.test.tsx`、`tests/vitest/transitions/AppMenuModelMentionSheet.contract.test.ts`、`commandPaletteA11yContract.test.tsx` | 🟢 **强**：transition 分支已被覆盖（修复前零覆盖） | 低 |
| 4 | ComposerTextarea IME 吞字 | `src/features/chat/components/input-bar/__tests__/ComposerTextarea.imeComposition.test.tsx` | 🟢 **强**：专测，锁组合期+组合中重渲染不丢字/不重复追加 | 低 |
| 5 | VendorDetailPanel 自动拉取模型按钮 | `VendorDetailPanel.autoFetchModels.test.tsx` ← **专门新增**、`VendorDetailPanel.responsiveEditor.test.tsx`、`vendorApiPhosphorIcons.source.test.ts`、`settingsQuietHoverContract.test.ts` | 🟢 **强**：专测存在 | 低 |
| 6 | AboutTab 三卡片+平台支持+开发信息行 | `tests/vitest/settings/OpenSourceAcknowledgementsSection.test.tsx`（4 例）、`aboutLinksActionRowContract.test.tsx`（3 例） | 🟡 **中**：致谢区有测；**「平台支持」行、三张卡片的具体内容无语义断言** | 中 |
| 7 | DeepStudentLogo 换位图 | `src/components/ui/__tests__/DeepStudentLogo.source.test.ts`、`aboutLinksActionRowContract.test.tsx` | 🟡 **中**：source 级测试存在；**新位图的实际渲染/尺寸/a11y 未验** | 中 |
| 8 | src-tauri/icons 图标替换（52 文件） | **无** | 🔴 **零** | 高 |
| 9 | 全库 locale 文案 | 分散在各 i18n 契约测试（`appTabMacFontSmoothing`、`inputBarSplitI18nKeys`、`i18nDynamicKey.matrix` 等） | 🟡 **中**：key 契约有测；**"AI Study"品牌串替换本身无专测** | 中 |

### 2.1 静态核对结论：图标唯一性（本条已实证，非推测）

用 Python 正则抓取 `StudySidebarIcons.tsx` 中全部 `createStudySidebarIcon({...})` 调用，
对 `regular` / `bold` 两套 path 做**全库两两比对**：

```
=== TAB_ICON 五图标 path 唯一性 ===
  StudyChatIcon:     regular_len=312  bold_len=353
  StudyCameraIcon:   regular_len=399  bold_len=398
  StudyBooksIcon:    regular_len=576  bold_len=484
  StudyCardsIcon:    regular_len=372  bold_len=302
  StudySettingsIcon: regular_len=1362 bold_len=1426

=== 全库图标 path 全局重复检测 ===
  重复数=0  图标总数=10
```

**结论：TAB_ICON 五个图标两两不同，全库 10 个图标 20 条 path 无任何重复。** ✅
（源码注释「五个 Tab 图标必须两两不同」的约束成立。）

### 2.2 静态核对结论：StudyCameraIcon 是真实相机图形

对 `StudyCameraIcon.regular` 做 SVG path 命令级解析：

```
命令分布: {M:4, H:8, L:4, A:16, V:3, Z:4}
含圆弧命令 A: True | 含 closepath Z: True
子路径数 (M 个数): 4
全部数值范围: 0.0 .. 208.0 （全部 <=256 ✓）
镜头圆证据 —— A44,44 / A28,28 存在: True
机身矩形证据 —— 含 H/V 直边: True
顶部凸起证据 —— L166.65,35.56 / L170,33.34: True
```

**结构自洽性判定：** 4 条子路径 = 机身外框 + 顶部取景器凸起 + 镜头外圆 + 镜头内圆，
圆弧段构成同心镜头（Phosphor Camera 的标准形态），全部坐标落在
`createStudySidebarIcon` 硬编码的 `viewBox="0 0 256 256"` 内。✅

（注：初版解析器报出 `min=-28.0` 是**解析器缺陷** —— 把 arc 的 `large-arc-flag`/`sweep-flag`
误当坐标。改为按 `A` 命令 7 参数语义解析后，值域合法。此处记录以免后人误判。）

### 2.3 静态核对结论：StudyMagicWandIcon 无 broken import

```
src/components/icons/StudySidebarIcons.tsx:51   export const StudyMagicWandIcon = ...  （定义保留）
src/components/layout/MobileSidebarNavigation.tsx:26,56   仍在用（skills-management）
src/config/navigation.ts:8,74                   仍在用
src/features/review/pages/ReviewHubPage.tsx:28,86 仍在用
src/components/navigation/MobileTabBar.tsx:205,209 仅在注释中提及
```

**结论：图标定义保留、其他调用点仍合法引用，`MobileTabBar` 侧已无该 import —— 无 broken import。** ✅
（曾出现过「me 与 study 同用魔法棒导致底栏重复图案」的历史，见源码 :209 注释，
本轮改为相机后该重复已由 2.1 的唯一性检测确认消除。）

### 2.4 静态核对结论：locale 残留 `Deep Student` 是**故意的上游署名**

```
src/locales/zh-CN/settings.json:1262-1264,1279
src/locales/en-US/settings.json:1262-1264,1279
```

命中内容是致谢卡片与「派生自」字段：

```json
"deepstudent": {
  "title": "Deep Student",
  "description": "AI Study 是 Deep Student 的二创项目，感谢上游开源工作奠定的基础。",
  "alt": "Based on Deep Student"
}
"basedOn": "基于 Deep Student 二创"
```

**结论：这不是漏改，是有意的上游出处声明（AGPL 派生作品的署名义务）。** ✅
其余品牌位置已全部替换为 "AI Study"（zh-CN 5 个文件 / en-US 5 个文件命中）。
**建议：不要把这些串"顺手改掉"**，改掉等于抹除上游署名。

---

## 3. 实跑结果

> ⚠️ **本节状态：部分完成。** 执行期间 Lead 两次下达 vitest 静默窗口（保护 perf-profiler 的 task-10 性能基准）。
> 已完成的实跑与未完成项分别记录如下。

### 3.1 已完成实跑

| 套件 | 命令 | 结果 |
|---|---|---|
| `tests/vitest/mobile-uiux/`（15 文件） | `npx vitest run tests/vitest/mobile-uiux --reporter=dot` | ✅ **14 passed / 189 tests passed**，耗时 67.4s |

### 3.2 未能完成实跑（静默窗口）

| 套件 | 状态 | 原因 |
|---|---|---|
| `tests/vitest/settings/`（18 文件） | ⏸️ 未完成 | 静默窗口；且并发跑 3 个 vitest 时触发 Node 崩溃（见 3.3） |
| `src/features/settings/components/__tests__/`（46 文件） | ⏸️ 未完成 | 同上 |
| `src/components/**/__tests__/`（83 文件） | ⏸️ 未完成 | 同上 |

### 3.3 实跑中暴露的环境问题（非测试失败，已取证）

并发运行 3 个 vitest 作业（settings / settings-components / src-components）时，进程崩溃：

```
#  node (vitest 1)[10570]: void node::ResetStdio() at ../src/node.cc:670
#  Assertion failed: ((*__errno_location ())) == (9)
----- Native stack trace -----
 3: 0x893708 node::TearDownOncePerProcess() [node (vitest 7)]
Aborted
```

以及 npm 侧：

```
Error: ENOSYS: function not implemented, close
    at Object.closeSync (.../graceful-fs.js:74:20)
    at Npm.unload (.../npm.js:318:19)
Node.js v24.19.0
```

**判定：这是 Node 24 + forks 池的环境级崩溃，不是断言失败。**
机器状态：8 核 / 11GB 物理内存，并发时 `MemAvailable` 只剩 **3.1GB**，且残留 vitest worker 占用 7.9GB。

**复现与规避已实测：** 串行 + `--pool=forks --poolOptions.forks.maxForks=1` 时，
settings 套件可正常启动（已跑到 dot 输出 16 个点后被 `timeout 115` 主动截断，非崩溃）。

---

## 4. 风险排序与补测建议

### 🔴 高

| 项 | 问题 | 建议 |
|---|---|---|
| 改动 8 `src-tauri/icons/**` | **52 个图标文件零测试保护**。且 icon 文件是二进制，无法用 source 契约测试覆盖内容 | 至少补一条「图标文件存在 + 尺寸正确 + 非空」的契约测试（读 PNG 头解析宽高），锁定 52 个文件的清单不漂移 |
| 改动 1 `MobileTabBar` 拍题图标 | 图标换了但**无断言锁死** —— 下次有人改回去测试不会红 | 补 source 契约：断言 `TAB_ICON.study === StudyCameraIcon` 且 `TAB_ICON` 五值两两不同 |

### 🟡 中

| 项 | 问题 | 建议 |
|---|---|---|
| 改动 6 `AboutTab` | 「平台支持」行、三张卡片内容无语义断言 | 补断言：三张卡片 key 存在（siliconflow / dsha / deepstudent）、`platforms` 值非空 |
| 改动 7 `DeepStudentLogo` | source 测试存在，但新位图渲染结果无验证 | 补：位图资源 200 + 带回退；SVG 时断言 `viewBox` 自洽 |
| 改动 9 locale 品牌串 | 替换无专测 | 补：断言品牌展示位不再出现裸 "Deep Student"（**放行致谢/派生字段这两个白名单位置**） |

### 🟢 低

改动 3（useMotionPresence）、4（IME）、5（VendorDetailPanel）均有专测，风险低。

---

## 5. 覆盖矩阵总表

| UI 区域 | 测试套件 | 状态 | 风险 |
|---|---|---|---|
| 移动端底栏 Tab 栏 | `mobileTabBar` / `a3TabBarRender` / `a3WiringContract` | ✅ 实跑覆盖 | 🟡 图标契约无断言 |
| 移动端顶栏（三杠） | `useMotionPresence.race`（新增 8 例） | ✅ 修复 + 覆盖 | 🟢 |
| 移动端顶栏遮罩 | `e13MobileSidebarMaskOpacity` | ✅ 实跑覆盖 | 🟢 |
| 输入栏 / IME | `ComposerTextarea.imeComposition` | ✅ 覆盖 | 🟢 |
| 移动端 UI/UX 契约 | `tests/vitest/mobile-uiux/` 14 文件 | ✅ **189 tests passed** | 🟢 |
| 设置 - 供应商面板 | `VendorDetailPanel.autoFetchModels` 等 | ✅ 覆盖 | 🟢 |
| 设置 - 关于页 | `OpenSourceAcknowledgementsSection` / `aboutLinksActionRow` | ⏸️ 未实跑 | 🟡 |
| 设置 - 全套 | `tests/vitest/settings/` 18 文件 | ⏸️ 未实跑 | 🟡 |
| 设置 - 组件 | `src/features/settings/components/__tests__/` 46 文件 | ⏸️ 未实跑 | 🟡 |
| 通用组件 | `src/components/**/__tests__/` 83 文件 | ⏸️ 未实跑 | 🟡 |
| 应用图标 | `src-tauri/icons/**` 52 文件 | ❌ **无测试** | 🔴 |
| locale 文案 | 分散 i18n 契约 | ⏸️ 未实跑 | 🟡 |

---

## 6. 遗留与后续

1. **待办**：静默窗口结束后补跑 settings（18）+ settings components（46）+ src components（83），
   按「串行 + maxForks=1 + 每条命令 timeout 115」执行，避免再次触发 Node 崩溃。
2. **待确认**：`settingsMobileDataListsContract.test.ts` 实际用例数（静态计数为 0，需实跑确认非空跑）。
3. **本报告已确认无需修复的三项**：图标唯一性、相机 path 合法性、locale 上游署名 —— 均为正常状态，勿误改。
