TERMINAL = {'succeeded', 'failed', 'cancelled', 'blocked'}


def make_job(spec, at):
    resources = spec.get('resources', {})
    return {
        'id': spec['id'],
        'key': spec.get('key'),
        'submitted': at,
        'priority': spec.get('priority', 0),
        'cpu': resources.get('cpu', 1),
        'memory': resources.get('memory', 1),
        'labels': set(spec.get('labels', [])),
        'requires': list(spec.get('requires', [])),
        'mutex': spec.get('mutex'),
        'maxAttempts': spec.get('maxAttempts', 1),
        'backoff': spec.get('backoff', 1),
        'lease': spec.get('lease', 10),
        'aging': spec.get('aging', 10),
        'effect': spec.get('effect'),
        'status': 'pending',
        'attempts': 0,
        'readyAt': at,
        'worker': None,
        'token': None,
        'leaseUntil': None,
    }


def public_state(job):
    return {'id': job['id'], 'status': job['status'], 'attempts': job['attempts']}
