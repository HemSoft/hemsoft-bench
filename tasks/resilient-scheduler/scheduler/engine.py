from .model import TERMINAL, make_job, public_state
from . import replay


class Engine:
    """Deterministic scheduler state machine.

    The public surface is deliberately narrow: advance to an operation's time,
    apply it, checkpoint/restore when asked, and finish the scenario.
    """

    def __init__(self, workers, until=0):
        self.workers = {
            worker['id']: {
                **worker,
                'labels': set(worker.get('labels', [])),
                'usedCpu': 0,
                'usedMemory': 0,
                'up': True,
            }
            for worker in workers
        }
        self.until = until
        self.now = 0
        self.jobs = {}
        self.keys = {}
        self.effects = set()
        self.timeline = []

    def emit(self, at, kind, job, **extra):
        self.timeline.append({'at': at, 'event': kind, 'job': job['id'], **extra})

    def release(self, job):
        if job['worker']:
            worker = self.workers.get(job['worker'])
            if worker:
                worker['usedCpu'] -= job['cpu']
                worker['usedMemory'] -= job['memory']
        job['worker'] = job['token'] = job['leaseUntil'] = None

    def propagate(self, at):
        changed = True
        while changed:
            changed = False
            for job in self.jobs.values():
                if job['status'] != 'pending':
                    continue
                failed = next((dependency for dependency in job['requires']
                               if dependency in self.jobs and
                               self.jobs[dependency]['status'] in {'failed', 'blocked'}), None)
                if failed is not None:
                    job['status'] = 'blocked'
                    self.emit(at, 'blocked', job, dependency=failed)
                    changed = True

    def worker_for(self, job):
        for worker in self.workers.values():
            if not worker['up'] or not job['labels'].issubset(worker['labels']):
                continue
            if worker['cpu'] - worker['usedCpu'] < job['cpu']:
                continue
            if worker['memory'] - worker['usedMemory'] < job['memory']:
                continue
            return worker
        return None

    def can_run(self, job, at):
        return (job['status'] == 'pending' and job['readyAt'] <= at and
                all(self.jobs.get(dep, {}).get('status') == 'succeeded'
                    for dep in job['requires']))

    def dispatch(self, at):
        while True:
            ready = [job for job in self.jobs.values() if self.can_run(job, at)]
            ready.sort(key=lambda job: (-job['priority'], job['submitted'], job['id']))
            selected = None
            for job in ready:
                worker = self.worker_for(job)
                if worker:
                    selected = job, worker
                    break
            if not selected:
                return
            job, worker = selected
            job['status'] = 'running'
            job['attempts'] += 1
            job['worker'] = worker['id']
            job['token'] = f"{job['id']}:{job['attempts']}"
            job['leaseUntil'] = at + job['lease']
            worker['usedCpu'] += job['cpu']
            worker['usedMemory'] += job['memory']
            self.emit(at, 'started', job, worker=worker['id'],
                      attempt=job['attempts'], token=job['token'],
                      leaseUntil=job['leaseUntil'])

    def retry(self, job, at, reason):
        attempt = job['attempts']
        self.release(job)
        if attempt >= job['maxAttempts']:
            job['status'] = 'failed'
            self.emit(at, 'failed', job, attempt=attempt, reason=reason)
        else:
            job['status'] = 'pending'
            job['readyAt'] = at + job['backoff'] * attempt
            self.emit(at, 'retry', job, attempt=attempt, reason=reason,
                      readyAt=job['readyAt'])

    def next_internal(self, target):
        values = []
        for job in self.jobs.values():
            if job['status'] == 'running':
                values.append(job['leaseUntil'])
            if job['status'] == 'pending' and job['readyAt'] > self.now:
                values.append(job['readyAt'])
        value = min(values, default=10**30)
        return value if value <= target else None

    def advance(self, target):
        while (at := self.next_internal(target)) is not None:
            self.now = at
            expired = sorted((job for job in self.jobs.values()
                              if job['status'] == 'running' and job['leaseUntil'] <= at),
                             key=lambda job: job['id'])
            for job in expired:
                self.retry(job, at, 'lease')
            self.propagate(at)
            self.dispatch(at)
        self.now = target

    def submit(self, spec, at):
        if spec['id'] in self.jobs or spec.get('key') and spec['key'] in self.keys:
            return
        job = make_job(spec, at)
        self.jobs[job['id']] = job
        if job['key']:
            self.keys[job['key']] = job['id']

    def apply(self, operation):
        at, kind = operation['at'], operation['type']
        if kind == 'submit':
            self.submit(operation['job'], at)
            return
        if kind in {'workerDown', 'workerUp'}:
            if operation['worker'] in self.workers:
                self.workers[operation['worker']]['up'] = kind == 'workerUp'
            return
        job = self.jobs.get(operation.get('job'))
        if not job:
            return
        if kind == 'cancel' and job['status'] not in TERMINAL:
            if job['status'] == 'running':
                self.release(job)
            job['status'] = 'cancelled'
            self.emit(at, 'cancelled', job)
            return
        if kind == 'heartbeat' and job['status'] == 'running':
            job['leaseUntil'] = at + job['lease']
            self.emit(at, 'heartbeat', job, token=job['token'],
                      leaseUntil=job['leaseUntil'])
            return
        if kind in {'finish', 'fail'} and job['status'] == 'running':
            attempt = job['attempts']
            if kind == 'fail':
                self.retry(job, at, 'failure')
            else:
                self.release(job)
                job['status'] = 'succeeded'
                if job['effect']:
                    self.effects.add(job['effect'])
                self.emit(at, 'succeeded', job, attempt=attempt)

    def snapshot(self):
        return replay.encode(self)

    @classmethod
    def restore(cls, state):
        return replay.decode(cls, state)

    def finish(self):
        self.advance(self.until)
        for job in self.jobs.values():
            possible = any(job['labels'].issubset(worker['labels']) and
                           worker['cpu'] >= job['cpu'] and
                           worker['memory'] >= job['memory']
                           for worker in self.workers.values())
            missing = next((dep for dep in job['requires'] if dep not in self.jobs), None)
            if job['status'] == 'pending' and (not possible or missing is not None):
                job['status'] = 'blocked'
                self.emit(self.now, 'blocked', job, dependency=missing)
        self.propagate(self.now)
        self.dispatch(self.now)
        return {
            'timeline': self.timeline,
            'jobs': sorted((public_state(job) for job in self.jobs.values()),
                           key=lambda item: item['id']),
            'effects': sorted(self.effects),
        }
