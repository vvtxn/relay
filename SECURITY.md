# Security

Relay runs an agent that can read and write files and execute shell commands on the host. Treat the server as a
privileged service and keep it on a trusted, single-user machine unless you have configured the allowlists below.

## Threat model

- **Single-tenant by default.** The server binds `127.0.0.1` and is intended for one operator. The agent's tools run
  with the server process's privileges.
- **The agent executes tools.** `bash` is not confined to the workspace; file tools are (see below). A user who can
  drive the agent can run commands on the host.
- **Clients are untrusted.** Markdown and tool output are rendered safely, and all API access is authenticated.

## Authentication

`AUTH_PROVIDER` selects the mode:

- `local` — every request is the configured `DEV_AUTH_SUBJECT`. **No login and no CSRF protection for the dev
  identity**; use it only on a trusted machine.
- `github` — the browser completes a GitHub App user-authorization flow (PKCE + `state`). The server issues an opaque
  session token (32 random bytes, SHA-256 hashed at rest) in an `HttpOnly; SameSite=Lax; Path=/` cookie, `Secure` when
  `RELAY_PUBLIC_URL` is https.

Session tokens slide on use and are revoked on logout. Expired rows are pruned opportunistically.

### Access control

- Every session-scoped route verifies the session belongs to the caller; the `RunManager` caches handles keyed by
  `(sessionId, ownerId)`.
- `AUTH_ALLOWED_GITHUB` (comma-separated GitHub logins or numeric ids) restricts who may sign in. **Set this before
  exposing the server**, otherwise any GitHub account can authenticate.
- `RELAY_WORKSPACE_ROOTS` (comma-separated absolute paths) restricts where a session's workspace may be created. Without
  it, an authenticated user can point the agent at any directory on the host (and `bash` is unconfined).
- The CLI bridge header `X-Relay-Local-Subject` is honored only when `AUTH_ALLOW_LOCAL=true` **and** the request
  originates from loopback.

## CSRF

State-changing `/api/*` requests are rejected when an `Origin` header is present and does not match `RELAY_PUBLIC_URL`
or the request's own origin. Combined with `SameSite=Lax`, this blocks browser cross-site requests. The CLI/curl send no
`Origin` and are unaffected.

## File-tool confinement

`createWorkspaceTools(root)` resolves file-tool paths with `resolveRealWithinRoot`, which rejects `..`, absolute
escapes, and **symlinks that resolve outside the root** (for new files it resolves the parent directory). This is
best-effort: `bash` is intentionally not confined, so a shell command can still reach outside the workspace. Use
OS-level isolation (container, separate user, VM) for untrusted workloads.

## Rendering

Agent output is rendered as markdown into Solid elements (no `innerHTML`). Link and image URLs are restricted to
`http:`, `https:`, `mailto:`, and same-origin relative references, so `javascript:`/`data:` URLs cannot execute.

## Hardening checklist for exposure

1. Keep `AUTH_PROVIDER=github` and set `AUTH_ALLOWED_GITHUB`.
2. Set `RELAY_WORKSPACE_ROOTS` to the directories sessions may use.
3. Keep `AUTH_ALLOW_LOCAL=false` (default in github mode).
4. Terminate TLS and set `RELAY_PUBLIC_URL` to the https origin.
5. Run the server as an unprivileged user, ideally in a container.
6. Never commit `.env.*.local` files; `deno task build` does not embed env.

## Reporting

Report vulnerabilities via a private GitHub security advisory on the repository rather than a public issue.
