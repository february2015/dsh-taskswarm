# Buju（布局）

多智能体任务编排插件，原生运行在 **DeepSeek Harness (DSH)** 上。

> 布局（围棋术语）：落子前先摆全局，再让棋子在各自位置并行推进——正是这个项目做的事：**先规划波次、再并行执行**。

- **GitHub:** https://github.com/february2015/dsh-buju.git
- **上游:** [TaskPlane](https://github.com/HenryLach/taskplane)（Pi 生态多智能体编排，MIT License）——本项目的原生移植
- **License:** MIT

## 这是什么

把 TaskPlane（idea → spec → 任务包 → 编排 → 评估）的能力搬进 DSH：

- **任务包**：每个任务 = `PROMPT.md`（使命/步骤/约束）+ `STATUS.md`（进度），持久记忆，worker 能扛过上下文重置
- **Waves / Lanes**：按依赖 DAG 排成波次，每波的任务在 git worktree 隔离的 lane 里并行执行
- **4 类角色**：supervisor（/orch 命令 + 引擎）、worker（DSH agent）、reviewer（跨模型评审）、merger（自动并入 orch 分支）
- **文件邮箱**：agent 间通过 mailbox 异步通信（notify / escalate / request）
- **检查点纪律**：步骤边界 git commit，worker 崩溃不丢活
- **状态可见**：`/orch-status` 实时查看 batch / lane 进度（后续可接 Web 仪表盘）

## 目录结构

```
dsh-buju/
├── src/
│   ├── core/            # 移植的编排核心（git/naming/mailbox/task/discover/worktree/status）
│   ├── orchestrator/    # /orch 系列命令 + 波次/泳道引擎 + worker 宿主
│   └── worker/          # worker bundle：启动器 + runner + 4 个桥接工具
├── templates/tasks/     # 任务包模板
├── cordis.patch.yml     # DSH bundle patch（挂载 orchestrator 插件）
└── tests/               # node:test 集成测试
```

## 状态

**开发中（v0.1）**——核心引擎与命令层已实现并通过测试，且已在**真实 DSH 进程中真机验证**：

```
npm install && npm run build && npm test
# 9/9 通过：core 单元测试 + 引擎集成测试（2 任务并行 + 依赖波次 + worktree 隔离 + orch 合并）+ 插件冒烟测试
```

| 模块                                                      | 状态                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| core（git/naming/mailbox/task/discover/worktree/status）  | ✅ 测试通过                                                                                                 |
| engine（waves/lanes + 状态持久化）                             | ✅ 集成测试通过（并行性已验证）                                                                                       |
| /buju 命令（10 个，/orch 兼容别名）+ 4 个桥接工具                      | ✅ 注册冒烟测试通过                                                                                             |
| **真实 DSH 进程验证**（`dsh --profile buju-verify`，沙箱 profile） | ✅ 完整 batch 跑通：/buju-init → /buju-plan → /buju → /buju-status                                           |
| **真实 LLM worker**                                       | ✅ 2 个 worker 并行执行（deepseek-v4-flash），task_runner 逐步推进 + checkpoint 提交 + merge 进 `buju/orch`，产物文件内容验证通过 |
| 接入 web profile                                          | ✅ 已装入 bundles（重启 dsh web 后 /buju 在 GUI 会话可用）                                                           |
| **对话式 supervisor**（TaskPlane 移植）                        | ✅ 事件唤醒（wave/失败/完成）+ 定时检查（卡住检测）+ 定时汇报（按需开启）+ 文字指令控制（start/integrate/dashboard）                          |
| **Web Dashboard**（TaskPlane 移植）                         | ✅ 真机验证：localhost:8101 HTTP 200，/api/state 正常；多工作区多实例、端口自动避让                                            |

## 安装到 DSH

```bash
cd ~/myProject/dsh-buju && npm run build
# 1. orchestrator → web profile（已做；重启 dsh web 生效）
dsh plugin --profile web add ~/myProject/dsh-buju
#    ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 已追加 "dsh-buju"
# 2. 重启 dsh web 后，会话里：/buju-init → /buju all → /buju-status
```

> 默认 `host: in-process`（worker 为进程内 DSH agent，已验证）；`host: headless` 走 `dsh --profile buju-worker` 子进程（worker bundle 已就绪，见 `src/worker/`）。

## Web Dashboard

本地实时批次仪表盘（TaskPlane dashboard 移植，零依赖 node:http + SSE）。

```bash
# 方式 1：npm script
npm run dashboard -- --root <仓库路径>          # 默认端口 8100

# 方式 2：CLI 入口
npx buju-dashboard --root <仓库路径> [--port 8101] [--no-open]

# 方式 3：会话内命令（任意工作区）
/buju-dashboard                                  # 用当前会话 cwd 作为仓库根

# 方式 4：对话式（supervisor 文字指令）
"帮我开个 dashboard"                             # 由 supervisor 调用 buju_dashboard 工具启动
```

- **端口**：默认 8100；被占用时自动 +1 探测（最多 20 次，`findPort`），显式 `--port` 则只试指定端口
- **多工作区**：每个仓库独立实例，端口自动错开（仓库 A→8100，仓库 B→8101…）
- **实时**：SSE（`/api/stream`）+ 2s 轮询 + `.buju/batches/` 文件变更即时推送
- **页面**：批次概览（waves/lanes 进度）、lane 详情（任务包 STATUS）、历史批次、主题切换
- 数据源为 `<repo>/.buju/batches/*.json` 与 `<repo>/tasks/`；无批次时显示空状态

### 与 supervisor 的配合

- 运行 `/buju`（或 `/orch`）后，会话 agent 成为对话式 supervisor：wave 完成、lane 失败、batch 完成会自动汇报（`[Buju supervisor]` 消息）
- 定时汇报：说"每隔 5 分钟汇报一次"即可开启；定时检查（卡住检测）默认开启
- 文字指挥：说"启动 WEB-006"、"开 dashboard"、"跑完 integrate" 由 supervisor 调工具执行
