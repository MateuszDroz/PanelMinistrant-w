# PanelMinistrant-w
PanelMinistrantów by Mateusz Droż
<div align="center">

# Panel Ministrantów
### System zarządzania grupą ministrantów

[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?style=flat&logo=google&logoColor=white)](https://script.google.com)
[![Netlify](https://img.shields.io/badge/Netlify-00C7B7?style=flat&logo=netlify&logoColor=white)](https://netlify.com)
[![OneSignal](https://img.shields.io/badge/OneSignal-E54B4D?style=flat&logo=onesignal&logoColor=white)](https://onesignal.com)

Aplikacja webowa do zarządzania ministrantami — obecności, punkty, dyżury, RFID i powiadomienia push.

*Parafia Najświętszej Maryi Panny Nieustającej Pomocy*

</div>

---

## Funkcje

- **Logowanie** z hashowanymi hasłami (MD5 + sól)
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

## Architektura

```
Netlify (shell)
    └── iframe
            └── Google Apps Script /exec
                    ├── doGet()          → panel HTML
                    ├── ?action=rfid     → odbicia RFID
                    ├── ?action=checkin  → check-in QR
                    ├── ?action=config   → konfiguracja ESP32
                    └── ?action=err      → diagnostyka ESP32
```

Komunikacja Netlify ↔ GAS przez `postMessage` (most localStorage) — GAS działa w podwójnie zagnieżdżonym cross-origin iframe.

---

## API czytnika RFID

**Pobierz zdarzenia przy starcie:**
```
GET ?action=config
→ { "sukces": true, "wydarzenia": [{ "kod": "AUTO", "nazwa": "Auto (msza/dyżur)", "punkty": 0 }] }
```

**Przyłożenie karty:**
```
GET ?action=rfid&uid=XXXX&type=AUTO&device=nazwa_czytnika
→ { "sukces": true, "imie": "Jan", "wydarzenie": "Msza", "punkty": 5, "suma": 120 }
```

Tryb `AUTO` wykrywa automatycznie czy trwa msza czy dyżur na podstawie kalendarza.

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

Wrażliwe dane ustaw w **Script Properties** w GAS (`Projekt → Ustawienia projektu → Właściwości skryptu`), nigdy nie wpisuj ich bezpośrednio w kodzie:

| Klucz | Opis |
|---|---|
| `onesignal_app_id` | App ID z panelu OneSignal |
| `onesignal_rest_key` | REST API Key z panelu OneSignal |
| `checkin_lat` | Szerokość geograficzna (check-in) |
| `checkin_lng` | Długość geograficzna (check-in) |
| `checkin_promien` | Promień check-inu w metrach |

---

## Wdrożenie

1. Utwórz nowy projekt w [Google Apps Script](https://script.google.com)
2. Wgraj pliki `Kod.gs` i `Index.html`
3. Ustaw Script Properties (patrz wyżej)
4. `Wdróż → Nowe wdrożenie → Aplikacja internetowa` → dostęp: `Wszyscy`
5. Skopiuj URL wdrożenia do zmiennych środowiskowych Netlify

---

## Struktura arkuszy

| Arkusz | Kolumny |
|---|---|
| `Hasła` | ID, Imię i Nazwisko, Hasło, Rola |
| `Karty_RFID` | UID karty, ID ministranta, Imię i Nazwisko, Aktywna |
| `Zdarzenia_czytnika` | Kod, Nazwa, Punkty, Aktywne |
| `Logi_czytnik` | Data, ID, Imię i Nazwisko, Czytnik, Wydarzenie, Punkty |
| `Sesje_urzadzen` | DeviceID, UserID, Token, Imię, Rola, DataWażności |

---

## Licencja

Projekt prywatny — wszelkie prawa zastrzeżone.  
© Mateusz Droż / Parafia Najświętszej Maryi Panny Nieustającej Pomocy
