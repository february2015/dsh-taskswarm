# TaskSwarm（蜂群）

**DeepSeek Harness 上的多智能体任务编排插件** —— 把一批任务按依赖排成波次，让多个 AI worker 在相互隔离的环境里并行执行，再自动评审、合并产出。

> 蜂群（自然隐喻）：蜂后指挥全局，工蜂各自埋头推进自己的任务，成百上千个个体并行协作——正是这个项目做的事：**supervisor 先规划波次，worker 再在自己的 lane 里并行执行**。

- **License:** MIT
- **上游:** [TaskPlane](https://github.com/HenryLach/taskplane)（Pi 生态多智能体编排）—— 本项目的原生移植
- **English:** [README.md](README.md)

## 核心特性

- **Waves / Lanes 并行编排** —— 按依赖 DAG 把任务排成波次，每波任务并行执行；依赖关系自动分层
- **Git worktree 隔离** —— 每个任务（lane）在独立 git worktree 里工作，互不干扰，产物通过 `taskswarm/orch` 集成分支合并
- **任务包（Task Packets）** —— 每个任务 = `PROMPT.md`（使命/步骤/约束）+ `STATUS.md`（进度），持久记忆，worker 能扛过上下文重置
- **检查点纪律** —— 步骤边界自动 git commit；worker 崩溃不丢已完成的活
- **跨模型评审（Reviewer）** —— 独立 reviewer 按任务 `Review Level` 评审产出，PASS 才合并，REVISE 打回修订
- **文件邮箱（Mailbox）** —— worker ↔ supervisor 异步通信（notify / escalate / request），不依赖共享上下文
- **对话式 Supervisor** —— 与你共享会话：wave 完成、lane 失败、批次完成自动汇报；可指挥它 start / pause / abort / integrate / 开 dashboard；通知与提示词**中英双语**（"用英文汇报"即可切换，自动按你的会话语言判断，写入 `.taskswarm/config.json` 跨重启生效）
- **Web Dashboard** —— 本地实时仪表盘，零依赖 node:http + SSE，多仓库多实例、端口自动避让。**启动批次时自动拉起并打印链接到会话**——同一工作区始终只有一个 dashboard 实例（已运行的会被复用，绝不重复拉起）
- **崩溃可恢复** —— 磁盘状态持久化 + 检查点 + lane 分支保留，进程被杀/重启后可抢救产物、清理残留、重跑
- **orch 基线 lane** —— 每个 lane 工作树从 `taskswarm/orch` 集成 HEAD 创建，直接继承此前全部已合并产物，不重造共享代码
- **任务包校验** —— `/tswarm-check` + `npm run check:tasks` 让坏格式任务包（ID 缺连字符、缺步骤/验收标准）报出可操作原因，不再静默跳过
- **LLM merge agent** —— lane 并入 `taskswarm/orch` 冲突时，独立 merger agent 在 orch worktree 内语义化解冲突；无法解决时 lane 进入 `conflict` 态并暂停批次等 supervisor 处置

## 为什么用 TaskSwarm，DSH 不是已经有 subagent 了吗？

DSH 原生 `subagent` / `workflow` / `goal` 是**会话式、一次性**调度——适合临时委派。TaskSwarm 是架在其上的**项目级编排层**：

| | DSH 原生 subagent | TaskSwarm |
| ------------- | --------------------------------- | ------------------------------- |
| 任务形态 | 聊天里一句话 | **任务包**（PROMPT.md / STATUS.md）——可版本化、可批量、可复用 |
| 并行度 | 手动 | **波次规划**：按依赖拓扑分波、每波并行 lane |
| 隔离 | 共享工作区（写文件会冲突） | **git worktree 隔离**：每 lane 独立分支 + 检查点，合并进 `taskswarm/orch` |
| 质量门 | 无 | **独立 Reviewer**（PASS / REVISE） |
| 可恢复 | 进程结束即消失 | **持久批次状态**（`.taskswarm/batches/*.json`）：重启 / resume / 跳过已完成 lane |
| 可观测 | 盯着聊天 | **supervisor 事件汇报 + Web Dashboard**，批次启动自动拉起、链接打印到会话 |

## 快速开始

### 1. 安装（三选一）

```bash
# npm registry
dsh plugin --profile web add dsh-taskswarm

# GitHub
dsh plugin --profile web add https://github.com/february2015/dsh-taskswarm.git

# 本地目录（开发/离线）
git clone https://github.com/february2015/dsh-taskswarm.git && cd dsh-taskswarm
npm install && npm run build
dsh plugin --profile web add $(pwd)
```

安装后**重启 dsh web**，插件即生效。

> **升级已装的版本**：`dsh plugin --profile web add dsh-taskswarm` 对已满足依赖范围的旧版会报 "Already up to date" 不升级；要拉新版本需显式指定：`dsh plugin --profile web add dsh-taskswarm@<新版本>`（或在该 profile 目录 `pnpm update --latest`），然后重启 dsh web。

### 2. 初始化示例任务

```
/tswarm-init        # 生成两个示例任务包（EXAMPLE-001 / EXAMPLE-002）
```

### 3. 预览波次计划（不执行）

```
/tswarm-plan all    # 展示任务按依赖排成的波次
```

### 4. 启动批次

```
/tswarm all         # 并行执行所有任务；也可以指定任务：/tswarm EXAMPLE-002
/tswarm-status      # 随时查看进度
```

### 5. 看 Dashboard

启动批次（`/tswarm`）会**自动启动 dashboard 并把链接打印在会话里**，波次执行期间
随时可看进度。手动控制仍然可用：

```bash
# DSH 会话内（supervisor 命令）
/tswarm-dashboard

# 独立 CLI —— 安装插件后 bin 即在 PATH 上：
npx taskswarm-dashboard --root <仓库路径>

# 不安装、临时拉取（npm 发布后可用）：
npx --package dsh-taskswarm taskswarm-dashboard --root <仓库路径> [--port 8100] [--no-open]
```

> 同一工作区只保留一个 dashboard：若该仓库已有实例在跑（手动启动或上次会话残留），
> 会自动探测并复用，不会拉起第二个。

## 工作原理

TaskSwarm 编排 **4 类角色**：

| 角色             | 职责                                                  |
| -------------- | --------------------------------------------------- |
| **Supervisor** | 规划波次、调度 lane、处理事件、与你对话（你发起 `/tswarm` 的会话即 supervisor） |
| **Worker**     | 每个任务一个 DSH agent，在隔离的 lane worktree 里逐步推进任务包        |
| **Reviewer**   | 独立 agent 评审 worker 产出，给出 PASS / REVISE              |
| **Merger**     | lane 完成后自动把产物合并进 `taskswarm/orch` 集成分支                   |

**Git 模型：**

```
taskswarm/orch            ← 集成分支：所有 lane 产物汇总（常驻，勿手动删除）
taskswarm/<taskId>        ← 每个 lane 的工作分支（含步骤检查点 commit，合并后自动删除）
```

**持久状态**（`<repo>/.taskswarm/`）：

```
.taskswarm/batches/<batchId>.json   # 批次唯一权威状态（phase + lanes）
.taskswarm/mailbox/<batchId>/       # agent 间消息
.taskswarm/worktrees/_orch/         # 集成分支 worktree
.taskswarm/worktrees/<taskId>/      # 各 lane 的隔离 worktree
```

## 命令参考

| 命令                             | 作用                              |
| ------------------------------ | ------------------------------- |
| `/tswarm [scope]`                | 启动批次（scope: `all` / 任务 ID / 路径） |
| `/tswarm-plan [scope]`           | 预览波次计划与依赖图（不执行）                 |
| `/tswarm-status`                 | 查看当前批次 / lane 进度                |
| `/tswarm-pause` / `/tswarm-resume` | 当前波次结束后暂停 / 恢复                  |
| `/tswarm-abort`                  | 当前波次结束后中止（并终止运行中 lane）          |
| `/tswarm-deps [scope]`           | 查看依赖图                           |
| `/tswarm-sessions`               | 列出活跃 lane 及其 worktree           |
| `/tswarm-integrate`              | 把 `taskswarm/orch` 合并进当前工作分支         |
| `/tswarm-dashboard`              | 启动 Web Dashboard                |
| `/tswarm-init [ID]`              | 生成示例任务包                         |

> 兼容别名：`/orch`、`/orch-status` 等 `/orch-*` 命令等价。

## 热更 / HMR 行为

- **配置热更**：TaskSwarm 是标准 DSH bundle，配置在 profile 的 `cordis.patch.yml` 中覆盖后由 DSH 热重载、无需重启。**但注意**：orchestrator 插件被重载时（例如修改它的配置行），卸载清理会 **abort 当前运行中的所有批次**——批次运行期间请勿修改 orchestrator 配置。
- **源码热更**：DSH 官方在 web profile 上未启用插件源码 HMR（`cordis-plugin-hmr` 默认禁用）；修改 TaskSwarm 源码需 `npm run build` 后**重启 dsh web** 生效。
- **批次可恢复**：即使重启，`.taskswarm/` 磁盘状态 + 检查点 + lane 分支都会保留；重启后可用 `/orch-status` 查看，并通过 supervisor 恢复或重跑失败 lane，不丢已完成工作。

## 与 dsh-dingo 配合

TaskSwarm 向其它 DSH 插件暴露标准 Cordis 服务：

```ts
const taskswarm = ctx.get('taskswarm')
const { batches } = taskswarm.getSnapshot()
```

每个 batch 都带有 `ownerSessionId`，所以像 [dsh-dingo](https://github.com/february2015/dsh-dingo) 这样的插件可以在主对话卡片上显示“等待后台/子任务/蜂群”状态，只要批次还在跑。

这样你就能在 dsh-dingo 的卡片面板里直接看到：

> 主对话已经完成，但蜂群还在跑，还没有真正交付。

## 文档

- **[运维手册（Runbook）](docs/runbook.zh-CN.md)** —— 清理残留 / 错误恢复 / 工作抢救的标准作业程序（supervisor / AI 代理必读）
- **[发布手册（Release）](docs/release.zh-CN.md)** —— npm 发布、版本号管理、2FA bypass token 的坑（维护者用）
- **[已知问题（Known Issues）](docs/known-issues.zh-CN.md)** —— 已修复问题的根因分析与修复记录
- **[更新日志（Changelog）](CHANGELOG.zh-CN.md)** —— 逐版本更新说明（English: [CHANGELOG.md](CHANGELOG.md)）

## 许可与致谢

- **MIT License**，可自由使用、修改、分发
- 上游 **TaskPlane**（[github.com/HenryLach/taskplane](https://github.com/HenryLach/taskplane)）：波次编排、任务包、mailbox、supervisor 的原始设计，本项目的原生移植
- 运行环境：[DeepSeek Harness (DSH)](https://github.com/deepseek-ai)
