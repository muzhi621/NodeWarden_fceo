# NodeWarden BYO-DB — 阿里云 FC 部署说明

> 本文件在**仓库根目录**与**部署 ZIP 根目录**各存一份，内容一致。
> 部署包是为「阿里云函数计算 FC · Web 函数」准备的可直接上传 ZIP，版本 **v1.8.11**。
> 代码来源：`main` 分支（BYO-DB + Node 运行时 + 多轮代码审查修复）。
>
> 注：下文的「包内容」以 **ZIP 包**为准。仓库里的 `node_modules/` 是完整开发依赖，
> `dist/`、`server/index.mjs` 需自行构建（见第九节）；`fc-entry.mjs` 在仓库根目录，
> 组包时原样复制到包根即可。
>
> **从 v1.8.10 升级**：替换 `dist/`、`server/index.mjs`（及 `node-functions/`，若用 EdgeOne）
> 与根目录文档即可，**数据库不用动**。这一版解决的是「继续用环境变量、但副库一直同步不了」：
>
> - 新增 `DB_STANDBY_NAME`（副库库名）。设置后环境变量配置本身就变成**主库 + 副库双节点**，
>   「同步数据到副库」不再需要删掉 `DB_*`、也不需要 NAS 或后台配置能挺过冷启动——
>   副库信息就在环境变量里，重启即恢复。同实例时其余参数全部沿用主库，只加一行。
> - 环境变量副库**不参与自动切换、不分摊读**：它是手动同步出来的备份。主库抖一下就自动切到
>   一个可能空着的库，代价是所有人被登出且回不来，所以这条固定关闭。
> - 切主库的方式相应变成「互换 `DB_NAME` 与 `DB_STANDBY_NAME` 后重启」。
> - 副库库还没建时报错会直说 `CREATE DATABASE`，不再只说「建表失败」。
>
> **从 v1.8.9 升级**：只需替换 `dist/`、`server/index.mjs`、`node-functions/`（若用 EdgeOne）
> 与根目录文档，**数据库不用动**。这一版没有 schema 变更，改的是「后台 → 数据库」页面上
> 几个会静默失败的地方：
>
> - 同步到副库卡在「数据表 0/？、已处理 0 行」时，现在会直接说原因（源库没有任何基础表 /
>   副库还没建表 / 副库自动建表失败），不再显示成「上次同步未完成」；
> - 副库是空库时，点同步会先自动建表再搬数据，不再逐表报 `1146`；
> - 由 `DB_*` 环境变量接管时，同步按钮会明确说「后台保存的集群没有生效，请先删环境变量」，
>   而不是含糊的「数据库自身复制」；
> - 启动日志在 `DATA_DIR` 指向 `/tmp` 时会打一条 WARNING：后台保存的集群配置随实例回收消失。
>
> 另外 `information_schema` 的查询改成显式绑定节点配置里的库名，不再依赖连接默认库
> （`DATABASE()` 为空时曾被当成"零张表、同步完成"）。
>
> **从 v1.8.8 升级**：`dist/` 与 `server/index.mjs` **都有实质变化**——这次找到并修掉了
> 「登录成功、但一刷新就退回登录页」的真正原因：**老库里的毫秒时间戳列是 `INT`**。
>
> `refresh_tokens.expires_at` 存的是毫秒时间戳（约 1.79e12），而 `INT` 上限是 2147483647。
> 如果你的库是早期版本建的、或当初手工执行过 `migrations/0001_init.sql`（SQLite 的 `INTEGER`
> 在 MySQL 里就是 `INT`），那 `CREATE TABLE IF NOT EXISTS` 永远不会改这张已存在的表，
> 于是每次登录写令牌都被静默截断成 2147483647（1970-01-25），紧接着的清理语句
> `DELETE FROM refresh_tokens WHERE expires_at < now` 把它当成早已过期删掉 ——
> 登录照常返回 200、Cookie 也正常下发，但每次刷新都报「令牌不存在或已过期」。
>
> 本版启动时会检查这几列（`refresh_tokens` 的 `expires_at` / `created_at` / `last_used_at` /
> `absolute_expires_at`），**只对 MySQL、只在类型不是 `bigint` 时**执行一次
> `ALTER TABLE ... MODIFY COLUMN ... BIGINT`，并把改过的列写进启动日志与 `/healthz`
> 的 `schemaRepair` 字段（没问题时不出现该字段）。
>
> 不需要手工跑 SQL；升级后第一次请求会自动修好，然后**重新登录一次**（旧令牌已经被截断成
> 1970 年，不可恢复）。若 `/healthz` 里出现了 `schemaRepair`，就说明这一版正好治的是你的库。
>
> 同时新增诊断：刷新失败事件现在带 `stage`（`record_missing` / `extend_rejected` /
> `device_session_mismatch` …）、`tokenRows`（当时表里有几行）和 `newestTokenAt`，
> 万一是别的原因，一条日志就能定位。
>
> **多节点集群请在全部节点上升级**：只升部分节点的话，未升级的实例仍可能把鉴权读分流到落后副本，
> 掉登录会以"偶发"的形式继续出现。
>
> **存储位置（附件/后台配置）见 [DEPLOY.md 第三节](DEPLOY.md#三存储与挂载最容易漏的一节)**：
> FC 默认把附件写在 `/tmp/nodewarden`，**实例回收即丢**；要持久化有两条路——挂 NAS
> （`DATA_DIR` / `ATTACHMENTS_DIR`，见「三之二」），或**原生挂载 OSS** 只放附件
> （`ATTACHMENTS_DIR=/mnt/oss`，见 [DEPLOY.md 3.7](DEPLOY.md#37-阿里云-fc原生挂载-oss从建桶到验证)）。

## 一、包内容
- `server/index.mjs`：**已用 esbuild 打包好的后端（纯 JS，运行时不需要 tsx/esbuild）**
- `server/register-cf-stub.mjs` / `server/cf-stub-loader.mjs`：把 `cloudflare:workers` 映射为桩
- `dist/`：已构建好的前端（含登录页与管理后台）
- `node_modules/`：仅 `mysql2` 及其依赖（其余依赖已打进 bundle）
- `fc-entry.mjs`：FC 启动入口（自动设 `/tmp` 数据目录、端口 9000）
- `package.json` / `package-lock.json`
- `FC-DEPLOY.md`（本文件）/ `DEPLOY.md`（四种部署方式汇总 + 环境变量总表 + 存储挂载）

## 二、免费额度内配置（关键）
在 FC「创建函数」页按下表配置，即可留在免费额度内：

| 配置项 | 值 | 说明 |
|---|---|---|
| 函数类型 | **Web 函数** | 跑 HTTP 服务 |
| 运行环境 | **Node.js 22** | |
| 规格方案 | 0.35 vCPU / 0.5 GB | 最小规格，最省 |
| **最小实例数** | **0** | ⚠️ 必须 0！设 1 会常驻、超出免费额度 |
| 单实例并发数 | 20 | 越高越省 |
| 执行超时时间 | **300 秒** | 备份/还原是长任务；默认 60s 会中断 |
| 监听端口 | **9000** | 与 `fc-entry.mjs` 默认一致 |
| 启动命令 | `node fc-entry.mjs` | |

> 免费额度：每月 **100 万次调用 + 40 万 CU·秒**。个人负载约 11 万次/月，用不到 2%。

## 三、环境变量（FC 控制台）

### 必填
| 变量 | 值 |
|---|---|
| `JWT_SECRET` | ≥32 位随机串 |
| `DB_HOST` | 外接 MySQL 地址（TiDB：`gz-xxx.tidbcloud.com`） |
| `DB_PORT` | TiDB `4000`，自建多为 `3306` |
| `DB_USER` | 数据库账号 |
| `DB_PASSWORD` | 数据库密码 |
| `DB_NAME` | 库名，如 `nodewarden` |
| `DB_SSL` | `true`（TiDB 必须）；自建无 TLS 时设 `false` |

### 与本次修复相关（按需）
| 变量 | 默认 | 作用 |
|---|---|---|
| `DB_SSL_INSECURE` | 未设（=严格校验） | **⚠️ 默认已改为校验证书**。若你的库用自签证书，升级后若报 TLS/证书错误，设 `1` 恢复旧行为（不校验），或改用下面的 CA |
| `DB_SSL_CA` | 无 | 私有 CA 的 PEM 文件路径（推荐做法，比关闭校验安全） |
| `DB_HOST_ALLOWLIST` | 空 | 逗号分隔的域名/IP 白名单。后台「测试连接」默认**拒绝**内网地址（10./172.16-31./192.168./127./169.254./localhost）；自建库在内网时把它的 host 填进来即可 |
| `BACKUP_ENDPOINT_ALLOWLIST` | 空 | 同上，作用于备份目的地（S3/MinIO/WebDAV）。备份端点默认同样拒绝内网与回环地址，自建对象存储在内网时填它 |
| `CRON_SECRET` | 空 | **定时备份用**。设置后可通过带 `x-cron-secret` 头的 `POST /internal/cron/backup` 触发计划备份（见第五节） |
| `INPROCESS_CRON` | 关闭 | 仅单实例常驻自托管才设 `1`。**FC 上不要开**（多实例会重复跑备份、且阻止缩容到 0） |
| `MAX_BODY_MB` | `100` | 请求体上限（超限返回 413） |
| `DB_TIMEZONE` | `Z`(UTC) | 时间戳本身是 epoch 毫秒，一般无需改 |
| `DB_STANDBY_NAME` | 空 | **副库库名**（可选）。设置后环境变量配置即为主库 + 副库双节点，可在后台「同步数据到副库」把主库数据搬过去；不设 = 单节点，与以往行为完全一致 |
| `DB_STANDBY_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_SSL` / `_CONN_LIMIT` | 沿用主库 | 副库在另一台服务器、或使用另一套账号时才需要单独设 |
| `DATA_DIR` | `/tmp/nodewarden` | 数据目录（后台配置、节点同步记录、写入水位、附件父目录）。FC 仅 `/tmp` 可写，**要持久化必须挂 NAS 后改这里** |
| `ATTACHMENTS_DIR` | `${DATA_DIR}/attachments` | 附件实际落盘目录，想单独挂一块盘时设 |
| `PORT` | `9000` | |

> 也可以不设 DB_*，启动后在管理后台 `/admin/database` 填写（需设 `DB_CONFIG_KEY`）。
> 注意：**环境变量优先于后台配置**。两者都配时，后台保存会提示「已保存但未生效」。

## 三之一、用环境变量配一台可同步的副库（v1.8.11+）

以前「保存了副库却切不过去、同步永远 0%」的根因是：**生效的集群是环境变量那一台**，后台保存的
副库被挡住；而要让后台配置生效，又得先有能挺过冷启动的 `DATA_DIR`（NAS）。如果你的部署就想
保持「全部配置写在环境变量里」，不必删任何变量，只加一行：

```bash
DB_STANDBY_NAME=nodewarden-bak     # 副库的库名（同实例时其余参数自动沿用主库）
```

改完重启，然后：

1. **确认库存在**：`CREATE DATABASE nodewarden-bak DEFAULT CHARACTER SET utf8mb4;`
   （表结构不用手建，点同步时会自动建）。
2. 打开后台 → 数据库：会看到两台节点——「环境变量主库」与「环境变量副库（手动同步）」；
   下面是「已保存的集群配置」，那条红色提示可以忽略，它现在只影响后台配置那一套。
3. 点 **「同步数据到副库」**：默认「只补缺失行」，不会覆盖副库已有数据；分多段短请求跑，
   进度条按已完成的数据表推进。
4. 想校验：`SELECT COUNT(*) FROM nodewarden.users;` 与 `nodewarden-bak.users` 对比。

两点必须知道：

- **副库不会被自动切换过去**。环境变量副库是「手动同步的备份」：`native` 模式下应用无法判断它是否
  完整，主库短暂抖动就自动切到空库的代价是全员被登出、且没有入口再切回来。所以这条固定关闭。
- **要真正换主库**：把 `DB_NAME` 与 `DB_STANDBY_NAME` 互换后重启。数据不动，随时可以换回来。

> 副库是独立服务器时再补 `DB_STANDBY_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_SSL`。
> 注意同一台 MySQL 实例上的两个库**不构成高可用**：实例挂了两个一起挂，这里得到的是
> 「可回滚副本」，不是冗余。

## 三之二、挂载 NAS 让附件与配置持久化（**必看，默认会丢**）

不挂盘时，`fc-entry.mjs` 把可写目录默认指到 `/tmp/nodewarden`：实例缩容/回收后，
**附件、后台保存的数据库配置、节点同步与水位记录全部消失**。表现为「昨天上传的附件今天 404」
「后台配置冷启动后变回环境变量那套」。

1. **创建 NAS**：文件存储 NAS → 创建文件系统（NFS，容量型最便宜），与函数放在**同一 VPC**。
2. **挂载到函数**：函数 → 配置 → 存储 → 挂载 NAS，挂载点填 `/mnt/nas`；同时给函数配好 VPC 访问
   （与「允许访问公网」可以并存）。
3. **改环境变量**（关键的两行）：
   ```bash
   DATA_DIR=/mnt/nas/nodewarden
   ATTACHMENTS_DIR=/mnt/nas/nodewarden/attachments
   ```
   目录会在启动时自动 `mkdir -p`；**挂载点必须可写**，否则启动即报 `EACCES` / `EROFS`。
4. **验证**：上传一个附件 → 等实例缩容（最小实例数 0 时很快）→ 再下载同一个附件。
   能下载 = 挂载生效；仍然 404 = 还在 `/tmp`，回去确认变量是否写错、或挂载点是不是 `/mnt/nas`。

> 只设 `DATA_DIR` 就够了（`ATTACHMENTS_DIR` 默认是 `${DATA_DIR}/attachments`）。
> **不要**把 `DATA_DIR` 指向代码目录——FC 代码目录只读。
> FC 装不了 ossfs（没有 `/dev/fuse`），但控制台提供了**原生挂载 OSS** 的开关（可读写），
> 是 NAS 之外更省钱的附件盘方案：函数 → 配置 → 存储 → 挂载 OSS 对象存储，
> 本地目录 `/mnt/oss` + 环境变量 `ATTACHMENTS_DIR=/mnt/oss`。
> 完整步骤（建桶选项、RAM 角色策略、挂载失败怎么查）见
> [DEPLOY.md 3.7](DEPLOY.md#37-阿里云-fc原生挂载-oss从建桶到验证)。
> 不想动挂载的话，对象存储也可以只当**定时备份目标**
> （OSS/COS 的 endpoint、bucket、region 填法见 [DEPLOY.md 3.6.6](DEPLOY.md#366-serverless-上挂不了怎么办用备份中心把-oss-cos-当目标)）。

## 四、上传部署步骤
1. FC 控制台 → 创建函数（**Web 函数**）。
2. 代码上传方式选 **ZIP 包上传**，上传本 ZIP。
3. 运行环境 Node.js 22、启动命令 `node fc-entry.mjs`、监听端口 9000、**最小实例数 0**、超时 300s。
4. 配置环境变量（第三节）。
5. 创建 HTTP 触发器，**认证方式选「无需认证」**（应用层自带登录鉴权；否则网关会报 `MissingRequiredHeader`）。
6. 授予「允许默认网络访问公网」（否则连不上外部 MySQL）。
7. 打开函数 URL → 注册管理员 → 后台 `/admin/database` 确认「外接 MySQL · 已就绪」。

## 五、定时备份（本轮有变化，务必看）
旧版本用进程内 `setInterval` 每 5 分钟跑一次计划备份。在 FC 上这是错的：缩容到 0 后不触发、多实例会各跑一遍（重复上传到同一个 WebDAV）。

现在改为**平台定时触发**：
1. 设环境变量 `CRON_SECRET`（随机串，≥16 位）。
2. FC 函数 → 触发器 → 创建**定时触发器**：`0 */5 * * * * *`（每 5 分钟）。
   若定时触发器不支持自定义请求头，则用「云监控/事件总线」或任意外部 cron（如 GitHub Actions、Uptime 机器人）调用：
   ```bash
   curl -X POST https://<函数URL>/internal/cron/backup -H "x-cron-secret: <CRON_SECRET>"
   ```
3. 未设 `CRON_SECRET` 时该端点返回 503（拒绝无鉴权触发），不会静默放行。

## 六、从旧版本升级（重要）
数据库结构在本轮有两处修正，**旧库需要手动修一次**（新库自动正确）：

```sql
-- 1) JSON 列恢复为大文本：旧版本把 TEXT DEFAULT '[]' 建成了 VARCHAR(2048)，
--    规则较多的用户保存域名规则会报 1406 或被截断。
ALTER TABLE domain_settings
  MODIFY equivalent_domains LONGTEXT NOT NULL,
  MODIFY custom_equivalent_domains LONGTEXT NOT NULL,
  MODIFY excluded_global_equivalent_domains LONGTEXT NOT NULL;

-- 2) 唯一索引去掉前缀：旧版本是 credential_id(191)，长 credential ID 会被误判重复。
ALTER TABLE webauthn_credentials
  MODIFY credential_id VARCHAR(512) NOT NULL,
  DROP INDEX idx_webauthn_credentials_credential_id,
  ADD UNIQUE INDEX idx_webauthn_credentials_credential_id (credential_id);
```

> 如果库里有重复数据导致第 2 步失败，先清理重复的 `credential_id` 再执行。
> 也可以直接重建库（`DROP DATABASE` → 重新部署 → 用迁移工具导入），本项目仍在验证期，重建更省事。

## 七、验证
```bash
curl https://<函数URL>/healthz
# 期望：{"ok":true,"db":"up","mode":"mysql","source":"env","runtime":"node","attachments":"ok"}
```
- 应**不再**返回 MySQL 原始错误（旧版本会把 `Access denied for user ...` 直接吐给未登录访问者）。
- Bitwarden 网页/客户端能注册、登录、保存/同步一条密码即成功。

## 八、Node 运行时功能降级（未变）
- **实时推送**：WebSocket 升级不可用（501）→ 客户端自动退回轮询同步。
- **备份中心**：Durable Objects 以进程内实现运行（内存版 `state.storage` + 定时器版 `alarm`），手动/定时备份、WebDAV/S3 还原、附件同步可用；状态按进程保存，冷启动丢失（仅影响 60 秒令牌与 10 分钟任务租约）。
- 附件与后台兜底配置默认存 `/tmp`，实例回收会丢失；**挂 NAS 并设 `DATA_DIR` 才能真正持久**（见「三之二」）。

## 九、从仓库自行打包（可选）
不想用现成 ZIP 时，从仓库构建：

```bash
npm ci
npm run build            # 前端 → dist/

# 后端打成纯 JS（mysql2 保持外部依赖，随包携带）
npx esbuild server/index.ts --bundle --platform=node --format=esm \
  --target=node22 --outfile=server/index.mjs --external:cloudflare:workers --external:mysql2
```

启动入口直接用**仓库根的 `fc-entry.mjs`**（FC 代码目录只读，仅 `/tmp` 可写，故把可写目录默认指到
`/tmp`；该文件与发布 ZIP 内的完全一致，无需手抄）。组包时把它原样复制到包根即可。

然后按下面的结构组包，`node_modules/` 只放 mysql2 及其依赖（`aws-ssl-profiles`、`generate-function`、
`iconv-lite`、`is-property`、`long`、`lru.min`、`named-placeholders`、`safer-buffer`、`sql-escaper` 等）：

```
FC-DEPLOY.md
DEPLOY.md
fc-entry.mjs
package.json
dist/
server/index.mjs
server/register-cf-stub.mjs
server/cf-stub-loader.mjs
node_modules/            # 只放 mysql2 及其依赖
```

> `server/index.mjs` 在仓库中是跟踪文件，重新构建后请一并提交，避免包内 bundle 与源码不一致。
