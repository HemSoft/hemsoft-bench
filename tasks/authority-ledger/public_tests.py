import unittest

from solution import solve_case


RESOURCES = [
    {'id': 'root', 'parent': None},
    {'id': 'service', 'parent': 'root'},
    {'id': 'database', 'parent': 'service'},
]


def rule(version_id, fact, recorded, issuer, subject, resource, action, effect, delegate=0, valid=None):
    return {
        'id': version_id,
        'fact': fact,
        'recorded': recorded,
        'valid': valid or [0, None],
        'payload': {
            'kind': 'rule',
            'issuer': issuer,
            'subject': subject,
            'resource': resource,
            'action': action,
            'effect': effect,
            'delegate': delegate,
        },
    }


def query(subject='alice', resource='database', action='read', known=100, at=50):
    return {'subject': subject, 'resource': resource, 'action': action, 'known': known, 'at': at}


class PublicLedgerTests(unittest.TestCase):
    def test_default_deny(self):
        case = {'resources': RESOURCES, 'versions': [], 'queries': [query()]}
        self.assertEqual(solve_case(case), [{'decision': 'deny', 'rule': None, 'authority': [], 'subjectPath': []}])

    def test_resource_inheritance(self):
        case = {
            'resources': RESOURCES,
            'versions': [rule('allow-v1', 'allow', 1, 'ROOT', 'alice', 'root', 'read', 'allow')],
            'queries': [query()],
        }
        self.assertEqual(solve_case(case), [{'decision': 'allow', 'rule': 'allow-v1', 'authority': ['allow-v1'], 'subjectPath': ['alice']}])

    def test_late_correction(self):
        case = {
            'resources': RESOURCES,
            'versions': [
                rule('allow-v1', 'policy', 10, 'ROOT', 'alice', 'service', 'read', 'allow'),
                rule('deny-v2', 'policy', 60, 'ROOT', 'alice', 'service', 'read', 'deny'),
            ],
            'queries': [query(known=30), query(known=80)],
        }
        self.assertEqual(solve_case(case), [
            {'decision': 'allow', 'rule': 'allow-v1', 'authority': ['allow-v1'], 'subjectPath': ['alice']},
            {'decision': 'deny', 'rule': 'deny-v2', 'authority': ['deny-v2'], 'subjectPath': ['alice']},
        ])

    def test_nested_membership(self):
        versions = [
            {'id': 'm1', 'fact': 'm1', 'recorded': 1, 'valid': [0, None], 'payload': {'kind': 'member', 'member': 'alice', 'group': 'oncall'}},
            {'id': 'm2', 'fact': 'm2', 'recorded': 1, 'valid': [0, None], 'payload': {'kind': 'member', 'member': 'oncall', 'group': 'engineering'}},
            rule('allow-v1', 'allow', 1, 'ROOT', 'engineering', 'service', 'read', 'allow'),
        ]
        case = {'resources': RESOURCES, 'versions': versions, 'queries': [query()]}
        self.assertEqual(solve_case(case), [{'decision': 'allow', 'rule': 'allow-v1', 'authority': ['allow-v1'], 'subjectPath': ['alice', 'oncall', 'engineering']}])

    def test_specific_allow_beats_broad_deny(self):
        versions = [
            rule('deny-v1', 'deny', 1, 'ROOT', 'alice', 'root', 'read', 'deny'),
            rule('allow-v1', 'allow', 1, 'ROOT', 'alice', 'service', 'read', 'allow'),
        ]
        case = {'resources': RESOURCES, 'versions': versions, 'queries': [query()]}
        self.assertEqual(solve_case(case)[0]['decision'], 'allow')

    def test_delegation(self):
        versions = [
            rule('root-v1', 'root-rule', 1, 'ROOT', 'admin', 'root', '*', 'allow', 2),
            rule('child-v1', 'child-rule', 2, 'admin', 'alice', 'service', 'read', 'allow', 1),
        ]
        case = {'resources': RESOURCES, 'versions': versions, 'queries': [query()]}
        self.assertEqual(solve_case(case), [{'decision': 'allow', 'rule': 'child-v1', 'authority': ['root-v1', 'child-v1'], 'subjectPath': ['alice']}])


if __name__ == '__main__':
    unittest.main()
