# PanelMinistrant-w
PanelMinistrantów by Mateusz Droż

<div align="center">

# Panel Ministrantów
### System zarządzania grupą ministrantów

[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?style=flat&logo=google&logoColor=white)](https://script.google.com)
[![Netlify](https://img.shields.io/badge/Netlify-00C7B7?style=flat&logo=netlify&logoColor=white)](https://netlify.com)
[![OneSignal](https://img.shields.io/badge/OneSignal-E54B4D?style=flat&logo=onesignal&logoColor=white)](https://onesignal.com)

Aplikacja webowa do zarządzania ministrantami — obecności, punkty, dyżury, RFID i powiadomienia push.

Projekt open source, pierwotnie stworzony dla jednej parafii — możesz postawić własną, niezależną instancję.

</div>

---

## Funkcje

- **Logowanie** z hashowanymi hasłami
- **System punktowy** — msze, zbiórki, wyjazdy, inne zdarzenia
- **Czytnik RFID (ESP32)** — przyłożenie karty rejestruje obecność automatycznie
- **Check-in przez QR kod**
- **Rankingi i statystyki** z eksportem do PDF
- **Dyżury i kalendarz**
- **Powiadomienia push** (OneSignal)
- **Panel admina** — logi, diagnostyka ESP32, zarządzanie użytkownikami
- **Zgłaszanie błędów** przez użytkowników
- **Wnioski i ankiety**

---

## Technologie

| Warstwa | Technologia |
|---|---|
| Backend | Google Apps Script |
| Frontend | HTML / CSS / JS (HtmlService) |
| Baza danych | Google Sheets |
| Hosting | Netlify |
| Push | OneSignal |
| Hardware | ESP32 + RC522 (RFID) |

---

## Architektura (skrót)

```
Netlify (shell)
    └── Google Apps Script /exec
            ├── panel webowy (logowanie, punkty, dyżury)
            ├── endpoint dla czytnika RFID
            ├── endpoint check-in QR
            └── endpointy konfiguracji / diagnostyki ESP32
```

Pełna specyfikacja endpointów, formatu zapytań i odpowiedzi znajduje się w [`docs/API.md`](docs/API.md) — czytaj ją, jeśli integrujesz własny czytnik lub rozwijasz backend. Nie publikujemy tu szczegółów działającej instancji parafialnej.

---

## Role użytkowników

| Rola | Uprawnienia |
|---|---|
| `MINISTRANT` | Własne punkty, dyżury, profil |
| `MODERATOR` | Edycja dyżurów i punktów innych |
| `ADMIN` | Pełny dostęp, logi, ustawienia |
| `KSIADZ` | Podgląd logów i statystyk |

---

## Konfiguracja

Wrażliwe dane ustaw w **Script Properties** w GAS (`Projekt → Ustawienia projektu → Właściwości skryptu`), nigdy nie wpisuj ich bezpośrednio w kodzie ani nie commituj do repozytorium. Przykładowa lista wymaganych kluczy znajduje się w [`.env.example`](.env.example).

---

## Wdrożenie własnej instancji

1. Sforkuj repozytorium i utwórz własny arkusz Google Sheets (nie używaj arkusza innej instancji).
2. Utwórz nowy projekt w [Google Apps Script](https://script.google.com) i wgraj pliki `Kod.gs` i `Index.html`.
3. Ustaw Script Properties (patrz wyżej i `.env.example`).
4. `Wdróż → Nowe wdrożenie → Aplikacja internetowa` → dostęp: `Wszyscy`.
5. Skopiuj URL wdrożenia do zmiennych środowiskowych Netlify.
6. Zapoznaj się z [`SECURITY.md`](SECURITY.md) przed uruchomieniem produkcyjnym — projekt przechowuje dane osobowe (w tym dzieci), więc wymaga podstawowego utwardzenia zabezpieczeń.

---

## Bezpieczeństwo

Ten projekt przechowuje dane osobowe, w tym dane małoletnich. Przed wdrożeniem produkcyjnym zapoznaj się z [`SECURITY.md`](SECURITY.md). Jeśli znajdziesz podatność, zgłoś ją zgodnie z instrukcją w tym pliku — **nie publikuj jej w publicznym issue**.

---

## Licencja

Projekt udostępniony na licencji **GPL-2.0**. Pełny tekst licencji znajduje się w pliku [`LICENSE`](LICENSE). W skrócie: możesz swobodnie używać, modyfikować i rozpowszechniać ten kod, ale każda rozpowszechniana modyfikacja musi być udostępniona na tych samych warunkach (copyleft) wraz z kodem źródłowym.
