# Wanderlog authentication recovery

## Scope and identity

For `no-token`, HTTP 401/403 or exit code 3, recover without asking Alan when the approved path is available. The explicit Wanderlog Google identity is **alan200994@gmail.com**, not the default Google profile. The designated 1Password item UUID is in the README auth section; load `tool--1password` for Env-Secrets routing and `agent-browser` before browser work. Never print, log, or write a password, TOTP or cookie outside the protected `wlog` token store; do not put a cookie or credential in an argument, transcript, fixture or shell history.

## Working path: persistent browser already signed in

```sh
wlog auth recover <tripKey>
wlog auth status
wlog trips get <tripKey> --json
```

The command attaches only to the launchd-owned personal-logins Chrome on `127.0.0.1:9333`, checks the listener PID and profile, opens a uniquely pinned tab, checks Wanderlog's account identity, reads the cookie via CDP in memory, calls the CLI's import logic with the browser's user ID, validates status and fetches the specified trip. It closes only its own tab and daemon. It refuses other accounts, unverified listeners/targets, invalid cookies, custom service origins and failed trip verification. If the endpoint is unavailable it tries the existing launchd service once, never a new browser. Do not list all Chrome tabs into logs: their URLs can contain unrelated OAuth codes.

Both reuse and the signed-out Wanderlog / signed-in Google flow have been verified live. The latter requires a guarded trusted browser click, not a DOM `element.click()`. After the client-side redirect to `/home`, the bootstrap auth store can still be anonymous even when the UI is signed in; the command reopens Settings to verify identity before reading the cookie. A guard result can be uncertain when navigation interrupts the click: inspect without repeating it. The earlier isolated `wlog auth login` timed out and exited; if an isolated login **owned by the current task** is still waiting, close that process and its own temporary Chrome only. Never kill shared Chrome or another task's window.

## Signed-out Google SSO: required behavior and current boundary

Alan requested autonomous Google SSO with the identity above and authenticator-app TOTP when needed, stopping for CAPTCHA, push/SMS-only challenges or an account mismatch. `auth recover` performs a guarded Google sign-in and exact-account selection in the owned tab; the existing signed-in Google path passed live, while the chooser is fixture-tested only. It does not yet enter a Google password or TOTP.

If the Google session can sign in without credentials, use the `agent-browser` skill's attached, uniquely pinned personal-logins session and its private-operation guard before the login action; select only the named identity and verify Wanderlog Settings shows that email before re-running `wlog auth recover <tripKey>`. Do not create an account or switch identities. Stop at CAPTCHA, push/SMS-only, security rejection, account mismatch, or an uncertain submission; do not retry an ambiguous submission.

Alan approved the bridge's encrypted Authentication Vault for travel logins. The designated Wanderlog item has an SSO field and no recognized credential values; an exact-identity search found a separate Google login with password and TOTP present (item IDs are in the README). The SSO field did not expose a linked-item ID. The existing OTP bridge requires a matching item primary origin and a durable account-specific authorization, and its CDP form implementation currently supports only its observed TradingView and Indeed flows, not Google. **Do not bypass those checks or inject a Google TOTP with ad hoc code.** If Google asks for a password or authenticator, recovery remains blocked at the unsupported guarded bridge boundary; report it precisely. Do not claim path (c) works until it has fixture coverage and the supported bridge exists.
