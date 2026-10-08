# 原始 Codex Renderer 的设备桥接

连接设备本机的 loopback CDP，通过官方 `open-in-new-window` 创建独立窗口上下文，只替换该窗口的入口文档；原始 preload、App Host、IPC 与 worker 接口保持由 Codex 提供。现有桌面窗口不复用 App View 端口。

设备只接受共享协议定义的消息和方法，不接收 JavaScript 或 CDP 命令。原始前端和 Buddy 资源在用户安装目录读取，不放进 AIO 发布包。协议保持 structured clone 的数组、循环引用、二进制、Map、Set 和 BigInt。

每个连接拥有自己创建的 target，关闭只清理该 target。完整插件上线仍需设备身份与撤权、真实网页交互和升级兼容验收。
