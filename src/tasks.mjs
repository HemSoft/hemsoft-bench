import {SCHEDULER_TASK_ID,schedulerCases,schedulerAnswers,schedulerAnswerMatches} from './scheduler-task.mjs';

export {SCHEDULER_TASK_ID};
export const TASK_IDS=[SCHEDULER_TASK_ID];
export const TASK_VERSION='1';

export function taskCases(id){
  if(id!==SCHEDULER_TASK_ID)throw new Error('Unknown task.');
  return schedulerCases();
}

export function expectedAnswers(id,cases=taskCases(id)){
  if(id!==SCHEDULER_TASK_ID)throw new Error('Unknown task.');
  return schedulerAnswers(cases);
}

export function scoreAnswers(expected,actual){
  if(!Array.isArray(actual)||actual.length!==expected.length)return {passed:0,total:expected.length,success:false,formatError:'Expected one answer per case.'};
  const normalized=JSON.parse(JSON.stringify(actual));
  const passed=expected.filter((answer,i)=>schedulerAnswerMatches(normalized[i],answer)).length;
  return {passed,total:expected.length,success:passed===expected.length};
}
