<!--
Release note writing rules:
1. Always add the newest release at the top of this file; do not delete older release notes.
2. Move previous releases down unchanged, then write the new release above them.
3. Use this exact release structure:
   - One H1 title: "# vX.Y.Z - Short English Summary".
   - English section first with "### Added", "### Improved", and "### Fixed".
   - Then a horizontal rule "---".
   - Chinese section second with "### 新增", "### 改进", and "### 修复".
4. Use numbered items under each group. Each item must be:
   - "1. **Short feature/fix title.** One concise paragraph explaining what changed and why it matters."
   - No one-line commit dumps, no raw changelog lists, no vague marketing copy.
   - Merge related commits into one readable item instead of listing every commit separately.
5. Keep the tone user-friendly and concrete:
   - Explain behavior, compatibility, UI impact, migration impact, or bug impact in plain language.
   - Be concise but specific; one item is usually 1-3 sentences.
   - Avoid internal-only implementation details unless they explain a user-visible change.
6. Add GitHub commit links at the end of every numbered item:
   - English: "Commit: [abc1234](...)." or "Commits: [abc1234](...), [def5678](...)."
   - Chinese: "提交：[abc1234](...)。" or "提交：[abc1234](...)、[def5678](...)。"
7. The English and Chinese versions should match in content and ordering, not be two different summaries.
-->

# v1.8.5 - Correct S3 Signatures and a Verified Attachment Disk

### Added

1. **A startup check that the attachment disk is really a disk.** Pointing `ATTACHMENTS_DIR` at a directory that exists but is not a mount (or is not writable) used to accept uploads onto the container's own disk, which are then lost when the instance is recycled — silently, with no error anywhere. It is now checked once at boot, logged at error level with what to do about it, and reported by `/healthz` as `attachments`: `ok`, `missing`, `not-mounted` or `unwritable`. The check only runs when the directory was moved away from the default, so nobody who left it alone pays for it. Commit: [1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755).

1. **`BACKUP_ENDPOINT_ALLOWLIST`, so self-hosted object storage can be used at all.** The strict SSRF policy rejected every backup endpoint that was not a public address, which ruled out a MinIO on `127.0.0.1` or a NAS on a private range — the two most common self-hosted targets. The variable accepts exact hosts, `*.suffix` wildcards and IPv4 CIDR blocks, and is unset by default: nothing loosens unless you list it, and cloud metadata and link-local addresses stay blocked either way. Commit: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b).

1. **An S3 test server that verifies SigV4 with its own implementation.** `scripts/s3-test-server.ts` re-derives the signature independently of the code under test, so canonicalisation bugs fail the suite instead of passing through a mock that agrees with whatever the client sent. Ten cases cover round trips, spaces and non-ASCII keys, continuation tokens, sub-prefixes, retention, error detail and addressing styles. Commit: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b).

### Improved

1. **Uploads no longer sit in memory.** The Node runtime used to read the whole request into a buffer before the pipeline saw a byte, so a single 100 MB attachment pinned 100 MB of the instance on top of whatever the storage layer then used. The socket is handed over as a stream and piped straight to the file. The size ceiling moved into the body pipeline: a declared `Content-Length` over `MAX_BODY_MB` is refused before anything is read, and a chunked upload that grows past it is cut off mid-stream with 413. Commit: [1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755).

1. **Backup requests now explain themselves, time out, and retry.** A failing upload used to come back as a bare status code. The provider's own `<Code>` and `<Message>` are now surfaced, so a 403 tells you whether the problem is the keys, the region or the addressing style. Requests carry a timeout (`S3_REQUEST_TIMEOUT_MS`, 120 s by default), and 429, 5xx and network failures are retried up to three times with the response body cancelled first. Commit: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b).

1. **OSS is told up front that it only speaks virtual-hosted-style.** Aliyun OSS rejects path-style requests, and the normalisation default was path-style, so the operator got an unexplained 403 on every request. The combination is now refused before anything is sent, with a message naming the setting to change, and the addressing table in the docs says the same thing. Commit: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b).

### Fixed

1. **S3 signatures failed on any path containing a space or non-ASCII characters.** The canonical query string was built with `URLSearchParams`, which encodes a space as `+`, while the signature covered `%20` — so an upload prefix like `我的 备份` produced `SignatureDoesNotMatch` every single time. The canonical string is now built from the raw query with RFC 3986 encoding. Keys and headers are also sorted by code point rather than `localeCompare`, whose ICU collation orders punctuation differently from AWS and broke the signature for some parameter combinations only. Commit: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b).

1. **Half-written attachments were served as valid files.** An upload interrupted mid-write left a short file with either no metadata or metadata written afterwards, and a self-consistent length, so the download looked fine and the attachment was silently truncated. The sidecar is now written first with an `incomplete` marker and rewritten with the byte count that was counted while streaming; an interrupted upload is never served. Files restored by copying (no sidecar) are still readable, so existing data does not disappear. Commits: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b), [1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755).

1. **A broken mount looked like deleted files.** Only `ENOENT` and `ENOTDIR` mean "no such attachment" now; `EIO`, `ETIMEDOUT`, `EACCES` and `ENOTCONN` are rethrown, so a dropped FUSE mount answers 5xx instead of telling every client that their files were deleted. Commit: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b).

1. **Object keys containing `&` or `<` were listed under names that could not be downloaded.** ListObjectsV2 was parsed with a tag-based XML reader, so an unescaped metacharacter truncated the key on read: the file appeared in the backup list under a wrong name and could neither be downloaded nor deleted. Listing now requests `encoding-type=url` and percent-decodes the result. Commit: [1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755).

1. **Four EdgeOne smoke assertions had been red on `main` since round six.** The no-database gate has answered 503 with an operator-facing message since then, but the smoke script still expected 500. The assertions now accept the documented behaviour, and `test:edgeone` is 21/21 again. Commit: [e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b).

---

# v1.8.5 - 修正 S3 签名，并让附件盘能自证

### 新增

1. **启动时确认附件盘真的是块盘。** 过去把 `ATTACHMENTS_DIR` 指到一个「目录存在、但其实没挂上」的位置，上传会照常成功——文件落在容器自己的盘上，实例回收即消失，而且哪里都不报错。现在启动时检查一次：能不能写、是不是独立挂载点；结果按 error 级别记一条日志（写明该怎么办），并在 `/healthz` 的 `attachments` 字段报告 `ok` / `missing` / `not-mounted` / `unwritable`。该检查只在目录被改成非默认值时才跑，没动过这个变量的人不受影响。提交：[1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755)。

1. **`BACKUP_ENDPOINT_ALLOWLIST`，让自建对象存储真正能用。** 严格 SSRF 策略会拒绝一切非公网地址，于是 `127.0.0.1` 上的 MinIO、内网段的 NAS 这两类最常见的自建目标根本配不上。该变量支持精确主机名、`*.后缀` 通配和 IPv4 CIDR，默认不设——你不写就什么都不放开，云元数据地址与 link-local 始终保持拦截。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)。

1. **一个自己验签的 S3 测试服务器。** `scripts/s3-test-server.ts` 独立实现 SigV4 校验，不与被测代码共用一份逻辑，签名规范化写错时测试会红，而不是被一个「客户端发什么就认什么」的桩糊过去。10 个用例覆盖往返读写、空格与非 ASCII 键、续页令牌、子前缀、保留策略、错误详情和地址样式。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)。

### 改进

1. **上传不再整包进内存。** 过去 Node 运行时会把整个请求先读成 Buffer，管线才拿到第一个字节，一个 100 MB 的附件就额外占住 100 MB 实例内存，之后存储层还要再占一份。现在 socket 直接交给流处理，一路管道写进文件。大小上限移到请求体管线里：`Content-Length` 声明的长度超过 `MAX_BODY_MB` 会在读取前就被拒，分块上传涨过上限则在传输中途截断并返回 413。提交：[1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755)。

1. **备份出错会说话了，也会超时和重试。** 上传失败过去只回一个状态码。现在把服务商自己的 `<Code>` 和 `<Message>` 透出来，403 能直接看出是密钥、区域还是地址样式的问题。请求带超时（`S3_REQUEST_TIMEOUT_MS`，默认 120 秒），429、5xx 与网络故障最多重试三次，重试前先取消响应体。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)。

1. **阿里云 OSS 只支持 virtual-hosted-style，现在会提前拦住。** OSS 不接受 path-style 请求，而配置归一化的默认值恰好是 path-style，于是每个请求都吃一个没有解释的 403。这个组合现在在发请求之前就被拒绝，并提示该改哪个设置，文档里的地址样式对照表也一并改正。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)。

### 修复

1. **路径里带空格或中文时，S3 签名必然失败。** 规范查询串用 `URLSearchParams` 生成，它把空格编成 `+`，而签名覆盖的是 `%20`，所以像 `我的 备份` 这样的上传前缀每次都会 `SignatureDoesNotMatch`。现在按原始查询串手工做 RFC 3986 编码。键与请求头的排序也改成按码点，不再用 `localeCompare`——它的 ICU 排序对符号的处理与 AWS 不同，只会在某些参数组合下偶发失败。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)。

1. **写了一半的附件会被当成正常文件下载。** 上传中途断掉会留下一个短文件，元数据要么没有、要么事后才写，长度自洽，于是下载看起来成功，附件其实被截断。现在先写带 `incomplete` 标记的元数据，上传过程中边写边数字节，完成后再改写成真实长度；中断的上传永远不会被提供下载。用拷贝方式恢复、没有元数据的文件仍然可读，已有数据不会集体消失。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)、[1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755)。

1. **挂载坏掉不再被当成「文件被删了」。** 现在只有 `ENOENT` 和 `ENOTDIR` 代表「没有这个附件」，`EIO`、`ETIMEDOUT`、`EACCES`、`ENOTCONN` 一律抛出去，FUSE 掉线时返回 5xx，而不是告诉每个客户端他们的文件已被删除。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)。

1. **对象键里含 `&` 或 `<` 时，列表显示的名字下载不到。** ListObjectsV2 原先用标签式 XML 解析，未转义的元字符会在读取时把键截断：文件以错误的名字出现在备份列表里，既下不下来也删不掉。列表现在请求 `encoding-type=url` 并对结果做百分号解码。提交：[1fa4e61](https://github.com/muzhi621/NodeWarden_fceo/commit/1fa4e61140a0d2561d5e94b3a99fc3c744cea755)。

1. **EdgeOne 有 4 条冒烟断言从第六轮起在 `main` 上就是红的。** 无数据库时接口早已改为返回 503 并带运维提示，冒烟脚本却仍在断言 500。断言已改为接受文档化的行为，`test:edgeone` 恢复 21/21。提交：[e5a4365](https://github.com/muzhi621/NodeWarden_fceo/commit/e5a4365eae830d165d1df0b4d7740c503128310b)。

---

# v1.8.4 - Trustworthy Failover, Explicit Switchover, and a Complete Deployment Guide

### Added

1. **Switch the writer explicitly, with three gates.** Standby cards in Admin → Database settings now have a "Switch to primary" button backed by `POST /api/admin/db-config/promote`. It verifies connectivity, then that the database itself reports writable (`@@GLOBAL.read_only` / `super_read_only`, so a read-only replica is refused instead of becoming a primary that rejects every write), then — in `write-through` mode — that the node completed a sync with no watermark lag. A refusal returns 409 and lists every unmet condition; `?force=1` overrides it and says what data will be missing. After a successful switch the roles swap, priorities are renumbered, and a demoted node that was level keeps a sync record so it can still serve reads or take over again. Commits: [176b9f9](https://github.com/muzhi621/NodeWarden_fceo/commit/176b9f9bc4ebc63220607e9fcd51e5d8034c0c72), [df8d80e](https://github.com/muzhi621/NodeWarden_fceo/commit/df8d80ea0ad591705e044b992c046a61b3c50308).

1. **A consolidated deployment guide with the storage chapter that was missing.** New `DEPLOY.md` covers all four targets (Cloudflare Workers, EdgeOne Pages, Alibaba Cloud FC, self-hosted/Docker) in one place, including where attachments and admin-page settings actually live and what to set so they survive a restart: R2 `ATTACHMENTS` and KV `SETTINGS_KV` on Workers, a NAS mount plus `DATA_DIR` / `ATTACHMENTS_DIR` on FC, and a volume mount for Docker. It also documents the D1/R2 to Node migration step that nobody had written down — attachments do not travel with the database and must be copied by hand — plus mounting Alibaba Cloud OSS or Tencent COS as the attachment disk with ossfs, cosfs or rclone (self-hosted only; serverless has no FUSE device, so those deployments use the backup centre's S3-compatible target instead), a full environment-variable table and an acceptance checklist. Commits: [138a8c7](https://github.com/muzhi621/NodeWarden_fceo/commit/138a8c76a9e36893b8e416f7a366481d5d4be6e6), [8669772](https://github.com/muzhi621/NodeWarden_fceo/commit/866977213d543c1c515b4e272d19496b337ca787).

### Improved

1. **Access-control failures are now actionable instead of a crash.** A saved cluster config whose nodes are all disabled used to fall through to the D1 binding, which does not exist on the Node runtime, so every request died on `undefined.prepare`. It now returns 503 with a message naming how many nodes exist and what to do, visible both in `/healthz` and as a banner on the admin page. Raw driver errors still come back as a generic 500, so host names and credentials never leak. Commit: [2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e).

1. **An unreachable standby no longer slows every request.** Schema initialisation against a standby that is down used to be retried on every single request with no backoff, so a perfectly healthy primary paid a connection timeout per request whenever a standby was offline. Failures now back off from 30 seconds, doubling to a five-minute cap, and reset on the first success. Commit: [243f998](https://github.com/muzhi621/NodeWarden_fceo/commit/243f9984b170755b2606a44f67fdc3783815af8e).

1. **Sync results stopped overstating progress.** A merge sync re-sends the whole table on every run, and `FOUND_ROWS` makes "inserted" and "already there" both report one affected row, so the old row count said nothing about progress. The added-row count is now measured from the target's own `COUNT(*)` before and after, and the page reads "added N rows (M already existed, not overwritten)". Overwrite and truncated runs report no number rather than a misleading one. Commit: [176b9f9](https://github.com/muzhi621/NodeWarden_fceo/commit/176b9f9bc4ebc63220607e9fcd51e5d8034c0c72).

1. **A standby that finishes syncing on another instance becomes usable immediately.** The connection-pool cache key ignored readiness, so a pool created before the sync kept refusing the standby even after `resolveDbCluster` reported it ready. The cached adapter now refreshes its readiness on every hit.

### Fixed

1. **A restart no longer makes a lagging standby look caught up.** Write watermarks only existed in process memory, so a restart reset every node to "0 == 0, therefore current" and the next failover silently lost whatever the standby had missed — in a reproduced case, four rows with a reported lag of zero and no warning. The "who is behind" relation is now persisted, and nodes that were behind are marked as needing a full sync, because the in-memory journal that could have bridged the gap no longer exists. Commit: [2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e).

1. **A completed sync no longer masks writes it did not copy.** `markNodeSynced()` pinned the watermark to the current write sequence, but the default merge sync never overwrites an existing row. A standby that missed an `UPDATE` was reported as level while permanently diverged (reproduced: primary `v2`, standby `v1`, `lag=0`). It now advances only to the watermark captured when the sync started, leaving the difference to the journal. Commit: [2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e).

1. **Repointing a standby at a new database invalidates its "already synced" verdict.** The sync record was keyed by node id alone, and the UI keeps the id when you change host or database (that is how the password is preserved), so a brand-new empty database inherited the old verdict and could take over immediately. Records now carry a `host|port|database` fingerprint, and stale records are deleted when the config is saved. Legacy records without a fingerprint are still trusted so upgrading does not invalidate a working setup. Commit: [2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e).

1. **Regression tests now cover the boundaries where all of the above lived.** The existing cluster suite passed while these bugs shipped, because every one of them happened across a restart or a changed node identity. New suites cover restarts and watermarks, the promote gates, the zero-enabled-node case, and inserted-versus-resent counts, and the real-MySQL end-to-end script now switches the writer and asserts that the next write lands on the new primary and is replayed to the old one. Commit: [3c143a2](https://github.com/muzhi621/NodeWarden_fceo/commit/3c143a2f763ef60bac4b3ec205410f1d92e49b79).

---

# v1.8.4 - 可靠的主副库切换、显式提升，以及一份完整的部署教程

### 新增

1. **显式切换主库，切换前三道校验。** 数据库设置里的副库卡片新增「切换主库」按钮（`POST /api/admin/db-config/promote`）。切换前依次确认：目标节点连得上；数据库自己报告可写（`@@GLOBAL.read_only` / `super_read_only`，只读副本会被当场挡回，而不是切成一个拒绝所有写入的主库）；`write-through` 模式下该节点已完成同步且写入水位无落后。任一项不满足返回 409 并列出全部缺口，`?force=1` 才强制切换，并写明会缺哪部分数据。切换成功后角色互换、优先级重排，原本与水位持平的原主库会保留一条同步记录，仍可承接读请求或再次接管。提交：[176b9f9](https://github.com/muzhi621/NodeWarden_fceo/commit/176b9f9bc4ebc63220607e9fcd51e5d8034c0c72)、[df8d80e](https://github.com/muzhi621/NodeWarden_fceo/commit/df8d80ea0ad591705e044b992c046a61b3c50308)。

1. **一份汇总部署教程，补上一直缺的存储章节。** 新增 `DEPLOY.md`，把四种部署方式（Cloudflare Workers、EdgeOne Pages、阿里云 FC、自建/Docker）收到一处，重点讲清「附件和管理页配置到底存在哪、怎么配才能在重启后还在」：Workers 用 R2 `ATTACHMENTS` 与 KV `SETTINGS_KV` 绑定，FC 挂 NAS 并设 `DATA_DIR` / `ATTACHMENTS_DIR`，Docker 挂卷。同时补上了过去没人写的一步——从 D1/R2 迁到 Node 运行时，**附件不会跟着数据库走，必须手动拷贝**——以及把阿里云 OSS / 腾讯云 COS 挂成附件盘的完整教程（ossfs、cosfs、rclone 三条路，仅自建/Docker 可行：Serverless 没有 FUSE 设备，这类部署改用备份中心的 S3 兼容目标），另附完整的环境变量总表与上线自检清单。提交：[138a8c7](https://github.com/muzhi621/NodeWarden_fceo/commit/138a8c76a9e36893b8e416f7a366481d5d4be6e6)、[8669772](https://github.com/muzhi621/NodeWarden_fceo/commit/866977213d543c1c515b4e272d19496b337ca787)。

### 改进

1. **没有可用数据库时给出可执行的错误，而不是崩溃。** 保存过集群配置但节点全部停用时，旧逻辑会回落到 D1 绑定——Node 运行时根本没有这个绑定，于是每个请求都死在 `undefined.prepare`，日志里只有一句没人看得懂的话。现在统一返回 503，直接说明配置里有几个节点、全部停用、该去哪里启用，`/healthz` 与管理页顶部都会显示。驱动原始错误仍然只返回通用 500，不会泄露主机名与凭据。提交：[2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e)。

1. **副库不可达时不再拖慢每一个请求。** 旧逻辑对连不上的副库会在**每个请求**上重试建表且没有退避，主库完全健康也要为每次请求付一次连接超时。现在失败后从 30 秒起退避、逐次翻倍、封顶 5 分钟，首次成功后立即复位。提交：[243f998](https://github.com/muzhi621/NodeWarden_fceo/commit/243f9984b170755b2606a44f67fdc3783815af8e)。

1. **同步结果不再夸大进度。** 「只补缺失行」模式每次都会整表重发，而 `FOUND_ROWS` 让「新插入」和「已存在」都返回 1 行，旧的行数统计说明不了任何问题。现在按目标库同步前后的 `COUNT(*)` 差值给出真正新增的行数，页面显示「新增 N 行（另 M 行已存在，未覆盖）」；覆盖模式与被截断的轮次不再给数字，而不是给一个误导值。提交：[176b9f9](https://github.com/muzhi621/NodeWarden_fceo/commit/176b9f9bc4ebc63220607e9fcd51e5d8034c0c72)。

1. **另一个实例完成同步后，本实例立即放行该副库。** 连接池缓存键不包含就绪状态，先建好的池会一直拒绝这个副库，即使配置层已经判定它可以接管（多实例部署下很常见）。现在命中缓存时会刷新就绪状态。

### 修复

1. **重启后落后的副库不再被当成"已追平"。** 写入水位只存在于进程内存，重启后所有节点归零为「0 == 0，所以是最新的」，下一次故障切换就会悄悄丢掉它没来得及同步的数据——实测丢 4 行、`lag=0`、没有任何告警。「谁落后」这一关系现在会持久化，落后的节点标记为需要完整同步（可以用来补齐的内存补写日志已经不跨进程存在了）。提交：[2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e)。

1. **「同步完成」不再掩盖没被复制过去的写入。** `markNodeSynced()` 会把水位直接拉到当前写入序号，而默认的「只补缺失行」并不会覆盖已存在的行。于是漏掉过一次 `UPDATE` 的副库被报告为 `lag=0`，实际已经永久分叉（实测：主库 `v2`、副库 `v1`，`lag=0`）。现在只把水位推进到同步开始的那一刻，差额留给补写日志。提交：[2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e)。

1. **把副库改指到别的库后，旧的「已同步」自动作废。** 同步记录只以节点 id 为键，而后台改 host 或库名时 id 是不变的（保留密码就靠这个），于是一个全新的空库继承了旧的「已同步」判定，可以在故障时立刻接管。现在记录带 `host|port|database` 指纹，保存配置时主动清理失效记录；没有指纹的历史记录仍然信任，升级不会把原本正常的部署变成"未同步"。提交：[2bfbf3a](https://github.com/muzhi621/NodeWarden_fceo/commit/2bfbf3a124082b8b1d240a68cd4e3ec61df6d33e)。

1. **上面这些问题现在有回归测试兜底。** 原有 18 个集群用例全部通过时，这些缺陷照样发布了出去，因为它们都发生在「重启」和「换节点身份」这两个测试从未跨越的边界上。新增用例覆盖：重启与水位持久化、切换主库的三道校验、全部节点停用、以及「新增行 vs 重发行」的计数；真库 E2E 也加上了切换主库的整段流程，并断言下一笔写入落在新主库且回放到旧主库。提交：[3c143a2](https://github.com/muzhi621/NodeWarden_fceo/commit/3c143a2f763ef60bac4b3ec205410f1d92e49b79)。

---

# v1.8.1 - Expanded Generators, Safer Vault Editing, and Client Compatibility

### Added

1. **More local generation tools.** The generator now creates numeric PINs, memorable usernames, email aliases, and Ed25519 or RSA SSH key pairs alongside passwords and passphrases. Passwords support minimum counts for each character type and an option to avoid ambiguous characters, while passphrases and usernames can use custom word lists. SSH keys are generated on the device and are not retained by NodeWarden, so save the private key before leaving the page. Commit: [df493b4](https://github.com/shuaiplus/nodewarden/commit/df493b46972bf864e9dad11370ed5d48de06af2a).

### Improved

1. **Current Bitwarden client compatibility.** Configuration, prelogin, and account-key responses now include fields expected by Bitwarden 2026.7 clients while retaining older response formats. Supported desktop clients also show the official settings dialog with browser integration controls. Commits: [a012890](https://github.com/shuaiplus/nodewarden/commit/a0128908e18557511590bcb06e13c8799b427343), [6ffdf05](https://github.com/shuaiplus/nodewarden/commit/6ffdf05dc65a0fcd3f60cfe586a04a31e19d6de3).

1. **Stronger account authentication with automatic migration.** New registrations and password changes use randomly salted server-side password verifiers, and existing accounts upgrade after a successful password login and any required two-factor verification. Existing vault keys and sessions are preserved, and failed logins use more consistent responses and verification work to reduce account discovery through errors or timing. Commit: [5f71cb3](https://github.com/shuaiplus/nodewarden/commit/5f71cb388c061a640e5f2e372e79fa6059f0e26b).

1. **Clearer deployment and build guidance.** Builds now declare support for Node.js 22.19+ within the 22.x series or Node.js 24.11+, with `.node-version` selecting 24.18.0; align any Cloudflare dashboard `NODE_VERSION` override with that file when upgrading. The deployment FAQ also explains repository connection problems, persistent registration data, and where to configure runtime secrets. Commits: [02081ea](https://github.com/shuaiplus/nodewarden/commit/02081ea07f07501330ba9cfcf1ff4611466def2e), [99d404f](https://github.com/shuaiplus/nodewarden/commit/99d404f7cbf47fa094ea9ed153c16e8f231ded56).

### Fixed

1. **Vault edits preserve fields and detect conflicting saves.** Web edits now retain linked custom-field metadata and unrecognized encrypted properties in supported item types. Outdated and concurrent saves are rejected instead of overwriting newer changes, and the editor keeps your draft with instructions to reopen the item. Official bulk delete and restore methods are also supported alongside legacy routes, with restore returning the restored items. Commit: [293f5ce](https://github.com/shuaiplus/nodewarden/commit/293f5ce19685855f393226c8dceaadd9af8a8782).

1. **Cleared notes stay cleared.** Full item updates now treat omitted notes and custom fields as cleared values, matching clients that leave these properties out after deletion. Previously saved encrypted notes no longer reappear through fallback merging. Commit: [a72592e](https://github.com/shuaiplus/nodewarden/commit/a72592e76e80f1e31eebde0c0216d2a77004440f).

1. **Safe duplicate selection across large vaults.** Duplicate groups now keep distinct identities even when there are more than 64 groups. Cleanup selection no longer confuses later groups with earlier ones or selects every item in an affected group. Commit: [df6b0b9](https://github.com/shuaiplus/nodewarden/commit/df6b0b97675ce69efba68f7895291ba67436208e).

1. **WebAuthn verification in official clients.** Desktop, browser-extension, and mobile connectors now follow Bitwarden's request and response formats, including mobile callbacks and supported desktop origins. Exact connector URLs are preserved in Worker deployments, avoiding redirects and framing restrictions that could interrupt security-key verification. Commit: [f761fff](https://github.com/shuaiplus/nodewarden/commit/f761fffd58ff7b6fd510ae57a1d409d247728a1b).

1. **Helpful registration errors when browser cryptography is unavailable.** Registration now detects insecure or unsupported browser contexts before creating account keys and shows localized guidance to use HTTPS in a supported browser. This replaces an unreadable cryptography runtime error with an actionable message. Commit: [82d9f61](https://github.com/shuaiplus/nodewarden/commit/82d9f61163f6d29803e3a3264b8f986dfa992ebc).

1. **Visible controls and values in narrow panels.** Remote backup rows now reflow according to the panel's available width, vault toolbars and authorized-device actions wrap, and item-detail values retain usable space. These changes prevent buttons and values from being clipped, while links, backup controls, and TOTP indicators follow the selected theme color more consistently. Commits: [589557a](https://github.com/shuaiplus/nodewarden/commit/589557a75737134574861f568b44703c4881795d), [38b0ff6](https://github.com/shuaiplus/nodewarden/commit/38b0ff6263e54e54e2fcc7f6c7ea3e6f34bb8c08), [ecc0d13](https://github.com/shuaiplus/nodewarden/commit/ecc0d134ac732d29240e6d5ba84e9798be222f17), [f644baa](https://github.com/shuaiplus/nodewarden/commit/f644baaf8d23df2b646d2c1c815bd6d7e1e60e26), [fb627f5](https://github.com/shuaiplus/nodewarden/commit/fb627f59f0ee6cfc396634b3f1674cc09a22e186).

1. **Credentials no longer accepted in sensitive request URLs.** Notification connections now use short-lived, single-use tickets obtained through authenticated negotiation instead of accepting access JWTs from URL query parameters. Admin backup attachment downloads require POST with a JSON body; integrations using the old GET endpoint must switch to POST so master-password verification credentials do not enter URL logs or browser history. Commits: [e63f966](https://github.com/shuaiplus/nodewarden/commit/e63f9663e845817268f842fff6c628ef921652db), [6529523](https://github.com/shuaiplus/nodewarden/commit/652952379b5d1d8350dc17096b3125919add4884).

1. **Updated dependencies and removal of vulnerable build tooling.** Dependency updates include Nano ID 3.3.18, Undici 8.10.2, Sharp 0.35.4, and a PostCSS path-traversal fix. The Web Vault also moves to Tailwind CSS 4, removing the vulnerable `braces` dependency from its previous build chain. Commits: [d43f21e](https://github.com/shuaiplus/nodewarden/commit/d43f21e8e03847df1ce81f2dc9534c23f82f54cb), [293f5ce](https://github.com/shuaiplus/nodewarden/commit/293f5ce19685855f393226c8dceaadd9af8a8782), [588dce6](https://github.com/shuaiplus/nodewarden/commit/588dce6a0a3ec67bd48fbbca7f250e181f4bc45f), [f6403b8](https://github.com/shuaiplus/nodewarden/commit/f6403b8cab98abfb456db66e343039c5a803c01b), [4c241aa](https://github.com/shuaiplus/nodewarden/commit/4c241aa64bff3c2833468f8dd5974cc856089aed).

---

### 新增

1. **更多本地生成工具。** 生成器在密码和口令短语之外，新增数字 PIN、易记用户名、邮箱别名以及 Ed25519 或 RSA SSH 密钥对。密码可设置各类字符的最少数量并排除易混淆字符，口令短语和用户名可使用自定义词表。SSH 密钥在设备本地生成，NodeWarden 不会保留，请在离开页面前保存私钥。提交：[df493b4](https://github.com/shuaiplus/nodewarden/commit/df493b46972bf864e9dad11370ed5d48de06af2a)。

### 改进

1. **兼容新版 Bitwarden 客户端。** 配置、预登录和账户密钥响应补齐了 Bitwarden 2026.7 客户端所需字段，同时保留旧版响应格式。受支持的桌面客户端也会显示包含浏览器集成选项的官方设置对话框。提交：[a012890](https://github.com/shuaiplus/nodewarden/commit/a0128908e18557511590bcb06e13c8799b427343)、[6ffdf05](https://github.com/shuaiplus/nodewarden/commit/6ffdf05dc65a0fcd3f60cfe586a04a31e19d6de3)。

1. **更安全的账户认证与自动迁移。** 新注册和修改密码使用带随机盐的服务端密码校验数据，已有账户在密码登录及所需双因素验证成功后自动升级。升级保留原有保险库密钥和会话，失败登录也采用更一致的响应与验证计算，减少通过错误信息或响应耗时探测账户的机会。提交：[5f71cb3](https://github.com/shuaiplus/nodewarden/commit/5f71cb388c061a640e5f2e372e79fa6059f0e26b)。

1. **更清晰的部署与构建说明。** 构建现已声明支持 Node.js 22.x 系列中的 22.19 及以上版本，或 Node.js 24.11 及以上版本；`.node-version` 指定使用 24.18.0，升级时请同步调整 Cloudflare 控制台中覆盖该文件的 `NODE_VERSION` 设置。部署常见问题也补充了仓库连接异常、注册数据持久化和运行时 Secret 配置位置的说明。提交：[02081ea](https://github.com/shuaiplus/nodewarden/commit/02081ea07f07501330ba9cfcf1ff4611466def2e)、[99d404f](https://github.com/shuaiplus/nodewarden/commit/99d404f7cbf47fa094ea9ed153c16e8f231ded56)。

### 修复

1. **编辑条目保留字段并识别保存冲突。** Web 编辑现在会保留关联自定义字段的元数据，以及受支持条目类型中尚未识别的加密属性。过期或并发保存会被拒绝，避免覆盖其他客户端的新修改；编辑器保留草稿，并提示重新打开条目。同时兼容官方批量删除、恢复方法和旧版路由，恢复操作会返回已恢复的条目。提交：[293f5ce](https://github.com/shuaiplus/nodewarden/commit/293f5ce19685855f393226c8dceaadd9af8a8782)。

1. **已清空的备注不再重新出现。** 完整更新条目时，省略的备注和自定义字段现在会按已清空处理，兼容删除后不再发送这些属性的客户端。旧的加密备注不会再被回退合并逻辑恢复。提交：[a72592e](https://github.com/shuaiplus/nodewarden/commit/a72592e76e80f1e31eebde0c0216d2a77004440f)。

1. **大量重复分组下正确选择待清理条目。** 重复分组超过 64 组时，各组仍会保留独立标识。清理选择不再混淆前后的分组，也不会误选受影响分组中的全部条目。提交：[df6b0b9](https://github.com/shuaiplus/nodewarden/commit/df6b0b97675ce69efba68f7895291ba67436208e)。

1. **官方客户端的 WebAuthn 验证。** 桌面端、浏览器扩展和移动端连接页面现已遵循 Bitwarden 的请求与响应格式，包括移动端回调和受支持的桌面端来源。Worker 部署保留连接页面的精确 URL，避免重定向和嵌入限制中断安全密钥验证。提交：[f761fff](https://github.com/shuaiplus/nodewarden/commit/f761fffd58ff7b6fd510ae57a1d409d247728a1b)。

1. **浏览器加密能力不可用时提供明确注册提示。** 注册现在会在创建账户密钥前检查不安全或不受支持的浏览器环境，并通过本地化提示引导用户使用受支持的浏览器和 HTTPS。原先难以理解的加密运行时错误改为可直接处理的提示。提交：[82d9f61](https://github.com/shuaiplus/nodewarden/commit/82d9f61163f6d29803e3a3264b8f986dfa992ebc)。

1. **窄面板中的按钮和内容保持可见。** 远端备份列表现在按面板可用宽度重新排版，保险库工具栏和已授权设备操作按钮可自动换行，条目详情的值也保留可读空间，避免按钮或内容被裁切。链接、备份控件和 TOTP 指示器也会更一致地使用所选主题颜色。提交：[589557a](https://github.com/shuaiplus/nodewarden/commit/589557a75737134574861f568b44703c4881795d)、[38b0ff6](https://github.com/shuaiplus/nodewarden/commit/38b0ff6263e54e54e2fcc7f6c7ea3e6f34bb8c08)、[ecc0d13](https://github.com/shuaiplus/nodewarden/commit/ecc0d134ac732d29240e6d5ba84e9798be222f17)、[f644baa](https://github.com/shuaiplus/nodewarden/commit/f644baaf8d23df2b646d2c1c815bd6d7e1e60e26)、[fb627f5](https://github.com/shuaiplus/nodewarden/commit/fb627f59f0ee6cfc396634b3f1674cc09a22e186)。

1. **敏感请求不再接受 URL 中的认证凭据。** 通知连接现在使用认证协商后取得的短期一次性票据，不再接受 URL 查询参数中的访问 JWT。管理员备份附件下载仅接受带 JSON 请求体的 POST；使用旧 GET 接口的集成需要改为 POST，避免主密码验证凭据进入 URL 日志或浏览器历史。提交：[e63f966](https://github.com/shuaiplus/nodewarden/commit/e63f9663e845817268f842fff6c628ef921652db)、[6529523](https://github.com/shuaiplus/nodewarden/commit/652952379b5d1d8350dc17096b3125919add4884)。

1. **更新依赖并移除存在漏洞的构建工具依赖。** 依赖更新包括 Nano ID 3.3.18、Undici 8.10.2、Sharp 0.35.4，以及 PostCSS 路径穿越问题的修复。Web Vault 同时迁移至 Tailwind CSS 4，移除了旧构建链中存在漏洞的 `braces` 依赖。提交：[d43f21e](https://github.com/shuaiplus/nodewarden/commit/d43f21e8e03847df1ce81f2dc9534c23f82f54cb)、[293f5ce](https://github.com/shuaiplus/nodewarden/commit/293f5ce19685855f393226c8dceaadd9af8a8782)、[588dce6](https://github.com/shuaiplus/nodewarden/commit/588dce6a0a3ec67bd48fbbca7f250e181f4bc45f)、[f6403b8](https://github.com/shuaiplus/nodewarden/commit/f6403b8cab98abfb456db66e343039c5a803c01b)、[4c241aa](https://github.com/shuaiplus/nodewarden/commit/4c241aa64bff3c2833468f8dd5974cc856089aed)。

# v1.8.0 - Deployment Control, Session Reliability, and Compatibility Fixes

### Added

1. **Web Vault visibility control.** Cloudflare Workers deployments can now set `HIDE_WEB_VAULT=1` to return `404 Not Found` for server-hosted Web Vault pages and static assets while keeping Bitwarden login, sync, attachment, icon, notification, and compatibility endpoints available. Removing the variable restores the Web Vault, and already installed or cached PWAs can continue using their local frontend. Commit: [d990b2c](https://github.com/shuaiplus/nodewarden/commit/d990b2c71ff43a43f4598cad715b09c673e87b53).

### Improved

1. **Simpler desktop and mobile navigation.** The Web Vault now uses a consistent grouped sidebar with persistent expanded sections, clearer separation between tools, settings, and system management, and matching mobile settings navigation. This removes the previous layout-mode picker and makes frequently used destinations easier to find. Commit: [e25ec15](https://github.com/shuaiplus/nodewarden/commit/e25ec159bb2cd07ec6b3a794032a8a2978340d3d).

1. **Safer YubiKey validation credential management.** Yubico validation credentials now use centralized, concurrency-safe initialization; only active administrators can view or replace configured credentials, and credential initialization and reconfiguration are recorded in the security audit log. Regular users can still enroll YubiKeys without gaining access to server-wide credentials. Commit: [573451c](https://github.com/shuaiplus/nodewarden/commit/573451c52f02978dee5ab8379ff86e59da805437).

1. **Bitwarden-compatible personal API keys and safer backups.** Personal API keys can now be viewed after master-password verification and rotated without revoking unrelated sessions. Legacy hashed keys continue to authenticate until the user explicitly rotates them, while new backups exclude personal API keys and runtime authentication or device-trust state; older archives remain importable, but that runtime state is intentionally ignored during restore. Commit: [299eda5](https://github.com/shuaiplus/nodewarden/commit/299eda597ff8a07bf0b7ddfb6e3a5e7f800096db).

### Fixed

1. **Unexpected logout during temporary refresh failures.** Refresh sessions now use client-aware sliding lifetimes with an absolute upper bound, and transient network or service failures no longer turn a locked Web Vault into a forced full login. The Web Vault preserves the locked session, shows a retry path, and keeps official desktop, mobile, browser-extension, and web-cookie flows compatible. Commit: [b731a01](https://github.com/shuaiplus/nodewarden/commit/b731a014f1d86552615110cdf543f809a5c6a7e6).

1. **Complete key data required for master-password changes.** Password changes now reject incomplete or inconsistent authentication and unlock data, require the newly wrapped user key, and prevent KDF settings from being changed through the password-only endpoint. This avoids accepting a password update that could leave the account unable to decrypt its vault. Commit: [19de8d6](https://github.com/shuaiplus/nodewarden/commit/19de8d6e5769be463f973c8f2ec4de2e1530005c).

1. **Extended vault item imports preserve their data.** Web imports now correctly map bank accounts, driver's licenses, and passports instead of reducing item types 6-8 to incomplete generic drafts. Import summaries also report these item types by name. Commit: [e943357](https://github.com/shuaiplus/nodewarden/commit/e943357067236deeaa76ac0003020fa986abf2ab).

1. **Reliable bulk folder deletion.** Bulk folder deletion now calculates Cloudflare D1 bind limits correctly and batches the related cipher cleanup and folder removal statements safely, preventing large selections from failing or leaving partially updated folder references. Commit: [63b642b](https://github.com/shuaiplus/nodewarden/commit/63b642b2511207f435546802e197b6842f5c7aca).

1. **Fresh remote backup directory listings.** Opening a remote backup destination now automatically refreshes directory data when the saved cache is older than five minutes, so newly created backup files appear without requiring a manual refresh. Commit: [72d8ec9](https://github.com/shuaiplus/nodewarden/commit/72d8ec9cbadcb1b74d032deb5e5eea96e785d9c4).

---

### 新增

1. **Web Vault 显示开关。** Cloudflare Workers 部署现在可以设置 `HIDE_WEB_VAULT=1`，让服务器托管的 Web Vault 页面和静态资源统一返回 `404 Not Found`，同时继续提供 Bitwarden 客户端所需的登录、同步、附件、图标、通知和兼容接口。删除变量即可恢复 Web Vault，已经安装或缓存的 PWA 仍可继续使用本地前端。提交：[d990b2c](https://github.com/shuaiplus/nodewarden/commit/d990b2c71ff43a43f4598cad715b09c673e87b53)。

### 改进

1. **更简洁的桌面端和移动端导航。** Web Vault 现在统一使用分组侧边栏，并会保存各分组的展开状态；工具、设置和系统管理的层级更加清楚，移动端设置入口也同步调整。原有布局模式选择器已移除，常用功能更容易查找。提交：[e25ec15](https://github.com/shuaiplus/nodewarden/commit/e25ec159bb2cd07ec6b3a794032a8a2978340d3d)。

1. **更安全的 YubiKey 验证凭据管理。** Yubico 验证凭据现在通过统一且可防并发冲突的流程初始化；只有状态正常的管理员能够查看或替换服务器凭据，初始化和重新配置操作也会写入安全审计日志。普通用户仍可绑定 YubiKey，但无法接触服务器级凭据。提交：[573451c](https://github.com/shuaiplus/nodewarden/commit/573451c52f02978dee5ab8379ff86e59da805437)。

1. **兼容 Bitwarden 的个人 API Key 与更安全的备份。** 用户现在可以在验证主密码后查看个人 API Key，并在不撤销无关会话的情况下轮换密钥。旧版哈希密钥在用户主动轮换前仍可继续认证；新备份不再包含个人 API Key、运行中的认证状态或设备信任状态，旧备份仍能导入，但其中这类运行时状态会被主动忽略。提交：[299eda5](https://github.com/shuaiplus/nodewarden/commit/299eda597ff8a07bf0b7ddfb6e3a5e7f800096db)。

### 修复

1. **临时刷新失败导致意外退出登录。** 刷新会话现在根据客户端采用滑动有效期，并保留绝对最长时限；临时网络或服务故障不会再把已锁定的 Web Vault 直接变成完整登录页。Web Vault 会保留锁定会话并提供重试入口，同时兼容官方桌面端、移动端、浏览器扩展和 Web Cookie 会话。提交：[b731a01](https://github.com/shuaiplus/nodewarden/commit/b731a014f1d86552615110cdf543f809a5c6a7e6)。

1. **修改主密码时必须提交完整密钥数据。** 密码修改接口现在会拒绝不完整或不一致的认证与解锁数据，强制要求新的用户密钥包装结果，并禁止通过仅修改密码的接口顺带更改 KDF 设置，避免出现密码已更新但保险库无法解密的账户状态。提交：[19de8d6](https://github.com/shuaiplus/nodewarden/commit/19de8d6e5769be463f973c8f2ec4de2e1530005c)。

1. **扩展保险库条目导入时完整保留数据。** Web 导入现在会正确映射银行账户、驾驶证和护照，不再把类型 6-8 转换为字段缺失的通用草稿；导入结果摘要也会按名称显示这些条目类型。提交：[e943357](https://github.com/shuaiplus/nodewarden/commit/e943357067236deeaa76ac0003020fa986abf2ab)。

1. **可靠的批量文件夹删除。** 批量删除文件夹时现在会正确计算 Cloudflare D1 的绑定参数上限，并安全批处理密码条目引用清理和文件夹删除语句，避免大量选择时失败或留下只更新了一部分的文件夹引用。提交：[63b642b](https://github.com/shuaiplus/nodewarden/commit/63b642b2511207f435546802e197b6842f5c7aca)。

1. **远端备份目录自动显示最新文件。** 打开远端备份目标时，如果已保存的目录缓存超过五分钟，页面会自动获取最新数据，新生成的备份文件无需手动点击刷新即可出现。提交：[72d8ec9](https://github.com/shuaiplus/nodewarden/commit/72d8ec9cbadcb1b74d032deb5e5eea96e785d9c4)。

# v1.7.4 - Password Tools, Localization, and Security Hardening

### Added

1. **Built-in password generator.** The web vault now provides a dedicated generator for creating strong, configurable passwords, including memorable passphrases backed by the EFF word list. Generated values can be used while creating or editing vault items without leaving the app. Commits: [dfc9800](https://github.com/shuaiplus/nodewarden/commit/dfc98008cb58e9ed01b21ba158bb2584291462a3), [fb37679](https://github.com/shuaiplus/nodewarden/commit/fb376797d266003f8e23b64870f3638fde35d428).

1. **Password security dashboard.** A new password-security view scans the vault and reports weak, reused, exposed, and missing two-factor-authentication passwords, helping users prioritize account cleanup. Commit: [99b5027](https://github.com/shuaiplus/nodewarden/commit/99b50275a6a845e6ebbbae4d647350df939457f9).

1. **Duplicate-item selection tools.** Duplicate results are grouped by color and sorted alphabetically, and the vault now lets users select the unique items from a duplicate group for quicker review and cleanup. Commits: [0992170](https://github.com/shuaiplus/nodewarden/commit/099217062a4cb3a3caacce7513354bb388e8d76c), [39d9df7](https://github.com/shuaiplus/nodewarden/commit/39d9df78ea324fb2d1509221606408b1bb610118).

1. **Five additional interface languages.** Finnish, German, French, Italian, and Swedish are now available in the web vault, expanding the supported interface languages to ten. Commits: [dd90d7b](https://github.com/shuaiplus/nodewarden/commit/dd90d7b8b88a8a49ff1423bb36abb4eeb8f2f329), [9caa064](https://github.com/shuaiplus/nodewarden/commit/9caa0644888c25db835f8c5c93b8341ed80a42fe).

### Improved

1. **Passkey unlock and Bitwarden-client compatibility.** Account passkeys can now unlock the web vault directly, and supported FIDO2 origins, worker-routed fill-assist, Android asset-links checks, and web bootstrap paths are recognized more consistently. Commits: [8c65cb2](https://github.com/shuaiplus/nodewarden/commit/8c65cb2e80c6e5454fb53dbd7ea45cb83bf88ef7), [db31792](https://github.com/shuaiplus/nodewarden/commit/db31792cefc0f21fd543faf21407107a53b8dac2).

1. **Clearer offline and Send experiences.** The app now clearly indicates when it is operating offline, Send pages use improved date formatting, and closing dialogs retain their title through the animation to avoid a visual flash. Commits: [aae614a](https://github.com/shuaiplus/nodewarden/commit/aae614a079b5fa151e2bb98506f1b4fceac29072), [04cb475](https://github.com/shuaiplus/nodewarden/commit/04cb4759358b85029e3e32a5cab6ca39cbbef744), [525b773](https://github.com/shuaiplus/nodewarden/commit/525b773cf4799913ac24e34857348e3aa176608b).

1. **Simplified new-device sign-in.** New-device verification is no longer enforced, removing an extra login step for devices that are otherwise able to authenticate successfully. Commit: [14dff8e](https://github.com/shuaiplus/nodewarden/commit/14dff8ee6a59b741d86a42b25451116b120ac404).

### Fixed

1. **Backup destination SSRF protection.** Backup destination validation now rejects IPv6 loopback addresses, closing a path that could otherwise bypass loopback-host safeguards. Commit: [3c581d1](https://github.com/shuaiplus/nodewarden/commit/3c581d1fb1d92da9e00d3ff139c46f080462e6e8).

1. **Sensitive admin actions require the master password.** Administrative operations and device-wipe actions now require master-password confirmation, reducing the impact of an unattended or compromised web session. Commit: [fa611dc](https://github.com/shuaiplus/nodewarden/commit/fa611dc8430fc80744662feaaf3912341d5b63f2).

---

### 新增

1. **内置密码生成器。** Web 保险库现在提供专用的密码生成器，可创建高强度且可配置的密码，也支持基于 EFF 词表的易记口令短语。生成的值可直接用于新建或编辑保险库条目，无需离开应用。提交：[dfc9800](https://github.com/shuaiplus/nodewarden/commit/dfc98008cb58e9ed01b21ba158bb2584291462a3)、[fb37679](https://github.com/shuaiplus/nodewarden/commit/fb376797d266003f8e23b64870f3638fde35d428)。

1. **密码安全仪表板。** 新增的密码安全视图会扫描保险库，并报告弱密码、重复密码、已泄露密码和缺少双因素认证的密码，帮助用户优先处理需要清理的账户。提交：[99b5027](https://github.com/shuaiplus/nodewarden/commit/99b50275a6a845e6ebbbae4d647350df939457f9)。

1. **重复条目选择工具。** 重复项结果会按颜色分组并按字母顺序排序；保险库现在还可以从重复组中选择唯一条目，以便更快地审查和清理。提交：[0992170](https://github.com/shuaiplus/nodewarden/commit/099217062a4cb3a3caacce7513354bb388e8d76c)、[39d9df7](https://github.com/shuaiplus/nodewarden/commit/39d9df78ea324fb2d1509221606408b1bb610118)。

1. **新增五种界面语言。** Web 保险库现在提供芬兰语、德语、法语、意大利语和瑞典语，支持的界面语言扩展至十种。提交：[dd90d7b](https://github.com/shuaiplus/nodewarden/commit/dd90d7b8b88a8a49ff1423bb36abb4eeb8f2f329)、[9caa064](https://github.com/shuaiplus/nodewarden/commit/9caa0644888c25db835f8c5c93b8341ed80a42fe)。

### 改进

1. **通行密钥解锁和 Bitwarden 客户端兼容性。** 账户通行密钥现在可以直接解锁 Web 保险库；同时，对受支持 FIDO2 来源、Worker 路由的 fill-assist、Android asset-links 检查和 Web 启动路径的识别更加一致。提交：[8c65cb2](https://github.com/shuaiplus/nodewarden/commit/8c65cb2e80c6e5454fb53dbd7ea45cb83bf88ef7)、[db31792](https://github.com/shuaiplus/nodewarden/commit/db31792cefc0f21fd543faf21407107a53b8dac2)。

1. **更清晰的离线和 Send 使用体验。** 应用现在会明确提示离线运行状态，Send 页面采用了更好的日期格式，关闭对话框时会在动画期间保留标题，避免视觉闪烁。提交：[aae614a](https://github.com/shuaiplus/nodewarden/commit/aae614a079b5fa151e2bb98506f1b4fceac29072)、[04cb475](https://github.com/shuaiplus/nodewarden/commit/04cb4759358b85029e3e32a5cab6ca39cbbef744)、[525b773](https://github.com/shuaiplus/nodewarden/commit/525b773cf4799913ac24e34857348e3aa176608b)。

1. **简化新设备登录。** 不再强制执行新设备验证，能够正常完成身份验证的设备无需额外登录步骤。提交：[14dff8e](https://github.com/shuaiplus/nodewarden/commit/14dff8ee6a59b741d86a42b25451116b120ac404)。

### 修复

1. **备份目标的 SSRF 防护。** 备份目标校验现在会拒绝 IPv6 回环地址，堵住了可能绕过回环主机保护的路径。提交：[3c581d1](https://github.com/shuaiplus/nodewarden/commit/3c581d1fb1d92da9e00d3ff139c46f080462e6e8)。

1. **敏感管理员操作需要主密码。** 管理员操作和设备擦除操作现在需要确认主密码，降低无人值守或会话遭入侵时的影响。提交：[fa611dc](https://github.com/shuaiplus/nodewarden/commit/fa611dc8430fc80744662feaaf3912341d5b63f2)。

# v1.7.3 - Stronger Two-Step Login and Client Compatibility

### Added

1. **YubiKey OTP and passkey two-step login.** NodeWarden now supports YubiKey OTP as a managed two-factor provider and adds passkey-based two-factor authentication, including setup screens, WebAuthn fallback connector handling, multi-provider login prompts, and safer WebAuthn response normalization. Commits: [f63b745](https://github.com/shuaiplus/nodewarden/commit/f63b745), [c019c93](https://github.com/shuaiplus/nodewarden/commit/c019c93), [e73ae3d](https://github.com/shuaiplus/nodewarden/commit/e73ae3d), [d8cc88d](https://github.com/shuaiplus/nodewarden/commit/d8cc88d).

1. **Bitwarden extended vault item types.** Vault items now cover bank accounts, driver's licenses, and passports in addition to the existing login, card, identity, secure note, and SSH key flows. The web vault can create, display, decrypt, import, and export these item types with clearer sidebar icons. Commits: [109593d](https://github.com/shuaiplus/nodewarden/commit/109593d), [9de0d3b](https://github.com/shuaiplus/nodewarden/commit/9de0d3b).

1. **More Bitwarden client compatibility endpoints.** Added device verification settings, device registration routes, admin auth-request compatibility, fill-assist alignment, and push relay installation handling so more official Bitwarden client flows receive expected responses. Unsupported email verification and KDF routes now return explicit unsupported responses instead of ambiguous failures. Commits: [e376a84](https://github.com/shuaiplus/nodewarden/commit/e376a84), [8b2f98b](https://github.com/shuaiplus/nodewarden/commit/8b2f98b), [f0e5233](https://github.com/shuaiplus/nodewarden/commit/f0e5233), [56b301f](https://github.com/shuaiplus/nodewarden/commit/56b301f), [fd46dff](https://github.com/shuaiplus/nodewarden/commit/fd46dff), [cde4555](https://github.com/shuaiplus/nodewarden/commit/cde4555).

### Improved

1. **TOTP QR scanning and Bitwarden-compatible TOTP behavior.** Uploading TOTP QR codes now falls back to `jsQR` when browser `BarcodeDetector` support is incomplete, handles transparent PNGs correctly, validates uploaded QR images, and throttles camera fallback decoding to reduce CPU usage. TOTP storage and decryption behavior is also aligned more closely with Bitwarden clients. Commits: [b0a679b](https://github.com/shuaiplus/nodewarden/commit/b0a679b), [d024798](https://github.com/shuaiplus/nodewarden/commit/d024798), [73bbe8b](https://github.com/shuaiplus/nodewarden/commit/73bbe8b), [6e72220](https://github.com/shuaiplus/nodewarden/commit/6e72220), [8a5b210](https://github.com/shuaiplus/nodewarden/commit/8a5b210).

1. **Settings, device management, and localization polish.** Device management now lives inside Settings with updated navigation, the two-step provider UI is more responsive, and new settings, audit-log, and validation messages are localized across supported languages. This makes the security settings area easier to scan on desktop and mobile. Commits: [c7eb6c6](https://github.com/shuaiplus/nodewarden/commit/c7eb6c6), [062c966](https://github.com/shuaiplus/nodewarden/commit/062c966), [12af18e](https://github.com/shuaiplus/nodewarden/commit/12af18e), [c53d71f](https://github.com/shuaiplus/nodewarden/commit/c53d71f), [01ff627](https://github.com/shuaiplus/nodewarden/commit/01ff627).

1. **Encrypted Send password visibility and editing.** Password-protected Sends now show a lock indicator in the list, display masked password dots when editing an existing protected Send, and provide a compact trash-icon control for removing the stored password. This makes password state visible without exposing the password itself. Commits: [a870142](https://github.com/shuaiplus/nodewarden/commit/a870142), [ebc8e8e](https://github.com/shuaiplus/nodewarden/commit/ebc8e8e).

1. **Website icon behavior and workflow maintenance.** Website icons are now always available without the old `WEBSITE_ICONS_ENABLED` environment toggle, while icon requests keep privacy protections. The global-domains sync workflow also validates its ref before running. Commits: [57c5ef9](https://github.com/shuaiplus/nodewarden/commit/57c5ef9), [c643874](https://github.com/shuaiplus/nodewarden/commit/c643874), [680e287](https://github.com/shuaiplus/nodewarden/commit/680e287).

### Fixed

1. **Authentication, token, and rate-limit hardening.** API keys are stored as hashes, password rotation and JWT handling were tightened, user cache invalidates on token handling, remembered 2FA tokens survive a bad password attempt, the current access-token session is revoked correctly, and known rate-limit reset bypasses were closed. Commits: [1545881](https://github.com/shuaiplus/nodewarden/commit/1545881), [439683d](https://github.com/shuaiplus/nodewarden/commit/439683d), [60dd298](https://github.com/shuaiplus/nodewarden/commit/60dd298), [d9a36fe](https://github.com/shuaiplus/nodewarden/commit/d9a36fe), [1bad32f](https://github.com/shuaiplus/nodewarden/commit/1bad32f), [2df43cc](https://github.com/shuaiplus/nodewarden/commit/2df43cc), [ae168be](https://github.com/shuaiplus/nodewarden/commit/ae168be).

1. **User data isolation and request validation.** Storage reads are scoped by user, Send file routes gate access more strictly, anonymous notification hub requests are validated, and multipart backup/upload requests now have caps. This reduces the chance of cross-user data reads or oversized requests reaching deeper handlers. Commits: [baf5699](https://github.com/shuaiplus/nodewarden/commit/baf5699), [8c481a1](https://github.com/shuaiplus/nodewarden/commit/8c481a1), [23c53bd](https://github.com/shuaiplus/nodewarden/commit/23c53bd), [5142846](https://github.com/shuaiplus/nodewarden/commit/5142846).

1. **Backup, restore, and download safety.** Remote backup deletes are verified, archives and backup blobs are validated before use, destination secrets are redacted from settings responses, backup/download token flows are harder to misuse, and WebAuthn credential purpose survives backup export/import. A backup uploader redirect guard was also reverted to restore compatible remote behavior. Commits: [0cef6a0](https://github.com/shuaiplus/nodewarden/commit/0cef6a0), [00e0ec0](https://github.com/shuaiplus/nodewarden/commit/00e0ec0), [5c8f01b](https://github.com/shuaiplus/nodewarden/commit/5c8f01b), [cc4a830](https://github.com/shuaiplus/nodewarden/commit/cc4a830), [f532d3a](https://github.com/shuaiplus/nodewarden/commit/f532d3a), [a366acb](https://github.com/shuaiplus/nodewarden/commit/a366acb).

1. **Import compatibility and encrypted-field validation.** Imports now validate payload structure and ZIP entries before processing, and plaintext FIDO2 credential, SSH key, and password-history fields are rejected instead of being silently accepted and later dropped. This makes failed imports clearer and protects encrypted vault fields from incompatible plaintext data. Commits: [cf14704](https://github.com/shuaiplus/nodewarden/commit/cf14704), [1ec6ed4](https://github.com/shuaiplus/nodewarden/commit/1ec6ed4).

1. **Admin, audit, WebAuthn, and backup endpoint edge cases.** Admin audit-clears are recorded, passkey 2FA status is reported correctly, WebAuthn extension origins are constrained, and auth-request plus backup endpoint checks were tightened around sensitive flows. Commits: [d028b19](https://github.com/shuaiplus/nodewarden/commit/d028b19), [ace00e8](https://github.com/shuaiplus/nodewarden/commit/ace00e8), [7ac6ae5](https://github.com/shuaiplus/nodewarden/commit/7ac6ae5).

---

### 新增

1. **YubiKey OTP 和通行密钥两步登录。** NodeWarden 现在支持将 YubiKey OTP 作为可管理的双因素提供商，并新增基于通行密钥的双因素认证，包含设置界面、WebAuthn 备用连接器处理、多提供商登录提示，以及更安全的 WebAuthn 响应规范化。提交：[f63b745](https://github.com/shuaiplus/nodewarden/commit/f63b745)、[c019c93](https://github.com/shuaiplus/nodewarden/commit/c019c93)、[e73ae3d](https://github.com/shuaiplus/nodewarden/commit/e73ae3d)、[d8cc88d](https://github.com/shuaiplus/nodewarden/commit/d8cc88d)。

1. **Bitwarden 扩展保险库条目类型。** 除现有登录、银行卡、身份、安全笔记和 SSH 密钥流程外，保险库条目现在还覆盖银行账户、驾驶证和护照。Web 保险库可以创建、展示、解密、导入和导出这些条目类型，并提供更清晰的侧边栏图标。提交：[109593d](https://github.com/shuaiplus/nodewarden/commit/109593d)、[9de0d3b](https://github.com/shuaiplus/nodewarden/commit/9de0d3b)。

1. **更多 Bitwarden 客户端兼容端点。** 新增设备验证设置、设备注册路由、管理员认证请求兼容、fill-assist 对齐和推送中继安装处理，让更多官方 Bitwarden 客户端流程能获得预期响应。不支持的邮箱验证和 KDF 路由现在会返回明确的不支持响应，而不是含糊失败。提交：[e376a84](https://github.com/shuaiplus/nodewarden/commit/e376a84)、[8b2f98b](https://github.com/shuaiplus/nodewarden/commit/8b2f98b)、[f0e5233](https://github.com/shuaiplus/nodewarden/commit/f0e5233)、[56b301f](https://github.com/shuaiplus/nodewarden/commit/56b301f)、[fd46dff](https://github.com/shuaiplus/nodewarden/commit/fd46dff)、[cde4555](https://github.com/shuaiplus/nodewarden/commit/cde4555)。

### 改进

1. **TOTP 二维码扫描和 Bitwarden 兼容 TOTP 行为。** 上传 TOTP 二维码时，如果浏览器 `BarcodeDetector` 支持不完整，现在会回退到 `jsQR`，并正确处理透明 PNG、校验上传的二维码图片、限制摄像头回退解码频率以降低 CPU 占用。TOTP 的存储和解密行为也更贴近 Bitwarden 客户端。提交：[b0a679b](https://github.com/shuaiplus/nodewarden/commit/b0a679b)、[d024798](https://github.com/shuaiplus/nodewarden/commit/d024798)、[73bbe8b](https://github.com/shuaiplus/nodewarden/commit/73bbe8b)、[6e72220](https://github.com/shuaiplus/nodewarden/commit/6e72220)、[8a5b210](https://github.com/shuaiplus/nodewarden/commit/8a5b210)。

1. **设置、设备管理和本地化打磨。** 设备管理现在整合进设置页并更新了导航，两步验证提供商界面在响应式布局下更顺手，新的设置、审计日志和校验消息也补齐了受支持语言的本地化。安全设置区域在桌面和移动端都更容易浏览。提交：[c7eb6c6](https://github.com/shuaiplus/nodewarden/commit/c7eb6c6)、[062c966](https://github.com/shuaiplus/nodewarden/commit/062c966)、[12af18e](https://github.com/shuaiplus/nodewarden/commit/12af18e)、[c53d71f](https://github.com/shuaiplus/nodewarden/commit/c53d71f)、[01ff627](https://github.com/shuaiplus/nodewarden/commit/01ff627)。

1. **加密 Send 的密码状态展示与编辑。** 受密码保护的 Send 现在会在列表中显示锁定标记，编辑已有受保护 Send 时会显示密码掩码圆点，并提供紧凑的垃圾桶图标用于移除已保存密码。这样可以看清密码状态，同时不暴露密码本身。提交：[a870142](https://github.com/shuaiplus/nodewarden/commit/a870142)、[ebc8e8e](https://github.com/shuaiplus/nodewarden/commit/ebc8e8e)。

1. **网站图标行为和工作流维护。** 网站图标现在无需旧的 `WEBSITE_ICONS_ENABLED` 环境开关即可始终可用，同时图标请求仍保留隐私保护。global-domains 同步工作流也会在运行前校验引用。提交：[57c5ef9](https://github.com/shuaiplus/nodewarden/commit/57c5ef9)、[c643874](https://github.com/shuaiplus/nodewarden/commit/c643874)、[680e287](https://github.com/shuaiplus/nodewarden/commit/680e287)。

### 修复

1. **认证、令牌和速率限制加固。** API key 现在以哈希形式存储，密码轮换和 JWT 处理更严格，令牌处理时会使用户缓存失效，错误密码不会丢失已记住的 2FA token，当前访问令牌会被正确撤销，并关闭了已知的速率限制重置绕过路径。提交：[1545881](https://github.com/shuaiplus/nodewarden/commit/1545881)、[439683d](https://github.com/shuaiplus/nodewarden/commit/439683d)、[60dd298](https://github.com/shuaiplus/nodewarden/commit/60dd298)、[d9a36fe](https://github.com/shuaiplus/nodewarden/commit/d9a36fe)、[1bad32f](https://github.com/shuaiplus/nodewarden/commit/1bad32f)、[2df43cc](https://github.com/shuaiplus/nodewarden/commit/2df43cc)、[ae168be](https://github.com/shuaiplus/nodewarden/commit/ae168be)。

1. **用户数据隔离和请求校验。** 存储读取现在按用户限定范围，Send 文件路由更严格地拦截访问，匿名通知 hub 请求会被校验，并且多段备份/上传请求增加了上限。这降低了跨用户数据读取或超大请求进入深层处理器的风险。提交：[baf5699](https://github.com/shuaiplus/nodewarden/commit/baf5699)、[8c481a1](https://github.com/shuaiplus/nodewarden/commit/8c481a1)、[23c53bd](https://github.com/shuaiplus/nodewarden/commit/23c53bd)、[5142846](https://github.com/shuaiplus/nodewarden/commit/5142846)。

1. **备份、恢复和下载安全性。** 远端备份删除现在会被验证，归档和备份 blob 使用前会校验，目标配置里的密钥会在设置响应中脱敏，备份/下载令牌流程更难被误用，WebAuthn 凭据用途也会在备份导出/导入中保留。备份上传器的重定向防护也已回退，以恢复兼容的远端行为。提交：[0cef6a0](https://github.com/shuaiplus/nodewarden/commit/0cef6a0)、[00e0ec0](https://github.com/shuaiplus/nodewarden/commit/00e0ec0)、[5c8f01b](https://github.com/shuaiplus/nodewarden/commit/5c8f01b)、[cc4a830](https://github.com/shuaiplus/nodewarden/commit/cc4a830)、[f532d3a](https://github.com/shuaiplus/nodewarden/commit/f532d3a)、[a366acb](https://github.com/shuaiplus/nodewarden/commit/a366acb)。

1. **导入兼容性和加密字段校验。** 导入流程现在会在处理前校验 payload 结构和 ZIP 条目，明文 FIDO2 凭据、SSH 密钥和密码历史字段会被拒绝，而不是先被静默接受再在响应时丢弃。这让失败导入更清楚，也保护加密保险库字段不接收不兼容的明文数据。提交：[cf14704](https://github.com/shuaiplus/nodewarden/commit/cf14704)、[1ec6ed4](https://github.com/shuaiplus/nodewarden/commit/1ec6ed4)。

1. **管理员、审计、WebAuthn 和备份端点边界情况。** 管理员清空审计日志会被记录，通行密钥 2FA 状态会正确上报，WebAuthn 扩展来源会受到限制，并且认证请求与备份端点围绕敏感流程的校验也更严格。提交：[d028b19](https://github.com/shuaiplus/nodewarden/commit/d028b19)、[ace00e8](https://github.com/shuaiplus/nodewarden/commit/ace00e8)、[7ac6ae5](https://github.com/shuaiplus/nodewarden/commit/7ac6ae5)。

---

# v1.7.2 - New Backup Providers, WebAuthn PRF, and UI Polish

### Added

1. **Three new S3-compatible backup providers: Backblaze B2, Cloudflare R2, and Tigris.** Each new destination comes with detailed provider-specific recommendations, storage-class guidance, and localization strings across all five supported languages. You can now back up to more services without custom scripting. Commits: [1acc31e](https://github.com/shuaiplus/nodewarden/commit/1acc31e), [c3dc53b](https://github.com/shuaiplus/nodewarden/commit/c3dc53b), [ff85698](https://github.com/shuaiplus/nodewarden/commit/ff85698).

2. **WebAuthn PRF (pseudorandom function) extension support.** Credential creation and assertion now pass browser-compatible PRF extension requests, support excluding PRF extensions where the client doesn't need them, and handle the underlying passkey operations more robustly. This improves WebAuthn compatibility with modern browsers and password managers that rely on PRF for per-credential keys. Commits: [8942e5b](https://github.com/shuaiplus/nodewarden/commit/8942e5b), [31cfd19](https://github.com/shuaiplus/nodewarden/commit/31cfd19), [6a1a835](https://github.com/shuaiplus/nodewarden/commit/6a1a835), [bf6ac7b](https://github.com/shuaiplus/nodewarden/commit/bf6ac7b).

3. **Backup import locking and checksum verification.** Restoring a full backup now acquires an exclusive lock so concurrent imports cannot collide, and the importer verifies file checksums before applying the data. This makes disaster recovery safer when multiple admins might trigger restores. Commit: [e9272ec](https://github.com/shuaiplus/nodewarden/commit/e9272ec).

4. **Fullscreen layout toggle.** The web vault can now switch to fullscreen mode with a dedicated toggle button, with corresponding localization updates. Useful for kiosk-mode or presentation setups. Commit: [d722815](https://github.com/shuaiplus/nodewarden/commit/d722815).

5. **Fill-assist API handlers.** NodeWarden now implements Bitwarden-compatible credential fill-assist endpoints, letting clients fetch credentials inline via the new `POST /fill-assist` route. Device response types are also updated to include the fields needed by the fill-assist flow. Commit: [e4215b4](https://github.com/shuaiplus/nodewarden/commit/e4215b4).

6. **Device selection and removal in SecurityDevicesPage.** The security devices panel now supports selecting individual trusted devices and removing them directly from the web UI, so you no longer need to use the API to revoke a specific device. Commit: [a5ad16a](https://github.com/shuaiplus/nodewarden/commit/a5ad16a).

7. **Delete invalid organization invitations.** Admins can now detect and remove dangling or invalid invitations from the admin panel, helping keep the invitation list clean. The API also renamed `revokeInvite` to `deleteInvite` for clearer semantics. Commits: [0d1bb19](https://github.com/shuaiplus/nodewarden/commit/0d1bb19), [f82dcc3](https://github.com/shuaiplus/nodewarden/commit/f82dcc3).

8. **validFolderIds support in cipher responses.** Sync and cipher responses now include a `validFolderIds` field so clients can distinguish real folders from orphaned references. The folder repository also validates folder existence more strictly. Commit: [82f968e](https://github.com/shuaiplus/nodewarden/commit/82f968e).

9. **Pending auth request loading state.** The pending login-request panel shows a refreshing indicator while fetching or updating the request list, providing clearer feedback during auth request workflows. Commit: [4378e1b](https://github.com/shuaiplus/nodewarden/commit/4378e1b).

### Improved

1. **Enhanced Bitwarden CSV import with custom field and multiline support.** The CSV parser now recognizes custom fields and restores their metadata correctly during import. It also preserves multiline values such as SSH private keys—previously, any line without a `: ` delimiter was silently dropped, truncating private keys to the first line. Text fields containing newlines now survive a full export-import round-trip. Commits: [5eeaf4e](https://github.com/shuaiplus/nodewarden/commit/5eeaf4e), [68c42a0](https://github.com/shuaiplus/nodewarden/commit/68c42a0).

2. **Consolidated security devices UI.** Device management and authorized devices sections are merged into a single coherent card on SecurityDevicesPage, and the pending-auth-requests panel has been removed from the general SettingsPage to reduce clutter. The device list also includes improved selection controls. Commit: [c694f1b](https://github.com/shuaiplus/nodewarden/commit/c694f1b).

3. **Refined app-shell styles and dark mode consistency.** Removed redundant global styles, cleaned up shell component spacing, and improved dark-mode visual consistency across the header, sidebar, and main content areas. Commit: [1bfb9a6](https://github.com/shuaiplus/nodewarden/commit/1bfb9a6).

4. **Backup and restore error messages across all locales.** New error strings for backup/restore edge cases—lock failures, checksum mismatches, missing files—are now localized in all five supported languages (en, es, ru, zh-CN, zh-TW), with improved UI prompts for backup browser refresh scenarios. Commit: [4cd9ad0](https://github.com/shuaiplus/nodewarden/commit/4cd9ad0).

5. **Updated project wiki link and removed obsolete security scripts.** The issue-template wiki link now points to the correct URL, and the old local security scanning scripts and workflows have been removed in favor of GitHub-native security automation (CodeQL, security-extra workflows). Commit: [e31f82c](https://github.com/shuaiplus/nodewarden/commit/e31f82c).

6. **Security automation and dependency hardening.** Added GitHub-native CodeQL and security-extra workflows, overrode a `ws` vulnerability, and upgraded CI actions to pinned major versions (checkout v7, setup-node v6, create-pull-request v8). Dependencies refreshed include TypeScript 6.0, `@types/node` 26, `lucide-preact` 1.x, and many others across npm and GitHub Actions. Commits: [64f26e7](https://github.com/shuaiplus/nodewarden/commit/64f26e7), [32b3d2a](https://github.com/shuaiplus/nodewarden/commit/32b3d2a), [5dd9dff](https://github.com/shuaiplus/nodewarden/commit/5dd9dff), [8d292ca](https://github.com/shuaiplus/nodewarden/commit/8d292ca), [5bd7dab](https://github.com/shuaiplus/nodewarden/commit/5bd7dab), [99f2d7f](https://github.com/shuaiplus/nodewarden/commit/99f2d7f), [fb9a2ae](https://github.com/shuaiplus/nodewarden/commit/fb9a2ae), [c87e6ac](https://github.com/shuaiplus/nodewarden/commit/c87e6ac).

### Fixed

1. **CSV import truncating multiline field values.** `parseBitwardenCsvFieldLines` previously discarded any line that did not contain a `: ` delimiter, silently dropping SSH private keys and other multiline content to only the first line. The parser now accumulates continuation lines correctly, restoring full private key content through a CSV round-trip. Commit: [68c42a0](https://github.com/shuaiplus/nodewarden/commit/68c42a0).

---

### 新增

1. **三个新的 S3 兼容备份提供商：Backblaze B2、Cloudflare R2 和 Tigris。** 每个新目标都带有详细的提供商建议、存储层级指导和五种语言的本地化字符串，无需额外脚本即可将备份扩展到更多存储服务。提交：[1acc31e](https://github.com/shuaiplus/nodewarden/commit/1acc31e)、[c3dc53b](https://github.com/shuaiplus/nodewarden/commit/c3dc53b)、[ff85698](https://github.com/shuaiplus/nodewarden/commit/ff85698)。

2. **WebAuthn PRF（伪随机函数）扩展支持。** 创建和断言凭证时会传递浏览器兼容的 PRF 扩展请求，支持在不需要时排除 PRF 扩展，并且底层密钥操作更健壮。这改善了与依赖 PRF 做每凭据密钥派生功能的现代浏览器和密码管理器的兼容性。提交：[8942e5b](https://github.com/shuaiplus/nodewarden/commit/8942e5b)、[31cfd19](https://github.com/shuaiplus/nodewarden/commit/31cfd19)、[6a1a835](https://github.com/shuaiplus/nodewarden/commit/6a1a835)、[bf6ac7b](https://github.com/shuaiplus/nodewarden/commit/bf6ac7b)。

3. **备份导入加锁和校验和验证。** 完整恢复备份时现在会获取独占锁，防止并发导入冲突；导入前还会验证文件校验和再应用数据。多管理员可能同时触发恢复时，该机制让灾难恢复更加安全。提交：[e9272ec](https://github.com/shuaiplus/nodewarden/commit/e9272ec)。

4. **全屏布局切换。** Web 保险库现在可以通过专用按钮切换全屏模式，附带对应本地化更新。适合信息亭模式或展示等场景。提交：[d722815](https://github.com/shuaiplus/nodewarden/commit/d722815)。

5. **Fill-assist API 处理器。** NodeWarden 现在实现了与 Bitwarden 兼容的凭据填充辅助端点，客户端可以通过新的 `POST /fill-assist` 路由内联获取凭据。设备响应类型也补上了 fill-assist 流程需要的字段。提交：[e4215b4](https://github.com/shuaiplus/nodewarden/commit/e4215b4)。

6. **安全设备页的设备选择与删除。** 设备面板现在支持在 Web UI 中直接选择单个可信设备并移除，无需通过 API 手动撤销指定设备。提交：[a5ad16a](https://github.com/shuaiplus/nodewarden/commit/a5ad16a)。

7. **删除无效邀请码。** 管理员现在可以在管理面板中检测并删除悬空或无效的邀请，保持邀请列表整洁。API 也将 `revokeInvite` 改名为 `deleteInvite`，语义更清晰。提交：[0d1bb19](https://github.com/shuaiplus/nodewarden/commit/0d1bb19)、[f82dcc3](https://github.com/shuaiplus/nodewarden/commit/f82dcc3)。

8. **密码条目响应增加 validFolderIds。** 同步和密码条目响应现在包含 `validFolderIds` 字段，方便客户端区分真实文件夹和孤立引用；文件夹存储也加强了对文件夹存在性的校验。提交：[82f968e](https://github.com/shuaiplus/nodewarden/commit/82f968e)。

9. **待处理认证请求的加载状态。** 待处理的登录请求面板现在会在获取或更新请求列表时显示刷新指示器，为认证请求操作提供更清晰的反馈。提交：[4378e1b](https://github.com/shuaiplus/nodewarden/commit/4378e1b)。

### 改进

1. **增强的 Bitwarden CSV 导入——自定义字段和多行支持。** CSV 解析器现在可以识别自定义字段并在导入时正确恢复其元数据。同时保留了 SSH 私钥等多行值——之前任何不带 `: ` 分隔符的行都会被丢弃，导致私钥只保留第一行。包含换行符的文本字段现在可以完整通过导出-导入周期。提交：[5eeaf4e](https://github.com/shuaiplus/nodewarden/commit/5eeaf4e)、[68c42a0](https://github.com/shuaiplus/nodewarden/commit/68c42a0)。

2. **整合安全设备界面。** 设备管理和已授权设备两个部分合并为 SecurityDevicesPage 上的一个统一卡片；待处理认证请求面板从 SettingsPage 中移除以减少杂乱。设备列表也改进了选择操作。提交：[c694f1b](https://github.com/shuaiplus/nodewarden/commit/c694f1b)。

3. **精简应用外壳样式与暗色模式一致性。** 移除了冗余全局样式，清理了外壳组件间距，改善了头部、侧边栏和主内容区在暗色模式下的视觉一致性。提交：[1bfb9a6](https://github.com/shuaiplus/nodewarden/commit/1bfb9a6)。

4. **备份/恢复错误消息全语言本地化。** 备份/恢复边界场景（加锁失败、校验和不匹配、文件缺失）的新错误字符串已在五种支持语言（en、es、ru、zh-CN、zh-TW）中完成本地化，同时改进了备份浏览器刷新场景下的界面提示。提交：[4cd9ad0](https://github.com/shuaiplus/nodewarden/commit/4cd9ad0)。

5. **更新项目 Wiki 链接并移除过时安全脚本。** 议题模板中的 Wiki 链接已指向正确 URL；老旧的本地安全扫描脚本和工作流已移除，改用 GitHub 原生安全自动化（CodeQL、security-extra 工作流）。提交：[e31f82c](https://github.com/shuaiplus/nodewarden/commit/e31f82c)。

6. **安全自动化和依赖加固。** 新增 GitHub 原生 CodeQL 和 security-extra 工作流；覆盖了 `ws` 的已知漏洞；将 CI Action 升级到钉死的主要版本（checkout v7、setup-node v6、create-pull-request v8）。依赖升级包括 TypeScript 6.0、`@types/node` 26、`lucide-preact` 1.x，以及 npm 和 GitHub Actions 的多项更新。提交：[64f26e7](https://github.com/shuaiplus/nodewarden/commit/64f26e7)、[32b3d2a](https://github.com/shuaiplus/nodewarden/commit/32b3d2a)、[5dd9dff](https://github.com/shuaiplus/nodewarden/commit/5dd9dff)、[8d292ca](https://github.com/shuaiplus/nodewarden/commit/8d292ca)、[5bd7dab](https://github.com/shuaiplus/nodewarden/commit/5bd7dab)、[99f2d7f](https://github.com/shuaiplus/nodewarden/commit/99f2d7f)、[fb9a2ae](https://github.com/shuaiplus/nodewarden/commit/fb9a2ae)、[c87e6ac](https://github.com/shuaiplus/nodewarden/commit/c87e6ac)。

### 修复

1. **CSV 导入截断多行字段值。** `parseBitwardenCsvFieldLines` 之前会丢弃任何不包含 `: ` 分隔符的行，导致 SSH 私钥等多行内容被静默截断为仅第一行。解析器现已正确累积后续行，使私钥等完整内容能够通过 CSV 导出-导入周期完好保留。提交：[68c42a0](https://github.com/shuaiplus/nodewarden/commit/68c42a0)。

# v1.7.1 - Security Hardening Update

Thanks to GN998 for responsibly reporting security issues addressed in this release.

### Added

1. **No new user-facing features.** This patch release intentionally focuses on security fixes and defensive hardening rather than new product functionality. Commits: [7279668](https://github.com/shuaiplus/nodewarden/commit/7279668), [850fe0f](https://github.com/shuaiplus/nodewarden/commit/850fe0f), [a2a8f1c](https://github.com/shuaiplus/nodewarden/commit/a2a8f1c), [23b23f3](https://github.com/shuaiplus/nodewarden/commit/23b23f3).

### Improved

1. **Stronger security defaults.** NodeWarden now applies more conservative handling around sensitive authentication, backup, and file-delivery flows while keeping existing clients compatible. Upgrade is recommended for all deployments. Commits: [7279668](https://github.com/shuaiplus/nodewarden/commit/7279668), [850fe0f](https://github.com/shuaiplus/nodewarden/commit/850fe0f), [a2a8f1c](https://github.com/shuaiplus/nodewarden/commit/a2a8f1c), [23b23f3](https://github.com/shuaiplus/nodewarden/commit/23b23f3).

### Fixed

1. **High-priority security fixes.** This release closes multiple reported security issues across sensitive server-side flows and response hardening without exposing operational details in the public notes. Commits: [7279668](https://github.com/shuaiplus/nodewarden/commit/7279668), [850fe0f](https://github.com/shuaiplus/nodewarden/commit/850fe0f), [a2a8f1c](https://github.com/shuaiplus/nodewarden/commit/a2a8f1c), [23b23f3](https://github.com/shuaiplus/nodewarden/commit/23b23f3).

2. **Security dependency overrides.** Package overrides were added for selected transitive dependencies so installs resolve to patched versions where applicable. Commit: [0daad46](https://github.com/shuaiplus/nodewarden/commit/0daad46).

---

### 新增

感谢 GN998 负责任地报告了本次发布中修复的安全问题。

1. **没有新增面向用户的功能。** 本次补丁发布刻意专注于安全修复和防护加固，不包含新的产品功能。提交：[7279668](https://github.com/shuaiplus/nodewarden/commit/7279668)、[850fe0f](https://github.com/shuaiplus/nodewarden/commit/850fe0f)、[a2a8f1c](https://github.com/shuaiplus/nodewarden/commit/a2a8f1c)、[23b23f3](https://github.com/shuaiplus/nodewarden/commit/23b23f3)。

### 改进

1. **更稳妥的安全默认行为。** NodeWarden 对敏感认证、备份和文件响应流程采用了更保守的处理方式，同时保持现有客户端兼容。建议所有部署尽快升级。提交：[7279668](https://github.com/shuaiplus/nodewarden/commit/7279668)、[850fe0f](https://github.com/shuaiplus/nodewarden/commit/850fe0f)、[a2a8f1c](https://github.com/shuaiplus/nodewarden/commit/a2a8f1c)、[23b23f3](https://github.com/shuaiplus/nodewarden/commit/23b23f3)。

### 修复

1. **高优先级安全修复。** 本次发布修复了多项已报告的安全问题，覆盖敏感服务端流程和响应加固；公开说明中不会展开可操作的攻击细节。提交：[7279668](https://github.com/shuaiplus/nodewarden/commit/7279668)、[850fe0f](https://github.com/shuaiplus/nodewarden/commit/850fe0f)、[a2a8f1c](https://github.com/shuaiplus/nodewarden/commit/a2a8f1c)、[23b23f3](https://github.com/shuaiplus/nodewarden/commit/23b23f3)。

2. **安全依赖覆盖。** 为部分传递依赖添加了版本覆盖，让安装时尽可能解析到已修复版本。提交：[0daad46](https://github.com/shuaiplus/nodewarden/commit/0daad46)。

# v1.7.0 - Faster Multi-Device Sync, Mobile Push, and a Smoother Vault


### Added

1. **Resource-level realtime sync.** NodeWarden now sends Bitwarden-style notifications for cipher, folder, and Send create, update, and delete events. The web app can refresh only the affected resource instead of reloading the full vault every time, and state-changing operations such as attachment uploads, attachment deletes, public Send access counts, and Send file downloads also emit the right updates. Commits: [fe0c66c](https://github.com/shuaiplus/nodewarden/commit/fe0c66c), [42b765b](https://github.com/shuaiplus/nodewarden/commit/42b765b), [045b23f](https://github.com/shuaiplus/nodewarden/commit/045b23f), [46ba8b9](https://github.com/shuaiplus/nodewarden/commit/46ba8b9), [f096681](https://github.com/shuaiplus/nodewarden/commit/f096681).

2. **Bitwarden mobile push relay support.** Devices can now store `push_uuid` and `push_token`, register or unregister through the Bitwarden push relay, and receive mobile push notifications when vault resources change. The database schema includes the new push fields and indexes needed to detect push-capable devices. Commit: [79ed7c9](https://github.com/shuaiplus/nodewarden/commit/79ed7c9).

3. **Bitwarden CSV export.** The web app can now export a Bitwarden-compatible CSV file alongside the existing JSON, encrypted JSON, and attachment ZIP formats. Multiple login URIs are serialized safely, and non-login item types such as cards, identities, and SSH keys are preserved as clearly as possible in field text. Commits: [b024226](https://github.com/shuaiplus/nodewarden/commit/b024226), [a06cb0e](https://github.com/shuaiplus/nodewarden/commit/a06cb0e).

4. **More duplicate detection modes.** Duplicate search can now compare exact item content, login site plus credentials, username plus password, or password alone. Duplicate groups are color-coded, and the mobile vault UI includes the new duplicate mode selector and improved filter controls. Commits: [7b3be2c](https://github.com/shuaiplus/nodewarden/commit/7b3be2c), [b444c0f](https://github.com/shuaiplus/nodewarden/commit/b444c0f).

5. **S3 addressing style selection.** Backup destinations can now choose between path-style and virtual-hosted-style S3 URLs, improving compatibility with more S3-compatible providers and self-hosted object storage. Commit: [a818316](https://github.com/shuaiplus/nodewarden/commit/a818316).

### Improved

1. **Web vault updates feel immediate.** Creating, editing, deleting, archiving, restoring, and moving items; creating or deleting folders; and creating, updating, or deleting Sends now update the local encrypted snapshot, decrypted lists, and revision timestamp directly. This reduces visible lag after successful actions and makes cached vault validation work better with resource-level sync. Commits: [42b765b](https://github.com/shuaiplus/nodewarden/commit/42b765b), [045b23f](https://github.com/shuaiplus/nodewarden/commit/045b23f).

2. **Better Bitwarden client compatibility.** Profile and sync responses now include fields such as `organizationsNew`, `policiesNew`, and `V2UpgradeToken`; `/api/accounts/keys` supports GET; password change and password verification accept newer `authenticationData` and `unlockData` request shapes; and device routes work with both `/api/devices` and `/devices`. Cipher responses also preserve stored `edit`, `viewPassword`, and `permissions` flags instead of resetting them. Commits: [add921b](https://github.com/shuaiplus/nodewarden/commit/add921b), [f9fe532](https://github.com/shuaiplus/nodewarden/commit/f9fe532).

3. **Cleaner mobile and narrow-screen UI.** Topbar controls, network status, theme switching, and lock buttons now share more consistent sizing and styling. The vault list search, sorting, filtering, create button, and bulk selection toolbar are more compact on mobile, and mobile filter menus can switch between all items, favorites, archive, trash, duplicates, types, and folders. Commits: [7e0406f](https://github.com/shuaiplus/nodewarden/commit/7e0406f), [16bde22](https://github.com/shuaiplus/nodewarden/commit/16bde22), [cd2ec82](https://github.com/shuaiplus/nodewarden/commit/cd2ec82), [c1f5795](https://github.com/shuaiplus/nodewarden/commit/c1f5795).

4. **More tolerant TOTP handling.** TOTP codes are grouped more naturally for 5-digit, 6-digit, 8-digit, and other lengths, and the TOTP list no longer overflows narrow screens because of fixed column widths. `otpauth://` parsing is also more tolerant of unusual parameter encoding, with more stable Steam-code detection. Commits: [9e0908f](https://github.com/shuaiplus/nodewarden/commit/9e0908f), [d5c2ab2](https://github.com/shuaiplus/nodewarden/commit/d5c2ab2).

5. **Less jumpy network status.** The web app no longer switches offline after one short failed probe. It uses a longer timeout, waits for repeated failures, and lets normal API successes or failures update the network state, reducing false offline unlock fallbacks when the service is reachable but slow. Commit: [b4dfb04](https://github.com/shuaiplus/nodewarden/commit/b4dfb04).

6. **More complete backups.** Full instance backups now include trusted two-factor device tokens and restore them during import. The importer validates token ownership, device identifiers, expiration times, and duplicates, so remembered two-factor devices can survive a full migration. Commit: [f6169b7](https://github.com/shuaiplus/nodewarden/commit/f6169b7).

### Fixed

1. **Realtime notification correctness.** Resource notification type numbers now match Bitwarden semantics, while NodeWarden-specific device status and backup progress notifications use internal values to avoid conflicts with official Send update types. SignalR MessagePack invocations now include `streamIds`, pending auth request notifications refresh the login request list, and the web app ignores notifications sent by the current device to avoid redundant refreshes. Commits: [fe0c66c](https://github.com/shuaiplus/nodewarden/commit/fe0c66c), [9a21504](https://github.com/shuaiplus/nodewarden/commit/9a21504), [4900de0](https://github.com/shuaiplus/nodewarden/commit/4900de0).

2. **Attachment and Send download details.** Public attachment and Send file downloads now include `Content-Disposition` filenames and `X-Content-Type-Options: nosniff`, making browser downloads keep better filenames and reducing content sniffing issues. Attachment delete responses now include both uppercase and lowercase field forms for broader client compatibility. Commit: [add921b](https://github.com/shuaiplus/nodewarden/commit/add921b).

3. **Deleted item and bulk action edge cases.** Vault paging now detects deleted items from both database columns and older JSON payload fields, preventing old deleted items from appearing in the normal vault list. Bulk archive skips deleted items, and duplicate detection now uses decrypted password history instead of encrypted stored text. Commits: [add921b](https://github.com/shuaiplus/nodewarden/commit/add921b), [b444c0f](https://github.com/shuaiplus/nodewarden/commit/b444c0f).

4. **Export, dialog, and toast polish.** CSV export now escapes login URIs correctly inside a single CSV cell; some dialog dismissal behavior is more stable; login and unlock success toasts are less noisy; and the toast close button now uses a styled SVG icon. Commits: [b024226](https://github.com/shuaiplus/nodewarden/commit/b024226), [a06cb0e](https://github.com/shuaiplus/nodewarden/commit/a06cb0e), [8f2704f](https://github.com/shuaiplus/nodewarden/commit/8f2704f), [907126d](https://github.com/shuaiplus/nodewarden/commit/907126d).

5. **S3 backup URL construction.** Virtual-hosted-style backup operations now use the `bucket.endpoint` form for upload, download, delete, and existence checks, while avoiding duplicate bucket names when the endpoint already includes the bucket. Path-style mode keeps the existing `endpoint/bucket` behavior. Commit: [a818316](https://github.com/shuaiplus/nodewarden/commit/a818316).

---

### 新增

1. **资源级实时同步。** NodeWarden 现在会按 Bitwarden 风格发送密码条目、文件夹、Send 的新增、更新和删除通知。Web 端收到通知后可以只刷新受影响的资源，而不是每次都重新同步整个保险库；附件上传、附件删除、公开 Send 访问计数、Send 文件下载等会改变状态的操作，也会触发对应更新。提交：[fe0c66c](https://github.com/shuaiplus/nodewarden/commit/fe0c66c)、[42b765b](https://github.com/shuaiplus/nodewarden/commit/42b765b)、[045b23f](https://github.com/shuaiplus/nodewarden/commit/045b23f)、[46ba8b9](https://github.com/shuaiplus/nodewarden/commit/46ba8b9)、[f096681](https://github.com/shuaiplus/nodewarden/commit/f096681)。

2. **Bitwarden 移动端推送中继支持。** 设备现在可以保存 `push_uuid` 和 `push_token`，通过 Bitwarden push relay 注册或注销，并在保险库资源变化时尝试接收移动端推送。数据库结构也补上了推送字段和索引，用于识别哪些设备可以被推送。提交：[79ed7c9](https://github.com/shuaiplus/nodewarden/commit/79ed7c9)。

3. **Bitwarden CSV 导出。** 除了原有 JSON、加密 JSON 和带附件 ZIP 导出，现在 Web 端可以直接导出 Bitwarden 兼容 CSV。多个登录 URI 会按 CSV 规则安全序列化，卡片、身份、SSH Key 等非登录类型也会尽量保留到字段文本中，方便迁移或人工整理。提交：[b024226](https://github.com/shuaiplus/nodewarden/commit/b024226)、[a06cb0e](https://github.com/shuaiplus/nodewarden/commit/a06cb0e)。

4. **更多重复项检测模式。** 重复项现在可以按完全一致、登录站点加凭据、用户名加密码、单独密码等方式判断。重复组会用颜色辅助区分，移动端保险库也补上了重复项模式选择和更完整的筛选入口。提交：[7b3be2c](https://github.com/shuaiplus/nodewarden/commit/7b3be2c)、[b444c0f](https://github.com/shuaiplus/nodewarden/commit/b444c0f)。

5. **S3 地址样式选择。** 远程备份目标现在可以选择 path-style 或 virtual-hosted-style，兼容更多 S3 服务和自建对象存储。提交：[a818316](https://github.com/shuaiplus/nodewarden/commit/a818316)。

### 改进

1. **Web 保险库操作反馈更及时。** 创建、编辑、删除、归档、恢复、移动条目，创建或删除文件夹，以及创建、更新、删除 Send 时，前端会直接更新本地加密快照、解密列表和修订时间。这样操作成功后列表更快跟上，也让资源级同步下的本地缓存校验更稳定。提交：[42b765b](https://github.com/shuaiplus/nodewarden/commit/42b765b)、[045b23f](https://github.com/shuaiplus/nodewarden/commit/045b23f)。

2. **Bitwarden 客户端兼容性更好。** 账户资料和同步响应补齐了 `organizationsNew`、`policiesNew`、`V2UpgradeToken` 等字段；`/api/accounts/keys` 支持 GET；改密和校验密码接口兼容较新的 `authenticationData`、`unlockData` 请求结构；设备路由同时兼容 `/api/devices` 和 `/devices`。密码条目响应也会保留已存储的 `edit`、`viewPassword` 和 `permissions`，避免跨客户端编辑时权限标记被重置。提交：[add921b](https://github.com/shuaiplus/nodewarden/commit/add921b)、[f9fe532](https://github.com/shuaiplus/nodewarden/commit/f9fe532)。

3. **移动端和小屏界面更顺手。** 顶部栏按钮、网络状态、主题切换、锁定按钮的尺寸和样式更统一。保险库列表里的搜索、排序、筛选、创建按钮和批量选择工具栏在移动端更紧凑；移动筛选菜单可以直接切换全部、收藏、归档、回收站、重复项、类型和文件夹。提交：[7e0406f](https://github.com/shuaiplus/nodewarden/commit/7e0406f)、[16bde22](https://github.com/shuaiplus/nodewarden/commit/16bde22)、[cd2ec82](https://github.com/shuaiplus/nodewarden/commit/cd2ec82)、[c1f5795](https://github.com/shuaiplus/nodewarden/commit/c1f5795)。

4. **TOTP 展示和解析更稳。** 验证码会按 5 位、6 位、8 位等不同长度更自然地分组，列表在窄屏下不会再被固定列宽撑破。`otpauth://` 解析也更能容忍特殊参数编码，Steam 类验证码识别更稳定。提交：[9e0908f](https://github.com/shuaiplus/nodewarden/commit/9e0908f)、[d5c2ab2](https://github.com/shuaiplus/nodewarden/commit/d5c2ab2)。

5. **网络状态不再过度敏感。** Web 端不会因为一次短暂探测失败就立刻判定离线，而是延长探测超时并等待连续失败；普通 API 请求成功或失败也会反向更新网络状态。在线但网络较慢时，不容易误进入离线解锁流程。提交：[b4dfb04](https://github.com/shuaiplus/nodewarden/commit/b4dfb04)。

6. **备份内容更完整。** 完整实例备份现在会导出和还原可信二步验证设备令牌。导入时会校验令牌所属用户、设备标识、过期时间和重复项，让“记住此设备”的二步验证状态在完整迁移后也能保留下来。提交：[f6169b7](https://github.com/shuaiplus/nodewarden/commit/f6169b7)。

### 修复

1. **实时通知类型和刷新逻辑。** 资源通知的类型编号调整为与 Bitwarden 官方语义一致，NodeWarden 自定义的设备状态和备份进度通知改用内部编号，避免和官方 Send 更新类型冲突。SignalR MessagePack 调用补齐了 `streamIds`，认证请求通知会刷新待处理登录请求列表，Web 端也会忽略当前设备自己发出的通知，避免重复刷新。提交：[fe0c66c](https://github.com/shuaiplus/nodewarden/commit/fe0c66c)、[9a21504](https://github.com/shuaiplus/nodewarden/commit/9a21504)、[4900de0](https://github.com/shuaiplus/nodewarden/commit/4900de0)。

2. **附件和 Send 文件下载细节。** 公开附件和 Send 文件下载现在会带上 `Content-Disposition` 文件名和 `X-Content-Type-Options: nosniff`，浏览器保存文件时更接近原文件名，也减少类型嗅探问题。删除附件的响应同时提供大小写两套字段，兼容不同客户端读取方式。提交：[add921b](https://github.com/shuaiplus/nodewarden/commit/add921b)。

3. **已删除条目和批量操作边界。** 保险库分页查询现在会同时识别数据库列和历史 JSON 数据里的删除时间，避免旧数据中已删除条目出现在正常列表。批量归档会跳过已删除条目，重复项判断也会使用已解密的密码历史，避免加密文本影响结果。提交：[add921b](https://github.com/shuaiplus/nodewarden/commit/add921b)、[b444c0f](https://github.com/shuaiplus/nodewarden/commit/b444c0f)。

4. **导出、弹窗和提示细节。** CSV 导出中的登录 URI 会按单行 CSV 单元格正确转义；部分弹窗关闭行为更稳定；登录或解锁成功后的 toast 更克制，避免重复提示；toast 关闭按钮换成了 SVG 图标并调整了样式。提交：[b024226](https://github.com/shuaiplus/nodewarden/commit/b024226)、[a06cb0e](https://github.com/shuaiplus/nodewarden/commit/a06cb0e)、[8f2704f](https://github.com/shuaiplus/nodewarden/commit/8f2704f)、[907126d](https://github.com/shuaiplus/nodewarden/commit/907126d)。

5. **S3 备份地址拼接。** 选择 virtual-hosted-style 时，备份上传、下载、删除和存在性检查会使用 `bucket.endpoint` 形式；如果 endpoint 已经带有 bucket，也不会重复拼接 bucket。path-style 仍保持原有 `endpoint/bucket` 形式。提交：[a818316](https://github.com/shuaiplus/nodewarden/commit/a818316)。
