# 技术决策、证据与需求追踪

修订基线：2026-10-29。最新来源为提交 `a18466c` 中的 [opinions.md](../opinions.md)，覆盖原 [draft.drawio](draft/draft.drawio) 及 2026-10-28 正式设计的冲突内容。原始文件保留不改。以下技术决定支持当前需求，不把旧选择继续当作约束。

## 当前决策

| 编号 | 决定 | 依据与取舍 |
| --- | --- | --- |
| ADR-01 | 本阶段只有教师 Electron、Docker Fastify 与 PostgreSQL | 保留 record-only 范围；结束的是记录，不控制学生电脑 |
| ADR-02 | Fastify 模块化单体 + REST，所有业务判断在服务端 | schema 请求校验/响应白名单、插件隔离、inject 集成测试。[S1][S2] |
| ADR-03 | 设备—标签只存一份关联表 | 复合主键/外键/双向索引；机房/分区只是标签筛选，最新需求取消机房权限。[S3] |
| ADR-04 | 活动占用来自 ended_at 为空的 usage_records | 学生与设备各有条件唯一索引，不维护第二份占用表或 is_using。[S3][S4] |
| ADR-05 | 独立 studentId + students.card_hash 唯一；学生必须预置 | 内部 UUID 保持历史关联；本次取消卡凭证轮换表。未知卡拒绝，外部存在也不能自动注册；预置来源 TBD-07 |
| ADR-06 | CardReader 内立即固定盐 SHA-256，对外只交 hash | 按最新需求替代服务端秘密键 HMAC；编码明确长度/字节序/发行方。固定盐不等于秘密，不能保证低熵 UID 不被枚举或防克隆卡，不夸大为匿名化。[S9][S10] |
| ADR-07 | 每次有效刷卡调用外部 API，并提交已有学生最新资料 | 历史/列表只读内部 DB，不触发外部请求；取消登记不撤销资料刷新。接口失败阻止刷卡流程；手动结束仍可用 |
| ADR-08 | 时间 JSON 为 Unix 毫秒整数，DB 为 timestamptz | 服务端接收刷卡时刻决定开始/结束；实际提交时间另记；时区仅影响显示。[S14] |
| ADR-09 | Sequelize 6 + pg + Umzug；不手写 SQL | 选择稳定版本，TypeScript 模型、QueryInterface 迁移、transaction/lock、where 条件索引满足当前需求；不使用 raw query/literal 或生产 sync alter。[S17][S18][S19] |
| ADR-10 | 写业务、审计和持久操作结果同事务，统一锁顺序 | 设备 → 学生 → 记录各自排序；唯一约束兜底；超时用原 clientId/requestId 查询/重试。[S3][S5][S18] |
| ADR-11 | 批量先固定 ID/版本集合，再显式确认，单批全成全败 | 全部指全系统活动记录；后来新增不纳入；默认 500/批可配置，与设备总数无关 |
| ADR-12 | 历史只读；设备删除软删除 | 历史无编辑/作废/删除/导出；活动记录仍可备注/结束；设备有活动先结束，保留历史 FK |
| ADR-13 | 登记为 10 秒无任何用户操作才取消 | 替代旧 5 秒固定取消；真实输入重置空闲期限，后台仍计时，返回先清过期；刷卡结束 5 秒确认独立保留 |
| ADR-14 | 共享业务账号，无 admin、无机房 ACL | 账号密码从服务端 .env 配置；所有合法教师访问全部设备，但只能访问业务 API；无法归因到具体教师，这是共享账号的实际边界 |
| ADR-15 | 应用内 SHA-256 叶证书 pin + 固定 HTTPS origin | 不写系统证书库；握手阶段核对 DER 摘要/有效期/IP SAN，拒绝重定向；换配置重建网络 session，防校验缓存复用。[S20][S21] |
| ADR-16 | 本地密码用 OS 保护存储；服务端 .env 改密后重建容器 | 密码不交 renderer；保存不可用则仅内存。首版内存会话随 API 重启失效，旧 token/密码不能继续用。[S22][S23] |
| ADR-17 | Docker Compose 单节点，五类服务，无备份/导出模块 | gateway/api/db/migrate/log-ingest；卷持久性、迁移与日志补传仍需验收，产品不承担自动备份或恢复承诺。[S6][S7][S8] |
| ADR-18 | Yarn 4 内部 workspace:^；固定 tarball 消费 cyez-ui | 上游 pnpm 构建与项目 Yarn 消费分开；库使用授权已由用户确认，不再列为阻塞项。[S15][S16] |
| ADR-19 | 两端独立单元/集成，真实 PG / Electron / TLS pin 负例 | 测并发、IPC、实际网络和持久队列，不能仅用 mock 或上游测试代替。[S2][S11][S12][S13] |
| ADR-20 | 每个 preview/batchUnit 只成功消费一次 | 持久唯一 intentId 防止换 requestId 重复消费；同键仍返回原结果，不依赖删除内存预览。[S3] |
| ADR-21 | 对象锁内验证使用区间不重叠，旧刷卡时间冲突须重刷 | 不偷偷改开始时间；合法结束与新开始相等允许，负时长和重叠拒绝。[S5][S14] |

## 新文件逐项落实

| opinions.md 要求 | 正式落点 |
| --- | --- |
| 设置页增加设备添加/删除/修改 | specification 业务 API；ui 设置/设备页；图 06；S-I-02 / C-I-08 |
| 好看的历史列表，只看不改删 | ui 固定表头、分页、筛选、详情抽屉；图 06；历史 API 不调用 provider 且拒绝变更 |
| 左侧上下两个并列入口 | 图 06：上“使用登记”、下“设置”；设备编辑/历史为设置内页 |
| 每次刷卡更新外部最新资料，历史读内部库 | ADR-07；刷卡独立刷新事务和错误行为；图 01/03/04；S-I-06/07 |
| 输入 IP、证书指纹、账号密码，可本地保存 | ADR-15/16；specification 连接规则；图 05/06/07；C-I-09/10 |
| 不向本机添加自签名证书 | pin 仅作用于专用 session 和配置 origin，不改系统信任库 |
| .env 改服务端密码，共享账号，无真正 admin | ADR-14/16；deployment 环境配置、容器重建、旧会话失效；无账号管理页 |
| 教师不访问业务外数据 | 固定 API 白名单；无数据库、系统日志、备份、导出、配置管理端点 |
| 不考虑备份和导出 | ADR-17；删 backup 服务、RPO/RTO/恢复演练与导出 UI；产品外运维手工导出另行处理 |
| cyez-ui 已获授权 | ui / 图 07 标记已确认；TBD-06 只保留 Windows 发布材料 |
| 用库操作数据库，不手写 SQL | ADR-09；删除 SQL 示例，使用 Sequelize/QueryInterface/Umzug |
| 登记 10 秒无操作取消 | 明确 lastActivity、输入重置、后台返回检查，与结束页 5 秒确认区分 |
| 库中不存在学生为非法，无未知手动登记 | ADR-05；未知即拒绝，TBD-07 预置来源，删除学生注册/补录 API 与界面 |
| 读卡后立即固定盐哈希，不存卡号 | ADR-06；raw UID 不出 CardReader；TBD-02 确认哈希/不含原卡号的查询标识兼容性 |
| 不要机房权限，合法教师可分配所有设备 | 删除 rooms/ACL/operator/admin，标签仅用于筛选；全部结束范围为全系统 |

原草图仍保留的规则：学生当前资料覆盖更新，历史展示当前数据库值；设备标签多对多；一次使用一条记录；整数时间；使用中/未使用选项卡；单结束 Modal 与整页复用；批量备注从空开始追加；只有设备列表刷卡跳转。旧草图的未知学生注册、5 秒登记取消和记录 CRUD 被本轮明确替换。

## 待定输入与延期

| 编号 | 状态和内容 | 影响及图中位置 |
| --- | --- | --- |
| TBD-01 | 学生最终字段、必填项和显示白名单 | 姓名/班级/校内学号为候选，不采集无关学籍号；图 01/02/03/06 |
| TBD-02 | 校园 API 协议、认证、限额、SLA、字段；是否接受 cardHash 或预置的非原卡号 lookupRef | 必须能在原 UID 不离开读卡模块的条件下查询；只接收 UID 则接口未兼容，不能假实现；图 01/03/05/08 |
| TBD-03 | USB 协议、驱动、型号、发行方、UID 字节序与长度 | CardReader 确定后立即哈希；普通键盘输入不能默认作为卡数据；图 01/03/06/08 |
| TBD-04 | Linux/架构、服务器 IP、含 IP SAN 的证书及指纹分发、外部网络 | 容器、pin 和 .env 方案已定；不含备份/RPO/RTO；图 05/08 |
| TBD-05 | 资料、记录、日志保留期及产品外清理规则 | 未确认前不自动删数据；不扩展成教师导出/管理员功能；图 02/05/06 |
| TBD-06 | Windows 安装包签名材料与目标系统验收 | cyez-ui 使用授权已由用户在 opinions.md 确认，许可不再待定；图 07/08 |
| TBD-07 | 初始合法学生及 cardHash/可选 providerLookupRef 来源、格式和更新责任 | 上线前必须预置；只能通过产品外受控工具/ORM seed，不增加教师注册页；图 02/03/08 |
| NEXT-01 | 跨卡身份迁移明确延期 | 首版新卡无预置记录就拒绝，不自动视为可登记新人；无换盐/换卡自动迁移；图 02/07 |

## 依据

S1～S16 于 2026-10-28 已核对；本次新增 S17～S23 于 2026-10-29 核对官方文档或其官方仓库正文。外部 current/latest 会变化，实现时固定兼容依赖版本。官方能力不等于本项目已通过测试。

- [S1 Fastify schema](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)；[S2 Fastify testing](https://fastify.dev/docs/latest/Guides/Testing/)。
- [S3 PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)；[S4 partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)；[S5 locking](https://www.postgresql.org/docs/current/explicit-locking.html)。通过 ORM 声明/调用这些能力，不据此要求手写 SQL。
- [S6 Docker multi-stage](https://docs.docker.com/build/building/multi-stage/)；[S7 Compose startup](https://docs.docker.com/compose/how-tos/startup-order/)；[S8 Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)。
- [S9 Node crypto](https://nodejs.org/api/crypto.html)；[S10 OWASP storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)。固定盐哈希是用户指定的处理策略，不声称达到秘密 HMAC 的抗枚举能力。
- [S11 Electron security](https://www.electronjs.org/docs/latest/tutorial/security)；[S12 Vitest coverage](https://vitest.dev/guide/coverage.html)；[S13 Playwright Electron](https://playwright.dev/docs/api/class-electron)（实验性）。
- [S14 PostgreSQL date/time](https://www.postgresql.org/docs/current/datatype-datetime.html)；[S15 Yarn focus](https://yarnpkg.com/cli/workspaces/focus)。
- [S16 cyez-ui 固定提交](https://github.com/lmyzzzz/cyez-ui/tree/0a1d4f4fa9affecb2eaf83e978c1e9b1557c7043)：包入口、tarball、peer 与验证边界；使用授权以用户最新确认为准。
- [S17 Sequelize v6 indexes](https://github.com/sequelize/website/blob/main/versioned_docs/version-6.x.x/other-topics/indexes.md)：多列/唯一/where 条件索引。
- [S18 Sequelize transactions](https://github.com/sequelize/website/blob/main/versioned_docs/version-6.x.x/other-topics/transactions.md)：托管事务、隔离与行锁。
- [S19 Sequelize migrations](https://github.com/sequelize/website/blob/main/versioned_docs/version-6.x.x/other-topics/migrations.md) 与 [TypeScript](https://github.com/sequelize/website/blob/main/versioned_docs/version-6.x.x/other-topics/typescript.md)：QueryInterface、版本迁移、类型模型。文档亦展示 raw SQL；本项目明确只用库 API。
- [S20 Electron Session](https://github.com/electron/electron/blob/main/docs/api/session.md)：setCertificateVerifyProc、回调结果和校验缓存；不能把示例的按主机接受直接当安全 pinning。
- [S21 Node TLS](https://nodejs.org/api/tls.html)：fingerprint256 是证书 DER 的 SHA-256；本项目从实际证书计算该摘要，不混用 SHA-1/SPKI。
- [S22 Electron safeStorage](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)：OS 保护存储。上游新版本 API 可能变更，按固定 Electron 版本选择实现。
- [S23 Docker Compose interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)：.env 插值须显式传入服务环境；改值后重建容器。
