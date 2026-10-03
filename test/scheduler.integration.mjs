import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gradeScheduler} from '../src/scheduler-task.mjs';

// A correct Engine is still correct when JSON object fields are emitted in a
// different order. Contractually significant event and array order is preserved.
test('real scheduler grading ignores JSON object key order',async()=>{
 const {image}=JSON.parse(await readFile(new URL('../.local/runtime.json',import.meta.url),'utf8'));
 const reference=await readFile(new URL('../references/resilient-scheduler.py',import.meta.url),'utf8');
 const engine=reference+`

def reverse_fields(value):
    if isinstance(value, dict):
        return {key: reverse_fields(value[key]) for key in reversed(value)}
    if isinstance(value, list):
        return [reverse_fields(item) for item in value]
    return value

class Engine(Engine):
    def finish(self):
        return reverse_fields(super().finish())
`;
 const grade=await gradeScheduler(image,{
  'scheduler/engine.py':engine,
  'scheduler/model.py':'# Unused by the independent Engine.\n',
  'scheduler/replay.py':'# Unused by the independent Engine.\n',
 });
 assert.deepEqual(grade,{passed:72,total:72,success:true});
});

test('real grading still rejects premature dispatch at external-operation boundaries',async()=>{
 const {image}=JSON.parse(await readFile(new URL('../.local/runtime.json',import.meta.url),'utf8'));
 const reference=await readFile(new URL('../references/resilient-scheduler.py',import.meta.url),'utf8');
 const old='if t<target:self.propagate(t);self.dispatch(t)';
 assert.ok(reference.includes(old));
 const engine=reference.replace(old,'self.propagate(t);self.dispatch(t)');
 const grade=await gradeScheduler(image,{
  'scheduler/engine.py':engine,
  'scheduler/model.py':'# Unused by the independent Engine.\n',
  'scheduler/replay.py':'# Unused by the independent Engine.\n',
 });
 assert.ok(grade.passed>0&&grade.passed<72,JSON.stringify(grade));
 assert.equal(grade.success,false);
});

test('real grading accepts independent dependency blocks in lexical job order',async()=>{
 const {image}=JSON.parse(await readFile(new URL('../.local/runtime.json',import.meta.url),'utf8'));
 const reference=await readFile(new URL('../references/resilient-scheduler.py',import.meta.url),'utf8');
 // The contract does not prescribe iteration order for dependency propagation.
 // Keep the independent Engine, changing only that traversal order.
 const engine=reference+`

class Engine(Engine):
    def propagate(self, at):
        original = self.jobs
        self.jobs = dict(sorted(original.items()))
        try:
            super().propagate(at)
        finally:
            self.jobs = original
`;
 const grade=await gradeScheduler(image,{
  'scheduler/engine.py':engine,
  'scheduler/model.py':'# Unused by the independent Engine.\n',
  'scheduler/replay.py':'# Unused by the independent Engine.\n',
 });
 assert.deepEqual(grade,{passed:72,total:72,success:true});
});
