import CDP from "chrome-remote-interface";
import { randomUUID } from "node:crypto";
import { decode, validateWebFrame, type NativeFrame, type NativeSnapshot, type WebFrame } from "../shared/wire.js";
import { FileUploads } from "./uploads.js";
import { type UploadFrame } from "../shared/uploads.js";

declare const NATIVE_BOOTSTRAP_SOURCE: string;
type Client = Awaited<ReturnType<typeof CDP>>;
type InspectorEvent = { method: string; params: Record<string, any>; sessionId?: string };

export interface ConnectionOptions {
  endpoint: string;
  onFrame(frame: NativeFrame): void;
  timeoutMs?: number;
}

function loopbackEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Codex 调试连接必须是设备本机的 loopback HTTP 地址");
  }
  return url;
}

export class CodexWebConnection {
  private readonly route = `/local/${randomUUID()}`;
  private client?: Client;
  private targetId?: string;
  private sessionId?: string;
  private stopped = false;
  private creating?: Promise<void>;
  private closing?: Promise<void>;
  private incoming = Promise.resolve();
  private readonly uploads = new FileUploads();
  private resolveReady?: (value: NativeSnapshot) => void;
  private rejectReady?: (error: Error) => void;
  private readonly endpoint: URL;
  constructor(private readonly options: ConnectionOptions) {
    this.endpoint = loopbackEndpoint(options.endpoint);
  }

  async open(): Promise<NativeSnapshot> {
    if (this.client || this.stopped) { throw new Error("Codex 网页连接不能重复启动"); }
    const [version, targets] = await Promise.all([
      this.fetchMetadata("/json/version"),
      this.fetchMetadata("/json/list"),
    ]);
    if (this.stopped) { throw new Error("Codex 网页连接已关闭"); }
    const source = targets.find((target: any) => target.type === "page" && target.url === "app://-/index.html");
    if (!source) { throw new Error("未找到通过 Codex Buddy 启动的原生主窗口"); }
    const socket = new URL(version.webSocketDebuggerUrl);
    if (socket.protocol !== "ws:" || socket.hostname !== this.endpoint.hostname || socket.port !== this.endpoint.port) {
      throw new Error("Codex 浏览器调试端点与本机来源不一致");
    }
    const client = await CDP({ target: socket.href });
    if (this.stopped) {
      await client.close();
      throw new Error("Codex 网页连接已关闭");
    }
    this.client = client;
    const ready = new Promise<NativeSnapshot>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 关闭可发生在源窗口的 attach 应答之前，提前处理拒绝以免产生未处理异常。
    void ready.catch(() => undefined);
    const timeout = setTimeout(() => this.fail(new Error("Codex 网页窗口启动超时")), this.options.timeoutMs ?? 60_000);
    client.on("event", (event: InspectorEvent) => {
      void this.handleEvent(event).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
    });
    client.on("disconnect", () => {
      if (!this.stopped) { this.fail(new Error("Codex 桌面连接已经中断")); }
    });
    try {
      const sourceSession = await client.send("Target.attachToTarget", { targetId: source.id, flatten: true });
      await client.send("Target.setDiscoverTargets", { discover: true });
      // 原生窗口先完成自身初始化，再重载为独立桥接页面；不替换用户当前窗口的 App View。
      if (this.stopped) { throw new Error("Codex 网页连接已关闭"); }
      const setup = this.createWindow(client, sourceSession.sessionId);
      this.creating = setup;
      return await Promise.race([ready, setup.then(() => ready)]);
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async createWindow(client: Client, sourceSession: string): Promise<void> {
    const result = await client.send("Runtime.evaluate", {
      expression: `window.electronBridge.sendMessageFromView(${JSON.stringify({ type: "open-in-new-window", path: this.route })})`,
      awaitPromise: true,
      returnByValue: true,
    }, sourceSession);
    if (result.exceptionDetails) { throw new Error("Codex 拒绝创建独立网页窗口"); }
    const { targetInfos } = await client.send("Target.getTargets");
    const target = targetInfos.find(info => this.ownsUrl(info.url));
    if (!target) { throw new Error("未找到本连接创建的 Codex 窗口"); }
    this.targetId = target.targetId;
    if (this.stopped) { return; }
    const attached = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    this.sessionId = attached.sessionId;
    await client.send("Page.enable", undefined, attached.sessionId);
    await client.send("Runtime.enable", undefined, attached.sessionId);
    await client.send("Runtime.addBinding", { name: "__aioNativeFrame" }, attached.sessionId);
    // app 协议不经过 Fetch；文档重载保留官方 preload，并关闭旧 Renderer 的消息端口。
    const source = `if (new URL(location.href).searchParams.get("initialRoute") === ${JSON.stringify(this.route)}) {
      const root = document.documentElement ?? document.appendChild(document.createElement("html"));
      const head = document.head ?? root.appendChild(document.createElement("head"));
      const policy = document.createElement("meta"); policy.httpEquiv = "Content-Security-Policy"; policy.content = "script-src 'none'"; head.prepend(policy);
      window.addEventListener("DOMContentLoaded", () => { document.body.replaceChildren(); document.title = "AIO Codex Web Host"; }, {once: true});
      ${NATIVE_BOOTSTRAP_SOURCE}\n }`;
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source }, attached.sessionId);
    await client.send("Page.reload", { ignoreCache: true }, attached.sessionId);
  }

  async receive(frame: WebFrame): Promise<void> {
    validateWebFrame(frame);
    this.incoming = this.incoming.then(() => this.dispatch(frame));
    return this.incoming;
  }

  private async dispatch(frame: WebFrame): Promise<void> {
    if (this.stopped || !this.client || !this.sessionId) { throw new Error("Codex 网页窗口尚未连接"); }
    if (frame.kind.startsWith("upload-")) {
      const upload = frame as UploadFrame;
      try {
        const path = await this.uploads.receive(upload);
        this.options.onFrame({ kind: "upload-result", id: upload.id, ...(path ? { path } : {}) });
      } catch (error) {
        this.options.onFrame({ kind: "upload-result", id: upload.id, error: error instanceof Error ? error.message : "设备附件传输失败" });
      }
      return;
    }
    const result = await this.client.send("Runtime.evaluate", {
      expression: `window.__aioCodexNative.receive(${JSON.stringify(frame)})`,
      returnByValue: true,
      awaitPromise: true,
    }, this.sessionId);
    if (result.exceptionDetails) { throw new Error("Codex 原生网页桥接拒绝了消息"); }
  }

  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<void> {
    this.stopped = true;
    this.rejectReady?.(new Error("Codex 网页连接已关闭"));
    this.rejectReady = undefined;
    const client = this.client;
    this.client = undefined;
    try {
      await this.incoming.catch(() => undefined);
      if (!client) { return; }
      // 窗口创建应答完成后再清理，断线时也不会遗留本连接拥有的窗口。
      await this.creating?.catch(() => undefined);
      const { targetInfos } = await client.send("Target.getTargets");
      for (const target of targetInfos) {
        if (this.ownsUrl(target.url)) { await client.send("Target.closeTarget", { targetId: target.targetId }); }
      }
    } finally {
      try { await client?.close(); }
      finally { await this.uploads.dispose(); }
    }
  }

  private async fetchMetadata(path: string): Promise<any> {
    const response = await fetch(new URL(path, this.endpoint), { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) { throw new Error(`Codex 调试端点返回 HTTP ${response.status}`); }
    return response.json();
  }

  private fail(error: Error): void {
    if (this.stopped) { return; }
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    this.options.onFrame({ kind: "error", error: error.message });
  }

  private async handleEvent(event: InspectorEvent): Promise<void> {
    if (this.stopped || !this.client) { return; }
    if (event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") {
      const info = event.params.targetInfo;
      if (this.ownsUrl(info.url)) { this.targetId = info.targetId; }
      return;
    }
    if (event.method === "Runtime.bindingCalled" && event.sessionId === this.sessionId && event.params.name === "__aioNativeFrame") {
      const frame = JSON.parse(event.params.payload) as NativeFrame;
      if (frame.kind === "native-ready") {
        this.resolveReady?.({ ...frame.snapshot, fileUploads: true, directoryUploads: true });
        this.resolveReady = undefined;
        this.rejectReady = undefined;
      } else {
        if (frame.kind === "native-message") {
          const value = decode(frame.payload) as {type?: string; path?: string} | null;
          if (value?.type === "navigate-to-route" && value.path === this.route) { return; }
        }
        this.options.onFrame(frame);
      }
      return;
    }
    if (event.method === "Target.detachedFromTarget" && event.params.sessionId === this.sessionId) {
      this.fail(new Error("Codex 网页窗口已关闭"));
    }
  }

  private ownsUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "app:" && url.hostname === "-" && url.pathname === "/index.html" && url.searchParams.get("initialRoute") === this.route;
    } catch { return false; }
  }

}
