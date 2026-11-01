import { getAddress, verifyMessage } from 'ethers';
import { ApiError } from './economy.ts';
import { worldProfileLinkMessage } from '../src/world-profile.ts';
import type { WorldProfile } from '../src/world-profile.ts';

export function verifyWorldProfileLink(body: unknown, csrf: string, now: number): string {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'address,issuedAt,signature'
    || !('address' in body) || typeof body.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(body.address)
    || !('issuedAt' in body) || typeof body.issuedAt !== 'number' || !Number.isSafeInteger(body.issuedAt)
    || Math.abs(now - body.issuedAt) > 300000 || !('signature' in body) || typeof body.signature !== 'string')
    throw new ApiError(400, 'Invalid World profile link. Sign again.');
  let signer: string;
  try { signer = verifyMessage(worldProfileLinkMessage(body.address, csrf, body.issuedAt), body.signature); }
  catch { throw new ApiError(401, 'Invalid World profile signature.'); }
  const address = getAddress(body.address);
  if (signer !== address || /^0x0{40}$/i.test(address)) throw new ApiError(401, 'World profile signature was not made by this wallet.');
  return address;
}

export function worldProfileReader(origin: string): (address: string) => Promise<WorldProfile | null> {
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('WORLD_PROFILE_API_ORIGIN must be an exact HTTP(S) origin.');
  return async address => {
    let response: Response;
    try { response = await fetch(`${origin}/api/v1/profiles/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }); }
    catch (error) { console.error('World profile request failed:', error); throw new ApiError(503, 'World profile service is unavailable.'); }
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError(503, 'World profile service is unavailable.');
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new ApiError(503, 'World profile service returned an invalid profile.'); }
    if (!body || typeof body !== 'object' || !('profile' in body)) throw new ApiError(503, 'World profile service returned an invalid profile.');
    if (body.profile === null) return null;
    const profile = body.profile;
    if (!profile || typeof profile !== 'object' || !('username' in profile) || typeof profile.username !== 'string'
      || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,23}$/.test(profile.username)
      || !('avatar' in profile) || typeof profile.avatar !== 'string') throw new ApiError(503, 'World profile service returned an invalid profile.');
    return { username: profile.username, avatar: profile.avatar };
  };
}
