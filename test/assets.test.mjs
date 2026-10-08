import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodexAssets } from "../dist/native/index.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aio-codex-assets-"));
  const bytes = Buffer.from("原始界面\0二进制");
  const index = Buffer.from(JSON.stringify({ files: { webview: { files: { "index.html": { offset: "0", size: bytes.length }, "escape.js": { offset: "99999", size: 16 }, "linked.js": { link: "../private" } } }, "auth.json": { offset: "0", size: bytes.length } } }));
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(index.length + 8, 4);
  header.writeUInt32LE(index.length + 4, 8);
  header.writeUInt32LE(index.length, 12);
  const path = join(root, "app.asar");
  await writeFile(path, Buffer.concat([header, index, bytes]));
  return { root, path, bytes };
}

test("only installed webview assets are read and the exact bytes have an integrity hash", async () => {
  const value = await fixture();
  const assets = new CodexAssets(value.path);
  try {
    await assets.open();
    const file = await assets.read("index.html");
    assert.deepEqual(Buffer.from(file.bytes), value.bytes);
    assert.equal(file.sha256, createHash("sha256").update(value.bytes).digest("hex"));
    for (const path of ["../auth.json", "auth.json", "/index.html", "assets/../index.html", "linked.js", "escape.js", "__proto__/x"]) {
      await assert.rejects(assets.read(path));
    }
    await assets.close();
    await assert.rejects(assets.read("index.html"));
  } finally {
    await assets.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("invalid archive indexes fail before a resource can be served", async () => {
  const value = await fixture();
  try {
    await writeFile(value.path, Buffer.alloc(16, 255));
    const assets = new CodexAssets(value.path);
    await assert.rejects(assets.open());
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('the Buddy renderer is pinned when a view opens even if the installed file changes', async()=>{
 const value=await fixture();const buddy=join(value.root,'buddy.js');
 await writeFile(buddy,'original-buddy');const assets=new CodexAssets(value.path,buddy);
 try {await assets.open();await writeFile(buddy,'updated-buddy');assert.equal(Buffer.from((await assets.read('__buddy.js')).bytes).toString(),'original-buddy');}
 finally{await assets.close();await rm(value.root,{recursive:true,force:true});}
});
