"""Print each Box policy denial as `[box] DENY <action> <resource> (rule <id>)`.

boxy writes the run's records (OTLP JSON) to ~/.boxy/runs/<run>/records.jsonl in the container. This
follows the newest run's file, so the runtime's CloudWatch log shows every denial.
Usage: python3 -u relay_denials.py &
"""
import glob
import json
import os
import time

RECORDS = "/home/box/.boxy/runs/*/records.jsonl"


def records_file(started):
    while True:
        found = [p for p in glob.glob(RECORDS) if os.path.getmtime(p) >= started]
        if found:
            return max(found, key=os.path.getmtime)
        time.sleep(0.5)


def denials(request):
    for resource_logs in request.get("resourceLogs", []):
        for scope_logs in resource_logs.get("scopeLogs", []):
            for record in scope_logs.get("logRecords", []):
                attributes = {
                    a["key"]: next(iter(a["value"].values()), "")
                    for a in record.get("attributes", [])
                    if a.get("value")
                }
                if attributes.get("strands.box.policy.verdict") == "deny":
                    yield attributes


def main():
    with open(records_file(time.time()), encoding="utf-8") as records:
        while True:
            line = records.readline()
            if not line:
                time.sleep(0.5)
                continue
            try:
                request = json.loads(line)
            except ValueError:
                continue
            if not isinstance(request, dict):
                continue
            for a in denials(request):
                rule = a.get("strands.box.policy.rule") or a.get("strands.box.policy.cause", "")
                action = a.get("strands.box.policy.action", "?")
                resource = a.get("strands.box.policy.resource", "?")
                print(f"[box] DENY {action} {resource} (rule {rule})", flush=True)


main()
