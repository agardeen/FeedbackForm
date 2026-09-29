# Upgrading the already-deployed database to per-user accounts

Do this once, in order, after deploying the new Worker code. There's a short
window in step 3–5 where `/sync/*` calls will fail (the new code expects
columns that don't exist until the migration finishes) — that's expected and
fine, sync is a manual "Sync Now" button, not a background process.

1. **Set the two new secrets** (from the `worker/` directory):
   ```
   npx wrangler secret put ADMIN_KEY
   npx wrangler secret put AUTH_JWT_SECRET
   ```
   `ADMIN_KEY` gates account creation — pick a long random value and keep it
   somewhere private (a password manager). It must never be pasted into
   `index.html` or committed anywhere; you'll only ever use it from a
   terminal. `AUTH_JWT_SECRET` signs login sessions — any long random string,
   you'll never need to type it again after setting it.

2. **Deploy the new code:**
   ```
   npx wrangler deploy
   ```

3. **Create the `users` table:**
   ```
   npx wrangler d1 execute field-feedback-sync --remote --file=migrations/0001_users_table.sql
   ```

4. **Create the account that will own all pre-existing data** (pick your own
   username/email/password — this becomes your login):
   ```
   curl -X POST https://field-feedback-card-scan.andrew-ea2.workers.dev/auth/admin/create-user \
     -H "X-Admin-Key: <the ADMIN_KEY you set in step 1>" \
     -H "Content-Type: application/json" \
     -d "{\"username\":\"andrew\",\"email\":\"you@example.com\",\"password\":\"<a real password>\",\"isAdmin\":true}"
   ```
   The response is JSON like `{"id":"3f2a...","username":"andrew",...}` —
   **copy that `id` value**, you need it for the next step. Set
   `"isAdmin":true` for this first account so you can still see everyone's
   data later.

5. **Open `migrations/0002_scope_records_to_users.sql`, replace every
   `OWNER_USER_ID` with the id from step 4**, save, then run it:
   ```
   npx wrangler d1 execute field-feedback-sync --remote --file=migrations/0002_scope_records_to_users.sql
   ```
   This is the step that finishes the schema change — after this, `/sync/*`
   works again, and every record/media row that existed before today is now
   owned by the account you created in step 4.

6. **Create an account for each other person who'll use the app:**
   ```
   curl -X POST https://field-feedback-card-scan.andrew-ea2.workers.dev/auth/admin/create-user \
     -H "X-Admin-Key: <ADMIN_KEY>" \
     -H "Content-Type: application/json" \
     -d "{\"username\":\"jsmith\",\"email\":\"jsmith@example.com\",\"password\":\"<a real password>\"}"
   ```
   (omit `"isAdmin":true` for everyone except accounts that should see
   everyone's data). Hand each person their own username/password.

That's it — the app's login screen (see the main README) now works against
these accounts, and `worker/sync-viewer.html` can log in as the admin account
and tick "all users" to see everything in one table.
