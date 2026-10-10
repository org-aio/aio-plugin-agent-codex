import {parse, parseFragment, serialize, type DefaultTreeAdapterMap} from 'parse5';
import {createHash} from 'node:crypto';
import type {OriginalAsset} from './assets.js';

declare const BROWSER_BOOTSTRAP_SOURCE: string;
declare const BROWSER_MOBILE_STYLES: string;
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function elements(node: Node): Element[] {
  const children = 'childNodes' in node ? node.childNodes : [];
  return children.flatMap(child => 'tagName' in child ? [child, ...elements(child)] : elements(child));
}

function attribute(node: Element, name: string): string | undefined { return node.attrs.find(attr => attr.name === name)?.value; }
function remove(node: Element): void {
  if (node.parentNode) { node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node); }
}
export function virtualAsset(path: string): OriginalAsset | undefined {
  if (path !== '__boot.js' && path !== '__mobile.css') { return; }
  const bytes = Buffer.from(path === '__boot.js' ? BROWSER_BOOTSTRAP_SOURCE : BROWSER_MOBILE_STYLES);
  const contentType = path === '__boot.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
  return {bytes, contentType, sha256: createHash('sha256').update(bytes).digest('hex')};
}

/** 只替换通信启动入口和来源策略，页面组件仍由原版模块渲染。 */
export function renderOriginalDocument(bytes: Uint8Array): Uint8Array {
  const document = parse(Buffer.from(bytes).toString('utf8'));
  const nodes = elements(document);
  const head = nodes.find(node => node.tagName === 'head');
  const main = nodes.find(node => node.tagName === 'script' && attribute(node, 'type') === 'module' && attribute(node, 'src'));
  const src = main && attribute(main, 'src');
  if (!head || !main || !src || !/^\.?\/?assets\/[a-zA-Z0-9_.-]+\.js$/.test(src)) { throw new Error('此版本 Codex 的模块入口尚未通过网页兼容验证'); }
  for (const node of nodes) {
    if (node.tagName === 'base' || (node.tagName === 'meta' && /^(content-security-policy|referrer)$/i.test(attribute(node, 'http-equiv') ?? attribute(node, 'name') ?? ''))) { remove(node); }
    if (node.tagName === 'meta' && attribute(node, 'name')?.toLowerCase() === 'viewport') { remove(node); }
    if (node.tagName === 'script' || node.tagName === 'link') {
      node.attrs = node.attrs.filter(attr => attr.name !== 'integrity');
      if (attribute(node, 'src') || attribute(node, 'href')) { node.attrs.push({name: 'crossorigin', value: 'anonymous'}); }
    }
  }
  main.attrs = [{name: 'src', value: './__boot.js'}, {name: 'data-entry', value: src.replace(/^\.?\//, '')}, {name: 'crossorigin', value: 'anonymous'}];
  const mobile = parseFragment('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><link rel="stylesheet" href="./__mobile.css" crossorigin="anonymous">');
  for (const node of mobile.childNodes) { node.parentNode = head; head.childNodes.push(node); }
  return Buffer.from(serialize(document));
}
