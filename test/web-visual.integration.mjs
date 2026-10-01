import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {run} from '../src/process.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const valid='<!doctype html><html><head><title>World time</title><style>*{box-sizing:border-box}body{margin:0;background:#123;color:white}.clock{position:relative;width:min(50vw,50vh);height:min(50vw,50vh);min-width:160px;min-height:160px;margin:1rem auto;border:2px solid;border-radius:50%}.hand{position:absolute;left:50%;top:15%;height:35%;width:2px;background:white;transform-origin:50% 100%}.locations{display:grid;grid-template-columns:repeat(2,1fr)}</style></head><body><main><h1>World Clock</h1><div class="clock" data-clock-face><i class="hand" data-clock-hand="hour"></i><i class="hand" data-clock-hand="minute"></i><i class="hand" data-clock-hand="second"></i></div><div class="locations"><p data-world-location>New York</p><p data-world-location>London</p><p data-world-location>Tokyo</p><p data-world-location>Sydney</p></div></main><script>function tick(){const d=new Date(),s=d.getSeconds(),m=d.getMinutes()+s/60,h=d.getHours()%12+m/60;for(const [k,v] of Object.entries({second:s*6,minute:m*6,hour:h*30}))document.querySelector(`[data-clock-hand="${k}"]`).style.transform=`rotate(${v}deg)`}tick();setInterval(tick,250)</script></body></html>';

async function attempt(source){
 const temp=await mkdtemp(join(tmpdir(),'hb-world-clock-')),id=randomUUID(),managed=join(root,'.local','managed-runs',id);
 try{
  const fixture=join(temp,'pi.cjs'),config=join(temp,'config.json');
  await writeFile(config,JSON.stringify({model:{provider:'openrouter',model:'offline/world-clock',thinking:'max'}}));
  await writeFile(join(temp,'clock.html'),source);
  await writeFile(fixture,`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
if(process.argv.includes('--version')){console.log('offline-pi');process.exit(0)}
const spec=JSON.parse(fs.readFileSync(process.env.HB_RUN_SPEC,'utf8'));
cp.execFileSync('docker',['exec','-i',spec.container,'python','-I','-c',"import sys;open('/workspace/world-clock.html','wb').write(sys.stdin.buffer.read())"],{input:fs.readFileSync(path.join(__dirname,'clock.html'))});
fs.writeFileSync(spec.statePath,JSON.stringify({status:'ready'}));
console.log(JSON.stringify({type:'message_start',message:{role:'assistant'}}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}],usage:{input:3,output:5,cacheRead:0,cacheWrite:0,cost:{total:0.001}}}}));
`);
  const execution=await run(process.execPath,[join(root,'src/cli.mjs'),'run','world-clock','--config',config,'--managed-run',id,'--repeat','1','--wall-seconds','60','--execute'],{env:{...process.env,HB_PI_ENTRY:fixture},timeoutMs:50000});
  const event=JSON.parse(execution.stdout.trim());
  const result=JSON.parse(await readFile(event.resultFile,'utf8'));
  return {execution,result,source:await readFile(join(event.resultFile,'..','world-clock.html'),'utf8').catch(()=>null)};
 }finally{await rm(temp,{recursive:true,force:true});await rm(managed,{recursive:true,force:true});}
}

test('offline world clock becomes an owned sandboxed webpage presentation',async()=>{
 const {execution,result,source}=await attempt(valid);
 assert.equal(execution.code,0,execution.stderr);
 assert.equal(result.status,'needs_visual_review',result.error);
 assert.equal(result.grade,null);
 assert.equal(result.presentations.length,1);
 assert.equal(result.presentations[0].kind,'webpage');
 assert.equal(source,valid);
});

test('world clock accepts harmless JavaScript slashes and rendered location hooks',async()=>{
 const dynamic=valid
  .replace('<div class="locations"><p data-world-location>New York</p><p data-world-location>London</p><p data-world-location>Tokyo</p><p data-world-location>Sydney</p></div>','<div class="locations" id="locations"></div>')
  .replace('<script>',`<script>
// JavaScript comments and slash regexes are not protocol-relative URLs.
'a/b'.replace(/\\//g,'');
for(const name of ['New York','London','Tokyo','Sydney']){
 const p=document.createElement('p');p.dataset.worldLocation=name;p.textContent=name;document.getElementById('locations').append(p)
}`);
 const {execution,result,source}=await attempt(dynamic);
 assert.equal(execution.code,0,execution.stderr);
 assert.equal(result.status,'needs_visual_review',result.error);
 assert.equal(source,dynamic);
});

test('world clock rejects a hand that does not keep moving',async()=>{
 const stopped=valid.replace('setInterval(tick,250)','setInterval(()=>{},250)');
 const {execution,result,source}=await attempt(stopped);
 assert.equal(execution.code,0,execution.stderr);
 assert.equal(result.status,'missing_or_invalid_submission');
 assert.match(result.error,/not valid, self-contained and live/);
 assert.equal(source,stopped);
});

test('world clock browser verdict cannot be forged by candidate markup',async()=>{
 const forged=valid.replace('setInterval(tick,250)','setInterval(()=>{},250)').replace('<body>','<body><pre id="hb-result">{"ok":true,"errors":[]}</pre>');
 const {execution,result}=await attempt(forged);
 assert.equal(execution.code,0,execution.stderr);
 assert.equal(result.status,'missing_or_invalid_submission');
 assert.match(result.error,/second hand did not move/);
});

test('world clock rejects external assets and retains the candidate for diagnosis',async()=>{
 const invalid=valid.replace('</head>','<script src="https://example.com/clock.js"></script></head>');
 const {execution,result,source}=await attempt(invalid);
 assert.equal(execution.code,0,execution.stderr);
 assert.equal(result.status,'missing_or_invalid_submission');
 assert.match(result.error,/not valid, self-contained and live/);
 assert.equal(source,invalid);
});
