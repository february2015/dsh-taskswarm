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

**开发中（v0.1）**——核心引擎与命令层已实现并通过测试：

```
npm install && npm run build && npm test
# 9/9 通过：core 单元测试 + 引擎集成测试（2 任务并行 + 依赖波次 + worktree 隔离 + orch 合并）+ 插件冒烟测试
```

| 模块 | 状态 |
|---|---|
| core（git/naming/mailbox/task/discover/worktree/status） | ✅ 测试通过 |
| engine（waves/lanes + 状态持久化） | ✅ 集成测试通过（并行性已验证） |
| /orch 命令（10 个）+ 4 个桥接工具 | ✅ 注册冒烟测试通过 |
| worker bundle（headless runner + startup） | ✅ 编译通过，待真机验证 |
| 接入 DSH web profile | ⏳ 下一步（安装 + 重启后 /orch 可用） |

## 安装到 DSH（下一步）

```bash
cd ~/myProject/dsh-buju && npm run build
# 1. orchestrator → web profile
dsh plugin --profile web add ~/myProject/dsh-buju
#    在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 追加 "dsh-buju"
# 2. （headless worker 模式）worker profile
dsh --profile buju-worker                    # 首次自动初始化
#    在 ~/.dsh/profiles/buju-worker/package.json 设 bundles: ["@deepseek-ai/dsh-base"]
#    在 cordis.patch.yml 插入 dsh-buju/worker/startup + dsh-buju/worker/runner
dsh plugin --profile buju-worker add ~/myProject/dsh-buju
# 3. 重启 dsh web，会话里 /buju-init → /orch all → /orch-status
```

> 默认 `host: in-process`（worker 为进程内 DSH agent，无需额外 profile）；`host: headless` 走 `dsh --profile buju-worker` 子进程。
