import { UPLOAD_CHUNK_BYTES, validateUploadFrame, type UploadFrame } from "../shared/uploads.js";

interface FileOptions {
  enabled: boolean;
  request(frame: UploadFrame): Promise<unknown>;
  onState(pending: number, error?: string): void;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function installFileUploads(options: FileOptions) {
  const paths = new WeakMap<File, string>();
  const staging = new WeakMap<File, Promise<void>>();
  const generations = new WeakMap<EventTarget, object>();
  let disposed = false;
  let pending = 0;

  async function upload(file: File): Promise<void> {
    const id = crypto.randomUUID();
    const begin: UploadFrame = { kind: "upload-begin", id, name: file.name, size: file.size };
    validateUploadFrame(begin);
    try {
      await options.request(begin);
      for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
        if (disposed) { throw new Error("附件上传已随设备连接关闭"); }
        const buffer = await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer();
        const data = base64(new Uint8Array(buffer));
        await options.request({ kind: "upload-chunk", id, offset, data });
      }
      const path = await options.request({ kind: "upload-complete", id });
      if (typeof path !== "string" || !path.length) { throw new Error("设备未确认附件保存路径"); }
      paths.set(file, path);
    } catch (error) {
      // 只清理本次未完成的上传；断线时由设备端关闭连接统一回收。
      if (!disposed) { await options.request({ kind: "upload-abort", id }); }
      throw error;
    }
  }

  function stage(file: File): Promise<void> {
    if (paths.has(file)) { return Promise.resolve(); }
    const existing = staging.get(file);
    if (existing) { return existing; }
    const operation = upload(file).finally(() => { staging.delete(file); });
    staging.set(file, operation);
    return operation;
  }

  function capture(event: Event): void {
    if (disposed) { return; }
    const target = event.target;
    if (!target) { return; }
    const input = target instanceof HTMLInputElement && target.type === "file" ? target : undefined;
    const original = event instanceof DragEvent ? event.dataTransfer : event instanceof ClipboardEvent ? event.clipboardData : null;
    const files = Array.from(input?.files ?? original?.files ?? []);
    if (!files.length || files.every(file => paths.has(file))) { return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    const generation = {};
    generations.set(target, generation);
    // 浏览器只允许在原事件期间读取剪贴板或拖拽数据，先保存文本和 File 引用。
    const transfer = original ? new DataTransfer() : undefined;
    if (original && transfer) {
      for (const type of original.types) {
        if (type !== "Files") { transfer.setData(type, original.getData(type)); }
      }
      for (const file of files) { transfer.items.add(file); }
    }
    const directory = original && Array.from(original.items).some(item => item.webkitGetAsEntry?.()?.isDirectory);
    const replay = event instanceof DragEvent ? new DragEvent(event.type, {
      bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed, dataTransfer: transfer,
      clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
      ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
    }) : event instanceof ClipboardEvent ? new ClipboardEvent(event.type, {
      bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed, clipboardData: transfer,
    }) : new Event(event.type, { bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed });
    pending++;
    options.onState(pending);
    void (async () => {
      let message: string | undefined;
      try {
        if (directory) { throw new Error("请在设备上的 Codex 中选择项目目录；网页当前支持上传文件"); }
        for (const file of files) { await stage(file); }
        if (disposed || generations.get(target) !== generation) { return; }
        if (input && (input.files?.length !== files.length || files.some((file, index) => input.files?.item(index) !== file))) { return; }
        if (transfer) {
          Array.from(transfer.files).forEach((file, index) => { paths.set(file, paths.get(files[index])!); });
        }
        target.dispatchEvent(replay);
      } catch (error) {
        message = error instanceof Error ? error.message : "附件上传失败";
      } finally {
        pending--;
        if (!disposed) { options.onState(pending, message); }
      }
    })();
  }

  if (options.enabled) {
    for (const kind of ["change", "drop", "paste"]) { window.addEventListener(kind, capture, true); }
  }
  return {
    path(file: File): string | null { return paths.get(file) ?? null; },
    dispose(): void {
      disposed = true;
      for (const kind of ["change", "drop", "paste"]) { window.removeEventListener(kind, capture, true); }
    },
  };
}
