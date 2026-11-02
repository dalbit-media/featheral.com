// Ethereum wallet sign-in: verifies a personal_sign (EIP-191) signature without any network access.
const { secp256k1 } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');

const hex = (b) => Buffer.from(b).toString('hex');
const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

// EIP-55 mixed-case checksum form.
function checksum(address) {
  const a = address.toLowerCase().replace(/^0x/, '');
  const h = hex(keccak_256(Buffer.from(a, 'utf8')));
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

function hashMessage(message) {
  const body = Buffer.from(message, 'utf8');
  return keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]));
}

// Address that produced `signature` (0x + 65 bytes r‖s‖v) over `message`, or null if it is malformed.
function recoverAddress(message, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const bytes = Buffer.from(signature.slice(2), 'hex');
  let v = bytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(bytes.subarray(0, 64)).addRecoveryBit(v);
    const pub = sig.recoverPublicKey(hashMessage(message)).toRawBytes(false).subarray(1);
    return checksum('0x' + hex(keccak_256(pub)).slice(-40));
  } catch { return null; }
}

function signInMessage(brand, address, nonce, issuedAt) {
  return `Sign in to ${brand} to leave comments.\n\nWallet: ${address}\nNonce: ${nonce}\nIssued: ${new Date(issuedAt).toISOString()}\n\nThis request does not send a transaction or cost any gas.`;
}

// FTHX is a ledger kept by this site; a top-up is a signed request, not an on-chain transfer.
function depositMessage(brand, address, amount, nonce, issuedAt) {
  return `Add ${amount} FTHX to your balance on ${brand}.\n\nWallet: ${address}\nAmount: ${amount} FTHX\nNonce: ${nonce}\nIssued: ${new Date(issuedAt).toISOString()}\n\nFTHX is recorded by this site only. This request does not send a transaction or cost any gas.`;
}

module.exports = { isAddress, checksum, hashMessage, recoverAddress, signInMessage, depositMessage };
