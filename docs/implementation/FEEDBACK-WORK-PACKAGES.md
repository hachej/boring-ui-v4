# Feedback: implementation sequence and work packages

This is the delivery breakdown of [FEEDBACK.md](../architecture/FEEDBACK.md), which owns the
design and the laws FEEDBACK-1..8. Packages here restate no decision; they say
who builds what, in which order, against which checks. Base revision for every
package: `main` at `026988f`. A package that starts on a later `main` names its
own base.

Every package follows `AGENTS.md`:

- an isolated worktree;
- its owned files and allowed `ARCHITECTURE.json` edges only;
- behavior lands with tests, a driven control or journey, and a
  [FEATURES.md](FEATURES.md) row;
- raw evidence stays under `.cache/evidence/`;
- `npm run check`, `npm test` and `npm run verify` pass before and after;
- runtime proofs that a package does not discharge stay registered as pending
  in `VERIFY.json`. A structural check is never relabelled as a runtime proof.

## Sequence

```
WP0 contracts ─┬─ WP1 format ──┬─ WP4 store ──┬─ WP6 agent tool ─┬─ WP7 phase-1 qualification
               │               │              │                  │
               └─ WP2 anchor kit ─ WP3 markdown pins ─ WP5 annotate UI ┘
                                                     │
WP7 ─┬─ WP8 ask action
     ├─ WP9 privacy canaries ─ WP10 evidence & retention ─ WP11 transcription & dictation
     └─ WP12 sync spike ───────────────┐
WP2 ─ WP13 HTML artifacts (bridge, stamping, picker) ─ WP14 application pages (recorder, replay) ─ WP15 canvas, image, PDF
                                        WP10, WP11, WP12 ┘
WP16 consumer work (other repositories): boring-app source plugin, hub migration
```

The phases of FEEDBACK.md map onto packages as follows:

| Phase | Packages |
| --- | --- |
| 0 | WP0–WP2 |
| 1 | WP3–WP7 |
| 2 | WP8 |
| 3 | WP9–WP11 |
| 4 | WP12–WP14 |
| 5 | WP15 |

**What can run in parallel:**

- WP1 and WP2 after WP0;
- WP3 and WP4 after WP1 and WP2;
- WP8, WP9 and WP12 after WP7;
- WP13 after WP2. It can start early because it touches only the HTML viewer
  and the bridge.

**One integrating owner per cross-package contract:**

- WP0 owns `@boring/ui/contracts` anchor types;
- WP1 owns `feedback@1`;
- WP4 owns the store interface.

Later packages propose changes to these contracts; they do not edit them in
place.

## Plan amendment carried by these packages

FEEDBACK.md's package table gains one server-side subpath, `@boring/feedback/store`:

- create, list, read, resolve and delete over the host's injected resource
  boundary;
- used by the agent capability and by host routes;
- so the browser and the agent never build publication requests
  independently.

WP0 adds it to FEEDBACK.md together with the edges.

---

## WP0 · Contracts and boundaries

**Goal:** the shapes and edges everything else builds on, with no behavior yet.

- **Depends on:** nothing.
- **Owns:**
  - `packages/feedback/` (package skeleton, `package.json` exports `./format`,
    `./store`, `./agent`, `./ui`, `./transcription`);
  - the anchor section of `packages/ui/src/contracts.ts`;
  - `ARCHITECTURE.json`, `VERIFY.json` and `docs/LAWS.md` entries;
  - `test/packages/feedback.test.mjs`;
  - the isolated-consumer script.
- **Edges:**
  - `feedback/format` → `ui/contracts` (type-only), `files` contracts
    (type-only);
  - `feedback/store` → `format`, `files` contracts;
  - `feedback/agent` → `format`, `store`, `agent`, Pi peers;
  - `feedback/ui` → `format`, `ui`;
  - `feedback/transcription` → `format`.

  No existing package gains an edge to `feedback`.

**Spec:**

- In `@boring/ui/contracts`:
  - `Anchor` (`{ kind: \`${string}.${string}@${number}\`; fallback: string }`
    plus kind data);
  - `Placement<Range>` with `exact | moved | ambiguous | partial | missing |
    unsupported`, each carrying `evaluated`;
  - `AnchorResolution<A, Snapshot, Range>` (`kind`, `schema`, `resolve`,
    `fallback`);
  - `AnchorCapture<A, Selection, Subject>` (`anchorOf`, `reveal` as a
    `PresentationCommand`);
  - `ViewerAnchors = { resolution, capture? }`.

  All function members are `readonly` properties. Nothing is a runtime value.
- **`ViewerFeature`** gains no required member. Anchor support is declared
  beside the feature (`anchors?: ViewerAnchors`), so existing features compile
  unchanged.
- **Each subpath** exports a typed empty surface (no placeholders that
  pretend behavior). The `VERIFY.json` runtime slots for FEEDBACK-1..8 are
  registered as `pending`, naming the package that discharges each.

**Invariants:**

- FEEDBACK-5 structural: dependencies point one way. The boundary test fails
  on any import of `@boring/feedback` from `packages/ui`, `files`, `agent` or
  `execution`, or from the headless UI root.
- BORING-PI-5: no browser subpath reaches the server filesystem or Pi runtime.
  The `./transcription` and `./store` subpaths are server-only and absent from
  the browser bundle check.
- Erased declarations need no behavior test; every runtime file added later
  needs `test/packages/feedback*.test.mjs` importing the public entry.

**Tests:**

- boundary mutants: an inserted forbidden import must fail;
- an isolated tarball consumer type-checks each subpath;
- the browser bundle of `./ui` contains no `node:` module.

**Not in scope:** any behavior; the registry item; changes to existing viewers.

**Done when:** check, test and verify pass; the laws are indexed; the pending
runtime slots are visible in `verify` output.

## WP1 · The `feedback@1` format

**Goal:** one pure serializer and parser for the report, ported in part from the hub.

- **Depends on:** WP0.
- **Owns:** `packages/feedback/src/format/*`, `test/packages/feedback-format.test.mjs`.

**Spec:**

- **Parsing and serializing.**
  - `parseFeedback(bytes) → { ok: true, report } | { ok: false, problems }`
    and `serializeFeedback(report) → Uint8Array`.
  - Front matter is YAML restricted to a safe subset: no anchors, aliases,
    tags or custom types.
  - The body has the fixed sections `## Said`, `## Timeline` and
    `## Resolution`, plus a constant preface.
- **Fields:**
  - `format`;
  - `id`, `fb_` plus 16 characters from a cryptographic random source through
    `@boring/files/platform`;
  - `status` (`open | addressed`);
  - `author` (`principalId` and display, filled by the host, never by
    content);
  - `created`;
  - `observed` (`locator`, `revision`, `dirty`, `digest`);
  - `anchors[]`, opaque to the format except `kind` and `fallback`;
  - `evidence` (references with `staged | committed | unavailable`, and
    `truncated`).
- **Rendering.**
  - `renderReport({ said, timeline, … })` produces the body.
  - The timeline summary (steps, console, failed requests, runs) is ported
    from boring-hub `hub/captures/timeline.mjs`, typed and with the same
    caps and overflow notes.
- **Publication builders.** `createRequest`, `resolveRequest` and
  `deleteRequest` return a `PublicationRequest`:
  - create: `expected: absent`;
  - resolve: `replace` at the revision read;
  - each takes the caller's `operationId`.

  Builders never perform I/O.
- **The untrusted preface is one exported constant.**

**Invariants:**

- FEEDBACK-1: every producer serializes only through `serializeFeedback`.
- FEEDBACK-2 (structural): the parser refuses a report missing a body section,
  an anchor without a non-empty `fallback`, or a missing `observed`.
- FEEDBACK-3: an unknown anchor kind round-trips byte-identically through
  parse and serialize.
- Local: `parse(serialize(r))` deep-equals `r`. `serialize(parse(b))` is
  canonical and idempotent. Rendering escapes Markdown control sequences in
  every captured string, so captured text cannot forge a section heading or a
  front-matter fence.

**Tests:**

- property tests for round-trip and canonical form;
- forged-heading and fence-injection fixtures;
- unknown-kind round-trip;
- hub timeline parity fixtures (the hub's report for the same events, modulo
  format);
- caps with explicit overflow notes.

**Not in scope:** storage, anchors' meaning, UI.

**Done when:** the FEEDBACK-1, 2 and 3 structural checks are registered and
passing.

## WP2 · The anchor conformance kit

**Goal:** the test kit every anchor adapter must pass, before any real adapter exists.

- **Depends on:** WP0.
- **Owns:**
  - `packages/ui/src/anchor-conformance.ts`, exported as
    `@boring/ui/anchor-conformance`, a test-only entry;
  - `test/fixtures/anchors/`;
  - `test/packages/ui-anchor-conformance.test.mjs`.

**Spec:**

- `testAnchorAdapter({ resolution, capture?, corpus })` runs on `node:test`.
- `corpus` is a list of `{ before: Snapshot, selection, edits: Edit[],
  expect: 'exact' | 'moved' | 'ambiguous' | 'partial' | 'missing', truth?:
  Range }`.
- The kit checks:
  - same snapshot → `exact` at the captured range;
  - after each edit, the placement kind is one the case allows, and
    `exact`/`moved` equal `truth`;
  - **a wrong spot counts as a failure regardless of the expected kind**;
  - `resolve` is deterministic (repeated calls deep-equal) and does no I/O
    (globals for fetch, timers and the filesystem are trapped);
  - the anchor's schema round-trips;
  - `fallback` is non-empty.
- **Mutation generators:** move, duplicate, reword, delete, split and merge,
  for text-like snapshots. Adapters supply their own for structured
  snapshots.
- **A synthetic adapter** (`test.line@1`, anchoring by line content and
  neighbours) proves the kit is not shaped around Markdown.
- The kit reports the re-anchoring rate per mutation class as evidence,
  without a pass threshold.

**Invariants:** FEEDBACK-4 (structural part) and FEEDBACK-3 (unknown kind →
`unsupported`, exercised through a resolution registry built from adapters).

**Tests:** the kit's own mutants: an adapter that guesses a near match on an
ambiguous corpus must fail; an adapter calling `Date.now()` in `resolve` must
fail.

**Not in scope:** real viewers.

**Done when:** the synthetic adapter passes, and the deliberately broken
adapters fail with readable reasons.

## WP3 · Markdown pins (`markdown.quote@1`) — spike first

**Goal:** the first real adapter, with zero wrong spots on a real edit corpus.

- **Depends on:** WP2.
- **Owns:**
  - `packages/ui/src/markdown-anchors.ts` (resolution, server-safe) and its
    capture glue in `markdown-mounted.ts`;
  - `test/fixtures/anchors/markdown/`;
  - `test/packages/ui-markdown-anchors.test.mjs`.

**Spike (time-boxed, recorded in `.cache/evidence/`):**

- Build the corpus from fictional documents: real edit sequences taken from
  this repository's own Markdown history (docs only, fictional content), plus
  the generators.
- Compare exact quote matching with a W3C text-quote and fuzzy approach
  (quote, prefix and suffix scoring with a position hint, as Hypothesis
  does).
- Pick the thresholds.
- The spike ends with a written result: wrong spots (must be 0) and the
  re-anchoring rate.

**Spec:**

- The anchor is `{ kind: 'markdown.quote@1', quote, prefix, suffix, headingPath,
  hint: { start }, fallback }`, with prefix and suffix up to 32 characters.
- **Capture** uses the mounted `inspect` result: the current selection over
  the current buffer, whether dirty or not.
- **Resolve:**
  - a unique best match above the threshold, with its runner-up below the
    ambiguity margin, is `exact` (same offsets) or `moved`;
  - two candidates within the margin are `ambiguous`;
  - a quote found with a changed interior is `partial`;
  - otherwise `missing`.
- **Reveal** uses the existing mounted `select` and `revealHeading` on the
  bound target. It refuses unless the placement is `exact` or `moved`.

**Invariants:**

- FEEDBACK-4 on the full corpus with zero wrong spots;
- FEEDBACK-6: capture records `dirty` and the buffer digest.

**Tests:**

- the WP2 kit over the corpus;
- dirty-buffer capture;
- a reveal on a stale mount returns `stale`;
- duplicate passages produce `ambiguous`.

**Not in scope:** the annotation UI; any non-Markdown viewer.

**Done when:** the spike result is recorded and the kit passes with zero wrong
spots.

## WP4 · The feedback store

**Goal:** stored feedback with conditional writes and recovery, usable headless.

- **Depends on:** WP1.
- **Owns:**
  - `packages/feedback/src/store/*`;
  - `test/packages/feedback-store.test.mjs`;
  - `test/contracts/feedback-store-crash.test.mjs`.

**Spec:**

- **The API.** `createFeedbackStore({ resources, root, protectedRoot })` gives:

| Method | Does |
| --- | --- |
| `create(report, { operationId })` | Conditional create (`expected: absent`) |
| `read(id)` | `{ report, revision } \| missing \| denied \| unavailable` |
| `list({ status?, subject? })` | Reads the root; skips invalid files and reports them as `invalid`, never throws |
| `resolve(id, { expectedRevision, note, operationId })` | Conditional replace; the note is appended to `## Resolution` |
| `remove(id, { expectedRevision, operationId })` | Deletion, with a tombstone record kept under the root |

- **Lost replies:**
  - an unknown outcome is reconciled by looking up the `operationId` before
    any retry;
  - a matching completed operation returns its original result;
  - a mismatched digest returns `conflict`.
- **`protectedRoot`** is the host's declaration that native working tools
  cannot write `root`. Without it, `createFeedbackStore` still works but
  reports `guarantees.oneWriter = 'unavailable'`, and the agent capability
  surfaces that.

**Invariants:**

- FEEDBACK-1 (runtime part, for this layer);
- FEEDBACK-7: the store has no permission API; `denied` comes only from the
  host boundary;
- FILES-GIT-EXEC "Working writes and publication": the store uses only
  `PublicationRequest`, never a filesystem write.

**Tests:**

- two concurrent creators (distinct ids, both stored);
- competing resolutions (one `applied`, one `conflict` with the current
  revision);
- a lost reply after commit, reconciled without duplicating the note;
- a hard kill between commit and acknowledgement, using the existing SQLite
  reference provider and crash-test pattern;
- an invalid file in the root is listed as `invalid`;
- with a protected mount declared, a native file write to the root is refused
  (fixture provider).

**Not in scope:** evidence blobs (WP10), UI, agent.

**Done when:** crash and concurrency tests pass on the SQLite reference
provider.

## WP5 · Annotation UI for Markdown, and the registry item

**Goal:** a person annotates Markdown, copies the report or saves it, and
reviews saved feedback. No agent is involved.

- **Depends on:** WP3; WP4 for Save.
- **Owns:**
  - `packages/feedback/src/ui/*` (headless state for the annotate sheet, Copy
    report, the list and viewer data hooks);
  - `registry/feedback/*` (`AnnotateButton`, `AnnotateSheet`,
    `FeedbackReport`, `FeedbackList`);
  - the `registry.json` entry;
  - `test/packages/feedback-ui.test.mjs`;
  - a studio demo `examples/studio/demos/feedback-markdown/`.

**Spec:**

- **Annotate** reads the viewer's capture half and opens the sheet with the
  anchor's fallback shown. Typing is required in this package.
- **Copy report** renders through `./format` and writes to the clipboard
  through `@boring/files/platform` helpers. It works with no store
  configured.
- **Save** is shown only when a store endpoint is configured. It calls the
  host route over `./store`, with a fresh `operationId` kept across retries of
  the same Save.
- **The viewer** shows the report and resolves anchors with the server-safe
  resolution. **Reveal** is enabled only for `exact` and `moved`; an
  `ambiguous` result lists its candidates for the person to choose.
- The registry item depends on `@boring/feedback` `./format` and `./ui`, never
  `./agent`. Its CSS is scoped to `[data-boring="feedback"]`, as the other
  items are.

**Invariants:**

- FEEDBACK-2 (Copy works with nothing installed but annotation);
- FEEDBACK-5 (an app with the registry item and no agent);
- FEEDBACK-7 (reveal refuses uncertain placements).

**Tests:**

- DOM tests for the sheet, Copy and Save retry;
- an installed-recipe consumer test, following
  `scripts/test-registry-consumer.mjs`;
- a studio browser journey: annotate a dirty buffer, copy, save, reload,
  reveal, and pick a candidate when ambiguous.

**Not in scope:** dictation, the picker, recordings.

**Done when:** the journey passes and the recipe consumer test passes.

## WP6 · The agent capability: the `feedback` tool

**Goal:** an agent reads, shows and resolves feedback through one tool.

- **Depends on:** WP4, WP3.
- **Owns:**
  - `packages/feedback/src/agent/*`;
  - `registry/pi-chat/feedback-card.tsx` and its wiring in `pi-chat.tsx`;
  - `test/packages/feedback-agent.test.mjs`;
  - a studio builder agent in the WP5 demo.

**Spec:**

- `createFeedbackCapability({ store, placements, actions? })` returns
  `{ extension }`, one native `Extension`:
  - a prompt section: the root, the untrusted-content rule, and when to use
    each action;
  - one tool `feedback` with `replay: 'safe'`.
- **The tool's parameters** are a flat object:
  - `action: 'list' | 'show' | 'resolve'`, with `ask` added in WP8;
  - optional `status`, `subject`, `id`, `anchor`, `expectedRevision` and
    `note`.

  Fields are checked per action, and a missing field returns an error naming
  it.
- **`list`** returns compact text: id, title (from `## Said`), subject, age,
  and placement per anchor.
- **`show`** sends a target-bound reveal through the host's page-command
  channel and returns the `PresentationResult` verbatim. It refuses
  uncertain placements.
- **`resolve`** derives its `operationId` from the tool call id, so a replay
  is reconciled by the store.
- **A disabled action** is refused with its reason.
- **`guarantees.oneWriter = 'unavailable'`** is stated in the prompt section
  and in `list` output.
- **The pi-chat feedback card** renders `@feedback/…` mentions and `feedback`
  tool results. It contains a validator copy kept equal by a source test, as
  the artifact card does.

**Invariants:**

- FEEDBACK-5: an agent without the extension has an unchanged tool list and
  prompt (snapshot test).
- FEEDBACK-7: the tool grants nothing; `show` honest results.
- BORING-PI-3: removing the extension leaves an ordinary agent.

**Tests:**

- native ToolTask execution of each action;
- replaying a `resolve` call does not duplicate the note;
- the disabled-action refusal;
- `show` on a disposed viewer returns `stale`;
- the agent-without-extension snapshot;
- a feedback card DOM test.

**Not in scope:** `ask` (WP8).

**Done when:** a native tool test and the studio builder can list, show and
resolve against the SQLite reference store.

## WP7 · Phase-1 qualification journey

**Goal:** prove phase 1 end to end, including the failure cases, before
anything else builds on it.

- **Depends on:** WP5, WP6.
- **Owns:**
  - `examples/studio/demos/feedback-markdown/journey.mjs`;
  - `FEATURES.md` rows;
  - the `VERIFY.json` runtime entries it discharges.

**Spec:**

- One driven Chromium journey with a fake model:
  1. annotate a dirty buffer;
  2. save and reload;
  3. copy the report and paste it into the chat;
  4. the agent lists the item;
  5. the agent shows it, and the reveal is applied;
  6. the agent edits the document and resolves the item.
- Then the failure cases:
  - an ambiguous anchor (duplicate passage) is refused for reveal and picked
    by the person;
  - a lost reply on resolve is reconciled;
  - two browser contexts annotate and resolve at once, with one `conflict`
    shown;
  - an edit that deletes the passage makes the item `missing` in `list`.
- A separate model-judged check gives a plain agent with no extension and no
  viewer only `feedback.md` and asks what and where. It is recorded as
  evaluated behavior, not as a gate (FEEDBACK-2).

**Invariants:** FEEDBACK-1 to 6 runtime proofs for Markdown.

**Not in scope:** new behavior. Fixes found here go back to their owning
package.

**Done when:** the journey passes twice in a row; its evidence is under
`.cache/evidence/feedback-markdown/`; the discharged `VERIFY.json` slots name
it.

## WP8 · The `ask` action

**Goal:** the agent asks the person to point at something, durably.

- **Depends on:** WP7.
- **Owns:**
  - the `ask` action in `packages/feedback/src/agent/*`;
  - `registry/pi-chat/point-card.tsx`;
  - `test/packages/feedback-ask.test.mjs`;
  - `test/contracts/feedback-ask-crash.test.mjs`.

**Spec:**

- `ask` admits a question through the existing `@boring/agent/questions`
  mechanism (host `authorize` and `isCurrent`). The question's subject digest
  binds the requested subject.
- The person answers by annotating in the point card.
- The browser publishes the feedback first (`create` with an `operationId`),
  then resolves the question with the feedback id as the answer.
- **On restart between the two steps,** reconciliation finds the published
  feedback by `operationId` and resolves the question with it, so nothing is
  created twice.
- **A stale browser target** (the viewer was closed or the revision changed)
  does not cancel the question; the card asks the person to reopen the
  subject.

**Invariants:**

- FEEDBACK-6: the answer is bound to the question;
- FEEDBACK-7: the question's answer is information, never a grant (as the
  questions module states);
- BORING-PI-1: the native wait remains authoritative.

**Tests:**

- a pending question survives a restart;
- a hard kill between publish and resolve reconciles to one feedback and one
  answer;
- the stale target keeps the question pending;
- an answer to the wrong subject is refused.

**Not in scope:** dictation in the card (it arrives with WP11 through the
shared sheet).

**Done when:** the crash tests pass and the studio journey gains an `ask` step.

## WP9 · Privacy canaries and mask-by-default — spike first

**Goal:** prove masking holds before any recording or snapshot ships.

- **Depends on:** WP7.
- **Owns:**
  - `packages/feedback/src/ui/privacy/*`, the masking policy shared by the
    recorder, picker and snapshots;
  - `test/kits/privacy-canaries.mjs`, exported for applications;
  - `test/packages/feedback-privacy.test.mjs`.

**Spike:**

- Run rrweb with mask-all-text plus `data-feedback-visible` unmasking on the
  studio's fictional screens.
- Record the false-mask rate (how much useful text was hidden) and confirm
  zero canary leaks.
- Decide the default unmask list (labels and buttons the application marks).

**Spec:**

- One masking policy object, `maskAllText: true` by default:
  - unmasking only through `data-feedback-visible` on an ancestor;
  - inputs always masked unless the field also carries
    `data-feedback-visible`;
  - URL query strings and fragments dropped;
  - request and response bodies never recorded.
- Snapshot serialization for `app.element@1` uses the same policy.
- **The kit:** `testPrivacyCanaries({ render, journeys, canaries })` records
  each journey through the real recorder, picker and snapshot paths. It fails
  if any canary appears in the events, console, requests, report, anchors,
  fallbacks or snapshots, compared case-insensitively and after HTML-entity
  decoding.
- The host authorization hook (`authorizeCapture(kind, subject)`) is called
  before recording, snapshotting or transcription. A refusal stops capture.

**Invariants:** FEEDBACK-8 (masking and authorization), checked through the
canary kit.

**Tests:**

- the kit on the studio fixture;
- mutants: an element without the unmask attribute must stay masked, and a
  deliberately unmasked canary must fail the kit.

**Not in scope:** the recorder itself (WP14). This package builds the policy
the recorder must use.

**Done when:** the spike result is recorded, the kit is exported, and its
mutants fail correctly.

## WP10 · Evidence and retention

**Goal:** audio and replays can be kept and deleted honestly.

- **Depends on:** WP4, WP9.
- **Owns:**
  - `packages/feedback/src/store/evidence.ts`;
  - `test/packages/feedback-evidence.test.mjs`;
  - `test/contracts/feedback-evidence-crash.test.mjs`.

**Spec:**

- **Evidence port.** `EvidenceStore { stage(bytes, mediaType, operationId)
  → ref; commit(ref, feedbackId); remove(ref); sweep(olderThan) }`, injected
  by the host.
- **Saving with evidence:**
  1. stage each blob;
  2. publish the report with references in the `staged` state;
  3. commit the blobs;
  4. a conditional replace switches the references to `committed`.
- **Failure handling:**
  - a failure before step 4 leaves the report readable, with the evidence
    shown as unavailable;
  - `sweep` removes blobs staged longer than the window without a committed
    reference.
- **Deletion:**
  1. replace the report with a tombstone (id, deletion time, operation id,
     no content);
  2. remove its evidence;
  3. append a note listing what deletion cannot reach.

**Invariants:**

- FEEDBACK-8 (retention);
- FEEDBACK-6: late completions check that the item is not resolved and not
  tombstoned before writing, using a conditional write.

**Tests:**

- a hard kill at each step;
- an orphan sweep;
- deletion with a late transcription arriving afterwards (dropped and
  recorded);
- an `unavailable` evidence rendering.

**Not in scope:** transcription; the recorder.

**Done when:** the crash tests pass on the SQLite reference provider with a
fixture evidence store.

## WP11 · Transcription and dictation

**Goal:** speech becomes the note, with providers plugged in.

- **Depends on:** WP10.
- **Owns:**
  - `packages/feedback/src/transcription/*`, ported from boring-hub
    `hub/ports/transcription.mjs` and the `openai` and `fake` adapters;
  - microphone capture in `./ui`, ported from the hub's `session.js`
    (`startMicrophone`, `pickAudioType`);
  - dictation in `AnnotateSheet`;
  - `test/packages/feedback-transcription.test.mjs`.

**Spec:**

- **The provider port:**
  - `TranscriptionProvider { id; configured(); transcribe({ bytes, mimeType })
    → { text, segments[] } }`;
  - the OpenAI adapter, with its key from host configuration;
  - a fake adapter for tests;
  - provider choice at host composition, as in the hub after PR #65.
- **Dictation:**
  - the sheet records, stages the audio (WP10) and requests a transcription
    bound to the feedback id;
  - the transcript fills `## Said` by conditional replace;
  - Copy waits for the transcript, as in the hub after PR #66.
- **Host authorization** (WP9) is checked before recording and again before
  sending audio to a provider.

**Invariants:**

- FEEDBACK-6: late results are fenced;
- FEEDBACK-8: authorized processing;
- BORING-PI-4: the provider key stays in host configuration and never reaches
  the browser.

**Tests:**

- fake-provider dictation;
- switching subject while a transcription is pending (the result lands on the
  original);
- completion after resolve and after delete;
- a provider refusal shown with a retry;
- the browser bundle contains no provider key path.

A real-provider check runs separately and manually, with its evidence
recorded.

**Not in scope:** replay sync (WP12).

**Done when:** the fake-provider journey passes and the real-provider check is
recorded once.

## WP12 · Audio and replay sync — spike first

**Goal:** know and bound the drift between voice and replay, per browser.

- **Depends on:** WP7. It can run in parallel with WP9 to WP11.
- **Owns:**
  - `packages/feedback/src/ui/replay/*` (`useReplay`: rrweb Replayer scaling,
    audio clock, seeking, re-sync), ported from boring-hub `Replay.jsx`;
  - `test/kits/beep-sync.mjs`.

**Spike:**

- A fake microphone plays a WAV with beeps at known times while a scripted
  page clicks at those times.
- Playwright measures the beep-to-click gap in Chromium, Firefox and WebKit:
  - with the hub's current method;
  - with the first-audio-chunk clock based on `performance.now()`.

**Spec:**

- The audio clock starts at the first `dataavailable` chunk's
  `performance.now()`, mapped to the rrweb time base. The offset is stored
  with the evidence.
- Replays with audio set `skipInactive: false`.
- Playback re-syncs when drift exceeds 200 ms.
- Seeking from a timeline entry seeks both clocks.

**Invariants:** a sync-specific obligation, recorded per browser. It is not a
FEEDBACK law: the evidence states the measured bound and the browser.

**Tests:** the beep kit in three browsers; seek and re-sync unit tests with a
fake clock.

**Not in scope:** the recorder (WP14).

**Done when:** each browser's measured bound is recorded, the target of 200 ms
is met or the shortfall is stated, and `useReplay` passes its tests.

## WP13 · HTML artifacts: stamping, bridge and picker

**Goal:** exact pins on model-written HTML, and the DevTools-style picker.

- **Depends on:** WP2; WP5 for the sheet.
- **Owns:**
  - node stamping in `packages/ui/src/html-preview.ts`;
  - the per-frame bridge in `packages/ui/src/html-viewer.tsx` and the
    interactive recipe;
  - `packages/ui/src/html-anchors.ts` (`html.node@1` resolution);
  - the picker and overlay script in `packages/feedback/src/ui/picker/*`;
  - `registry/feedback/picker-overlay.tsx`;
  - tests.

**Spec:**

- **Stamping.** During the existing allowlist rebuild, every kept element
  gets `data-b="n<k>"`. A side table maps each node id to its source range
  `[start, end)` in the file at the viewed revision. Rendering is otherwise
  unchanged.
- **The bridge** follows HUB-FACTORY §6:
  - a `MessageChannel` and a nonce per frame load; one port transferred to
    the frame;
  - the port closes on navigation or reload;
  - an allowlist of messages (`ready`, `hover`, `pick`, `reveal`, `cancel`);
  - schema validation, at most 64 KiB per message, rate limited;
  - nothing on the channel carries authority.
- **The picker** is injected by the host into the rebuilt page:
  - the only script in passive mode;
  - in interactive mode, it is added alongside the page's own scripts;
  - the overlay is drawn in its own shadow root with `pointer-events: none`,
    excluded from recordings, with masked regions labelled "masked";
  - keys: ↑ parent, ↓ child, Shift multi-select, Esc cancel. Tab and Enter in
    pick mode; tap with parent and child buttons on touch.
- **`html.node@1`** is `{ nodeId, sourceRange, revision, path, text,
  fallback }`.
  - **Resolve** maps the range through the text diff to the current revision:
    an unchanged range is `exact`; a range shifted intact is `moved`; a range
    with a changed interior is `partial`; a deleted range is `missing`.
  - **Runtime elements** (interactive mode, no stamp) carry `runtime: true`
    and resolve only by path and text, never better than `moved`.
- **`show` draws the same overlay** with the agent's note.

**Invariants:**

- FEEDBACK-4 (corpus of HTML source edits with zero wrong spots);
- FEEDBACK-7 (the bridge carries no authority);
- A12 (malicious HTML stays isolated). Stamping and the picker do not weaken
  the sandbox: no `allow-same-origin`, and the CSP is unchanged except for the
  nonce-bound picker script.

**Tests:**

- a stamping round-trip (rendered output is equal apart from the data
  attributes);
- bridge mutants (a wrong nonce, an oversized message, an unknown type, a
  message after reload, all refused);
- a malicious-HTML fixture still isolated;
- picker DOM tests and a browser journey (hover, refine, pick, annotate,
  edit the file, pin follows);
- WP2 kit with an HTML corpus.

**Not in scope:** application pages (WP14).

**Done when:** the browser journey passes and the A12 fixtures still pass.

## WP14 · Application pages: recorder, `app.element@1`, replay player

**Goal:** the hub's bug recording, rebuilt inside an application on the new
foundations.

- **Depends on:** WP9, WP10, WP11, WP12, WP13.
- **Owns:**
  - `packages/feedback/src/ui/recorder/*`, ported from boring-hub
    `experiences/capture/recorder.mjs` with its cross-frame parts dropped;
  - `packages/feedback/src/ui/app-anchors.ts` (`app.element@1`);
  - `registry/feedback/replay-player.tsx`;
  - the port of boring-hub `tools/capture-e2e.mjs` checks to
    `test/journeys/feedback-app.mjs`.

**Spec:**

- **The recorder** records the application's own page through rrweb with the
  WP9 policy:
  - the console plugin;
  - failed requests (method, path and status only);
  - agent run ids;
  - a size cap that sets `truncated`.
- **Each click while recording** becomes an `app.element@1` anchor with `at`.
- **`app.element@1`** is `{ source?, testId?, feedbackId?, role, selector,
  path, box, snapshot, at?, fallback }`.
  - **Resolve** against a live snapshot is a vote: `feedbackId` or `source`
    agreement is strong; test id, role and name, and text are medium; path
    and box are weak.
  - Strong agreement with no conflict is `exact` or `moved`. Conflicting
    signals are `ambiguous`. A partial match is `partial`.
- **The player** uses `useReplay`.

**Invariants:**

- FEEDBACK-8 through the canary kit on the recorder;
- FEEDBACK-4 through a DOM-mutation corpus (renamed classes, reordered lists,
  duplicated buttons, removed test ids) with zero wrong spots;
- the WP12 bound holds.

**Tests:**

- the ported 43 capture checks, adapted (no cross-origin guard);
- the canary kit;
- the DOM-mutation corpus;
- a browser journey: record, pick, dictate, save, the agent lists and shows,
  replay with sync.

**Not in scope:** the boring-app template plugin and hub removal (WP16).

**Done when:** the journey passes in Chromium, and Firefox and WebKit results
are recorded.

## WP15 · Canvas, image and PDF pins

**Goal:** the remaining viewers.

- **Depends on:** WP2, WP5.
- **Owns:** `canvas-anchors.ts` (with the canvas agent inspection tools that
  SPEC.md promises and the canvas lacks), image and PDF anchors in the
  viewers recipe, and tests.

**Spec:**

- **`canvas.shapes@1`:** shape ids with labels and geometry, or a page region.
  - All shapes present is `exact`; some deleted is `partial`; all deleted is
    `missing`.
  - A region resolves by geometry only, never better than `moved`.
- **`image.rect@1`:** the rectangle, image dimensions and digest. A changed
  digest with the same dimensions is `moved` only if the person confirms;
  otherwise `missing`.
- **`pdf.rect@1`:** page, rectangle, page size and text under the rectangle.
  It resolves by text first, then geometry.

**Invariants:** FEEDBACK-4 per adapter with its corpus.

**Done when:** each adapter passes the kit, and annotate and reveal work in
the studio.

## WP16 · Consumer work in other repositories (not this repository)

These are separate issues and PRs in their own repositories, under their own
instructions (`AGENTS.md`: no consumer edits from specification work).

- **boring-app template:**
  - the dev and preview Vite plugin stamping `data-source="file:line"`;
  - the default `data-feedback-visible` marks;
  - the canary kit in the template's CI.
- **boring-hub:**
  - stop extending `hub/captures`;
  - once an application ships WP14, remove the record button for that
    application;
  - decide the hub-wide builder queue (PR #49).
