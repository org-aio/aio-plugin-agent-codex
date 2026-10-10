# AIO Codex Buddy

在 AIO 网页中使用配对设备上安装的原版 Codex 界面、运行时与 Codex Buddy。插件只提供设备选择、连接状态和传输；项目、聊天、执行工具及 Harness 能力由设备上的 Codex/Buddy 提供，不实现第二套智能体循环。

## 使用

1. 安装支持网页发现接口的 Codex Buddy，并通过 Buddy 打开 Codex。
2. 使用现有 AIO 设备配对和设备助手 `0.12.2` 或更新版本，在设备运行 `aio device codex-enable`。
3. 从 AIO 安装本插件，选择在线设备并连接。

`aio device codex-disable` 撤销网页访问，`aio device codex-status` 查看本机开关。Mac 默认读取 `/Applications/ChatGPT.app/Contents/Resources/app.asar`；其他安装位置使用 `--asar`，运行时描述位置可使用 `--descriptor`。网页不接收这些本机路径、CDP 地址或设备凭据。

设备必须保持在线，Codex Buddy 必须运行。执行发生在所选设备及 Codex 已连接的 Host 上。浏览器刷新或设备重连会建立新的原生视图，旧写操作不重放；断线前的操作结果需要回到原会话确认。

## 当前边界

- UI 和 Buddy 扩展资源从设备当前安装版本读取，不打包或再分发 Codex 安装包。
- AIO 宿主最低版本为 `2026.10.11`，需启用 WebSocket Upgrade；插件入口使用 AIO Component v2。宿主管理员需在 `AIO_PROCESS_WORKER_CAPABILITIES` 中追加 `codex.web`，保留已有能力，并批准清单中的固定进程镜像。
- 每台设备最多四个独立视图。视图绑定登录、租户、用户、插件来源、版本及挂载，授权过期或撤销会关闭通道。
- 网页连接使用独立的原生辅助窗口，建立后恢复桌面主窗口及其当前会话。辅助窗口说明连接用途，可以最小化；关闭它只会断开对应网页。桌面和网页共享 Codex 运行时，各自保留导航与输入状态。
- 支持浏览器文件选择、文件拖入和文件粘贴；目录拖入由 AIO 宿主读取，再向隔离的原版界面传递 File 和相对目录结构，保留空目录。文件分块传到所选设备，整个目录完整确认后才向原版界面提供设备路径。失败不会交付半成品或断开原生会话；中断时清理未完成目录及其中已上传的文件，已交付文件保留在设备的系统临时目录。浏览器不传客户端原始绝对路径，iframe 保持不透明沙箱。
- 单文件最多 `128 MiB`，每个视图最多 `512 MiB`、`4096` 个文件和目录项，目录相对路径最多 `32` 层。旧宿主或设备需升级后才能拖入目录。
- 桥接不声明桌面原生菜单及拖拽接口，原版组件使用自己的浏览器菜单与链接拖拽分支。真实 Chromium 已验证链接拖拽；各原版菜单仍需设备 UI 验收。从 Codex 向浏览器外拖出文件和 Electron 内嵌 `<webview>` 尚未完整接入。
- 官方 UI/IPC 为版本相关接口。更新后读取新版资源，但仍需要兼容性验收；不能承诺所有版本或生态能力自动兼容。
- 真实发送、流式回复、停止、审批及文件操作的发布验收必须在已运行的设备上完成。源码测试不代表这些交互已验收，也不代表已上线。

现有 AIO Agent 和历史记录保留，完成核心交互验收后再决定替换范围。

## 构建

插件使用 Topcoat `0.6.2` 与 `nightly-2026-05-25`。

```sh
npm ci
npm run test:native
npm run typecheck
sh scripts/build.sh
aio plugin validate .
aio plugin package . --git https://github.com/org-aio/aio-plugin-agent-codex.git --version 0.1.2
```

`native/` 提供设备助手使用的 Node 连接库；`frontend/` 提供连接外壳与原版 UI 的浏览器传输；`shared/wire.ts` 定义固定帧、原生方法白名单及 structured clone 校验。原版页面由原安装模块渲染。

浏览器沙箱测试见 [test/README.md](test/README.md)，原生窗口与资源说明见 [native/README.md](native/README.md)。发布以 AIO 上传任务激活、已安装 revision 和真实网页交互为准。
