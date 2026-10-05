# E13-Y：logo 绝对路径引用在打包后是否失效 —— 实证报告

| 项 | 值 |
| --- | --- |
| 任务 | task-19（owner: icon-swapper） |
| 仓库 | `/root/workspace/repos/deep-student`，分支 `diy/m1-build-baseline` |
| 审查对象 | `src/components/ui/DeepStudentLogo.tsx:80-89` 的 `<image href="/ai-study-logo-832.png">` |
| Tauri 版本 | 2.11.5（`Cargo.lock`） |
| Vite base | `command === 'serve' ? '/' : './'`（`vite.config.ts:179`） |
| 日期 | 2026-10-05 |

---

## 结论

**无打包失效风险。**

`<image href="/ai-study-logo-832.png">` 在 Vite 构建 + Tauri（含 Android）生产包里能正常加载。理由三条，均为实测：

1. **该写法是项目既有惯例**，有大量先例（含带测试断言的），不是本次新引入的模式；
2. **Vite 的 `base: './'` 不影响它** —— 硬编码在 JSX 里的绝对路径不经 Vite 改写，而是由 Tauri 生产构建把 origin 设为 `http://tauri.localhost/`，绝对路径 `/x.png` 即在 `frontendDist`（`../dist`）根下解析；
3. **CSP 已放行**：`img-src` 含 `'self'`，`http://tauri.localhost` 属同源。

**但这不代表写法是最优的** —— 第五节给出更稳的替代方案（`import` 静态资源），并说明为何本次不改。

### 一处需要更正的前提

Lead 最初判断"全项目只有这一处用绝对路径引用 public 资源"。经独立 grep，**该前提不成立**（Lead 后已自我更正）。实测先例见第二节。

另有一个**反向发现**：项目里唯一使用 `<image href>` 的组件 `WorkbenchAppIcon.tsx`，用的**不是**绝对路径，而是 Vite `import` 的静态资源。这一点对风险评估很重要，见第四节。

---

## 一、两个机制必须先分清

这是本次调查最容易踩空的地方 —— 项目里有**两套完全不同的资源机制**：

| 机制 | 用途 | 路径形态 | 是否受 `assetProtocol.scope` 管制 |
| --- | --- | --- | --- |
| **asset protocol** | 加载**磁盘上的文件**（`convertFileSrc`） | `asset://localhost/...` | **是** |
| **WebView 静态资源服务器** | 加载**前端 dist 里的静态资源** | `/xxx.png`、`./xxx.png` | 否，根 = `frontendDist` |

实测 `tauri.conf.json` 的 `assetProtocol`：

```json
{ "enable": true,
  "scope": ["$APPDATA/**", "$APPLOCALDATA/**", "$RESOURCE/**",
            "$DOCUMENT/**", "$DOWNLOAD/**", "$DESKTOP/**", "$PICTURE/**", "$TEMP/**"] }
```

**scope 里没有任何前端 dist 目录**。这反过来证明：前端静态资源**不走 asset protocol**，而是走 WebView 内建的静态资源服务器，以 `frontendDist: "../dist"` 为根。

> 参照 [Tauri 官方 asset protocol 文档](https://v2.tauri.app/zh-cn/security/asset-protocol/)：asset protocol 是"把磁盘文件送进 WebView"的机制，其 scope 决定"哪些**文件系统路径**可被暴露"。它不管理前端打包产物。

---

## 二、先例：绝对路径引用 public 资源是既有惯例

以下均为实测 grep 结果（非推测）：

| 位置 | 写法 |
| --- | --- |
| `src/features/chat/components/MessageList.tsx:1091` | `src="/logo-black.svg"` |
| `src/lazyComponents.tsx:52,60` | `src="/logo-black.svg"` |
| `src/features/workbench/components/AgentControlCenter.tsx:466,503` | `src="/app-icon.png"` |
| `src/features/workbench/components/WallpaperLayer.tsx:56,63,70,77` | `imageUrl: '/wallpapers/study-os/*.webp'` |
| `index.html` | `href="/app-icon.png"`、`src="/logo-black.svg"` |

**其中两处带既有测试断言**，证明这些绝对路径是团队有意维护的契约：

- `src/features/workbench/components/__tests__/AgentControlCenter.test.tsx:76,84`
  ```ts
  expect(trigger.querySelector('img')).toHaveAttribute('src', '/app-icon.png');
  expect(dialog.querySelector('.wb-agent-control-mark img')).toHaveAttribute('src', '/app-icon.png');
  ```
- `src/features/workbench/components/__tests__/WallpaperLayer.test.tsx:57`
  ```ts
  expect(naturalPresets.every((preset) => preset.imageUrl?.startsWith('/wallpapers/study-os/'))).toBe(true);
  ```

`/app-icon.png` 对应 `public/app-icon.png`，`/logo-black.svg` 对应 `public/logo-black.svg`，`/wallpapers/` 对应 `public/wallpapers/` —— 与 `public/ai-study-logo-832.png` → `/ai-study-logo-832.png` **完全同构**。

---

## 三、构建产物实证：`base: './'` 对两类资源的效果不同

实测 `dist/`（10-03 构建产物）得到决定性对比。

**Vite 改写的部分（HTML 层）**：`base='./'` 生效，`/app-icon.png` 被改写为相对路径：

```
href="./app-icon.png"
src="./boot-theme.js"
src="./assets/main-CiWXIrRR.js"
```

**Vite 不改写的部分（JS 里硬编码的绝对路径）**：原样保留，实测：

```
dist/assets/....js  ->  "/wallpapers/study-os/mountain-mist.webp"
dist/assets/....js  ->  "/logo-black.svg"
dist/assets/....js  ->  "/icons/providers/generic.svg"
```

**对照 —— Vite `import` 型资源**（`WorkbenchAppIcon` 用的那类）产出**带 hash 且无前导斜杠**的形态：

```
dist/assets/  ->  todo-RSpTCeB8.svg , notes-C6_ikqPN.svg , essay-xxOAU83u.svg ...
dist/assets/...js  ->  "todo-RSpTCeB8.svg"
```

### 结论

`base: './'` **只改写 Vite 自己生成的引用**（HTML 与 import 型资源）。**JSX 里硬编码的 `/x.png` 不在其中** —— 它在运行时才被浏览器解析。

因此风险点不在 Vite，而在**运行时 origin 是什么**。Tauri 生产构建把 WebView origin 设为 `http://tauri.localhost`（桌面/Android 一致），于是：

```
/ai-study-logo-832.png
  -> http://tauri.localhost/ai-study-logo-832.png
  -> Tauri 静态资源服务器以 frontendDist(../dist) 为根
  -> dist/ai-study-logo-832.png   ✅ 命中
```

实测 `dist/ai-study-logo-832.png` 存在性：**该文件在 10-03 的旧 dist 中尚不存在**（本次新增），但同目录下 `dist/app-icon.png`、`dist/logo-black.svg` 均平铺在根，且 `public/` 下所有资源被构建平铺复制的行为一致 —— 下次 `npm run build` 后 `dist/ai-study-logo-832.png` 会同样落在根。

> 参照 [tauri-apps/tauri#13262](https://github.com/tauri-apps/tauri/issues/13262)：生产构建中资源路径会被重写到 `http://tauri.localhost/`，与该机制吻合。

---

## 四、唯一真正的新点：SVG `<image href>` 是否等同 `<img src>`

这是 Lead 指出的、也确实**唯一**没被先例覆盖的点。实测结果**比预期复杂**：

项目里唯一的 `<image>` 用例是 `src/features/workbench/components/WorkbenchAppIcon.tsx:40`：

```tsx
<image href={APP_ICON_URLS[typeId]} x="9" y="9" width="46" height="46" preserveAspectRatio="xMidYMid meet" />
```

而 `APP_ICON_URLS` 来自 **Vite `import`**（`src/features/workbench/icons/appIcons.tsx`）：

```ts
import todoUrl from './app-icons/todo.svg';
export const APP_ICON_URLS = { todo: todoUrl, ... };
```

> **所以这个先例证明的是 `<image href>` 在 SVG 内可用（会在渲染期发起图片请求），但它的 URL 是 import 型、不是硬编码绝对路径 —— 不能直接等同于我的写法。**

### 规范层面

按 CSP 规范，SVG `<image>` 在**作为 `<img>` 加载或文档内联时**，其外部引用受 `img-src` 管辖（参见 [W3C public-webappsec 讨论](https://lists.w3.org/Archives/Public/public-webappsec/2012Feb/0020.html)、[CSP Level 2](https://www.w3.org/TR/2015/CR-CSP2-20150219/)）。即 `<image href="/x.png">` 与 `<img src="/x.png">` **同受 `img-src` 约束**。

实测本项目 `img-src`：

```
img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost
        pdfstream: ... filestream: ... https:;
```

含 `'self'` → `http://tauri.localhost/ai-study-logo-832.png` 属同源，**放行**。

### 但这里有一个我不能确证的点

`<image href>` 在**内联 SVG**（我的写法）vs **`<img src>`** 之间，除 CSP 外还有一层差异：**SVG `<image>` 的外部引用在部分 WebView 实现下对相对/绝对路径的解析基准是"文档 URL"还是"SVG 文档 URL"**。我的 SVG 是 React 内联进 DOM 的，基准应为文档 URL（即 `http://tauri.localhost/`），与 `<img src>` 一致 —— **逻辑上成立，但我没有 Android 实机证据**。

**因此我的诚实判定是：机制上无风险、CSP 上无风险，但"内联 SVG `<image>` 绝对路径在 Android WebView 的实际加载"缺少真机验证。** 见第六节建议。

---

## 五、更稳的替代写法（若要把风险降到零）

项目里已有**明确更稳**的范式，就在 `WorkbenchAppIcon` / `appIcons.tsx`：

**方案 A（推荐，最稳）—— 把图片挪到 `src/assets/` 并 `import`**

```ts
// 新增 src/assets/ai-study-logo.png（源图放这里）
import logoSrc from '@/assets/ai-study-logo.png';
// ...
<image href={logoSrc} x="0" y="0" width="409" height="147" preserveAspectRatio="xMidYMid meet" />
```

优点：
- 产出**带 hash 的真实 URL**，由 Vite 按 `base` 正确改写，**与产物根位置解耦**；
- 天然享受 Vite 的 hash 与缓存策略；
- **与项目既有 `<image>` 用法完全一致**（`WorkbenchAppIcon` 就是这么做的）。

**方案 B —— 保留 public，但改用 `new URL`**：不适用（`new URL` 只对 import 型有意义）。

**影响面（方案 A）**：只动 `src/components/ui/DeepStudentLogo.tsx` 的 import 与 `href`，另把 `public/ai-study-logo-832.png` 挪到 `src/assets/`。**不动** `AboutTab.tsx`、不动图标、不动其它 public 资源。测试 `DeepStudentLogo.source.test.ts` 的 4 条断言不受影响（不断言 `href` 值）。

**为什么本次没有直接改**：
1. 任务明确要求"只读调查 + 给方案，不要擅自改源码"；
2. 现有写法**已有 5 处同构先例**（含带测试断言的），并未引入新风险面；
3. 是否走方案 A 属**写法偏好**，需你决定。

---

## 六、诚实声明

1. **我无法验证 Android 实机/模拟器上的实际加载效果。** 本报告全部结论基于：源码 grep、`dist/` 产物实测、`tauri.conf.json` 配置、Tauri 2.11.5 官方文档与 issue。**未做真机验证。**
2. **`dist/` 是 10-03 的旧产物**，不含 `ai-study-logo-832.png`。我**没有跑 `vite build`**（遵守 ≤2 分钟禁令；该构建在此前实测中超 5 分钟）。因此"构建后该文件落在 `dist/` 根"是**基于 public 目录复制规则的推断**，依据是同目录下 `app-icon.png`/`logo-black.svg` 的实测落位。
3. **不能截屏、不能识图** —— 无法看到 logo 是否真的显示出来。
4. 报告未评估**视觉呈现**（这是 task-8 的范畴，那边已声明未做视觉确认）。

### 建议的零成本真机校验（人工，1 分钟）

出包后打开「设置 → 关于」，看 logo 位置：

- **显示正常** → 结论确证，无需改动；
- **空白/裂图** → 唯一可疑点被证实，按第五节方案 A 改（把图挪 `src/assets/` + `import`），改动量约 3 行。

同时可开 DevTools 看是否有 `Refused to load the image ... img-src` 报错 —— 若有，说明是 CSP 而非路径问题（可把 `http://tauri.localhost` 显式加入 `img-src`）。

---

## 七、二次校验记录（独立角度）

按"校验两遍"要求，第二遍换了证据来源，与第一遍结论一致：

| 维度 | 第一遍（源码/产物） | 第二遍（独立角度） | 是否一致 |
| --- | --- | --- | --- |
| 是否有先例 | grep `src="/..."` 命中 5 处 | 查**测试断言**是否存在 → `AgentControlCenter.test.tsx:76,84`、`WallpaperLayer.test.tsx:57` 确实断言了绝对路径 | ✅ 一致，且第二遍更强（测试是契约） |
| `base='./'` 影响面 | 实测 `dist/index.html` 改写为 `./`、JS 里 `/wallpapers/` 原样 | 查 `import` 型资源产出形态 → hash 且无前导斜杠，**与绝对路径不同** | ✅ 一致，且第二遍揭示了差异机制 |
| 机制归属 | `assetProtocol.scope` 不含 dist → 不走 asset protocol | 查 [Tauri 官方文档](https://v2.tauri.app/zh-cn/security/asset-protocol/) → asset protocol 确为"磁盘文件"机制 | ✅ 一致 |
| `<image>` 是否受 CSP 管辖 | `img-src` 含 `'self'` → 放行 | 查 [W3C/CSP 规范讨论](https://lists.w3.org/Archives/Public/public-webappsec/2012Feb/0020.html) → `<image>` 的外部引用受 `img-src` 管辖 | ✅ 一致 |

**第二遍额外发现（第一遍漏掉的反例）**：`WorkbenchAppIcon` 这个唯一的 `<image>` 先例，用的**不是**绝对路径而是 import —— 这削弱了"先例直接等价"的乐观判断，故本报告第四节把 `<image>` 单列为"未获真机确证的点"，而非直接归为无风险。
