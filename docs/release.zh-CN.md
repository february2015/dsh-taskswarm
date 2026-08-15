# 发布手册（Release Guide）

> 面向**维护者**——如何把 taskswarm 发布到 npm registry，让别人能
> `dsh plugin add dsh-taskswarm` 或 `npx taskswarm-dashboard`。双语标准：
> English version: [release.md](release.md)。
> 
> 面向用户的安装说明（npm / GitHub / 本地）在 README；本手册只讲「发新版本」。

## 发布渠道

| 渠道         | 用户怎么装                                                               | 时机                |
| ---------- | ------------------------------------------------------------------- | ----------------- |
| **npm**（主） | `dsh plugin add dsh-taskswarm` / `npx --package dsh-taskswarm taskswarm-dashboard` | 每次发版              |
| GitHub     | `dsh plugin add https://github.com/february2015/dsh-taskswarm.git`       | 保持同步（push master） |
| 本地 / 离线    | 拷贝或 zip + `npm install && npm run build && dsh plugin add <dir>`    | 开发期               |

## 前置条件

- 有 `dsh-taskswarm` 发布权限的 npm 账号（非 scoped 包默认公开）。
- **Granular Access Token**——账号开了 2FA 时，经典 token 会被拒：
  `E403 ... Two-factor authentication or granular access token with bypass 2fa
  enabled is required`（实测踩过这个坑）：
  - https://www.npmjs.com/settings/<用户名>/tokens → Generate New Token → **Granular Access Token**
  - Packages and scopes：`dsh-taskswarm`；Permissions：**Read and write**
  - **必须勾选 2FA bypass 选项**（发布时绕过两步验证），否则照样 E403。
- 存 token（下面步骤假设已写入 `~/.npmrc`）：

```bash
npm config set //registry.npmjs.org/:_authToken <npm_token>
npm whoami            # 应打印你的 npm 用户名
```

## 发布步骤

```bash
# 1. 编译 + 测试——运行时加载 lib/，改过 src/ 必须重新 build
npm run build
npm test

# 2. 改 package.json 的 version（语义化版本；npm 不允许覆盖已发布版本）
#    如 0.1.0 → 0.1.1（或 npm version patch）

# 3. 先看会发出去什么（files 必须含 lib/、dashboard/、docs/、
#    templates/、cordis.patch.yml、README.md、README.zh-CN.md）
npm pack --dry-run

# 4. 发布（非 scoped 包默认公开，无需额外参数）
npm publish

# 5. 验证
npm view dsh-taskswarm version        # → 0.1.1
npm view dsh-taskswarm bin            # → { 'taskswarm-dashboard': 'dashboard/server.mjs' }

# 6. 全部验证通过后，再 push 到 GitHub（顺序约定见下）
git push origin master
```

> ⚠️ **发布顺序约定（2026-08-15 起，强制）**：**先 `npm publish` 成功、验证通过，再 `git push` 到 GitHub**。
> - GitHub 渠道安装依赖的是 npm 已发布的版本；代码在 npm 可见之前不要 push，避免"仓库有新代码、装到的是旧包"。
> - push 不会触发自动发布；每个版本号的发布动作只有一次（npm 拒绝重复发布），顺序错了无法补救。
> - 若 push 后发现发布有问题：走 `npm version patch` 升新版本号重新发布，不要尝试覆盖。

## 从用户侧验证

```bash
dsh plugin --profile web add dsh-taskswarm          # 装插件（重启 dsh web 生效）
npx --package dsh-taskswarm taskswarm-dashboard --root <仓库路径>   # 独立 dashboard CLI
```

### 升级已安装的插件

`dsh plugin --profile web add dsh-taskswarm` **不会升级**已满足依赖范围的旧版本：
lockfile 里的 `0.2.9` 满足声明范围 `^0.2.9`，pnpm 会报 "Already up to date" 并停留在旧版。
要拉到范围内的更新版本，需**显式指定版本**：

```bash
dsh plugin --profile web add dsh-taskswarm@0.2.10   # 显式版本一定重新解析
# 或在 profile 目录里：pnpm update --latest
```

然后重启 `dsh web` 生效。

## 版本规则

- 语义化版本；0.x 阶段破坏性变更可走 minor。
- **每次发布必须升版本号**——registry 拒绝重复发布已存在的版本。
- 发布包按发布时的工作区内容打包；若 `src/` 改过而 `lib/` 是旧的，
  先升版本 + rebuild 再发。

## 安全注意事项

- token 最小权限：只给 `dsh-taskswarm`、Read and write、bypass 2FA。
- token 存在 `~/.npmrc`，按密码对待。
- token 泄露或不再使用：去 https://www.npmjs.com/settings/<用户名>/tokens revoke，
  本地用 `npm config delete //registry.npmjs.org/:_authToken` 清除。

## 发布检查清单

- [ ] `npm run build` 通过
- [ ] `npm test` 通过
- [ ] `package.json` version 已递增
- [ ] `npm pack --dry-run` 文件清单符合预期（lib/dashboard/docs/templates/cordis.patch.yml/README\*）
- [ ] `npm publish` 成功
- [ ] `npm view dsh-taskswarm` 确认新版本 + bin
- [ ] **（全部通过后才）** `git push origin master` 到 GitHub
