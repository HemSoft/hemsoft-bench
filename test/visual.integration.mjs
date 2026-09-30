import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {run} from '../src/process.mjs';
import {validateSvg,visualFilename} from '../src/visual.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><title>Kangaroo on bicycle</title><circle cx="55" cy="160" r="35"/><circle cx="230" cy="160" r="35"/><path d="M55 160L120 95L230 160Z"/><path d="M130 110L150 50"/></svg>';

async function offlineAttempt(id,model,source,mode='regular'){
 const temp=await mkdtemp(join(tmpdir(),'hb-visual-')),managed=join(root,'.local','managed-runs',id);
 try{
  const fixture=join(temp,'pi.cjs'),config=join(temp,'config.json');
  await writeFile(config,JSON.stringify({model:{provider:'openrouter',model,thinking:'max'}}));
  await writeFile(join(temp,'art.svg'),source);
  await writeFile(fixture,`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
if(process.argv.includes('--version')){console.log('offline-pi');process.exit(0)}
const spec=JSON.parse(fs.readFileSync(process.env.HB_RUN_SPEC,'utf8'));
const settings=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.pi/settings.json'),'utf8'));
fs.writeFileSync(path.join(path.dirname(spec.statePath),'settings-observed.json'),JSON.stringify(settings));
if(${JSON.stringify(mode)}==='link')cp.execFileSync('docker',['exec',spec.container,'ln','-s','/workspace/TASK.md','/workspace/bike.svg']);
else if(${JSON.stringify(mode)}==='fifo')cp.execFileSync('docker',['exec',spec.container,'mkfifo','/workspace/bike.svg']);
else cp.execFileSync('docker',['exec','-i',spec.container,'python','-I','-c',"import sys;open('/workspace/bike.svg','wb').write(sys.stdin.buffer.read())"],{input:fs.readFileSync(path.join(__dirname,'art.svg'))});
fs.writeFileSync(spec.statePath,JSON.stringify({status:'ready'}));
const emit=e=>console.log(JSON.stringify(e));
emit({type:'message_start',message:{role:'assistant'}});
emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}],usage:{input:3,output:5,cacheRead:0,cacheWrite:0,cost:{total:0.001}}}});
`);
  const execution=await run(process.execPath,[join(root,'src/cli.mjs'),'run','kangaroo-bike','--config',config,'--managed-run',id,'--repeat','1','--wall-seconds','60','--execute'],{env:{...process.env,HB_PI_ENTRY:fixture},timeoutMs:50000});
  const record=JSON.parse(execution.stdout.trim());
  const result=JSON.parse(await readFile(record.resultFile,'utf8'));
  const retainedCandidate=await readFile(join(record.resultFile,'..','bike.svg'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  return {execution,result,record,retainedCandidate,settings:JSON.parse(await readFile(join(record.resultFile,'..','settings-observed.json'),'utf8'))};
 }finally{await rm(temp,{recursive:true,force:true});await rm(managed,{recursive:true,force:true});}
}

test('offline candidate publishes validated SVG and PNG in .local/results without grading art',async()=>{
 const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model})),pngFile=file.replace(/\.svg$/,'.png');
 try{
  const {execution,result,settings}=await offlineAttempt(randomUUID(),model,svg);
  assert.equal(execution.code,0,execution.stderr);
  assert.equal(result.status,'needs_visual_review');assert.equal(result.grade,null);
  assert.equal(result.artifact.publicFile,file);assert.equal(result.artifact.published,true);
  assert.equal(result.artifact.pngPublicFile,pngFile);
  assert.equal(await readFile(file,'utf8'),svg);
  const png=await readFile(pngFile);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(png.readUInt32BE(16)<=1200 && png.readUInt32BE(20)<=1200);
  assert.equal(settings.retry.provider.maxRetries,0);
 }finally{await rm(file,{force:true});await rm(pngFile,{force:true});}
});
test('self-contained CSS and local gradient references are accepted',async()=>{
 const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model})),pngFile=file.replace(/\.svg$/,'.png');
 const styled='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="fur"><stop offset="0%" stop-color="orange"/></linearGradient></defs><style>.fur { fill: url(#fur); stroke: black; }</style><path class="fur" fill="url(#fur)" d="M0 0L50 50"/></svg>';
 try{
  const {execution,result}=await offlineAttempt(randomUUID(),model,styled);
  assert.equal(execution.code,0,execution.stderr);
  assert.equal(result.status,'needs_visual_review');assert.equal(await readFile(file,'utf8'),styled);
  assert.equal((await readFile(pngFile)).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 }finally{await rm(file,{force:true});await rm(pngFile,{force:true});}
});
test('local blur and drop-shadow filters validate and render offline',async()=>{
 const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model})),pngFile=file.replace(/\.svg$/,'.png');
 const filtered='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="shade"><feGaussianBlur stdDeviation="2"/><feDropShadow dx="2" dy="3" stdDeviation="2" flood-opacity=".3"/></filter></defs><circle cx="50" cy="50" r="30" fill="orange" filter="url(#shade)"/></svg>';
 try{
  const {result}=await offlineAttempt(randomUUID(),model,filtered);
  assert.equal(result.status,'needs_visual_review',result.error);
  assert.equal(await readFile(file,'utf8'),filtered);
  assert.equal((await readFile(pngFile)).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 }finally{await rm(file,{force:true});await rm(pngFile,{force:true});}
});
test('fragment-local use elements validate and render offline',async()=>{
 const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model})),pngFile=file.replace(/\.svg$/,'.png');
 const reused='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><g id="spokes"><path d="M0-20V20M-20 0H20"/></g><g id="wheel"><circle r="22"/><use href="#spokes"/></g></defs><use href="#wheel" transform="translate(28 50)"/><use href="#wheel" transform="translate(72 50)"/></svg>';
 try{
  const {result}=await offlineAttempt(randomUUID(),model,reused);
  assert.equal(result.status,'needs_visual_review',result.error);
  assert.equal(await readFile(file,'utf8'),reused);
  assert.equal((await readFile(pngFile)).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 }finally{await rm(file,{force:true});await rm(pngFile,{force:true});}
});
test('a subsequent run never overwrites either model-named image, and retains both candidates',async()=>{
 const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model})),pngFile=file.replace(/\.svg$/,'.png');
 try{
  await offlineAttempt(randomUUID(),model,svg);
  const original=await readFile(pngFile);
  const second=await offlineAttempt(randomUUID(),model,svg.replace('bicycle','bike'));
  assert.equal(second.execution.code,1);assert.equal(second.result.status,'artifact_conflict');
  assert.equal(second.result.artifact.collision,true);
  assert.equal(await readFile(file,'utf8'),svg);
  assert.deepEqual(await readFile(pngFile),original);
 }finally{await rm(file,{force:true});await rm(pngFile,{force:true});}
});
test('an existing PNG blocks publication of the SVG, leaving the old PNG untouched',async()=>{
 const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model})),pngFile=file.replace(/\.svg$/,'.png');
 await writeFile(pngFile,'existing');
 try{
  const {result}=await offlineAttempt(randomUUID(),model,svg);
  assert.equal(result.status,'artifact_conflict');
  assert.equal(await readFile(pngFile,'utf8'),'existing');
  await assert.rejects(stat(file),{code:'ENOENT'});
 }finally{await rm(file,{force:true});await rm(pngFile,{force:true});}
});
for(const [name,source] of [['script','<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],['external','<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/x"/></svg>'],['external-use','<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.invalid/x.svg#shape"/></svg>'],['missing-use','<svg xmlns="http://www.w3.org/2000/svg"><use href="#missing"/></svg>'],['cyclic-use','<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="loop"><use href="#loop"/></g></defs><use href="#loop"/></svg>'],['doctype','<!DOCTYPE svg [<!ENTITY e SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>'],['invalid','<svg xmlns="http://www.w3.org/2000/svg">'],['css-import','<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.invalid/p.css";</style></svg>'],['css-remote','<svg xmlns="http://www.w3.org/2000/svg"><style>.x{fill:url(https://example.invalid/img)}</style></svg>']]){
 test(`invalid ${name} SVG is not published`,async()=>{
  const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model}));
  const {result,retainedCandidate}=await offlineAttempt(randomUUID(),model,source);
  assert.equal(result.status,'missing_or_invalid_submission');
  assert.equal(retainedCandidate,source);
  if(name==='script')assert.match(result.error,/Unsupported SVG element <script>/);
  await assert.rejects(stat(file),{code:'ENOENT'});
  await assert.rejects(stat(file.replace(/\.svg$/,'.png')),{code:'ENOENT'});
 });
}
for(const mode of ['link','fifo'])test(`${mode} artifact is rejected without hanging or publishing`,async()=>{
 const model='offline-'+randomUUID(),file=join(root,'.local/results',visualFilename({model}));
 const {result}=await offlineAttempt(randomUUID(),model,svg,mode);
 assert.equal(result.status,'missing_or_invalid_submission');
 await assert.rejects(stat(file),{code:'ENOENT'});
});
