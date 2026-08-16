# 恢复标准 npm 包名 `dsh-taskswarm`（24h 冷却期后）

> 起因（2026-08-16 23:15 北京时间）：清理 npm 历史版本时执行 `npm unpublish dsh-taskswarm`（不带版本号，删整个包），
> 触发 npm 防抢注保护——**包名删除后 24 小时内不能重新发布同名包**。
> 期间用临时包名 `dsh-taskswarm2@0.2.38` 顶替（README 首行有通告）。

## 恢复时间

**8月19日（2026-08-19）北京时间起恢复标准包名**。技术冷却期实际到 08-17 23:24（08-16 23:24 + 24h）就结束，但按对外通告统一在 **8/19** 恢复（8/17、8/18 两天用临时包名 `dsh-taskswarm2`）。

## 恢复步骤（3 步，约 1 分钟）

```bash
cd /Users/robin/myProject/dsh-taskswarm

# 1. package.json 的 name 改回标准名
sed -i '' 's/"name": "dsh-taskswarm2"/"name": "dsh-taskswarm"/' package.json
grep '"name"' package.json    # 确认 → "name": "dsh-taskswarm"

# 2. 重新发布标准包（当前 ~/.npmrc 是 bypass token，无需验证码）
npm run build && npm test     # 顺手验证一遍（可选但推荐）
npm publish
npm view dsh-taskswarm version   # 确认 → 0.2.38

# 3. 移除 README 首行的临时包名通告，push
```

推送：

```bash
git add README.md README.zh-CN.md package.json
git commit -m "chore: 恢复标准包名 dsh-taskswarm（临时包 dsh-taskswarm2 过渡期结束）"
git push
```

## 恢复后收尾

- 临时包 `dsh-taskswarm2@0.2.38` 可以留着（不影响），或 deprecate 标记弃用：
  `npm deprecate dsh-taskswarm2@0.2.38 "临时包，请改用 dsh-taskswarm@0.2.38"`（需要 classic token + 恢复码）
- 本地 web profile 如装了 `dsh-taskswarm2`，恢复后改回标准包：
  `dsh plugin --profile web add dsh-taskswarm@0.2.38`

## token 备忘（2026-08-17 实测）

| token | 名字 | bypass_2fa | 用途 |
|---|---|---|---|
| `npm_JJHI...` | tt | ✅ | publish（发布） |
| `npm_oaJr...` | deletetoken | ❌ | unpublish（删除，需恢复码当 OTP） |

- 发布用 bypass token（`~/.npmrc` 当前是这个）；删除版本用 classic token + 恢复码。
- 恢复码文件：`~/Downloads/npm_recovery_codes (1).txt`（每码一次性，用完在 npm 2FA 设置页 Regenerate）。
