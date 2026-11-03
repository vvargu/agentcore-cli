"""Pass the runtime's Gateway and Memory variables to the agent.

The agent sees only [agent.env], not the container's environment. The CDK sets these variables on
AgentCore Runtime, and `agentcore dev` sets the Gateway ones the same way. This appends each one to
[agent.env], which agentcore writes as the last table of the container profile.

Only exact name shapes pass (an allowlist, not a prefix match): AGENTCORE_GATEWAY_<NAME>_URL/_ARN/
_AUTH_TYPE, MEMORY_<NAME>_ID/_ARN, and the imported GATEWAY_<ID>_* forms. The container's environment
also holds secrets (AGENTCORE_CREDENTIAL_<NAME>, the env:// secrets boxy reads), and none may reach
the agent. A value must be printable ASCII without spaces (a URL, an ARN, an id), so it is a safe
TOML string. A name the profile already sets keeps its value.

Usage: python3 agent_env.py <container profile.toml>
"""
import json
import os
import re
import sys
import tomllib

NAME = re.compile(r"(AGENTCORE_GATEWAY|AGENTCORE_MEMORY|GATEWAY|MEMORY)_[A-Z0-9_]+_(URL|ARN|ID|AUTH_TYPE)")
VALUE = re.compile(r"[\x21-\x7e]*")


def main():
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    headers = re.findall(r"^\s*\[[^\]]+\]", text, re.M)
    if not headers or headers[-1].strip() != "[agent.env]":
        sys.exit("entrypoint: the container profile does not end with [agent.env]; passed nothing")
    already = set(tomllib.loads(text).get("agent", {}).get("env", {}))
    names = sorted(
        name
        for name, value in os.environ.items()
        if NAME.fullmatch(name) and VALUE.fullmatch(value) and name not in already
    )
    with open(path, "a", encoding="utf-8") as f:
        for name in names:
            f.write(f"{name} = {json.dumps(os.environ[name])}\n")
    print(f"entrypoint: passed to the agent: {', '.join(names) or 'nothing'}")


main()
