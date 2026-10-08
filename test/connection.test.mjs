import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
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
