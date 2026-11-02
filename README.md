# Antigravity ACP Server

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server for
Google Antigravity's `agy` CLI, built on [Bun](https://bun.com). It lets any
ACP-compatible editor drive `agy`: it spawns the CLI, streams its progress live,
and replays conversation history on demand.

## ⚠️ Terms of Service risk

Google's [Antigravity Terms of Service](https://antigravity.google/terms) state:

> You must not abuse, harm, interfere with, or disrupt the Service. This
> includes, but is not limited to, using the Service in connection with
> products not provided by us. Using third party software, tools, or services
> to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a
> breach of this Agreement. Such actions may be grounds for suspension or
> termination of your account.

`antigravity-acp` does not itself request, store, or process any
authentication credentials — it only spawns the official `agy` binary as a
subprocess and talks to it over stdio; all Google OAuth login is handled
entirely by `agy` itself, outside of this project. However, the *effect* is
still a non-Google, ACP-compatible editor driving `agy` (and therefore your
Antigravity account) through a third-party tool — the exact pattern Google's
FAQ names as a Terms of Service violation (Claude Code, OpenClaw, OpenCode,
and by extension this project).

**By using `antigravity-acp` with an `agy` session logged into your personal
Antigravity account, you accept the risk that Google may suspend or terminate
that account.** This project is provided as-is, with no warranty, and its
authors and contributors accept no liability for any account action Google
takes as a result of its use. If you want to avoid this risk entirely, Google
recommends authenticating with a Vertex AI or AI Studio API key instead of an
Antigravity OAuth login.

See [#3](https://github.com/shubzkothekar/antigravity-acp/issues/3) for
background.

## Run

**From source (Bun required):**

```bash
bun run index.ts          # ACP over stdio
bun run index.ts --version
```

**As a compiled single-executable (no Bun required):**

```bash
dist/agy-acp-darwin-arm64   # macOS Apple Silicon
dist/agy-acp-darwin-x64     # macOS Intel
dist/agy-acp-linux-arm64    # Linux ARM64
dist/agy-acp-linux-x64      # Linux x86-64
dist/agy-acp-windows-arm64.exe # Windows ARM64
dist/agy-acp-windows-x64.exe   # Windows x86-64
```

Both modes speak ACP over stdio — point your editor at the binary as-is.

## agy auto-install

The server locates `agy` at startup using this priority order:

1. An `agy` binary placed next to the executable (`dist/agy`, or `bin/agy` when
   running from source after `bun install`).
2. `$AGY_BIN` — set this to point at your own build.
3. `agy` on `$PATH`.

If none are found the server downloads the matching release from GitHub
(`google-antigravity/antigravity-cli`) and verifies its SHA-256. The download is
skipped when `AGY_SKIP_DOWNLOAD=1` or `$AGY_BIN` is set.

`bun install` runs the same download via the `postinstall` hook, so a plain
`bun install` also provisions `agy` for source runs.

## Flags / env

| | |
|---|---|
| `AGY_BIN` | Path to an `agy` binary; skips the auto-download |
| `AGY_SKIP_DOWNLOAD` | Set to `1` to skip the download entirely |
| `AGY_EXTRA_ARGS` | Extra args forwarded to every `agy` invocation |
| `AGY_CONVERSATIONS_DIR` | Custom directory where `agy` writes its conversation SQLite databases |

## Mid-turn steering (native hook plugin)

The server can accept a second plain-text `session/prompt` while a turn is
already running. Instead of starting another `agy -p` process, it queues the
text for the active run and asks the installed Antigravity hook plugin to
inject it before the next model call. The original prompt stays pending until
its `agy -p` child exits.

Install the native Antigravity plugin from this repository:

```bash
agy plugin install "<path-to-this-repo>/plugin"
agy plugin list --json
```

The plugin directory contains only `plugin.json`, `hooks.json`, and the Bun
helper. It does not write or replace the user's global
`~/.gemini/config/hooks.json`. The helper is a no-op when
`AGY_ACP_STEER_IPC` is absent, so other `agy` sessions started by the user are
unaffected.

The server advertises `_meta.midTurnSteering: true` only when the plugin is
installed, enabled, and the runtime can provide the local IPC endpoint. If the
plugin is absent or disabled, clients should keep the existing interrupt
fallback; a concurrent prompt during an active run is rejected rather than
starting another process.

Behavior and limits:

- Only plain text is accepted for mid-turn steering. Slash commands and
  resource/image blocks are rejected while a run is active.
- Every pending steer claimed by one `PreInvocation`/`PostInvocation` is
  injected in FIFO order. `PostInvocation` uses `force_continue` so a steer
  arriving after the final model output is still consumed.
- The owner-validated `conversationId` returned by the hook is the
  authoritative conversation binding for a native steering run. It is
  validated against the active run and session; a fresh steering run does not
  guess its conversation DB from a directory snapshot.
- A steer is acknowledged only after the active run's SQLite trajectory
  contains the matching new raw user-input text. The server sends the
  `user_message_chunk` with that raw text and the row's step index as
  `messageId`; hook output alone is not treated as proof, and literal XML or
  resource-link text is not passed through the normal display parser.
- If the child exits, the run is cancelled, or no matching row appears, the
  pending steer fails explicitly and is not retried automatically.
- Stop/close/cancel revoke the run's queue and reject pending steers. A later
  prompt can start a fresh run.
- Windows currently keeps the interrupt path because the steering IPC uses a
  Unix domain socket.

To disable or remove the plugin:

```bash
agy plugin disable agy-acp-steer
agy plugin uninstall agy-acp-steer
```

The steering path was validated with `agy` 1.4.12, a loopback fake GenAI
gateway, and a signed-in Gemini 3.8 Flash run. The real-model check kept the
wait tool running, inserted the correction into the same trajectory, and
wrote the corrected result without cancellation.

## BB fork maintenance

This repository is a personal fork of the third-party
[`shubzkothekar/antigravity-acp`](https://github.com/shubzkothekar/antigravity-acp)
project, not an official Google ACP implementation. The BB runtime copy was
installed from npm `antigravity-acp@1.1.0`; all 43 installed files matched the
npm tarball byte-for-byte. The only local customization was a wrapper that
warms `~/.agy-acp/models.json` before the ACP server starts, because BB reads
the model catalog immediately after `session/new`.

This fork is based on upstream `1.2.0` and carries that wrapper as
`agy-entry.mjs`. It defaults to `agy` on `$PATH`; set `AGY_BIN` to use another
binary:

```bash
AGY_BIN=/path/to/agy bun ./agy-entry.mjs
```

Creating this fork does not upgrade or change the current BB runtime provider
configuration.

`origin` is `hxy91819/antigravity-acp`; `upstream` is
`shubzkothekar/antigravity-acp`. Update the fork with:

```bash
git fetch upstream
git merge --no-autostash upstream/main
```

Keep fork-specific changes in `agy-entry.mjs`; there is no separate patch
registry.

## Build (Single Executable Application)

```bash
bun run build:mac-arm64    # → dist/agy-acp-darwin-arm64
bun run build:mac-x64      # → dist/agy-acp-darwin-x64
bun run build:linux-arm64  # → dist/agy-acp-linux-arm64
bun run build:linux-x64    # → dist/agy-acp-linux-x64
bun run build:win-arm64    # → dist/agy-acp-windows-arm64.exe
bun run build:win-x64      # → dist/agy-acp-windows-x64.exe
bun run build:all          # all six at once
```

The compiled binary embeds the entire TypeScript source and all dependencies. It
auto-downloads `agy` on first launch if not present next to the executable.

## ACP surface

- **initialize** — advertises `loadSession`, `additionalDirectories`,
  `list`/`delete`/`resume`/`close`, `embeddedContext`.
- **session/new** — accepts `cwd` and `additionalDirectories`; returns the session configuration options (including modes and available models).
- **session/set_config_option** — model and mode selection; persisted per session.
- **session/load** — replays full conversation history from the `agy` SQLite DB,
  including tool calls, task/permission/error decorators, and title updates.
- **session/resume** — re-attaches a client and re-sends `available_commands_update` and `config_option_update` notifications.
- **Post-session notifications** — after every `session/new`, `session/load`, and
  `session/resume` the server sends `available_commands_update` → `config_option_update` in order, so the UI can render the mode picker and model selector immediately.

## Architecture

```
index.ts                      entry: startup, agy auto-install, ACP wiring
src/
  acp/                        ACP surface
    server.ts                 Bun stdio <-> ndJsonStream <-> agent
    agent.ts                  initialize / session.* / prompt / cancel
    sessions.ts               in-memory registry + eviction
    adapter.ts                prompt turn: spawn agy, poll, stream
    client.ts                 AgentContext wrapper (notify / request)
  agy/
    binary.ts                 resolve binary: SEA-local / bin/ / $AGY_BIN / PATH
    installer.ts              shared download + SHA-256 verify + extract logic
    process.ts                Bun.spawn, arg building, model discovery
  constants/
    index.ts                  shared constants (paths, poll intervals, modes, commands)
  conversation/
    database.ts               bun:sqlite reader (reusable handle)
    scan.ts                   discover new conversation DBs
    translator.ts             shared step -> ACP engine (stream + replay)
    streaming.ts              live poll loop (stream mode)
    replay.ts                 history replay + incremental cache
    columns.ts                error / permission / task decoders
    updates.ts                per-step dispatcher
  updates/                    per-tool ACP builders + shared utils
  store/sessionStore.ts       persistent session bindings (atomic, serialized writes)
  narration/                  narration filter
  gen/steps.ts                generated protobuf
  types/                      type definitions (session, step row)
  utils/lru.ts                small LRU
scripts/
  postinstall.ts              npm install hook: download agy into bin/
```

### Shared streaming/replay engine

Live streaming and history replay differ only in how they treat the agent's
growing text stream. Everything else — tool calls, titles, user prompts, and the
task/permission/error enrichment — is identical, so both drive a single
[`Translator`](src/conversation/translator.ts):

- **stream** emits the newly-appended text slice each poll and dedups tool steps
  it has already sent;
- **replay** buffers consecutive agent-text parts and flushes them as one message
  at each boundary.

### Caching & performance

- **Incremental replay cache** ([replay.ts](src/conversation/replay.ts)): replays
  are cached per conversation and validated by file `(mtime, size)`. An unchanged
  conversation returns instantly; a conversation that merely grew has only its new
  tail of steps read and translated, then appended. (agy DBs are append-only.)
- **Reused DB handle**: the live poll loop keeps one `bun:sqlite` handle +
  prepared statement open for the whole turn instead of reopening each tick.
- **Bun-native throughout**: `bun:sqlite`, `Bun.spawn`, `Bun.stdin`/`Bun.stdout`,
  `Bun.file`/`Bun.write` — no `better-sqlite3`, `protobufjs` runtime, or
  node-stream shims.

## Test

```bash
bun run typecheck
bun test
```
