<p align="center">
  <img src="./NodeWarden.svg" alt="NodeWarden Logo" />
</p>

<p align="center">
  Bitwarden-compatible server running on Cloudflare Workers
</p>

<p align="center">
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Powered%20by-Cloudflare-F38020?logo=cloudflare&logoColor=white" alt="Powered by Cloudflare" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-LGPL--3.0-2ea44f" alt="License: LGPL-3.0" /></a>
  <a href="https://github.com/shuaiplus/NodeWarden/releases/latest"><img src="https://img.shields.io/github/v/release/shuaiplus/NodeWarden?display_name=tag" alt="Latest Release" /></a>

</p>

<p align="center">
  <a href="https://t.me/NodeWarden_News">Telegram Channel</a> |
  <a href="https://t.me/NodeWarden_Official">Telegram Group</a>
</p>

<p align="center">
  <a href="./README_ZH.md">中文</a> |
  <a href="./CONTRIBUTING.md">Contributing</a> |
  <a href="https://nodewarden.app">Official wiki</a>
</p>

> **Disclaimer**  
> This project is for learning and discussion purposes only. Please back up your vault regularly.  
> This project is not affiliated with Bitwarden. Please do not report NodeWarden issues to the official Bitwarden team.

---

## Feature comparison with the official Bitwarden server

| Feature | Bitwarden Free | NodeWarden | Notes |
|---|---|---|---|
| Web vault | ✅ | ✅ | **Original Web Vault UI** |
| TOTP | ❌ | ✅ | Includes `steam://` support |
| **PWA / offline** | ❌ | ✅ | **Installable, offline** |
| **Passkey login** | ✅ | ✅ | **passwordless auth** |
| API keys | ✅ | ✅ | CLI keys; create and rotate |
| Login 2FA | ✅ | ✅ | TOTP, YubiKey, Passkey |
| 2FA recovery codes | ✅ | ✅ | One-time 2FA disable codes |
| Real-time push sync | ✅ | ✅ | All device sync |
| Attachments / Send | ✅ | ✅ | Cloudflare R2 or KV |
| Import / export | ✅ | ✅ | Bitwarden JSON / CSV / **ZIP** |
| **Cloud backup center** | ❌ | ✅ | **Scheduled WebDAV / S3 incrementals** |
| Device management | ✅ | ✅ | **Remove devices; trust controls** |
| Login requests | ✅ | ✅ | **Cross-device login approval/unlock** |
| **Multi-user** | ✅ | ✅ | Invite-code registration |
| Domain rules | ✅ | ✅ | Equivalent domains, global exclusions |
| Fill-assist | ✅ | ✅ | `POST /fill-assist`|
| Organizations / collections / roles | ✅ | ❌ | Not implemented |
| SSO / SCIM / directory | ✅ | ❌ | Not implemented |

---

## Tested clients

- ✅ Windows desktop
- ✅ Mobile app
- ✅ Browser extension
- ✅ Linux desktop
- ⚠️ macOS desktop not fully verified yet

---

## Visual quick deploy

1. Fork the NodeWarden repository to your GitHub account
2. Open [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)
3. Choose **Continue with GitHub** and select your fork
4. Set **build command** to `npm run build` and **deploy command** to `npm run deploy`
   - For KV mode, change the deploy command to `npm run deploy:kv`
5. After deployment finishes, open the generated Workers URL

- The default Workers hostname may be unreachable on some networks. To use a custom domain, add it in [Workers settings](https://dash.cloudflare.com/?to=/:account/workers/services/view/nodewarden/production/settings).

- If the site reports a missing `JWT_SECRET`, add it as a **Secret** in Workers settings. In production use a random string of at least 32 characters; do not use temporary or example values.

- To hide the Web Vault, add a text variable named `HIDE_WEB_VAULT` with the value `1` under **Workers settings → Variables and Secrets**. While enabled, server-hosted frontend pages and static assets return `404 Not Found`, while the login, sync, attachment, icon, notification, and other server endpoints used by Bitwarden clients remain available; an already installed or cached PWA can continue using its local frontend. Delete the variable (or change it to anything other than `1`) to restore the server-hosted Web Vault.

- In this flow you hand code to Cloudflare to build and deploy. `wrangler.toml` or `wrangler.kv.toml` in the repo defines binding names; the Worker initializes the D1 schema on first request—no manual SQL upload.


> [!TIP] 
> Default R2 vs optional KV:
>   | Storage | Card required | Max single attachment / Send file | Free tier |
>   |---|---|---|---|
>   | R2 | Yes | 100 MB (soft limit, adjustable) | 10 GB |
>   | KV | No | 25 MiB (Cloudflare limit) | 1 GB |


## FAQ

- **After forking the repository, why can't I see my repository when connecting GitHub to Cloudflare, or why do I get a 404 after selecting it?**  
  This is usually related to how the GitHub fork is identified or how Cloudflare handles repository authorization and synchronization. If the fork keeps a repository name, description, or other information that is very similar to the upstream project, it may be more likely to trigger related restrictions or issues. It is recommended to rename the repository to something different from the upstream project when creating the fork, and change the repository description as well. For example, you can rename it to `2233warden`. If you have already created the fork, you can rename the repository and update its description in the GitHub repository settings, then try connecting it to Cloudflare again.

- **I deleted my deployment and redeployed it. Why does registration require an invite code again?**  
  Deleting the Worker or redeploying it does not automatically delete the persistent data that was already created. The users, invite codes, and related configuration stored in the D1 database and KV namespace are still there, so the newly deployed Worker continues to read the existing data and enforce the invite-code requirement.  
  If you want to start completely from scratch, you need to delete the corresponding **D1 database and KV namespace** as well.

- **I configured `JWT_SECRET`, but the page still says it is missing. Why?**  
  Make sure `JWT_SECRET` is configured under **Workers → Settings → Variables and Secrets**, specifically as a **Runtime variable or Secret**, rather than under **Build variables**.  
  Build-time variables are only available during the build process. They are not available to the Worker at runtime, so the build may succeed while the application still reports that `JWT_SECRET` is missing.

- **Why does `JWT_SECRET` seem to disappear after an upgrade or redeployment?**  
  It is recommended to store `JWT_SECRET` as a **Secret** rather than as a plain-text variable. `JWT_SECRET` is a sensitive runtime credential and should not be committed to the repository.  
  If your deployment process recreates or overwrites the Worker variable configuration, ordinary variables may be affected. Secrets are more appropriate for sensitive configuration that needs to remain available across multiple deployments. If the application still reports that `JWT_SECRET` is missing after a redeployment, check **Variables and Secrets** for the current Worker and make sure the Secret is still configured.

---

## How to update

- Manual: open your fork on GitHub; when the sync banner appears, click **Sync fork** → **Update branch**




## CLI deploy

```powershell
git clone https://github.com/shuaiplus/NodeWarden.git
cd NodeWarden

npm install
npx wrangler login

# Default: R2 mode
npm run deploy

# Optional: KV mode
npm run deploy:kv

# Local development
npm run dev
npm run dev:kv
```

---


## External database (BYO DB) & Node.js / EdgeOne deploy

This fork adds **frontend-configurable external MySQL** (BYO DB) plus a plain Node.js server
entry, so the vault no longer depends on Cloudflare D1. The database can live anywhere
(TiDB Cloud free tier, self-hosted MySQL on a NAS, any cloud DB) and be swapped at any time.

Quick start (Node + MySQL):

```bash
npm install && npm run build
export JWT_SECRET="32+ chars"
export DB_HOST=... DB_PORT=4000 DB_USER=... DB_PASSWORD=... DB_NAME=nodewarden DB_SSL=true
export DB_CONFIG_KEY="passphrase-for-encrypted-admin-config"
npm run start:node          # http://localhost:8787
```

Then open **Admin → Database settings** (`/admin/database`) to edit/test the connection
(AES-256-GCM encrypted, password never echoed). `/healthz` reports DB mode and connectivity
only — driver errors and the version string are no longer echoed to unauthenticated callers.
Without `DB_HOST` the app falls back to D1 — `npm run deploy` works exactly like upstream.

### Deploying to Aliyun FC / self-hosting Node

A prebuilt, upload-ready package is attached to every
[release](https://github.com/muzhi621/NodeWarden_fceo/releases) (`nodewarden-fc.zip`).
Sizing that stays inside the free tier, the full env-var table, the scheduled-backup trigger
and the manual SQL for upgrading older databases are in **[FC-DEPLOY.md](FC-DEPLOY.md)**.

Three behaviours differ from upstream's Node story:

- **TLS is verified by default.** For self-signed databases set `DB_SSL_INSECURE=1`, or preferably
  point `DB_SSL_CA` at the PEM bundle. The admin "test connection" button refuses hosts that
  resolve to loopback/private/link-local ranges unless they are listed in `DB_HOST_ALLOWLIST`.
- **Scheduled backups are triggered by the platform**, not an in-process timer:
  `POST /internal/cron/backup` with an `x-cron-secret` header (`CRON_SECRET`). This avoids
  duplicate runs across instances and survives scale-to-zero. `INPROCESS_CRON=1` restores the
  old timer for single-node self-hosting only.
- **Request bodies are capped** at `MAX_BODY_MB` (default 100) and oversized uploads get a 413
  instead of exhausting memory.

Notes on the Node runtime: Durable Objects run in-process with in-memory state
(`server/local-durable-objects.ts`), so the backup centre (manual/scheduled runs,
remote restore, attachment sync) and notification tokens keep working; WebSocket
upgrades still return 501, so realtime push degrades to client polling, and DO
state is per-process (lost on cold start).
See `README_ZH.md` (外接数据库部署教程) for the full tutorial: TiDB Serverless setup,
D1→MySQL data migration, FC/SCF/EdgeOne deployment options, and Dockerfile.

### Deploying to Tencent EdgeOne Pages

`dist/` is served as static assets and the API runs as **Node Functions** — the repo already
ships the adapter, no wrapper code to write: `server/edgeone.ts` (entry),
`server/node-runtime.ts` (pipeline shared with FC), `edgeone.json` (build/SPA fallback/duration)
and `node-functions/**` (one thin entry per backend path prefix, bundled into the committed
`node-functions/_nodewarden/runtime.mjs`).

Platform limits to know: request body ≤ 6 MB, one invocation ≤ 120 s, no persistent disk
(only `/tmp`), KV is not available to Node Functions, WebSockets degrade to polling.
Deployment steps, env vars, scheduled-backup options and troubleshooting: **[EDGEONE-DEPLOY.md](EDGEONE-DEPLOY.md)**.

```bash
npm run build:edgeone     # build the web vault + bundle the Node Functions runtime
npm run test:edgeone      # 15 checks, no platform account needed
npm run test:edgeone:db   # full register → login → sync flow against a real MySQL
```

> **Upgrading an existing MySQL database?** Read FC-DEPLOY.md §6 first — two schema fixes
> (JSON columns back to `LONGTEXT`, and dropping the 191-byte prefix from the
> `webauthn_credentials.credential_id` unique index) are applied by hand on old databases.

---


## License

LGPL-3.0 License

---

## Credits

- [Bitwarden](https://bitwarden.com/) - Original design and clients
- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) - Server implementation reference
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless platform

---

## Contributors

<a href="https://github.com/shuaiplus/nodewarden/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=shuaiplus/nodewarden" alt="NodeWarden contributors" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=shuaiplus%2FNodeWarden&type=timeline&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=shuaiplus/NodeWarden&type=timeline&theme=dark&legend=top-left&sealed_token=ck0AMqR8EFMjJ6tMbnGDHT5QwMpO85IUuN7i8e82zRRNPtjoLsAAFwVzxmSZwaid97wLUwy56EEiVE9M-OY0cf16bQKBrU9GaauFoOFXGq-vMqcOyk0tIc4b3o1ZGfDw9IH8o6NUxC125TJkjKSLn9fxhFUUeNr1f1El0UcAUcjsMPl_LX80qQrlvQqp" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=shuaiplus/NodeWarden&type=timeline&legend=top-left&sealed_token=ck0AMqR8EFMjJ6tMbnGDHT5QwMpO85IUuN7i8e82zRRNPtjoLsAAFwVzxmSZwaid97wLUwy56EEiVE9M-OY0cf16bQKBrU9GaauFoOFXGq-vMqcOyk0tIc4b3o1ZGfDw9IH8o6NUxC125TJkjKSLn9fxhFUUeNr1f1El0UcAUcjsMPl_LX80qQrlvQqp" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=shuaiplus/NodeWarden&type=timeline&legend=top-left&sealed_token=ck0AMqR8EFMjJ6tMbnGDHT5QwMpO85IUuN7i8e82zRRNPtjoLsAAFwVzxmSZwaid97wLUwy56EEiVE9M-OY0cf16bQKBrU9GaauFoOFXGq-vMqcOyk0tIc4b3o1ZGfDw9IH8o6NUxC125TJkjKSLn9fxhFUUeNr1f1El0UcAUcjsMPl_LX80qQrlvQqp" />
 </picture>
</a>
