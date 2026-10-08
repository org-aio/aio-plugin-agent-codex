import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_VIEW_UPLOAD_BYTES, MAX_VIEW_UPLOAD_ENTRIES, UPLOAD_CHUNK_BYTES, type UploadFrame } from "../shared/uploads.js";

interface Upload {
  directory: string;
  path: string;
  handle: FileHandle;
  size: number;
  received: number;
  group?: string;
}

interface DirectoryUpload {
  directory: string;
  path: string;
  entries: Map<string, "directory" | "file">;
  files: Map<string, number>;
  size: number;
  failed: boolean;
}

export class FileUploads {
  private root?: Promise<string>;
  private readonly active = new Map<string, Upload>();
  private readonly directories = new Map<string, DirectoryUpload>();
  private readonly started = new Set<string>();
  private entries = 0;
  private reserved = 0;
  private completed = 0;

  async receive(frame: UploadFrame): Promise<string | undefined> {
    switch (frame.kind) {
      case "upload-begin":
      case "upload-file-begin": await this.beginFile(frame); return;
      case "upload-directory-begin": await this.beginDirectory(frame); return;
      case "upload-directory-entry": await this.addDirectory(frame); return;
      case "upload-chunk": await this.chunk(frame); return;
      case "upload-complete": return this.complete(frame.id);
      case "upload-abort": await this.abort(frame.id); return;
    }
  }

  private capacity(size: number, entries: number): void {
    if (this.entries + entries > MAX_VIEW_UPLOAD_ENTRIES || this.reserved + size > MAX_VIEW_UPLOAD_BYTES) {
      throw new Error("本次连接的文件、目录数量或总大小超过限制，请重新连接后继续");
    }
  }

  private begin(id: string): void {
    if (this.started.has(id)) { throw new Error("附件传输不能重复开始"); }
    if (this.active.size + this.directories.size >= 8) { throw new Error("同时上传的文件或目录超过限制"); }
  }

  private async rootPath(): Promise<string> {
    this.root ??= mkdtemp(join(tmpdir(), "aio-codex-upload-"));
    return this.root;
  }

  private async beginDirectory(frame: Extract<UploadFrame, { kind: "upload-directory-begin" }>): Promise<void> {
    this.begin(frame.id);
    this.capacity(0, 1);
    const directory = join(await this.rootPath(), frame.id);
    const path = join(directory, frame.name);
    try {
      await mkdir(directory, { mode: 0o700 });
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("设备无法保存上传目录", { cause: error });
    }
    this.directories.set(frame.id, { directory, path, entries: new Map(), files: new Map(), size: 0, failed: false });
    this.started.add(frame.id);
    this.entries++;
  }

  private directory(id: string): DirectoryUpload {
    const directory = this.directories.get(id);
    if (!directory) { throw new Error("目录传输不存在或已经结束"); }
    return directory;
  }

  private missingDirectories(directory: DirectoryUpload, parts: string[]): string[] {
    const missing: string[] = [];
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join("/");
      const kind = directory.entries.get(path);
      if (kind === "file") { throw new Error("目录内的文件和目录路径冲突"); }
      if (!kind) { missing.push(path); }
    }
    return missing;
  }

  private async addDirectory(frame: Extract<UploadFrame, { kind: "upload-directory-entry" }>): Promise<void> {
    const directory = this.directory(frame.id);
    const missing = this.missingDirectories(directory, frame.relativePath.split("/"));
    this.capacity(0, missing.length);
    try { await mkdir(join(directory.path, ...frame.relativePath.split("/")), { recursive: true, mode: 0o700 }); }
    catch (error) { throw new Error("设备无法保存子目录", { cause: error }); }
    for (const path of missing) { directory.entries.set(path, "directory"); }
    this.entries += missing.length;
  }

  private async beginFile(frame: Extract<UploadFrame, { kind: "upload-begin" | "upload-file-begin" }>): Promise<void> {
    this.begin(frame.id);
    const group = frame.kind === "upload-file-begin" ? this.directory(frame.directory) : undefined;
    const relativePath = frame.kind === "upload-file-begin" ? frame.relativePath : frame.name;
    if (group?.entries.has(relativePath)) { throw new Error("目录内的文件路径不能重复"); }
    const parts = relativePath.split("/");
    const missing = group ? this.missingDirectories(group, parts.slice(0, -1)) : [];
    this.capacity(frame.size, missing.length + 1);
    const directory = group?.directory ?? join(await this.rootPath(), frame.id);
    const path = join(group?.path ?? directory, ...parts);
    try {
      await mkdir(group ? dirname(path) : directory, { recursive: !!group, mode: 0o700 });
      const handle = await open(path, "wx", 0o600);
      this.active.set(frame.id, { directory, path, handle, size: frame.size, received: 0, ...(frame.kind === "upload-file-begin" ? { group: frame.directory } : {}) });
    } catch (error) {
      if (!group) { await rm(directory, { recursive: true, force: true }); }
      throw new Error("设备无法保存上传文件", { cause: error });
    }
    if (group) {
      for (const path of missing) { group.entries.set(path, "directory"); }
      group.entries.set(relativePath, "file");
      group.files.set(frame.id, frame.size);
      group.size += frame.size;
    }
    this.started.add(frame.id);
    this.entries += missing.length + 1;
    this.reserved += frame.size;
  }

  private async chunk(frame: Extract<UploadFrame, { kind: "upload-chunk" }>): Promise<void> {
    const upload = this.require(frame.id);
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.toString("base64") !== frame.data || bytes.length > UPLOAD_CHUNK_BYTES ||
        frame.offset !== upload.received || upload.received + bytes.length > upload.size) {
      throw new Error("附件分块顺序、内容或大小不一致");
    }
    try {
      let written = 0;
      while (written < bytes.length) {
        const result = await upload.handle.write(bytes, written, bytes.length - written, upload.received + written);
        if (!result.bytesWritten) { throw new Error("设备未写入附件内容"); }
        written += result.bytesWritten;
      }
      upload.received += written;
    } catch (error) { throw new Error("设备写入附件失败", { cause: error }); }
  }

  private async complete(id: string): Promise<string> {
    const directory = this.directories.get(id);
    if (directory) {
      if (directory.failed || [...directory.files.keys()].some(file => this.active.has(file))) { throw new Error("目录内的文件尚未完整上传"); }
      this.directories.delete(id);
      this.completed++;
      return directory.path;
    }
    const upload = this.require(id);
    if (upload.received !== upload.size) { throw new Error("附件尚未完整上传"); }
    try { await upload.handle.close(); }
    catch (error) { throw new Error("设备无法完成附件写入", { cause: error }); }
    this.active.delete(id);
    if (!upload.group) { this.completed++; }
    return upload.path;
  }

  private require(id: string): Upload {
    const upload = this.active.get(id);
    if (!upload) { throw new Error("附件传输不存在或已经结束"); }
    return upload;
  }

  private async abortFile(id: string): Promise<void> {
    const upload = this.active.get(id);
    if (!upload) { return; }
    this.active.delete(id);
    this.reserved -= upload.size;
    const group = upload.group ? this.directories.get(upload.group) : undefined;
    if (group) {
      group.files.delete(id);
      group.size -= upload.size;
      group.failed = true;
    }
    try { await upload.handle.close(); }
    finally { await rm(upload.group ? upload.path : upload.directory, { recursive: !upload.group, force: true }); }
  }

  private async abort(id: string): Promise<void> {
    const directory = this.directories.get(id);
    if (!directory) { await this.abortFile(id); return; }
    const results = await Promise.allSettled([...directory.files.keys()].map(file => this.abortFile(file)));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    this.directories.delete(id);
    this.reserved -= directory.size;
    try { await rm(directory.directory, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (errors.length) { throw new AggregateError(errors, "设备上传目录清理失败"); }
  }

  async dispose(): Promise<void> {
    const directories = await Promise.allSettled([...this.directories.keys()].map(id => this.abort(id)));
    const files = await Promise.allSettled([...this.active.keys()].map(id => this.abortFile(id)));
    const errors = [...directories, ...files].flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (this.root && !this.completed) {
      try { await rm(await this.root, { recursive: true, force: true }); }
      catch (error) { errors.push(error); }
    }
    // 已交给原版界面的完整文件和目录继续供当前任务与审批读取。
    if (errors.length) { throw new AggregateError(errors, "设备附件临时文件清理失败"); }
  }
}
