export const TOOL_NAMES = ['sandbox_read', 'sandbox_write', 'sandbox_edit', 'sandbox_bash'];
export const SYSTEM_PROMPT = `You are a coding assistant. Complete the user's task in /workspace.
Use sandbox_read to inspect files, sandbox_write or sandbox_edit to change them, and sandbox_bash to run commands.
All tools operate in a disposable Linux environment. Python 3.12 and its standard library are available. Network access is disabled. No external packages are needed.
Read TASK.md, implement the requested program, and test it. Do not ask for clarification; the task specification defines the required behavior. Leave the final deliverable at the specified path and summarize what you did.`;

export function validateModel(config) {
  if (!config || !/^[a-z0-9][a-z0-9_-]*$/i.test(config.provider ?? '')) throw new Error('An exact Pi provider is required.');
  if (typeof config.model !== 'string' || !config.model || config.model.startsWith('-') || /[\s*?\[\]]/.test(config.model) || /:(off|minimal|low|medium|high|xhigh|max)$/.test(config.model)) throw new Error('Use an exact model ID, without a thinking suffix or wildcard.');
  if (!['off','minimal','low','medium','high','xhigh','max'].includes(config.thinking)) throw new Error('Explicit Pi thinking level required.');
  return config;
}

export function executionPolicy(model) {
  return {version:4,transport:model.provider === 'openai-codex' ? 'sse' : 'auto',agentRetries:2,retryScope:'consecutive-errors',retryBaseDelayMs:2000,retryMaxDelayMs:5000,providerRetries:0,openRouterFinishErrorRetry:true,interruptedSubmission:'capture-and-grade'};
}

export function isolatedPiSettings(model) {
  const policy=executionPolicy(model);
  return {packages:[],extensions:[],skills:[],prompts:[],themes:[],transport:policy.transport,
    compaction:{enabled:false},retry:{enabled:policy.agentRetries>0,maxRetries:policy.agentRetries,baseDelayMs:policy.retryBaseDelayMs,maxAgentDelayMs:policy.retryMaxDelayMs,provider:{maxRetries:policy.providerRetries}},enableSkillCommands:false};
}

export function piArgs(config, extension) {
  validateModel(config);
  return ['--mode', 'json', '--print', '--offline', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--no-builtin-tools', '--tools', TOOL_NAMES.join(','), '--extension', extension,
    '--approve', '--provider', config.provider, '--model', config.model, '--thinking', config.thinking,
    '--system-prompt', SYSTEM_PROMPT];
}

export function containerArgs(name, image) {
  if (!/^hb-[a-z0-9-]+$/.test(name)) throw new Error('Invalid managed container name.');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('A locally resolved immutable image ID is required. Run setup.');
  return ['run', '-d', '--name', name, '--label=hemsoft-bench.managed=true', '--pull=never',
    '--hostname=workspace', '--network=none', '--read-only', '--user=1000:1000',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
    '--memory=256m', '--memory-swap=256m', '--cpus=1', '--init',
    '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=0700',
    '--workdir=/workspace', image, 'sleep', 'infinity'];
}

export function summarizeRuns(results) {
  const groups = new Map();
  for (const result of results.filter(r => !r.selfTest)) {
    // Never silently pool different task sets, runners, budgets, or environments.
    const identity = {executionPolicy:result.executionPolicy??null,executionContext:result.executionContext??{mode:'legacy',concurrency:1},task:result.task, taskVersion:result.taskVersion, model:result.model, image:result.image, piVersion:result.piVersion, limits:result.limits, fingerprints:result.fingerprints};
    const key = JSON.stringify(identity);
    if (!groups.has(key)) groups.set(key, { ...identity, attempts:0, fullPasses:0, recoveredGraded:0, recoveredFullPasses:0, statuses:{}, estimatedCostUsd:0, costComplete:true });
    const row = groups.get(key);
    row.attempts++;
    row.fullPasses += result.status === 'passed' ? 1 : 0;
    row.recoveredGraded += result.recovery?.state === 'graded' ? 1 : 0;
    row.recoveredFullPasses += result.recovery?.state === 'graded' && result.recovery.grade?.success === true ? 1 : 0;
    row.statuses[result.status] = (row.statuses[result.status] ?? 0) + 1;
    if (['passed','failed','missing_or_invalid_submission'].includes(result.status) && result.metrics?.usageComplete !== false && typeof result.metrics?.estimatedCostUsd === 'number') row.estimatedCostUsd += result.metrics.estimatedCostUsd;
    else row.costComplete = false;
  }
  return [...groups.values()].map(row => ({...row, estimatedCostUsd:row.costComplete?row.estimatedCostUsd:null}));
}

export function summarizeEvents(events, {interrupted=false}={}) {
  let assistantOpen = false;
  for (const event of events) {
    if (event.type === 'message_start' && event.message?.role === 'assistant') assistantOpen = true;
    if (event.type === 'message_end' && event.message?.role === 'assistant') assistantOpen = false;
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const assistants = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message);
  let cost = 0;
  let costsKnown = assistants.length > 0;
  for (const m of assistants) {
    for (const key of ['input','output','cacheRead','cacheWrite']) usage[key] += Number.isFinite(m.usage?.[key]) ? m.usage[key] : 0;
    if (Number.isFinite(m.usage?.cost?.total)) cost += m.usage.cost.total;
    else costsKnown = false;
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const last = assistants.at(-1);
  const completed = !interrupted && !assistantOpen && last?.stopReason === 'stop';
  const errorHistory = assistants.filter(m => ['error','aborted'].includes(m.stopReason)).map(m => m.errorMessage ?? m.stopReason);
  let pendingErrors=[];
  const recoveredErrors=[];
  for (const message of assistants) {
    if (['error','aborted'].includes(message.stopReason)) pendingErrors.push(message.errorMessage??message.stopReason);
    else if (['stop','toolUse','length'].includes(message.stopReason)) { recoveredErrors.push(...pendingErrors); pendingErrors=[]; }
  }
  // A subsequent successful retry does not recover usage missing from a broken stream.
  const usageComplete = completed && errorHistory.length === 0 && assistants.every(m => ['input','output','cacheRead','cacheWrite'].every(key => Number.isFinite(m.usage?.[key])));
  return {
    assistantTurns: assistants.length,
    toolCalls: events.filter(e => e.type === 'tool_execution_start').length,
    usage, usageComplete,
    reportedEstimatedCostUsd: assistants.length > 0 ? cost : null,
    estimatedCostUsd: usageComplete && costsKnown ? cost : null,
    completed,
    providerErrors: [...new Set(pendingErrors)],
    recoveredProviderErrors: recoveredErrors,
    retryCount: events.filter(e => e.type === 'auto_retry_start').length,
    finalText: (last?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'),
  };
}
