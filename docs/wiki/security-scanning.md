# Security Scanning

RemitLend uses Trivy to scan container images for known vulnerabilities (CVEs) during the deployment process to staging and production.

## Exception Process (.trivyignore)

If a vulnerability is flagged but is considered a false positive, not applicable to our environment, or an acceptable risk while waiting for a patch, you can add it to the `.trivyignore` file located at the root of the repository.

### How to ignore a vulnerability:

1. Open `.trivyignore`.
2. Add a comment explaining **why** the vulnerability is being ignored and, if applicable, until when.
3. Add the CVE identifier on the next line.

Example:
```
# axios SSRF / credential-leak advisory. Not exploitable here: we never pass
# user-controlled URLs to axios and always set an explicit baseURL.
# Re-evaluate once the base image ships axios >= 1.6.0. See issue #123
CVE-2023-45857
```
