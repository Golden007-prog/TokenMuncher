# Security

TokenMuncher reads the logins that Claude Code, Cursor and the GitHub CLI keep on your computer, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately:

1. Go to the [Security tab](https://github.com/bartoszclapinski/TokenMuncher/security) of the repository.
2. Click **Report a vulnerability** and describe the problem and how to reproduce it.

Only the maintainer sees the report. This is a hobby project with one maintainer; expect a first answer within a week.

Do not include real tokens or credential files in a report. A description of where the problem is and how to trigger it is enough.

## What counts

- A login or token that is stored, logged, shown, or sent anywhere other than the server of the tool it belongs to.
- Usage data leaving the computer.
- A way to make the app run code or an installer that did not come from this repository's releases.
- A problem in the update check, the download or its checksum verification.

## Supported versions

Only the [latest release](https://github.com/bartoszclapinski/TokenMuncher/releases/latest) gets fixes. The app updates itself from GitHub releases.

## Verifying a download

Every release lists the SHA-256 of its installers in the notes and in `SHA256SUMS.txt`. The app checks a downloaded update against the checksum GitHub reports for the release file before starting it. The installers are not code-signed.
