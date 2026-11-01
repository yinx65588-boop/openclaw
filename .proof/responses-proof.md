# Custom Responses runtime-context proof

Production candidate: b7389fa399e7bbbd183c80dd0caf367a4d32a17a.
Unchanged production baseline: 47cb40a3b3f0d74a3e78ec95076a365d5b75d1ee.

The fixture starts a synthetic loopback Responses service, invokes the shipped
`pnpm openclaw agent --local` command in two independent processes using one
isolated session, and executes a real file-read tool in each turn. Four HTTP
requests must complete successfully before it checks historical carrier positions
and the exact serialized input prefix after reopening. No paid provider is used.

Baseline proof: https://github.com/yinx65588-boop/openclaw/actions/runs/41318309791
Repaired proof: https://github.com/yinx65588-boop/openclaw/actions/runs/41317880294
Unit/integration baseline: https://github.com/yinx65588-boop/openclaw/actions/runs/41316746564

The linked workflows contain the pinned checkout/setup/build commands and run the
fixture inside a loopback-only network namespace with isolated HOME/config/state.
Download their artifacts for CLI stdout/stderr, result.json, request-ledger.json,
original exit status, fixture source and the exact tested delta. The baseline CLI
exits 1 on missing historical retention after all four requests; its workflow
checks that exact failure. The repaired CLI exits 0 with its whole earlier input
preserved as a prefix.

This readable fixture is the final baseline fixture. The repaired run predates a
classifier correction: it checked whether a carrier appeared anywhere as well as
requiring the complete exact input prefix. The final fixture checks the carrier
at its original index too, so identical current temporal text cannot be mistaken
for historical retention. The production patch and prefix assertion are unchanged.

Both variants use synthetic zero-priced usage. The proof establishes serialized
request stability, not live provider cache hits, billing or latency improvement.