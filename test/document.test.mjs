import test from 'node:test';
import assert from 'node:assert/strict';
import {renderOriginalDocument} from '../dist/native/index.mjs';
import {parse} from 'parse5';

test('original components and stylesheet stay intact while the transport entry changes',()=>{
 const input=Buffer.from('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src app:"><meta name="referrer" content="origin"><link rel="stylesheet" href="./assets/styles.css"><script type="module" src="./assets/index-a.js"></script></head><body><div id="root"><span>原版启动界面</span></div></body></html>');
 const output=Buffer.from(renderOriginalDocument(input)).toString();
 assert(output.includes('原版启动界面'));
 assert(output.includes('href="./assets/styles.css"'));
 assert(output.includes('data-entry="assets/index-a.js"'));
 assert(output.includes('src="./__boot.js"'));
 assert(!output.includes('Content-Security-Policy'));
 assert(!output.includes('content="origin"'));
 assert(parse(output));
 assert.throws(()=>renderOriginalDocument(Buffer.from('<script type="module" src="https://evil.invalid/a.js"></script>')));
});
