import json
import sys
from collections import defaultdict, deque


def active_versions(case, known, effective):
    latest = {}
    for version in case['versions']:
        if version['recorded'] > known:
            continue
        previous = latest.get(version['fact'])
        if previous is None or (version['recorded'], version['id']) > (previous['recorded'], previous['id']):
            latest[version['fact']] = version
    return [
        version for version in latest.values()
        if version['payload'] is not None
        and version['valid'][0] <= effective
        and (version['valid'][1] is None or effective < version['valid'][1])
    ]


def membership_paths(memberships, subject):
    edges = defaultdict(set)
    for version in memberships:
        payload = version['payload']
        edges[payload['member']].add(payload['group'])
    paths = {subject: (subject,)}
    pending = deque([subject])
    while pending:
        member = pending.popleft()
        for group in sorted(edges[member]):
            candidate = paths[member] + (group,)
            previous = paths.get(group)
            if previous is None or (len(candidate), candidate) < (len(previous), previous):
                paths[group] = candidate
                pending.append(group)
    return paths


def resource_distances(resources, leaf):
    parents = {resource['id']: resource['parent'] for resource in resources}
    distances = {}
    current = leaf
    while current is not None:
        distances[current] = len(distances)
        current = parents[current]
    return distances


def authorize(rules, resources, memberships):
    states = {rule['id']: {} for rule in rules}
    membership_cache = {}
    resource_cache = {}
    for rule in rules:
        payload = rule['payload']
        if payload['issuer'] == 'ROOT':
            states[rule['id']][payload['delegate']] = (rule['id'],)
    changed = True
    while changed:
        changed = False
        for child in rules:
            child_payload = child['payload']
            if child_payload['issuer'] == 'ROOT':
                continue
            issuer = child_payload['issuer']
            issuer_paths = membership_cache.setdefault(issuer, membership_paths(memberships, issuer))
            ancestors = resource_cache.setdefault(child_payload['resource'], resource_distances(resources, child_payload['resource']))
            for parent in rules:
                parent_payload = parent['payload']
                if parent_payload['effect'] != 'allow':
                    continue
                if parent_payload['subject'] not in issuer_paths or parent_payload['resource'] not in ancestors:
                    continue
                if parent_payload['action'] != '*' and parent_payload['action'] != child_payload['action']:
                    continue
                for remaining, proof in list(states[parent['id']].items()):
                    if remaining < 1 or child['id'] in proof:
                        continue
                    child_remaining = min(child_payload['delegate'], remaining - 1)
                    candidate = proof + (child['id'],)
                    previous = states[child['id']].get(child_remaining)
                    if previous is None or (len(candidate), candidate) < (len(previous), previous):
                        states[child['id']][child_remaining] = candidate
                        changed = True
    return states


def solve_case(case):
    answers = []
    for query in case['queries']:
        active = active_versions(case, query['known'], query['at'])
        memberships = [version for version in active if version['payload']['kind'] == 'member']
        rules = [version for version in active if version['payload']['kind'] == 'rule']
        subject_paths = membership_paths(memberships, query['subject'])
        ancestors = resource_distances(case['resources'], query['resource'])
        states = authorize(rules, case['resources'], memberships)
        candidates = []
        for rule in rules:
            payload = rule['payload']
            if not states[rule['id']] or payload['subject'] not in subject_paths or payload['resource'] not in ancestors:
                continue
            if payload['action'] != '*' and payload['action'] != query['action']:
                continue
            proof = min(states[rule['id']].values(), key=lambda value: (len(value), value))
            subject_path = subject_paths[payload['subject']]
            rank = (
                ancestors[payload['resource']],
                len(subject_path) - 1,
                1 if payload['action'] == '*' else 0,
                0 if payload['effect'] == 'deny' else 1,
                len(proof),
                proof,
                subject_path,
                rule['id'],
            )
            candidates.append((rank, rule, proof, subject_path))
        if not candidates:
            answers.append({'decision': 'deny', 'rule': None, 'authority': [], 'subjectPath': []})
            continue
        _, rule, proof, subject_path = min(candidates, key=lambda item: item[0])
        answers.append({
            'decision': rule['payload']['effect'],
            'rule': rule['id'],
            'authority': list(proof),
            'subjectPath': list(subject_path),
        })
    return answers


def main():
    payload = json.load(sys.stdin)
    print(json.dumps([solve_case(case) for case in payload['cases']], separators=(',', ':')))


if __name__ == '__main__':
    main()
