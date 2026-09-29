/**
 * Password hashing (PBKDF2-SHA256) and session tokens (HS256 JWT), built
 * entirely on the Web Crypto API that ships in the Workers runtime — no
 * external auth library/dependency needed.
 */

const PBKDF2_ITERATIONS = 100000;

function toBase64Url(bytes) {
	let binary = '';
	for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
	const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export async function hashPassword(password) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		keyMaterial,
		256
	);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(bits)}`;
}

export async function verifyPassword(password, stored) {
	const parts = (stored || '').split('$');
	if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
	const iterations = Number(parts[1]);
	const salt = fromBase64Url(parts[2]);
	const expectedHash = fromBase64Url(parts[3]);
	const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = new Uint8Array(await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
		keyMaterial,
		expectedHash.length * 8
	));
	if (bits.length !== expectedHash.length) return false;
	// Constant-time-ish comparison — avoids short-circuiting on the first
	// mismatched byte, which is the point of not using `===` here.
	let diff = 0;
	for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expectedHash[i];
	return diff === 0;
}

async function hmacKey(secret) {
	return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signJwt(payload, secret, expiresInSeconds) {
	const header = { alg: 'HS256', typ: 'JWT' };
	const now = Math.floor(Date.now() / 1000);
	const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
	const encHeader = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
	const encPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(fullPayload)));
	const signingInput = `${encHeader}.${encPayload}`;
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
	return `${signingInput}.${toBase64Url(signature)}`;
}

export async function verifyJwt(token, secret) {
	if (!token || typeof token !== 'string') return null;
	const segments = token.split('.');
	if (segments.length !== 3) return null;
	const [encHeader, encPayload, encSignature] = segments;
	let signatureBytes;
	try {
		signatureBytes = fromBase64Url(encSignature);
	} catch (err) {
		return null;
	}
	const key = await hmacKey(secret);
	const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(`${encHeader}.${encPayload}`));
	if (!valid) return null;
	let payload;
	try {
		payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encPayload)));
	} catch (err) {
		return null;
	}
	if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) return null;
	return payload;
}
