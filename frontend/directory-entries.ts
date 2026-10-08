import { MAX_VIEW_UPLOAD_ENTRIES, validateUploadFrame } from "../shared/uploads.js";

export type DirectoryEntry =
  | { kind: "directory"; relativePath: string }
  | { kind: "file"; relativePath: string; file: File };

export interface DirectoryRoot {
  kind: "directory";
  name: string;
  entries: DirectoryEntry[];
}

export type DropRoot = DirectoryRoot | { kind: "file"; file: File };

export function* directoryEntries(root: DirectoryRoot, id: string, closed: () => boolean): Generator<DirectoryEntry> {
  if (root.entries.length >= MAX_VIEW_UPLOAD_ENTRIES) { throw new Error("目录内的文件或子目录数量超过限制"); }
  for (const entry of root.entries) {
    if (closed()) { throw new Error("目录上传已随设备连接关闭"); }
    if (!entry || (entry.kind !== "file" && entry.kind !== "directory")) { throw new Error("宿主目录项无效"); }
    validateUploadFrame({ kind: "upload-directory-entry", id, relativePath: entry.relativePath });
    if (entry.kind === "file") {
      if (!(entry.file instanceof File)) { throw new Error("宿主文件无效"); }
      validateUploadFrame({ kind: "upload-file-begin", id, directory: id, relativePath: entry.relativePath, size: entry.file.size });
    }
    yield entry;
  }
}
