#!/usr/bin/env python3
"""Summarize saved capacity evidence. This performs no tests or provider calls."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import statistics
from datetime import datetime


def trace_evidence(trace, started, cutoff):
    """Recover evidence even when final root-history export was interrupted."""
    threads, rollouts, items, quota = {}, {}, {}, []
    for line in trace.read_text().splitlines():
        row = json.loads(line)
        message = row.get('message', {})
        if row['direction'] == 'from-client':
            thread = message.get('result', {}).get('thread') or message.get('params', {}).get('thread')
            if thread:
                threads[thread['id']] = thread
            if message.get('method') == 'account/rateLimits/updated':
                quota.append(message['params']['rateLimits']['primary']['usedPercent'])
        if row['direction'] == 'native-rollout':
            owner = message['threadId']
            rollouts.setdefault(owner, []).extend(message['records'])
            for record in message['records']:
                payload = record.get('payload', {})
                if payload.get('type') == 'item_completed':
                    items[(owner, payload['item']['id'])] = payload
    root = next(key for key, thread in threads.items() if thread.get('threadSource') == 'user')
    helpers = [key for key, thread in threads.items() if thread.get('parentThreadId') == root]
    writes, calls, command_errors, durations = {}, [], [], []
    for (owner, _), event in items.items():
        item = event['item']
        if item['type'] == 'McpToolCall':
            calls.append({'thread': owner, 'tool': item['tool'], 'arguments': item['arguments'],
                          'status': item['status'], 'is_helper': owner in helpers})
        if item['type'] == 'CommandExecution':
            command = '\n'.join(item['command'])
            if owner in helpers and item.get('exit_code') == 0 and any(
                    marker in command for marker in ('>', 'write_text', 'json.dump')):
                if 'review.json' in command:
                    for packet in re.findall(r'results/([a-z-]+)', command):
                        writes[packet] = event.get('completed_at_ms')
                    # Resolve only literal local bindings used by saved Python
                    # report writes; never execute participant command text.
                    for match in re.finditer(r'results/\{([A-Za-z_]\w*)\}/review\.json', command):
                        bindings = re.findall(rf'(?:^|\n)\s*{re.escape(match[1])}\s*=\s*[\'\"]([a-z-]+)[\'\"]',
                                              command[:match.start()])
                        if bindings:
                            writes[bindings[-1]] = event.get('completed_at_ms')
            if item.get('exit_code') not in (None, 0):
                command_errors.append({'thread': owner, 'exit_code': item['exit_code'],
                                       'command': command[:300]})
        if item['type'] == 'FileChange' and item.get('status') == 'completed':
            for packet in re.findall(r'results/([a-z-]+)/review\.json', json.dumps(item)):
                writes[packet] = event.get('completed_at_ms')
        if item['type'] in ('CommandExecution', 'McpToolCall'):
            a, b = event.get('started_at_ms'), event.get('completed_at_ms')
            if a is not None and b is not None:
                kind = item['type'][0].lower() + item['type'][1:]
                durations.append({'type': kind, 'duration_ms': b - a})
    endpoint = max(writes.values()) if len(writes) == 16 and all(writes.values()) else cutoff
    intervals, models = [], {}
    for owner, records in rollouts.items():
        models[owner] = sorted({f"{r['payload'].get('model')}/{r['payload'].get('effort')}"
                                for r in records if r['type'] == 'turn_context'})
        if owner not in helpers:
            continue
        starts = {}
        for record in records:
            payload = record.get('payload', {})
            at = datetime.fromisoformat(record['timestamp'].replace('Z', '+00:00')).timestamp() * 1000
            if payload.get('type') == 'task_started':
                starts[payload['turn_id']] = at
            elif payload.get('type') == 'task_complete' and payload['turn_id'] in starts:
                intervals.append({'thread': owner, 'start_ms': starts.pop(payload['turn_id']),
                                  'end_ms': at, 'censored': False})
        intervals.extend({'thread': owner, 'start_ms': at, 'end_ms': endpoint, 'censored': True}
                         for at in starts.values())
    events = sorted((at, delta) for interval in intervals for at, delta in
                    ((max(started, interval['start_ms']), 1), (min(endpoint, interval['end_ms']), -1))
                    if interval['start_ms'] < endpoint)
    active, previous, peak, area = 0, started, 0, 0
    timeline, seconds_by_count = [], Counter()
    for at, delta in events:
        seconds_by_count[active] += (at - previous) / 1000
        area += active * (at - previous)
        active += delta
        peak = max(peak, active)
        timeline.append({'at_ms': at, 'active_helpers': active})
        previous = at
    seconds_by_count[active] += max(0, endpoint - previous) / 1000
    return {'root': root, 'direct_helpers': helpers, 'models': models,
            'report_write_times_ms': writes, 'last_report_ms': endpoint if len(writes) == 16 else None,
            'intervals': intervals, 'timeline': timeline, 'peak_active_helpers': peak,
            'average_active_helpers': area / (endpoint - started),
            'seconds_by_active_count': dict(sorted(seconds_by_count.items())),
            'mcp_calls': calls, 'command_errors': command_errors, 'tool_durations': durations,
            'weekly_quota_used_percent_first': quota[0] if quota else None,
            'weekly_quota_used_percent_last': quota[-1] if quota else None}


def summarize(catalog, count):
    folder = catalog / f'helpers-{count}'
    timing = json.loads((folder / 'timing.json').read_text())
    samples = [json.loads(line) for line in (folder / 'resources.jsonl').read_text().splitlines()]
    begin = timing['work_started_ms']
    capture_end = timing.get('work_finished_ms') or samples[-1]['at_ms']
    trace = catalog / 'traces' / f'capacity-{count}.jsonl'
    evidence = trace_evidence(trace, begin, capture_end)
    (folder / 'derived-native-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    end = evidence['last_report_ms'] or capture_end
    work = [row for row in samples if begin <= row['at_ms'] <= end]
    baseline = [row for row in samples if begin - 5000 <= row['at_ms'] < begin]
    baseline_pss = statistics.mean(row['pss_kib'] for row in baseline)
    cpu_rates = [(b['observed_cpu_seconds'] - a['observed_cpu_seconds']) /
                 ((b['at_ms'] - a['at_ms']) / 1000) for a, b in zip(work, work[1:])]
    packets = [json.loads(file.read_text()) for file in sorted((folder / 'results').glob('*/tests.json'))]
    reports = [json.loads(file.read_text()) for file in sorted((folder / 'results').glob('*/review.json'))]
    test_events = sorted([(p['started_at_ms'], 1) for p in packets] +
                         [(p['completed_at_ms'], -1) for p in packets])
    concurrent, test_peak = 0, 0
    for _, delta in test_events:
        concurrent += delta
        test_peak = max(test_peak, concurrent)
    quiet_start = (timing.get('work_finished_ms') or float('inf')) + 3000
    quiet = [row for row in samples if row['at_ms'] > quiet_start and
             any(p.get('kind') == 'mcp' for p in row['processes'])]
    proxy_snapshot = []
    if quiet:
        selected = quiet[-1]
        proxy_snapshot = [{**{key: proc.get(key) for key in
                            ['pid', 'threads', 'rss_kib', 'pss_kib', 'socket_inodes', 'thread_names']},
                           'registered_delivery_owner': proc['pid'] in (selected['delivery_owner_pids'] or [])}
                          for proc in selected['processes'] if proc.get('kind') == 'mcp']
    usage, provider_errors = {}, []
    tool_durations = evidence['tool_durations']
    for line in trace.read_text().splitlines():
        row = json.loads(line)
        message = row.get('message', {})
        if row.get('direction') == 'native-rollout':
            thread_id = message.get('threadId')
            for record in message.get('records', []):
                payload = record.get('payload', {})
                if payload.get('type') == 'token_count':
                    latest = (payload.get('info') or {}).get('total_token_usage')
                    if latest:
                        usage[thread_id] = latest
        if row.get('direction') == 'from-client' and message.get('method') == 'error':
            provider_errors.append(message.get('params'))
        if not tool_durations and row.get('direction') == 'completed-histories':
            for thread in message.get('threads', {}).values():
                for turn in thread.get('turns', []):
                    for item in turn.get('items', []):
                        if item.get('type') in ['commandExecution', 'mcpToolCall']:
                            a, b = item.get('startedAtMs'), item.get('completedAtMs')
                            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                                tool_durations.append({'type': item['type'], 'duration_ms': b - a})
    token_sums = dict(sum((Counter(value) for value in usage.values()), Counter()))
    snapshot = {
        'helpers_configured': count, 'total_thread_limit': count + 1,
        'case_failure': timing.get('failure'),
        'batch_report_seconds': (end - begin) / 1000 if evidence['last_report_ms'] else None,
        'observed_capture_seconds': (capture_end - begin) / 1000,
        'root_completion_seconds': (timing['work_finished_ms'] - begin) / 1000
                                   if timing.get('work_finished_ms') else None,
        'resource_window': 'root input through last report' if evidence['last_report_ms'] else 'capture interval',
        'activity': timing.get('activity'),
        'actual_helpers': len(evidence['direct_helpers']),
        'peak_active_helpers': evidence['peak_active_helpers'],
        'average_active_helpers': evidence['average_active_helpers'],
        'seconds_by_active_count': evidence['seconds_by_active_count'],
        'models': evidence['models'],
        'weekly_quota_used_percent_first': evidence['weekly_quota_used_percent_first'],
        'weekly_quota_used_percent_last': evidence['weekly_quota_used_percent_last'],
        'captured_mcp_call_count': len(evidence['mcp_calls']),
        'captured_unapproved_mcp_calls': [call for call in evidence['mcp_calls']
                                        if call['tool'] != 'get_job' or not call['is_helper']],
        'command_errors': evidence['command_errors'],
        'packet_receipts': len(packets), 'review_reports': len(reports),
        'tests_run': sum(row['tests_run'] or 0 for row in packets),
        'test_failures': [row for row in packets if row['exit_code']],
        'test_process_peak_overlap': test_peak,
        'packet_test_cpu_seconds': sum(row['cpu_seconds'] for row in packets),
        'packet_test_wall_seconds_sum': sum(row['wall_seconds'] for row in packets),
        'packets_per_minute': len(packets) * 60 / ((end - begin) / 1000),
        'private_process_peak_pss_mib': max(row['pss_kib'] for row in work) / 1024,
        'blank_client_baseline_pss_mib': baseline_pss / 1024,
        'incremental_peak_pss_mib': (max(row['pss_kib'] for row in work) - baseline_pss) / 1024,
        'private_process_peak_rss_mib': max(row['rss_kib'] for row in work) / 1024,
        'missing_pss_process_samples': sum(row['pss_missing'] for row in work),
        'observed_process_cpu_seconds': work[-1]['observed_cpu_seconds'] - work[0]['observed_cpu_seconds'],
        'mean_busy_cpu_cores': statistics.mean(cpu_rates) if cpu_rates else None,
        'peak_half_second_busy_cpu_cores': max(cpu_rates) if cpu_rates else None,
        'host_min_available_mib': min(row['host']['memory_kib']['MemAvailable'] for row in work) / 1024,
        'host_baseline_available_mib': statistics.mean(row['host']['memory_kib']['MemAvailable'] for row in baseline) / 1024,
        'host_memory_full_psi_avg10_max': max(row['host']['pressure']['memory'].get('full', {}).get('avg10', 0) for row in work),
        'host_swap_pages_in_delta': work[-1]['host']['swap_pages_in'] - work[0]['host']['swap_pages_in'],
        'host_swap_pages_out_delta': work[-1]['host']['swap_pages_out'] - work[0]['host']['swap_pages_out'],
        'host_oom_kills_delta': work[-1]['host']['oom_kill'] - work[0]['host']['oom_kill'],
        'quiescent_actual_proxies': proxy_snapshot,
        'cleanup_remaining_processes': timing.get('cleanup_process_count'),
        'reported_usage': timing['reported_usage'], 'rollout_usage_sums': token_sums,
        'native_error_events': provider_errors,
        'tool_latency_ms': {kind: {'count': len(rows), 'median': statistics.median(rows), 'max': max(rows)}
                            for kind in ['commandExecution', 'mcpToolCall']
                            if (rows := [row['duration_ms'] for row in tool_durations if row['type'] == kind])},
        'packet_receipt_details': packets,
        'review_findings': [{'packet': report['packet'], 'findings': report.get('findings')}
                            for report in reports if report.get('findings')],
    }
    (folder / 'summary.json').write_text(json.dumps(snapshot, indent=2) + '\n')
    return {key: value for key, value in snapshot.items() if key not in
            ['activity', 'packet_receipt_details', 'quiescent_actual_proxies', 'review_findings']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('catalog', type=Path)
    parser.add_argument('helpers', type=int)
    arguments = parser.parse_args()
    print(json.dumps(summarize(arguments.catalog, arguments.helpers), indent=2))
