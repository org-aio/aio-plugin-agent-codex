# 网络要求

设备使用现有 AIO HTTPS 来源与 Bearer 身份，主动建立出站 `wss` 通道；无需公网设备地址、入站端口或再次配对。反向代理必须为 `/api/runtime/workers/webviews/channel` 和插件挂载下的 `__channel` 保留 WebSocket Upgrade。

浏览器只连接 AIO 当前视图地址。原版资源通过设备读入、经 AIO 回传，资源响应带 SHA-256 校验且禁止缓存。设备身份、Codex 配置、账户凭据、运行时描述和 CDP 地址不进入插件包。

当前设备 WebSocket 使用 Node/ws 的直接 TLS 连接；仅允许代理出网的环境需先提供相应网络通路。Codex 模型和工具网络由原生运行时按原配置处理。
