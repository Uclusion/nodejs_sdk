#!/usr/bin/env python3
"""Read Linux process/host counters for one private native Codex home."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time


def key_values(file):
    values = {}
    for line in Path(file).read_text().splitlines():
        fields = line.replace(':', '').split()
        if len(fields) > 1 and fields[1].isdigit():
            values[fields[0]] = int(fields[1])
    return values


def pressure(name):
    result = {}
    try:
        for line in Path('/proc/pressure', name).read_text().splitlines():
            fields = line.split()
            result[fields[0]] = {k: float(v) for k, v in (word.split('=') for word in fields[1:])}
    except FileNotFoundError:
        pass
    return result


def host_snapshot():
    memory, vm = key_values('/proc/meminfo'), key_values('/proc/vmstat')
    return {'memory_kib': {key: memory.get(key) for key in
                          ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']},
            'cpu_ticks': [int(value) for value in Path('/proc/stat').read_text().splitlines()[0].split()[1:]],
            'swap_pages_in': vm.get('pswpin'), 'swap_pages_out': vm.get('pswpout'),
            'oom_kill': vm.get('oom_kill'),
            'pressure': {name: pressure(name) for name in ['cpu', 'memory', 'io']},
            'load_average': list(os.getloadavg())}


def process_table():
    result = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            text = (entry / 'stat').read_text()
            tail = text[text.rindex(')') + 2:].split()
            pid = int(entry.name)
            result[pid] = {'pid': pid, 'ppid': int(tail[1]), 'start_ticks': int(tail[19]),
                           'cpu_ticks': int(tail[11]) + int(tail[12]),
                           'threads': int(tail[17]), 'rss_kib': int(tail[21]) * os.sysconf('SC_PAGE_SIZE') // 1024,
                           'name': text[text.index('(') + 1:text.rindex(')')]}
        except (OSError, ValueError, IndexError):
            continue
    return result


def private_processes(table, home, known):
    selected = {pid for pid, row in table.items() if known.get(pid) == row['start_ticks']}
    expected = {b'HOME=' + os.fsencode(home), b'CODEX_HOME=' + os.fsencode(home / '.codex')}
    for pid in table:
        if pid in selected:
            continue
        try:
            environment = set(Path('/proc', str(pid), 'environ').read_bytes().split(b'\0'))
            if environment & expected:
                selected.add(pid)
        except OSError:
            pass
    while True:
        descendants = {pid for pid, row in table.items() if row['ppid'] in selected}
        if descendants <= selected:
            break
        selected |= descendants
    return selected


def enrich(row, proxy):
    proc = Path('/proc', str(row['pid']))
    try:
        memory = key_values(proc / 'smaps_rollup')
        row['pss_kib'] = memory.get('Pss')
        row['private_kib'] = memory.get('Private_Clean', 0) + memory.get('Private_Dirty', 0)
    except OSError:
        row['pss_kib'] = None
    try:
        arguments = (proc / 'cmdline').read_bytes().split(b'\0')
        row['kind'] = 'mcp' if os.fsencode(proxy) in arguments else (
            'packet-test' if b'unittest' in arguments else 'runtime-or-tool')
        if row['kind'] == 'mcp':
            row['thread_names'] = sorted((task / 'comm').read_text().strip()
                                         for task in (proc / 'task').iterdir())
            # Inodes are enough to correlate live sockets without capturing addresses or credentials.
            row['socket_inodes'] = sorted(os.readlink(fd)[8:-1] for fd in (proc / 'fd').iterdir()
                                          if os.readlink(fd).startswith('socket:['))
    except OSError:
        pass
    return row


def delivery_owners(home):
    database = home / '.uclusion' / 'poke_inbox.sqlite3'
    if not database.exists():
        return []
    try:
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=0.05) as connection:
            return [row[0] for row in connection.execute('SELECT pid FROM codex_native_proxies')]
    except sqlite3.Error:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, required=True)
    parser.add_argument('--proxy', type=Path, required=True)
    parser.add_argument('--snapshot', action='store_true')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--stop', type=Path)
    parser.add_argument('--native-stop', type=Path)
    parser.add_argument('--abort', type=Path)
    parser.add_argument('--timeout', type=float, default=650)
    args = parser.parse_args()
    if args.snapshot:
        table = process_table()
        print(json.dumps({'processes': [enrich(table[pid], args.proxy) for pid in
                                       sorted(private_processes(table, args.home.resolve(), {}))]}))
        return
    known, maxima = {}, {}
    started = time.monotonic()
    low_since = pressure_since = None
    baseline = host_snapshot()
    with args.output.open('x') as output:
        while not args.stop.exists() and time.monotonic() - started < args.timeout:
            tick = time.monotonic()
            table, host = process_table(), host_snapshot()
            selected = private_processes(table, args.home.resolve(), known)
            rows = []
            for pid in sorted(selected):
                row = enrich(table[pid], args.proxy)
                known[pid] = row['start_ticks']
                identity = f"{pid}:{row['start_ticks']}"
                maxima[identity] = max(maxima.get(identity, 0), row['cpu_ticks'])
                rows.append(row)
            available = host['memory_kib']['MemAvailable']
            low_since = (low_since or tick) if available < 1024 * 1024 else None
            full = host['pressure']['memory'].get('full', {}).get('avg10', 0)
            swapping = (host['swap_pages_in'] > baseline['swap_pages_in'] or
                        host['swap_pages_out'] > baseline['swap_pages_out'])
            pressure_since = (pressure_since or tick) if full >= 5 and swapping else None
            reason = None
            if host['oom_kill'] > baseline['oom_kill']:
                reason = 'Host OOM kill counter increased'
            elif low_since and tick - low_since >= 10:
                reason = 'MemAvailable below 1 GiB for 10 seconds'
            elif pressure_since and tick - pressure_since >= 10:
                reason = 'Memory full PSI avg10 at least 5 percent with swap activity for 10 seconds'
            snapshot = {'at_ms': round(time.time() * 1000), 'host': host, 'processes': rows,
                        'delivery_owner_pids': delivery_owners(args.home),
                        'observed_cpu_seconds': sum(maxima.values()) / os.sysconf('SC_CLK_TCK'),
                        'sampler_cpu_seconds': time.process_time(),
                        'pss_kib': sum(row['pss_kib'] or 0 for row in rows),
                        'pss_missing': sum(row['pss_kib'] is None for row in rows),
                        'rss_kib': sum(row['rss_kib'] for row in rows)}
            if not known:
                snapshot['baseline_top_processes'] = sorted(table.values(), key=lambda row: row['rss_kib'], reverse=True)[:15]
            output.write(json.dumps(snapshot) + '\n')
            output.flush()
            if reason:
                args.abort.write_text(json.dumps({'reason': reason, 'at_ms': snapshot['at_ms']}) + '\n')
                args.native_stop.write_text('stop\n')
            time.sleep(max(0, 0.5 - (time.monotonic() - tick)))


if __name__ == '__main__':
    main()
