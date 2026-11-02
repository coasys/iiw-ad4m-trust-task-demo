# AD4M and ToIP trust tasks: a runnable demo

*Coasys, for IIW 43 / AIW Interop Day, November 2026. DRAFT: tested on AD4M `dev` at bd9d34e2e; the version numbers and commands below
are checked against AD4M v0.13.1 once that release exists.*

## AD4M in three lines

AD4M is an agent-centric runtime you run yourself. Each agent is an Ed25519 `did:key`, and every piece
of data it writes is a link signed by that key. Groups share these graphs and agree on changes
through **flows**: state machines whose state is derived from signed votes, so anyone holding the
links can re-check how a decision was made.

## What the demo does

A builder runs an AD4M node on a laptop (tested: AD4M `dev` at bd9d34e2e with `@coasys/ad4m`
0.13.1-staging.5; v0.13.1 once released) and two plain
JavaScript files with Node: `demo.mjs` for the AD4M side, one command per step, and `requester.mjs`
for the other party.

1. `demo.mjs show` puts the ToIP trust task `acl/grant/0.2` next to the AD4M social DNA it becomes: a
   class for the stored request and a flow with its states, transitions and vote counts.
2. `demo.mjs agent --as bob` creates the node's agent (the passphrase is asked for, never stored unless you
   ask); `demo.mjs users add alice` adds a second person on the node with her own DID. `demo.mjs
   space` makes a space (an AD4M perspective) and installs the class and flow in it.
3. `requester.mjs request` makes the trust task ("give Carol the role `member`") and signs it
   `eddsa-jcs-2022` with its own Ed25519 `did:key`, using ToIP's TypeScript libraries.
4. `demo.mjs receive` checks it with ToIP's consumer pipeline (proof, recipient, payload schema,
   freshness, duplicates), stores the original JSON byte for byte in the space, and starts the flow:
   `Received → Accepted` needs two voters, `Received → Rejected` needs one.
5. `demo.mjs vote accept --as alice`, then `--as bob`: two people, each with their own DID, vote
   through the flow with their own signatures.
6. `demo.mjs respond`: when the flow ends, AD4M mints a **flow receipt** (content-addressed: its
   address is the SHA-256 of its body; it carries the signed votes and the exact request the group
   decided on) and verifies it; the space answers with a signed `#response` or `trust-task-error`
   that includes the receipt.
7. `requester.mjs verify` checks the answer's proof, recomputes the receipt hash, and checks that the
   receipt names the exact document it sent. A request changed after signing is refused before
   anything is stored or any flow starts.

Two modes. **Local**: one node; alice is a user on it (AD4M's multi-user mode) and bob is the node's
own agent. Needs no network after `npm ci`. **Shared**: alice and bob each run a node; alice
publishes the space as a neighbourhood (`share`, over Holochain or a link server), bob joins it by
URL and votes from his own node. Bob's node can re-check the receipt too. More users on one node
share a space the same way.

## Mapping

| Trust-task piece | In the demo | What AD4M provides |
|---|---|---|
| `issuer` / `recipient` | each party has an Ed25519 `did:key` | every AD4M agent is an Ed25519 `did:key`. The space's trust-task key in this demo is a separate key held by `demo.mjs` |
| `proof` (`eddsa-jcs-2022`) | made and checked by the JS files with ToIP's library | AD4M signs its own links, and can sign a string with the agent key (`agent.signMessage`), but emits no Data Integrity proof. The demo keeps the trust-task key separate rather than building a proof on that call |
| the task document | stored losslessly as one value, plus typed fields from a class defined by a JSON Schema | spaces (perspectives) and subject classes |
| outcome: `#response` / error | the group's flow decides; the response carries the flow receipt and its hash | flows, signed votes, `mintFlowReceipt`, `verifyFlowReceipt` |
| transport | JSON files between requester and space | the node's WebSocket API for its client; neighbourhoods (Holochain) between members' nodes. No HTTPS, DIDComm or TSP trust-task binding |

## What it shows, and what it does not

It shows a standard trust task checked with ToIP's reference code, decided by a group through signed
votes (on one node, or on two nodes that share the space), and answered with portable evidence of
how the group decided, bound to the exact request.

It does not show:
- AD4M producing or checking `eddsa-jcs-2022`: `demo.mjs` does that with its own throwaway key.
- A permission change: accepting the `acl/grant` records it in the space; no AD4M permission changes.
- The requester re-checking AD4M's signatures inside the receipt: AD4M's `verifyFlowReceipt` does that
  on the members' nodes; the requester checks the hash and the binding to its request.

## Identity direction

AD4M's next identity step is `did:scid`: a self-certifying identifier backed by a key event log, so an
agent can rotate keys and others can check the history. It is in review
(starting at [coasys/ad4m #1539](https://github.com/coasys/ad4m/pull/1539)) and **not in v0.13.1**, so the
demo uses `did:key`. With it, a trust task's `issuer` could be a rotatable AD4M identity.

## Run it

`README.md` in the demo folder: until v0.13.1 is out, build the executor from AD4M `dev` at
bd9d34e2e (afterwards, download the v0.13.1 executor), run
`./start-node.sh init` and `./start-node.sh run`, then `npm ci` and the steps one by one, or
`npm test`. Node 22 or newer.

Contact: Nicolas Luck, Coasys — [contact line: Nico fills in] · github.com/coasys/ad4m
