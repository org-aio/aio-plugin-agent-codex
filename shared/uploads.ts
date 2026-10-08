export const UPLOAD_CHUNK_BYTES = 256 * 1024;
export const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_VIEW_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_VIEW_UPLOAD_FILES = 128;

export type UploadFrame =
  | { kind: "upload-begin"; id: string; name: string; size: number }
  | { kind: "upload-chunk"; id: string; offset: number; data: string }
  | { kind: "upload-complete"; id: string }
  | { kind: "upload-abort"; id: string };

export function validateUploadFrame(value: Record<string, unknown>): asserts value is Record<string, unknown> & UploadFrame {
  if (typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)) {
    throw new Error("附件传输标识无效");
  }
  if (value.kind === "upload-begin") {
    if (typeof value.name !== "string" || value.name === "." || value.name === ".." || !value.name.length ||
        new TextEncoder().encode(value.name).byteLength > 255 || /[<>:"/\\|?*\x00-\x1f]/.test(value.name) || /[. ]$/.test(value.name) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.name)) {
      throw new Error("附件名称无效");
    }
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
