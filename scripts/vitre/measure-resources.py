#!/usr/bin/env python3
"""Measure an isolated Vitre release process tree; no installed app state is used."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import tempfile
import time


def cpu_seconds(value):
    days, _, value = value.rpartition("-")
    parts = [float(part) for part in value.split(":")]
    return (float(days or 0) * 86400 + sum(part * 60 ** i for i, part in enumerate(reversed(parts))))


def processes(root):
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss=,time=,comm="], text=True)
    rows = {}
    for line in output.splitlines():
        fields = line.split(None, 4)
        if len(fields) != 5:
            continue
        pid, parent, rss, cpu, command = fields
        rows[int(pid)] = (int(parent), int(rss), cpu_seconds(cpu), command)
    selected = {root}
    while True:
        children = {pid for pid, row in rows.items() if row[0] in selected}
        if children <= selected:
            break
        selected |= children
    return {pid: rows[pid] for pid in selected if pid in rows}


def group(pid, root, command):
    name = Path(command).name.lower()
    if pid == root:
        return "native"
    if name in ("node", "nodejs"):
        return "node_and_node_tools"
    if "webkit" in name:
        return "browser"
    return "other_children"


def sample(root, previous, interval):
    rows = processes(root)
    groups = {}
    cpu = 0.0
    for pid, (_, rss, seconds, command) in rows.items():
        bucket = groups.setdefault(group(pid, root, command), {"rss_mib": 0.0, "pss_mib": None})
        bucket["rss_mib"] += rss / 1024
        if platform.system() == "Linux":
            try:
                text = Path(f"/proc/{pid}/smaps_rollup").read_text()
                pss = next(float(line.split()[1]) for line in text.splitlines() if line.startswith("Pss:"))
                bucket["pss_mib"] = (bucket["pss_mib"] or 0) + pss / 1024
            except (OSError, StopIteration):
                pass
        if pid in previous:
            cpu += max(0, seconds - previous[pid])
    return {
        "groups": groups,
        "processes": [{"pid": pid, "parent_pid": row[0], "command": row[3], "rss_mib": row[1] / 1024} for pid, row in rows.items()],
        "tree_rss_mib": sum(entry["rss_mib"] for entry in groups.values()),
        "cpu_percent_one_core": cpu * 100 / interval,
        "process_count": len(rows),
    }, {pid: row[2] for pid, row in rows.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="target/release/vitre")
    parser.add_argument("--server", default="apps/server/dist/bin.mjs")
    parser.add_argument("--duration", type=int, default=300, help="Idle seconds after backend readiness")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    binary = Path(args.binary).resolve()
    server = Path(args.server).resolve()
    report = {
        "platform": platform.platform(), "machine": platform.machine(),
        "logical_cpus": os.cpu_count(), "processor": platform.processor(),
        "build_configuration": "cargo build -p vitre-app --release; vp pack in apps/server",
        "scenario": "empty disposable home; idle native UI and local backend",
        "duration_seconds": args.duration,
        "node_version": subprocess.check_output([os.environ.get("VITRE_NODE", "node"), "--version"], text=True).strip(),
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "working_tree": subprocess.check_output(["git", "status", "--short"], text=True).splitlines(),
        "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "server_sha256": hashlib.sha256(server.read_bytes()).hexdigest(),
        "metric_notes": "RSS sums double-count shared pages. Linux PSS is separate. GPU allocations and reparented subprocesses are not attributed. Node children include Node-based tools.",
        "runs": [],
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    for run in range(args.runs):
        with tempfile.TemporaryDirectory(prefix="vitre-perf-") as home:
            env = {key: value for key, value in os.environ.items() if not key.startswith("VITRE_")}
            env.update(VITRE_HOME=home, VITRE_SERVER_ENTRY=str(server), VITRE_PROFILE="1")
            log_path = output.with_suffix(f".run-{run + 1}.log")
            started = time.monotonic()
            ready = None
            measurements = []
            previous = {}
            last = started
            with log_path.open("w") as log:
                child = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=log, start_new_session=True)
                try:
                    while child.poll() is None:
                        time.sleep(1)
                        now = time.monotonic()
                        if ready is None and "backend ready at" in log_path.read_text(errors="replace"):
                            ready = now - started
                        measurement, previous = sample(child.pid, previous, now - last)
                        measurement["elapsed_seconds"] = now - started
                        measurements.append(measurement)
                        last = now
                        if len(measurements) % 30 == 0:
                            print(f"run {run + 1}: {now - started:.0f}s, RSS {measurement['tree_rss_mib']:.1f} MiB", flush=True)
                        if ready is None and now - started > 90:
                            raise RuntimeError(f"Backend never became ready; see {log_path}")
                        if ready is not None and now - started >= ready + args.duration:
                            break
                finally:
                    if child.poll() is None:
                        child.send_signal(signal.SIGTERM)
                        try:
                            child.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait()
            tail = measurements[-min(60, len(measurements)):]
            log_text = log_path.read_text(errors="replace")
            startup = re.search(r"backend ready at .* after (\d+) ms", log_text)
            shell = re.search(r"shell snapshot ready after (\d+) ms", log_text)
            result = {
                "completed_duration": ready is not None and bool(measurements) and measurements[-1]["elapsed_seconds"] >= ready + args.duration,
                "backend_launch_to_ready_ms": int(startup.group(1)) if startup else None,
                "client_start_to_shell_snapshot_ms": int(shell.group(1)) if shell else None,
                "backend_ready_observed_seconds": ready,
                "readiness_sample_resolution_seconds": 1,
                "peak_tree_rss_mib": max((m["tree_rss_mib"] for m in measurements), default=0),
                "settled_tree_rss_mib": sum(m["tree_rss_mib"] for m in tail) / max(1, len(tail)),
                "settled_cpu_percent_one_core": sum(m["cpu_percent_one_core"] for m in tail) / max(1, len(tail)),
                "samples": measurements,
            }
            report["runs"].append(result)
            output.write_text(json.dumps(report, indent=2) + "\n")
            print(f"completed run {run + 1}: {result['settled_tree_rss_mib']:.1f} MiB settled RSS", flush=True)


if __name__ == "__main__":
    main()
