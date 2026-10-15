// Fingerabdruck / Face-ID über WebAuthn (Passkey) mit der PRF-Erweiterung.
//
// Die PRF-Erweiterung liefert pro Passkey + Salt ein geheimes 32-Byte-Ergebnis,
// das nur nach erfolgreicher biometrischer Prüfung herausgegeben wird. Daraus
// wird ein Schlüssel abgeleitet, der den Tresor-Schlüssel entschlüsselt.
// Es gibt keinen Server: die "Challenge" ist zufällig und wird nicht geprüft,
// die Sicherheit beruht allein auf dem PRF-Geheimnis im Authenticator.

import { randomBytes } from './crypto.js';

export async function isBiometricAvailable() {
  try {
    return !!window.PublicKeyCredential
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function prfResult(cred) {
  const r = cred.getClientExtensionResults?.().prf;
  return r?.results?.first ? new Uint8Array(r.results.first) : null;
}

export async function registerBiometric(prfSalt) {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'PW Tresor', id: location.hostname },
      user: { id: randomBytes(16), name: 'PW Tresor', displayName: 'PW Tresor' },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'discouraged',
        userVerification: 'required',
      },
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  const ext = cred.getClientExtensionResults?.().prf;
  if (!ext?.enabled && !ext?.results) {
    throw new Error('Dieses Gerät/dieser Browser unterstützt die PRF-Erweiterung nicht. Entsperren per Fingerabdruck ist hier leider nicht möglich.');
  }
  const credId = new Uint8Array(cred.rawId);
  // Manche Plattformen liefern das PRF-Ergebnis schon bei der Registrierung,
  // andere erst bei einer Anmeldung, dann ist eine zweite Bestätigung nötig.
  const prf = prfResult(cred) ?? await getBiometricSecret(credId, prfSalt);
  return { credId, prf };
}

export async function getBiometricSecret(credId, prfSalt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credId, transports: ['internal', 'hybrid'] }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  const prf = prfResult(cred);
  if (!prf) throw new Error('Kein PRF-Ergebnis erhalten.');
  return prf;
}
