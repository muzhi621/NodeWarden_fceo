<p align="center">
  <img src="./NodeWarden.svg" alt="NodeWarden Logo" />
</p>

<p align="center">
  运行在 Cloudflare Workers 上的 Bitwarden 兼容服务端
</p>

<p align="center">
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Powered%20by-Cloudflare-F38020?logo=cloudflare&logoColor=white" alt="Powered by Cloudflare" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-LGPL--3.0-2ea44f" alt="License: LGPL-3.0" /></a>
  <a href="https://github.com/shuaiplus/NodeWarden/releases/latest"><img src="https://img.shields.io/github/v/release/shuaiplus/NodeWarden?display_name=tag" alt="Latest Release" /></a>

</p>

<p align="center">
  <a href="https://t.me/NodeWarden_News">Telegram 频道</a> |
  <a href="https://t.me/NodeWarden_Official">Telegram 群组</a>
</p>

<p align="center">
  <a href="./README.md">English</a> |
  <a href="./CONTRIBUTING.md">贡献指南</a> |
  <a href="https://nodewarden.app">官方wiki</a>
</p>

> **免责声明**  
> 本项目仅供学习与交流使用，请定期备份你的密码库。  
> 本项目与 Bitwarden 官方无关，请不要向 Bitwarden 官方反馈 NodeWarden 的问题。

---

## 与 Bitwarden 官方服务端能力对比

| 能力 | Bitwarden免费版 | NodeWarden | 说明 |
|---|---|---|---|
| 网页密码库 | ✅ | ✅ | **原创Web Vault界面** |
| TOTP | ❌ | ✅ | 包括 `steam://` 支持 |
| **PWA / 离线使用** | ❌ | ✅ | **可安装、离线使用、App快捷方式** |
| **Passkey 登录** | ✅ | ✅ | **支持WebAuthn/FIDO2无密码登录** |
| API 密钥 | ✅ | ✅ | 供bitwarden cli使用，支持获取和轮换 |
| 登录 2FA | ✅ | ✅ | 支持 TOTP、YubiKey、Passkey |
| 2FA 恢复码 | ✅ | ✅ | 一次性恢复码用于禁用 2FA |
| 实时推送同步 | ✅ | ✅ | 网页端、浏览器扩展、电脑端和手机端实时同步 |
| 附件 / Send| ✅ | ✅ | Cloudflare R2 或 KV |
| 导入 / 导出 | ✅ | ✅ | 支持 Bitwarden JSON / CSV / **ZIP 导入（包括附件）** |
| **云端备份中心** | ❌ | ✅ | **支持 WebDAV / S3 定时增量备份** |
| 设备管理 | ✅ | ✅ | **删除设备、撤销信任、永久信任** |
| 登录请求 | ✅ | ✅ | **多端免密登录审批、跨设备解锁请求** |
| **多用户使用** | ✅ | ✅ | 支持邀请码注册 |
| 域名规则 | ✅ | ✅ | 自定义等效域名、全局域名排除 |
| Fill-assist | ✅ | ✅ | `POST /fill-assist` 辅助客户端自动填充；不能绕过保险库解锁 |
| 组织 / 集合 / 成员权限 | ✅ | ❌ | 未实现 |
| SSO / SCIM / 企业目录 | ✅ | ❌ | 未实现 |

---

## 已测试客户端

- ✅ Windows 桌面端
- ✅ 手机 App
- ✅ 浏览器扩展
- ✅ Linux 桌面端
- ⚠️ macOS 桌面端尚未完整验证

---

## 可视化快速部署

1. Fork NodeWarden 仓库到自己的 GitHub 账号
2. 进入 [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)
3. 选择 Continue with GitHub 并选择你的仓库
4. 构建命令填 `npm run build`，部署命令填 `npm run deploy`
- 如果你打算用 KV 模式，把部署命令改成 `npm run deploy:kv`
5. 等部署完成后，打开生成的 Workers 域名

- Workers 默认域名在部分网络环境不可直连。如需自定义域名，到 [Workers 设置](https://dash.cloudflare.com/?to=/:account/workers/services/view/nodewarden/production/settings)里添加。

- 页面提示缺少 `JWT_SECRET` 时，到 Workers 设置里添加 Secret。正式环境至少使用 32 个字符以上的随机字符串，不要使用临时值或示例值。

- 如需隐藏 Web Vault，在 Workers 的“设置 → 变量和机密”中添加文本变量 `HIDE_WEB_VAULT`，值设为 `1`。启用后，服务器上的前端页面和静态资源统一返回 `404 Not Found`，Bitwarden 客户端所需的登录、同步、附件、图标、通知等服务端接口仍可使用；已经安装或缓存的 PWA 可以继续使用本地前端。删除该变量（或将值改为非 `1`）即可恢复服务器上的 Web Vault。

- 这套流程里，用户实际做的是把代码交给 Cloudflare 构建并部署。代码里的 `wrangler.toml` 或 `wrangler.kv.toml` 决定绑定名，Worker 第一次处理请求时会自动初始化 D1 schema，不需要用户上传 SQL。


> [!TIP] 
> 默认R2与可选KV的区别：
>   | 储存 | 是否需绑卡 | 单个附件/Send文件上限 | 免费额度 |
>   |---|---|---|---|
>   | R2 | 需要 | 100 MB（软限制可更改） | 10 GB |
>   | KV | 不需要 | 25 MiB（Cloudflare限制） | 1 GB |


## 常见问题：
- **Fork 完仓库后，在 Cloudflare 连接 GitHub 账户时看不到自己的仓库，或者选择仓库后返回 404？**  
  这通常与 GitHub Fork 仓库的识别或 Cloudflare 对仓库的授权/同步有关。如果 Fork 后仓库名称、描述等信息与上游项目高度一致，可能更容易触发相关限制或异常。建议在 Fork 时就将仓库名称修改为与上游不同的名称，并同时修改仓库描述，例如改为 `2233warden`。如果已经完成 Fork，也可以直接在 GitHub 仓库设置中修改名称和描述，然后重新尝试在 Cloudflare 中连接。

- **我删掉部署后重新部署，为什么注册又开始要求邀请码了？**  
  因为删除 Worker 或重新部署并不会自动删除已经创建的持久化数据。D1 数据库和 KV 命名空间中的用户、邀请码及相关配置仍然存在，因此重新部署后仍会读取原来的数据，并继续要求邀请码。  
  如果希望完全重新开始，需要同时删除对应的 **D1 数据库和 KV 命名空间**。

- **我配置了 `JWT_SECRET`，为什么页面仍然提示缺少？**  
  请将 `JWT_SECRET` 配置在 Cloudflare Workers 的 **Settings → Variables and Secrets** 中，并确保它属于 **Runtime variables and secrets**，而不是 **Build variables**。  
  Build 阶段的变量只在项目构建过程中可用，Worker 实际运行时无法通过运行时环境读取，因此即使构建能够正常完成，页面仍可能提示 `JWT_SECRET` 缺失。

- **为什么升级或重新部署后，`JWT_SECRET` 好像消失了？**  
  建议将 `JWT_SECRET` 配置为 **Secret**，而不是普通的明文变量。`JWT_SECRET` 属于敏感的运行时凭据，也不应该出现在代码仓库中。  
  如果部署流程会重新生成或覆盖 Worker 的变量配置，普通变量可能受到影响；使用 Secret 更适合保存这类需要在多次部署之间持续存在的敏感配置。重新部署后如果仍提示缺失，请检查当前 Worker 的 **Variables and Secrets** 中是否仍存在该 Secret。

---

## 更新方法：
- 手动：打开你 Fork 的 GitHub 仓库，看到顶部同步提示后，点击 `Sync fork` ➜ `Update branch`




## CLI 部署

```powershell
git clone https://github.com/shuaiplus/NodeWarden.git
cd NodeWarden

npm install
npx wrangler login

# 默认：R2 模式
npm run deploy

# 可选：KV 模式
npm run deploy:kv

# 本地开发
npm run dev
npm run dev:kv
```

---


## 外接数据库（BYO DB）与 Node.js / EdgeOne 部署教程

> 本分支新增能力：**数据库配置前台化 + 外接 MySQL**（BYO DB）。数据库不再绑定 Cloudflare D1，
> 可以部署在任何地方（TiDB Serverless 免费层、家里 NAS 自建 MySQL、任意云数据库），由应用按配置直连。
> 库随时可搬，彻底摆脱平台续费锁定。配套 Node.js 运行入口，可部署到 阿里云 FC / 腾讯云 SCF / EdgeOne Pages / 任意 Node 主机。

### 1. 功能总览

| 能力 | 说明 |
|---|---|
| 前台配置 UI | 管理后台 → `/admin/database`：填写 host/端口/账号/密码/库名/TLS，支持**测试连接**、**一键建表** |
| 加密存储 | 配置用 AES-256-GCM 加密保存（主密钥来自 `DB_CONFIG_KEY`），密码永不回显 |
| 环境变量配置 | 也可以直接用 `DB_HOST` 等环境变量（优先级高于前台配置） |
| MySQL 适配器 | 业务 SQL 自动从 SQLite/D1 方言翻译为 MySQL（含 upsert/json/PRAGMA 等 20+ 处差异），19 张表自动建表 |
| 双存储路由 | 未配置 MySQL 时自动使用 D1（Cloudflare Workers 原样可用）；配置后即时切换，无需重启 |
| 健康检查 | `GET /healthz` 返回数据库模式与连接状态（不再回显驱动错误和版本号） |
| 数据迁移 | 用内置备份导出/导入（`/api/admin/backup`）把 D1 数据搬到 MySQL（见下文） |

> 📦 **开箱即用的阿里云 FC 部署包**：每个 [Release](https://github.com/muzhi621/NodeWarden_fceo/releases)
> 都附带 `nodewarden-fc.zip`（已构建好前端与后端 bundle，免装依赖直接上传）。
> 规格选型、环境变量、平台定时备份、旧库升级 SQL 见 **[FC-DEPLOY.md](FC-DEPLOY.md)**。
>
> 与本家（上游）行为的三处差异，升级前务必知道：
> - **TLS 默认校验证书**：自签库设 `DB_SSL_INSECURE=1`，更好的是把 `DB_SSL_CA` 指向 PEM；
> - 后台「测试连接」默认拒绝内网/回环地址，自建库在内网需把 host 加进 `DB_HOST_ALLOWLIST`；
> - **定时备份改为平台触发**：`POST /internal/cron/backup` + `x-cron-secret` 头（`CRON_SECRET`），
>   不再用进程内定时器（避免多实例重复跑、缩容到 0 后停摆）；单机自托管可用 `INPROCESS_CRON=1` 恢复旧行为。

### 2. 快速开始（Node.js + 外接 MySQL）

```bash
git clone <本仓库>
cd nodewarden
npm install
npm run build            # 构建 Web 管理界面到 dist/

# 配置环境变量后启动（MySQL 配置也可以启动后在 /admin/database 页面里填）
export JWT_SECRET="至少32位随机字符串"
export DB_HOST="你的MySQL地址"      # 例如 TiDB: gz-xxx.tidbcloud.com
export DB_PORT=4000                  # TiDB Serverless 为 4000，自建多为 3306
export DB_USER="nodewarden"
export DB_PASSWORD="********"
export DB_NAME="nodewarden"
export DB_SSL=true                   # TiDB 必须开启
export DB_CONFIG_KEY="任意口令或base64(32字节)"  # 前台配置的加密主密钥

npm run start:node                   # 默认监听 http://localhost:8787
```

启动后访问 `http://localhost:8787` 完成注册；管理员登录后进入 **管理后台 → 数据库设置**（`/admin/database`）可随时查看/修改连接配置。

**常用环境变量**

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | ✅ | 32 位以上随机串 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | 二选一 | 外接 MySQL 连接（与前台配置二选一，环境变量优先） |
| `DB_SSL` | — | 默认 `true`；TiDB Serverless 必须开启 |
| `DB_CONN_LIMIT` | — | 连接池上限，默认 5 |
| `DB_CONFIG_KEY` | 前台配置时必填 | 前台保存配置的加密主密钥 |
| `DATA_DIR` | — | 数据目录（附件/配置文件），默认 `./data` |
| `PORT` | — | 监听端口，默认 8787 |
| `HIDE_WEB_VAULT` / `WEBAUTHN_*` | — | 与 Workers 版一致 |

### 3. 数据库去处推荐（个人免费/极低价）

| 方案 | 价格 | 说明 |
|---|---|---|
| **TiDB Cloud Starter（推荐）** | 免费层：25GiB 存储 + 250M RU/月 | MySQL 协议兼容、托管免运维、TLS 强制（端口 4000）；机房在海外，跨境延迟略高 |
| 自建 MySQL（NAS/云主机） | ¥0 起 | 国内延迟最低；**必须** TLS + 强密码 + 非默认端口 + 最小权限账号（函数出口 IP 不固定，无法做 IP 白名单） |
| 国内云数据库（RDS/TDSQL-C） | 按量/包年 | 延迟最低，注意新人价续费陷阱 |

### 4. 从 Cloudflare D1 迁移数据

1. 在旧部署（D1）的管理后台使用 **备份导出**（`/api/admin/backup/export`，需主密码）下载加密归档；
2. 部署新实例并连上目标 MySQL（启动时自动建表）；
3. 在新实例管理后台使用 **备份导入**（`/api/admin/backup/import`）恢复；
4. 客户端重新登录并同步，确认数据一致后下线旧实例。

### 5. 部署到云平台

**方式 A：任意 Node 主机 / 容器 / FC / SCF 自定义运行时（推荐）**

`npm run start:node` 就是一个标准 HTTP 服务（监听 `PORT`），可直接跑在云主机、Docker、
阿里云 FC 自定义运行时、腾讯云 SCF 等任何能跑 Node 22 的地方。容器示例：

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
ENV PORT=8787
CMD ["npm", "run", "start:node"]
```

**方式 B：EdgeOne Pages（Node Functions）**

- 静态资源 `dist/` 由 Pages 托管，后端由 `node-functions/**` 里的 **Node Functions** 承载
  （`context.env` 注入 `DB_*` / `JWT_SECRET`，`onRequest(context)` 入口）；
- 仓库里已经适配好，**不需要自己写包装代码**：`server/edgeone.ts` 是入口适配层，
  `server/node-runtime.ts` 是与 FC 共用的请求管线，`edgeone.json` 声明构建命令 / 输出目录 /
  缓存与安全头 / 函数时长，`scripts/edgeone-postbuild.mjs` 产出 `dist/404.html` 兜底 SPA 深链，
  函数入口由 `scripts/build-edgeone.mjs` 打包成 `node-functions/_nodewarden/runtime.mjs`（已提交）；
  注意 EdgeOne 的 `rewrites` **不支持** SPA 路由回退，也不读 `_redirects`，别用 `/* → /index.html` 硬修；
- 页面上**不要**绑定 KV：EdgeOne 的 KV 只给 Edge Functions，Node Functions 用不了；本分支改成
  「环境变量 + MySQL」，也不依赖平台的持久磁盘（后台保存的配置在 `/tmp`，冷启动会丢）；
- 平台限制：请求体 ≤6 MB、单次执行 ≤120s、WebSocket 走轮询降级 —— 明细、部署步骤、排错见
  **[EDGEONE-DEPLOY.md](EDGEONE-DEPLOY.md)**。

自测（不用开平台账号）：

```bash
npm run build:edgeone     # 构建前端 + 打包 Node Functions bundle
npm run test:edgeone      # 路由/CORS/cron 鉴权等 15 项
npm run test:edgeone:db   # 接真实 MySQL 跑注册→登录→同步→写入
```

**方式 C：Cloudflare Workers（原版 D1，零改动）**

```bash
npm run deploy      # R2 模式
npm run deploy:kv   # KV 模式
```

未配置 `DB_HOST` 时自动走 D1，行为与上游完全一致。

### 6. 功能降级说明（Node 运行时）

- **实时推送**：WebSocket 升级在 Node 运行时不可用（`/notifications/hub` 返回 501），
  Bitwarden 客户端自动降级为轮询同步（功能不缺，实时性略降）；`negotiate` 正常返回令牌，
  不会再报 `Failed to issue websocket connection token`；
- **备份中心的远程备份/恢复**：Durable Objects 以**进程内实现**运行
  （`server/local-durable-objects.ts`，内存版 `state.storage`），手动/定时备份、WebDAV/S3
  远程还原、附件同步均可正常使用；代价是 DO 状态按进程保存、冷启动丢失（只影响 60 秒
  WebSocket 令牌与 10 分钟备份任务租约，不影响数据）；
- **限流/同步缓存**：`caches.*` 为进程内内存缓存，多实例部署时按实例独立（个人单实例无影响）。

### 7. 测试与验证

```bash
npm run test:mysql-dialect   # SQL 方言翻译器单元测试
npm run test:db-lifecycle    # 切库/初始化生命周期测试
npx tsc --noEmit             # 类型检查
npm run build                # 前端构建
curl http://localhost:8787/healthz   # 健康检查（返回数据库模式/连接状态）
```

---


## 开源协议

LGPL-3.0 License

---

## 致谢

- [Bitwarden](https://bitwarden.com/) - 原始设计与客户端
- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) - 服务端实现参考
- [Cloudflare Workers](https://workers.cloudflare.com/) - 无服务器平台

---

## 贡献者

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
