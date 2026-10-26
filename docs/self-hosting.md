# Self-hosting the team hub

The hosted hub is `youiyoux hub serve` ([what it does](commands.md#the-hosted-hub)): a read-only
page of every repository's products, drift and System adoption, fed by CI. No source code leaves a
repository. Each release publishes it as an image, `ghcr.io/ap9000/youiyoux`, for amd64 and arm64.

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
| `YOUIYOUX_HUB_VIEW_KEY` | What people sign in with: `openssl rand -base64 32` |
| `YOUIYOUX_HUB_GITHUB_OWNERS` | The GitHub accounts whose repositories may send records, by numeric id (`gh api orgs/acme --jq .id`), comma-separated |
| `YOUIYOUX_HUB_AUDIENCE` | The hub's https address, exactly as CI's `YOUIYOUX_HUB_URL` secret will name it |
| `YOUIYOUX_DOMAIN` | For the https profile: the hub's domain, e.g. `hub.acme.dev` |

For CI other than GitHub's, leave the owners and audience empty and set `YOUIYOUX_HUB_TOKEN`
(`openssl rand -base64 32`) instead: then whoever holds it can send a record naming any repository.

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
