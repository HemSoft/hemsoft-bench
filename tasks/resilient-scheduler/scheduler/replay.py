"""JSON-safe checkpoint support.

The scheduler process may restart between any two operations. This module is
intentionally small because every piece of live state must cross that seam.
"""


def encode(engine):
    workers = [{**worker, 'labels': sorted(worker['labels'])}
               for worker in engine.workers.values()]
    jobs = [{**job, 'labels': sorted(job['labels'])}
            for job in engine.jobs.values()]
    return {
        'workers': workers,
        'until': engine.until,
        'now': engine.now,
        'jobs': jobs,
        'keys': engine.keys,
        'effects': sorted(engine.effects),
        'timeline': engine.timeline,
    }


def decode(engine_type, state):
    # Reconstruct through the normal constructor so worker invariants stay in
    # one place. (A production restart test is failing around this code.)
    engine = engine_type(state['workers'], state['until'])
    engine.now = state['now']
    engine.jobs = {
        job['id']: {**job, 'labels': set(job['labels'])}
        for job in state['jobs']
    }
    engine.keys = dict(state['keys'])
    engine.effects = set()
    engine.timeline = list(state['timeline'])
    return engine
