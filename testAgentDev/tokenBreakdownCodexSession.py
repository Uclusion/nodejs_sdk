#!/usr/bin/env python3
"""Run one native Codex session in a pseudo-terminal for a live catalog.

The installed Uclusion MCP adapter collects the audit from ordinary Codex.
This reuses the demo terminal and keeps the session open until the harness
creates its stop file, the session exits, or its timeout passes.

Exit codes: 0 stopped by the harness, 3 the session exited, 4 timed out.
"""

import argparse
import importlib.util
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


def stop_private_codex(codex, workspace):
    """Stop only this fixture's daemon and private updater before removal."""
    home = Path(os.environ['CODEX_HOME']).resolve()
    expected = Path(workspace).resolve().parent / 'home' / '.codex'
    if home != expected:
        raise RuntimeError('Refusing to stop a Codex daemon outside the fixture home')
    subprocess.run([codex, 'app-server', 'daemon', 'stop'],
                   capture_output=True, text=True, timeout=15, check=True)
    # On Linux daemon stop leaves an updater running from the private home.
    # A pidfd keeps termination tied to that exact process, including PID reuse.
    if not hasattr(os, 'pidfd_open') or not Path('/proc').is_dir():
        return
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        descriptor = None
        try:
            descriptor = os.pidfd_open(int(entry.name))
            argv = [part.decode() for part in (entry / 'cmdline').read_bytes().split(b'\0') if part]
            if (argv and Path(argv[0]).is_relative_to(home)
                    and argv[1:] == ['app-server', 'daemon', 'pid-update-loop']):
                signal.pidfd_send_signal(descriptor, signal.SIGTERM)
                if not select.select([descriptor], [], [], 3)[0]:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    if not select.select([descriptor], [], [], 2)[0]:
                        raise RuntimeError('The fixture Codex updater did not stop')
        except (FileNotFoundError, ProcessLookupError, PermissionError, UnicodeError):
            continue
        finally:
            if descriptor is not None:
                os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--scripts', required=True,
                        help='The uclusion_web_ui public/scripts directory under test.')
    parser.add_argument('--workspace', required=True,
                        help='The directory the session runs in.')
    parser.add_argument('--log', required=True, help='Where to copy the terminal output.')
    parser.add_argument('--stop', required=True, help='A file whose creation ends the session.')
    parser.add_argument('--timeout', type=float, required=True, help='Seconds before giving up.')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a command to run is required after --')

    sys.path.insert(0, args.scripts)
    spec = importlib.util.spec_from_file_location(
        'uclusion_install_under_test', os.path.join(args.scripts, 'uclusionInstall.py'))
    install = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(install)
    # The demo terminal starts its session in the demo home; this one runs in
    # the fixture's workspace.
    install.uclusion_home_root = lambda: args.workspace

    deadline = time.monotonic() + args.timeout
    with open(args.log, 'wb') as log:
        terminal = install.DemoCodexTerminal(command, {**os.environ, 'TERM': 'xterm-256color'}, log)
        try:
            while True:
                if os.path.exists(args.stop):
                    return 0
                if terminal.process.poll() is not None:
                    return 3
                if time.monotonic() >= deadline:
                    return 4
                terminal.drain()
        finally:
            try:
                install.stop_demo_session(terminal.process)
            finally:
                try:
                    terminal.close()
                finally:
                    stop_private_codex(command[0], args.workspace)


if __name__ == '__main__':
    sys.exit(main())
