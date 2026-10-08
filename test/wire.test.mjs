import test from "node:test";
import assert from "node:assert/strict";
import { encode, decode, validateWebFrame } from "../dist/native/index.mjs";

test("native RPC retains binary data, cycles, BigInt and collection references", () => {
  const bytes = Uint8Array.from([0, 128, 255]);
  const input = { bytes, bigint: 9007199254740993n, map: new Map(), set: new Set(), missing: undefined };
  input.self = input;
  input.map.set("same", bytes);
  input.set.add(input);
  const output = decode(JSON.parse(JSON.stringify(encode(input))));
  assert.deepEqual(output.bytes, bytes);
  assert.equal(output.bigint, input.bigint);
  assert.equal(output.self, output);
  assert.equal(output.map.get("same"), output.bytes);
  assert.equal(output.set.has(output), true);
  assert.equal(Object.hasOwn(output, "missing"), true);
});

test("remote frames cannot submit JavaScript or arbitrary native methods", () => {
  for (const value of [null, [], { kind: "evaluate", source: "process.exit()" }, { kind: "call", id: "1", method: "constructor", payload: encode([]) }, { kind: "subscribe-worker", worker: "../private" }]) {
    assert.throws(() => validateWebFrame(value));
  }
  validateWebFrame({ kind: "call", id: "test-1", method: "sendMessageFromView", payload: encode([{ type: "test" }]) });
});

test("wire preserves undefined and negative zero and rejects executable clone constructors", () => {
  validateWebFrame({kind:"call",id:"optional",method:"showContextMenu",payload:encode([{},undefined])});
  validateWebFrame({kind:"app-host",payload:encode({value:-0})});
  for(const payload of [[['Function','return process']],[[7,{name:'Worker',message:'code'}]],[[7,{name:'setTimeout',message:'code'}]]]){
    assert.throws(()=>validateWebFrame({kind:"app-host",payload}));
  }
  assert.throws(()=>validateWebFrame({kind:"connect",source:"window.eval('x')"}));
  assert.throws(()=>validateWebFrame({kind:"call",id:"test",method:"sendWorkerMessageFromView",payload:encode(['../secret',{}])}));
});
