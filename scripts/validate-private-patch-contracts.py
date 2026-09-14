#!/usr/bin/env python3
"""Validate the private-patch ledger against Git.

Answers the question the ledger exists for: is every private commit accounted
for by a contract, does every contract point at commits that exist, and is the
recorded base/tip still true? Stdlib only, so no dependency bump can break it.

Exit 0 = ledger agrees with Git. Exit 1 = it does not; the differences print.
"""
from __future__ import annotations

import re
import subprocess
import sys
import tomllib
from pathlib import Path

LEDGER = Path(__file__).resolve().parent.parent / 'private-patch-contracts.toml'
VALID_STATUS = {'merged', 'open-pr', 'open-prs', 'closed-unmerged', 'not-submitted'}


def git(*args: str) -> str:
    result = subprocess.run(('git', *args), capture_output=True, text=True,
                            cwd=LEDGER.parent)
    if result.returncode:
        raise SystemExit(f'git {" ".join(args)} failed: {result.stderr.strip()}')
    return result.stdout.strip()


def main() -> int:
    text = LEDGER.read_text()
    ledger = tomllib.loads(text)
    stack = ledger['stack']
    problems: list[str] = []

    base, tip = stack['base_ref'], stack['tracked_tip']
    for ref, label in ((base, 'base_ref'), (tip, 'tracked_tip')):
        if subprocess.run(('git', 'cat-file', '-e', f'{ref}^{{commit}}'),
                          capture_output=True, cwd=LEDGER.parent).returncode:
            problems.append(f'{label} {ref!r} does not resolve to a commit')
    if problems:
        print('\n'.join(problems))
        return 1

    # Commits claimed by contracts, plus the trailing comment blocks that
    # deliberately account for test-only commits and upstream sync merges.
    claimed: dict[str, str] = {}
    for patch in ledger['patches']:
        if patch.get('upstream_status') not in VALID_STATUS:
            problems.append(f'{patch["id"]}: unknown upstream_status '
                            f'{patch.get("upstream_status")!r}')
        for field in ('retire_when', 'validation'):
            if not patch.get(field):
                problems.append(f'{patch["id"]}: missing {field}')
        for commit in patch.get('commits', []):
            if commit in claimed:
                problems.append(f'{commit} claimed by both {claimed[commit]} '
                                f'and {patch["id"]}')
            claimed[commit] = patch['id']

    for line in re.findall(r'^#\s+((?:[0-9a-f]{7,40}\s*)+)$', text, re.M):
        for commit in line.split():
            claimed.setdefault(commit, 'accounted-comment')

    for commit, owner in claimed.items():
        if subprocess.run(('git', 'cat-file', '-e', f'{commit}^{{commit}}'),
                          capture_output=True, cwd=LEDGER.parent).returncode:
            problems.append(f'{owner}: commit {commit} does not resolve')

    # The authoritative private set: everything on the tip that is not upstream.
    merge_base = git('merge-base', tip, base)
    actual = set(git('log', '--format=%h', f'{merge_base}..{tip}').split())
    # Normalize: compare on the abbreviations Git itself produces.
    claimed_short = {git('log', '-1', '--format=%h', c) for c in claimed}

    for commit in sorted(actual - claimed_short):
        subject = git('log', '-1', '--format=%s', commit)
        problems.append(f'UNACCOUNTED private commit {commit} {subject}')
    for commit in sorted(claimed_short - actual):
        problems.append(f'ledger lists {commit}, which is not in '
                        f'{merge_base[:8]}..{tip[:8]}')

    print(f'ledger: {len(ledger["patches"])} contracts, '
          f'{len(claimed)} commits accounted, '
          f'{len(actual)} private commits in {base}..{tip[:8]}')
    if problems:
        print('\nFAIL:')
        print('\n'.join(f'  - {p}' for p in problems))
        return 1
    print('OK: every private commit is accounted for and every hash resolves')
    return 0


if __name__ == '__main__':
    sys.exit(main())
