# The image that runs this agent in a box: `boxy run` is the entry point, and boxy starts the agent
# ({{codeLocation}}) in its sandbox. This file is yours: `agentcore create` wrote it to
# {{codeLocation}}/Dockerfile, and you may edit it, for example to apt-get a system package.
#
# agentcore builds it from the project root, so the paths below are relative to the root. A
# .dockerignore that agentcore writes there lets in only app/ and .box-build/, and keeps out host
# venvs and .env files. agentcore stages .box-build/{{runtimeName}}/ on each dev, build, and deploy
# with what comes from outside the project:
#   boxy/                  boxy and its helpers, prebuilt for Linux arm64 (AGENTCORE_BOXY_BIN),
#                          and boxy's resources/ (AGENTCORE_BOXY_SOURCE)
#   box-container/         the container profile: box/profile.toml with container settings,
#                          box/policy.dw if you wrote one, and the agentcore-container pack
#   entrypoint.sh          prepares the container and starts boxy
#
# The same image runs locally (`agentcore dev`) and on AgentCore Runtime, which runs linux/arm64.

# TODO(box-poc): use released boxy binaries once they ship.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim-bookworm

# curl reads the execution role from instance metadata in entrypoint.sh; setpriv and umount are in
# the base image (util-linux, mount).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir uv

# boxy runs as `box` (uid 1000); its home holds boxy's state and the AWS profile box-runtime.
RUN useradd -u 1000 -m box

# The agent's environment is outside its workspace, because boxy runs no program from a folder the
# agent can write. The container profile sets python.venv and python.runtime to these paths.
ARG UV_DEFAULT_INDEX
ARG UV_INDEX
ENV UV_NO_CACHE=1 UV_COMPILE_BYTECODE=1 UV_NO_PROGRESS=1 \
    UV_PYTHON=/usr/local/bin/python3.12 UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/agent-venv \
    UV_DEFAULT_INDEX=${UV_DEFAULT_INDEX} UV_INDEX=${UV_INDEX}
WORKDIR /app/{{codeLocation}}
COPY {{codeLocation}}/pyproject.toml {{codeLocation}}/uv.lock* ./
RUN if [ -f uv.lock ]; then uv sync --frozen --no-dev --no-install-project; \
    else uv sync --no-dev --no-install-project; fi

# boxy, its two helper programs, and its resources (packs) sit in one folder: Box Core finds the
# helpers beside the running boxy, and boxy finds resources/ beside itself.
COPY .box-build/{{runtimeName}}/boxy/ /opt/boxy/
RUN chmod 0755 /opt/boxy/boxy /opt/boxy/strands-box-sock-alias /opt/boxy/strands-box-contain-trampoline

# The project: the agent's code (the workspace, which the agent may write) and the container
# profile in /app/.box/profile, outside the workspace.
COPY {{codeLocation}}/ /app/{{codeLocation}}/
COPY .box-build/{{runtimeName}}/box-container/ /app/.box/profile/
COPY .box-build/{{runtimeName}}/entrypoint.sh /entrypoint.sh
RUN chown -R box:box /app/{{codeLocation}} && chmod 0755 /entrypoint.sh

# boxy's workspace is the folder it starts in: the agent's code.
ENV AGENT_WORKSPACE=/app/{{codeLocation}}
WORKDIR /app/{{codeLocation}}
# Box listens here ([agent.ingress] in the container profile) and relays to the agent's own 8080.
EXPOSE 8080
# No USER line: the entry point runs as root to uncover /proc, then drops to uid 1000.
ENTRYPOINT ["/entrypoint.sh"]
