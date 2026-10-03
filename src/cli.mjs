import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { piArgs, validateModel, summarizeEvents, summarizeRuns, SYSTEM_PROMPT, executionPolicy, isolatedPiSettings } from './core.mjs';
import { checked, run, piCommand } from './process.mjs';
import { Sandbox } from './sandbox.mjs';
import { Activity, eventDecoder, formatActivity, formatCompactActivity } from './activity.mjs';
import { acquireRunLock, validateRunLock, releaseRunLock } from './retention.mjs';
import { STARTER_SOURCE, RECOVERABLE_STATUSES, recoverSubmission } from './submission.mjs';
import { SCHEDULER_TASK_ID, TASK_IDS, TASK_VERSION, taskCases, expectedAnswers, scoreAnswers } from './tasks.mjs';
import {SCHEDULER_FILES,schedulerStarter,schedulerBundleHash,gradeScheduler,saveSchedulerBundle} from './scheduler-task.mjs';
import { VISUAL_TASK_ID, validateSvg, rasterizeSvg, publishSvg } from './visual.mjs';
import { WEB_VISUAL_TASK_ID, validateWorldClock, saveWorldClock } from './web-visual.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseLocal = join(root,'.local');
let local = baseLocal;
let managedRunId;
let executionContext = {mode:'legacy',concurrency:1};
const modelFile = join(root,'models.local.json');
const abort = new AbortController();
const VISUAL_TASK_IDS=new Set([VISUAL_TASK_ID,WEB_VISUAL_TASK_ID]);
process.on('SIGINT',()=>abort.abort());
process.on('SIGTERM',()=>abort.abort());
const hash = text => createHash('sha256').update(text).digest('hex');
const json = async path => JSON.parse(await readFile(path,'utf8'));
async function save(path,value) { await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n'); }
function options(argv) {
  const positional=[], flags={};
  for(let i=0;i<argv.length;i++) {
    if(!argv[i].startsWith('--')) {positional.push(argv[i]);continue;}
    const key=argv[i].slice(2);
    if(!['provider','model','thinking','repeat','execute','wall-seconds','max-requests','max-estimated-usd','search','config','progress','progress-json','invocation','managed-run'].includes(key))throw new Error(`Unknown option --${key}`);
    if(key in flags)throw new Error(`Duplicate option --${key}`);
    flags[key]=['execute','progress','progress-json'].includes(key)?true:argv[++i];
    if(flags[key]===undefined)throw new Error(`Missing value for --${key}`);
  }
  return {positional,flags};
}
function positive(value,fallback,max) {
  const n=value===undefined?fallback:Number(value);
  if(!Number.isInteger(n)||n<1||n>max)throw new Error(`Expected integer between 1 and ${max}`);
  return n;
}
async function imageId() {
  const lock=await json(join(baseLocal,'runtime.json')).catch(()=>{throw new Error('Run setup first to record an immutable local image ID.');});
  await checked('docker',['image','inspect',lock.image,'--format','{{.Id}}']);
  return lock.image;
}
async function rendererId() {
  const lock=await json(join(baseLocal,'runtime.json'));
  if(!/^sha256:[a-f0-9]{64}$/.test(lock.rendererImage??''))throw new Error('Run setup to pin the local SVG renderer image before starting a visual test.');
  await checked('docker',['image','inspect',lock.rendererImage,'--format','{{.Id}}']);
  await checked('docker',['run','--rm','--pull=never','--network=none','--read-only',lock.rendererImage,'rsvg-convert','--version'],{timeoutMs:12000,maxBytes:1024});
  await checked('docker',['run','--rm','--pull=never','--network=none','--read-only',lock.rendererImage,'chromium','--version'],{timeoutMs:12000,maxBytes:1024});
  await checked('docker',['run','--rm','--pull=never','--network=none','--read-only',lock.rendererImage,'chromedriver','--version'],{timeoutMs:12000,maxBytes:1024});
  await checked('docker',['run','--rm','--pull=never','--network=none','--read-only',lock.rendererImage,'/usr/bin/python3','-c','import selenium'],{timeoutMs:12000,maxBytes:1024});
  return lock.rendererImage;
}
async function seed(sandbox,task) {
  await sandbox.file('write',{path:'TASK.md',content:await readFile(join(root,'tasks',task,'TASK.md'),'utf8')});
  if(task===SCHEDULER_TASK_ID) {
    const starter=await schedulerStarter();
    for(const path of SCHEDULER_FILES)await sandbox.file('write',{path,content:starter[path]});
    await sandbox.file('write',{path:'scheduler/__init__.py',content:'from .engine import Engine\n'});
    await sandbox.file('write',{path:'public_tests.py',content:await readFile(join(root,'tasks',task,'public_tests.py'),'utf8')});
    return starter;
  }
  if(!VISUAL_TASK_IDS.has(task)) {
    await sandbox.file('write',{path:'solution.py',content:STARTER_SOURCE});
    return STARTER_SOURCE;
  }
  return null;
}
async function grade(image,task,source,signal) {
  if(task===SCHEDULER_TASK_ID)return gradeScheduler(image,source,taskCases(task));
  const sandbox=await new Sandbox(image).start();
  try {
    const cases=taskCases(task), expected=expectedAnswers(task,cases);
    const execution=await sandbox.evaluate(source,{cases},{signal});
    if(execution.code!==0||execution.failure)return {passed:0,total:cases.length,success:false,executionError:execution.failure??`exit ${execution.code}`,stderr:execution.stderr.slice(0,4000)};
    let actual;try{actual=JSON.parse(execution.stdout);}catch{return {passed:0,total:cases.length,success:false,formatError:'Submission did not return valid JSON.'};}
    return scoreAnswers(expected,actual);
  } finally {await sandbox.dispose();}
}
async function fingerprints(task) {
  const files=['src/core.mjs','src/submission.mjs','src/activity.mjs','src/process.mjs','src/transport-diagnostics.mjs','src/sandbox.mjs','src/cli.mjs','src/tasks.mjs','src/scheduler-task.mjs','src/visual.mjs','src/web-visual.mjs','extensions/sandbox-tools.ts',`tasks/${task}/TASK.md`];
  if(task===SCHEDULER_TASK_ID)files.push(...SCHEDULER_FILES.map(path=>`tasks/${task}/${path}`),`tasks/${task}/runner.py`,`tasks/${task}/public_tests.py`);
  const hashes={};for(const f of files)hashes[f]=hash(await readFile(join(root,f)));
  return {files:hashes,systemPrompt:hash(SYSTEM_PROMPT),caseSet:VISUAL_TASK_IDS.has(task)?null:hash(JSON.stringify(taskCases(task)))};
}
async function executeTrial(model,task,limits,{selfTest=false,progress=false,progressJson=false,attempt=1,repeat=1}={}) {
  const image=await imageId();
  // Refuse an unavailable renderer before any paid request, not after the SVG
  // has already been produced.
  const renderer=VISUAL_TASK_IDS.has(task) && !selfTest?await rendererId():null;
  const id=randomUUID();
  const directory=join(local,'runs',id);
  const cwd=await mkdtemp(join(tmpdir(),'hb-'));
  await mkdir(join(cwd,'.pi'),{recursive:true});
  await writeFile(join(cwd,'.pi','settings.json'),JSON.stringify(isolatedPiSettings(model)));
  const sandbox=new Sandbox(image);
  const statePath=join(directory,'extension-state.json');
  const started=Date.now();
  let stage='Preparing sandbox';
  let activity, heartbeat, displayTimer;
  let candidateStarted=false, starterSource=null;
  const display=progress || progressJson;
  const activityPath=join(directory,'activity.json');
  const persistActivity=(status='running')=>{
    if(!activity)return;
    writeFileSync(activityPath+'.tmp',JSON.stringify({id,task,status,stage,wallSeconds:limits.wallSeconds,...activity.snapshot()},null,2)+'\n');
    renameSync(activityPath+'.tmp',activityPath);
  };
  const announce=()=>{
    const s=activity?.snapshot();
    const live=s && ['Model running','Checking sandbox tools'].includes(stage);
    const label=`[${task} ${attempt}/${repeat}]`;
    if(progressJson)console.log(JSON.stringify({type:'progress',task,attempt,repeat,stage,
      text:`${label} ${live?formatCompactActivity(s,limits.wallSeconds):stage}`,
      quiet:!!live && s.silenceSeconds>=60,toolErrors:s?.toolErrors??0,activity:s??null}));
    else console.error(`${label} ${live?formatActivity(s,limits.wallSeconds):`${stage} | ${Math.floor((Date.now()-started)/1000)}s elapsed`}`);
  };
  const setStage=value=>{stage=value;persistActivity();if(display)announce();};
  if(display)announce();
  const result={id,managedRunId,executionContext,executionPolicy:executionPolicy(model),task,taskVersion:TASK_VERSION,model,image,limits,selfTest,nodeVersion:process.version,hostPlatform:process.platform,startedAt:new Date().toISOString(),status:'infrastructure_error',grade:null};
  const tracePath=join(directory,'transport.jsonl');
  result.transportDiagnostics={version:1,file:tracePath,coverage:'HTTP/SSE metadata only; inspect missing end records alongside the run stop reason'};
  const stopPath=join(directory,'stop');
  const spec={...model,...limits,selfTest,container:sandbox.name,image,statePath,stopPath,cancelPath:managedRunId?join(local,'cancel'):null};
  const specPath=join(directory,'spec.json');
  try {
    await save(specPath,spec);
    result.fingerprints=await fingerprints(task);
    const pi=piCommand();
    result.piVersion=(await checked(pi.command,[...pi.prefix,'--version'])).trim();
    await sandbox.start();starterSource=await seed(sandbox,task);
    const args=piArgs(model,join(root,'extensions','sandbox-tools.ts'));
    // Save bounded raw output while it arrives; stdout remains machine-readable.
    const eventPath=join(directory,'events.jsonl'), stderrPath=join(directory,'stderr.txt');
    writeFileSync(eventPath,'');writeFileSync(stderrPath,'');
    activity=new Activity();
    const events=[];
    const decoder=eventDecoder(event=>{
      // Summary uses authoritative messages, never streaming usage estimates.
      if(['message_start','message_end','tool_execution_start','auto_retry_start','auto_retry_end'].includes(event?.type))events.push(event);
      if(activity.accept(event)){persistActivity();if(display)announce();}
    });
    heartbeat=setInterval(()=>{
      try {persistActivity();if(progress && !progressJson)announce();}
      catch(error){result.error=`Activity logging failed: ${error.message}`;abort.abort();}
    },10000);
    if(progressJson)displayTimer=setInterval(announce,1000);
    if(progress && !progressJson)console.error(`[${task} ${attempt}/${repeat}] Live activity: ${activityPath}`);
    // Self-test uses an input hook that handles the prompt and forbids provider requests.
    setStage(selfTest?'Checking sandbox tools':'Model running');
    spec.deadlineAt=Date.now()+limits.wallSeconds*1000;
    await save(specPath,spec);
    candidateStarted=true;
    const execution=await run(pi.command,[...pi.prefix,...args],{cwd,
      input:'Read /workspace/TASK.md and complete the task.\n',
      env:{...process.env,HB_TRANSPORT_TRACE:tracePath,PI_OFFLINE:'1',PI_TELEMETRY:'0',HB_RUN_SPEC:specPath,...(selfTest?{HB_HOST_SECRET:'fake-host-canary'}:{})},
      timeoutMs:limits.wallSeconds*1000,maxBytes:32*1024*1024,signal:abort.signal,
      onStdout:chunk=>{appendFileSync(eventPath,chunk);decoder.push(chunk);},
      onStderr:chunk=>appendFileSync(stderrPath,chunk),
      onStop:reason=>{writeFileSync(stopPath+'.tmp',reason);renameSync(stopPath+'.tmp',stopPath);}});
    const decoding=decoder.end();
    result.malformedEventLines=decoding.malformed;
    if(execution.observerError)result.error=`Run logging failed: ${execution.observerError}`;
    if(!selfTest)result.metrics=summarizeEvents(events,{interrupted:!!execution.failure || execution.code!==0 || !!decoding.malformed});
    if(decoding.malformed && !execution.failure)throw new Error('Invalid JSON in model event stream. See events.jsonl.');
    const state=await json(statePath).catch(()=>({status:'missing'}));
    result.extension=state;
    if(selfTest) {
      if(execution.code!==0||execution.failure||state.status!=='self_test_passed')throw new Error(`Pi self-test failed: ${execution.failure??execution.code}; extension ${state.status}. See retained stderr.`);
      result.status='self_test_passed';return result;
    }
    if(execution.failure) {result.status=execution.failure;return result;}
    if(state.status==='blocked'){result.status=state.reason;return result;}
    if(state.status==='ready' && result.metrics.providerErrors.length){result.status='provider_error';result.error=result.metrics.providerErrors.join('; ');return result;}
    if(execution.code!==0||state.status!=='ready')throw new Error('Pi failed or sandbox extension did not initialize.');
    if(!result.metrics.completed){result.status='incomplete';return result;}
    if(task===WEB_VISUAL_TASK_ID){
      let html;
      try{html=Buffer.from(await sandbox.webArtifact(),'utf8');}
      catch{result.status='missing_or_invalid_submission';result.error='No regular world-clock.html within the 2 MiB limit.';return result;}
      try{await validateWorldClock(image,renderer,html);}
      catch(error){
        const candidate=join(directory,'world-clock.html');
        await writeFile(candidate,html,{flag:'wx',mode:0o600});
        result.status='missing_or_invalid_submission';
        result.error=`World clock is not valid, self-contained and live. Candidate saved at ${candidate}. ${String(error.message).slice(0,500)}`;
        return result;
      }
      const saved=await saveWorldClock(html,directory);
      result.presentations=[saved.presentation];
      result.submissionHash=saved.sha256;
      result.status='needs_visual_review';
      return result;
    }
    if(task===VISUAL_TASK_ID){
      let svg;
      try{svg=Buffer.from(await sandbox.svgArtifact(),'utf8');}
      catch{result.status='missing_or_invalid_submission';result.error='No regular bike.svg within the 1 MiB limit.';return result;}
      try{await validateSvg(image,svg);}
      catch(error){
        const candidate=join(directory,'bike.svg');
        await writeFile(candidate,svg,{flag:'wx',mode:0o600});
        const reason=String(error.message).match(/(?:ValueError|ParseError): ([^\r\n]+)/)?.[1]?.slice(0,240);
        const unsupported=reason?.match(/^Unsupported SVG element: ([A-Za-z][A-Za-z0-9]{0,63})$/);
        result.status='missing_or_invalid_submission';
        if(reason)result.validationError=unsupported?`Unsupported SVG element <${unsupported[1]}>`:reason;
        result.error=`${result.validationError?`SVG validation failed: ${result.validationError}`:'SVG validation could not complete'}. Candidate saved at ${candidate}.`;
        return result;
      }
      setStage('Rendering PNG in isolated container');
      let png;
      try{png=await rasterizeSvg(renderer,svg);}
      catch(error){result.status='render_error';result.error=`Validated SVG could not be rendered to PNG: ${error.message}`;await writeFile(join(directory,'bike.svg'),svg,{flag:'wx',mode:0o600});return result;}
      result.artifact=await publishSvg(root,model,svg,png,directory);
      result.submissionHash=result.artifact.sha256;
      result.status=result.artifact.published?'needs_visual_review':'artifact_conflict';
      if(result.artifact.collision)result.error=`Existing named SVG or PNG was preserved. Candidate saved at ${result.artifact.ownedFile} and ${result.artifact.pngOwnedFile}.`;
      return result;
    }
    let source;
    try {source=task===SCHEDULER_TASK_ID?await sandbox.schedulerBundle():await sandbox.submission();}
    catch {result.status='missing_or_invalid_submission';return result;}
    result.submissionHash=task===SCHEDULER_TASK_ID?await saveSchedulerBundle(source,directory):hash(source);
    if(task!==SCHEDULER_TASK_ID)await writeFile(join(directory,'submission.py'),source);
    setStage('Grading submission');
    await sandbox.dispose(); // No candidate processes survive into grading.
    result.grade=await grade(image,task,source,abort.signal);
    result.status=result.grade.success?'passed':'failed';
    return result;
  } catch(error) {result.error=error.message;return result;}
  finally {
    if(heartbeat)clearInterval(heartbeat);
    if(displayTimer)clearInterval(displayTimer);
    if(!selfTest && !VISUAL_TASK_IDS.has(task) && candidateStarted && !result.submissionHash && RECOVERABLE_STATUSES.has(result.status)) {
      stage='Capturing and grading interrupted solution';
      if(display)announce();
      const gradingSignal=abort.signal.aborted?undefined:abort.signal;
      if(task===SCHEDULER_TASK_ID){
        result.recovery={kind:'interrupted_snapshot',reason:result.status,state:'capture_failed'};
        try{
          const bundle=await sandbox.schedulerBundle();
          if(schedulerBundleHash(bundle)===schedulerBundleHash(starterSource))result.recovery.state='unchanged_starter';
          else{
            result.recovery.sourceHash=await saveSchedulerBundle(bundle,directory);
            result.recovery.sourceFile='submission/scheduler';
            await sandbox.dispose();
            try{result.recovery.grade=await grade(image,task,bundle,gradingSignal);result.recovery.state='graded';}
            catch(error){result.recovery.state='grading_failed';result.recovery.error=error.message;}
          }
        }catch(error){result.recovery.error=error.message;}
      }else result.recovery=await recoverSubmission(sandbox,directory,source=>grade(image,task,source,gradingSignal),result.status,starterSource??STARTER_SOURCE);
      if(result.recovery.state==='cleanup_failed') {
        result.terminationStatus=result.status;
        result.status='cleanup_error';
        result.cleanupError=result.recovery.error;
      }
    }
    stage='Saving result and cleaning up';
    if(display)announce();
    try {await sandbox.dispose();} catch(error) {result.status='cleanup_error';result.cleanupError=error.message;}
    await rm(cwd,{recursive:true,force:true});
    result.elapsedSeconds=(Date.now()-started)/1000;
    try {persistActivity(result.status);} catch(error) {result.status='infrastructure_error';result.error=`Activity logging failed: ${error.message}`;}
    await save(join(directory,'result.json'),result);
    console.log(JSON.stringify({id,status:result.status,grade:result.grade,recovery:result.recovery,artifact:result.artifact,error:result.error,resultFile:join(directory,'result.json')}));
  }
}

async function main() {
  const [command='help',...argv]=process.argv.slice(2);
  const {positional,flags}=options(argv);
  if(flags['managed-run']) {
    managedRunId=flags['managed-run'];
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(managedRunId))throw new Error('Invalid managed run ID.');
    if(!['doctor','verify','self-test','run','report'].includes(command))throw new Error('This command does not support managed runs.');
    local=join(baseLocal,'managed-runs',managedRunId);
    const checkCancel=()=>{if(existsSync(join(local,'cancel')))abort.abort();};
    checkCancel();
    setInterval(checkCancel,250).unref();
    if(abort.signal.aborted)throw new Error('Managed run cancelled before launch.');
  }
  if(command==='help') {
    console.log(`HemSoft Bench\n\n  node src/cli.mjs setup\n  node src/cli.mjs doctor\n  node src/cli.mjs models [--search TEXT]\n  node src/cli.mjs add NAME --provider PROVIDER --model EXACT_ID --thinking LEVEL\n  node src/cli.mjs tasks\n  node src/cli.mjs report\n  node src/cli.mjs verify\n  node src/cli.mjs self-test NAME\n  node src/cli.mjs self-test --config PATH\n  node src/cli.mjs run TASK --config PATH [--repeat 3] [--execute]\n  node src/cli.mjs run NAME TASK [--repeat 3] [--execute]\n\nRun without --execute only prints a plan. self-test and verify make no model calls.\nLimits: --wall-seconds 1800 --max-requests 40 --max-estimated-usd 5\nAdd --progress for live response/tool activity on stderr, or --progress-json for typed progress records on stdout.\nCost limit uses provider estimates, is checked between calls, and is NOT a billing guarantee.`);return;
  }
  if(command==='setup') {
    await mkdir(local,{recursive:true});
    // Pull explicitly via Docker first. setup never silently downloads or changes the image.
    const image=(await checked('docker',['image','inspect','python:3.12-slim','--format','{{.Id}}'])).trim();
    const rendererImage=(await checked('docker',['image','inspect','hemsoft-bench-renderer:local','--format','{{.Id}}'])).trim();
    await save(join(local,'runtime.json'),{image,rendererImage,sourceTag:'python:3.12-slim',rendererTag:'hemsoft-bench-renderer:local',recordedAt:new Date().toISOString()});
    console.log(`Recorded immutable sandbox image ${image} and offline SVG renderer ${rendererImage}`);return;
  }
  if(command==='doctor') {
    const pi=piCommand();
    console.log('Pi:',(await checked(pi.command,[...pi.prefix,'--version'])).trim());
    console.log('Docker:',(await checked('docker',['version','--format','{{.Server.Version}}'])).trim());
    console.log('Sandbox image:',await imageId());
    console.log('SVG renderer image:',await rendererId());
    console.log('No inference request made.');return;
  }
  if(command==='models') {
    const pi=piCommand();
    console.log(await checked(pi.command,[...pi.prefix,'--offline','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--list-models',...(flags.search?[flags.search]:[])],{maxBytes:2*1024*1024,timeoutMs:60000,env:{...process.env,PI_OFFLINE:'1',PI_TELEMETRY:'0'}}));return;
  }
  if(command==='report') {
    const directory=join(local,'runs');
    const entries=await readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const results=[];
    for(const entry of entries.filter(e=>e.isDirectory())) {
      const path=join(directory,entry.name,'result.json');
      if(existsSync(path)) results.push(await json(path));
      else console.error(`Incomplete run without result.json: ${entry.name}`);
    }
    console.log(JSON.stringify({note:'Full passes count against all attempts. Status counts expose infrastructure and budget failures. Changed configurations remain separate. Costs are estimates, not subscription invoices.',groups:summarizeRuns(results)},null,2));return;
  }
  if(command==='tasks') {console.log([...TASK_IDS.map(id=>`${id} v${TASK_VERSION} (${taskCases(id).length} hidden cases; difficulty uncalibrated)`),`${VISUAL_TASK_ID} v1 (visual artifact for human review; no automatic score)`,`${WEB_VISUAL_TASK_ID} v1 (live webpage for human review; no automatic score)`].join('\n'));return;}
  if(command==='add') {
    const [name]=positional;
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name??''))throw new Error('Use a short lowercase model alias.');
    const model=validateModel({provider:flags.provider,model:flags.model,thinking:flags.thinking});
    const config=existsSync(modelFile)?await json(modelFile):{models:{}};
    if(Object.hasOwn(config.models,name))throw new Error('Alias already exists; edit models.local.json explicitly to change it.');
    config.models[name]=model;await save(modelFile,config);console.log(`Added ${name}. Credentials remain in Pi, not this file.`);return;
  }
  if(command==='verify') {
    const image=await imageId();
    for(const task of TASK_IDS) {
      const cases=taskCases(task),expected=expectedAnswers(task,cases),box=await new Sandbox(image).start();
      let result;
      try{
        await box.file('write',{path:'reference.py',content:await readFile(join(root,'references',task+'.py'),'utf8')});
        const execution=await checked('docker',['exec','-i',box.name,'timeout','45','python','-I','/workspace/reference.py'],{input:JSON.stringify({cases}),timeoutMs:55000,maxBytes:8*1024*1024});
        result=scoreAnswers(expected,JSON.parse(execution));
      }finally{await box.dispose();}
      if(!result.success)throw new Error(`Reference failed for ${task}: ${JSON.stringify(result)}`);
      const bad=await grade(image,task,await schedulerStarter());
      if(bad.success)throw new Error('Grader accepted the intentionally defective starter');
      console.log(`${task}: independent Python reference passed ${result.total} cases; defective starter rejected (${bad.passed}/${bad.total}).`);
    }
    return;
  }
  if(command==='run'||command==='self-test') {
    const config=await json(flags.config?resolve(flags.config):modelFile).catch(()=>{throw new Error('Cannot read model configuration. Add an alias or supply --config PATH.');});
    const model=validateModel(flags.config?config.model:config.models[positional[0]]);
    if(managedRunId)executionContext={mode:'managed',concurrency:positive(config.executionContext?.concurrency,1,8)};
    const task=command==='self-test'?TASK_IDS[0]:positional[flags.config?0:1];
    if(!TASK_IDS.includes(task)&&!VISUAL_TASK_IDS.has(task))throw new Error('Choose a task from the tasks command.');
    const repeat=positive(flags.repeat,command==='self-test'?1:3,20);
    const requestedWall=positive(flags['wall-seconds'],command==='self-test'?60:1800,2700);
    const limits={wallSeconds:requestedWall,maxRequests:positive(flags['max-requests'],40,200),maxEstimatedUsd:Number(flags['max-estimated-usd']??5)};
    if(!Number.isFinite(limits.maxEstimatedUsd)||limits.maxEstimatedUsd<=0||limits.maxEstimatedUsd>100)throw new Error('Estimated cost limit must be >0 and <=100 USD.');
    if(command==='run'&&!flags.execute){console.log(JSON.stringify({mode:'plan-only',model,task,repeat,limits,note:'Add --execute to make model calls. Per-trial limits; inference may consume credits or subscription quota.'},null,2));return;}
    const lease=flags.invocation?await validateRunLock(local,flags.invocation):await acquireRunLock(local);
    try {
      const results=[];
      for(let i=0;i<repeat;i++){
        if(abort.signal.aborted){process.exitCode=1;break;}
        const result=await executeTrial(model,task,limits,{selfTest:command==='self-test',progress:flags.progress===true,progressJson:flags['progress-json']===true,attempt:i+1,repeat});results.push(result);
        if(!['passed','failed','needs_visual_review','self_test_passed','missing_or_invalid_submission'].includes(result.status))break;
      }
      if(results.some(r=>!['passed','failed','needs_visual_review','self_test_passed','missing_or_invalid_submission'].includes(r.status)))process.exitCode=1;
    } finally {if(!flags.invocation)await releaseRunLock(local,lease.id);}
    return;
  }
  throw new Error('Unknown command. Use help.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
