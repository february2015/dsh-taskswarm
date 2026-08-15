# TaskSwarm 运维手册（Runbook）

> 本手册是 **supervisor / AI 代理 / 人类 operator** 操作 TaskSwarm 批次的标准作业程序（SOP）。
> 目标是：任何安装本工具的人（或 AI）遇到以下场景，都能按步骤诊断、处置、恢复，且不丢活。
> 
> 覆盖三大类：
> 
> - **日常运维**（Part A）：安装/构建/生效、任务包操作、执行期监控
> - **异常处置**（Part B）：清理残留、错误恢复、工作抢救
> - **参考**（Part C）：动作分类、波次依赖语义、known-issues 关联
> 
> 所有命令以仓库根为 cwd（如 `~/myProject/tswarm`）。动作分类（diagnostic /
> tier0_known / destructive）与 supervisor 自主度规则一致，见 §9。

---

# Part A 日常运维

## 1. 状态模型速览（先看懂状态，再动手）

TaskSwarm 的**唯一权威状态**是磁盘上的 `.taskswarm/`，不是内存。进程重启后引擎内存态清空，
只剩磁盘态——所以一切恢复都从读 `.taskswarm/` 开始。

```
<repo>/
├── .taskswarm/
│   ├── batches/<batchId>.json   # 批次唯一权威状态（phase + lanes[]）
│   ├── mailbox/<batchId>/       # agent 间异步消息（supervisor/inbox、<lane>/outbox、broadcast）
│   └── worktrees/
│       ├── _orch/               # taskswarm/orch 集成分支的常驻 worktree（引擎基础设施，勿删）
│       └── <taskId>/            # 每个 lane 的隔离 worktree
├── tasks/<ID>-<slug>/
│   ├── PROMPT.md                # 任务使命/步骤（分界线以上不可变）
│   ├── STATUS.md                # worker 持有：**Status:** 状态行 + Execution Log
│   ├── .DONE                    # merged 时由引擎创建（有它 = 该任务已完成，默认不再被扫描）
│   └── .reviews/                # reviewer 结论文件（内容含 PASS / REVISE）
└── .git/                        # index.lock 等锁文件
```

**批次 phase**：`planning → running → paused → aborted | complete`
**lane phase**：`pending → running → review（REVISE）→ merged | failed`（另有 `skipped`）

**git 分支约定**：

| 分支              | 角色                             | 生命周期                           |
| --------------- | ------------------------------ | ------------------------------ |
| `taskswarm/orch`     | 集成分支，所有 lane 产物汇总于此            | 常驻，引擎自动创建，**勿删**               |
| `taskswarm/<taskId>` | 单个 lane 的工作分支（检查点 commit 都在上面） | merge 成功后被删；失败/abort/崩溃时**残留** |

> **lane 基线机制**：新 lane 从 `taskswarm/orch` HEAD 建分支（`worktree add -b <branch> <dir> taskswarm/orch`）——
> 直接继承**此前所有已合并任务**的产物，不重造共享代码；续跑 lane 附着旧分支后引擎自动
> `git merge taskswarm/orch` 同步最新合并产物（冲突时 abort，由 worker 自行 merge）。
> worker 任务书也明确说明基线含 orch 产物，并提示需要更新时可自行 merge。

**关键机制**（代码依据 `src/core/worktree.ts`、`src/orchestrator/engine.ts`）：

- **检查点纪律**：worker 在步骤边界和退出时执行 checkpoint commit 到 `taskswarm/<taskId>`。
  进程崩溃不丢已 commit 的产物——这是抢救的根基。
- **重跑自动续接**：`createLaneWorktree` 若发现 `taskswarm/<taskId>` 分支已存在，会
  `git worktree add <branch> <dir>` **附着既有分支**而非新建（KI-004 修复）。
  所以重跑失败任务 = 从旧检查点继续，不是从零开始。
- **abort 语义**：协作式，在波次边界生效；会 kill 运行中 lane 并 `worktree remove` 所有
  lane worktree，但 **`taskswarm/<taskId>` 分支保留**（供排查/抢救）。
- **进程崩溃/重启**：引擎 `active` 内存表清空 → `pause / resume / abort` 全部变 no-op
  （"No running batch"）；磁盘态停在崩溃前一刻（可能 phase=running 但无引擎在跑）。

---

## 2. 日常操作速查表

| 场景                      | 判定方法                                     | 分类          | 标准动作                                       |
| ----------------------- | ---------------------------------------- | ----------- | ------------------------------------------ |
| 看批次状态                   | `/tswarm-status` 或读 `.taskswarm/batches/*.json` | diagnostic  | 直接查证，无需确认                                  |
| 看波次计划 / 依赖图             | `/tswarm-plan [scope]`、`/tswarm-deps`        | diagnostic  | 只读，直接做                                     |
| **任务包不生效 / 被跳过**        | `/tswarm-plan` 里看不到某任务、`/tswarm-check` 报解析失败 | diagnostic  | 先 `/tswarm-check` 看原因，再按 §4.2 格式修复，重跑 plan 验证 |
| 列活跃 lane 与 worktree     | `/tswarm-sessions`                         | diagnostic  | 只读，直接做                                     |
| 看 worker 会话日志 / mailbox | `~/.dsh/sessions/…`、`.taskswarm/mailbox/…`    | diagnostic  | §5.3 / §5.4                                |
| 开/关定时汇报                 | "每隔 X 分钟汇报一次"                            | tier0_known | `tswarm_supervisor_report_interval <N>`（0=关） |
| pause / resume          | phase=paused 或 running                   | tier0_known | `tswarm_supervisor_control pause/resume`     |
| 清 `.git/index.lock`     | `ls .git/index.lock`（确认无 git 进程）         | tier0_known | `rm .git/index.lock`                       |
| 重试失败的 merge             | lane error="merge failed: ..."           | tier0_known | 排查冲突后重试                                    |
| 改 src 后 GUI 不生效         | 行为还是旧的                                   | —           | `npm run build` + 重启 dsh web（§3.2）         |
| 新建任务包                   | tasks/ 下缺任务                              | —           | `/tswarm-init` 或按 §4.1 手写                    |
| 手动改任务状态 / 删 .DONE       | 状态与实际不符                                  | destructive | 确认后按 §4.4                                  |
| 删残留 lane 分支             | `git branch` 见 `taskswarm/<id>`               | destructive | 先验证并入 orch，再 `git branch -D`（§6.2）         |
| 删残留 worktree            | `git worktree list`                      | destructive | 先抢救未提交内容，再 `worktree remove --force`（§6.3） |
| 删 mailbox / 批次记录        | `ls .taskswarm/mailbox`、`.taskswarm/batches`       | destructive | `rm -rf`（见 §6.4/§6.5 取舍）                   |
| abort 批次                | phase=running                            | destructive | `tswarm_supervisor_control abort`            |
| integrate 到工作分支         | 批次完成后                                    | destructive | `tswarm_supervisor_control integrate`        |
| 修改 STATUS/.DONE/批次状态    | —                                        | destructive | 先征求 operator 确认                            |
| 进程崩溃/重启后恢复              | phase 卡 running、abort 报 no-op            | destructive | 按 §7.4 六步走                                 |

> 自主度规则（默认 supervised）：diagnostic / tier0_known 自动执行；destructive 先征求
> 一句确认。autonomous 全部自主；interactive 非诊断都要问。

---

## 3. 安装 / 构建 / 生效 / 配置

### 3.1 安装到 DSH

```bash
cd ~/myProject/tswarm && npm run build
dsh plugin --profile web add ~/myProject/tswarm   # 追加 taskswarm bundle 到 web profile
# 重启 dsh web 后，会话里 /tswarm-init → /tswarm all → /tswarm-status
```

卸载：`dsh plugin --profile web remove taskswarm`（同样需重启生效）。

> 发布到 npm / 版本号管理（维护者）：见 `docs/release.zh-CN.md`。

### 3.2 改动生效规则（常见误区）

- `src/` 代码改动（含 supervisor 提示词、工具行为）→ `npm run build` + **重启 dsh web
  进程**才生效；`tsc` 编译出的 bundle 在进程内，不热更新。
- `docs/`、`README.md` 等纯文档改动 → 无需构建。
- `tasks/` 任务包改动 → 实时生效（下次扫描/规划即见）。

### 3.3 配置项速查（`src/orchestrator/index.ts` Config）

| 配置                                     | 默认                                       | 说明                                                       |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `repoRoot` / `tasksRoot` / `stateRoot` | 会话 cwd / `<repo>/tasks` / `<repo>/.taskswarm` | 仓库、任务包、状态三根路径                                            |
| `host`                                 | `in-process`                             | `headless` 走 `dsh --profile taskswarm-worker` 子进程             |
| `workerModel` / `reviewerModel`        | 会话默认                                     | worker / reviewer 模型覆盖                                   |
| `includeDoneTasks`                     | false                                    | true 时连有 `.DONE` 的任务也扫描（重跑已完成任务）                         |
| `supervisorMode`                       | `supervised`                             | `off` / `interactive` / `supervised` / `autonomous`（自主度） |
| `supervisorCheckIntervalMs`            | 60000                                    | 定时检查间隔（1 分钟，只读零成本）                                       |
| `supervisorStalledMs`                  | 240000                                   | 卡住判定阈值（4 分钟无 lane 变化）                                    |
| `laneTimeoutMinutes`                   | 180                                      | 单 lane 看门狗超时（分钟）：worker 超时无完成事件 → 强制结束该 lane（failed）并继续下一 wave（KI-007 方案 B）。`0` = 禁用（不建议，退回"只能重启引擎"的假死态） |
| `locale`                               | `auto`                                   | supervisor 通知/提示词语言：`auto`（按会话语言检测）/ `zh-CN` / `en`。运行时可用文字切换并写入 `.taskswarm/config.json`（见 §3.5） |

### 3.5 仓库级配置文件（`.taskswarm/config.json`）

operator 用文字设置的运行时配置，持久化在 `<repo>/.taskswarm/config.json`，**跨重启生效**。
优先级：**config.json（运行时最新意图）> 插件 Config（安装方默认）> 内置默认**。

| 键 | 取值 | 设置方式（文字） |
|---|---|---|
| `locale` | `zh-CN` / `en`（`auto` 通过移除该键表达） | "用英文汇报" / "用中文" / "恢复自动" → `tswarm_supervisor_locale` 工具 |
| `reportIntervalMinutes` | 整数 ≥0（0=关） | "每隔 15 分钟汇报一次" → `tswarm_supervisor_report_interval` 工具 |

候选扩展键（设计槽位，引擎创建时读取）：`supervisorMode`、`workerModel`、
`reviewerModel`、`includeDoneTasks`。文件为 JSON 合并写，新增键不影响旧读者。

语言自动检测：`auto` 时读取发起批次会话的最近用户消息，CJK 占比启发式
（中文会话 → zh-CN，否则 → en；无信号兜底 zh-CN）。

### 3.4 多仓库 / 多工作区

- 每个仓库（repoRoot）一个独立 engine 实例 + 独立 dashboard 实例，端口自动避让
  （8100 起，被占 +1，最多 20 次探测）。
- 事件只回发给**发起该批次的会话**（batch owner），不会跨会话串消息。

---

## 4. 任务包操作（创建 / 格式 / 手动修正）

### 4.1 创建

- 快速示例：`/tswarm-init`（scaffold `EXAMPLE-001-hello-world`、`EXAMPLE-002-parallel-smoke`；
  传前缀如 `/tswarm-init WEB` 则生成 WEB-001/WEB-002）。
- 空项目时 `start all` 也会自动初始化示例任务（`autoInitIfEmpty`）。
- 手写：在 `tasks/` 下建 `<ID>-<slug>/` 目录，放 `PROMPT.md` + `STATUS.md`。

### 4.2 PROMPT.md 格式规范（**机器解析，严格**，`src/core/task.ts`）

> ⚠️ 这是**机器格式**，不是给人看的自然文档。格式不合规 = 该任务被**静默跳过**
> （`parsePrompt` 返回 null，`scanTasks` 直接 continue，plan/status 里根本看不到它）。
> 历史上最典型的事故：任务包按人类可读格式写（`# T1 xxx` / `## 目标` / `## 任务内容` /
> `## 验收标准`），8 个任务全被跳过而无人察觉。写完务必跑 `/tswarm-check` 或
> `npm run check:tasks` 自查。

```
# Task: <ID> — <名称>          ← 必须；ID 形如 [A-Z]+-\d+（如 T-1、VOICE-001）
                                  ⚠️ "T1" 没有连字符 → 不合法 → 整个包被跳过！
                                  ⚠️ 节标题是英文且精确匹配，中文节名（## 目标）不识别
**Size:** S | M | L | XL       ← 可选，缺省 M
## Review Level: 2             ← 可选，缺省 2
## Dependencies                ← 依赖（可多个）：
                                  `- T-1` 或 `**Requires:** T-1, T-2`
                                  ⚠️ ID 必须也是 [A-Z]+-\d+，写 "T1" 不会被识别
## Mission                     ← 任务说明（自由文本，可放背景/设计引用）
### Step 1: <标题>              ← 步骤必须是 "### Step N:" 开头（编号 1. 2. 3. 不识别）
- [ ] <待办项>                  ← 步骤下必须是 "- [ ]" checkbox 清单
## Completion Criteria          ← 验收项，"- [ ]" 清单（⚠️ 英文标题，不是"验收标准"）
## File Scope                   ← 可选，声明影响文件（"- path" 每行一个）
```

**常见坑速查**：

| 症状 | 原因 | 修法 |
|---|---|---|
| 任务在 plan 里消失 | 标题 ID 缺连字符（`# T1 xxx`）或没有 `# Task:` 标题 | 改 `# Task: T-1 — xxx` |
| 任务消失 / ID 乱 | 目录名没有 `<ID>-<slug>` 形态且标题无合法 ID | 目录改 `T-1-xxx`，或标题写合法 ID |
| worker 不动 / 状态不推进 | Mission 里没有 `### Step N:` + `- [ ]` | 改步骤为 `### Step N:` + checkbox |
| 永远不算完成 | 没有 `## Completion Criteria` | 加验收项 checklist |
| 依赖不生效 / 乱序成波 | Dependencies 节缺失或 ID 写法错 | 写 `- T-1`（连字符 ID） |
| 同波 merge 冲突 | 多任务改同一文件 | 用 File Scope 声明影响文件，共享文件注明"只追加不重构" |

**写完任务包后的自查清单**（每次新建/手改后必做）：
1. `npm run check:tasks`（或 DSH 会话里 `/tswarm-check`）→ 无"解析失败"，警告可接受；
2. `/tswarm-plan all` → 能看到你的任务、波次符合预期、无 "Unresolved dependency references"；
3. scope 命中：`start <文件夹名>` / `<ID>` 都能选中该任务。

- 依赖决定波次 DAG（§10）；未知依赖 ID 当作已满足并显示在 "Unresolved dependency references" 里，不阻塞计划；
- 执行期追加修订：写在分界线 `---` 以下的 `## Amendments (Added During Execution)`（分界线以上不可变）。

### 4.3 STATUS.md 字段（worker 持有，引擎/工具读取）

| 字段                  | 取值                                                                |
| ------------------- | ----------------------------------------------------------------- |
| `**Status:**`       | 🔵 Ready / 🟢 In Progress / 🟡 In Review / ✅ Complete / ❌ Blocked |
| `**Current Step:**` | 当前步骤名                                                             |
| `**Blocker:**`      | 可选，❌ 时填阻塞原因                                                       |
| `**Iteration:**`    | 迭代次数                                                              |
| Execution Log 表     | `                                                                 |

lane 结束时引擎判定：STATUS 是 ✅ 或 ❌（或存在 `.DONE`）才算"干完"，否则 lane 判 failed
（`task not marked done`）。`.DONE` 由引擎在 merged 时创建。

### 4.4 手动修正（destructive，需确认）

- **任务实际干完但没标记**：把 STATUS 状态行改为 ✅（或手动建 `.DONE`）后重跑判定。
- **误标完成想重跑**：删 `tasks/<ID>/.DONE` **并把 STATUS 状态行改回非 ✅**（只删 .DONE
  不够——解析时 ✅ 也算 done）。
- **整体跳过某任务**：不建议手改 phase；宁可 abort 后按 scope 只跑需要的任务。

---

## 5. 执行期监控与排查

### 5.1 卡住检测（默认开启，零成本）

- 每 60s 读一次状态（`checkIntervalMs`）；lane 的 `taskId:phase` 指纹 **4 分钟无变化**
  （`stalledMs`）**且**所有运行中 lane 的 worker 会话日志也超时 → 唤醒一次
  「疑似卡住」提醒。
- 会话日志仍在写 = worker 在干活（写大段代码时 lane 阶段不变），不误报。
- 收到提醒后：diagnostic 查证 lane 日志 → 判断继续等 / pause / abort。

### 5.2 定时汇报

- 默认关闭；operator 说"每隔 X 分钟汇报一次"即开启（`tswarm_supervisor_report_interval`）。
- 0 = 关闭；设置后第一个完整间隔才汇报，不立即触发。
- 间隔持久化到 `.taskswarm/config.json`（`reportIntervalMinutes`），**重启后仍生效**；文案随
  当前语言（`locale`）双语。

### 5.3 worker 会话日志（排查失败/卡住的现场）

worker 会话目录按 lane worktree 绝对路径转义命名：

```bash
ls ~/.dsh/sessions/--<worktree路径用-替换/>--/
# 例：--Users-robin-myProject-taskswarm-.taskswarm-worktrees-demo-006--
# 其下 session-*/session.jsonl(.zstd) 为完整对话/工具调用记录
```

### 5.4 mailbox 排查（worker 在说什么）

```bash
ls .taskswarm/mailbox/<batchId>/supervisor/inbox/      # 未处理消息
ls .taskswarm/mailbox/<batchId>/supervisor/ack/        # 已 ack 消息
# 每个文件是 json：{ from, type, payload }；type ∈ notify/escalate/request/broadcast/reply
```

- `escalate` = worker 求援（历史案例：缺工具 escalate，见 KI-002 现象）。
- 引擎批次结束时会 drain supervisor inbox；崩溃残留则原样保留，可作排查现场。

---

# Part B 异常处置

## 6. 清理残留（Cleanup）

### 6.1 盘点残留

```bash
git worktree list                        # 所有 worktree（_orch 之外的 <taskId> 即 lane 残留）
git branch | grep -E 'taskswarm/'             # lane 分支（taskswarm/orch 是常驻的，别动）
ls .taskswarm/batches/ 2>/dev/null            # 历史/残留批次记录
ls .taskswarm/mailbox/ 2>/dev/null            # 历史/残留 mailbox
ls .taskswarm/worktrees/                      # _orch 之外都是 lane worktree 残留
```

### 6.2 删除残留 lane 分支（安全前提：已并入 taskswarm/orch）

`git branch -d` 只认"并入当前分支（master）"，lane 分支只并入过 `taskswarm/orch`，所以
`-d` 会拒绝。**先逐个验证并入 orch，再 `-D`**：

```bash
# 验证（每个分支都做；输出 MERGED 才可删）
git merge-base --is-ancestor taskswarm/<taskId> taskswarm/orch && echo "MERGED: <taskId>"
# 删除（已验证安全）
git branch -D taskswarm/<taskId>
```

> 为什么安全：`merge-base --is-ancestor` 为真 = 该分支所有 commit 都已在 `taskswarm/orch` 上，
> 内容不丢。批量删前先把验证结果列给 operator 看。

### 6.3 删除残留 worktree

```bash
# 先看有没有未提交/未 commit 的活（抢救优先，见 §8.2）
git -C .taskswarm/worktrees/<taskId> status --short
# 确认无价值内容后删除
git worktree remove --force .taskswarm/worktrees/<taskId>
git worktree prune          # 清理登记表里的孤儿条目
```

> 崩溃残留的 worktree 目录可能没有对应登记项，`prune` 会兜底。**永远不要手删目录而不
> 走 `git worktree remove`**，否则登记表残留会导致后续 `worktree add` 冲突（KI-004 教训）。

### 6.4 清理 mailbox

```bash
rm -rf .taskswarm/mailbox/<batchId>
```

mailbox 只是 agent 间消息文件，删除无副作用（引擎结束时会 drain，崩溃残留则直接删）。

### 6.5 清理批次记录（有取舍）

```bash
rm .taskswarm/batches/<batchId>.json
```

- 删除后 `/tswarm-status` 回到 "No TaskSwarm batch yet"，可干净地开新批次。
- **取舍**：dashboard 的数据源就是 `.taskswarm/batches/*.json`——删了 = 从 dashboard 历史里
  消失。想留审计历史就保留文件（把 phase 改成 `aborted` 更诚实，见 §7.4 第 2 步）。

### 6.6 不要动的东西

- `taskswarm/orch` 分支与 `.taskswarm/worktrees/_orch/`——引擎基础设施，删了引擎会自动重建，
  但没必要。
- 已 merged 任务目录的 `.DONE` / `STATUS.md` 产物、`src/` 未提交改动——不属于"残留"。

---

## 7. 错误后的清理与恢复（Recovery）

### 7.1 lane 失败（phase=failed）

判定：批次 json 里 `lane.error` + `log` 给出原因。三种常见：

| error 形态                      | 含义                            | 处置                          |
| ----------------------------- | ----------------------------- | --------------------------- |
| `worker exited 1`（exitCode≠0） | worker 进程异常退出                 | 读 worker 会话日志找原因（§5.3），修后重跑 |
| `task not marked done`        | worker 正常退出但 STATUS.md 不是 ✅/❌ | 判断活是否干完；重跑或标记后重跑（§4.4）      |
| `merge failed: ...`           | 并入 orch 冲突                    | 在 `_orch` worktree 里查冲突解决   |

重跑失败 lane（未 done 任务默认会被重新扫描）：

```
/tswarm <taskId>       # 或 tswarm_supervisor_control start scope=<taskId>
```

因为 `taskswarm/<taskId>` 分支还在，新 worktree 会**附着旧分支**——从旧检查点续跑而非从零
（引擎会先自动 `git merge taskswarm/orch` 把最新合并产物并入 lane，冲突时 abort 由 worker 自行处理）。

> ⚠️ **同波 fmt 任务冲突（2026-08-14 实测）**：同波内若有 `cargo fmt --all` 类任务（全仓重排 .rs，一次可达 69 文件），与同波改 .rs 的其他任务**必然 merge 冲突**（如 external/lib.rs、main/system.rs、biz-core/scope.rs）。处置：`_orch` worktree 里对冲突文件 `git checkout --theirs -- <file>` 取 worker 功能版本 → `git add` → 完成合并 → **波末统一跑 `cargo fmt --all` 提交归一**（否则 W2 起 lane 从含混合格式的基线出发）。预防：fmt 类任务单波执行，或 File Scope 限定为 `cargo fmt --check` 实际报错的文件清单。

### 7.2 REVISE（phase=review）

reviewer 结论为 REVISE 时 lane 进入 `review`，任务未标记 done。处置：

1. 读 `tasks/<ID>/STATUS.md` 与 `.reviews/` 最新结论，看 reviewer 要求改什么；
2. 修订后重跑该任务（同 §7.1）；reviewer 会写新 verdict 文件，引擎只认最新一份。

### 7.3 abort 之后

- 批次 phase=`aborted`；lane worktree 已被引擎清掉；**`taskswarm/<taskId>` 分支残留**。
- 处置：按 §6.2 逐个验证并入后删分支；mailbox 按 §6.4 删；批次记录保留（历史）或删。
- 想接着干：abort 是终态，**不支持续跑**——抢救产物（§8）后按 §7.4 开新批次。

### 7.4 进程崩溃 / 重启之后（最重要的恢复场景）

症状：重启后 `/tswarm-status` 显示批次 phase 卡在 `running`（或 planning/paused），但
`abort`/`resume`/`pause` 都报 "No running batch"（引擎内存已空），且 supervisor 的
`start` 会因 phase=running/planning 保护而拒绝新批次。

**恢复六步**（实测验证的完整流程）：

```bash
# ① 盘点现场：批次状态 + 残留
cat .taskswarm/batches/<batchId>.json        # 看哪些 lane merged / failed / running
git worktree list
git branch | grep -E 'taskswarm/'

# ② 把卡住的批次状态改为 aborted（或删除记录文件）——解锁 start 保护
#    改 json 里的 "phase": "aborted"（有终态语义，dashboard 历史也保留）

# ③ 抢救有价值产物（§8）——失败/running lane 的检查点在 taskswarm/<taskId> 分支上

# ④ 清理残留：验证并入后删 lane 分支（§6.2）、删残留 worktree（§6.3）、删 mailbox（§6.4）

# ⑤ 重新规划剩余工作
/tswarm-plan all            # 看还剩哪些任务（failed/pending 会被重新扫描）

# ⑥ 开新批次（scope 指定剩余任务，避免重跑已 merged 的）
/tswarm <剩余任务ID...> 或 tswarm_supervisor_control start scope=<taskId>
```

要点：崩溃恢复 = **先抢救、再清理、再重跑**，顺序别反（先删就丢了抢救机会）。

### 7.5 其他常见故障

- **`.git/index.lock`**：git 进程被杀残留。确认无 git 在跑 → `rm .git/index.lock`（tier0_known，自动做）。
- **`could not create lane worktree`**：旧残留阻塞。引擎已内置清理（KI-004 修复），
  仍失败就手动 `git worktree prune` + 按 §6.2/§6.3 清理同名分支/目录后重试。
- **dashboard 启动失败**：`tswarm_dashboard` 提示产物未并入 → 先 `integrate`；
  端口占用 → 引擎自动避让，或手动 `--port` 指定。
- **worker 无工具 / 沙箱审批弹窗**：已修复（KI-002/KI-005），worker 会话自带
  full-access + 免审批；GUI 会话与全局配置不受影响。若仍出现，查 worker 工具装配。

---

### 7.6 假死：lane 已完成但迟迟不 complete（2026-08-14 实测）

> ⚠️ **v0.1.1 起已根治（KI-007）**：引擎带 `laneTimeoutMinutes` 看门狗（默认 180 分钟），
> worker 超时无完成事件会自动强制结束该 lane（failed）并继续下一 wave，**新批次不再需要
> 重启引擎**。本流程用于：① 存量僵局批次（如本批 `b-mss7l7sm-4217b2`，引擎无看门狗）；②
> 手动收尾保住已完成 lane 的代码成果；③ 看门狗被配置为 0（禁用）的环境。

**现象**：lane 显示 100%（步骤全 [x]）但长时间 `[running]` 不进入 merged；批次 JSON 中该 lane
`log` 只有 `starting <task>`，无 `advance step / worker exited / done` 事件（对比正常 lane 有
`worker exited 0`）；worker 进程已消失。

**根因**：worker 进程异常退出/失联，supervisor 未收到其进度与退出事件，lane 未回收；
`resume` 对"未暂停的失联 lane"无效（不会重新拉起 worker）。

**判定**（先判"活是否干完"，再治"状态卡死"）：

```bash
# ① 批次 lane log：只有 "starting" 而无 worker 事件 → 疑似失联
python3 -c "import json;d=json.load(open('.taskswarm/batches/<batch>.json'));[print(l['lane'],l['phase'],l['log']) for l in d['lanes']]"
# ② worktree 是否有实际提交（工作已完成 = 有提交且 status 干净）
git -C .taskswarm/worktrees/<taskId> log --oneline -5
git -C .taskswarm/worktrees/<taskId> status --short   # 空 = 已提交干净
# ③ 核对产出满足 PROMPT 验收（关键产物存在 + 门禁可过：tsc -b / cargo check）
# ④ worker 进程是否已消失
ps aux | grep <taskId> | grep -v grep
```

**处理流程**（确认产出满足验收后的手动收尾）：

1. 写完成标记与审计记录（手动操作必须可追溯）：
   ```bash
   date -u +%Y-%m-%dT%H:%M:%SZ > tasks/<taskId>/.DONE
   # STATUS.md 追加 Execution Log：supervisor manual finalize + 原因
   ```
2. 合并分支：`integrate` 后**必须核对主干是否真包含改动**（`git log` + 关键产物），
   integrate 可能合不全甚至误报"已经是最新的"（§7.6 实测）；缺了就手动
   `git merge taskswarm/<taskId> --no-edit`。
3. 跨任务冲突：同一文件被两个任务改（如 bflow.tsx 被 JM-333 与 JM-340 同时改）时，
   冲突取"功能并集"，并清理因组件抽离产生的**未使用 import**（否则 tsc 报错）。
4. 验证：`tsc -b` / `cargo check` / 关键产物存在 → `git commit --no-edit`。

**工具坑（勿踩）**：

- `abort` 是**批次级**操作，scope 不生效，会 abort 整个批次（含未启动 lane）；误操作后用
  `resume` 恢复（aborted → running）。**无法用 abort 释放单个 lane 的调度槽**。
- `start` 在批次 phase=running 时拒绝启动新批次。
- 手动改 `.taskswarm/batches/*.json` 的 lane phase：引擎内存**不重读**，无法推进调度
  （但重启引擎后会被读取——所以仍建议改，配合重启恢复，见 KI-007）。

**最终恢复**：上述手段都无法让引擎推进 wave 时，唯一可靠恢复是**重启 DSH 引擎（新开会话）**
——引擎重启后重新加载批次 JSON（失联 lane 已手工标记 merged），wave 推进、剩余任务按新
plan 继续。代码成果在手动收尾时已保住（在主干），重启无损失。

---

## 8. 工作抢救（Salvage）

「抢救」= 从失败的 lane / 崩溃的进程里，把**已经做出来的活**捞回来并落地。
项目先例：WEB-006（cli-integration）在批次里抢救出 dashboard server，
`src/orchestrator/index.ts` 的 `/tswarm-dashboard` 即"移植自 WEB-006 的抢救实现"。

### 8.1 抢救对象在哪

| 产物位置                                    | 何时存在                   | 怎么取                                                           |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `taskswarm/<taskId>` 分支上的 checkpoint commits | worker 退出/崩溃前 commit 过 | `git log --oneline taskswarm/<taskId>`，内容在分支上                      |
| lane worktree 里的未 commit 文件             | 崩溃前没来得及 commit         | `git -C .taskswarm/worktrees/<taskId> status` → 先 commit/stash 再清理 |
| `taskswarm/orch` 上已 merged 的 lane 产物         | 波次内成功 merge 的部分        | 最终统一 `integrate`                                              |

### 8.2 抢救步骤

```bash
# ① 列出失败 lane 分支上的检查点
git log --oneline taskswarm/<taskId>

# ② 看产物（对比 master 或直接 checkout 到临时位置）
git diff master taskswarm/<taskId> --stat

# ③ 选一种落地方式：
#   a) 手动并入 orch（后续 integrate 一起落地）
#      git -C .taskswarm/worktrees/_orch merge --no-edit taskswarm/<taskId>
#   b) cherry-pick 关键 commit 到当前分支
#      git cherry-pick <commit>
#   c) 干脆重跑任务续接（检查点自动带上，§7.1）
```

### 8.3 正式落地：integrate

批次完成后（或抢救产物并入 orch 后），把 `taskswarm/orch` 合并进工作分支：

```
/tswarm-integrate        # = git merge --no-edit taskswarm/orch
```

这是 lane 产物（含抢救产物）进入工作树的**唯一正式入口**。destructive 分类，supervised
模式下先征求确认。

---

# Part C 参考

## 9. 动作分类与自主度（supervisor 视角）

来源：`src/orchestrator/supervisor.ts` 的 `ACTION_CLASSIFICATION_EXAMPLES`。
AI 按此判断哪些动作可以自动做、哪些要先问。

| 分类                    | 包含动作                                                                                                                  | 自主度规则              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **diagnostic**（永远可做）  | 读 `.taskswarm/batches/*.json`、`tasks/*/STATUS.md`、lane 日志；`git status/log/diff/worktree list`；跑测试；`tswarm_supervisor_status` | 全部级别直接做            |
| **tier0_known**（已知恢复） | 重试失败的 merge；resume / pause；清 `.git/index.lock`；重试前清理过期 worktree                                                       | supervised 自动做     |
| **destructive**（需确认）  | abort；integrate；`git reset / checkout -B / branch -D`；`git worktree remove`；改 STATUS/.DONE/批次状态文件；跳过任务/波次             | supervised 先征求一句确认 |

## 10. 波次依赖与边界行为（理解引擎，避免误判）

1. **失败 lane 不阻塞后续波次**：引擎按波次推进，wave 1 有 lane 失败，wave 2 照跑——
   但下游任务可能因缺上游产物而失败。规划/重跑时先修上游，再跑依赖它的任务。
2. **未知依赖 ID**：当作已满足处理，并显示在 `Unresolved dependency references` 里，
   不阻塞计划（`buildWaves`）。
3. **依赖环**：无法分层时按剩余顺序强行成波（会显示为同一波），需人工修正任务包。
4. **start 保护**：supervisor 的 start 在 phase=running/planning 时拒绝开新批次；
   `/tswarm` 命令本身无保护——崩溃后直接 `/tswarm` 会开新批次撞残留，先按 §7.4 恢复。
5. **空项目**：`start all` / `/tswarm all` 自动 scaffold 示例任务（EXAMPLE-001/002）。
6. **scope 语法**：`all` | 任务 ID（如 `DEMO-004`）| 路径（绝对/相对），空格分隔多 token；
   匹配任务 ID 或目录名。
7. **重跑已完成任务**：配置 `includeDoneTasks: true` 才会扫描有 `.DONE` 的任务；否则按
   §4.4 手动重置单任务。

## 11. 与 known-issues 的关联

- **KI-004**（kill 后残留阻塞新批次）已修复：`createLaneWorktree` 自动清理残留目录并
  附着既有分支。本手册 §6/§7.4 是修复后的"人工兜底"路径。
- **KI-003**（并发写批次状态互相覆盖）已修复：lane 持久化走单 lane 定向 `updateLane`。
  若见到状态与事实不符，先怀疑旧引擎产物，按 §6 清理后重跑。
- **KI-002 / KI-005**（worker 工具缺失 / 沙箱审批）已修复：worker 会话自带标准工具 +
  full-access + 免审批；`escalate` 消息是这两类问题的排查线索（§5.4）。
- **KI-001**（worker 会话污染侧边栏）已修复：内部会话自动隐藏。
- 本手册未覆盖的已知问题见 `docs/known-issues.zh-CN.md`。
