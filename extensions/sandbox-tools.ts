import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Sandbox } from '../src/sandbox.mjs';
import { TOOL_NAMES, SYSTEM_PROMPT } from '../src/core.mjs';
import { installOpenRouterFinishErrorRetry } from '../src/openrouter-retry.mjs';
import { recordDiagnostic, adapterErrorClass, installTransportDiagnostics } from '../src/transport-diagnostics.mjs';

export default function (pi: ExtensionAPI) {
  const specPath = process.env.HB_RUN_SPEC;
  if (!specPath) throw new Error('HB_RUN_SPEC is required; no tools registered.');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (!/^hb-[a-z0-9-]+$/.test(spec.container)) throw new Error('Invalid sandbox identity.');
  const sandbox = new Sandbox(spec.image, spec.container);
  let requests = 0;
  let estimatedCost = 0;
  let queue = Promise.resolve();
  const registered = new Map<string, any>();
  const register = (tool: any) => { registered.set(tool.name, tool); pi.registerTool(tool); };
  const record = (value: object) => writeFileSync(spec.statePath, JSON.stringify(value, null, 2));
  const fatal = (reason: string) => {
    recordDiagnostic('request_blocked',{reason:['timeout','aborted','request_limit','estimated_cost_limit','output_limit','output_observer_error'].includes(reason)?reason:'configuration_error'});
    record({status:'blocked', reason, requests, estimatedCost}); process.exit(3);
  };
  // Serialize all tools: a shell mutation cannot race an edit or artifact read.
  const execute = (fn: (params: any, signal: AbortSignal | undefined) => Promise<string>) =>
    async (_id: string, params: any, signal: AbortSignal | undefined) => {
      const job = queue.then(() => fn(params, signal));
      queue = job.then(() => {}, () => {});
      return {content:[{type:'text' as const,text:await job}], details:{}};
    };

  register({name:'sandbox_read',label:'Read',description:'Read UTF-8 files in /workspace. Output is limited to 2000 lines and 50 KB; use offset and limit to continue.',
    parameters:Type.Object({path:Type.String(),offset:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:2000}))}),
    execute:execute((p,s)=>sandbox.file('read',p,s))});
  register({name:'sandbox_write',label:'Write',description:'Create or replace a UTF-8 file in /workspace, at most 1 MiB.',
    parameters:Type.Object({path:Type.String(),content:Type.String()}),execute:execute((p,s)=>sandbox.file('write',p,s))});
  register({name:'sandbox_edit',label:'Edit',description:'Apply unique exact replacements against the original file. Edits must not overlap.',
    parameters:Type.Object({path:Type.String(),edits:Type.Array(Type.Object({oldText:Type.String(),newText:Type.String()}),{minItems:1,maxItems:20})}),
    execute:execute((p,s)=>sandbox.file('edit',p,s))});
  register({name:'sandbox_bash',label:'Bash',description:'Run bash in the isolated Linux workspace. No network, host filesystem, credentials, or external packages. Maximum 60 seconds per command, last 50 KB of output returned.',
    parameters:Type.Object({command:Type.String(),timeout:Type.Optional(Type.Number({minimum:1,maximum:60}))}),execute:execute((p,s)=>sandbox.bash(p.command,p.timeout??30,s))});

  pi.on('session_start', async (_event,ctx) => {
    pi.setActiveTools(TOOL_NAMES);
    if (pi.getActiveTools().slice().sort().join(',') !== TOOL_NAMES.slice().sort().join(',')) fatal('Unexpected active tool set');
    if (ctx.model?.provider !== spec.provider || ctx.model?.id !== spec.model) fatal('Pi did not select the exact requested provider/model');
    if (ctx.thinkingLevel !== spec.thinking) fatal(`Thinking setting mismatch: requested ${spec.thinking}, context ${ctx.thinkingLevel}, Pi accessor ${pi.getThinkingLevel()}`);
    record({status:'ready', provider:ctx.model?.provider, model:ctx.model?.id, thinking:ctx.thinkingLevel, tools:pi.getActiveTools()});
  });
  pi.on('before_agent_start', () => {
    installTransportDiagnostics();
    installOpenRouterFinishErrorRetry(spec.provider,()=>recordDiagnostic('openrouter_finish_error_normalized',{request:requests}));
    return {systemPrompt:SYSTEM_PROMPT};
  });
  pi.on('cache_warming_decision', () => ({action:'stop' as const}));
  pi.on('before_provider_request', () => {
    if (spec.selfTest) fatal('Self-test attempted a provider request');
    // Parent-side termination can take seconds on Windows. Do not start another
    // paid request while taskkill is still traversing the process tree.
    if (spec.stopPath && existsSync(spec.stopPath)) fatal(readFileSync(spec.stopPath,'utf8'));
    if (spec.cancelPath && existsSync(spec.cancelPath)) fatal('aborted');
    if (!Number.isSafeInteger(spec.deadlineAt)) fatal('invalid_deadline');
    if (Date.now() >= spec.deadlineAt) fatal('timeout');
    if (++requests > spec.maxRequests) fatal('request_limit');
    if (estimatedCost >= spec.maxEstimatedUsd) fatal('estimated_cost_limit');
    process.env.HB_PROVIDER_REQUEST=String(requests);
    recordDiagnostic('provider_request_allowed',{request:requests,remainingMs:Math.max(0,spec.deadlineAt-Date.now())});
  });
  pi.on('message_end', event => {
    if (event.message.role === 'assistant') {
      estimatedCost += event.message.usage?.cost?.total ?? 0;
      recordDiagnostic('adapter_end',{request:requests,stopReason:['stop','length','toolUse','error','aborted'].includes(event.message.stopReason)?event.message.stopReason:'other',errorClass:adapterErrorClass(event.message.errorMessage)});
    }
  });
  pi.on('input', async () => {
    if (!spec.selfTest) return;
    // An offline smoke test exercises the actual registered tools, without inference.
    const call = async (name: string, params: object) => registered.get(name).execute('self-test', params, undefined);
    await call('sandbox_write',{path:'probe.txt',content:'isolated'});
    await call('sandbox_edit',{path:'probe.txt',edits:[{oldText:'isolated',newText:'verified'}]});
    const result = await call('sandbox_read',{path:'probe.txt'});
    if (result.content[0].text !== 'verified') fatal('Sandbox file-tool smoke test failed');
    const command = await call('sandbox_bash',{command:"python -I -c \"import os; assert 'HB_HOST_SECRET' not in os.environ; print('terminal-ok')\""});
    if (!command.content[0].text.includes('terminal-ok')) fatal('Sandbox terminal smoke test failed');
    record({status:'self_test_passed',tools:pi.getActiveTools(),modelCalls:0});
    return {action:'handled' as const};
  });
}
