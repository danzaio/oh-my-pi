# SoL-Pi in this fork (OMP bridge)

SoL-Pi (`NVlabs/SoL-Pi`, MIT) ships pinned as a submodule at
`third-party/sol-pi` (`2ecee02e116d3a13b2304ccf6c770d7bc4675660` at the time of
writing). Zero edits inside `third-party/sol-pi`. To update the pin:

```bash
cd third-party/sol-pi && git fetch origin && git checkout <NOVO_SHA> && cd ../.. \
  && git add third-party/sol-pi && git commit -m "Bump SoL-Pi to <NOVO_SHA>"
```

## Clone

```bash
git clone --recurse-submodules git@github.com:danzaio/oh-my-pi.git
# or, on an existing clone:
git submodule update --init --recursive
git submodule status   # third-party/sol-pi <SHA>, no `-` prefix
```

## Upstream checks (inside `third-party/sol-pi`)

Protocol from the submodule's `agents-install.md` — no `|| true`:

```bash
git status --short --branch
git rev-parse HEAD
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
npx vitest run tests/all-mechanisms.test.ts
```

## Link the bridge (only the bridge, never the raw submodule)

```bash
omp plugin link ./third-party/sol-pi-omp
omp plugin list   # omp-sol-pi-bridge enabled; third-party/sol-pi must NOT appear
```

Linking `third-party/sol-pi` itself next to the bridge registers all four
mechanisms twice — prohibited. Plugin state is per-machine, not committed.

## Where each surface lives

- Day to day: `/settings` → Tools → Extensions (4 toggles + 2 free-text
  provider/model fields + cache ratio submenu), and
  `omp config {list,get,set} solPi.*` — no extra code, both read the schema.
- Fallback hand-edit: `sol-pi.json`, user-wide `<agentDir>/sol-pi.json`
  (≈ `~/.omp/agent/sol-pi.json`) or project `<cwd>/.omp/sol-pi.json`.
  Project replaces user-wide without merging. If both exist, stop and ask
  before touching either.
- Merge rule (`third-party/sol-pi-omp/src/resolve-config.ts`): settings win
  only where touched (`isConfigured`); the rest keeps the file value, so
  upstream semantics survive. A `/settings` change takes effect from the
  next session — same granularity as editing the file. Ratio accepts any
  finite non-negative number; `0` is explicit (cache write free), invalid
  values fall back to the file. Blank provider/model strings fall back to
  the file, then to built-ins (`openai-codex` / `gpt-5.6-luna`).

## Templates

All-off (identical to upstream defaults — this is the no-config state):

```json
{
	"version": 1,
	"actionFusion": false,
	"observationPack": false,
	"evidencePreservingReducer": false,
	"evidencePreservingReducerModel": "gpt-5.6-luna",
	"evidencePreservingReducerProvider": "openai-codex",
	"onlineContextCompact": false,
	"cacheWriteReadRatio": 12.5
}
```

Conservative (validation + handles, no remote calls):

```json
{
	"version": 1,
	"actionFusion": true,
	"observationPack": true,
	"evidencePreservingReducer": false,
	"evidencePreservingReducerModel": "gpt-5.6-luna",
	"evidencePreservingReducerProvider": "openai-codex",
	"onlineContextCompact": false,
	"cacheWriteReadRatio": 12.5
}
```

All-enabled (replace provider/model with real values):

```json
{
	"version": 1,
	"actionFusion": true,
	"observationPack": true,
	"evidencePreservingReducer": true,
	"evidencePreservingReducerProvider": "provider-id",
	"evidencePreservingReducerModel": "model-id",
	"onlineContextCompact": true,
	"cacheWriteReadRatio": 12.5
}
```

Validate a hand-edited file from inside the submodule:

```bash
node scripts/check-sol-pi-config.mjs --config /absolute/path/to/sol-pi.json [--require-all-enabled]
```

## Evidence-Preserving Reducer warning

Read `third-party/sol-pi/SECURITY.md` before enabling. When on, eligible log
content goes to the configured reducer model via Pi-managed auth — never
enable it for logs that must stay local. The likely-secret detector is a
precaution, not a complete scanner.

Without configuring anything, all four mechanisms stay off.
