import { StringDecoder } from 'node:string_decoder';
import { TOOL_NAMES } from './core.mjs';

// Track metadata only. Never echo model text, reasoning, arguments, or results.
export class Activity {
  constructor(now = Date.now) {
    this.now = now;
    this.started = now();
    this.phase = 'Waiting for model';
    this.lastEventAt = null;
    this.lastModelAt = null;
    this.events = 0;
    this.deltas = 0;
    this.turns = 0;
    this.toolsStarted = 0;
    this.toolsCompleted = 0;
    this.toolErrors = 0;
    this.activeTools = new Map();
    this.lastTool = null;
    this.writesCompleted = 0;
    this.retriesScheduled = 0;
  }
  accept(event) {
    if (!event || typeof event.type !== 'string') return false;
    const now = this.now();
    this.lastEventAt = now;
    this.events++;
    let important = false;
    if (event.type === 'turn_start') this.phase = 'Waiting for model';
    if (event.type === 'message_update') {
      const type = event.assistantMessageEvent?.type;
      this.lastModelAt = now;
      if (type?.endsWith('_delta')) this.deltas++;
      if (type?.startsWith('thinking_')) this.phase = 'Reasoning stream';
      else if (type?.startsWith('text_')) this.phase = 'Response stream';
      else if (type?.startsWith('toolcall_')) this.phase = 'Preparing tool call';
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      this.turns++;
      this.lastModelAt = now;
      this.phase = event.message.stopReason === 'toolUse' ? 'Waiting for tools' : 'Response ended';
      important = true;
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      // An allowlist prevents terminal control characters from untrusted labels.
      const name = TOOL_NAMES.includes(event.toolName) ? event.toolName : 'unknown tool';
      this.lastTool = name;
      if (event.type === 'tool_execution_start') {
        this.toolsStarted++;
        this.activeTools.set(event.toolCallId, name);
        this.phase = `Running ${name}`;
      } else {
        this.toolsCompleted++;
        this.activeTools.delete(event.toolCallId);
        if (event.isError) this.toolErrors++;
        if (!event.isError && ['sandbox_write','sandbox_edit'].includes(name)) this.writesCompleted++;
        this.phase = this.activeTools.size ? 'Running tools' : 'Waiting for model';
      }
      important = true;
    }
    if (event.type === 'agent_end') { this.phase = 'Model finished'; important = true; }
    if (event.type === 'auto_retry_start') { this.retriesScheduled++; this.phase = 'Retrying response'; important = true; }
    if (event.type === 'auto_retry_end') { this.phase = event.success ? 'Response recovered' : 'Recovery stopped'; important = true; }
    return important;
  }
  snapshot() {
    const now = this.now();
    return {
      updatedAt: new Date(now).toISOString(), phase: this.phase,
      executionElapsedSeconds: Math.floor((now - this.started) / 1000),
      secondsSinceEvent: this.lastEventAt === null ? null : Math.floor((now - this.lastEventAt) / 1000),
      secondsSinceModelResponse: this.lastModelAt === null ? null : Math.floor((now - this.lastModelAt) / 1000),
      silenceSeconds: Math.floor((now - (this.lastEventAt ?? this.started)) / 1000),
      retriesScheduled: this.retriesScheduled,
      events: this.events, deltas: this.deltas, completedResponses: this.turns,
      toolsStarted: this.toolsStarted, toolsCompleted: this.toolsCompleted, toolErrors: this.toolErrors,
      activeTools: [...this.activeTools.values()], lastTool: this.lastTool, writesCompleted: this.writesCompleted,
    };
  }
}

export function formatActivity(s, wallSeconds) {
  const age = value => value === null ? 'none yet' : `${value}s ago`;
  return `${s.phase} | ${s.executionElapsedSeconds}/${wallSeconds}s | last event ${age(s.secondsSinceEvent)} | last model ${age(s.secondsSinceModelResponse)} | deltas ${s.deltas} | tools ${s.toolsCompleted}/${s.toolsStarted}, errors ${s.toolErrors} | writes/edits ${s.writesCompleted}` +
    (s.silenceSeconds >= 60 ? ` | QUIET ${s.silenceSeconds}s: no events; not proof of a hang` : '');
}

export function formatCompactActivity(s, wallSeconds) {
  const duration = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const phases = { 'Waiting for model':'Waiting', 'Reasoning stream':'Reasoning', 'Response stream':'Responding', 'Preparing tool call':'Preparing tool', 'Waiting for tools':'Starting tools', 'Response ended':'Response ended', 'Model finished':'Finished' };
  const phase = phases[s.phase] ?? s.phase.replace('Running sandbox_', 'Tool: ');
  const activity = s.silenceSeconds >= 60 ? `QUIET ${s.silenceSeconds}s` : `last event ${s.secondsSinceEvent === null ? 'pending' : `${s.secondsSinceEvent}s`}`;
  return `${phase} | ${duration(s.executionElapsedSeconds)}/${duration(wallSeconds)} | ${activity} | tools ${s.toolsCompleted}/${s.toolsStarted} | edits ${s.writesCompleted}` + (s.toolErrors ? ` | errors ${s.toolErrors}` : '');
}

// LF-only framing and a streaming UTF-8 decoder handle arbitrary pipe chunks.
// Retain at most one bounded partial line, not cumulative response snapshots.
export function eventDecoder(onEvent, maxLineBytes = 32 * 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let malformed = 0;
  const consume = text => {
    pending += text;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      parse(line);
    }
    if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('Event line exceeds telemetry limit');
  };
  const parse = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { malformed++; return; }
    onEvent(event);
  };
  return {
    push(chunk) { consume(decoder.write(chunk)); },
    end() { consume(decoder.end()); parse(pending); pending = ''; return { malformed }; },
  };
}
