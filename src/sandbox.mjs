import { randomUUID } from 'node:crypto';
import { containerArgs } from './core.mjs';
import { checked, run } from './process.mjs';

// Runs only inside the container. Arguments arrive as JSON over stdin.
const FILE_OPS = String.raw`
import json,sys,pathlib,os
r=json.load(sys.stdin)
p=pathlib.Path(r['path'].removeprefix('@'))
if not p.is_absolute(): p=pathlib.Path('/workspace')/p
p=p.resolve()
if not p.is_relative_to('/workspace'): raise ValueError('File tools only access /workspace')
if r['op']=='read':
    if p.stat().st_size>2*1024*1024: raise ValueError('File exceeds 2 MiB; use bash for bounded inspection')
    lines=p.read_text().splitlines(keepends=True)
    start=r.get('offset',1)-1
    text=''.join(lines[start:start+r.get('limit',2000)])
    data=text.encode()[:50000]
    print(data.decode(errors='replace'),end='')
    if len(text.encode())>50000 or start+r.get('limit',2000)<len(lines): print('\n[Truncated; continue with offset or inspect using bash]')
elif r['op']=='write':
    content=r['content']
    if len(content.encode())>1024*1024: raise ValueError('Write exceeds 1 MiB')
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(content)
    print('Wrote '+str(p))
elif r['op']=='edit':
    if p.stat().st_size>2*1024*1024: raise ValueError('File too large')
    text=p.read_text(); regions=[]
    for e in r['edits']:
        old=e['oldText']
        if not old or text.count(old)!=1: raise ValueError('oldText must match exactly once')
        i=text.index(old); regions.append((i,i+len(old),e['newText']))
    regions.sort()
    if any(a[1]>b[0] for a,b in zip(regions,regions[1:])): raise ValueError('Overlapping edits')
    for start,end,new in reversed(regions): text=text[:start]+new+text[end:]
    p.write_text(text)
    print('Edited '+str(p))
else: raise ValueError('Unknown file operation')
`;

export class Sandbox {
  constructor(image, name = `hb-${randomUUID()}`) { this.image = image; this.name = name; }
  async start() {
    try { await checked('docker', containerArgs(this.name, this.image)); }
    catch (error) { await this.dispose(); throw error; }
    return this;
  }
  async dispose() {
    const result = await run('docker', ['rm', '-f', this.name]);
    if (result.code !== 0 && !result.stderr.includes('No such container')) throw new Error(`Sandbox cleanup failed for ${this.name}: ${result.stderr}`);
  }
  async file(op, params, signal) {
    return checked('docker', ['exec','-i',this.name,'timeout','-k','1','10','python','-I','-c',FILE_OPS], { input: JSON.stringify({ ...params, op }), signal, maxBytes: 128*1024, timeoutMs: 15_000 });
  }
  async bash(command, timeout = 30, signal) {
    if (typeof command !== 'string' || command.length > 30000) throw new Error('Invalid or oversized command.');
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60) throw new Error('Command timeout must be 1 to 60 seconds.');
    const result = await run('docker', ['exec','-i',this.name,'timeout','-k','1',String(timeout),'bash','--noprofile','--norc','-c',command], { signal, timeoutMs: (timeout+5)*1000, maxBytes: 512*1024 });
    const text = result.stdout + result.stderr;
    const bounded = Buffer.from(text).subarray(-50000).toString('utf8');
    if (result.failure) throw new Error(`Command ${result.failure}.\n${bounded}`);
    return `${bounded}${Buffer.byteLength(text)>50000?'\n[Output truncated to last 50 KB]':''}\n[exit code ${result.code}]`;
  }
  async schedulerBundle() {
    const output=await checked('docker',['exec',this.name,'timeout','5','python','-I','-c',
      "import os,stat,json; out={}; paths=['scheduler/model.py','scheduler/engine.py','scheduler/replay.py'];\nfor p in paths:\n q='/workspace/'+p; fd=os.open(q,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and 0<s.st_size<=524288, 'Expected regular '+p+' <=512 KiB'; data=os.read(fd,524289); os.close(fd); assert len(data)<=524288; out[p]=data.decode('utf-8','strict')\nprint(json.dumps(out,separators=(',',':')))"],{maxBytes:2*1024*1024});
    return JSON.parse(output);
  }
  async submission() {
    // Extract only bytes from a regular non-symlink file. Never extract an untrusted tar archive on the host.
    return checked('docker', ['exec',this.name,'timeout','5','python','-I','-c',
      "import os,stat,sys; p='/workspace/solution.py'; fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and s.st_size<=1048576, 'Expected regular solution.py <=1 MiB'; f=os.fdopen(fd,'rb'); data=f.read(1048577); f.close(); assert len(data)<=1048576, 'Submission exceeds 1 MiB'; sys.stdout.buffer.write(data)"], {maxBytes:2*1024*1024});
  }
  async webArtifact() {
    return checked('docker', ['exec',this.name,'timeout','5','python','-I','-c',
      "import os,stat,sys; p='/workspace/world-clock.html'; fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and 0<s.st_size<=2097152, 'Expected regular world-clock.html <=2 MiB'; f=os.fdopen(fd,'rb'); data=f.read(2097153); f.close(); assert len(data)<=2097152, 'HTML exceeds 2 MiB'; data.decode('utf-8','strict'); sys.stdout.buffer.write(data)"], {maxBytes:3*1024*1024});
  }
  async svgArtifact() {
    // Read only this file, without following links or waiting on FIFOs. XML and
    // active-content validation happen on the host before publishing it.
    return checked('docker', ['exec',this.name,'timeout','5','python','-I','-c',
      "import os,stat,sys; p='/workspace/bike.svg'; fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and 0<s.st_size<=1048576, 'Expected regular bike.svg <=1 MiB'; f=os.fdopen(fd,'rb'); data=f.read(1048577); f.close(); assert len(data)<=1048576, 'SVG exceeds 1 MiB'; data.decode('utf-8','strict'); sys.stdout.buffer.write(data)"], {maxBytes:2*1024*1024});
  }
  async evaluate(source, input, {unbounded=false,signal}={}) {
    await this.file('write', {path:'solution.py',content:source},signal);
    const command=unbounded
      ? ['exec','-i',this.name,'python','-I','-B','/workspace/solution.py']
      : ['exec','-i',this.name,'timeout','-k','1','5','python','-I','-B','/workspace/solution.py'];
    return run('docker', command, { input:JSON.stringify(input), timeoutMs:unbounded?null:12_000, maxBytes:2*1024*1024, signal });
  }
}
