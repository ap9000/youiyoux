# Releasing youiyoux

## Once: set up publishing (owner)

1. GitHub → repo **Settings** → **Environments** → **New environment** `npm`. Optional: add
   yourself as a required reviewer, so every publish waits for your approval.
2. npmjs.com → package `youiyoux` → **Settings** → **Trusted Publisher** → **GitHub Actions**:
   - Organization or user: `ap9000`
   - Repository: `youiyoux`
   - Workflow filename: `release.yml`
   - Environment: `npm`
3. Once a release has gone out this way: under **Publishing access**, choose "Require two-factor
   authentication and disallow tokens", so only the workflow can publish.

No npm token is stored anywhere. The workflow signs in with GitHub's OIDC token and publishes with
provenance.

## Every release

```sh
pnpm release patch     # or minor, major, or an exact 1.2.3
```

It refuses unless you are on `main`, the tree is clean and `main` matches `origin/main`. Then it
sets the new version in every workspace `package.json`, runs `pnpm typecheck` and `pnpm test`,
commits `Release vX.Y.Z`, tags `vX.Y.Z`, shows what it will push and asks before pushing (`--yes`
skips the question).

The tag push runs [`release.yml`](../.github/workflows/release.yml). It publishes only a tag whose
commit is on `main` and matches the package version. Three jobs, least privilege each: build
(typecheck, tests, `pnpm pack`; read-only), publish (that exact tarball, `npm publish
--provenance`; the only job with an OIDC token, in the `npm` environment), release (the GitHub
Release with generated notes and the tarball).

| Flag | Does |
| --- | --- |
| `--dry-run` | Everything except commit, tag and push; restores the files. Exits 1 if a real run would refuse. |
| `--yes` | Push without asking. |
| `--trailer "Key: value"` | Adds a commit trailer (repeatable; or `RELEASE_TRAILERS`, one per line). For agents' `Co-Authored-By`. |

## If a run fails

For a cause outside the code (an npm setting, a flaky step), re-run it: **Actions → Release → Run
workflow**, with the tag. It skips `npm publish` when that version is already on npm, so a re-run
only fills in what is missing. If the code is wrong, fix it and release the next patch; never move
a pushed tag.
