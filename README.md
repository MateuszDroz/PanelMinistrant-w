# Panel Ministrantów

<div align="center">

**Kompleksowy system zarządzania grupą ministrantów**

[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?style=flat&logo=google&logoColor=white)](https://script.google.com)
[![Netlify](https://img.shields.io/badge/Netlify-00C7B7?style=flat&logo=netlify&logoColor=white)](https://netlify.com)
[![OneSignal](https://img.shields.io/badge/OneSignal-E54B4D?style=flat&logo=onesignal&logoColor=white)](https://onesignal.com)
[![ESP32](https://img.shields.io/badge/ESP32-RFID-E7352C?style=flat&logo=espressif&logoColor=white)](https://www.espressif.com)
[![Google Sheets](https://img.shields.io/badge/Google%20Sheets-34A853?style=flat&logo=googlesheets&logoColor=white)](https://sheets.google.com)

Aplikacja webowa do prowadzenia ewidencji obecności, punktów i dyżurów ministrantów.
Rejestracja obecności przez **karty RFID (ESP32 + RC522)** oraz **check-in QR z weryfikacją GPS**.
Powiadomienia push przez **OneSignal**. Dane trzymane w **Google Sheets**, backend w **Google Apps Script**.

</div>

---

## Spis treści

1. [Wprowadzenie](#1-wprowadzenie)
2. [Funkcje — szczegółowy opis](#2-funkcje--szczegółowy-opis)
3. [Technologie i architektura](#3-technologie-i-architektura)
4. [Struktura repozytorium](#4-struktura-repozytorium)
5. [Opis najważniejszych plików](#5-opis-najważniejszych-plików)
6. [Model danych (arkusze Google Sheets)](#6-model-danych-arkusze-google-sheets)
7. [Kontrakt HTTP — endpointy backendu](#7-kontrakt-http--endpointy-backendu)
8. [System punktowy](#8-system-punktowy)
9. [System RFID (ESP32)](#9-system-rfid-esp32)
10. [System powiadomień push (OneSignal)](#10-system-powiadomień-push-onesignal)
11. [System dyżurów, kalendarza i passy](#11-system-dyżurów-kalendarza-i-passy)
12. [System wniosków i ticketów](#12-system-wniosków-i-ticketów)
13. [Moduł ogłoszeń, ankiet i komentarzy](#13-moduł-ogłoszeń-ankiet-i-komentarzy)
14. [Panel administratora](#14-panel-administratora)
15. [System uprawnień i role](#15-system-uprawnień-i-role)
16. [Wdrożenie własnej instancji](#16-wdrożenie-własnej-instancji)
17. [Konfiguracja (Script Properties)](#17-konfiguracja-script-properties)
18. [Bezpieczeństwo](#18-bezpieczeństwo)
19. [Prywatność i RODO](#19-prywatność-i-rodo)
20. [Rozwiązywanie problemów](#20-rozwiązywanie-problemów)
21. [Współtworzenie](#21-współtworzenie)
22. [Licencja](#22-licencja)

---

## 1. Wprowadzenie

### 1.1. Czym jest ten projekt

**Panel Ministrantów** to kompletny, samodzielny system informatyczny do zarządzania grupą ministrantów w parafii. Został pierwotnie stworzony dla jednej konkretnej parafii, ale został zaprojektowany w taki sposób, żeby **każda parafia mogła postawić własną, niezależną instancję** — z własną bazą danych (arkusz Google Sheets), własnym kontem OneSignal (dla powiadomień push) i własnym urządzeniem RFID.

### 1.2. Do czego służy

System obsługuje cały cykl życia ministranta w parafii:

- **Ewidencja obecności** — na mszach, zbiórkach, uroczystościach.
- **Punktacja** — punkty dodatnie (za służbę) i ujemne (za nieobecność), ranking, historia.
- **Dyżury** — stałe (cotygodniowe), jednorazowe (np. niedziela 18:00), historia zmian, passa.
- **Wnioski** — o przesunięcie dyżuru, o nieobecność, o dodatkowe punkty, o zdjęcie blokady zdjęcia.
- **Komunikacja** — ogłoszenia, ankiety, komentarze, tickety do administracji.
- **Powiadomienia push** — o nowym ogłoszeniu, o zbliżającym się dyżurze, o przyznanych punktach.
- **Diagnostyka** — zdalne raportowanie błędów z czytników RFID, statystyki, logi administracyjne.

### 1.3. Dla kogo

- **Ministranci** — sprawdzają swoje punkty, dyżury, kalendarz, składają wnioski.
- **Lektorzy** — dodatkowo mogą samodzielnie ustawiać swój dyżur.
- **Moderatorzy** — pomagają administratorowi w codziennej pracy.
- **Administratorzy** — pełny dostęp do ustawień, statystyk, logów i zarządzania użytkownikami.
- **Księża** — podgląd statystyk i logów, bez punktów (nie są w systemie punktowym).

### 1.4. Kluczowe cechy

| Cecha | Opis |
|---|---|
| **Zero kosztów utrzymania** | Wszystko działa w darmowych planach: Google Apps Script, Google Sheets, Netlify, OneSignal, ESP32 to jednorazowy zakup sprzętu. |
| **Samoobsługa** | Ministranci sami składają wnioski, sami sprawdzają punkty, sami zmieniają hasła. |
| **Odporność na awarie** | Backend korzysta z `LockService`, `CacheService`, deduplikacji i automatycznych retry. |
| **Bezpieczeństwo** | Hasła hashowane (sól + setki iteracji MD5), blokada po błędnych logowaniach, tokeny sesji per urządzenie. |
| **Wielourządzeniowość** | „Zapamiętaj mnie" działa na wielu urządzeniach jednocześnie (osobny token per urządzenie). |
| **Odporność na iOS ITP** | Most `postMessage` z Netlify do iframe GAS obchodzi ograniczenia `localStorage` w Safari. |

---

## 2. Funkcje — szczegółowy opis

### 2.1. Uwierzytelnianie i sesje

#### Logowanie
- Pola: **ID** (4-cyfrowy numer ministranta lub ID karty) i **hasło**.
- Weryfikacja po stronie backendu — hasła są przechowywane jako `sol$hash`.
- Obsługa dwóch ID na osobę: głównego (kolumna A arkusza `Hasła`) i drugiego (kolumna G — „chwilowe ID").
- Po poprawnym logowaniu backend zwraca: `userId`, `rola`, `imie`, `token` (UUID sesji), `wymagaZmiany`, `theme`, opcjonalnie `przerwaTechniczna`, `zielonyBaner`.

#### Hashowanie haseł
- Sól: 16 losowych bajtów zapisanych w hex.
- Hash: `MD5(sól + hasło)` powtórzone `_HASH_ITERACJE = 500` razy.
- Format zapisu: `sol$hash` w kolumnie C arkusza `Hasła`.
- Migracja starych haseł jawnych: przy pierwszym poprawnym logowaniu następuje zamiana na format hashowany.

#### Blokada konta (progressive lockout)
| Poziom | Liczba błędnych prób | Czas blokady |
|---|---|---|
| 0 | 5 | 1 minuta |
| 1 | 3 (po odblokowaniu) | 5 minut |
| 2 | 1 (po odblokowaniu) | **Trwała** |

- Blokada czasowa resetuje się automatycznie po upływie czasu.
- Blokada trwała wymaga ręcznego odblokowania przez administratora (generuje nowe hasło tymczasowe).
- **Automatyczny decay**: po 24 godzinach ciszy od ostatniej błędnej próby licznik wraca do poziomu 0.

#### „Zapamiętaj mnie"
- 30-dniowy token zapisany w arkuszu `Sesje_urzadzen` (kolumny: `DeviceID`, `UserID`, `Token`, `Imie`, `Rola`, `DataWaznosci`).
- Autologin przy wejściu na stronę (przed pokazaniem formularza logowania).
- Data ważności odświeżana przy każdym użyciu (sliding window).
- `DeviceID` to UUID generowany raz i zapisany w `localStorage` + cookie (obejście iOS ITP).

#### Wymuszona zmiana hasła
- Po pierwszym logowaniu lub po resecie hasła przez admina — flaga `Zmiana = false` w arkuszu `Hasła`.
- Wymaga jednocześnie: nowego hasła i wyboru stałego dyżuru (jeśli nowy rok formacyjny).

#### Zmiana hasła z panelu
- Dostępna dla każdego użytkownika (Administracja i wnioski → Zmiana hasła).
- Wymaga podania aktualnego hasła + nowego hasła dwa razy.
- Nie wymaga akceptacji administratora.

### 2.2. System punktowy

#### Źródła punktów
| Kanał | Opis |
|---|---|
| **Czytnik RFID (ESP32)** | Automatyczna rejestracja po przyłożeniu karty |
| **Check-in QR** | Weryfikacja po ID + GPS (strona `checkin.html`) |
| **Wpis ręczny** | Admin dodaje punkty pojedynczo |
| **Wpis masowy** | Admin dodaje punkty grupie osób jednocześnie |
| **Akceptacja wniosku o punkty** | Admin akceptuje wniosek, system tworzy wpis |
| **Automatyczne minusy** | System nalicza po upływie okna odbicia (co 15 min trigger) |

#### Punktacja — tabela domyślna
| Zdarzenie | Punkty |
|---|---|
| Wielka Sobota | +15 |
| Triduum Paschalne | +15 |
| Służba na uroczystości | +12 |
| Msza Święta w niedzielę | +7 |
| Pogrzeb / Ślub | +7 |
| Dyżur | +4 |
| Msza Święta w tygodniu | +4 |
| Droga Krzyżowa | +4 |
| Różaniec październikowy | +5 |
| Zbiórka ogólna (LSO) | +6 |
| Nabożeństwo majowe/czerwcowe | +2 |
| Dodatkowe zaangażowanie | +1 … +10 |
| Nieobecność na dyżurze | −4 |
| Nieobecność na uroczystości | −12 |

#### Modyfikatory
- **Dyżur + msza**: jeśli ministrant ma dyżur w czasie mszy, zamiast punktów za mszę dostaje punkty za dyżur (nazwa: „Dyżur (Msza Święta 18:00)").
- **Sobota 18:00** traktowana jak msza niedzielna (+7), chyba że ktoś ma wtedy dyżur — wtedy +4.
- **Bonusy sezonowe**: nabożeństwo majowe do mszy 18:00 w maju/czerwcu (+2).
- **Październik**: osobny slot na różaniec 17:30 (+5), alternatywnie „Msza + Różaniec" (+9).

#### Zapobieganie duplikatom
- Ten sam typ wydarzenia (pełna nazwa, np. „Msza Święta 07:00") może być zaliczony **tylko raz dziennie**.
- „Dyżur" blokuje kolejny „dyżur" tego samego dnia (1 dyżur/dzień/osoba).
- Auto-minusy mają klucz idempotencji w kolumnie Opis (np. `AUTO_MINUS_DYZUR|2026-09-21|18:00`).

#### Historia punktacji
- Każdy wpis ma timestamp, autora (kto przyznał), wydarzenie, punkty i opis.
- Widoczna w profilu ministranta (paginacja po 5, potem „Pokaż więcej").
- Opisy z kluczami technicznymi są automatycznie formatowane na czytelne (np. `AUTO_MINUS_DYZUR|...` → „Brak potwierdzonej obecności na wydarzeniu…").

#### Ranking
- Trzy filtry: wszyscy / ministranci / lektorzy.
- Opcjonalny zakres dat (punkty liczone z logów).
- Pozycja własna wyróżniona na liście i pokazana w osobnej karcie „Twoja pozycja".
- Eksport do PDF (A4 pion, kolorowanie miejsc 1–3).

### 2.3. Kalendarz i dyżury

#### Kalendarz miesięczny
- Widok siatki z kolorami wg typu wydarzenia:
  - **Niebieski** — dyżur
  - **Zielony** — zbiórka
  - **Pomarańczowy** — uroczystość
  - **Fioletowy** — Triduum
  - **Turkusowy** — wydarzenie informacyjne (0 pkt)
- Kropki wskazują typy wydarzeń w danym dniu.
- Kliknięcie dnia otwiera modal „Plany na dzień".

#### Typy wydarzeń
- **Uroczystość** — +12 pkt.
- **Triduum Paschalne** — +15 pkt (osobny typ).
- **Wielka Sobota** — +15 pkt (osobny typ).
- **Zbiórka** — +4 pkt (naliczana ręcznie, nie łapie się na RFID).
- **Wydarzenie informacyjne** — 0 pkt (pokazywane tylko w kalendarzu).

#### Powtarzalność
Obsługiwane tryby:
| Tryb | Opis |
|---|---|
| `brak` | Jednorazowe wydarzenie |
| `codzien` | Każdego dnia |
| `cotygodnia` | Co tydzień w ten sam dzień |
| `dzien_miesiaca` | Każdego X dnia miesiąca (X = 1–31, z korektą dla krótszych miesięcy) |
| `pierwszy_niedziela` | Pierwsza niedziela każdego miesiąca |
| `pierwszy_poniedzialek` | Pierwszy poniedziałek |
| ... | Analogicznie dla pozostałych dni |

- Każde wystąpienie dostaje wspólny `groupId` (np. `REP-1727361234567-54321`), dzięki czemu można je usunąć całą serią.
- Lista planów grupuje wystąpienia w jedną pozycję: „🔁 Powtarza się co tydzień · 12× do 15.12.2026".
- Stare (legacy) wpisy bez `groupId` rozpoznawane po nazwie + punktach + opisie i grupowane razem.

#### Okno odbijania karty RFID
- Konfigurowalne **per wydarzenie** (kolumny G, H arkusza `Kalendarz`).
- Wartości: `OknoOdMin` (ile minut przed startem) i `OknoDoMin` (ile minut po starcie).
- Domyślnie: tydzień −30 min / +60 min, niedziela i sobota 18:00 −30 min / +75 min.
- Puste wartości = fallback na domyślne.

#### Dyżury stałe
- Tabela `Dyżury`: `Data i Godzina | Imię i Nazwisko | ID | Obowiązuje od | Obowiązuje do`.
- Występują cotygodniowo (poniedziałek–sobota, bez niedziel).
- Trzy dozwolone godziny: 7:00, 8:00, 18:00.
- **Historia zmian**: zamiast nadpisywać wiersz, system zamyka stary okres (`Obowiązuje do` = wczoraj) i dopisuje nowy.
- „Obowiązuje od" puste = od zawsze; „Obowiązuje do" puste = wciąż aktywny.

#### Dyżury jednorazowe
- Dodawane z niedzieli 18:00 (+7 pkt, jak msza niedzielna).
- Oznaczane jako `jednorazowy: true` (Obowiązuje od === Obowiązuje do).
- Pokazują się w kalendarzu tylko w swoim dniu (bez rozciągania na kolejne tygodnie).

#### Passa dyżurów
- Liczba **kolejnych tygodni** z obecnością na dyżurze lub zaakceptowaną nieobecnością.
- Liczona przez dopasowanie każdego dyżuru z arkusza `Dyżury` do logów RFID w oknie ±45 min.
- Nadpisanie admina (per tydzień) ma priorytet nad logami.
- Widok badge'a w pasku górnym (🔥 N) — kliknięcie otwiera historię tygodniową.
- **Reset passy** — admin może wyzerować wszystkim (wymaga kodu 4-cyfrowego). Po resecie pierwszy liczący się tydzień to następny poniedziałek.

#### Lista planów na przyszłość
- Pokazuje najbliższe wydarzenia w kolejności chronologicznej.
- Dyżury grupowane w zwijaną sekcję `<details>`.
- Paginacja: 5 pozycji, potem „Pokaż więcej".

### 2.4. Wnioski

#### Wniosek o zmianę dyżuru
- Ministrant wybiera swój dyżur + nowy termin (dzień + godzina).
- Podaje powód.
- Admin akceptuje → stary dyżur zostaje zamknięty (Obowiązuje do = wczoraj), nowy dopisany.
- Admin odrzuca → powód odrzucenia widoczny dla wnioskodawcy.
- **Konflikt interesów**: admin nie może rozpatrzyć własnego wniosku.

#### Wniosek o nieobecność na dyżurze
- Data + godzina dyżuru (wybór z selecta), powód, opcjonalnie proponowane odrobienie.
- Po akceptacji: passa zachowana, brak minusa punktowego.
- **Precyzyjne dopasowanie**: data + godzina (wniosek o 07:00 nie blokuje auto-minusa dla 18:00 tego samego dnia).

#### Wniosek o punkty dodatkowe
- Kategoria (pomoc w parafii, prace porządkowe, przygotowanie liturgii, inne).
- Opis (min. 5 znaków).
- Proponowana liczba punktów (1–20).
- Admin akceptuje z możliwością korekty liczby punktów.

#### Odwołanie od blokady zdjęcia profilowego
- Użytkownik z aktywną blokadą może napisać uzasadnienie (min. 10 znaków).
- Admin akceptuje → blokada zdjęta, punkty dopisane (jeśli było zaznaczone „dodaj +4 pkt za obecność").
- Admin odrzuca → blokada zostaje, komentarz widoczny dla użytkownika.

#### Ticket do administracji
- Kategorie: ranga/awans, dyżury, konto/hasło, punkty, błąd aplikacji, inne.
- Dwukierunkowy czat między użytkownikiem a adminem.
- Możliwość dodawania zdjęć.
- Możliwość zaproszenia innych adminów/ministrantów do rozmowy (helperzy).
- Status: `Otwarty` / `Zamknięty`.
- Przejęcie ticketu przez admina (atomowe, przez LockService).

### 2.5. Ogłoszenia, ankiety, komentarze

#### Posty (ogłoszenia)
- Tytuł + treść + opcjonalne zdjęcia (z telefonu/komputera, upload na Drive).
- Autor widoczny jako avatar + imię.
- Paginacja: 10 postów na stronę, przyciski „Nowsze" / „Starsze".
- Edycja/usuwanie tylko przez admina/moderatora.
- Wzmianki `@Imię_Nazwisko` i `@ranga` (np. `@wszyscy`, `@Ministrant`) → powiadomienie push do oznaczonych.
- **Reakcje iMessage-style**: 👍 ❤️ 🙏 😂 😭 — pojedyncza reakcja per user per post.
- Komentarze z możliwością dodawania zdjęć.
- Podgląd listy osób, które zareagowały.

#### Ankiety
- Pytanie + opcje (min. 2).
- Każda opcja może mieć tekst, zdjęcie lub oba.
- Opcjonalne załączniki (zdjęcia do samej ankiety).
- Czas trwania (opcjonalny) — po upływie automatyczne zamknięcie.
- Autor widzi, kto jak zagłosował (przycisk „Kto głosował").
- Admin widzi wszystkie ankiety.
- Komentarze i reakcje działają analogicznie do postów (wspólne arkusze z ujemnym ID).

#### Moderacja
- Admin/moderator widzi przyciski „Zamknij" / „Usuń".
- Usunięcie ankiety usuwa też jej komentarze i głosy.

### 2.6. Powiadomienia

#### Push (OneSignal)
- Wymaga zgody użytkownika (baner „Włącz powiadomienia" z opcją „Nie teraz" — snooze do jutra).
- Działa na Netlify jako top-level (nie w iframe GAS) — wymóg iOS.
- Trzy typy zdarzeń push:
  1. **Wzmianki @** w postach/komentarzach.
  2. **Przypomnienia o dyżurze** — dzień wcześniej o 20:00 i 2h przed startem.
  3. **Nowe ogłoszenia/ankiety**, akceptacje wniosków, przyznane punkty.

#### Dzwonek in-app (centrum powiadomień)
- Zapisane w arkuszu `Powiadomienia_zdarzenia` (widoczne dla użytkownika) i `Powiadomienia_wyslane` (dedup — żeby nie wyświetlać drugi raz).
- Preferencje per typ: user w Ustawieniach włącza/wyłącza poszczególne kategorie.
- Ksiądz widzi tylko wzmianki @.

#### Zgodność z iOS/Safari
- Zgody push trzymane **per urządzenie** (arkusz `Powiadomienia_Zgoda` z kolumną `DeviceID`).
- Backup „legacy" (bez `DeviceID`) na wypadek gdyby Safari wyczyścił `localStorage` (ITP) i zmienił UUID urządzenia.

### 2.7. Check-in QR

#### Jak działa
1. Użytkownik wchodzi na `checkin.html` (np. ze skanu QR kodu w zakrystii).
2. Wpisuje swoje ID (bez hasła).
3. Przeglądarka pobiera lokalizację GPS.
4. Backend sprawdza:
   - czy ID istnieje w arkuszu `Hasła`,
   - czy odległość od kościoła ≤ `checkin_promien_m` (+ tolerancja GPS),
   - czy dokładność GPS ≤ 500 m,
   - czy w tym momencie jest msza/dyżur w oknie czasowym.
5. Jeśli kilka nabożeństw nakłada się — użytkownik wybiera z listy.
6. Zapisanie obecności identyczne jak z RFID.

#### Weryfikacja GPS
- Odległość liczona wzorem haversine.
- Kościół zdefiniowany przez `checkin_lat`, `checkin_lng` w Script Properties.
- Limit: `checkin_promien_m + min(accuracy, 80)` — tolerancja błędu GPS.
- Można wyłączyć (`checkin_geo_wymagane = false`).

### 2.8. Moduł dostępności

- Aktywny **tydzień przed** uroczystością/Triduum/Wielką Sobotą.
- Ministranci oznaczają „✅ Dostępny" / „❌ Niedostępny".
- Dane zapisywane w arkuszu `Dostepnosc`, widoczne dla admina w Statystykach.
- Push wysyłany dzień wcześniej o 20:00 do tych, którzy jeszcze nie odpowiedzieli.

### 2.9. Baza wiedzy

- Moduł dla kandydatów i ministrantów (bez lektorów i księży).
- Kategorie: Kandydatura, Służba Ministrancka, Liturgia, Ogólne.
- Wpisy z tytułem, treścią i załącznikami (zdjęcia/PDF).
- Wyszukiwarka kategorii (chipy filtrów).
- **Domyślnie ukryty** w bocznym menu (flaga `display:none` w linku) — można włączyć w każdej chwili.

### 2.10. Motyw jasny/ciemny

- Przełącznik w Ustawieniach.
- Zapisywany w Script Properties (`Ustawienia_uzytkownikow`).
- Synchronizacja z parent (Netlify) przez `postMessage` — żeby tło i pasek statusu iPhone'a były spójne.

---

## 3. Technologie i architektura

### 3.1. Stack technologiczny

| Warstwa | Technologia | Uwagi |
|---|---|---|
| Backend | Google Apps Script (V8) | Darmowy, wbudowany w Google Workspace |
| Baza danych | Google Sheets | Darmowy do 15 GB, wystarczy dla parafii |
| Frontend | HTML / CSS / Vanilla JS | Bez frameworka — pełna kontrola |
| Hosting shell | Netlify | Darmowy, obsługa `<iframe>` i Service Workera |
| Powiadomienia | OneSignal | Darmowy do 10 000 subskrybentów |
| Pliki | Google Drive | Zdjęcia profilowe, załączniki do postów |
| Hardware | ESP32 + RC522 | Czytnik RFID, ~50 zł |
| Wyświetlacz | LCD 16×2 (I²C) | Informacja dla ministranta |
| Klawiatura | 4×4 membrane | Wybór opcji przy kolizji nabożeństw |

### 3.2. Diagram architektury
