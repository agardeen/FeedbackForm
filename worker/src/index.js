/**
 * Business card scan proxy.
 *
 * Holds the OpenAI API key server-side (Cloudflare Worker secret) and forwards
 * a business-card photo to a vision-capable OpenAI model with a strict JSON
 * schema, so the frontend never sees the key and never has to parse free-form
 * text. The frontend does image capture, orientation-correction, cropping,
 * and resizing before it ever reaches here (see the "Frontend integration"
 * note in the README) — this Worker's job is just: validate, proxy, validate
 * the response, and get out of the way.
 *
 * Provider swap: everything OpenAI-specific lives in `callOpenAI()` and
 * `CARD_SCHEMA`. To move to a different vision-capable provider later,
 * replace `callOpenAI()` with an equivalent call and keep returning the same
 * shape (`{ ok, data }` or `{ ok: false, error }`) — nothing else needs to
 * change.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8MB base64 payload cap (defense in depth —
// the frontend resizes well below this before sending; this just stops an
// abusive direct call to the endpoint from sending something huge).
const OPENAI_TIMEOUT_MS = 25000;

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

function corsHeaders(origin, allowedOrigins) {
	const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
	return {
		'Access-Control-Allow-Origin': allowOrigin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
		'Vary': 'Origin',
	};
}

function jsonResponse(body, status, extraHeaders) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
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

export default {
	async fetch(request, env) {
		const origin = request.headers.get('Origin') || '';
		const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
		const headers = corsHeaders(origin, allowedOrigins);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers });
		}

		if (request.method !== 'POST') {
			return jsonResponse({ error: 'method_not_allowed' }, 405, headers);
		}

		if (!allowedOrigins.includes(origin)) {
			return jsonResponse({ error: 'origin_not_allowed' }, 403, headers);
		}

		// Optional lightweight deterrent against casual direct-hit abuse (not real
		// security — client-side secrets are always extractable — just raises the
		// bar above "found the URL and curled it". Skipped entirely if the secret
		// isn't configured, so this feature works with zero extra setup too.
		if (env.APP_SHARED_KEY && request.headers.get('X-App-Key') !== env.APP_SHARED_KEY) {
			return jsonResponse({ error: 'unauthorized' }, 401, headers);
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
	},
};
