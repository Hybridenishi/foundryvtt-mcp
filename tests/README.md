# Testing

Two suites, for two different failure classes. Neither substitutes for the
other.

## Automated tests

Deterministic code — parsers, route handlers, confirmation binding, tool
registration. Run with:

```bash
npm test
```

This builds the TypeScript server, then runs `sidecar/*.test.js`,
`module/scripts/*.test.mjs`, and `dist/register.test.js` (compiled from
`src/register.test.ts`). All of it runs against fakes; none of it needs a
live Foundry host.

Add a test here whenever you fix a bug in code that has an assertable
input/output — that's what catches the next regression automatically.

## Natural-language scenarios (`scenarios/`)

Agent *behavior* — whether the agent reaches for the right tool, previews
before applying, surfaces an error instead of working around it, or reads
prose like `dataProvenance.interpretation` correctly — can't be asserted by
`node --test`. It has to be run by an agent against a live deployment, which
is what these scenario files are for.

Each scenario is a **re-runnable case with explicit expectations**, not a
transcript. That's what makes it catch a regression on a later run, rather
than merely record one.

### Running a scenario

1. Have a live sidecar + GM bridge deployment reachable (`npm run
   smoke:foundry -- --require-bridge` should pass first).
2. Open the scenario file, resolve its placeholders (`<PC-A>`, `<actor-id>`,
   etc.) against your actual world, and hand the `## Prompt` to your MCP
   client as-is.
3. Compare the agent's tool calls and responses against `## Expect` and
   `## Must not`.
4. If it fails, write down what happened under `regressions/`, named after
   the scenario and dated, and fix the underlying issue. Once the scenario
   passes again, set `regression-for:` on the scenario to the fixing commit.

### Placeholders, not real data

Use placeholders (`<PC-A>`, `<actor-id>`) for every piece of world data — never
paste in real character names, actor IDs, or campaign content.
[`docs/FINDINGS.md`](../docs/FINDINGS.md) already anonymizes this table's
characters as "Character A/B/C/D" for the same reason; scenario files and any
archived transcript under `regressions/` should follow the same convention,
since both are checked into git.

## `regressions/`

Empty until a scenario run actually finds a defect. A transcript lands here
only when it caught something — this directory is a record of failures
found and fixed, not a general run log. Old passing runs go stale fast and
nobody re-reads them; keep the signal-to-noise ratio high.
