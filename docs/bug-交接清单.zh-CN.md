# TaskSwarm 引擎 Bug 交接清单（2026-08-15）

> 仓库：`dsh-taskswarm`（本仓库）｜ 本文件为**唯一交接文档**——供另一位开发者（全新对话，无本会话上下文）
> 直接接手修复。现场证据位于 `/Users/robin/myProject/dsh-localvoice/.taskswarm/`（dsh-localvoice 项目批次现场，2026-08-15）。
> 三个 bug 均来自同一批次的运维观察：abort+restart 状态错乱、worker 进度显示滞后、merge 冲突处理竞态。

---

## 总览

| # | Bug | 严重度 | 状态 |
|---|---|---|---|
| B1 | abort 后立刻 start 的批次簿记错乱（状态写错文件、显示永远 0） | 高 | ✅ **已修复**（commit `92cf912`，v0.2.18；存档见 §1） |
| B2 | worker 不推进 STATUS/检查点 → 每 lane 百分比滞后、0→100% 跳变 | 中 | ❌ **未修复**（§2） |
| B3 | merge 冲突处理设计缺陷：失败即删分支 + merger 竞态 + 无"暂停等 supervisor" | 中 | ❌ **未修复**（§3） |

---

# §1. B1（已修复·存档）abort 后批次状态写入错乱

**修复 commit**：`92cf912`（abortWaiter 中断在途 worker + runLane 查 abort + updateLane 终态防御 +
execute 波次写回尊重磁盘终态 + run() 并发保护），已发布 **0.2.18**（`npm run build` 通过、30/30 测试含 2 个新回归）。
**生效前提**：重启 dsh web 后旧引擎退出、新引擎加载。

以下为修复前现象（存档，供理解设计）：
- 对同一仓库 `abort` 后立刻 `start`：新批次状态文件（如 `b-msu3g6en-4c5aec.json`）创建后 mtime 不再变化、
  lane 永远 `running ['starting T-x']`，显示永远 "0 lanes done"；而旧（已 abort）批次文件被事后续写
  （abort 于 16:02，旧文件 mtime 变 16:30，出现新执行的 `T-7 merged`）。
- 根因：`abort()` 只置标志+杀 worker+删 worktree，不取消在途 `execute()` 的 `Promise.all(runLane)`；
  `runLane` 不查 abort，abort 后仍重建 worktree、spawn 新 worker，跑完用旧 batchId 写进旧文件；
  `run()` 无并发保护（引擎按 repo 单例缓存），旧 execute 未收尾时新批次照常启动 → 双执行并发抢同一批路径；
  `updateLane` 不校验批次终态，aborted 文件可被续写。
- 附带现象：supervisor 收到迟到的旧批次 wave 事件、重复的 lane 失败通知（见 §3 竞态加剧此问题）。

---

# §2. B2（未修复）worker 不推进 STATUS/检查点 → 进度显示滞后

## 症状

dashboard / `/tswarm-status` 的**每 lane 百分比**（= `tasks/<ID>/STATUS.md` 里 `- [ ]` 勾选数 ÷ 总数）
与实际代码进度严重脱节：

1. 运行中百分比长时间停在低值：T-6 实际代码早已全部写完（一次提交 `581867d` 覆盖 FR-4.1~4.9、17 个文件），
   STATUS.md 却只勾 1/7（14%），直到收尾才批量补勾跳到 100%；
2. **0 → 100% 跳变**：T-7 全程不调用 `task_runner advance`，一口气写完（256 测试通过）再直接 `done`，
   进度显示没有任何中间值；
3. **worker 直接改写 STATUS.md 绕过 advance 工具**：T-7 worker 认为 "task_runner says task has no steps"
   （误读格式），改为手写 STATUS.md 为 ✅；
4. **无增量检查点提交**：T-6/T-7 的 lane worktree 完成前没有 commit（改动攒到最后一次提交），
   崩溃/中断时进度与产物只能靠最后一次提交抢救。

## 根因

1. `src/worker/lane-tools.ts` 的 `buildWorkerMission` 只说 "Drive the task with the task_runner tool:
   advance … done"，**没有硬性要求每完成一个 checkbox 就 advance（该调用自动做检查点 commit）**；
   worker（LLM）倾向于攒批处理。
2. 引擎看门狗（`laneTimeoutMinutes`）只防"完全失联"，不防"一直在干活但不推进 STATUS"。
3. `tasks/<ID>/STATUS.md` 是普通文件，worker 可绕过 `task_runner` 手改；引擎只按最终 STATUS 判定 done，
   不校验变更来源。
4. dashboard 百分比只读 STATUS checkbox，无备用数据源（如按检查点 commit 数）。

## 修复建议（按性价比排序）

1. **worker mission 强化**（`lane-tools.ts` `buildWorkerMission`）：硬性规则——"每完成一个 checkbox
   立即 `task_runner advance`（该调用会自动做检查点 commit）；禁止攒批到最后统一勾选；`done` 只允许
   在全部 Completion Criteria 满足后调用"。
2. **看门狗补充"advance 停滞"检测**：`runLaneWorker` 除总超时外，增加"距上次 advance/检查点 commit
   超过 N 分钟仍在 running"的提醒；`supervisor.ts` 的 stalled 指纹可加 STATUS 变化。
3. **STATUS 变更来源校验（可选）**：lane 结束时对比 STATUS 勾选与 Execution Log（advance 记录），
   无对应 advance log 的勾选记 warning（不做硬失败）。
4. **进度显示加兜底数据源（可选）**：STATUS 停滞时叠加"检查点 commit 数 / 总步数"作为参考进度。

## 代码位置

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/worker/lane-tools.ts` | `buildWorkerMission` | worker 任务书（缺逐步 advance 硬性要求） |
| `src/worker/lane-tools.ts` | `task_runner`（advance/done） | 工具本身正常，问题在"不调用" |
| `src/core/task.ts` | `advanceStep` / `markTaskDone` | 工具侧无需改 |
| `src/orchestrator/engine.ts` | `runLaneWorker` 看门狗 | 只有总超时，无 advance 停滞检测 |
| `src/orchestrator/supervisor.ts` | stalled 检测 | 现用 `taskId:phase` 指纹 |
| dashboard | 每 lane 百分比 | 只读 STATUS checkbox |

---

# §3. B3（未修复）merge 冲突处理设计缺陷：失败即删分支 + merger 竞态 + 无暂停等 supervisor

## 症状（本次实测）

T-6 merge 失败流程产生了**两条失败通知**：

1. **第一条**（~16:40）：`mergeLane` 执行 `git merge taskswarm/t-6` → index.ts/rpc.ts 冲突失败 →
   `mergeLane` 失败清理**立即删除 `taskswarm/t-6` 分支** → lane failed → 通知；
2. 引擎随即 **spawn LLM merger agent**（10 分钟窗口）去语义化解冲突；
3. supervisor（人工）在 16:44 **手工并集修复并提交**（`e9fe0b5`）——**与在途 merger 撞车**；
4. **第二条**（~16:50）：merger agent 结束时发现 `taskswarm/t-6` 分支已被删（第 1 步清理）→
   它执行 `git merge taskswarm/t-6` → git 报 **"merge: taskswarm/t-6 - not something we can merge"**
   → 引擎记为第二次失败 → **第二条通知**（实为"僵尸失败"，T-6 产物实际已安全并入 orch）。

## 根因

1. **`mergeLane`（`src/core/worktree.ts`）失败即删 lane 分支**，但 merger agent 的 mission
   （`src/worker/merger.ts` `buildMergePrompt`）却让它对**该分支**执行 merge 语义解析——分支已不存在，
   merger 必然拿到 "not something we can merge"。**分支应保留到解决尘埃落定**（merger 或 supervisor
   完成后再清）；merger 应只基于 orch 里的冲突现场（MERGE_HEAD + 未合并索引）工作。
2. **merge 冲突不"暂停等 supervisor"**：引擎只发通知、lane 已 failed、批次照跑；supervisor 手工介入时
   与在途 merger **竞态** → 重复/迟到通知、状态混乱（叠加 B1 未重启时更严重）。
3. `mergeLane` 的失败清理（`branch -D`）与 merger 的启动顺序本身就有矛盾（先删分支、再让 merger 用分支）。

## 修复建议

1. **失败保留分支**：`mergeLane` 冲突失败后**不删** `taskswarm/<taskId>` 分支（保留现场供 merger/人工），
   只在 merge **成功**或人工确认后再清理；
2. **merger 基于冲突现场而非分支 ref**：merger mission 明确"在 orch worktree 的未完成 merge
   （MERGE_HEAD 存在）上工作，禁止对 `laneBranch` 再执行 `git merge`"；
3. **冲突进入"待处理"态而非自动续跑**：merge 冲突（或 merger 失败）时 lane 置为需 supervisor 处置的
   明确状态（可复用 review 态的语义或新增），**批次暂停该 lane 并征求 supervisor 处置**（修复 or 重跑），
   不再后台自动重试，避免与人工竞态；
4. **重复通知防御**：同一 lane 的 merge 结果只发一次事件（或对已 failed 的 lane 忽略后续 merge 结果）。

## 代码位置

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/core/worktree.ts` | `mergeLane` | 失败即 `branch -D`（应先保留分支） |
| `src/orchestrator/engine.ts` | `serializedMerge`（约 L381-410） | merge 失败 → spawn merger；结果透出 |
| `src/worker/merger.ts` | `buildMergePrompt` | mission 未禁止对 laneBranch 再 merge |
| `src/orchestrator/engine.ts` | runLane 失败分支 | 冲突后 lane 直接 failed，无"待 supervisor"态 |

---

## 附：本清单的由来（现场速查）

- 批次：dsh-localvoice `b-msu3g6en-4c5aec`（T-4/T-6/T-7 并行）与前一批次 `b-msu0oo9b-dc565b`（abort）。
- 关键证据文件：`.taskswarm/batches/*.json`（两个文件 mtime 对比）、`tasks/T6/STATUS.md`（1/7→7/7）、
  worker 会话日志（`~/.dsh/sessions/--Users-robin-myProject-dsh-localvoice-.taskswarm-worktrees-t-*--/`）。
- 已落地的同类改进（非 bug，预防性）：lane 基线改为 `taskswarm/orch` HEAD（commit `44c5b88`，v0.2.13 起）、
  `/tswarm-check` 任务包校验（`9894f52`）。
