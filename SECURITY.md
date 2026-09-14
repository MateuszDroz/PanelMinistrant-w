# Bezpieczeństwo

Ten projekt przechowuje dane osobowe, w tym dane osób małoletnich (imiona, nazwiska, obecności, punkty, numery kart RFID). Jeśli wdrażasz własną instancję, potraktuj poniższe punkty jako minimum przed uruchomieniem produkcyjnym.

## Zalecane zmiany przed wdrożeniem produkcyjnym

- **Hashowanie haseł.** Nie używaj MD5 (nawet z solą) do przechowywania haseł — jest to algorytm uznawany za kryptograficznie słaby i podatny na złamanie. Zamień na bcrypt, scrypt lub Argon2 przed uruchomieniem dla realnych użytkowników.
- **Dostęp do arkusza Google Sheets.** Arkusz pełniący rolę bazy danych powinien być udostępniony wyłącznie kontu serwisowemu skryptu, nie szerszemu gronu edytorów.
- **URL wdrożenia GAS.** Traktuj adres `/exec` swojej instancji jako dane wrażliwe — nie publikuj go w publicznych miejscach (commity, fora, zrzuty ekranu). Każdy, kto go zna, może wysyłać zapytania do endpointów opisanych w `docs/API.md`.
- **Autoryzacja endpointów czytnika RFID / check-in.** Sprawdź, czy endpointy wykorzystywane przez ESP32 / QR wymagają tokenu urządzenia (patrz arkusz sesji urządzeń) i nie polegają wyłącznie na nieznajomości parametrów zapytania.
- **Zmienne środowiskowe.** Wszystkie klucze (OneSignal, współrzędne check-inu itd.) trzymaj w Script Properties, nigdy w kodzie ani w repozytorium.

## Zgłaszanie podatności

Jeśli znajdziesz lukę bezpieczeństwa, **nie zgłaszaj jej jako publiczny issue na GitHubie** — mogłoby to ułatwić atak na żywe instancje innych osób (np. konkretnych parafii) zanim zostanie załatana. Zamiast tego zgłoś ją prywatnie autorowi projektu (np. przez prywatną wiadomość / e-mail podany w profilu autora), opisując kroki reprodukcji.

## Odpowiedzialność

To repozytorium jest udostępniane na zasadach open source "as-is". Osoba wdrażająca własną instancję odpowiada za dostosowanie zabezpieczeń do lokalnych wymogów (w tym ochrony danych osobowych dzieci, zgodnie z obowiązującym prawem, np. RODO w UE).
