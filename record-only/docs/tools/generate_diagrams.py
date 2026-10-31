#!/usr/bin/env python3
"""Generate the record-only design atlas; standard library, optional CairoSVG preview."""
from pathlib import Path
import argparse
import importlib.util
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('diagram_engine', Path(__file__).with_name('diagram_engine.py'))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
page, panel, route, down = engine.page, engine.panel, engine.route, engine.down
BLUE, GREEN, PURPLE, RED, YELLOW = engine.BLUE, engine.GREEN, engine.PURPLE, engine.RED, engine.YELLOW


def card(p, ident, x, y, w, h, text, fill='#ffffff', size=19):
    return p.box(ident, x, y, w, h, text, fill=fill, size=size)


def note(p, ident, x, y, w, h, text, fill=YELLOW, size=18):
    return card(p, ident, x, y, w, h, text, fill, size)


def caption(p, text):
    p.label('footer', 40, p.height-72, p.width-80, 48,
            text, size=17, fill=BLUE)


def overview():
    p = page('architecture', '01 · 刷卡登记版总体架构',
             '当前实施范围：教师 Electron + Docker 服务端；设备仅是登记资源。箭头表示调用或数据流，虚线表示日志归集。', 1800, 1660)
    panel(p, 'teacher', 40, 145, 520, 1140, '教师 Windows · 可有多个客户端', GREEN)
    card(p, 'reader', 75, 225, 450, 120,
         '独立读卡进程 · Rust mock / 硬件\nstdin/stdout JSON Lines v1 · 4 字节 UID\nWiegand-34；TBD-03：真实硬件验收', YELLOW)
    card(p, 'renderer', 75, 420, 450, 150,
         'React renderer + cyez-ui\n上：使用登记；下：设置\n设备编辑 / 只读历史 / 连接配置\n无原 UID、密码/token 或数据库权限')
    card(p, 'preload', 75, 640, 450, 95,
         '受限 preload IPC\nsender + schema 校验，隔离 renderer')
    card(p, 'main', 75, 810, 450, 160,
         'Electron main · 启动读卡进程 / 立即哈希\n原卡号 + studentId 经已 pin HTTPS\n证书 pin / 共享认证 / 密码 OS 保存\n卡号不落盘；提交意图 / 日志可恢复')
    card(p, 'outbox', 75, 1065, 450, 150,
         '本地 SQLite 日志 outbox\nmain / UI / reader / SDK / 安装日志\n稳定 logId，断网留盘\n服务端持久 ACK 后回收', GREEN)
    down(p, 'ui-ipc', 'renderer', 'preload')
    down(p, 'ipc-main', 'preload', 'main')
    down(p, 'main-logs', 'main', 'outbox')
    route(p, 'reader-main', 'reader', 'main', [(75,285),(57,285),(57,870),(75,870)], both=True)

    panel(p, 'server', 640, 145, 1120, 1140, '学校固定地址 · Linux Docker Compose', BLUE)
    card(p, 'api', 680, 230, 1040, 115,
         'HTTPS :443 → gateway → Fastify REST /api/v1\n共享登录 / 刷卡刷新 / 登记结束 / 设备编辑 / 历史 / 日志 ACK\n固定业务白名单；无 admin、机房 ACL 或运维数据查询')
    card(p, 'services', 680, 455, 480, 180,
         'Fastify + Sequelize · 服务端规则\n按原卡号重算 studentId，拒绝错配\n每次查 API；成功新增或覆盖缓存\n预览 TTL / 幂等 / 版本 / 事务')
    card(p, 'provider', 1260, 455, 460, 180,
         '校园卡 API · 用本次原卡号查询\n正常 TLS；查询后释放原卡号\nTBD-02：协议、认证、卡号格式\nTBD-01：学生资料白名单', YELLOW)
    card(p, 'credentials', 680, 725, 480, 125,
         '共享账号 · .env 修改后重建 API\n所有合法教师可分配全部设备\nclientId 只区分来源，不代表个人身份')
    card(p, 'previews', 1260, 725, 460, 125,
         '短期预览 · 有界内存\n绑定 clientId / 会话 / 学生版本\n默认 2 分钟；重启失效，须重刷')
    card(p, 'db', 680, 955, 1040, 160,
         'PostgreSQL · Sequelize 模型/事务/迁移，禁止手写 SQL\nstudents.id = 固定盐 SHA-256；设备 / 标签 / 使用记录\n无原卡号 / 独立 card_hash；历史只读 DB，不查校园 API\n操作结果 + 审计同事务，全部脱敏日志归集；占用条件唯一', GREEN, 21)
    down(p, 'api-services', 'api', 'services')
    route(p, 'provider-call', 'services', 'provider', [(1160,535),(1260,535)], both=True)
    route(p, 'services-db', 'services', 'db', [(920,635),(920,690),(1195,690),(1195,920),(1200,920),(1200,955)])
    down(p, 'provider-preview', 'provider', 'previews')
    route(p, 'business-http', 'main', 'api', [(525,870),(600,870),(600,290),(680,290)], both=True)
    route(p, 'log-upload', 'outbox', 'api', [(525,1140),(620,1140),(620,320),(680,320)], dashed=True)
    p.label('log-label', 690, 1150, 1010, 58,
            '客户端日志也经 HTTPS API → 去重持久提交 → 逐项 ACK\n服务端 / gateway / DB 日志另经本地 spool → 内部 log-ingest', 18)
    note(p, 'scope', 40, 1330, 840, 160,
         '范围边界\n本版无学生端、人脸识别、锁机或屏幕墙\n“结束使用”仅结束记录，故障不控制或关闭电脑\n不限制设备总数；有限分页/批次用于资源保护', BLUE, 20)
    note(p, 'privacy', 920, 1330, 840, 160,
         '数据与刷新边界\n卡号临时请求 / 学生缓存分开；原卡号不入库或日志\nstudentId 为哈希；API 为权威，本地仅缓存\n取消不撤销已刷新资料；日志仅用请求/记录 ID 关联', GREEN, 20)
    caption(p, '黄色：尚待外部确认的需求。蓝/绿：已决定的结构。本目录独立维护；实施与故障处理见 implementation-plan.md。')
    return p


def data_model():
    p = page('data-model', '02 · 数据模型、关系与一致性约束',
             '实线从外键引用方指向被引用方，边旁写明基数；虚线为约束/算法说明。活动占用只从 usage_records 派生。', 1800, 2120)
    card(p, 'students', 60, 160, 500, 245,
         'students · API 资料缓存\nPK id = 固定盐 SHA-256 / STRING(64)\nhash_version / 最新白名单资料\nprofile_refreshed_at / version\n无原卡号 / card_hash / lookupRef\nTBD-01：姓名、班级、校内学号', YELLOW, 20)
    card(p, 'records', 650, 160, 500, 245,
         'usage_records · 一次使用一条\nUUID PK id / UUID FK device_id\nFK student_id STRING(64) → students.id\nstarted_at / ended_at nullable\nnotes / end_reason / version / clientId\n结束后只读；无原卡号', GREEN, 20)
    card(p, 'devices', 1240, 160, 500, 245,
         'devices · 设备资源\nPK id / unique code / display_name\nnotes / version / is_disabled\ndeleted_at 软删除，保留历史 FK\n无 room ACL；机房/分区用标签', BLUE, 20)
    route(p, 'record-student', 'records', 'students', [(650,280),(560,280)])
    route(p, 'record-device', 'records', 'devices', [(1150,280),(1240,280)])
    p.label('student-many', 570, 200, 70, 65, 'N : 1', 17)
    p.label('device-many', 1160, 200, 70, 65, 'N : 1', 17)

    card(p, 'card', 60, 500, 500, 245,
         '校园 API 是权威数据源\n每次有效刷卡按原卡号查询\n成功时新增或覆盖本地学生缓存\n拒绝/故障不使用旧缓存放行\n日常查看和历史仅读本地缓存', YELLOW, 20)
    card(p, 'rules', 650, 500, 500, 245,
         '一致性约束 · ORM 声明与事务\n活动 = ended_at 为空\n活动 student_id / device_id 各自唯一\n行锁内验证时间与区间不重叠\n无单独占用表，无历史更正/删除', PURPLE, 20)
    card(p, 'device-rule', 1240, 500, 500, 170,
         '设备编辑与删除\n设置中增加 / 修改 / 删除\n有活动记录先结束，删除为软删除', BLUE, 20)
    route(p, 'card-student', 'card', 'students', [(310,500),(310,405)], dashed=True)
    p.label('card-many', 325, 427, 200, 45, '成功写入缓存', 17)
    route(p, 'device-rule-edge', 'devices', 'device-rule', [(1490,405),(1490,500)], dashed=True)
    p.label('device-rule-label', 1500, 427, 200, 45, '业务规则', 17)
    route(p, 'record-rules', 'records', 'rules', [(900,405),(900,500)], dashed=True)

    card(p, 'card-hash', 60, 845, 500, 210,
         'CardScanInput · 不是持久实体\ncard: { issuer, uidHex } 仅短时内存\nmain → HTTPS → API → provider\n查询完成/失败即释放原卡号\n不进学生档案 / 预览 / 日志 / 磁盘', BLUE, 19)
    card(p, 'tags', 650, 845, 500, 180,
         'tags · 平面标签\nPK id / normalized_name UNIQUE\ndisplay_name / archived_at / version\n不另存 deviceIds 数组', BLUE, 20)
    card(p, 'device-tags', 1240, 845, 500, 180,
         'device_tags · 唯一多对多关联\nPK (device_id, tag_id) + 两个 FK\n反向索引 (tag_id, device_id)\n设备 DTO 的 tagIds 由此投影', GREEN, 20)
    route(p, 'join-device', 'device-tags', 'devices', [(1710,845),(1770,845),(1770,365),(1740,365)])
    route(p, 'join-tag', 'device-tags', 'tags', [(1240,935),(1150,935)])
    p.label('tag-many', 1160, 865, 70, 50, 'N : 1', 17)
    route(p, 'card-identity', 'card-hash', 'students', [(60,950),(30,950),(30,280),(60,280)], dashed=True)
    p.label('card-boundary', 75, 770, 470, 45, '卡号仅作临时输入；以哈希关联学生', 17)
    p.label('join-many', 1410, 740, 290, 48, '关联表 → 设备：N : 1', 17)

    panel(p, 'support', 60, 1150, 1680, 310, '业务提交与可追踪性 · 逻辑关联使用对象 ID，业务更新与审计/操作结果同事务', PURPLE)
    card(p, 'ops', 85, 1230, 510, 180,
         'operations\nclientId + requestId UNIQUE\nintent_id 唯一，预览成功消费一次\n路由 / payload 摘要 / 持久结果\n重登后仍可查原提交', size=19)
    card(p, 'audit', 645, 1230, 510, 180,
         'audit_events · 受限内部审计\n共享账号 / clientId / requestId / 时间\n必要时 student_id STRING(64) FK\n无原卡号，仅必要对象 ID 与字段名\n与资料/业务更新同事务；教师不可查', size=19)
    card(p, 'logs', 1205, 1230, 510, 180,
         'app_logs · 全部来源日志\nsource + logId UNIQUE；提交后 ACK\nrequestId / scanId / recordId 关联\n无原卡号 / studentId / 完整响应\nTBD-05：保留与产品外清理', YELLOW, 19)
    note(p, 'history', 60, 1520, 800, 230,
         '历史记录 · 只读内部库\n学生字段为最近一次成功刷卡刷新的数据库值\n查看历史不请求校园 API；取消登记不撤销资料刷新\n无编辑 / 删除 / 导出；软删除设备仍可显示历史\nTBD-01：字段；TBD-05：留存', YELLOW, 20)
    note(p, 'identity', 920, 1520, 820, 230,
         'NEXT-01 · 跨卡 / 换盐迁移延期\n换卡/盐/版本会改变 studentId 主键\n需要新旧映射，迁移历史 FK / 审计 / 持久结果\n新卡可单独缓存，但不自动合并旧历史\n固定盐哈希不防枚举/克隆，不是认证秘密', YELLOW, 20)
    note(p, 'identity-protocol', 60, 1810, 1680, 165,
         '身份协议与临时卡号生命周期\nstudentId = 小写 hex(SHA-256(版本 / 固定盐 / 发行方 / UID 的有长度字节编码))\n客户端 / 服务端 / seed 共用协议；服务端由原卡号重算，不能让一个学生 ID 绑定另一张卡\n原卡号仅本次 HTTPS 查询；成功、失败、取消、超时均释放，不进入预览或离线重试', BLUE, 20)
    caption(p, '可分配 = 未软删除 + 未禁用 + 无活动记录；固定盐 hash 不等于不可枚举或不可克隆，不作为认证秘密。')
    return p


def registration():
    p = page('registration-flow', '03 · 刷卡、登记和结束的完整流程',
             '实线为事件/请求/状态流；每次提交都重新校验权限、占用和版本。教师客户端显示成功必须以服务端提交结果为准。', 1800, 2100)
    card(p, 'scan', 60, 155, 500, 150,
         '① 读卡进程 → main 立即计算 studentId\n固定盐 SHA-256；原卡号独立短时内存\n卡号不经 renderer IPC、不进日志\nWiegand-34 / 4 字节；TBD-03 实机验收', YELLOW)
    card(p, 'gate', 650, 155, 500, 150,
         '② 页面门控\n在设备列表主页面？\n无 Modal / 无提交 / 无 scan 处理中？\n全部满足才继续', BLUE)
    card(p, 'ignored', 1240, 155, 500, 150,
         '否 → 仅 Toast\n返回使用登记主页面重新刷卡\n丢弃事件，不调用外部 API\n不排队稍后重放', RED)
    route(p, 'scan-gate', 'scan', 'gate', [(560,230),(650,230)])
    route(p, 'gate-ignore', 'gate', 'ignored', [(1150,230),(1240,230)])
    card(p, 'preview', 650, 395, 500, 155,
         '③ main → 已 pin HTTPS /scan-previews\ncard + studentId / hashVersion / scanId\n服务端重算 ID 拒绝错配，记 scanAtMs\n本地有无缓存都查询校园 API\nAPI 确认学生后才创建预览', BLUE)
    down(p, 'gate-preview', 'gate', 'preview', '是')
    card(p, 'provider', 1240, 395, 500, 155,
         '本次原卡号查询校园 API\n查询/校验后释放；不入预览或队列\nTBD-02：协议/认证/拒绝语义/字段\n正常请求关联，无需额外绑定证明\nTBD-01：资料白名单；新增或覆盖缓存', YELLOW)
    route(p, 'preview-provider', 'preview', 'provider', [(1150,470),(1240,470)], both=True)
    note(p, 'failed-preview', 60, 395, 500, 155,
         'API 拒绝 / 外部失败 / 卡号 ID 错配\n失败不写缓存，不以旧缓存放行\n显示错误，重刷或返回；无手动注册\n已有记录可从内部列表手动结束', RED)
    route(p, 'preview-fail', 'preview', 'failed-preview', [(650,470),(560,470)])
    card(p, 'mode', 650, 640, 500, 120,
         '④ 学生缓存新增或覆盖单独提交\n按 studentId 返回 start/end，无原卡号\n历史只读 DB；取消不回滚缓存更新', PURPLE)
    down(p, 'preview-mode', 'preview', 'mode')

    card(p, 'register-form', 60, 865, 780, 185,
         '无活动记录 → 登记页\n只读学生摘要、刷卡时间、备注和 DevicePicker\n连续 10 秒无任何用户操作自动取消\n键盘/指针/选择/编辑重置；后台返回先检查过期\n取消不占设备、不撤销资料刷新；无补填学生入口', YELLOW, 20)
    card(p, 'end-form', 960, 865, 780, 185,
         '有活动记录 → 刷卡结束页\n固定 recordId + expectedVersion\n当前资料、设备、原开始与本次刷卡时间\n备注预填已有值；默认 5 秒自动确认\n可立即确认或取消，不结束后来新开的记录', GREEN, 20)
    route(p, 'to-start', 'mode', 'register-form', [(750,760),(750,810),(450,810),(450,865)])
    route(p, 'to-end', 'mode', 'end-form', [(1050,760),(1050,810),(1350,810),(1350,865)])
    card(p, 'picker', 60, 1140, 780, 155,
         '选择设备 · 只能选可分配设备\n占用设备：先单独确认结束，服务端成功后刷新再选\n若释放晚于本次刷卡，须重刷以避免使用时间重叠\n禁用不可选；无设备/资料缺失不可提交；冲突重新确认', BLUE, 20)
    card(p, 'end-check', 960, 1140, 780, 155,
         '刷卡结束专用 5 秒确认规则\n编辑 / 失焦 / 后台 / 网络故障 → 暂停自动提交\n回到前台需显式继续或确认\n手动单结束 / 批量 Modal 没有自动确认', BLUE, 20)
    down(p, 'form-picker', 'register-form', 'picker')
    down(p, 'form-check', 'end-form', 'end-check')
    card(p, 'start-command', 60, 1385, 780, 125,
         'POST /usage-records/start\npreviewId + deviceId + notes + requestId\n仅创建使用记录，endedAtMs = null；学生必须已存在', GREEN, 20)
    card(p, 'end-command', 960, 1385, 780, 125,
         'POST /usage-records/{id}/end\npreviewId + recordId + expectedVersion + notes + requestId\nendedAtMs 取本次 scanAtMs；提交时再验 end ≥ start', GREEN, 20)
    down(p, 'picker-start', 'picker', 'start-command')
    down(p, 'check-end', 'end-check', 'end-command')
    card(p, 'transaction', 60, 1615, 1680, 135,
         '⑤ 服务端事务 → 数据 + 审计 + 持久操作结果一起提交\n成功返回设备列表并刷新；409 冲突需重新确认，410 预览失效需重刷\n已发请求超时：保留同一 requestId 查询/重试，不把超时当失败另开新请求', PURPLE, 21)
    route(p, 'start-tx', 'start-command', 'transaction', [(450,1510),(450,1615)])
    route(p, 'end-tx', 'end-command', 'transaction', [(1350,1510),(1350,1615)])
    note(p, 'preview-rule', 60, 1825, 800, 165,
         '预览 / 幂等\n默认 2 分钟有界内存；取消释放，重启失效\nintentId 成功消费一次；同 clientId/requestId 可重试\n已提交结果不随预览失效，重新登录后仍可查询', BLUE, 20)
    note(p, 'time-rule', 920, 1825, 820, 165,
         '时间规则\nscanAtMs = 服务端接收刷卡请求的时刻\ncreatedAtMs / updatedAtMs = 实际提交时间\nJSON 为 Unix 毫秒整数；客户端时钟不定历史', BLUE, 20)
    caption(p, '登记空闲取消不撤销资料刷新或已发独立请求；刷卡结束自动确认失焦暂停。所有 UI 成功均以服务端结果为准。')
    return p


def transactions():
    p = page('record-transactions', '04 · 业务事务、并发、幂等与批量结束',
             '数据库是唯一权威；列表与 preview 都是快照。图中每列执行过程均服从底部统一锁顺序及条件唯一约束。', 1800, 2050)
    card(p, 'entry', 60, 150, 1680, 150,
         '确认入口：共享账号 / clientId / 业务 schema → operations(clientId, requestId)\n同键同摘要返回原结果；异请求拒绝；preview / batchUnit 成功消费一次\nSequelize 托管事务 + 行锁；只操作合法业务对象，不开放 admin 或机房权限', BLUE, 22)
    columns = [(60,'start','A · 开始使用'),(650,'end','B · 单条结束'),(1240,'batch','C · 批量结束')]
    for x,ident,title in columns:
        card(p, ident+'-title', x, 395, 500, 70, title, PURPLE, 21)
        route(p, 'dispatch-'+ident, 'entry', ident+'-title', [(x+250,300),(x+250,395)])
    texts = {
        'start': [
            '目标明确\npreviewId / deviceId / notes\n只允许内部已存在且启用的学生\n先刷新资料，提交时核对版本',
            '锁定与验证\n设备可分配；学生缓存版本有效\n刷卡阶段已完成 API 查询和缓存写入\n仅创建使用记录，失败整笔回滚',
            '写入\n创建 usage_record，结束时间为空\n写审计 + committed 操作结果\n条件唯一索引保证一人/一机一条',
            '提交后返回\n返回记录 ID、版本与操作 ID\n竞争失败 409；不留下半条记录\n同键重试不重复创建'],
        'end': [
            '目标明确\nrecordId + expectedVersion\n预览候选结束时间 / 已有备注\n手动结束需显式确认',
            '锁定与验证\n先读关联 ID，按统一顺序取锁\n重验关联、权限、版本、仍活动\n校验结束时间不早于开始',
            '写入\n结束时间 / 原因 / 备注 / version++\n写审计 + committed 操作结果\n不重新按学生寻找另一条记录',
            '提交后返回\n同键重复：返回原结果\n其他键已结束/改版：409\n不静默覆盖刚编辑的备注'],
        'batch': [
            '确认前已预览固定集合\n服务器解析全系统或选中/筛选范围\n固定 recordIds / versions / endedAtMs\n明确数量/筛选，之后新增不纳入',
            '显式确认 → 单批事务\n按固定 ID 排序取锁并重验每条\n任一变更：整批 409 回滚\n过期/重启失效须重新预览',
            '写入与公共备注\n空备注：保留每条原文\n非空：原文 + 换行 + 批量结束备注\n同事务审计 / batchId / 操作结果',
            '单批全成或全败\n默认最多 500 条，可配置\n超过：固定分批计划 + 逐批状态\n跨批部分完成不能显示全局成功']}
    for x, ident, title in columns:
        last = ident+'-title'
        for i, text in enumerate(texts[ident]):
            key = f'{ident}-{i}'
            card(p,key,x,545+i*245,500,165,text,GREEN if i==3 else '#ffffff',19)
            down(p, f'{ident}-step-{i}', last, key)
            last=key
    note(p,'locks',60,1555,1680,150,
         '统一锁顺序：设备 IDs 升序 → 学生 IDs 升序 → 记录 IDs 升序\n开始、结束、设备软删除、批量统一遵守；provider 调用不持数据库事务锁\n仅引用已有学生；验证资料版本与时间区间，条件唯一兜底；失败有限重试沿用原键',BLUE,21)
    note(p,'recovery',60,1775,800,165,
         '提交结果未知 · 网络中断 / 应用重启\nmain 持久保存不含 UID/hash 的提交意图\nGET /operations/{requestId} 查询结果\n未找到不证明没执行；重试仍用原键',RED,20)
    note(p,'batch-scope',920,1775,820,165,
         '范围与历史边界\n“结束全部” = 全系统全部活动记录\n选中 / 筛选结果独立按钮；公共备注追加一次\n只允许编辑活动备注，结束后历史不可修改',BLUE,20)
    caption(p,'资料刷新在刷卡阶段独立提交；业务只写已存在学生的使用记录。设备可编辑/软删除，历史只读。')
    return p


def docker():
    p = page('docker-deployment', '05 · Docker 服务端部署与运维拓扑',
             '目标是学校 Linux Docker Engine / Compose 单节点；Windows 宿主可使用 Linux VM。图中端口是设计约定，非已部署事实。', 1800, 2260)
    card(p,'client',60,155,720,145,
         '教师 Electron · 设置连接\nIP / 端口 / SHA-256 叶证书指纹 / 共享账号密码\n应用内 pin 后才发 HTTPS，不改系统证书库',GREEN,21)
    card(p,'campus',1020,155,720,145,
         '校园卡 API · 本次原卡号查询，用后释放\n固定 HTTPS 目的地，正常 TLS，拒绝重定向\nTBD-02：协议、认证、原卡号格式与字段',YELLOW,21)
    panel(p,'host',60,420,1680,1000,'Compose 项目 · frontend / backend 网络隔离 · 不发布 PostgreSQL 端口',BLUE)
    card(p,'gateway',100,530,430,165,
         'gateway · Nginx 非特权容器\n宿主 443 → 容器 8443\nTLS / body 上限 / 限速 / 日志脱敏\n刷卡 body 禁磁盘缓冲与缓存',size=20)
    card(p,'api',650,530,500,165,
         'api · Fastify / Sequelize\n内部 :3000 / 非 root / 单实例\n共享登录 + 业务 API 白名单\n无 admin、导出、服务器日志查询',size=20)
    card(p,'db',1270,530,430,165,
         'db · PostgreSQL\nbackend 内部 :5432\npgdata 命名卷 / 独立角色\n不向 LAN 发布端口',GREEN,20)
    route(p,'lan-tls','client','gateway',[(420,300),(420,365),(315,365),(315,530)])
    route(p,'proxy','gateway','api',[(530,610),(650,610)])
    route(p,'sql','api','db',[(1150,610),(1270,610)])
    route(p,'campus-outbound','api','campus',[(900,530),(900,495),(1755,495),(1755,365),(1380,365),(1380,300)])
    card(p,'secrets',100,800,430,170,
         '部署 .env + 受限挂载\nTEACHER_USERNAME / PASSWORD\n改密需重建 API；旧 token 失效\nTLS / DB / provider 秘密不进镜像',YELLOW,20)
    card(p,'spool',650,800,500,170,
         '持久日志 spool · 多个来源卷\nAPI / gateway / DB / 运维日志\n数据库不可写继续留盘\nstdout 仅作额外运维输出',GREEN,20)
    card(p,'migrate',1270,800,430,170,
         'migrate · 单次串行任务\nSequelize QueryInterface + Umzug\n版本迁移，不手写 SQL\n成功退出后 API 才启动',PURPLE,19)
    route(p,'migration-db','migrate','db',[(1485,800),(1485,695)])
    down(p,'api-spool','api','spool')
    route(p,'secret-api','secrets','api',[(530,880),(585,880),(585,720),(700,720),(700,695)],dashed=True)
    card(p,'ingest',100,1090,430,170,
         'log-ingest · 内部工作进程\n读 spool / 来源游标 / 去重\n提交 app_logs 后确认回收\n无公开端口、无 Docker socket',GREEN,19)
    card(p,'runtime',650,1090,500,170,
         '容器基线\n只读根 FS / 有界 tmpfs / 可写日志卷\ncap_drop / no-new-privileges\n固定镜像版本与 digest，SIGTERM 排空',size=19)
    card(p,'seed',1270,1090,430,170,
         '学生缓存 · API 权威\n成功刷卡新增或覆盖资料\n旧缓存仅供日常查询与历史\n没有教师注册、备份或导出服务',YELLOW,19)
    route(p,'spool-ingest','spool','ingest',[(750,970),(750,1030),(315,1030),(315,1090)],dashed=True)
    route(p,'logs-db','ingest','db',[(315,1260),(315,1290),(1195,1290),(1195,735),(1330,735),(1330,695)],dashed=True)
    route(p,'seed-db','seed','db',[(1700,1175),(1720,1175),(1720,650),(1700,650)],dashed=True)
    p.label('network-note',100,1310,1600,70,
            'frontend：gateway 与 api；backend：api / db / migrate / log-ingest\n单宿主专用网络内部 HTTP；无关容器禁入；跨宿主/不可信网络改为 TLS。仅 gateway 发布端口。',19)

    card(p,'build',60,1515,800,190,
         '镜像构建契约 · 多阶段\n固定 Node LTS / Yarn 4；install --immutable\n共享包 → server；focus 生产依赖含 Sequelize/pg\n复制 dist / 迁移 / 工作区产物，Linux 原生模块重建\n不含 Windows 依赖、UI 包、真实 .env 或个人数据',BLUE,20)
    card(p,'persist',920,1515,820,190,
         '数据与日志持久性\npgdata / spool / 游标使用独立卷\n容器重建保留业务、审计、日志、操作结果\n不做备份/导出；有需由运维在产品外手工操作\n正常升级禁止 down -v；容量告警/限写/恢复',GREEN,20)
    card(p,'startup',60,1780,1680,145,
         '启动：db healthy → ORM migrate 成功 → api ready → gateway 接入\n.env 改密后 force-recreate api，旧会话全部失效；教师用新密码重新登录\nlive 测进程；ready 测 DB/schema；provider 故障停止刷卡，历史与手动结束仍可用',PURPLE,21)
    note(p,'pending',60,1990,1680,160,
         'TBD-04：Linux / 架构 / 服务器 IP / 含 IP SAN 的叶证书与可信指纹分发 / API 放通\nTBD-05：保留期及产品外清理；不新增教师备份、导出、机房授权或管理员页面\n单节点停机时禁止新业务；认证恢复后沿原 requestId 查询，日志留盘补传',YELLOW,21)
    caption(p,'五类 Compose 服务：gateway / api / db / migrate / log-ingest；学生缓存由 API 在成功刷卡后维护。')
    return p


def teacher_ui():
    p = page('teacher-ui', '06 · 教师界面：使用登记与设置',
             '结构线框与交互规格；使用 cyez-ui 统一主题。左侧只有上下两个一级入口，设置内含连接、设备、历史和诊断。',1800,2760)
    panel(p,'shell',50,145,1700,520,'AppShell · 两个并列入口 · 共享业务账号，无管理员或机房权限',BLUE)
    card(p,'nav-top',80,225,250,80,'使用登记',GREEN,23)
    card(p,'nav-bottom',80,545,250,80,'设置',PURPLE,23)
    p.label('nav-hint',85,335,240,150,'一级入口只有两个\n设置固定于侧栏下方\n其余页面在内容区内切换',18)
    card(p,'content-head',380,225,1330,80,'当前内容页    |    服务器连接 / 认证状态    |    数据更新时间',size=21)
    card(p,'business',380,345,630,245,
         '使用登记\n使用中 / 未使用，搜索 / 标签筛选\n设备、学生、时间、备注、手动结束\n结束选中… / 结束全部记录…\n唯一允许刷卡跳转的设备列表\n全系统设备均可用，标签不授予权限',size=20)
    card(p,'settings',1060,345,650,245,
         '设置 · 内部页签\n连接配置   |   设备管理   |   历史记录   |   诊断\n连接：IP / pin / 账号密码 / 本地保存\n设备：新增、修改、删除，历史引用保留\n历史：漂亮、清晰的只读分页列表\n本页任何刷卡都只 Toast，不跳转、不查 API',size=20)
    panel(p,'connect',50,760,800,400,'设置 / 连接配置',GREEN)
    card(p,'connection-fields',80,840,740,140,
         '服务端 IP   [                 ]    端口 [443]\n叶证书 SHA-256 指纹   [规范化的 64 位十六进制]\n账号 [          ]   密码 [••••••••]   □ 记住登录',size=21)
    card(p,'connection-actions',80,1015,740,105,
         '测试连接    保存并登录    清除保存项\npin 正确后才发送密码；不安装系统自签名证书\n密码由 main OS 加密；换配置清旧网络 session',BLUE,19)
    panel(p,'devices-panel',930,760,820,400,'设置 / 设备管理',PURPLE)
    card(p,'device-controls',960,840,760,70,'新增设备…    搜索 / 标签 / 状态筛选    刷新',size=21)
    card(p,'device-table',960,945,760,175,
         '编号 / 名称      标签      状态      备注      操作\nA-001 / 电脑 1   图书馆    空闲      —        编辑 / 删除…\nA-002 / 电脑 2   东区      使用中    —        编辑\n删除确认；活动设备先结束；软删除保留历史\n编辑带版本，冲突重新加载，不能覆盖别人修改',size=19)
    panel(p,'history-panel',50,1250,1700,560,'设置 / 历史记录 · 内部数据库查询，完全只读',BLUE)
    card(p,'history-controls',80,1330,1640,70,
         '历史记录 · 总条数    日期范围 [开始—结束]    学生搜索    设备 / 标签    重置筛选',size=21)
    # Each table column is an independent native draw.io object for alignment and editing.
    headers=[('开始时间',80,275),('结束时间',355,275),('时长',630,160),('学生摘要',790,310),('设备',1100,230),('备注',1330,390)]
    rows=[['10-29 09:00','10-29 09:45','45 分钟','姓名 / 班级（示例）','A-001','正常结束'],
          ['10-29 08:10','10-29 08:40','30 分钟','姓名 / 班级（示例）','A-002','长备注省略… 点击查看完整内容']]
    for j,(title,x,w) in enumerate(headers):
        card(p,'history-col-'+str(j),x,1435,w,55,title,PURPLE,19)
        for i,row in enumerate(rows):
            card(p,f'history-cell-{i}-{j}',x,1495+i*60,w,55,row[j], '#ffffff' if i==0 else '#f2f6fc',17)
    card(p,'history-footer',80,1650,1640,110,
         '上一页   1 / …   下一页   每页条数     |     点击行 → 右侧只读详情抽屉\n固定表头 / 时间列对齐 / 长备注展开 / 键盘焦点；加载骨架、空态、重试和过期提示\n无编辑 / 删除 / 导出按钮；展示最近一次刷卡刷新后的数据库资料，不向外部 API 请求',GREEN,19)
    panel(p,'register',50,1900,530,555,'使用登记 / 登记页',GREEN)
    card(p,'reg-info',75,1985,480,170,
         '学生摘要只读 · TBD-01 字段\n每次刷卡都向校园 API 查询\n成功时新增或覆盖缓存；无手动补填\n刷卡开始时间 / 备注 / DevicePicker\n失败不以旧缓存继续登记',YELLOW,19)
    card(p,'reg-timer',75,2200,480,210,
         '连续 10 秒无操作 → 自动取消\n键盘/指针/选择/编辑等真实操作重置\n轮询、动画、合成事件不重置\n后台继续计时，返回先清过期登记\n已提交则关闭空闲计时\n取消不撤销资料刷新或已发结束请求',BLUE,18)
    panel(p,'picker-panel',635,1900,530,555,'使用登记 / 设备选择',PURPLE)
    card(p,'picker-body',660,1985,480,170,
         '空闲 → 可选；禁用 → 不可选\n占用 → 先独立确认结束，再刷新选择\n若释放晚于本次刷卡，要求重刷\n无可用设备 / 资料不齐 → 禁用确认\n提交仍由服务端重新校验',size=19)
    card(p,'picker-note',660,2200,480,210,
         '仅在设备列表收到刷卡才自动进入\n设置 / 历史 / Modal / 提交中只 Toast\n重复硬件帧不触发额外刷新\n新卡事件不替换正在处理的学生\nDevicePicker 内操作重置登记空闲\n不排队返回后自动重放刷卡',size=19)
    panel(p,'end-panel',1220,1900,530,555,'使用登记 / 结束与批量',BLUE)
    card(p,'end-card',1245,1985,480,170,
         '刷卡结束仍为 5 秒自动确认\n现有备注、原开始、本次刷卡时间\n编辑 / 失焦 / 后台暂停自动提交\n返回显式继续；按钮/到期仅提交一次\n手动单结束 Modal：无自动确认',size=19)
    card(p,'batch-card',1245,2200,480,210,
         '批量 Modal：固定列表 + 数量 + 范围\n公共备注初始为空，提交只追加一次\n结束全部 = 全系统活动记录\n单批冲突整体回滚；分批结果透明\n已结束历史不可修改或删除\nModal 内刷卡仍只 Toast',size=19)
    note(p,'visual',50,2530,1700,115,
         'cyez-ui 主题 / 间距 / 圆角 / 清晰字级；状态不只靠颜色，窄窗口筛选换行与表格横向滚动\n诊断只显示本机连接、读卡、版本与待传数量；无服务器系统日志、密钥、任意表或管理权限\nTBD-03 读卡硬件；TBD-05 保留期；TBD-06 Windows 发布材料；UI 使用授权已确认',YELLOW,20)
    caption(p,'本图是正式交互结构，不是已实现截图。所有请求经 pin 校验 HTTPS；历史页、设备页与手动结束不调用校园 API。')
    return p


def workspaces():
    p = page('ui-workspaces', '07 · Yarn 工作区、cyez-ui 与 Electron 权限边界',
             '上部为工作区组织与使用方→依赖；中部为上游→tarball 构建流；下部为本地 IPC。内部包使用 workspace:^。', 1800, 2120)
    card(p,'root',60,150,1680,140,
         '项目根 · 私有 monorepo · Yarn 4 精确版本 · 单一 yarn.lock · nodeLinker: node-modules\nworkspaces 明确覆盖 record-only/apps/* + record-only/packages/*\nCI install --immutable；共享包 exports + 编译产物；禁止跨包相对导入与双份 DTO',BLUE,22)
    card(p,'server-app',60,390,800,170,
         'record-only/apps/server · Fastify / Sequelize\nprotocol + domain；共享账号、刷卡刷新、占用事务\nAPI 成功后新增/覆盖缓存；设备编辑 / 只读历史\n通过 ORM 操作 PostgreSQL，不手写 SQL',GREEN,21)
    card(p,'teacher-app',940,390,800,170,
         'record-only/apps/teacher · Electron / React\n依赖 protocol + client-sdk + ui\nrenderer：页面；preload：受限桥；main：子进程/网络\nmain spawn apps/reader-mock；Cargo.lock 锁定原生依赖',GREEN,21)
    route(p,'root-server','root','server-app',[(460,290),(460,390)])
    route(p,'root-teacher','root','teacher-app',[(1340,290),(1340,390)])
    panel(p,'packages',60,670,1680,300,'本项目共享 packages · 边界与运行时 schema 比相同语言更重要',PURPLE)
    p.nodes = [n for n in p.nodes if n['id'] != 'packages-title']
    p.label('packages-label',75,685,160,55,'共享包\nworkspace:^',18)
    package_defs = [
        ('domain',85,'domain\n纯业务规则 / 时间 / 备注\nserver 使用；无 I/O\n不混入后续三端 Session'),
        ('protocol',500,'protocol\nDTO / schema / 错误码\n共享 studentId 编码 / 哈希\n无盐配置值或数据库连接'),
        ('sdk',915,'client-sdk\nREST / 认证 / 查询恢复\n日志批传 / ACK / 重试\n依赖 protocol'),
        ('ui',1330,'ui · 项目适配包\n主题 / 路由 / 业务组件\n依赖 @series/ui\n不包含特权系统调用')]
    for ident,x,txt in package_defs:
        card(p,ident,x,755,385,170,txt,size=19)
    route(p,'server-domain','server-app','domain',[(260,560),(260,620),(278,620),(278,755)])
    route(p,'server-protocol','server-app','protocol',[(690,560),(690,755)])
    route(p,'teacher-sdk','teacher-app','sdk',[(1105,560),(1105,755)])
    route(p,'teacher-ui','teacher-app','ui',[(1525,560),(1525,755)])
    route(p,'sdk-protocol','sdk','protocol',[(1105,925),(1105,945),(693,945),(693,925)],dashed=True)

    card(p,'ui-upstream',60,1100,800,225,
         'cyez-ui 已选定 · 上游 pnpm 工程\n@series/ui@0.1.0：. / theme / bootstrap / styles.css\napp.css / appearance-init.js；React 19 + router 7\n@series/electron@0.1.0：main / preload / shared\nElectron peer：>=39 <45；本项目固定实测兼容版本',BLUE,20)
    card(p,'vendor',940,1100,800,225,
         '受信任构建 → 固定 tarball → 本项目消费\n源提交 0a1d4f4… + 校验和 + LICENSE / NOTICE\n上游 pnpm 构建不改变本项目 Yarn 选择\nfile: / 受控制品固定依赖；不依赖上游 node_modules\n干净安装、单份 React、preload 分包、打包运行验收',GREEN,20)
    route(p,'artifact','ui-upstream','vendor',[(860,1210),(940,1210)])
    route(p,'ui-tarball','ui','vendor',[(1523,925),(1523,1100)])
    panel(p,'ipc-boundary',60,1430,1680,275,'Electron 权限边界 · cyez-ui 的窗口封装不授权业务 IPC',BLUE)
    card(p,'renderer-boundary',90,1515,490,140,
         'renderer + @series/ui\nsandbox / contextIsolation = true\nnodeIntegration = false\n无 raw UID / token / Node 系统权限',size=19)
    card(p,'preload-boundary',655,1515,490,140,
         'preload + @series/electron/preload\n有限 typed API / sender 校验\n刷卡元数据 / 业务动作 / 日志\n无任意 URL / shell / 原 UID / token',size=19)
    card(p,'main-boundary',1220,1515,490,140,
         'main + @series/electron/main\nCardReader 立即算哈希 studentId\n原卡号仅临时 HTTPS；pin / OS 保存\nSQLite 仅持久提交意图与脱敏日志',size=19)
    route(p,'renderer-preload','renderer-boundary','preload-boundary',[(580,1585),(655,1585)],both=True)
    route(p,'preload-main','preload-boundary','main-boundary',[(1145,1585),(1220,1585)],both=True)
    note(p,'release',60,1810,800,185,
         '已确认：cyez-ui 使用授权\n按固定提交 tarball 接入，保留 LICENSE/NOTICE\nTBD-06 仅 Windows 签名材料 / 发布实机验收\n上下两个一级入口：使用登记 / 设置\n不把上游验证当本项目集成通过',YELLOW,19)
    note(p,'phase',940,1810,800,185,
         '范围与延期\n无学生端 / 完整 Session 状态机\nNEXT-01：换卡/盐改变 ID，历史关联迁移延期\n无 admin、机房 ACL、备份导出、历史编辑删除\nTBD-02：真实 API 拒绝语义待确认',YELLOW,19)
    caption(p,'固定上游包已入 vendor；Yarn 4 工作区、教师应用与服务端已实现，真实外部接入按 TBD 验收。')
    return p


def testing():
    p = page('testing-pipeline', '08 · 服务端与客户端测试分层、联调及发布门禁',
             '两端单元与集成测试已运行；Mock 不能替代数据库约束、真实 Electron IPC 和打包运行。目标环境验收按 TBD 保留。', 1800, 2250)
    card(p,'source',60,150,1680,130,
         '提交 → 文档/图源一致性 → Yarn 不可变安装 → 类型/格式 → 四类独立测试报告\n服务端 S-U / S-I 与客户端 C-U / C-I 均为必需；缺少桌面或 DB 环境不能静默跳过并标绿',BLUE,22)
    panel(p,'server-tests',60,385,800,830,'服务端 · Linux CI · Vitest / Fastify / PostgreSQL',GREEN)
    panel(p,'client-tests',940,385,800,830,'客户端 · Windows CI · Vitest / 真实 Electron',PURPLE)
    card(p,'su',90,485,740,230,
         'S-U · 单元 / 确定性 fake\n由原卡号重算 studentId，错配/版本错误拒绝\n共享向量 / 前导零 / 长度编码 / 白名单\n毫秒整数、结束 ≥ 开始、活动/禁用/软删除\n共享账号、批量备注、请求摘要和错误映射\nVitest；fake clock / provider，不用真实资料',size=20)
    card(p,'cu',970,485,740,230,
         'C-U · 规则与 React 组件\n立即算 studentId；卡输入与学生 DTO 分离\n原卡号仅内存/HTTPS，无 IPC/日志/持久队列\n10 秒无操作取消，真实输入重置 / 后台检查\n结束 5 秒确认独立规则 / 一次提交门闩\n页面门控 / 设备编辑 / 历史只读 / pin 格式',size=20)
    card(p,'si',90,820,740,315,
         'S-I · Fastify → Sequelize → 真实 PostgreSQL\n哈希 PK/FK、条件索引、并发占用、行锁与迁移\nprovider 收到原卡号；错配拒绝；卡号不落库\n首次建缓存、每次覆盖；历史只读 DB\n响应丢失 / 重启 / intentId / 固定批量集合\n.env 改密失效；网关 body 无临时文件\n日志 ACK / 容量恢复 / 网络隔离',size=20)
    card(p,'ci',970,820,740,315,
         'C-I · Windows 真实 Electron / SQLite / HTTPS\nRust mock / main / preload / renderer 链路\nTLS pin 错误不得发送密码/原卡号/正文\n证书过期/SAN 错/重定向拒绝；换 pin 清 session\nOS 密码保存/清除，不可用不得回落明文\n刷卡不持久重放；卡号释放 / 10 秒空闲 / 补传\n设备 CRUD / 历史 / IPC 越权 / 打包 UI 验收',size=20)
    down(p,'su-si','su','si')
    down(p,'cu-ci','cu','ci')
    route(p,'source-server','source','server-tests',[(460,280),(460,385)])
    route(p,'source-client','source','client-tests',[(1340,280),(1340,385)])
    card(p,'e2e',60,1320,1680,185,
         'E2E · 打包教师应用 + Docker gateway / API / PostgreSQL + FakeProvider\n空缓存首次刷卡建档 → 登记 → 再刷卡覆盖 → 结束 → 历史；API 拒绝不放行\n设备增改软删除、历史只读、pin 正负例、共享改密、断网/重启/补传、迁移和卷持久性\n临时环境隔离；备份/导出/管理员/历史更正不属产品功能，业务外 API 必须拒绝',BLUE,21)
    route(p,'server-e2e','server-tests','e2e',[(460,1215),(460,1320)])
    route(p,'client-e2e','client-tests','e2e',[(1340,1215),(1340,1320)])
    card(p,'coverage',60,1610,800,220,
         '自动门禁 · 两端独立统计\nlines / statements / functions ≥85%，branches ≥80%\n身份 / 占用 / 幂等 / pin / 计时 / 刷新等 branches ≥90%\nP0 全通过，无静默跳过；flaky 重试仍须报告\n覆盖率不能代替实际行为与网络测试',GREEN,20)
    note(p,'hardware',940,1610,800,220,
         '待确认的真实输入\nTBD-02 API / 原卡号格式 / 拒绝语义\nTBD-03 真实读卡器与 UID 对照样本\nTBD-04 Linux / TLS 证书 / pin 分发\nTBD-06 Windows 签名与目标验收',YELLOW,20)
    down(p,'e2e-coverage','e2e','coverage')
    route(p,'e2e-hardware','e2e','hardware',[(1340,1505),(1340,1610)])
    card(p,'release',60,1935,1680,195,
         '发布候选：单元/集成报告 + 两端 coverage + 源版本 + 镜像 digest + 安装包验收\n上游 UI 测试不计本项目覆盖；证书 pin 必须实际握手验证，不能只 mock fetch\nTBD 阻塞的 API/硬件明确 blocked，不以模拟通过声称已部署\n集成环境应用 / Docker / PG / Electron 已验证；真实 API、USB 和目标发布仍待验收',PURPLE,21)
    route(p,'gate-release','coverage','release',[(460,1830),(460,1935)])
    route(p,'hardware-release','hardware','release',[(1340,1830),(1340,1935)])
    caption(p,'详见 testing.md 中 S-U / S-I / C-U / C-I 的逐条断言；实际通过范围、CI 与 TBD 缺口见 verification-report.md。')
    return p


FACTORIES = [overview, data_model, registration, transactions, docker, teacher_ui, workspaces, testing]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check generated sources without writing.')
    parser.add_argument('--render-dir', type=Path, help='Optional PNG previews; requires CairoSVG.')
    args = parser.parse_args()
    pages = [factory() for factory in FACTORIES]
    mxfile = ET.Element('mxfile', host='app.diagrams.net', type='device')
    outputs = {}
    for p in pages:
        engine.validate(p)
        for n in p.nodes:
            assert len(n['text'].split('\n')) * n['size'] * 1.45 <= n['h'] + 8, (p.ident, n['id'], 'text too tall')
        for e in p.edges:
            assert all(0 <= x <= p.width and 0 <= y <= p.height for x,y in e['points'])
        outputs[p.ident+'.svg'] = p.svg_text()
        p.export_drawio(mxfile)
        print(f'{p.ident}: {len(p.nodes)} nodes, {len(p.edges)} edges')
    ET.indent(mxfile, space='  ')
    outputs['architecture.drawio'] = '<?xml version="1.0" encoding="utf-8"?>\n'+ET.tostring(mxfile, encoding='unicode')+'\n'
    for name, content in outputs.items():
        path = OUT / name
        if args.check:
            assert path.exists() and path.read_text(encoding='utf-8') == content, f'Out of date: {path}'
        else:
            path.write_text(content, encoding='utf-8', newline='\n')
    if args.render_dir:
        import cairosvg
        args.render_dir.mkdir(parents=True, exist_ok=True)
        for p in pages:
            cairosvg.svg2png(bytestring=outputs[p.ident+'.svg'].encode(), write_to=str(args.render_dir / (p.ident+'.png')))


if __name__ == '__main__':
    main()
