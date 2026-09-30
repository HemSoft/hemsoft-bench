import json
import sys

sys.path.insert(0, '/workspace')
from scheduler.engine import Engine


def solve(case):
    engine = Engine(case.get('workers', []), case.get('until', 0))
    operations = case.get('operations', [])
    checkpoint = case.get('checkpoint')
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


payload = json.load(sys.stdin)
answers = [solve(case) for case in payload['cases']]
print(json.dumps(answers, separators=(',', ':')))
