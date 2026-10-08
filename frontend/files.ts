import { MAX_VIEW_UPLOAD_BYTES, MAX_VIEW_UPLOAD_ENTRIES, UPLOAD_CHUNK_BYTES, validateUploadFrame, type UploadFrame } from "../shared/uploads.js";
import { directoryEntries, type DirectoryRoot, type DropRoot } from "./directory-entries.js";

interface FileOptions {
  enabled: boolean;
  directories: boolean;
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

// 浏览器每次访问 items 都可创建新的包装对象，在重放的 DataTransfer 上保留分类。
function preserveEntries(transfer: DataTransfer, entries: (FileSystemEntry | null)[]): void {
  const list = transfer.items;
  const itemAt = (index: number) => new Proxy(list[index], {
    get(item, key) {
      if (key === "webkitGetAsEntry") { return () => entries[index] ?? null; }
      const value = Reflect.get(item, key, item);
      return typeof value === "function" ? value.bind(item) : value;
    },
  });
  Object.defineProperty(transfer, "items", { value: new Proxy(list, {
    get(items, key) {
      if (key === Symbol.iterator) { return function* () { for (let index = 0; index < items.length; index++) { yield itemAt(index); } }; }
      if (typeof key === "string" && /^\d+$/.test(key) && Number(key) < items.length) { return itemAt(Number(key)); }
      const value = Reflect.get(items, key, items);
      return typeof value === "function" ? value.bind(items) : value;
    },
  }) });
}

export function installFileUploads(options: FileOptions) {
  const paths = new WeakMap<File, string>();
  const staging = new WeakMap<File, Promise<void>>();
  const generations = new WeakMap<EventTarget, object>();
  const directories = new WeakMap<File, DirectoryRoot>();
  let disposed = false;
  let pending = 0;

  async function upload(file: File, begin: Extract<UploadFrame, { kind: "upload-begin" | "upload-file-begin" }>): Promise<string> {
    const id = begin.id;
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
      return path;
    } catch (error) {
      // 只清理本次未完成的上传；断线时由设备端关闭连接统一回收。
      if (!disposed) { await options.request({ kind: "upload-abort", id }); }
      throw error;
    }
  }

  async function uploadDirectory(entry: DirectoryRoot): Promise<string> {
    if (!options.directories) { throw new Error("请更新设备助手后再拖入目录"); }
    const id = crypto.randomUUID();
    const begin: UploadFrame = { kind: "upload-directory-begin", id, name: entry.name };
    validateUploadFrame(begin);
    try {
      await options.request(begin);
      for (const child of directoryEntries(entry, id, () => disposed)) {
        if (child.kind === "directory") {
          await options.request({ kind: "upload-directory-entry", id, relativePath: child.relativePath });
        } else {
          await upload(child.file, { kind: "upload-file-begin", id: crypto.randomUUID(), directory: id, relativePath: child.relativePath, size: child.file.size });
        }
      }
      const path = await options.request({ kind: "upload-complete", id });
      if (typeof path !== "string" || !path.length) { throw new Error("设备未确认目录保存路径"); }
      return path;
    } catch (error) {
      if (!disposed) { await options.request({ kind: "upload-abort", id }); }
      throw error;
    }
  }

  function stage(file: File, directory?: DirectoryRoot): Promise<void> {
    if (paths.has(file)) { return Promise.resolve(); }
    const existing = staging.get(file);
    if (existing) { return existing; }
    const operation = (directory ? uploadDirectory(directory) : upload(file, { kind: "upload-begin", id: crypto.randomUUID(), name: file.name, size: file.size }))
      .then(path => { paths.set(file, path); })
      .finally(() => { staging.delete(file); });
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
    const entries = original ? Array.from(original.items).filter(item => item.kind === "file").map(item => item.webkitGetAsEntry?.() ?? null) : [];
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
      // 原版界面用该接口区分目录和文件，重放事件必须保留原始分类。
      let fileIndex = 0;
      preserveEntries(transfer, Array.from(transfer.items).map(item => item.kind === "file" ? entries[fileIndex++] ?? null : null));
    }
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
        for (const [index, file] of files.entries()) {
          const entry = entries[index];
          if (entry?.isDirectory && !options.directories) { throw new Error("请更新设备助手后再拖入目录"); }
          if (entry?.isDirectory && !directories.has(file)) { throw new Error("请更新 AIO 网页宿主后再拖入目录"); }
          await stage(file, directories.get(file));
        }
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

  function dragEnter(event: DragEvent): void {
    if (!disposed && options.directories && event.dataTransfer?.types.includes("Files")) {
      parent.postMessage({ protocol: "aio:device-view@1", kind: "file-drag" }, "*");
    }
  }

  function receiveDrop(event: MessageEvent): void {
    const message = event.data;
    if (disposed || event.source !== parent || message?.protocol !== "aio:device-view@1" || message.kind !== "file-drop") { return; }
    try {
      if (message.error) { throw new Error(String(message.error)); }
      if (!options.directories) { throw new Error("请更新设备助手后再拖入目录"); }
      if (!Array.isArray(message.roots) || !message.roots.length || message.roots.length > MAX_VIEW_UPLOAD_ENTRIES ||
          !Number.isFinite(message.point?.x) || !Number.isFinite(message.point?.y)) { throw new Error("宿主文件拖入数据无效"); }
      const roots = message.roots as DropRoot[];
      const id = crypto.randomUUID();
      let count = 0;
      let bytes = 0;
      // 先校验全部元数据，不能让无效相对路径或超限目录进入设备传输。
      for (const root of roots) {
        count++;
        if (root.kind === "directory") {
          validateUploadFrame({ kind: "upload-directory-begin", id, name: root.name });
          if (!Array.isArray(root.entries)) { throw new Error("宿主目录结构无效"); }
          for (const entry of directoryEntries(root, id, () => disposed)) { count++; if (entry.kind === "file") { bytes += entry.file.size; } }
        } else if (root.kind === "file" && root.file instanceof File) {
          validateUploadFrame({ kind: "upload-begin", id, name: root.file.name, size: root.file.size });
          bytes += root.file.size;
        } else { throw new Error("宿主文件拖入数据无效"); }
        if (count > MAX_VIEW_UPLOAD_ENTRIES || bytes > MAX_VIEW_UPLOAD_BYTES) { throw new Error("目录内的文件数量或大小超过限制"); }
      }
      const target = document.elementFromPoint(message.point.x, message.point.y);
      if (!target) { throw new Error("拖入位置已经离开 Codex 界面"); }
      const transfer = new DataTransfer();
      for (const [type, text] of Object.entries(message.text ?? {})) {
        if (["text/plain", "text/html", "text/uri-list"].includes(type) && typeof text === "string" && text.length <= 100000) { transfer.setData(type, text); }
      }
      for (const root of roots) { transfer.items.add(root.kind === "file" ? root.file : new File([], root.name)); }
      let fileIndex = 0;
      const entries = Array.from(transfer.items).map(item => {
        if (item.kind !== "file") { return null; }
        const index = fileIndex++;
        const root = roots[index];
        if (root.kind !== "directory") { return null; }
        directories.set(transfer.files[index], root);
        // 只保留原版分类所需的事实，浏览器 FileSystemEntry 不跨来源传递。
        return { isDirectory: true, isFile: false, name: root.name } as FileSystemDirectoryEntry;
      });
      preserveEntries(transfer, entries);
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer,
        clientX: message.point.x, clientY: message.point.y, ctrlKey: message.modifiers?.ctrlKey === true, altKey: message.modifiers?.altKey === true,
        shiftKey: message.modifiers?.shiftKey === true, metaKey: message.modifiers?.metaKey === true }));
    } catch (error) { options.onState(pending, error instanceof Error ? error.message : "目录拖入失败"); }
  }

  if (options.enabled) {
    for (const kind of ["change", "drop", "paste"]) { window.addEventListener(kind, capture, true); }
    window.addEventListener("dragenter", dragEnter, true);
    window.addEventListener("dragover", dragEnter, true);
    window.addEventListener("message", receiveDrop);
  }
  return {
    path(file: File): string | null { return paths.get(file) ?? null; },
    dispose(): void {
      disposed = true;
      for (const kind of ["change", "drop", "paste"]) { window.removeEventListener(kind, capture, true); }
      window.removeEventListener("dragenter", dragEnter, true);
      window.removeEventListener("dragover", dragEnter, true);
      window.removeEventListener("message", receiveDrop);
    },
  };
}
