import { open, readFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, posix } from "node:path";

type Entry = { size?: number; offset?: string; files?: Record<string, Entry>; link?: string; unpacked?: boolean };
export interface OriginalAsset { bytes: Uint8Array; sha256: string; contentType: string }
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".mp4": "video/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
};

export class CodexAssets {
  private handle?: FileHandle;
  private tree?: Entry;
  private base = 0;
  private buddyBytes?: Buffer;
  private archiveSize = 0;
  private readonly cache = new Map<string, OriginalAsset>();
  private cachedBytes = 0;
  constructor(private readonly asarPath: string, private readonly buddyRendererPath?: string) {}

  async open(): Promise<void> {
    if (this.handle) { throw new Error("Codex 资源读取器已经启动"); }
    const handle = await open(this.asarPath, "r");
    try {
      const stat = await handle.stat();
      const header = Buffer.alloc(16);
      const result = await handle.read(header, 0, header.length, 0);
      if (result.bytesRead !== 16) { throw new Error("Codex ASAR 文件头不完整"); }
      const length = header.readUInt32LE(12);
      const base = 8 + header.readUInt32LE(4);
      if (length > 64 * 1024 * 1024 || length < 2 || base < 16 + length || base > stat.size) {
        throw new Error("Codex ASAR 文件头长度无效");
      }
      const json = Buffer.alloc(length);
      const read = await handle.read(json, 0, length, 16);
      if (read.bytesRead !== length) { throw new Error("Codex ASAR 索引不完整"); }
      const tree = JSON.parse(json.toString("utf8")) as Entry;
      if (!tree.files?.webview?.files) { throw new Error("Codex 安装包缺少原始 Web 前端"); }
      if (this.buddyRendererPath) {
        this.buddyBytes = await readFile(this.buddyRendererPath);
        if (this.buddyBytes.length > 32 * 1024 * 1024) { throw new Error("Buddy 页面扩展超过限制"); }
      }
      this.handle = handle;
      this.tree = tree;
      this.base = base;
      this.archiveSize = stat.size;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(path: string): Promise<OriginalAsset> {
    if (!this.handle || !this.tree) { throw new Error("Codex 资源读取器尚未启动"); }
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes("?") ||
        path.includes("#") || path.split("/").some(part => !part || part === "." || part === "..") || posix.normalize(path) !== path) {
      throw new Error("Codex 资源路径无效");
    }
    const cached = this.cache.get(path);
    if (cached) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      return cached;
    }
    let bytes: Buffer;
    if (path === "__buddy.js") {
      if (!this.buddyRendererPath) { throw new Error("此设备没有可用的 Codex Buddy Renderer"); }
      if (!this.buddyBytes) { throw new Error("Buddy 页面扩展尚未初始化"); }
      bytes = this.buddyBytes;
    } else {
      let entry: Entry | undefined = this.tree.files?.webview;
      for (const part of path.split("/")) {
        entry = entry?.files && Object.hasOwn(entry.files, part) ? entry.files[part] : undefined;
      }
      if (!entry || entry.files || entry.link || entry.unpacked || typeof entry.size !== "number" ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 32 * 1024 * 1024 ||
          typeof entry.offset !== "string" || !/^\d+$/.test(entry.offset)) {
        throw new Error("Codex 资源不存在或不可读取");
      }
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || this.base + offset + entry.size > this.archiveSize) {
        throw new Error("Codex 资源索引超出安装包范围");
      }
      bytes = Buffer.alloc(entry.size);
      const result = await this.handle.read(bytes, 0, entry.size, this.base + offset);
      if (result.bytesRead !== entry.size) { throw new Error("Codex 资源读取不完整"); }
    }
    if (bytes.length > 32 * 1024 * 1024) { throw new Error("Codex 资源超过传输限制"); }
    const asset = {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: MIME[extname(path)] ?? "application/octet-stream",
    };
    while (this.cachedBytes + bytes.length > 64 * 1024 * 1024 || this.cache.size >= 256) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) { break; }
      this.cachedBytes -= this.cache.get(oldest)!.bytes.length;
      this.cache.delete(oldest);
    }
    this.cache.set(path, asset);
    this.cachedBytes += bytes.length;
    return asset;
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    this.tree = undefined;
    this.buddyBytes = undefined;
    this.cache.clear();
    this.cachedBytes = 0;
    await handle?.close();
  }
}
