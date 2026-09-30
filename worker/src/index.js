/**
 * Field Feedback Worker.
 *
 * Five unrelated jobs share this Worker (and its wrangler deploy flow):
 *
 * 1. Business card scan proxy (`POST /`) — holds the OpenAI API key
 *    server-side and forwards a business-card photo to a vision-capable
 *    OpenAI model with a strict JSON schema. See the "Frontend integration"
 *    note in the README for how the frontend uses this.
 *
 * 2. Login (`/auth/*`) — every synced record belongs to one account. There
 *    is no public sign-up. The very first account is created via
 *    `POST /auth/admin/create-user` (guarded by the ADMIN_KEY secret, which
 *    never ships in client code — terminal/curl only, see
 *    migrations/README.md). After that, any account with is_admin can add
 *    more via `POST /auth/users` (checked from their own session token).
 *    `GET /auth/users` lists every account (username/email/admin-flag only,
 *    nothing sensitive) — any logged-in account can call it, both for the
 *    Account tab's admin view and for the share picker (job 4 below).
 *    `POST /auth/login` exchanges a username/password for a signed,
 *    expiring token (see auth.js). `GET /auth/me` and
 *    `POST /auth/change-password` also need that token.
 *
 * 3. Optional server sync (`/sync/*`) — lets the app back up its locally
 *    stored records (feedback, survey answers, contacts, quick captures,
 *    meeting notes, todos, events) and media (photos/audio/scans) to a D1
 *    database and R2 bucket, so a device wipe or reinstall isn't a full loss.
 *    Sync is opt-in from the app; nothing here runs unless the frontend
 *    calls it. Every /sync/* route requires a valid `Authorization: Bearer
 *    <token>` from /auth/login, and every record/media row is scoped to the
 *    account that owns it — an admin account can additionally read (not
 *    write or delete) every account's data via `?all=1`, for oversight.
 *
 * 4. Sharing (`POST /sync/share`, `POST /email/send`) — both authenticated
 *    the same way as /sync/*. `/sync/share` copies one entry's data into
 *    another account (a new independent row under a new id — not a live
 *    link; editing one copy never affects the other). `/email/send` relays
 *    a pre-formatted subject/body through Resend so a copy can be emailed to
 *    anyone, account or not — the frontend does all the per-entry-type
 *    formatting; this route is a dumb relay. Requires the RESEND_API_KEY
 *    secret; see README for setup (a verified sending domain is needed for
 *    production use, not just the sandbox address).
 *
 * 5. Shared tag tree (`/tags*`) — unlike everything above, this is NOT
 *    scoped per account. It's one shared hierarchy of tags (arbitrary
 *    nesting) used to tag Contacts/Quick Captures/Meeting Notes/Todos,
 *    visible to every account. Any logged-in account can read the tree
 *    (`GET /tags`) and add a new node (`POST /tags`, tagged with who added
 *    it); only accounts with is_admin can rename/move/reorder/delete a node
 *    (`PUT /tags/:id`, `DELETE /tags/:id`) — see the Tags tab in the app.
 *
 * Provider swap (card scan): everything OpenAI-specific lives in
 * `callOpenAI()` and `CARD_SCHEMA`. Replace `callOpenAI()` with an
 * equivalent call and keep returning the same shape — nothing else needs
 * to change.
 */

import { hashPassword, verifyPassword, signJwt, verifyJwt } from './auth.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8MB base64 payload cap (defense in depth —
// the frontend resizes well below this before sending; this just stops an
// abusive direct call to the endpoint from sending something huge).
const OPENAI_TIMEOUT_MS = 25000;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // photos/audio uploaded for sync
const AUTH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60; // sessions expire after 14 days

const CARD_SCHEMA = {
	name: 'business_card_contact',
	strict: true,
	schema: {
		type: 'object',
		properties: {
			is_business_card: {
				type: 'boolean',
				description: 'True only if the image actually shows a business card (or close equivalent, like a name badge with contact details). False for anything else — a random photo, a blank/illegible image, etc.',
			},
			first_name: { type: ['string', 'null'] },
			last_name: { type: ['string', 'null'] },
			full_name: { type: ['string', 'null'] },
			job_title: { type: ['string', 'null'] },
			company: { type: ['string', 'null'] },
			email: { type: ['string', 'null'] },
			phone: { type: ['string', 'null'], description: 'A landline/office number if distinguishable from a mobile number.' },
			mobile_phone: { type: ['string', 'null'], description: 'A mobile/cell number if distinguishable from an office number. If only one number is present and its type is unclear, put it in `phone` and leave this null.' },
			website: { type: ['string', 'null'] },
			address: {
				type: 'object',
				properties: {
					street: { type: ['string', 'null'] },
					city: { type: ['string', 'null'] },
					state: { type: ['string', 'null'] },
					postal_code: { type: ['string', 'null'] },
					country: { type: ['string', 'null'] },
				},
				required: ['street', 'city', 'state', 'postal_code', 'country'],
				additionalProperties: false,
			},
			linkedin: { type: ['string', 'null'] },
			notes: {
				type: ['string', 'null'],
				description: 'Any other useful text on the card that does not fit the fields above (e.g. a second job title, certifications, a secondary company name). Do not include decorative taglines/slogans here unless they help identify the company.',
			},
		},
		required: [
			'is_business_card', 'first_name', 'last_name', 'full_name', 'job_title',
			'company', 'email', 'phone', 'mobile_phone', 'website', 'address',
			'linkedin', 'notes',
		],
		additionalProperties: false,
	},
};

const SYSTEM_PROMPT = `You extract contact information from a photo of a business card.

Rules:
- Do not invent or guess missing information. If a field is not clearly present or is ambiguous, use null (or null for every field under "address" if there's no address at all).
- Normalize email addresses to lowercase. Keep phone numbers close to how they're printed, including country codes and extensions, but remove stray OCR noise characters.
- Preserve international phone numbers and country codes as printed.
- Split first_name/last_name when the name is clearly a personal name; always also fill full_name. If you cannot confidently split first/last (e.g. a single-word name, or a name in a script/order you're unsure how to split), leave first_name and last_name null but still fill full_name.
- company and job_title are independent fields — do not merge them.
- If two phone numbers are present, classify them into phone (office/landline) vs mobile_phone only if there's a clear indicator (a label, icon, or context). If you can't tell which is which, put the first/primary number in phone and leave mobile_phone null.
- Ignore decorative slogans/taglines, QR codes, and pure branding graphics — they are not contact data. A company name repeated as a logo IS relevant for the company field.
- If the image does not show a business card (or a badge with equivalent contact info), set is_business_card to false and leave every other field null.
- Set is_business_card to true only when you are actually looking at a card — not merely because you found some text.`;

// Record types the sync endpoints will accept. Kept in sync with the app's
// STORAGE_KEYS in index.html — the Worker treats `data` as an opaque JSON
// blob either way, this is just an allowlist against typos/abuse.
const RECORD_TYPES = new Set(['feedback', 'qa', 'contacts', 'quickCaptures', 'meetingNotes', 'todos', 'events']);

function corsHeaders(origin, allowedOrigins) {
	const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
	return {
		'Access-Control-Allow-Origin': allowOrigin,
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-Key, X-Admin-Key, X-Media-Kind',
		'Vary': 'Origin',
	};
}

function jsonResponse(body, status, extraHeaders) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}

// Verifies the `Authorization: Bearer <token>` header on a /sync/* or
// /auth/me request. Returns { userId, username, isAdmin } or null — the
// token alone is trusted (no per-request DB lookup) since sessions are
// stateless; revoking an account takes effect within AUTH_TOKEN_TTL_SECONDS.
async function requireAuth(request, env) {
	const header = request.headers.get('Authorization') || '';
	const match = /^Bearer (.+)$/.exec(header);
	if (!match) return null;
	const payload = await verifyJwt(match[1], env.AUTH_JWT_SECRET);
	if (!payload || !payload.sub) return null;
	return { userId: payload.sub, username: payload.username, isAdmin: !!payload.isAdmin };
}

function normalizeUsername(username) {
	return (username || '').trim().toLowerCase();
}

// --- Auth routes ---

// Shared by both account-creation entry points below. Returns
// { status, body: { error } } on validation/DB failure, or { user } on success.
async function createUserFromRequestBody(env, body) {
	const username = normalizeUsername(body && body.username);
	const email = (body && body.email || '').trim();
	const password = body && body.password;
	if (!username || !email || !password || password.length < 8) {
		return { status: 400, body: { error: 'invalid_input', detail: 'username, email, and a password of at least 8 characters are required' } };
	}

	const id = crypto.randomUUID();
	const passwordHash = await hashPassword(password);
	const isAdmin = body.isAdmin ? 1 : 0;

	try {
		await env.SYNC_DB.prepare(
			`INSERT INTO users (id, username, email, password_hash, is_admin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
		).bind(id, username, email, passwordHash, isAdmin, Date.now()).run();
	} catch (err) {
		// D1 surfaces a UNIQUE constraint violation as a generic error; treat any
		// insert failure here as "username taken" since that's the only constraint.
		return { status: 409, body: { error: 'username_taken' } };
	}

	return { user: { id, username, email, isAdmin: !!isAdmin } };
}

// Bootstrap-only: creates the very first account(s) before any admin exists to
// log in with. Guarded by the ADMIN_KEY secret (terminal/curl only — never
// ships in client code). See migrations/README.md.
async function handleAdminCreateUser(request, env, headers) {
	if (!env.ADMIN_KEY) {
		// eslint-disable-next-line no-console
		console.error('ADMIN_KEY is not configured; account creation is disabled');
		return jsonResponse({ error: 'server_not_configured' }, 500, headers);
	}
	if (request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
		return jsonResponse({ error: 'unauthorized' }, 401, headers);
	}

	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const result = await createUserFromRequestBody(env, body);
	if (result.status) return jsonResponse(result.body, result.status, headers);
	return jsonResponse(result.user, 200, headers);
}

// In-app account creation: any account with is_admin can add more accounts,
// verified from their own session token — no shared secret involved.
async function handleAdminCreateUserInApp(request, env, headers, auth) {
	if (!auth.isAdmin) return jsonResponse({ error: 'forbidden' }, 403, headers);

	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const result = await createUserFromRequestBody(env, body);
	if (result.status) return jsonResponse(result.body, result.status, headers);
	return jsonResponse(result.user, 200, headers);
}

// Any logged-in account can list accounts — not admin-only. Needed so the
// share picker can show who else to share an entry with; nothing sensitive
// is returned (no password data), just username/email/admin-flag.
async function handleListUsers(env, headers) {
	const { results } = await env.SYNC_DB.prepare(
		`SELECT id, username, email, is_admin, created_at FROM users ORDER BY created_at ASC`
	).all();
	const users = (results || []).map((u) => ({ id: u.id, username: u.username, email: u.email, isAdmin: !!u.is_admin, createdAt: u.created_at }));
	return jsonResponse({ users }, 200, headers);
}

async function handleLogin(request, env, headers) {
	if (!env.AUTH_JWT_SECRET) {
		// eslint-disable-next-line no-console
		console.error('AUTH_JWT_SECRET is not configured; login is disabled');
		return jsonResponse({ error: 'server_not_configured' }, 500, headers);
	}

	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const username = normalizeUsername(body && body.username);
	const password = body && body.password;
	if (!username || !password) return jsonResponse({ error: 'invalid_input' }, 400, headers);

	const user = await env.SYNC_DB.prepare(
		`SELECT id, username, email, password_hash, is_admin FROM users WHERE username = ?1`
	).bind(username).first();

	// Same error for "no such user" and "wrong password" — don't leak which one it was.
	if (!user || !(await verifyPassword(password, user.password_hash))) {
		return jsonResponse({ error: 'invalid_credentials' }, 401, headers);
	}

	const token = await signJwt(
		{ sub: user.id, username: user.username, isAdmin: !!user.is_admin },
		env.AUTH_JWT_SECRET,
		AUTH_TOKEN_TTL_SECONDS
	);

	return jsonResponse({
		token,
		user: { id: user.id, username: user.username, email: user.email, isAdmin: !!user.is_admin },
	}, 200, headers);
}

async function handleMe(request, env, headers, auth) {
	const user = await env.SYNC_DB.prepare(
		`SELECT id, username, email, is_admin FROM users WHERE id = ?1`
	).bind(auth.userId).first();
	if (!user) return jsonResponse({ error: 'not_found' }, 404, headers);
	return jsonResponse({ id: user.id, username: user.username, email: user.email, isAdmin: !!user.is_admin }, 200, headers);
}

async function handleChangePassword(request, env, headers, auth) {
	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const currentPassword = body && body.currentPassword;
	const newPassword = body && body.newPassword;
	if (!currentPassword || !newPassword || newPassword.length < 8) {
		return jsonResponse({ error: 'invalid_input' }, 400, headers);
	}

	const user = await env.SYNC_DB.prepare(`SELECT password_hash FROM users WHERE id = ?1`).bind(auth.userId).first();
	if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
		return jsonResponse({ error: 'invalid_credentials' }, 401, headers);
	}

	const newHash = await hashPassword(newPassword);
	await env.SYNC_DB.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2`).bind(newHash, auth.userId).run();

	return jsonResponse({ ok: true }, 200, headers);
}

async function callOpenAI(env, imageDataUrl) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
	try {
		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: env.OPENAI_MODEL || 'gpt-4o-mini',
				temperature: 0,
				max_tokens: 900,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{
						role: 'user',
						content: [
							{ type: 'text', text: 'Extract the contact information from this business card photo.' },
							{ type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
						],
					},
				],
				response_format: { type: 'json_schema', json_schema: CARD_SCHEMA },
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			// Never log response bodies here — they can echo back request content.
			// eslint-disable-next-line no-console
			console.error(`OpenAI request failed: HTTP ${res.status}`);
			if (res.status === 429) return { ok: false, error: 'rate_limited', status: 429 };
			if (res.status === 401 || res.status === 403) return { ok: false, error: 'upstream_auth_failed', status: 502 };
			return { ok: false, error: 'upstream_error', status: 502 };
		}

		const payload = await res.json();
		const raw = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
		if (!raw) return { ok: false, error: 'empty_response', status: 502 };

		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			return { ok: false, error: 'invalid_json_from_model', status: 502 };
		}
		return { ok: true, data: parsed };
	} catch (err) {
		if (err.name === 'AbortError') return { ok: false, error: 'timeout', status: 504 };
		// eslint-disable-next-line no-console
		console.error('OpenAI request threw:', err.name);
		return { ok: false, error: 'network_error', status: 502 };
	} finally {
		clearTimeout(timeout);
	}
}

// Cheap structural check on top of the strict schema — the model can't return
// extra/missing fields (enforced by OpenAI's strict mode), but this guards
// against a malformed/truncated response still slipping through as valid JSON.
function validateShape(data) {
	if (!data || typeof data !== 'object') return false;
	if (typeof data.is_business_card !== 'boolean') return false;
	if (!data.address || typeof data.address !== 'object') return false;
	return true;
}

async function handleCardScan(request, env, headers) {
	if (request.method !== 'POST') {
		return jsonResponse({ error: 'method_not_allowed' }, 405, headers);
	}

	if (!env.OPENAI_API_KEY) {
		// eslint-disable-next-line no-console
		console.error('OPENAI_API_KEY is not configured');
		return jsonResponse({ error: 'server_not_configured' }, 500, headers);
	}

	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const image = body && body.image;
	if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
		return jsonResponse({ error: 'missing_or_invalid_image' }, 400, headers);
	}
	if (image.length > MAX_IMAGE_BYTES) {
		return jsonResponse({ error: 'image_too_large' }, 413, headers);
	}

	const result = await callOpenAI(env, image);
	if (!result.ok) {
		return jsonResponse({ error: result.error }, result.status || 502, headers);
	}
	if (!validateShape(result.data)) {
		// eslint-disable-next-line no-console
		console.error('Model response failed shape validation');
		return jsonResponse({ error: 'invalid_model_response' }, 502, headers);
	}
	if (!result.data.is_business_card) {
		return jsonResponse({ error: 'not_a_business_card' }, 422, headers);
	}

	return jsonResponse({ contact: result.data }, 200, headers);
}

// --- Sync: records (feedback/survey/contacts/quick captures/meeting notes/todos) ---

async function handleRecordsUpsert(request, env, headers, type, auth) {
	if (!RECORD_TYPES.has(type)) return jsonResponse({ error: 'unknown_record_type' }, 404, headers);

	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const records = body && Array.isArray(body.records) ? body.records : null;
	if (!records || !records.length) return jsonResponse({ error: 'missing_records' }, 400, headers);
	if (records.length > 500) return jsonResponse({ error: 'too_many_records' }, 413, headers);

	const now = Date.now();
	const statements = [];
	for (const record of records) {
		if (!record || typeof record.id !== 'string' || !record.id) continue;
		const updatedAt = Number.isFinite(record.updatedAt) ? record.updatedAt : now;
		const data = JSON.stringify(record.data ?? {});
		// Last-write-wins, but only if the incoming version is at least as new —
		// protects against an out-of-order sync from an offline-queued device.
		statements.push(
			env.SYNC_DB.prepare(
				`INSERT INTO records (user_id, type, id, data, updated_at, deleted_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
				 ON CONFLICT(user_id, type, id) DO UPDATE SET
				   data = excluded.data,
				   updated_at = excluded.updated_at,
				   deleted_at = NULL
				 WHERE excluded.updated_at >= records.updated_at`
			).bind(auth.userId, type, record.id, data, updatedAt)
		);
	}
	if (!statements.length) return jsonResponse({ error: 'no_valid_records' }, 400, headers);

	await env.SYNC_DB.batch(statements);
	return jsonResponse({ ok: true, upserted: statements.length }, 200, headers);
}

async function handleRecordDelete(env, headers, type, id, auth) {
	if (!RECORD_TYPES.has(type)) return jsonResponse({ error: 'unknown_record_type' }, 404, headers);
	if (!id) return jsonResponse({ error: 'missing_id' }, 400, headers);

	// Scoped to the caller's own data even for admins — "view everyone's data"
	// does not imply "can delete everyone's data".
	await env.SYNC_DB.prepare(
		`UPDATE records SET deleted_at = ?1, updated_at = ?1 WHERE type = ?2 AND id = ?3 AND user_id = ?4`
	).bind(Date.now(), type, id, auth.userId).run();

	return jsonResponse({ ok: true }, 200, headers);
}

async function handleRecordsPull(request, env, headers, type, auth) {
	if (!RECORD_TYPES.has(type)) return jsonResponse({ error: 'unknown_record_type' }, 404, headers);

	const url = new URL(request.url);
	const since = Number(url.searchParams.get('since')) || 0;
	const wantsAll = auth.isAdmin && url.searchParams.get('all') === '1';

	const { results } = wantsAll
		? await env.SYNC_DB.prepare(
			`SELECT id, user_id, data, updated_at, deleted_at FROM records WHERE type = ?1 AND updated_at > ?2 ORDER BY updated_at ASC LIMIT 1000`
		  ).bind(type, since).all()
		: await env.SYNC_DB.prepare(
			`SELECT id, user_id, data, updated_at, deleted_at FROM records WHERE type = ?1 AND user_id = ?2 AND updated_at > ?3 ORDER BY updated_at ASC LIMIT 1000`
		  ).bind(type, auth.userId, since).all();

	const records = (results || []).map((row) => ({
		id: row.id,
		userId: row.user_id,
		updatedAt: row.updated_at,
		deleted: !!row.deleted_at,
		data: row.deleted_at ? null : JSON.parse(row.data),
	}));

	return jsonResponse({ records, serverTime: Date.now() }, 200, headers);
}

// --- Sharing: copy one entry into another account, or email it out ---

// Copies `data` (the full local entry, exactly as the app already stores and
// syncs it) into another account as a brand-new row with a fresh id. This is
// a one-time copy, not a live link — editing either side afterward never
// affects the other. Media referenced by the copied entry (attachmentIds,
// cardPhotoId) is NOT duplicated — it still belongs to the original account,
// so any photos won't show up for the recipient. Text-only sharing works
// fully; that's a known limitation, not a bug.
async function handleShareRecord(request, env, headers, auth) {
	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const type = body && body.type;
	const targetUserId = body && body.targetUserId;
	const data = body && body.data;
	if (!RECORD_TYPES.has(type)) return jsonResponse({ error: 'unknown_record_type' }, 404, headers);
	if (!targetUserId || typeof targetUserId !== 'string') return jsonResponse({ error: 'invalid_input' }, 400, headers);
	if (!data || typeof data !== 'object') return jsonResponse({ error: 'invalid_input' }, 400, headers);

	const targetUser = await env.SYNC_DB.prepare(`SELECT id, username FROM users WHERE id = ?1`).bind(targetUserId).first();
	if (!targetUser) return jsonResponse({ error: 'user_not_found' }, 404, headers);

	const newId = crypto.randomUUID();
	const now = Date.now();
	const sharedData = { ...data, id: newId, sharedFrom: { username: auth.username, sharedAt: now } };

	await env.SYNC_DB.prepare(
		`INSERT INTO records (user_id, type, id, data, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)`
	).bind(targetUserId, type, newId, JSON.stringify(sharedData), now).run();

	return jsonResponse({ ok: true, id: newId, sharedWith: targetUser.username }, 200, headers);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dumb relay to Resend — the frontend already knows how to format each entry
// type into readable text (it has the same rendering logic used on-screen),
// so this route just takes a ready-made subject/body and sends it. Any
// logged-in account can use it; it's not scoped to synced data at all.
async function handleSendEmail(request, env, headers, auth) {
	if (!env.RESEND_API_KEY) {
		// eslint-disable-next-line no-console
		console.error('RESEND_API_KEY is not configured; email sending is disabled');
		return jsonResponse({ error: 'server_not_configured' }, 500, headers);
	}

	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const to = ((body && body.to) || '').trim();
	const subject = ((body && body.subject) || 'Shared entry').toString().slice(0, 200);
	const text = ((body && body.text) || '').toString().slice(0, 10000);
	if (!EMAIL_RE.test(to)) return jsonResponse({ error: 'invalid_email' }, 400, headers);
	if (!text) return jsonResponse({ error: 'missing_body' }, 400, headers);

	try {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: env.EMAIL_FROM || 'Field Feedback <onboarding@resend.dev>',
				to: [to],
				subject,
				text: `${text}\n\n— sent from Field Feedback by ${auth.username}`,
			}),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			// eslint-disable-next-line no-console
			console.error(`Resend request failed: HTTP ${res.status} ${detail}`);
			return jsonResponse({ error: 'email_send_failed' }, 502, headers);
		}
	} catch (err) {
		// eslint-disable-next-line no-console
		console.error('Resend request threw:', err);
		return jsonResponse({ error: 'network_error' }, 502, headers);
	}

	return jsonResponse({ ok: true }, 200, headers);
}

// --- Shared tag tree ---
// One tree for the whole team (not scoped per account, unlike everything
// else in this file). Nodes with parent_id = NULL are top-level categories
// (e.g. "People", "Companies", "Products"); nesting under those is
// unlimited. Entries store a tag by its label text (not its id) — see the
// frontend's tag pickers — so renaming a node never changes what's already
// saved on old entries, and no migration is needed when labels change.

async function handleTagsGet(env, headers) {
	const { results } = await env.SYNC_DB.prepare(
		`SELECT id, label, parent_id, sort_order, show_on, created_by, updated_at FROM tags WHERE deleted_at IS NULL ORDER BY sort_order ASC`
	).all();
	const tags = (results || []).map((t) => ({
		id: t.id,
		label: t.label,
		parentId: t.parent_id,
		sortOrder: t.sort_order,
		showOn: t.show_on ? JSON.parse(t.show_on) : [],
		createdBy: t.created_by,
		updatedAt: t.updated_at,
	}));
	return jsonResponse({ tags }, 200, headers);
}

async function handleTagsCreate(request, env, headers, auth) {
	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const label = ((body && body.label) || '').trim();
	const parentId = (body && body.parentId) || null;
	if (!label) return jsonResponse({ error: 'invalid_input' }, 400, headers);
	// A brand-new top-level category (e.g. another "People"/"Products") is a
	// structural decision — admin-only. Nesting a tag under an existing node
	// is open to anyone; that's the "add + suggest where it's nested" case.
	if (!parentId && !auth.isAdmin) return jsonResponse({ error: 'forbidden' }, 403, headers);

	if (parentId) {
		const parent = await env.SYNC_DB.prepare(`SELECT id FROM tags WHERE id = ?1 AND deleted_at IS NULL`).bind(parentId).first();
		if (!parent) return jsonResponse({ error: 'parent_not_found' }, 404, headers);
	}

	const maxOrder = await env.SYNC_DB.prepare(
		parentId
			? `SELECT MAX(sort_order) AS m FROM tags WHERE parent_id = ?1 AND deleted_at IS NULL`
			: `SELECT MAX(sort_order) AS m FROM tags WHERE parent_id IS NULL AND deleted_at IS NULL`
	).bind(...(parentId ? [parentId] : [])).first();

	const id = crypto.randomUUID();
	const now = Date.now();
	await env.SYNC_DB.prepare(
		`INSERT INTO tags (id, label, parent_id, sort_order, show_on, created_by, updated_at, deleted_at)
		 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, NULL)`
	).bind(id, label, parentId, (maxOrder && maxOrder.m != null ? maxOrder.m + 1 : 0), auth.username, now).run();

	return jsonResponse({ id, label, parentId, sortOrder: (maxOrder && maxOrder.m != null ? maxOrder.m + 1 : 0), showOn: [], createdBy: auth.username, updatedAt: now }, 200, headers);
}

async function handleTagUpdate(request, env, headers, auth, id) {
	if (!auth.isAdmin) return jsonResponse({ error: 'forbidden' }, 403, headers);

	let body;
	try {
		body = await request.json();
	} catch (err) {
		return jsonResponse({ error: 'invalid_request_body' }, 400, headers);
	}

	const existing = await env.SYNC_DB.prepare(`SELECT id FROM tags WHERE id = ?1 AND deleted_at IS NULL`).bind(id).first();
	if (!existing) return jsonResponse({ error: 'not_found' }, 404, headers);

	// A node can't become its own descendant — walk up from the proposed new
	// parent and reject if we ever reach `id`.
	if (body.parentId) {
		let cursor = body.parentId;
		let hops = 0;
		while (cursor && hops < 100) {
			if (cursor === id) return jsonResponse({ error: 'cannot_move_into_own_descendant' }, 400, headers);
			const row = await env.SYNC_DB.prepare(`SELECT parent_id FROM tags WHERE id = ?1`).bind(cursor).first();
			cursor = row ? row.parent_id : null;
			hops += 1;
		}
	}

	const sets = [];
	const binds = [];
	let i = 1;
	if (typeof body.label === 'string' && body.label.trim()) { sets.push(`label = ?${i++}`); binds.push(body.label.trim()); }
	if ('parentId' in body) { sets.push(`parent_id = ?${i++}`); binds.push(body.parentId || null); }
	if (typeof body.sortOrder === 'number') { sets.push(`sort_order = ?${i++}`); binds.push(body.sortOrder); }
	if ('showOn' in body) { sets.push(`show_on = ?${i++}`); binds.push(JSON.stringify(Array.isArray(body.showOn) ? body.showOn : [])); }
	if (!sets.length) return jsonResponse({ error: 'no_fields_to_update' }, 400, headers);
	sets.push(`updated_at = ?${i++}`);
	binds.push(Date.now());
	binds.push(id);

	await env.SYNC_DB.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?${i}`).bind(...binds).run();
	return jsonResponse({ ok: true }, 200, headers);
}

async function handleTagDelete(env, headers, auth, id) {
	if (!auth.isAdmin) return jsonResponse({ error: 'forbidden' }, 403, headers);

	// Cascade: soft-delete this node and every descendant, level by level.
	let frontier = [id];
	const toDelete = [id];
	let hops = 0;
	while (frontier.length && hops < 50) {
		const placeholders = frontier.map((_, idx) => `?${idx + 1}`).join(',');
		const { results } = await env.SYNC_DB.prepare(
			`SELECT id FROM tags WHERE parent_id IN (${placeholders}) AND deleted_at IS NULL`
		).bind(...frontier).all();
		frontier = (results || []).map((r) => r.id);
		toDelete.push(...frontier);
		hops += 1;
	}

	const now = Date.now();
	const statements = toDelete.map((tagId) =>
		env.SYNC_DB.prepare(`UPDATE tags SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2`).bind(now, tagId)
	);
	await env.SYNC_DB.batch(statements);

	return jsonResponse({ ok: true, deletedCount: toDelete.length }, 200, headers);
}

// --- Sync: media (photos/audio/scans) ---

async function handleMediaUpload(request, env, headers, id, auth) {
	if (!id) return jsonResponse({ error: 'missing_id' }, 400, headers);

	// An id already owned by a different account can't be silently taken over.
	const existing = await env.SYNC_DB.prepare(`SELECT user_id FROM media WHERE id = ?1`).bind(id).first();
	if (existing && existing.user_id !== auth.userId) return jsonResponse({ error: 'forbidden' }, 403, headers);

	const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
	const kind = request.headers.get('X-Media-Kind') || 'unknown';
	const body = await request.arrayBuffer();
	if (!body.byteLength) return jsonResponse({ error: 'empty_body' }, 400, headers);
	if (body.byteLength > MAX_MEDIA_BYTES) return jsonResponse({ error: 'media_too_large' }, 413, headers);

	await env.SYNC_MEDIA.put(id, body, { httpMetadata: { contentType } });

	const now = Date.now();
	await env.SYNC_DB.prepare(
		`INSERT INTO media (id, user_id, kind, content_type, updated_at, deleted_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
		 ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, content_type = excluded.content_type, updated_at = excluded.updated_at, deleted_at = NULL`
	).bind(id, auth.userId, kind, contentType, now).run();

	return jsonResponse({ ok: true }, 200, headers);
}

async function handleMediaDownload(env, headers, id, auth) {
	if (!id) return jsonResponse({ error: 'missing_id' }, 400, headers);
	const row = await env.SYNC_DB.prepare(`SELECT user_id FROM media WHERE id = ?1`).bind(id).first();
	if (!row) return jsonResponse({ error: 'not_found' }, 404, headers);
	if (row.user_id !== auth.userId && !auth.isAdmin) return jsonResponse({ error: 'forbidden' }, 403, headers);
	const object = await env.SYNC_MEDIA.get(id);
	if (!object) return jsonResponse({ error: 'not_found' }, 404, headers);
	return new Response(object.body, {
		status: 200,
		headers: { ...headers, 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream' },
	});
}

async function handleMediaDelete(env, headers, id, auth) {
	if (!id) return jsonResponse({ error: 'missing_id' }, 400, headers);
	// Scoped to the caller's own media even for admins, same rationale as record deletes.
	const result = await env.SYNC_DB.prepare(
		`UPDATE media SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND user_id = ?3`
	).bind(Date.now(), id, auth.userId).run();
	if (result.meta && result.meta.changes) await env.SYNC_MEDIA.delete(id);
	return jsonResponse({ ok: true }, 200, headers);
}

async function handleMediaList(request, env, headers, auth) {
	const url = new URL(request.url);
	const since = Number(url.searchParams.get('since')) || 0;
	const wantsAll = auth.isAdmin && url.searchParams.get('all') === '1';

	const { results } = wantsAll
		? await env.SYNC_DB.prepare(
			`SELECT id, user_id, kind, content_type, updated_at, deleted_at FROM media WHERE updated_at > ?1 ORDER BY updated_at ASC LIMIT 1000`
		  ).bind(since).all()
		: await env.SYNC_DB.prepare(
			`SELECT id, user_id, kind, content_type, updated_at, deleted_at FROM media WHERE user_id = ?1 AND updated_at > ?2 ORDER BY updated_at ASC LIMIT 1000`
		  ).bind(auth.userId, since).all();

	const media = (results || []).map((row) => ({
		id: row.id,
		userId: row.user_id,
		kind: row.kind,
		contentType: row.content_type,
		updatedAt: row.updated_at,
		deleted: !!row.deleted_at,
	}));

	return jsonResponse({ media, serverTime: Date.now() }, 200, headers);
}

export default {
	async fetch(request, env) {
		const origin = request.headers.get('Origin') || '';
		const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
		const headers = corsHeaders(origin, allowedOrigins);
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers });
		}

		// Admin account creation is a terminal-only route (curl/CLI, guarded by
		// ADMIN_KEY, never called from the browser app) — it must come before the
		// browser CORS-origin gate below, since curl sends no Origin header at all.
		if (url.pathname === '/auth/admin/create-user' && request.method === 'POST') {
			return handleAdminCreateUser(request, env, headers);
		}

		if (!allowedOrigins.includes(origin)) {
			return jsonResponse({ error: 'origin_not_allowed' }, 403, headers);
		}

		// --- Card scan: unchanged behavior at the root path ---
		if (url.pathname === '/') {
			// Optional lightweight deterrent against casual direct-hit abuse (not real
			// security — client-side secrets are always extractable — just raises the
			// bar above "found the URL and curled it". Skipped entirely if the secret
			// isn't configured, so this feature works with zero extra setup too.
			if (env.APP_SHARED_KEY && request.headers.get('X-App-Key') !== env.APP_SHARED_KEY) {
				return jsonResponse({ error: 'unauthorized' }, 401, headers);
			}
			return handleCardScan(request, env, headers);
		}

		// --- Auth routes ---
		if (url.pathname === '/auth/login' && request.method === 'POST') {
			return handleLogin(request, env, headers);
		}
		if (url.pathname === '/auth/me' && request.method === 'GET') {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			return handleMe(request, env, headers, auth);
		}
		if (url.pathname === '/auth/change-password' && request.method === 'POST') {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			return handleChangePassword(request, env, headers, auth);
		}
		if (url.pathname === '/auth/users' && request.method === 'POST') {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			return handleAdminCreateUserInApp(request, env, headers, auth);
		}
		if (url.pathname === '/auth/users' && request.method === 'GET') {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			return handleListUsers(env, headers);
		}

		// --- Sharing routes: any logged-in account (not admin-only) ---
		if (url.pathname === '/email/send' && request.method === 'POST') {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			return handleSendEmail(request, env, headers, auth);
		}

		// --- Shared tag tree: read/create open to any account, edit/delete admin-only ---
		if (url.pathname === '/tags' && request.method === 'GET') {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			return handleTagsGet(env, headers);
		}
		if (url.pathname === '/tags' && request.method === 'POST') {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			return handleTagsCreate(request, env, headers, auth);
		}
		if (url.pathname.startsWith('/tags/')) {
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);
			const tagId = decodeURIComponent(url.pathname.slice('/tags/'.length));
			if (request.method === 'PUT') return handleTagUpdate(request, env, headers, auth, tagId);
			if (request.method === 'DELETE') return handleTagDelete(env, headers, auth, tagId);
		}

		// --- Sync routes: require a logged-in account. Every row is scoped to
		// the account that owns it; an admin account can pass ?all=1 on a GET
		// to read (never write/delete) everyone's data. ---
		if (url.pathname.startsWith('/sync/')) {
			if (!env.AUTH_JWT_SECRET) {
				// eslint-disable-next-line no-console
				console.error('AUTH_JWT_SECRET is not configured; /sync/* is disabled');
				return jsonResponse({ error: 'server_not_configured' }, 500, headers);
			}
			const auth = await requireAuth(request, env);
			if (!auth) return jsonResponse({ error: 'unauthorized' }, 401, headers);

			const parts = url.pathname.split('/').filter(Boolean); // ['sync', ...]

			// /sync/share                     POST (copy one entry into another account)
			if (parts[1] === 'share' && request.method === 'POST') {
				return handleShareRecord(request, env, headers, auth);
			}

			// /sync/records/:type            POST (upsert), GET (pull, ?since=&all=)
			// /sync/records/:type/:id        DELETE (tombstone)
			if (parts[1] === 'records' && parts[2]) {
				const type = parts[2];
				if (parts[3] && request.method === 'DELETE') {
					return handleRecordDelete(env, headers, type, decodeURIComponent(parts[3]), auth);
				}
				if (request.method === 'POST') {
					return handleRecordsUpsert(request, env, headers, type, auth);
				}
				if (request.method === 'GET') {
					return handleRecordsPull(request, env, headers, type, auth);
				}
			}

			// /sync/media                    GET (list, ?since=&all=)
			// /sync/media/:id                POST (upload), GET (download), DELETE
			if (parts[1] === 'media') {
				if (!parts[2] && request.method === 'GET') {
					return handleMediaList(request, env, headers, auth);
				}
				if (parts[2] && request.method === 'POST') {
					return handleMediaUpload(request, env, headers, decodeURIComponent(parts[2]), auth);
				}
				if (parts[2] && request.method === 'GET') {
					return handleMediaDownload(env, headers, decodeURIComponent(parts[2]), auth);
				}
				if (parts[2] && request.method === 'DELETE') {
					return handleMediaDelete(env, headers, decodeURIComponent(parts[2]), auth);
				}
			}

			return jsonResponse({ error: 'not_found' }, 404, headers);
		}

		return jsonResponse({ error: 'not_found' }, 404, headers);
	},
};
