# Security Policy

## Supported Versions

Security updates are provided only for the **latest stable release** of `playcanvas-opti-pixel` published on [npm](https://www.npmjs.com/package/playcanvas-opti-pixel).

A **stable version** is always a release in the `X.Y` form (for example `1.1`, `2.0`, `2.1`).

Versions with a patch component (`X.Y.Z`, for example `1.0.1`, `1.0.13`) are **not** considered stable. Pre-release, alpha, beta, RC, and other non-stable tags are also not stable.

The following are **not** considered supported for security fixes:

- Non-stable `X.Y.Z` releases (for example `1.0.1`)
- Older stable `X.Y` releases once a newer stable version is available
- Pre-release, alpha, beta, RC, or other non-stable tags
- Unpublished commits, forks, or custom builds not matching an npm release

| Version | Supported          |
| ------- | ------------------ |
| Latest stable (`X.Y`, e.g. `1.1`, `2.0`, `2.1`) | :white_check_mark: |
| Older stable `X.Y` releases | :x: |
| Non-stable `X.Y.Z` (e.g. `1.0.1`) | :x: |
| Pre-releases / non-stable tags | :x: |

We recommend always upgrading to the latest stable `X.Y` version from npm. When a vulnerability is fixed, the fix is typically released as a new stable `X.Y` version.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately. Do **not** open a public GitHub issue or pull request that discloses the vulnerability.

Prefer one of these channels:

1. **GitHub private vulnerability reporting**  
   [Report a vulnerability](https://github.com/AlexAPPi/playcanvas-opti-pixel/security/advisories/new)

Please include as much of the following as possible:

- Description of the vulnerability and its impact
- Steps to reproduce, or a proof of concept
- Affected versions / commit hashes
- Suggested fix, if you have one

## What to expect

- You should receive an initial response within a few days.
- If the report is confirmed, a fix will be prepared and released as soon as practical.
- Please do not publicly disclose the issue until a fix has been published, or you have agreed otherwise with the maintainers.

Thank you for helping keep this project and its users safe.
