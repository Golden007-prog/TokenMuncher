# Contributing to TokenMuncher

Thanks for wanting to help. Bug reports, fixes and new features are welcome.

This is a hobby project with one maintainer, so answers can take a few days.

## Reporting a problem

1. In the app, open *Settings → about* and click **`[ copy diagnostics ]`**. The report has versions, settings and counts. It has no logins, tokens, conversation text or project names.
2. Open a [bug report](https://github.com/bartoszclapinski/TokenMuncher/issues/new/choose), describe what you see, and paste the report.

Issues are public. Do not paste tokens, the contents of credential files, or screenshots with data you want to keep private.

**Security problems** do not go into issues. See [SECURITY.md](SECURITY.md).

## Proposing a change

1. **Open an issue first** (or comment on an existing one) and say what you want to do. This avoids work on something that will not be merged. Typo and documentation fixes can skip this step.
2. Fork the repository and make a branch from `main`.
3. Make **one change per pull request**. Mention the issue in the description (`Closes #N`).
4. The maintainer reviews and merges. `main` only takes pull requests.

## Running it

You need Windows 10 or 11, Node.js 22 and npm.

```sh
npm install
npm start     # run from source
npm test      # unit tests
```

Two switches make development safe next to an installed copy:

| Variable | Effect |
|---|---|
| `TM_DEMO=1` | made-up projects, sessions and limits. No requests, no real data. Use this for screenshots. |
| `TM_PROFILE=<dir>` | separate settings and data, so your installed copy is not touched |

The README has the [full list of switches and a code map](README.md#for-developers).

## What a pull request needs

- **Tests pass** (`npm test`), and logic you add or change has tests. The logic lives in pure modules (`src/main/*.js`, `src/shared/*.js`) that are tested without Electron; keep it that way.
- **Checked in the running app**, not only in tests. Say in the description what you checked and what you could not check.
- **Screenshots from demo mode only** (`TM_DEMO=1`), never with real usage data.
- **The README is updated** when behaviour, settings or files on disk change.
- **No version bump and no release files.** The maintainer sets the version when releasing.
- Code, comments and commit messages are in English. Comments say what the code is for, not what it does line by line.

## Logins and the network

TokenMuncher reads the logins of other tools, so these rules are strict. A pull request that breaks one is not merged.

- A login is only **read**, and sent only to **the server of the tool it belongs to**. It is never stored, logged, refreshed or shown.
- **No new network destinations** without a reason agreed in the issue first. No telemetry and no analytics, ever.
- **No new dependencies** without a reason agreed in the issue first. Each one is code that runs next to those logins.
- A new data source says in the README what it reads and where it sends it.

## What is out of scope

- Comparing models by cost alone ("this session would have cost X on another model"). The result of the work cannot be measured, so the comparison means little.
- Anything that sends usage data off the computer.
- Logos or mascots of other products. Skins use colour palettes only, and every mascot is original pixel art.

## License

By contributing, you agree that your contribution is licensed under the [MIT license](LICENSE) of this project.
