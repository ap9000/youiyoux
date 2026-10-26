# Self-hosting the team hub

The hosted hub is `youiyoux hub serve` ([what it does](commands.md#the-hosted-hub)): a read-only
page of every repository's products, drift and System adoption, fed by CI. No source code leaves a
repository. Each release publishes it as an image, `ghcr.io/ap9000/youiyoux`, for amd64 and arm64.

It runs one of two ways:

- **One organisation**, behind a view key: everyone who has the key sees every repository that
  sends records.
- **Workspaces**, with GitHub sign-in: one hub holds several teams or clients, each kept apart,
  and each person sees only the workspaces they are a member of ([Workspaces](#workspaces)).

## With Docker Compose (Postgres, optional https)

You need Docker with Compose, and for https a domain pointed at the machine.

```sh
mkdir youiyoux-hub && cd youiyoux-hub
for f in compose.yml Caddyfile .env.example; do curl -fsSLO "https://raw.githubusercontent.com/ap9000/youiyoux/main/docker/$f"; done
cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
| --- | --- |
| `YOUIYOUX_VERSION` | The image's version, e.g. `0.1.28`. `latest` follows each release; a pinned version makes an upgrade a change you make |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `YOUIYOUX_HUB_AUDIENCE` | The hub's https address, exactly as CI's `YOUIYOUX_HUB_URL` secret will name it |
| `YOUIYOUX_DOMAIN` | For the https profile: the hub's domain, e.g. `hub.acme.dev` |

Then, for **one organisation**:

| Variable | Value |
| --- | --- |
| `YOUIYOUX_HUB_VIEW_KEY` | What people sign in with: `openssl rand -base64 32` |
| `YOUIYOUX_HUB_GITHUB_OWNERS` | The GitHub accounts whose repositories may send records, by numeric id (`gh api orgs/acme --jq .id`), comma-separated |

For CI other than GitHub's, leave the owners and audience empty and set `YOUIYOUX_HUB_TOKEN`
(`openssl rand -base64 32`) instead: then whoever holds it can send a record naming any repository.

Or, for **workspaces**, the two halves of the hub's GitHub OAuth App, and none of the three above
([Workspaces](#workspaces) says how to make it):

| Variable | Value |
| --- | --- |
| `YOUIYOUX_HUB_GITHUB_CLIENT_ID` | The app's client id |
| `YOUIYOUX_HUB_GITHUB_CLIENT_SECRET` | A client secret you generate for it |

```sh
docker compose --profile https up -d   # the hub, Postgres, and Caddy with a certificate for YOUIYOUX_DOMAIN
docker compose up -d                   # or without Caddy, behind a proxy of your own
```

Without the https profile the hub answers on `http://127.0.0.1:8080` (`YOUIYOUX_PORT`), on that
machine only: put your own https proxy in front of it. Its session cookie is `Secure`, so people
sign in over https (or on `localhost`, which browsers treat as secure).

Then, in each repository, `npx youiyoux hooks install --record` writes the workflow that sends its
record on each push to the default branch; give the repository the secret `YOUIYOUX_HUB_URL` (the
audience above). The first push shows up on the hub's page.

## Workspaces

One hub, several teams or clients, each with its own repositories, members and records. Nobody sees
a workspace they are not a member of, and a workspace's name is not given away to anyone else.

**1. The hub's GitHub OAuth App.** On GitHub, **Settings → Developer settings → OAuth Apps → New
OAuth App** (for an organisation, under its own settings, so the app outlives any one person):

- Homepage URL: the hub's address (`YOUIYOUX_HUB_AUDIENCE`).
- Authorization callback URL: that address followed by `/auth/github/callback`.

Generate a client secret and put both halves in `.env`, then `docker compose up -d`. The hub asks
GitHub for `read:org` only, to see which organisations a person belongs to. It reads that once, at
sign-in, then gives the token back; it keeps no GitHub token.

**2. A workspace, and who feeds it.** On the hub's machine (each command works on the hub's own
database):

```sh
docker compose exec hub youiyoux hub workspace add acme --name "Acme" --org acme
docker compose exec hub youiyoux hub owner add acme acme
docker compose exec hub youiyoux hub member add acme your-login --admin
```

- `--org` lets every active member of that GitHub organisation in, checked when they sign in. That
  check stands for 12 hours; then the hub asks them to sign in again (one click: GitHub does not ask
  again for an app they have approved), so someone who has left the organisation loses access within
  12 hours. Invited members keep a 14-day session, and removing anyone counts at once.
- `owner add` says whose repositories' CI sends records here: an organisation or a user, kept by
  GitHub's numeric id, so a renamed account's old name never matches. One owner feeds one workspace.
- `member add` invites a person by login, also outside the organisation; `--admin` makes them one of
  the workspace's admins, who manage it from the page from then on (below). An invite stays when the
  person leaves the organisation; `member remove` ends it.
- Accounts are looked up on GitHub by login or id; on a machine that cannot reach GitHub, give
  `id:login` (`1234567:acme`).

`youiyoux hub workspace list` shows each workspace with its owners, members and CI tokens;
`youiyoux hub member list acme` shows its members and how each got in.

**The Manage page.** A workspace's admins see Manage beside its overview. There they invite people
by GitHub login and change their roles, add or remove the GitHub owners whose CI sends records, and
make or remove CI tokens; each in a modal, where a new token is shown once. A workspace always keeps
one admin: the last one can neither be removed nor step down. The hub sends no invitation: tell the
person the hub's address, and they sign in with GitHub. A change is taken only from the hub's own page
(its origin is `YOUIYOUX_HUB_AUDIENCE`'s). Adding or removing a workspace, and its `--org`, stay with
whoever runs the hub.

**3. CI.** Each repository's workflow (`npx youiyoux hooks install --record`) proves its repository
with GitHub Actions' OIDC token, and the hub files the record under the workspace that owns it. For
CI other than GitHub's, `youiyoux hub token add acme jenkins` makes a token for that workspace. It is
shown once and kept only as a hash; give it to that CI as `YOUIYOUX_HUB_TOKEN`, and
`youiyoux hub token remove acme jenkins` revokes it.

**Moving from one organisation:** records sent before workspaces stay in a workspace named
`default`. To keep showing them, `youiyoux hub workspace add default --name "…"`, then move the
owners from `YOUIYOUX_HUB_GITHUB_OWNERS` with `youiyoux hub owner add default …`. Remove the
view key, owners and token from `.env`: a hub with workspaces refuses to start beside them, so
nobody thinks the old key still opens it.

**Upgrade:** set the new `YOUIYOUX_VERSION`, then `docker compose pull && docker compose up -d`.
The store's migrations run on start. **Back up:** `docker compose exec db pg_dump -U youiyoux youiyoux > hub.sql`.

## With one container (SQLite)

For a small team, without Postgres: the records are kept in a SQLite file on the `/data` volume.

```sh
docker run -d --name youiyoux-hub --restart unless-stopped -p 127.0.0.1:8080:8080 -v youiyoux-hub:/data \
  --env-file hub.env ghcr.io/ap9000/youiyoux:latest
```

`hub.env` holds the same `YOUIYOUX_HUB_*` variables as above (never pass a secret with `-e NAME=value`:
it is kept in your shell's history). Pass `DATABASE_URL` to use a Postgres you already run.

## Without Docker

`npx youiyoux hub serve --host 0.0.0.0` on any host with Node 20 or later (22.5 or later for
SQLite; `npm install youiyoux pg` for Postgres), with the same environment.

## Building the image yourself

From a checkout, `pnpm docker` packs this commit's package and builds `youiyoux-hub:dev` from it;
`pnpm docker --smoke` then runs it with secrets made for that run, sends a record and reads it back.
CI does the same on every push, and the release workflow smoke-tests each release's image before it
pushes it.
