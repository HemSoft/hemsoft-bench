import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gradeScheduler} from '../src/scheduler-task.mjs';

// A correct Engine is still correct when JSON object fields are emitted in a
// different order. Arrays retain their contractually significant ordering.
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
