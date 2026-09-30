# Bitemporal authority ledger

Complete `/workspace/solution.py` using Python 3.12 and only its standard library. The starter contains JSON input/output plumbing and a `solve_case` function for you to implement. You may replace it completely. Public examples are available in `/workspace/public_tests.py`.

Read one JSON object from stdin and write one JSON value to stdout. Do not print explanations or test output to stdout. Only `solution.py` is submitted to the private grader.

Input is `{"cases":[case, ...]}`. Output is a list containing one list of query answers per case, in input order.

## Case format

A case has `resources`, `versions`, and `queries`.

Resources form a rooted tree:

```json
{"id":"database","parent":"production"}
```

Exactly one resource has a null parent. Every other parent exists. Resource IDs are unique and the tree is acyclic.

Versions are recorded versions of logical facts:

```json
{
  "id":"policy-v2",
  "fact":"policy-17",
  "recorded":40,
  "valid":[10,80],
  "payload":{"kind":"rule","issuer":"ROOT","subject":"oncall","resource":"production","action":"deploy","effect":"allow","delegate":2}
}
```

- `id` identifies this version and is globally unique within the case.
- `fact` identifies the logical fact. Several versions may have the same fact ID.
- `recorded` is a nonnegative integer representing when this version became known.
- `valid` is `[start,end]`. It is active when `start <= at < end`. A null end means no upper bound.
- `payload` is a membership, a rule, or JSON null. A null payload retracts the logical fact.

A membership payload is:

```json
{"kind":"member","member":"alice","group":"oncall"}
```

A rule payload is:

```json
{"kind":"rule","issuer":"ROOT","subject":"oncall","resource":"production","action":"deploy","effect":"allow","delegate":2}
```

`effect` is `allow` or `deny`. `action` is an action name or `*`. `delegate` is a nonnegative integer.

A query is:

```json
{"subject":"alice","resource":"database","action":"deploy","known":55,"at":25}
```

`known` is recorded time. `at` is effective time.

All names and IDs are nonempty ASCII alphanumeric strings, `_`, or `-`, at most 30 characters. `ROOT` is reserved and never appears as an ordinary subject, member, group, or issuer.

## Select the known facts

For each fact, consider only versions with `recorded <= known`. Select the version with the greatest `(recorded, id)` pair, comparing IDs in ascending ASCII order. This means the ASCII-greatest ID wins when recorded times tie.

Discard a selected version when its payload is null or `at` is outside its half-open valid interval. Versions that were not selected have no effect, even if their own valid interval contains `at`.

All remaining processing uses only these active selected versions.

## Membership paths

Membership edges point from `member` to `group`. Membership is transitive. Cycles are legal.

A subject reaches itself by the path `[subject]`. For every reachable group, use the path with the fewest edges. If several paths have the same length, use the lexicographically smallest complete list of names. List comparison is element by element, with a proper prefix sorting first.

A rule applies to a query subject when the rule's subject has a membership path from the query subject. Its subject distance is the number of edges in that path.

Membership also determines whether an issuer possesses authority through a rule. Use the same reachability rules for issuers.

## Resource and action scope

A rule on a resource applies to that resource and all descendants. Its resource distance is the number of parent edges from the queried resource to the rule resource. A rule outside that ancestor chain does not apply.

An exact action applies only to the same action. `*` applies to every action.

## Authorized rules and delegation

Not every active rule is authorized.

A rule whose issuer is `ROOT` is authorized immediately. Its remaining delegation depth is its own `delegate` value. Root deny rules are authorized but cannot authorize another rule because only allow rules carry authority.

A non-root rule becomes authorized when there is an authorized allow rule that:

- applies to the child rule's issuer through membership;
- has a resource that is the same as, or an ancestor of, the child rule's resource;
- has action `*` or exactly the child rule's action; and
- has remaining delegation depth of at least one.

If a parent rule has remaining depth `r`, the child state has remaining depth:

```text
min(child.delegate, r - 1)
```

Compute the least fixed point beginning only with root rules. A delegation cycle cannot authorize itself. A proof may not repeat a rule version ID.

A rule can have several authorized states with different remaining depths or proofs. Preserve every remaining depth that can be derived. For the same rule and remaining depth, retain the proof with the fewest rule IDs, then the lexicographically smallest proof.

A rule with remaining depth zero still applies to access decisions. It simply cannot authorize another rule.

The authority proof for an applicable rule is the shortest proof among all its authorized states, then the lexicographically smallest. A proof lists active rule version IDs from the root rule through the applicable rule.

## Choose the decision

Collect every authorized rule that applies to the query subject, resource, and action. Rank candidates by these criteria, in order:

1. Smaller resource distance.
2. Smaller subject distance.
3. Exact action before `*`.
4. `deny` before `allow`.
5. Shorter authority proof.
6. Lexicographically smaller authority proof.
7. Lexicographically smaller subject path.
8. Lexicographically smaller rule version ID.

The first candidate wins. Specificity is considered before effect, so a more specific allow beats a less specific deny.

If no candidate applies, deny by default.

## Output

For a winning rule, return:

```json
{"decision":"allow","rule":"policy-v2","authority":["root-v1","policy-v2"],"subjectPath":["alice","oncall"]}
```

For a default denial, return exactly:

```json
{"decision":"deny","rule":null,"authority":[],"subjectPath":[]}
```

Object key order does not matter. Every list order does matter.

## Limits and behavior

- At most 60 cases per input.
- At most 40 resources, 400 versions, and 60 queries per case.
- Delegation values are from 0 through 6.
- Recorded and effective times are nonnegative integers at most 1,000,000.
- All referenced resources exist. All inputs follow this specification.
- Grading has no task-specific execution-time cutoff, but your program must terminate and stay within 256 MiB.
- The agent work period is capped at 30 minutes.

Leave the final implementation at `/workspace/solution.py`.
