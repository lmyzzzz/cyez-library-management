# 刷卡登记版业务与接口规格

修订基线：2026-10-29，以 [opinions.md](../opinions.md) 为本轮需求来源，优先于原草图及 2026-10-28 设计。当前只有文档和图表，尚未实现应用。`usage_record` 是一次使用记录，不套用完整三端方案的锁机/Session 状态机。

## 范围与职责

本版包括教师 Electron、Docker 化 Fastify 服务端与 PostgreSQL。左侧侧边栏只有上下两个一级入口：上方“使用登记”，下方“设置”。登记包含设备列表、刷卡登记、结束和批量结束；设置包含连接配置、设备编辑、只读历史记录和诊断。所有教师共用一个业务账号，合法教师可分配任意设备，无机房权限体系、管理员角色或教师账号管理。机房/分区仅用标签筛选，不参与授权。

| 组件 | 负责 | 边界 |
| --- | --- | --- |
| CardReader / Electron main | USB 解析后立即固定盐哈希、网络连接、指纹校验、认证、持久提交意图和日志 | 原 UID 不离开刷卡模块；renderer、服务端、日志和 SQLite 均不接收原卡号 |
| renderer / preload | 两个导航入口、设备选择、10 秒无操作取消、结束确认、受限 IPC | 不持有密码/token、任意 URL、SQL 或系统权限；仅使用最小业务 DTO |
| Fastify | 共享账号验证、每次合格刷卡刷新资料、登记/结束、设备编辑、历史查询、审计/日志接收 | 只开放列明的业务 API；不开放数据库、系统配置、运维日志、导出或任意表查询 |
| Sequelize + PostgreSQL | 模型、关联、参数化查询、事务、行锁、迁移、条件唯一索引 | 使用库的 Model / QueryInterface / transaction API；不手写 SQL 字符串 |
| 校园卡提供方 | 返回本次刷卡最新学生信息 | 仅服务端调用，TBD-02；完整响应仅短时处理，只更新白名单字段 |

不提供学生手动注册、学生导入/编辑页、历史补录/更正/删除、备份或导出功能。初始合法学生必须预置于内部数据库，来源见 TBD-07；外部 API 有这个人也不构成本系统登记资格。设备数量不设产品上限，分页和单批上限仅用于控制一次请求的成本。

## 连接、证书指纹与共享账号

设置页填写服务端 IP、端口（默认 443）、**服务端叶证书 DER 的 SHA-256 指纹**、账号和密码，可选择保存登录信息。指纹支持大小写和冒号规范化，最终校验为 32 字节；不是 SHA-1 指纹，也不是公钥 SPKI 指纹。不向 Windows 系统证书库添加自签名证书。

main 使用专用 Electron network session，通过 `setCertificateVerifyProc` 为这个固定 HTTPS origin 实施 pinning：只接受配置 IP 上证书 DER 摘要与配置指纹完全相等、证书有效期正确、IP SAN 匹配的证书；证书链不在系统信任库可由明确配置的 pin 替代信任锚。即使系统信任另一张证书，也不能绕过 pin。校验在发送 HTTP 密码、token、cardHash 或业务正文之前完成。请求只允许配置的 origin；拒绝重定向、HTTP 降级和任意 URL。renderer 不使用该网络 session。外部校园 API 走服务端正常 TLS 校验，不复用教师端的例外。

不能用全局忽略证书错误、无条件接受所有证书或只在请求后检查指纹实现。Electron 会缓存证书校验结果；修改 IP/端口/pin 后销毁旧连接池/session，建立新的专用 session，取消旧目标的待发业务请求，重新测试连接并登录。更新证书必须由运维通过可信渠道提供新指纹，由教师显式修改；不能从失败连接自动学习新 pin。诊断区只显示证书摘要/有效期/连接结果，无私钥。

IP/pin 可作为普通本地配置保存；密码和 token 仅 main 通过操作系统保护存储保存（Windows DPAPI / Electron safeStorage，采用所选 Electron 版本支持的 API）。保存功能不可用时仅保留内存并提示，不能退化为明文文件。密码输入后不再回显，可清除保存项。

服务端共享账号通过部署 `.env` 中 `TEACHER_USERNAME`、`TEACHER_PASSWORD` 修改；无内置默认密码、无 admin。Compose 明确将这两个变量传入 API，修改后重新创建 API 容器才生效，仅编辑文件或普通 restart 不等于重新加载环境。登录做限速和成熟密码验证；HTTPS 后颁发短期、绑定 `clientId` 的不透明会话 token。首版单实例会话仅驻内存，重启/重建全部失效，须用新密码重新登录。客户端改密后旧保存密码不能继续使用。

`clientId` 为安装时生成并持久保存的随机 ID，用于区分提交意图、启动报告及日志来源；它不是第二套角色系统，也不能证明具体哪位教师操作。审计只能记录共享账号、clientId、请求和时间，不能声称具备个人问责身份。未登录不能读取业务；日志暂存到重新认证后补传。客户端断线时禁止新业务写入，默认前台设备列表每 3 秒轮询、后台暂停、失败退避，并明确显示数据已过期。

## 刷卡与资料更新

![刷卡流程](registration-flow.svg)

1. CardReader 完成协议必要的 UID 规范化后，**第一时间在模块内**计算 `SHA-256(encode(hashVersion, fixedSalt, issuer, uidLength, uidBytes))`。使用固定明确长度编码，保留字节序、长度和前导零；发行方、算法版本与固定盐一致才能跨教师机匹配。所有终端、预置数据工具和 provider 适配约定使用同一套参数；不得随机逐次加盐。固定盐不是秘密，不当作密码或认证凭证。
2. 模块对外只输出 `scanId / cardHash / hashVersion / source`，释放原 UID 引用，可写 buffer 尽力覆写；不宣称 JavaScript GC 能保证物理擦除。原卡号不经 IPC、不上传服务器、不入队、不落盘。cardHash 本身也是可关联的敏感标识，不写日志，不作为教师认证材料。
3. 只有“使用登记”的设备列表、无 Modal、无提交且无 scan 处理中时才接受刷卡流程；其他页面（包括设置和历史）只 Toast“接收到刷卡消息，请返回主页面以触发登记”，丢弃该事件，不向外部 API 查询、不排队重放。以下“每次刷卡”指通过该门控并去重后的有效刷卡；不把硬件连续重复帧视为多次业务刷卡。
4. main 通过已校验 pin 的 HTTPS 发送 `POST /api/v1/scan-previews`，仅含 hash/来源/scanId。服务端记录 `scanAtMs`，查内部 student，同时为本次刷卡请求外部最新资料；**已知学生也每次请求，不读缓存冒充刷新**。接口需要 cardHash 或预置的非原卡号 `provider_lookup_ref`。TBD-02 必须确认供应方支持哪种；若只接受原 UID，在当前隐私边界下无法接入，不能反推哈希或暗中保留原卡号。未知 hash 没有可用查询标识时直接拒绝，不为满足查询次数而放宽此边界。
5. 内部数据库中不存在、已停用或 hash 版本不匹配：拒绝登记，不插入学生，即使外部返回合法学生也一样。内部已知学生且外部成功：按 TBD-01 白名单校验并更新该学生已有资料、`profile_refreshed_at` 和版本；不改变学生 ID/cardHash/登记资格。外部超时、错误、身份不匹配或必需字段缺失：不覆盖已有资料、不生成可提交预览，显示错误允许重刷。
6. 资料刷新是刷卡阶段独立提交的事务，之后按是否有活动记录返回 `start` 或 `end` 预览。预览取消只取消登记/结束意图，**不回滚已经刷新的学生资料**。同一学生的刷新在单实例服务端串行处理，provider 调用在短数据库事务之外；并发旧响应不能覆盖新响应。未来多 API 实例须先实现跨实例串行/版本控制，不能直接水平扩容。
7. 预览绑定 clientId/认证上下文，默认 2 分钟、仅有界内存、重启失效；提交时验证资料版本、hash 与当前档案仍匹配。确认前若另一次刷卡刷新了资料，旧页面返回 409 重新预览，不能悄悄切换学生。

**未知学生绝无手动登记入口。** 合法学生初始预置及 cardHash/provider 引用对应来源为 TBD-07；未解决前只能使用测试种子，不能把空库自动注册当上线替代方案。更换卡首版仍不自动合并；新卡没有预置授权记录就拒绝，跨卡迁移作为 NEXT-01 后续事项。

外部 API 不可用时停止刷卡登记及刷卡结束，不用旧资料冒充本次新资料；教师仍可从内部活动列表**手动结束**已有记录，清楚显示为手动操作。历史、列表、设备管理和手动/批量结束只访问内部数据库，不触发校园 API。

## 登记、结束与计时

登记页显示只读学生摘要、本次刷卡时间、备注和 DevicePicker；仅选择未删除、未禁用且无活动记录的设备。资料不足或无可分配设备禁用确认。确认只创建使用记录，`endedAtMs=null`，绝不创建学生。

登记取消计时改为 **连续 10 秒没有用户操作才取消**。页面资料加载完成且可交互时开始；页面内可信的键盘/输入、点击、触摸、滚轮、指针移动等活动重置期限为“现在 + 10 秒”，包括选择设备与编辑备注。合成事件、轮询、网络响应、动画与反复读卡帧不算用户活动。不安装全局键鼠钩子。使用单调时钟记录 lastActivity；持续编辑不能因为固定倒数而被取消。

切后台/失焦仍按最后一次活动计空闲时间，**仅取消，不提交**；系统可能节流计时器，回前台/系统唤醒后先检查期限，已满 10 秒立即退出登记页，再处理新的业务输入，不能把过期登记复活。DevicePicker 和其 Modal 内真实操作也重置登记空闲期限；若独立结束请求已发送，取消登记不能撤销该请求，main 继续按原 requestId 查询结果。登记自身已提交则关闭空闲计时，不用“取消”伪装回滚。

刷卡结束仍保留 **5 秒自动确认**，备注加载已有值；编辑/失焦/后台/错误暂停自动提交，恢复需显式继续或确认。这是结束页的独立规则，不套用登记的 10 秒空闲取消。手动单结束与批量结束没有自动确认。按钮与计时器共用一次提交门闩，离开页面清理计时器。

`scanAtMs` 为服务端接收请求时刻；登记开始/刷卡结束采用它，手动/批量结束用服务端生成预览时刻。JSON 时间一律 Unix 毫秒安全整数或 `null`，DB 用 `timestamptz`；实际写入时间另记。服务端在关联对象锁内校验 `end >= start` 及有效使用区间 `[start,end)` 不重叠。刷卡之后才结束目标设备原占用，若旧刷卡时间会重叠则返回 `TIME_RANGE_CONFLICT` 要求重刷，不暗改开始时间。

## 数据模型与数据库库

![数据模型](data-model.svg)

采用 **Sequelize 6 稳定版 + pg，TypeScript 模型与版本化迁移**；依赖精确版本在实现时固定。查询、关联、CRUD、分页、事务、行锁、索引和迁移统一用 Sequelize 的 Model / QueryInterface API，迁移编排采用 Umzug。不得写 `sequelize.query` 原始语句、`literal` 片段或手拼 SQL；模型级 validator 不替代事务/数据库约束。生产不使用 `sync({ force/alter: true })` 自动改表。库支持带 `where` 的条件唯一索引与事务行锁，已有方案无需靠手写 SQL 实现。

| 实体 | 字段与约束 | 说明 |
| --- | --- | --- |
| `students` | `id` UUID PK、唯一 `card_hash`、`hash_version`、可选 `provider_lookup_ref`、候选姓名/班级/校内学号、`is_enabled`、`profile_refreshed_at`、`version` | 由受控预置提供合法学生；只刷新已有资料，不自动创建；字段 TBD-01、预置来源 TBD-07 |
| `devices` | UUID PK、唯一 code、display_name、is_disabled、notes、deleted_at、version | 设置中添加/编辑/删除；删除使用软删除以保留历史引用 |
| `tags` / `device_tags` | 标签 ID/名称；关联 `(device_id,tag_id)` 复合 PK，两个 FK，反向索引 | 机房/区域仅为筛选标签，一份关系双向查询，无机房授权表 |
| `usage_records` | UUID PK、student_id/device_id FK、started_at、ended_at nullable、notes、end_reason、version、clientId 与写入时间 | 活动=`ended_at` 为空；学生/设备活动字段各设条件唯一索引；已结束历史只读，无作废、更正、删除接口 |
| `operations` | `(client_id,request_id)` 唯一、可空唯一 intent_id、路由+payload 摘要、持久结果与时间 | 跨会话重登也能查询本机提交；同键异 payload 拒绝；preview/batchUnit 成功消费一次 |
| `audit_events` | event_id、共享账号标识/clientId、对象 ID、requestId、动作/时间/必要字段名 | 与业务提交同事务；只服务器保存，无教师审计日志查询接口 |
| `app_logs` | source+logId 唯一、来源/级别/时间/版本/关联 ID/脱敏消息 | 全部已产生日志集中归集；无 UID/hash/密码/provider 完整响应；无教师全库日志浏览接口 |

不再需要卡密钥轮换映射表、账号角色表或机房 ACL 表。固定盐/hashVersion 属于协议配置，**运行中不得随意改盐**；没有原 UID 无法从旧 hash 计算新 hash，变更必须有新的合法预置数据/迁移计划，首版不提供换盐或换卡自动迁移。

约束通过 QueryInterface 的建表/外键/复合主键/`addIndex({ unique, where })` 等 API 声明；学生和设备分别只允许一条 `ended_at` 为空的记录。事务使用统一顺序的行锁验证时间区间和停用/删除状态，防止并发抢同机与禁用竞争。学生/设备表不额外双写 `is_using`；设备 DTO 按活动记录派生占用。

删除设备前若仍有活动记录返回 409，先显式结束后再删除；软删除后不在可分配列表中出现，历史仍可关联设备名称/编号。历史页只查内部当前资料，学生信息显示**最近一次成功刷卡刷新后的数据库值**；查看历史不发外部请求。历史不允许修改备注、开始/结束时间、关联或删除；活动记录的备注编辑及结束时备注合并仍属于当前使用流程，结束后不可再次编辑。

## 事务、幂等与批量

![事务设计](record-transactions.svg)

开始/结束/设备修改先验证共享账号和业务 schema，再查 `(clientId,requestId)` 原操作结果；同路由同摘要返回已提交结果，不同 payload 拒绝。新提交验证 preview 绑定、TTL 和学生版本，进入 Sequelize 托管事务：按设备 ID → 学生 ID → 记录 ID 各自升序锁定，重新检查关联和状态，写业务、审计、操作结果后一同提交。provider 调用不放入此事务。死锁有限重试沿用原 requestId，条件唯一索引兜底。

开始只引用存在且启用的学生；结束只针对明确 `recordId + expectedVersion`，不能结束同学生后来新建的记录。同一 preview/批次单元的 intentId 以唯一约束持久消费，换 requestId 也不能再次提交；失败事务不消费。先返回持久幂等结果，再判断旧 preview 是否过期。

批量结束先服务器预览固定 ID/版本集合和候选时间，之后新增的记录不纳入。结束全部=**全系统全部活动记录**；结束选中/筛选结果使用不同按钮，并显示数量和筛选条件，不受机房权限限制。单批默认上限 500 条、可配置；一条冲突则整批 409 回滚。更大集合固定分批，逐批状态透明，不宣称跨批原子性。

单条备注为确认的完整值；批量公共备注初始为空，空则保留原文，非空由服务端在锁内追加 `原有备注 + 换行 + 批量结束备注：XXX`，原文为空不加前导换行。同一提交只追加一次。已结束记录不开放备注修改。

超时不等于失败；main 先保存不含原 UID/hash 的提交意图（previewId/recordId/deviceId/version/requestId/必要备注），以原键查询/重试；更换服务器配置时按 origin 隔离意图，绝不把旧服务器命令重放到新服务器。返回/关闭页面不撤销已发请求。

## REST 契约

除健康检查和登录外均需共享账号会话；下表省略 `/api/v1` 前缀。业务权限为固定白名单，无通用资源 CRUD、admin 或运维端点。

| 接口族 | 输入与行为 | 结果/错误 |
| --- | --- | --- |
| `POST /auth/login`、`/auth/logout` | `.env` 对应账号密码、clientId；登录限速 | 内存短期会话；重启失效；401/429；无注册/改密/admin API |
| `POST /clients/startup` | 已认证的 clientId、版本报告 | 仅报告启动，无自报角色提权 |
| `POST /scan-previews` | scanId/cardHash/hashVersion/source | 每次有效刷卡刷新已有学生；未知拒绝、provider 失败停止；返回资料/模式/绑定预览 |
| `DELETE /scan-previews/{id}` | 仅当前 client 的预览 | 释放意图，TTL 兜底；不回滚学生资料刷新或已提交业务 |
| `POST /usage-records/start` | previewId/deviceId/notes/requestId | 仅创建使用记录；409 冲突、410 过期；没有学生补充字段 |
| `POST /usage-records/{id}/end-preview`、`/end` | 手动预览；确认带 previewId/expectedVersion/notes/requestId | 结束指定活动记录；手动流程只读内部 DB |
| `POST /usage-records/end-batches/preview`、`/confirm` | 精确选择/筛选/全系统、固定批次预览、公共备注 | 单批全成或全败；不得扩展确认范围 |
| `PATCH /usage-records/{id}/notes` | 仅活动记录；expectedVersion/notes/requestId | 已结束返回 `HISTORY_READ_ONLY`；历史页无该操作 |
| `GET /usage-records` | 分页、时间/学生显示字段/设备/标签筛选；默认已结束历史 | 仅内部 DB；最小 DTO；无编辑/删除/导出 |
| `GET /devices`、`/tags` | 状态/标签/名称筛选、分页 | 所有合法教师可见全部设备；无机房 ACL |
| `POST /devices`、`PATCH /devices/{id}`、`DELETE /devices/{id}` | 业务字段、标签关系、预期版本、requestId；DELETE 为软删除 | 活动中不能删；保留历史 FK；标签仅业务管理 |
| `POST /tags`、`PATCH/DELETE /tags/{id}` | 名称/版本/设备筛选关系 | 仅影响筛选，不产生权限；删除关联同事务 |
| `GET /operations/{requestId}` | session 绑定 clientId 的原请求 | 持久结果；未找到仍沿原键重试，不直接判定未执行 |
| `POST /logs/batch` | 已认证来源和稳定 logId，有限批量 | 持久提交后 ACK；仅上传，无教师全库读取 |
| `GET /health/live`、`/health/ready` | 进程、DB/schema/必要写入条件 | 200/503，无秘密或运维数据；健康路径无 `/api/v1` 前缀 |

固定错误 code 区分 `STUDENT_NOT_ALLOWED`、`PROVIDER_UNAVAILABLE`、`PROFILE_MISMATCH`、`TIME_RANGE_CONFLICT`、`PREVIEW_ALREADY_USED`、`HISTORY_READ_ONLY`；401 恢复登录，409 冲突须重预览，410 过期须重刷，422 输入错误，429/503 退避。API 不接受任意表名、SQL、外部 URL 或运行命令。

## 日志与故障

教师 main/renderer/reader/SDK/安装日志全部本地持久排队，认证恢复后上传，持久 ACK 前不回收。服务端/gateway/DB 日志先 spool 后内部归集；配置 ORM/gateway 禁止输出绑定参数、刷卡/登录请求 body、hash、密码、token 和完整 provider 响应。教师诊断只能显示本机连接/读卡/版本/待传数量等业务必要状态，不提供服务器系统日志、数据库凭证或原始表访问。

所有来源稳定 logId 去重，日志接收不递归生成同类日志；无法保存业务审计则拒绝业务写入。本版故障不控制或关闭学生电脑。应用无备份/导出功能；运维确有需要时在产品外手工操作数据库。完整验收见[两端测试设计](testing.md)。
