"""Write the AWS profile box-runtime from the execution role's credentials.

Reads the IMDS credential document (JSON) on stdin and prints the profile to stdout:
  curl ... | python3 imds_credentials.py > /home/box/.aws/credentials.tmp
"""
import json
import sys

document = json.load(sys.stdin)
sys.stdout.write(
    "[box-runtime]\n"
    f"aws_access_key_id = {document['AccessKeyId']}\n"
    f"aws_secret_access_key = {document['SecretAccessKey']}\n"
    f"aws_session_token = {document['Token']}\n"
)
