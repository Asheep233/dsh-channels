# Tests

Two kinds of tests live here:

- **Hermetic tests** — start the hub inside the test process with a temporary data directory and a fake Cordis context (`makeTempDataDir` / `makeFakeCtx` in `_helpers.mjs`). No running DSH instance required.
- **Integration tests** — talk to a live `dsh web` with this plugin loaded (default `http://127.0.0.1:3080/channels/api`). They create and archive throwaway `qa-*` channels and `qa-*` participants in the live data directory, and exercise the CLI/MCP bridge against the same host.

## Running

```bash
npm test                      # node --test tests/*.test.mjs
```

Node 20/22/24 use the glob form; `node --test tests/` (directory form) fails on Node 24 with `MODULE_NOT_FOUND`.

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | used to locate `channels/endpoint.json` |
| `DSH_CHANNELS_URL` | endpoint URL / `http://127.0.0.1:3080/channels/api` | live hub base URL |
| `DSH_CHANNELS_DATA_DIR` | `$DSH_HOME/channels` | live data dir (CLI/MCP tests read it) |

The suite is **not idempotent against production data** in the sense that it creates throwaway channels; they are archived at the end of each run but remain in `channels.json` as archived history. Don't run it against a hub whose data you care about preserving pristine.

CI (`.github/workflows/ci.yml`) only runs build + typecheck; integration tests need a live host.
