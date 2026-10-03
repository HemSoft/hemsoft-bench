import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {Sandbox} from './sandbox.mjs';
import {checked} from './process.mjs';

export const SCHEDULER_TASK_ID='resilient-scheduler';
export const SCHEDULER_FILES=['scheduler/model.py','scheduler/engine.py','scheduler/replay.py'];
const root=fileURLToPath(new URL('../',import.meta.url));

function clone(value){return JSON.parse(JSON.stringify(value));}
function compareText(a,b){return a<b?-1:a>b?1:0;}

export function schedulerReference(input,options={}){
  const workers=new Map((input.workers??[]).map(w=>[w.id,{id:w.id,cpu:w.cpu,memory:w.memory,labels:new Set(w.labels??[]),usedCpu:0,usedMemory:0,up:true}]));
  const jobs=new Map(),keys=new Map(),effects=new Set(),timeline=[];
  let now=0;
  const state=j=>({id:j.id,status:j.status,attempts:j.attempts});
  const event=(at,type,j,extra={})=>timeline.push({at,event:type,job:j.id,...extra});
  const release=j=>{
    if(!j.worker)return;
    const w=workers.get(j.worker);
    if(w){w.usedCpu-=j.cpu;w.usedMemory-=j.memory;}
    j.worker=null;j.token=null;j.leaseUntil=null;
  };
  const terminal=s=>['succeeded','failed','cancelled','blocked'].includes(s);
  const propagate=at=>{
    if(options.noDependencyPropagation)return;
    let changed=true;
    while(changed){changed=false;
      for(const j of jobs.values()){
        if(j.status!=='pending')continue;
        const bad=j.requires.find(id=>jobs.has(id)&&['failed','cancelled','blocked'].includes(jobs.get(id).status));
        if(bad){j.status='blocked';event(at,'blocked',j,{dependency:bad});changed=true;}
      }
    }
  };
  const workerFor=j=>{
    const candidates=[];
    for(const w of workers.values()){
      if(!w.up||![...j.labels].every(x=>w.labels.has(x)))continue;
      if(w.cpu-w.usedCpu<j.cpu||w.memory-w.usedMemory<j.memory)continue;
      const rc=w.cpu-w.usedCpu-j.cpu,rm=w.memory-w.usedMemory-j.memory;
      candidates.push({w,key:options.firstFit?[0,w.id]:[rc+rm,rc,rm,w.id]});
    }
    candidates.sort((a,b)=>{for(let i=0;i<a.key.length;i++){if(a.key[i]!==b.key[i])return typeof a.key[i]==='string'?compareText(a.key[i],b.key[i]):a.key[i]-b.key[i];}return 0;});
    return candidates[0]?.w;
  };
  const canRun=(j,at)=>j.status==='pending'&&j.readyAt<=at&&j.requires.every(id=>jobs.get(id)?.status==='succeeded')&&(options.noMutex||!j.mutex||![...jobs.values()].some(x=>x.status==='running'&&x.mutex===j.mutex));
  const dispatch=at=>{
    let progress=true;
    while(progress){progress=false;
      const ready=[...jobs.values()].filter(j=>canRun(j,at));
      ready.sort((a,b)=>{
        const pa=a.priority+(options.noAging?0:Math.floor((at-a.submitted)/a.aging));
        const pb=b.priority+(options.noAging?0:Math.floor((at-b.submitted)/b.aging));
        return pb-pa||a.submitted-b.submitted||compareText(a.id,b.id);
      });
      for(const j of ready){
        const w=workerFor(j);if(!w)continue;
        j.status='running';j.attempts++;j.worker=w.id;j.token=`${j.id}:${j.attempts}`;j.leaseUntil=at+j.lease;
        w.usedCpu+=j.cpu;w.usedMemory+=j.memory;
        event(at,'started',j,{worker:w.id,attempt:j.attempts,token:j.token,leaseUntil:j.leaseUntil});
        progress=true;break;
      }
    }
  };
  const retry=(j,at,reason)=>{
    const attempt=j.attempts;release(j);
    if(attempt>=j.maxAttempts){j.status='failed';event(at,'failed',j,{attempt,reason});return;}
    j.status='pending';j.readyAt=at+(options.noBackoff?0:j.backoff*Math.pow(2,attempt-1));
    event(at,'retry',j,{attempt,reason,readyAt:j.readyAt});
  };
  const nextInternal=limit=>{
    let value=Infinity;
    for(const j of jobs.values()){
      if(j.status==='running')value=Math.min(value,j.leaseUntil);
      if(j.status==='pending'&&j.readyAt>now)value=Math.min(value,j.readyAt);
    }
    return value<=limit?value:Infinity;
  };
  const advance=target=>{
    for(let t=nextInternal(target);t!==Infinity;t=nextInternal(target)){
      now=t;
      const expired=[...jobs.values()].filter(j=>j.status==='running'&&j.leaseUntil<=t).sort((a,b)=>compareText(a.id,b.id));
      for(const j of expired){if(options.noLeases){j.leaseUntil=target+1;continue;}retry(j,t,'lease');}
      // At an external-operation timestamp, defer scheduling until the caller
      // applies the complete batch. Internal timestamps before it dispatch now.
      if(t<target){propagate(t);dispatch(t);}
    }
    now=target;
  };
  const submit=(spec,at)=>{
    if(jobs.has(spec.id)||spec.key&&keys.has(spec.key))return;
    const r=spec.resources??{};
    const j={id:spec.id,key:spec.key??null,submitted:at,priority:spec.priority??0,cpu:r.cpu??1,memory:r.memory??1,labels:new Set(spec.labels??[]),requires:[...(spec.requires??[])],mutex:spec.mutex??null,maxAttempts:spec.maxAttempts??1,backoff:spec.backoff??1,lease:spec.lease??10,aging:spec.aging??10,effect:spec.effect??null,status:'pending',attempts:0,readyAt:at,worker:null,token:null,leaseUntil:null};
    jobs.set(j.id,j);if(j.key)keys.set(j.key,j.id);
  };
  const apply=(op,at)=>{
    if(op.type==='submit'){submit(op.job,at);return;}
    if(op.type==='workerDown'||op.type==='workerUp'){const w=workers.get(op.worker);if(w)w.up=op.type==='workerUp';return;}
    const j=jobs.get(op.job);if(!j)return;
    if(op.type==='cancel'&&!terminal(j.status)){if(j.status==='running')release(j);j.status='cancelled';event(at,'cancelled',j);return;}
    if(op.type==='heartbeat'&&j.status==='running'&&op.token===j.token){j.leaseUntil=at+j.lease;event(at,'heartbeat',j,{token:j.token,leaseUntil:j.leaseUntil});return;}
    if((op.type==='finish'||op.type==='fail')&&j.status==='running'&&(options.acceptStale||op.token===j.token)){
      const attempt=j.attempts;
      if(op.type==='fail'){retry(j,at,'failure');return;}
      release(j);j.status='succeeded';if(j.effect)effects.add(j.effect);event(at,'succeeded',j,{attempt});
    }
  };
  const operations=[...(input.operations??[])];
  let i=0;
  while(i<operations.length){
    const at=operations[i].at;advance(at);
    while(i<operations.length&&operations[i].at===at)apply(operations[i++],at);
    propagate(at);dispatch(at);
  }
  advance(input.until??now);
  const impossible=j=>![...workers.values()].some(w=>[...j.labels].every(x=>w.labels.has(x))&&w.cpu>=j.cpu&&w.memory>=j.memory);
  for(const j of jobs.values())if(j.status==='pending'&&(impossible(j)||j.requires.some(id=>!jobs.has(id)))){j.status='blocked';event(now,'blocked',j,{dependency:j.requires.find(id=>!jobs.has(id))??null});}
  const visiting=new Set(),done=new Set(),cycles=new Set();
  const visit=id=>{if(visiting.has(id)){cycles.add(id);return true;}if(done.has(id))return false;const j=jobs.get(id);if(!j||j.status!=='pending')return false;visiting.add(id);let cyclic=false;for(const d of j.requires)if(visit(d)){cycles.add(id);cyclic=true;}visiting.delete(id);done.add(id);return cyclic;};
  for(const j of jobs.values())visit(j.id);
  for(const id of [...cycles].sort()){const j=jobs.get(id);if(j.status==='pending'){j.status='blocked';event(now,'blocked',j,{dependency:'cycle'});}}
  propagate(now);dispatch(now);
  return {timeline,jobs:[...jobs.values()].map(state).sort((a,b)=>compareText(a.id,b.id)),effects:[...effects].sort()};
}

function rng(seed){let s=seed>>>0;return n=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s%n;};}
const worker=(id,cpu=4,memory=4,labels=[])=>({id,cpu,memory,labels});
const submit=(at,id,extra={})=>({at,type:'submit',job:{id,resources:{cpu:1,memory:1},lease:5,maxAttempts:2,backoff:2,aging:5,...extra}});

export function schedulerCases(){
  const cases=[
    {workers:[worker('w')],operations:[submit(0,'a'),{at:1,type:'finish',job:'a',token:'a:1'}],until:2},
    {workers:[worker('w')],operations:[submit(0,'a',{maxAttempts:2}),{at:1,type:'fail',job:'a',token:'a:1'},{at:3,type:'finish',job:'a',token:'a:2'}],until:4},
    {workers:[worker('w')],operations:[submit(0,'a',{lease:3}),{at:3,type:'heartbeat',job:'a',token:'a:1'},{at:4,type:'finish',job:'a',token:'a:1'}],until:5},
    {workers:[worker('w')],operations:[submit(0,'a',{lease:2,maxAttempts:2}),{at:3,type:'finish',job:'a',token:'a:1'},{at:5,type:'finish',job:'a',token:'a:2'}],until:6},
    {workers:[worker('w')],operations:[submit(0,'b',{requires:['a']}),submit(0,'a'),{at:1,type:'finish',job:'a',token:'a:1'},{at:2,type:'finish',job:'b',token:'b:1'}],until:3},
    {workers:[worker('w')],operations:[submit(0,'a',{requires:['b']}),submit(0,'b',{requires:['a']})],until:2},
    {workers:[worker('w',2,2)],operations:[submit(0,'a',{mutex:'db'}),submit(0,'b',{mutex:'db'}),{at:1,type:'finish',job:'a',token:'a:1'},{at:2,type:'finish',job:'b',token:'b:1'}],until:3},
    {workers:[worker('large',8,8),worker('tight',2,2)],operations:[submit(0,'a',{resources:{cpu:2,memory:2}})],until:1},
    {workers:[worker('w')],operations:[submit(0,'a',{effect:'mail:1'}),submit(0,'b',{effect:'mail:1'}),{at:1,type:'finish',job:'a',token:'a:1'},{at:2,type:'finish',job:'b',token:'b:1'}],until:3},
    {workers:[worker('w')],operations:[submit(0,'a'),{at:1,type:'cancel',job:'a'},{at:2,type:'finish',job:'a',token:'a:1'}],until:3},
    {workers:[worker('w')],operations:[submit(0,'a'),{at:1,type:'workerDown',worker:'w'},{at:5,type:'workerUp',worker:'w'},{at:7,type:'finish',job:'a',token:'a:2'}],until:8},
    {workers:[worker('cpu',4,4,['cpu']),worker('gpu',4,4,['gpu'])],operations:[submit(0,'a',{labels:['gpu']})],until:1},
    {workers:[worker('w')],operations:[submit(0,'a',{key:'same'}),submit(0,'b',{key:'same'})],until:1},
    {workers:[worker('w')],operations:[submit(0,'a',{requires:['missing']})],until:1},
    {workers:[worker('w',1,1)],operations:[submit(0,'low',{priority:0,aging:1}),submit(0,'high',{priority:3}),{at:4,type:'finish',job:'high',token:'high:1'}],until:5},
    {workers:[worker('w',1,1)],operations:[submit(0,'a',{resources:{cpu:2,memory:1}})],until:1},
  ];
  const rand=rng(92317);
  for(let c=0;c<56;c++){
    const workers=[worker('w1',2+rand(4),2+rand(4),rand(2)?['cpu']:['gpu']),worker('w2',3+rand(4),3+rand(4),['cpu','gpu'])];
    const operations=[];const n=3+rand(5);
    for(let i=0;i<n;i++){
      const id='j'+i,requires=i&&rand(3)===0?['j'+rand(i)]:[];
      operations.push(submit(rand(3),id,{priority:rand(7)-2,resources:{cpu:1+rand(3),memory:1+rand(3)},requires,labels:rand(4)===0?['gpu']:[],mutex:rand(4)===0?'m'+rand(2):null,maxAttempts:1+rand(3),lease:2+rand(5),backoff:1+rand(3),aging:1+rand(6),effect:rand(5)===0?'e'+rand(4):null}));
    }
    operations.sort((a,b)=>a.at-b.at||compareText(a.job.id,b.job.id));
    for(let i=0;i<n;i++){
      const at=3+rand(12),kind=rand(5);
      operations.push(kind===0?{at,type:'cancel',job:'j'+i}:kind===1?{at,type:'fail',job:'j'+i,token:`j${i}:1`}:{at,type:'finish',job:'j'+i,token:`j${i}:1`});
    }
    if(c%4===0){operations.push({at:2,type:'workerDown',worker:'w1'},{at:7,type:'workerUp',worker:'w1'});}
    operations.sort((a,b)=>a.at-b.at);
    cases.push({workers,operations,until:18,checkpoint:c%3===0?1+rand(Math.max(1,operations.length-1)):null});
  }
  return cases;
}

export function schedulerAnswers(cases=schedulerCases(),options={}){return cases.map(x=>schedulerReference(clone(x),options));}

export async function schedulerStarter(){
  return Object.fromEntries(await Promise.all(SCHEDULER_FILES.map(async path=>[path,await readFile(join(root,'tasks',SCHEDULER_TASK_ID,path),'utf8')])));
}

export function schedulerBundleHash(bundle){
  const canonical=JSON.stringify(SCHEDULER_FILES.map(path=>[path,bundle[path]]));
  return createHash('sha256').update(canonical).digest('hex');
}

async function prepareScheduler(box,bundle){
  for(const path of SCHEDULER_FILES){
    if(typeof bundle[path]!=='string'||Buffer.byteLength(bundle[path])>512*1024)throw new Error(`Invalid ${path}`);
    await box.file('write',{path,content:bundle[path]});
  }
  await box.file('write',{path:'scheduler/__init__.py',content:'from .engine import Engine\n'});
  await box.file('write',{path:'_runner.py',content:await readFile(join(root,'tasks',SCHEDULER_TASK_ID,'runner.py'),'utf8')});
}

export async function gradeScheduler(image,bundle,cases=schedulerCases()){
  const box=await new Sandbox(image).start();
  try{
    await prepareScheduler(box,bundle);
    const input=JSON.stringify({cases});
    const output=await checked('docker',['exec','-i',box.name,'timeout','45','python','-I','/workspace/_runner.py'],{input,timeoutMs:55000,maxBytes:8*1024*1024});
    const actual=JSON.parse(output),expected=schedulerAnswers(cases);
    if(!Array.isArray(actual)||actual.length!==expected.length)throw new Error('Runner must return one answer per case.');
    let passed=0;for(let i=0;i<expected.length;i++)if(isDeepStrictEqual(actual[i],expected[i]))passed++;
    return {passed,total:expected.length,success:passed===expected.length};
  }finally{await box.dispose();}
}

export async function saveSchedulerBundle(bundle,directory){
  const target=join(directory,'submission','scheduler');
  await mkdir(target,{recursive:true,mode:0o700});
  for(const path of SCHEDULER_FILES)await writeFile(join(directory,'submission',path),bundle[path],{flag:'wx',mode:0o600});
  return schedulerBundleHash(bundle);
}
