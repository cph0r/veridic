# Privacy

Veridic collects nothing and sends nothing.

- It runs entirely on your machine. There is no account, no telemetry, no analytics and no network call from its scripts.
- It reads your repository's files, its git history and a local code index in `.codegraph/`.
- It writes only that index and the files you ask for (specs, reports, test skeletons).
- It runs [CodeGraph](https://github.com/colbymchenry/codegraph) to build the index, always with CodeGraph's telemetry switched off (`CODEGRAPH_TELEMETRY=0`).
- It runs your tests only when you ask (`--run`), and installs nothing unless you pass `veridic init --install`.
- Its Claude Code Stop hook runs only in repos that opted in (`.veridic.json`), and only reads the repo and its index.

Questions: [open an issue](https://github.com/cph0r/veridic/issues).
