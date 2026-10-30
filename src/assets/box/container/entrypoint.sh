#!/bin/sh
# The container's entry point, after Ravi's examples/beatbox/docker/entrypoint.sh in Box Core. It
# runs as root, prepares the container, and starts boxy as the ordinary user `box` (uid 1000):
#
#   Step 1. Uncover /proc, so Box can mount a fresh /proc for the agent's sandbox.
#   Step 2. On AgentCore Runtime, write the AWS profile `box-runtime` from the execution role.
#   Step 3. Start boxy: `boxy run /app/.box/profile` from the agent's folder (the workspace).
set -u

# --- Step 1: uncover /proc --------------------------------------------------------------------------
# The container runtime covers some paths under /proc (and /sys/firmware). The kernel refuses Box's
# fresh /proc for the agent while they are covered, so remove every cover, deepest first. The list
# comes from the mount table, so it follows whatever the runtime actually covered.
awk '$5 ~ "^/proc/" || $5 == "/sys/firmware" {print $5}' /proc/self/mountinfo \
  | sort -r | while read -r p; do umount "$p" || echo "entrypoint: could not unmount $p"; done
remaining=$(awk '$5 ~ "^/proc/" {print $5}' /proc/self/mountinfo | wc -l)
echo "entrypoint: covers over /proc remaining: $remaining"

# --- Step 2: the AWS profile box-runtime, from the execution role -----------------------------------
# On AgentCore Runtime, Box signs the model and AgentCore Gateway requests with the profile
# `box-runtime` (`secret.ref = "aws://box-runtime"` in the AWS profile), and Box does not read
# instance metadata. So copy the execution role's credentials from the instance metadata endpoint
# (IMDSv2) into that profile, and refresh it every 15 minutes. Only uid 1000 can read the file; the
# agent's sandbox neither sees it nor reaches the endpoint (boxy's policy blocks IMDS).
# `agentcore dev` sets LOCAL_DEV=1: locally the profile routes use env:// secrets, so skip this.
IMDS=http://169.254.169.254/latest
write_credentials() {
  token=$(curl -sf -m 3 -X PUT "$IMDS/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300") || return 1
  role=$(curl -sf -m 3 -H "X-aws-ec2-metadata-token: $token" "$IMDS/meta-data/iam/security-credentials/") || return 1
  document=$(curl -sf -m 3 -H "X-aws-ec2-metadata-token: $token" "$IMDS/meta-data/iam/security-credentials/$role") || return 1
  mkdir -p /home/box/.aws && chown box:box /home/box/.aws && chmod 0700 /home/box/.aws
  printf '%s' "$document" | python3 -c '
import json, sys
d = json.load(sys.stdin)
sys.stdout.write("[box-runtime]\naws_access_key_id = %s\naws_secret_access_key = %s\naws_session_token = %s\n"
                 % (d["AccessKeyId"], d["SecretAccessKey"], d["Token"]))
' > /home/box/.aws/credentials.tmp || return 1
  chown box:box /home/box/.aws/credentials.tmp && chmod 0600 /home/box/.aws/credentials.tmp
  mv /home/box/.aws/credentials.tmp /home/box/.aws/credentials
  echo "entrypoint: execution role credentials written for profile box-runtime (role $role)"
}
if [ "${LOCAL_DEV:-}" = "1" ]; then
  echo "entrypoint: local dev; no AWS profile box-runtime"
elif write_credentials; then
  ( while sleep 900; do write_credentials >/dev/null || echo "entrypoint: credential refresh failed"; done ) &
else
  echo "entrypoint: no instance metadata endpoint; using whatever AWS profile is mounted"
fi

# --- Step 3: start boxy -----------------------------------------------------------------------------
# Box needs no root, so drop to uid 1000 first; the agent then maps to uid 1000 outside its sandbox,
# not to 0. boxy compiles /app/.box/profile (the container profile), and Box starts its trusted half
# (the egress gateway, policy, and the ingress listener on :8080) and the agent in its sandbox. The
# container's environment (the env:// secrets) reaches boxy, and not the agent.
cd "${AGENT_WORKSPACE:?}" || exit 1
exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/box \
  /opt/boxy/boxy run /app/.box/profile
