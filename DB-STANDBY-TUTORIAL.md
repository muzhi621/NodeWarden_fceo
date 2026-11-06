# FC 版多节点数据库配置教程（TiDB 主库 + 免费副库）

> 适用版本 **v1.8.16+**，部署方式「阿里云函数计算 FC · Web 函数」，配置全部写在**环境变量**里。
> 主库以 **TiDB Cloud Serverless**（原 Starter，免费 5 GiB 行存 / 5000 万 RU 每月）为例，
> 副库以免费的 [SQLPub](https://sqlpub.com) MySQL 8.4 为例；两者角色可以互换，规则通用。
> 规则速查见 [FC-DEPLOY.md 第三节之一](FC-DEPLOY.md#三之一用环境变量配一组可同步的副库v1812)。

这一篇是把一次真实排障整理成的**照着做**教程，覆盖两件容易翻车的事：主库连得上却起不来、
副库密码对了却连不上。第「零之一」节和文末「错误对照表」是重点——它们分别对应
`CREATE command denied`（全站 500）和 `connection failed (unknown)`（卡片红字）。

---

## 零、先说清楚会得到什么

FC 上把 `DB_*` 写进环境变量后，**这份配置就是生效的集群**，后台保存的集群会被它挡住
（FC 没有持久盘，后台保存的内容还会随实例回收消失）。所以加副库只有一种正确姿势：
再加一个环境变量 `DB_STANDBY_NODES`。

得到的是一张**可回滚副本**，不是高可用：

- 副库只由后台的「同步数据到副库」写入，**不会自动接管**，也不会分担读流量；
- 卡片显示「尚未同步（不可接管）」是**正常的新副库状态**，同步一次才会变成可接管；
- 真正要换主库是手工操作：把 `DB_NAME` 改成副库库名、把它从清单里删掉、重新部署。
- 同一台 MySQL 实例上的两个库不构成冗余，实例挂了一起挂。

> ⚠️ **不要把真实密码库放进免费共享实例**。SQLPub 免费版官方定位是测试/学习，明确提示避免
> 处理敏感数据，且免费额度有限（500 MB 存储、约 30 并发、每小时请求数上限，以控制台当前说明为准），
> 没有 SLA。而副库是**主库的全量副本**。请只用空库 + 假数据验证功能；生产容灾请用自建 MySQL
> 或按量付费云数据库，或者干脆用主库 + 备份中心（对象存储）更省事。

---

## 零之一、主库用 TiDB Cloud Serverless：先建业务库（**最容易全站 500 的坑**）

> 这一节是主库配置，和副库无关，但**优先级最高**：库名填错时应用连得上、TLS 通过、认证通过，
> 却在启动第一句 `CREATE TABLE config` 被拒，之后除 `/healthz` 外**每个请求都返回 500**，
> 日志刷 `DB init error: CREATE command denied to user 'xxx.root'@'%' for table 'config'`。

### 1. 不要用 Connect 对话框默认的 `sys`

TiDB Cloud 的 **Connect** 对话框里 `Database` 默认选中的是 `sys`。那是**只读系统库**，
不允许建表（`mysql`、`information_schema`、`performance_schema`、`metrics_schema` 同理）。
把它直接抄进 `DB_NAME` 就会撞上上面的错误。

在控制台 **SQL Editor** 里建库建表。**这个编辑器一次只执行光标所在（或选中）的那一条语句**：
把下面的语句一起贴进去点 Run，实际只跑光标停着的那一条，前面的 `CREATE DATABASE` 根本没执行，
于是后面引用 `nodewarden` 时会报 `Unknown database 'nodewarden'`（Query log 里也只有最后一条）。
**逐条单跑**，每条都看到 Query OK 再继续：

```sql
-- ① 光标放在这一行，单独 Run
CREATE DATABASE IF NOT EXISTS nodewarden DEFAULT CHARACTER SET utf8mb4;
```

```sql
-- ② 单独 Run，确认列表里真的出现了 nodewarden
SHOW DATABASES;
```

```sql
-- ③ 单独 Run（探针建表）
CREATE TABLE nodewarden._probe (id INT PRIMARY KEY);
```

```sql
-- ④ 单独 Run（收尾删掉）
DROP TABLE nodewarden._probe;
```

探针**用全限定名** `nodewarden._probe`，不要写 `USE nodewarden;` —— SQL Editor 不保持会话，
跨语句的库切换不会生效。四条全绿才说明这个账号有 DDL 权限；若 ① 或 ③ 报
`CREATE command denied`，那是**账号权限**问题而不是库名问题，去控制台的 SQL Users
给账号加 DDL 权限（TiDB Cloud Starter 的 `.root` 角色在 public preview 期间可能默认没有）。

### 2. 主库环境变量（照抄填值）

```bash
DB_HOST=gateway01.<region>.prod.alicloud.tidbcloud.com   # 以 Connect 对话框为准
DB_PORT=4000
DB_NAME=nodewarden          # ⚠️ 不是 sys，也不是 test 之外的系统库
DB_USER=<prefix>.root       # ⚠️ 必须带点号前缀，如 ZzHnNXSa5Mdgw8v.root；点号不能丢
DB_PASSWORD=<Connect 对话框 Generate Password 生成的密码，只显示一次>
DB_SSL=true                 # TiDB Cloud Serverless 公网连接强制 TLS
```

- **用户名**：TiDB Cloud Serverless 固定是 `<随机前缀>.root`。少一个点、前缀被工具改写、
  或客户端把 `.` 当分隔符解析掉，都会在连接阶段失败。以 Connect 对话框原样复制。
- **TLS 证书**：Serverless 的证书由公共 CA 签发，Node.js 内置 Mozilla CA 即可验证，
  **不需要** `DB_SSL_CA`，也**不要**设 `DB_SSL_INSECURE=1`（那是全局开关，会连带把主库的
  证书校验一起关掉；之前给自签证书的 SQLPub 副库设过的话，换主库后请删掉）。
- **IP 访问列表**：集群 → Networking → IP Access List。FC 出口 IP 是动态的，验证阶段可临时
  放 `0.0.0.0/0`，确认通了再收紧到自己的出口段。
- **冷启动**：Starter 空闲会缩容到 0，首次连接常有 1–3 秒唤醒延迟，偶尔先断一次；
  重试即可，不是配置错。

### 3. 改完必须重新部署

`DB_*` 改动要发布新版本并让旧实例回收（运行环境有进程内 `sharedEnv` 缓存），
否则旧进程还拿着旧值。`/healthz` 变回 `{"ok":true,"db":"up",...}` 才算恢复。

---

## 一、准备副库实例

1. 注册并创建一个免费 MySQL 实例，记下控制台给的这四项（本例为演示值）：

   | 项 | 示例 |
   |---|---|
   | 连接地址 | `mysql6.sqlpub.com` |
   | 端口 | `3311` |
   | 数据库名 | `nodewardenfc` |
   | 用户名 | `nodewardenfc` |

2. **重置一次密码并立刻复制保存**。免费平台的密码通常随机生成、只在重置时显示一次，列表页不回显。
   库名和用户名可以同名，不是笔误。
3. 先用独立客户端验证网络与凭据，把 NodeWarden 排除在外：

   ```bash
   mysql -h mysql6.sqlpub.com -P 3311 -u nodewardenfc -p nodewardenfc \
     -e "SELECT VERSION(), CURRENT_USER()"
   ```

   能返回 `8.4.x` 即说明地址、端口、账号、密码、来源 IP 全都没问题。**这一步不通过，后面全白做**。

---

## 二、写环境变量（推荐：分离式，不需要编码）

在 FC 控制台 → 函数配置 → 环境变量里，主库那套保持原样，只在下面新增/修改。

```bash
# —— 主库：保持原样 ——
DB_HOST=<主库主机>
DB_PORT=3306
DB_USER=<主库用户>
DB_PASSWORD=<主库密码>
DB_NAME=<主库库名>
DB_SSL=<true 或 false，按主库实际情况>

# —— 副库：每一项都要显式写，尤其 DB_STANDBY_PASSWORD 不能空 ——
DB_STANDBY_NODES=nodewardenfc
DB_STANDBY_HOST=mysql6.sqlpub.com
DB_STANDBY_PORT=3311
DB_STANDBY_USER=nodewardenfc
DB_STANDBY_PASSWORD=<刚重置出来的 SQLPub 密码，原样粘贴，不加引号>
DB_STANDBY_SSL=true
DB_STANDBY_CONN_LIMIT=2
```

**为什么推荐这套**：`DB_STANDBY_NODES` 里只写一个裸库名时，代码会拿 `DB_STANDBY_*` 这一组作为
连接默认值，密码是一个独立的变量值，**不需要任何百分号编码**，也不怕 `@ : / # ?` 这类字符把 URL 切断。
免费实例只有约 30 个连接，`CONN_LIMIT=2` 足够，别照抄主库的 5。

可用的变量名只有下面这些，写错（例如 `DB_STANDBY_PASS`）会被**静默忽略**，然后触发第三个坑：

| 变量 | 作用 |
|---|---|
| `DB_STANDBY_NODES` | 副库清单，逗号分隔；最多 7 个副库（含主库共 8 节点） |
| `DB_STANDBY_HOST` / `_PORT` / `_USER` / `_PASSWORD` | 裸库名条目的连接参数 |
| `DB_STANDBY_SSL` | 是否启用 TLS |
| `DB_STANDBY_CONN_LIMIT` | 该副库连接池上限 |
| `DB_STANDBYS` / `DB_STANDBY_NAME` | 旧版单数写法，仍被读取，等价 |

### 另一种写法：完整 URL

多台不同服务器、不同账号时更方便，可以混写裸库名和 URL：

```bash
DB_STANDBY_NODES='nodewardenfc,mysql://bak:p%40ss@10.0.0.6:3306/nw_bak?ssl=false&conn=2'
```

URL 形式有两条硬规矩：

1. **格式必须严格**：`mysql://用户:密码@主机:端口/库名?参数`。
   下面这种是 `Invalid URL`，会被整条跳过并在启动日志里留一行 `does not parse`：

   ```
   mysql://nodewardenfc:密码 @//mysql6.sqlpub.com/:3311/nodewardenfc?ssl=true&conn=5
                         ↑    ↑↑                 ↑
                       空格   多余的 //      端口写进了路径
   ```

2. **密码要百分号编码**。用命令生成，别手编：

   ```bash
   node -e "console.log(encodeURIComponent(process.argv[1]))" '<你的密码>'
   ```

   `@ : / # ? , ; & % 空格` 都必须编码（`@`→`%40`、`#`→`%23`、`%`→`%25`）。
   逗号 `,` 也要编码——它是清单的分隔符，不编码会把一条拆成两条。

`?` 后面的 `ssl` / `conn` 只对这一条生效；不写 `ssl` 就跟随主库的 `DB_SSL`。

---

## 三、重新部署（这一步不能省）

改完环境变量**必须发布新版本，并确认旧实例已回收**：运行环境把环境变量镜像进 `process.env`，
且有进程内缓存，预留/常驻实例会一直用旧值。常见现象就是「控制台明明改了，后台还是旧配置」。

同时**浏览器强制刷新**一次：前端资源文件名带 hash，不刷新会加载旧 JS。

**验收两处**：浏览器打开 `/healthz` 应返回 200 且 `{"ok":true,"db":"up",...}`；再回 SQL Editor
单独跑一次 `SHOW TABLES FROM nodewarden;`，能看到 `config`、`users`、`ciphers` 等表，才说明
初始化真的跑完了（`/healthz` 只证明连接池能解析，不代表建表成功）。
新库是空的，需要重新注册账号或从备份导入；副库还要点一次「同步数据到副库」才有 `syncReady`。

---

## 四、验证：让卡片变绿

打开后台 → 数据库设置，环境变量副库会显示成 `副库 1 · nodewardenfc` 这样的卡片
（这个名字是代码按清单生成的，不是后台保存的）。

点该卡片的「测试」。成功时长这样：

```
副库 1 · nodewardenfc    135ms · 8.4.3-SQLPub-0.0.1
mysql6.sqlpub.com:3311 / nodewardenfc · nodewardenfc · 连接池 2 · TLS 开启 · 优先级 2 · 尚未同步（不可接管）
```

✅ 绿色延迟 + 版本号 = 握手、TLS、认证全通过。

> **测试时密码框请留空。** 表单里的「已保存（留空则不修改）」意思是「沿用生效配置里的密码」——
> 这正是我们要验证的那份。手动填一遍虽然也能变绿，但那是在测你手填的值，会造成假阳性。
> v1.8.15 及更早版本有个 bug 会让留空时误用主库密码（见坑 4），**v1.8.16 已修复**。

---

## 五、同步数据，解除「不可接管」

卡片上的「尚未同步（不可接管）」= `syncReady:false`：未同步的副库会被排除在读写之外，
主库和线上登录**不受影响**，所以看到它不用慌。

点「同步数据到副库」，一次请求会处理清单里所有副库：

- 空库不用手工建表，同步前会用主库的 `SHOW CREATE TABLE` 把缺的表补上；
- 默认「只补缺失行」，不覆盖副库已有数据；
- 完成后卡片变成「已同步 <时间> · N 张表」，此时才是可接管状态。

> 免费实例有每小时请求数上限。全表 COUNT 校验 + 分批 upsert 会打不少请求，
> **数据量一大就可能触发账号临时锁定**（`3118 - Account is locked`）；这也是只用假数据验证的原因之一。

---

## 六、七个坑（按踩中的概率排序）

### 坑 0：主库库名用了 `sys`，全站 500（**最严重**）

见第「零之一」节。TiDB Cloud 的 Connect 对话框默认给 `sys`，那是只读系统库，连得上却建不了表。
现象很迷惑：TLS 通过、认证通过、客户端能查 `SELECT 1`，但应用启动就报
`CREATE command denied to user 'xxx.root'@'%' for table 'config'`，之后每个请求都是 500，
而后台节点「测试」按钮在 v1.8.15 及更早会**显示绿色**（探测只跑 `SELECT VERSION()`，不建表）。

**修法**：`CREATE DATABASE nodewarden;` → 把 `DB_NAME` 改成 `nodewarden` → 重新部署。
**v1.8.16 起**：探测会直接检查 `DATABASE()` 是否是系统库并报 `connection failed (permission)` +
中文提示，不会再假绿；分类器也把 `CREATE command denied` 从 `unknown` 拆出来。

### 坑 1：副库密码被静默继承成主库密码

`DB_STANDBY_PASSWORD` 没设、设成空串、或 URL 里省略了 `用户:密码@` 时，代码会**回退使用主库的
`DB_PASSWORD`**。两台服务器账号密码不同 → 必然 `Access denied`。

后台看不出来：节点卡只回传「密码是否已设置」，继承来的主库密码非空，照样显示「已设置」。
**v1.8.16 起**：跨主机/端口/账号的继承会在启动日志告警一次，卡片上也会出现红色
「密码沿用主库（请设 DB_STANDBY_PASSWORD）」标记。

### 坑 2：`(auth)` 也可能是「要求 SSL」

MySQL 账号带 `REQUIRE SSL` 时，明文连接返回的是
`Access denied; SSL connection is required`，错误分类**先匹配 `Access denied` 再匹配 TLS**，
所以显示成 `(auth)` 而不是 `(tls)`。按上面设 `DB_STANDBY_SSL=true` 再测。

若开启 TLS 后变成 `(tls)`，通常是平台用自签证书，而代码默认校验证书链：

```bash
DB_SSL_INSECURE=1     # 跳过证书校验
```

⚠️ 这是**全局开关**，主库连接也会跟着不校验。主库是 TiDB 之类依赖严格校验的服务时，
改用 `DB_SSL_CA` 指向 CA 的 PEM 文件更安全。若日志是 `HANDSHAKE_NO_SSL_SUPPORT`，说明服务端
压根不支持 TLS，把该条改回 `?ssl=false`。

### 坑 3：URL 格式错 / 密码没编码 → 整条被跳过

见第二节。整条跳过时页面表现是「副库卡片根本不出现」或「连接参数还是主库的」，
启动日志里会有 `does not parse`、密码已脱敏成 `***`。

### 坑 4：「测试」按钮的假阴性（v1.8.15 及更早）

旧版本的测试接口在后台保存的集群里按 id 找不到 `env-standby-1`，就回退到生效集群的
**第 0 个节点 = 主库**，拿主库密码去连副库 —— 于是环境变量 URL 完全正确，点「测试」依然
`connection failed (auth)`。**实际读写链路不受影响**，所以会出现「客户端能连、后台一直红」。
保存集群的路径也有同样漏洞，会把空密码写进配置。

**v1.8.16 修复**：按 id 先在生效集群里找（环境变量优先，防止旧保存记录覆盖）；
探测失败时返回可执行的中文提示 + 脱敏截断的原始驱动错误（含 `using password`、`@来源IP`），
不用再翻 FC 日志。旧版本的临时绕过办法是点测试前在密码框手填一遍，但那只是绕过，不是修好。

### 坑 5：改了环境变量没生效

见第三节：必须重新部署 + 旧实例回收 + 浏览器强刷。

### 坑 6：以为副库会自动接管

见第零节和第五节。复制不等于接管，也不等于高可用。

---

## 七、错误对照表

后台红字形如 `connection failed (分类)`，分类由服务端按错误信息归类：

| 分类 | 触发条件 | 先查什么 |
|---|---|---|
| `auth` | 含 `Access denied` | 密码（坑 1）、账号锁定（3118）、`REQUIRE SSL`（坑 2）、来源 IP 白名单 |
| `tls` | 含 `certificate` / `TLS` / `SSL` / `self-signed` | 自签证书 → `DB_SSL_INSECURE=1`；不支持 TLS → `?ssl=false` |
| `dns` | `ENOTFOUND` | 主机名拼写、FC 出网 / DNS |
| `refused` | `ECONNREFUSED` | 端口写错、目标未监听 |
| `timeout` | `ETIMEDOUT` / `timeout` | 安全组 / 防火墙、白名单是否放行 FC 出口 IP |
| `database` | `Unknown database` | 库名拼写、库是否真的建了；SQL Editor 里尤其常见——只跑了光标那一条，`CREATE DATABASE` 没执行（第「零之一」节） |
| `permission` (v1.8.16+) | `CREATE/ALTER/DROP command denied` | **库名是不是 `sys` 等系统库**（坑 0）、账号有没有 DDL 权限 |
| `unknown` | 以上都不匹配 | 看提示条里的原始驱动错误；常见是 `read ECONNRESET` / `PROTOCOL_CONNECTION_LOST`（TiDB 冷启动重试即可）、`ERROR 1105`、`Client does not support authentication protocol` |

> 注意 `CREATE command denied` **不含** `Access denied`，也不含 `Unknown database`，
> 所以 v1.8.15 及更早只会显示没有信息量的 `connection failed (unknown)`。这就是
> 「FC 日志里明明写了原因、页面却看不出来」的原因；v1.8.16 已拆出 `permission` 分类。

v1.8.16 起，失败提示条会直接带上中文处置建议和脱敏后的原始错误；服务端日志
`[db-config] connection test failed` 还会记录 `user` 与 `passwordSource`
（`env` / `inherited-primary` / `form` / `saved` / `unset`），据此能一锤定音是哪份凭据在生效。

> 提示条里的原始错误已折叠换行、截断到 240 字符，且**不含密码明文**；贴出来求助是安全的，
> 但环境变量值和完整 URL 请勿外发。

---

## 八、离线自检（可选）

不想反复部署试错时，可以先在本地把 FC 那套变量设到同一个 shell，跑一次解析自检
（仓库内 `scripts/db-env-check.mjs`）：

```bash
# macOS / Linux / Git Bash：把 FC 控制台的变量照抄到同一个 shell
DB_HOST=... DB_PASSWORD=... DB_STANDBY_NODES=nodewardenfc \
DB_STANDBY_HOST=mysql6.sqlpub.com DB_STANDBY_PASSWORD=... \
  node scripts/db-env-check.mjs

# Windows PowerShell
$env:DB_HOST="..."; $env:DB_PASSWORD="..."; $env:DB_STANDBY_NODES="nodewardenfc"
node scripts/db-env-check.mjs
```

脚本**不连数据库、不打印明文密码**（只输出长度与首尾字符），直接告诉你每个副库最终生效的
host / port / user / database / SSL / 连接池，以及**密码来源是「显式设置」还是「⚠ 继承主库」**、
有没有拼错的 `DB_*` 变量名、URL 密码是否被特殊字符截断。逻辑复现
`src/services/db-config.ts` 的 `resolveStandbysFromEnv()` 与 `server/node-runtime.ts` 的白名单，
改环境变量前先跑一遍最省时间。

---

## 九、清理与回滚

- **去掉副库**：删掉 `DB_STANDBY_NODES`（以及 `DB_STANDBY_*`）后重新部署，集群自动回到单节点，
  主库数据不动。
- **换主库**：把 `DB_NAME` / `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` 改成副库的，
  并把它从 `DB_STANDBY_NODES` 里删掉，重新部署。数据不动，随时可以改回来；
  也可以把旧主库写进清单，等于反向备份一次。
- **别在 FC 上用后台「保存集群」**：实例回收后 `/tmp` 里的配置会丢，环境变量才是唯一可靠来源。
  若确实要持久化后台配置，需先挂 NAS 并设 `DATA_DIR`（见 [FC-DEPLOY.md 第三节之二](FC-DEPLOY.md#三之二挂载-nas-让附件与配置持久化必看默认会丢)）。
