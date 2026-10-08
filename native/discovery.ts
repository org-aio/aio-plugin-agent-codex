import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';

export interface LocalRuntime { endpoint: string; buddyRenderer: string; asar: string }

export function runtimeDescriptorPath(): string {
  if (process.env.CODEXHOST_RUNTIME_DESCRIPTOR_PATH) { return process.env.CODEXHOST_RUNTIME_DESCRIPTOR_PATH; }
  if (process.platform === 'darwin') { return join(homedir(), 'Library/Application Support/codexhost/desktop-runtime-v1.json'); }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) { return join(process.env.LOCALAPPDATA, 'codexhost/desktop-runtime-v1.json'); }
  if (process.env.XDG_RUNTIME_DIR) { return join(process.env.XDG_RUNTIME_DIR, 'codexhost/desktop-runtime-v1.json'); }
  throw new Error('未找到 Codex Buddy 运行时目录，请通过 Codex Buddy 启动桌面应用');
}

export async function discoverRuntime(options: {descriptor?: string; asar?: string} = {}): Promise<LocalRuntime> {
  const descriptor = JSON.parse(await readFile(options.descriptor ?? runtimeDescriptorPath(), 'utf8')) as Record<string, unknown>;
  if (descriptor.schema_version !== 1 || !Number.isInteger(descriptor.control_port) || Number(descriptor.control_port) < 1 || Number(descriptor.control_port) > 65535 || typeof descriptor.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(descriptor.nonce)) {
    throw new Error('Codex Buddy 本机运行时描述无效');
  }
  const info = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection({host: '127.0.0.1', port: Number(descriptor.control_port)});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('Codex Buddy 本机发现超时')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`WEB ${descriptor.nonce}\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024) { socket.destroy(new Error('Codex Buddy 本机描述过大')); }
    });
    socket.once('end', () => {
      try { resolve(JSON.parse(buffer)); }
      catch { reject(new Error('当前 Codex Buddy 尚未提供网页入口，请更新 Buddy')); }
    });
  });
  if (info.schemaVersion !== 1 || typeof info.rendererCdpEndpoint !== 'string' || typeof info.rendererPath !== 'string') { throw new Error('Codex Buddy 网页运行时描述无效'); }
  const asar = options.asar ?? (process.platform === 'darwin' ? '/Applications/ChatGPT.app/Contents/Resources/app.asar' : undefined);
  if (!asar) { throw new Error('此系统需要用 --asar 指定已安装 Codex 的 resources/app.asar'); }
  return {endpoint: info.rendererCdpEndpoint, buddyRenderer: info.rendererPath, asar};
}
