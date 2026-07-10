# Project integration

The framework is designed to be embedded inside existing TypeScript repositories.

## Directory model

Recommended structure:

```text
my-project/
  package.json
  tsconfig.json
  src/
  .simple-agent-orchestrator/
    orchestrator.ts
    channels/
    clients/
    environments/
    prompts/
    state/
    logs/
    tmp/
```

The orchestrator directory can import code from your project:

```ts
import { fetchRecentReviewCandidates } from "../../src/lib/github/reviews";
```

The app should generally not import from `.simple-agent-orchestrator`. Keep the dependency direction as:

```text
.simple-agent-orchestrator -> project code
project code              -> does not need orchestrator config
```

## Config discovery

`simple-agent-orchestrator start` discovers config in this order:

1. `--config <path>` if provided.
2. `.simple-agent-orchestrator/orchestrator.ts` under the detected project root.
3. A package.json pointer:

```json
{
  "simpleAgentOrchestrator": {
    "config": ".simple-agent-orchestrator/orchestrator.ts"
  }
}
```

You can also run with an explicit root:

```bash
npx simple-agent-orchestrator start --root packages/api
```

## Project context

`defineConfig` receives a `project` context:

```ts
export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
}));
```

Available helpers:

```ts
project.root
project.orchestratorDir
project.packageJson
project.resolve("src")
project.fromRoot("src")
project.fromOrchestrator("prompts/review.md")
project.statePath("state.json")
project.cachePath("scratch")
```

Use these helpers instead of long relative path chains.

## TypeScript loading

The runtime loads `.ts`, `.mts`, and `.cts` config files through `tsx`. It does not type-check config at runtime; use your editor or `tsc` for type checking.

The init command creates `.simple-agent-orchestrator/tsconfig.json` so your editor can type-check orchestrator files in the context of your project.

## Runtime state

The template stores mutable state under:

```text
.simple-agent-orchestrator/state/state.json
```

The state directory is git-ignored by default.

You can change the store in `orchestrator.ts`:

```ts
export default defineConfig(({ project }) => ({
  store: jsonFileStore(project.statePath("state.json")),
}));
```

The store interface is intentionally small so you can add a database-backed adapter later.
