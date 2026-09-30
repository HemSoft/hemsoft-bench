import json
import unittest

from scheduler.engine import Engine


def run(case, checkpoint=None):
    engine = Engine(case['workers'], case.get('until', 0))
    operations = case.get('operations', [])
    index = 0
    while index < len(operations):
        at = operations[index]['at']
        engine.advance(at)
        while index < len(operations) and operations[index]['at'] == at:
            engine.apply(operations[index])
            index += 1
            if checkpoint == index:
                state = json.loads(json.dumps(engine.snapshot()))
                engine = Engine.restore(state)
        engine.propagate(at)
        engine.dispatch(at)
    return engine.finish()


def worker(worker_id='w', cpu=4, memory=4, labels=()):
    return {'id': worker_id, 'cpu': cpu, 'memory': memory, 'labels': list(labels)}


def submit(at, job_id, **values):
    job = {'id': job_id, 'resources': {'cpu': 1, 'memory': 1},
           'lease': 5, 'maxAttempts': 2, 'backoff': 2, 'aging': 5}
    job.update(values)
    return {'at': at, 'type': 'submit', 'job': job}


class SchedulerExamples(unittest.TestCase):
    def test_basic_success(self):
        answer = run({'workers': [worker()], 'operations': [
            submit(0, 'a'),
            {'at': 1, 'type': 'finish', 'job': 'a', 'token': 'a:1'},
        ], 'until': 2})
        self.assertEqual(answer['jobs'], [{'id': 'a', 'status': 'succeeded', 'attempts': 1}])
        self.assertEqual([event['event'] for event in answer['timeline']], ['started', 'succeeded'])

    def test_lease_retries_with_exponential_backoff(self):
        answer = run({'workers': [worker()], 'operations': [
            submit(0, 'a', lease=2, maxAttempts=3, backoff=3),
        ], 'until': 15})
        starts = [event['at'] for event in answer['timeline'] if event['event'] == 'started']
        self.assertEqual(starts, [0, 5, 13])

    def test_tightest_worker_is_selected(self):
        answer = run({'workers': [worker('large', 8, 8), worker('tight', 2, 2)],
                      'operations': [submit(0, 'a', resources={'cpu': 2, 'memory': 2})],
                      'until': 1})
        self.assertEqual(answer['timeline'][0]['worker'], 'tight')

    def test_stale_attempt_completion_is_ignored(self):
        answer = run({'workers': [worker()], 'operations': [
            submit(0, 'a', lease=2),
            {'at': 3, 'type': 'finish', 'job': 'a', 'token': 'a:1'},
        ], 'until': 4})
        self.assertEqual(answer['jobs'][0], {'id': 'a', 'status': 'running', 'attempts': 2})

    def test_mutex_serializes_jobs(self):
        answer = run({'workers': [worker(cpu=2, memory=2)], 'operations': [
            submit(0, 'a', mutex='database'), submit(0, 'b', mutex='database'),
        ], 'until': 1})
        self.assertEqual([event['job'] for event in answer['timeline'] if event['event'] == 'started'], ['a'])

    def test_restart_preserves_live_allocations(self):
        answer = run({'workers': [worker(cpu=2, memory=2)], 'operations': [
            submit(0, 'a'), submit(0, 'b'),
            {'at': 1, 'type': 'heartbeat', 'job': 'a', 'token': 'a:1'},
            submit(1, 'c'),
        ], 'until': 2}, checkpoint=3)
        starts = [(event['job'], event['at']) for event in answer['timeline'] if event['event'] == 'started']
        self.assertEqual(starts, [('a', 0), ('b', 0)])

    def test_cycles_are_blocked(self):
        answer = run({'workers': [worker()], 'operations': [
            submit(0, 'a', requires=['b']), submit(0, 'b', requires=['a']),
        ], 'until': 1})
        self.assertEqual([job['status'] for job in answer['jobs']], ['blocked', 'blocked'])

    def test_cancelled_dependency_propagates(self):
        answer = run({'workers': [worker()], 'operations': [
            submit(0, 'a'), submit(0, 'b', requires=['a']),
            {'at': 1, 'type': 'cancel', 'job': 'a'},
        ], 'until': 2})
        self.assertEqual(answer['jobs'][1]['status'], 'blocked')

    def test_priority_ages_while_waiting(self):
        answer = run({'workers': [worker(cpu=1, memory=1)], 'operations': [
            submit(0, 'blocker', priority=9, lease=20),
            submit(0, 'old', priority=0, aging=1),
            submit(4, 'new', priority=3, aging=10),
            {'at': 5, 'type': 'finish', 'job': 'blocker', 'token': 'blocker:1'},
        ], 'until': 6})
        started = [event['job'] for event in answer['timeline'] if event['event'] == 'started']
        self.assertEqual(started, ['blocker', 'old'])


if __name__ == '__main__':
    unittest.main()
