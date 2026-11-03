"""Pass the runtime's Gateway and Memory variables to the agent.

The agent sees only [agent.env], not the container's environment. The CDK sets these variables on
AgentCore Runtime, and `agentcore dev` sets the Gateway ones the same way. This appends each one to
[agent.env], which agentcore writes as the last table of the container profile.

Only exact name shapes pass (an allowlist, not a prefix match): AGENTCORE_GATEWAY_<NAME>_URL/_ARN/
_AUTH_TYPE, MEMORY_<NAME>_ID/_ARN, and the imported GATEWAY_<ID>_* forms. The container's environment
also holds secrets (AGENTCORE_CREDENTIAL_<NAME>, the env:// secrets boxy reads), and none may reach
the agent. A value must be printable ASCII without spaces (a URL, an ARN, an id), so it is a safe
TOML string. A name the profile already sets keeps its value.

It also narrows the Gateway route. On the first deploy the profile can only allow any Gateway in
the region (*.gateway.bedrock-agentcore.<region>.amazonaws.com), because a Gateway's host has an id
that exists only once the Gateway is created. At start the URLs are known, so the route names
exactly their hosts.

Usage: python3 agent_env.py <container profile.toml>
"""
import json
import os
import re
import sys
import tomllib
from urllib.parse import urlparse

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
    text = narrow_gateway_route(text)
    text += "".join(f"{name} = {json.dumps(os.environ[name])}\n" for name in names)
    tomllib.loads(text)  # still valid TOML, or nothing is written
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"entrypoint: passed to the agent: {', '.join(names) or 'nothing'}")


# The route agentcore writes when the Gateways' hosts are not known yet.
WILDCARD_ROUTE = re.compile(
    r'^(\[egress\.agentcore-gateway\]\n)destinations = \[ "\*\.gateway\.bedrock-agentcore\.'
    r'([a-z]{2}(?:-[a-z]+)+-\d+)\.amazonaws\.com" \]$',
    re.M,
)
GATEWAY_URL = re.compile(r"(AGENTCORE_GATEWAY|GATEWAY)_[A-Z0-9_]+_URL")


def narrow_gateway_route(text):
    """Replace the Gateway route's `*` with the hosts of the AGENTCORE_GATEWAY_<NAME>_URL values."""
    match = WILDCARD_ROUTE.search(text)
    if not match:
        return text
    suffix = f".gateway.bedrock-agentcore.{match.group(2)}.amazonaws.com"
    hosts = sorted(
        {
            host
            for name, value in os.environ.items()
            if GATEWAY_URL.fullmatch(name)
            for host in [urlparse(value).hostname or ""]
            if host.endswith(suffix) and re.fullmatch(r"[a-z0-9-]+", host[: -len(suffix)])
        }
    )
    if not hosts:
        return text
    print(f"entrypoint: the Gateway route allows only {', '.join(hosts)}")
    listed = ", ".join(json.dumps(host) for host in hosts)
    return text[: match.start()] + f"{match.group(1)}destinations = [ {listed} ]" + text[match.end() :]


main()
