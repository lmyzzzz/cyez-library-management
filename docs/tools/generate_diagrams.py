#!/usr/bin/env python3
"""Generate the editable draw.io atlas and matching SVGs. Python standard library only."""
from pathlib import Path
import html
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs'
FONT = 'Microsoft YaHei'


class Page:
    def __init__(self, ident, title, subtitle, width, height):
        self.ident, self.title, self.subtitle = ident, title, subtitle
        self.width, self.height = width, height
        self.nodes, self.edges = [], []

    def box(self, ident, x, y, w, h, text, fill='#ffffff', stroke='#cbd5e1', size=18, bold=False, align='center', kind='box'):
        node = dict(id=ident, x=x, y=y, w=w, h=h, text=text, fill=fill, stroke=stroke,
                    size=size, bold=bold, align=align, kind=kind)
        self.nodes.append(node)
        return node

    def label(self, ident, x, y, w, h, text, size=17, fill='none', bold=False, align='center'):
        return self.box(ident, x, y, w, h, text, fill=fill, stroke='none', size=size, bold=bold, align=align, kind='label')

    def edge(self, ident, source, target, points, both=False, dashed=False, arrow=True):
        self.edges.append(dict(id=ident, source=source, target=target, points=points,
                               both=both, dashed=dashed, arrow=arrow))

    def svg_text(self):
        esc = html.escape
        chunks = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}" role="img" aria-labelledby="title desc">',
                  f'<title id="title">{esc(self.title)}</title><desc id="desc">{esc(self.subtitle)}</desc>',
                  '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker></defs>',
                  f'<rect width="{self.width}" height="{self.height}" fill="#ffffff"/>']

        def draw_node(n):
            if n['kind'] != 'label' or n['fill'] != 'none':
                chunks.append(f'<rect x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" rx="10" fill="{n["fill"]}" stroke="{n["stroke"]}" stroke-width="1.5"/>')
            lines = n['text'].split('\n')
            lh = n['size'] * 1.45
            tx = n['x'] + (18 if n['align'] == 'left' else n['w'] / 2)
            ty = n['y'] + n['h'] / 2 - (len(lines) - 1) * lh / 2 + n['size'] * .35
            anchor = 'start' if n['align'] == 'left' else 'middle'
            for i, line in enumerate(lines):
                chunks.append(f'<text x="{tx}" y="{ty + i * lh}" text-anchor="{anchor}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="{n["size"]}" font-weight="{600 if n["bold"] else 400}" fill="#172b4d">{esc(line)}</text>')

        for n in self.nodes:
            if n['kind'] == 'panel':
                draw_node(n)
        for e in self.edges:
            attrs = ' marker-end="url(#arrow)"' if e['arrow'] else ''
            if e['both']:
                attrs += ' marker-start="url(#arrow)"'
            if e['dashed']:
                attrs += ' stroke-dasharray="6 5"'
            points = ' '.join(f'{x},{y}' for x, y in e['points'])
            chunks.append(f'<polyline points="{points}" fill="none" stroke="#475569" stroke-width="2" stroke-linejoin="round"{attrs}/>')
        for n in self.nodes:
            if n['kind'] != 'panel':
                draw_node(n)
        chunks.append('</svg>')
        return '\n'.join(chunks) + '\n'

    def export_drawio(self, mxfile):
        diag = ET.SubElement(mxfile, 'diagram', id=self.ident, name=self.title)
        model = ET.SubElement(diag, 'mxGraphModel', dx=str(self.width), dy=str(self.height), grid='1', gridSize='10', guides='1', tooltips='1', connect='1', arrows='1', fold='1', page='1', pageScale='1', pageWidth=str(self.width), pageHeight=str(self.height), math='0', shadow='0')
        root = ET.SubElement(model, 'root')
        ET.SubElement(root, 'mxCell', id='0')
        ET.SubElement(root, 'mxCell', id='1', parent='0')
        lookup = {n['id']: n for n in self.nodes}

        def add_node(n):
            style = f'rounded=1;whiteSpace=wrap;html=0;fillColor={n["fill"]};strokeColor={n["stroke"]};strokeWidth=1.5;fontColor=#172b4d;fontFamily={FONT};fontSize={n["size"]};fontStyle={1 if n["bold"] else 0};align={n["align"]};verticalAlign=middle;spacing=8;'
            cell = ET.SubElement(root, 'mxCell', id=n['id'], value=n['text'], style=style, vertex='1', parent='1')
            ET.SubElement(cell, 'mxGeometry', {'x': str(n['x']), 'y': str(n['y']), 'width': str(n['w']), 'height': str(n['h']), 'as': 'geometry'})

        for n in self.nodes:
            if n['kind'] == 'panel':
                add_node(n)
        for e in self.edges:
            style = f'edgeStyle=none;rounded=0;html=0;strokeColor=#475569;strokeWidth=2;endArrow={"block" if e["arrow"] else "none"};endFill=1;startArrow={"block" if e["both"] else "none"};startFill=1;dashed={1 if e["dashed"] else 0};'
            attrs = dict(id=e['id'], edge='1', parent='1')
            for side, node_id, point in [('source', e['source'], e['points'][0]), ('target', e['target'], e['points'][-1])]:
                if node_id:
                    attrs[side] = node_id
                    n = lookup[node_id]
                    prefix = 'exit' if side == 'source' else 'entry'
                    style += f'{prefix}X={(point[0] - n["x"]) / n["w"]};{prefix}Y={(point[1] - n["y"]) / n["h"]};{prefix}Perimeter=0;'
            attrs['style'] = style
            cell = ET.SubElement(root, 'mxCell', **attrs)
            geom = ET.SubElement(cell, 'mxGeometry', {'relative': '1', 'as': 'geometry'})
            for key, point in [('sourcePoint', e['points'][0]), ('targetPoint', e['points'][-1])]:
                ET.SubElement(geom, 'mxPoint', {'x': str(point[0]), 'y': str(point[1]), 'as': key})
            if len(e['points']) > 2:
                pts = ET.SubElement(geom, 'Array', {'as': 'points'})
                for x, y in e['points'][1:-1]:
                    ET.SubElement(pts, 'mxPoint', x=str(x), y=str(y))
        for n in self.nodes:
            if n['kind'] != 'panel':
                add_node(n)

    def heading(self):
        self.label('title', 25, 15, self.width - 50, 52, self.title, 30, bold=True, align='left')
        self.label('subtitle', 25, 68, self.width - 50, 36, self.subtitle, 17, align='left')


BLUE = '#e8effa'
GREEN = '#e4f2eb'
PURPLE = '#eee7f8'
RED = '#fcebea'
YELLOW = '#fff4dc'


def page(ident, title, subtitle, width=1800, height=1400):
    p = Page(ident, title, subtitle, width, height)
    p.heading()
    return p


def panel(p, ident, x, y, w, h, title, fill):
    p.box(ident, x, y, w, h, '', fill, kind='panel')
    p.label(ident + '-title', x + 15, y + 10, w - 30, 45, title, 23, bold=True)


def route(p, ident, src, dst, points, label=None, at=None, both=False, dashed=False):
    p.edge(ident, src, dst, points, both=both, dashed=dashed)
    if label:
        x, y, w, h = at
        p.label(ident + '-label', x, y, w, h, label, 17, fill='#ffffff')


def down(p, ident, src, dst, label=None):
    a = next(n for n in p.nodes if n['id'] == src)
    b = next(n for n in p.nodes if n['id'] == dst)
    x1, y1 = a['x'] + a['w']/2, a['y'] + a['h']
    x2, y2 = b['x'] + b['w']/2, b['y']
    points = [(x1,y1),(x2,y2)] if x1 == x2 else [(x1,y1),(x1,(y1+y2)/2),(x2,(y1+y2)/2),(x2,y2)]
    route(p,ident,src,dst,points,label, (min(x1,x2)-170,(y1+y2)/2-23,340,46) if label else None)


def footer(p, text):
    p.label('footer', 40, p.height-95, p.width-80, 70, text, 18, fill=YELLOW)


def overview():
    p = page('architecture','01 · 系统总体架构','TypeScript / Electron 承担业务；Rust 只做离线守护｜设备与教师按集合管理，数量不设产品上限',1800,1640)
    panel(p,'server',50,145,1700,460,'固定地址服务端 · Node.js / TypeScript 模块化单体',BLUE)
    p.box('api',95,220,1610,65,'HTTPS / WSS：设备与教师鉴权、业务 API、全部日志批传 / 持久确认；服务器自身日志内部归集',size=21)
    modules=[('registry','入网与设备目录\n角色 / 机房 / 地址 / 启动标识'),('auth','账号权限与操作权\n控制租约 / controlEpoch / 授权'),('session','Session 与命令\n占用事务 / 幂等 / 状态校准'),('profile','学生与识别接入\nUID / 档案 / 人脸适配')]
    for i,(ident,text) in enumerate(modules):
        x=95+i*410
        p.box(ident,x,345,380,95,text,size=19)
        route(p,'api-'+ident,'api',ident,[(x+190,285),(x+190,345)])
    p.box('pg',95,505,790,65,'PostgreSQL：全部日志 / 审计、业务实体、策略与去重',GREEN,size=20)
    p.box('files',925,505,780,65,'文件仓库：人脸资料 / 签名更新包 / 备份',GREEN,size=20)
    route(p,'store','session','pg',[(1105,440),(1105,470),(490,470),(490,505)])
    route(p,'media','profile','files',[(1515,440),(1515,480),(1315,480),(1315,505)])
    panel(p,'teacher',50,810,730,680,'教师 Electron · 动态 IP · 多实例',GREEN)
    p.box('t-ui',90,890,650,85,'渲染界面 + @cyez/ui\n录入登记 / 屏幕墙 / 管理操作 / 服务器管理',size=20)
    p.box('t-main',90,1040,650,100,'主进程：身份与 SDK、授权申请、直连监听\n操作权 / 命令路由 / 画面订阅与新鲜度',size=20)
    down(p,'teacher-ipc','t-ui','t-main','受限 preload / IPC')
    p.box('hardware',90,1210,300,95,'读卡器 / 摄像头\nUID 与人脸供应方适配',size=19)
    p.box('t-screen',440,1210,300,95,'只读画面订阅\n与设备控制权分离',size=19)
    route(p,'hardware-input','hardware','t-main',[(240,1210),(240,1140)])
    route(p,'screen-view','t-screen','t-main',[(590,1210),(590,1140)])
    p.box('t-logs',90,1350,650,95,'全部应用 / SDK / 安装更新日志\nSQLite outbox → 服务端；离线补传 / 确认后回收',GREEN,size=19)
    route(p,'teacher-logs','t-main','t-logs',[(90,1100),(75,1100),(75,1397),(90,1397)])
    panel(p,'student',1020,810,730,680,'学生端 · Windows 10+ · 多实例',PURPLE)
    p.box('s-app',1060,890,650,145,'Electron 主进程 + 应用内 worker\n网络、鉴权、Session、策略、全部日志与事件\n导入守护 / 安装日志；截图、健康与更新',size=21)
    p.box('s-render',1060,1110,300,95,'渲染器 + preload\n锁机 / 采集 / 状态确认',size=18)
    p.box('s-store',1410,1110,300,95,'SQLite / 凭证存储\n全量日志 outbox / 命令',size=18)
    route(p,'s-ipc','s-app','s-render',[(1210,1035),(1210,1110)],both=True)
    route(p,'s-persist','s-app','s-store',[(1560,1035),(1560,1110)],both=True)
    p.box('rust',1060,1330,650,100,'Rust 离线 Windows 服务 · Session 0\n监督 / 状态机 / 关机；全部日志交由 Electron 上传',RED,size=20)
    route(p,'guardian-ipc','s-app','rust',[(1060,980),(1040,980),(1040,1280),(1385,1280),(1385,1330)],'带 ACL 的本地命名管道',(1125,1245,520,45),both=True)
    route(p,'t-server','teacher','server',[(415,810),(415,605)],both=True)
    p.label('t-link',100,655,630,95,'HTTPS / WSS\n全部日志上传 / 查询；注册、授权、管理、心跳',20,fill='#ffffff')
    route(p,'s-server','student','server',[(1385,810),(1385,605)],both=True)
    p.label('s-link',1070,655,630,95,'Electron → HTTPS / WSS\n全部日志 / 事件上传；发现、策略、更新、心跳',20,fill='#ffffff')
    route(p,'direct','teacher','student',[(780,1060),(1020,1060)],both=True)
    p.label('direct-label',795,905,210,130,'直连 HTTPS / WSS\n命令 / 回执 / 心跳\n画面使用独立通道',18,fill='#ffffff')
    p.label('rust-no-network',795,1175,210,115,'Rust 无网络链路\n不持有业务身份\n不计算 Session',17)
    footer(p,'200 学生端 + 2 教师端仅为首轮负载测试基线；容量随部署实测。\n学生持有管理员权限：服务层尽力防护，不开发驱动，不承诺不可绕过。')
    return p


def runtime():
    p=page('student-runtime','02 · 学生端内部职责与信任边界','Electron 应用内共享 TypeScript 业务；Rust 只接受有限本地动作，渲染器不能直接访问系统服务',1800,1510)
    p.box('remote',60,145,1100,80,'远端：服务端 HTTPS / WSS + 当前控制教师 WSS + 独立画面通道',BLUE,size=22)
    panel(p,'app',60,330,1100,1060,'Electron 应用 · 当前交互式用户权限',BLUE)
    panel(p,'guardian',1240,330,500,1060,'Rust 服务 · Session 0',RED)
    p.box('network',100,425,480,110,'连接与身份模块\n注册 / 发现 / TLS / SDK\n网络心跳与两路失联计时',size=20)
    p.box('business',640,425,480,110,'命令与 Session 模块\n签名 / 幂等 / 控制代次\n共享 domain 规则与业务投影',size=20)
    route(p,'remote-network','remote','network',[(340,225),(340,425)],'只有 Electron 访问网络',(155,264,370,48),both=True)
    route(p,'net-business','network','business',[(580,480),(640,480)],both=True)
    p.box('coordinator',100,620,1020,85,'应用协调器：请求保护动作、确认实际界面状态、合并守护事实、故障优先',PURPLE,size=20)
    down(p,'net-coordinate','network','coordinator')
    route(p,'biz-coordinate','business','coordinator',[(880,535),(880,620)])
    p.box('render',100,805,300,120,'渲染器 + preload\n多屏锁机 / 实际确认\n响应健康挑战',size=20)
    p.box('workers',460,805,300,120,'应用内 worker\n全部日志归集 / 批传\n截图 / 更新校验',size=20)
    p.box('database',820,805,300,120,'SQLite 单写者\n全部日志 / 事件 outbox\n命令与恢复状态',GREEN,size=20)
    for ident,cx in [('render',250),('workers',610),('database',970)]:
        route(p,'coordinate-'+ident,'coordinator',ident,[(cx,705),(cx,805)],both=True)
    p.box('health',100,1020,1020,100,'本地健康报告：主逻辑 + 锁机渲染器都要响应\n两路远端 ack 才可更新网络健康期限；普通 IPC 心跳不可续期',size=20)
    p.box('app-boundary',100,1210,1020,115,'不向 renderer 暴露私钥、业务数据库或守护管道\n画面与更新任务不得阻塞主业务 / 锁机确认；有界队列丢弃过时帧\nElectron 持有远端授权，Rust 不重新实现业务鉴权',YELLOW,size=19)
    p.box('pipe',1280,425,420,110,'受限命名管道\n绑定子进程 / 用户会话\nIPC 版本 / 请求序号 / 保护代次',size=19)
    p.box('machine',1280,620,420,110,'本地保护状态机\nSTARTING / LOCKED / UNLOCKED\nLOCKING / MAINTENANCE 等',size=19)
    p.box('supervisor',1280,815,420,110,'监督与定时器\n进程句柄 / 必需进程实例\n本地健康截止时间',size=19)
    p.box('journal',1280,1010,420,110,'全部守护日志：运行 / 诊断 / 事实\nReadLogs → Electron 持久导入\nAckLogs 后转交上传责任',GREEN,size=19)
    p.box('actions',1280,1210,420,115,'固定系统动作\n启动应用 / 请求锁定 / 关机\n配合受控维护',size=19)
    down(p,'pipe-machine','pipe','machine')
    down(p,'machine-supervisor','machine','supervisor')
    down(p,'supervisor-journal','supervisor','journal')
    down(p,'journal-actions','journal','actions')
    route(p,'local-boundary','coordinator','pipe',[(1120,662),(1200,662),(1200,480),(1280,480)],both=True)
    route(p,'journal-import','journal','database',[(1280,1065),(1190,1065),(1190,955),(970,955),(970,925)],dashed=True)
    footer(p,'Rust 不创建 HTTP/WSS 连接、不监听远端、不处理人脸/Session/截图、不下载更新。\n本地报告可被管理员篡改，因此其健康期限不能作为远端连接真实性的强证明。')
    return p


def sequence(ident,title,subtitle,actors,steps,notes=(),height=None):
    width=1800
    step_height=100
    bottom=300+len(steps)*step_height
    height=height or bottom+170+len(notes)*55
    p=page(ident,title,subtitle,width,height)
    spacing=1680/len(actors)
    centers={}
    for i,(key,name) in enumerate(actors):
        x=60+i*spacing
        centers[key]=x+spacing/2
        p.box(key,x+10,145,spacing-20,80,name,BLUE,size=20,bold=True)
        p.edge('lifeline-'+key,None,None,[(centers[key],225),(centers[key],bottom-10)],dashed=True,arrow=False)
    for i,step in enumerate(steps):
        src,dst,text=step[:3]
        y=310+i*step_height
        x1,x2=centers[src],centers[dst]
        if src==dst:
            p.box('self-'+str(i),x1-135,y-68,270,58,text,YELLOW,size=17)
        else:
            route(p,'msg-'+str(i),None,None,[(x1,y),(x2,y)],dashed=(len(step)>3 and step[3]))
            p.label('msg-text-'+str(i),min(x1,x2)+8,y-70,abs(x2-x1)-16,62,text,17,fill='#ffffff')
    for i,note in enumerate(notes):
        p.label('note-'+str(i),60,bottom+25+i*55,1680,48,note,18,fill=YELLOW)
    return p


def discovery():
    return sequence('device-discovery','03 · 入网、地址发现与教师接管','设备 ID 是身份；IP 是地址。教师数量不限，控制权以每台学生机为单位仲裁。',
      [('teacher','教师 Electron'),('server','服务端 / 设备目录'),('student','学生 Electron'),('guardian','Rust 离线守护')],[
      ('guardian','student','1. 用户登录后启动应用\n等待首次锁定与 IPC 就绪'),
      ('student','server','2. 设备凭证认证 + bootId\n上报版本，获取策略'),
      ('teacher','server','3. 注册角色与监听端点\n额外校验教师登录权限'),
      ('student','server','4. 查询控制教师\n机房 / deviceId / controlEpoch'),
      ('server','student','5. 返回认证身份、地址\n端口、有效期与控制代次',True),
      ('student','teacher','6. 学生主动建立认证直连；控制和画面分通道'),
      ('student','guardian','7. 有效远端 ack → 本地健康报告\n不把网络职责交给 Rust'),
      ('teacher','server','8. IP 变化：更新端点\n或其他教师请求接管'),
      ('server','student','9. 下发新目录 / 新控制代次\n数据库变更不等于接管完成'),
      ('student','teacher','10. 验证新身份，建立新控制连接，拒绝旧代次命令'),
      ('student','server','11. 确认新代次与连接\n服务器才显示接管成功',True)
      ],notes=[
      '首次入网须一次性注册码或审批；客户端自报 role=teacher 不会获得教师权限。',
      '地址重试、发现请求及接管过程不重置失联期限；任一必需连接 20 秒无有效回应即锁机。',
      '无控制教师或目录无效时保持锁定；跨机房需实际放通学生到服务器和教师的指定端口。'])


def unlock():
    return sequence('registration-sequence','04 · 登记、授权与实际解锁时序','业务授权归 Electron；本地保护许可归 Rust；服务端依据学生持久化事件确认使用开始。',
      [('teacher','教师 Electron'),('server','服务端 / 数据库'),('student','学生 Electron 主逻辑'),('guardian','Rust 离线状态机'),('renderer','锁机渲染器')],[
      ('teacher','server','1. 首次 UID + 人工资料\n或日常人脸确认学生'),
      ('teacher','server','2. 登记并预留机器\n事务检查学生 / 机器占用'),
      ('server','teacher','3. 返回 Session / 命令授权\ncommandId / controlEpoch',True),
      ('teacher','student','4. 经直连发送授权命令；重试使用同一 commandId'),
      ('student','student','5. 鉴权 / 去重 / 健康检查\n持久化命令意图'),
      ('student','guardian','6. RequestUnlock\n请求 ID / 本地保护代次'),
      ('guardian','student','7. 本地健康通过，发一次许可\n进入 UNLOCK_PENDING',True),
      ('student','renderer','8. 切换界面：隐藏锁机窗口，应用继续运行'),
      ('renderer','student','9. 返回实际界面切换结果；不是仅确认收到消息',True),
      ('student','guardian','10. ConfirmUnlocked\n匹配请求 / 保护代次'),
      ('guardian','student','11. 原子确认 UNLOCKED\n新故障优先于旧确认',True),
      ('student','student','12. SQLite 事务落盘\nUNLOCK_SUCCEEDED'),
      ('student','server','13. 直接批量上报学生事件\n服务端事务更新 Session'),
      ('server','student','14. 持久化后确认 eventId\n应用再回收发送队列',True),
      ('student','teacher','15. 回执关联原命令；教师从服务端获取最终业务状态',True)
      ],notes=[
      '仅收到 Rust 许可不算解锁成功；实际界面与本地状态均确认后，才生成使用开始事件。',
      '超时或回执丢失：保留机器预留并查询同一命令，不直接当成失败后释放机器。',
      '任何阶段故障锁定都会递增本地保护代次，旧许可或迟到确认不得重新放行。'])


def guardian():
    p=page('guardian-state','05 · Rust 离线守护状态机','这是本地保护状态，不是学生 Session；远端鉴权、用户资料和使用时长都留在 Electron。',1800,1530)
    boxes=[
      ('start',90,170,450,110,'STARTING\n启动用户应用 / 首次锁定\n首次就绪期限 30 秒',BLUE),
      ('locked',690,170,450,110,'LOCKED\n锁机确认 / 保持监督\n等待新的本地解锁请求',GREEN),
      ('pending',690,450,450,110,'UNLOCK_PENDING\n本地健康通过 / 一次许可\n3 秒内等待匹配确认',PURPLE),
      ('unlocked',690,730,450,110,'UNLOCKED\n界面确认解锁\n持续监督进程与本地健康',GREEN),
      ('locking',1280,450,430,110,'LOCKING\n提高保护代次 / 要求锁定\n3 秒内等待界面确认',PURPLE),
      ('maintenance',90,730,450,110,'MAINTENANCE\n只由受控维护流程进入\n限定对象 / 期限 / 安装计划',YELLOW),
      ('shutdown',1280,1080,430,110,'SHUTTING_DOWN\n本地记事实 / 请求系统关机\n拒绝全部解锁请求',RED),
      ('fatal',90,1080,1050,110,'全局保护故障（运行就绪后）\nElectron 非预期退出 / 渲染故障 / 本地有效心跳缺失 3 秒\n或 STARTING 超时：直接请求关机，不依赖网络',RED)]
    for ident,x,y,w,h,text,fill in boxes:p.box(ident,x,y,w,h,text,fill,size=20)
    route(p,'boot-ready','start','locked',[(540,225),(690,225)],'锁机已确认',(540,170,150,45))
    down(p,'request-unlock','locked','pending','请求 + 本地条件通过')
    down(p,'confirm-unlock','pending','unlocked','确认匹配请求与代次')
    route(p,'network-fault','unlocked','locking',[(1140,785),(1495,785),(1495,560)],'期限届满 / 进程退出\n或 Electron 请求锁机',(1170,640,530,65))
    route(p,'unlock-failed','pending','locking',[(1140,505),(1280,505)],'超时 / 失败',(1145,440,130,60))
    route(p,'lock-confirmed','locking','locked',[(1495,450),(1495,225),(1140,225)],'锁定确认\n不自动解锁',(1270,285,430,70))
    route(p,'lock-timeout','locking','shutdown',[(1710,505),(1750,505),(1750,1135),(1710,1135)])
    p.label('lock-timeout-label',1470,930,270,60,'锁定 3 秒未确认',18,fill='#ffffff')
    route(p,'maint-enter','locked','maintenance',[(690,245),(595,245),(595,670),(315,670),(315,730)],'受控维护授权',(345,590,245,45))
    route(p,'maint-exit','maintenance','start',[(90,785),(55,785),(55,225),(90,225)])
    p.label('maint-exit-label',100,410,430,125,'退出维护 → 重新启动并锁定\n到期：按实际健康触发锁定/关机\n无用户会话时等待登录',19,fill='#ffffff')
    route(p,'fatal-shutdown','fatal','shutdown',[(1140,1135),(1280,1135)],'优先处置',(1145,1070,130,45))
    p.box('rules',90,1260,1620,130,'转换规则：故障锁定优先于解锁确认；每次保护故障 / 守护重启 / 新用户会话都使旧许可失效。\n请求关机是固定本地动作，可由已校验的 Electron 请求或守护故障触发；不代表系统已经断电。\n无交互式用户时保持待机，不启动 30 秒就绪期限；正常系统关机中的预期退出不重复触发故障。',size=20)
    footer(p,'Rust 仅信任受约束的本地应用报告，不验证远端身份；普通心跳不得续期网络健康期限。\n同一动作使用请求 ID 去重，晚到结果不能覆盖较新的保护代次。')
    return p


def failures():
    p=page('failure-handling','06 · 故障检测、动作与证据','Electron 负责网络判断与业务记账；Rust 在离线情况下独立执行本地故障动作。',1800,1420)
    triggers=[('net',60,'网络健康故障\nElectron 每 1 秒收有效 ack\n任一路连续 20 秒失联',BLUE),('proc',640,'必需进程故障\nRust 监督句柄与实例\n退出 / 身份不符立即触发',BLUE),('dead',1220,'应用保护故障\n非预期退出 / 渲染器故障\n本地有效心跳缺失 3 秒',RED)]
    for ident,x,text,fill in triggers:p.box(ident,x,165,520,130,text,fill,size=21)
    p.box('lock',350,450,810,100,'Rust 进入 LOCKING，递增保护代次\n通过本地 IPC 要求 Electron 显示所有锁机窗口',PURPLE,size=22)
    route(p,'network-lock','net','lock',[(320,295),(320,370),(550,370),(550,450)],'Electron 主动请求 + 本地期限兜底',(85,320,570,45))
    route(p,'process-lock','proc','lock',[(900,295),(900,450)],'不因进程重启自动放行',(720,340,360,45))
    p.box('confirmed',350,660,810,90,'3 秒内获得实际界面锁定确认？',size=23)
    down(p,'lock-confirm','lock','confirmed')
    p.box('pause',350,880,810,110,'是：保护状态 LOCKED\nElectron 记录 Session 暂停 + 事件落盘 / 补报\n无 Session 则只记录设备状态',GREEN,size=21)
    down(p,'yes-pause','confirmed','pause','是')
    p.box('resume',350,1100,810,100,'连接与必需进程恢复 + 教师重新授权\n重新通过业务校验与本地许可后恢复使用',GREEN,size=21)
    down(p,'resume-check','pause','resume','仅恢复连接或进程仍保持锁定')
    p.box('shutdown',1280,660,460,110,'本地记录守护故障\n请求系统关机\n不等待网络确认',RED,size=21)
    route(p,'dead-shutdown','dead','shutdown',[(1480,295),(1480,660)])
    route(p,'not-confirmed','confirmed','shutdown',[(1160,705),(1280,705)],'否',(1170,650,100,45))
    p.box('reconcile',1280,960,460,140,'Electron 可用时直接上报\n已退出则下次启动导入守护日志\n服务端保留结束待确认状态\n不把崩溃自动判为恶意',YELLOW,size=19)
    down(p,'shutdown-evidence','shutdown','reconcile','关机请求 ≠ 已断电')
    p.label('offline-server',45,725,270,210,'服务器仅看到失联时\n显示“锁机待确认”\n不能伪造本地执行成功\n也不能释放未确认占用',18,fill=YELLOW)
    footer(p,'突然断电 / 长按电源可能无任何上报：先标原因待确认，保留最后确认时间与可能结束区间。\n管理员若同时停止服务与界面，本地故障动作无法得到保证。')
    return p


def session_state():
    p=page('session-state','07 · Session 生命周期与计时','服务端是业务真值来源；学生 Electron 提供实际执行事件，Rust 不持有业务 Session 状态。',1800,1320)
    entries=[('registered',70,170,'REGISTERED\n登记成功 / 等待机器',BLUE),('pending',680,170,'UNLOCK_PENDING\n机器预留 / 等待实际解锁',PURPLE),('active',1290,170,'ACTIVE\n已确认解锁 / 累计可用时长',GREEN),('cancelled',70,550,'CANCELLED\n尚未使用的登记取消',YELLOW),('end-pending',680,550,'END_PENDING\n结束待确认 / 证据不足',YELLOW),('paused',1290,550,'PAUSED\n已确认锁机 / 保留占用',PURPLE),('ended',680,930,'ENDED\n记录结论与证据等级',GREEN)]
    for ident,x,y,text,fill in entries:p.box(ident,x,y,440,105,text,fill,size=22)
    route(p,'reserve','registered','pending',[(510,222),(680,222)],'占用事务通过',(515,160,160,45))
    route(p,'actual-unlock','pending','active',[(1120,222),(1290,222)],'学生成功事件',(1125,160,160,45))
    down(p,'cancel','registered','cancelled','未开始使用时取消')
    down(p,'lock-pause','active','paused','锁机实际确认')
    route(p,'resume-session','paused','active',[(1730,602),(1770,602),(1770,222),(1730,222)])
    p.label('resume-session-label',1545,450,215,70,'新教师授权\n+ 实际恢复事件',18,fill='#ffffff')
    route(p,'active-ending','active','end-pending',[(1330,275),(1330,460),(900,460),(900,550)])
    p.label('end-note',760,370,470,55,'结束请求 / 关机或重启线索',18,fill='#ffffff')
    route(p,'paused-end','paused','end-pending',[(1290,602),(1120,602)],'显式结束',(1125,540,160,45))
    down(p,'end-confirm','end-pending','ended','终态证据或追加审计结论')
    p.box('uncertain',70,815,440,220,'超时不等于执行失败\n预留与暂停都算占用\n迟到事件按 Session / bootId 归属\n不得污染新 Session\n恢复实际使用须重新授权',YELLOW,size=19)
    p.box('timing',1290,815,440,220,'登记总时长：登记 → 最终结束\n可用时长：已确认解锁区间之和\n暂停区间排除\nUTC 用于展示 / 单调时钟计时\n未知结束点保留区间而非伪造',BLUE,size=19)
    footer(p,'一个学生 / 一台设备最多对应一个未结束的使用 Session；预留、暂停和结束待确认均占用。\n网络失联先标连接与证据状态，锁机事件才确认暂停；故障恢复不自动解锁，人工更正追加审计。')
    return p


def events():
    return sequence('event-delivery','08 · 全量日志上传、持久确认与可靠补传','所有组件、所有已生成级别均须归集；包含 debug / trace。Rust 与安装器保持离线，由 Electron 转发。',
      [('source','离线源：Rust / 安装器'),('electron','教师 / 学生 Electron'),('sqlite','各端 SQLite outbox'),('server','统一接收 / PostgreSQL')],[
      ('source','source','1. 全部日志本地持久化\n含诊断 / 错误 / 更新回滚'),
      ('electron','sqlite','2. 应用全部日志先落盘\nmain / renderer / worker / SDK'),
      ('electron','source','3. ReadLogs / 安装日志游标\n启动及运行中持续导入'),
      ('source','electron','4. logId / 来源实例 / 序号\n原始时间 / 级别 / 脱敏内容',True),
      ('electron','sqlite','5. 导入日志与游标同一事务\n保留原 ID，唯一约束去重'),
      ('sqlite','electron','6. 本地持久提交成功',True),
      ('electron','source','7. AckLogs / 确认日志段\n仅转交保管责任，可回收源副本'),
      ('electron','server','8. HTTPS 批传全部日志；业务事件附关联 logId，分别经 logs / events 接口'),
      ('server','server','9. 并行归集自身/配套日志\n持久缓冲 → 内部接入'),
      ('server','server','10. 普通日志：去重落盘\n不驱动 Session 状态'),
      ('server','server','11. 业务事件：事务提交\n事件 + 日志 + 状态投影'),
      ('server','electron','12. 提交后返回已持久化 ID 集合；部分失败不确认失败项',True),
      ('electron','sqlite','13. 只回收最终确认的项\n未确认 / 隔离项继续保留'),
      ('electron','electron','14. 断网 / 重启后补传\n复用原 ID，退避重试'),
      ('source','source','15. 应用退出时继续留盘\n恢复后由 Electron 导入')
      ],notes=[
      '来源：两类 Electron 的主进程、renderer、worker、SDK、网络；Rust；初次安装、更新及回滚；服务器与配套服务。',
      '本地 ACK 只转移保管责任；服务端持久 ACK 才算完成。两级 ACK 丢失均可重放，不生成新的日志或业务事件。',
      '去重保留 logId / 来源 / bootId / 原始时间；业务 eventId 单独关联。服务端自身日志走内部归集，不需 HTTP 回环。',
      '不采样漏传，不清理未确认日志；无效项隔离告警，长记录分片。后台批传不阻塞心跳，日志接收不递归放大。',
      '存储故障禁止新使用并保护锁机；关机不等待网络。断电或磁盘损坏可能留下缺口，恢复后报告，不伪造日志。'])


def updates():
    return sequence('update-lifecycle','09 · 更新下载、受控维护与回滚','Electron 负责版本决策与联网；独立受限执行器完成注销后的切换，Rust 仅配合本地维护状态。',
      [('server','版本服务 / 包仓库'),('electron','Electron 更新协调'),('installer','本地更新执行器'),('guard','Rust 离线守护')],[
      ('electron','server','1. 启动检查签名清单\n网络 / IPC / OS 兼容要求'),
      ('server','electron','2. 返回清单与下载地址\n签名与摘要不等价',True),
      ('electron','electron','3. 下载暂存包并验证\n安装条件未满足则等待'),
      ('electron','installer','4. 提交受控更新计划\n包 / 目标版本 / 维护期限'),
      ('installer','installer','5. 再校验暂存包与计划\n固定动作，不接受任意 shell'),
      ('installer','guard','6. 进入 MAINTENANCE\n限定对象、期限、关联计划'),
      ('guard','installer','7. 确认进入维护\n豁免仅覆盖预期退出',True),
      ('installer','installer','8. 确认无 Session 且已注销\n停止组件 / 原子切换版本'),
      ('installer','guard','9. 重启守护 / 退出维护\n等待用户应用健康验证'),
      ('guard','electron','10. 用户会话启动应用\n默认锁定，重新握手'),
      ('electron','installer','11. 返回版本与本地健康结果\n与服务器可达性分别判断',True),
      ('electron','installer','12. 按来源 / 游标导入全部日志\n诊断、失败、回滚也进入 outbox'),
      ('electron','server','13. 上传全部更新日志与结果\n无网络时保持锁定并待补传')
      ],notes=[
      '本地健康失败或超时：执行器回滚至已验证版本并重新默认锁定；无用户时等待验证，不伪造成功。',
      '安装日志独立于版本目录；停电据计划恢复。身份、全部日志 outbox、未交接的守护/安装日志全部保留。',
      '初次安装尚未入网或应用无法启动：日志继续留盘，恢复后导入补传；不能只上报最终更新结果。',
      '教师端安装前先结束或转交控制任务；签名私钥不部署到客户端，Rust 从不下载或选择更新版本。'])


def workspaces():
    p=page('workspace-dependencies','10 · 现代 Yarn workspaces 与复用边界','Node.js 服务端与 Electron 使用 TypeScript；同一代码库不代表同一权限，Rust 仅共享本地协议。',1800,1550)
    p.box('root',60,145,1680,105,'私有 monorepo 根：packageManager 固定 Yarn 4 精确版本 · 单一 yarn.lock\nworkspaces: apps/* + packages/* · nodeLinker: node-modules · CI: yarn install --immutable',BLUE,size=23)
    apps=[('server',60,'apps/server · @cyez/server','protocol + domain\n服务端最终鉴权 / 占用事务'),('teacher',640,'apps/teacher · @cyez/teacher','protocol + domain + client-sdk + ui\n教师权限 / 直连操作 / 订阅'),('student',1220,'apps/student · @cyez/student','protocol + domain + client-sdk\n+ guardian-contract + ui')]
    for ident,x,title,body in apps:
        p.box(ident,x,350,520,140,title+'\n'+body,GREEN,size=20)
        route(p,'root-'+ident,'root',ident,[(x+260,250),(x+260,350)])
    panel(p,'shared',60,600,1680,395,'共享工作区 · 内部显式依赖 workspace:^ · 通过 exports 访问编译产物',PURPLE)
    pkgs=[('protocol',95,690,490,115,'@cyez/protocol\n网络 / 日志 / 事件 DTO 与 schema\n不含设备私钥或服务端数据库'),('domain',655,690,490,115,'@cyez/domain\nSession 纯规则 / 状态转换\n不依赖 Electron、数据库或 I/O'),('sdk',1215,690,490,115,'@cyez/client-sdk\n依赖 protocol：认证 / 重连\n全部日志批传 / 确认 / 重试'),('contract',95,850,770,100,'@cyez/guardian-contract\n本地 IPC schema / ReadLogs、AckLogs / 序列化测试向量'),('ui',935,850,770,100,'@cyez/ui\n组件库适配 / 共享界面；不包含系统权限或服务端逻辑')]
    for ident,x,y,w,h,text in pkgs:p.box(ident,x,y,w,h,text,size=20)
    for ident,x in [('server',320),('teacher',900),('student',1480)]:
        route(p,ident+'-imports',ident,'shared',[(x,490),(x,600)],'工作区依赖',(x-150,520,300,45))
    route(p,'sdk-protocol','sdk','protocol',[(1460,690),(1460,670),(340,670),(340,690)],dashed=True)
    p.box('cargo',95,1110,770,120,'native/guardian · Cargo / Rust\n仅从 guardian-contract 生成或校验 IPC 类型\n不导入 domain、client-sdk 或任何网络业务包',RED,size=21)
    down(p,'schema-native','contract','cargo','schema / fixtures，不执行 TypeScript')
    p.box('build',935,1110,770,120,'构建与交付\n共享包按拓扑构建 → 应用 → 安装包\nCargo 独立编译 → 装配守护二进制',BLUE,size=21)
    route(p,'native-package','cargo','build',[(865,1170),(935,1170)])
    p.box('build-rules',95,1290,1610,115,'禁止：跨包相对目录导入、复制 DTO、服务端依赖 UI、Rust 重写业务状态机。\n依赖声明与 exports 作为边界；Electron 原生模块按目标 ABI 重建，不能混用服务器编译产物。\n全量工作区脚本排除根包，防止递归；Cargo 不冒充 Yarn workspace。',YELLOW,size=20)
    footer(p,'本页规定编码阶段目录与依赖关系；当前仓库交付文档与图，不代表应用骨架或运行时已经实现。')
    return p


def validate(p):
    ids=[n['id'] for n in p.nodes]+[e['id'] for e in p.edges]
    assert len(ids)==len(set(ids)), f'{p.ident}: duplicate ID'
    nodes={n['id'] for n in p.nodes}
    for e in p.edges:
        assert e['source'] is None or e['source'] in nodes
        assert e['target'] is None or e['target'] in nodes
    for n in p.nodes:
        assert n['x']>=0 and n['y']>=0 and n['x']+n['w']<=p.width and n['y']+n['h']<=p.height, (p.ident,n['id'],'outside canvas')


def main():
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true',help='Verify generated files are current without writing them.')
    parser.add_argument('--render-dir',type=Path,help='Optionally render PNGs using installed CairoSVG.')
    args=parser.parse_args()
    pages=[overview(),runtime(),discovery(),unlock(),guardian(),failures(),session_state(),events(),updates(),workspaces()]
    mxfile=ET.Element('mxfile',host='app.diagrams.net',type='device')
    outputs={}
    for p in pages:
        validate(p)
        outputs[f'{p.ident}.svg']=p.svg_text()
        p.export_drawio(mxfile)
        print(f'{p.ident}: {len(p.nodes)} nodes, {len(p.edges)} edges')
    ET.indent(mxfile,space='  ')
    outputs['architecture.drawio']='<?xml version="1.0" encoding="utf-8"?>\n'+ET.tostring(mxfile,encoding='unicode')+'\n'
    for name,content in outputs.items():
        path=OUT/name
        if args.check:
            assert path.exists() and path.read_text(encoding='utf-8')==content, f'Out of date: {path}'
        else:
            path.write_text(content,encoding='utf-8',newline='\n')
    if args.render_dir:
        import cairosvg
        args.render_dir.mkdir(parents=True,exist_ok=True)
        for p in pages:
            cairosvg.svg2png(bytestring=outputs[f'{p.ident}.svg'].encode(),write_to=str(args.render_dir/f'{p.ident}.png'))


if __name__=='__main__':
    main()
