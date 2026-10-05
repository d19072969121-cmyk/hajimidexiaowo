# E13-T4 能力字段 merge 缺口修复报告

**任务**：task-22 / E13-T4 —— 修复 `merge_builtin_profile_user_aware` 漏同步 `is_image_generation`
**来源**：`analysis/E13T2_模型能力字段透传复核.md`（task-14 只读复核）中的发现，Lead 已独立核实核心缺口
**仓库**：`/root/workspace/repos/deep-student` 分支 `diy/m1-build-baseline`
**改动文件**：`src-tauri/src/llm_manager/mod.rs`（唯一生产改动）
**结论一句话**：**3 处真缺口已修（merge 两分支 + 迁移补丁双重修复），3 项候选经核实为误报或非缺口未改；新增 2 条互补回归测试。**

---

## 1. 已修复的缺口（3 处）

### 1.1 `merge_builtin_profile_user_aware` — 无快照分支

`mod.rs:4155-4157`（按内容定位，行号含本任务新增测试的偏移）：

```rust
let Some(previous_builtin) = previous_builtin_profile else {
    existing.is_multimodal = builtin_profile.is_multimodal;
    existing.is_reasoning = builtin_profile.is_reasoning;
    existing.is_embedding = builtin_profile.is_embedding;
    existing.is_reranker = builtin_profile.is_reranker;
    existing.is_image_generation = builtin_profile.is_image_generation;   // ← 新增
    existing.supports_tools = builtin_profile.supports_tools;
    existing.supports_reasoning = builtin_profile.supports_reasoning;
    return;
};
```

### 1.2 `merge_builtin_profile_user_aware` — 有快照分支（宏列表）

`mod.rs:4178-4179`：

```rust
update_if_untouched!(is_embedding);
update_if_untouched!(is_reranker);
update_if_untouched!(is_image_generation);   // ← 新增
```

### 1.3 迁移补丁 — 触发条件 + 赋值体（**双重修复**）

`mod.rs:5748-5761`：

```rust
if profile.supports_tools != builtin.supports_tools
    || profile.is_multimodal != builtin.is_multimodal
    || profile.is_reasoning != builtin.is_reasoning
    || profile.supports_reasoning != builtin.supports_reasoning
    || profile.is_embedding != builtin.is_embedding              // ← 新增
    || profile.is_reranker != builtin.is_reranker                // ← 新增
    || profile.is_image_generation != builtin.is_image_generation // ← 新增
{
    profile.is_multimodal = builtin.is_multimodal;
    profile.is_reasoning = builtin.is_reasoning;
    profile.is_embedding = builtin.is_embedding;
    profile.is_reranker = builtin.is_reranker;
    profile.is_image_generation = builtin.is_image_generation;    // ← 新增
    profile.supports_tools = builtin.supports_tools;
    profile.supports_reasoning = builtin.supports_reasoning;
```

**为何必须同时改触发条件**：只补赋值体是**无效修复**。若该 profile 的其余字段恰好与内置一致、**仅** `is_image_generation` 有差异，`if` 条件不成立 → 整个赋值块不执行 → 标记照样丢失。这是原代码的**第二重缺陷**（复核阶段只发现第一重）。

> 附带收益：原触发条件漏了 `is_embedding`/`is_reranker`，属同类隐患，本次一并补上（与相邻字段同构，零额外风险）。

---

## 2. 判定为误报 / 不改的候选项（3 项）

### 2.1 ❌ 误报：`migrate_api_configs_legacy` 的 `is_image_generation: false`

**这是我在 task-14 复核中标注「未验证」的那一项 —— 现已验证，撤回。**

- `:6133` `migrate_api_configs_legacy` 确实在**生产路径**（调用点 `:5174`，读取旧格式配置时触发）。**cfg 边界已确认**：
  括号配平枚举全文件 `#[cfg(test)]` → 唯一相关块在 `:2781`，**于 `:2909` 闭合**；
  `2909`→`6178` 区间内 **`#[cfg(test)]` 计数 = 0**。故该函数是生产代码，我原先的"未验证"标注是必要的谨慎。
- **但结论是 `false` 正确，不应改**：该函数迁移的是 **V1/V2 旧 schema**，其实测字段数：

```
OldApiConfigV2 (:6140-6145) / OldApiConfigV1 (:6146-6161)
  含 is_embedding / is_reranker / is_image_generation 的字段数 = 0
```

旧格式**从未存过**这三项能力。迁移时填 `false` 是**唯一有依据的默认值**（无机可传）。此处**不改**。

**教训记录**：`false` 字面量不能一律视为"遗留硬编码" —— 必须先确认**数据源是否曾有该字段**。幂等默认值与漏传在代码形态上完全相同，只有查旧 schema 才能区分。

### 2.2 ❌ 非缺口：`CapabilityOverrides` 不含三字段

`mod.rs:164-169` 仅有 `is_multimodal` / `supports_tools` / `supports_reasoning` / `context_window`。

判定**不改**，理由：它是「只凭 model id 从注册表反推能力」的**独立旁路**（`infer_capability_overrides_from_registry` / `..._from_builtin_catalog`），**不参与**三字段的主透传路径（主透传走 `merge_builtin_profile_user_aware` 与直接赋值）。

→ **是同类隐患而非本 bug 成因**：将来若要在"仅凭 model id"时自动识别 embedding/reranker/image_generation，需先扩此结构体。**记录在案，本轮不动**（改动面大且超出任务目标）。

### 2.3 ❌ 非缺口：启发式仅覆盖 4 个关键词

`mod.rs:3312-3317` 只认 `["gpt-image", "dall-e", "imagen", "flux"]`。

判定**不改**：它是**兜底**（`is_image_generation || looks_like_image_generation_model_id(...)`），而非主判据。本次修好主字段后，兜底覆盖不足不再影响正确性。扩关键词表属产品策略（要认多少家厂商的命名），**非缺陷**。

---

## 3. 新增回归测试（2 条，互补）

照 `:2094` `merge_builtin_profile_user_aware_without_snapshot_syncs_capability_fields` 仿写：

| 测试名 | 锁定分支 | 关键点 |
|---|---|---|
| `merge_builtin_profile_user_aware_without_snapshot_syncs_image_generation_flag` | 无快照（`else` 分支） | `previous_builtin_profile = None` |
| `merge_builtin_profile_user_aware_with_snapshot_updates_untouched_image_generation` | 有快照（`update_if_untouched!` 宏列表） | 传入快照，字段"未动过"→ 应被覆盖 |

**两条互补的必要性**：两个分支是**独立代码路径**，宏列表漏项与直接赋值漏项是**两种不同的失误**。只测其一，另一分支漏 `is_image_generation` 时测试仍绿。这正对应 §1.1 / §1.2 是**两处**而非一处。

**刻意用 `cogview-4` 作样本模型名**：因它**不含**启发式四关键词（`gpt-image`/`dall-e`/`imagen`/`flux`）。
→ 断言必须由 `is_image_generation` 字段本身驱动，**不可能被兜底启发式"蒙对"**。若用 `gpt-image-1` 做样本，即使字段漏传也可能因启发式而通过 —— 那会是假绿。

---

## 4. 校验两遍

**第一遍（已完成）**：3 处修复按**内容 grep** 逐一确认在位：

```
4157:  existing.is_image_generation = builtin_profile.is_image_generation;
4179:  update_if_untouched!(is_image_generation);
5761:  profile.is_image_generation = builtin.is_image_generation;
5748-5761: 触发条件含 || profile.is_image_generation != builtin.is_image_generation
```

⚠️ 行号因插入测试整体偏移，故**改用内容定位**而非行号引用 —— 避免复核者按旧行号看错位置。

**第二遍（待执行）**：编译 + 跑测试。**状态见 §6「验证状态」** —— 需 Lead 确认 perf-profiler 静默窗口（占 CPU 的 cargo 任务会干扰测速）。

---

## 5. 影响评估：为什么这个缺口值得修

**静默失败形态**：三处都是 `bool` 字段的「不赋值」——
- 不报错、不告警、无日志；
- Rust 编译器不提示（字段有 `#[serde(default)]`，别处结构体字面量已满足）；
- 单测不覆盖（原测试只断言 `supports_tools` / `is_builtin`）。

→ 与前端 `modeFamily.ts` 反复警告的「加字段但判据点没跟上」是**同一类缺陷在 Rust 侧的等价形态**。

**下游客观后果**（三处**硬依赖** `!is_image_generation` 做排除）：
- `anki_model_routing.rs:153` —— 制卡路由排除非对话模型
- `chat_v2/pipeline/context_compiler/model_selection.rs:31-33` —— 上下文压缩选型
- `llm_manager/mod.rs:2775` —— OCR 候选模型筛选

标记丢失 → 图像生成模型（如 `cogview-4`，**不含启发式关键词**）**混入以上三类候选**，且会出现在对话模型选择器里。

**与 task-14 的关系（同一条功能链两端）**：
- task-14（copy-renamer）= 让内置表**标出**能力
- 本案 = 让 merge 逻辑**不丢**能力

→ 只做 task-14 会变成「标了但白标」：新补录的 `is_image_generation: true` 对**已有用户配置**不生效。（全新安装走无快照分支原也有漏；本次两分支都补齐。）

---

## 6. 验证状态

| 项 | 状态 |
|---|---|
| 3 处修复内容核对 | ✅ 完成（内容 grep） |
| cfg 边界确认（`:6178`/`:6243`） | ✅ 完成（生产代码，但 `false` 正确） |
| 2 条回归测试已写入 | ✅ 完成 |
| 编译验证（生产代码） | ✅ **通过**（`cargo check --target aarch64-linux-android`，2026-10-05 Lead 代跑，零 error，仅既有 unused-import 警告） |
| 测试代码编译 | ✅ **通过**（`cargo check --tests --target aarch64-linux-android`，2 条新回归测试类型签名正确） |
| 测试断言执行 | ⏳ **未执行**（宿主机缺 glib-2.0 无法构建测试二进制；Android target 无法运行宿主测试 → 留待 CI 宿主 job 执行） |

**未验证项（诚实标注）**：
- 未跑 `cargo check` / `cargo test`（遵守 Lead 关于性能测速窗口的指示，cargo 占 CPU）；
- 类型安全目前基于**静态判读**：三处改动均为 `bool` 字段的赋值/宏调用，与相邻 `is_embedding`/`is_reranker` **完全同构**，理论无类型风险 —— 但**未编译即不算验证**；
- 未做端到端运行时验证（无真机，未构造"注册表声明 cogview-4 → 用户已有配置是否更新"的集成测试）。

---

## 7. 变更清单

- `src-tauri/src/llm_manager/mod.rs`：3 处生产修复 + 2 条回归测试
  - `:4157` 无快照分支补 `is_image_generation`
  - `:4179` 宏列表补 `update_if_untouched!(is_image_generation)`
  - `:5748-5761` 迁移补丁：触发条件 +3、赋值体 +1
  - `:2121` 起 2 条新测试
- `analysis/E13T4_能力字段merge缺口修复.md`（本报告）

**未触碰**：`builtin_vendors.rs`（copy-renamer 的写作用域）、`CapabilityOverrides`、启发式关键词表、`migrate_api_configs_legacy` 的 `false` 字面量。
