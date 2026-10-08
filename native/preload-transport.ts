import { decode, encode, validateWebFrame, type NativeSnapshot, type WebFrame } from "../shared/wire.js";

interface NativeBridge {
  sendMessageFromView(value: unknown): Promise<unknown>;
  sendWorkerMessageFromView(worker: string, value: unknown): Promise<unknown>;
  subscribeToWorkerMessages(worker: string, callback: (message: unknown) => void): () => void;
  subscribeToSystemThemeVariant(callback: () => void): () => void;
  getSharedObjectSnapshotValue(key: string): unknown;
  getInitialSidebarBootstrap(): unknown;
  getSentryInitOptions(): unknown;
  getAppSessionId(): string;
  getBuildFlavor(): string;
  getDesktopUserAgent(): string;
  getSystemThemeVariant(): string;
  isDeviceCheckSupported(): boolean;
  isIntelMacBuild(): boolean;
}

declare global {
  interface Window {
    electronBridge?: NativeBridge;
    __aioNativeFrame?: (value: string) => void;
    __SENTRY_IPC__?: Record<string, Record<string, (...args: unknown[]) => void>>;
    __aioCodexNative?: { receive(frame: WebFrame): void; snapshot(): NativeSnapshot; dispose(): void };
  }
}

function install(): void {
  const bridge = window.electronBridge;
  const binding = window.__aioNativeFrame;
  if (!bridge || typeof bridge.sendMessageFromView !== "function" || !binding) {
    throw new Error("Codex 原生预加载通信契约不可用");
  }
  const send = (frame: unknown): void => binding(JSON.stringify(frame));
  let port: MessagePort | undefined;
  const workers = new Map<string, () => void>();
  const receiveNative = (event: MessageEvent): void => {
    if (event.data?.type === "connect-app-host") { return; }
    if (event.source != null && event.source !== window) { return; }
    if (event.data && (typeof event.data.type === "string" || event.data.marker === "codex-host-chunked-message-v1")) {
      send({ kind: "native-message", payload: encode(event.data) });
    }
  };
  window.addEventListener("message", receiveNative);
  const stopTheme = bridge.subscribeToSystemThemeVariant(() => {
    send({ kind: "theme", theme: bridge.getSystemThemeVariant() });
  });
  const snapshot = (): NativeSnapshot => ({
    initialSidebarBootstrap: bridge.getInitialSidebarBootstrap(),
    sentryInitOptions: bridge.getSentryInitOptions(),
    appSessionId: bridge.getAppSessionId(),
    buildFlavor: bridge.getBuildFlavor(),
    desktopUserAgent: bridge.getDesktopUserAgent(),
    theme: bridge.getSystemThemeVariant(),
    isDeviceCheckSupported: bridge.isDeviceCheckSupported(),
    isIntelMacBuild: bridge.isIntelMacBuild(),
    sharedObjects: { host_config: bridge.getSharedObjectSnapshotValue("host_config") },
    sentryIPC: !!window.__SENTRY_IPC__?.["sentry-ipc"],
  });
  const receive = (frame: WebFrame): void => {
    validateWebFrame(frame);
    switch (frame.kind) {
      case "connect": {
        if (port) { throw new Error("Codex App Host 端口已经建立"); }
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = event => send({ kind: "app-host", payload: encode(event.data) });
        port.start();
        window.postMessage({ type: "connect-app-host", port: channel.port2 }, window.location.origin, [channel.port2]);
        return;
      }
      case "app-host":
        if (!port) { throw new Error("Codex App Host 端口尚未建立"); }
        port.postMessage(decode(frame.payload));
        return;
      case "subscribe-worker":
        if (!workers.has(frame.worker)) {
          workers.set(frame.worker, bridge.subscribeToWorkerMessages(frame.worker, message => {
            send({ kind: "worker", worker: frame.worker, payload: encode(message) });
          }));
        }
        return;
      case "unsubscribe-worker":
        workers.get(frame.worker)?.();
        workers.delete(frame.worker);
        return;
      case "sentry": {
        const method = window.__SENTRY_IPC__?.["sentry-ipc"]?.[frame.method];
        const args = decode(frame.payload);
        if (typeof method !== "function" || !Array.isArray(args)) { throw new Error("Codex 原生日志通信不可用"); }
        Reflect.apply(method, window.__SENTRY_IPC__!["sentry-ipc"], args);
        return;
      }
      case "call": {
        const method = (bridge as unknown as Record<string, unknown>)[frame.method];
        if (typeof method !== "function") { throw new Error("Codex 原生通信方法不可用"); }
        const args = decode(frame.payload);
        if (!Array.isArray(args)) { throw new Error("Codex 原生调用参数无效"); }
        Promise.resolve(Reflect.apply(method, bridge, args)).then(
          value => send({ kind: "call-result", id: frame.id, payload: encode(value) }),
          error => send({ kind: "call-result", id: frame.id, error: error instanceof Error ? error.message : String(error) }),
        );
        return;
      }
    }
  };
  window.__aioCodexNative = {
    receive,
    snapshot,
    dispose() {
      port?.close();
      for (const unsubscribe of workers.values()) { unsubscribe(); }
      workers.clear();
      stopTheme();
      window.removeEventListener("message", receiveNative);
      delete window.__aioCodexNative;
    },
  };
  send({ kind: "native-ready", snapshot: snapshot() });
  // 最小原生页面也必须完成 Renderer 生命周期，否则 Main 会继续缓存普通消息。
  void bridge.sendMessageFromView({ type: "ready" }).catch(error => {
    send({ kind: "error", error: error instanceof Error ? error.message : String(error) });
  });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", install, { once: true });
} else {
  install();
}
