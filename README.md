# PW Tresor

Lokaler, verschlüsselter Passwort-Manager als Web-App (PWA) fürs Smartphone.
Kein Server, keine Cloud: alle Daten bleiben verschlüsselt auf dem Gerät.

## Funktionen

- **Verschlüsselung**: AES-256-GCM; der Schlüssel wird mit PBKDF2-SHA256 (600.000 Runden) aus dem Master-Passwort abgeleitet. Nur WebCrypto, keine Krypto-Bibliotheken.
- **Fingerabdruck / Face ID**: über einen Passkey mit der WebAuthn-**PRF**-Erweiterung. Der Fingerabdruck gibt einen echten Schlüssel frei, er ist also mehr als nur eine Sperre auf der Oberfläche.
- **Kamera-Erkennung**: Die Kamera wird auf einen anderen Bildschirm (PC, Laptop, TV) gerichtet. Die Texterkennung liest die Domain (z. B. `amazon.de`) und zeigt den passenden Eintrag. Läuft komplett offline mit Tesseract.js.
- **Teilen-Ziel (Android)**: In Browser oder App auf „Teilen“ → **PW Tresor** tippen, dann erscheint der passende Eintrag.
- Schnell kopieren direkt aus der Liste; die Zwischenablage wird automatisch geleert.
- Passwort-Generator, Favoriten, „Zuletzt verwendet“, Suche
- Automatische Sperre bei Inaktivität und im Hintergrund
- **Geräte abgleichen**: „Teilen (Bluetooth / Quick Share)“ schickt alle Einträge verschlüsselt an ein anderes Gerät. Dort „Teilen → PW Tresor“ oder „Importieren“ wählen. Neue, geänderte und **gelöschte** Einträge werden zusammengeführt; bei Konflikten gewinnt die neuere Änderung.
- Verschlüsselter Export und Import als Backup, CSV-Import aus Chrome, Firefox, Bitwarden und KeePass
- Offline-fähig (Service Worker), strenge Content-Security-Policy, keine externen Skripte

## Installation

Die App muss über **HTTPS** ausgeliefert werden; das ist Pflicht für PWA, Kamera und Fingerabdruck.
Am einfachsten geht das mit **GitHub Pages**:

1. Repository → *Settings* → *Pages* → *Deploy from a branch* → Branch `main`, Ordner `/ (root)`
2. Nach 1–2 Minuten ist die App unter `https://<benutzer>.github.io/<repo>/` erreichbar.
3. Auf dem Handy öffnen:
   - **Android (Chrome)**: Menü ⋮ → *App installieren*
   - **iPhone (Safari)**: Teilen → *Zum Home-Bildschirm*
4. Master-Passwort festlegen, dann in den *Einstellungen* den Fingerabdruck aktivieren.

> GitHub Pages liefert nur die App-Dateien aus. Die Passwörter werden nie hochgeladen.
> Hinweis: Bei einem kostenlosen Konto muss das Repository für GitHub Pages öffentlich sein. Das ist unkritisch, weil der Code keine Daten enthält.

Lokal testen: `python3 -m http.server 8080` und dann `http://localhost:8080` öffnen (localhost gilt als sicherer Kontext).

## Sicherheitsmodell

```
Master-Passwort ──PBKDF2──► KEK₁ ──┐
                                    ├─ entschlüsselt ─► Tresor-Schlüssel ──AES-GCM──► Einträge
Fingerabdruck ──PRF+HKDF──► KEK₂ ──┘
```

- Gespeichert werden nur Salt, verschlüsselter Tresor-Schlüssel und verschlüsselte Daten (IndexedDB).
- Der Tresor-Schlüssel liegt nur im Arbeitsspeicher, solange die App entsperrt ist.
- Der Fingerabdruck-Passkey ist an dieses Gerät gebunden (bzw. an iCloud-/Google-Passwortmanager). Das Master-Passwort bleibt immer der Weg zur Wiederherstellung.

**Wichtig**

- Das Master-Passwort lässt sich **nicht** wiederherstellen.
- **Regelmäßig exportieren.** Wenn die Browserdaten gelöscht werden oder das Handy verloren geht, ist der Tresor sonst weg.
- Eine Web-App kann **kein** automatisches Ausfüllen in anderen Apps anbieten (Android-Autofill bzw. iOS-Passwortanbieter). Dafür wäre eine native App nötig.
- Das Teilen-Ziel funktioniert nur unter Android. iOS unterstützt das für Web-Apps nicht.
- Die Kamera kann nicht den eigenen Bildschirm des Handys erfassen.

## Kompatibilität

| Funktion | Android (Chrome) | iPhone (Safari) |
|---|---|---|
| App, Offline, Verschlüsselung | ✅ | ✅ |
| Fingerabdruck / Face ID (PRF) | ✅ Android 9+ | ✅ iOS 18+ |
| Kamera-Erkennung | ✅ | ✅ |
| Teilen-Ziel (Links & Dateien empfangen) | ✅ | ❌ |
| Teilen per Bluetooth / Quick Share | ✅ | ✅ (AirDrop) |

## Projektstruktur

```
index.html            App-Shell + Content-Security-Policy
manifest.webmanifest  PWA-Manifest inkl. Teilen-Ziel
sw.js                 Service Worker (Offline-Cache)
css/style.css
js/app.js             Oberfläche, Navigation, Auto-Sperre
js/vault.js           Tresor: anlegen, entsperren, speichern, Export/Import
js/crypto.js          WebCrypto, Passwort-Generator
js/webauthn.js        Fingerabdruck (Passkey + PRF)
js/storage.js         IndexedDB
js/domain.js          Domain-Erkennung und Zuordnung
js/ocr.js             Kamera + Texterkennung
vendor/tesseract/     Tesseract.js 5.1.1 (Apache-2.0), lokal mitgeliefert
```

Nach Änderungen an Dateien in `sw.js` die `VERSION` erhöhen, damit installierte Apps die neue Version laden.
