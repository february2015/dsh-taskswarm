# 更新日志（Changelog）

**dsh-taskswarm（TaskSwarm 蜂群）** 的所有重要变更记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)；本项目使用
[语义化版本](https://semver.org/lang/zh-CN/)。English version: [CHANGELOG.md](CHANGELOG.md)。

## [0.2.24] - 2026-08-16

### 新增

- **`/tswarm-stop-lane <taskId>`**（别名 `/orch-stop-lane`）—— 立即停掉单个 lane：终止其 worker
  （不等看门狗）、标记 failed、保留 worktree/检查点供抢救。同波其他 lane 不受影响；
  `pauseOnLaneFailure`（默认开）开启时该波结束后批次自动暂停等处置。
- **`pauseOnLaneFailure` 配置（默认 `true`）** —— failed lane 不再直接滚到下一 wave，而是在
  该波结束后**自动暂停**让 supervisor 处置（重跑 / 丢弃 / 继续）。`resume` 时跳过 failed lane
  （丢弃失败工作）；重跑失败任务用 `/tswarm <taskId>` 单独跑。这与崩溃恢复的 resume 区分——
  后者 failed lane 会重跑续接检查点（KI-007）。

### 修复

- stop-lane 竞态：被 `/tswarm-stop-lane` 停掉的 lane 即使 worker 后续正常返回也保持 failed
  （此前正常完成路径可能把它复活为 merged）。
- `pauseOnLaneFailure` 的 resume 不再死循环：恢复失败暂停的批次时丢弃 failed lane，而非
  重跑再失败 → 再暂停。

## [0.2.23] - 2026-08-16

### 新增

- **Web dashboard 每 lane 步数徽章** —— 每个运行中 lane 的任务卡显示 `⚙ N steps`：
  worker 从任务开始到现在累计执行的步数（会话事件 `step` 字段——每次工具调用/回复 +1），
  复杂任务在后台跑很多步时，前台靠数字上涨即可感知"还在跑"。数据来自新实现的
  `runtimeLaneSnapshots`（worker.stepCount），读 worker 会话日志
  （`~/.dsh/sessions/--<worktree>--/session.jsonl[.zstd]`）。
- **工蜂→蜂王消息带步数** —— `notify_supervisor` / `escalate_to_supervisor` 现在会在消息里
  附带 worker 当前的 `steps X/Y`（checkbox 进度）与 `N steps executed`（会话累计步数）；
  supervisor 定时汇报/状态行的每个 lane 也同时显示两者
  （如 `lane 1 [running] JM-401 steps 0/11 · 179 steps executed`）。

### 修复

- **总步数回退 PROMPT.md**（`laneProgress`）：STATUS.md 缺 `### Step N:` 段（手工/其它 AI
  只写 Status 头 + Execution Log）时，总数改用任务包的 checkbox——第一步还没完成也能看到
  `0/N`，知道任务一共多少步。
- **所有 STATUS.md 落盘入口先保证 Step 结构** —— 新增 `ensureTaskDirStructure()`，在全部
  状态持久化写入函数入口调用（`setTaskStatus` / `markTaskDone` / `markTaskRunning` /
  `advanceStep` / `appendExecutionLog` / `updateStatusField` / `appendStepStatus`）：
  任务创建 / 更新 / 成功 / 失败 / 状态变更任何环节都不会落到引擎依赖的残缺结构上。
  `ensureStatusStructure` 改为**注入** Step 段（保留已有 Execution Log 行），而非重写文件。
- 修复插件测试对新增 `ctx.provide('taskswarm', …)` 服务（b83e4bf）的适配：mock 上下文补了
  no-op 的 `provide`。

## [0.2.22] - 2026-08-15

### 新增

- **状态汇报附任务步数进度（KI-008）** —— `parseStatusFile` 返回 `checked`/`total` 勾选统计，
  `/tswarm-status` 与 supervisor 状态行的每个 lane 显示 `已完成/总数`（如
  `lane 1 [running] T-8 2/7`），一眼看清任务一共多少步、执行到哪一步。

### 变更

- **README 新增「TaskSwarm vs DSH 原生 subagent」对比表** —— 对比表（任务形态 / 并行度 /
  隔离 / 质量门 / 可恢复 / 可观测）从社区帖移入 README，正面回答最常见的第一个问题。
- **删除社区介绍帖**（`docs/community-post*.md`）——其唯一独有内容（对比表）已并入 README，
  其余与 README 重复。
- **known-issues 整理** —— 英文版把早已修复的 KI-005/KI-006 从 OPEN 移到 RESOLVED（中文版
  本就在 RESOLVED）；KI-008 移入 RESOLVED 并注明修复。两版 OPEN 区现在均为空。

## [0.2.21] - 2026-08-15

移除 bug 交接清单文档（`docs/bug-交接清单.zh-CN.md`）——清单中四个 bug（B1 abort 簿记、
B2 进度上报、B3 merge 冲突处理、B4 Current Step 显示）均已修复（v0.2.18–v0.2.20），
根因分析保留在 known-issues。

## [0.2.20] - 2026-08-15

### 修复

- **lane 运行中不再显示 "Not Started"（B4）** —— `runLane` 在 lane 启动时调用 `markTaskRunning()`：
  除了 `**Status:** 🟢`，还把 `**Current Step:**` 置为第一个 Step 的标题、该 Step 状态标 🟢，
  STATUS.md 从启动那一刻起自洽（此前"🟢 In Progress"与"**Current Step:** Not Started"并存，
  直到 worker 首次 `advance`）。dashboard 兜底：running/review/conflict 的 lane 若 Current Step
  仍是初始值 "Not Started"，显示为 "In Progress"，不再暴露原始初始值。

### 变更

- **停滞阈值 4 → 7 分钟**（`supervisorStalledMs` 默认 240000 → 420000）：worker 常在首次
  `advance` 前做几分钟调研，4 分钟会产生过多的 🐢 进度停滞提醒；7 分钟更宽容，同时仍能抓住
  真正的攒批。
- **README 精简** —— 移除「项目状态」段（版本号 + 测试数 + 与 Features 重复的能力清单，
  必然过时）；Features 未覆盖的能力（orch 基线 lane、任务包校验、LLM merge agent）并入
  Features 段。版本历史只留在 CHANGELOG。过时的"本地 link 安装"待办删除，剩余待办
  （supervisor 汇报附任务步数进度）移入 known-issues 作为 KI-008（双语）。

## [0.2.19] - 2026-08-15

### 变更

- **worker 任务书强制逐步 `advance`（B2）** —— 任务书新增硬性规则：每完成一个 checkbox
  **立即** `advance`、禁止攒批到最后统一勾选、`done` 仅在所有 Completion Criteria 满足后才可调用、
  禁止手改 STATUS.md。修复进度显示长时间停低值后 0→100% 跳变、以及崩溃恢复只能靠最后一次提交
  的问题。
- **进度停滞监督（B2）** —— 定时 supervisor 跟踪每个 running lane 的 STATUS.md mtime；
  会话活跃但 STATUS 超过停滞阈值未推进的 lane 会收到一次 `progressStalled` 提醒（双语），
  识别攒批不推进的 worker。

### 新增

- **`conflict` lane 状态 + 未解决 merge 冲突自动暂停（B3#3）** —— merger agent 无法解决冲突
  （或无 merger 可用）时，lane 进入新的 `conflict` 态（现场完整保留：lane worktree、分支、
  orch 冲突状态），批次在**波次边界自动暂停**而非静默继续。supervisor 经 wave-complete 事件
  （带 `conflict` 计数）唤醒，可手工修复 merge 后 `resume`，或决定重跑该 lane——不再有人工介入
  与后台 merger/重试的竞态（双通知的根因）。
- merger 任务书显式禁止再次执行 `git merge <laneBranch>`、禁止 abort 在途 merge（B3#2）——
  agent 只基于保留的冲突现场工作。

### 修复

- `estimateEta`、supervisor 卡住检测、活跃 lane 列表、dashboard 适配器均计入 `conflict` 态
  （视为未完成而非已完成）。

## [0.2.18] - 2026-08-15

LICENSE 改为标准 MIT 模板（GitHub 识别从 NOASSERTION/Other 恢复为 MIT）；package.json 补
homepage / repository / bugs 字段（npm 页面展示）。

## [0.2.17] - 2026-08-15

移除已修复的 bug 交接文档；CHANGELOG 引用同步。

## [0.2.16] - 2026-08-15

### 修复

- **`abort` 后立刻 `start` 不再错乱批次簿记**（dsh-localvoice 现场复现）：abort 发生在波次途中时，旧批次的在途 lane 不停止——重建已被删的
  worktree、spawn 新 worker，并把完成状态写进**已 abort 的旧批次文件**；而新批次文件停在 0 进度。
  四项修复：
  - `abort()` 现在 resolve 每批次的 abort waiter；`runLaneWorker` 把在途 worker await 与它对跑，
    abort 真正停止在途工作而非仅置标志。
  - `runLane` 在创建 worktree 前、spawn worker 前检查 `aborted`。
  - `updateLane` 拒绝向终态批次（`aborted`/`complete`）写 lane。
  - `execute()` 波次边界写盘尊重磁盘终态，不再用内存里陈旧的 `running` 覆盖（此前会"复活"
    已 abort 的文件）。
  - `run()` 在仍有（未 abort 的）批次运行中时拒绝启动新批次。
- 回归测试：波次中 abort → 立刻 start → 旧文件不再被写、新批次正常跑完。

## [0.2.15] - 2026-08-15

### 新增

- **LLM merger agent（P1）** —— lane 并入 `taskswarm/orch` 的 `git merge` 失败（冲突）时，
  引擎 spawn 一个 merger agent（spawn 方式同 reviewer，`src/worker/merger.ts`）在 orch
  worktree 内**语义化解冲突**：读双方意图 → 编辑文件 → 完成 merge commit。移植自 TaskPlane
  的 LLM 合并 agent。配置：`mergerModel`。
- **Merge 验证（P2）** —— merge 成功后可选跑验证命令（`mergeVerifyCommands`，如
  `["npm test"]`），随 merger agent 任务书下发。
- **Merge 看门狗（P3）** —— merger agent 卡住时超时（`mergerTimeoutMinutes`，默认 10 分钟），
  保留现场返回 unresolved，不阻塞后续串行 merge 队列。

### 修复

- **merge 失败不再销毁现场（P0）** —— `mergeLane` 此前在 merge 失败时对 lane 分支执行
  `git branch -D`（与自身注释矛盾），把 worker 的工作删掉；现在完整保留 lane worktree、
  分支与 orch 冲突状态，供排查 / merger agent 解决 / 人工介入。
- **orch worktree 并发 merge 串行化** —— 同一 wave 并行完成的 lane 此前会并发对同一 orch
  worktree 跑 `git merge`，被 git 锁拒绝（stderr 为空、lane 静默失败）；现在 merge 走
  promise 链互斥队列。

## [0.2.14] - 2026-08-15

### 修复

- 发布手册：包名三处全部修正为 `dsh-taskswarm`（`dsh plugin add`、`npm view`、npm Granular
  Access Token 权限范围）——`buju`→`dsh-taskswarm` 更名后文档仍指向不存在的包名。

## [0.2.13] - 2026-08-15

### 修复

- **lane 工作树改为以 `taskswarm/orch` HEAD 为基线，而非工作分支** —— dsh-localvoice T-5
  rpc.ts 事故的根因：`createLaneWorktree` 跑 `git worktree add -b <branch> <dir>` 时未指定
  commit-ish，每个 lane 都从工作分支（master）出发，看不到此前已合并任务的产物；只能靠 worker
  **自觉** `git merge taskswarm/orch` 补基线，未意识到依赖的 worker 产出残缺/重复实现，
  merge 回 orch 时互相冲突。
  - 新 lane：`worktree add -b <branch> <dir> taskswarm/orch` —— 从起点继承全部已合并产物。
  - 续跑 lane：附着旧分支后引擎**自动** `git merge taskswarm/orch`（冲突 → abort，worker 自行解决）。
  - worker 任务书明确说明 lane 基于 `taskswarm/orch`、应复用已合并产物。
  - runbook 记录 lane 基线机制；新增测试覆盖新 lane 基线 + 续跑保留检查点。

### 变更

- 发布手册：强制 **先 `npm publish` 后 `git push`** 的顺序 —— GitHub 渠道安装依赖 npm 已发布
  版本，且每个版本只能发布一次，顺序事后无法补救。

## [0.2.12] - 2026-08-15

### 新增

- **坏格式任务包不再被静默跳过** —— 无法被机器解析的 `PROMPT.md`（例如 `T1` 这种缺连字符的 ID、
  或旧式人类可读格式）此前会被 `scanTasks` 无声丢弃；现在会报出可操作的错误原因。
- **`/tswarm-check` 命令** —— 直接从会话里校验任务包质量（缺步骤 / 缺验收标准 / 缺文件范围）。
- **`npm run check:tasks`** —— 独立任务包校验脚本（`scripts/check-tasks.mjs`），可在不开 DSH 的
  情况下用于 CI / 发布前预检。
- `scanTaskFailures` / `explainParseFailure` —— 解析失败诊断的编程接口。

### 变更

- `plan` / `start` 现在会在输出里追加解析失败警告，坏任务包不会再无声地从波次计划中消失。
- `docs/runbook.md` §4.2 重写为严格的任务包机器格式规范，附避坑表和自查清单。

## [0.2.11] - 2026-08-14

仅版本号变更（包元数据）。作为承载 0.2.9/0.2.10 文档与打包修复的基线发布到 npm。

## [0.2.10] - 2026-08-14

### 新增

- README：升级说明 —— 升级时需显式指定版本（`dsh plugin add dsh-taskswarm@<版本>`），因为
  lockfile 版本已满足声明范围时安装会报 "Already up to date"。
- 发布手册：补充 npm 2FA 下必须使用**勾选 bypass 的 Granular Access Token**（账号开启 2FA 时
  经典 token 会被 `E403` 拒绝）。

## [0.2.9] - 2026-08-14

### 变更

- **`prepare` 脚本** —— 安装时自动 `npm run build`，GitHub 直装
  （`dsh plugin add https://github.com/february2015/dsh-taskswarm.git`）无需手动构建。
- **patch id 与插件名统一** —— bundle patch id 改为 `tswarm-orchestrator`，与包名一致。
- README：补充热更 / HMR 行为说明（配置热更注意事项、源码 HMR 需重新构建并重启 dsh web、
  重启后批次恢复）。
- 清理旧名 `buju` 遗留（LICENSE 版权归属、`.gitignore` 状态目录）。

## [0.2.8] - 2026-08-14

### 新增

- Dashboard 启动时自动打开浏览器（`--no-open` 可关闭）；已有实例直接复用，不再开第二个。

## [0.2.7] - 2026-08-14

### 修复

- Dashboard 进度条段宽按任务数分配 —— 无 `STATUS.md` 的 pending wave 不再塌缩成 0 宽
  （恢复 TaskPlane 式多段显示）。
- Dashboard logo `viewBox` 加宽以适配 "TaskSwarm" 文字（原 300px 只显示中间 "skswa"），
  含主题切换 logo 变体。

## [0.2.x 早期 / 0.2.6 及以下]

0.2.x 系列是在 2026-08-14 的快速发布冲刺中从 0.1.x 代码库切出的。0.2.7 之前的主要变更：

- **`buju` 更名 `dsh-taskswarm`（TaskSwarm 蜂群）** —— 仓库、包名、命令前缀统一（`/orch-*`
  保留为兼容别名）。
- **对话式 supervisor** —— 与 operator 共享会话，汇报波次完成 / lane 失败 / 批次完成，
  接受口头命令，双语（中文 / English）自动检测会话语言，持久化到 `.taskswarm/config.json`。
- **Web Dashboard** —— 零依赖 `node:http` + SSE，多实例自动协商端口，批次开始时自动启动
  （每个工作区永远只有一个实例）。
- **崩溃恢复** —— 持久磁盘状态 + 检查点 + 保留 lane 分支；引擎重启后 `resume` 恢复未完成批次
  （只跳过 merged lane，failed lane 重新执行）。
- **lane 看门狗** —— `laneTimeoutMinutes` 默认 90 → 180（并行大任务在 90 分钟被切断）；
  超时前先查磁盘，手动收尾的 lane 不再被误标 `failed`。
- **supervisor 清理提醒** —— 批次全成功后提醒清理 worker 会话历史，通知附带磁盘占用。

## [0.1.1] - 2026-08-14

首个打 tag 的发布。双语文档（发布手册、runbook、known-issues）、README 重写、`tasks/`
运行时数据移出仓库、npm 打包修复。

## [0.1.0] - 2026-08-14

[TaskPlane](https://github.com/HenryLach/taskplane) 到 DeepSeek Harness 的初版移植：

- **waves / lanes 并行编排** —— 按依赖 DAG 分层成波次；同一波内任务并发执行。
- **git worktree 隔离** —— 每个 lane 在独立 worktree 中工作，结果合并进 `taskswarm/orch`
  集成分支。
- **任务包** —— 每任务 `PROMPT.md`（任务 / 步骤 / 约束）+ `STATUS.md`（进度）；步骤边界自动
  检查点提交。
- **跨模型评审** —— 独立评审 agent 按 Review Level 打分；PASS 合并、REVISE 退回修订。
- **文件邮箱** —— worker ↔ supervisor 异步通信（notify / escalate / request）。
- 在真实 DSH 进程内验证：真实 LLM worker 并行运行（deepseek-v4-flash）、检查点提交、
  合并进 `taskswarm/orch`。

[0.2.24]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.23...v0.2.24
[0.2.23]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.22...v0.2.23
[0.2.22]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.21...v0.2.22
[0.2.21]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.20...v0.2.21
[0.2.20]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.19...v0.2.20
[0.2.19]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.18...v0.2.19
[0.2.18]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.14
[0.2.13]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.13
[0.2.12]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.11
[0.2.10]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.10
