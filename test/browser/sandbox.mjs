import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,writeFile,stat,readdir,rm} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {chromium} from '@playwright/test';
import {build} from 'esbuild';
import {renderOriginalDocument,virtualAsset,encode,validateWebFrame} from '../../dist/native/index.mjs';

// 此测试验证真实浏览器中的两层不透明沙箱及传输，不模拟 Codex 智能体执行。
const platform=process.env.AIO_PLATFORM_ROOT;
assert(platform,'请设置 AIO_PLATFORM_ROOT 指向配套平台源码');
await mkdir('.local',{recursive:true});
await build({entryPoints:['native/uploads.ts'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:'.local/uploads-test.mjs'});
const {FileUploads}=await import(pathToFileURL(resolve('.local/uploads-test.mjs')).href);
const sdk=(await Promise.all(['lifecycle','wasm','navigation','guest'].map(name=>readFile(resolve(platform,`sdk/web/${name}.js`),'utf8')))).join('\n');
const hostBridge=await readFile(resolve(platform,'sdk/web/host.mjs'),'utf8');
const wrapper=await readFile(new URL('../../frontend/index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../../frontend/app.js',import.meta.url));
const styles=await readFile(new URL('../../frontend/styles.css',import.meta.url));
let origin;const views=new Map();const requests=[];
const device=randomUUID();
const mount='/api/runtime/components/assets/browser-fixture/';
const body=Buffer.from(renderOriginalDocument(Buffer.from('<html><head><script type="module" src="./assets/fixture.js"></script></head><body><div id="root">等待原生桥接</div></body></html>')));
const module=`
 for(const kind of ['dragenter','dragover','drop']){addEventListener(kind,event=>console.log('DRAG child '+kind+' '+Array.from(event.dataTransfer.types).join(',')),true);}
 const root=document.getElementById('root');
 const title=document.createElement('h1');title.textContent='测试模块加载成功';root.replaceChildren(title);
 const output=document.createElement('p');output.setAttribute('role','status');root.append(output);
 localStorage.setItem('probe','ok');
 output.textContent=window.electronBridge.getAppSessionId()+': '+localStorage.getItem('probe');
 const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
 worker.onerror=event=>{const p=document.createElement('p');p.textContent='Worker error: '+event.message;root.append(p);};
 worker.onmessage=event=>{const p=document.createElement('p');p.textContent=event.data;root.append(p);worker.terminate();};
 const action=document.createElement('button');action.textContent='测试原生请求';action.onclick=async()=>{const result=await window.electronBridge.sendMessageFromView({type:'fixture'});output.textContent=result;};root.append(action);
 const next=document.createElement('button');next.textContent='打开测试详情';next.onclick=()=>history.pushState({},'',new URL('?initialRoute=/local/fixture-next',location.href));root.append(next);
 const attachments=document.createElement('pre');attachments.id='attachments';attachments.dataset.count='0';root.append(attachments);const records=[];
 const record=(kind,files,text,transfer)=>{const paths=Array.from(files).map(file=>window.electronBridge.getPathForFile(file));if(paths.some(path=>typeof path!=='string'))throw new Error('附件事件在设备确认前到达原版模块');const directories=transfer?Array.from(transfer.items).filter(item=>item.kind==='file').map(item=>item.webkitGetAsEntry?.()?.isDirectory===true):[];records.push({kind,names:Array.from(files).map(file=>file.name),paths,text,directories});attachments.textContent=JSON.stringify(records);attachments.dataset.count=String(records.length);};
 const input=document.createElement('input');input.type='file';input.multiple=true;input.setAttribute('aria-label','选择测试附件');input.onchange=()=>record('input',input.files);root.append(input);
 const drop=document.createElement('div');drop.id='drop';drop.textContent='拖入测试附件';drop.ondragover=event=>event.preventDefault();drop.ondrop=event=>{event.preventDefault();record('drop',event.dataTransfer.files,event.dataTransfer.getData('text/plain'),event.dataTransfer);};root.append(drop);
 const link=document.createElement('a');link.id='drag-link';link.href='https://example.invalid/fixture';link.textContent='拖拽测试链接';link.onclick=event=>event.preventDefault();link.ondragstart=event=>{const start=window.electronBridge?.startLinkDrag;if(start){event.preventDefault();start({url:link.href,title:link.textContent,html:link.outerHTML});}};root.append(link);
 const linkDrop=document.createElement('div');linkDrop.id='link-drop';linkDrop.textContent='链接拖入位置';linkDrop.ondragover=event=>event.preventDefault();linkDrop.ondrop=event=>{event.preventDefault();linkDrop.textContent=event.dataTransfer.getData('text/uri-list').trim();};root.append(linkDrop);
 const paste=document.createElement('textarea');paste.id='paste';paste.setAttribute('aria-label','粘贴测试附件');paste.onpaste=event=>{event.preventDefault();record('paste',event.clipboardData.files,event.clipboardData.getData('text/plain'));};root.append(paste);
 addEventListener('message',event=>{if(event.data?.type==='navigate-to-route'){history.replaceState({},'',new URL('?initialRoute='+encodeURIComponent(event.data.path),location.href));}});
`;
const server=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,origin);const path=url.pathname;requests.push({asset:path});
  res.setHeader('cache-control','no-store');res.setHeader('access-control-allow-origin','*');res.setHeader('referrer-policy','no-referrer');
  if(path==='/'){
   res.setHeader('content-type','text/html');res.end(`<!doctype html><html><body><iframe id="plugin" sandbox="allow-scripts" style="width:98vw;height:94vh;border:0" src="${mount}index.html${url.hash}"></iframe><script>
   const frame=document.getElementById('plugin');
   for(const kind of ['dragenter','dragover','dragleave','drop']){addEventListener(kind,event=>console.log('DRAG host '+kind+' '+Array.from(event.dataTransfer.types).join(',')+' '+frame.inert),true);}
   addEventListener('message',event=>{if(['file-drag','file-drop-subscribe'].includes(event.data?.kind)){console.log('DRAG message '+event.data.kind);}});
   function restore(){frame.contentWindow.postMessage({channel:'aio-navigation',token:'browser-fixture',navigation:location.hash},'*');}
   frame.addEventListener('load',restore);
   addEventListener('hashchange',restore);addEventListener('popstate',restore);
   addEventListener('message',event=>{const m=event.data;if(event.source!==frame.contentWindow||m?.channel!=='aio-navigation')return;
    if(typeof m.navigation==='string'){history[m.replace?'replaceState':'pushState']({},'',m.navigation||location.pathname);restore();}
    frame.contentWindow.postMessage({channel:'aio-navigation',token:'browser-fixture',id:m.id,response:null},'*');
   });
   </script><script type="module">
   import {mountBridge} from '/bridge.js';
   mountBridge(document.getElementById('plugin'),()=>{throw new Error('测试页面未使用服务调用');},{fileDrop:()=> 'fixture-lease'});
   </script></body></html>`);return;
  }
  if(path==='/bridge.js'){res.setHeader('content-type','text/javascript');res.end(hostBridge);return;}
  if(path===mount+'__device_view'){
   let bytes='';for await(const chunk of req){bytes+=chunk;}const request=JSON.parse(bytes);requests.push(request);
   let data;
   if(request.operation==='list'){data=[{id:device,label:'沙箱测试设备',status:'online'}];}
   if(request.operation==='open'){const id=randomUUID();views.set(id,true);data={id,src:origin+mount+'__device_view/'+id+'/index.html?initialRoute='+encodeURIComponent(request.route)};}
   if(request.operation==='close'){views.delete(request.id);data=null;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));return;
  }
  if(path===mount+'index.html'){
   res.setHeader('content-type','text/html');res.setHeader('content-security-policy',`sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${origin+mount}; connect-src ${origin+mount} blob:; style-src 'unsafe-inline' ${origin+mount}; worker-src blob:; frame-src ${origin+mount}__device_view/; base-uri ${origin+mount}`);
   res.end(wrapper.replace('<head>','<head><base href="'+origin+mount+'"><script data-token="browser-fixture" data-root="'+origin+mount+'">'+sdk+'</script>'));return;
  }
  if(path===mount+'app.js'){res.setHeader('content-type','text/javascript');res.end(app);return;}
  if(path===mount+'styles.css'){res.setHeader('content-type','text/css');res.end(styles);return;}
  const match=path.match(/\/__device_view\/([^/]+)\/(.+)$/);
  if(match&&views.has(match[1])){
   const prefix=origin+mount+'__device_view/'+match[1]+'/';
   res.setHeader('content-security-policy',`default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${prefix} blob:; connect-src ${prefix} ${prefix.replace('http:','ws:')} blob:; style-src 'unsafe-inline' ${prefix}; img-src data: blob: ${prefix}; font-src data: ${prefix}; worker-src data: ${prefix}; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri ${prefix}`);
   if(match[2]==='index.html'){res.setHeader('content-type','text/html');res.end(body);return;}
   res.setHeader('content-type','text/javascript');
   if(match[2]==='__boot.js'){res.end(virtualAsset('__boot.js').bytes);return;}
   if(match[2]==='__buddy.js'){res.end('window.buddyLoaded=true;');return;}
   if(match[2]==='assets/fixture.js'){res.end(module);return;}
   if(match[2]==='assets/worker.js'){res.end('postMessage("Worker 模块加载成功");');return;}
  }
  res.writeHead(404).end();
 }catch(error){res.writeHead(500).end(error.message);}
});
const web=new WebSocketServer({server});
const uploaded=[];
const uploadFrames=[];
const uploadRoots=new Set();
const uploadCleanup=[];
web.on('connection',socket=>{
 const uploads=new FileUploads();let queue=Promise.resolve();
 const send=frame=>{if(socket.readyState===1){socket.send(JSON.stringify({kind:'frame',frame}));}};
 socket.send(JSON.stringify({kind:'ready',snapshot:{appSessionId:'native-fixture',theme:'light',sharedObjects:{},fileUploads:true,directoryUploads:true}}));
 socket.on('message',bytes=>{
  const frame=JSON.parse(bytes.toString());
  queue=queue.then(async()=>{
   if(frame.kind==='call'){send({kind:'call-result',id:frame.id,payload:encode('原生请求已确认')});return;}
   if(!frame.kind.startsWith('upload-')){return;}
   uploadFrames.push(frame);
   let result={kind:'upload-result',id:frame.id};
   try {
    validateWebFrame(frame);
    if(frame.kind==='upload-begin'&&frame.name==='fail.txt'){throw new Error('测试设备拒绝附件');}
    if(frame.kind==='upload-file-begin'&&frame.relativePath==='fail.txt'){throw new Error('测试设备拒绝目录文件');}
    const path=await uploads.receive(frame);
    if(path){
     result.path=path;
     let root=dirname(path);
     while(!basename(root).startsWith('aio-codex-upload-')){const parent=dirname(root);assert.notEqual(parent,root);root=parent;}
     uploadRoots.add(root);
     if((await stat(path)).isFile()){uploaded.push({name:basename(path),path,bytes:await readFile(path)});}
    }
   }catch(error){result.error=error.message;}
   setTimeout(()=>send(result),30);
  });
 });
 socket.on('close',()=>{uploadCleanup.push(queue.then(()=>uploads.dispose()));});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];const consoleErrors=[];const dragEvents=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'){consoleErrors.push(message.text());}if(message.text().startsWith('DRAG ')){dragEvents.push(message.text());}});
let directorySource;
try {
 await page.goto(origin);
 const plugin=page.frameLocator('#plugin');
 await plugin.getByRole('button',{name:'连接',exact:true}).click();
 const codex=plugin.frameLocator('#view');
 await codex.getByText('测试模块加载成功',{exact:true}).waitFor();
 await codex.getByText('Worker 模块加载成功',{exact:true}).waitFor();
 await codex.getByRole('button',{name:'测试原生请求'}).click();
 await codex.getByText('原生请求已确认',{exact:true}).waitFor();
 assert.equal(await plugin.locator('#status').innerText(),'已连接');
 assert.equal(await codex.locator('body').evaluate(()=>window.origin),'null');
 await codex.locator('#drag-link').dragTo(codex.locator('#link-drop'));
 await codex.getByText('https://example.invalid/fixture',{exact:true}).waitFor();
 assert.equal(await codex.locator('body').evaluate(()=>window.electronBridge.showContextMenu),undefined);
 const attachmentBytes=Buffer.alloc(256*1024+17);for(let i=0;i<attachmentBytes.length;i++){attachmentBytes[i]=i%256;}
 await codex.getByLabel('选择测试附件').setInputFiles([{name:'设计附件.bin',mimeType:'application/octet-stream',buffer:attachmentBytes},{name:'empty.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)}]);
 await codex.locator('#attachments[data-count="1"]').waitFor();
 let records=JSON.parse(await codex.locator('#attachments').innerText());assert.deepEqual(records[0].names,['设计附件.bin','empty.txt']);assert(records[0].paths.every(path=>path.includes('aio-codex-upload-')));
 assert.deepEqual(uploaded.find(item=>item.name==='设计附件.bin').bytes,attachmentBytes);assert.equal(uploaded.find(item=>item.name==='empty.txt').bytes.length,0);
 await codex.locator('#drop').evaluate(target=>{const transfer=new DataTransfer();transfer.setData('text/plain','保留拖拽文本');transfer.items.add(new File(['drop bytes'],'drop.txt'));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
 await codex.locator('#attachments[data-count="2"]').waitFor();
 records=JSON.parse(await codex.locator('#attachments').innerText());assert.equal(records[1].kind,'drop');assert.equal(records[1].text,'保留拖拽文本');assert.equal(uploaded.find(item=>item.name==='drop.txt').bytes.toString(),'drop bytes');
 await codex.locator('#paste').evaluate(target=>{const transfer=new DataTransfer();transfer.setData('text/plain','保留剪贴板文本');transfer.items.add(new File([Uint8Array.from([0,128,255])],'paste.png',{type:'image/png'}));target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));});
 await codex.locator('#attachments[data-count="3"]').waitFor();
 records=JSON.parse(await codex.locator('#attachments').innerText());assert.equal(records[2].kind,'paste');assert.equal(records[2].text,'保留剪贴板文本');assert.deepEqual(uploaded.find(item=>item.name==='paste.png').bytes,Buffer.from([0,128,255]));
 await codex.getByLabel('选择测试附件').setInputFiles({name:'stale.txt',mimeType:'text/plain',buffer:Buffer.from('stale')});
 await codex.getByLabel('选择测试附件').setInputFiles({name:'current.txt',mimeType:'text/plain',buffer:Buffer.from('current')});
 await codex.locator('#attachments[data-count="4"]').waitFor();records=JSON.parse(await codex.locator('#attachments').innerText());assert.deepEqual(records[3].names,['current.txt']);
 await codex.getByLabel('选择测试附件').setInputFiles({name:'fail.txt',mimeType:'text/plain',buffer:Buffer.from('failure')});
 await plugin.getByText('测试设备拒绝附件',{exact:true}).waitFor();assert.equal(await codex.locator('#attachments').getAttribute('data-count'),'4');
 await codex.getByRole('button',{name:'测试原生请求'}).click();await codex.getByText('原生请求已确认',{exact:true}).waitFor();
 await codex.getByLabel('选择测试附件').setInputFiles({name:'retry.txt',mimeType:'text/plain',buffer:Buffer.from('retry')});
 await codex.locator('#attachments[data-count="5"]').waitFor();await plugin.locator('#status[data-state="ready"]').waitFor();
 directorySource=await mkdtemp(join(tmpdir(),'aio-codex-browser-source-'));
 const directoryPath=join(directorySource,'项目');
 await mkdir(join(directoryPath,'源码'),{recursive:true});
 await mkdir(join(directoryPath,'空目录/子目录'),{recursive:true});
 await writeFile(join(directoryPath,'源码/main.bin'),Buffer.from([0,128,255]));
 await writeFile(join(directoryPath,'.gitignore'),'target/\n');
 for(let index=0;index<131;index++){await writeFile(join(directoryPath,'entry-'+index+'.txt'),String(index));}
 const cdp=await page.context().newCDPSession(page);
 const dropDirectory=async path=>{
  const box=await codex.locator('#drop').boundingBox();assert(box);
  for(const type of ['dragEnter','dragOver','drop']){await cdp.send('Input.dispatchDragEvent',{type,x:box.x+box.width/2,y:box.y+box.height/2,data:{items:[],files:[path],dragOperationsMask:1}});if(type==='dragEnter'){await page.waitForFunction(()=>document.getElementById('plugin').inert,null,{timeout:5000});}}
 };
 await dropDirectory(directoryPath);
 await codex.locator('#attachments[data-count="6"]').waitFor({timeout:30000});
 records=JSON.parse(await codex.locator('#attachments').innerText());const copiedDirectory=records[5].paths[0];
 assert.deepEqual(records[5].directories,[true]);assert.notEqual(copiedDirectory,directoryPath);
 assert.deepEqual(await readFile(join(copiedDirectory,'源码/main.bin')),Buffer.from([0,128,255]));
 assert.equal(await readFile(join(copiedDirectory,'.gitignore'),'utf8'),'target/\n');
 assert.equal(await readFile(join(copiedDirectory,'entry-130.txt'),'utf8'),'130');
 assert.equal((await stat(join(copiedDirectory,'空目录/子目录'))).isDirectory(),true);
 const emptyDirectory=join(directorySource,'empty-project');await mkdir(emptyDirectory);
 await dropDirectory(emptyDirectory);await codex.locator('#attachments[data-count="7"]').waitFor();
 records=JSON.parse(await codex.locator('#attachments').innerText());assert.deepEqual(await readdir(records[6].paths[0]),[]);
 const failedDirectory=join(directorySource,'broken-project');await mkdir(failedDirectory);
 await writeFile(join(failedDirectory,'finished.txt'),'retained only on success');await writeFile(join(failedDirectory,'fail.txt'),'device failure');
 await dropDirectory(failedDirectory);await plugin.getByText('测试设备拒绝目录文件',{exact:true}).waitFor();
 assert.equal(await codex.locator('#attachments').getAttribute('data-count'),'7');
 const failedFrame=uploadFrames.find(frame=>frame.kind==='upload-directory-begin'&&frame.name==='broken-project');assert(failedFrame);
 for(const root of uploadRoots){await assert.rejects(stat(join(root,failedFrame.id)),{code:'ENOENT'});}
 assert.equal(await readFile(join(copiedDirectory,'entry-130.txt'),'utf8'),'130');
 await codex.getByRole('button',{name:'测试原生请求'}).click();await codex.getByText('原生请求已确认',{exact:true}).waitFor();
 await codex.getByRole('button',{name:'打开测试详情'}).click();
 await page.waitForURL(url=>new URLSearchParams(url.hash.slice(1)).get('route')==='/local/fixture-next');
 await page.goBack();
 await page.waitForURL(url=>new URLSearchParams(url.hash.slice(1)).get('route')==='/');
 await page.goForward();
 await page.waitForURL(url=>new URLSearchParams(url.hash.slice(1)).get('route')==='/local/fixture-next');
 await page.reload();
 await plugin.locator('#status[data-state="ready"]').waitFor();
 assert.deepEqual(await readFile(join(copiedDirectory,'源码/main.bin')),Buffer.from([0,128,255]));
 await plugin.getByRole('button',{name:'重新连接',exact:true}).click();
 await plugin.locator('#status[data-state="ready"]').waitFor();
 await mkdir('.local',{recursive:true});await page.screenshot({path:'.local/sandbox.png',fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));assert(requests.some(item=>item.operation==='close'));
 console.log(JSON.stringify({sandbox:'opaque',worker:'loaded',nativeRequest:'confirmed',attachments:'input-drop-paste-binary-empty-stale-failure-retry',directories:'real-filesystem-drop-paginated-nested-empty-failure-cleanup-retention',linkDrag:'browser-default',navigation:'back-forward-refresh',errors}));
}catch(error){
 await mkdir('.local',{recursive:true});await page.screenshot({path:'.local/sandbox-failure.png',fullPage:true});
 console.error(JSON.stringify({errors,consoleErrors,dragEvents,requests,frames:await Promise.all(page.frames().map(async frame=>({url:frame.url(),text:await frame.locator('body').innerText().catch(()=>'<unavailable>')})))}));
 throw error;
}finally{await browser.close();for(const socket of web.clients){socket.terminate();}await new Promise(resolve=>web.close(resolve));await Promise.all(uploadCleanup);await new Promise(resolve=>server.close(resolve));for(const root of uploadRoots){await rm(root,{recursive:true,force:true});}if(directorySource){await rm(directorySource,{recursive:true,force:true});}}
