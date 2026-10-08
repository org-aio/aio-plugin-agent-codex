export const UPLOAD_CHUNK_BYTES = 256 * 1024;
export const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_VIEW_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_VIEW_UPLOAD_ENTRIES = 4096;
export const MAX_UPLOAD_DIRECTORY_DEPTH = 32;

export type UploadFrame =
  | { kind: "upload-begin"; id: string; name: string; size: number }
  | { kind: "upload-directory-begin"; id: string; name: string }
  | { kind: "upload-directory-entry"; id: string; relativePath: string }
  | { kind: "upload-file-begin"; id: string; directory: string; relativePath: string; size: number }
  | { kind: "upload-chunk"; id: string; offset: number; data: string }
  | { kind: "upload-complete"; id: string }
  | { kind: "upload-abort"; id: string };

function validateId(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("附件传输标识无效");
  }
}

function validateName(value: unknown): void {
  if (typeof value !== "string" || value === "." || value === ".." || !value.length ||
      new TextEncoder().encode(value).byteLength > 255 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error("附件名称无效");
  }
}

function validateRelativePath(value: unknown): void {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096) {
    throw new Error("目录内的相对路径无效或过长");
  }
  const parts = value.split("/");
  if (parts.length > MAX_UPLOAD_DIRECTORY_DEPTH) { throw new Error("目录层级超过限制"); }
  for (const part of parts) { validateName(part); }
}

export function validateUploadFrame(value: Record<string, unknown>): asserts value is Record<string, unknown> & UploadFrame {
  validateId(value.id);
  if (value.kind === "upload-begin" || value.kind === "upload-directory-begin") { validateName(value.name); }
  if (value.kind === "upload-file-begin" || value.kind === "upload-directory-entry") { validateRelativePath(value.relativePath); }
  if (value.kind === "upload-file-begin") { validateId(value.directory); }
  if (value.kind === "upload-begin" || value.kind === "upload-file-begin") {
    if (!Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > MAX_UPLOAD_BYTES) {
      throw new Error("单个附件不能超过 128 MiB");
    }
  }
  if (value.kind === "upload-chunk") {
    if (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || Number(value.offset) > MAX_UPLOAD_BYTES ||
        typeof value.data !== "string" || !value.data.length || value.data.length % 4 !== 0 || value.data.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) {
      throw new Error("附件分块无效或超限");
    }
    const bytes = value.data.length / 4 * 3 - (value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0);
    if (bytes > UPLOAD_CHUNK_BYTES) { throw new Error("附件分块无效或超限"); }
  }
}
