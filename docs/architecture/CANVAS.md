# Default canvas: tldraw

Decision: tldraw, explicitly selected by Julien. No Excalidraw default or mandatory clinical canvas. The optional document controller now uses the pinned 5.5.2 SDK. The optional React renderer uses the same native store and controller; deployment qualifications remain pending.

## Durable document and local session

The [SDK persistence guide](https://tldraw.dev/docs/persistence) distinguishes `getSnapshot(editor.store).document` from `.session`. Use the document snapshot for authoritative shapes/pages/bindings and asset records/references. Session camera/selection/UI state stays per-person locally. `loadSnapshot` replaces the document, so loading a newer snapshot must not silently discard a dirty local edit.

The adapter reads/writes the same resource authority as agent operations, with schema/version and expected revision. Acknowledged document saves yield provider evidence; UI-only session changes do not create document revisions. Validate before load/publication; custom shapes are host-installed code with explicit schemas/migrations. Agent shape operations are typed and validated, not arbitrary browser JavaScript or whole-document blind overwrite.

Do not use `persistenceKey`/IndexedDB as a second authoritative store. A local draft cache, if offered, is explicitly uncommitted and access-scope/resource/version bound. Asset storage/download/upload is host-injected, authenticated and revision-aware; do not auto-fetch arbitrary generated remote URLs or route application assets through a public demo backend.

First implementation is single-editor revision-checked publication. Realtime collaborative editing is optional; choose one authenticated authority and compatibility semantics before enabling `@tldraw/sync`. The hosted demo is not a production/private-data backend. A host's shared consultation scope does not itself require multiplayer canvas.

## Embedding

Offer independent read-only/editable imports under the UI package. Lazy-load SDK and its styles; no canvas dependency in plain chat/Markdown use. Host controls dimensions/layout and license provisioning. Prove vendor style isolation and CSP/asset/network compatibility rather than assuming third-party CSS satisfies Boring's embedding promise.

## License gate

The [SDK licensing page](https://tldraw.dev/community/license) states default use is development-only; production requires an applicable trial/commercial/hobby license and valid key. The SDK is source-available, not permissively licensed. Boring must document downstream license obligations and not imply its own package license covers tldraw. No license is purchased or key provisioned by this spec.

The vendor documents trial-license analytics and no information sent under commercial/hobby licensing. Check the selected release and application deployment policy before shipping; do not treat a vendor statement as a completed traffic/privacy audit.

## Proof obligations

Pinned snapshot roundtrip/migration; schema-invalid/custom-unknown record rejection; unauthorized asset access; no-init-save; camera/selection changes create no revisions; dirty-buffer conflict preservation; concurrent agent/human shape edit; failed/partial asset upload; no browser-origin privilege or hidden egress; license configuration; styles contained within the embedded component. Canvas does not stand in for the clinic's semantic block renderer.

## Current document controller

`@boring/ui/canvas` borrows a native `TLStore` and the host's authenticated `ResourceClient`. It publishes only the document snapshot with `application/vnd.tldraw+json` and exact revision/absence expectations. Its concrete controller exposes the original store, save selection, flush, refresh, explicit discard and operation lookup reconciliation. Markdown and canvas share a private publication buffer; neither creates another resource authority.

Construction refuses a saved source that differs from a nonempty borrowed document. The host must select an empty or matching store, so a later viewer cannot overwrite an earlier draft. The current schema boundary validates every record in a separate native store before applying a saved document. It accepts the selected store's exact schema version, built-in document/page/shape/user records and arrow bindings. Unknown/custom shapes, other binding types, assets and session records refuse before publication. Schema migration and asset adapters remain pending. Invalid remote bytes preserve the current document and base. Native session changes do not publish or dirty a saved document.

Native document edits and raw `loadStoreSnapshot` calls both update dirty state. Publication settlement and awaited refresh synchronize the borrowed store before deciding whether a newer draft exists. Read-only denies this controller's publication; it does not revoke the host's native store API or block another consumer. Disposal removes owned listeners and preserves that store.

Public tests exercise actual native stores with SQLite publication and a DOM animation scheduler. The SDK's supported test environment disables its module-level user-sync BroadcastChannel. A default Node import retains that SDK channel even after store disposal, so this evidence does not qualify a server import/lifecycle. CSS, license provisioning, asset authorization, egress, multiplayer and complete proposal interactions remain open. The headless document-edit entry below supplies validated native-record operations. See [implementation evidence](../implementation/FEATURES.md).

Native tldraw 5.5 adds document-scoped user records for author attribution. Preserve those records without treating their IDs/names as authentication or receipt identity. The current adapter accepts only empty author `imageUrl`; URL/data/blob values require the same future host asset qualification as other images. Creating an author record can dirty the document on native editor mount, but mounting performs no publication.

## Current React renderer

`@boring/ui/canvas-editor` lazy-loads the public native `Tldraw` component. The host supplies the concrete controller, a complete `CanvasAssetUrls` map and optional native mount callback/license key. Load `tldraw/tldraw.css` in the selected canvas route. The library does not install a second persistence backend. One native editor may be mounted per store; separate concurrent views need independent session stores and an explicit document synchronization policy.

The toolbar exposes native selection, hand, drawing, rectangle, text, arrow, line, note, frame, highlight, eraser, undo/redo and fit actions. Save captures the controller's exact selection; unknown acknowledgement requires operation lookup. Remote changes retain the draft until explicit discard. Unmount leaves the controller and native session state alive. A read-only mount sets the native read-only flag, which remains set until the host explicitly changes it; the renderer never clears a host restriction.

The asset map must cover every pinned native font, icon, translation and embed icon. These are trusted host URLs, not document content or authenticated asset authorization. Unsupported paste/import/upload handlers are disabled before the host mount callback. Native default shapes remain available internally, while the controller refuses unsupported published records. The host callback receives the direct native editor and remains trusted application code.

Tests with fictional font-loading and asset-response boundaries establish DOM controls and publication only. They cannot establish real fonts, layout, pointer geometry, browser input, CSS isolation, CSP or vendor/license traffic. Consumers set `skipLibCheck: true` for the pinned SDK's own declarations (missing upstream lodash types; `ArrowShapeUtil.onHandleDrag`/`onTranslateStart` incompatible under exact optional properties). The installed consumers still check consumer code strictly and fail on any library diagnostic outside tldraw's declarations ([UI README](../../packages/ui/README.md)).

## Mounted presentation commands

The renderer exposes concrete inspect/select/frame commands through optional `onMountedTools`. The [UI guide](../../packages/ui/README.md#mounted-canvas-commands) owns their input, targeting and refusal rules. Commands retain native shape/page/camera types and act only on the committed mounted editor. Selection and viewport changes stay local session state, including for read-only or dirty documents. They do not grant resource access or produce publication receipts.

The public DOM suite covers native editor lifecycle and target invalidation; the native compatibility test composes the same selection command with an ordinary Pi ToolTask. The isolated renderer consumer checks its concrete types and repeats the public DOM suite without Pi. `npm run canvas:journey:commands` drives actual desktop/phone geometry with fictional inline assets. Raw execution results and exact candidate stay in the current implementation checkpoint. A browser geometry pass does not establish production asset, CSS isolation, licensing, egress, multiplayer or migration guarantees. Saved-canvas shape mutation and remote browser delivery remain separate qualification work.

## Shared document edits

`@boring/ui/canvas-document` owns native record validation, complete graph checks and detached create/update/remove batches. The [UI guide](../../packages/ui/README.md#headless-canvas-document-edits) owns exact edit and deletion semantics. The entry loads the pinned native schema package without an editor, React or DOM lifecycle.

The controller retains native temporary-store normalization for local initialization and validates the normalized document through this shared module. Saved documents must already contain their document/page records and a valid graph; invalid remote graphs refuse before native loading and preserve the existing draft and base. The Studio saved tools use the same validator and transform before conditional publication. This replaces their separate deletion algorithm.

Public-output tests cover graph and batch behavior. Native Harness/SQLite tests exercise saved tools and concurrent publication. Installed canvas consumers verify the server entry exits normally without DOM setup and excludes editor/React/resource implementations from its bundle. Concrete proposal state, human review/adoption controls, mounted proposal delivery and the complete browser edit/proposal journey remain required follow-up work. None of these changes qualifies assets, migrations, custom executable shapes or full native Editor deletion equivalence.
