import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_VIEW_UPLOAD_BYTES, MAX_VIEW_UPLOAD_FILES, UPLOAD_CHUNK_BYTES, type UploadFrame } from "../shared/uploads.js";

interface Upload {
  directory: string;
  path: string;
  handle: FileHandle;
  size: number;
  received: number;
}

export class FileUploads {
  private root?: Promise<string>;
  private readonly active = new Map<string, Upload>();
  private readonly started = new Set<string>();
  private reserved = 0;
  private completed = 0;

  async receive(frame: UploadFrame): Promise<string | undefined> {
    switch (frame.kind) {
      case "upload-begin": await this.begin(frame); return;
      case "upload-chunk": await this.chunk(frame); return;
      case "upload-complete": return this.complete(frame.id);
      case "upload-abort": await this.abort(frame.id); return;
    }
  }

  private async begin(frame: Extract<UploadFrame, { kind: "upload-begin" }>): Promise<void> {
    if (this.started.has(frame.id)) { throw new Error("附件传输不能重复开始"); }
    if (this.active.size >= 8 || this.started.size >= MAX_VIEW_UPLOAD_FILES || this.reserved + frame.size > MAX_VIEW_UPLOAD_BYTES) {
      throw new Error("本次连接的附件数量或总大小超过限制，请重新连接后继续");
    }
    this.root ??= mkdtemp(join(tmpdir(), "aio-codex-upload-"));
    const directory = join(await this.root, frame.id);
    const path = join(directory, frame.name);
    try {
      await mkdir(directory, { mode: 0o700 });
      const handle = await open(path, "wx", 0o600);
      this.active.set(frame.id, { directory, path, handle, size: frame.size, received: 0 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("设备无法保存上传文件", { cause: error });
    }
    this.started.add(frame.id);
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
    } catch (error) {
      throw new Error("设备写入附件失败", { cause: error });
    }
  }

  private async complete(id: string): Promise<string> {
    const upload = this.require(id);
    if (upload.received !== upload.size) { throw new Error("附件尚未完整上传"); }
    try { await upload.handle.close(); }
    catch (error) { throw new Error("设备无法完成附件写入", { cause: error }); }
    this.active.delete(id);
    this.completed++;
    return upload.path;
  }

  private require(id: string): Upload {
    const upload = this.active.get(id);
    if (!upload) { throw new Error("附件传输不存在或已经结束"); }
    return upload;
  }

  private async abort(id: string): Promise<void> {
    const upload = this.active.get(id);
    if (!upload) { return; }
    this.active.delete(id);
    this.reserved -= upload.size;
    try { await upload.handle.close(); }
    finally { await rm(upload.directory, { recursive: true, force: true }); }
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.active.keys()].map(id => this.abort(id)));
    const errors = results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason);
    if (this.root && !this.completed) {
      try { await rm(await this.root, { recursive: true, force: true }); }
      catch (error) { errors.push(error); }
    }
    // 已交给原版界面的文件继续供当前任务与审批读取，不能随浏览器断线删除。
    if (errors.length) { throw new AggregateError(errors, "设备附件临时文件清理失败"); }
  }
}
