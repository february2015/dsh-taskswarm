# 更新日志（Changelog）

**dsh-taskswarm（TaskSwarm 蜂群）** 的所有重要变更记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)；本项目使用
[语义化版本](https://semver.org/lang/zh-CN/)。English version: [CHANGELOG.md](CHANGELOG.md)。

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

[0.2.15]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.14
[0.2.13]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.13
[0.2.12]: https://github.com/february2015/dsh-taskswarm/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.11
[0.2.10]: https://github.com/february2015/dsh-taskswarm/releases/tag/v0.2.10
