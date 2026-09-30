import json
import sys
from collections import defaultdict, deque


def lexical_path(candidate, current):
    """Return True when candidate is the preferred shortest, lexical path."""
    return current is None or (len(candidate), tuple(candidate)) < (len(current), tuple(current))


def resource_ancestors(resources, resource):
    """Return {resource_id: distance} from a leaf through the root."""
    parents = {item['id']: item['parent'] for item in resources}
    result = {}
    current = resource
    while current is not None:
        result[current] = len(result)
        current = parents[current]
    return result


def solve_case(case):
    """Return one decision object per query. Implement the ledger semantics here."""
    raise NotImplementedError('complete solve_case')


def main():
    payload = json.load(sys.stdin)
    print(json.dumps([solve_case(case) for case in payload['cases']], separators=(',', ':')))


if __name__ == '__main__':
    main()
