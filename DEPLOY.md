# NodeWarden 部署总览（含存储挂载）

本文是**所有部署方式的汇总入口**，把散落在 README、[FC-DEPLOY.md](FC-DEPLOY.md)、[EDGEONE-DEPLOY.md](EDGEONE-DEPLOY.md)
里的内容收拢到一处，并补齐过去三份文档都漏掉的一章：**存储挂在哪里、用哪些变量**。

- 想知道「我该选哪种」→ 看[第一节](#一选型速查)
- 已经选好、只想把附件/配置持久化 → 直接跳[第三节 存储与挂载](#三存储与挂载最容易漏的一节)
- 要找某个变量 → [第五节 环境变量总表](#五环境变量总表)
- 平台专属细节（FC 规格、EdgeOne 限制、定时备份）→ 仍以两份平台文档为准

> 本文对应版本 **v1.8.4**。每个 [Release](https://github.com/muzhi621/NodeWarden_fceo/releases) 都附带
> 可直接上传的 `nodewarden-fc.zip`（前端 + 后端 bundle + mysql2 依赖，免构建）。

---

## 一、选型速查

| | Cloudflare Workers | EdgeOne Pages | 阿里云 FC | 自建 / Docker（VPS、NAS） |
|---|---|---|---|---|
| 适合 | 已有 CF 账号、想要平台内置存储 | 国内访问、免费额度高、当 Web 入口 | 国内主力、要挂持久盘 | 完全可控、局域网自用 |
| 业务数据 | D1（默认）或外接 MySQL | 必须外接 MySQL | 必须外接 MySQL | 必须外接 MySQL |
| 附件持久性 | ✅ R2 | ❌ 只有 `/tmp`，实例回收即丢 | ⚠️ 默认 `/tmp`；**挂 NAS 后持久** | ✅ 本地磁盘/卷 |
| OSS/COS 当附件盘 | ❌（用 R2） | ❌ | ❌ 无 FUSE，改用 NAS 或备份中心 | ✅ ossfs / cosfs / rclone（[3.6](#36-把阿里云-oss--腾讯云-cos-当附件盘fuse-挂载)） |
| 配置存储 | ✅ KV / R2 | ❌ 无（只能用 `DB_*` 环境变量） | ⚠️ 默认 `/tmp`；挂 NAS 后持久 | ✅ `DATA_DIR` |
| 多节点主副库 | ✅ | ❌ 不支持 | ✅（建议单实例写） | ✅ |
| 实时推送 | ✅ WebSocket | ❌ 轮询 | ❌ 轮询（501） | ✅ WebSocket |
| 请求体上限 | 平台限制（免费 100 MB） | **6 MB** | `MAX_BODY_MB`（默认 100） | `MAX_BODY_MB` |
| 单次执行上限 | CPU 时间 | **120 s** | 300 s（可调） | 无 |

**一句话结论**：附件/备份重度使用 → FC 挂 NAS 或自建；只想有个随时能开的入口 → EdgeOne；
已经在用 Cloudflare → Workers 原样跑，什么都不用改。

---

## 二、开始之前

1. **数据库**：MySQL 8.0 / MariaDB 10.6+ / TiDB Serverless 均可，库字符集 `utf8mb4`。
   不需要预建表——启动时自动建 19 张表（每次请求还会做增量迁移检查）。
2. **两个密钥**（别复用、别进仓库）：
   ```bash
   openssl rand -base64 32   # JWT_SECRET（登录态签名）
   openssl rand -base64 24   # DB_CONFIG_KEY（后台保存的数据库配置用它加密）
   ```
   `JWT_SECRET` 必填；`DB_CONFIG_KEY` 只有在你要用后台 `/admin/database` 保存配置时才需要。
3. **平台用量上限先看一眼**：EdgeOne 单请求 6 MB / 120 s，是大附件和还原操作最主要的坑。

---

## 三、存储与挂载（最容易漏的一节）

应用里有**三份不同的数据**，各自有各自的存放位置。搞混是部署后"配置没保存""附件重启就没了"的根源：

| 数据 | 存什么 | Cloudflare Workers | FC / 自建 Node | EdgeOne |
|---|---|---|---|---|
| **业务数据** | 账号、密码条目、审计日志… | D1 `DB` 或外接 MySQL | 外接 MySQL | 外接 MySQL |
| **附件 / Send 文件**（blob） | 附件二进制 | R2 桶 `ATTACHMENTS`（或 KV `ATTACHMENTS_KV`） | `ATTACHMENTS_DIR` 指向的本地目录 | `/tmp/nodewarden/attachments` |
| **运行时配置** | `/admin/database` 保存的集群配置、节点同步记录、写入水位 | KV `SETTINGS_KV`（首选）→ R2 `ATTACHMENTS` → KV `ATTACHMENTS_KV` | `DATA_DIR` 指向的本地目录 | `/tmp/nodewarden`（**不持久**） |

选择顺序是固定的（代码里就是按这个优先级）：配置存储 **`SETTINGS_KV` → `ATTACHMENTS`(R2) → `ATTACHMENTS_KV`**，
附件存储 **`ATTACHMENTS`(R2) → `ATTACHMENTS_KV`**。Node 运行时把这三者统一映射成
「本地目录 + 文件」，所以你只需要关心两个变量：`DATA_DIR` 和 `ATTACHMENTS_DIR`。

### 3.1 Cloudflare Workers：R2 + KV 绑定

绑定不是环境变量，写在 `wrangler.toml` 里：

| 绑定名 | 类型 | 作用 | 必须 |
|---|---|---|---|
| `DB` | D1 database | 业务数据（用外接 MySQL 后可忽略） | 默认模式必须 |
| `ATTACHMENTS` | R2 bucket | 附件 / Send 文件 | ✅（R2 模式） |
| `SETTINGS_KV` | KV namespace | 配置存储（**优先级最高**） | 建议 |
| `ATTACHMENTS_KV` | KV namespace | KV 模式下的附件存储 | 仅 KV 模式 |
| `ASSETS` | 静态资源 | 前端 `dist/` | ✅ |
| `NOTIFICATIONS_HUB` / `BACKUP_TRANSFER_RUNNER` | Durable Object | 实时推送、备份任务 | ✅ |

创建资源并填进 `wrangler.toml`：

```bash
npx wrangler r2 bucket create nodewarden-attachments
npx wrangler kv namespace create SETTINGS_KV     # 记下返回的 id
```

```toml
[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "nodewarden-attachments"

[[kv_namespaces]]
binding = "SETTINGS_KV"
id = "<上一步返回的 id>"
```

两种部署脚本的区别：`npm run deploy` 用 `wrangler.toml`（**R2 模式**，附件进 R2）；
`npm run deploy:kv` 会先跑 `scripts/ensure-kv.cjs` 自动建库再部署 `wrangler.kv.toml`（**KV 模式**，附件进 KV）。

> ⚠️ R2 与 KV 不互通：从 KV 模式切到 R2 模式，历史附件不会自动搬过去，需要自己导一次。
> 单库附件多时优先 R2（KV 单 key 有 25 MiB 上限，且按读计费更贵）。

### 3.2 阿里云 FC：挂 NAS 才能持久化附件

FC 的代码目录只读，**只有 `/tmp` 可写**，而 `/tmp` 随实例回收清空。默认行为：

```js
// fc-entry.mjs
DATA_DIR        = /tmp/nodewarden
ATTACHMENTS_DIR = /tmp/nodewarden/attachments
```

所以「上传的附件第二天打不开」「后台保存的数据库配置冷启动后没了」都不是 bug，是没挂持久盘。

**挂 NAS 的完整步骤：**

1. 文件存储 NAS → 创建文件系统（NFS 协议，容量型最便宜），记下挂载点域名。
2. 函数计算 → 你的函数 → **配置 → 存储 → 挂载 NAS**，挂载点填 `/mnt/nas`。
   NAS 与函数必须在同一 VPC；同时给函数配好 VPC 访问（与「允许访问公网」可以并存）。
3. 加两个环境变量（**这一步就是这次补上的缺口**）：
   ```bash
   DATA_DIR=/mnt/nas/nodewarden
   ATTACHMENTS_DIR=/mnt/nas/nodewarden/attachments
   ```
   目录不用手动建，启动时会 `mkdir -p`；**但挂载点必须可写**，否则启动即报 `EACCES/EROFS`。
4. 重启函数 → 上传一个附件 → 等实例缩容（最小实例数 0 时很快）→ 再下载同一个附件。
   能下载 = 挂载生效；404 = 还在 `/tmp`，回去检查变量是否被平台覆盖。

> 想区分「配置目录」和「附件目录」也可以只设 `DATA_DIR`：`ATTACHMENTS_DIR` 默认就是
> `${DATA_DIR}/attachments`。FC 上**不要**把 `DATA_DIR` 指向代码目录（只读）。
>
> OSS 不能直接当文件系统用（`ossfs` 对 rename/append 的支持不完整，而 FC 本身也不给 FUSE 设备）；
> 在 FC 上要放对象存储请用应用内备份中心的 WebDAV/S3。想在 VPS/Docker 上真把 OSS/COS 挂成附件盘，
> 见 [3.6](#36-把阿里云-oss--腾讯云-cos-当附件盘fuse-挂载)。

### 3.3 EdgeOne Pages：没有持久盘，别指望附件留下来

`DATA_DIR` 在函数模式下会被**强制改写**成 `/tmp/nodewarden`，填什么都没用（`node-functions/` 只读，
写进去会让每个请求 500）。后果：

- 附件、`/admin/database` 的后台配置、进程内备份任务状态，**实例回收即丢**；
- 所以数据库连接**一律用 `DB_*` 环境变量**，不要用后台保存；
- 附件重度使用请把 FC 当主力，EdgeOne 只当入口/备用。

### 3.4 自建 / Docker：卷挂到 `DATA_DIR`

宿主目录或命名卷挂到容器内一个固定路径，再让 `DATA_DIR` 指过去：

```bash
docker run -d --name nodewarden -p 8787:8787 \
  -v nw-data:/data \
  -e DATA_DIR=/data \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e DB_HOST=... -e DB_USER=... -e DB_PASSWORD=... -e DB_NAME=... \
  nodewarden:1.8.4
```

```yaml
# docker-compose.yml 片段
services:
  nodewarden:
    build: .
    ports: ["8787:8787"]
    volumes:
      - nw-data:/data                 # 附件 + 配置 + 备份临时文件
    environment:
      DATA_DIR: /data
      # ATTACHMENTS_DIR: /data/attachments   # 想单独挂一块盘时再设
volumes:
  nw-data:
```

备份只需要打包 `/data` 这一个目录（附件 + 加密后的数据库配置都在里面）；业务数据在 MySQL，用
`mysqldump` 或应用内备份中心导出。

### 3.5 从 Workers 迁到 Node 运行时：附件要手动搬

这是迁移里唯一需要人工的一步：Workers 上附件存在 R2 桶里，Node 运行时读的是本地目录。

```bash
# 1) 先把对象列表导出（key 就是库里的附件路径）
npx wrangler r2 object list nodewarden-attachments --json > keys.json
# 2) 逐个下载到 ATTACHMENTS_DIR 对应位置（小库可直接循环；大库建议用 rclone 的 S3 兼容模式）
```

漏了这一步的表现是：附件列表还在、点下载提示 404 —— 记录在库里，文件没跟过来。

### 3.6 把阿里云 OSS / 腾讯云 COS 当附件盘（FUSE 挂载）

先看能不能挂 —— 这一步决定你有没有这条路：

| 运行环境 | 能否用 ossfs / cosfs 挂 OSS/COS | 该怎么做 |
|---|---|---|
| 阿里云 FC | ❌ 无 `/dev/fuse`、不能给特权容器 | 挂 **NAS**（[3.2](#32-阿里云-fc挂-nas-才能持久化附件)）；对象存储只能当**备份目标**（[3.6.6](#366-serverless-上挂不了怎么办用备份中心把-oss-cos-当目标)） |
| EdgeOne Pages | ❌ 同上，且只有 `/tmp` | 同上，或干脆只当入口 |
| 自建 VPS（有 root） | ✅ ossfs / cosfs / rclone 都可以 | 本文 [3.6.1](#361-阿里云-ossossfs)、[3.6.2](#362-腾讯云-coscosfs) |
| Docker | ✅ 但要显式放行 FUSE 设备与权限 | 见 [3.6.4](#364-docker-里挂-oss-完整示例) 的 `--device /dev/fuse --cap-add SYS_ADMIN` |

**为什么这个应用能挂在对象存储上**：附件读写的实际文件操作只有三种 ——
写入是新文件（数据 + 同名 `.meta.json` 记录 content-type）、读取是 `stat` + 顺序读、删除是 `rm`。
**没有用到 `rename`、`append`、硬链接、目录遍历**，而这四项恰好是 ossfs/cosfs 最难保证的。
所以 FUSE 挂载是安全的，代价是：每个附件占 **2 个对象**，且没开缓存时每次下载都要回源（流量与延迟）。

#### 3.6.1 阿里云 OSS（ossfs）

```bash
# 1) 安装（Ubuntu/Debian；先装 FUSE 运行时，ossfs 2.0 用 fuse3，1.x 用 fuse）
#    官方文档：help.aliyun.com → 对象存储 OSS → 常用工具 → ossfs
sudo apt install -y fuse3
# 按官方提供的 .deb / .rpm 包安装，或从源码构建
ossfs --version

# 2) 凭据文件（只有本机 root 可读）
echo "my-bucket:LTAI5t********:yourAccessSecret" | sudo tee /etc/passwd-ossfs
sudo chmod 640 /etc/passwd-ossfs

# 3) 挂载（同 region 的 ECS 用内网 endpoint，不计公网流量）
sudo mkdir -p /mnt/oss
sudo ossfs my-bucket /mnt/oss \
  -o url=https://oss-cn-hangzhou-internal.aliyuncs.com \
  -o allow_other -o umask=000 \
  -o kernel_cache -o max_stat_cache_size=10000
```

开机自动挂载（`/etc/fstab`）：

```
my-bucket  /mnt/oss  fuse.ossfs  _netdev,allow_other,umask=000,url=https://oss-cn-hangzhou-internal.aliyuncs.com  0 0
```

> `allow_other` 需要 `/etc/fuse.conf` 里有 `user_allow_other`（用 root 挂载时一般已满足）。
> 挂载点是桶的**根**：应用的 `ATTACHMENTS_DIR` 指向桶内某个前缀即可，例如 `/mnt/oss/nodewarden/attachments`。
> 官方的「OSS 挂载到本地」也叫 `ossfs`，1.x 与 2.x 参数略有差异，报 `unrecognized option` 时换另一个版本的参数写法。

#### 3.6.2 腾讯云 COS（cosfs）

```bash
# 1) 安装 cosfs（官方 GitHub tencentyun/cosfs，按 README 编译或装包）
cosfs --version

# 2) 凭据文件：注意桶名要带 APPID 后缀
echo "my-bucket-1250000000:AKID********:yourSecretKey" | sudo tee /etc/passwd-cosfs
sudo chmod 640 /etc/passwd-cosfs

# 3) 挂载（同地域内网域名可省公网流量）
sudo mkdir -p /mnt/cos
sudo cosfs my-bucket-1250000000 /mnt/cos \
  -ourl=https://cos.ap-guangzhou.myqcloud.com \
  -o allow_other -o umask=000 -o dbglevel=warn \
  -o enable_noobj_cache
```

`/etc/fstab`：

```
my-bucket-1250000000  /mnt/cos  fuse.cosfs  _netdev,allow_other,umask=000,url=https://cos.ap-guangzhou.myqcloud.com  0 0
```

> 桶名格式是 `<名字>-<APPID>`，少了 `-1250000000` 这截会报桶不存在。
> 内网域名形如 `https://cos.ap-guangzhou.myqcloud.com`（同地域 CVM 走内网自动解析），跨地域请用公网域名。

#### 3.6.3 通用方案：rclone mount（OSS 与 COS 同一套命令）

不想装两个工具、或者想加本地缓存时用 rclone，两边都支持：

```bash
rclone config
# n) 新建 → 选 s3 → provider 选 Alibaba（OSS）或 TencentCOS（COS）
#    access_key_id / secret_access_key 填入 AK/SK，endpoint 填对应地域域名

mkdir -p /mnt/obj
rclone mount nw-oss:nodewarden /mnt/obj \
  --vfs-cache-mode writes \
  --vfs-cache-max-size 2G \
  --allow-other \
  --daemon
```

>`--vfs-cache-mode writes` 会先写本地缓存再上传，避免小文件半途失败；读多的话再加
>`--vfs-cache-mode full` 与 `--vfs-cache-max-age`，代价是占本地磁盘。

#### 3.6.4 Docker 里挂 OSS（完整示例）

容器内挂 FUSE 需要两件事：把 `/dev/fuse` 透进去、给 `SYS_ADMIN` 能力。

```yaml
services:
  nodewarden:
    image: nodewarden:1.8.4
    ports: ["8787:8787"]
    devices:
      - /dev/fuse:/dev/fuse          # 必需
    cap_add:
      - SYS_ADMIN                    # 必需
    security_opt:
      - apparmor:unconfined          # 宿主机启用了 AppArmor 时需要
    volumes:
      - nw-data:/data                # DATA_DIR：本地盘，别放对象存储
      - /mnt/oss:/mnt/oss:shared     # 宿主机先挂好 OSS，再共享进容器
    environment:
      DATA_DIR: /data
      ATTACHMENTS_DIR: /mnt/oss/nodewarden/attachments
volumes:
  nw-data:
```

> **只把 `ATTACHMENTS_DIR` 放对象存储，`DATA_DIR` 留在本地盘。**
> 原因：`DATA_DIR` 里是 `kv-store.json`（每次写入都把整个 JSON 重写一遍）和节点同步记录，
> 放到 FUSE 上既慢又容易读到写了一半的内容。这么做还有一个额外好处——挂载掉线时，
> 配置和登录态不受影响，只是附件暂时读不到。

#### 3.6.5 接到 NodeWarden 并验证

```bash
# 只换附件目录（推荐）
ATTACHMENTS_DIR=/mnt/oss/nodewarden/attachments

# 或者连 DATA_DIR 一起放到挂载点（不推荐，理由见上）
# DATA_DIR=/mnt/oss/nodewarden
# ATTACHMENTS_DIR=/mnt/oss/nodewarden/attachments
```

验证顺序（和 NAS 一样，必须跨重启）：

1. 启动 → 上传一个附件 → 在挂载点里应能看到**两个对象**：`<key>` 与 `<key>.meta.json`；
2. **重启容器/服务**（或 `umount` 后重新挂载）→ 再下载同一个附件；
3. 能下载 = 生效；404 且挂载点里没有对象 = 应用还在写本地目录，检查变量是否生效（`DATA_DIR` 拼错最常见）。

成本与性能提醒：

- 每个附件 2 个对象 → 请求数翻倍，OSS/COS 的**请求费**（尤其 PUT/GET 次数）比容量费更容易超；
- 没开 `kernel_cache`/vfs 缓存时，每次下载都会产生一次 GET 与流量；
- 对象存储无 POSIX 完整语义（rename/append 缺失），本应用不用这些操作，但**不要**把 MySQL 数据文件、
  `kv-store.json` 之类放上去；
- 对象存储挂载不适合高并发小文件场景，个人密码库的量级完全够用。

#### 3.6.6 Serverless 上挂不了怎么办：用备份中心把 OSS/COS 当目标

FC / EdgeOne 没有 FUSE，但**备份中心支持 S3 兼容目标**，OSS 与 COS 都能直接当备份目的地
（附件同步也在备份范围内）。在管理后台 → 备份中心 → 新建目标 → 选 S3：

| 字段 | 阿里云 OSS | 腾讯云 COS |
|---|---|---|
| `endpoint` | `https://oss-cn-hangzhou.aliyuncs.com` | `https://cos.ap-guangzhou.myqcloud.com` |
| `bucket` | `my-bucket` | `my-bucket-1250000000` |
| `region` | `oss-cn-hangzhou` | `ap-guangzhou` |
| `addressingStyle` | `virtual-hosted`（默认）或 `path` | `virtual-hosted`（默认）或 `path` |
| `rootPath` | 例如 `nodewarden` | 例如 `nodewarden` |
| `accessKeyId` / `secretAccessKey` | 建议用只授权该桶的子账号 AK | 同左（建议子账号 + 最小权限策略） |

> 端点必须带 `https://`；`path` 风格在自建/兼容端点（MinIO、R2）上更保险。
> 这条路的语义是**定时备份**，不是实时存储：附件仍在实例本地（或 NAS），
> 对象存储里是可供还原的快照。定期还原演练一次，确认附件也在快照里。

---

## 四、各平台部署步骤

### 4.1 Cloudflare Workers（CLI）

```bash
git clone https://github.com/muzhi621/NodeWarden_fceo.git
cd NodeWarden_fceo
npm install
npx wrangler login

npx wrangler r2 bucket create nodewarden-attachments   # 首次
npx wrangler kv namespace create SETTINGS_KV           # 首次，id 填进 wrangler.toml

npm run deploy          # R2 模式
# npm run deploy:kv     # KV 模式
npm run dev             # 本地开发
```

变量与密钥在 **Settings → Variables and Secrets → Runtime**（不要加到 Build variables，构建期变量运行时读不到）。

### 4.2 阿里云 FC（Web 函数 + ZIP）

摘要（完整版见 [FC-DEPLOY.md](FC-DEPLOY.md)）：

1. 创建 **Web 函数**，运行环境 Node.js 22，启动命令 `node fc-entry.mjs`，监听端口 **9000**；
2. 规格 0.35 vCPU / 0.5 GB，**最小实例数 0**，执行超时 **300 s**，单实例并发 20；
3. 上传 Release 里的 `nodewarden-fc.zip`；
4. 配置环境变量（[第五节](#五环境变量总表)），要持久化附件再加 NAS 挂载（[3.2](#32-阿里云-fc挂-nas-才能持久化附件)）；
5. 创建 HTTP 触发器，认证方式选**无需认证**；允许默认网络访问公网；
6. 打开函数 URL → 注册管理员 → `/admin/database` 确认「外接 MySQL · 已就绪」。

### 4.3 EdgeOne Pages

摘要（完整版见 [EDGEONE-DEPLOY.md](EDGEONE-DEPLOY.md)）：

1. 导入仓库，框架选 Vite，构建命令 `npm run build:edgeone:pages`，输出目录 `dist`，Node 22；
2. 环境变量设 `JWT_SECRET`、`DB_*`、`MAX_BODY_MB=5`；
3. 部署后访问域名 → `curl https://<域名>/healthz` 看 `runtime:"node"`；
4. 附件不持久、无 KV，多节点主副库不可用（见 [3.3](#33-edgeone-pages没有持久盘别指望附件留下来)）。

### 4.4 自建 / Docker

```bash
npm ci
npm run build                    # 前端 → dist/
export JWT_SECRET=... DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=...
npm run start:node               # 默认 http://localhost:8787
```

想跑成 systemd 服务或 Docker 时，记得给 `DATA_DIR` 一个**持久**路径（[3.4](#34-自建--docker卷挂到-data_dir)）。

---

## 五、环境变量总表

「平台」列：`W`=Workers，`F`=阿里云 FC，`E`=EdgeOne，`N`=自建 Node/Docker。

### 5.1 基础运行

| 变量 | 默认 | 平台 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | — | 全部 | **必填**，≥32 位随机串 |
| `PORT` | `8787`（FC 包内 `9000`） | F/N | 监听端口 |
| `MAX_BODY_MB` | `100` | 全部 | 请求体上限，超限 413。EdgeOne 建议 `5`（平台 6 MB） |
| `HIDE_WEB_VAULT` | 关闭 | W/F/N | 设为 `1` 时只提供 API，不提供网页版 |
| `DIST_DIR` | `<repo>/dist` | F/N | 前端静态文件目录 |
| `REQUEST_TIMEOUT_MS` | `300000` | N | Node HTTP 服务端请求超时 |
| `HEADERS_TIMEOUT_MS` | `60000` | N | 请求头超时 |
| `KEEPALIVE_TIMEOUT_MS` | `65000` | N | keep-alive 空闲超时 |

### 5.2 数据库（外接 MySQL）

| 变量 | 默认 | 平台 | 说明 |
|---|---|---|---|
| `DB_HOST` | — | F/E/N | MySQL / TiDB 地址。**与后台配置二选一，环境变量优先** |
| `DB_PORT` | `3306` | F/E/N | TiDB Serverless 为 `4000` |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | F/E/N | 账号、密码、库名 |
| `DB_SSL` | **`true`** | F/E/N | 默认开启。TiDB 必须 `true`；自建库无 TLS 时设 `false` |
| `DB_SSL_INSECURE` | 未设（严格校验证书） | F/E/N | 自签证书库设 `1`（等价于不校验证书）；EdgeOne 上只能用这个 |
| `DB_SSL_CA` | — | F/N | 私有 CA 的 PEM 路径（比关校验更安全）；EdgeOne 无持久文件，不可用 |
| `DB_CONN_LIMIT` | `5` | F/E/N | 连接池上限；函数环境别调大 |
| `DB_HOST_ALLOWLIST` | 空 | 全部 | 逗号分隔的域名/IP/CIDR 白名单。后台「测试连接」默认**拒绝内网地址**，自建库在内网时必须填 |
| `DB_CONFIG_KEY` | — | W/F/N | 后台保存配置的加密主密钥（AES-256-GCM）。不设就只能用环境变量 |
| `DB_TIMEZONE` | `Z` | F/E/N | 时间戳本身是 epoch 毫秒，一般不用改 |

### 5.3 存储（**本次补充**）

| 变量 / 绑定 | 默认 | 平台 | 说明 |
|---|---|---|---|
| `DATA_DIR` | `<repo>/data`（FC 包 `/tmp/nodewarden`） | F/N | 数据目录：后台保存的配置、节点同步记录、写入水位、本地 KV 文件。**必须指向持久盘**才能跨重启/缩容保留 |
| `ATTACHMENTS_DIR` | `${DATA_DIR}/attachments` | F/N | 附件与 Send 文件的实际落盘目录。想单独挂一块盘时设 |
| `ATTACHMENTS`（R2 绑定） | — | W | 附件存储，R2 模式必需 |
| `SETTINGS_KV`（KV 绑定） | — | W | 配置存储，优先级最高 |
| `ATTACHMENTS_KV`（KV 绑定） | — | W | KV 模式的附件存储；恢复 KV 模式备份时必需 |

> 目录会在启动时自动创建（`mkdir -p`），但**挂载点必须可写**：不可写会在启动阶段直接报 `EACCES`/`EROFS`。
> EdgeOne 上 `DATA_DIR` 会被强制改成 `/tmp/nodewarden`，填了也无效。

### 5.4 定时备份

| 变量 | 默认 | 平台 | 说明 |
|---|---|---|---|
| `CRON_SECRET` | 空 | F/E/N | 设置后 `POST /internal/cron/backup` 需带 `x-cron-secret` 头；未设时该端点返回 503 |
| `INPROCESS_CRON` | 关闭 | N | 仅单实例常驻自托管设 `1`（进程内定时器）。**FC/EdgeOne 不要开** |
| `INPROCESS_CRON_INTERVAL_MS` | `300000` | N | 进程内定时器间隔 |

### 5.5 认证扩展

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBAUTHN_RP_ID` | 请求域名 | Passkey 的 RP ID，反代/多域名时显式指定 |
| `WEBAUTHN_RP_NAME` | `NodeWarden` | 显示名 |
| `WEBAUTHN_ALLOWED_ORIGINS` | 同源 | 逗号分隔，允许的 Passkey origin |
| `YUBICO_VALIDATION_URLS` | Yubico 官方 | YubiKey OTP 校验地址（离线/私有部署可改） |

---

## 六、数据迁移与备份

1. **D1 → MySQL**：管理后台 → 备份中心 → 导出（`.zip`）→ 切到 MySQL → 导入。
   附件是否一起带走取决于备份选项；从 Workers 迁到 Node 运行时另见 [3.5](#35-从-workers-迁到-node-运行时附件要手动搬)。
2. **MySQL → MySQL**：用「备份数据到副库」（`write-through` 模式），或直接 `mysqldump`。
   给已有数据的部署新增副库时，双写只覆盖保存之后的写入，历史数据必须靠同步补齐。
3. **定时备份**：用平台定时器/外部 cron 调 `POST /internal/cron/backup`（带 `x-cron-secret`），
   而不是进程内定时器。目标端支持 WebDAV / S3，详见部署文档对应章节。
4. **本地目录**：`DATA_DIR` 整个目录 + MySQL 一个 dump 就是完整备份。

---

## 七、上线自检清单

```bash
curl -s https://<你的地址>/healthz
# 期望：{"ok":true,"db":"up","mode":"mysql","source":"env","runtime":"node"}
# Workers 上 mode 可能是 d1；db:down 时先看 5.2 的 TLS 与白名单两项
```

- [ ] `/admin/database` 直接刷新能打开（不是整页 404，也不是白屏）
- [ ] 能注册管理员、网页端登录、保存并同步一条密码
- [ ] 上传一个附件 → **重启实例/等缩容** → 同一个附件还能下载（这一步才证明存储挂载生效）
- [ ] 后台改一次数据库设置 → 重启 → 设置还在（证明 `DATA_DIR` 持久）
- [ ] `MAX_BODY_MB` 不超过平台上限（EdgeOne 6 MB）

---

## 八、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `/healthz` 返回 `db:down`，日志有证书错误 | 默认严格校验证书，自签库过不了 | 设 `DB_SSL_INSECURE=1`，或 `DB_SSL_CA` 指向 PEM |
| `/healthz` 正常但登录报错 | 库字符集/时区不对，或 `JWT_SECRET` 部署后变了 | 库用 `utf8mb4`；`JWT_SECRET` 设成 Secret 而不是普通变量 |
| 后台「测试连接」提示内网地址被拒 | SSRF 防护默认拒绝私网/回环 | 把 host 加进 `DB_HOST_ALLOWLIST` |
| 后台保存配置成功但提示「未生效」 | `DB_*` 环境变量优先于后台配置 | 想用后台配置就先删掉 `DB_*` |
| 附件上传成功，重启后下载 404 | `DATA_DIR` 还在 `/tmp` 或没挂持久盘 | FC 挂 NAS（[3.2](#32-阿里云-fc挂-nas-才能持久化附件)），自建挂卷（[3.4](#34-自建--docker卷挂到-data_dir)） |
| 启动就报 `EACCES` / `EROFS` | 挂载点不可写，或指向了只读的代码目录 | 换到挂载的 NAS/卷；别把 `DATA_DIR` 指到代码目录 |
| EdgeOne 上设了 `DATA_DIR` 没用 | 函数模式强制 `/tmp/nodewarden` | 平台限制，附件持久化请用 FC |
| 大附件/还原在 EdgeOne 上中断 | 6 MB 请求体、120 s 单次执行 | 换 FC，或把备份任务拆小 |
| 配置了副库但切换后数据"少了一截" | 副库从未完成同步，或 `native` 模式其实没接主从 | 先点「同步数据到副库」；保存时红色警告点名的副库要先确认它真的在复制 |
| 多实例部署下主副库互相打架 | 节点健康/水位在进程内，各实例独立判断 | 生产上只保留一个写实例，或用 `native` 让数据库负责复制 |

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [README_ZH.md](README_ZH.md) / [README.md](README.md) | 项目介绍、功能对比、BYO-DB 与多节点语义 |
| [FC-DEPLOY.md](FC-DEPLOY.md) | 阿里云 FC：规格选型、免费额度、定时触发器、旧库升级 SQL、自行打包 |
| [EDGEONE-DEPLOY.md](EDGEONE-DEPLOY.md) | EdgeOne Pages：项目配置、平台限制、部署自测、计划备份 |
| [SECURITY.md](SECURITY.md) | 安全策略与漏洞上报 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |
