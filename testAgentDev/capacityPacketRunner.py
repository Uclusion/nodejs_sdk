#!/usr/bin/env python3
"""Run one real verification packet once, with private local state and a receipt."""
import argparse
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import time


def run_packet(source, output, packet):
    output.mkdir(parents=True, exist_ok=True)
    receipt_path = output / 'tests.json'
    # A model retry must not turn one packet into unbounded repeated work.
    if receipt_path.exists():
        return json.loads(receipt_path.read_text())
    home = output / 'test-home'
    temporary = output / 'tmp'
    home.mkdir(exist_ok=True)
    temporary.mkdir(exist_ok=True)
    command = [sys.executable, '-B', '-m', 'unittest', '-v', *packet['tests']]
    environment = {**os.environ, 'HOME': str(home), 'UCLUSION_HOME': str(home),
                   'CODEX_HOME': str(home / '.codex'),
                   'CLAUDE_CONFIG_DIR': str(home / '.claude'),
                   'TMPDIR': str(temporary), 'PYTHONDONTWRITEBYTECODE': '1',
                   'PYTHONPATH': str(source / 'public' / 'scripts')}
    started = time.time()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    with (output / 'tests.log').open('w') as log:
        result = subprocess.run(command, cwd=source, env=environment, stdout=log,
                                stderr=subprocess.STDOUT, timeout=180)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    text = (output / 'tests.log').read_text()
    counts = re.findall(r'^Ran (\d+) tests? in ([\d.]+)s$', text, re.MULTILINE)
    receipt = {'packet': packet['id'], 'command': command, 'exit_code': result.returncode,
               'started_at_ms': round(started * 1000), 'completed_at_ms': round(time.time() * 1000),
               'wall_seconds': time.time() - started,
               'tests_run': int(counts[-1][0]) if counts else None,
               'test_seconds': float(counts[-1][1]) if counts else None,
               'cpu_seconds': (after.ru_utime + after.ru_stime) - (before.ru_utime + before.ru_stime),
               'peak_child_rss_kib': after.ru_maxrss,
               'failures': re.findall(r'^(?:FAIL|ERROR): (.+)$', text, re.MULTILINE),
               'skips': re.findall(r'^(.+?) \.\.\. skipped (.+)$', text, re.MULTILINE)}
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--packets', type=Path, default=Path(__file__).with_name('capacityPackets.json'))
    parser.add_argument('--packet', required=True)
    args = parser.parse_args()
    packets = json.loads(args.packets.read_text())
    packet = next(item for item in packets if item['id'] == args.packet)
    receipt = run_packet(args.source.resolve(), args.output.resolve(), packet)
    print(json.dumps(receipt))
    return receipt['exit_code']


if __name__ == '__main__':
    sys.exit(main())
