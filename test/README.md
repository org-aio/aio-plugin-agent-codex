# 验证

`npm run test:native` 覆盖原始资源范围与摘要、安装版本固定、原生窗口所有权、帧顺序、原 HTML 入口替换及 wire 校验。文件测试实际写入设备测试进程的磁盘并比较二进制内容，覆盖分块顺序、完整确认、取消和断线清理、已交付文件保留与大小限制。CDP 桌面仍是协议 fixture。`npm run typecheck` 检查前端、设备库和共享协议。

`cargo test --locked` 当前只作为 Topcoat 入口的编译检查；没有业务测试，不代表设备或聊天交互已验收。

真实 Chromium 沙箱测试使用配套 AIO 平台 SDK：

```sh
AIO_PLATFORM_ROOT=/path/to/aio-platform npm run test:browser
```

先安装 Playwright Chromium，或使用与 Playwright 版本一致的官方容器。该测试验证真实两层 opaque iframe、Worker 模块、原生请求桥、路由、刷新和浏览器前进后退；文件场景验证选择、拖入、粘贴、二进制、空文件、过期选择丢弃、失败反馈和重试。目录场景用 CDP 浏览器原生拖拽输入实际磁盘目录，通过配套 SDK 的真实宿主读取，覆盖超过 100 项的分页、中文/隐藏文件、嵌套空目录、空根目录、设备失败清理及刷新后的完整文件保留；最终比较设备测试进程写入的实际字节。还验证原版链接拖拽分支使用浏览器默认行为。

原版模块的同步路径读取和目录分类契约由测试模块验证；Native 请求应答和桌面 CDP 是协议 fixture，不代表真实 Codex 文件界面、菜单或智能体执行。普通文件 drop/paste 部分使用合成事件，目录拖入使用真实浏览器文件系统输入；截图保存在忽略目录 `.local/`。配套 AIO SDK 的目录读取授权、票据变更、挂载销毁及旧订阅丢弃在平台仓库 `sdk/web/file-drop.test.mjs` 验证。

发布验收另需运行实际 Codex Buddy，完成聊天发送、流式回复、停止、审批、文件操作及设备撤权，并核对 AIO 实际安装 revision。
