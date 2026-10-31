# NodeWarden BYO-DB — 腾讯 EdgeOne Pages 部署说明

> 版本 **v1.8.3**，与 `FC-DEPLOY.md`（阿里云 FC）同源同库，只是换了一个托管平台。
> 代码来源：分支 `edgeone`（基于 `test`）。遵循项目约定：本分支独立，**未合并、未改动 main / test**，
> 由用户确认后再合并。
>
> **两个平台可以同时在线**：它们连同一个外接 MySQL 即可（同一份数据，互不影响；但不要让浏览器同时
> 往两台服务器写同一个账号，会互相覆盖同步版本，正常使用只选一个入口）。

---

## 一、结论先说（EdgeOne vs 阿里云 FC）

| 维度 | 腾讯 EdgeOne Pages | 阿里云 FC（已部署成功） |
|---|---|---|
| 部署形态 | 静态资源（`dist/`）+ **Node Functions**（`node-functions/**`） | Web 函数（跑一个常驻 HTTP 服务） |
| 代码改造 | **已在本分支完成**（见第三节），无需你写代码 | 打包好的 ZIP 直接上传 |
| 请求体上限 | **6 MB**（平台硬限制） | 100 MB（我们自己的 `MAX_BODY_MB`） |
| 单次执行时长 | 默认 30s，可配至 **120s**（`edgeone.json` 已设 120） | 可设 300s（备份/还原够用） |
| 可写磁盘 | 只有 `/tmp`，随实例回收清空 | 只有 `/tmp`（挂 NAS/OSS 可持久化） |
| KV 存储 | **Node Functions 用不了**（官方 KV 只给 Edge Functions） | 无（正好都走 MySQL） |
| 实时推送（WebSocket） | 走轮询降级（与 FC 相同） | 走轮询降级 |
| 免费额度 | 免费版：100 万次函数调用/月 + 计算额度（GB·s），送 CDN 流量与 SSL | 100 万次/月 + 40 万 CU·s |
| 额外好处 | 白送全站 CDN、免费 SSL、自定义域名、安全防护 | 执行时长大、可挂 NAS |

一句话：**EdgeOne 更省流量费、更适合只做「密码库 Web 入口 + 客户端 API」的个人场景；
FC 更适合当需要上传大附件、长时间备份的主力。** 两台的免费额度对个人（约 11 万次/月）都只用 1~2%。

---

## 二、这个分支加了什么（都在新增文件里，不动原有逻辑）

```
server/node-runtime.ts        ← 新增：平台无关的请求管线（env 组装、KV/R2 文件桩、
                                 caches 桩、进程内 Durable Objects、cron tick）
server/index.ts               ← 改薄：只剩 http.Server（FC / 本机 start:node 用），
                                 行为、日志、端口、MAX_BODY_MB 全部不变
server/edgeone.ts             ← 新增：EdgeOne 入口适配层（onRequest 封装 + 公网 URL/IP 修正
                                 + 平台定时任务的 secret 透传）
server/cf-workers-stub.mjs    ← 新增：cloudflare:workers 桩，供 EdgeOne 打包时内联
node-functions/**             ← 新增：15 个薄入口，把后端路径映射成 Node Functions
node-functions/_nodewarden/runtime.mjs  ← 新增：打包产物（已提交，与 FC 的 server/index.mjs 同理）
edgeone.json                  ← 新增：构建配置、缓存/安全头、函数时长、mysql2 外置
scripts/edgeone-postbuild.mjs ← 新增：构建后产出 dist/404.html（SPA 深链兜底）
scripts/build-edgeone.mjs     ← 新增：打包 + 漂移检查
scripts/edgeone-smoke.mjs     ← 新增：本地模拟平台调用的自测（可接真实 MySQL）
```

为什么不能直接复用 `server/index.ts`：EdgeOne 的 Node Functions 是**一次调用一个 `onRequest(context)`**，
没有端口可以监听，也没有 `http.Server`。所以把「请求进来到响应出去」的那段抽成 `node-runtime.ts`，
让 http 服务和函数入口共用同一套管线——两边的行为完全一致（同一份路由、同一份鉴权、同一份 MySQL 方言翻译）。

### 路由是怎么映射的

EdgeOne 按 `node-functions/` 的目录结构生成路由。因为后端路径分散在根级（`/api`、`/identity`、
`/healthz`…），这里**没有**用根级 `[[default]].js` 兜底（那会把静态资源也拦下来，官方文档明确要求
「需在函数内处理静态资源的返回」），而是给每个后端前缀建一个入口：

| 文件 | 覆盖的路径 |
|---|---|
| `node-functions/api/[[default]].js` | `/api/**`（sync、ciphers、sends、attachments、admin…） |
| `node-functions/identity/[[default]].js` | `/identity/**`（connect/token、accounts/prelogin、2FA…） |
| `node-functions/icons/[[default]].js` | `/icons/{域名}/icon.png` |
| `node-functions/notifications/[[default]].js` | `/notifications/**`（轮询、negotiate） |
| `node-functions/fill-assist/`、`devices/`、`auth-requests/`、`webauthn/` | 同名兼容路径 |
| `node-functions/healthz.js`、`config.js`、`web-bootstrap.js` | 精确路径 |
| `node-functions/accounts/kdf.js`、`settings/domains.js`、`v1/[id].js` | 精确路径（`/v1/assetlinks:check` 由 `[id]` 动态段接） |
| `node-functions/internal/cron/backup.js` | 计划备份触发端点 |

静态资源（`/`、`/assets/*`、`/favicon.ico`、`/webauthn-connector.html`…）由 Pages 直接托管，
不消耗函数调用。

### 前端深链（刷新 `/vault`、`/admin/database`）怎么兜底

这一版**没有**在 `edgeone.json` 里写 `rewrites: [{ "source": "/*", "destination": "/index.html" }]`，
原因有两个：

1. 官方文档对该项写得很明确——**重写只作用于静态资源，不支持 SPA 前端路由重写**；
2. `/*` 这种写法不带 `:splat`，一旦平台真的按字面执行，会把 `/assets/*.js` 也重写成 index.html，
   直接白屏。**这是个容易踩的坑，别加回去。**

实际做法：
- EdgeOne Pages 静态托管对「找不到的路径」默认回退到 `index.html`（腾讯云官方答复也是这个行为），
  深链刷新直接可用；
- 构建时额外产出 `dist/404.html`（= `index.html` 的副本，见 `scripts/edgeone-postbuild.mjs`）作为兜底：
  万一某次部署用的是「自定义 404 页」而不是回退到 index.html，页面照样能起来、由前端路由接管
  （此时 HTTP 状态码是 404，功能不受影响）。

> `dist/_redirects` 是 Cloudflare Pages 的约定，**EdgeOne Pages 不读**，不要指望它。

---

## 三、部署步骤（控制台）

### 0. 前置：一个外接 MySQL
与 FC 完全一样（TiDB Cloud Starter 免费层 / 自建 MySQL 都行），**两台服务器可以连同一个库**。
如果已经在 FC 上用得好好的，**这一步可以跳过**，直接复用现有 `DB_*`。

### 1. 建项目
1. 打开 [EdgeOne Pages 控制台](https://console.cloud.tencent.com/edgeone/pages) → 新建项目 → **导入 Git 仓库**；
2. 选 `muzhi621/NodeWarden_fceo`，分支 **`edgeone`**；
3. 构建配置由仓库根的 `edgeone.json` 决定，无需手填（控制台里也应显示）：

   | 项 | 值 |
   |---|---|
   | 安装命令 | `npm install --no-audit --no-fund` |
   | 构建命令 | `npm run build:edgeone:pages`（= Vite 构建 + 产出 `404.html`） |
   | 输出目录 | `dist` |
   | Node 版本（构建） | `22.11.0` |

> `node-functions/_nodewarden/runtime.mjs` 是**已提交的打包产物**，构建阶段不需要跑 esbuild，
> 因此构建命令只有前端 Vite 构建（外加一个零依赖的 404 页复制）。若你改了 `src/` 或 `server/`，
> 记得先在本地 `npm run build:edgeone` 重新打包并提交（见第七节）。

### 2. 环境变量（项目设置 → 环境变量）

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | ✅ | ≥32 位随机串 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | ✅（推荐） | 与 FC 相同；TiDB 端口 `4000` |
| `DB_SSL` | — | TiDB 必须 `true`；自建无 TLS 时 `false` |
| `DB_CONN_LIMIT` | — | 连接池上限，默认 5，函数环境不建议调大 |
| `CRON_SECRET` | 计划备份时 | 见第六节 |
| `MAX_BODY_MB` | — | **建议设 `5`**（平台请求体上限 6 MB，设大了也用不上） |
| `HIDE_WEB_VAULT` / `WEBAUTHN_*` / `YUBICO_VALIDATION_URLS` | — | 与 Workers / FC 版一致 |

> ⚠️ 平台限制：**变量值最长 1000 字节**，改动**只对新部署生效**（改完要重新部署一次）。
> ⚠️ 不用设 `DATA_DIR`：本分支在函数模式下默认用 `/tmp/nodewarden`。
> ⚠️ `DB_SSL_CA`（PEM 文件路径）在 EdgeOne 上没法用——没有可上传持久文件的位置；
> 自签库请用 `DB_SSL_INSECURE=1`，TiDB 的公信 CA 无需配置。
> ⚠️ `INPROCESS_CRON` **不要开**：多实例会各跑一遍备份，而且会让实例无法休眠。

后台 `/admin/database` 依然可用（查看状态、测试连接、一键建表都行），但**不要用后台保存配置**：
本平台的函数没有持久磁盘，配置写在 `/tmp` 里冷启动就丢。**数据库连接请一律用环境变量。**

### 3. 部署与域名
1. 点「部署」，首次约 1~3 分钟（含 npm install + Vite 构建）；
2. 得到 `https://<项目名>.edgeone.app`（或 `.edgeone.run`）域名，先自测；
3. 项目设置 → 域名 → 绑定自定义域名，SSL 证书自动签发（免费版即含）。

### 4. 首次使用
打开域名 → 注册管理员 → 进 `/admin/database` 确认「外接 MySQL · 已就绪、19 张表已建」→
Bitwarden 客户端用该地址登录、保存/同步一条密码。

---

## 四、验证

```bash
curl https://<你的域名>/healthz
# 期望：{"ok":true,"db":"up","mode":"mysql","source":"env","runtime":"node"}
```

- `runtime:"node"` 表示请求确实进了 Node Functions（不是静态资源）；
- `/healthz` 是**函数路径**，会消耗一次调用；静态页 `/`、`/assets/*` 不会。
- 前端深链（直接刷新 `/admin/database`）应返回 Web 界面（静态层回退到 index.html / 404.html 兜底）。
- Bitwarden 网页端 / 桌面端 / 浏览器扩展能登录并同步即算通过。

---

## 五、已知限制（务必先看，和 FC 的差异都在这里）

| 限制 | 影响 | 应对 |
|---|---|---|
| **请求体 6 MB** | 附件、Send 文件、备份导入超过 6 MB 会被平台直接拒（413/中断） | 大附件场景用 FC 或 CF；本站只放小附件 |
| **单次 120s** | 备份上传/远程还原可能超时；超时后进度会停在中途 | 备份改用 FC 触发，或把任务拆小；不要指望 120s 内完成大库还原 |
| **只有 `/tmp`** | 附件、`/admin/database` 的后台配置、进程内 Durable Object 状态在实例回收后丢失 | 数据库用环境变量；附件另存（重要附件别只放这里） |
| **KV 不可用** | 无法用平台 KV 存配置 | 本分支已改为「MySQL + 环境变量」，不依赖 KV |
| **无 WebSocket** | 实时推送不可用，客户端自动退回轮询 | 功能不缺，实时性略降（与 FC 相同） |
| **冷启动** | 实例休眠后首个请求要多等几百毫秒~2s，且要跑一次建表检查 | 正常现象；不要把 `minInstances` 调高（免额度会被吃掉） |
| **多实例** | 限流计数、备份任务租约是进程内内存，多实例各自独立 | 个人单账号场景无影响 |

> 结论：**EdgeOne 适合当「随时可用的 Web 入口 + 客户端 API」；如果你的用法重度依赖附件和备份，
> 让 FC 当主力，EdgeOne 当备用入口。**

---

## 六、计划备份（两种触发方式）

平台自带的定时任务（`edgeone.json → schedules`）**不支持自定义请求头**，所以本分支额外支持
「把 secret 放进 JSON body」：

```json
{
  "schedules": [
    {
      "name": "nodewarden-backup",
      "cron": "0 3 * * *",
      "path": "/internal/cron/backup",
      "method": "POST",
      "payload": { "secret": "<你的 CRON_SECRET>" }
    }
  ]
}
```

- 官方对 `schedules` 的说明是「精度到分钟，**最小间隔一天**」——所以想做**每 5 分钟**的计划备份，
  请用外部 cron（GitHub Actions / 云函数 / Uptime 机器人）打带头的请求：

```bash
curl -X POST https://<你的域名>/internal/cron/backup -H "x-cron-secret: <CRON_SECRET>"
```

- 没设 `CRON_SECRET` 时该端点返回 **503**（拒绝无鉴权触发），不会静默放行。

---

## 七、本地自测（不用开平台账号）

```bash
npm ci
npm run build:edgeone      # = npm run build + 打 node-functions/_nodewarden/runtime.mjs
npm run test:edgeone       # 15 项：路由映射、CORS、cron 鉴权、公网 URL/IP 修正、静态层隔离
```

接一个**真实 MySQL** 跑完整链路（注册 → 登录 → 同步 → 写入条目 → healthz）：

```bash
# 方式一：环境变量
SMOKE_DB_HOST=127.0.0.1 SMOKE_DB_PORT=3306 SMOKE_DB_USER=root SMOKE_DB_NAME=nodewarden_edgeone \
  npm run test:edgeone:db

# 方式二：把连接信息放进仓库根 .smoke-db.json（已 gitignore，命令行不留密码）
{ "host": "127.0.0.1", "port": 3306, "user": "root", "password": "", "name": "nodewarden_edgeone" }
npm run test:edgeone:db
```

自测做的就是「模拟 EdgeOne 调函数」：`onRequest({ request, env, clientIp })` → `Response`，
用的是**已提交的那份 bundle**，所以本地过了等于平台上大概率也过。

改了 `src/` 或 `server/` 之后：

```bash
npm run build:edgeone      # 重新打包并提交
npm run check:edgeone      # CI/本地校验：提交的 bundle 是否与源码一致（不一致退出码 1）
```

---

## 八、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开域名 404，`/healthz` 也 404 | 函数未部署（只有静态资源） | 确认分支是 `edgeone`、`node-functions/` 已提交；重新部署看构建日志 |
| `/healthz` 502/超时 | 函数起来了但连不上库 | 检查 `DB_*`、`DB_SSL`；函数出口是公网，自建库别只监听内网 |
| 全站 500 `Database not initialized` | 建表失败 | 看 Pages → 函数日志；常见是账号没有 CREATE 权限、或 `DB_NAME` 写错 |
| 浏览器刷新子页面出现 404 白屏 | 静态层没有回退到 index.html，且 `dist/404.html` 也丢了 | 确认构建命令是 `npm run build:edgeone:pages`（会产出 `404.html`）；**不要**用 `rewrites: /* → /index.html` 硬修，那条规则会连 `/assets/*` 一起重写 |
| 注册报 `403 Forbidden origin` | 请求的 `Origin` 与服务器识别的站点域名不一致 | 本分支已用 `x-forwarded-host` 修正；若仍报，检查是否套了一层 CDN/反代改了 Host |
| 注册/登录报 `403 Client IP is required` | 平台没把客户端 IP 传进来 | 本分支已用 `context.clientIp` 补 `X-Forwarded-For`；若仍报，说明平台字段变了，需同步适配 |
| 上传附件失败 | 超过 6 MB 平台上限 | 换小文件或用 FC |
| 修改环境变量后没变化 | 平台规则：只对新部署生效 | 改完重新部署一次 |
| 构建失败提示 Node 版本 | `edgeone.json` 的 `nodeVersion` 与环境不匹配 | 改成控制台默认，或换成 `20.18.0` / `22.11.0` |

---

## 九、从 FC 迁到 EdgeOne（几乎零成本）

1. EdgeOne 项目里把 `DB_*` 指向**现在 FC 用的那个 MySQL**（数据完全不用动）；
2. 部署完成后 `curl https://<域名>/healthz`，确认 `db:"up"`；
3. 用 Bitwarden 客户端登录验证；
4. 确认无误后，把客户端服务器地址改成新域名（或把旧域名 CNAME 过去）。
   注意：**不要两处同时写**，否则同账号在两个入口的同步版本会互相打架。

---

## 十、分支与合并

- 本分支 `edgeone` 从 `test` 拉出，只新增/最小改动上述文件，**未合并任何分支**。
- 自测结论（本地，2026-10-31，提交前重跑）：
  - `npm run test:edgeone` → 15/15；
  - `npm run test:edgeone:db`（真实 MySQL 8.0.30）→ 22/22（注册/登录/同步/写条目/cron/healthz）；
  - FC 入口回归（`node server/index.mjs` 真实 HTTP + 同一 MySQL）→ 8/8（含 `/notifications/hub/negotiate`）；
  - 既有单测：node-runtime 4、db-lifecycle 7、db-policy 7、db-config-save 4、app-routes 2、
    mysql-dialect 52、webauthn-connectors 3，全绿；`tsc --noEmit` 干净。
- 你确认 EdgeOne 上真机跑通后，再把 `edgeone` 合并进 `main`（合并动作由你执行，我不代劳）。
