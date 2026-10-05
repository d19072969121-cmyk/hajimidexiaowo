# E13-AA：仓库门面文本改造

**执行者**：Lead 亲自执行（队友通道失效——send_message accepted 但零实际执行，环境级 node 崩溃后 teammate 宿主进程已坏，多轮重试无效）。
**日期**：2026-10-05

## 改动清单

### README.md（11 处）
- :5 logo → `./public/ai-study-logo-832.png`（alt="AI Study"）
- :10 **新增署名行**：`> A derivative work of [Deep Student](https://github.com/helixnow/deep-student) (AGPL-3.0).`
- :17 Release 徽章 → `img.shields.io/github/v/release/d19072969121-cmyk/hajimidexiaowo` + 链接指向用户仓库 releases/latest
- :19 Stars 徽章 → 用户仓库
- :21 `[Website](https://deepstudent.cn)` → `[GitHub](https://github.com/d19072969121-cmyk/hajimidexiaowo)`
- :23 Quick Start → 锚点 `#installation`
- :24 User Guide → 用户仓库 `#readme`
- :25 Report Issues → 用户仓库 issues
- :337 下载地址 → 用户仓库 releases/latest
- :465 `git clone` → `https://github.com/d19072969121-cmyk/hajimidexiaowo.git`
- :482-483 在线文档链接（deepstudent.cn/docs）→ 改为 in-repo 指向
- :529 Issues 链接 → 用户仓库 issues

### README_CN.md（同构 11 处，中文文案不变）
- :5 logo、:10 署名行（`> 基于 [Deep Student](...) 二创（AGPL-3.0）。`）、:17/:19 徽章、:21 官网→GitHub、:23-24 快速入门/用户手册、:25 反馈问题、:337 下载、:465 git clone、:482-483 在线版、:529 Issue

### .github/PULL_REQUEST_TEMPLATE.md（1 处）
- :21 上游 CLA 链接行 → **整行删除**（用户仓库无 CLA 流程；报告即此说明）

## 验证输出（Lead 实跑）

```
$ grep -c "deepstudent.cn" README.md README_CN.md
README.md:0
README_CN.md:0

$ grep -n "helixnow/deep-student" README.md README_CN.md .github/PULL_REQUEST_TEMPLATE.md
README.md:10:> A derivative work of [Deep Student](https://github.com/helixnow/deep-student) (AGPL-3.0).
README_CN.md:10:> 基于 [Deep Student](https://github.com/helixnow/deep-student) 二创（AGPL-3.0）。
README_CN.md:538:> 基于 [Deep Student](https://github.com/helixnow/deep-student) 二创（AGPL-3.0）。

$ grep -c "d19072969121-cmyk/hajimidexiaowo" README.md README_CN.md
7 / 7
```

- 上游链接残留**仅剩署名行**（AGPL-3.0 义务）✅
- deepstudent.cn **归零** ✅
- README_CN.md:538 的署名行是文档内重复段落（引导语），同属署名，合规

## 红线遵守

- docs/ 历史文档：未动 ✅
- CHANGELOG.md：未动 ✅
- AboutTab.tsx 致谢卡片（Deep Student 卡 + 上游链接）：未动 ✅
