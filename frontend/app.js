const device = document.querySelector('#device');
const view = document.querySelector('#view');
const welcome = document.querySelector('#welcome');
const connect = document.querySelector('#connect');
const refresh = document.querySelector('#refresh');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
let current;
let serial = 0;
let fragment = '';
let devices = [];
let writingRoute = false;
let opening = false;
let reopen = false;
let disposeFileDrop;

function report(text, state = '') { status.textContent = text; status.dataset.state = state; }
function routeState() {
  const query = new URLSearchParams(fragment.replace(/^#/, ''));
  return {device: query.get('device') || '', route: query.get('route') || '/'};
}
function fail(cause) {
  error.textContent = cause.message || String(cause);
  report('连接不可用', 'error');
  welcome.hidden = false;
  view.hidden = true;
  connect.disabled = !device.value;
  connect.textContent = '重新连接';
}
async function loadDevices() {
  const generation = ++serial;
  refresh.disabled = true;
  try {
    devices = await window.aioPlugin.deviceView({operation: 'list'});
    if (generation !== serial) { return; }
    const selected = routeState().device || device.value;
    device.replaceChildren();
    for (const item of devices) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.label}${item.status === 'online' ? '' : ' · 离线'}`;
      option.disabled = item.status !== 'online';
      device.append(option);
    }
    if (!devices.length) { device.append(new Option('没有已开通的设备', '')); }
    if (devices.some(item => item.id === selected)) { device.value = selected; }
    connect.disabled = !devices.some(item => item.id === device.value && item.status === 'online');
    if (!current) { report(devices.length ? '选择设备后连接' : '等待设备开通'); }
    error.textContent = '';
  } catch (cause) { fail(cause); }
  finally { refresh.disabled = false; }
}
async function close() {
  disposeFileDrop?.();
  disposeFileDrop = undefined;
  const previous = current;
  current = undefined;
  view.hidden = true;
  view.removeAttribute('src');
  if (previous) { await window.aioPlugin.deviceView({operation: 'close', id: previous.id}); }
}
async function open({save = true} = {}) {
  if (opening) { if (!save) { reopen = true; } return; }
  const selected = device.value;
  const route = routeState().route;
  if (!selected || !devices.some(item => item.id === selected && item.status === 'online')) { return; }
  opening = true;
  device.disabled = true;
  refresh.disabled = true;
  connect.disabled = true;
  error.textContent = '';
  report('正在连接设备…');
  try {
    await close();
    if (save) {
      const query = new URLSearchParams({device: selected, route: routeState().route});
      writingRoute = true;
      try { await window.aioPlugin.navigate('#' + query); }
      finally { writingRoute = false; }
    }
    const opened = await window.aioPlugin.deviceView({operation: 'open', device: selected, route});
    current = {...opened, device: selected, route};
    view.src = current.src;
    view.hidden = false;
    welcome.hidden = true;
    report('正在启动 Codex…');
    connect.textContent = '重新连接';
  } catch (cause) { fail(cause); }
  finally {
    opening = false;
    device.disabled = false;
    refresh.disabled = false;
    connect.disabled = !devices.some(item => item.id === device.value && item.status === 'online');
    if (reopen) { reopen = false; void open({save: false}); }
  }
}
window.addEventListener('message', event => {
  if (event.source !== view.contentWindow || event.data?.protocol !== 'aio:device-view@1') { return; }
  if (event.data.kind === 'route' && typeof event.data.route === 'string' && event.data.route.startsWith('/') && !event.data.route.startsWith('//')) {
    const query = new URLSearchParams({device: device.value, route: event.data.route});
    writingRoute = true;
    void window.aioPlugin.navigate('#' + query, {replace: event.data.replace === true}).catch(fail).finally(() => { writingRoute = false; });
  }
  if (event.data.kind === 'ready') {
    report('已连接', 'ready');
    if (current && current.route !== routeState().route) { navigateView(routeState().route); }
    disposeFileDrop?.();
    const connection = current;
    disposeFileDrop = window.aioPlugin.onFileDrop?.(drop => {
      if (!connection || current !== connection || view.hidden) { return; }
      const rect = view.getBoundingClientRect();
      const point = {x: (drop.point?.x - rect.left) * view.clientWidth / rect.width, y: (drop.point?.y - rect.top) * view.clientHeight / rect.height};
      if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) { return; }
      view.contentWindow.postMessage({...drop, point, protocol: 'aio:device-view@1'}, '*');
    });
  }
  if (event.data.kind === 'file-drag' && current && !view.hidden) { window.aioPlugin.fileDrag?.(); }
  if (event.data.kind === 'error') { disposeFileDrop?.(); disposeFileDrop = undefined; fail(new Error(event.data.error || '设备已经断开')); }
  if (event.data.kind === 'upload' && Number.isSafeInteger(event.data.pending) && event.data.pending >= 0) {
    if (event.data.error) { report(String(event.data.error), 'error'); }
    else { report(event.data.pending ? '正在上传附件…' : '已连接', event.data.pending ? 'loading' : 'ready'); }
  }
});
connect.addEventListener('click', () => open());
refresh.addEventListener('click', () => loadDevices());
device.addEventListener('change', () => { connect.disabled = !device.value; });
document.querySelector('#copy').addEventListener('click', async () => {
  try { await window.aioPlugin.copy('aio device codex-enable'); report('命令已复制'); }
  catch (cause) { fail(cause); }
});
if (!window.aioPlugin?.deviceView) { fail(new Error('请从支持设备视图的 AIO 工作空间打开插件')); }
else {
  window.aioPlugin.onNavigationChange(next => {
    const previous = routeState();
    fragment = next;
    const target = routeState();
    if (!writingRoute && (previous.device !== target.device || previous.route !== target.route) && devices.some(item => item.id === target.device)) {
      device.value = target.device;
      if (current?.device === target.device) { navigateView(target.route); }
      else { void open({save: false}); }
    }
  });
  void loadDevices().then(() => { if (routeState().device) { return open({save: false}); } });
}

function navigateView(route) {
  if (!current) { return; }
  current.route = route;
  view.contentWindow.postMessage({protocol: 'aio:device-view@1', kind: 'navigate', route}, '*');
}
