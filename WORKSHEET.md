# Worksheet: one request, one answer, who checks what

Run the step-by-step commands in README.md once (`npm test` keeps its own files in `.demo-test/`),
then open `out/request.json` and the `out/response-<id>.json` next to it. This page walks through
both.

## The request (`out/request.json`)

| Part | Made by | Checked by |
|---|---|---|
| envelope: a JSON object with a string `id` and a usable `issuer` | requester | space: otherwise an unsigned `malformedRequest`, exit 2 (nobody to address an answer to) |
| `type` `…/acl/grant/0.2` | requester | space: any other type gets a signed `unsupportedType` before any other check, the proof check included (ToIP's order) |
| `payload.entry` (subject, role, scopes) | requester | space: ToIP payload schema (ajv) |
| `issuer` (requester `did:key`), `recipient` (the space's trust-task `did:key`) | requester | space: `recipient` must be its own DID |
| `issuedAt`, `expiresAt` | requester | space: freshness. A request is accepted for 5 minutes after `issuedAt` (ToIP's default for consequential tasks) and never after `expiresAt` |
| `id` | requester | space: duplicate record, kept in the AD4M space (a resend is answered with the earlier answer, never run twice; `respond` twice returns the same signed answer) |
| `proof` `eddsa-jcs-2022`, `proofPurpose` `assertionMethod` | requester's key, via `@openvtc/trust-tasks-proof` | `demo.mjs`, same library. **Not AD4M.** |

The checks are ToIP's `consumeInbound` pipeline. Any failure answers with a signed
`trust-task-error` and nothing is stored, so no flow starts. The exception is a file that is not
JSON or has no usable `id`/`issuer`: there is nobody to answer, so `receive` stops (exit 2) and
signs nothing.

## What the space stores

One `IiwTrustTaskRequest` instance in the space: `raw` is the request file's text, byte for byte;
the other fields (`taskId`, `issuer`, `subject`, `role`, `digest`, …) are copies for querying. The class
is defined from a JSON Schema (`Ad4mModel.fromJSONSchema`). AD4M signs each link it writes with the
writing agent's key, in AD4M's own format (not a Data Integrity proof).

## The decision

Flow `iiw://TrustTaskDecisionFlow` runs on that instance: `Received → Accepted` needs 2 distinct voters,
`Received → Rejected` needs 1. The two voters are two AD4M agents with their own DIDs: in local mode
alice (a user on the node) and bob (the node's own agent); in shared mode each on their own node.
Each vote is a link signed by the voter's agent. `mintFlowReceipt` and
`verifyFlowReceipt` work the state out from those links each time. (`status` shows the state the
node last worked out, a cache.) `n:2` counts any two distinct voters in the space; it does not check
roles. Both votes name the request instance as the run's output,
so the quorum signs a hash of the instance's content, `raw` included.

## The answer (`out/response-<id>.json`)

| Part | Made by | Checked by |
|---|---|---|
| `type` `…#response` (or `trust-task-error`, code `permissionDenied`, when rejected) | `demo.mjs` (`respondWith` / `rejectWith`) | requester: matches the receipt's terminal state |
| `threadId` = request `id`; `recipient` = requester | `demo.mjs` | requester |
| `payload.entry` | copied from the request | requester's proof check covers it |
| `ext["org.coasys.ad4m"].flowReceipt.receipt` | AD4M `mintFlowReceipt` | the space's node: AD4M `verifyFlowReceipt` → `verified` (re-derives the state from the carried signed votes) |
| `flowReceipt.uri` / `sha256` | AD4M: `ad4m://flow/receipt/<sha256 of the receipt, keys sorted>` | requester: recomputes the hash |
| `receipt.outputs[0].content` → `raw` | the quorum committed to it | requester: its digest equals the request it sent ("decided on my exact document") |
| `flowReceipt.terminalState` | `demo.mjs`, from the verdict | requester: must equal the receipt body's `terminal_state` and match the answer's kind |
| `flowReceipt.voters` | `demo.mjs`, from the verdict | nobody: it is what the space reports, covered by its signature. The requester does not check it against the votes inside the receipt |
| `proof` `eddsa-jcs-2022` | the space's trust-task key, held by `demo.mjs` (a throwaway `did:key`, not an AD4M agent key) | requester |

## What nobody in this demo checks

- The requester does not re-check the AD4M signatures on the votes inside the receipt. Only AD4M
  nodes do (`verifyFlowReceipt`; `demo.mjs check-receipt` runs it on any member's node). The requester
  trusts the space's key for that.
- Nothing ties the space's trust-task `did:key` to the two AD4M agent DIDs that voted.
- The requester checks the flow's name (`flow_uri`), not its rules. The receipt's `flow_dna_hash`
  identifies the states and quorums, but the requester cannot recompute it without AD4M; a space could
  run a flow with the same name and `Accepted` at one vote.
- No permission changes when the grant is accepted. The `entry` in the answer is what the space
  recorded, not an access rule AD4M enforces.

## Try it

- Change the role in `out/request.json` and `receive` it: `proofInvalid`, nothing stored.
- `vote reject --as bob` on a new request, then `respond`: a `trust-task-error` that still carries the
  receipt, with one voter.
- Change one character inside `flowReceipt.receipt` in a response: `requester.mjs verify` fails at
  "proof" (the response is signed). The test suite also re-signs such a response to show the receipt
  hash check failing on its own.
