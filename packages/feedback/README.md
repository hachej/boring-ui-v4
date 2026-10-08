# @boring/feedback

Feedback reports, storage, placement, and optional UI and native agent adapters.
This package is under development and is not yet qualified for npm release.

Import the capability you need. There is no root export.

- `@boring/feedback/format` defines report data.
- `@boring/feedback/store` reads and conditionally publishes reports.
- `@boring/feedback/page` captures page observations.
- `@boring/feedback/ui` supplies React controls.
- `@boring/feedback/agent` supplies the optional native Pi adapter.
- `@boring/feedback/preview` and `@boring/feedback/tickets` supply integrations.
- `@boring/feedback/source` and `@boring/feedback/source/jsx-dev-runtime` supply source attribution.

The host owns authorization, storage, and capture policy. Feedback cannot grant
access or establish publication evidence. See the included [feedback laws](INVARIANTS.md)
and the [design](https://github.com/hachej/boring-ui-v4/blob/main/docs/architecture/FEEDBACK.md).

Install the optional peers required by the selected entry. The package manifest
lists pinned versions. Node.js 22.19.0 or later is required for Node adapters.
