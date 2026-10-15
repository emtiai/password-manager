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
        // Android unterstützt PRF nur für echte Passkeys (Google Passwortmanager),
        // nicht für den älteren Weg ohne auffindbaren Schlüssel.
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  const ext = cred.getClientExtensionResults?.().prf;
  if (!ext?.enabled && !ext?.results) {
    throw new Error('Der gewählte Passkey-Speicher unterstützt die nötige PRF-Funktion nicht. Bitte erneut versuchen und als Speicherort den „Google Passwortmanager“ wählen (nicht Samsung Pass o. Ä.). Chrome sollte aktuell sein.');
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

// Übersetzt WebAuthn-Fehler in verständliche Hinweise (inkl. technischem Namen zur Fehlersuche).
export function describeBiometricError(ex) {
  const hints = {
    NotAllowedError: 'Vorgang abgebrochen oder Zeit abgelaufen. Bitte erneut versuchen und den Fingerabdruck bestätigen.',
    InvalidStateError: 'Für diese App existiert auf dem Gerät bereits ein Passkey. Bitte in den Einstellungen des Google Passwortmanagers den Eintrag für „emtiai.github.io“ löschen und erneut versuchen.',
    NotSupportedError: 'Dieses Gerät oder der gewählte Passkey-Speicher unterstützt das Verfahren nicht. Bitte den „Google Passwortmanager“ als Speicherort wählen.',
    SecurityError: 'Sicherheitsfehler: Die App muss über https://emtiai.github.io/… geöffnet werden, nicht über eine lokale Datei oder einen lokalen Server.',
    ConstraintError: 'Auf dem Gerät ist keine Bildschirmsperre mit Fingerabdruck eingerichtet.',
  };
  const text = hints[ex?.name] || ex?.message || String(ex);
  return `${text}\n\n(Technisch: ${ex?.name || 'Error'}: ${ex?.message || ''})`;
}
