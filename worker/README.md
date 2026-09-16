# Business card scan — Cloudflare Worker

Holds the OpenAI API key server-side and proxies business-card photos to a
vision-capable OpenAI model with a strict JSON schema, so the key never has
to live in the static site's client-side code.

**Status:** already deployed at `https://field-feedback-card-scan.andrew-ea2.workers.dev`
(code only — see "Finish setup" below, it won't actually work until the
OpenAI key is set).

## How it fits together

- `index.html` (the static site) has a **"Scan with AI"** button next to the
  existing on-device "Scan Card" button on the Contact tab. It does its own
  orientation-correction, crop, and resize (same tools as the on-device
  scanner) client-side, then POSTs the photo as a JSON body
  (`{ "image": "data:image/jpeg;base64,..." }`) to this Worker.
- This Worker validates the request, calls OpenAI's Chat Completions API with
  Structured Outputs (a strict JSON schema — the model literally cannot
  return malformed/extra fields), validates the shape of what comes back, and
  returns `{ "contact": {...} }` or `{ "error": "some_code" }`.
- The frontend maps the returned fields into the *same* Contact form fields
  the on-device scanner fills in, using the same "only fill if currently
  empty" rule — it never overwrites something you've already typed.

## Finish setup (one-time)

1. **Get an OpenAI API key** at platform.openai.com if you don't have one,
   and make sure billing is enabled on that account (Structured Outputs +
   vision requires a paid account, not just the free trial credit in some
   cases).
2. **Set it as a Worker secret** — from this `worker/` directory:
   ```
   npx wrangler secret put OPENAI_API_KEY
   ```
   It'll prompt you to paste the key directly into the terminal — it's
   stored encrypted on Cloudflare's side and never appears in source control
   or in this chat.
3. That's it — the Worker picks up the secret immediately, no redeploy
   needed. Try "Scan with AI" on a real card photo to confirm.

### Optional: a lightweight abuse deterrent

The Worker's real protection against random abuse is CORS (it only accepts
requests whose `Origin` header matches `ALLOWED_ORIGINS` in `wrangler.toml`).
That stops a browser on some other site from calling it, but CORS is
enforced by browsers, not the server — someone who finds the Worker's URL
could still hit it directly with `curl` and rack up your OpenAI bill.

For a bit more friction (not real security — see note below):
```
npx wrangler secret put APP_SHARED_KEY
```
Then in `index.html`, add `'X-App-Key': '<the same value>'` to the `headers`
object in the `fetch()` call inside the `scanCardAiBtn` click handler. This
is a shared secret embedded in public client-side code, so a determined
person can still extract it from view-source — it only stops casual/
opportunistic misuse, not a targeted one. For real rate limiting, add a
Cloudflare **Rate Limiting Rule** on this Worker's route from the Cloudflare
dashboard (Security → WAF → Rate limiting rules) — no code change needed.

## Redeploying after code changes

```
cd worker
npx wrangler deploy
```

## Changing the model later (or swapping providers)

- **Different OpenAI model:** edit `OPENAI_MODEL` in `wrangler.toml`
  (`[vars]` section) and redeploy — no code change.
- **Different vision provider entirely:** everything provider-specific lives
  in `callOpenAI()` and `CARD_SCHEMA` in `src/index.js`. Replace that
  function with an equivalent call to the new provider, keep it returning
  the same `{ ok, data }` / `{ ok: false, error, status }` shape, and nothing
  else (the request validation, CORS, response shape checks) needs to
  change.

## Local testing

```
cd worker
npx wrangler dev
```
This runs the Worker locally (usually at `http://localhost:8787`). Point
`CARD_SCAN_API_URL` in `index.html` at that URL temporarily to test against
a local instance instead of the deployed one — remember to add
`http://localhost:8787`-style origins to `ALLOWED_ORIGINS` if needed, and to
change `CARD_SCAN_API_URL` back before deploying the site.

## What's NOT logged

The Worker never logs the image, the extracted contact data, or the API
key — only high-level events (e.g. "OpenAI request failed: HTTP 429") for
debugging. Check `npx wrangler tail` to see this in real time if you need to
debug a failure.
