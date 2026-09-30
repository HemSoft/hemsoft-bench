import { isDeepStrictEqual } from 'node:util';
import { authorityCases, authorityReference } from './authority-task.mjs';

export const AUTHORITY_TASK_ID = 'authority-ledger';
export const TASK_IDS = [AUTHORITY_TASK_ID];
export const TASK_VERSION = '1';

export function taskCases(id) {
  if (id !== AUTHORITY_TASK_ID) throw new Error('Unknown task.');
  return authorityCases();
}

export function expectedAnswers(id,cases=taskCases(id)) {
  if (id !== AUTHORITY_TASK_ID) throw new Error('Unknown task.');
  return cases.map(authorityReference);
}

export function scoreAnswers(expected,actual) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return {passed:0,total:expected.length,success:false,formatError:'Expected one answer per case.'};
  }
  // JSON has no meaningful distinction between numeric -0 and 0.
  const normalized=JSON.parse(JSON.stringify(actual));
  const passed=expected.filter((answer,i)=>isDeepStrictEqual(answer,normalized[i])).length;
  return {passed,total:expected.length,success:passed===expected.length};
}
