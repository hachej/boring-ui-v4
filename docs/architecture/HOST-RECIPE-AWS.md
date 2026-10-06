# Host recipe: AWS (AgentCore Runtime + Code Interpreter + EFS)

Status: **specification only, nothing implemented.** Owner: the host-recipe track in [ROADMAP.md §10](ROADMAP.md#10-package-useful-recipes-and-keep-one-source-of-instructions).
Facts about AWS services were checked against AWS documentation on 2026-10-05 (links at the end); re-check them when work starts.

## Goal

One executable recipe that runs a library agent (`defineAgent`, document/artifact/ask-user tools, chat transport) on AWS
with durable Pi state, a real shell, and the `pi-chat` UI talking to it, the same way the studio does locally. It is a
recipe, not a framework: native AWS pieces wired directly, no generic multi-cloud deploy layer, no second harness or
scheduler (BORING-PI-1..6). Cloudflare (`PiHarness` in a Durable Object) is the sibling recipe; both share only the
library adapters listed under "Library work".

## Mapping

| Need | AWS piece | Library seam |
|---|---|---|
| Agent process and lifecycle | **Bedrock AgentCore Runtime** (microVM per `runtimeSessionId`, container on ARM64, `0.0.0.0:8080`, `POST /invocations`, `GET /ping`, optional `/ws`) | A small container entry that opens the native Harness and serves the chat transport |
| Durable Pi state | **Amazon EFS** access point mounted by the runtime (`filesystemConfigurations[].efsAccessPoint`, mount path under `/mnt/`) | Pi Durable SQLite storage on a file under the mount |
| Workspace files (documents, presented files) | Same EFS mount | The workspace provider (`createWorkspaceProvider`) over the workspace directory on the mount, its journal in a SQLite file outside that directory (files PR 7, pending) |
| Real shell and files for the agent | **AgentCore Code Interpreter** (`InvokeCodeInterpreter`: `executeCommand`, `startCommandExecution`/`getTask`/`stopTask`, `readFiles`, `writeFiles`, `listFiles`, `removeFiles`) | A Pi `ExecutionEnv` adapter, same pattern as the Vercel Sandbox adapter in `@boring/execution` |
| Browser chat | `pi-chat` + `createRemoteChat` against the runtime endpoint | Chat transport over `/invocations` (and `/ws` later) |
| Identity | AgentCore inbound auth with a JWT authorizer (Cognito or another OIDC issuer) | Transport `authenticate` maps the verified token to the host identity/scope |

## Decisions and why

1. **One AgentCore session per conversation (or per private workspace).** A session is one microVM; mapping a
   conversation to `runtimeSessionId` gives a single writer for that conversation's databases. Session ids must meet the
   AgentCore length rule (derive them from the conversation id).
2. **Durable state on EFS, not managed session storage.** Managed session storage is per-session and survives
   stop/resume, but it is **wiped on every runtime version update** (every deploy) and after 14 idle days. Pi durable
   state and published resources must survive deploys, so they live on EFS. Session storage may still hold disposable
   scratch.
3. **One SQLite file per writer.** EFS is shared NFS (close-to-open consistency, advisory locks). SQLite over NFS is
   only acceptable with a single writer per file: `/mnt/state/<scope>/<conversation>.pi.sqlite` for the harness and
   `/mnt/state/<scope>/journal.sqlite` for the workspace journal, written only by the session that owns the scope. A
   workspace shared across sessions needs a server-side owner (a separate session or service), not concurrent
   SQLite writers. Validate WAL vs rollback journal on EFS before choosing.
4. **Idle termination vs background work.** Sessions stop after `idleRuntimeSessionTimeout` (default 900 s) and at
   `maxLifetime` (default and max 28 800 s). Pi recovers interrupted work on the next open, but nothing reopens a
   stopped session by itself. The recipe must either keep the session busy while native tasks run (the `/ping`
   contract's busy status, to be verified) or wake it (an EventBridge Scheduler invocation) when background tasks are
   pending. Report "stopped, will resume" separately from "done".
5. **Code Interpreter as the execution environment, not the agent host.** The agent process stays in Runtime; the
   shell and working files run in a Code Interpreter session acquired per workspace. Interpreter sessions also expire,
   so reattachment must verify instance identity or report the workspace lost (AGENTS: references include view and
   scope; reattachment verifies identity). Bytes cross the API, so large files need streaming or S3 staging.
6. **Transport over `/invocations`.** AgentCore routes only `/invocations`, `/ping` and `/ws` to the container. The
   chat transport today selects the operation with a `?op=` query parameter on one endpoint; verify that query strings
   reach the container, otherwise move the operation into the request body for this recipe. `watch` needs a streaming
   response (or `/ws`); verify streaming limits through the AgentCore endpoint.
7. **Models.** Bedrock models through Pi AI's provider configuration, or the host's existing OpenAI/Anthropic keys from
   Secrets Manager. No credentials in the image or in tool-visible files.

## Library work this recipe needs (shared with Cloudflare)

- Done: the workspace journal and the SQLite workspace backend take an injected `SqliteConnection` (`openNodeConnection`,
  `durableObjectSqliteConnection`), so the same code runs on a file, on EFS, or in a Durable Object.
- `@boring/execution` gains a Code Interpreter `ExecutionEnv` adapter (FileSystem + Shell from one session instance),
  with bounded output, cancellation through `stopTask`, and explicit loss on expiry.
- The chat transport keeps working behind a single route (`op` in the body as an option).

## Infrastructure (in the recipe, as code)

VPC with subnets in the EFS mount-target Availability Zones (DNS hostnames and resolution on); EFS file system,
mount targets and one access point with the container's POSIX UID/GID; security groups allowing TCP 2049 from the
runtime to the mount targets; execution role with `elasticfilesystem:ClientMount`/`ClientWrite` conditioned on the
access point ARN plus Code Interpreter and model permissions; ECR image (ARM64); AgentCore runtime with
`networkMode: VPC`, the EFS `filesystemConfigurations`, lifecycle settings and a JWT inbound authorizer. Infrastructure
as code (CDK or Terraform) is chosen when work starts; deployment workflows themselves belong to boring-factory.

## Acceptance for the recipe

A journey (real browser, real model) against the deployed endpoint: chat with streaming and a tool call; create and
edit an artifact; run a shell command in the Code Interpreter; reload and see history; force a session stop
(`StopRuntimeSession`) and a runtime version update, then resume and see the same conversation, documents and
pending work recovered; a second user cannot read the first user's scope. Costs and limits recorded.

## Open questions

- `/ping` busy semantics and whether they hold a session past the idle timeout.
- Query strings and streaming through `InvokeAgentRuntime`; WebSocket session limits.
- SQLite journal mode and latency on EFS; whether harness and resources share one file per scope.
- Code Interpreter session limits, network modes and file size limits for the adapter.

## Sources

- AgentCore Runtime file systems: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html
- AgentCore Runtime HTTP contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
- AgentCore lifecycle settings: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html
- InvokeCodeInterpreter: https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeCodeInterpreter.html
- Cloudflare PiHarness (sibling recipe): https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/
