# Release Guide (发布手册)

> For **maintainers** — how to publish taskswarm to the npm registry so others
> can `dsh plugin add dsh-taskswarm` or `npx taskswarm-dashboard`. Bilingual standard:
> 中文版见 [release.zh-CN.md](release.zh-CN.md).
>
> User-facing install instructions (npm / GitHub / local) live in the README;
> this guide is about getting a new version out.

## Distribution channels

| Channel | How users install | When |
|---|---|---|
| **npm** (primary) | `dsh plugin add dsh-taskswarm` / `npx --package dsh-taskswarm taskswarm-dashboard` | every release |
| GitHub | `dsh plugin add https://github.com/february2015/dsh-taskswarm.git` | keep in sync (push master) |
| local / offline | clone or zip + `npm install && npm run build && dsh plugin add <dir>` | development |

## Prerequisites

- An npm account with **publish rights** on `taskswarm` (unscoped → public by default).
- A **Granular Access Token** — a classic token will be rejected with
  `E403 ... Two-factor authentication or granular access token with bypass 2fa
  enabled is required` when the account has 2FA enabled (it does, by default):
  - https://www.npmjs.com/settings/<user>/tokens → Generate New Token → **Granular Access Token**
  - Packages and scopes: `dsh-taskswarm`; Permissions: **Read and write**
  - **Must check the 2FA bypass option** ("bypass" for publish) — otherwise publishing still fails.
- Store the token (the published steps below assume it's in `~/.npmrc`):

```bash
npm config set //registry.npmjs.org/:_authToken <npm_token>
npm whoami            # should print your npm username
```

## Release steps

```bash
# 1. Build & test — the runtime loads lib/, so a fresh build is mandatory
npm run build
npm test

# 2. Bump the version in package.json (semver; npm never allows overwriting a published version)
#    e.g. 0.1.0 → 0.1.1  (or: npm version patch)

# 3. Sanity-check what would ship (files must include lib/, dashboard/, docs/,
#    templates/, cordis.patch.yml, README.md, README.zh-CN.md)
npm pack --dry-run

# 4. Publish (public by default for unscoped packages; no extra flag needed)
npm publish

# 5. Verify
npm view dsh-taskswarm version        # → 0.1.1
npm view dsh-taskswarm bin            # → { 'taskswarm-dashboard': 'dashboard/server.mjs' }

# 6. Only after everything above passes, push to GitHub (ordering rule below)
git push origin master
```

> ⚠️ **Publish-before-push ordering (mandatory since 2026-08-15)**: **`npm publish` must
> succeed and be verified BEFORE `git push` to GitHub.**
> - Installing from GitHub depends on the version already published to npm; do not
>   push code that is not yet visible on npm ("repo has new code, installs get the old package").
> - Pushing never triggers an automatic publish; each version can be published exactly
>   once (npm rejects duplicates), so the order cannot be fixed afterwards.
> - If a problem surfaces after the push: bump with `npm version patch` and republish;
>   never try to overwrite an existing version.

## Verifying from the user side

```bash
dsh plugin --profile web add dsh-taskswarm          # install as plugin (restart dsh web)
npx --package dsh-taskswarm taskswarm-dashboard --root <repo>   # standalone dashboard CLI
```

### Upgrading an existing install

`dsh plugin --profile web add dsh-taskswarm` **does not bump** a dependency whose
lockfile version already satisfies the declared range (`^0.2.9` is satisfied by
`0.2.9`, so pnpm reports "Already up to date" and stays on the old version).
To pull a newer version within the range, pin it explicitly:

```bash
dsh plugin --profile web add dsh-taskswarm@0.2.10    # explicit version always resolves
# or, inside the profile dir: pnpm update --latest
```

Then restart `dsh web` for the new version to take effect.

## Versioning rules

- Semantic versioning; during 0.x any minor bump is acceptable for breaking changes.
- **Every publish must bump the version** — the registry rejects re-publishing an existing version.
- The published tarball is built from the working tree at publish time; if `lib/`
  is stale (e.g. you changed `src/`), bump + rebuild + republish.

## Security notes

- **Two tokens, different rules** (verified 2026-08-17):
  - **Publish**: Granular Access Token with **2FA bypass** (no OTP prompt on publish).
  - **Unpublish (delete a version)**: npm security policy **forbids bypass-2FA tokens
    from deleting versions** — `E403 Granular access tokens that bypass two-factor
    authentication may not perform this action`. Use a **classic token (no 2FA bypass)**;
    with 2FA enabled npm will ask for a one-time code:
    ```bash
    npm unpublish dsh-taskswarm@0.2.2          # enter the OTP when prompted
    # or supply it up front: npm unpublish dsh-taskswarm@0.2.2 --otp=<6-digit code>
    ```
  - `~/.npmrc` currently holds the classic token (for unpublish). If publish fails with
    `Two-factor authentication ... is required`, temporarily switch back to the bypass
    token or go through OTP.
- Use the least-privilege token: scoped to `dsh-taskswarm` only, Read and write.
- The token is stored in `~/.npmrc` — treat it like a password.
- If a token leaks or you stop using it: revoke it at
  https://www.npmjs.com/settings/<user>/tokens and remove it locally with
  `npm config delete //registry.npmjs.org/:_authToken`.
- **72-hour unpublish window**: npm only allows deleting a version within **72 hours**
  of publishing; older versions can only be `npm deprecate`d (marked deprecated),
  never truly removed. Bulk-delete history:
  ```bash
  for v in 0.2.1 0.2.2 ... 0.2.37; do npm unpublish dsh-taskswarm@$v; done
  ```

## Release checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] version bumped in `package.json`
- [ ] `npm pack --dry-run` shows the expected files (lib/dashboard/docs/templates/cordis.patch.yml/README\*)
- [ ] `npm publish` succeeds
- [ ] `npm view dsh-taskswarm` confirms the new version + bin
- [ ] **(only after all of the above)** `git push origin master` to GitHub
