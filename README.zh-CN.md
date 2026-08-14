# TaskSwarm（布局）

**DeepSeek Harness 上的多智能体任务编排插件** —— 把一批任务按依赖排成波次，让多个 AI worker 在相互隔离的环境里并行执行，再自动评审、合并产出。

> 布局（围棋术语）：落子前先摆全局，再让棋子在各自位置并行推进——正是这个项目做的事：**先规划波次、再并行执行**。

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

## 快速开始

### 1. 安装（三选一）

```bash
# npm registry
dsh plugin --profile web add dsh-taskswarm

# GitHub
dsh plugin --profile web add https://github.com/february2015/taskswarm.git

# 本地目录（开发/离线）
git clone https://github.com/february2015/taskswarm.git && cd taskswarm
npm install && npm run build
dsh plugin --profile web add $(pwd)
```

安装后**重启 dsh web**，插件即生效。

### 2. 初始化示例任务

```
/taskswarm-init        # 生成两个示例任务包（EXAMPLE-001 / EXAMPLE-002）
```

### 3. 预览波次计划（不执行）

```
/taskswarm-plan all    # 展示任务按依赖排成的波次
```

### 4. 启动批次

```
/taskswarm all         # 并行执行所有任务；也可以指定任务：/taskswarm EXAMPLE-002
/taskswarm-status      # 随时查看进度
```

### 5. 看 Dashboard

启动批次（`/taskswarm`）会**自动启动 dashboard 并把链接打印在会话里**，波次执行期间
随时可看进度。手动控制仍然可用：

```bash
# DSH 会话内（supervisor 命令）
/taskswarm-dashboard

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
| **Supervisor** | 规划波次、调度 lane、处理事件、与你对话（你发起 `/taskswarm` 的会话即 supervisor） |
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
| `/taskswarm [scope]`                | 启动批次（scope: `all` / 任务 ID / 路径） |
| `/taskswarm-plan [scope]`           | 预览波次计划与依赖图（不执行）                 |
| `/taskswarm-status`                 | 查看当前批次 / lane 进度                |
| `/taskswarm-pause` / `/taskswarm-resume` | 当前波次结束后暂停 / 恢复                  |
| `/taskswarm-abort`                  | 当前波次结束后中止（并终止运行中 lane）          |
| `/taskswarm-deps [scope]`           | 查看依赖图                           |
| `/taskswarm-sessions`               | 列出活跃 lane 及其 worktree           |
| `/taskswarm-integrate`              | 把 `taskswarm/orch` 合并进当前工作分支         |
| `/taskswarm-dashboard`              | 启动 Web Dashboard                |
| `/taskswarm-init [ID]`              | 生成示例任务包                         |

> 兼容别名：`/orch`、`/orch-status` 等 `/orch-*` 命令等价。

## 项目状态

**开发中（v0.1）** —— 核心引擎与命令层已实现并通过测试（`npm install && npm run build && npm test`，9/9），且已在真实 DSH 进程中真机验证：

- ✅ core 单元测试 + 引擎集成测试（并行 wave + worktree 隔离 + orch 合并）
- ✅ 真实 LLM worker 并行执行（deepseek-v4-flash），检查点提交 + 合并进 `taskswarm/orch`
- ✅ 对话式 supervisor：事件唤醒 + 定时检查（卡住检测）+ 文字指令控制
- ✅ Web Dashboard 真机验证（localhost 多实例、端口自动避让）
- ✅ Dashboard 的 Lanes & Tasks 列表只显示当前执行 Wave 及已执行 Wave 内的 lane，未到 Wave（未来 wave）的 lane 不展示（`renderLanesTasks` 按 `wavePlan`/`currentWaveIndex` 过滤；批次全部终态时展示全部供回放）
- 📋 待办：上述 Dashboard 功能开发完成后，把本机安装从「本地目录 link 安装」（`dsh plugin add $(pwd)`）切换为 npm 安装（`dsh plugin add taskswarm`），让本地执行环境与本地源代码完全独立——当前 link 安装下二者是同一份文件，改代码即改安装（需 `npm run build` + 重启 dsh web 才生效）
- 📋 待办：supervisor 的定时状态上报与定时汇报（及给用户的状态汇报）中，附带每个 Lane/任务的执行进度「已完成步数/总步数」（如 3/5）——让用户随时知道每个任务一共多少步、执行到哪一步

## 文档

- **[运维手册（Runbook）](docs/runbook.zh-CN.md)** —— 清理残留 / 错误恢复 / 工作抢救的标准作业程序（supervisor / AI 代理必读）
- **[发布手册（Release）](docs/release.zh-CN.md)** —— npm 发布、版本号管理、2FA bypass token 的坑（维护者用）
- **[已知问题（Known Issues）](docs/known-issues.zh-CN.md)** —— 已修复问题的根因分析与修复记录

## 许可与致谢

- **MIT License**，可自由使用、修改、分发
- 上游 **TaskPlane**（[github.com/HenryLach/taskplane](https://github.com/HenryLach/taskplane)）：波次编排、任务包、mailbox、supervisor 的原始设计，本项目的原生移植
- 运行环境：[DeepSeek Harness (DSH)](https://github.com/deepseek-ai)
