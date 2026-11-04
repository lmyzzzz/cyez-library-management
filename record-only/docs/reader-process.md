# 独立读卡进程接口 v1

2026-10-30：读卡硬件处理由独立原生进程实现，Electron main 的 Node.js 负责启动它并通过继承管道通信。当前提供 Rust Windows 窗口 mock、串口进程和 ACR1552U-M1 PC/SC 进程；更换读卡器时实现同一协议，不改教师业务层。不读取其他扇区、姓名或学籍资料。

## UID 与职责

本接口只接收 Wiegand-34 的中间 32 个数据位，即 4 字节 UID。硬件进程负责处理设备/驱动传输、34 位帧及奇偶校验：第 1 位与前 16 个数据位组成偶校验，第 34 位与后 16 个数据位组成奇校验。以数据位最高位在前的顺序输出 8 位小写十六进制；不能删前导零、反转字节或拆分 facility/card number。`00000001`、`abcdef01`、`ffffffff` 均为有效 UID；不是十进制卡号输入。

读卡进程不接收固定盐或校园 API 凭证。Electron main 收到 UID 后立即调用已有 `CardReader` 计算固定盐 SHA-256 学生 ID；去重、页面门控、HTTPS 查询和本地缓存更新沿用业务规格。原 UID 只短时经过读卡进程、继承管道和本次查询内存，不进入 renderer、日志、SQLite 或重放队列。可写 buffer 在交付/错误/关闭时覆写；不承诺操作系统、GUI 控件或运行时副本的物理擦除。

## 通道与消息

main 用 `spawn(executable, args, {shell:false, stdio:["pipe","pipe","pipe"]})` 启动；外部进程路径必须是绝对 `.exe`，内置 mock/serial 使用构建产物或打包资源。进程不监听网络或公共命名管道。stdout 仅输出协议；UTF-8 JSON，每条一行并立即 flush，LF 分隔（接收兼容 CRLF），一行不含 LF 最多 256 字节。消息可跨多个 pipe chunk，也可多条合并；不以 chunk 边界当帧边界。字段严格校验，未知字段/类型/版本不忽略。

| 方向 | 消息 | 语义 |
| --- | --- | --- |
| 子进程 → main | `{"type":"ready","protocol":1,"kind":"hardware"}` | 5 秒内唯一一次握手；硬件初始化后发送。Rust mock 必须自报 `kind:"mock"` |
| 子进程 → main | `{"type":"scan","uidHex":"00000001"}` | 握手后的一次刷卡；只能携带 UID，没有扇区数据、日志文本或学生资料 |
| 子进程 → main | `{"type":"error","code":"READER_IO"}` | 设备/驱动不可用，关闭本连接；不可附带原始异常文本 |
| 子进程 → main | `{"type":"error","code":"INVALID_FRAME"}` | 输入帧无法校验，关闭本连接；不得发送原帧 |
| main → 子进程 | `{"type":"shutdown"}` 加 LF | 停止读卡并退出；stdin EOF 也应退出，避免父进程异常退出后遗留窗口 |

校验不通过的硬件脉冲可以在子进程内部丢弃；若报告 `error` 则视为本连接不可继续。main 对握手超时、重复握手、ready 前 scan、无效 JSON、超长行、异常退出和上述错误统一停止接收、清除临时帧、结束进程，显示错误并生成固定 `READER_FAILED` 脱敏日志。教师检查设备后重启应用恢复；不自动重放或无限重启。历史、手动结束等业务仍可使用。

正常关闭时 main 发送 shutdown 并关闭 stdin；1.5 秒未退出则 kill，2.5 秒结束等待。Rust mock 接受上述规范 shutdown 字符串（LF/CRLF）或 EOF；其他控制输入以退出码 2 退出。子进程 stdout 不得写调试信息；main 丢弃第三方 stderr，防止原始硬件诊断污染日志。需要归集的读卡故障使用固定错误码通道。main 仅传入运行 GUI 所需的有限系统环境变量，不传教师/数据库/provider 配置。

## ACR1552U-M1 PC/SC 进程

ACR1552U-M1 为 USB-A 版本，Windows 下使用厂商 CCID 驱动暴露的 PC/SC 读卡器，不作为串口/Wiegand D0/D1 设备打开。官方 ACR1552U Series Reference Manual v1.09 第 34–35 页定义 `FF CA 00 00 00` 取卡 UID/PUPI/SN，成功响应末尾为 `90 00`。`cyez-reader-acr1552.exe` 使用 WinSCard 的读卡器枚举、状态变化和卡片传输。仅接受成功且恰好 4 字节的结果，按响应顺序输出 8 位小写十六进制；7/10 字节、失败状态及异常长度不得截断、倒序或猜测 Wiegand 编码。每次检测到卡片进入只发送一次，移卡后才重新接收；设备消失/PCSC I/O 错误发送固定 `READER_IO`，不合格响应发送固定 `INVALID_FRAME`，然后退出。父进程 shutdown/EOF 在有界状态等待内退出。

设置页选择“ACR1552U-M1 (PC/SC)”，点击“刷新 PC/SC 读卡器”，从枚举到的 ACR1552 系列 PICC 接口中选择精确设备名；SAM/接触式接口不进入列表，同型号多台设备不会自动切换。状态检查间隔可设为 100–2000 ms，默认 250 ms，它决定正常停止的最长等待时间，不改变 UID 规则。进程只支持 `--reader <name> --poll-ms <100..2000>`；`--list-readers` 一次性返回 `{"readers":[...]}`。选定设备不在枚举中或 WinSCard 服务不可用时启动失败，教师端恢复原进程并显示故障。无需在 UI 设置串口参数、APDU 字节序、扇区或厂商键盘仿真模式；键盘仿真是设备固件配置，不属于 PC/SC 读卡进程。

配置示例：

```json
{"readerProcess":{"kind":"acr1552","reader":"ACS ACR1552U PICC 0","pollMs":250}}
```

官方产品页：https://www.acs.com.hk/en/products/575/acr1552u-usb-nfc-reader-iv/；参考手册：https://www.acs.com.hk/download-manual/13473/REF-ACR1552U-Series-1.09.pdf。实际 PC/SC 名称须以目标机器枚举结果为准。**尚缺实卡对照**：PC/SC 返回的 4 字节 UID 是否等于既有 Wiegand-34 中间 32 数据位及校园 API 接受的原卡号，必须用真实发卡样本核对；不能以编译、模拟响应或手动 mock 代替。仅 7/10 字节的卡不符合当前 4 字节协议，需业务方确认卡片/编码后才能支持，不能自行转换。

## Rust mock 与配置

2026-11-03 新增 Rust 串口进程 `cyez-reader-serial.exe`。设置页可覆盖选择内置串口、外部原生进程或（仅开发/集成）手动 mock；main 等待新进程 ready 后才保存选择，启动失败尝试恢复旧进程。串口列表由内置 Rust 进程单次枚举，Node 不直接读取串口；亦可手动输入 `COM1` 至 `COM9999`。串口配置为端口、300–921600 比特率、5/6/7/8 数据位、无/奇/偶校验、1/2 停止位、无/硬件/软件流控和每行卡号的进制。默认 9600/8N1/无流控、固定 8 位十六进制；旧配置缺少进制字段时也按此默认值解析。实际硬件参数需按设备说明设定。配置只从表单整份覆盖，界面不读取或回填旧参数。

串口进程打开设备成功后发送 `kind:"hardware"` 握手；串口字节流按 LF 分帧，接受 CRLF。每行只含一个无符号整数，按设置页选择的格式解析：`hex8` 为恰好 8 位十六进制，`hex` 为 1–8 位十六进制，`decimal` 为 1–10 位十进制，`octal` 为 1–11 位八进制，`binary` 为 1–32 位二进制。十六进制允许大小写；所有格式都拒绝符号、前缀、空格、分隔符、非法数字及超过 32 位的值。进程将数值补齐为 8 位小写十六进制，再通过统一 IPC 输出 4 字节 UID；例如十进制 `1` 和十六进制 `00000001` 都输出 `00000001`。格式错误发送固定 `INVALID_FRAME`，I/O 错误发送 `READER_IO` 并退出；不上传原始串口行。`--list-ports` 是独立的一次性枚举模式，输出严格 JSON 列表，不能代替正常读卡 IPC。Linux 伪终端测试覆盖实际串口读写与进程握手；Windows 实物串口/读卡器验收仍需 TBD-03。

串口配置的本机示例：

```json
{"kind":"serial","port":"COM3","baudRate":9600,"dataBits":8,"parity":"none","stopBits":1,"flowControl":"none","format":"decimal"}
```

Windows、Rust 1.94.0（MSVC 工具链）和 Visual Studio C++ Build Tools：

```powershell
corepack yarn build:reader:mock
corepack yarn build:client
$env:CYEZ_CLIENT_CONFIG = (Resolve-Path config/client.integration.json).Path
corepack yarn start:client
```

集成模板使用 `"readerProcess":{"kind":"mock"}`。Electron 自动启动 `Wiegand-34 UID Mock` 窗口；输入 8 位十六进制，点击 **Send scan**。输入允许大小写，输出统一小写，成功后清空输入；错误输入只在窗口提示，不生成刷卡。输入测试种子 `00000001` 可进入已授权测试学生流程。窗口提示 `Scan sent` 只表示已写入管道，业务是否受理以教师窗口为准；在设置页、未登录或 Modal 中刷卡仍受原门控约束。关闭 mock 窗口会使教师端显示读卡进程断开。

`--test-uid 00000001` 是自动化测试专用的一次性模式：发送 mock ready 和一条 scan 后退出；不会伪装成 hardware，不用于正常 GUI 运行。交互运行须由 Node/Electron 保持 stdin 管道；直接双击 exe 没有父管道会退出。

生产模板可使用内置 ACR1552U、串口进程或外部进程。`readerProcess` 也可暂时省略，让生产客户端先打开设置页选择；此时读卡状态明确显示未配置，不能刷卡。外部进程示例：

```json
{"readerProcess":{"kind":"external","executable":"C:/Program Files/cyez-library-reader/reader.exe"}}
```

`environment:"production"` 拒绝 mock 配置及自报 mock 的外部进程。`identity.uidByteLengths` 固定为 `[4]`，盐/issuer/hashVersion 必须与服务端一致。旧 `readerModule`/JavaScript 动态加载接口已移除，需更新配置。安装包将三个 Rust 进程放在 `resources/readers/`；其中 mock 只可在显式开发/集成配置使用。

TBD-03 已获 ACR1552U-M1 型号及其 PC/SC 获取 UID 的正式接口，仍缺目标机器驱动/WinSCard、实际发卡样本、与 Wiegand-34 数据位和校园 API 原卡号的对照及实物刷卡验收。Rust mock 和 PC/SC 单元测试不证明真实硬件已验证；校园 API 对原 UID 的转换仍依 TBD-02，不编造硬件/校园协议。
