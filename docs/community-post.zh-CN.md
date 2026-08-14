# TaskSwarm（蜂群）— DeepSeek Harness 上的波次式多智能体任务编排插件

> 蜂群（自然隐喻）：蜂后指挥全局，工蜂各自埋头推进自己的任务，成百上千个个体并行协作——正是这个项目做的事：**supervisor 先规划波次，worker 再在自己的 lane 里并行执行**。

**TaskSwarm（蜂群）** 是 [TaskPlane](https://github.com/HenryLach/taskplane)（MIT）在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 上的原生移植。把一批任务按依赖排成**波次**，让多个 AI worker 在 git worktree 隔离的环境里**并行执行**，再自动**评审、合并**产出。

## 安装

```bash
dsh plugin --profile web add dsh-taskswarm
# 重启 dsh web 后，会话里：
/tswarm-init        # 生成两个示例任务包
/tswarm all         # 所有任务按波次并行执行
/tswarm-status      # 随时查看进度
```

兼容别名：`/orch`、`/orch-status` 等仍然可用。

## DSH 已经有 subagent 了，为什么还要 TaskSwarm？

DSH 原生的 `subagent` / `workflow` / `goal` 是**会话内的一次性调度**——适合随手小委托。TaskSwarm 是在它们之上的一层**项目级编排**：

|      | DSH 原生 subagent | TaskSwarm（蜂群）                                              |
| ---- | --------------- | ---------------------------------------------------------- |
| 任务形态 | 对话里一句话          | **任务包文件**（PROMPT.md/STATUS.md）——可版本管理、可批量、可复用              |
| 并行模型 | 手动逐个委托          | **波次调度**：按依赖拓扑分层，同波 lane 并行                                |
| 工作隔离 | 共享工作区（写文件互相踩）   | **git worktree 隔离**：每 lane 独立分支+检查点，产物合并进 `taskswarm/orch` |
| 质量门禁 | 无               | **独立 Reviewer 评审**（PASS / REVISE）                          |
| 可恢复性 | 进程结束=任务蒸发       | **批次状态持久化**（`.taskswarm/batches/*.json`），重启可续跑、跳过已完成 lane  |
| 可观测  | 只能看对话           | **Supervisor 事件汇报 + Web Dashboard**，批次启动自动拉起并打印链接          |

## 亮点

- **波次并行执行**——几十个任务分波跑，不会一拥而上，也能按依赖自动分层
- **对话式 Supervisor**——与你共享会话：wave 完成、lane 失败、批次完成自动汇报；可文字指挥 `start` / `pause` / `abort` / `integrate`；通知中英双语
- **Web Dashboard**——本地实时看板（零依赖 node:http + SSE）；**批次启动时自动拉起并把链接打印到会话**；同一工作区始终只有一个实例
- **跨模型评审**——Reviewer agent（可配不同模型）给每个 lane 把关
- **Lane 看门狗**——失联/卡死的 worker 会被强制收尾，wave 继续推进，不假死

## 链接

- npm：<https://www.npmjs.com/package/dsh-taskswarm>
- GitHub：<https://github.com/february2015/dsh-taskswarm>
- 文档：仓库内 `docs/runbook.zh-CN.md` · MIT License · 上游 [TaskPlane](https://github.com/HenryLach/taskplane)
