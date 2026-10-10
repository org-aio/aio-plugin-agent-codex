import { build } from "esbuild";
import { readFile, mkdir, rm } from "node:fs/promises";

await rm("dist/native", { recursive: true, force: true });
await mkdir("dist/native", { recursive: true });
await build({
  entryPoints: ["native/preload-transport.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  outfile: "dist/native/preload-transport.js",
});
const nativeSource = await readFile("dist/native/preload-transport.js", "utf8");
await build({
  entryPoints: ["frontend/bootstrap.ts"], bundle: true, platform: "browser", format: "iife",
  target: "chrome120", outfile: "dist/native/browser-bootstrap.js",
});
const browserSource = await readFile("dist/native/browser-bootstrap.js", "utf8");
const mobileStyles = await readFile("frontend/mobile.css", "utf8");
await build({
  entryPoints: ["native/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/native/index.mjs",
  banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
  define: { NATIVE_BOOTSTRAP_SOURCE: JSON.stringify(nativeSource), BROWSER_BOOTSTRAP_SOURCE: JSON.stringify(browserSource), BROWSER_MOBILE_STYLES: JSON.stringify(mobileStyles) },
});
