# 恢复标准 npm 包名 `dsh-taskswarm`（24h 冷却期后）

> 起因（2026-08-16 23:24 北京时间）：清理 npm 历史版本时执行 `npm unpublish dsh-taskswarm`（不带版本号，删整个包），
> 触发 npm 防抢注保护——**包名删除后 24 小时内不能重新发布同名包**。
> 过渡方案：8/17、8/18 两天改用 **GitHub 安装**（README 首行有通告），不维护临时包名。

## 过渡期安装方式（8/17 ~ 8/18）

```bash
dsh plugin --profile web add https://github.com/february2015/dsh-taskswarm.git
```

GitHub 安装 = clone 项目源码本地构建，包名用项目 package.json 的 `dsh-taskswarm`（标准名），
`cordis.patch.yml` 路径 `dsh-taskswarm/orchestrator` 匹配，无需改名。

## 恢复时间

**8月19日（2026-08-19）北京时间起恢复 npm 安装**。技术冷却期实际到 08-17 23:24（08-16 23:24 + 24h）就结束，
但按对外通告统一在 **8/19** 恢复（8/17、8/18 两天用 GitHub 安装）。

## 恢复步骤（3 步，约 1 分钟）

```bash
cd /Users/robin/myProject/dsh-taskswarm

# 1. 确认 package.json 的 name 是标准名（过渡期保持标准名，无需改动）
grep '"name"' package.json    # 确认 → "name": "dsh-taskswarm"

# 2. 重新发布标准包（当前 ~/.npmrc 是 bypass token，无需验证码）
npm run build && npm test     # 顺手验证一遍（可选但推荐）
npm publish
npm view dsh-taskswarm version   # 确认 → 0.2.38

# 3. 移除 README 首行的 GitHub 过渡通告，push
```

推送：

```bash
git add README.md README.zh-CN.md
git commit -m "chore: npm 包已恢复，移除 GitHub 过渡期安装通告"
git push
```

## 恢复后收尾

- 本地 web profile 过渡期可能装了 GitHub 版本（`dsh-taskswarm` link 到本地项目或 clone），
  恢复后统一切回 npm 包即可（`dsh plugin --profile web add dsh-taskswarm`，自动装 latest）。
- 如需清理：过渡期如用过 `dsh-taskswarm2`（未采用，仅备查）或 GitHub clone 副本，按需移除。

## token 备忘（2026-08-17 实测）

| token | 名字 | bypass_2fa | 用途 |
|---|---|---|---|
| `npm_JJHI...` | tt | ✅ | publish（发布） |
| `npm_oaJr...` | deletetoken | ❌ | unpublish（删除，需恢复码当 OTP） |

- 发布用 bypass token（`~/.npmrc` 当前是这个）；删除版本用 classic token + 恢复码。
- 恢复码文件：`~/Downloads/npm_recovery_codes (1).txt`（每码一次性，用完在 npm 2FA 设置页 Regenerate）。
