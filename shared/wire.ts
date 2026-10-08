import { serialize, deserialize } from "@ungap/structured-clone";
import { validateUploadFrame, type UploadFrame } from "./uploads.js";

export const PROTOCOL_VERSION = 1;
export const NATIVE_METHODS = [
  "sendMessageFromView",
  "sendWorkerMessageFromView",
  "acknowledgeChunkedMessage",
  "showContextMenu",
  "getFastModeRolloutMetrics",
  "startFileDrag",
  "startLinkDrag",
] as const;

export type NativeMethod = typeof NATIVE_METHODS[number];
export const SENTRY_METHODS = ["sendRendererStart", "sendScope", "sendEnvelope", "sendStatus", "sendStructuredLog", "sendMetric"] as const;
export type SentryMethod = typeof SENTRY_METHODS[number];
export type Payload = ReturnType<typeof serialize>;
export type WebFrame = UploadFrame
  | { kind: "connect" }
  | { kind: "app-host"; payload: Payload }
  | { kind: "call"; id: string; method: NativeMethod; payload: Payload }
  | { kind: "sentry"; method: SentryMethod; payload: Payload }
  | { kind: "subscribe-worker"; worker: string }
  | { kind: "unsubscribe-worker"; worker: string };
export type NativeFrame =
  | { kind: "native-ready"; snapshot: NativeSnapshot }
  | { kind: "app-host"; payload: Payload }
  | { kind: "native-message"; payload: Payload }
  | { kind: "worker"; worker: string; payload: Payload }
  | { kind: "theme"; theme: string }
  | { kind: "call-result"; id: string; payload?: Payload; error?: string }
  | { kind: "upload-result"; id: string; path?: string; error?: string }
  | { kind: "error"; error: string };

export interface NativeSnapshot {
  initialSidebarBootstrap: unknown;
  sentryInitOptions: unknown;
  appSessionId: string;
  buildFlavor: string;
  desktopUserAgent: string;
  theme: string;
  isDeviceCheckSupported: boolean;
  isIntelMacBuild: boolean;
  sharedObjects: Record<string, unknown>;
  sentryIPC: boolean;
  fileUploads?: boolean;
}

export function encode(value: unknown): Payload {
  return serialize(value);
}

export function decode(payload: Payload): unknown {
  return deserialize(payload);
}

const SAFE_CLONE_TYPES = new Set(["BigInt", "Boolean", "Number", "String", "ArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "-0"]);

function validatePayload(value: unknown): asserts value is Payload {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200_000) { throw new Error("原生消息载荷无效或超限"); }
  for (const record of value) {
    if (!Array.isArray(record) || (record.length !== 2 && !(record.length === 1 && (record[0] === -1 || record[0] === "-0")))) { throw new Error("原生消息记录无效"); }
    const [type, data] = record;
    if (typeof type === "string" ? !SAFE_CLONE_TYPES.has(type) : !Number.isInteger(type) || type < -1 || type > 8) { throw new Error("原生消息不能构造任意对象"); }
    if (type === 7 && (!data || typeof data !== "object" || !["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"].includes(data.name))) { throw new Error("原生异常类型无效"); }
  }
}

export function validateWebFrame(value: unknown): asserts value is WebFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Codex 网页消息必须是对象"); }
  const frame = value as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(frame)).byteLength > 16 * 1024 * 1024) { throw new Error("Codex 网页消息超过限制"); }
  const keys: Record<string, string[]> = {connect: ["kind"], "app-host": ["kind", "payload"], call: ["kind", "id", "method", "payload"], sentry: ["kind", "method", "payload"], "subscribe-worker": ["kind", "worker"], "unsubscribe-worker": ["kind", "worker"], "upload-begin": ["kind", "id", "name", "size"], "upload-chunk": ["kind", "id", "offset", "data"], "upload-complete": ["kind", "id"], "upload-abort": ["kind", "id"]};
  const fields = typeof frame.kind === "string" ? keys[frame.kind] : undefined;
  if (!fields || Object.keys(frame).length !== fields.length || Object.keys(frame).some(key => !fields.includes(key))) { throw new Error("Codex 网页消息字段无效"); }
  switch (frame.kind) {
    case "upload-begin":
    case "upload-chunk":
    case "upload-complete":
    case "upload-abort": validateUploadFrame(frame); return;
    case "connect": return;
    case "app-host": validatePayload(frame.payload); return;
    case "call": {
      if (typeof frame.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(frame.id) || !NATIVE_METHODS.includes(frame.method as NativeMethod)) { break; }
      validatePayload(frame.payload);
      const args = decode(frame.payload);
      const count = frame.method === "sendWorkerMessageFromView" || frame.method === "acknowledgeChunkedMessage" || frame.method === "showContextMenu" ? 2 : 1;
      if (!Array.isArray(args) || args.length !== count) { throw new Error("Codex 原生调用参数个数无效"); }
      if (frame.method === "sendWorkerMessageFromView" && (typeof args[0] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(args[0]))) { throw new Error("原生 Worker 名称无效"); }
      return;
    }
    case "sentry":
      if (!SENTRY_METHODS.includes(frame.method as SentryMethod)) { break; }
      validatePayload(frame.payload);
      if (!Array.isArray(decode(frame.payload))) { break; }
      return;
    case "subscribe-worker":
    case "unsubscribe-worker":
      if (typeof frame.worker === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(frame.worker)) { return; }
      break;
  }
  throw new Error("Codex 网页消息类型或参数无效");
}
