import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Sandbox} from '../src/sandbox.mjs';
import {checked} from '../src/process.mjs';
const {image}=JSON.parse(await readFile(new URL('../.local/runtime.json',import.meta.url),'utf8'));

test('real Docker sandbox isolates state, credentials, network, and tool paths',async()=>{
  process.env.HB_HOST_SECRET='fake-host-canary-never-forward';
  const box=await new Sandbox(image).start();
  try {
    const [info]=JSON.parse(await checked('docker',['inspect',box.name]));
    assert.equal(info.HostConfig.NetworkMode,'none');assert.equal(info.HostConfig.ReadonlyRootfs,true);
    assert.equal(info.Config.User,'1000:1000');assert.equal(info.Mounts.length,0);
    assert.equal(info.HostConfig.Privileged,false);assert.ok(info.HostConfig.CapDrop.includes('ALL'));
    await box.file('write',{path:'data.txt',content:'original\nsecond\n'});
    await box.file('edit',{path:'data.txt',edits:[{oldText:'original',newText:'changed'},{oldText:'second',newText:'next'}]});
    assert.equal(await box.file('read',{path:'data.txt',offset:2,limit:1}),'next\n');
    await assert.rejects(box.file('edit',{path:'data.txt',edits:[{oldText:'missing',newText:'x'}]}));
    await assert.rejects(box.file('read',{path:'/etc/hostname'}));
    await box.bash('ln -s /etc/hostname /workspace/outside');
    await assert.rejects(box.file('read',{path:'outside'}));
    const output=await box.bash(`python -I -c "import os,socket; assert 'HB_HOST_SECRET' not in os.environ; assert 'OPENCODE_API_KEY' not in os.environ; assert 'OPENROUTER_API_KEY' not in os.environ; s=socket.socket(); s.settimeout(1); code=s.connect_ex(('1.1.1.1',443)); assert code != 0; print('isolation-ok')"`);
    assert.ok(output.includes('isolation-ok'));assert.ok(output.includes('exit code 0'));
    const timed=await box.bash('sleep 5',1);assert.ok(timed.includes('exit code 124'));
    const bounded=await box.bash(`python -c "print('x'*100000)"`);
    assert.ok(bounded.includes('truncated'));assert.ok(bounded.length<51000);
    await box.bash('ln -s /etc/hostname /workspace/solution.py');
    await assert.rejects(box.submission());
    await box.bash('rm solution.py; mkfifo solution.py');
    await assert.rejects(box.submission()); // A FIFO must not block artifact capture.
    await box.bash(`rm solution.py; python -c "open('solution.py','wb').write(b'x'*1048577)"`);
    await assert.rejects(box.submission());
    await box.bash(`python -c "open('solution.py','wb').write(b'x'*1048576)"`);
    assert.equal((await box.submission()).length,1048576);
  } finally {await box.dispose();delete process.env.HB_HOST_SECRET;}
  const clean=await new Sandbox(image).start();
  try {await assert.rejects(clean.file('read',{path:'data.txt'}));}
  finally {await clean.dispose();}
});
