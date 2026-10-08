import { decode, encode, SENTRY_METHODS, type NativeFrame, type NativeSnapshot, type WebFrame } from "../shared/wire.js";
import { installFileUploads } from "./files.js";

export interface BrowserTransportOptions {
  snapshot: NativeSnapshot;
  send(frame: WebFrame): Promise<void>;
  onError(error: Error): void;
  onUploadState?(pending: number, error?: string): void;
}

export function createBrowserTransport(options: BrowserTransportOptions) {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const workers = new Map<string, Set<(value: unknown) => void>>();
  const themeListeners = new Set<() => void>();
  const sharedObjects = { ...options.snapshot.sharedObjects };
  let theme = options.snapshot.theme;
  let appHost: MessagePort | undefined;
  let disposed = false;
  let outgoing = Promise.resolve();
  const originalPostMessage = window.postMessage;
  // MessagePort 的顺序也是 RPC 对象生命周期的顺序，网络调用必须保持它。
  const transmit = (frame: WebFrame): Promise<void> => {
    outgoing = outgoing.then(() => {
      if (disposed) { throw new Error("Codex 网页连接已经关闭"); }
      return options.send(frame);
    });
    return outgoing;
  };
  const send = (frame: WebFrame): void => {
    if (disposed) { return; }
    void transmit(frame).catch(error => options.onError(error instanceof Error ? error : new Error(String(error))));
  };
  const request = (id: string, frame: WebFrame): Promise<unknown> => {
    if (disposed) { return Promise.reject(new Error("Codex 网页连接已经关闭")); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Codex 桌面请求超时，执行结果需要重新确认"));
      }, 60_000);
      pending.set(id, { resolve, reject, timer });
      void transmit(frame).catch(error => {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  };
  const call = (method: Extract<WebFrame, { kind: "call" }>["method"], args: unknown[]): Promise<unknown> => {
    const id = crypto.randomUUID();
    return request(id, { kind: "call", id, method, payload: encode(args) });
  };
  const files = installFileUploads({
    enabled: options.snapshot.fileUploads === true,
    request: frame => request(frame.id, frame),
    onState: (pending, error) => options.onUploadState?.(pending, error),
  });
  const bridge = {
    windowType: "electron",
    getPreloadStartedAtMs: () => performance.timeOrigin,
    getInitialSidebarBootstrap: () => options.snapshot.initialSidebarBootstrap,
    getSentryInitOptions: () => options.snapshot.sentryInitOptions,
    getAppSessionId: () => options.snapshot.appSessionId,
    getBuildFlavor: () => options.snapshot.buildFlavor,
    getDesktopUserAgent: () => options.snapshot.desktopUserAgent,
    getSystemThemeVariant: () => theme,
    isDeviceCheckSupported: () => options.snapshot.isDeviceCheckSupported,
    isIntelMacBuild: () => options.snapshot.isIntelMacBuild,
    getSharedObjectSnapshotValue: (key: string) => sharedObjects[key],
    getPathForFile: (file: File) => files.path(file),
    startFileDrag: (_value: unknown) => false,
    startLinkDrag: (value: unknown) => { void call("startLinkDrag", [value]).catch(options.onError); },
    acknowledgeChunkedMessage: (transferId: string, sequence: number) => {
      void call("acknowledgeChunkedMessage", [transferId, sequence]).catch(options.onError);
    },
    sendMessageFromView: (message: any) => {
      if (message?.type === "shared-object-set") {
        if (message.value === undefined) { delete sharedObjects[message.key]; }
        else { sharedObjects[message.key] = message.value; }
      }
      return call("sendMessageFromView", [message]);
    },
    sendWorkerMessageFromView: (worker: string, message: unknown) => call("sendWorkerMessageFromView", [worker, message]),
    showContextMenu: (template: unknown, position: unknown) => call("showContextMenu", [template, position]),
    getFastModeRolloutMetrics: (value: unknown) => call("getFastModeRolloutMetrics", [value]),
    subscribeToSystemThemeVariant: (listener: () => void) => {
      themeListeners.add(listener);
      return () => { themeListeners.delete(listener); };
    },
    subscribeToWorkerMessages: (worker: string, listener: (value: unknown) => void) => {
      let listeners = workers.get(worker);
      if (!listeners) {
        listeners = new Set();
        workers.set(worker, listeners);
        send({ kind: "subscribe-worker", worker });
      }
      listeners.add(listener);
      return () => {
        const current = workers.get(worker);
        current?.delete(listener);
        if (current?.size === 0) {
          workers.delete(worker);
          send({ kind: "unsubscribe-worker", worker });
        }
      };
    },
  };
  Object.defineProperty(window, "electronBridge", { value: bridge, configurable: true });
  if (options.snapshot.sentryIPC) {
    const sentry = Object.fromEntries(SENTRY_METHODS.map(method => [method, (...args: unknown[]) => send({ kind: "sentry", method, payload: encode(args) })]));
    Object.defineProperty(window, "__SENTRY_IPC__", { value: { "sentry-ipc": sentry }, configurable: true });
  }
  Object.defineProperty(window, "codexWindowType", { value: "electron", configurable: true });
  document.documentElement.dataset.theme = theme;
  // 不透明 iframe 的来源为 null；只承接原始 App Host 握手，其他窗口消息仍交给浏览器。
  window.postMessage = function (this: Window, message: any, targetOriginOrOptions?: any, transfer?: Transferable[]) {
    if (this === window && message?.type === "connect-app-host") {
      if (!(message.port instanceof MessagePort) || appHost) { throw new Error("Codex App Host 握手无效或重复"); }
      const port = message.port as MessagePort;
      appHost = port;
      port.onmessage = event => send({ kind: "app-host", payload: encode(event.data) });
      port.start();
      send({ kind: "connect" });
      return;
    }
    if (typeof targetOriginOrOptions === "string") {
      return Reflect.apply(originalPostMessage, this, [message, targetOriginOrOptions, transfer ?? []]);
    }
    return Reflect.apply(originalPostMessage, this, [message, targetOriginOrOptions]);
  } as typeof window.postMessage;

  return {
    receive(frame: NativeFrame): void {
      if (disposed) { return; }
      switch (frame.kind) {
        case "app-host":
          if (!appHost) { throw new Error("Codex App Host 尚未握手"); }
          appHost.postMessage(decode(frame.payload));
          return;
        case "native-message": {
          const message = decode(frame.payload) as any;
          if (message?.type === "shared-object-updated") {
            if (message.value === undefined) { delete sharedObjects[message.key]; }
            else { sharedObjects[message.key] = message.value; }
          }
          window.dispatchEvent(new MessageEvent("message", { data: message }));
          return;
        }
        case "worker":
          for (const listener of workers.get(frame.worker) ?? []) { listener(decode(frame.payload)); }
          return;
        case "theme":
          theme = frame.theme;
          document.documentElement.dataset.theme = theme;
          for (const listener of themeListeners) { listener(); }
          return;
        case "upload-result":
        case "call-result": {
          const request = pending.get(frame.id);
          if (!request) { return; }
          pending.delete(frame.id);
          clearTimeout(request.timer);
          if (frame.error) { request.reject(new Error(frame.error)); }
          else { request.resolve(frame.kind === "upload-result" ? frame.path : frame.payload ? decode(frame.payload) : undefined); }
          return;
        }
        case "error":
          options.onError(new Error(frame.error));
          return;
        case "native-ready":
          return;
      }
    },
    dispose(): void {
      if (disposed) { return; }
      for (const worker of workers.keys()) { send({ kind: "unsubscribe-worker", worker }); }
      disposed = true;
      files.dispose();
      appHost?.close();
      workers.clear();
      themeListeners.clear();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Codex 网页连接已经关闭"));
      }
      pending.clear();
      window.postMessage = originalPostMessage;
      delete window.electronBridge;
      delete window.__SENTRY_IPC__;
      delete (window as Window & { codexWindowType?: string }).codexWindowType;
    },
  };
}
