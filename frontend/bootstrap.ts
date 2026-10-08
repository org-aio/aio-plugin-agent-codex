import {createBrowserTransport} from './transport.js';
import {encode, type NativeFrame, type NativeSnapshot} from '../shared/wire.js';

const script = document.currentScript as HTMLScriptElement | null;
if (!script?.src || !script.dataset.entry) { throw new Error('Codex 网页模块入口缺失'); }
const root = new URL('.', script.src);
const entry = new URL(script.dataset.entry, root);
const channel = new URL('__channel', root);
channel.protocol = channel.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(channel);
let transport: ReturnType<typeof createBrowserTransport> | undefined;
let initialized = false;
let loaded = false;
let stopped = false;
const waiting: NativeFrame[] = [];
let requestedRoute: string | undefined;

function navigate(): void {
  if (!transport || !requestedRoute) { return; }
  transport.receive({kind: 'native-message', payload: encode({type: 'navigate-to-route', path: requestedRoute})});
  requestedRoute = undefined;
}
window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== parent || message?.protocol !== 'aio:device-view@1' || message.kind !== 'navigate') { return; }
  if (typeof message.route !== 'string' || !message.route.startsWith('/') || message.route.startsWith('//') || message.route.length > 2048 || /[?#\\\x00-\x1f]/.test(message.route)) { return; }
  requestedRoute = message.route;
  if (loaded) { navigate(); }
});

function status(kind: string, error?: string): void {
  parent.postMessage({protocol: 'aio:device-view@1', kind, error}, '*');
}
function stop(message: string): void {
  if (stopped) { return; }
  stopped = true;
  transport?.dispose();
  socket.close();
  status('error', message);
}

// 原版偏好由 Native 管理；不透明沙箱中浏览器存储只保存本次页面的临时状态。
for (const key of ['localStorage', 'sessionStorage'] as const) {
  try { window[key].getItem('__aioStorageProbe'); }
  catch {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: key => values.get(String(key)) ?? null,
      key: index => [...values.keys()][index] ?? null,
      removeItem: key => { values.delete(String(key)); },
      setItem: (key, value) => { values.set(String(key), String(value)); },
    };
    Object.defineProperty(window, key, {value: storage, configurable: true});
  }
}

// 不透明来源无法启动 blob 模块 Worker，data 启动入口再导入同一视图的资源。
const BrowserWorker = window.Worker;
window.Worker = class extends BrowserWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    const address = new URL(String(url), document.baseURI);
    if (address.protocol === "data:") { super(address, options); return; }
    if (!address.href.startsWith(root.href)) { throw new Error("Worker 资源不属于此设备视图"); }
    const source = options?.type === "module" ? `import ${JSON.stringify(address.href)};` : `importScripts(${JSON.stringify(address.href)});`;
    super("data:text/javascript;charset=utf-8," + encodeURIComponent(source), options);
  }
};
for (const method of ["pushState", "replaceState"] as const) {
  const native = history[method].bind(history);
  history[method] = (data, unused, url) => {
    native(data, unused, url);
    const route = new URL(location.href).searchParams.get("initialRoute");
    if (route?.startsWith("/") && !route.startsWith("//") && route.length < 2048) {
      const path = new URL(route, "https://view.invalid").pathname;
      parent.postMessage({protocol: "aio:device-view@1", kind: "route", route: path, replace: method === "replaceState"}, "*");
    }
  };
}

async function initialize(snapshot: NativeSnapshot): Promise<void> {
  if (initialized || stopped) { throw new Error('Codex 网页初始化重复或连接已关闭'); }
  initialized = true;
  transport = createBrowserTransport({
    snapshot,
    onUploadState: (pending, error) => parent.postMessage({protocol: 'aio:device-view@1', kind: 'upload', pending, error}, '*'),
    async send(frame) {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 16 * 1024 * 1024) { throw new Error('设备通道中断或过载，执行结果需要重新确认'); }
      socket.send(JSON.stringify(frame));
    },
    onError: error => stop(error.message),
  });
  const config = globalThis as typeof globalThis & {__zod_globalConfig?: {jitless?: boolean}};
  config.__zod_globalConfig ??= {};
  config.__zod_globalConfig.jitless = true;
  await import(entry.href);
  if (stopped) { return; }
  const buddy = document.createElement('script');
  buddy.src = new URL('__buddy.js', root).href;
  buddy.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    buddy.onload = () => resolve();
    buddy.onerror = () => reject(new Error('Codex Buddy 页面扩展加载失败'));
    document.head.append(buddy);
  });
  for (const frame of waiting.splice(0)) { transport.receive(frame); }
  loaded = true;
  navigate();
  status('ready');
}

socket.onmessage = event => {
  try {
    const message = JSON.parse(event.data);
    if (message.kind === 'ready') { void initialize(message.snapshot).catch(error => stop(error.message)); return; }
    if (message.kind === 'closed') { stop('设备已断开，请重新连接'); return; }
    if (message.kind === 'error') { stop(message.error ?? 'Codex 设备连接失败'); return; }
    if (message.kind === 'frame') {
      if (transport) { transport.receive(message.frame); }
      else if (waiting.length < 256) { waiting.push(message.frame); }
      else { stop('Codex 启动消息超出限制'); }
    }
  } catch { stop('设备消息无法解析，请重新连接'); }
};
socket.onclose = () => stop('设备通道已断开，请重新连接；之前的操作结果需要重新确认');
socket.onerror = () => stop('无法连接设备通道');
const startupTimeout = setTimeout(() => { if (!initialized) { stop('Codex 启动超时，请检查设备上的桌面应用'); } }, 90_000);
window.addEventListener('pagehide', () => { clearTimeout(startupTimeout); stopped = true; transport?.dispose(); socket.close(); }, {once: true});
