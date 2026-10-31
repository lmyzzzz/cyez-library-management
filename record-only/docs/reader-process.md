# 独立读卡进程接口 v1

2026-10-30：读卡硬件处理由独立原生进程实现，Electron main 的 Node.js 负责启动它并通过继承管道通信。当前提供 Rust Windows 窗口 mock；更换真实读卡器时实现同一协议，不改教师业务层。不读取其他扇区、姓名或学籍资料。

## UID 与职责

本接口只接收 Wiegand-34 的中间 32 个数据位，即 4 字节 UID。硬件进程负责处理设备/驱动传输、34 位帧及奇偶校验：第 1 位与前 16 个数据位组成偶校验，第 34 位与后 16 个数据位组成奇校验。以数据位最高位在前的顺序输出 8 位小写十六进制；不能删前导零、反转字节或拆分 facility/card number。`00000001`、`abcdef01`、`ffffffff` 均为有效 UID；不是十进制卡号输入。

读卡进程不接收固定盐或校园 API 凭证。Electron main 收到 UID 后立即调用已有 `CardReader` 计算固定盐 SHA-256 学生 ID；去重、页面门控、HTTPS 查询和本地缓存更新沿用业务规格。原 UID 只短时经过读卡进程、继承管道和本次查询内存，不进入 renderer、日志、SQLite 或重放队列。可写 buffer 在交付/错误/关闭时覆写；不承诺操作系统、GUI 控件或运行时副本的物理擦除。

## 通道与消息

main 用 `spawn(executable, [], {shell:false, stdio:["pipe","pipe","pipe"]})` 启动；生产配置指定绝对 `.exe` 路径，mock 使用构建产物/打包资源。进程不监听网络或公共命名管道。stdout 仅输出协议；UTF-8 JSON，每条一行并立即 flush，LF 分隔（接收兼容 CRLF），一行不含 LF 最多 256 字节。消息可跨多个 pipe chunk，也可多条合并；不以 chunk 边界当帧边界。字段严格校验，未知字段/类型/版本不忽略。

| 方向 | 消息 | 语义 |
| --- | --- | --- |
| 子进程 → main | `{"type":"ready","protocol":1,"kind":"hardware"}` | 5 秒内唯一一次握手；硬件初始化后发送。Rust mock 必须自报 `kind:"mock"` |
| 子进程 → main | `{"type":"scan","uidHex":"00000001"}` | 握手后的一次刷卡；只能携带 UID，没有扇区数据、日志文本或学生资料 |
| 子进程 → main | `{"type":"error","code":"READER_IO"}` | 设备/驱动不可用，关闭本连接；不可附带原始异常文本 |
| 子进程 → main | `{"type":"error","code":"INVALID_FRAME"}` | 输入帧无法校验，关闭本连接；不得发送原帧 |
| main → 子进程 | `{"type":"shutdown"}` 加 LF | 停止读卡并退出；stdin EOF 也应退出，避免父进程异常退出后遗留窗口 |

校验不通过的硬件脉冲可以在子进程内部丢弃；若报告 `error` 则视为本连接不可继续。main 对握手超时、重复握手、ready 前 scan、无效 JSON、超长行、异常退出和上述错误统一停止接收、清除临时帧、结束进程，显示错误并生成固定 `READER_FAILED` 脱敏日志。教师检查设备后重启应用恢复；不自动重放或无限重启。历史、手动结束等业务仍可使用。

正常关闭时 main 发送 shutdown 并关闭 stdin；1.5 秒未退出则 kill，2.5 秒结束等待。Rust mock 接受上述规范 shutdown 字符串（LF/CRLF）或 EOF；其他控制输入以退出码 2 退出。子进程 stdout 不得写调试信息；main 丢弃第三方 stderr，防止原始硬件诊断污染日志。需要归集的读卡故障使用固定错误码通道。main 仅传入运行 GUI 所需的有限系统环境变量，不传教师/数据库/provider 配置。

## Rust mock 与配置

Windows、Rust 1.94.0（MSVC 工具链）和 Visual Studio C++ Build Tools：

```powershell
corepack yarn build:reader:mock
corepack yarn build:client
$env:CYEZ_CLIENT_CONFIG = (Resolve-Path config/client.integration.json).Path
corepack yarn start:client
```

集成模板使用 `"readerProcess":{"kind":"mock"}`。Electron 自动启动 `Wiegand-34 UID Mock` 窗口；输入 8 位十六进制，点击 **Send scan**。输入允许大小写，输出统一小写，成功后清空输入；错误输入只在窗口提示，不生成刷卡。输入测试种子 `00000001` 可进入已授权测试学生流程。窗口提示 `Scan sent` 只表示已写入管道，业务是否受理以教师窗口为准；在设置页、未登录或 Modal 中刷卡仍受原门控约束。关闭 mock 窗口会使教师端显示读卡进程断开。

`--test-uid 00000001` 是自动化测试专用的一次性模式：发送 mock ready 和一条 scan 后退出；不会伪装成 hardware，不用于正常 GUI 运行。交互运行须由 Node/Electron 保持 stdin 管道；直接双击 exe 没有父管道会退出。

生产模板使用：

```json
{"readerProcess":{"kind":"external","executable":"C:/Program Files/cyez-library-reader/reader.exe"}}
```

`environment:"production"` 拒绝 mock 配置及自报 mock 的外部进程。`identity.uidByteLengths` 固定为 `[4]`，盐/issuer/hashVersion 必须与服务端和授权种子一致。旧 `readerModule`/JavaScript 动态加载接口已移除，需更新配置。安装包将 mock 放在 `resources/readers/`，只可在显式开发/集成配置使用。

TBD-03 现在仅保留真实读卡器型号、驱动/电气或设备传输协议、实际发行方以及真实帧到规范 UID 的对照样本与验收。Wiegand-34、4 字节数据和本 IPC 接口已经确定。Rust mock 证明管道和应用集成，不证明真实硬件已验证；校园 API 对原 UID 的转换仍依 TBD-02，不编造硬件/校园协议。
