import {readFile,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {TRACE_LIMIT,summarizeDiagnostics} from './transport-diagnostics.mjs';

export async function diagnoseStream(resultFile) {
 const file=resolve(resultFile);
 if((await stat(file)).size>4*1024*1024)throw new Error('Result file exceeds diagnostic read limit.');
 const result=JSON.parse(await readFile(file,'utf8'));
 const trace=join(dirname(file),'transport.jsonl');
 let text;
 try{
  if((await stat(trace)).size>TRACE_LIMIT+4096)throw new Error('Trace exceeds diagnostic read limit.');
  text=await readFile(trace,'utf8');
 }catch(error){
  if(error.code!=='ENOENT')throw error;
  return {available:false,reason:"No transport trace. The failure's origin cannot be determined from interpreted Pi events alone."};
 }
 const records=[];let malformedRecords=0;
 for(const line of text.split('\n').filter(s=>s.trim())){
  try{const record=JSON.parse(line);if(!record||typeof record.event!=='string')throw new Error();records.push(record);}catch{malformedRecords++;}
 }
 const summary=summarizeDiagnostics(records);
 const missingAdapterRecords=Math.max(0,(result.metrics?.assistantTurns??0)-summary.adapterResponses);
 const stopReasons=new Set(['timeout','aborted','request_limit','estimated_cost_limit','output_limit','output_observer_error']);
 return {available:records.some(r=>r.event==='capture_installed'),runStop:stopReasons.has(result.status)?result.status:null,malformedRecords,missingAdapterRecords,...summary,captureLimited:summary.captureLimited||malformedRecords>0||missingAdapterRecords>0,note:'Fetch-level observations, not packet capture. Missing end records can mean process termination or lost diagnostics. Normal HTTP EOF cannot identify which upstream component ended the response.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==3){console.error('Usage: node src/diagnose-stream.mjs PATH/TO/result.json');process.exitCode=1;}
 else diagnoseStream(process.argv[2]).then(result=>console.log(JSON.stringify(result,null,2))).catch(()=>{console.error('Could not read stream diagnostics. Check the path, file sizes and JSON validity.');process.exitCode=1;});
}
