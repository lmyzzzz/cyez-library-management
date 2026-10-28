#!/usr/bin/env python3
"""Generate the record-only design atlas; standard library, optional CairoSVG preview."""
from pathlib import Path
import argparse
import importlib.util
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parents[1]
REPO = OUT.parents[1]
spec = importlib.util.spec_from_file_location('diagram_engine', REPO / 'docs/tools/generate_diagrams.py')
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
         'USB → CardReader 适配器\nscanId / 来源 / UID 字节\nTBD-03：协议、驱动、字节序', YELLOW)
    card(p, 'renderer', 75, 420, 450, 150,
         'React renderer + cyez-ui\n设备列表 / 登记 / 结束 / 管理\n页面门控、确认、倒计时\n无原 UID、token 或数据库权限')
    card(p, 'preload', 75, 640, 450, 95,
         '受限 preload IPC\nsender + schema 校验，隔离 renderer')
    card(p, 'main', 75, 810, 450, 160,
         'Electron main · TypeScript\n读卡防抖 / 认证 / REST SDK\n原 UID 仅短期内存 → 服务端\n持久提交意图 / 操作结果恢复')
    card(p, 'outbox', 75, 1065, 450, 150,
         '本地 SQLite 日志 outbox\nmain / UI / reader / SDK / 安装日志\n稳定 logId，断网留盘\n服务端持久 ACK 后回收', GREEN)
    down(p, 'ui-ipc', 'renderer', 'preload')
    down(p, 'ipc-main', 'preload', 'main')
    down(p, 'main-logs', 'main', 'outbox')
    route(p, 'reader-main', 'reader', 'main', [(75,285),(57,285),(57,870),(75,870)])

    panel(p, 'server', 640, 145, 1120, 1140, '学校固定地址 · Linux Docker Compose', BLUE)
    card(p, 'api', 680, 230, 1040, 115,
         'HTTPS :443 → gateway → Fastify REST /api/v1\n注册 / 登录 / 预览 / 业务命令 / 查询 / 日志 ACK\n身份与机房权限、schema、限流；教师 IP 变化不影响主动请求')
    card(p, 'services', 680, 455, 480, 180,
         '业务模块 · 服务端最终判断\n学生与卡凭证 / 设备与标签\n开始 / 结束 / 批量固定集合\n预览 TTL / 幂等 / 版本 / 事务')
    card(p, 'provider', 1260, 455, 460, 180,
         '外部校园卡 API · 服务端独占\n仅未知卡需要查询\n提取白名单后释放完整响应\nTBD-01 字段 / TBD-02 接口', YELLOW)
    card(p, 'credentials', 680, 725, 480, 125,
         '身份与账号边界\n客户端身份：入网 / 日志 / 启动报告\noperator / admin：业务与机房授权')
    card(p, 'previews', 1260, 725, 460, 125,
         '短期候选 · 有界内存\npreviewId 绑定账号 + 客户端\n默认 2 分钟；重启需重刷')
    card(p, 'db', 680, 955, 1040, 160,
         'PostgreSQL · 仅 Compose 内网 :5432 · pgdata 持久卷\n学生 / 卡 HMAC / 机房 / 设备 / 标签 / 使用记录\n操作结果 + 审计同事务；全部应用与部署日志统一存储\n活动记录条件唯一索引防止一人或一机重复占用', GREEN, 21)
    down(p, 'api-services', 'api', 'services')
    route(p, 'provider-call', 'services', 'provider', [(1160,535),(1260,535)], both=True)
    route(p, 'services-db', 'services', 'db', [(920,635),(920,690),(1195,690),(1195,920),(1200,920),(1200,955)])
    down(p, 'provider-preview', 'provider', 'previews')
    route(p, 'business-http', 'main', 'api', [(525,870),(600,870),(600,290),(680,290)], both=True)
    route(p, 'log-upload', 'outbox', 'api', [(525,1140),(620,1140),(620,320),(680,320)], dashed=True)
    p.label('log-label', 690, 1150, 1010, 58,
            '客户端日志也经 HTTPS API → 去重持久提交 → 逐项 ACK\n服务端 / gateway / DB 日志另经本地 spool → 内部 log-ingest', 18)
    note(p, 'scope', 40, 1330, 840, 160,
         '范围边界\n本版无学生端、Rust、人脸识别、锁机或屏幕墙\n“结束使用”仅结束记录，故障不控制或关闭电脑\n不限制设备总数；有限分页/批次用于资源保护', BLUE, 20)
    note(p, 'privacy', 920, 1330, 840, 160,
         '统一规则\n业务失败不伪造成功；响应丢失用原 requestId 恢复\n所有已产生日志归集；无原卡号、token 或完整资料响应\n技术决策 / 来源 / 待定项详见 decisions.md', GREEN, 20)
    caption(p, '黄色：尚待外部确认的需求。蓝/绿：已决定的结构。后续三端扩展方案保留于根 docs/，不混用本版状态机。')
    return p


def data_model():
    p = page('data-model', '02 · 数据模型、关系与一致性约束',
             '实线从外键引用方指向被引用方，边旁写明基数；虚线为约束/算法说明。活动占用只从 usage_records 派生。', 1800, 1920)
    card(p, 'students', 60, 160, 500, 245,
         'students · 学生当前档案\nPK id: UUID / version / archived_at\n姓名、班级、校内学号：候选字段\nTBD-01：必填项与稳定人物键\n不存 is_using / 原 UID / 资料快照', YELLOW, 20)
    card(p, 'records', 650, 160, 500, 245,
         'usage_records · 一次使用一条\nPK id / FK student_id / FK device_id\nstarted_at / ended_at nullable\nnotes / end_reason / version\nvoided_at + reason / actor / timestamps', GREEN, 20)
    card(p, 'devices', 1240, 160, 500, 245,
         'devices · 可登记的设备资源\nPK id / FK room_id / unique code\ndisplay_name / notes / version\nis_disabled / archived_at\n占用状态来自活动记录', BLUE, 20)
    route(p, 'record-student', 'records', 'students', [(650,280),(560,280)])
    route(p, 'record-device', 'records', 'devices', [(1150,280),(1240,280)])
    p.label('student-many', 570, 200, 70, 65, 'N : 1', 17)
    p.label('device-many', 1160, 200, 70, 65, 'N : 1', 17)

    card(p, 'card', 60, 500, 500, 245,
         'student_credentials · 卡凭证别名\nPK id / FK student_id / issuer\nkey_version / uid_hmac / revoked_at\n有效 issuer + keyVersion + hmac 唯一\n同卡轮换别名归属同一 studentId', GREEN, 20)
    card(p, 'rules', 650, 500, 500, 245,
         '一致性约束\n活动 = ended_at 空 且 voided_at 空\n活动 student_id / device_id 各自唯一\nended_at ≥ started_at；FK 限制删除\n事务持对象锁检查有效时间区间不重叠', PURPLE, 20)
    card(p, 'rooms', 1240, 500, 500, 170,
         'rooms · 机房权限范围\nPK id / display_name / archived_at\n标签只作筛选，不授予机房权限', BLUE, 20)
    route(p, 'card-student', 'card', 'students', [(310,500),(310,405)])
    p.label('card-many', 325, 427, 200, 45, 'N : 1', 17)
    down(p, 'device-room', 'devices', 'rooms')
    p.label('room-many', 1500, 427, 200, 45, 'N : 1', 17)
    route(p, 'record-rules', 'records', 'rules', [(900,405),(900,500)], dashed=True)

    card(p, 'hmac', 60, 845, 500, 210,
         'HMAC-SHA-256 · 服务端秘密键\ndomain / issuer / length / UID 字节\n长度编码、字节序与前导零不能丢失\nkey 不与业务库明文放在一起\n轮换保留旧键，重刷后加新别名', BLUE, 19)
    card(p, 'tags', 650, 845, 500, 180,
         'tags · 平面标签\nPK id / normalized_name UNIQUE\ndisplay_name / archived_at / version\n不另存 deviceIds 数组', BLUE, 20)
    card(p, 'device-tags', 1240, 845, 500, 180,
         'device_tags · 唯一多对多关联\nPK (device_id, tag_id) + 两个 FK\n反向索引 (tag_id, device_id)\n设备 DTO 的 tagIds 由此投影', GREEN, 20)
    route(p, 'join-device', 'device-tags', 'devices', [(1710,845),(1770,845),(1770,365),(1740,365)])
    route(p, 'join-tag', 'device-tags', 'tags', [(1240,935),(1150,935)])
    p.label('tag-many', 1160, 865, 70, 50, 'N : 1', 17)
    route(p, 'card-hmac', 'card', 'hmac', [(310,745),(310,845)], dashed=True)
    p.label('join-many', 1410, 740, 290, 48, '关联表 → 设备：N : 1', 17)

    panel(p, 'support', 60, 1150, 1680, 310, '业务提交与可追踪性 · 逻辑关联使用对象 ID，业务更新与审计/操作结果同事务', PURPLE)
    card(p, 'ops', 85, 1230, 510, 180,
         'operations\nactorId + requestId UNIQUE\nintent_id 唯一，预览只能成功消费一次\n路由 / payload 摘要 / 持久结果\n重试先查结果再判断 preview', size=19)
    card(p, 'audit', 645, 1230, 510, 180,
         'audit_events · 追加写入\neventId / actor / client / requestId\n对象 ID / batchId / 时间 / 原因\n字段名和必要变更元数据\n不保存完整旧学生资料', size=19)
    card(p, 'logs', 1205, 1230, 510, 180,
         'app_logs · 全部来源日志\n认证 source + logId UNIQUE\nlevel / 时间 / 关联 ID / 脱敏消息\n持久提交后 ACK\nTBD-05：保留期与查询权限', YELLOW, 19)
    note(p, 'history', 60, 1520, 800, 230,
         '已确定：历史展示当前资料\nusage_records 只保存 student_id\n修改班级/姓名后旧记录也展示新资料\n归档保留历史 FK；更正/作废需 admin + 原因\nTBD-01：上线前确认字段白名单', YELLOW, 20)
    note(p, 'identity', 920, 1520, 820, 230,
         'NEXT-01 · 明确延期：跨卡身份合并\n首版换卡视为另一位学生，不按姓名班级合并\nHMAC 是化名化，不能防克隆卡或代刷\nTBD-05：资料/记录/日志留存与导出规则\nJSON 用 Unix 毫秒整数；DB 用 timestamptz', YELLOW, 20)
    caption(p, '可分配 = 未归档 + 未禁用 + 无活动记录。禁用与占用可并存；禁止维护第二套占用真值。')
    return p


def registration():
    p = page('registration-flow', '03 · 刷卡、登记和结束的完整流程',
             '实线为事件/请求/状态流；每次提交都重新校验权限、占用和版本。教师客户端显示成功必须以服务端提交结果为准。', 1800, 2100)
    card(p, 'scan', 60, 155, 500, 150,
         '① USB 事件 → main\n防抖 / scanId / 短期持有 UID\nrenderer 只收到 scan 元数据\nTBD-03：协议 / 驱动 / UID 格式', YELLOW)
    card(p, 'gate', 650, 155, 500, 150,
         '② 页面门控\n在设备列表主页面？\n无 Modal / 无提交 / 无 scan 处理中？\n全部满足才继续', BLUE)
    card(p, 'ignored', 1240, 155, 500, 150,
         '否 → 只显示 Toast\n“请返回主页面以触发登记”\n释放卡号；不调用 provider\n不排队稍后自动重放', RED)
    route(p, 'scan-gate', 'scan', 'gate', [(560,230),(650,230)])
    route(p, 'gate-ignore', 'gate', 'ignored', [(1150,230),(1240,230)])
    card(p, 'preview', 650, 395, 500, 155,
         '③ main → POST /scan-previews\n服务端记录 scanAtMs\nHMAC 查找凭证 / 当前学生 / 活动记录\n创建账号+客户端绑定的短期 preview', BLUE)
    down(p, 'gate-preview', 'gate', 'preview', '是')
    card(p, 'provider', 1240, 395, 500, 155,
         '仅未知卡 → 校园卡 API\n超时/有限重试；白名单候选资料\nTBD-02 接口；TBD-01 字段\n失败不创建学生/记录', YELLOW)
    route(p, 'preview-provider', 'preview', 'provider', [(1150,470),(1240,470)], both=True)
    note(p, 'failed-preview', 60, 395, 500, 155,
         '预览失败 / 资料不足\n显示可恢复错误，允许重刷或取消\n无卡号磁盘缓存，无离线登记\n已知可用档案无需每次访问 provider', RED)
    route(p, 'preview-fail', 'preview', 'failed-preview', [(650,470),(560,470)])
    card(p, 'mode', 650, 640, 500, 120,
         '④ 服务端明确返回 mode\n是否有该学生的活动记录？\n禁止以客户端缓存决定切换', PURPLE)
    down(p, 'preview-mode', 'preview', 'mode')

    card(p, 'register-form', 60, 865, 780, 185,
         '无活动记录 → 登记页\n显示当前资料、刷卡时间、备注和 DevicePicker\n未知学生仅填写白名单补充字段；TBD-01 最终 schema\n资料和界面就绪后 5 秒自动取消；可立即确认\n取消只释放 preview，不创建档案或占用', YELLOW, 20)
    card(p, 'end-form', 960, 865, 780, 185,
         '有活动记录 → 刷卡结束页\n固定 recordId + expectedVersion\n当前资料、设备、原开始与本次刷卡时间\n备注预填已有值；默认 5 秒自动确认\n可立即确认或取消，不结束后来新开的记录', GREEN, 20)
    route(p, 'to-start', 'mode', 'register-form', [(750,760),(750,810),(450,810),(450,865)])
    route(p, 'to-end', 'mode', 'end-form', [(1050,760),(1050,810),(1350,810),(1350,865)])
    card(p, 'picker', 60, 1140, 780, 155,
         '选择设备 · 只能选可分配设备\n占用设备：先单独确认结束，服务端成功后刷新再选\n若释放晚于本次刷卡，须重刷以避免使用时间重叠\n禁用不可选；无设备/资料缺失不可提交；冲突重新确认', BLUE, 20)
    card(p, 'end-check', 960, 1140, 780, 155,
         '提交门闩 · 按钮与计时器共用\n编辑 / 失焦 / 后台 / 网络故障 → 暂停自动动作\n回到前台需显式继续或确认\n手动单结束 / 批量 Modal 没有自动确认', BLUE, 20)
    down(p, 'form-picker', 'register-form', 'picker')
    down(p, 'form-check', 'end-form', 'end-check')
    card(p, 'start-command', 60, 1385, 780, 125,
         'POST /usage-records/start\npreviewId + deviceId + notes + requestId\n未知学生与使用记录同事务创建，endedAtMs = null', GREEN, 20)
    card(p, 'end-command', 960, 1385, 780, 125,
         'POST /usage-records/{id}/end\npreviewId + recordId + expectedVersion + notes + requestId\nendedAtMs 取本次 scanAtMs；提交时再验 end ≥ start', GREEN, 20)
    down(p, 'picker-start', 'picker', 'start-command')
    down(p, 'check-end', 'end-check', 'end-command')
    card(p, 'transaction', 60, 1615, 1680, 135,
         '⑤ 服务端事务 → 数据 + 审计 + 持久操作结果一起提交\n成功返回设备列表并刷新；409 冲突需重新确认，410 预览失效需重刷\n已发请求超时：保留同一 requestId 查询/重试，不把超时当失败另开新请求', PURPLE, 21)
    route(p, 'start-tx', 'start-command', 'transaction', [(450,1510),(450,1615)])
    route(p, 'end-tx', 'end-command', 'transaction', [(1350,1510),(1350,1615)])
    note(p, 'preview-rule', 60, 1825, 800, 165,
         '预览生命期\n默认 2 分钟；有界内存；取消释放 / TTL 兜底\n重启失效；已提交结果不随 preview 失效而消失\n成功事务持久消费 intentId，换请求键也不可复用', BLUE, 20)
    note(p, 'time-rule', 920, 1825, 820, 165,
         '时间规则\nscanAtMs = 服务端接收刷卡请求的时刻\ncreatedAtMs / updatedAtMs = 实际提交时间\nJSON 为 Unix 毫秒整数；客户端时钟不定历史', BLUE, 20)
    caption(p, '自动动作仅发生在可交互的刷卡页面；离开页面清理旧计时器。收到新刷卡不替换正在编辑的学生。')
    return p


def transactions():
    p = page('record-transactions', '04 · 业务事务、并发、幂等与批量结束',
             '数据库是唯一权威；列表与 preview 都是快照。图中每列执行过程均服从底部统一锁顺序及条件唯一约束。', 1800, 2050)
    card(p, 'entry', 60, 150, 1680, 150,
         '确认提交入口：验证账号 / client / 机房范围 / schema → 查 operations(actorId, requestId)\n已有同路由同摘要：返回原结果；同键异请求拒绝；preview / batchUnit 只成功消费一次\n新请求：验证预览绑定/TTL，开始事务并占用幂等键；先查结果再检查过期 preview', BLUE, 22)
    columns = [(60,'start','A · 开始使用'),(650,'end','B · 单条结束'),(1240,'batch','C · 批量结束')]
    for x,ident,title in columns:
        card(p, ident+'-title', x, 395, 500, 70, title, PURPLE, 21)
        route(p, 'dispatch-'+ident, 'entry', ident+'-title', [(x+250,300),(x+250,395)])
    texts = {
        'start': [
            '目标明确\npreviewId / deviceId / notes\n未知学生补充字段仅限白名单\n不从姓名班级猜测身份',
            '锁定与验证\n设备可分配；学生未归档且无占用\n未知卡：同事务插入学生/凭证\n任一凭证别名冲突整笔回滚',
            '写入\n创建 usage_record，结束时间为空\n写审计 + committed 操作结果\n条件唯一索引保证一人/一机一条',
            '提交后返回\n返回记录 ID、版本与操作 ID\n竞争失败 409；无孤儿档案\n同键重试不重复创建'],
        'end': [
            '目标明确\nrecordId + expectedVersion\n预览候选结束时间 / 完整备注值\n手动结束需显式确认',
            '锁定与验证\n先读关联 ID，按统一顺序取锁\n重验关联、权限、版本、仍活动\n校验结束时间不早于开始',
            '写入\n结束时间 / 原因 / 备注 / version++\n写审计 + committed 操作结果\n不重新按学生寻找另一条记录',
            '提交后返回\n同键重复：返回原结果\n其他键已结束/改版：409\n不静默覆盖刚编辑的备注'],
        'batch': [
            '确认前已预览固定集合\n服务器解析有权机房与筛选范围\n保存 recordIds + versions + endedAtMs\n明确数量/机房，之后新增不纳入',
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
         '统一锁顺序：设备 IDs 升序 → 学生 IDs 升序 → 记录 IDs 升序\n开始、结束、归档、更正、批量都遵守；关联被改则回滚重预览，不临时反向加锁\n未知卡在设备锁后创建新学生；凭证/活动唯一冲突整笔回滚；死锁有限重试沿用原 requestId',BLUE,21)
    note(p,'recovery',60,1775,800,165,
         '提交结果未知 · 网络中断 / 应用重启\nmain 先持久保存不含 UID 的提交意图\nGET /operations/{requestId} 查询结果\n未找到不证明没执行；重试仍用原键',RED,20)
    note(p,'batch-scope',920,1775,820,165,
         '范围和备注必须可解释\n“结束全部”= 账号授权范围全部活动记录\n“结束筛选结果”/“结束选中”使用不同按钮\n批量初始备注为空；追加由服务端执行一次',BLUE,20)
    caption(p,'失败事务不会留下半个学生/使用记录；不允许 raw CRUD 绕过业务命令。归档、历史更正、作废均保留审计。')
    return p


def docker():
    p = page('docker-deployment', '05 · Docker 服务端部署与运维拓扑',
             '目标是学校 Linux Docker Engine / Compose 单节点；Windows 宿主可使用 Linux VM。图中端口是设计约定，非已部署事实。', 1800, 2260)
    card(p,'client',60,155,720,145,
         '教师 Windows Electron\n受信任校内证书 / client 身份 + 操作账号\n只访问固定服务器 HTTPS :443',GREEN,21)
    card(p,'campus',1020,155,720,145,
         '外部校园卡 API\n仅 api 受控出口可访问，凭证仅服务端持有\nTBD-02：主机 / 认证 / 限额 / 错误与 SLA',YELLOW,21)
    panel(p,'host',60,420,1680,1000,'Compose 项目 · frontend / backend 网络隔离 · 不发布 PostgreSQL 端口',BLUE)
    card(p,'gateway',100,530,430,165,
         'gateway · Nginx 非特权容器\n宿主 443 → 容器 8443\nTLS / body 上限 / 限速\n覆写代理头 / 访问日志脱敏',size=20)
    card(p,'api',650,530,500,165,
         'api · Fastify 生产镜像\n仅内部 :3000 / 非 root\n业务 + 账号鉴权 + runtime schema\n运行账号仅必要数据库 DML',size=20)
    card(p,'db',1270,530,430,165,
         'db · PostgreSQL\nbackend 内部 :5432\npgdata 命名卷 / 独立角色\n不向 LAN 发布端口',GREEN,20)
    route(p,'lan-tls','client','gateway',[(420,300),(420,365),(315,365),(315,530)])
    route(p,'proxy','gateway','api',[(530,610),(650,610)])
    route(p,'sql','api','db',[(1150,610),(1270,610)])
    route(p,'campus-outbound','api','campus',[(900,530),(900,495),(1755,495),(1755,365),(1380,365),(1380,300)])
    card(p,'secrets',100,800,430,170,
         'secrets · /run/secrets/*\nDB / HMAC / provider / TLS\n宿主文件挂载，不自带加密\n镜像/日志/源码中没有秘密',YELLOW,20)
    card(p,'spool',650,800,500,170,
         '持久日志 spool · 多个来源卷\nAPI / gateway / DB / 运维日志\n数据库不可写继续留盘\nstdout 仅作额外运维输出',GREEN,20)
    card(p,'migrate',1270,800,430,170,
         'migrate · 一次性任务\n与 API 同版镜像 / 独立 DDL 账号\n迁移锁 + 版本化 migration\n成功退出后 API 才启动',PURPLE,19)
    route(p,'migration-db','migrate','db',[(1485,800),(1485,695)])
    down(p,'api-spool','api','spool')
    route(p,'secret-api','secrets','api',[(530,880),(585,880),(585,720),(700,720),(700,695)],dashed=True)
    card(p,'ingest',100,1090,430,170,
         'log-ingest · 内部工作进程\n读 spool / 来源游标 / 去重\n提交 app_logs 后确认回收\n无公开端口、无 Docker socket',GREEN,19)
    card(p,'runtime',650,1090,500,170,
         '容器基线\n只读根 FS / 有界 tmpfs / 可写日志卷\ncap_drop / no-new-privileges\n固定镜像版本与 digest，SIGTERM 排空',size=19)
    card(p,'backup',1270,1090,430,170,
         'backup · 运维 profile / 调度\n独立凭证 / 匹配 PG 版本\n一致备份 + 必要 WAL/PITR\n加密发送校外或异盘目的地',GREEN,19)
    route(p,'spool-ingest','spool','ingest',[(750,970),(750,1030),(315,1030),(315,1090)],dashed=True)
    route(p,'logs-db','ingest','db',[(315,1260),(315,1290),(1195,1290),(1195,735),(1330,735),(1330,695)],dashed=True)
    route(p,'backup-db','backup','db',[(1700,1175),(1720,1175),(1720,650),(1700,650)],dashed=True)
    p.label('network-note',100,1310,1600,70,
            'frontend：gateway 与 api；backend：api / db / migrate / log-ingest / backup\n同宿主受控网络内部 HTTP；跨不可信网络改为 TLS。容器重启不能代替业务恢复和数据库迁移。',19)

    card(p,'build',60,1515,800,190,
         '镜像构建契约 · 多阶段\n固定 Node LTS / Yarn 4；install --immutable\n共享包 → server 构建；workspaces focus 生产依赖\n复制 dist + 依赖工作区产物，Linux 原生模块重建\n不把 UI 包、Windows node_modules 或秘密放进镜像',BLUE,20)
    card(p,'persist',920,1515,820,190,
         '持久化与备份契约\npgdata / 各来源 spool / 收集游标独立卷\n业务、审计、日志、操作结果都须可恢复\n备份包含加密密钥材料和未交接日志；恢复实测\n普通升级严禁 down -v；同盘副本不是灾备',GREEN,20)
    card(p,'startup',60,1780,1680,145,
         '启动门禁：db healthy → migrate 成功 → api ready → gateway 接入\n/health/live：事件循环；/health/ready：DB、schema、必要写入条件；运行中仍处理 DB 断线\n迁移失败阻断；发布前备份，扩展—迁移—收缩；回旧镜像不等于撤销数据库迁移',PURPLE,21)
    note(p,'pending',60,1990,1680,160,
         'TBD-04：Linux 发行版 / 架构 / TLS 发放 / API 放通 / 备份位置 / RPO / RTO\nTBD-05：资料、记录、日志保留期和授权导出 / 归档规则\n单节点不承诺零停机；停机时禁止新业务，已发请求沿用 requestId，日志保留到恢复补传',YELLOW,21)
    caption(p,'本轮交付部署设计，Dockerfile / Compose / migration 与容器测试在业务实现阶段落地；没有虚构可运行的应用镜像。')
    return p


def teacher_ui():
    p = page('teacher-ui', '06 · 教师界面结构与交互细节',
             '正式结构线框图：以 cyez-ui 实现主题、导航、表单和 Modal；数字与设备名仅作示意，最终学生字段仍待定。', 1800, 2220)
    panel(p,'list-screen',60,150,1680,690,'A · 设备列表主页面 · 唯一接收刷卡自动跳转的页面',BLUE)
    card(p,'shell',90,230,1620,70,
         '图书馆登记   |   当前账号 / 角色   |   有权机房范围   |   在线 / 离线   |   数据更新时间',size=21)
    card(p,'navigation',90,330,260,450,
         '导航\n设备列表\n使用记录\n学生管理\n设备 / 标签\n账号与机房\n设置 / 诊断\n\n管理入口按角色显示',size=20)
    card(p,'filters',390,330,1320,80,
         '使用中  |  未使用     机房 ▼   标签 ▼   搜索   刷新     结束选中…   结束全部记录…',size=20)
    card(p,'list',390,440,1320,230,
         '选择    设备 / 机房 / 标签     学生摘要     开始时间 / 时长     备注     操作\n□        A-001 / 图书馆       当前资料       10:20 / 18 分钟       查看     手动结束…\n□        A-002 / 图书馆       当前资料       10:25 / 13 分钟       编辑…    手动结束…\n使用中且禁用：仍显示占用，同时标注“已禁用，不可再次分配”\n未使用选项卡：空闲可分配与禁用明确区分，状态不只使用颜色',size=20)
    card(p,'list-status',390,700,1320,80,
         '已选条数 / 总条数 · 分页     |     断线保留过期视图，禁用业务写入，恢复后刷新',GREEN,20)
    p.label('list-modal-note',60,865,1680,60,
            '刷卡门控：主页面 + 无 Modal + 无提交 + 无 scan 处理中；其余场景只 Toast，要求回主页面重新刷卡。',21,fill=YELLOW)

    panel(p,'registration',60,1015,520,775,'B · 登记页 / 刷卡结束页',GREEN)
    card(p,'summary',85,1100,470,150,
         'StudentSummary\n姓名 / 班级 / 校内学号：候选\nTBD-01：最终字段与必填项\n未知学生仅补充允许的字段',YELLOW,19)
    card(p,'times',85,1285,470,110,
         '时间与备注\n开始：本次刷卡时间，备注可空\n结束：原开始/本次结束，已有备注',size=19)
    card(p,'choice',85,1430,470,105,
         '登记：打开 DevicePicker →\n结束：固定设备 / recordId / version\n不自动替换成另一条新记录',size=19)
    card(p,'timer',85,1570,470,175,
         '取消   |   确认\n登记：5 秒后自动取消\n刷卡结束：5 秒后自动确认\n编辑/失焦暂停；回前台显式继续\n资料缺失/未选设备不可确认',BLUE,19)

    panel(p,'device-picker',640,1015,520,775,'C · DevicePicker · 可搜索分页',PURPLE)
    card(p,'picker-filter',665,1100,470,75,'机房 / 标签 / 搜索 / 状态筛选',size=20)
    card(p,'free',665,1220,470,105,
         '○ A-003 · 空闲 · 可选择\n显示设备名、机房、标签\n选择状态明确，键盘可操作',GREEN,19)
    card(p,'busy',665,1370,470,140,
         'A-004 · 使用中 · 不可直接选\n[结束占用…] → 独立确认 Modal\n提交成功 → 刷新；释放晚于刷卡须重刷\n登记和结束是两个明确动作',BLUE,19)
    card(p,'disabled',665,1555,470,105,
         'A-005 · 禁用 · 不可选\n显示原因，不与空闲混淆\n提交时服务端再次检查',RED,19)
    p.label('picker-hint',665,1690,470,55,'没有可分配设备 → 提示并禁用确认',18)

    panel(p,'modal',1220,1015,520,775,'D · 手动 / 批量结束 Modal',BLUE)
    card(p,'single-modal',1245,1100,470,140,
         '手动单结束\n复用结束页表单，加载已有备注\n固定记录版本；显式确认\n没有 5 秒自动提交',size=19)
    card(p,'batch-modal',1245,1285,470,190,
         '批量结束 · 范围 / 条数 / 机房\n紧凑设备 + 学生 + 开始时间列表\n公共备注初始为空，只追加不覆盖\n后续新增不入固定集合\n取消   |   明确确认结束 N 条',size=19)
    card(p,'batch-status',1245,1520,470,120,
         '冲突：整批回滚，重新预览确认\n超批次上限：显示逐批状态\n已成功批次不重复执行',RED,19)
    card(p,'focus',1245,1680,470,65,'焦点限制 / 关闭恢复 / 刷卡只 Toast',size=18)

    note(p,'admin',60,1870,800,220,
         '其他管理页面\n记录：筛选、分页、导出；更正/作废需 admin + 原因\n学生 / 设备 / 标签：单条与批量预览、归档、版本冲突\nTBD-01：学生表单和 CSV 模板；TBD-05：权限与保留\n旧记录显示学生最新资料，不保存学生快照',YELLOW,20)
    note(p,'diagnostics',920,1870,820,220,
         '诊断与界面安全\n服务器 / TLS / 版本 / reader 状态 / 待传日志数\nTBD-03：实际 reader 协议、驱动与型号\n不显示 UID / HMAC / token；不执行任意 shell\nLoading / 空态 / 错误 / 冲突 / 离线都提供清晰反馈',YELLOW,20)
    caption(p,'线框图不声称已实现 cyez-ui 页面。主题与窗口能力由库提供，登记规则、权限和业务组件由本项目实现与测试。')
    return p


def workspaces():
    p = page('ui-workspaces', '07 · Yarn 工作区、cyez-ui 与 Electron 权限边界',
             '上部为工作区组织与使用方→依赖；中部为上游→tarball 构建流；下部为本地 IPC。内部包使用 workspace:^。', 1800, 2120)
    card(p,'root',60,150,1680,140,
         '项目根 · 私有 monorepo · Yarn 4 精确版本 · 单一 yarn.lock · nodeLinker: node-modules\nworkspaces 明确覆盖 record-only/apps/* + record-only/packages/*\nCI install --immutable；共享包 exports + 编译产物；禁止跨包相对导入与双份 DTO',BLUE,22)
    card(p,'server-app',60,390,800,170,
         'record-only/apps/server · Node / Fastify\n依赖 protocol + domain；最终业务判断在服务端\n认证 / HMAC / preview / 占用事务 / provider / 日志\n不依赖 Electron / React / UI 包',GREEN,21)
    card(p,'teacher-app',940,390,800,170,
         'record-only/apps/teacher · Electron / React\n依赖 protocol + client-sdk + ui\nrenderer：页面；preload：受限桥；main：读卡/网络\n不导入服务端数据库或复制占用业务事务',GREEN,21)
    route(p,'root-server','root','server-app',[(460,290),(460,390)])
    route(p,'root-teacher','root','teacher-app',[(1340,290),(1340,390)])
    panel(p,'packages',60,670,1680,300,'本项目共享 packages · 边界与运行时 schema 比相同语言更重要',PURPLE)
    p.nodes = [n for n in p.nodes if n['id'] != 'packages-title']
    p.label('packages-label',75,685,160,55,'共享包\nworkspace:^',18)
    package_defs = [
        ('domain',85,'domain\n纯业务规则 / 时间 / 备注\nserver 使用；无 I/O\n不混入后续三端 Session'),
        ('protocol',500,'protocol\nDTO / schema / 错误码\n毫秒整数 / 版本 / 幂等\n不含秘密或数据库连接'),
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
         'preload + @series/electron/preload\n有限 typed API / sender 校验\n刷卡元数据 / 业务意图 / 日志\n不暴露任意 channel / URL / shell',size=19)
    card(p,'main-boundary',1220,1515,490,140,
         'main + @series/electron/main\n系统安全存储 / REST / reader\n本地 SQLite 意图与日志\nprovider 凭证只在服务端',size=19)
    route(p,'renderer-preload','renderer-boundary','preload-boundary',[(580,1585),(655,1585)],both=True)
    route(p,'preload-main','preload-boundary','main-boundary',[(1145,1585),(1220,1585)],both=True)
    note(p,'release',60,1810,800,185,
         'TBD-06 · 发布输入\n库选择已确定；代码/二进制使用分发许可需留证\n上游 LICENSE/NOTICE 保留权利，未重新开源\nWindows 签名材料、安装/卸载与 DPI 实机验收\n本轮不复制上游源码，不声明已经集成通过',YELLOW,19)
    note(p,'phase',940,1810,800,185,
         '范围和后续扩展\n本阶段不引入学生端 / Rust / 完整 Session 状态机\nNEXT-01：跨卡合并与历史迁移明确延期\n当前卡是唯一业务身份，内部 UUID 不等于跨卡识别\n后续共享包复用须审查业务语义是否相同',YELLOW,19)
    caption(p,'上游提交与包入口已核对；应用目录和脚本为实施契约，当前文档仓库尚未创建运行中的工作区或应用。')
    return p


def testing():
    p = page('testing-pipeline', '08 · 服务端与客户端测试分层、联调及发布门禁',
             '两端分别具备单元与集成测试；Mock 不能替代数据库约束、真实 Electron IPC 和打包运行。当前均为待实施验收计划。', 1800, 2250)
    card(p,'source',60,150,1680,130,
         '提交 → 文档/图源一致性 → Yarn 不可变安装 → 类型/格式 → 四类独立测试报告\n服务端 S-U / S-I 与客户端 C-U / C-I 均为必需；缺少桌面或 DB 环境不能静默跳过并标绿',BLUE,22)
    panel(p,'server-tests',60,385,800,830,'服务端 · Linux CI · Vitest / Fastify / PostgreSQL',GREEN)
    panel(p,'client-tests',940,385,800,830,'客户端 · Windows CI · Vitest / 真实 Electron',PURPLE)
    card(p,'su',90,485,740,230,
         'S-U · 单元测试 / 确定性 fake\nUID 规范化 / HMAC / keyVersion / 不泄漏敏感输入\n毫秒整数、时区、结束 ≥ 开始\n活动/禁用/归档、权限、白名单与当前资料\n批量备注精确追加、空备注、请求摘要和错误映射\nVitest；假时钟/ID/provider，不连接真实校园资料',size=20)
    card(p,'cu',970,485,740,230,
         'C-U · 纯规则与 React 组件单元测试\n主页面 / Modal / 提交中刷卡门控\n同卡重复、双卡交错、防抖和异常帧\n5 秒默认动作、失焦暂停、按钮/计时器竞争\nDevicePicker / 批量范围 / DTO / IPC schema\nVitest + Testing Library；fake clock / reader / network',size=20)
    card(p,'si',90,820,740,315,
         'S-I · 真实 PostgreSQL + 路由 / TLS 集成\nFastify inject → 服务 → repository → 临时 PG\n并发占用 / 时间重叠 / 锁顺序 / HMAC 轮换\n响应丢失 / 重启重试 / 预览单次消费 / 版本冲突\n固定批量集合、后来新增、单条变更整批回滚\nprovider 失败、权限越界、日志 ACK / DB 不可写\n空库/升级 migration、备份还原、真实 gateway 请求',size=20)
    card(p,'ci',970,820,740,315,
         'C-I · 真实 Electron main / preload / renderer\nWindows + 固定 Playwright Electron（实验性）\n临时 userData + 实际 SQLite + 可控 HTTP 服务\nFakeCardReader 经真实 IPC / Modal 焦点 / 路由\n断网、token 过期、kill/restart 后查询提交结果\n日志重启补传 / ACK 丢失 / 磁盘失败 / IPC 越权\ntarball 干净消费与打包可执行文件运行',size=20)
    down(p,'su-si','su','si')
    down(p,'cu-ci','cu','ci')
    route(p,'source-server','source','server-tests',[(460,280),(460,385)])
    route(p,'source-client','source','client-tests',[(1340,280),(1340,385)])
    card(p,'e2e',60,1320,1680,185,
         'E2E · 打包教师应用 + Docker gateway / API / PostgreSQL + FakeProvider\n未知卡 → 补充资料 → 选设备 → 登记 → 再刷卡结束；已知卡、取消、手动/批量结束\n两教师争用、后建记录排除、断网/重启/补传、迁移、SIGTERM、卷持久性与备份恢复\n测试环境唯一 project/db/userData，禁止指向生产；记录 seed、版本、trace 与失败截图',BLUE,21)
    route(p,'server-e2e','server-tests','e2e',[(460,1215),(460,1320)])
    route(p,'client-e2e','client-tests','e2e',[(1340,1215),(1340,1320)])
    card(p,'coverage',60,1610,800,220,
         '自动门禁 · 两端独立统计\nlines / statements / functions ≥85%，branches ≥80%\n身份 / 占用 / 幂等 / 权限 / 计时 / 备注 branches ≥90%\nP0 场景全通过，无静默跳过；flaky 重试仍须报告\n阈值是项目选择；不以覆盖率代替集成行为清单',GREEN,20)
    note(p,'hardware',940,1610,800,220,
         '真实硬件与发布门禁\nTBD-02：真实校园 API 契约 / 配额 / 错误\nTBD-03：USB 协议 / 拔插 / 驱动 / UID 实机验证\nTBD-04：Linux / TLS / 备份恢复目标环境\nTBD-06：许可 / Windows 签名 / 安装卸载 / DPI',YELLOW,20)
    down(p,'e2e-coverage','e2e','coverage')
    route(p,'e2e-hardware','e2e','hardware',[(1340,1505),(1340,1610)])
    card(p,'release',60,1935,1680,195,
         '发布候选：测试报告 + 两端 coverage + 构建版本 + 镜像 digest + 安装包签名 + 运维验证记录\n第三方包与生成代码不计本项目覆盖率；上游 UI 的测试通过不能替代本项目用例\nTBD 阻塞的真实场景单独标 blocked，不以模拟通过声称已验证硬件\n当前交付只验证文档与图表；应用单元、集成、E2E 和 Docker 运行验收均尚未执行',PURPLE,21)
    route(p,'gate-release','coverage','release',[(460,1830),(460,1935)])
    route(p,'hardware-release','hardware','release',[(1340,1830),(1340,1935)])
    caption(p,'详见 testing.md 中 S-U / S-I / C-U / C-I 的逐条断言；测试脚本随业务实现提交，本轮不伪造脚手架或通过结果。')
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
