"""`agentcore dev`: write the AWS profile box-runtime from the developer's credentials.

The credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, or else from
the profile AWS_PROFILE (default `default`) in AWS_SHARED_CREDENTIALS_FILE, the ~/.aws that dev
mounts. Usage: python3 local_credentials.py <output file>
"""
import configparser
import os
import sys

KEYS = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")


def from_environment():
    keys = {name: os.environ.get(name) for name in KEYS}
    if keys["AWS_ACCESS_KEY_ID"] and keys["AWS_SECRET_ACCESS_KEY"]:
        return keys, "the environment"
    return None


def from_profile():
    path = os.environ.get("AWS_SHARED_CREDENTIALS_FILE", "")
    profile = os.environ.get("AWS_PROFILE", "default")
    parser = configparser.RawConfigParser()
    if not (path and parser.read(path) and parser.has_section(profile)):
        sys.exit("no AWS credentials passed in")
    section = parser[profile]
    keys = {
        "AWS_ACCESS_KEY_ID": section.get("aws_access_key_id"),
        "AWS_SECRET_ACCESS_KEY": section.get("aws_secret_access_key"),
        "AWS_SESSION_TOKEN": section.get("aws_session_token"),
    }
    if not (keys["AWS_ACCESS_KEY_ID"] and keys["AWS_SECRET_ACCESS_KEY"]):
        sys.exit(f"profile {profile} has no static keys")
    return keys, f"profile {profile}"


def main():
    keys, source = from_environment() or from_profile()
    lines = [
        "[box-runtime]",
        f"aws_access_key_id = {keys['AWS_ACCESS_KEY_ID']}",
        f"aws_secret_access_key = {keys['AWS_SECRET_ACCESS_KEY']}",
    ]
    if keys["AWS_SESSION_TOKEN"]:
        lines.append(f"aws_session_token = {keys['AWS_SESSION_TOKEN']}")
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"entrypoint: local dev; your AWS credentials ({source}) written for profile box-runtime")


main()
