import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {randomUUID} from 'node:crypto';
import {readFile,rm,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {CodexWebConnection,encode} from '../dist/native/index.mjs';

async function desktop({pauseCreation=false}={}) {
 const actions=[];let owned;let endpoint;let nextSession=0;
 let release;const creation=pauseCreation?new Promise(resolve=>{release=resolve;}):Promise.resolve();
 const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/json/protocol'){res.end(JSON.stringify({version:{major:'1',minor:'3'},domains:[]}));return;}
  if(req.url==='/json/version'){res.end(JSON.stringify({webSocketDebuggerUrl:endpoint.replace('http:','ws:')+'devtools/browser/test'}));return;}
  if(req.url==='/json/list'){res.end(JSON.stringify([{id:'user-main',type:'page',url:'app://-/index.html'}]));return;}
  res.writeHead(404).end();
 });
 const web=new WebSocketServer({server});
 web.on('connection',socket=>socket.on('message',async bytes=>{
  const request=JSON.parse(bytes.toString());actions.push(request);let result={};
  if(request.method==='Target.attachToTarget'){result={sessionId:'session-'+(++nextSession)};}
  if(request.method==='Runtime.evaluate'&&request.params.expression.includes('open-in-new-window')){
   const data=JSON.parse(request.params.expression.slice(request.params.expression.indexOf('({')+1,-1));
   await creation;
   owned={targetId:'own-view',type:'page',url:'app://-/index.html?initialRoute='+encodeURIComponent(data.path)};
  }
  if(request.method==='Target.getTargets'){result={targetInfos:[{targetId:'user-main',type:'page',url:'app://-/index.html'},...(owned?[owned]:[])]};}
  if(request.method==='Target.closeTarget'){assert.equal(request.params.targetId,'own-view');owned=undefined;result={success:true};}
  socket.send(JSON.stringify({id:request.id,sessionId:request.sessionId,result}));
  if(request.method==='Page.reload'){
   socket.send(JSON.stringify({method:'Runtime.bindingCalled',sessionId:request.sessionId,params:{name:'__aioNativeFrame',payload:JSON.stringify({kind:'native-ready',snapshot:{appSessionId:'fixture'}})}}));
  }
 }));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 endpoint=`http://127.0.0.1:${server.address().port}/`;
 return {endpoint,actions,release:()=>release?.(),async close(){release?.();for(const socket of web.clients){socket.terminate();}await new Promise(resolve=>web.close(resolve));await new Promise(resolve=>server.close(resolve));}};
}

test('each connection owns its window and preserves native frame order without closing the user window',async()=>{
 const fixture=await desktop();const output=[];
 const connection=new CodexWebConnection({endpoint:fixture.endpoint,onFrame:frame=>output.push(frame)});
 try {
  assert.equal((await connection.open()).appSessionId,'fixture');
  await Promise.all([1,2,3].map(index=>connection.receive({kind:'app-host',payload:encode({index})})));
  const frames=fixture.actions.filter(action=>action.method==='Runtime.evaluate'&&action.params.expression.startsWith('window.__aioCodexNative.receive'));
  assert.equal(frames.length,3);
  assert(frames.every(frame=>frame.sessionId==='session-2'));
  assert(frames[0].params.expression.includes('1'));
  await assert.rejects(connection.receive({kind:'call',id:'bad',method:'constructor',payload:encode([])}));
  await connection.close();await connection.close();
  assert.deepEqual(fixture.actions.filter(action=>action.method==='Target.closeTarget').map(action=>action.params.targetId),['own-view']);
  await assert.rejects(connection.receive({kind:'connect'}));
 }finally{await connection.close();await fixture.close();}
});

test('remote CDP origins are rejected before any connection',()=>{
 for(const endpoint of ['https://example.invalid','http://192.168.1.2:1234','http://user:password@127.0.0.1:1234','http://127.0.0.1:1234/path']){
  assert.throws(()=>new CodexWebConnection({endpoint,onFrame(){}}));
 }
});

test('closing during native window creation waits for the owned target and removes it',async()=>{
 const fixture=await desktop({pauseCreation:true});
 const connection=new CodexWebConnection({endpoint:fixture.endpoint,onFrame:()=>undefined});
 try {
  const opening=assert.rejects(connection.open(),/连接已关闭/);
  for(let i=0;i<200&&!fixture.actions.some(action=>action.method==='Runtime.evaluate');i++){await new Promise(resolve=>setTimeout(resolve,10));}
  assert(fixture.actions.some(action=>action.method==='Runtime.evaluate'));
  const closing=connection.close();fixture.release();await closing;await opening;
  assert.equal(fixture.actions.filter(action=>action.method==='Target.closeTarget').length,1);
  assert(!fixture.actions.some(action=>action.method==='Target.closeTarget'&&action.params.targetId==='user-main'));
 }finally{fixture.release();await connection.close();await fixture.close();}
});

test('uploads acknowledge actual device bytes, reject wrong offsets and retain completed files after disconnect',async()=>{
 const fixture=await desktop();const output=[];let root;
 const connection=new CodexWebConnection({endpoint:fixture.endpoint,onFrame:frame=>output.push(frame)});
 const id=randomUUID();const name='零件图.bin';const bytes=Buffer.alloc(256*1024+17);
 for(let index=0;index<bytes.length;index++){bytes[index]=index%256;}
 const reply=()=>output.at(-1);
 try {
  assert.equal((await connection.open()).fileUploads,true);
  await connection.receive({kind:'upload-begin',id,name,size:bytes.length});
  assert.deepEqual(reply(),{kind:'upload-result',id});
  await connection.receive({kind:'upload-complete',id});
  assert.match(reply().error,/完整上传/);
  await connection.receive({kind:'upload-chunk',id,offset:1,data:bytes.subarray(0,256*1024).toString('base64')});
  assert.match(reply().error,/顺序/);
  await connection.receive({kind:'upload-chunk',id,offset:0,data:bytes.subarray(0,256*1024).toString('base64')});
  assert.equal(reply().error,undefined);
  await connection.receive({kind:'upload-chunk',id,offset:256*1024,data:bytes.subarray(256*1024).toString('base64')});
  await connection.receive({kind:'upload-complete',id});
  const path=reply().path;assert(path.endsWith(name));root=dirname(dirname(path));
  assert.deepEqual(await readFile(path),bytes);
  if(process.platform!=='win32'){assert.equal((await stat(path)).mode&0o777,0o600);}
  assert(!fixture.actions.some(action=>action.method==='Runtime.evaluate'&&action.params.expression.includes('upload-')));
  await connection.close();assert.deepEqual(await readFile(path),bytes);
 }finally{await connection.close();await fixture.close();if(root){await rm(root,{recursive:true,force:true});}}
});

test('aborted and disconnected partial uploads are removed without deleting already attached files',async()=>{
 const fixture=await desktop();const output=[];let root;
 const connection=new CodexWebConnection({endpoint:fixture.endpoint,onFrame:frame=>output.push(frame)});
 const retained=randomUUID();const aborted=randomUUID();const interrupted=randomUUID();
 try {
  await connection.open();
  await connection.receive({kind:'upload-begin',id:retained,name:'empty.txt',size:0});
  await connection.receive({kind:'upload-complete',id:retained});
  const path=output.at(-1).path;root=dirname(dirname(path));
  await connection.receive({kind:'upload-begin',id:aborted,name:'partial.txt',size:10});
  await connection.receive({kind:'upload-chunk',id:aborted,offset:0,data:Buffer.from('part').toString('base64')});
  assert.equal(await readFile(join(root,aborted,'partial.txt'),'utf8'),'part');
  await connection.receive({kind:'upload-abort',id:aborted});
  await assert.rejects(stat(join(root,aborted)),{code:'ENOENT'});
  await connection.receive({kind:'upload-begin',id:interrupted,name:'interrupted.txt',size:10});
  await connection.close();
  await assert.rejects(stat(join(root,interrupted)),{code:'ENOENT'});
  assert.equal((await readFile(path)).length,0);
 }finally{await connection.close();await fixture.close();if(root){await rm(root,{recursive:true,force:true});}}
});

test('upload limits and cancellation recover without poisoning the native connection',async()=>{
 const fixture=await desktop();const output=[];let root;
 const connection=new CodexWebConnection({endpoint:fixture.endpoint,onFrame:frame=>output.push(frame)});
 try {
  await connection.open();const anchor=randomUUID();
  await connection.receive({kind:'upload-begin',id:anchor,name:'anchor.txt',size:0});
  await connection.receive({kind:'upload-complete',id:anchor});root=dirname(dirname(output.at(-1).path));
  const ids=Array.from({length:4},()=>randomUUID());
  for(const id of ids){await connection.receive({kind:'upload-begin',id,name:'large.bin',size:128*1024*1024});assert.equal(output.at(-1).error,undefined);}
  await connection.receive({kind:'upload-begin',id:randomUUID(),name:'overflow.bin',size:1});assert.match(output.at(-1).error,/总大小/);
  for(const id of ids){await connection.receive({kind:'upload-abort',id});}
  const id=randomUUID();await connection.receive({kind:'upload-begin',id,name:'retry.txt',size:1});
  await connection.receive({kind:'upload-chunk',id,offset:0,data:'Zh=='});assert.match(output.at(-1).error,/内容/);
  await connection.receive({kind:'upload-chunk',id,offset:0,data:'Zg=='});
  await connection.receive({kind:'upload-complete',id});assert.equal(await readFile(output.at(-1).path,'utf8'),'f');
  await connection.receive({kind:'app-host',payload:encode({index:'still-connected'})});
  assert(fixture.actions.some(action=>action.method==='Runtime.evaluate'&&action.params.expression.includes('still-connected')));
 }finally{await connection.close();await fixture.close();if(root){await rm(root,{recursive:true,force:true});}}
});
