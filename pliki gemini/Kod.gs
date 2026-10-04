// [vPERM-ANK] verified 2026-09: jednorazowy dyżur + RFID dzień bieżący OK
// >>> FIX TZ: wymuś Europe/Warsaw w całej aplikacji (poprawka +2h w logach).
// UWAGA: ta zmienna MUSI być zdefiniowana zanim wywołają ją inne funkcje.
var _APP_TZ = "Europe/Warsaw";

/**
 * Dzien tygodnia (0=Nd..6=Sb) w STREFIE ARKUSZA.
 * Wymagany przez getAppData / _dyzurUseraWTygodniu — bez tego nie da
 * sie poprawnie rozpoznac dnia dyzuru, gdy arkusz ma inna strefe niz skrypt.
 * (Ten sam helper dodaje tez fix_tz.py — tutaj mamy gwarancje, ze istnieje.)
 */
function _dzienTygodniaDyzuru(dataObj) {
  try {
    if (!(dataObj instanceof Date) || isNaN(dataObj.getTime())) return -1;
    if (dataObj.getFullYear() < 1970) return dataObj.getUTCDay();
    var _sheetTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || _APP_TZ;
    var _iso = parseInt(Utilities.formatDate(dataObj, _sheetTz, "u"), 10);
    if (isNaN(_iso)) return dataObj.getDay();
    return (_iso === 7) ? 0 : _iso;
  } catch (e) {
    return dataObj.getDay();
  }
}


// ---- Informacje o aplikacji (zakładka "Informacje" w Ustawieniach) ----
// Wersja/data są trzymane w Script Properties tego arkusza ("System zarządzania
// grupą ministrantów"), żeby dało się je zmienić bez edycji kodu.
function pobierzInfoAplikacji() {
  try {
    // Wersja, data, autor, licencja, linki — wszystko z arkusza Status_Serwisu.
    // Zero wartości zapisanych na sztywno w kodzie. Brakujące wiersze
    // dopisuje _czytajStatusSerwisu() przy pierwszym odczycie.
    var s = _czytajStatusSerwisu();
    return {
      sukces: true,
      wersja:    String(s["app_wersja"] || "").trim(),
      data:      _formatujDateInfo(s["app_data_publikacji"]),
      autor:     String(s["app_autor"] || "").trim(),
      licencja:  String(s["app_licencja"] || "").trim(),
      github:    String(s["app_github"] || "").trim(),
      discord:   String(s["app_discord"] || "").trim()
    };
  } catch (e) {
    return { sukces: false, wersja: "", data: "", autor: "", licencja: "",
             github: "", discord: "", wiadomosc: String(e.message || e) };
  }
}

// Wywołaj ręcznie (np. z edytora Apps Script) po każdym wydaniu nowej wersji.
function ustawInfoAplikacji(wersja, data) {
  var props = PropertiesService.getScriptProperties();
  if (wersja) props.setProperty("app_wersja", String(wersja).trim());
  if (data) props.setProperty("app_data_publikacji", String(data).trim());
  return pobierzInfoAplikacji();
}

function doGet(e) {
  // Check-in z Netlify (proxy → GET action=checkin)
  try {
    if (e && e.parameter && String(e.parameter.action || "") === "checkin") {
      var wynik = checkinPrzezQr(
        e.parameter.id,
        // Hasło opcjonalne — pusty string OK (check-in tylko ID):
        (e.parameter.haslo || ""),
        e.parameter.kod || "AUTO",
        e.parameter.lat,
        e.parameter.lng,
        e.parameter.accuracy
      );
      return ContentService
        .createTextOutput(JSON.stringify(wynik))
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (errCheckin) {
    return ContentService
      .createTextOutput(JSON.stringify({
        sukces: false,
        wiadomosc: String(errCheckin && errCheckin.message ? errCheckin.message : errCheckin)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Harmonogram resetow dla czytnika ESP32 (zapytanie z urzadzenia)
  if (e.parameter.action === "reset_schedule") {
    return ContentService.createTextOutput(getHarmonogramResetu())
        .setMimeType(ContentService.MimeType.JSON);
  }

  // Czytnik RFID (ESP32) pobiera liste aktywnych zdarzen przy starcie
  if (e.parameter.action === "config") {
    return ContentService.createTextOutput(getKonfiguracjeCzytnika())
        .setMimeType(ContentService.MimeType.JSON);
  }

  // Tryb skanowania UID (z aplikacji lub type=SCAN)
  if (e.parameter.action === "scan" && e.parameter.id) {
    return ContentService.createTextOutput(
        zapiszSkanUidRfid(e.parameter.id, e.parameter.device)
      ).setMimeType(ContentService.MimeType.JSON);
  }

  // Zdalna diagnostyka bledow z ESP32 (bez potrzeby kabla/Serial) —
  // urzadzenie samo zglasza bledy, admin ogląda je zdalnie przez panel.
  if (e.parameter.action === "err") {
    return ContentService.createTextOutput(
        logBladUrzadzenia(e.parameter.device, e.parameter.kod, e.parameter.msg)
      ).setMimeType(ContentService.MimeType.JSON);
  }

  // Czytnik RFID (ESP32) — przyłożenie karty
  // type=AUTO (lub brak type przy device) → inteligentne wykrywanie mszy/dyżuru
  // type=<kod z opcji> → wybór po pytaniu na ekranie
  // type=A/B/C/D → stary tryb z arkusza Zdarzenia_czytnika (kompatybilność)
  // Lekki endpoint RFID (nowy, preferowany) — ?action=rfid&uid=XXX
  if (e.parameter.action === "rfid" && e.parameter.uid) {
    var _t0 = new Date().getTime();
    var _w = przetworzOdbicieESP32(e.parameter.uid, e.parameter.type || "AUTO", e.parameter.device, e.parameter.manual);
    console.log("[DIAG-RFID] action=rfid " + (new Date().getTime() - _t0) + "ms uid=" + e.parameter.uid);
    return ContentService.createTextOutput(_w).setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.id && e.parameter.action !== "scan") {
    var _typ = String(e.parameter.type || "").trim();
    var _dev = String(e.parameter.device || "").trim();
    if (_typ || _dev) {
      if (!_typ) _typ = "AUTO";
      var _t1 = new Date().getTime();
      var _w1 = przetworzOdbicieESP32(e.parameter.id, _typ, e.parameter.device, e.parameter.manual);
      console.log("[DIAG-RFID] id " + (new Date().getTime() - _t1) + "ms uid=" + e.parameter.id + " typ=" + _typ);
      return ContentService.createTextOutput(_w1).setMimeType(ContentService.MimeType.JSON);
    }
  }

  var viewMode = "";
  try {
    viewMode = String((e.parameter && e.parameter.view) || "").trim().toLowerCase();
  } catch (eV) {}

  // Osobna lekka strona check-in (bez logowania do panelu)
  if (viewMode === "checkin") {
    return HtmlService.createHtmlOutputFromFile("Checkin")
      .setTitle("Check-in · Ministranci")
      .setFaviconUrl("https://nmpnp.netlify.app/ikona.png")
      .addMetaTag("viewport", "width=device-width, initial-scale=1")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  var template = HtmlService.createTemplateFromFile("Index");
  template.deviceId = (e.parameter && e.parameter.deviceId) || "";
  template.viewMode = viewMode;
  return template.evaluate()
      .setTitle("Panel Ministrantów")
      .setFaviconUrl("https://nmpnp.netlify.app/ikona.png")
      .addMetaTag("viewport", "width=device-width, initial-scale=1")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ----------------------------------------------------------------------
// SYSTEM PUNKTOWY RFID — CZYTNIK ESP32
// Kontrakt JSON (musi sie zgadzac z kodem ESP32):
//   GET ?action=config
//     -> {"sukces":true,"wydarzenia":[{"kod":"A","nazwa":"...","punkty":N}, ...]}
//   GET ?id=<uid>&type=<kod_zdarzenia>&device=<nazwa_czytnika>
//     -> sukces: {"sukces":true,"imie":"...","wydarzenie":"...","punkty":N,"suma":N}
//     -> blad:   {"sukces":false,"blad":"nieznana_karta"|"karta_nieaktywna"|"nieznane_wydarzenie"}
//
// Arkusze wykorzystywane (auto-tworzone z naglowkiem, jesli nie istnieja):
//   Karty_RFID         : UID_karty | ID_ministranta | Imię i Nazwisko | Aktywna
//   Zdarzenia_czytnika : Kod | Nazwa | Punkty | Aktywne
//   Logi_czytnik       : Data | ID | Imię i Nazwisko | Czytnik | Wydarzenie | Punkty (juz istnieje)
// ----------------------------------------------------------------------

function _pobierzAlboUtworzArkuszKart() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Karty_RFID");
  if (!sheet) {
    sheet = ss.insertSheet("Karty_RFID");
    sheet.appendRow(["UID_karty", "ID_ministranta", "Imię i Nazwisko", "Aktywna"]);
  }
  return sheet;
}

function _pobierzAlboUtworzArkuszZdarzen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Zdarzenia_czytnika");
  if (!sheet) {
    sheet = ss.insertSheet("Zdarzenia_czytnika");
    sheet.appendRow(["Kod", "Nazwa", "Punkty", "Aktywne"]);
    // A wyłączone — punkty mszy liczy AUTO (5/7/3…), nie stałe 2
    sheet.appendRow(["A", "Msza (AUTO)", 0, false]);
    sheet.appendRow(["B", "Zbiorka", 1, true]);
    sheet.appendRow(["C", "Wyjazd", 5, true]);
    sheet.appendRow(["D", "Inne", 1, true]);
  } else {
    // Migracja: wyłącz stare A=Msza=2
    try {
      var dane = sheet.getDataRange().getValues();
      for (var i = 1; i < dane.length; i++) {
        if (String(dane[i][0] || "").trim().toUpperCase() === "A") {
          var pkt = parseInt(dane[i][2], 10);
          if (pkt === 2 || String(dane[i][1] || "").toLowerCase().indexOf("msza") >= 0) {
            sheet.getRange(i + 1, 2).setValue("Msza (AUTO)");
            sheet.getRange(i + 1, 3).setValue(0);
            sheet.getRange(i + 1, 4).setValue(false);
          }
          break;
        }
      }
    } catch (eMig) {}
  }
  return sheet;
}


function _czyAktywne(wartosc) {
  return wartosc === true || String(wartosc).toUpperCase().trim() === "TRUE";
}

// Zwraca skonfigurowane, aktywne zdarzenia (max 4) dla czytnika ESP32.
function getKonfiguracjeCzytnika() {
  try {
    // AUTO = inteligentne wykrywanie (domyślne na ESP32)
    var wydarzenia = [
      { kod: "AUTO", nazwa: "Auto (msza/dyżur)", punkty: 0 }
    ];
    var sheet = _pobierzAlboUtworzArkuszZdarzen();
    var dane = sheet.getDataRange().getValues();

    for (var i = 1; i < dane.length; i++) {
      var kod = String(dane[i][0] || "").trim();
      if (!kod || !_czyAktywne(dane[i][3])) continue;
      if (String(kod).toUpperCase() === "AUTO") continue;

      wydarzenia.push({
        kod: kod,
        nazwa: String(dane[i][1] || "").trim(),
        punkty: parseInt(dane[i][2]) || 0
      });

      if (wydarzenia.length >= 4) break;
    }

    var propsCfg = PropertiesService.getScriptProperties();
    var trybSkan = propsCfg.getProperty("rfid_tryb_skanowania") === "true";
    var przerwaInfo = getPrzerwaTechniczna();
    var przerwaAktywna = !!(przerwaInfo && przerwaInfo.aktywna);
    return JSON.stringify({
      sukces: true,
      wydarzenia: wydarzenia,
      tryb_skanowania: trybSkan,
      przerwa_techniczna: przerwaAktywna,
      przerwa_wiadomosc: (przerwaInfo && przerwaInfo.wiadomosc) ? String(przerwaInfo.wiadomosc) : ""
    });
  } catch (err) {
    return JSON.stringify({ sukces: false, blad: "blad_serwera" });
  }
}

// Przetwarza odbicie karty RFID z czytnika ESP32: identyfikuje ministranta,
// dolicza punkty za wybrane zdarzenie i zapisuje wpis w Logi_czytnik.

// ----------------------------------------------------------------------
// TRYB SKANOWANIA UID KARTY (powiązanie karty przy dodawaniu ministranta)
// ----------------------------------------------------------------------

function _rfidTrybSkanAktywny() {
  return PropertiesService.getScriptProperties().getProperty("rfid_tryb_skanowania") === "true";
}

function zapiszSkanUidRfid(uidParam, deviceParam) {
  try {
    var uid = String(uidParam || "").trim().toUpperCase();
    if (!uid) return JSON.stringify({ sukces: false, blad: "brak_uid" });
    var props = PropertiesService.getScriptProperties();
    props.setProperty("rfid_ostatni_skan_uid", uid);
    props.setProperty("rfid_ostatni_skan_ts", String(new Date().getTime()));
    props.setProperty("rfid_ostatni_skan_device", String(deviceParam || "").trim());
    // Po jednym udanym skanie — wracamy do normalnego rejestrowania obecnosci
    props.setProperty("rfid_tryb_skanowania", "false");
    // Pola imie/punkty/wydarzenie: ASCII, zeby stary firmware LCD nie wyswietlal smieci (UTF-8)
    return JSON.stringify({
      sukces: true,
      skan: true,
      uid: uid,
      imie: "UID zapisany",
      punkty: 0,
      wydarzenie: "SKAN",
      suma: 0
    });
  } catch (e) {
    return JSON.stringify({ sukces: false, blad: "blad_serwera" });
  }
}

/** Admin włącza tryb: kolejne przyłożenie karty na czytniku zapisze UID (bez punktów). */
function wlaczTrybSkanowaniaRfid(wykonawcaId) {
  try {
    var uid = String(wykonawcaId || "").trim();
    var rola = pobierzRoleUzytkownika(uid);
    if (!_czyAdminLubKsiadz(rola) && String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var props = PropertiesService.getScriptProperties();
    props.setProperty("rfid_tryb_skanowania", "true");
    props.setProperty("rfid_tryb_skanowania_od", String(new Date().getTime()));
    props.setProperty("rfid_tryb_skanowania_kto", uid);
    props.deleteProperty("rfid_ostatni_skan_uid");
    props.deleteProperty("rfid_ostatni_skan_ts");
    return { sukces: true, aktywny: true, wiadomosc: "Tryb skanowania włączony. Przyłóż kartę do czytnika." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function wylaczTrybSkanowaniaRfid(wykonawcaId) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty("rfid_tryb_skanowania", "false");
    return { sukces: true, aktywny: false };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/** Status trybu + ostatnio zeskanowany UID (poll z aplikacji). */
function getStatusSkanowaniaRfid(wykonawcaId) {
  try {
    var props = PropertiesService.getScriptProperties();
    var aktywny = props.getProperty("rfid_tryb_skanowania") === "true";
    var skanUid = String(props.getProperty("rfid_ostatni_skan_uid") || "").trim();
    var skanTs = parseInt(props.getProperty("rfid_ostatni_skan_ts") || "0", 10) || 0;
    var od = parseInt(props.getProperty("rfid_tryb_skanowania_od") || "0", 10) || 0;
    // Auto-wyłącz po 3 minutach
    if (aktywny && od && (new Date().getTime() - od > 180000)) {
      props.setProperty("rfid_tryb_skanowania", "false");
      aktywny = false;
    }
    return {
      sukces: true,
      aktywny: aktywny,
      uid: skanUid,
      ts: skanTs,
      device: String(props.getProperty("rfid_ostatni_skan_device") || "")
    };
  } catch (e) {
    return { sukces: false, aktywny: false, uid: "", wiadomosc: e.message };
  }
}

// ----------------------------------------------------------------------
// ZDALNA DIAGNOSTYKA BŁĘDÓW ESP32 (bez kabla USB / Serial)
// Urządzenie samo zgłasza błędy (WiFi, HTTP, JSON, itd.) na serwer;
// admin może je podejrzeć zdalnie z panelu przez pobierzBledyUrzadzenRfid() (Ustawienia → Diagnostyka ESP32).
// ----------------------------------------------------------------------

var MAX_BLEDOW_URZADZEN = 30;

function logBladUrzadzenia(deviceParam, kodBleduParam, wiadomoscParam) {
  try {
    var device = String(deviceParam || "Nieznany czytnik").trim();
    var kodBledu = String(kodBleduParam || "nieznany").trim();
    var wiadomosc = String(wiadomoscParam || "").trim().substring(0, 200);
    var props = PropertiesService.getScriptProperties();
    var lista = [];
    try {
      lista = JSON.parse(props.getProperty("rfid_bledy_urzadzen") || "[]");
    } catch (eParse) {
      lista = [];
    }
    lista.push({
      ts: new Date().getTime(),
      device: device,
      kod: kodBledu,
      wiadomosc: wiadomosc
    });
    while (lista.length > MAX_BLEDOW_URZADZEN) lista.shift();
    props.setProperty("rfid_bledy_urzadzen", JSON.stringify(lista));
    // >>> Push TYLKO do ID 2212 — błąd czytnika jest krytyczny, więc
    //     właściciel systemu ma wiedzieć natychmiast. Inni admini
    //     zobaczą błąd w panelu (Ustawienia → Diagnostyka ESP32).
    try {
      if (typeof wyslijPowiadomienieDoUserow === "function") {
        var _tytB = "🔴 Błąd czytnika " + device;
        var _trB = "[" + kodBledu + "] " + wiadomosc.substring(0, 120);
        wyslijPowiadomienieDoUserow("2212", _tytB, _trB);
      }
    } catch (ePushEsp) {}
    return JSON.stringify({ sukces: true });
  } catch (e) {
    return JSON.stringify({ sukces: false, wiadomosc: String(e && e.message ? e.message : e) });
  }
}

/** Odczyt ostatnich błędów zgłoszonych przez czytniki ESP32 — do wywołania z panelu admina. */
function pobierzBledyUrzadzenRfid(wykonawcaId) {
  try {
    var uid = String(wykonawcaId || "").trim();
    var rola = "";
    try { rola = String(pobierzRoleUzytkownika(uid) || "").toUpperCase(); } catch (eR) {}
    var ok = (rola.indexOf("ADMIN") === 0) || uid === "2212";
    if (!ok) return { sukces: false, wiadomosc: "Brak uprawnień.", bledy: [] };
    var props = PropertiesService.getScriptProperties();
    var lista = [];
    try {
      lista = JSON.parse(props.getProperty("rfid_bledy_urzadzen") || "[]");
    } catch (eParse) {
      lista = [];
    }
    lista.sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
    return { sukces: true, bledy: lista };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message, bledy: [] };
  }
}

function wyczyscBledyUrzadzenRfid(wykonawcaId) {
  try {
    var uid = String(wykonawcaId || "").trim();
    var rola = "";
    try { rola = String(pobierzRoleUzytkownika(uid) || "").toUpperCase(); } catch (eR) {}
    var ok = (rola.indexOf("ADMIN") === 0) || uid === "2212";
    if (!ok) return { sukces: false, wiadomosc: "Brak uprawnień." };
    PropertiesService.getScriptProperties().deleteProperty("rfid_bledy_urzadzen");
    try { _logAdmin(uid, "", "ESP32_BLEDY_CLEAR", "", ""); } catch (eL) {}
    return { sukces: true, wiadomosc: "Logi błędów ESP32 wyczyszczone." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}



/**
 * Check-in przez QR: weryfikuje ID+hasło i zapisuje punkty jak odbicie karty
 * (domyślnie kod A = Msza z arkusza Zdarzenia_czytnika).
 */

// ======================================================================
// SYSTEM PUNKTÓW - AKTUALIZOWANA TABELA
// ======================================================================
var _PKT = {
  DYZUR: 5,
  MSZA_ND: 7,
  MSZA_TD: 4,
  UROCZYSTOSC: 12,
  WIELKA_SOBOTA: 15,
  TRIDUUM: 15,
  DROGA_KRZYZOWA: 4,
  ROZANIEC_PAZDZ: 5,
  NABOZENSTWO_MJPC: 2,
  POGROBIONY_SLUB: 7,
  ZBIORKA: 6,
  ZAANGAZOWANIE_MIN: 1,
  ZAANGAZOWANIE_MAX: 10,
  BRAK_DYZURU: -4,
  BRAK_UROCZYSTOSCI: -12
};

// ======================================================================
// CHECK-IN: lokalizacja GPS (Script Properties)
//   checkin_lat, checkin_lng  — współrzędne kościoła
//   checkin_promien_m         — max odległość w metrach (domyślnie 250)
//   checkin_geo_wymagane      — "true"/"false" (domyślnie true gdy ustawiono lat/lng)
// ======================================================================
function _haversineM(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _getConfigCheckinGeo() {
  var props = PropertiesService.getScriptProperties();
  var lat = parseFloat(props.getProperty("checkin_lat"));
  var lng = parseFloat(props.getProperty("checkin_lng"));
  var promien = parseFloat(props.getProperty("checkin_promien_m"));
  if (isNaN(promien) || promien <= 0) promien = 250;
  var wym = props.getProperty("checkin_geo_wymagane");
  var wymagane = (wym === null || wym === "") ? true : (String(wym).toLowerCase() === "true");
  var skonfigurowane = !isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    lat: lat,
    lng: lng,
    promien: promien,
    wymagane: wymagane,
    skonfigurowane: skonfigurowane
  };
}

/**
 * lat/lng z urządzenia. Zwraca {ok:true, dystansM} lub {ok:false, blad, wiadomosc}.
 */
function _sprawdzLokalizacjeCheckin(lat, lng, accuracy) {
  var cfg = _getConfigCheckinGeo();
  if (!cfg.skonfigurowane) {
    // Brak współrzędnych kościoła — nie blokuj (admin musi ustawić)
    return { ok: true, dystansM: null, ostrzezenie: "brak_konfiguracji_geo" };
  }
  if (!cfg.wymagane) return { ok: true, dystansM: null };

  var uLat = parseFloat(lat);
  var uLng = parseFloat(lng);
  if (isNaN(uLat) || isNaN(uLng)) {
    return {
      ok: false,
      blad: "brak_lokalizacji",
      wiadomosc: "Włącz lokalizację GPS i zezwól stronie na dostęp. Check-in działa tylko w pobliżu kościoła."
    };
  }
  if (Math.abs(uLat) > 90 || Math.abs(uLng) > 180) {
    return { ok: false, blad: "bledna_lokalizacja", wiadomosc: "Nieprawidłowa lokalizacja GPS." };
  }

  var acc = parseFloat(accuracy);
  // odrzuć bardzo niedokładne pozycje (> 500 m) — łatwe do oszustwa
  if (!isNaN(acc) && acc > 500) {
    return {
      ok: false,
      blad: "slaba_gps",
      wiadomosc: "Sygnał GPS jest zbyt słaby (dokładność " + Math.round(acc) + " m). Wyjdź na zewnątrz i spróbuj ponownie."
    };
  }

  var dist = _haversineM(cfg.lat, cfg.lng, uLat, uLng);
  // tolerancja: promień + min(accuracy, 80) żeby nie karać za błąd GPS
  var limit = cfg.promien + (isNaN(acc) ? 40 : Math.min(acc, 80));
  if (dist > limit) {
    return {
      ok: false,
      blad: "za_daleko",
      wiadomosc: "Jesteś za daleko od kościoła (~" + Math.round(dist) + " m). Check-in tylko na miejscu (max ~" + Math.round(cfg.promien) + " m).",
      dystansM: Math.round(dist)
    };
  }
  return { ok: true, dystansM: Math.round(dist) };
}

/** Admin: ustaw współrzędne kościoła do weryfikacji check-in. */
function ustawLokalizacjeCheckin(wykonawcaId, lat, lng, promienM) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "KSIADZ") {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var la = parseFloat(lat);
    var ln = parseFloat(lng);
    if (isNaN(la) || isNaN(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      return { sukces: false, wiadomosc: "Podaj prawidłowe szerokość i długość geograficzną." };
    }
    var pr = parseFloat(promienM);
    if (isNaN(pr) || pr < 50) pr = 250;
    if (pr > 2000) pr = 2000;
    var props = PropertiesService.getScriptProperties();
    props.setProperty("checkin_lat", String(la));
    props.setProperty("checkin_lng", String(ln));
    props.setProperty("checkin_promien_m", String(Math.round(pr)));
    props.setProperty("checkin_geo_wymagane", "true");
    _logAdmin(uid, "", "CHECKIN_GEO_SET", la + "," + ln, "promien=" + Math.round(pr) + "m");
    return {
      sukces: true,
      lat: la,
      lng: ln,
      promien: Math.round(pr),
      wiadomosc: "Zapisano lokalizację check-in (" + Math.round(pr) + " m)."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

function getLokalizacjaCheckin(wykonawcaId) {
  try {
    var cfg = _getConfigCheckinGeo();
    return {
      sukces: true,
      skonfigurowane: cfg.skonfigurowane,
      wymagane: cfg.wymagane,
      lat: cfg.skonfigurowane ? cfg.lat : null,
      lng: cfg.skonfigurowane ? cfg.lng : null,
      promien: cfg.promien
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

function checkinPrzezQr(userId, haslo, kodZdarzenia, lat, lng, accuracy) {
  try {
    // ══════════════════════════════════════════════════════════════
    // CHECK-IN BEZ HASŁA (dodane 2026-09-20)
    // Hasło jest OPCJONALNE. Pusty string = weryfikacja tylko po:
    //   1. ID istniejącym w arkuszu Hasła
  //  2. GPS w okolicy kosciola
    // ══════════════════════════════════════════════════════════════
    var uid = _normId(userId);
    var pass = String(haslo || "").trim();
    console.log("[CHECKIN-ENTRY] uid=" + uid + " hasloLen=" + pass.length +
                " kod=" + kodZdarzenia + " lat=" + lat + " lng=" + lng +
                " (haslo puste = OK, check-in tylko ID)");
    var kod = String(kodZdarzenia || "AUTO").trim().toUpperCase();
    if (!uid) return { sukces: false, wiadomosc: "Podaj ID." };

    // --- Weryfikacja lokalizacji (anty-oszustwo) ---
    var geo = _sprawdzLokalizacjeCheckin(lat, lng, accuracy);
    if (!geo.ok) {
      return {
        sukces: false,
        blad: geo.blad || "lokalizacja",
        wiadomosc: geo.wiadomosc || "Wymagana lokalizacja w pobliżu kościoła."
      };
    }


    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetHasla = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetHasla) return { sukces: false, wiadomosc: "Błąd bazy haseł." };

    var dane = sheetHasla.getDataRange().getValues();
    var imie = "";
    var ok = false;
    for (var i = 1; i < dane.length; i++) {
      if (_normId(dane[i][0]) === uid) {
        // >>> Check-in bez hasła: jeśli hasło NIE zostało podane, przepuszczamy
        //     użytkownika po sprawdzeniu że ID istnieje + GPS ok. Gdy hasło JEST
        //     podane (np. stary klient), wciąż je weryfikujemy.
        var weryfikacjaQr;
        if (!pass) {
          weryfikacjaQr = { ok: true, legacy: false };
        } else {
          weryfikacjaQr = _sprawdzHaslo(pass, dane[i][2]);
        }
        if (weryfikacjaQr.ok) {
          ok = true;
          imie = String(dane[i][1] || "").trim();
          if (weryfikacjaQr.legacy && pass) {
            sheetHasla.getRange(i + 1, 3).setValue(_utworzZapisHasla(pass));
          }
        }
        break;
      }
    }
    if (!ok) return { sukces: false, wiadomosc: "Nie znaleziono takiego ID w bazie." };
    if (!imie) imie = uid;

    var teraz = _getCzasSystemowy();
    var device = "QR Check-in";

    // --- Ta sama logika co czytnik RFID: AUTO / kolizja okien → wybór ---
    var wynik;
    if (!kod || kod === "AUTO" || kod === "A") {
      wynik = _rozstrzygnijOdbicieAuto(ss, uid, teraz);
      if (wynik.tryb === "brak") {
        return {
          sukces: false,
          blad: "brak_wydarzenia",
          wiadomosc: "Brak mszy/dyżuru w oknie czasowym (−1h…+2h). Spróbuj w czasie nabożeństwa."
        };
      }
      if (wynik.tryb === "wybor") {
        return {
          sukces: false,
          blad: "wybor_wymagany",
          imie: imie,
          wiadomosc: "Kilka nabożeństw nachodzi na siebie — wybierz, na które przyszedłeś.",
          opcje: wynik.opcje || []
        };
      }
      // tryb ok
      var pol = _policzPunktyZaSlot(wynik.slot, teraz, !!wynik.maDyzur);
      if (_czyJuzZaliczoneDziś(ss, uid, pol.nazwa, teraz)) {
        return {
          sukces: false,
          blad: "juz_zaliczone",
          wiadomosc: "Już masz dziś zapisane: „" + pol.nazwa + "”."
        };
      }
      var suma = _zapiszLogIPrzelicz(ss, uid, imie, device, pol.nazwa, pol.punkty);
      return {
        sukces: true,
        imie: imie,
        wydarzenie: pol.nazwa,
        punkty: pol.punkty,
        suma: suma,
        wiadomosc: "Zapisano: " + pol.nazwa + " (+" + pol.punkty + " pkt). Suma: " + suma
      };
    }

    // Kod konkretnego slotu (po wyborze z listy kolizji) lub stary kod B/C/D z arkusza
    if (kod.length === 1 && kod.match(/^[B-Z]$/)) {
      var sheetZ = _pobierzAlboUtworzArkuszZdarzen();
      var daneZ = sheetZ.getDataRange().getValues();
      var nazwaW = null, pktW = 0;
      for (var j = 1; j < daneZ.length; j++) {
        if (String(daneZ[j][0] || "").trim().toUpperCase() === kod && _czyAktywne(daneZ[j][3])) {
          nazwaW = String(daneZ[j][1] || "").trim();
          pktW = parseInt(daneZ[j][2], 10) || 0;
          break;
        }
      }
      if (nazwaW !== null) {
        if (_czyJuzZaliczoneDziś(ss, uid, nazwaW, teraz)) {
          return { sukces: false, blad: "juz_zaliczone", wiadomosc: "Już masz dziś zapisane: „" + nazwaW + "”." };
        }
        var sumaSt = _zapiszLogIPrzelicz(ss, uid, imie, device, nazwaW, pktW);
        return {
          sukces: true, imie: imie, wydarzenie: nazwaW, punkty: pktW, suma: sumaSt,
          wiadomosc: "Zapisano: " + nazwaW + " (+" + pktW + " pkt). Suma: " + sumaSt
        };
      }
    }

    // Kod slotu z _slotyWOknie (np. K1800, WS, TR, …)
    var slot = _znajdzSlotPoKodzie(ss, teraz, kod, uid);
    if (!slot) {
      return {
        sukces: false,
        blad: "nieznane_wydarzenie",
        wiadomosc: "Wybrane wydarzenie nie jest już dostępne w oknie −1h…+2h."
      };
    }
    var dyzur = _dyzurUseraWTygodniu(ss, uid, teraz);
    var maD = dyzur && slot.start &&
      teraz.getDay() === dyzur.dzienTygodnia &&
      slot.start.getHours() === dyzur.godzina &&
      slot.start.getMinutes() === (dyzur.minuta || 0);
    var pol2 = _policzPunktyZaSlot(slot, teraz, maD);
    if (_czyJuzZaliczoneDziś(ss, uid, pol2.nazwa, teraz)) {
      return {
        sukces: false,
        blad: "juz_zaliczone",
        wiadomosc: "Już masz dziś zapisane: „" + pol2.nazwa + "”."
      };
    }
    var suma2 = _zapiszLogIPrzelicz(ss, uid, imie, device, pol2.nazwa, pol2.punkty);
    return {
      sukces: true,
      imie: imie,
      wydarzenie: pol2.nazwa,
      punkty: pol2.punkty,
      suma: suma2,
      wiadomosc: "Zapisano: " + pol2.nazwa + " (+" + pol2.punkty + " pkt). Suma: " + suma2
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}


// ======================================================================
// INTELIGENTNE PUNKTY RFID (msze, dyżury, sezony, kolizje okien)
// Okno mszy: [start−1h ; start+2h]. Kolizja → wybor_wymagany (LCD/klawiatura).
// Dyżur: nie ma w niedzielę ani sobotę 18:00; 1 dyżur / tydzień.
// ======================================================================

var _PKT = {
  DYZUR: 4,
  MSZA_ND: 7,
  MSZA_TD: 4,
  UROCZYSTOSC: 12,
  WIELKA_SOBOTA: 15,
  TRIDUUM: 15,
  DROGA_KRZYZOWA: 4,
  ROZANIEC_PAZDZ: 5,
  NABOZENSTWO_MJPC: 2,
  POGROBIONY_SLUB: 7,
  ZBIORKA: 6,
  ZAANGAZOWANIE_MIN: 1,
  ZAANGAZOWANIE_MAX: 10,
  BRAK_DYZURU: -4,
  BRAK_UROCZYSTOSCI: -12
};

/** Sobota 18:00 to msza wigilijna — liczy się jak niedziela (punkty i typ). */
function _liczySieJakoNiedziela(dzienTygodnia, godzina) {
  return dzienTygodnia === 0 || (dzienTygodnia === 6 && godzina === 18);
}

/** Stałe godziny mszy (gdy brak uroczystości w kalendarzu). */
function _staleMszeDlaDnia(dataObj) {
  var d = dataObj.getDay(); // 0=nd
  var out = [];
  if (d === 0) {
    // niedziela
    [8, 10, 12, 18].forEach(function(h) {
      out.push({ godzina: h, minuta: 0, typ: "msza_nd", nazwa: "Msza Święta " + _fmtHM(h, 0) });
    });
  } else {
    // pon–sob
    [7, 8, 18].forEach(function(h) {
      // >>> ZMIANA: sobota 18:00 liczy się jak niedziela (msza wigilijna)
      var jakoNd = _liczySieJakoNiedziela(d, h);
      out.push({
        godzina: h, minuta: 0,
        typ: jakoNd ? "msza_nd" : "msza_td",
        nazwa: "Msza Święta " + _fmtHM(h, 0) + (jakoNd ? " (niedzielna)" : "")
      });
    });
  }
  return out;
}

function _fmtHM(h, m) {
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}

function _cloneDateAt(dataObj, h, m) {
  var x = new Date(dataObj.getTime());
  x.setHours(h, m || 0, 0, 0);
  return x;
}

/** Wielkanoc (algorytm Meeusa/Jonesa) — do Wielkiego Postu / Triduum. */
function _dataWielkanocy(rok) {
  var a = rok % 19;
  var b = Math.floor(rok / 100);
  var c = rok % 100;
  var d = Math.floor(b / 4);
  var e = b % 4;
  var f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3);
  var h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4);
  var k = c % 4;
  var l = (32 + 2 * e + 2 * i - h - k) % 7;
  var m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31);
  var day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(rok, month - 1, day, 12, 0, 0);
}

function _czyWielkiPost(dataObj) {
  var rok = dataObj.getFullYear();
  var wielkanoc = _dataWielkanocy(rok);
  var popielec = new Date(wielkanoc.getTime());
  popielec.setDate(popielec.getDate() - 46);
  var koniec = new Date(wielkanoc.getTime());
  koniec.setDate(koniec.getDate() - 1); // Wielka Sobota
  var t = dataObj.getTime();
  return t >= popielec.getTime() && t <= koniec.getTime();
}

function _czyAdwent(dataObj) {
  // Od 4. niedzieli przed Bożym Narodzeniem do 24.12
  var rok = dataObj.getFullYear();
  var bn = new Date(rok, 11, 25, 12, 0, 0);
  var nd = bn.getDay();
  var czwarta = new Date(bn.getTime());
  czwarta.setDate(czwarta.getDate() - ((nd === 0 ? 7 : nd) + 21));
  var t = dataObj.getTime();
  var koniec = new Date(rok, 11, 24, 23, 59, 59);
  return t >= czwarta.getTime() && t <= koniec.getTime();
}

function _czyTriduumLubWielkaSobota(dataObj, kalendarzDnia) {
  var nazwy = (kalendarzDnia || []).map(function(k) { return String(k.nazwa || "").toLowerCase(); });
  for (var i = 0; i < nazwy.length; i++) {
    if (nazwy[i].indexOf("wielka sobota") >= 0) return "WIELKA_SOBOTA";
    if (nazwy[i].indexOf("triduum") >= 0) return "TRIDUUM";
    if (nazwy[i].indexOf("wielki piątek") >= 0 || nazwy[i].indexOf("wielki piatek") >= 0) return "TRIDUUM";
    if (nazwy[i].indexOf("wielki czwartek") >= 0) return "TRIDUUM";
  }
  // Fallback po dacie względem Wielkanocy
  var w = _dataWielkanocy(dataObj.getFullYear());
  var diff = Math.round((dataObj.setHours(12,0,0,0) - w.setHours(12,0,0,0)) / 86400000);
  // reset dataObj damage - use copies
  return null;
}

function _klasyfikujDzienTriduum(dataObj) {
  var w = _dataWielkanocy(dataObj.getFullYear());
  var d0 = new Date(dataObj.getFullYear(), dataObj.getMonth(), dataObj.getDate(), 12, 0, 0);
  var w0 = new Date(w.getFullYear(), w.getMonth(), w.getDate(), 12, 0, 0);
  var diff = Math.round((d0.getTime() - w0.getTime()) / 86400000);
  if (diff === -3 || diff === -2) return "TRIDUUM";
  if (diff === -1) return "WIELKA_SOBOTA";
  return null;
}

/** Wydarzenia z kalendarza na dany dzień (data lokalna). */
function _kalendarzNaDzien(ss, dataObj) {
  var sheet = ss.getSheetByName("Kalendarz");
  if (!sheet) return [];
  var dane = sheet.getDataRange().getValues();
  var y = dataObj.getFullYear(), m = dataObj.getMonth(), d = dataObj.getDate();
  var out = [];
  for (var i = 1; i < dane.length; i++) {
    if (!dane[i][0]) continue;
    var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
    if (isNaN(dt.getTime())) continue;
    if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) continue;
    var nazwa = String(dane[i][1] || "").trim();
    var pkt = parseInt(dane[i][2], 10);
    if (isNaN(pkt)) pkt = _PKT.UROCZYSTOSC;

    // OKNO ODBIJANIA (kolumny G/H) — puste = fallback na domyślne w _oknoCzasoweMszy
    var _okOdRaw = (dane[i].length > 6) ? dane[i][6] : "";
    var _okDoRaw = (dane[i].length > 7) ? dane[i][7] : "";
    var _okOdMin = null, _okDoMin = null;
    if (_okOdRaw !== "" && _okOdRaw != null) {
      var vOd = parseInt(_okOdRaw, 10);
      if (!isNaN(vOd) && vOd >= 0) _okOdMin = vOd;
    }
    if (_okDoRaw !== "" && _okDoRaw != null) {
      var vDo = parseInt(_okDoRaw, 10);
      if (!isNaN(vDo) && vDo >= 0) _okDoMin = vDo;
    }

    out.push({
      nazwa: nazwa,
      punkty: pkt,
      godzina: dt.getHours(),
      minuta: dt.getMinutes(),
      start: dt,
      typ: "kalendarz",
      oknoOdMin: _okOdMin,
      oknoDoMin: _okDoMin
    });
  }
  return out;
}

/**
 * Dyżur użytkownika w bieżącym tygodniu (arkusz Dyżury: Data | Imię | ID).
 * Data w arkuszu = reprezentatywna data z dniem tygodnia + godziną.
 */
function _dyzurUseraWTygodniu(ss, userId, dataObj) {
  var sheet = ss.getSheetByName("Dyżury");
  if (!sheet) return null;
  var dane = sheet.getDataRange().getValues();
  var uid = String(userId || "").trim();
  var tz = _APP_TZ;
  var dzienKey = Utilities.formatDate(dataObj, tz, "yyyy-MM-dd");

  // Arkusz Dyżury: Data i Godzina | Imię i Nazwisko | ID | Obowiązuje od | Obowiązuje do
  // Kolumny D/E pozwalają zachować historię: gdy ktoś zmienia dzień/godzinę dyżuru,
  // stary wpis zostaje zamknięty (Obowiązuje do), a nowy zaczyna obowiązywać od danej daty.
  // Wpisy bez wypełnionych kolumn D/E (stare dane sprzed tej funkcji) traktujemy jako zawsze aktywne.
  var pasujace = [];
  for (var i = 1; i < dane.length; i++) {
    if (String(dane[i][2] || "").trim() !== uid) continue;
    if (!dane[i][0]) continue;
    var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
    if (isNaN(dt.getTime())) continue;

    var odKey = "", doKey = "";
    var odRaw = dane[i][3];
    var doRaw = dane[i][4];
    if (odRaw) {
      var odD = odRaw instanceof Date ? odRaw : new Date(odRaw);
      if (!isNaN(odD.getTime())) odKey = Utilities.formatDate(odD, tz, "yyyy-MM-dd");
    }
    if (doRaw) {
      var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
      if (!isNaN(doD.getTime())) doKey = Utilities.formatDate(doD, tz, "yyyy-MM-dd");
    }

    var pasuje = (!odKey || dzienKey >= odKey) && (!doKey || dzienKey <= doKey);
    if (!pasuje) continue;

    pasujace.push({ dt: dt, odKey: odKey, doKey: doKey });
  }
  if (!pasujace.length) return null;
  // Gdyby kilka okresów się pokrywało (nie powinno), bierz to z najpóźniejszym "Obowiązuje od".
  pasujace.sort(function(a, b) { return (a.odKey || "").localeCompare(b.odKey || ""); });
  var _wybranyPelny = pasujace[pasujace.length - 1];
  var wybrany = _wybranyPelny.dt;

  // bierzemy wzorzec dnia tygodnia + godziny (dyżur cykliczny) z wybranego okresu
  var wd = wybrany.getDay();
  var h = wybrany.getHours();
  var mi = wybrany.getMinutes();

  // Niedziela: pomijamy ZWYKŁE dyżury tygodniowe (niedziela to dzień wolny),
  // ale przepuszczamy dyżur jednorazowy — taki, w którym
  // "Obowiązuje od" === "Obowiązuje do". Tylko wtedy wd=0 jest legalne.
  if (wd === 0) {
    var _jedn = (_wybranyPelny.odKey && _wybranyPelny.doKey &&
                 _wybranyPelny.odKey === _wybranyPelny.doKey);
    if (!_jedn) return null;
  }
  return { dzienTygodnia: wd, godzina: h, minuta: mi, nazwa: "Dyżur " + _fmtHM(h, mi) };
}

function _czyTenSamDyzurTeraz(dyzur, dataObj) {
  if (!dyzur) return false;
  if (dataObj.getDay() !== dyzur.dzienTygodnia) return false;
  var start = _cloneDateAt(dataObj, dyzur.godzina, dyzur.minuta);
  var okno = _oknoCzasoweMszy(start);
  var t = dataObj.getTime();
  return t >= okno.od.getTime() && t <= okno.do.getTime();
}

/**
 * Zwraca granice okna czasowego, w ktorym czytnik RFID zaliczy obecnosc
 * na mszy o podanym starcie.
 *   - Tydzien (pon-pt): start - 30 min, start + 1 h
 *   - Niedziela i sobota 18:00 (msza wigilijna): start - 30 min, start + 1 h 15 min
 */
function _oknoCzasoweMszy(start, przedMinOverride, poMinOverride) {
  var dzien = start.getDay(); // 0=Nd, 6=Sb
  var godz = start.getHours();
  var czyNiedzielne = (dzien === 0) || (dzien === 6 && godz === 18);
  // Domyślne wartości:
  var przedMin = 30;
  var poMin = czyNiedzielne ? 75 : 60;
  // Override per-wydarzenie (z kolumn G/H arkusza Kalendarz).
  // 0 jest poprawną wartością (np. "odbijaj tylko 0 min przed").
  if (typeof przedMinOverride === "number" &&
      !isNaN(przedMinOverride) && przedMinOverride >= 0) {
    przedMin = przedMinOverride;
  }
  if (typeof poMinOverride === "number" &&
      !isNaN(poMinOverride) && poMinOverride >= 0) {
    poMin = poMinOverride;
  }
  return {
    od:  new Date(start.getTime() - przedMin * 60 * 1000),
    do_: new Date(start.getTime() + poMin    * 60 * 1000),
    czyNiedzielne: czyNiedzielne,
    przedMin: przedMin,
    poMin: poMin
  };
}
function _slotyWOknie(ss, dataObj) {
  var t = dataObj.getTime();
  var sloty = [];
  var kal = _kalendarzNaDzien(ss, dataObj);
  var dzien = dataObj.getDay(); // 0=nd

  // Uroczystości / wpisy kalendarza (tylko prawdziwe uroczystości, nie zwykłe msze)
  kal.forEach(function(k) {
    // ── ZBIÓRKA: naliczana RĘCZNIE przez admina, czytnik jej NIE widzi ──
    var _nz0 = String(k.nazwa || "").toLowerCase();
    if (_nz0.indexOf("zbiórk") >= 0 || _nz0.indexOf("zbiork") >= 0) return;

    var start = k.start;
    if (!start) return;
    var _ok = _oknoCzasoweMszy(start, k.oknoOdMin, k.oknoDoMin);
    var od = _ok.od;
    var do_ = _ok.do_;
    if (t < od.getTime() || t > do_.getTime()) return;
    var n = String(k.nazwa || "").toLowerCase();

    // Zwykła msza w kalendarzu → traktuj jak stałą mszę (nie bierz punktów z arkusza!)
    var toZwyklaMsza = (n.indexOf("msza") >= 0) &&
      (n.indexOf("uroczyst") < 0) &&
      (n.indexOf("wielka sobota") < 0) &&
      (n.indexOf("triduum") < 0) &&
      (n.indexOf("ślub") < 0) && (n.indexOf("slub") < 0) &&
      (n.indexOf("pogrzeb") < 0) &&
      (n.indexOf("zbiórk") < 0) && (n.indexOf("zbiork") < 0);
    if (toZwyklaMsza) {
      // >>> ZMIANA: sobota 18:00 liczy się jak niedziela (msza wigilijna)
      var typM = _liczySieJakoNiedziela(dzien, start.getHours()) ? "msza_nd" : "msza_td";
      sloty.push({
        kod: "M" + start.getHours() + (start.getMinutes() < 10 ? "0" : "") + start.getMinutes(),
        nazwa: "Msza Święta " + _fmtHM(start.getHours(), start.getMinutes()),
        typ: typM,
        punktyBazowe: typM === "msza_nd" ? _PKT.MSZA_ND : _PKT.MSZA_TD,
        start: start
      });
      return;
    }

    // >>> FIX BEZ PUNKTÓW (2026-09-21): wydarzenie z 0 pkt jest INFORMACYJNE.
    // Pokazuje się w kalendarzu i w modalu dnia, ale NIE jest wydarzeniem
    // RFID — nie łapie się w oknie, nie daje punktów za przyłożenie karty,
    // nie generuje wpisu w Logi_czytnik.
    var _pktRaw = (typeof k.punkty === "number") ? k.punkty : parseInt(k.punkty, 10);
    if (!isNaN(_pktRaw) && _pktRaw === 0) return;

    var typ = "uroczystosc";
    var pkt = _PKT.UROCZYSTOSC;
    if (n.indexOf("wielka sobota") >= 0) { typ = "wielka_sobota"; pkt = _PKT.WIELKA_SOBOTA; }
    else if (n.indexOf("triduum") >= 0 || n.indexOf("wielki piątek") >= 0 || n.indexOf("wielki piatek") >= 0 || n.indexOf("wielki czwartek") >= 0) {
      typ = "triduum"; pkt = _PKT.TRIDUUM;
    } else if (n.indexOf("uroczyst") >= 0) {
      typ = "uroczystosc"; pkt = _PKT.UROCZYSTOSC;
    } else if (typeof k.punkty === "number" && !isNaN(k.punkty) && k.punkty > 0) {
      // inne wpisy (np. zbiórka) — punkty z kalendarza, ale min. nie „Msza=2”
      pkt = k.punkty;
      if (pkt === 2 && n.indexOf("msza") >= 0) pkt = _liczySieJakoNiedziela(dzien, start.getHours()) ? _PKT.MSZA_ND : _PKT.MSZA_TD;
    }
    sloty.push({
      kod: "K" + start.getHours() + (start.getMinutes() < 10 ? "0" : "") + start.getMinutes(),
      nazwa: k.nazwa || "Uroczystość",
      typ: typ,
      punktyBazowe: pkt,
      start: start
    });
  });

  // Triduum po dacie (gdy brak wpisu)
  var tr = _klasyfikujDzienTriduum(dataObj);
  if (tr && sloty.length === 0) {
    sloty.push({
      kod: tr === "WIELKA_SOBOTA" ? "WS" : "TR",
      nazwa: tr === "WIELKA_SOBOTA" ? "Wielka Sobota" : "Triduum Paschalne",
      typ: tr === "WIELKA_SOBOTA" ? "wielka_sobota" : "triduum",
      punktyBazowe: tr === "WIELKA_SOBOTA" ? _PKT.WIELKA_SOBOTA : _PKT.TRIDUUM,
      start: _cloneDateAt(dataObj, 10, 0)
    });
  }

// ── RÓŻANIEC 1 (wcześniejszy) — środa i piątek października, 16:00–17:00 ──
// Karta odbita między 16:00 a 17:00 w środę/piątek = różaniec (+5 pkt),
// bez żadnego wyboru (osobny slot na czytniku).
if (dataObj.getMonth() === 9 && (dzien === 3 || dzien === 5)) {
  var startRoz1 = _cloneDateAt(dataObj, 16, 30);            // środek okna
  var odRoz1 = new Date(startRoz1.getTime() - 30 * 60 * 1000); // 16:00
  var doRoz1 = new Date(startRoz1.getTime() + 30 * 60 * 1000); // 17:00
  if (t >= odRoz1.getTime() && t <= doRoz1.getTime()) {
    sloty.push({
      kod: "ROZ16",
      nazwa: "Różaniec październikowy (16:00–17:00)",
      typ: "rozaniec",
      punktyBazowe: _PKT.ROZANIEC_PAZDZ,
      start: startRoz1
    });
  }
}

// ── RÓŻANIEC 2 (późniejszy, w WYBORZE przy mszy 18:00) — październik, pon–pt, 17:30 ──
// Zostaje mechanizm wyboru: czytnik pokaże "Msza 18:00" albo "Msza + Różaniec".
if (dataObj.getMonth() === 9 && dzien >= 1 && dzien <= 5) {
  var startRoz = _cloneDateAt(dataObj, 17, 30);
  var _okRoz = _oknoCzasoweMszy(startRoz, 20, 60);
  if (t >= _okRoz.od.getTime() && t <= _okRoz.do_.getTime()) {
    sloty.push({
      kod: "ROZ",
      nazwa: "Różaniec październikowy (17:30)",
      typ: "rozaniec",
      punktyBazowe: _PKT.ROZANIEC_PAZDZ,
      start: startRoz
    });
  }
}

  // Stałe msze: nd 8/10/12/18 → +7; tydzień 7/8/18 → +5; okno −1h…+2h od startu
  var stale = _staleMszeDlaDnia(dataObj);
  stale.forEach(function(s) {
    var start = _cloneDateAt(dataObj, s.godzina, s.minuta);
    // ── PAŹDZIERNIK: msza 18:00 (pon–pt) ma rozszerzone okno
    // 17:10 → 19:00 (normalnie 17:30 → 19:00), bo na różaniec
    // przychodzi się wcześniej. W tym oknie user wybiera między
    // "tylko Msza" a "Msza + Różaniec".
    var _rozszerzoneOkno = (dataObj.getMonth() === 9) &&
                            (dzien >= 1 && dzien <= 5) &&
                            s.godzina === 18 &&
                            (s.minuta || 0) === 0;
    var _ok = _rozszerzoneOkno ? _oknoCzasoweMszy(start, 50, 60)
                               : _oknoCzasoweMszy(start);
    var od = _ok.od;
    var do_ = _ok.do_;
    if (t < od.getTime() || t > do_.getTime()) return;
    var konfliktKal = sloty.some(function(sl) {
      return sl.start && Math.abs(sl.start.getTime() - start.getTime()) < 30 * 60 * 1000 &&
        (sl.typ === "uroczystosc" || sl.typ === "triduum" || sl.typ === "wielka_sobota");
    });
    if (konfliktKal) return;
    // nie duplikuj tej samej godziny
    var dup = sloty.some(function(sl) {
      return sl.start && sl.start.getHours() === s.godzina && sl.start.getMinutes() === (s.minuta || 0) &&
        (sl.typ === "msza_nd" || sl.typ === "msza_td" || sl.typ === "msza_rozaniec");
    });
    if (dup) return;
    if (_rozszerzoneOkno) {
      // Październik, pon–pt, msza 18:00 — DWA warianty do wyboru.
      // Backend zwróci blad:"wybor_wymagany" i użytkownik sam wskaże,
      // czy był tylko na mszy, czy także na różańcu.
      sloty.push({
        kod: "M" + s.godzina + (s.minuta < 10 ? "0" : "") + (s.minuta || 0),
        nazwa: "Msza Święta " + _fmtHM(s.godzina, s.minuta || 0),
        typ: "msza_td",
        punktyBazowe: _PKT.MSZA_TD,
        start: start
      });
      sloty.push({
        kod: "M" + s.godzina + (s.minuta < 10 ? "0" : "") + (s.minuta || 0) + "ROZ",
        nazwa: "Msza Święta " + _fmtHM(s.godzina, s.minuta || 0) + " · Różaniec",
        typ: "msza_rozaniec",
        punktyBazowe: _PKT.MSZA_TD + _PKT.ROZANIEC_PAZDZ,
        start: start
      });
    } else {
      sloty.push({
        kod: "M" + s.godzina + (s.minuta < 10 ? "0" : "") + (s.minuta || 0),
        nazwa: s.nazwa,
        typ: s.typ,
        punktyBazowe: s.typ === "msza_nd" ? _PKT.MSZA_ND : _PKT.MSZA_TD,
        start: start
      });
    }
  });


  // Droga Krzyżowa — piątki w Wielkim Poście (po 8:00 i ok. 17:00 / po 18:00)
  if (_czyWielkiPost(dataObj) && dzien === 5) {
    [8, 17].forEach(function(hDK) {
      var startDK = _cloneDateAt(dataObj, hDK, 0);
      var odDK = new Date(startDK.getTime() - 60 * 60 * 1000);
      var doDK = new Date(startDK.getTime() + 2 * 60 * 60 * 1000);
      if (t >= odDK.getTime() && t <= doDK.getTime()) {
        sloty.push({
          kod: "DK" + hDK + "00",
          nazwa: "Droga Krzyżowa",
          typ: "droga_krzyzowa",
          punktyBazowe: _PKT.DROGA_KRZYZOWA,
          start: startDK
        });
      }
    });
  }

  return sloty;
}


function _bonusyDoSlotu(slot, dataObj) {
  var bonus = 0;
  var etykiety = [];
  if (!slot || !slot.start) return { bonus: 0, etykiety: [] };
  var h = slot.start.getHours();
  var mi = slot.start.getMinutes();
  var wd = dataObj.getDay();
  var mies = dataObj.getMonth();

  if ((mies === 4 || mies === 5) && wd >= 1 && wd <= 5) {
    if (slot.typ === "msza_td" && h === 18 && mi === 0) {
      bonus += _PKT.NABOZENSTWO_MJPC;
      etykiety.push("Nabożeństwo +" + _PKT.NABOZENSTWO_MJPC);
    }
  }
  // Różaniec październikowy — USUNIĘTE jako bonus do Mszy 18:00.
  // Od teraz jest to osobny slot RFID (kod "ROZ", patrz _slotyWOknie),
  // dzięki czemu użytkownik sam wybiera, na co przyszedł, a punkty
  // nie sumują się podwójnie (5 + 4 = 9 pkt za jedną obecność).
  return { bonus: bonus, etykiety: etykiety };
}

function _policzPunktyZaSlot(slot, dataObj, maDyzurNaTenSlot) {
  if (!slot) return { punkty: 0, nazwa: "Służba", kod: "" };
  var typ = String(slot.typ || "");
  var nazwa = slot.nazwa || "Służba";
  var baz = 0;

  if (typ === "msza_nd") baz = _PKT.MSZA_ND;
  else if (typ === "msza_td") baz = _PKT.MSZA_TD;
  else if (typ === "msza_rozaniec") baz = _PKT.MSZA_TD + _PKT.ROZANIEC_PAZDZ;
  else if (typ === "wielka_sobota") baz = _PKT.WIELKA_SOBOTA;
  else if (typ === "triduum") baz = _PKT.TRIDUUM;
  else if (typ === "uroczystosc") baz = _PKT.UROCZYSTOSC;
  else if (typ === "droga_krzyzowa") baz = _PKT.DROGA_KRZYZOWA;
  else if (typ === "rozaniec") baz = _PKT.ROZANIEC_PAZDZ;
  else if (typ === "zbiorka") baz = _PKT.ZBIORKA;
  else {
    baz = parseInt(slot.punktyBazowe, 10);
    if (isNaN(baz) || baz === 2) {
      var nl = String(nazwa).toLowerCase();
      if (nl.indexOf("msza") >= 0) {
        var gH = slot.start ? slot.start.getHours() : (dataObj ? dataObj.getHours() : -1);
        baz = (dataObj && _liczySieJakoNiedziela(dataObj.getDay(), gH)) ? _PKT.MSZA_ND : _PKT.MSZA_TD;
      } else { baz = isNaN(baz) ? 0 : baz; }
    }
  }
  if (maDyzurNaTenSlot && (typ === "msza_td" || typ === "msza_nd")) {
    // >>> FIX 2026-09 (SAT-18-DUTY-RULES):
    // Sobota 18:00 (msza wigilijna) — dla osoby MAJĄCEJ dyżur
    // stosujemy teraz zasady zwykłego dyżuru: obecność +4 pkt
    // (DYZUR), nieobecność -4 pkt (BRAK_DYZURU). Wcześniej ta
    // msza była klasyfikowana jako msza_nd (niedzielna) i dawała
    // +7 pkt nawet przy dyżurze, co było niespójne z resztą dyżurów.
    //
    // Osoba BEZ dyżuru, która przyjdzie na mszę Sob 18:00, dostaje
    // +7 pkt (jak msza niedzielna) — to realizuje dolna gałąź,
    // bo warunek "maDyzurNaTenSlot" jest wtedy false.
    //
    // Niedziela (prawdziwa msza niedzielna) — bez zmian: dyżur
    // jednorazowy w niedzielę zachowuje +7 pkt.
    var _jestSob18 = slot.start
      && slot.start.getDay() === 6
      && slot.start.getHours() === 18;
    if (typ !== "msza_nd" || _jestSob18) {
      baz = _PKT.DYZUR;
    }
    nazwa = "Dyżur (" + (slot.nazwa || "") + ")";
  } else if (maDyzurNaTenSlot && typ === "msza_rozaniec") {
    // Październik: dyżurny wybrał wariant "Msza + Różaniec"
    baz = _PKT.DYZUR + _PKT.ROZANIEC_PAZDZ;
    nazwa = "Dyżur + Różaniec (" + (slot.nazwa || "") + ")";
  }
  var b = _bonusyDoSlotu(slot, dataObj);
  return { punkty: baz + b.bonus,
           nazwa: nazwa + (b.etykiety.length ? " · " + b.etykiety.join(", ") : ""),
           kod: slot.kod };
}

/**
 * Normalizuje nazwę wydarzenia do porównań:
 *   - lowercase
 *   - skleja wielokrotne spacje do jednej
 *   - normalizuje HH:MM → HH:MM z paddingiem zer (7:0 → 07:00, 7:00 → 07:00)
 */
function _normNazwaWyd(tekst) {
  var s = String(tekst || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/(\d{1,2}):(\d{1,2})/g, function(_, h, mi) {
    var hh = parseInt(h, 10);
    var mm = parseInt(mi, 10);
    if (isNaN(hh) || isNaN(mm)) return _;
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  });
  return s;
}

/**
 * Czy dane wydarzenie zostało już dziś zaliczone temu użytkownikowi?
 *
 * POPRAWKA: wcześniej porównywano tylko pierwsze 12 znaków nazwy
 * ("msza święta" dla "Msza Święta 07:00" i "Msza Święta 18:00"),
 * przez co druga msza w tym samym dniu była odrzucana jako "już zaliczone".
 * Teraz porównujemy PEŁNĄ znormalizowaną nazwę, dzięki czemu:
 *   - Msza Święta 07:00 ≠ Msza Święta 18:00   (różne nazwy → obie przechodzą)
 *   - Msza Święta 18:00 = Msza Święta 18:00   (dublowanie tego samego slotu)
 *
 * Dyżur blokuje kolejny dyżur tego samego dnia (jeden dyżur na dzień),
 * tak jak było wcześniej.
 */
// === PATCH_BEZ_LIMITU_DZIENNEGO (2026-09) ===
// Każde odbicie karty / check-in liczy się osobno (2x, 3x, bez limitu).
// === FIX 2026-09-24: przywrócona blokada wielokrotnego nabijania punktów ===
// Każde wydarzenie (msza/dyżur/uroczystość) może być zaliczone tylko RAZ
// dziennie na osobę. Bez tego użytkownik mógł przykładać kartę w kółko
// i nabijać punkty w nieskończoność.
function _czyJuzZaliczoneDziś(ss, userId, nazwaWydarzenia, dataObj) {
  var sheet = ss.getSheetByName("Logi_czytnik");
  if (!sheet) return false;

  var dane = sheet.getDataRange().getValues();
  if (dane.length < 2) return false;

  var uid = String(userId).trim();
  var y = dataObj.getFullYear();
  var m = dataObj.getMonth();
  var d = dataObj.getDate();
  var kluczNorm = _normNazwaWyd(nazwaWydarzenia);
  if (!kluczNorm) return false;

  for (var i = dane.length - 1; i >= 1; i--) {
    if (String(dane[i][1] || "").trim() !== uid) continue;

    var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
    if (isNaN(dt.getTime())) continue;
    if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) continue;

    var nNorm = _normNazwaWyd(dane[i][4]);
    if (!nNorm) continue;

    // (1) Dokładnie ta sama nazwa wydarzenia (z uwzględnieniem HH:MM)
    //     -> już zaliczone dziś dla tej osoby.
    if (nNorm === kluczNorm) return true;

    // (2) Dyżur: każdy wpis zawierający „dyżur" blokuje kolejny „dyżur"
    //     tego samego dnia (reguła: 1 dyżur / dzień / osoba).
    if (kluczNorm.indexOf("dyżur") >= 0 && nNorm.indexOf("dyżur") >= 0) return true;
  }
  return false;
}

function _czyJuzZaliczoneDziś_LOGIKA_ORYGINALNA(ss, userId, nazwaWydarzenia, dataObj) {
  var sheet = ss.getSheetByName("Logi_czytnik");
  if (!sheet) return false;
  var dane = sheet.getDataRange().getValues();
  var uid = String(userId).trim();
  var y = dataObj.getFullYear(), m = dataObj.getMonth(), d = dataObj.getDate();
  var kluczNorm = _normNazwaWyd(nazwaWydarzenia);
  if (!kluczNorm) return false;

  for (var i = dane.length - 1; i >= 1; i--) {
    if (String(dane[i][1] || "").trim() !== uid) continue;
    var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
    if (isNaN(dt.getTime())) continue;
    if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) continue;

    var nNorm = _normNazwaWyd(dane[i][4]);
    if (!nNorm) continue;

    // 1) Ta sama, pełna nazwa wydarzenia → już zaliczone.
    if (nNorm === kluczNorm) return true;

    // 2) Dyżur: każdy wpis zawierający słowo "dyżur" blokuje kolejny
    //    "dyżur" tego samego dnia (jeden dyżur na dzień — zgodnie z regułą).
    if (kluczNorm.indexOf("dyżur") >= 0 && nNorm.indexOf("dyżur") >= 0) return true;
  }
  return false;
}

/**
 * Główna logika AUTO: zwraca {tryb:"ok", wynik} | {tryb:"wybor", opcje} | {tryb:"brak"}
 */

/** Krótka nazwa ASCII na LCD czytnika (16 znaków, bez polskich). */
function _nazwaLcdSlot(slot, pol) {
  if (!slot) return "Opcja";
  var typ = String(slot.typ || "");
  var h = slot.start ? slot.start.getHours() : -1;
  var mi = slot.start ? slot.start.getMinutes() : 0;
  var hm = (h >= 0) ? (_fmtHM(h, mi)) : "";
  var base = "Sluzba";
  if (pol && pol.nazwa && String(pol.nazwa).toLowerCase().indexOf("dyzur") >= 0) {
    base = "Dyzur";
  } else if (typ === "msza_nd" || typ === "msza_td") {
  base = "Msza";
} else if (typ === "msza_rozaniec") {
  base = "Msza+Rozaniec";
} else if (typ === "uroczystosc") {
    base = "Uroczyst.";
  } else if (typ === "wielka_sobota") {
    base = "W.Sobota";
  } else if (typ === "triduum") {
    base = "Triduum";
  } else if (typ === "gorzkie_zale") {
    base = "G.Zale";
  } else if (typ === "droga_krzyzowa") {
    base = "D.Krzyzowa";
  } else if (typ === "rozaniec") {
    base = "Rozaniec";
  } else {
    // strip non-ascii from nazwa
    base = String(slot.nazwa || "Opcja").replace(/[^\x20-\x7E]/g, "").substring(0, 10) || "Opcja";
  }
  var out = hm ? (base + " " + hm) : base;
  if (pol && typeof pol.punkty === "number") {
    var withPkt = out + " +" + pol.punkty;
    if (withPkt.length <= 16) out = withPkt;
  }
  return String(out).substring(0, 16);
}

function _rozstrzygnijOdbicieAuto(ss, userId, dataObj) {
  var sloty = _slotyWOknie(ss, dataObj);
  var dyzur = _dyzurUseraWTygodniu(ss, userId, dataObj);
  var t = dataObj.getTime();

  function _pasujeDoDyzuru(s) {
    if (!dyzur || !s || !s.start) return false;
    if (dataObj.getDay() !== dyzur.dzienTygodnia) return false;
    return s.start.getHours() === dyzur.godzina &&
      s.start.getMinutes() === (dyzur.minuta || 0);
  }

  function _tylkoZwykleMsze(lista) {
    if (!lista || !lista.length) return false;
    for (var i = 0; i < lista.length; i++) {
      var tp = String(lista[i].typ || "");
      if (tp !== "msza_nd" && tp !== "msza_td") return false;
    }
    return true;
  }

  /** Najbliższa msza względem teraz (start). */
  function _najblizszySlot(lista) {
    var best = null, bestDist = Infinity;
    for (var i = 0; i < lista.length; i++) {
      if (!lista[i].start) continue;
      var dist = Math.abs(lista[i].start.getTime() - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = lista[i];
      }
    }
    return best || lista[0];
  }

  if (!sloty.length) return { tryb: "brak" };

  // 1) Masz dyżur na którąś z mszy w oknie → ZAWSZE zalicz jak dyżur (+3), bez pytania
  var slotyZDyzurem = sloty.filter(_pasujeDoDyzuru);
  if (slotyZDyzurem.length >= 1) {
    // jeśli kilka (rzadkie) — bierz najbliższą godzinę dyżuru
    var sD = slotyZDyzurem.length === 1 ? slotyZDyzurem[0] : _najblizszySlot(slotyZDyzurem);
    return { tryb: "ok", slot: sD, maDyzur: true };
  }

  // 2) Jedna opcja → OK
  if (sloty.length === 1) {
    return { tryb: "ok", slot: sloty[0], maDyzur: false };
  }

  // 3) Kilka zwykłych mszy w oknie (np. 7:00 i 8:00 w tygodniu) → WYBÓR.
  //    Wcześniej system sam wybierał najbliższą czasowo; teraz decyduje user
  //    na klawiaturze czytnika / ekranie checkin QR. Dyżur nadal ma priorytet
  //    (patrz krok 1 wyżej — jeśli pasuje do dyżuru, tryb "ok" bez pytania).
  if (_tylkoZwykleMsze(sloty)) {
    return {
      tryb: "wybor",
      opcje: sloty.map(function(s) {
        var p = _policzPunktyZaSlot(s, dataObj, false);
        return {
          kod: s.kod,
          nazwa: p.nazwa,
          nazwaLcd: _nazwaLcdSlot(s, p),
          punkty: p.punkty,
          maDyzur: false
        };
      })
    };
  }

  // 4) Różne typy (msza + uroczystość / Gorzkie Żale / Droga Krzyżowa…) → wybór na LCD
  return {
    tryb: "wybor",
    opcje: sloty.map(function(s) {
      var p = _policzPunktyZaSlot(s, dataObj, false);
      return { kod: s.kod, nazwa: p.nazwa, nazwaLcd: _nazwaLcdSlot(s, p), punkty: p.punkty, maDyzur: false };
    })
  };
}


function _znajdzSlotPoKodzie(ss, dataObj, kod, userId) {
  var sloty = _slotyWOknie(ss, dataObj);
  for (var i = 0; i < sloty.length; i++) {
    if (String(sloty[i].kod) === String(kod)) return sloty[i];
  }
  return null;
}

function _zapiszLogIPrzelicz(ss, idMin, imie, device, nazwaWyd, punkty) {
  var sheetLogi = ss.getSheetByName("Logi_czytnik");
  if (!sheetLogi) {
    sheetLogi = ss.insertSheet("Logi_czytnik");
    sheetLogi.appendRow(["Data", "ID", "Imię i Nazwisko", "Czytnik", "Wydarzenie", "Punkty"]);
  }
  var dataStr = Utilities.formatDate(_getCzasSystemowy(), _APP_TZ, "yyyy-MM-dd HH:mm:ss");
  sheetLogi.appendRow([dataStr, idMin, imie, device, nazwaWyd, punkty]);
  przeliczPunktyUzytkownika(idMin);
  var suma = punkty;
  var sheetK = ss.getSheetByName("Kandydaci");
  if (sheetK) {
    var dk = sheetK.getDataRange().getValues();
    for (var k = 1; k < dk.length; k++) {
      if (String(dk[k][0]).trim() === String(idMin).trim()) {
        suma = parseInt(dk[k][2], 10) || 0;
        break;
      }
    }
  }
  return suma;
}


// ======================================================================
// CZAS SYSTEMOWY (testowy override — tylko ID 1 w aplikacji)
// ScriptProperties: "czas_testowy_iso" = ISO string (np. 2026-08-28T18:00:00)
// Gdy ustawiony — RFID/msze/dyżury widzą ten czas zamiast zegara serwera.
// ======================================================================
var _CZAS_TEST_USER_ID = "2212";


/**
 * Publiczny ranking punktów (imie, punkty, ranga) — dla wszystkich zalogowanych.
 * Bez haseł / danych wrażliwych.
 */

/** Lekki endpoint: tylko własny profil (naprawa spinnera „Ładowanie profili…”). */

/** Normalizacja ID z arkusza (liczba / "1234.0" / string). */
function _normId(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "number") {
    if (isNaN(raw)) return "";
    return String(Math.floor(raw));
  }
  var s = String(raw).trim().replace(/\.0$/, "");
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    var n = parseInt(s, 10);
    if (!isNaN(n)) return String(n);
  }
  return s;
}

function getMojProfil(userId) {
  try {
    var uid = _normId(userId);
    if (!uid) return { sukces: false, wiadomosc: "Brak ID." };
    var dane = _pobierzDaneKandydaci();
    if (!dane || dane.length === 0) return { sukces: false, wiadomosc: "Brak arkusza Kandydaci." };
    for (var i = 1; i < dane.length; i++) {
      var id = _normId(dane[i][0]);
      if (!id) continue;
      if (id !== uid) continue;
      var pkt = parseInt(dane[i][2], 10);
      if (isNaN(pkt)) pkt = 0;
      return {
        sukces: true,
        kandydat: [
          id,
          String(dane[i][1] || ""),
          pkt,
          String(dane[i][3] || ""),
          String(dane[i][4] || ""),
          String(dane[i][5] || ""),
          String(dane[i][6] || ""),
          String(dane[i][7] || "")
        ],
        rola: pobierzRoleUzytkownika(uid) || pobierzRoleUzytkownika(id) || ""
      };
    }
    return { sukces: false, wiadomosc: "Nie znaleziono profilu o ID " + uid + "." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * Suma punktów zdobytych przez ministranta WYŁĄCZNIE w podanym okresie
 * (na podstawie logów, nie z kolumny sumy w Kandydaci, bo ta jest sumą "od zawsze").
 */
function _sumaPunktowWZakresie(ss, uid, od, do_) {
  var suma = 0;
  var logi = ss.getSheetByName("Logi_czytnik");
  if (logi && logi.getLastRow() > 1) {
    var dl = logi.getDataRange().getValues();
    for (var i = 1; i < dl.length; i++) {
      if (String(dl[i][1] || "").trim() !== uid) continue;
      var d = dl[i][0] instanceof Date ? dl[i][0] : new Date(dl[i][0]);
      if (!_dataWZakresie(d, od, do_)) continue;
      suma += parseInt(dl[i][5], 10) || 0;
    }
  }
  var reczne = ss.getSheetByName("Logi_ręczne");
  if (reczne && reczne.getLastRow() > 1) {
    var dr = reczne.getDataRange().getValues();
    for (var j = 1; j < dr.length; j++) {
      if (String(dr[j][1] || "").trim() !== uid) continue;
      var d2 = dr[j][0] instanceof Date ? dr[j][0] : new Date(dr[j][0]);
      if (!_dataWZakresie(d2, od, do_)) continue;
      suma += parseInt(dr[j][3], 10) || 0;
    }
  }
  return suma;
}

function getRanking(userId, sessionToken, odIso, doIso, filtr) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, lista: [], wiadomosc: "Brak sesji." };
    var rola = pobierzRoleUzytkownika(uid);
    if (!rola) return { sukces: false, lista: [], wiadomosc: "Brak uprawnień." };
    var filtrN = String(filtr || "wszyscy").toLowerCase();

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kandydaci");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, lista: [], mojaPozycja: null };
    var _daneKandRank = _pobierzDaneKandydaci();

    // Opcjonalny zakres dat: jeśli podany, ranking liczy punkty zdobyte TYLKO
    // w tym okresie (z logów), a nie sumę "od zawsze" z kolumny w Kandydaci.
    var uzyjZakresu = !!(String(odIso || "").trim() || String(doIso || "").trim());
    var zakres = uzyjZakresu ? _parseZakresStat(odIso, doIso) : null;

    var dane = _daneKandRank;
    var lista = [];
    for (var i = 1; i < dane.length; i++) {
      var id = String(dane[i][0] || "").trim();
      if (!id) continue;
      var imie = String(dane[i][1] || "").trim() || id;
      var pkt;
      if (zakres) {
        pkt = _sumaPunktowWZakresie(ss, id, zakres.od, zakres.do_);
      } else {
        pkt = parseInt(dane[i][2], 10);
        if (isNaN(pkt)) pkt = 0;
      }
      var ranga = String(dane[i][6] || "").trim();
      // Ranking: zawsze bez księży i adminów
      var rLow = ranga.toLowerCase();
      if (rLow.indexOf("ksi") === 0) continue;
      if (rLow.indexOf("admin") === 0) continue;
      var czyLektor = rLow.indexOf("lektor") >= 0;
      if (filtrN === "ministranci" && czyLektor) continue;
      if (filtrN === "lektorzy" && !czyLektor) continue;
      var zdjecie = String(dane[i][7] || "").trim();
      lista.push({ id: id, imie: imie, punkty: pkt, ranga: ranga, zdjecie: zdjecie });
    }
    lista.sort(function(a, b) {
      if (b.punkty !== a.punkty) return b.punkty - a.punkty;
      return String(a.imie).localeCompare(String(b.imie), "pl");
    });
    var mojaPozycja = null;
    for (var p = 0; p < lista.length; p++) {
      lista[p].pozycja = p + 1;
      if (String(lista[p].id) === uid) mojaPozycja = p + 1;
    }
    var tzR = _APP_TZ;
    return {
      sukces: true,
      lista: lista,
      mojaPozycja: mojaPozycja,
      razem: lista.length,
      zakres: zakres ? {
        od: Utilities.formatDate(zakres.od, tzR, "yyyy-MM-dd"),
        do: Utilities.formatDate(zakres.do_, tzR, "yyyy-MM-dd")
      } : null
    };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: e.message };
  }
}

function _getCzasSystemowy() {
  try {
    var props = PropertiesService.getScriptProperties();
    var iso = String(props.getProperty("czas_testowy_iso") || "").trim();
    if (iso) {
      var d = new Date(iso);
      if (!isNaN(d.getTime())) return d;
    }
  } catch (e) {}
  return new Date();
}

/**
 * Czy dany user może korzystać z panelu "Czas systemowy (test RFID)"?
 * Wszyscy ADMIN/MODERATOR + konto testowe 2212.
 */
function _jestAdminCzasuTestowego(userId) {
  try {
    var uid = _normId(userId);
    if (!uid) return false;
    if (String(uid) === "2212") return true;
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    return rola === "ADMIN" || rola === "MODERATOR";
  } catch (e) { return false; }
}

function getCzasTestowyStatus(userId) {
  try {
    if (!_jestAdminCzasuTestowego(userId)) {
      return { sukces: false, wiadomosc: "Brak uprawnień — tylko administrator." };
    }
    var props = PropertiesService.getScriptProperties();
    var iso = String(props.getProperty("czas_testowy_iso") || "").trim();
    var real = new Date();
    var eff = _getCzasSystemowy();
    var tz = _APP_TZ;
    return {
      sukces: true,
      aktywny: !!iso,
      iso: iso || "",
      czasEfektywny: Utilities.formatDate(eff, tz, "yyyy-MM-dd HH:mm:ss"),
      czasRealny: Utilities.formatDate(real, tz, "yyyy-MM-dd HH:mm:ss"),
      wiadomosc: iso ? ("Czas testowy: " + Utilities.formatDate(eff, tz, "dd.MM.yyyy HH:mm")) : "Używany czas rzeczywisty serwera."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/** Ustawia sztuczny czas systemowy (ISO lub yyyy-MM-ddTHH:mm). Tylko ID 1. */
function ustawCzasTestowy(userId, isoOrLocal) {
  try {
    if (!_jestAdminCzasuTestowego(userId)) {
      return { sukces: false, wiadomosc: "Tylko administrator może zmieniać czas systemowy." };
    }
    var raw = String(isoOrLocal || "").trim();
    if (!raw) return { sukces: false, wiadomosc: "Podaj datę i godzinę." };
    // "2026-08-28T18:00" lub "2026-08-28 18:00:00"
    raw = raw.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) raw += ":00";
    var d = new Date(raw);
    if (isNaN(d.getTime())) return { sukces: false, wiadomosc: "Niepoprawna data/godzina." };
    PropertiesService.getScriptProperties().setProperty("czas_testowy_iso", d.toISOString());
    var st = getCzasTestowyStatus(userId);
    return { sukces: true, wiadomosc: "Ustawiono czas testowy: " + (st.czasEfektywny || raw), status: st };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function wyczyscCzasTestowy(userId) {
  try {
    if (!_jestAdminCzasuTestowego(userId)) {
      return { sukces: false, wiadomosc: "Brak uprawnień — tylko administrator." };
    }
    PropertiesService.getScriptProperties().deleteProperty("czas_testowy_iso");
    return { sukces: true, wiadomosc: "Przywrócono czas rzeczywisty serwera.", status: getCzasTestowyStatus(userId) };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/**
 * Rozpoznaje ministranta po UID karty LUB po ID numerycznym (wpisanym z klawiatury ESP).
 * Zwraca { id, imie, blad } — blad = nieznana_karta | karta_nieaktywna | null
 */
function _rozpoznajMinistrantaPoUidLubId(ss, uidRaw) {
  var uid = String(uidRaw || "").trim().toUpperCase();
  if (!uid) return { id: null, imie: null, blad: "brak_uid" };

  var mapaUid = _pobierzMapeUidRfid();
  var mapaId  = _pobierzMapeIdMinistrantow();
  var setDyzur = _pobierzSetOsobZDyzurem();

  var idMin = null, imieMin = null, aktywnaKarta = true, jestKarta = false;

  if (mapaUid[uid]) {
    jestKarta = true;
    var wpis = mapaUid[uid];
    idMin = wpis.id;
    imieMin = wpis.imie;
    aktywnaKarta = wpis.aktywna;
  } else if (/^\d+$/.test(uid)) {
    var idSzuk = String(parseInt(uid, 10));
    if (mapaId[uid]) { idMin = uid; imieMin = mapaId[uid]; }
    else if (mapaId[idSzuk]) { idMin = idSzuk; imieMin = mapaId[idSzuk]; }
    else {
      try {
        var sheetH = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
        if (sheetH && sheetH.getLastRow() > 1) {
          var dh = sheetH.getDataRange().getValues();
          for (var h = 1; h < dh.length; h++) {
            var hid = String(dh[h][0] || "").trim();
            if (hid === uid || hid === idSzuk || String(parseInt(hid, 10)) === idSzuk) {
              idMin = hid;
              imieMin = String(dh[h][1] || "").trim() || hid;
              break;
            }
          }
        }
      } catch (eH) {}
    }
  } else {
    return { id: null, imie: null, blad: "nieznana_karta" };
  }

  if (!idMin) return { id: null, imie: null, blad: "nieznana_karta" };
  if (jestKarta && !aktywnaKarta) return { id: idMin, imie: imieMin, blad: "karta_nieaktywna" };

  // Karta aktywuje się dopiero gdy osoba ma ustawiony dyżur.
  // Wpisanie samego ID numerycznego (bez prawdziwej karty RFID) pomija tę blokadę.
  if (jestKarta && _rfidWymagajDyzuru() && !setDyzur[idMin]) {
    return { id: idMin, imie: imieMin, blad: "brak_dyzuru" };
  }

  return { id: idMin, imie: imieMin, blad: null };
}

function przetworzOdbicieESP32(uidParam, kodParam, deviceParam, manualParam) {
  try {
    var uid = String(uidParam || "").trim().toUpperCase();
    var kod = String(kodParam || "AUTO").trim().toUpperCase();
    var device = String(deviceParam || "Nieznany czytnik").trim();
    if (!uid) return JSON.stringify({ sukces: false, blad: "brak_uid" });

    // Przerwa techniczna — czytnik nie rejestruje obecności, gdy przerwa jest
    // aktywna. Tryb SKANOWANIA UID (parowanie kart) nadal działa, bo to
    // czynność administracyjna, a nie wpis na stan obecności.
    if (!_rfidTrybSkanAktywny()) {
      // Tylko PELNA BLOKADA DOSTEPU (permanentna) wstrzymuje rejestracje
      // obecnosci z czytnika. Sam baner informacyjny w aplikacji NIE blokuje
      // skanow RFID — ministranci moga dalej odbijac karty.
      var _prz = getPrzerwaTechniczna();
      if (_prz && _prz.permanentna) {
        return JSON.stringify({
          sukces: false,
          blad: "przerwa_techniczna",
          wiadomosc: (_prz.wiadomosc || "Blokada dostepu — rejestracja obecnosci wstrzymana.")
        });
      }
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var teraz = _getCzasSystemowy(); // respektuje czas testowy (ID 1)

    // Tryb skanowania UID (bez punktów) — tylko dla prawdziwych odbić karty RFID,
    // nie dla ID wpisanego ręcznie z klawiatury.
    // Rozpoznajemy to po jawnej fladze "manual" wysyłanej przez ESP32.
    // Fallback (stary firmware bez tej flagi): zgaduj po tym, czy UID jest czysto
    // cyfrowy — ale to zawodne (karta RFID też może mieć same cyfry w UID),
    // dlatego zaktualizuj firmware ESP32, żeby zawsze wysyłał manual=0/1.
    var manualJawny = (manualParam !== undefined && manualParam !== null && String(manualParam) !== "");
    var jestReczny = manualJawny ? (String(manualParam) === "1") : /^\d+$/.test(uid);
    if (_rfidTrybSkanAktywny() && !jestReczny) {
      return zapiszSkanUidRfid(uid, device);
    }

    // Karta RFID LUB ID wpisane z klawiatury → ministrant
    var rozpoznany = _rozpoznajMinistrantaPoUidLubId(ss, uid);
    if (rozpoznany.blad) {
      return JSON.stringify({ sukces: false, blad: rozpoznany.blad });
    }
    var idMinistranta = rozpoznany.id;
    var imieMinistranta = rozpoznany.imie;

    // --- Stary tryb A/B/C/D z arkusza (gdy kod 1-literowy i nie AUTO) ---
    if (kod.length === 1 && kod !== "A" && kod.match(/^[B-Z]$/)) {
      var sheetZ = _pobierzAlboUtworzArkuszZdarzen();
      var daneZ = sheetZ.getDataRange().getValues();
      var nazwaW = null, pktW = 0;
      for (var j = 1; j < daneZ.length; j++) {
        if (String(daneZ[j][0] || "").trim().toUpperCase() === kod && _czyAktywne(daneZ[j][3])) {
          nazwaW = String(daneZ[j][1] || "").trim();
          pktW = parseInt(daneZ[j][2], 10) || 0;
          break;
        }
      }
      if (nazwaW === null) {
        // Nieznany kod z arkusza → spróbuj inteligentnego AUTO zamiast suchego błędu
        kod = "AUTO";
      } else {
        var sumaSt = _zapiszLogIPrzelicz(ss, idMinistranta, imieMinistranta, device, nazwaW, pktW);
        return JSON.stringify({ sukces: true, imie: imieMinistranta, wydarzenie: nazwaW, punkty: pktW, suma: sumaSt });
      }
    }

    // --- AUTO lub kod A (msza) lub kod wyboru z LCD ---
    var wynik;
    if (kod === "AUTO" || kod === "A" || kod === "") {
      wynik = _rozstrzygnijOdbicieAuto(ss, idMinistranta, teraz);
      if (wynik.tryb === "brak") {
        return JSON.stringify({
          sukces: false,
          blad: "brak_wydarzenia",
          wiadomosc: "Brak mszy/dyżuru w oknie czasowym (−1h…+2h)."
        });
      }
      if (wynik.tryb === "wybor") {
        return JSON.stringify({
          sukces: false,
          blad: "wybor_wymagany",
          imie: imieMinistranta,
          wiadomosc: "Wybierz wydarzenie na klawiaturze",
          opcje: wynik.opcje
        });
      }
      // tryb ok
      var policzone = _policzPunktyZaSlot(wynik.slot, teraz, !!wynik.maDyzur);
      if (_czyJuzZaliczoneDziś(ss, idMinistranta, policzone.nazwa, teraz)) {
        return JSON.stringify({
          sukces: false,
          blad: "juz_zaliczone",
          imie: imieMinistranta,
          wiadomosc: "To wydarzenie było już dziś zaliczone."
        });
      }
      var suma1 = _zapiszLogIPrzelicz(ss, idMinistranta, imieMinistranta, device, policzone.nazwa, policzone.punkty);
      return JSON.stringify({
        sukces: true,
        imie: imieMinistranta,
        wydarzenie: policzone.nazwa,
        punkty: policzone.punkty,
        suma: suma1
      });
    }

    // Kod z listy opcji (po wyborze na klawiaturze)
    var slot = _znajdzSlotPoKodzie(ss, teraz, kod, idMinistranta);
    if (!slot) {
      // spróbuj też małe litery / oryginalny kod
      slot = _znajdzSlotPoKodzie(ss, teraz, String(kodParam || "").trim(), idMinistranta);
    }
    if (!slot) {
      // Ostatnia deska: spróbuj AUTO jeszcze raz (okno mogło się zmienić)
      var wynik2 = _rozstrzygnijOdbicieAuto(ss, idMinistranta, teraz);
      if (wynik2.tryb === "ok") {
        var pol2 = _policzPunktyZaSlot(wynik2.slot, teraz, !!wynik2.maDyzur);
        if (!_czyJuzZaliczoneDziś(ss, idMinistranta, pol2.nazwa, teraz)) {
          var suma3 = _zapiszLogIPrzelicz(ss, idMinistranta, imieMinistranta, device, pol2.nazwa, pol2.punkty);
          return JSON.stringify({ sukces: true, imie: imieMinistranta, wydarzenie: pol2.nazwa, punkty: pol2.punkty, suma: suma3 });
        }
      }
      return JSON.stringify({
        sukces: false,
        blad: "nieznane_wydarzenie",
        wiadomosc: "Brak aktualnie trwającego wydarzenia. Przyłóż kartę w bliżej czasu mszy."
      });
    }
    var dyzur = _dyzurUseraWTygodniu(ss, idMinistranta, teraz);
    var maD = dyzur && slot.start &&
      teraz.getDay() === dyzur.dzienTygodnia &&
      slot.start.getHours() === dyzur.godzina &&
      slot.start.getMinutes() === (dyzur.minuta || 0);
    var pol = _policzPunktyZaSlot(slot, teraz, maD);
    if (_czyJuzZaliczoneDziś(ss, idMinistranta, pol.nazwa, teraz)) {
      return JSON.stringify({ sukces: false, blad: "juz_zaliczone", imie: imieMinistranta });
    }
    var suma2 = _zapiszLogIPrzelicz(ss, idMinistranta, imieMinistranta, device, pol.nazwa, pol.punkty);
    return JSON.stringify({
      sukces: true,
      imie: imieMinistranta,
      wydarzenie: pol.nazwa,
      punkty: pol.punkty,
      suma: suma2
    });

  } catch (err) {
    return JSON.stringify({ sukces: false, blad: "blad_serwera", wiadomosc: String(err && err.message ? err.message : err) });
  }
}

/**
 * Automat −6: niedziela 23:59 — kto miał dyżur w tym tygodniu i nie ma logu „Dyżur”, dostaje minus.
 * Uruchom trigger: czasowy, co niedzielę 23:55–23:59 (lub ręcznie).
 */

/**
 * Data założenia konta — od tego dnia wliczają się automatyczne minusy
 * (dyżury / zbiórki / uroczystości). Starsze zdarzenia są pomijane.
 * Przechowywane w ScriptProperties: konto_od_<ID> = ISO date.
 * Brak daty = konto "stare" (bez filtra wstecz — jak dotychczas).
 */
function _ustawDataZalozeniaKonta(userId, dataOpt) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return;
    var d = dataOpt instanceof Date ? dataOpt : (dataOpt ? new Date(dataOpt) : new Date());
    if (isNaN(d.getTime())) d = new Date();
    PropertiesService.getScriptProperties().setProperty(
      "konto_od_" + uid,
      Utilities.formatDate(d, _APP_TZ, "yyyy-MM-dd")
    );
  } catch (e) {}
}

function _getDataZalozeniaKonta(userId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return null;
    var raw = PropertiesService.getScriptProperties().getProperty("konto_od_" + uid);
    if (!raw) return null;
    // yyyy-MM-dd lub ISO
    var d = new Date(String(raw).indexOf("T") >= 0 ? raw : (String(raw).trim() + "T12:00:00"));
    if (isNaN(d.getTime())) return null;
    return d;
  } catch (e) {
    return null;
  }
}

// ======================================================================
// PARSER DATY Z ARKUSZA Nieobecnosci_dyzur (kolumna D)
// ----------------------------------------------------------------------
// Kolumna D jest w formacie plain text ("Czwartek 24.09.2026, 8:00"),
// więc new Date(tekst) zwracał Invalid Date → warunek "ma zaakceptowany
// wniosek" NIGDY nie działał i minus leciał mimo usprawiedliwienia.
// Poniższa funkcja obsługuje:
//   - Date (obiekt)
//   - "2026-09-24" (ISO)
//   - "24.09.2026" (PL gdziekolwiek w stringu)
//   - "Czwartek 24.09.2026, 8:00" (PL z dniem tygodnia i godziną)
//   - "24-09-2026"
// Zwraca "YYYY-MM-DD" albo "".
// ======================================================================
function _parsujDateNieobecnosci(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return "";
  var tz = _APP_TZ;
  if (rawValue instanceof Date) {
    if (isNaN(rawValue.getTime())) return "";
    return Utilities.formatDate(rawValue, tz, "yyyy-MM-dd");
  }
  var s = String(rawValue).trim();
  if (!s) return "";
  var mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) return mIso[1] + "-" + mIso[2] + "-" + mIso[3];
  var mPl = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (mPl) {
    var dd = mPl[1].length === 1 ? "0" + mPl[1] : mPl[1];
    var mm = mPl[2].length === 1 ? "0" + mPl[2] : mPl[2];
    return mPl[3] + "-" + mm + "-" + dd;
  }
  var mDash = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (mDash) {
    var dd2 = mDash[1].length === 1 ? "0" + mDash[1] : mDash[1];
    var mm2 = mDash[2].length === 1 ? "0" + mDash[2] : mDash[2];
    return mDash[3] + "-" + mm2 + "-" + dd2;
  }
  var dObj = new Date(s);
  if (!isNaN(dObj.getTime())) return Utilities.formatDate(dObj, tz, "yyyy-MM-dd");
  return "";
}

/**
 * Usuwa już naliczony auto-minus za dyżur (klucz AUTO_MINUS_DYZUR|YYYY-MM-DD|HH:MM)
 * dla danego usera. godzinaKey="" → usuwa wszystkie auto-minusy za ten dzień.
 * Przelicza punkty. Idempotentne. Zwraca liczbę usuniętych wierszy.
 */
function _usunAutoMinusDyzurZaDzien(userId, dzienKey, godzinaKey) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logiR = ss.getSheetByName("Logi_ręczne");
    if (!logiR || logiR.getLastRow() < 2) return 0;
    var daneR = logiR.getDataRange().getValues();
    var usunieto = 0;
    var needleDay  = "AUTO_MINUS_DYZUR|" + dzienKey + "|";
    var needleFull = godzinaKey ? ("AUTO_MINUS_DYZUR|" + dzienKey + "|" + godzinaKey) : null;
    for (var lr = daneR.length - 1; lr >= 1; lr--) {
      if (String(daneR[lr][1] || "").trim() !== String(userId).trim()) continue;
      if ((parseInt(daneR[lr][3], 10) || 0) >= 0) continue;
      var opisR = String(daneR[lr][4] || "");
      var pasuje = needleFull
        ? (opisR.indexOf(needleFull) >= 0)
        : (opisR.indexOf(needleDay)  >= 0);
      if (!pasuje) continue;
      try { logiR.deleteRow(lr + 1); } catch (eD) { continue; }
      usunieto++;
    }
    if (usunieto > 0) {
      try { przeliczPunktyUzytkownika(userId); } catch (eP) {}
    }
    return usunieto;
  } catch (e) {
    return 0;
  }
}

/**
 * Diagnostyka — uruchom RĘCZNIE z edytora: diagnozujWnioskiNieobecnosci("")
 * Wypisuje do Logs co parser wyciąga z każdego wiersza arkusza.
 */
function diagnozujWnioskiNieobecnosci(userId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
  if (!sheetN || sheetN.getLastRow() < 2) { Logger.log("Brak arkusza Nieobecnosci_dyzur."); return; }
  var uidFilter = String(userId || "").trim();
  var dane = sheetN.getDataRange().getValues();
  Logger.log("=== Diagnostyka wniosków o nieobecność ===");
  for (var i = 1; i < dane.length; i++) {
    var uid = String(dane[i][1] || "").trim();
    if (uidFilter && uid !== uidFilter) continue;
    var rawD = dane[i][3];
    var rawType = (rawD instanceof Date) ? "Date" : typeof rawD;
    Logger.log("wiersz=" + (i + 1) + " uid=" + uid + " rawType=" + rawType +
               " rawD=[" + String(rawD) + "] → dKey=[" + _parsujDateNieobecnosci(rawD) +
               "] status=[" + String(dane[i][6] || "").trim() + "]");
  }
  Logger.log("=== Koniec diagnostyki ===");
}

// ======================================================================
// MIGRACJA KOLUMN Kandydaci + Hasła (wstaw pustą kolumnę B)
// ----------------------------------------------------------------------
// Przesuwa wszystko od B w prawo. Dzięki temu kolumna B jest pusta
// i można w niej ręcznie wpisywać dodatkowe ID. Flaga migracji w
// ScriptProperties zabezpiecza przed podwójnym uruchomieniem.
//
// Uruchom RĘCZNIE raz z edytora Apps Script.
// ======================================================================
function migrujKolumnyKandydaciHasla() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('migracja_kolumny_B_v1') === 'done') {
    return "Migracja już przeprowadzona (flaga migracja_kolumny_B_v1=done).";
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var raport = [];
  ['Kandydaci', 'Hasła', 'Hasla'].forEach(function(nazwa) {
    var sheet = ss.getSheetByName(nazwa);
    if (!sheet) return;
    if (nazwa === 'Hasla' && ss.getSheetByName('Hasła')) return; // uniknij duplikatu
    sheet.insertColumnBefore(2);
    sheet.getRange(1, 2).setValue("ID_2");
    raport.push(nazwa + ": wstawiono pustą kolumnę B.");
  });
  props.setProperty('migracja_kolumny_B_v1', 'done');
  return raport.join("\n") || "Nic do zmigrowania.";
}

/** Sprawdza czy migracja kolumn została już przeprowadzona. */
function _migracjaKolumnyBDone() {
  try {
    return PropertiesService.getScriptProperties().getProperty('migracja_kolumny_B_v1') === 'done';
  } catch (e) { return false; }
}

/**
 * Wyciąga ID z wiersza arkusza Kandydaci/Hasła. Sprawdza kolumnę A (idx 0)
 * i kolumnę B (idx 1). Zwraca pierwszą niepustą wartość zawierającą
 * przynajmniej 1 cyfrę. Jeśli obie puste/bez-cyfrowe → "".
 */
function _idZWiersza(row) {
  if (!row || row.length === 0) return "";
  var a = _normId(row[0]);
  var b = row.length > 1 ? _normId(row[1]) : "";
  if (a && /\d/.test(a)) return a;
  if (b && /\d/.test(b)) return b;
  return "";
}

/**
 * Normalizuje wiersz Kandydaci do formatu SPRZED migracji (kolumna 0 = ID,
 * 1 = Imię, 2 = Punkty, 3 = Funkcje, 4 = Dodatkowe, 5 = Uwagi, 6 = Ranga,
 * 7 = Zdjęcie). Po migracji: A=ID1, B=ID2, C=Imię, D=Punkty, E=Funkcje,
 * F=Dodatkowe, G=Uwagi, H=Ranga, I=Zdjęcie.
 */
function _normalizujWierszKandydaci(row) {
  if (!row) return row;
  if (!_migracjaKolumnyBDone()) return row;
  return [
    _idZWiersza(row),
    String(row[2] || ""),  // Imię
    row[3],                 // Punkty
    String(row[4] || ""),  // Funkcje
    String(row[5] || ""),  // Dodatkowe
    String(row[6] || ""),  // Uwagi
    String(row[7] || ""),  // Ranga
    String(row[8] || "")   // Zdjęcie URL
  ];
}

/**
 * Normalizuje wiersz Hasła do formatu SPRZED migracji:
 * 0=ID, 1=Imię, 2=Hasło, 3=Zmiana, 4=Rola, 5=Admin.
 * Po migracji: A=ID1, B=ID2, C=Imię, D=Hasło, E=Zmiana, F=Rola, G=Admin.
 */
function _normalizujWierszHasla(row) {
  if (!row) return row;
  if (!_migracjaKolumnyBDone()) return row;
  return [
    _idZWiersza(row),
    String(row[2] || ""),
    String(row[3] || ""),
    row[4],
    String(row[5] || ""),
    row[6]
  ];
}

/** Zwraca znormalizowane wiersze arkusza Kandydaci (po migracji = stary format). */
function _pobierzDaneKandydaci() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Kandydaci");
  if (!sheet) return [[]];
  var dane = sheet.getDataRange().getValues();
  if (!_migracjaKolumnyBDone()) return dane;
  return dane.map(_normalizujWierszKandydaci);
}

/** Zwraca znormalizowane wiersze arkusza Hasła (po migracji = stary format). */
function _pobierzDaneHasla() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
  if (!sheet) return [[]];
  var dane = sheet.getDataRange().getValues();
  if (!_migracjaKolumnyBDone()) return dane;
  return dane.map(_normalizujWierszHasla);
}

// ======================================================================
// DRUGIE ID (kol. G w Hasła, kol. J w Kandydaci) — mapowanie na ID główne
// ----------------------------------------------------------------------
// Główne ID jest w kolumnie A. Drugie (chwilowe) ID jest w:
//   - Hasła:     kolumna G (indeks 6)
//   - Kandydaci: kolumna J (indeks 9)
// Do logowania działa A LUB drugie. Po zalogowaniu cała aplikacja używa
// ID głównego (kolumna A) — drugie ID jest tylko wygodnym skrótem.
// ======================================================================

var _SECOND_ID_COL_HASLA = 6;     // kolumna G
var _SECOND_ID_COL_KANDYDACI = 9; // kolumna J

/**
 * Zwraca ID główne (z kolumny A) jeśli podane ID pasuje do A LUB drugiego
 * w Hasłach/Kandydaci. Gdy nic nie pasuje — zwraca podane ID bez zmian.
 */
function _resolvePrimaryId(uid) {
  var target = _normId(uid);
  if (!target) return "";
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetH = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (sheetH && sheetH.getLastRow() > 1) {
      var dh = sheetH.getDataRange().getValues();
      for (var i = 1; i < dh.length; i++) {
        var a = _normId(dh[i][0]);
        var g = _normId(dh[i][_SECOND_ID_COL_HASLA]);
        if (a && a === target) return a;
        if (g && g === target && a) return a;
      }
    }
    var sheetK = ss.getSheetByName("Kandydaci");
    if (sheetK && sheetK.getLastRow() > 1) {
      var dk = sheetK.getDataRange().getValues();
      for (var j = 1; j < dk.length; j++) {
        var ak = _normId(dk[j][0]);
        var jk = _normId(dk[j][_SECOND_ID_COL_KANDYDACI]);
        if (ak && ak === target) return ak;
        if (jk && jk === target && ak) return ak;
      }
    }
  } catch (e) {}
  return target;
}

/** Czy wiersz Hasła pasuje do ID (A albo G). */
function _wierszHaslaPasuje(row, targetNormId) {
  if (!row) return false;
  var a = _normId(row[0]);
  var g = _normId(row[_SECOND_ID_COL_HASLA]);
  return (a && a === targetNormId) || (g && g === targetNormId);
}

/** Czy wiersz Kandydaci pasuje do ID (A albo J). */
function _wierszKandydaciPasuje(row, targetNormId) {
  if (!row) return false;
  var a = _normId(row[0]);
  var j = _normId(row[_SECOND_ID_COL_KANDYDACI]);
  return (a && a === targetNormId) || (j && j === targetNormId);
}

// ======================================================================
// PARSER DATY z arkusza Nieobecnosci_dyzur (kolumna D)
// ======================================================================
function _parsujDateNieobecnosci(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return "";
  var tz = _APP_TZ;
  if (rawValue instanceof Date) {
    if (isNaN(rawValue.getTime())) return "";
    return Utilities.formatDate(rawValue, tz, "yyyy-MM-dd");
  }
  var s = String(rawValue).trim();
  if (!s) return "";
  var mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) return mIso[1] + "-" + mIso[2] + "-" + mIso[3];
  var mPl = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (mPl) {
    var dd = mPl[1].length === 1 ? "0" + mPl[1] : mPl[1];
    var mm = mPl[2].length === 1 ? "0" + mPl[2] : mPl[2];
    return mPl[3] + "-" + mm + "-" + dd;
  }
  var mDash = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (mDash) {
    var dd2 = mDash[1].length === 1 ? "0" + mDash[1] : mDash[1];
    var mm2 = mDash[2].length === 1 ? "0" + mDash[2] : mDash[2];
    return mDash[3] + "-" + mm2 + "-" + dd2;
  }
  var dObj = new Date(s);
  if (!isNaN(dObj.getTime())) return Utilities.formatDate(dObj, tz, "yyyy-MM-dd");
  return "";
}

/** Usuwa już naliczony auto-minus za dyżur. */
function _usunAutoMinusDyzurZaDzien(userId, dzienKey, godzinaKey) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logiR = ss.getSheetByName("Logi_ręczne");
    if (!logiR || logiR.getLastRow() < 2) return 0;
    var daneR = logiR.getDataRange().getValues();
    var usunieto = 0;
    var needleDay  = "AUTO_MINUS_DYZUR|" + dzienKey + "|";
    var needleFull = godzinaKey ? ("AUTO_MINUS_DYZUR|" + dzienKey + "|" + godzinaKey) : null;
    for (var lr = daneR.length - 1; lr >= 1; lr--) {
      if (String(daneR[lr][1] || "").trim() !== String(userId).trim()) continue;
      if ((parseInt(daneR[lr][3], 10) || 0) >= 0) continue;
      var opisR = String(daneR[lr][4] || "");
      var pasuje = needleFull
        ? (opisR.indexOf(needleFull) >= 0)
        : (opisR.indexOf(needleDay)  >= 0);
      if (!pasuje) continue;
      try { logiR.deleteRow(lr + 1); } catch (eD) { continue; }
      usunieto++;
    }
    if (usunieto > 0) {
      try { przeliczPunktyUzytkownika(userId); } catch (eP) {}
    }
    return usunieto;
  } catch (e) { return 0; }
}

/** true = konto istniało w dniu zdarzenia (minus wolno naliczyć). */
function _kontoIstnialoWDniu(userId, dataZdarzenia) {
  var od = _getDataZalozeniaKonta(userId);
  if (!od) return true; // legacy bez daty — bez zmian zachowania
  if (!dataZdarzenia) return true;
  var z = dataZdarzenia instanceof Date ? dataZdarzenia : new Date(dataZdarzenia);
  if (isNaN(z.getTime())) return true;
  var od0 = new Date(od.getFullYear(), od.getMonth(), od.getDate()).getTime();
  var z0 = new Date(z.getFullYear(), z.getMonth(), z.getDate()).getTime();
  return z0 >= od0;
}

/**
 * Auto-minus za nieobecność na dyżurze — działa per-dyżur, na bieżąco.
 *
 * ZASADY:
 *   1. Sprawdza każdy dyżur w arkuszu Dyżury INDYWIDUALNIE — nie cały
 *      tydzień naraz (poprzednia wersja mogła pominąć osobę, która była
 *      w poniedziałek, a nie przyszła w piątek).
 *   2. Minus nalicza się OD RAZU po zamknięciu okna odbicia:
 *         tydzień (pon-pt):  start + 1h
 *      (sobota 18:00 i niedziela są pomijane — brak dyżurów.)
 *   3. Minus pomijany gdy:
 *        - osoba ma log "Dyżur" w Logi_czytnik lub Logi_ręczne tego dnia
 *        - ma zaakceptowany wniosek o nieobecność na ten dzień
 *        - konto zostało założone po dniu dyżuru
 *        - dyżur nie obowiązywał (Obowiązuje od / Obowiązuje do)
 *   4. Idempotencja: "AUTO_MINUS_DYZUR|YYYY-MM-DD|HH:MM" w Opis.
 *
 * Trigger: co 15 minut (patrz zainstalujTriggeryPunktow).
 */
function naliczMinusyZaOpuszczoneDyzury(dniWstecz) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetD = ss.getSheetByName("Dyżury");
    if (!sheetD || sheetD.getLastRow() < 2) return { sukces: true, naliczone: 0 };

    var tz = _APP_TZ;
    var teraz = new Date();
    var terazMs = teraz.getTime();
    var _dni = parseInt(dniWstecz, 10);
    if (isNaN(_dni) || _dni < 1) _dni = 1;
    if (_dni > 730) _dni = 730; // max 2 lata wstecz
    var oknoHist = _dni * 24 * 3600 * 1000;   // ile wstecz patrzymy

    var dane = sheetD.getDataRange().getValues();

    // Logi
    var sheetLogi = ss.getSheetByName("Logi_czytnik");
    var logi = (sheetLogi && sheetLogi.getLastRow() > 1) ? sheetLogi.getDataRange().getValues() : [];
    var sheetReczne = ss.getSheetByName("Logi_ręczne");
    if (!sheetReczne) {
      sheetReczne = ss.insertSheet("Logi_ręczne");
      sheetReczne.appendRow(["Data","ID","Wydarzenie","Punkty","Opis","Wykonawca ID","Wykonawca Imię"]);
    }
    var reczne = sheetReczne.getDataRange().getValues();

    // Nieobecności (dla zaakceptowanych wniosków)
    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    var nieob = (sheetN && sheetN.getLastRow() > 1) ? sheetN.getDataRange().getValues() : [];

    var naliczone = 0;

    for (var i = 1; i < dane.length; i++) {
      var uid = String(dane[i][2] || "").trim();
      if (!uid || !dane[i][0]) continue;
      var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
      if (isNaN(dt.getTime())) continue;

      var wd = dt.getDay();       // 0=Nd
      var hh = dt.getHours();
      var mm = dt.getMinutes();

      // Niedziela: pomijamy ZWYKŁE dyżury tygodniowe (niedziela to dzień
      // wolny), ale przepuszczamy dyżur JEDNORAZOWY (Obowiązuje od === do).
      var _odR = dane[i][3];
      var _doR = dane[i][4];
      var _odK = "", _doK = "";
      if (_odR) {
        var _odD = _odR instanceof Date ? _odR : new Date(_odR);
        if (!isNaN(_odD.getTime())) _odK = Utilities.formatDate(_odD, tz, "yyyy-MM-dd");
      }
      if (_doR) {
        var _doD = _doR instanceof Date ? _doR : new Date(_doR);
        if (!isNaN(_doD.getTime())) _doK = Utilities.formatDate(_doD, tz, "yyyy-MM-dd");
      }
      var _jestJednorazowy = (_odK && _doK && _odK === _doK);

      if (wd === 0 && !_jestJednorazowy) continue;
      // >>> FIX 2026-09 (SAT-18-MINUS):
      // Usunięto skip "
      // Sobota 18:00 to dyżur taki sam jak każdy inny — brak
      // obecności w oknie odbicia nalicza teraz -4 pkt
      // (zgodnie z _PKT.BRAK_DYZURU).

      // Znajdź OSTATNIE wystąpienie tego dyżuru (w tym tygodniu lub dziś)
      var dzisStart = new Date(teraz.getFullYear(), teraz.getMonth(), teraz.getDate());
      var offset = (dzisStart.getDay() - wd + 7) % 7;      // ile dni wstecz
      var wyst = new Date(dzisStart);
      wyst.setDate(dzisStart.getDate() - offset);
      wyst.setHours(hh, mm, 0, 0);

      // Jeśli "wystąpienie" jest w przyszłości — pomiń (dziś jeszcze nie było)
      if (wyst.getTime() > terazMs) continue;

      // Poza oknem 24h — pomiń
      if (terazMs - wyst.getTime() > oknoHist) continue;

      // Okno odbicia: tydzień +1h, niedziela/sobota 18:00 +1h15
      var _poMin = (wd === 0 || (wd === 6 && hh === 18)) ? 75 : 60;
      var oknoDo = new Date(wyst.getTime() + _poMin * 60 * 1000);
      if (terazMs < oknoDo.getTime()) continue;   // okno jeszcze trwa

      // Obowiązuje od / do
      var odRaw = dane[i][3];
      var doRaw = dane[i][4];
      var dzienKey = Utilities.formatDate(wyst, tz, "yyyy-MM-dd");
      if (odRaw) {
        var odD = odRaw instanceof Date ? odRaw : new Date(odRaw);
        if (!isNaN(odD.getTime())) {
          var odKey = Utilities.formatDate(odD, tz, "yyyy-MM-dd");
          if (dzienKey < odKey) continue;
        }
      }
      if (doRaw) {
        var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
        if (!isNaN(doD.getTime())) {
          var doKey = Utilities.formatDate(doD, tz, "yyyy-MM-dd");
          if (dzienKey > doKey) continue;
        }
      }

      // Konto istniało w dniu dyżuru?
      if (typeof _kontoIstnialoWDniu === "function" && !_kontoIstnialoWDniu(uid, wyst)) continue;

      // Log "Dyżur" tego dnia?
      var byl = false;
      function _maLog(rows, colId, colNazwa, colData) {
        for (var r = 1; r < rows.length; r++) {
          if (String(rows[r][colId] || "").trim() !== uid) continue;
          var ld = rows[r][colData] instanceof Date ? rows[r][colData] : new Date(rows[r][colData]);
          if (isNaN(ld.getTime())) continue;
          if (Utilities.formatDate(ld, tz, "yyyy-MM-dd") !== dzienKey) continue;
          var n = String(rows[r][colNazwa] || "").toLowerCase();
          if (n.indexOf("dyżur") >= 0 || n.indexOf("dyzur") >= 0) return true;
        }
        return false;
      }
      if (_maLog(logi, 1, 4, 0)) byl = true;
      if (!byl && _maLog(reczne, 1, 2, 0)) byl = true;

      // Zaakceptowany wniosek o nieobecność na ten dzień (i godzinę)?
      // >>> FIX 2026-09 (NIEOB-HOUR): sprawdzamy precyzyjnie datę +
      //     godzinę dyżuru. Jeśli wniosek ma godzinę 07:00, to nie
      //     blokuje auto-minusa dla tego samego dnia o 18:00.
      //     Jeśli wniosek nie ma godziny (stary format) — blokuje
      //     cały dzień (backward compat).
      if (!byl) {
        var _godzDyzurKey = (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm);
        if (_czyJestZaakceptowanaNieobecnoscDyzur(uid, dzienKey, _godzDyzurKey)) {
          byl = true;
        }
      }
      if (byl) continue;

      // Idempotencja
      var klucz = "AUTO_MINUS_DYZUR|" + dzienKey + "|" +
                  (hh < 10 ? "0"+hh : hh) + ":" + (mm < 10 ? "0"+mm : mm);
      var juzJest = false;
      for (var rr = 1; rr < reczne.length; rr++) {
        if (String(reczne[rr][1] || "").trim() !== uid) continue;
        if (String(reczne[rr][4] || "").indexOf(klucz) >= 0) { juzJest = true; break; }
      }
      if (juzJest) continue;

      // Nalicz minus
      sheetReczne.appendRow([
        new Date(),
        uid,
        "Nieusprawiedliwiona nieobecność na dyżurze",
        _PKT.BRAK_DYZURU,
        klucz + " (auto po oknie odbicia)",
        "SYSTEM",
        "System"
      ]);
      przeliczPunktyUzytkownika(uid);
      naliczone++;

      // >>> NOWE: push NATYCHMIAST po naliczeniu auto-minusa.
      //     Dociera nawet gdy apka jest zamknięta.
      try {
        var _newPD = 0;
        try {
          var _shKD = ss.getSheetByName("Kandydaci");
          if (_shKD) {
            var _dKD = _shKD.getDataRange().getValues();
            for (var _kd = 1; _kd < _dKD.length; _kd++) {
              if (String(_dKD[_kd][0] || "").trim() === uid) {
                _newPD = parseInt(_dKD[_kd][2], 10) || 0;
                break;
              }
            }
          }
        } catch (ePD) {}

        var _godzD = (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
        var _dataD = Utilities.formatDate(wyst, tz, "dd.MM.yyyy");
        var _tytD = "Kara punktowa za dyżur";
        var _trD = "Nie odnotowano obecności na dyżurze " + _dataD + " o " + _godzD +
                   ". " + _PKT.BRAK_DYZURU + " pkt. Nowa suma: " + _newPD + " pkt.";
        if (typeof _pushNatychmiast === "function") {
          _pushNatychmiast(
            uid, "📉", _tytD, _trD, "points", "page-profile",
            "points_loss_auto_" + uid + "_" + Date.now()
          );
        }
      } catch (ePushDyz) {}

      // Duplikat push usunięty — blok _pushNatychmiast powyżej już to robi
      // (zapisuje też klucz do Powiadomienia_wyslane).
    }

    return { sukces: true, naliczone: naliczone };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * Nadrabia WSZYSTKIE zaległe auto-minusy za dyżury (domyślnie rok wstecz).
 * Uruchom RĘCZNIE raz z edytora Apps Script, żeby naliczyć minusy za dyżury,
 * których trigger nie zdążył obsłużyć (np. projekt był wyłączony / trigger
 * nie działał przez długi czas).
 * Idempotentne: druga iteracja nie doda duplikatów (klucz w kolumnie Opis).
 */
function nadrobZalegleAutoMinusy() {
  return naliczMinusyZaOpuszczoneDyzury(365);
}

/**
 * Automat −12 za nieobecność na uroczystości (dzień po, jeśli brak logu i brak wniosku).
 */
/**
 * Auto-minus za nieobecność na uroczystości.
 *
 * ZASADY:
 *   1. Minus nalicza się TYLKO osobie, która w arkuszu Dostepnosc
 *      zaznaczyła "dostepny" na tę uroczystość i NIE odbiła karty.
 *      Brak odpowiedzi lub "niedostepny" → brak minusa.
 *   2. Minus nalicza się od razu po zamknięciu okna odbicia:
 *      - tydzień (pon-pt):     start + 1h
 *      - niedziela + sob 18:00: start + 1h 15min
 *   3. Idempotencja: klucz "AUTO_MINUS_UROCZYSTOSC|YYYY-MM-DD|nazwa"
 *      zapisany w kolumnie Opis — drugie uruchomienie pominie.
 *
 * Trigger: co 15 minut (patrz zainstalujTriggeryPunktow).
 */
function _koniecOknaOdbiciaUroczystosci(start) {
  var dzien = start.getDay(); // 0=Nd, 6=Sb
  var godz = start.getHours();
  var czyNiedzielne = (dzien === 0) || (dzien === 6 && godz === 18);
  var poMin = czyNiedzielne ? 75 : 60;
  return new Date(start.getTime() + poMin * 60 * 1000);
}

function naliczMinusyZaOpuszczoneUroczystosci() {
  // >>> WYCOFANE: minusy za nieobecność na uroczystościach zostały wyłączone.
  //     (decyzja administratora — patrz cofnijWszystkieMinusyZaUroczystosci().)
  return { sukces: true, naliczone: 0, wiadomosc: "Auto-minusy za uroczystości wycofane." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetK = ss.getSheetByName("Kalendarz");
    if (!sheetK) return { sukces: false, wiadomosc: "Brak arkusza Kalendarz" };

    var tz = _APP_TZ;
    var teraz = new Date();
    var terazMs = teraz.getTime();
    // Sprawdzamy uroczystości z ostatnich 24h — każda ma swoje okno odbicia
    var oknoHist = 24 * 3600 * 1000;

    var daneK = sheetK.getDataRange().getValues();
    var uroczystosci = [];
    for (var i = 1; i < daneK.length; i++) {
      if (!daneK[i][0]) continue;
      var dt = daneK[i][0] instanceof Date ? daneK[i][0] : new Date(daneK[i][0]);
      if (isNaN(dt.getTime())) continue;
      var ts = dt.getTime();
      if (ts > terazMs || ts < terazMs - oknoHist) continue;

      var nazwa = String(daneK[i][1] || "").trim();
      var pkt = parseInt(daneK[i][2], 10) || 0;
      var low = nazwa.toLowerCase();
      var jestUrocz = low.indexOf("uroczyst") >= 0
                   || low.indexOf("triduum") >= 0
                   || low.indexOf("wielka sobota") >= 0
                   || low.indexOf("wniebow") >= 0
                   || low.indexOf("boże") >= 0
                   || low.indexOf("boze") >= 0
                   || pkt >= 10;
      if (!jestUrocz) continue;

      var koniecOkna = _koniecOknaOdbiciaUroczystosci(dt);
      // Ruszamy dopiero gdy okno się ZAKOŃCZYŁO
      if (terazMs < koniecOkna.getTime()) continue;

      uroczystosci.push({ ts: ts, dt: dt, nazwa: nazwa, koniecOkna: koniecOkna });
    }

    if (!uroczystosci.length) return { sukces: true, naliczone: 0 };

    // Odpowiedzi z arkusza Dostepnosc (klucz: "dost_<ts>")
    var odpowiedzi = {};
    var shD = ss.getSheetByName("Dostepnosc");
    if (shD && shD.getLastRow() > 1) {
      var dD = shD.getDataRange().getValues();
      for (var r = 1; r < dD.length; r++) {
        var dts = dD[r][0] instanceof Date ? dD[r][0] : new Date(dD[r][0]);
        var idU = String(dD[r][1] || "").trim();
        var klucz = String(dD[r][3] || "").trim();
        var odp = String(dD[r][4] || "").trim().toLowerCase();
        if (!klucz || !idU) continue;
        if (!odpowiedzi[klucz]) odpowiedzi[klucz] = {};
        if (!odpowiedzi[klucz][idU]) odpowiedzi[klucz][idU] = [];
        odpowiedzi[klucz][idU].push({
          odpowiedz: odp,
          ts: isNaN(dts.getTime()) ? 0 : dts.getTime()
        });
      }
    }

    // Logi obecności (RFID/QR) — czytnik
    var sheetLogi = ss.getSheetByName("Logi_czytnik");
    var logi = (sheetLogi && sheetLogi.getLastRow() > 1) ? sheetLogi.getDataRange().getValues() : [];

    // Logi_ręczne — tu dopisujemy minusy; potrzebne też do idempotencji
    var sheetReczne = ss.getSheetByName("Logi_ręczne");
    if (!sheetReczne) {
      sheetReczne = ss.insertSheet("Logi_ręczne");
      sheetReczne.appendRow(["Data","ID","Wydarzenie","Punkty","Opis","Wykonawca ID","Wykonawca Imię"]);
    }
    var reczne = sheetReczne.getDataRange().getValues();

    var sheetKand = ss.getSheetByName("Kandydaci");
    if (!sheetKand) return { sukces: false, wiadomosc: "Brak arkusza Kandydaci" };
    var kand = sheetKand.getDataRange().getValues();

    var naliczone = 0;

    uroczystosci.forEach(function(u) {
      var klucz = "dost_" + u.ts;
      var mapaOdp = odpowiedzi[klucz] || {};
      var oknoStart = u.dt.getTime() - 30 * 60 * 1000;
      var oknoEnd = u.koniecOkna.getTime();

      for (var i = 1; i < kand.length; i++) {
        var uid = String(kand[i][0] || "").trim();
        if (!uid) continue;
        var ranga = String(kand[i][6] || "").toLowerCase();
        if (ranga.indexOf("ksi") === 0) continue; // księża bez minusów

        // --- Warunek 1: zaznaczył "dostepny" ---
        var wpisy = mapaOdp[uid];
        if (!wpisy || !wpisy.length) continue;
        wpisy.sort(function(a,b){ return b.ts - a.ts; });
        if (wpisy[0].odpowiedz !== "dostepny") continue;

        // Konto istniało w dniu uroczystości
        if (typeof _kontoIstnialoWDniu === "function" && !_kontoIstnialoWDniu(uid, u.dt)) continue;

        // --- Warunek 2: brak logu obecności w oknie ---
        var byl = false;
        for (var lr = 1; lr < logi.length; lr++) {
          if (String(logi[lr][1] || "").trim() !== uid) continue;
          var ld = logi[lr][0] instanceof Date ? logi[lr][0] : new Date(logi[lr][0]);
          if (isNaN(ld.getTime())) continue;
          var lts = ld.getTime();
          if (lts >= oknoStart && lts <= oknoEnd) { byl = true; break; }
        }
        if (byl) continue;

        // --- Idempotencja: czy już mamy minus za tę uroczystość? ---
        var kluczWpisu = "AUTO_MINUS_UROCZYSTOSC|" +
          Utilities.formatDate(u.dt, tz, "yyyy-MM-dd") + "|" + u.nazwa;
        var juzJest = false;
        for (var rr = 1; rr < reczne.length; rr++) {
          if (String(reczne[rr][1] || "").trim() !== uid) continue;
          var opisR = String(reczne[rr][4] || "");
          if (opisR.indexOf(kluczWpisu) >= 0) { juzJest = true; break; }
        }
        if (juzJest) continue;

        // Nalicz minus
        sheetReczne.appendRow([
          new Date(),
          uid,
          "Nieusprawiedliwiona nieobecność na uroczystości",
          _PKT.BRAK_UROCZYSTOSCI,
          kluczWpisu + " (zaznaczył dostępność, brak odbicia)",
          "SYSTEM",
          "System"
        ]);
        przeliczPunktyUzytkownika(uid);
        naliczone++;
      }
    });

    return { sukces: true, naliczone: naliczone };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * Usuwa WSZYSTKIE automatyczne minusy za nieobecność na uroczystościach
 * z arkusza Logi_ręczne (wpisy z kluczem AUTO_MINUS_UROCZYSTOSC|...).
 * Przelicza punkty każdej dotkniętej osoby. Idempotentne.
 * Uruchom RĘCZNIE raz z edytora Apps Script.
 */
function cofnijWszystkieMinusyZaUroczystosci() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Logi_ręczne");
    if (!sheet || sheet.getLastRow() < 2) {
      return { sukces: true, cofnieto: 0, wiadomosc: "Brak logów do czyszczenia." };
    }
    var dane = sheet.getDataRange().getValues();
    var doUsuniecia = [];
    var affected = {};
    for (var i = dane.length - 1; i >= 1; i--) {
      var opis = String(dane[i][4] || "");
      if (opis.indexOf("AUTO_MINUS_UROCZYSTOSC|") >= 0) {
        doUsuniecia.push(i + 1);
        var uid = String(dane[i][1] || "").trim();
        if (uid) affected[uid] = true;
      }
    }
    doUsuniecia.sort(function(a, b) { return b - a; });
    doUsuniecia.forEach(function(row) {
      try { sheet.deleteRow(row); } catch (e) {}
    });
    Object.keys(affected).forEach(function(uid) {
      try { przeliczPunktyUzytkownika(uid); } catch (e) {}
    });
    try { _logAdmin("SYSTEM", "", "COFNIJ_MINUSY_UROCZYSTOSCI", "", "usunieto=" + doUsuniecia.length + " osob=" + Object.keys(affected).length); } catch (e) {}
    return {
      sukces: true,
      cofnieto: doUsuniecia.length,
      osob: Object.keys(affected).length,
      wiadomosc: "Cofnięto " + doUsuniecia.length + " minusów za uroczystości (" + Object.keys(affected).length + " osób)."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * RĘCZNE narzędzie: usuwa wszystkie auto-minusy za dyżur z Logi_ręczne,
 * dla których istnieje ZAAKCEPTOWANY wniosek o nieobecność.
 * Uruchom RĘCZNIE raz z edytora Apps Script. Idempotentne.
 */
function cofnijAutoMinusyZaDyzur() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    if (!sheetN || sheetN.getLastRow() < 2) {
      return { sukces: true, cofnieto: 0, wiadomosc: "Brak wniosków." };
    }
    var nieob = sheetN.getDataRange().getValues();
    var mapa = {}; // uid -> { dzien -> [godziny...] }
    for (var i = 1; i < nieob.length; i++) {
      var uid = String(nieob[i][1] || "").trim();
      if (!uid) continue;
      var st = String(nieob[i][6] || "").toLowerCase();
      if (st.indexOf("akcept") < 0 && st.indexOf("accept") < 0) continue;
      var dKey = _parsujDateNieobecnosci(nieob[i][3]);
      if (!dKey) continue;
      if (!mapa[uid]) mapa[uid] = {};
      if (!mapa[uid][dKey]) mapa[uid][dKey] = true;
    }
    var cofnieto = 0;
    var osob = {};
    Object.keys(mapa).forEach(function(u) {
      Object.keys(mapa[u]).forEach(function(dz) {
        var n = _usunAutoMinusDyzurZaDzien(u, dz, "");
        if (n > 0) { cofnieto += n; osob[u] = true; }
      });
    });
    try { _logAdmin("SYSTEM", "", "COFNIJ_AUTO_MINUSY_DYZUR", "",
                    "usunieto=" + cofnieto + " osob=" + Object.keys(osob).length); } catch (eL) {}
    return {
      sukces: true,
      cofnieto: cofnieto,
      osob: Object.keys(osob).length,
      wiadomosc: "Cofnięto " + cofnieto + " auto-minusów za dyżury (" +
                 Object.keys(osob).length + " osób)."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * RĘCZNE narzędzie: usuwa wszystkie auto-minusy za dyżur z Logi_ręczne,
 * dla których istnieje ZAAKCEPTOWANY wniosek o nieobecność.
 * Uruchom RĘCZNIE raz z edytora Apps Script. Idempotentne.
 */
function cofnijAutoMinusyZaDyzur() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    if (!sheetN || sheetN.getLastRow() < 2) {
      return { sukces: true, cofnieto: 0, wiadomosc: "Brak wniosków." };
    }
    var nieob = sheetN.getDataRange().getValues();
    var mapa = {}; // uid -> { dzien: true }
    for (var i = 1; i < nieob.length; i++) {
      var uid = String(nieob[i][1] || "").trim();
      if (!uid) continue;
      var st = String(nieob[i][6] || "").toLowerCase();
      if (st.indexOf("akcept") < 0 && st.indexOf("accept") < 0) continue;
      var dKey = _parsujDateNieobecnosci(nieob[i][3]);
      if (!dKey) continue;
      if (!mapa[uid]) mapa[uid] = {};
      mapa[uid][dKey] = true;
    }
    var cofnieto = 0;
    var osob = {};
    Object.keys(mapa).forEach(function(u) {
      Object.keys(mapa[u]).forEach(function(dz) {
        var n = _usunAutoMinusDyzurZaDzien(u, dz, "");
        if (n > 0) { cofnieto += n; osob[u] = true; }
      });
    });
    try { _logAdmin("SYSTEM", "", "COFNIJ_AUTO_MINUSY_DYZUR", "",
                    "usunieto=" + cofnieto + " osob=" + Object.keys(osob).length); } catch (eL) {}
    return {
      sukces: true,
      cofnieto: cofnieto,
      osob: Object.keys(osob).length,
      wiadomosc: "Cofnięto " + cofnieto + " auto-minusów (" +
                 Object.keys(osob).length + " osób)."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * Diagnostyka: uruchom RĘCZNIE diagnozujWnioskiNieobecnosci("")
 * Wypisuje do Logs co parser wyciąga z każdego wiersza arkusza.
 */
function diagnozujWnioskiNieobecnosci(userId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
  if (!sheetN || sheetN.getLastRow() < 2) { Logger.log("Brak arkusza."); return; }
  var uidFilter = String(userId || "").trim();
  var dane = sheetN.getDataRange().getValues();
  Logger.log("=== Diagnostyka wniosków ===");
  for (var i = 1; i < dane.length; i++) {
    var uid = String(dane[i][1] || "").trim();
    if (uidFilter && uid !== uidFilter) continue;
    Logger.log("wiersz=" + (i + 1) + " uid=" + uid +
               " rawD=[" + String(dane[i][3]) + "] → dKey=[" +
               _parsujDateNieobecnosci(dane[i][3]) +
               "] status=[" + String(dane[i][6] || "").trim() + "]");
  }
  Logger.log("=== Koniec ===");
}

// FIXC_COFNIJ_HELPER

/** RĘCZNIE: usuwa auto-minusy za dyżur, na które są zaakceptowane wnioski. */
function cofnijAutoMinusyZaDyzur() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    if (!sheetN || sheetN.getLastRow() < 2) {
      return { sukces: true, cofnieto: 0, wiadomosc: "Brak wniosków." };
    }
    var nieob = sheetN.getDataRange().getValues();
    var mapa = {};
    for (var i = 1; i < nieob.length; i++) {
      var uid = String(nieob[i][1] || "").trim();
      if (!uid) continue;
      var st = String(nieob[i][6] || "").toLowerCase();
      if (st.indexOf("akcept") < 0 && st.indexOf("accept") < 0) continue;
      var dKey = _parsujDateNieobecnosci(nieob[i][3]);
      if (!dKey) continue;
      if (!mapa[uid]) mapa[uid] = {};
      mapa[uid][dKey] = true;
    }
    var cofnieto = 0, osob = {};
    Object.keys(mapa).forEach(function(u) {
      Object.keys(mapa[u]).forEach(function(dz) {
        var n = _usunAutoMinusDyzurZaDzien(u, dz, "");
        if (n > 0) { cofnieto += n; osob[u] = true; }
      });
    });
    try { _logAdmin("SYSTEM", "", "COFNIJ_AUTO_MINUSY_DYZUR", "",
                    "usunieto=" + cofnieto + " osob=" + Object.keys(osob).length); } catch (eL) {}
    return { sukces: true, cofnieto: cofnieto, osob: Object.keys(osob).length,
             wiadomosc: "Cofnięto " + cofnieto + " auto-minusów (" + Object.keys(osob).length + " osób)." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/** Diagnostyka parsera: diagnozujWnioskiNieobecnosci("") */
function diagnozujWnioskiNieobecnosci(userId) {
  var sheetN = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Nieobecnosci_dyzur");
  if (!sheetN || sheetN.getLastRow() < 2) { Logger.log("Brak arkusza."); return; }
  var uidFilter = String(userId || "").trim();
  var dane = sheetN.getDataRange().getValues();
  Logger.log("=== Diagnostyka wniosków ===");
  for (var i = 1; i < dane.length; i++) {
    var uid = String(dane[i][1] || "").trim();
    if (uidFilter && uid !== uidFilter) continue;
    Logger.log("wiersz=" + (i + 1) + " uid=" + uid +
               " rawD=[" + String(dane[i][3]) + "] → dKey=[" +
               _parsujDateNieobecnosci(dane[i][3]) +
               "] status=[" + String(dane[i][6] || "").trim() + "]");
  }
  Logger.log("=== Koniec ===");
}

/** Instalacja triggerów czasowych (uruchom raz ręcznie z edytora). */
function zainstalujTriggeryPunktow() {
  var doUsuniecia = ["naliczMinusyZaOpuszczoneDyzury",
                     "naliczMinusyZaOpuszczoneUroczystosci",
                     "wyslijPrzypomnieniaDyzuryServer"];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (doUsuniecia.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Dyżury: co 15 minut — minus pojawia się OD RAZU po zamknięciu okna odbicia
  // (start + 1h).
  ScriptApp.newTrigger("naliczMinusyZaOpuszczoneDyzury")
    .timeBased().everyMinutes(15).create();

  // >>> WYCOFANE: auto-minusy za uroczystości (nie instalujemy triggera).

  // Serwerowe przypomnienia push o dyżurach:
  //  - dzień wcześniej między 20:00 a 20:29
  //  - między 2h a 2h29m przed startem
  ScriptApp.newTrigger("wyslijPrzypomnieniaDyzuryServer")
    .timeBased().everyMinutes(15).create();

  return "Zainstalowano: dyżury (co 15 min) + przypomnienia push (co 15 min).";
}

function zapiszUstawieniaUsera(userId, motyw) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Ustawienia_uzytkownikow");
    if (!sheet) {
      sheet = ss.insertSheet("Ustawienia_uzytkownikow");
      sheet.appendRow(["UserID", "Motyw", "OstatniaAktywnosc"]);
    }
    var dane = sheet.getDataRange().getValues();
    var targetId = String(userId).trim();
    var teraz = new Date();
    try { CacheService.getScriptCache().remove("ust_" + targetId); } catch (eC) {}
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === targetId) {
        sheet.getRange(i + 1, 2).setValue(String(motyw).trim());
        sheet.getRange(i + 1, 3).setValue(teraz);
        return { sukces: true };
      }
    }
    sheet.appendRow([targetId, String(motyw).trim(), teraz]);
    return { sukces: true };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getUstawieniaUsera(userId) {
  var _uid = String(userId || "").trim();
  if (!_uid) return { motyw: "light" };
  try {
    var c = CacheService.getScriptCache();
    var key = "ust_" + _uid;
    var hit = c.get(key);
    if (hit) {
      try { return JSON.parse(hit); } catch (eJ) {}
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Ustawienia_uzytkownikow");
    if (!sheet) { c.put(key, '{"motyw":"light"}', 300); return { motyw: "light" }; }
    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === _uid) {
        var motyw = String(dane[i][1] || "light").trim();
        var wynik = { motyw: (motyw === "dark" ? "dark" : "light") };
        try { c.put(key, JSON.stringify(wynik), 300); } catch (eP) {}
        return wynik;
      }
    }
    var def = { motyw: "light" };
    try { c.put(key, JSON.stringify(def), 300); } catch (eP2) {}
    return def;
  } catch (e) {
    return { motyw: "light" };
  }
}

// ----------------------------------------------------------------------
// SESJE URZĄDZEŃ ("Zapamiętaj mnie" — 30 dni)
// Arkusz: Sesje_urzadzen | DeviceID | UserID | Token | Imie | Rola | DataWaznosci
// ----------------------------------------------------------------------

function zapiszSesjeUrzadzenia(deviceId, userId, token, imie, rola) {
  // >>> FIX: LockService — dwa rownolegle logowania (np. autologin +
  // reczne klikanie) mogly jednoczesnie nie znalezc wiersza i DOPISAC
  // dwa wiersze dla tego samego urzadzenia. Potem weryfikujSesjeUrzadzenia
  // trafialo na pierwszy-lepszy — i "Zapamietaj mnie" dzialalo losowo.
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try { gotLock = lock.tryLock(8000); } catch (eL) {}
  if (!gotLock) return { sukces: false, wiadomosc: "Serwer zajety — sprobuj ponownie." };

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Sesje_urzadzen");
    if (!sheet) {
      sheet = ss.insertSheet("Sesje_urzadzen");
      sheet.appendRow(["DeviceID", "UserID", "Token", "Imie", "Rola", "DataWaznosci"]);
    }
    var dev = String(deviceId).trim();
    var dataWaznosci = new Date();
    dataWaznosci.setDate(dataWaznosci.getDate() + 30);

    var dane = sheet.getDataRange().getValues();
    var znaleziony = -1;
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === dev) {
        if (znaleziony === -1) znaleziony = i;
        // ewentualne duplikaty (z dawnych czasow) — skasuj od konca
      }
    }
    if (znaleziony !== -1) {
      sheet.getRange(znaleziony + 1, 1, 1, 6).setValues([[
        dev,
        String(userId).trim(),
        String(token).trim(),
        String(imie || "").trim(),
        String(rola).trim(),
        dataWaznosci
      ]]);
      // Usuń ewentualne duplikaty (starsze)
      for (var j = dane.length - 1; j > znaleziony; j--) {
        if (String(dane[j][0]).trim() === dev) sheet.deleteRow(j + 1);
      }
      return { sukces: true };
    }
    sheet.appendRow([dev, String(userId).trim(), String(token).trim(), String(imie || "").trim(), String(rola).trim(), dataWaznosci]);
    return { sukces: true };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  } finally {
    if (gotLock) { try { lock.releaseLock(); } catch (eR) {} }
  }
}

function weryfikujSesjeUrzadzenia(deviceId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Sesje_urzadzen");
    if (!sheet) return { sukces: false };
    var dane = sheet.getDataRange().getValues();
    var deviceId = String(deviceId).trim();
    var teraz = new Date();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === deviceId) {
        var dataWaznosci = new Date(dane[i][5]);
        if (isNaN(dataWaznosci.getTime()) || dataWaznosci < teraz) {
          // Wygasła — usuń wiersz
          sheet.deleteRow(i + 1);
          return { sukces: false };
        }
        var userId = String(dane[i][1]).trim();
        // >>> DRUGIE ID: sesja mogła być zapisana pod drugim ID —
        //     rozwiąż do ID głównego na wypadek starych wpisów.
        try {
          var _resolved = _resolvePrimaryId(userId);
          if (_resolved) userId = _resolved;
        } catch (eR2) {}
        var token = String(dane[i][2]).trim();
        var imie = String(dane[i][3] || "").trim();
        var rola = String(dane[i][4]).trim();
        // Odśwież datę ważności o kolejne 30 dni przy każdym użyciu
        var nowaData = new Date();
        nowaData.setDate(nowaData.getDate() + 30);
        sheet.getRange(i + 1, 6).setValue(nowaData);
        // Pobierz motyw
        var ustawienia = getUstawieniaUsera(userId);
        return { sukces: true, userId: userId, token: token, imie: imie, rola: rola, theme: ustawienia.motyw };
      }
    }
    return { sukces: false };
  } catch(e) {
    return { sukces: false };
  }
}

function usunSesjeUrzadzenia(deviceId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Sesje_urzadzen");
    if (!sheet) return;
    var dane = sheet.getDataRange().getValues();
    var deviceId = String(deviceId).trim();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === deviceId) {
        sheet.deleteRow(i + 1);
        return;
      }
    }
  } catch(e) {}
}

// ----------------------------------------------------------------------
// AUTORYZACJA I ZARZĄDZANIE HASŁAMI
// ----------------------------------------------------------------------
//
// Hasła NIE są przechowywane jawnym tekstem. Zapisujemy tylko:
//   - losową sól (per użytkownik)
//   - hash = wielokrotny MD5(sól + hasło), nie da się odwrócić do hasła.
// Format zapisany w arkuszu (kolumna C "Hasło"): "sol$hash"
// Dzięki temu admin/programista/ktokolwiek z dostępem do arkusza NIE JEST
// w stanie odczytać ustawionego hasła — może je jedynie zresetować/nadpisać
// nowym (i to nowe też zostanie natychmiast zahaszowane).
// ----------------------------------------------------------------------

var _HASH_ITERACJE = 500; // spowalnia brute-force krótkich (np. 4-cyfrowych) haseł

/** Losowa sól (16 bajtów zakodowane w hex). */
function _generujSol() {
  var bajty = [];
  for (var i = 0; i < 16; i++) bajty.push(Math.floor(Math.random() * 256));
  return bajty.map(function(b) {
    var h = b.toString(16);
    return h.length === 1 ? "0" + h : h;
  }).join("");
}

/** Liczy MD5 w hex z podanego stringa. */
function _md5Hex(tekst) {
  var bajty = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, tekst, Utilities.Charset.UTF_8);
  return bajty.map(function(b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

/** Hashuje hasło z solą, z wieloma iteracjami (spowolnienie brute-force). */
function _hashHaslo(haslo, sol) {
  var wynik = String(sol) + String(haslo);
  for (var i = 0; i < _HASH_ITERACJE; i++) {
    wynik = _md5Hex(wynik);
  }
  return wynik;
}

/** Tworzy nowy zapis "sol$hash" dla podanego hasła — do zapisania w arkuszu. */
function _utworzZapisHasla(haslo) {
  var sol = _generujSol();
  var hash = _hashHaslo(haslo, sol);
  return sol + "$" + hash;
}

/**
 * Sprawdza podane hasło względem zapisu z arkusza.
 * Obsługuje też format przejściowy (stare, jawne hasło bez "$") —
 * jeśli trafi na taki wpis, uzna go za poprawny WYŁĄCZNIE gdy zgadza się
 * jeden-do-jednego, a wywołujący powinien od razu nadpisać go nowym hashem
 * (patrz weryfikujLogowanie / checkinPrzezQr).
 */
function _sprawdzHaslo(podaneHaslo, zapisZArkusza) {
  var zapis = String(zapisZArkusza == null ? "" : zapisZArkusza);
  var idx = zapis.indexOf("$");
  if (idx === -1) {
    // Stary, niezahaszowany zapis (migracja w toku / jeszcze nie zmigrowany).
    return { ok: zapis.trim() === String(podaneHaslo).trim(), legacy: true };
  }
  var sol = zapis.substring(0, idx);
  var hash = zapis.substring(idx + 1);
  var liczony = _hashHaslo(podaneHaslo, sol);
  return { ok: liczony === hash, legacy: false };
}

/**
 * Jednorazowa migracja: przechodzi po arkuszu "Hasła" i dla każdego wpisu,
 * który wciąż jest jawnym tekstem (bez "$"), generuje sól + hash i nadpisuje
 * komórkę. Po uruchomieniu tej funkcji administrator (Ty) NIE będzie już
 * w stanie odczytać żadnego z tych haseł z arkusza — zostają tylko hashe.
 *
 * Uruchom RĘCZNIE raz z edytora Apps Script (wybierz funkcję z listy i Run).
 * Bezpieczna do wielokrotnego uruchomienia — pomija wpisy już zahaszowane.
 */
function migrujHasłaDoHash() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetHasla = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
  if (!sheetHasla) return "Brak arkusza 'Hasła'.";

  var dane = sheetHasla.getDataRange().getValues();
  var zmigrowano = 0;
  for (var i = 1; i < dane.length; i++) {
    var zapis = String(dane[i][2] == null ? "" : dane[i][2]);
    if (!zapis || zapis.indexOf("$") !== -1) continue; // pusty lub już zahaszowany
    dane[i][2] = _utworzZapisHasla(zapis);
    zmigrowano++;
  }
  // Jeden zapis całej tablicy naraz (zamiast setValue per wiersz) — dużo szybsze.
  if (zmigrowano > 0) {
    sheetHasla.getRange(1, 1, dane.length, dane[0].length).setValues(dane);
  }
  var podsumowanie = "Zmigrowano " + zmigrowano + " haseł do postaci zahaszowanej.";
  Logger.log(podsumowanie);
  return podsumowanie;
}

// ======================================================================
// BLOKADA LOGOWANIA — licznik nieudanych prób
//   PropertiesService: login_attempts_<ID> = {count, level, lockedUntil, permanent}
//   Level 0: 3 złe  → blokada 60 s
//   Level 1: 3 złe  → blokada 300 s
//   Level 2: 1 złe  → blokada permanentna
// Po poprawnym logowaniu licznik jest zerowany.
// ======================================================================
function _getLoginAttempts(userId) {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty("login_attempts_" + userId);
    if (!raw) return { count: 0, level: 0, lockedUntil: 0, permanent: false, lastFailTs: 0 };
    var d = JSON.parse(raw);
    return {
      count: parseInt(d.count) || 0,
      level: parseInt(d.level) || 0,
      lockedUntil: parseInt(d.lockedUntil) || 0,
      permanent: !!d.permanent,
      lastFailTs: parseInt(d.lastFailTs) || 0
    };
  } catch (e) {
    return { count: 0, level: 0, lockedUntil: 0, permanent: false, lastFailTs: 0 };
  }
}

function _saveLoginAttempts(userId, data) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      "login_attempts_" + userId, JSON.stringify(data)
    );
  } catch (e) {}
}

function _sprawdzBlokadeLogowania(userId) {
  var a = _getLoginAttempts(userId);
  var teraz = Date.now();

  // NOWE: automatyczny reset progresji po okresie ciszy (domyślnie 24h).
  // Patrz komentarz w drugiej kopii tej funkcji.
  try {
    var DECAY_MS = 24 * 3600 * 1000;
    if (!a.permanent && a.lastFailTs && (teraz - a.lastFailTs) > DECAY_MS) {
      _resetBlokadyLogowania(userId);
      return { zablokowane: false, autoReset: true };
    }
  } catch (eDecay) {}

  if (a.permanent) {
    return { zablokowane: true, permanentna: true, pozostaloSek: 0 };
  }
  if (a.lockedUntil && a.lockedUntil > teraz) {
    return {
      zablokowane: true,
      permanentna: false,
      pozostaloSek: Math.ceil((a.lockedUntil - teraz) / 1000)
    };
  }
  // Blokada czasowa minęła — pozwól próbować dalej (level zostaje)
  if (a.lockedUntil && a.lockedUntil <= teraz) {
    a.lockedUntil = 0;
    a.count = 0;
    _saveLoginAttempts(userId, a);
  }
  return { zablokowane: false };
}

function _liczbaSlownie(n) {
  var slowa = ["zero", "jedną", "dwie", "trzy", "cztery", "pięć", "sześć", "siedem", "osiem", "dziewięć", "dziesięć"];
  return slowa[n] || String(n);
}

function _formaProba(n) {
  if (n === 1) return "próbę";
  if (n >= 2 && n <= 4) return "próby";
  return "prób";
}

function _zarejestrujNieudaneLogowanie(userId) {
  var a = _getLoginAttempts(userId);
  a.count = (parseInt(a.count) || 0) + 1;
  var teraz = Date.now();
  // Zapisz moment ostatniej nieudanej próby — używane przez _sprawdzBlokadeLogowania
  // do automatycznego resetu progresji po okresie ciszy (DECAY_MS).
  a.lastFailTs = teraz;

  // Progi blokady:
  //   level 0 → po 5 złych hasłach: blokada 1 minuta
  //   level 1 → po 3 złych hasłach: blokada 5 minut
  //   level 2 → po 1 złym haśle:    blokada permanentna
  var maxNaPoziomie = (a.level === 0) ? 5 : ((a.level === 1) ? 3 : 1);
  var blokadaSek     = (a.level === 0) ? 60 : ((a.level === 1) ? 300 : 0);
  var blokadaOpis    = (a.level === 0) ? "1 minutę" : ((a.level === 1) ? "5 minut" : "trwałą blokadę");

  if (a.count >= maxNaPoziomie) {
    if (a.level >= 2) {
      a.permanent = true;
      a.lockedUntil = 0;
      a.count = 0;
      _saveLoginAttempts(userId, a);
      return {
        zablokowane: true, permanentna: true, pozostaloSek: 0,
        wiadomosc: "Konto zostało trwale zablokowane. Skontaktuj się z administracją w celu odblokowania."
      };
    }
    a.level++;
    a.count = 0;
    a.lockedUntil = teraz + blokadaSek * 1000;
    _saveLoginAttempts(userId, a);
    return {
      zablokowane: true, permanentna: false, pozostaloSek: blokadaSek,
      wiadomosc: "Zbyt wiele błędnych prób — konto zablokowane na " + blokadaOpis + "."
    };
  }

  _saveLoginAttempts(userId, a);

  // Pozostało jeszcze X prób na bieżącym poziomie
  var pozostalo = maxNaPoziomie - a.count;
  var czasownik = (pozostalo === 1) ? "Pozostała" : "Pozostały";
  var ostrzezenie = czasownik + " " + _liczbaSlownie(pozostalo) + " " +
                    _formaProba(pozostalo) + " do blokady na " + blokadaOpis + ".";

  return {
    zablokowane: false,
    pozostalo: pozostalo,
    ostrzezenie: ostrzezenie
  };
}

function _resetBlokadyLogowania(userId) {
  try {
    PropertiesService.getScriptProperties().deleteProperty("login_attempts_" + userId);
  } catch (e) {}
}

// ======================================================================
// ADMIN: lista zablokowanych kont + odblokowanie z nowym hasłem
// ======================================================================
function getListaZablokowanychKont(wykonawcaId) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") return { sukces: false, lista: [], wiadomosc: "Tylko administrator." };

    var props = PropertiesService.getScriptProperties();
    var keys = props.getKeys();
    var teraz = Date.now();

    var mapaImion = {};
    try {
      var shK = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Kandydaci");
      if (shK && shK.getLastRow() > 1) {
        var dk = shK.getDataRange().getValues();
        for (var i = 1; i < dk.length; i++) {
          mapaImion[_normId(dk[i][0])] = String(dk[i][1] || "").trim();
        }
      }
    } catch (eM) {}

    var lista = [];
    keys.forEach(function(k) {
      if (k.indexOf("login_attempts_") !== 0) return;
      var id = k.substring("login_attempts_".length);
      var raw = props.getProperty(k);
      if (!raw) return;
      try {
        var d = JSON.parse(raw);
        var perm = !!d.permanent;
        var lockedUntil = parseInt(d.lockedUntil) || 0;
        var tymczasowa = lockedUntil > teraz;
        if (!perm && !tymczasowa) return;
        lista.push({
          userId: id,
          imie: mapaImion[id] || id,
          permanentna: perm,
          tymczasowa: tymczasowa,
          pozostaloSek: tymczasowa ? Math.ceil((lockedUntil - teraz) / 1000) : 0,
          lockedUntil: lockedUntil,
          level: parseInt(d.level) || 0
        });
      } catch (e) {}
    });

    lista.sort(function(a, b) {
      if (a.permanentna !== b.permanentna) return a.permanentna ? -1 : 1;
      return a.pozostaloSek - b.pozostaloSek;
    });
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: String(e.message || e) };
  }
}

function odblokujKontoUzytkownika(wykonawcaId, targetUserId) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Tylko administrator może odblokować konto." };

    var target = _normId(targetUserId);
    if (!target) return { sukces: false, wiadomosc: "Brak ID użytkownika." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetH = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetH) return { sukces: false, wiadomosc: "Brak arkusza Hasła." };

    var noweHaslo = String(1000 + Math.floor(Math.random() * 9000));
    var dane = sheetH.getDataRange().getValues();
    var znaleziono = false;
    var imie = target;
    for (var i = 1; i < dane.length; i++) {
      if (_normId(dane[i][0]) === target) {
        imie = String(dane[i][1] || "").trim() || target;
        sheetH.getRange(i + 1, 3).setValue(_utworzZapisHasla(noweHaslo));
        sheetH.getRange(i + 1, 4).setValue(false); // wymaga zmiany przy 1. logowaniu
        znaleziono = true;
        break;
      }
    }
    if (!znaleziono) return { sukces: false, wiadomosc: "Nie znaleziono użytkownika ID " + target + "." };

    _resetBlokadyLogowania(target);

    try { _logAdmin(uid, "", "ODBLOKUJ_KONTO", target, "nowe hasło tymczasowe"); } catch (e) {}

    return {
      sukces: true,
      userId: target,
      imie: imie,
      hasloTymczasowe: noweHaslo,
      wiadomosc: "Konto odblokowane. Nowe hasło tymczasowe: " + noweHaslo
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

// ======================================================================
// BLOKADA LOGOWANIA — 5 / 3 / 1 prób
//   level 0: 5 złych → blokada 1 minuta
//   level 1: 3 złe   → blokada 5 minut
//   level 2: 1 zła   → blokada trwała
// ======================================================================
function _getLoginAttempts(userId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty("login_attempts_" + userId);
    if (!raw) return { count: 0, level: 0, lockedUntil: 0, permanent: false, lastFailTs: 0 };
    var d = JSON.parse(raw);
    return {
      count: parseInt(d.count) || 0,
      level: parseInt(d.level) || 0,
      lockedUntil: parseInt(d.lockedUntil) || 0,
      permanent: !!d.permanent,
      lastFailTs: parseInt(d.lastFailTs) || 0
    };
  } catch (e) {
    return { count: 0, level: 0, lockedUntil: 0, permanent: false, lastFailTs: 0 };
  }
}
function _saveLoginAttempts(userId, data) {
  try { PropertiesService.getScriptProperties().setProperty("login_attempts_" + userId, JSON.stringify(data)); } catch (e) {}
}
function _sprawdzBlokadeLogowania(userId) {
  var a = _getLoginAttempts(userId);
  var teraz = Date.now();

  // NOWE: automatyczny reset progresji po okresie ciszy (domyślnie 24h).
  // Jeśli od ostatniej nieudanej próby minęło więcej niż DECAY_MS, cały
  // stan (count + level + lockedUntil) jest kasowany — użytkownik wraca
  // do punktu startu (5 prób na poziomie 0). Nie dotyczy blokady
  // permanentnej — ta wymaga ręcznego odblokowania przez admina.
  try {
    var DECAY_MS = 24 * 3600 * 1000;
    if (!a.permanent && a.lastFailTs && (teraz - a.lastFailTs) > DECAY_MS) {
      _resetBlokadyLogowania(userId);
      return { zablokowane: false, autoReset: true };
    }
  } catch (eDecay) {}

  if (a.permanent) return { zablokowane: true, permanentna: true, pozostaloSek: 0 };
  if (a.lockedUntil && a.lockedUntil > teraz) {
    return { zablokowane: true, permanentna: false, pozostaloSek: Math.ceil((a.lockedUntil - teraz) / 1000) };
  }
  if (a.lockedUntil && a.lockedUntil <= teraz) { a.lockedUntil = 0; a.count = 0; _saveLoginAttempts(userId, a); }
  return { zablokowane: false };
}
function _liczbaSlownie(n) {
  var s = ["zero","jedną","dwie","trzy","cztery","pięć","sześć","siedem","osiem","dziewięć","dziesięć"];
  return s[n] || String(n);
}
function _formaProba(n) {
  if (n === 1) return "próbę";
  if (n >= 2 && n <= 4) return "próby";
  return "prób";
}
function _zarejestrujNieudaneLogowanie(userId) {
  var a = _getLoginAttempts(userId);
  a.count = (parseInt(a.count) || 0) + 1;
  var teraz = Date.now();
  var maxNaPoziomie = (a.level === 0) ? 5 : ((a.level === 1) ? 3 : 1);
  var blokadaSek = (a.level === 0) ? 60 : ((a.level === 1) ? 300 : 0);
  var blokadaOpis = (a.level === 0) ? "1 minutę" : ((a.level === 1) ? "5 minut" : "trwałą blokadę");
  if (a.count >= maxNaPoziomie) {
    if (a.level >= 2) {
      a.permanent = true; a.lockedUntil = 0; a.count = 0; _saveLoginAttempts(userId, a);
      return { zablokowane: true, permanentna: true, pozostaloSek: 0,
               wiadomosc: "Konto zostało trwale zablokowane. Skontaktuj się z administracją w celu odblokowania." };
    }
    a.level++; a.count = 0; a.lockedUntil = teraz + blokadaSek * 1000; _saveLoginAttempts(userId, a);
    return { zablokowane: true, permanentna: false, pozostaloSek: blokadaSek,
             wiadomosc: "Zbyt wiele błędnych prób — konto zablokowane na " + blokadaOpis + "." };
  }
  _saveLoginAttempts(userId, a);
  var pozostalo = maxNaPoziomie - a.count;
  var czasownik = (pozostalo === 1) ? "Pozostała" : "Pozostały";
  return { zablokowane: false, pozostalo: pozostalo,
           ostrzezenie: czasownik + " " + _liczbaSlownie(pozostalo) + " " + _formaProba(pozostalo) + " do blokady na " + blokadaOpis + "." };
}
function _resetBlokadyLogowania(userId) {
  try { PropertiesService.getScriptProperties().deleteProperty("login_attempts_" + userId); } catch (e) {}
}

function getListaZablokowanychKont(wykonawcaId) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") return { sukces: false, lista: [], wiadomosc: "Tylko administrator." };
    var props = PropertiesService.getScriptProperties();
    var teraz = Date.now();
    var mapaImion = {};
    try {
      var shK = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Kandydaci");
      if (shK && shK.getLastRow() > 1) {
        var dk = shK.getDataRange().getValues();
        for (var i = 1; i < dk.length; i++) mapaImion[_normId(dk[i][0])] = String(dk[i][1] || "").trim();
      }
    } catch (eM) {}
    var lista = [];
    props.getKeys().forEach(function(k) {
      if (k.indexOf("login_attempts_") !== 0) return;
      var id = k.substring("login_attempts_".length);
      try {
        var d = JSON.parse(props.getProperty(k));
        var perm = !!d.permanent;
        var lockedUntil = parseInt(d.lockedUntil) || 0;
        var tymczasowa = lockedUntil > teraz;
        if (!perm && !tymczasowa) return;
        lista.push({ userId: id, imie: mapaImion[id] || id, permanentna: perm, tymczasowa: tymczasowa,
                     pozostaloSek: tymczasowa ? Math.ceil((lockedUntil - teraz) / 1000) : 0,
                     level: parseInt(d.level) || 0 });
      } catch (e) {}
    });
    lista.sort(function(a, b) { return (a.permanentna === b.permanentna) ? a.pozostaloSek - b.pozostaloSek : (a.permanentna ? -1 : 1); });
    return { sukces: true, lista: lista };
  } catch (e) { return { sukces: false, lista: [], wiadomosc: String(e.message || e) }; }
}

function odblokujKontoUzytkownika(wykonawcaId, targetUserId) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Tylko administrator." };
    var target = _normId(targetUserId);
    if (!target) return { sukces: false, wiadomosc: "Brak ID." };
    var sheetH = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Hasła") || SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Hasla");
    if (!sheetH) return { sukces: false, wiadomosc: "Brak arkusza Hasła." };
    var noweHaslo = String(1000 + Math.floor(Math.random() * 9000));
    var dane = _pobierzDaneHasla();
    var _off3 = _migracjaKolumnyBDone() ? 1 : 0;
    var znaleziono = false, imie = target;
    for (var i = 1; i < dane.length; i++) {
      if (_normId(dane[i][0]) === target) {
        imie = String(dane[i][1] || "").trim() || target;
        sheetH.getRange(i + 1, 3 + _off3).setValue(_utworzZapisHasla(noweHaslo));
        sheetH.getRange(i + 1, 4 + _off3).setValue(false);
        znaleziono = true; break;
      }
    }
    if (!znaleziono) return { sukces: false, wiadomosc: "Nie znaleziono użytkownika." };
    _resetBlokadyLogowania(target);
    try { _logAdmin(uid, "", "ODBLOKUJ_KONTO", target, "nowe hasło"); } catch (e) {}
    return { sukces: true, userId: target, imie: imie, hasloTymczasowe: noweHaslo,
             wiadomosc: "Konto odblokowane. Nowe hasło: " + noweHaslo };
  } catch (e) { return { sukces: false, wiadomosc: String(e.message || e) }; }
}

function weryfikujLogowanie(id, haslo, deviceId, zapamietaj) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetHasla = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetHasla) return { sukces: false, wiadomosc: "Błąd krytyczny: Brak arkusza 'Hasła'" };

    var dane = sheetHasla.getDataRange().getValues();
    var targetId = String(id).trim();
    var targetNorm = _normId(targetId);

    // Sprawdź czy konto jest aktualnie zablokowane
    var _lockInfo = _sprawdzBlokadeLogowania(targetNorm || targetId);
    if (_lockInfo && _lockInfo.zablokowane) {
      if (_lockInfo.permanentna) {
        return {
          sukces: false,
          zablokowane: true,
          permanentna: true,
          wiadomosc: "🔒 Konto zostało trwale zablokowane. Skontaktuj się z administracją w celu odblokowania."
        };
      }
      var _min = Math.floor(_lockInfo.pozostaloSek / 60);
      var _sek = _lockInfo.pozostaloSek % 60;
      var _czasTxt = (_min > 0 ? (_min + " min ") : "") + _sek + " s";
      return {
        sukces: false,
        zablokowane: true,
        permanentna: false,
        pozostaloSek: _lockInfo.pozostaloSek,
        wiadomosc: "🔒 Konto tymczasowo zablokowane. Spróbuj ponownie za " + _czasTxt + "."
      };
    }

    for (var i = 1; i < dane.length; i++) {
      // >>> DRUGIE ID: dopasuj ID z kolumny A LUB z kolumny G.
      var _idA = _normId(dane[i][0]);
      var _idG = _normId(dane[i][6]);
      var _pasuje = (_idA && _idA === targetNorm) ||
                    (_idG && _idG === targetNorm);
      if (!_pasuje) continue;

      var _primaryId = String(dane[i][0] || "").trim();
      var weryfikacja = _sprawdzHaslo(haslo, dane[i][2]);
      if (weryfikacja.ok) {
        _resetBlokadyLogowania(targetNorm || targetId);
        if (weryfikacja.legacy) {
          sheetHasla.getRange(i + 1, 3).setValue(_utworzZapisHasla(haslo));
        }
        var zmianaHaslaWymagana = (dane[i][3] === false || dane[i][3] === "FALSE" || dane[i][3] === "");

        var rola = _czyFlagaAdmin(dane[i][5])
          ? "ADMIN"
          : _normalizujRole(dane[i][4] || "");
        if (!rola) rola = "MINISTRANT";
        var token = generujToken();
        var _primTok = _primaryId || targetNorm || targetId;
        zapiszToken(_primTok, token, rola);
        var ustawienia = getUstawieniaUsera(_primTok);
        if (zapamietaj && deviceId) {
          zapiszSesjeUrzadzenia(deviceId, _primTok, token, String(dane[i][1]), rola);
        }

        var przerwaTechniczna = (targetNorm === "2212" || _primTok === "2212");
        var zielonyBaner = false;
        var zielonyBanerTytul = "";
        var zielonyBanerMsg = "";
        try {
          var gbInfo = getZielonyBaner();
          if (gbInfo && gbInfo.aktywny) {
            zielonyBaner = true;
            zielonyBanerTytul = gbInfo.tytul || "";
            zielonyBanerMsg = gbInfo.tresc || "";
          }
        } catch (eGb) {}

        return {
          sukces: true,
          userId: _primTok,   // klient użyje tego po loginie
          imie: String(dane[i][1]),
          rola: rola,
          token: token,
          wymagaZmiany: zmianaHaslaWymagana,
          theme: ustawienia.motyw,
          przerwaTechniczna: przerwaTechniczna,
          zielonyBaner: zielonyBaner,
          zielonyBanerTytul: zielonyBanerTytul,
          zielonyBanerMsg: zielonyBanerMsg,
          wiadomosc: "Zalogowano pomyślnie"
        };
      } else {
        var _wynikProb = _zarejestrujNieudaneLogowanie(targetNorm || targetId);
        if (_wynikProb.zablokowane) {
          return {
            sukces: false,
            zablokowane: true,
            permanentna: !!_wynikProb.permanentna,
            pozostaloSek: _wynikProb.pozostaloSek || 0,
            wiadomosc: "🔒 " + _wynikProb.wiadomosc
          };
        }
        return {
          sukces: false,
          wiadomosc: (_wynikProb.ostrzezenie || "Błędne hasło.")
        };
      }
    }
    return { sukces: false, wiadomosc: "Nie znaleziono takiego ID w bazie!" };
  } catch (error) {
    return { sukces: false, wiadomosc: error.message };
  }
}

// ----------------------------------------------------------------------
// TOKENY SESJI
// Przy logowaniu backend generuje losowy token i zapisuje go w PropertiesService.
// Przy każdym żądaniu wymagającym weryfikacji roli, token jest sprawdzany po stronie backendu.
// ----------------------------------------------------------------------

function generujToken() {
  return Utilities.getUuid();
}

function zapiszToken(userId, token, rola) {
  var props = PropertiesService.getScriptProperties();
  var dane = { token: token, rola: rola, ts: new Date().getTime() };
  props.setProperty("session_" + String(userId).trim(), JSON.stringify(dane));
}

function weryfikujToken(userId, token) {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty("session_" + String(userId).trim());
    if (!raw) return null;
    var dane = JSON.parse(raw);
    // Brak limitu czasowego — token ważny dopóki nie zostanie usunięty
    if (dane.token !== String(token).trim()) return null;
    return dane.rola;
  } catch(e) {
    return null;
  }
}

function usunToken(userId) {
  try {
    PropertiesService.getScriptProperties().deleteProperty("session_" + String(userId).trim());
  } catch(e) {}
}

// ----------------------------------------------------------------------
// Zastępuje weryfikację tokenu — usunięto sprawdzanie tokenów sesji
// (powodowało błąd "Sesja wygasła" przy logowaniu na kilku urządzeniach
// jednocześnie, bo token był nadpisywany). Rola jest teraz odczytywana
// bezpośrednio z arkusza "Hasła" na podstawie ID użytkownika.
// ----------------------------------------------------------------------
/**
 * Kolumna F (indeks 5) w arkuszu Hasła: TAK = administrator.
 * Można być jednocześnie ministrantem (kolumna E) i adminem (kolumna F).
 */

/**
 * Bezpieczne formatowanie daty/godziny w strefie Europe/Warsaw.
 * Działa poprawnie także dla wartości typu "czas-of-day" z arkuszy
 * Google (auto-konwersja "18:00" → Date 1899-12-30 18:00).
 *
 * Dla tych wartości Utilities.formatDate stosuje historyczną strefę
 * Warszawy (Warsaw Mean Time = UTC+1:24, przed 1915 r.) i zwraca
 * godzinę przesuniętą o 1h24m (np. 18:00 → 19:24).
 *
 * Zamiast tego dla dat sprzed 1970 używamy getHours()/getMinutes(),
 * które działają w bieżącej strefie projektu (appsscript.json ->
 * timeZone = "Europe/Warsaw"). Dla współczesnych dat — normalne
 * Utilities.formatDate.
 */
function _fmtWarszawa(x, fmt) {
  if (x === null || x === undefined || x === "") return "";
  if (x instanceof Date) {
    if (isNaN(x.getTime())) return "";
    var pad = function(n) { return (n < 10 ? "0" : "") + n; };
    if (x.getFullYear() < 1970) {
      var hh = x.getHours(), mm = x.getMinutes(), ss = x.getSeconds();
      var dd = x.getDate(), mo = x.getMonth() + 1, yy = x.getFullYear();
      if (fmt === "HH:mm")      return pad(hh) + ":" + pad(mm);
      if (fmt === "HH:mm:ss")   return pad(hh) + ":" + pad(mm) + ":" + pad(ss);
      if (fmt === "yyyy-MM-dd") return yy + "-" + pad(mo) + "-" + pad(dd);
      if (fmt === "dd.MM.yyyy") return pad(dd) + "." + pad(mo) + "." + yy;
      if (fmt === "dd.MM.yyyy HH:mm")
        return pad(dd) + "." + pad(mo) + "." + yy + " " + pad(hh) + ":" + pad(mm);
    }
    try { return Utilities.formatDate(x, "Europe/Warsaw", fmt); } catch (e) { return String(x); }
  }
  return String(x);
}

/** Normalizuje nazwę roli z arkusza (KSIĄDZ → KSIADZ). */
function _normalizujRole(rola) {
  var r = String(rola || "").toUpperCase().trim();
  r = r.replace(/Ą/g, "A").replace(/Ę/g, "E").replace(/Ó/g, "O")
       .replace(/Ś/g, "S").replace(/Ł/g, "L").replace(/Ż/g, "Z")
       .replace(/Ź/g, "Z").replace(/Ć/g, "C").replace(/Ń/g, "N");
  if (r === "KSIADZ") return "KSIADZ";
  return r;
}

/** Admin „pełny” lub ksiądz — wspólne uprawnienia operacyjne (punkty, posty…). */
function _czyAdminLubKsiadz(rola) {
  var r = _normalizujRole(rola);
  return r === "ADMIN" || r === "MODERATOR" || r === "KSIADZ";
}

function _czyPelnyAdmin(rola) {
  return _normalizujRole(rola) === "ADMIN";
}

function _czyFlagaAdmin(wartosc) {
  if (wartosc === true || wartosc === 1) return true;
  var s = String(wartosc == null ? "" : wartosc).toUpperCase().trim();
  return s === "TAK" || s === "TRUE" || s === "YES" || s === "1" || s === "ADMIN";
}

function pobierzRoleUzytkownika(userId) {
  var _uid = _normId(userId);
  if (!_uid) return null;
  var _key = "rola_" + _uid;
  var _cached = _cGet(_key);
  if (_cached !== null) {
    if (_cached === "__NONE__") return null;
    return _cached;
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetHasla = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetHasla) { _cPut(_key, "__NONE__", 60); return null; }
    var dane = sheetHasla.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      // >>> DRUGIE ID: dopasuj ID z kolumny A LUB z kolumny G.
      var _idA = _normId(dane[i][0]);
      var _idG = _normId(dane[i][6]);
      if ((_idA && _idA === _uid) || (_idG && _idG === _uid)) {
        var wynik;
        if (_czyFlagaAdmin(dane[i][5])) wynik = "ADMIN";
        else {
          var rolaE = _normalizujRole(dane[i][4] || "");
          wynik = rolaE || "MINISTRANT";
        }
        _cPut(_key, wynik, 300);
        return wynik;
      }
    }
    _cPut(_key, "__NONE__", 60);
    return null;
  } catch (e) {
    return null;
  }
}

function weryfikujTokenSesji(userId, token) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (!rola) return { sukces: false };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Ministranci");
    if (!sheet) return { sukces: true, rola: rola, imie: null };
    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === String(userId).trim()) {
        var ustawienia = getUstawieniaUsera(userId);
        return { sukces: true, rola: rola, imie: String(dane[i][1] || '').split(' ')[0], theme: ustawienia.motyw };
      }
    }
    return { sukces: true, rola: rola, imie: null, theme: "light" };
  } catch(e) {
    return { sukces: false };
  }
}

function wylogujSerwer(userId, deviceId) {
  usunToken(userId);
  if (deviceId) usunSesjeUrzadzenia(deviceId);
  return { sukces: true };
}

function zmienHasloPierwszeLogowanie(id, noweHaslo) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetHasla = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetHasla) return { sukces: false, wiadomosc: "Błąd bazy danych." };
    
    var dane = _pobierzDaneHasla();
    var targetId = String(id).trim();
    var pass = String(noweHaslo || "");
    if (pass.length < 4) return { sukces: false, wiadomosc: "Hasło musi mieć min. 4 znaki." };
    var _off = _migracjaKolumnyBDone() ? 1 : 0; // przesunięcie kolumn po migracji
    
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === targetId) {
        sheetHasla.getRange(i + 1, 3 + _off).setValue(_utworzZapisHasla(pass));
        sheetHasla.getRange(i + 1, 4 + _off).setValue(true);
        return { sukces: true, wiadomosc: "Hasło zostało zaktualizowane!" };
      }
    }
    return { sukces: false, wiadomosc: "Błąd: Nie znaleziono użytkownika." };
  } catch (error) {
    return { sukces: false, wiadomosc: error.message };
  }
}

/**
 * Zmiana własnego hasła (bez akceptacji admina).
 * Wymaga aktualnego (starego) hasła + nowego.
 */
function zmienHasloWlasne(userId, stareHaslo, noweHaslo, sessionToken) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Brak ID użytkownika." };
    var stare = String(stareHaslo || "");
    var nowe = String(noweHaslo || "");
    if (!stare) return { sukces: false, wiadomosc: "Podaj aktualne hasło." };
    if (nowe.length < 4) return { sukces: false, wiadomosc: "Nowe hasło musi mieć min. 4 znaki." };
    if (stare === nowe) return { sukces: false, wiadomosc: "Nowe hasło musi być inne niż stare." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetHasla = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetHasla) return { sukces: false, wiadomosc: "Błąd bazy haseł." };

    var dane = _pobierzDaneHasla();
    var _off2 = _migracjaKolumnyBDone() ? 1 : 0;
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() !== uid) continue;
      var weryfikacja = _sprawdzHaslo(stare, dane[i][2]);
      if (!weryfikacja || !weryfikacja.ok) {
        return { sukces: false, wiadomosc: "Aktualne hasło jest nieprawidłowe." };
      }
      sheetHasla.getRange(i + 1, 3 + _off2).setValue(_utworzZapisHasla(nowe));
      sheetHasla.getRange(i + 1, 4 + _off2).setValue(true);
      return { sukces: true, wiadomosc: "Hasło zostało zmienione." };
    }
    return { sukces: false, wiadomosc: "Nie znaleziono konta." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

// ----------------------------------------------------------------------
// GŁÓWNA FUNKCJA POBIERAJĄCA DANE
// ----------------------------------------------------------------------

function getAppData(userId, userRole, sessionToken, stronaPostow) {
  try {
    var POSTY_NA_STRONE = 10;
    var strona = parseInt(stronaPostow) || 0;
    // Rola pobierana bezpośrednio z arkusza (bez weryfikacji tokenu sesji)
    if (userId) {
      var rolaZeSheeta = pobierzRoleUzytkownika(userId);
      if (rolaZeSheeta) userRole = rolaZeSheeta;
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKandydaci = ss.getSheetByName("Kandydaci");
    var sheetKalendarz = ss.getSheetByName("Kalendarz");
    var sheetDyzury = ss.getSheetByName("Dyżury");
    var sheetSpolecznosc = ss.getSheetByName("Społeczność");
    var sheetWnioski = ss.getSheetByName("Wnioski_dyzury");

    if (!sheetDyzury) {
      sheetDyzury = ss.insertSheet("Dyżury");
      sheetDyzury.appendRow(["Data i Godzina", "Imię i Nazwisko", "ID", "Obowiązuje od", "Obowiązuje do"]);
    } else {
      // Migracja: dopisz nagłówki historii, jeśli arkusz powstał przed tą funkcją
      try {
        var naglDyz = sheetDyzury.getRange(1, 1, 1, Math.max(5, sheetDyzury.getLastColumn())).getValues()[0];
        if (!naglDyz[3]) sheetDyzury.getRange(1, 4).setValue("Obowiązuje od");
        if (!naglDyz[4]) sheetDyzury.getRange(1, 5).setValue("Obowiązuje do");
      } catch (eMigDyz) {}
    }
    if (!sheetSpolecznosc) {
      sheetSpolecznosc = ss.insertSheet("Społeczność");
      sheetSpolecznosc.appendRow(["Data", "Typ", "Tytuł", "Treść", "Link_Media"]);
    }
    if (!sheetWnioski) {
      sheetWnioski = ss.insertSheet("Wnioski_dyzury");
      sheetWnioski.appendRow(["Data zgłoszenia", "Wnioskodawca ID", "Wnioskodawca Imię", "Dyżur Data", "Dyżur Godzina", "Dyżur Imię i Nazwisko", "Dyżur ID", "Powód", "Status", "Wiersz Dyżuru", "Powód Odrzucenia", "Rozpatrzone przez"]);
    }
    if (!sheetKandydaci) throw new Error("Brak arkusza 'Kandydaci'");
    if (!sheetKalendarz) throw new Error("Brak arkusza 'Kalendarz'");
    
    // >>> D: normalizacja Kandydaci (po migracji A/B na stary format)
    var dataKandydaci = _pobierzKandydatowRawCached().map(function(row, idx) {
      if (idx === 0) return row; // nagłówek
      return _normalizujWierszKandydaci(row);
    });
    var dataKalendarz = sheetKalendarz.getDataRange().getValues();
    var dataDyzury = sheetDyzury.getDataRange().getValues();
    var dataSpolecznosc = sheetSpolecznosc.getDataRange().getValues();
    var dataWnioski = sheetWnioski.getDataRange().getValues();
    
    var kandydaci = [];
    if (dataKandydaci.length > 1) {
      for (var i = 1; i < dataKandydaci.length; i++) {
        var iterowanyId = _normId(dataKandydaci[i][0]);
        if (!iterowanyId) continue;
        
        // Nie-admin: tylko własny rekord (ranking = getRanking).
        var _rolaU = String(userRole || "").toUpperCase();
        // Lektorzy (w tym Lektor młodszy) też mają dostęp do strony "Wpis" i muszą
        // widzieć pełną listę ministrantów do wyboru — bez tego select-kandydat
        // pokazywał im tylko ich własny (odfiltrowany jako lektor) rekord, czyli pustkę.
        var _jestAdminLista = (_rolaU.indexOf("ADMIN") === 0 || _rolaU === "MODERATOR" || _rolaU === "KSIADZ" || _rolaU === "KSIĄDZ" || _rolaU.indexOf("LEKTOR") === 0);
        if (!_jestAdminLista) {
          // >>> DRUGIE ID: pasuje A (kol. 0) LUB J (kol. 9).
          var _uidCmp = _normId(userId);
          if (!_wierszKandydaciPasuje(dataKandydaci[i], _uidCmp)) {
            continue;
          }
        }

        kandydaci.push([
          iterowanyId,
          String(dataKandydaci[i][1] || ""),
          parseInt(dataKandydaci[i][2]) || 0,
          String(dataKandydaci[i][3] || ""),
          String(dataKandydaci[i][4] || ""),
          String(dataKandydaci[i][5] || ""),
          String(dataKandydaci[i][6] || ""),
          String(dataKandydaci[i][7] || "") // URL zdjęcia profilowego (kolumna H)
        ]);
      }
    }
    
    var kalendarz = [];
    if (dataKalendarz.length > 1) {
      for (var j = 1; j < dataKalendarz.length; j++) {
        if (!dataKalendarz[j][0]) continue;
        var czas = dataKalendarz[j][0] instanceof Date ? dataKalendarz[j][0].getTime() : new Date(dataKalendarz[j][0]).getTime();
        kalendarz.push([
          czas,
          String(dataKalendarz[j][1] || ""),
          parseInt(dataKalendarz[j][2]) || 0,
          j + 1,
          String(dataKalendarz[j][3] || ""),
          String(dataKalendarz[j][4] || ""), // ID grupy powtarzania (puste = wydarzenie jednorazowe)
          String(dataKalendarz[j][5] || "")  // czytelna etykieta powtarzania (np. "co tydzień")
        ]);
      }
    }
    
    var dyzury = [];
    if (dataDyzury.length > 1) {
      var tzDyz = _APP_TZ;
      var dzisiajKeyDyz = Utilities.formatDate(new Date(), tzDyz, "yyyy-MM-dd");
      for (var k = 1; k < dataDyzury.length; k++) {
        if (!dataDyzury[k][0]) continue;
        
        var surowaData = dataDyzury[k][0];
        var d = surowaData instanceof Date ? surowaData : new Date(surowaData);
        if (isNaN(d.getTime())) continue;

        // Tylko AKTYWNE dyżury: puste "Obowiązuje do" albo data >= dziś
        // (zamknięte przy przesunięciu mają "Obowiązuje do" = wczoraj → nie pokazuj)
        var doRawD = dataDyzury[k][4];
        if (doRawD !== null && doRawD !== undefined && doRawD !== "") {
          var doKeyD = "";
          if (doRawD instanceof Date && !isNaN(doRawD.getTime())) {
            doKeyD = Utilities.formatDate(doRawD, tzDyz, "yyyy-MM-dd");
          } else {
            var dsD = String(doRawD).trim();
            doKeyD = dsD.length >= 10 ? dsD.substring(0, 10) : dsD;
          }
          if (doKeyD && doKeyD < dzisiajKeyDyz) continue;
        }
        
        // >>> FIX JEDNORAZOWY: wykryj jednorazowy dyżur (Obowiązuje od === do)
        // i przekaż do frontu konkretną datę ISO (YYYY-MM-DD) + flagę.
        // Dzięki temu profil pokazuje "Niedziela 27.09.2026 18:00 (jednorazowy)"
        // zamiast mylącego "Niedziela · 18:00".
        // Filtr poniżej (doKey < dziś) i tak usuwa ten dyżur z profilu
        // w poniedziałek po niedzieli — w arkuszu zostaje jako historia.
        var _odRawD = dataDyzury[k][3];
        var _doRawD = dataDyzury[k][4];
        function _kluczDatyDyz(raw) {
          if (raw === null || raw === undefined || raw === "") return "";
          if (raw instanceof Date && !isNaN(raw.getTime())) {
            return Utilities.formatDate(raw, tzDyz, "yyyy-MM-dd");
          }
          var s = String(raw).trim();
          return s.length >= 10 ? s.substring(0, 10) : s;
        }
        var _odKeyD = _kluczDatyDyz(_odRawD);
        var _doKeyD = _kluczDatyDyz(_doRawD);
        var _jednorazowyD = !!(_odKeyD && _doKeyD && _odKeyD === _doKeyD);
        var _dataISOD = Utilities.formatDate(d, tzDyz, "yyyy-MM-dd");
        dyzury.push({
          wiersz: k + 1,
          timestamp: d.getTime(),
          dzienTygodnia: typeof _dzienTygodniaDyzuru === "function" ? _dzienTygodniaDyzuru(d) : d.getDay(),
          godzina: _fixGodzina(d),
          imieNazwisko: String(dataDyzury[k][1] || "Nieznany"),
          id: String(dataDyzury[k][2] || ""),
          jednorazowy: _jednorazowyD,
          dataISO: _dataISOD
        });
      }
    }

    var spolecznosc = [];
    if (dataSpolecznosc.length > 1) {
      for (var s = 1; s < dataSpolecznosc.length; s++) {
        if (!dataSpolecznosc[s][0]) continue;
        var ds = dataSpolecznosc[s][0] instanceof Date ? dataSpolecznosc[s][0] : new Date(dataSpolecznosc[s][0]);
        if (isNaN(ds.getTime())) continue;

        spolecznosc.push({
          wiersz: s + 1,
          timestamp: ds.getTime(),
          data: Utilities.formatDate(ds, _APP_TZ, "dd.MM.yyyy HH:mm"),
          dataFormated: Utilities.formatDate(ds, _APP_TZ, "dd.MM.yyyy HH:mm"),
          typ: String(dataSpolecznosc[s][1] || "Post"),
          tytul: String(dataSpolecznosc[s][2] || ""),
          tresc: String(dataSpolecznosc[s][3] || ""),
          linkMedia: String(dataSpolecznosc[s][4] || ""),
          autorImie: String(dataSpolecznosc[s][5] || "Admin"),
          liczbaKomentarzy: 0
        });
      }
      spolecznosc.sort(function(a, b) { return b.timestamp - a.timestamp; });
    }

    // Zlicz komentarze per post — JEDEN odczyt arkusza (używany też niżej do wzmianek)
    var sheetKomentarze = ss.getSheetByName("Komentarze");
    var dataKom = (sheetKomentarze && sheetKomentarze.getLastRow() > 1)
      ? sheetKomentarze.getDataRange().getValues()
      : [];
    if (dataKom.length > 1) {
      // mapa postWiersz -> liczba komentarzy (jeden przebieg)
      var _mapaKomPer = {};
      for (var kk = 1; kk < dataKom.length; kk++) {
        var pk = parseInt(dataKom[kk][1], 10);
        if (isNaN(pk)) continue;
        _mapaKomPer[pk] = (_mapaKomPer[pk] || 0) + 1;
      }
      spolecznosc.forEach(function(post) {
        post.liczbaKomentarzy = _mapaKomPer[post.wiersz] || 0;
      });
    }

    // Ostatnie komentarze — potrzebne do wykrywania wzmianek @ w komentarzach
    // (żeby oznaczona osoba dostała powiadomienie w Centrum Powiadomień, tak
    // jak przy wzmiankach w treści postów). Ograniczamy do kilku ostatnich dni,
    // żeby nie przesyłać całej historii komentarzy przy każdym odświeżeniu.
    var ostatnieKomentarze = [];
    if (dataKom.length > 1) {
      var mapaTytulowPostow = {};
      spolecznosc.forEach(function(p) { mapaTytulowPostow[p.wiersz] = p.tytul; });
      var progCzasuKom = Date.now() - 3 * 24 * 3600 * 1000;
      for (var ki2 = 1; ki2 < dataKom.length; ki2++) {
        if (!dataKom[ki2][0]) continue;
        var dKom = dataKom[ki2][0] instanceof Date ? dataKom[ki2][0] : new Date(dataKom[ki2][0]);
        if (isNaN(dKom.getTime()) || dKom.getTime() < progCzasuKom) continue;
        var postWierszKom = parseInt(dataKom[ki2][1]);
        ostatnieKomentarze.push({
          wiersz: ki2 + 1,
          postWiersz: postWierszKom,
          postTytul: mapaTytulowPostow[postWierszKom] || "",
          timestamp: dKom.getTime(),
          autorImie: String(dataKom[ki2][3] || ""),
          tresc: String(dataKom[ki2][4] || "")
        });
      }
    }

    var wszystkichPostow = spolecznosc.length;
    spolecznosc = spolecznosc.slice(strona * POSTY_NA_STRONE, (strona + 1) * POSTY_NA_STRONE);

    var wnioski = [];
    if (dataWnioski.length > 1) {
      for (var w = 1; w < dataWnioski.length; w++) {
        if (!dataWnioski[w][0]) continue;
        var dw = dataWnioski[w][0] instanceof Date ? dataWnioski[w][0] : new Date(dataWnioski[w][0]);
        if (isNaN(dw.getTime())) continue;

        // >>> FIX: używamy _fixGodzina() zamiast Utilities.formatDate.
        //     Wartości pochodzące z auto-konwersji Sheets ("18:00" → Date 1899)
        //     mają bazową datę 1899-12-30 i historyczną strefę Warszawy (UTC+1:24),
        //     przez co formatDate zwracał godzinę przesuniętą o 1h24m (np. 19:24).
        var nowaGodzina  = _fixGodzina(dataWnioski[w][4]);
        var staraGodzina = _fixGodzina(dataWnioski[w][6]);

        wnioski.push({
          wiersz: w + 1,
          timestamp: dw.getTime(),
          dataFormated: Utilities.formatDate(dw, _APP_TZ, "dd.MM.yyyy HH:mm"),
          wnioskodawcaId: String(dataWnioski[w][1] || ""),
          wnioskodawcaImie: String(dataWnioski[w][2] || ""),
          nowyTerminDzien: String(dataWnioski[w][3] || ""),
          nowaGodzina: nowaGodzina,
          staryDzienTygodnia: String(dataWnioski[w][5] || ""),
          staraGodzina: staraGodzina,
          powod: String(dataWnioski[w][7] || ""),
          status: String(dataWnioski[w][8] || "Nowy"),
          powodOdrzucenia: String(dataWnioski[w][10] || ""),
          rozpatrzonePrzez: String(dataWnioski[w][11] || "")
        });
      }
      wnioski.sort(function(a, b) { return b.timestamp - a.timestamp; });
    }
    
    var czyKandydat = false;
    if (dataKandydaci.length > 1 && userId) {
      var targetIdKand = _normId(userId);
      for (var ck = 1; ck < dataKandydaci.length; ck++) {
        if (_normId(dataKandydaci[ck][0]) === targetIdKand) { czyKandydat = true; break; }
      }
    }

    // Nazwa aktualnego roku formacyjnego — potrzebna po stronie klienta, żeby odróżnić
    // prawdziwą karę punktową od zwykłego zerowania punktów przy zamknięciu roku.
    var rokNazwaAktualna = PropertiesService.getScriptProperties().getProperty('rok_nazwa') || '';

    return { success: true, kandydaci: kandydaci, kalendarz: kalendarz, dyzury: dyzury, spolecznosc: spolecznosc, wnioski: wnioski, zweryfikowanaRola: userRole, czyKandydat: czyKandydat, postyMeta: { strona: strona, wszystkich: wszystkichPostow, naStrone: POSTY_NA_STRONE }, ostatnieKomentarze: ostatnieKomentarze, rokNazwa: rokNazwaAktualna };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ======================================================================
// LEKKI ENDPOINT: tylko wnioski o zmianę dyżuru
// Używane przy odświeżaniu kategorii "Dyżury".
// ======================================================================
function getWnioskiDyzury(userId, sessionToken) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { success: false, wnioski: [] };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetWnioski = ss.getSheetByName("Wnioski_dyzury");
    if (!sheetWnioski || sheetWnioski.getLastRow() < 2) {
      return { success: true, wnioski: [] };
    }
    var dataWnioski = sheetWnioski.getDataRange().getValues();
    var wnioski = [];
    for (var w = 1; w < dataWnioski.length; w++) {
      if (!dataWnioski[w][0]) continue;
      var dw = dataWnioski[w][0] instanceof Date ? dataWnioski[w][0] : new Date(dataWnioski[w][0]);
      if (isNaN(dw.getTime())) continue;
      wnioski.push({
        wiersz: w + 1,
        timestamp: dw.getTime(),
        dataFormated: Utilities.formatDate(dw, _APP_TZ, "dd.MM.yyyy HH:mm"),
        wnioskodawcaId: String(dataWnioski[w][1] || ""),
        wnioskodawcaImie: String(dataWnioski[w][2] || ""),
        nowyTerminDzien: String(dataWnioski[w][3] || ""),
        nowaGodzina: _fixGodzina(dataWnioski[w][4]),
        staryDzienTygodnia: String(dataWnioski[w][5] || ""),
        staraGodzina: _fixGodzina(dataWnioski[w][6]),
        powod: String(dataWnioski[w][7] || ""),
        status: String(dataWnioski[w][8] || "Nowy"),
        powodOdrzucenia: String(dataWnioski[w][10] || ""),
        rozpatrzonePrzez: String(dataWnioski[w][11] || "")
      });
    }
    wnioski.sort(function(a, b) { return b.timestamp - a.timestamp; });
    return { success: true, wnioski: wnioski };
  } catch (e) {
    return { success: false, wnioski: [], error: String(e.message || e) };
  }
}

// ----------------------------------------------------------------------
// FUNKCJE SPOŁECZNOŚCI
// ----------------------------------------------------------------------

function konwertujLinkDrive(link) {
  if (!link || link.trim() === "") return "";
  
  var idMatch = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) {
    idMatch = link.match(/id=([a-zA-Z0-9_-]+)/);
  }
  
  if (idMatch && idMatch[1]) {
    // >>> FIX: "uc?export=view" od dawna NIE dziala niezawodnie w <img>
    // — Google wymaga ciasteczek / przekierowan, ktore w iframe (GAS w
    // Netlify) czesto sa blokowane. "thumbnail?id=...&sz=w1000" dziala
    // jako bezposredni obrazek w <img src>.
    return "https://drive.google.com/thumbnail?id=" + idMatch[1] + "&sz=w1000";
  }

  return link;
}

function dodajPost(typ, tytul, tresc, linkMedia, rola) {
  // Posty: każdy zalogowany (rola tylko informacyjna)
  if (!rola) {
    return "Błąd: Brak uprawnień.";
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetSpolecznosc = ss.getSheetByName("Społeczność");
    if (!sheetSpolecznosc) return "Błąd: Brak arkusza 'Społeczność'";

    var now = new Date();
    sheetSpolecznosc.appendRow([now, typ || "AUTO", tytul, tresc, ""]);
    return "Post został opublikowany pomyślnie!";
  } catch(e) {
    return "Błąd dodawania posta: " + e.message;
  }
}

function usunPost(wiersz, rola) {
  if (rola !== "ADMIN") {
    return "Błąd: Brak uprawnień administratora.";
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetSpolecznosc = ss.getSheetByName("Społeczność");
    if(sheetSpolecznosc) {
      sheetSpolecznosc.deleteRow(parseInt(wiersz));
      return "Usunięto wpis ze społeczności!";
    }
    return "Błąd: Brak arkusza 'Społeczność'";
  } catch(e) {
    return "Błąd usuwania wpisu: " + e.message;
  }
}

// ----------------------------------------------------------------------
// WNIOSKI O PRZESUNIĘCIE DYŻURU
// ----------------------------------------------------------------------

function dodajWniosekPrzesunieciaDyzuru(wierszDyzuru, staryDzienTygodnia, staraGodzina, dyzurImieNazwisko, dyzurId, nowyTerminDzien, nowaGodzina, wnioskodawcaId, wnioskodawcaImie, powod) {
  // Szybka ścieżka: 1× appendRow (+ lekka deduplikacja).
  // Bez skanowania całego arkusza historii.
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try {
    try {
      gotLock = lock.tryLock(8000);
    } catch (eL) { gotLock = false; }
    if (!gotLock) {
      return { sukces: false, wiadomosc: "Serwer zajęty zapisem — spróbuj ponownie za chwilę." };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetWnioski = ss.getSheetByName("Wnioski_dyzury");
    if (!sheetWnioski) {
      sheetWnioski = ss.insertSheet("Wnioski_dyzury");
      sheetWnioski.appendRow(["Data zgłoszenia", "Wnioskodawca ID", "Wnioskodawca Imię", "Nowy Termin Dzień", "Nowa Godzina", "Stary Dzień Tygodnia", "Stara Godzina", "Powód", "Status", "Wiersz Dyżuru", "Powód Odrzucenia", "Rozpatrzone przez"]);
    }

    var normWniId = String(wnioskodawcaId || "").trim();
    var normWierszDyz = String(wierszDyzuru || "").trim();
    var cacheKey = "wn_dyz_open_" + normWniId + "_" + normWierszDyz;

    // 1) Cache — bez odczytu Sheets
    try {
      var cache = CacheService.getScriptCache();
      if (cache.get(cacheKey)) {
        return { sukces: false, wiadomosc: "Masz już otwarty wniosek dla tego dyżuru. Poczekaj na rozpatrzenie." };
      }
    } catch (eC) {}

    // 2) Dedup tylko ostatnich ~40 wierszy (otwarte wnioski są świeże)
    var last = sheetWnioski.getLastRow();
    if (last >= 2) {
      var startR = Math.max(2, last - 39);
      // getRange(..., 2, ..., 10) → [0]=B ID, [7]=I Status, [8]=J wiersz dyżuru
      var existing = sheetWnioski.getRange(startR, 2, last, 10).getValues();
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i][0]).trim() === normWniId &&
            String(existing[i][7]).trim() === "Nowy" &&
            String(existing[i][8]).trim() === normWierszDyz) {
          try { CacheService.getScriptCache().put(cacheKey, "1", 21600); } catch (eC2) {}
          return { sukces: false, wiadomosc: "Masz już otwarty wniosek dla tego dyżuru. Poczekaj na rozpatrzenie." };
        }
      }
    }

    // 3) Sam zapis — jedna operacja
    sheetWnioski.appendRow([
      new Date(),
      normWniId,
      String(wnioskodawcaImie || "").trim(),
      String(nowyTerminDzien || "").trim(),
      String(nowaGodzina || "").trim(),
      String(staryDzienTygodnia || "").trim(),
      String(staraGodzina || "").trim(),
      String(powod || "").trim(),
      "Nowy",
      normWierszDyz,
      ""
    ]);

    // >>> FIX GODZIN: wymuś PLAIN TEXT na kolumnach z godzinami
    //     (E=5 "Nowa Godzina", G=7 "Stara Godzina").
    //     Bez tego Sheets auto-konwertuje "18:00" na Date(1899-12-30 18:00),
    //     a przy odczycie Utilities.formatDate(..., "Europe/Warsaw", "HH:mm")
    //     dodaje +1:24 (Warsaw Mean Time z 1899) → na ekranie widniało "19:24".
    try {
      var _lastWn = sheetWnioski.getLastRow();
      var _cNowaG = sheetWnioski.getRange(_lastWn, 5);
      _cNowaG.setNumberFormat("@");
      _cNowaG.setValue(String(nowaGodzina || "").trim());
      var _cStaraG = sheetWnioski.getRange(_lastWn, 7);
      _cStaraG.setNumberFormat("@");
      _cStaraG.setValue(String(staraGodzina || "").trim());
    } catch (eFixG) {}

    try { CacheService.getScriptCache().put(cacheKey, "1", 21600); } catch (eC3) {}

    // 4) Powiadomienia adminów w tle (kolejka) — NIE blokują odpowiedzi do apki
    try {
      _kolejkujPowiadomienieAdminow(
        "Nowy wniosek o zmianę dyżuru",
        String(wnioskodawcaImie || wnioskodawcaId || "") + " — " +
          String(staryDzienTygodnia || "") + " " + String(staraGodzina || "") +
          " → " + String(nowyTerminDzien || "") + " " + String(nowaGodzina || ""),
        "page-wnioski",
        normWniId
      );
    } catch (eN) {}

    return { sukces: true, wiadomosc: "Wniosek o przesunięcie dyżuru został wysłany." };
  } catch (e) {
    return { sukces: false, wiadomosc: "Błąd zapisu wniosku: " + (e.message || e) };
  } finally {
    if (gotLock) {
      try { lock.releaseLock(); } catch (eR) {}
    }
  }
}

function obliczDateDlaWniosku(trybDnia, godzina) {
  var trimmed = String(trybDnia).trim();
  var dayMap = {
    "Poniedziałek": [1],
    "Wtorek":       [2],
    "Środa":        [3],
    "Czwartek":     [4],
    "Piątek":       [5],
    "Sobota":       [6],
    "Niedziela":    [0],
    "Pon-pt":       [1, 2, 3, 4, 5]
  };
  var allowed = dayMap[trimmed] || [1, 2, 3, 4, 5];

  var teraz = new Date();
  var hh = 0, mm = 0;
  if (godzina instanceof Date) {
    hh = godzina.getHours();
    mm = godzina.getMinutes();
  } else {
    var parts = String(godzina || "00:00").split(":");
    hh = parseInt(parts[0], 10) || 0;
    mm = parseInt(parts[1], 10) || 0;
  }

  for (var i = 0; i < 14; i++) {
    var cand = new Date(teraz);
    cand.setDate(teraz.getDate() + i);
    if (allowed.indexOf(cand.getDay()) === -1) continue;
    cand.setHours(hh, mm, 0, 0);
    if (cand.getTime() > teraz.getTime()) return cand;
  }

  var fallback = new Date(teraz);
  fallback.setDate(teraz.getDate() + 7);
  fallback.setHours(hh, mm, 0, 0);
  return fallback;
}

function zaakceptujWniosek(wiersz, wykonawcaId, wykonawcaImie) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetWnioski = ss.getSheetByName("Wnioski_dyzury");
    var sheetDyzury = ss.getSheetByName("Dyżury");

    if (!sheetWnioski) return "Błąd: Brak arkusza 'Wnioski_dyzury'";
    if (!sheetDyzury) return "Błąd: Brak arkusza 'Dyżury'";

    var row = parseInt(wiersz, 10);
    if (isNaN(row) || row < 2) return "Błędny wiersz wniosku.";

    var dane = sheetWnioski.getRange(row, 1, 1, 9).getValues()[0];

    var wnioskodawcaId = String(dane[1] || "").trim();
    var wierszDyzuruWn = "";
    try {
      // kolumna J = wiersz dyżuru (10)
      wierszDyzuruWn = String(sheetWnioski.getRange(row, 10).getValue() || "").trim();
      CacheService.getScriptCache().remove("wn_dyz_open_" + wnioskodawcaId + "_" + wierszDyzuruWn);
    } catch (eCache) {}

    // Zabezpieczenie przed konfliktem interesów — nie można rozpatrzyć własnego wniosku
    if (wykonawcaId && String(wykonawcaId).trim() === wnioskodawcaId) {
      return "Nie możesz rozpatrzyć własnego wniosku — poproś o to innego opiekuna/administratora.";
    }

    var dzienLabel = String(dane[3] || "").trim();
    var godzina = _fmtWarszawa(dane[4], "HH:mm");

    var dataNowegoDyzuru = obliczDateDlaWniosku(dzienLabel, godzina);

    // Zamykamy STARY dyżur (Obowiązuje do = wczoraj) i dopisujemy nowy.
    // Preferuj wiersz z wniosku (kol. J); dodatkowo zamknij wszystkie inne
    // nadal otwarte dyżury tej osoby, żeby nie zostawały 2 aktywne.
    var tzA = _APP_TZ;
    var dzisiajD = new Date();
    var dzisiajStr = Utilities.formatDate(dzisiajD, tzA, "yyyy-MM-dd");
    var wczorajStr = Utilities.formatDate(new Date(dzisiajD.getTime() - 24 * 3600 * 1000), tzA, "yyyy-MM-dd");

    // Upewnij się, że arkusz ma kolumny D/E
    try {
      var lastColD = sheetDyzury.getLastColumn();
      if (lastColD < 5) {
        while (sheetDyzury.getLastColumn() < 5) sheetDyzury.insertColumnAfter(sheetDyzury.getLastColumn());
        sheetDyzury.getRange(1, 4).setValue("Obowiązuje od");
        sheetDyzury.getRange(1, 5).setValue("Obowiązuje do");
      }
    } catch (eCol) {}

    var dyzury = sheetDyzury.getDataRange().getValues();
    var znaleziono = false;
    var imieNazwiskoStare = "";
    var targetRow = parseInt(wierszDyzuruWn, 10);

    function _dyzurJeszczeOtwarty(doRaw) {
      if (doRaw === null || doRaw === undefined || doRaw === "") return true;
      var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
      if (isNaN(doD.getTime())) {
        // string yyyy-MM-dd
        var s = String(doRaw).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
          return s >= dzisiajStr; // obowiązuje do dnia włącznie — dziś jeszcze "aktywny" w porównaniu; zamkniemy i tak
        }
        return true;
      }
      return Utilities.formatDate(doD, tzA, "yyyy-MM-dd") >= dzisiajStr;
    }

    // Zmieniamy dokładnie JEDEN dyżur — ten wskazany w kolumnie J wniosku.
    // NIE ruszamy innych dyżurów tej osoby, bo może mieć ich więcej niż
    // jeden (np. wtorek 18:00 + środa 18:00 w różnych okresach roku).
    //
    // Jeżeli wskazany wiersz ma "Obowiązuje od" >= dziś (dyżur jeszcze się
    // nie zaczął, więc zmiana wniosku unieważnia go całkowicie) → USUŃ wiersz.
    // W przeciwnym wypadku → zamknij go datą wczorajszą.
    if (!isNaN(targetRow) && targetRow >= 2 && targetRow <= dyzury.length) {
      var idx = targetRow - 1;
      if (String(dyzury[idx][2] || "").trim() === wnioskodawcaId) {
        imieNazwiskoStare = String(dyzury[idx][1] || "");

        var odOldRaw = dyzury[idx][3];
        var odOldKey = "";
        if (odOldRaw) {
          var odOldD = odOldRaw instanceof Date ? odOldRaw : new Date(odOldRaw);
          if (!isNaN(odOldD.getTime())) {
            odOldKey = Utilities.formatDate(odOldD, tzA, "yyyy-MM-dd");
          }
        }

        // ZAMYKAMY stary dyżur (nie usuwamy) — historia musi zostać.
        // Data zamknięcia = MAX(wczoraj, "Obowiązuje od"). Dzięki temu
        // NIGDY nie powstanie wiersz "od 19.09 do 18.09" (dyżur trwałby
        // ujemnie), a wiersz zostaje w historii jako zamknięty.
        var _doValue = wczorajStr;
        if (odOldKey && odOldKey > _doValue) _doValue = odOldKey;
        sheetDyzury.getRange(targetRow, 5).setValue(_doValue);
        znaleziono = true;
      }
    }

    if (!znaleziono) {
      return "Nie znaleziono dyżuru przypisanego do tego ministranta.";
    }
    if (!imieNazwiskoStare) {
      imieNazwiskoStare = String(dane[2] || wnioskodawcaId || "").trim();
    }

    sheetDyzury.appendRow([dataNowegoDyzuru, imieNazwiskoStare, wnioskodawcaId, dzisiajStr, ""]);
    try { _invalidateCacheRfid(); } catch (eInv) {}
    SpreadsheetApp.flush();

    sheetWnioski.getRange(row, 9).setValue("ZAAKCEPTOWANO");
    sheetWnioski.getRange(row, 12).setValue(String(wykonawcaImie || wykonawcaId || "").trim());
    _logAdmin(wykonawcaId, wykonawcaImie, "WNIOSEK_DYZUR_AKCEPTACJA", wnioskodawcaId, "wiersz=" + row + " " + dzienLabel + " " + godzina);

    // >>> NOWE: push do wnioskodawcy o akceptacji wniosku o zmianę dyżuru
    try {
      var _tytA = "Wniosek o zmianę dyżuru zaakceptowany";
      var _trA  = "Twój dyżur został zmieniony na: " + dzienLabel + " " + godzina + ".";
      if (typeof _zapiszZdarzeniePowiadomienia === "function") {
        _zapiszZdarzeniePowiadomienia(wnioskodawcaId,
          "wniosek_dyzur_ok_" + row + "_" + Date.now(),
          "dyzur", "✅", _tytA, _trA, "page-wnioski");
      }
      if (typeof wyslijPowiadomienieDoUserow === "function") {
        wyslijPowiadomienieDoUserow(wnioskodawcaId, "✅ " + _tytA, _trA);
      }
    } catch (ePA) {}

    return "Wniosek zaakceptowany i dyżur został zmieniony.";
  } catch (e) {
    return "Błąd akceptacji wniosku: " + e.message;
  }
}

function odrzucWniosek(wiersz, powodOdrzucenia, wykonawcaId, wykonawcaImie) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Wnioski_dyzury");

  if (!sheet) return "Błąd: Brak arkusza 'Wnioski_dyzury'";

  var row = parseInt(wiersz);
  if (isNaN(row) || row < 2) return "Błąd: nieprawidłowy numer wiersza wniosku.";

  try {
    var idW = String(sheet.getRange(row, 2).getValue() || "").trim();
    var wD = String(sheet.getRange(row, 10).getValue() || "").trim();
    CacheService.getScriptCache().remove("wn_dyz_open_" + idW + "_" + wD);
  } catch (eCache) {}

  // Zabezpieczenie przed konfliktem interesów — nie można rozpatrzyć własnego wniosku
  var wnioskodawcaId = String(sheet.getRange(row, 2).getValue() || "").trim();
  if (wykonawcaId && String(wykonawcaId).trim() === wnioskodawcaId) {
    return "Nie możesz rozpatrzyć własnego wniosku — poproś o to innego opiekuna/administratora.";
  }

  sheet.getRange(row, 9).setValue("ODRZUCONO");
  sheet.getRange(row, 11).setValue(String(powodOdrzucenia || "").trim());
  sheet.getRange(row, 12).setValue(String(wykonawcaImie || wykonawcaId || "").trim());
  _logAdmin(wykonawcaId, wykonawcaImie, "WNIOSEK_DYZUR_ODRZUCENIE", wnioskodawcaId, String(powodOdrzucenia||""));

  // >>> NOWE: push do wnioskodawcy o odrzuceniu wniosku o zmianę dyżuru
  try {
    var _tytO = "Wniosek o zmianę dyżuru odrzucony";
    var _trO  = "Powód: " + (String(powodOdrzucenia || "").trim() || "brak");
    if (typeof _zapiszZdarzeniePowiadomienia === "function") {
      _zapiszZdarzeniePowiadomienia(wnioskodawcaId,
        "wniosek_dyzur_no_" + row + "_" + Date.now(),
        "dyzur", "❌", _tytO, _trO, "page-wnioski");
    }
    if (typeof wyslijPowiadomienieDoUserow === "function") {
      wyslijPowiadomienieDoUserow(wnioskodawcaId, "❌ " + _tytO, _trO);
    }
  } catch (ePO) {}

  return "Wniosek odrzucony";
}

// ----------------------------------------------------------------------
// POZOSTAŁE FUNKCJE ADMINISTRACYJNE
// ----------------------------------------------------------------------


/** Czy użytkownik ma już jakikolwiek wpis w arkuszu Dyżury (ten rok). */

/**
 * Jedno szybkie sprawdzenie po logowaniu:
 * - status roku formacyjnego
 * - czy użytkownik ma już dyżur (tylko gdy rok aktywny i to ministrant)
 */
function sprawdzWejsciePoLogowaniu(userId) {
  try {
    var uid = String(userId || "").trim();
    var status = getStatusRokuFormacyjnego();
    var rokAktywny = status && status.rok_aktywny !== false;
    var maDyzur = false;
    if (uid && rokAktywny) {
      var c = czyUzytkownikMaDyzur(uid);
      maDyzur = !!(c && c.ma);
    }
    return {
      sukces: true,
      rok_aktywny: rokAktywny,
      rok_nazwa: (status && status.rok_nazwa) || "",
      rok_start: (status && status.rok_start) || "",
      ma_dyzur: maDyzur
    };
  } catch (e) {
    return {
      sukces: false,
      rok_aktywny: true,
      ma_dyzur: true,
      wiadomosc: e.message
    };
  }
}

function czyUzytkownikMaDyzur(userId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: true, ma: false };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Dyżury");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, ma: false };
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][2] || "").trim() === uid) return { sukces: true, ma: true };
    }
    return { sukces: true, ma: false };
  } catch (e) {
    return { sukces: false, ma: false, wiadomosc: e.message };
  }
}

/**
 * Pierwszy wybór dyżuru na nowy rok formacyjny.
 * zapisuje jeden wiersz (najbliższy termin dnia tygodnia) — UI traktuje go jako stały cotygodniowy.
 */
function zapiszWyborDyzuruNaRok(userId, imie, dzienTygodnia, godzina) {
  try {
    var uid = String(userId || "").trim();
    var im = String(imie || "").trim();
    var dzien = parseInt(dzienTygodnia, 10);
    var godz = String(godzina || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Brak ID." };
    if (!im) return { sukces: false, wiadomosc: "Brak imienia." };
    if (!(dzien >= 1 && dzien <= 6)) return { sukces: false, wiadomosc: "Wybierz dzień tygodnia (pon–sob)." };
    if (!godz) return { sukces: false, wiadomosc: "Wybierz godzinę." };

    // Normalizacja godziny
    if (/^\d{1,2}$/.test(godz)) godz = godz + ":00";
    if (godz.indexOf(":") < 0) godz = godz + ":00";

    var check = czyUzytkownikMaDyzur(uid);
    if (check.ma) return { sukces: false, wiadomosc: "Masz już wybrany dyżur w tym roku." };

    // Najbliższa data tego dnia tygodnia (od dziś)
    var dzis = new Date();
    dzis.setHours(0, 0, 0, 0);
    var biezacy = dzis.getDay(); // 0=Nd
    var roznica = (dzien - biezacy + 7) % 7;
    var dataD = new Date(dzis);
    dataD.setDate(dzis.getDate() + roznica);

    var y = dataD.getFullYear();
    var m = String(dataD.getMonth() + 1);
    if (m.length < 2) m = "0" + m;
    var d = String(dataD.getDate());
    if (d.length < 2) d = "0" + d;
    var dataStr = y + "-" + m + "-" + d + " " + godz;

    var wynik = dodajDyzurZFrontu(dataStr, im, uid);
    if (String(wynik).indexOf("Błąd") === 0 || String(wynik).indexOf("już istnieje") >= 0) {
      return { sukces: false, wiadomosc: String(wynik) };
    }
    return { sukces: true, wiadomosc: "Dyżur zapisany: " + wynik, data: dataStr };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/**
 * Bezpiecznie wyciąga "HH:MM" z wartości arkusza (Date lub string).
 *
 * UWAGA: NIE używamy Utilities.formatDate dla wartości z 1899-12-30,
 * bo to nie jest prawdziwa data, tylko "czas-of-day" Google Sheets.
 * Warsztat w 1899 r. używał Warsaw Mean Time (UTC+1:24), więc
 * formatDate(1899-12-30 18:00, "Europe/Warsaw", "HH:mm") zwraca "19:24".
 * getHours()/getMinutes() działają w strefie PROJEKTU (bez historycznej
 * korekty), więc dla time-of-day dają poprawną godzinę.
 */
function _fixGodzina(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return "";
    var h = raw.getHours();
    var m = raw.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  return String(raw).trim();
}

function _parseDataWarsaw(str) {
  var s = String(str || "").trim();
  if (!s) return new Date();
  try { var d = Utilities.parseDate(s, "Europe/Warsaw", "yyyy-MM-dd HH:mm"); if (!isNaN(d.getTime())) return d; } catch (e1) {}
  try { var d2 = Utilities.parseDate(s, "Europe/Warsaw", "yyyy-MM-dd HH:mm:ss"); if (!isNaN(d2.getTime())) return d2; } catch (e2) {}
  try { var d3 = Utilities.parseDate(s, "Europe/Warsaw", "yyyy-MM-dd"); if (!isNaN(d3.getTime())) return d3; } catch (e3) {}
  return new Date(s);
}
function dodajDyzurZFrontu(dataFormatowana, imieNazwisko, id, obowiazujeOdStr) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetDyzury = ss.getSheetByName("Dyżury");
    if (!sheetDyzury) return "Błąd: Brak arkusza 'Dyżury'";

    // Deduplikacja — ten sam dyżur w ciągu 30s
    var existingData = sheetDyzury.getDataRange().getValues();
    var normId = String(id).trim();
    var normImie = _normalizuj(imieNazwisko);
    var normData = _normalizuj(dataFormatowana);
    for (var i = 1; i < existingData.length; i++) {
      if (_normalizuj(existingData[i][0]) === normData && String(existingData[i][2]).trim() === normId) {
        return "Taki dyżur dla tej osoby już istnieje!";
      }
    }

    // "Obowiązuje od" — domyślnie dzień dodania, chyba że podano inną datę startu.
    var tzD = _APP_TZ;
    var odDate = obowiazujeOdStr ? new Date(obowiazujeOdStr) : new Date();
    if (isNaN(odDate.getTime())) odDate = new Date();
    var odStr = Utilities.formatDate(odDate, tzD, "yyyy-MM-dd");

    var dataObj = _parseDataWarsaw(dataFormatowana);
    sheetDyzury.appendRow([dataObj, imieNazwisko, normId, odStr, ""]);
    try { _invalidateCacheRfid(); } catch (eInv) {}
    return "Dyżur stały dodany pomyślnie!";
  } catch(e) {
    return "Błąd podczas zapisu dyżuru: " + e.message;
  }
}

// Normalizacja godziny — "17" → "17:00", "17:" → "17:00"
function _normalizujGodzine(g) {
  if (!g) return g;
  var s = String(g).trim();
  if (/^\d{1,2}$/.test(s)) return s + ':00';
  if (/^\d{1,2}:$/.test(s)) return s + '00';
  return s;
}

// Dodaj pojedyncze wydarzenie lub z powtarzalnością z poziomu kliku w dzień
function dodajDoKalendarza(dataStr, wydarzenie, punkty, powtarzanie, dataKoncaStr, dzienMiesiaca, oknoOdMin, oknoDoMin) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKalendarz = ss.getSheetByName("Kalendarz");
    if (!sheetKalendarz) return "Błąd: Brak arkusza 'Kalendarz'";

    // Auto-minuty — jeśli w nazwie jest godzina, normalizuj ją
    wydarzenie = String(wydarzenie || "").trim();

    // Parsuj datę i normalizuj minuty
    var dataObj = new Date(dataStr);
    if (isNaN(dataObj.getTime())) return "Błąd: Nieprawidłowy format daty.";
    // Jeśli minuty to 0 i podano tylko godzinę — zostaw 0 (poprawne :00)

    var pkt = parseInt(punkty) || 0;

    // Deduplikacja — to samo wydarzenie+data już w arkuszu?
    var existing = sheetKalendarz.getDataRange().getValues();
    var normWyd = _normalizuj(wydarzenie);
    var dataTs = dataObj.getTime();
    for (var i = 1; i < existing.length; i++) {
      if (!existing[i][0]) continue;
      var exTs = (existing[i][0] instanceof Date ? existing[i][0] : new Date(existing[i][0])).getTime();
      if (Math.abs(exTs - dataTs) < 60000 && _normalizuj(existing[i][1]) === normWyd) {
        return "To wydarzenie zostało już dodane do kalendarza!";
      }
    }

    // Jednorazowe lub brak powtarzania
    if (!powtarzanie || powtarzanie === 'brak') {
      sheetKalendarz.appendRow([dataObj, wydarzenie, pkt]);
      // Jeśli to Uroczystość/Triduum — wyślij OneSignal z prośbą o zgłoszenie dostępności
      var typSmall = wydarzenie.toLowerCase();
      if (typSmall.includes('triduum') || typSmall.includes('uroczystoś') || typSmall.includes('uroczystos')) {
        var dataPl = Utilities.formatDate(dataObj, _APP_TZ, "dd.MM.yyyy HH:mm");
        wyslijPowiadomienieDostepnosc(wydarzenie, dataPl);
      }
      return "Dodano wydarzenie do kalendarza!";
    }

    // Powtarzające się — użyj istniejącej funkcji
    return dodajPowtarzajaceWydarzenia(dataStr, wydarzenie, pkt, powtarzanie, dataKoncaStr || dataStr, dzienMiesiaca, "", oknoOdMin, oknoDoMin);
  } catch(e) {
    return "Błąd: " + e.message;
  }
}

/**
 * Dodaje JEDNORAZOWY dyżur w niedzielę o 18:00 (+7 pkt).
 * Zapisuje wiersz w arkuszu Dyżury z:
 *   Data i Godzina    = ta niedziela, 18:00
 *   Obowiązuje od     = ten dzień
 *   Obowiązuje do     = ten dzień (=== od → rozpoznawane jako jednorazowy)
 *
 * Tylko administrator. Waliduje: data musi być niedzielą.
 *
 * @param {string} wykonawcaId  ID admina dodającego
 * @param {string} dataISO      YYYY-MM-DD (musi być niedziela)
 * @param {string} userId       ID ministranta
 * @param {string} imieNazwisko Imię i nazwisko (opcjonalne, wypełni z bazy)
 */
function dodajDyzurJednorazowy(wykonawcaId, dataISO, userId, imieNazwisko) {
  try {
    var execId = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(execId));
    if (rola !== "ADMIN") {
      return { sukces: false, wiadomosc: "Tylko administrator może dodawać dyżury jednorazowe." };
    }
    var uid = _normId(userId);
    if (!uid) return { sukces: false, wiadomosc: "Wybierz ministranta." };

    var dataStr = String(dataISO || "").trim();
    var m = dataStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { sukces: false, wiadomosc: "Data musi być w formacie YYYY-MM-DD." };

    var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 18, 0, 0, 0);
    if (isNaN(d.getTime())) return { sukces: false, wiadomosc: "Niepoprawna data." };

    if (d.getDay() !== 0) {
      return { sukces: false, wiadomosc: "Dyżur jednorazowy może być tylko w niedzielę." };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetD = ss.getSheetByName("Dyżury");
    if (!sheetD) return { sukces: false, wiadomosc: "Brak arkusza Dyżury." };

    // Sprawdź czy ta osoba ma już jakikolwiek dyżur w tym dniu
    var dane = sheetD.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][2] || "").trim() !== uid) continue;
      if (!dane[i][0]) continue;
      var dtRow = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
      if (isNaN(dtRow.getTime())) continue;
      if (dtRow.getFullYear() === d.getFullYear() &&
          dtRow.getMonth() === d.getMonth() &&
          dtRow.getDate() === d.getDate()) {
        return { sukces: false, wiadomosc: "Ta osoba ma już dyżur w tym dniu." };
      }
    }

    var imie = String(imieNazwisko || "").trim();
    if (!imie) {
      try {
        var dk = _pobierzDaneKandydaci();
        for (var k = 1; k < dk.length; k++) {
          if (_normId(dk[k][0]) === uid) {
            imie = String(dk[k][1] || "").trim();
            break;
          }
        }
      } catch (eN) {}
    }
    if (!imie) imie = uid;

    var dataKey = Utilities.formatDate(d, _APP_TZ, "yyyy-MM-dd");

    // Zapis: Data i Godzina | Imię | ID | Obowiązuje od | Obowiązuje do
    // od === do → rozpoznawane jako JEDNORAZOWY (patrz _dyzurUseraWTygodniu)
    sheetD.appendRow([d, imie, uid, dataKey, dataKey]);
    try { _invalidateCacheRfid(); } catch (eInv) {}
    _logAdmin(execId, "", "DODAJ_DYZUR_JEDNORAZOWY", uid + " / " + imie,
              dataKey + " 18:00 (niedziela, +7 pkt)");

    return {
      sukces: true,
      data: dataKey,
      godzina: "18:00",
      imie: imie,
      wiadomosc: "Dodano jednorazowy dyżur: " + imie + " — niedziela " + dataKey + " 18:00 (+7 pkt)."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

function usunDyzur(wiersz) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetDyzury = ss.getSheetByName("Dyżury");
    if(sheetDyzury) {
      sheetDyzury.deleteRow(parseInt(wiersz));
      try { _invalidateCacheRfid(); } catch (eInv) {}
      return "Usunięto stały dyżur z bazy!";
    }
    return "Błąd: Brak arkusza 'Dyżury'";
  } catch(e) {
    return "Błąd usuwania dyżuru: " + e.message;
  }
}

function dodajWpisReczny(id, wydarzenie, punkty, opis, wykonawcaId, wykonawcaImie) {
  var wymaganyOpis = ["Pomoc w parafii", "Inny powód", "Dowolny powód"];
  if (wymaganyOpis.includes(wydarzenie) && (!opis || String(opis).trim() === "")) {
    return "Błąd: Przy tej akcji musisz podać szczegóły (opis)!";
  }

  // Księża nie uczestniczą w systemie punktowym (lektorzy TAK).
  try {
    var _rk = String(pobierzRoleUzytkownika(id) || "").toUpperCase();
    if (_rk === "KSIADZ" || _rk.indexOf("KSI") === 0) {
      return "Księżom nie nadaje się punktów!";
    }
  } catch (eKs) {}
  try {
    var ssK = SpreadsheetApp.getActiveSpreadsheet();
    var shK = ssK.getSheetByName("Kandydaci");
    if (shK) {
      var dk = shK.getDataRange().getValues();
      for (var ik = 1; ik < dk.length; ik++) {
        if (String(dk[ik][0] || "").trim() !== String(id || "").trim()) continue;
        var rg = String(dk[ik][6] || "").toLowerCase();
        if (rg.indexOf("ksi") === 0) return "Księżom nie nadaje się punktów!";
        break;
      }
    }
  } catch (eK2) {}

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetReczne = ss.getSheetByName("Logi_ręczne");
  if (!sheetReczne) return "Błąd: Brak arkusza 'Logi_ręczne'";
  _upewnijSieOKolumnyWykonawcy(sheetReczne);

  // Deduplikacja — ten sam wpis dla tego samego ID w ciągu 30 sekund
  var teraz = new Date().getTime();
  var istniejace = sheetReczne.getDataRange().getValues();
  for (var i = istniejace.length - 1; i >= 1; i--) {
    if (!istniejace[i][0]) continue;
    var ts = (istniejace[i][0] instanceof Date ? istniejace[i][0] : new Date(istniejace[i][0])).getTime();
    if (teraz - ts > 30000) break;
    if (String(istniejace[i][1]).trim() === String(id).trim() && _normalizuj(istniejace[i][2]) === _normalizuj(wydarzenie)) {
      return "Ten wpis został właśnie dodany. Odczekaj chwilę przed ponownym zapisem.";
    }
  }

  var now = new Date();
  var dataStr = Utilities.formatDate(now, _APP_TZ, "yyyy-MM-dd HH:mm:ss");
  var samodzielnie = wykonawcaId && String(wykonawcaId).trim() === String(id).trim();

  // PATCH-2026-10-NAN-PUNKTY
  var _pktNaprawione = _naprawPunktyNaN(wydarzenie, punkty);
  sheetReczne.appendRow([
    dataStr, id, wydarzenie, _pktNaprawione, opis,
    String(wykonawcaId || "").trim(),
    String(wykonawcaImie || "").trim() + (samodzielnie ? " (przyznane samodzielnie)" : "")
  ]);
  przeliczPunktyUzytkownika(id);
  _logAdmin(wykonawcaId, wykonawcaImie, "WPIS_RECZNY", String(id||""), String(wydarzenie||"") + " " + String(punkty||"") + " " + String(opis||""));

  // >>> NOWE: push NATYCHMIAST przy każdym ręcznym wpisie (dodatnim i ujemnym).
  //     Pomijamy tylko „sam sobie" — admin już wie, push byłby zdublowaniem.
  try {
    var _pktI = parseInt(punkty, 10);
    if (!isNaN(_pktI) && _pktI !== 0 && !samodzielnie && String(id).trim() !== String(wykonawcaId || "").trim()) {
      var _newP = 0;
      try {
        var _shP = ss.getSheetByName("Kandydaci");
        if (_shP) {
          var _dP = _shP.getDataRange().getValues();
          for (var _pi = 1; _pi < _dP.length; _pi++) {
            if (String(_dP[_pi][0] || "").trim() === String(id).trim()) {
              _newP = parseInt(_dP[_pi][2], 10) || 0;
              break;
            }
          }
        }
      } catch (eP1) {}

      var _ikl = _pktI < 0 ? "📉" : "📈";
      var _tyt = _pktI < 0 ? "Kara punktowa" : "Zdobyłeś punkty!";
      var _tr = (_pktI > 0 ? "+" : "") + _pktI + " pkt — " + String(wydarzenie || "") +
                (opis ? (" (" + String(opis).substring(0, 100) + ")") : "") +
                ". Nowa suma: " + _newP + " pkt.";
      if (typeof _pushNatychmiast === "function") {
        _pushNatychmiast(
          String(id).trim(), _ikl, _tyt, _tr, "points", "page-profile",
          "points_" + (_pktI < 0 ? "loss" : "gain") + "_" + String(id).trim() + "_" + Date.now()
        );
      }
    }
  } catch (ePushRec) {}


  // Duplikat push usunięty — _pushNatychmiast powyżej robi to samo
  // i jeszcze pisze klucz do Powiadomienia_wyslane (dzwonek bez duplikacji).

  return samodzielnie
    ? "Zapisano pomyślnie. Uwaga: przyznałeś punkty samemu sobie — wpis jest oznaczony w historii jako samodzielny."
    : "Zapisano pomyślnie i przeliczono punkty!";
}

// Dopisuje nagłówki kolumn "Wykonawca ID" / "Wykonawca Imię", jeśli arkusz Logi_ręczne
// pochodzi jeszcze ze starszej wersji bez tych kolumn (migracja "w locie").
function _upewnijSieOKolumnyWykonawcy(sheet) {
  if (sheet.getLastColumn() < 7) {
    sheet.getRange(1, 6).setValue("Wykonawca ID");
    sheet.getRange(1, 7).setValue("Wykonawca Imię");
  }
}

// PRZERWA TECHNICZNA (tylko ID=1)
// ----------------------------------------------------------------------
// Arkusz "Status_Serwisu" jest głównym źródłem prawdy.
// PropertiesService jest cache/fallback.

function _pobierzAlboUtworzArkuszStatusSerwisu() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Status_Serwisu");
  if (!sheet) {
    sheet = ss.insertSheet("Status_Serwisu");
    sheet.appendRow(["Klucz", "Wartość", "Opis"]);
    sheet.appendRow(["przerwa",      "FALSE", "Baner przerwy technicznej — TRUE lub FALSE"]);
    sheet.appendRow(["blokada",      "FALSE", "Blokada dostępu — TRUE samo w sobie blokuje wejście, niezależnie od 'przerwa'"]);
    sheet.appendRow(["opis_przerwy", "",      "Treść banera (puste = domyślny komunikat)"]);
    sheet.appendRow(["opis_blokady", "",      "Treść ekranu blokady (puste = domyślny komunikat)"]);
    sheet.appendRow(["app_wersja",           "", "Wersja aplikacji widoczna w Ustawienia → Informacje"]);
    sheet.appendRow(["app_data_publikacji",  "", "Data publikacji wersji (YYYY-MM-DD)"]);
    sheet.appendRow(["app_autor",            "Mateusz Droż", "Autor aplikacji widoczny w Informacjach"]);
    sheet.appendRow(["app_licencja",         "GPL-2.0", "Licencja aplikacji"]);
    sheet.appendRow(["app_github",           "https://github.com/MateuszDroz/PanelMinistrant-w", "Adres repozytorium"]);
    sheet.appendRow(["app_discord",          "https://discord.gg/MeeUAtsap9", "Adres Discorda"]);
    try {
      sheet.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#e8f0fe");
      sheet.setColumnWidth(1, 160);
      sheet.setColumnWidth(2, 100);
      sheet.setColumnWidth(3, 340);
      sheet.setFrozenRows(1);
    } catch (eFmt) {}
  }
  return sheet;
}

/**
 * Zamienia datę z arkusza (Date, ISO, "15.09.2026", "2026-09-15",
 * "Tue Sep 15 2026 …") na jednolity format dd.MM.yyyy.
 * Puste / nierozpoznane → zwraca oryginalny string (bezpieczny fallback).
 */
function _formatujDateInfo(v) {
  if (v === null || v === undefined || v === "") return "";
  var s = String(v).trim();
  if (!s) return "";

  // Już w formacie dd.MM.yyyy — zostaw
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) return s;

  var d = null;
  // Rzeczywisty obiekt Date
  if (v instanceof Date) {
    d = v;
  } else if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
    // ISO yyyy-mm-dd (Sheets czasem zwraca taki format)
    d = new Date(s);
  } else {
    // "Tue Sep 15 2026 02:00:00 GMT+0200" albo inny parseable format
    var t = Date.parse(s);
    if (!isNaN(t)) d = new Date(t);
  }

  if (!d || isNaN(d.getTime())) return s; // nierozpoznane — oddaj jak leci

  var dd = String(d.getDate());    if (dd.length < 2) dd = "0" + dd;
  var mm = String(d.getMonth()+1); if (mm.length < 2) mm = "0" + mm;
  return dd + "." + mm + "." + d.getFullYear();
}

function _czytajStatusSerwisu() {
  try {
    var sheet = _pobierzAlboUtworzArkuszStatusSerwisu();
    var dane = sheet.getDataRange().getValues();
    var map = {};
    for (var i = 1; i < dane.length; i++) {
      var k = String(dane[i][0] || "").trim().toLowerCase();
      var v = String(dane[i][1] || "").trim();
      if (k) map[k] = v;
    }
    // Auto-migracja — dopisz brakujące wiersze, żeby stare arkusze
    // (utworzone przed wprowadzeniem tej funkcji) też działały.
    // Admin uzupełnia potem wartości w kolumnie B ręcznie.
    var wymagane = [
      ["app_wersja",          "",                                                                  "Wersja aplikacji widoczna w Ustawienia → Informacje"],
      ["app_data_publikacji", "",                                                                  "Data publikacji wersji (YYYY-MM-DD)"],
      ["app_autor",           "Mateusz Droż",                                                     "Autor aplikacji widoczny w Informacjach"],
      ["app_licencja",        "GPL-2.0",                                                           "Licencja aplikacji"],
      ["app_github",          "https://github.com/MateuszDroz/PanelMinistrant-w",                 "Adres repozytorium"],
      ["app_discord",         "https://discord.gg/MeeUAtsap9",                                    "Adres Discorda"]
    ];
    for (var j = 0; j < wymagane.length; j++) {
      var key = wymagane[j][0];
      if (map[key] === undefined) {
        sheet.appendRow(wymagane[j]);
        map[key] = wymagane[j][1];
      }
    }
    return map;
  } catch (e) {
    return {};
  }
}

function _zapiszStatusSerwisu(klucz, wartosc) {
  try {
    var sheet = _pobierzAlboUtworzArkuszStatusSerwisu();
    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0] || "").trim().toLowerCase() === String(klucz).toLowerCase()) {
        sheet.getRange(i + 1, 2).setValue(wartosc);
        return;
      }
    }
    sheet.appendRow([klucz, wartosc, ""]);
  } catch (e) {}
}

function getPrzerwaTechniczna() {
  try {
    var statusMap = _czytajStatusSerwisu();
    var props = PropertiesService.getScriptProperties();
    var aktywna, permanentna, wiadomosc, opisBlokady;

    if (Object.keys(statusMap).length > 0) {
      // Arkusz jest źródłem prawdy
      permanentna = String(statusMap["blokada"] || "").toUpperCase() === "TRUE";
      // "blokada" jest niezależnym przełącznikiem — jeśli jest TRUE, to sama
      // w sobie aktywuje tryb przerwy, nawet gdy "przerwa" (baner) jest FALSE.
      aktywna    = (String(statusMap["przerwa"] || "").toUpperCase() === "TRUE") || permanentna;
      wiadomosc  = statusMap["opis_przerwy"] || "";
      opisBlokady = statusMap["opis_blokady"] || "";
      // Synchronizuj z PropertiesService (cache)
      props.setProperty("przerwa_techniczna",   aktywna    ? "true" : "false");
      props.setProperty("przerwa_permanentna",  permanentna ? "true" : "false");
      props.setProperty("przerwa_wiadomosc",    wiadomosc);
      props.setProperty("przerwa_opis_blokady", opisBlokady);
    } else {
      // Fallback do PropertiesService (ta sama zasada: blokada => aktywna)
      permanentna = props.getProperty("przerwa_permanentna")  === "true";
      aktywna     = (props.getProperty("przerwa_techniczna") === "true") || permanentna;
      wiadomosc   = props.getProperty("przerwa_wiadomosc")    || "";
      opisBlokady = props.getProperty("przerwa_opis_blokady") || "";
    }

    return {
      aktywna:     aktywna,
      permanentna: permanentna,
      wiadomosc:   wiadomosc,
      opisBlokady: opisBlokady
    };
  } catch(e) {
    return { aktywna: false, permanentna: false, wiadomosc: "", opisBlokady: "" };
  }
}

function setPrzerwaTechniczna(aktywna, permanentna, wiadomosc, wykonawcaId, opisBlokady) {
  try {
    // Przerwa techniczna: może nią zarządzać każdy ADMIN (oraz konto 2212).
    // Ksiądz i pozostali użytkownicy — brak uprawnień.
    var uidP = String(wykonawcaId || "").trim();
    var is2212 = (uidP === "2212");
    var rolaP = _normalizujRole(pobierzRoleUzytkownika(uidP));
    if (!is2212 && rolaP !== "ADMIN") {
      return { aktywna: false, permanentna: false, wiadomosc: "", opisBlokady: "",
               blad: "Tylko administrator może zarządzać przerwą techniczną." };
    }
    var props = PropertiesService.getScriptProperties();
    var wiad = String(wiadomosc   || "").trim();
    var opisB = String(opisBlokady || "").trim();

    props.setProperty("przerwa_techniczna",   aktywna ? "true" : "false");
    if (!aktywna) {
      props.setProperty("przerwa_permanentna",  "false");
      props.setProperty("przerwa_wiadomosc",    "");
      props.setProperty("przerwa_opis_blokady", "");
    } else {
      props.setProperty("przerwa_permanentna",  permanentna ? "true" : "false");
      props.setProperty("przerwa_wiadomosc",    wiad);
      props.setProperty("przerwa_opis_blokady", opisB);
    }

    // Zapisz do arkusza (pierwotne źródło)
    try {
      _zapiszStatusSerwisu("przerwa",      aktywna ? "TRUE" : "FALSE");
      _zapiszStatusSerwisu("blokada",      (aktywna && permanentna) ? "TRUE" : "FALSE");
      _zapiszStatusSerwisu("opis_przerwy", aktywna ? wiad  : "");
      _zapiszStatusSerwisu("opis_blokady", aktywna ? opisB : "");
    } catch (eSheet) {}

    _logAdmin(uidP, "", aktywna ? "PRZERWA_ON" : "PRZERWA_OFF", "",
      wiad + (permanentna ? " | blokada" : " | baner") + (opisB ? " | opisBlokady: " + opisB : ""));

    return {
      aktywna:     !!aktywna,
      permanentna: !!(aktywna && permanentna),
      wiadomosc:   aktywna ? wiad  : "",
      opisBlokady: aktywna ? opisB : ""
    };
  } catch(e) {
    return { aktywna: false, permanentna: false, wiadomosc: "", opisBlokady: "", blad: e.message };
  }
}

// Usuwa starsze wpisy cykliczne, dodane zanim wystąpienia zaczęły
// dostawać wspólne ID grupy (kolumna E jest dla nich pusta) — dopasowanie
// po nazwie + punktach + opisie, analogicznie do zbudujListePlanow() w JS.
function usunPowtarzajaceLegacy(wydarzenie, punkty, opis) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kalendarz");
    if (!sheet) return "Błąd: Brak arkusza 'Kalendarz'";

    var wydNorm = String(wydarzenie || "").trim();
    var pktNorm = parseInt(punkty) || 0;
    var opisNorm = String(opis || "").trim();

    var data = sheet.getDataRange().getValues();
    var wierszeDoUsuniecia = [];
    for (var i = 1; i < data.length; i++) {
      var maGroupId = String(data[i][4] || "").trim() !== "";
      if (maGroupId) continue; // to obsługuje usunGrupePowtarzajacych, nie ta funkcja
      if (String(data[i][1] || "").trim() !== wydNorm) continue;
      if ((parseInt(data[i][2]) || 0) !== pktNorm) continue;
      if (String(data[i][3] || "").trim() !== opisNorm) continue;
      wierszeDoUsuniecia.push(i + 1);
    }
    if (wierszeDoUsuniecia.length === 0) return "Nie znaleziono pasujących wydarzeń.";

    wierszeDoUsuniecia.sort(function(a, b) { return b - a; });
    wierszeDoUsuniecia.forEach(function(w) { sheet.deleteRow(w); });

    return "Usunięto " + wierszeDoUsuniecia.length + " wystąpień z cyklu.";
  } catch(e) {
    return "Błąd: " + e.message;
  }
}

function dodajDoKalendarza(dataStr, wydarzenie, punkty, opis, oknoOdMin, oknoDoMin) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKalendarz = ss.getSheetByName("Kalendarz");
    if (!sheetKalendarz) return "Błąd: Brak arkusza 'Kalendarz'";

    // Upewnij się, że arkusz ma kolumny G/H (OknoOdMin / OknoDoMin).
    _upewnijNaglowkiKalendarza(sheetKalendarz);

    // Puste pole w formularzu → "" (null) → fallback na domyślne okno w _oknoCzasoweMszy.
    var _oOd = (typeof oknoOdMin === "number" && !isNaN(oknoOdMin) && oknoOdMin >= 0) ? oknoOdMin : "";
    var _oDo = (typeof oknoDoMin === "number" && !isNaN(oknoDoMin) && oknoDoMin >= 0) ? oknoDoMin : "";

    // Kolumny E (ID grupy) i F (etykieta) puste — to wydarzenie jednorazowe.
    sheetKalendarz.appendRow([
      dataStr, wydarzenie, parseInt(punkty), String(opis || "").trim(),
      "", "", _oOd, _oDo
    ]);
    return "Uroczystość dodana do kalendarza!";
  } catch (e) {
    return "Błąd: " + (e && e.message ? e.message : e);
  }
}

function usunZKalendarza(wiersz) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetKalendarz = ss.getSheetByName("Kalendarz");
  if(sheetKalendarz) {
    sheetKalendarz.deleteRow(parseInt(wiersz));
    return "Usunięto z kalendarza!";
  }
  return "Błąd usuwania.";
}

// Usuwa WSZYSTKIE wystąpienia wydarzenia cyklicznego naraz (po ID grupy
// nadanym w dodajPowtarzajaceWydarzenia), zamiast pojedynczego wiersza.
function usunGrupePowtarzajacych(groupId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kalendarz");
    if (!sheet) return "Błąd: Brak arkusza 'Kalendarz'";
    if (!groupId) return "Błąd: Brak identyfikatora grupy.";

    var data = sheet.getDataRange().getValues();
    var wierszeDoUsuniecia = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][4] || "") === String(groupId)) {
        wierszeDoUsuniecia.push(i + 1); // numer wiersza w arkuszu (1-indeksowany)
      }
    }
    if (wierszeDoUsuniecia.length === 0) return "Nie znaleziono wydarzeń z tej serii.";

    // Usuwamy od najwyższego numeru wiersza, żeby usuwanie nie przesuwało
    // indeksów kolejnych wierszy, które jeszcze trzeba skasować.
    wierszeDoUsuniecia.sort(function(a, b) { return b - a; });
    wierszeDoUsuniecia.forEach(function(w) { sheet.deleteRow(w); });

    return "Usunięto " + wierszeDoUsuniecia.length + " wystąpień z cyklu.";
  } catch(e) {
    return "Błąd: " + e.message;
  }
}

function aktualizujProfil(id, funkcje, dodatkowe, uwagi, ranga, wykonawcaId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetKandydaci = ss.getSheetByName("Kandydaci");
  var dataKandydaci = sheetKandydaci.getDataRange().getValues();
  // >>> DRUGIE ID: resolve do głównego, żeby zapis trafił do właściwego wiersza.
  var targetId = String(_resolvePrimaryId(id) || id).trim();
  var execId = String(wykonawcaId || "").trim();

  if (execId) {
    var rolaExec = String(pobierzRoleUzytkownika(execId) || "").toUpperCase();
    var jestAdmin = (rolaExec.indexOf("ADMIN") === 0);
    if (execId === targetId && !jestAdmin) {
      return "Nie możesz edytować własnego profilu.";
    }
    if (typeof ranga !== "undefined" && ranga !== null && ranga !== "" && !jestAdmin) {
      ranga = "";
    }
  }
  if (String(ranga || "").trim() === "Lektor starszy") ranga = "Lektor";
  
  for (var i = 1; i < dataKandydaci.length; i++) {
    if (String(dataKandydaci[i][0]).trim() === targetId) {
      sheetKandydaci.getRange(i + 1, 4).setValue(funkcje);      
      sheetKandydaci.getRange(i + 1, 5).setValue(dodatkowe);     
      sheetKandydaci.getRange(i + 1, 6).setValue(uwagi);
      if (typeof ranga !== "undefined" && ranga !== null && ranga !== "") {
        sheetKandydaci.getRange(i + 1, 7).setValue(ranga);
        zsynchronizujRoleZRanga(targetId, ranga);
      }
      _cInvalidateKandydaci();
      _cInvalidateRola(targetId);
      return "Zaktualizowano profil pomyślnie!";
    }
  }
  return "Nie znaleziono użytkownika";
}

// ----------------------------------------------------------------------
// JEDNORAZOWA MIGRACJA: podział rangi "Lektor" na "Lektor młodszy" / "Lektor starszy"
// ----------------------------------------------------------------------
// Uruchom RAZ ręcznie (z edytora Apps Script: wybierz tę funkcję i kliknij "Uruchom"),
// żeby wszyscy dotychczasowi "Lektorzy" w arkuszu "Kandydaci" otrzymali nową,
// domyślną podrangę "Lektor młodszy". Obie podrangi mają na razie te same
// uprawnienia (patrz rolaMap w zsynchronizujRoleZRanga), więc migracja jest
// czysto kosmetyczna/porządkowa i nic w aplikacji się od razu nie zmieni.
function migrujRangeLektorNaMlodszy() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetKandydaci = ss.getSheetByName("Kandydaci");
  if (!sheetKandydaci) return "Brak arkusza 'Kandydaci'.";
  var dane = sheetKandydaci.getDataRange().getValues();
  var zmienione = 0;
  for (var i = 1; i < dane.length; i++) {
    if (String(dane[i][6] || "").trim() === "Lektor") {
      sheetKandydaci.getRange(i + 1, 7).setValue("Lektor młodszy");
      zmienione++;
    }
  }
  return "Zmigrowano " + zmienione + " osób z rangi 'Lektor' na 'Lektor młodszy'.";
}

/** Jednorazowa migracja: "Lektor starszy" → "Lektor". */
function migrujLektorStarszyNaLektor() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Kandydaci");
  if (!sheet) return "Brak arkusza Kandydaci.";
  var dane = sheet.getDataRange().getValues();
  var n = 0;
  for (var i = 1; i < dane.length; i++) {
    if (String(dane[i][6] || "").trim() === "Lektor starszy") {
      sheet.getRange(i + 1, 7).setValue("Lektor");
      zsynchronizujRoleZRanga(String(dane[i][0]).trim(), "Lektor");
      n++;
    }
  }
  return "Zmigrowano " + n + " osób: Lektor starszy → Lektor.";
}


function zsynchronizujRoleZRanga(id, ranga) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetHasla = ss.getSheetByName("Hasła");
    if (!sheetHasla) return;

    // Mapowanie rangi na rolę
    // "Lektor młodszy" i "Lektor starszy" mają na razie IDENTYCZNE uprawnienia
    // (obie mapują się na wewnętrzną rolę "LEKTOR") — rozdzielenie przyda się
    // w przyszłości, gdyby trzeba było różnicować uprawnienia między nimi.
    var rolaMap = {
      "Lektor młodszy": "LEKTOR",
      "Lektor starszy": "LEKTOR",
      "Lektor": "LEKTOR",
      "Ministrant": "MINISTRANT",
      "Kandydat":   "MINISTRANT",
      "Ksiądz":     "KSIADZ",
      "Ksiadz":     "KSIADZ"
    };
    var nowaRola = rolaMap[ranga];
    if (!nowaRola) return; // Nieznana ranga — nie nadpisuj

    var dane = sheetHasla.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === String(id).trim()) {
        // Nie ruszaj, jeśli kolumna F = TAK (admin niezależny od rangi)
        if (_czyFlagaAdmin(dane[i][5])) return;
        var obecnaRola = String(dane[i][4]).toUpperCase().trim();
        if (obecnaRola === "ADMIN") return;
        sheetHasla.getRange(i + 1, 5).setValue(nowaRola);
        _cInvalidateRola(id);
        return;
      }
    }
  } catch(e) {
    // Ignoruj błędy synchronizacji — nie blokuj zapisu profilu
  }
}

function _safeFormatDateTS(ts, fmt) {
  if (!ts) return "";
  try {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return Utilities.formatDate(d, _APP_TZ, fmt || "dd.MM.yyyy HH:mm");
  } catch (e) { return ""; }
}

function getHistoriaUzytkownika(id) {
  var historia = [];
  var MAX_WYNIK = 100;
  var SKAN_LIMIT = 2000;

  var targetId = "";
  try { targetId = String(_resolvePrimaryId(id) || id || "").trim(); }
  catch (e) { targetId = String(id || "").trim(); }
  if (!targetId) return { success: true, dane: [] };

  function _parseTs(raw) {
    if (!raw) return 0;
    if (raw instanceof Date) return isNaN(raw.getTime()) ? 0 : raw.getTime();
    var s = String(raw).trim();
    if (!s) return 0;
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d.getTime();
    var m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/);
    if (m) {
      var dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yy = parseInt(m[3], 10);
      var hh = m[4] ? parseInt(m[4], 10) : 0;
      var mi = m[5] ? parseInt(m[5], 10) : 0;
      var d2 = new Date(yy, mm - 1, dd, hh, mi, 0, 0);
      if (!isNaN(d2.getTime())) return d2.getTime();
    }
    return 0;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    try {
      var shC = ss.getSheetByName("Logi_czytnik");
      if (shC && shC.getLastRow() > 1) {
        var lrC = shC.getLastRow();
        var startC = Math.max(2, lrC - SKAN_LIMIT + 1);
        var numC = lrC - startC + 1;
        var colsC = Math.max(6, shC.getLastColumn());
        var dC = shC.getRange(startC, 1, numC, colsC).getValues();
        for (var i = 0; i < dC.length; i++) {
          try {
            var rC = dC[i];
            if (!rC || rC.length < 2) continue;
            if (String(rC[1] || "").trim() !== targetId) continue;
            var tsC = _parseTs(rC[0]);
            if (!tsC) continue;
            historia.push({
              timestamp: tsC,
              tekst: '<strong>' + String(rC[4] || "") + '</strong><br><span style="color:gray; font-size:12px;">Czytnik: ' + String(rC[3] || "") + '</span>',
              punkty: parseInt(rC[5], 10) || 0,
              data: _safeFormatDateTS(tsC)
            });
          } catch (eRow) {}
        }
      }
    } catch (eCzyt) {}

    try {
      var shR = ss.getSheetByName("Logi_ręczne");
      if (shR && shR.getLastRow() > 1) {
        var lrR = shR.getLastRow();
        var startR = Math.max(2, lrR - SKAN_LIMIT + 1);
        var numR = lrR - startR + 1;
        var colsR = Math.max(7, shR.getLastColumn());
        var dR = shR.getRange(startR, 1, numR, colsR).getValues();
        for (var j = 0; j < dR.length; j++) {
          try {
            var rR = dR[j];
            if (!rR || rR.length < 2) continue;
            if (String(rR[1] || "").trim() !== targetId) continue;
            var tsR = _parseTs(rR[0]);
            if (!tsR) continue;
            var wId = String(rR[5] || "").trim();
            var wIm = String(rR[6] || "").trim();
            var sam = wId && wId === targetId;
            var ety = wIm ? ' <span style="color:' + (sam ? '#e41e3f' : 'gray') + '; font-size:11px;">' + (sam ? '⚠️ przyznane samodzielnie' : 'przyznał: ' + wIm.replace(' (przyznane samodzielnie)','')) + '</span>' : "";
            var opis;
            try { opis = _formatujOpisLogu(rR[4]); } catch (e) { opis = String(rR[4] || ""); }
            historia.push({
              timestamp: tsR,
              tekst: '<strong>' + String(rR[2] || "") + '</strong><br><span style="color:gray; font-size:12px;">' + opis + '</span>' + ety,
              punkty: parseInt(rR[3], 10) || 0,
              data: _safeFormatDateTS(tsR)
            });
          } catch (eRow2) {}
        }
      }
    } catch (eRecz) {}

    historia.sort(function (a, b) { return b.timestamp - a.timestamp; });
    if (historia.length > MAX_WYNIK) historia = historia.slice(0, MAX_WYNIK);
    return { success: true, dane: historia };
  } catch (e) {
    try { console.log("[getHistoria] " + e); } catch (e2) {}
    return { success: true, dane: historia };
  }
}

function przeliczPunktyUzytkownika(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetKandydaci = ss.getSheetByName("Kandydaci");
  var sheetCzytnik = ss.getSheetByName("Logi_czytnik");
  var sheetReczne = ss.getSheetByName("Logi_ręczne");
  // >>> DRUGIE ID: resolve do głównego, żeby nie zapisać punktów w drugim wierszu.
  var targetId = String(_resolvePrimaryId(id) || id).trim();
  var suma = 0;
  // >>> PUNKTY-RESET (v1): pomijaj logi sprzed resetu punktów (jeśli ustawiony).
  var _resetTsP = (typeof _punktyResetTs === "function") ? _punktyResetTs() : 0;
  var _logTsP = function(raw) {
    if (raw instanceof Date) return isNaN(raw.getTime()) ? 0 : raw.getTime();
    var d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };
  
  if (sheetCzytnik) {
    var logiCzytnik = sheetCzytnik.getDataRange().getValues();
    for (var i = 1; i < logiCzytnik.length; i++) {
      if (logiCzytnik[i][1] && String(logiCzytnik[i][1]).trim() === targetId) {
        if (_resetTsP > 0) {
          var _tsCzP = _logTsP(logiCzytnik[i][0]);
          if (_tsCzP > 0 && _tsCzP < _resetTsP) continue;
        }
        suma += parseInt(logiCzytnik[i][5]) || 0; 
      }
    }
  }
  
  if (sheetReczne) {
    var logiReczne = sheetReczne.getDataRange().getValues();
    for (var j = 1; j < logiReczne.length; j++) {
      if (logiReczne[j][1] && String(logiReczne[j][1]).trim() === targetId) {
        if (_resetTsP > 0) {
          var _tsReP = _logTsP(logiReczne[j][0]);
          if (_tsReP > 0 && _tsReP < _resetTsP) continue;
        }
        suma += parseInt(logiReczne[j][3]) || 0; 
      }
    }
  }
  
  var dataKandydaci = sheetKandydaci.getDataRange().getValues();
  for (var k = 1; k < dataKandydaci.length; k++) {
    if (String(dataKandydaci[k][0]).trim() === targetId) {
      try { _cRemove("kandydaci_raw"); } catch (eC) {}
      var ranga = String(dataKandydaci[k][6] || "").trim();
      var lowRanga = ranga.toLowerCase();
      var wartoscDoZapisu = (lowRanga.indexOf("ksi") === 0) ? 0 : suma;
      sheetKandydaci.getRange(k + 1, 3).setValue(wartoscDoZapisu);
      break;
    }
  }
}
// ----------------------------------------------------------------------
// MASOWE DODAWANIE / ODEJMOWANIE PUNKTÓW
// ----------------------------------------------------------------------

// Sprawdza czy dany ID należy do osoby z rangą lektorską (lektorzy nie uczestniczą w punktacji).
// Obejmuje obie podrangi: "Lektor młodszy" i "Lektor starszy".
function _czyRangaLektor(id) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKandydaci = ss.getSheetByName("Kandydaci");
    if (!sheetKandydaci) return false;
    var dane = sheetKandydaci.getDataRange().getValues();
    var targetId = String(id).trim();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === targetId) {
        return String(dane[i][6] || "").trim().indexOf("Lektor") === 0;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

function dodajPunktyMasowo(listaId, wydarzenie, punkty, opis, wykonawcaId, wykonawcaImie) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetReczne = ss.getSheetByName("Logi_ręczne");
    if (!sheetReczne) return { sukces: false, wiadomosc: "Błąd: Brak arkusza 'Logi_ręczne'" };
    _upewnijSieOKolumnyWykonawcy(sheetReczne);

    var now = new Date();
    var dataStr = Utilities.formatDate(now, _APP_TZ, "yyyy-MM-dd HH:mm:ss");
    // PATCH-2026-10-NAN-PUNKTY
    var pkt = _naprawPunktyNaN(wydarzenie, punkty);
    var przetworzone = 0;
    var pominieci = 0;
    var samodzielnieUwzgledniono = false;

    function _czyKsiadzId(pid) {
      try {
        var rr = String(pobierzRoleUzytkownika(pid) || "").toUpperCase();
        if (rr === "KSIADZ" || rr.indexOf("KSI") === 0) return true;
      } catch (e1) {}
      try {
        var sheetK = ss.getSheetByName("Kandydaci");
        if (!sheetK) return false;
        var dk = sheetK.getDataRange().getValues();
        var tid = String(pid || "").trim();
        for (var i = 1; i < dk.length; i++) {
          if (String(dk[i][0] || "").trim() !== tid) continue;
          var rg = String(dk[i][6] || "").toLowerCase();
          return rg.indexOf("ksi") === 0;
        }
      } catch (e2) {}
      return false;
    }

    listaId.forEach(function(id) {
      if (!id || String(id).trim() === "") return;
      if (_czyKsiadzId(id)) { pominieci++; return; } // księża poza punktacją
      var samodzielnie = wykonawcaId && String(wykonawcaId).trim() === String(id).trim();
      if (samodzielnie) samodzielnieUwzgledniono = true;
      sheetReczne.appendRow([
        dataStr, String(id).trim(), wydarzenie, pkt, opis || "Wpis masowy",
        String(wykonawcaId || "").trim(),
        String(wykonawcaImie || "").trim() + (samodzielnie ? " (przyznane samodzielnie)" : "")
      ]);
      przeliczPunktyUzytkownika(String(id).trim());
      przetworzone++;

      // >>> NOWE: push NATYCHMIAST do każdego z listy.
      //     Pomijamy gdy admin przyznaje punkty sam sobie (samodzielnie).
      try {
        if (!samodzielnie && pkt !== 0) {
          var _newPM = 0;
          try {
            var _shKM = ss.getSheetByName("Kandydaci");
            if (_shKM) {
              var _dKM = _shKM.getDataRange().getValues();
              for (var _km = 1; _km < _dKM.length; _km++) {
                if (String(_dKM[_km][0] || "").trim() === String(id).trim()) {
                  _newPM = parseInt(_dKM[_km][2], 10) || 0;
                  break;
                }
              }
            }
          } catch (ePM) {}

          var _iklM = pkt < 0 ? "📉" : "📈";
          var _tytM = pkt < 0 ? "Kara punktowa" : "Zdobyłeś punkty!";
          var _trM = (pkt > 0 ? "+" : "") + pkt + " pkt — " + String(wydarzenie || "") +
                     (_opis ? (" (" + String(_opis).substring(0, 100) + ")") : "") +
                     ". Nowa suma: " + _newPM + " pkt.";
          if (typeof _pushNatychmiast === "function") {
            _pushNatychmiast(
              String(id).trim(), _iklM, _tytM, _trM, "points", "page-profile",
              "points_" + (pkt < 0 ? "loss" : "gain") + "_" + String(id).trim() + "_" + Date.now()
            );
          }
        }
      } catch (ePushMas) {}
    });

    var wiadomosc = "Zapisano punkty dla " + przetworzone + " ministrantów!";
    if (pominieci > 0) wiadomosc += " (pominięto " + pominieci + " lektorów/księży — poza punktacją)";
    if (samodzielnieUwzgledniono) wiadomosc += " Uwaga: na liście była też Twoja własna osoba — ten wpis oznaczono w historii jako samodzielny.";
    return { sukces: true, wiadomosc: wiadomosc };
  } catch(e) {
    return { sukces: false, wiadomosc: "Błąd masowego wpisu: " + e.message };
  }
}

// ----------------------------------------------------------------------
// KOMENTARZE DO POSTÓW
// ----------------------------------------------------------------------

function dodajKomentarz(postWiersz, trescKomentarza, autorId, autorImie, linkMedia) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKomentarze = ss.getSheetByName("Komentarze");
    if (!sheetKomentarze) {
      sheetKomentarze = ss.insertSheet("Komentarze");
      sheetKomentarze.appendRow(["Data", "Post Wiersz", "Autor ID", "Autor Imię", "Treść", "Link_Media"]);
    } else if (sheetKomentarze.getLastColumn() < 6) {
      sheetKomentarze.getRange(1, 6).setValue("Link_Media");
    }
    var now = new Date();
    var trescCzysta = String(trescKomentarza || "").trim();
    var mediaStr = "";
    if (Array.isArray(linkMedia) && linkMedia.length > 0) {
      mediaStr = JSON.stringify(linkMedia.map(function(l) { return konwertujLinkDrive(l); }).filter(function(l) { return l; }));
    } else if (linkMedia) {
      mediaStr = JSON.stringify([konwertujLinkDrive(String(linkMedia))]);
    }
    sheetKomentarze.appendRow([now, parseInt(postWiersz), String(autorId || "").trim(), String(autorImie || "").trim(), trescCzysta, mediaStr]);

    // OneSignal — wysyłaj TYLKO do oznaczonych w komentarzu
    var wzmiankiKom = [];
    var regexWzmiankaKom = /@([^\s@,!?.]+)/g;
    var matchKom;
    while ((matchKom = regexWzmiankaKom.exec(trescCzysta)) !== null) {
      wzmiankiKom.push(matchKom[1].replace(/_/g, ' '));
    }
    if (wzmiankiKom.length > 0) {
      wyslijPowiadomienieDoOznaczonych(
        "Zostałeś oznaczony w komentarzu!",
        (autorImie || "Ktoś") + ": " + trescCzysta.substring(0, 100),
        wzmiankiKom, ss
      );
    }

    return { sukces: true, wiadomosc: "Komentarz dodany!" };
  } catch(e) {
    return { sukces: false, wiadomosc: "Błąd dodawania komentarza: " + e.message };
  }
}

function usunKomentarz(wiersz, rola) {
  if (!_czyAdminLubKsiadz(rola)) return { sukces: false, wiadomosc: "Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Komentarze");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza komentarzy." };
    sheet.deleteRow(parseInt(wiersz));
    return { sukces: true, wiadomosc: "Komentarz usunięty." };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getKomentarzeDoPostu(postWiersz) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Komentarze");
    if (!sheet) return { sukces: true, dane: [] };
    var data = sheet.getDataRange().getValues();
    var wynik = [];
    for (var i = 1; i < data.length; i++) {
      if (parseInt(data[i][1]) === parseInt(postWiersz)) {
        var d = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
        wynik.push({
          wiersz: i + 1,
          dataFormated: Utilities.formatDate(d, _APP_TZ, "dd.MM.yyyy HH:mm"),
          autorId: String(data[i][2] || ""),
          autorImie: String(data[i][3] || ""),
          tresc: String(data[i][4] || ""),
          linkMedia: String(data[i][5] || "")
        });
      }
    }
    return { sukces: true, dane: wynik };
  } catch(e) {
    return { sukces: false, dane: [] };
  }
}

// ----------------------------------------------------------------------
// ANKIETY NA SPOŁECZNOŚCI
// ----------------------------------------------------------------------

function dodajAnkiete(pytanie, opcje, rola, czasTrwaniaGodzin, linkMedia, autorId, autorImie) {
  // Ankiety: każdy zalogowany (rola wymagana tylko jako obecność)
  if (!rola) return { sukces: false, wiadomosc: "Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetAnkiety = ss.getSheetByName("Ankiety");
    if (!sheetAnkiety) {
      sheetAnkiety = ss.insertSheet("Ankiety");
      sheetAnkiety.appendRow(["Data", "Pytanie", "Opcje JSON", "Aktywna", "Data zakończenia", "Link_Media", "Autor_ID", "Autor_Imie"]);
    }
    // Migracja starszego arkusza — kolumna "Data zakończenia", "Link_Media", autor
    if (sheetAnkiety.getLastColumn() < 5) {
      sheetAnkiety.getRange(1, 5).setValue("Data zakończenia");
    }
    if (sheetAnkiety.getLastColumn() < 6) {
      sheetAnkiety.getRange(1, 6).setValue("Link_Media");
    }
    if (sheetAnkiety.getLastColumn() < 7) {
      sheetAnkiety.getRange(1, 7).setValue("Autor_ID");
    }
    if (sheetAnkiety.getLastColumn() < 8) {
      sheetAnkiety.getRange(1, 8).setValue("Autor_Imie");
    }

    var pytTrim = String(pytanie || "").trim();
    // Deduplikacja tylko gdy pytanie niepuste
    if (pytTrim) {
      var data = sheetAnkiety.getDataRange().getValues();
      var normPyt = _normalizuj(pytTrim);
      for (var i = 1; i < data.length; i++) {
        if (data[i][3] !== false && _normalizuj(data[i][1]) === normPyt) {
          return { sukces: false, wiadomosc: "Ankieta z takim pytaniem już istnieje!" };
        }
      }
    }

    if (!opcje || !opcje.length || opcje.length < 2) {
      return { sukces: false, wiadomosc: "Podaj co najmniej 2 opcje odpowiedzi." };
    }

    // Normalizacja opcji: string | {t,i} | {tekst,img}
    // Każda opcja musi mieć tekst i/lub obraz.
    var opcjeNorm = [];
    for (var oi = 0; oi < opcje.length; oi++) {
      var raw = opcje[oi];
      if (raw && typeof raw === "object") {
        var t = String(raw.t != null ? raw.t : (raw.tekst != null ? raw.tekst : "")).trim();
        var i = String(raw.i != null ? raw.i : (raw.img != null ? raw.img : (raw.image || ""))).trim();
        if (!t && !i) {
          return { sukces: false, wiadomosc: "Opcja " + (oi + 1) + " jest pusta — podaj tekst lub zdjęcie." };
        }
        if (t && i) opcjeNorm.push({ t: t, i: i });
        else if (i) opcjeNorm.push({ t: "", i: i });
        else opcjeNorm.push(t); // sam tekst — kompatybilność wsteczna
      } else {
        var s = String(raw || "").trim();
        if (!s) {
          return { sukces: false, wiadomosc: "Opcja " + (oi + 1) + " jest pusta — podaj tekst lub zdjęcie." };
        }
        opcjeNorm.push(s);
      }
    }
    if (opcjeNorm.length < 2) {
      return { sukces: false, wiadomosc: "Podaj co najmniej 2 opcje odpowiedzi." };
    }

    var now = new Date();
    var godziny = parseFloat(czasTrwaniaGodzin);
    var dataZakonczenia = "";
    if (!isNaN(godziny) && godziny > 0) {
      dataZakonczenia = new Date(now.getTime() + godziny * 3600 * 1000);
    }

    var mediaJson = "[]";
    try {
      if (linkMedia && linkMedia.length) mediaJson = JSON.stringify(linkMedia);
    } catch (e2) { mediaJson = "[]"; }

    var aId = String(autorId || "").trim();
    var aImie = String(autorImie || "").trim();
    if (!aImie && aId) {
      try {
        var sheetK = ss.getSheetByName("Kandydaci");
        if (sheetK) {
          var dk = sheetK.getDataRange().getValues();
          for (var ki = 1; ki < dk.length; ki++) {
            if (String(dk[ki][0] || "").trim() === aId) {
              aImie = String(dk[ki][1] || "").trim();
              break;
            }
          }
        }
      } catch (eIm) {}
    }
    sheetAnkiety.appendRow([now, pytTrim, JSON.stringify(opcjeNorm), true, dataZakonczenia, mediaJson, aId, aImie]);

    // Powiadom wszystkich o nowej ankiecie (dzwonek w aplikacji + push OneSignal)
    try {
      _powiadomWszystkichONowym(
        "Nowa ankieta!",
        pytTrim,
        "page-ogloszenia",
        "ankieta"
      );
    } catch (eNotif) {}

    return { sukces: true, wiadomosc: "Ankieta opublikowana!" };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function zaglosujNaAnkiete(ankietaWiersz, opcjaIndex, userId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetGlosy = ss.getSheetByName("Glosy_ankiet");
    if (!sheetGlosy) {
      sheetGlosy = ss.insertSheet("Glosy_ankiet");
      sheetGlosy.appendRow(["Ankieta Wiersz", "User ID", "Opcja Index", "Data"]);
    }
    // Sprawdź czy już głosował
    var data = sheetGlosy.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (parseInt(data[i][0]) === parseInt(ankietaWiersz) && String(data[i][1]).trim() === String(userId).trim()) {
        return { sukces: false, wiadomosc: "Już oddałeś głos w tej ankiecie!" };
      }
    }
    sheetGlosy.appendRow([parseInt(ankietaWiersz), String(userId).trim(), parseInt(opcjaIndex), new Date()]);
    return { sukces: true, wiadomosc: "Głos oddany!" };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getAnkiety(userId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetAnkiety = ss.getSheetByName("Ankiety");
    var sheetGlosy = ss.getSheetByName("Glosy_ankiet");
    if (!sheetAnkiety) return { sukces: true, dane: [] };

    var dataAnkiet = sheetAnkiety.getDataRange().getValues();
    var dataGlosow = sheetGlosy ? sheetGlosy.getDataRange().getValues() : [[]];
    var wynik = [];
    var teraz = new Date();

    for (var i = 1; i < dataAnkiet.length; i++) {
      if (!dataAnkiet[i][0]) continue;
      var opcje = [];
      try { opcje = JSON.parse(dataAnkiet[i][2]); } catch(e) { opcje = []; }
      var wiersz = i + 1;

      // Sprawdź termin zakończenia (kolumna 5, index 4) — jeśli minął, ankieta jest zamknięta
      var terminRaw = dataAnkiet[i][4];
      var terminData = null;
      if (terminRaw) {
        terminData = terminRaw instanceof Date ? terminRaw : new Date(terminRaw);
        if (isNaN(terminData.getTime())) terminData = null;
      }
      var wygasla = terminData && terminData <= teraz;
      var aktywnaFlaga = dataAnkiet[i][3] !== false && dataAnkiet[i][3] !== "FALSE";
      if (wygasla && aktywnaFlaga) {
        // Auto-zamknięcie po upływie czasu trwania
        sheetAnkiety.getRange(wiersz, 4).setValue(false);
        aktywnaFlaga = false;
      }

      var liczbaGlosow = new Array(opcje.length).fill(0);
      var mojaOpcja = -1;
      for (var j = 1; j < dataGlosow.length; j++) {
        if (parseInt(dataGlosow[j][0]) === wiersz) {
          var idx = parseInt(dataGlosow[j][2]);
          if (!isNaN(idx) && idx < liczbaGlosow.length) liczbaGlosow[idx]++;
          if (String(dataGlosow[j][1]).trim() === String(userId).trim()) mojaOpcja = idx;
        }
      }
      var d = dataAnkiet[i][0] instanceof Date ? dataAnkiet[i][0] : new Date(dataAnkiet[i][0]);
      var linkMediaRaw = dataAnkiet[i][5] || "[]";
      // Komentarze/reakcje do ankiet są przechowywane pod ujemnym ID (-wiersz),
      // żeby nie kolidować z wierszami postów w arkuszach Komentarze / Reakcje_postow.
      var komentarzKey = -wiersz;
      var autorIdRow = String(dataAnkiet[i][6] || "").trim();
      var autorImieRow = String(dataAnkiet[i][7] || "").trim();
      wynik.push({
        wiersz: wiersz,
        pytanie: String(dataAnkiet[i][1] || ""),
        opcje: opcje,
        liczbaGlosow: liczbaGlosow,
        mojaOpcja: mojaOpcja,
        aktywna: aktywnaFlaga,
        dataZakonczeniaFormated: terminData ? Utilities.formatDate(terminData, _APP_TZ, "dd.MM.yyyy HH:mm") : "",
        dataFormated: Utilities.formatDate(d, _APP_TZ, "dd.MM.yyyy HH:mm"),
        linkMedia: String(linkMediaRaw || "[]"),
        liczbaKomentarzy: 0,
        reakcjaId: komentarzKey,
        autorId: autorIdRow,
        autorImie: autorImieRow,
        jestAutorem: !!(autorIdRow && String(userId || "").trim() === autorIdRow)
      });
    }

    // Policz komentarze do ankiet (Post Wiersz = -wierszAnkiety)
    var sheetKom = ss.getSheetByName("Komentarze");
    if (sheetKom && sheetKom.getLastRow() > 1) {
      var dataKomA = sheetKom.getDataRange().getValues();
      var mapaKom = {};
      for (var ki = 1; ki < dataKomA.length; ki++) {
        var pk = parseInt(dataKomA[ki][1], 10);
        if (isNaN(pk) || pk >= 0) continue;
        mapaKom[pk] = (mapaKom[pk] || 0) + 1;
      }
      wynik.forEach(function(a) {
        a.liczbaKomentarzy = mapaKom[-a.wiersz] || 0;
      });
    }

    // Trwające ankiety na górze, w każdej grupie od najnowszych do najstarszych
    wynik.sort(function(a, b) {
      if (a.aktywna !== b.aktywna) return a.aktywna ? -1 : 1;
      return b.wiersz - a.wiersz;
    });
    return { sukces: true, dane: wynik };
  } catch(e) {
    return { sukces: false, dane: [] };
  }
}

// Zamyka ankietę (ustawia Aktywna = false) bez usuwania jej z listy.
function zamknijAnkiete(wiersz, rola) {
  if (!_czyAdminLubKsiadz(rola)) return { sukces: false, wiadomosc: "Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Ankiety");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza ankiet." };
    sheet.getRange(parseInt(wiersz), 4).setValue(false);
    return { sukces: true, wiadomosc: "Ankieta zamknięta." };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function usunAnkiete(wiersz, rola) {
  if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Ankiety");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza ankiet." };
    sheet.deleteRow(parseInt(wiersz));
    return { sukces: true, wiadomosc: "Ankieta usunięta." };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/**
 * Lista głosów w ankiecie — tylko autor ankiety lub admin/ksiądz.
 * Zwraca { sukces, opcje:[{tekst, img, glosy:[{userId, imie}]}] }
 */
function getGlosyAnkiety(ankietaWiersz, userId) {
  try {
    var uid = String(userId || "").trim();
    var wiersz = parseInt(ankietaWiersz, 10);
    if (!uid || !wiersz) return { sukces: false, wiadomosc: "Brak danych." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetAnkiety = ss.getSheetByName("Ankiety");
    if (!sheetAnkiety || wiersz < 2 || wiersz > sheetAnkiety.getLastRow()) {
      return { sukces: false, wiadomosc: "Nie znaleziono ankiety." };
    }

    var row = sheetAnkiety.getRange(wiersz, 1, wiersz, Math.max(8, sheetAnkiety.getLastColumn())).getValues()[0];
    var autorId = String(row[6] || "").trim();
    var rola = "";
    try { rola = String(pobierzRoleUzytkownika(uid) || ""); } catch (eR) {}
    var isAdmin = (typeof _czyAdminLubKsiadz === "function" && _czyAdminLubKsiadz(rola)) ||
      String(rola || "").toUpperCase().indexOf("ADMIN") === 0;
    if (autorId && autorId !== uid && !isAdmin) {
      return { sukces: false, wiadomosc: "Tylko autor ankiety może zobaczyć kto głosował." };
    }
    // Stare ankiety bez autora — tylko admin
    if (!autorId && !isAdmin) {
      return { sukces: false, wiadomosc: "Brak danych o autorze — szczegóły głosów niedostępne." };
    }

    var opcje = [];
    try { opcje = JSON.parse(row[2] || "[]"); } catch (eP) { opcje = []; }
    if (!Array.isArray(opcje)) opcje = [];

    var sheetGlosy = ss.getSheetByName("Glosy_ankiet");
    var dataGlosow = sheetGlosy && sheetGlosy.getLastRow() > 1 ? sheetGlosy.getDataRange().getValues() : [[]];

    var mapaImion = {};
    try {
      var sheetK = ss.getSheetByName("Kandydaci");
      if (sheetK && sheetK.getLastRow() > 1) {
        var dk = sheetK.getDataRange().getValues();
        for (var j = 1; j < dk.length; j++) {
          mapaImion[String(dk[j][0]).trim()] = String(dk[j][1] || "").trim();
        }
      }
      var sheetH = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
      if (sheetH && sheetH.getLastRow() > 1) {
        var dh = sheetH.getDataRange().getValues();
        for (var h = 1; h < dh.length; h++) {
          var hid = String(dh[h][0]).trim();
          if (!mapaImion[hid]) mapaImion[hid] = String(dh[h][1] || "").trim();
        }
      }
    } catch (eMap) {}

    var wynikOpcje = opcje.map(function(op, idx) {
      var tekst = "";
      var img = "";
      if (op && typeof op === "object") {
        tekst = String(op.t != null ? op.t : (op.tekst != null ? op.tekst : "")).trim();
        img = String(op.i != null ? op.i : (op.img != null ? op.img : "")).trim();
      } else {
        tekst = String(op || "").trim();
      }
      return { index: idx, tekst: tekst, img: img, glosy: [] };
    });

    for (var g = 1; g < dataGlosow.length; g++) {
      if (parseInt(dataGlosow[g][0], 10) !== wiersz) continue;
      var gUid = String(dataGlosow[g][1] || "").trim();
      var gIdx = parseInt(dataGlosow[g][2], 10);
      if (isNaN(gIdx) || gIdx < 0 || gIdx >= wynikOpcje.length) continue;
      wynikOpcje[gIdx].glosy.push({
        userId: gUid,
        imie: mapaImion[gUid] || gUid || "?"
      });
    }

    wynikOpcje.forEach(function(o) {
      o.glosy.sort(function(a, b) {
        return String(a.imie).localeCompare(String(b.imie), "pl");
      });
    });

    return {
      sukces: true,
      pytanie: String(row[1] || ""),
      autorId: autorId,
      autorImie: String(row[7] || "").trim(),
      opcje: wynikOpcje
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

// ----------------------------------------------------------------------
// BAZA WIEDZY
// ----------------------------------------------------------------------

// Pomocnicze: normalizacja tekstu do porównań
function _normalizuj(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g,' ');
}

function dodajBazaWiedzy(kategoria, tytul, tresc, rola) {
  if (!_czyAdminLubKsiadz(rola)) return { sukces: false, wiadomosc: "Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Baza_wiedzy");
    if (!sheet) {
      sheet = ss.insertSheet("Baza_wiedzy");
      sheet.appendRow(["Data", "Kategoria", "Tytuł", "Treść", "Aktywny", "Link_Media"]);
    }
    // Deduplikacja — sprawdź czy wpis o tym samym tytule+kategorii już istnieje
    var data = sheet.getDataRange().getValues();
    var normTyt = _normalizuj(tytul);
    var normKat = _normalizuj(kategoria);
    for (var i = 1; i < data.length; i++) {
      if (_normalizuj(data[i][2]) === normTyt && _normalizuj(data[i][1]) === normKat) {
        return { sukces: false, wiadomosc: "Wpis o takim tytule i kategorii już istnieje!" };
      }
    }
    sheet.appendRow([new Date(), String(kategoria||"Ogólne").trim(), String(tytul||"").trim(), String(tresc||"").trim(), true, ""]);
    return { sukces: true, wiadomosc: "Wpis dodany do bazy wiedzy!" };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function dodajBazaWiedzyZMedia(kategoria, tytul, tresc, linkiMedia, rola) {
  if (!_czyAdminLubKsiadz(rola)) return { sukces: false, wiadomosc: "Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Baza_wiedzy");
    if (!sheet) {
      sheet = ss.insertSheet("Baza_wiedzy");
      sheet.appendRow(["Data", "Kategoria", "Tytuł", "Treść", "Aktywny", "Link_Media"]);
    }
    // Deduplikacja po tytule+kategorii
    var data = sheet.getDataRange().getValues();
    var normTyt = _normalizuj(tytul);
    var normKat = _normalizuj(kategoria);
    for (var i = 1; i < data.length; i++) {
      if (_normalizuj(data[i][2]) === normTyt && _normalizuj(data[i][1]) === normKat) {
        return { sukces: false, wiadomosc: "Wpis o takim tytule i kategorii już istnieje!" };
      }
    }
    var mediaStr = "";
    if (Array.isArray(linkiMedia) && linkiMedia.length > 0) {
      mediaStr = JSON.stringify(linkiMedia.filter(function(l){ return l && l.trim() !== ""; }));
    }
    sheet.appendRow([new Date(), String(kategoria||"Ogólne").trim(), String(tytul||"").trim(), String(tresc||"").trim(), true, mediaStr]);
    return { sukces: true, wiadomosc: "Wpis dodany do bazy wiedzy!" };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getBazaWiedzy() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Baza_wiedzy");
    if (!sheet) return { sukces: true, dane: [] };
    var data = sheet.getDataRange().getValues();
    var wynik = [];
    for (var i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      wynik.push({
        wiersz: i + 1,
        kategoria: String(data[i][1] || "Ogólne"),
        tytul: String(data[i][2] || ""),
        tresc: String(data[i][3] || ""),
        aktywny: data[i][4] !== false,
        linkMedia: String(data[i][5] || "")
      });
    }
    return { sukces: true, dane: wynik };
  } catch(e) {
    return { sukces: false, dane: [] };
  }
}

function usunBazaWiedzy(wiersz, rola) {
  if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Baza_wiedzy");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza." };
    sheet.deleteRow(parseInt(wiersz));
    return { sukces: true, wiadomosc: "Usunięto wpis." };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

// ----------------------------------------------------------------------
// UPLOAD ZDJĘĆ PRZEZ APLIKACJĘ (base64 → Google Drive)
// ----------------------------------------------------------------------

// ⚠️ WAŻNE: Ustaw ID folderu na Google Drive uruchamiając raz funkcję setFolderZdjecId() w edytorze.
// Możesz też wpisać ID bezpośrednio w PropertiesService (Plik → Właściwości projektu).
// ID folderu znajdziesz w adresie URL: drive.google.com/drive/folders/TUTAJ_JEST_ID
// Folder musi być udostępniony jako "Każdy z linkiem może wyświetlać".

function setFolderZdjecId() {
  var folderId = "DANE_WRAŻLIWE";
  PropertiesService.getScriptProperties().setProperty("FOLDER_ZDJEC_ID", folderId);
}
// PATCH_TICKET_PHOTOS_V1 — folder zdjęć z wbudowanym fallbackiem
function getFolderZdjecId() {
  // Fallback na domyślny folder — aplikacja działa od razu bez ręcznej konfiguracji.
  // Właściwość FOLDER_ZDJEC_ID (jeśli ustawiona) ma pierwszeństwo.
  return PropertiesService.getScriptProperties().getProperty("FOLDER_ZDJEC_ID")
      || "DANE_WRAŻLIWE";
}

function uploadZdjecie(base64Data, nazwaPliku, mimeType) {
  try {
    var folderId = getFolderZdjecId();
    if (!folderId) return { sukces: false, wiadomosc: "Brak ID folderu Drive. Uruchom setFolderZdjecId("DANE_WRAŻLIWE") w edytorze Apps Script." };

    // Sprawdź czy folder istnieje
    var folder;
    try {
      folder = DriveApp.getFolderById(folderId);
    } catch(e) {
      return { sukces: false, wiadomosc: "Nie znaleziono folderu Drive. Sprawdź ID ustawiony przez setFolderZdjecId()." };
    }
    var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, nazwaPliku);

    // Zapisz plik na Drive
    var plik = folder.createFile(blob);

    // Ustaw publiczny dostęp do odczytu
    plik.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // Zwróć bezpośredni link do podglądu
    var fileId = plik.getId();
    var linkPodgladu = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w500";

    return { sukces: true, link: linkPodgladu, fileId: fileId };
  } catch(e) {
    return { sukces: false, wiadomosc: "Błąd uploadu: " + e.message };
  }
}

// ----------------------------------------------------------------------
// ZDJĘCIA / PLIKI W POSTACH (przez Drive)
// Użytkownik uploaduje plik na Google Drive ręcznie i wkleja link,
// lub admin wkleja link do folderu współdzielonego — funkcja konwertuje.
// Obsługa wielu plików: linkMedia to JSON array stringów.
// ----------------------------------------------------------------------


// ----------------------------------------------------------------------
// REAKCJE DO POSTÓW
// Arkusz: Reakcje_postow | PostWiersz | UserID | Typ | Data
// Typ: like | love | pray | laugh | cry
// ----------------------------------------------------------------------

function _arkuszReakcji() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Reakcje_postow");
  if (!sheet) {
    sheet = ss.insertSheet("Reakcje_postow");
    sheet.appendRow(["PostWiersz", "UserID", "Typ", "Data"]);
  }
  return sheet;
}

/** Przełącz reakcję użytkownika na poście (jeden typ na usera na post). */
function toggleReakcjaPostu(postWiersz, userId, typ) {
  try {
    var pw = parseInt(postWiersz);
    var uid = String(userId || "").trim();
    var t = String(typ || "like").trim();
    if (!pw || !uid) return { sukces: false, wiadomosc: "Brak danych." };
    var sheet = _arkuszReakcji();
    var data = sheet.getDataRange().getValues();
    // Usuń poprzednią reakcję tego usera na tym poście
    for (var i = data.length - 1; i >= 1; i--) {
      if (parseInt(data[i][0]) === pw && String(data[i][1]).trim() === uid) {
        var staryTyp = String(data[i][2] || "").trim();
        sheet.deleteRow(i + 1);
        // Kliknięcie tej samej reakcji = wyłączenie
        if (staryTyp === t) {
          return { sukces: true, moja: "", podsumowanie: _podsumujReakcje(pw) };
        }
        break;
      }
    }
    sheet.appendRow([pw, uid, t, new Date()]);
    return { sukces: true, moja: t, podsumowanie: _podsumujReakcje(pw) };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function _podsumujReakcje(postWiersz) {
  var sheet = _arkuszReakcji();
  var data = sheet.getDataRange().getValues();
  var pw = parseInt(postWiersz);
  var sum = { like: 0, love: 0, pray: 0, laugh: 0, cry: 0 };
  for (var i = 1; i < data.length; i++) {
    if (parseInt(data[i][0]) === pw) {
      var typ = String(data[i][2] || "").trim();
      if (sum.hasOwnProperty(typ)) sum[typ]++;
    }
  }
  return sum;
}

function getReakcjeDlaPostow(listaWierszy, userId) {
  try {
    var sheet = _arkuszReakcji();
    var data = sheet.getDataRange().getValues();
    var uid = String(userId || "").trim();
    var set = {};
    (listaWierszy || []).forEach(function(w) { set[parseInt(w)] = true; });
    var wynik = {}; // postWiersz -> { sum, moja }
    for (var i = 1; i < data.length; i++) {
      var pw = parseInt(data[i][0]);
      if (!set[pw]) continue;
      if (!wynik[pw]) wynik[pw] = { sum: { like: 0, love: 0, pray: 0, laugh: 0, cry: 0 }, moja: "" };
      var typ = String(data[i][2] || "").trim();
      if (wynik[pw].sum.hasOwnProperty(typ)) wynik[pw].sum[typ]++;
      if (String(data[i][1]).trim() === uid) wynik[pw].moja = typ;
    }
    return { sukces: true, dane: wynik };
  } catch (e) {
    return { sukces: false, dane: {} };
  }
}

/** Lista osób które zareagowały na post/ankietę/komentarz (z imieniem). */
function getListaReakcjiPostu(postWiersz) {
  try {
    var pw = parseInt(postWiersz);
    if (!pw && pw !== 0) return { sukces: false, dane: [] };
    var sheet = _arkuszReakcji();
    var data = sheet.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < data.length; i++) {
      if (parseInt(data[i][0]) !== pw) continue;
      lista.push({
        userId: String(data[i][1] || "").trim(),
        typ: String(data[i][2] || "").trim()
      });
    }
    // Dołącz imiona z arkusza Kandydaci (kol. 0 = ID, kol. 1 = Imię)
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetK = ss.getSheetByName("Kandydaci");
    var mapaImion = {};
    if (sheetK && sheetK.getLastRow() > 1) {
      var dk = sheetK.getDataRange().getValues();
      for (var j = 1; j < dk.length; j++) {
        mapaImion[String(dk[j][0]).trim()] = String(dk[j][1] || "").trim();
      }
    }
    // Fallback: arkusz Hasła (ID, Imię)
    var sheetH = ss.getSheetByName("Hasła");
    if (sheetH && sheetH.getLastRow() > 1) {
      var dh = sheetH.getDataRange().getValues();
      for (var h = 1; h < dh.length; h++) {
        var hid = String(dh[h][0]).trim();
        if (!mapaImion[hid]) mapaImion[hid] = String(dh[h][1] || "").trim();
      }
    }
    lista.forEach(function(u) {
      u.imie = mapaImion[u.userId] || u.userId || "?";
    });
    // Sortuj: love, like, pray, laugh, cry
    var kolejnosc = { love: 0, like: 1, pray: 2, laugh: 3, cry: 4 };
    lista.sort(function(a, b) {
      var ka = kolejnosc[a.typ] != null ? kolejnosc[a.typ] : 9;
      var kb = kolejnosc[b.typ] != null ? kolejnosc[b.typ] : 9;
      if (ka !== kb) return ka - kb;
      return String(a.imie).localeCompare(String(b.imie), "pl");
    });
    return { sukces: true, dane: lista };
  } catch (e) {
    return { sukces: false, dane: [], wiadomosc: e.message };
  }
}


function dodajPostZMediami(typ, tytul, tresc, linkiMedia, rola, userId, sessionToken, autorImie) {
  // Rola pobierana bezpośrednio z arkusza (bez weryfikacji tokenu sesji)
  if (userId) {
    var rolaZeSheeta2 = pobierzRoleUzytkownika(userId);
    if (rolaZeSheeta2) rola = rolaZeSheeta2;
  }
  // Każdy zalogowany może publikować posty
  if (!userId || !rola) return { sukces: false, wiadomosc: "Błąd: Brak uprawnień." };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetSpolecznosc = ss.getSheetByName("Społeczność");
    if (!sheetSpolecznosc) return { sukces: false, wiadomosc: "Błąd: Brak arkusza 'Społeczność'" };

    // Deduplikacja — nie dodawaj jeśli ten sam tytuł+treść dodano w ciągu ostatnich 60 sekund
    var data = sheetSpolecznosc.getDataRange().getValues();
    var normTyt = _normalizuj(tytul);
    var normTresc = _normalizuj(tresc);
    var teraz = new Date().getTime();
    for (var i = data.length - 1; i >= 1; i--) {
      if (!data[i][0]) continue;
      var ts = (data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0])).getTime();
      if (teraz - ts > 60000) break; // starsze niż 60s — nie sprawdzaj
      if (_normalizuj(data[i][2]) === normTyt && _normalizuj(data[i][3]) === normTresc) {
        return { sukces: false, wiadomosc: "Identyczny post został właśnie opublikowany. Odczekaj chwilę." };
      }
    }

    var mediaStr = "";
    if (Array.isArray(linkiMedia) && linkiMedia.length > 0) {
      var skonwertowane = linkiMedia.map(function(l) { return konwertujLinkDrive(l); }).filter(function(l) { return l !== ""; });
      mediaStr = JSON.stringify(skonwertowane);
    }

    var imieAutora = String(autorImie || "").trim() || ("User " + String(userId || "").trim());
    // Arkusz Społeczność: Data | Typ | Tytuł | Treść | Link_Media | Autor_Imie
    sheetSpolecznosc.appendRow([new Date(), typ || "AUTO", tytul, tresc, mediaStr, imieAutora]);

    // OneSignal — wysyłaj TYLKO do oznaczonych w poście
    var trescPelna = (tytul || "") + " " + (tresc || "");
    var wzmianki = [];
    var regexWzmianka = /@([^\s@,!?.]+)/g;
    var match;
    while ((match = regexWzmianka.exec(trescPelna)) !== null) {
      wzmianki.push(match[1].replace(/_/g, ' '));
    }
    if (wzmianki.length > 0) {
      wyslijPowiadomienieDoOznaczonych(tytul || "Zostałeś oznaczony!", tresc ? tresc.substring(0, 100) : "Sprawdź nowe ogłoszenie.", wzmianki, ss);
    } else {
      // >>> NOWE: brak @ → push do wszystkich o nowym ogłoszeniu
      try {
        if (typeof _powiadomWszystkichONowym === "function") {
          _powiadomWszystkichONowym(
            "📢 " + (tytul || "Nowe ogłoszenie"),
            (tresc ? String(tresc).substring(0, 150) : "Zobacz w aplikacji."),
            "page-ogloszenia",
            "ogloszenia"
          );
        }
      } catch (eNotifAll) {}
    }
    return { sukces: true, wiadomosc: "Post opublikowany!" };
  } catch(e) {
    return { sukces: false, wiadomosc: "Błąd: " + e.message };
  }
}
function wyslijPowiadomienieDoOznaczonych(tytul, tresc, wzmianki, ss) {
  var ONESIGNAL_APP_ID = "DANE_WRAŻLIWE";
  var ONESIGNAL_REST_KEY = "DANE_WRAŻLIWE";

  var wyslijDoWszystkich = false;
  var oznaczoneRangi = [];
  var oznaczoneImiona = [];

  wzmianki.forEach(function(w) {
    var wLower = w.toLowerCase();
    if (wLower === 'wszyscy') {
      wyslijDoWszystkich = true;
    } else if (['kandydat','ministrant','lektor'].indexOf(wLower) !== -1) {
      oznaczoneRangi.push(w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    } else {
      oznaczoneImiona.push(w.toLowerCase());
    }
  });

  var payload = {
    app_id: ONESIGNAL_APP_ID,
    headings: { pl: tytul, en: tytul },
    contents: { pl: tresc, en: tresc }
  };

  if (wyslijDoWszystkich) {
    payload.included_segments = ["All"];
  } else {
    var doWyslania = [];
    var sheetKandydaci = ss.getSheetByName("Kandydaci");
    if (sheetKandydaci) {
      var dane = sheetKandydaci.getDataRange().getValues();
      for (var i = 1; i < dane.length; i++) {
        var userId = String(dane[i][0] || "").trim();
        var imie   = String(dane[i][1] || "").trim().toLowerCase();
        var ranga  = String(dane[i][6] || "").trim();
        if (!userId) continue;
        if (oznaczoneRangi.indexOf(ranga) !== -1) { doWyslania.push(userId); continue; }
        for (var j = 0; j < oznaczoneImiona.length; j++) {
          if (imie === oznaczoneImiona[j]) { doWyslania.push(userId); break; }
        }
      }
    }
    if (doWyslania.length === 0) return;
    payload.include_external_user_ids = doWyslania;
    payload.channel_for_external_user_ids = "push";
  }

  var options = {
    method: "post", contentType: "application/json",
    headers: { "Authorization": "Key " + ONESIGNAL_REST_KEY },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  try { UrlFetchApp.fetch("https://onesignal.com/api/v1/notifications", options); } catch(e) {}
}

function wyslijPowiadomienieOneSignal(tytul, tresc) {
  var ONESIGNAL_APP_ID = "DANE_WRAŻLIWE";
  var ONESIGNAL_REST_KEY = "DANE_WRAŻLIWE";
  
  var payload = {
    app_id: ONESIGNAL_APP_ID,
    included_segments: ["All"],
    headings: { pl: tytul, en: tytul },
    contents: { pl: tresc, en: tresc }
  };
  
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": "Key " + ONESIGNAL_REST_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  try {
    UrlFetchApp.fetch("https://onesignal.com/api/v1/notifications", options);
  } catch(e) {
    // ignoruj błędy push — nie blokuj głównej operacji
  }
}

/** Push OneSignal do konkretnych external_user_id (ID z arkusza Hasła/Kandydaci). */
function wyslijPowiadomienieDoUserow(userIds, tytul, tresc) {
  try {
    var ids = [];
    if (Array.isArray(userIds)) {
      userIds.forEach(function(u) {
        var s = String(u || "").trim();
        if (s && ids.indexOf(s) === -1) ids.push(s);
      });
    } else {
      var one = String(userIds || "").trim();
      if (one) ids.push(one);
    }
    if (ids.length === 0) return;

    var ONESIGNAL_APP_ID = "DANE_WRAŻLIWE";
    var ONESIGNAL_REST_KEY = "DANE_WRAŻLIWE";
    var payload = {
      app_id: ONESIGNAL_APP_ID,
      include_external_user_ids: ids,
      channel_for_external_user_ids: "push",
      headings: { pl: String(tytul || ""), en: String(tytul || "") },
      contents: { pl: String(tresc || ""), en: String(tresc || "") }
    };
    var options = {
      method: "post",
      contentType: "application/json",
      headers: { "Authorization": "Key " + ONESIGNAL_REST_KEY },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    UrlFetchApp.fetch("https://onesignal.com/api/v1/notifications", options);
  } catch (e) {}
}

// ----------------------------------------------------------------------
// ADMIN: dowolne powiadomienie do dowolnego użytkownika (dzwonek + push)
// ----------------------------------------------------------------------
/**
 * Wysyła powiadomienie do wskazanego użytkownika o dowolnej treści.
 * Wymaga roli ADMIN (albo konta 2212).
 * @param {string} wykonawcaId   ID admina wysyłającego
 * @param {string} targetUserId  ID odbiorcy
 * @param {string} tytul         Tytuł (może być pusty — zostanie „Powiadomienie")
 * @param {string} tresc         Treść
 * @param {string} stronaDocelowa  np. "page-ustawienia", "page-ogloszenia"
 */
function wyslijDowolnePowiadomienie(wykonawcaId, targetUserId, tytul, tresc, stronaDocelowa) {
  try {
    var execId = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(execId));
    var is2212 = String(execId) === "2212";
    if (rola !== "ADMIN" && !is2212) {
      return { sukces: false, wiadomosc: "Tylko administrator może wysyłać powiadomienia." };
    }
    var target = _normId(targetUserId);
    if (!target) return { sukces: false, wiadomosc: "Wybierz odbiorcę." };
    var tyt = String(tytul || "").trim();
    var tr = String(tresc || "").trim();
    if (!tyt && !tr) return { sukces: false, wiadomosc: "Podaj tytuł lub treść powiadomienia." };
    if (!tyt) tyt = "Powiadomienie";
    var strona = String(stronaDocelowa || "page-ustawienia").trim() || "page-ustawienia";
    var klucz = "custom_" + execId + "_" + target + "_" + Date.now();
    _zapiszZdarzeniePowiadomienia(target, klucz, "admin", "🔔", tyt, tr, strona);
    try { wyslijPowiadomienieDoUserow(target, tyt, tr); } catch (eP) {}
    try { _logAdmin(execId, "", "POWIADOM_DOWOLNE", target, tyt + " | " + tr.substring(0, 120)); } catch (eL) {}
    return { sukces: true, wiadomosc: "Powiadomienie wysłane do ID " + target + "." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

// ----------------------------------------------------------------------
// ZDARZENIA POWIADOMIEŃ (in-app dzwonek) — usunięcie zdjęcia, przerwa profilowa
// Arkusz: Powiadomienia_zdarzenia
//   UserID | Klucz | Typ | Ikona | Tytul | Opis | TargetPage | Data
// ----------------------------------------------------------------------

function _arkuszZdarzenPowiadomien() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Powiadomienia_zdarzenia");
  if (!sheet) {
    sheet = ss.insertSheet("Powiadomienia_zdarzenia");
    sheet.appendRow(["UserID", "Klucz", "Typ", "Ikona", "Tytul", "Opis", "TargetPage", "Data"]);
  }
  return sheet;
}

function _zapiszZdarzeniePowiadomienia(userId, klucz, typ, ikona, tytul, opis, targetPage) {
  try {
    var uid = String(userId || "").trim();
    if (!uid || !klucz) return;
    var kluczStr = String(klucz).trim();
    var sheet = _arkuszZdarzenPowiadomien();

    // DEDUP: ten sam klucz dla tego samego usera zapisujemy TYLKO raz.
    // Bez tego akcje wywołane wielokrotnie (podwójne kliknięcie admina,
    // ponowne rozpatrzenie tego samego wiersza, retry) tworzyły stos
    // identycznych powiadomień w dzwonku (np. 5x "Nieobecność zaakceptowana").
    try {
      var last = sheet.getLastRow();
      if (last > 1) {
        var start = Math.max(2, last - 500);
        var dane = sheet.getRange(start, 1, last - start + 1, 2).getValues();
        for (var i = 0; i < dane.length; i++) {
          if (String(dane[i][0] || "").trim() === uid &&
              String(dane[i][1] || "").trim() === kluczStr) {
            return; // już zapisane — nie duplikuj
          }
        }
      }
    } catch (eDedup) {}

    sheet.appendRow([
      uid,
      kluczStr,
      String(typ || "info"),
      String(ikona || "🔔"),
      String(tytul || ""),
      String(opis || ""),
      String(targetPage || "page-ustawienia"),
      new Date()
    ]);
  } catch (e) {}
}

/** Zwraca zdarzenia z ostatnich 14 dni dla usera — tylko OD daty założenia konta. */
function getZdarzeniaPowiadomien(userId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: true, zdarzenia: [] };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Powiadomienia_zdarzenia");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, zdarzenia: [] };
    var data = sheet.getDataRange().getValues();
    var prog = Date.now() - 14 * 24 * 3600 * 1000;
    // Nie pokazuj zdarzeń sprzed założenia konta
    try {
      var od = _getDataZalozeniaKonta(uid);
      if (od) {
        var od0 = new Date(od.getFullYear(), od.getMonth(), od.getDate()).getTime();
        if (od0 > prog) prog = od0;
      }
    } catch (eOd) {}
    var wynik = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0] || "").trim() !== uid) continue;
      var d = data[i][7] instanceof Date ? data[i][7] : new Date(data[i][7]);
      if (isNaN(d.getTime()) || d.getTime() < prog) continue;
      wynik.push({
        klucz: String(data[i][1] || ""),
        typ: String(data[i][2] || "info"),
        ikona: String(data[i][3] || "🔔"),
        tytul: String(data[i][4] || ""),
        opis: String(data[i][5] || ""),
        targetPage: String(data[i][6] || "page-ustawienia"),
        timestamp: d.getTime()
      });
    }
    return { sukces: true, zdarzenia: wynik };
  } catch (e) {
    return { sukces: false, zdarzenia: [] };
  }
}

/** Timestamp (ms) początku dnia założenia konta — 0 jeśli brak (stare konta). */
function getDataZalozeniaKontaMs(userId) {
  try {
    var od = _getDataZalozeniaKonta(userId);
    if (!od) return { sukces: true, ms: 0 };
    var od0 = new Date(od.getFullYear(), od.getMonth(), od.getDate()).getTime();
    return { sukces: true, ms: od0 };
  } catch (e) {
    return { sukces: true, ms: 0 };
  }
}

// Powiadomienie OneSignal o dostępności — wysyłane gdy admin dodaje Uroczystość/Triduum
function wyslijPowiadomienieDostepnosc(nazwaWydarzenia, dataWydarzenia) {
  var ONESIGNAL_APP_ID = "DANE_WRAŻLIWE";
  var ONESIGNAL_REST_KEY = "DANE_WRAŻLIWE";
  var payload = {
    app_id: ONESIGNAL_APP_ID,
    included_segments: ["All"],
    headings: { pl: "📅 Zgłoś dostępność!", en: "📅 Report availability!" },
    contents: {
      pl: nazwaWydarzenia + " (" + dataWydarzenia + ") — otwórz Panel Ministrantów i zaznacz czy będziesz dostępny.",
      en: nazwaWydarzenia + " — open the app and mark your availability."
    }
  };
  var options = {
    method: "post", contentType: "application/json",
    headers: { "Authorization": "Key " + ONESIGNAL_REST_KEY },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  try { UrlFetchApp.fetch("https://onesignal.com/api/v1/notifications", options); } catch(e) {}
}
// ----------------------------------------------------------------------
// ZGODA NA POWIADOMIENIA PUSH — PER URZĄDZENIE
// Problem: zgoda tylko per UserID → "tak" na PC blokowało baner na telefonie,
// choć telefon nie miał subskrypcji OneSignal / Notification.permission.
//
// Arkusz: Powiadomienia_Zgoda
//   ID_uzytkownika | DeviceID | Zgoda (tak/nie) | Data | Notatka
//
// Stare wiersze (bez DeviceID / 3 kolumny) = legacy; NIE blokują nowego urządzenia.
// ----------------------------------------------------------------------

function _pobierzAlboUtworzArkuszZgodyPush() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Powiadomienia_Zgoda");
  if (!sheet) {
    sheet = ss.insertSheet("Powiadomienia_Zgoda");
    sheet.appendRow(["ID_uzytkownika", "DeviceID", "Zgoda", "Data", "Notatka"]);
    return sheet;
  }
  // Nagłówek A bywa pusty (ręcznie utworzony arkusz) — uzupełnij bez kasowania danych
  try {
    if (!String(sheet.getRange(1, 1).getValue() || "").trim()) {
      sheet.getRange(1, 1).setValue("ID_uzytkownika");
    }
    if (!String(sheet.getRange(1, 2).getValue() || "").trim()) {
      sheet.getRange(1, 2).setValue("DeviceID");
    }
    if (!String(sheet.getRange(1, 3).getValue() || "").trim()) {
      sheet.getRange(1, 3).setValue("Zgoda");
    }
    if (!String(sheet.getRange(1, 4).getValue() || "").trim()) {
      sheet.getRange(1, 4).setValue("Data");
    }
    if (!String(sheet.getRange(1, 5).getValue() || "").trim()) {
      sheet.getRange(1, 5).setValue("Notatka");
    }
  } catch (eHdr) {}
  // Migracja nagłówka: stare A=ID, B=Zgoda, C=Data → A=ID, B=DeviceID, C=Zgoda, D=Data, E=Notatka
  var h1 = String(sheet.getRange(1, 1).getValue() || "").toLowerCase();
  var h2 = String(sheet.getRange(1, 2).getValue() || "").toLowerCase();
  if (h2.indexOf("zgoda") >= 0 || (h2 && h2.indexOf("device") < 0 && h2.indexOf("urzad") < 0)) {
    // Stary format — przekształć wiersze danych
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow >= 1) {
      var old = sheet.getDataRange().getValues();
      sheet.clear();
      sheet.appendRow(["ID_uzytkownika", "DeviceID", "Zgoda", "Data", "Notatka"]);
      for (var i = 1; i < old.length; i++) {
        var oid = String(old[i][0] || "").trim();
        if (!oid) continue;
        // Stary: B=zgoda, C=data  →  zachowaj jako legacy (pusty DeviceID)
        var oz = String(old[i][1] || "").trim();
        var od = old[i][2] || new Date();
        // Jeśli wyglądało już na nowy format (B=device, C=zgoda)
        if (String(old[0][1] || "").toLowerCase().indexOf("device") >= 0 ||
            String(old[0][1] || "").toLowerCase().indexOf("urzad") >= 0) {
          sheet.appendRow([oid, String(old[i][1] || ""), String(old[i][2] || ""), old[i][3] || od, String(old[i][4] || "")]);
        } else {
          sheet.appendRow([oid, "", oz, od, "legacy-bez-device"]);
        }
      }
    } else {
      sheet.getRange(1, 1, 1, 5).setValues([["ID_uzytkownika", "DeviceID", "Zgoda", "Data", "Notatka"]]);
    }
  } else if (sheet.getLastColumn() < 5) {
    sheet.getRange(1, 1, 1, 5).setValues([["ID_uzytkownika", "DeviceID", "Zgoda", "Data", "Notatka"]]);
  }
  return sheet;
}

/**
 * Zapis zgody push dla KONKRETNEGO urządzenia.
 * deviceId — z Netlify localStorage (UUID); pusty = legacy (niezalecane).
 */
function zapiszZgodePush(userId, zgoda, deviceId) {
  try {
    var id = String(userId || "").trim();
    var dev = String(deviceId || "").trim();
    var zRaw = String(zgoda || "").trim().toLowerCase();
    if (!id) return { sukces: false, wiadomosc: "Brak ID użytkownika." };

    var z = zRaw;
    var notatka = dev ? "" : "brak-device-id";
    var snoozeUntil = "";
    if (zRaw.indexOf("snooze") === 0) {
      z = "snooze";
      snoozeUntil = (zRaw.split(":")[1] || "").trim();
      if (!snoozeUntil) {
        var dS = new Date();
        dS.setDate(dS.getDate() + 1);
        snoozeUntil = Utilities.formatDate(dS, _APP_TZ, "yyyy-MM-dd");
      }
      notatka = "snooze:" + snoozeUntil;
    } else if (z !== "tak" && z !== "nie") {
      z = "tak";
    }

    var sheet = _pobierzAlboUtworzArkuszZgodyPush();
    var dane = sheet.getDataRange().getValues();

    // 1) Aktualizacja wiersza per-device (jeśli istnieje)
    var znalazlemDev = false;
    for (var i = 1; i < dane.length; i++) {
      var rowId = String(dane[i][0] || "").trim();
      var rowDev = String(dane[i][1] || "").trim();
      if (rowId === id && rowDev === dev) {
        sheet.getRange(i + 1, 3).setValue(z);
        sheet.getRange(i + 1, 4).setValue(new Date());
        sheet.getRange(i + 1, 5).setValue(notatka);
        znalazlemDev = true;
        break;
      }
    }
    if (!znalazlemDev) {
      sheet.appendRow([id, dev, z, new Date(), notatka]);
    }

    // 2) >>> FIX: dodatkowo aktualizacja / zapis wiersza LEGACY (bez deviceId)
    //    dla tego samego usera. Powód: iOS/Safari czyści localStorage PWA co
    //    kilka dni (ITP), co zmienia device_id. Bez tego backupu backend
    //    "zapominał" zgodę i baner „Włącz powiadomienia" wracał po każdej
    //    zmianie device_id. Tylko dla zgody "tak" lub "nie" (nie dla snooze).
    if (z === "tak" || z === "nie") {
      var znalazlemLegacy = false;
      var dane2 = sheet.getDataRange().getValues();
      for (var j = 1; j < dane2.length; j++) {
        if (String(dane2[j][0] || "").trim() === id &&
            String(dane2[j][1] || "").trim() === "") {
          sheet.getRange(j + 1, 3).setValue(z);
          sheet.getRange(j + 1, 4).setValue(new Date());
          sheet.getRange(j + 1, 5).setValue("legacy (backup dla " + dev + ")");
          znalazlemLegacy = true;
          break;
        }
      }
      if (!znalazlemLegacy) {
        sheet.appendRow([id, "", z, new Date(), "legacy (backup dla " + dev + ")"]);
      }
    }

    return { sukces: true, deviceId: dev, zgoda: z, snoozeUntil: snoozeUntil };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/**
 * Zgoda TYLKO dla tego deviceId.
 * Zgoda z innego urządzenia (PC vs telefon) NIE jest dziedziczona.
 * Legacy (pusty DeviceID) też nie blokuje nowego telefonu.
 */
function pobierzZgodePush(userId, deviceId) {
  try {
    var id = String(userId || "").trim();
    var dev = String(deviceId || "").trim();
    if (!id) return { sukces: true, zgoda: "", deviceId: dev };

    var sheet = _pobierzAlboUtworzArkuszZgodyPush();
    var dane = sheet.getDataRange().getValues();

    // 1) Dokładne dopasowanie user + device
    if (dev) {
      for (var i = 1; i < dane.length; i++) {
        if (String(dane[i][0] || "").trim() === id &&
            String(dane[i][1] || "").trim() === dev) {
          var zgF = String(dane[i][2] || "").trim().toLowerCase();
          var noteF = String(dane[i][4] || "");
          var untilF = "";
          var mm = String(noteF).match(/snooze:(\d{4}-\d{2}-\d{2})/);
          if (mm) untilF = mm[1];
          if (zgF === "snooze") {
            var todayF = Utilities.formatDate(new Date(), _APP_TZ, "yyyy-MM-dd");
            if (untilF && todayF < untilF) {
              return { sukces: true, zgoda: "snooze", snoozeUntil: untilF, deviceId: dev, perDevice: true };
            }
            return { sukces: true, zgoda: "", deviceId: dev, perDevice: true };
          }
          return {
            sukces: true,
            zgoda: zgF,
            deviceId: dev,
            perDevice: true,
            snoozeUntil: untilF
          };
        }
      }
      // >>> FIX: brak wpisu dla tego device_id — sprawdź backup LEGACY
      // (bez deviceId) dla tego samego usera. iOS/Safari potrafi wyczyścić
      // localStorage i zmienić device_id — backup pozwala odzyskać zgodę.
      for (var lg = dane.length - 1; lg >= 1; lg--) {
        if (String(dane[lg][0] || "").trim() === id &&
            String(dane[lg][1] || "").trim() === "") {
          var zgL = String(dane[lg][2] || "").trim().toLowerCase();
          var noteL = String(dane[lg][4] || "");
          var untilL = "";
          var mmL = String(noteL).match(/snooze:(\d{4}-\d{2}-\d{2})/);
          if (mmL) untilL = mmL[1];
          if (zgL === "snooze") {
            var todayL = Utilities.formatDate(new Date(), _APP_TZ, "yyyy-MM-dd");
            if (untilL && todayL < untilL) {
              return { sukces: true, zgoda: "snooze", snoozeUntil: untilL, deviceId: dev, perDevice: true, legacyBackup: true };
            }
            return { sukces: true, zgoda: "", deviceId: dev, perDevice: true, legacyBackup: true };
          }
          if (zgL === "tak" || zgL === "nie") {
            return { sukces: true, zgoda: zgL, deviceId: dev, perDevice: true, legacyBackup: true };
          }
        }
      }
      // Brak wpisu dla tego urządzenia i brak backupu → pytaj na tym urządzeniu
      return { sukces: true, zgoda: "", deviceId: dev, perDevice: true };
    }

    // 2) Bez deviceId (stary klient) — ostatni legacy / dowolny wpis usera
    for (var j = dane.length - 1; j >= 1; j--) {
      if (String(dane[j][0] || "").trim() === id) {
        var zg = String(dane[j][2] || "").trim().toLowerCase();
        // stary format mógł trzymać zgodę w kolumnie B
        if (!zg && String(dane[j][1] || "").toLowerCase().match(/^(tak|nie)$/)) {
          zg = String(dane[j][1] || "").trim().toLowerCase();
        }
        return { sukces: true, zgoda: zg, deviceId: "", perDevice: false };
      }
    }
    return { sukces: true, zgoda: "", deviceId: dev };
  } catch (e) {
    return { sukces: false, zgoda: "", wiadomosc: e.message };
  }
}

// ----------------------------------------------------------------------
// PAMIĘĆ WYŚWIETLONYCH POWIADOMIEŃ (dzwoneczek w aplikacji)
// Arkusz: Powiadomienia_wyslane | UserID | Klucz | Data
// Klient przysyła listę "kandydackich" kluczy zdarzeń (np. mention_post_12_555),
// a backend zwraca tylko te, których jeszcze nie zapisano dla danego usera —
// i od razu je zapisuje, żeby przy kolejnym sprawdzeniu (co 30s) nie wróciły.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// ZDJĘCIE PROFILOWE — zapis URL w arkuszu Kandydaci (kolumna H / indeks 7)
// ----------------------------------------------------------------------

function _upewnijNaglowekZdjeciaKandydaci(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 8) {
    sheet.getRange(1, 8).setValue("Zdjecie_URL");
  } else {
    var nag = String(sheet.getRange(1, 8).getValue() || "").trim();
    if (!nag) sheet.getRange(1, 8).setValue("Zdjecie_URL");
  }
}

// ----------------------------------------------------------------------
// PRZERWY NA EDYCJĘ ZDJĘCIA PROFILOWEGO — WIELE NIEZALEŻNYCH BLOKAD
// PropertiesService:
//   profil_timeouts_json = {
//     "1234": { doIso, powod, przez },
//     "6767": { doIso, powod, przez }
//   }
// Każda osoba ma własny timeout (dni/godziny + powód). Po wygaśnięciu
// wpis jest usuwany przy odczycie. Admin/Moderator nie podlegają blokadzie.
// ----------------------------------------------------------------------

function _odczytajMapeTimeoutowProfil() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty("profil_timeouts_json") || "";
  var mapa = {};
  if (raw) {
    try { mapa = JSON.parse(raw) || {}; } catch (e) { mapa = {}; }
  }

  // Migracja ze starego formatu (pojedyncza blokada)
  if (!raw) {
    var oldId = String(props.getProperty("profil_timeout_userId") || "").trim();
    var oldDo = String(props.getProperty("profil_timeout_do") || "").trim();
    if (oldId && oldDo) {
      mapa[oldId] = {
        doIso: oldDo,
        powod: String(props.getProperty("profil_timeout_powod") || "").trim(),
        przez: String(props.getProperty("profil_timeout_przez") || "").trim()
      };
      props.deleteProperty("profil_timeout_userId");
      props.deleteProperty("profil_timeout_do");
      props.deleteProperty("profil_timeout_powod");
      props.deleteProperty("profil_timeout_przez");
    }
  }

  // Wyrzuć wygasłe + powiadom użytkownika (minął czas)
  var teraz = Date.now();
  var zmieniono = false;
  Object.keys(mapa).forEach(function(uid) {
    var entry = mapa[uid];
    if (!entry || !entry.doIso) {
      delete mapa[uid];
      zmieniono = true;
      return;
    }
    var ts = new Date(entry.doIso).getTime();
    if (isNaN(ts) || ts <= teraz) {
      var powodWyg = String((entry && entry.powod) || "").trim();
      var opisWyg = "Przerwa na edycję zdjęcia profilowego wygasła (minął czas)." +
        (powodWyg ? (" Pierwotny powód blokady: " + powodWyg) : "");
      try {
        _zapiszZdarzeniePowiadomienia(
          uid,
          "przerwa_wygasla_" + uid + "_" + (entry.doIso || teraz),
          "profil", "✅",
          "Przerwa na zdjęcie zdjęta",
          opisWyg,
          "page-ustawienia"
        );
        wyslijPowiadomienieDoUserow(
          uid,
          "Przerwa na zdjęcie zdjęta",
          "Możesz ponownie zmieniać zdjęcie profilowe — minął czas przerwy."
        );
      } catch (eNotif) {}
      delete mapa[uid];
      zmieniono = true;
    }
  });
  if (zmieniono || !raw) {
    props.setProperty("profil_timeouts_json", JSON.stringify(mapa));
  }
  return mapa;
}

function _zapiszMapeTimeoutowProfil(mapa) {
  PropertiesService.getScriptProperties().setProperty("profil_timeouts_json", JSON.stringify(mapa || {}));
}

function _timeoutDlaUsera(userId) {
  var id = String(userId || "").trim();
  if (!id) return null;
  var mapa = _odczytajMapeTimeoutowProfil();
  var e = mapa[id];
  if (!e) return null;
  var doTs = new Date(e.doIso).getTime();
  if (isNaN(doTs) || doTs <= Date.now()) return null;
  return {
    userId: id,
    doTs: doTs,
    doIso: e.doIso,
    powod: String(e.powod || "").trim(),
    przez: String(e.przez || "").trim()
  };
}

/** Status: lista aktywnych przerw + czy BIEŻĄCY user ma blokadę. */
function getStatusCustomProfil(dlaUserId) {
  try {
    var mapa = _odczytajMapeTimeoutowProfil();
    var lista = [];
    Object.keys(mapa).forEach(function(uid) {
      var e = mapa[uid];
      if (!e || !e.doIso) return;
      var doTs = new Date(e.doIso).getTime();
      if (isNaN(doTs) || doTs <= Date.now()) return;
      lista.push({
        userId: uid,
        doTs: doTs,
        doIso: e.doIso,
        powod: String(e.powod || "").trim(),
        przez: String(e.przez || "").trim()
      });
    });
    lista.sort(function(a, b) { return a.doTs - b.doTs; });

    var id = String(dlaUserId || "").trim();
    var moja = null;
    if (id) {
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].userId === id) { moja = lista[i]; break; }
      }
    }

    return {
      sukces: true,
      aktywny: lista.length > 0,
      lista: lista,
      // kompatybilność wsteczna (pierwsza / własna)
      userId: moja ? moja.userId : (lista[0] ? lista[0].userId : ""),
      doTs: moja ? moja.doTs : (lista[0] ? lista[0].doTs : 0),
      doIso: moja ? moja.doIso : (lista[0] ? lista[0].doIso : ""),
      powod: moja ? moja.powod : (lista[0] ? lista[0].powod : ""),
      zablokowanyDlaMnie: !!moja
    };
  } catch (e) {
    return { sukces: false, aktywny: false, lista: [], zablokowanyDlaMnie: false };
  }
}

/**
 * Nadaje / przedłuża przerwę dla JEDNEJ osoby (nie kasuje innych).
 * dni + godziny od teraz. powod — tekst w modalu dla użytkownika.
 */
function nadajTimeoutProfil(celUserId, dni, godziny, powod, wykonawcaId) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Brak uprawnień administratora." };

    var cel = String(celUserId || "").trim();
    if (!cel) return { sukces: false, wiadomosc: "Wybierz użytkownika." };

    var rolaCelu = pobierzRoleUzytkownika(cel);
    if (rolaCelu === "ADMIN") {
      return { sukces: false, wiadomosc: "Nie można blokować zdjęcia profilowego administratora." };
    }

    var d = parseInt(dni, 10) || 0;
    var g = parseInt(godziny, 10) || 0;
    if (d < 0) d = 0;
    if (g < 0) g = 0;
    if (d === 0 && g === 0) {
      return { sukces: false, wiadomosc: "Podaj czas trwania (dni i/lub godziny)." };
    }
    if (d > 365) d = 365;
    if (g > 23) g = 23;

    var powodTxt = String(powod || "").trim();
    if (!powodTxt) powodTxt = "Naruszenie regulaminu zdjęć profilowych.";

    var koniec = new Date();
    koniec.setTime(koniec.getTime() + d * 24 * 3600 * 1000 + g * 3600 * 1000);
    var doIso = koniec.toISOString();

    var mapa = _odczytajMapeTimeoutowProfil();
    mapa[cel] = {
      doIso: doIso,
      powod: powodTxt,
      przez: String(wykonawcaId || "").trim()
    };
    _zapiszMapeTimeoutowProfil(mapa);

    var doPl = Utilities.formatDate(koniec, _APP_TZ, "dd.MM.yyyy HH:mm");
    var klucz = "przerwa_profil_" + cel + "_" + doIso;
    var opis = "Blokada z powodu: " + powodTxt + " (do " + doPl + ")";
    _zapiszZdarzeniePowiadomienia(
      cel, klucz, "profil", "🔒",
      "Blokada edycji zdjęcia profilowego",
      opis,
      "page-ustawienia"
    );
    wyslijPowiadomienieDoUserow(
      cel,
      "Blokada edycji zdjęcia profilowego",
      "Masz przerwę na zmianę zdjęcia do " + doPl + ". Blokada z powodu: " + powodTxt
    );

    return {
      sukces: true,
      userId: cel,
      doTs: koniec.getTime(),
      doIso: doIso,
      powod: powodTxt,
      lista: getStatusCustomProfil(wykonawcaId).lista || [],
      wiadomosc: "Nadano przerwę osobie ID " + cel + " do " + doPl + ". Użytkownik został powiadomiony."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/** Zdejmuje przerwę TYLKO dla wskazanej osoby (celUserId). */
function usunTimeoutProfil(celUserId, wykonawcaId) {
  try {
    // Kompatybilność: stare wywołanie usunTimeoutProfil(wykonawcaId)
    if (arguments.length === 1) {
      wykonawcaId = celUserId;
      celUserId = "";
    }
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Brak uprawnień administratora." };

    var cel = String(celUserId || "").trim();
    if (!cel) return { sukces: false, wiadomosc: "Wybierz osobę, której zdejmujesz przerwę." };

    var mapa = _odczytajMapeTimeoutowProfil();
    if (!mapa[cel]) {
      return { sukces: false, wiadomosc: "Ta osoba nie ma aktywnej przerwy." };
    }
    var staryPowod = String((mapa[cel] && mapa[cel].powod) || "").trim();
    delete mapa[cel];
    _zapiszMapeTimeoutowProfil(mapa);

    var opis = "Administrator zdjął Ci przerwę na edycję zdjęcia profilowego." +
      (staryPowod ? ("\nPierwotny powód blokady: " + staryPowod) : "");
    _zapiszZdarzeniePowiadomienia(
      cel,
      "przerwa_zdjeta_admin_" + cel + "_" + Date.now(),
      "profil", "✅",
      "Przerwa na zdjęcie zdjęta",
      opis,
      "page-ustawienia"
    );
    wyslijPowiadomienieDoUserow(
      cel,
      "Przerwa na zdjęcie zdjęta",
      "Administrator zdjął przerwę — możesz ponownie zmieniać zdjęcie profilowe."
    );

    return {
      sukces: true,
      userId: cel,
      lista: getStatusCustomProfil(wykonawcaId).lista || [],
      wiadomosc: "Przerwa zdjęta dla ID " + cel + ". Użytkownik został powiadomiony."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

// ----------------------------------------------------------------------
// ODWOŁANIA OD PRZERWY NA ZDJĘCIE PROFILOWE
// Arkusz: Odwolania_profil
//   UserID | Tekst | Status | Data | AdminID | Odpowiedz
// ----------------------------------------------------------------------

function _arkuszOdwolanProfil() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Odwolania_profil");
  if (!sheet) {
    sheet = ss.insertSheet("Odwolania_profil");
    sheet.appendRow(["UserID", "Tekst", "Status", "Data", "AdminID", "Odpowiedz"]);
  }
  return sheet;
}

function zlozOdwolanieProfil(userId, tekst) {
  try {
    var id = String(userId || "").trim();
    var t = String(tekst || "").trim();
    if (!id) return { sukces: false, wiadomosc: "Brak ID." };
    if (t.length < 10) return { sukces: false, wiadomosc: "Napisz dłuższe uzasadnienie (min. 10 znaków)." };

    if (!_timeoutDlaUsera(id)) {
      return { sukces: false, wiadomosc: "Nie masz aktywnej przerwy na edycję zdjęcia." };
    }

    var sheet = _arkuszOdwolanProfil();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === id && String(data[i][2]).trim() === "Nowy") {
        return { sukces: false, wiadomosc: "Masz już złożone odwołanie oczekujące na rozpatrzenie." };
      }
    }

    sheet.appendRow([id, t, "Nowy", new Date(), "", ""]);
    try {
      _powiadomAdminowONowymDoPrzegladu(
        "Nowe odwołanie (profil / zdjęcie)",
        "ID " + id + " złożył odwołanie — do rozpatrzenia",
        "page-wnioski",
        id
      );
    } catch (eN) {}
    return { sukces: true, wiadomosc: "Odwołanie wysłane. Admin je rozpatrzy." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getOdwolaniaProfil(wykonawcaId) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (rola !== "ADMIN") return { sukces: false, lista: [] };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Odwolania_profil");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, lista: [] };
    var data = sheet.getDataRange().getValues();
    var lista = [];
    var tz = _APP_TZ;
    for (var i = 1; i < data.length; i++) {
      var status = String(data[i][2] || "").trim() || "Nowy";
      var d = data[i][3] instanceof Date ? data[i][3] : new Date(data[i][3]);
      lista.push({
        wiersz: i + 1,
        userId: String(data[i][0] || "").trim(),
        tekst: String(data[i][1] || ""),
        status: status,
        data: isNaN(d.getTime()) ? "" : Utilities.formatDate(d, tz, "dd.MM.yyyy HH:mm"),
        adminId: String(data[i][4] || "").trim(),
        odpowiedz: String(data[i][5] || "")
      });
    }
    // Nowe na górze
    lista.sort(function(a, b) {
      if (a.status === "Nowy" && b.status !== "Nowy") return -1;
      if (a.status !== "Nowy" && b.status === "Nowy") return 1;
      return b.wiersz - a.wiersz;
    });
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [] };
  }
}

function rozpatrzOdwolanieProfil(wiersz, akceptuj, wykonawcaId, komentarz) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Brak uprawnień administratora." };
    var row = parseInt(wiersz, 10);
    if (!row || row < 2) return { sukces: false, wiadomosc: "Nieprawidłowy wiersz." };

    // >>> NOWE: konflikt interesów — nie można rozpatrzyć własnego odwołania.
    try {
      var _shO = _arkuszOdwolanProfil();
      if (row <= _shO.getLastRow()) {
        var wnioskId = _normId(_shO.getRange(row, 1).getValue());
        var execId = _normId(wykonawcaId);
        if (wnioskId && execId && wnioskId === execId) {
          return { sukces: false, konfliktInteresow: true,
                   wiadomosc: "Nie możesz rozpatrzyć własnego odwołania. Poproś innego administratora." };
        }
      }
    } catch (eK) {}

    // >>> NOWE: konflikt interesów — nie można rozpatrzyć własnego odwołania.
    try {
      var _shO = _arkuszOdwolanProfil();
      if (row <= _shO.getLastRow()) {
        var wnioskId = _normId(_shO.getRange(row, 1).getValue());
        var execId = _normId(wykonawcaId);
        if (wnioskId && execId && wnioskId === execId) {
          return { sukces: false, konfliktInteresow: true,
                   wiadomosc: "Nie możesz rozpatrzyć własnego odwołania. Poproś innego administratora." };
        }
      }
    } catch (eK) {}

    var sheet = _arkuszOdwolanProfil();
    if (row > sheet.getLastRow()) return { sukces: false, wiadomosc: "Brak takiego odwołania." };

    var userId = String(sheet.getRange(row, 1).getValue() || "").trim();
    var status = String(sheet.getRange(row, 3).getValue() || "").trim();
    if (status !== "Nowy") return { sukces: false, wiadomosc: "To odwołanie było już rozpatrzone." };

    var kom = String(komentarz || "").trim();

    if (akceptuj) {
      var mapa = _odczytajMapeTimeoutowProfil();
      if (mapa[userId]) {
        delete mapa[userId];
        _zapiszMapeTimeoutowProfil(mapa);
      }
      sheet.getRange(row, 3).setValue("Zaakceptowano");
      sheet.getRange(row, 5).setValue(String(wykonawcaId || ""));
      sheet.getRange(row, 6).setValue(kom || "Przerwa zdjęta.");
      var opisOk = "Administrator zdjął Ci przerwę na edycję zdjęcia profilowego." +
        (kom ? ("\nKomentarz: " + kom) : "");
      _zapiszZdarzeniePowiadomienia(
        userId,
        "odwolanie_ok_" + row + "_" + Date.now(),
        "profil", "✅",
        "Odwołanie przyjęte",
        opisOk,
        "page-wnioski"
      );
      wyslijPowiadomienieDoUserow(
        userId,
        "Odwołanie przyjęte",
        "Przerwa na edycję zdjęcia została zdjęta." + (kom ? (" Komentarz: " + kom) : "")
      );
      _logAdmin(wykonawcaId, "", akceptuj ? "PROFIL_ODWOLANIE_OK" : "PROFIL_ODWOLANIE_NO", String(wiersz||""), String(komentarz||""));
    return { sukces: true, wiadomosc: "Odwołanie zaakceptowane — przerwa zdjęta." };
    } else {
      sheet.getRange(row, 3).setValue("Odrzucono");
      sheet.getRange(row, 5).setValue(String(wykonawcaId || ""));
      sheet.getRange(row, 6).setValue(kom || "Odwołanie odrzucone.");
      var opisNo = "Administrator nie zdjął przerwy na edycję zdjęcia profilowego." +
        (kom ? ("\nKomentarz: " + kom) : "");
      _zapiszZdarzeniePowiadomienia(
        userId,
        "odwolanie_no_" + row + "_" + Date.now(),
        "profil", "❌",
        "Odwołanie odrzucone",
        opisNo,
        "page-wnioski"
      );
      wyslijPowiadomienieDoUserow(
        userId,
        "Odwołanie odrzucone",
        "Przerwa na edycję zdjęcia nadal obowiązuje." + (kom ? (" Komentarz: " + kom) : "")
      );
      return { sukces: true, wiadomosc: "Odwołanie odrzucone." };
    }
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getMojeOdwolaniaProfil(userId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: true, lista: [] };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Odwolania_profil");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, lista: [] };
    var data = sheet.getDataRange().getValues();
    var lista = [];
    var tz = _APP_TZ;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0] || "").trim() !== uid) continue;
      var d = data[i][3] instanceof Date ? data[i][3] : new Date(data[i][3]);
      lista.push({
        wiersz: i + 1,
        userId: uid,
        tekst: String(data[i][1] || ""),
        status: String(data[i][2] || "").trim() || "Nowy",
        data: isNaN(d.getTime()) ? "" : Utilities.formatDate(d, tz, "dd.MM.yyyy HH:mm"),
        odpowiedz: String(data[i][5] || "")
      });
    }
    lista.sort(function(a, b) { return b.wiersz - a.wiersz; });
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [] };
  }
}

function _czyMozeUstawiacZdjecieProfilowe(userId) {
  var rola = pobierzRoleUzytkownika(userId);
  if (rola === "ADMIN" || rola === "MODERATOR") return true;
  return !_timeoutDlaUsera(userId);
}

function zapiszZdjecieProfilowe(userId, base64Data, mimeType, fileName) {
  try {
    var id = String(userId || "").trim();
    if (!id) return { sukces: false, wiadomosc: "Brak ID użytkownika." };
    if (!base64Data) return { sukces: false, wiadomosc: "Brak danych zdjęcia." };

    var t = _timeoutDlaUsera(id);
    if (t) {
      var rola = pobierzRoleUzytkownika(id);
      if (!_czyAdminLubKsiadz(rola)) {
        return {
          sukces: false,
          zablokowane: true,
          powod: t.powod,
          doTs: t.doTs,
          doIso: t.doIso,
          wiadomosc: "Masz przerwę na edycję zdjęcia profilowego."
        };
      }
    }

    var upload = uploadZdjecie(base64Data, fileName || ("profil_" + id + ".jpg"), mimeType || "image/jpeg");
    if (!upload || !upload.sukces) {
      return { sukces: false, wiadomosc: (upload && upload.wiadomosc) ? upload.wiadomosc : "Błąd uploadu zdjęcia." };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kandydaci");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza Kandydaci." };
    _upewnijNaglowekZdjeciaKandydaci(sheet);

    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === id) {
        sheet.getRange(i + 1, 8).setValue(upload.link);
        _cRemove("kandydaci_raw");
        return { sukces: true, link: upload.link, wiadomosc: "Zdjęcie profilowe zapisane." };
      }
    }
    return { sukces: false, wiadomosc: "Nie znaleziono użytkownika w bazie." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/** Usuwa zdjęcie profilowe.
 *  - Własne: każdy (własne ID).
 *  - Cudze: tylko ADMIN, i tylko wobec nie-adminów — wymaga powodu.
 *  wykonawcaId — ID osoby klikającej „Usuń”.
 *  powod — wymagany przy usuwaniu cudzego (pokazywany użytkownikowi).
 */
function usunZdjecieProfiloweSerwer(userId, wykonawcaId, powod) {
  try {
    var id = String(userId || "").trim();
    if (!id) return { sukces: false, wiadomosc: "Brak ID użytkownika." };

    var wykonawca = String(wykonawcaId || "").trim();
    var toWlasne = !wykonawca || wykonawca === id;
    var powodTxt = String(powod || "").trim();

    if (!toWlasne) {
      var rolaWykonawcy = pobierzRoleUzytkownika(wykonawca);
      if (rolaWykonawcy !== "ADMIN") {
        return { sukces: false, wiadomosc: "Tylko administrator może usuwać zdjęcia innych osób." };
      }
      var rolaCelu = pobierzRoleUzytkownika(id);
      if (rolaCelu === "ADMIN") {
        return { sukces: false, wiadomosc: "Nie można usuwać zdjęcia profilowego innego administratora." };
      }
      if (!powodTxt) {
        return { sukces: false, wiadomosc: "Podaj powód usunięcia zdjęcia — zobaczy go użytkownik." };
      }
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kandydaci");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza Kandydaci." };
    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === id) {
        sheet.getRange(i + 1, 8).setValue("");
        _cRemove("kandydaci_raw");

        // Powiadomienie tylko gdy admin usuwa cudze
        if (!toWlasne && powodTxt) {
          var klucz = "usun_zdjecie_" + id + "_" + Date.now();
          var opis = "Blokada z powodu: " + powodTxt;
          _zapiszZdarzeniePowiadomienia(
            id, klucz, "profil", "🖼️",
            "Usunięto Twoje zdjęcie profilowe",
            opis,
            "page-ustawienia"
          );
          wyslijPowiadomienieDoUserow(
            id,
            "Usunięto zdjęcie profilowe",
            "Administrator usunął Twoje zdjęcie profilowe. Blokada z powodu: " + powodTxt
          );
        }

        return { sukces: true, wiadomosc: "Zdjęcie usunięte." + (!toWlasne ? " Użytkownik został powiadomiony." : "") };
      }
    }
    return { sukces: false, wiadomosc: "Nie znaleziono użytkownika." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}


/**
 * Zwraca klucze nowych powiadomień dla użytkownika i (opcjonalnie) wysyła
 * push OneSignal dla tych z flagą push:true.
 *
 * kandydaci: [{klucz, tytul, tresc, push}, ...]  ALBO  ["klucz1", ...]
 *   Dla kompatybilności wstecznej: jeśli w tablicy są stringi, traktujemy
 *   je jak {klucz: <string>, push: false} (bez wysyłania pusha).
 *
 * LockService gwarantuje, że przy dwóch równoległych pollach TEN SAM klucz
 * zostanie uznany za nowy tylko RAZ — a co za tym idzie push też pójdzie
 * dokładnie raz.
 */
function filtrujNowePowiadomienia(userId, sessionToken, kandydaci) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (!rola) return { success: false, nowe: [] };
    if (!Array.isArray(kandydaci) || kandydaci.length === 0) return { success: true, nowe: [] };

    // Normalizuj wejście do tablicy obiektów {klucz, tytul, tresc, push}
    var lista = kandydaci.map(function(k) {
      if (typeof k === "string") return { klucz: k, tytul: "", tresc: "", push: false };
      return {
        klucz: String(k && k.klucz || "").trim(),
        tytul: String(k && k.tytul || "").trim(),
        tresc: String(k && k.tresc || "").trim(),
        push: !!(k && k.push)
      };
    }).filter(function(x) { return x.klucz; });

    var lock = LockService.getScriptLock();
    var gotLock = false;
    try { gotLock = lock.tryLock(8000); } catch (eL) {}
    if (!gotLock) return { success: true, nowe: [] };

    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName("Powiadomienia_wyslane");
      if (!sheet) {
        sheet = ss.insertSheet("Powiadomienia_wyslane");
        sheet.appendRow(["UserID", "Klucz", "Data"]);
      }

      var uid = String(userId).trim();
      var dane = sheet.getDataRange().getValues();
      var wyslaneMap = {};
      for (var i = 1; i < dane.length; i++) {
        if (String(dane[i][0]).trim() === uid) {
          wyslaneMap[String(dane[i][1]).trim()] = true;
        }
      }

      var teraz = new Date();
      var nowe = [];
      var wierszeDoZapisu = [];
      var doPush = [];

      lista.forEach(function(x) {
        if (!wyslaneMap[x.klucz]) {
          nowe.push(x.klucz);
          wierszeDoZapisu.push([uid, x.klucz, teraz]);
          wyslaneMap[x.klucz] = true;
          if (x.push && x.tytul) {
            doPush.push({ tytul: x.tytul, tresc: x.tresc || "" });
          }
        }
      });

      if (wierszeDoZapisu.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, wierszeDoZapisu.length, 3).setValues(wierszeDoZapisu);
      }

      // Push OneSignal — dopiero po zapisaniu kluczy, żeby nawet przy błędzie
      // pusha nie było efektu "wysłane w kółko" (klucz już oznaczony).
      if (doPush.length > 0 && typeof wyslijPowiadomienieDoUserow === "function") {
        doPush.forEach(function(p) {
          try {
            wyslijPowiadomienieDoUserow(uid, p.tytul, p.tresc);
          } catch (eP) {}
        });
      }

      return { success: true, nowe: nowe };
    } finally {
      try { lock.releaseLock(); } catch (eR) {}
    }
  } catch (e) {
    return { success: false, nowe: [], error: e.message };
  }
}

// ----------------------------------------------------------------------
// MODUŁ DOSTĘPNOŚCI — zapis odpowiedzi ministrantów
// ----------------------------------------------------------------------

function zapiszDostepnoscServera(userId, imie, eventKlucz, wartosc) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Dostepnosc");
    if (!sheet) {
      sheet = ss.insertSheet("Dostepnosc");
      sheet.appendRow(["Data", "User ID", "Imię", "Wydarzenie (klucz)", "Odpowiedź"]);
    }
    // Sprawdź czy już istnieje wpis dla tego usera i eventu
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]).trim() === String(userId).trim() &&
          String(data[i][3]).trim() === String(eventKlucz).trim()) {
        // Aktualizuj istniejący
        sheet.getRange(i + 1, 5).setValue(wartosc);
        sheet.getRange(i + 1, 1).setValue(new Date());
        return { sukces: true };
      }
    }
    // Dodaj nowy
    sheet.appendRow([new Date(), String(userId).trim(), String(imie).trim(), String(eventKlucz).trim(), wartosc]);
    return { sukces: true };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

// ----------------------------------------------------------------------
// POBIERANIE DOSTĘPNOŚCI (do frontu — trwałość i panel admina)
// ----------------------------------------------------------------------

function getDostepnoscUzytkownika(userId) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Dostepnosc");
    if (!sheet) return {};
    var data = sheet.getDataRange().getValues();
    var wynik = {};
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]).trim() === String(userId).trim()) {
        wynik[String(data[i][3]).trim()] = String(data[i][4]).trim();
      }
    }
    return wynik;
  } catch(e) {
    return {};
  }
}

function getDostepnoscAdmin(userId) {
  try {
    var uid = _normId(userId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && rola !== "KSIADZ") {
      return { sukces: false, wiadomosc: "Brak uprawnień.", wydarzenia: [] };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = _APP_TZ;

    // 1. Lista wszystkich ministrantów (pomijamy księży)
    var osoby = {};
    var kand = ss.getSheetByName("Kandydaci");
    if (kand && kand.getLastRow() > 1) {
      var dk = kand.getDataRange().getValues();
      for (var i = 1; i < dk.length; i++) {
        var id = _normId(dk[i][0]);
        if (!id) continue;
        var ranga = String(dk[i][6] || "").toLowerCase();
        if (ranga.indexOf("ksi") === 0) continue;
        osoby[id] = String(dk[i][1] || "").trim() || id;
      }
    }

    // 2. Odpowiedzi z arkusza Dostepnosc — grupowane po PEŁNYM kluczu
    //    "dost_<ts>". Pełen timestamp jest jednoznaczny dla każdej
    //    uroczystości — nawet jeśli dwie mają tę samą nazwę, klucze
    //    są inne i NIE mieszają się.
    var odpowiedzi = {};
    var sh = ss.getSheetByName("Dostepnosc");
    if (sh && sh.getLastRow() > 1) {
      var dd = sh.getDataRange().getValues();
      for (var r = 1; r < dd.length; r++) {
        var dts = dd[r][0] instanceof Date ? dd[r][0] : new Date(dd[r][0]);
        var idO = _normId(dd[r][1]);
        var klucz = String(dd[r][3] || "").trim();
        var odp = String(dd[r][4] || "").trim().toLowerCase();
        if (!klucz || !idO || !odp) continue;
        if (!odpowiedzi[klucz]) odpowiedzi[klucz] = {};
        if (!odpowiedzi[klucz][idO]) odpowiedzi[klucz][idO] = [];
        odpowiedzi[klucz][idO].push({
          odpowiedz: odp,
          ts: isNaN(dts.getTime()) ? 0 : dts.getTime(),
          godz: isNaN(dts.getTime()) ? "" : Utilities.formatDate(dts, tz, "HH:mm"),
          data: isNaN(dts.getTime()) ? "" : Utilities.formatDate(dts, tz, "dd.MM.yyyy")
        });
      }
    }

    // 3. Najbliższe uroczystości z Kalendarza (90 dni wprzód + bieżące)
    var terazMs = new Date().getTime();
    var granica = terazMs + 90 * 24 * 3600 * 1000;
    var wydarzenia = [];
    var kal = ss.getSheetByName("Kalendarz");
    if (kal && kal.getLastRow() > 1) {
      var dk2 = kal.getDataRange().getValues();
      for (var k = 1; k < dk2.length; k++) {
        if (!dk2[k][0]) continue;
        var dt = dk2[k][0] instanceof Date ? dk2[k][0] : new Date(dk2[k][0]);
        if (isNaN(dt.getTime())) continue;
        var ts = dt.getTime();
        if (ts < terazMs - 3600 * 1000 || ts > granica) continue;

        var nazwa = String(dk2[k][1] || "").trim();
        var opis = String(dk2[k][3] || "").trim();
        var low = nazwa.toLowerCase();
        var czyUrocz = low.indexOf("uroczyst") >= 0
                    || low.indexOf("triduum") >= 0
                    || low.indexOf("wielka sobota") >= 0
                    || low.indexOf("wniebow") >= 0
                    || low.indexOf("boże") >= 0
                    || low.indexOf("boze") >= 0;
        if (!czyUrocz) continue;

        // KLUCZOWE: klucz identyczny z tym, co zapisuje klient (dost_<ts>).
        // Dzięki temu bierzemy odpowiedzi TYLKO dla tej konkretnej uroczystości.
        var key = "dost_" + ts;
        var wpisy = odpowiedzi[key] || {};

        var dostList = [], niedostList = [], nieodpList = [], historia = [];

        Object.keys(osoby).forEach(function(id) {
          var imie = osoby[id];
          var w = wpisy[id];
          if (!w || !w.length) {
            nieodpList.push({ id: id, imie: imie });
            return;
          }
          w.sort(function(a, b) { return b.ts - a.ts; });
          var n = w[0]; // najnowsza odpowiedź
          var cell = {
            id: id,
            imie: imie,
            godz: n.godz,
            data: n.data,
            czas: (n.godz ? (n.godz + " ") : "") + (n.data || "")
          };
          if (n.odpowiedz === "dostepny") dostList.push(cell);
          else niedostList.push(cell); // "niedostepny" lub nieznana wartość
          // Pełna historia zmian
          w.forEach(function(x) {
            historia.push({
              imie: imie,
              id: id,
              odpowiedz: x.odpowiedz,
              godz: x.godz,
              data: x.data,
              ts: x.ts
            });
          });
        });

        dostList.sort(function(a,b) { return a.imie.localeCompare(b.imie, "pl"); });
        niedostList.sort(function(a,b) { return a.imie.localeCompare(b.imie, "pl"); });
        nieodpList.sort(function(a,b) { return a.imie.localeCompare(b.imie, "pl"); });
        historia.sort(function(a,b) { return b.ts - a.ts; });

        wydarzenia.push({
          klucz: key,
          ts: ts,
          nazwa: nazwa,
          opis: opis,
          dataPl: Utilities.formatDate(dt, tz, "dd.MM.yyyy (EEEE) HH:mm"),
          dostepni: dostList,
          niedostepni: niedostList,
          nieodpowiedzieli: nieodpList,
          historia: historia,
          lacznie: Object.keys(osoby).length
        });
      }
      wydarzenia.sort(function(a,b) { return a.ts - b.ts; });
    }

    return { sukces: true, wydarzenia: wydarzenia };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e), wydarzenia: [] };
  }
}

// ----------------------------------------------------------------------
// POWTARZAJĄCE SIĘ WYDARZENIA W KALENDARZU
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// POWTARZAJĄCE SIĘ WYDARZENIA W KALENDARZU
// Tryby: codzien, cotygodnia, dzien_miesiaca,
//        pierwszy_poniedzialek/wtorek/sroda/czwartek/piatek/sobota/niedziela
// ----------------------------------------------------------------------

// Czytelne etykiety trybów powtarzania — wyświetlane przy zgrupowanej
// pozycji na liście planów, żeby było wiadomo jak często wydarzenie wraca.
var ETYKIETY_POWTARZANIA = {
  'codzien':               'Powtarza się codziennie',
  'cotygodnia':            'Powtarza się co tydzień',
  'dzien_miesiaca':        'Powtarza się co miesiąc',
  'pierwszy_niedziela':    'Powtarza się w 1. niedzielę miesiąca',
  'pierwszy_poniedzialek': 'Powtarza się w 1. poniedziałek miesiąca',
  'pierwszy_wtorek':       'Powtarza się w 1. wtorek miesiąca',
  'pierwszy_sroda':        'Powtarza się w 1. środę miesiąca',
  'pierwszy_czwartek':     'Powtarza się w 1. czwartek miesiąca',
  'pierwszy_piatek':       'Powtarza się w 1. piątek miesiąca',
  'pierwszy_sobota':       'Powtarza się w 1. sobotę miesiąca'
};

function dodajPowtarzajaceWydarzenia(dataStartStr, wydarzenie, punkty, powtarzanie, dataKoncaStr, dzienMiesiaca, opis, oknoOdMin, oknoDoMin) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKalendarz = ss.getSheetByName("Kalendarz");
    if (!sheetKalendarz) return "Błąd: Brak arkusza 'Kalendarz'";
    _upewnijNaglowkiKalendarza(sheetKalendarz);
    var opisWpis = String(opis || "").trim();

    // OKNO ODBIJANIA (kolumny G/H) — wspólne dla całej serii powtarzalnej.
    var _oOd = (typeof oknoOdMin === "number" && !isNaN(oknoOdMin) && oknoOdMin >= 0) ? oknoOdMin : "";
    var _oDo = (typeof oknoDoMin === "number" && !isNaN(oknoDoMin) && oknoDoMin >= 0) ? oknoDoMin : "";

    // Wspólny identyfikator dla wszystkich wystąpień tej serii — dzięki
    // niemu lista planów na przyszłość może pokazać JEDNĄ pozycję z
    // notatką "powtarza się" zamiast osobnego wiersza dla każdej daty.
    var groupId = "REP-" + new Date().getTime() + "-" + Math.floor(Math.random() * 100000);
    var etykietaPowtarzania = ETYKIETY_POWTARZANIA[powtarzanie] || "Wydarzenie cykliczne";

    var dataStart = new Date(dataStartStr);
    var dataKonca = new Date(dataKoncaStr + "T23:59:00");
    var pkt    = parseInt(punkty) || 0;
    var MAX    = 200;
    var dodano = 0;
    var daty   = [];

    // Mapa nazwy trybu na numer dnia tygodnia (0=Nd,1=Pn,...,6=Sb)
    var PIERWSZY_DZIEN = {
      'pierwszy_niedziela':    0,
      'pierwszy_poniedzialek': 1,
      'pierwszy_wtorek':       2,
      'pierwszy_sroda':        3,
      'pierwszy_czwartek':     4,
      'pierwszy_piatek':       5,
      'pierwszy_sobota':       6
    };

    if (powtarzanie === 'codzien') {
      var cur = new Date(dataStart);
      while (cur <= dataKonca && daty.length < MAX) {
        daty.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
      }

    } else if (powtarzanie === 'cotygodnia') {
      var cur = new Date(dataStart);
      while (cur <= dataKonca && daty.length < MAX) {
        daty.push(new Date(cur));
        cur.setDate(cur.getDate() + 7);
      }

    } else if (powtarzanie === 'dzien_miesiaca') {
      var dzien = Math.min(Math.max(parseInt(dzienMiesiaca) || 1, 1), 31);
      var cur = new Date(dataStart.getFullYear(), dataStart.getMonth(), 1);
      while (cur <= dataKonca && daty.length < MAX) {
        var maxDni  = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
        var targetD = Math.min(dzien, maxDni);
        var target  = new Date(cur.getFullYear(), cur.getMonth(), targetD,
                               dataStart.getHours(), dataStart.getMinutes(), 0, 0);
        if (target >= dataStart && target <= dataKonca) daty.push(new Date(target));
        cur.setMonth(cur.getMonth() + 1);
      }

    } else if (PIERWSZY_DZIEN.hasOwnProperty(powtarzanie)) {
      var targetDow = PIERWSZY_DZIEN[powtarzanie]; // 0-6
      var cur = new Date(dataStart.getFullYear(), dataStart.getMonth(), 1);
      while (cur <= dataKonca && daty.length < MAX) {
        // Znajdź pierwszy targetDow w tym miesiącu
        var pierwszyW = new Date(cur.getFullYear(), cur.getMonth(), 1);
        while (pierwszyW.getDay() !== targetDow) {
          pierwszyW.setDate(pierwszyW.getDate() + 1);
        }
        pierwszyW.setHours(dataStart.getHours(), dataStart.getMinutes(), 0, 0);
        if (pierwszyW >= dataStart && pierwszyW <= dataKonca) {
          daty.push(new Date(pierwszyW));
        }
        cur.setMonth(cur.getMonth() + 1);
      }

    } else {
      return "Nieznany tryb powtarzania: " + powtarzanie;
    }

    daty.forEach(function(d) {
      sheetKalendarz.appendRow([d, wydarzenie, pkt, opisWpis, groupId, etykietaPowtarzania, _oOd, _oDo]);
      dodano++;
    });

    if (dodano === 0) {
      return "Nie dodano żadnych wydarzeń — sprawdź, czy data 'Powtarzaj do' jest późniejsza niż data startu i czy pasuje do wybranego trybu powtarzania (np. dla \"dzień miesiąca\" wybrany dzień mógł już minąć w obu miesiącach z podanego zakresu).";
    }

    return "Dodano " + dodano + " wydarzeń do kalendarza!";
  } catch(e) {
    return "Błąd: " + e.message;
  }
}
// ----------------------------------------------------------------------
// ROK FORMACYJNY — zamknięcie, archiwizacja, przywracanie, zmiana daty
// Arkusze archiwizowane: Logi_ręczne, Logi_czytnik, Dyżury, Kalendarz,
//   Społeczność (posty+ankiety), Wnioski_dyzury, Kandydaci (punkty)
// Sufiks archiwum: np. _2025_2026
// Stan roku przechowywany w PropertiesService:
//   rok_aktywny (true/false), rok_nazwa, rok_start
// ----------------------------------------------------------------------

function getStatusRokuFormacyjnego() {
  try {
    var props = PropertiesService.getScriptProperties();
    var aktywny = props.getProperty('rok_aktywny');
    return {
      rok_aktywny: (aktywny === null || aktywny === 'true'), // domyślnie aktywny
      rok_nazwa:   props.getProperty('rok_nazwa') || '',
      rok_start:   props.getProperty('rok_start') || ''
    };
  } catch(e) {
    return { rok_aktywny: true, rok_nazwa: '', rok_start: '' };
  }
}

function zamknijRokFormacyjny(nowaRokNazwa, nowyRokStart, userId, sessionToken) {
  try {
    var _uidZ = String(userId || "").trim();
    if (_uidZ === "1111") return { sukces: false, wiadomosc: "Brak uprawnień do zamykania roku." };
    var _rolaZ = _normalizujRole(pobierzRoleUzytkownika(_uidZ));
    if (_rolaZ !== "ADMIN") return { sukces: false, wiadomosc: "Tylko administrator może zamknąć rok formacyjny." };

    var rola = pobierzRoleUzytkownika(userId);
    if (rola !== 'ADMIN') return { sukces: false, wiadomosc: 'Brak uprawnień.' };

    var props = PropertiesService.getScriptProperties();
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Nazwa archiwum z bieżącego roku
    var biezacyRok = props.getProperty('rok_nazwa') || String(new Date().getFullYear());
    var sufiks = '_' + biezacyRok.replace(/[\/\s]/g, '_');
    var archiwumNazwa = biezacyRok;

    // Arkusze do skopiowania do archiwum
    var doArchiwizacji = [
      'Logi_ręczne',
      'Logi_czytnik',
      'Dyżury',
      'Kalendarz',
      'Społeczność',
      'Wnioski_dyzury'
    ];

    doArchiwizacji.forEach(function(nazwa) {
      var sheet = ss.getSheetByName(nazwa);
      if (!sheet) return;
      // Usuń starą kopię jeśli istnieje (nadpisz)
      var stara = ss.getSheetByName(nazwa + sufiks);
      if (stara) ss.deleteSheet(stara);
      // Kopiuj i zmień nazwę
      var kopia = sheet.copyTo(ss);
      kopia.setName(nazwa + sufiks);
    });

    // Kopiuj Kandydaci (żeby zachować historię punktów)
    var sheetKandydaci = ss.getSheetByName('Kandydaci');
    if (sheetKandydaci) {
      var staraKopia = ss.getSheetByName('Kandydaci' + sufiks);
      if (staraKopia) ss.deleteSheet(staraKopia);
      sheetKandydaci.copyTo(ss).setName('Kandydaci' + sufiks);

      // Zeruj punkty w bieżącym arkuszu Kandydaci (kolumna 3)
      var ostatniWiersz = sheetKandydaci.getLastRow();
      if (ostatniWiersz > 1) {
        sheetKandydaci.getRange(2, 3, ostatniWiersz - 1, 1).setValue(0);
      }
    }

    // Wyczyść bieżące arkusze (zostaw nagłówki)
    var doWyczyszczenia = ['Logi_ręczne', 'Logi_czytnik', 'Dyżury', 'Kalendarz', 'Społeczność', 'Wnioski_dyzury'];
    doWyczyszczenia.forEach(function(nazwa) {
      var sheet = ss.getSheetByName(nazwa);
      if (!sheet || sheet.getLastRow() <= 1) return;
      sheet.deleteRows(2, sheet.getLastRow() - 1);
    });

    // Zapisz nowy stan roku
    props.setProperty('rok_aktywny', 'false');
    props.setProperty('rok_nazwa',   String(nowaRokNazwa).trim());
    props.setProperty('rok_start',   String(nowyRokStart).trim());

    return { sukces: true, archiwumNazwa: archiwumNazwa, wiadomosc: 'Rok zamknięty i zarchiwizowany.' };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function aktualizujDaneRoku(nowaRokNazwa, nowyRokStart, userId, sessionToken) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (rola !== 'ADMIN') return { sukces: false, wiadomosc: 'Brak uprawnień.' };

    var props = PropertiesService.getScriptProperties();
    if (nowaRokNazwa) props.setProperty('rok_nazwa', String(nowaRokNazwa).trim());
    if (nowyRokStart) props.setProperty('rok_start', String(nowyRokStart).trim());

    return { sukces: true };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function aktywujRokFormacyjny(userId, sessionToken) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (rola !== 'ADMIN') return { sukces: false, wiadomosc: 'Brak uprawnień.' };

    PropertiesService.getScriptProperties().setProperty('rok_aktywny', 'true');
    return { sukces: true };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getArchiwumRokow(userId, sessionToken) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (rola !== 'ADMIN') return { lata: [] };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var latSet = {};
    // Szukaj arkuszy z sufiksem pasującym do wzorca _XXXX_XXXX lub _XXXX
    ss.getSheets().forEach(function(s) {
      var nazwa = s.getName();
      // Wzorzec: kończy się _CYFRY_CYFRY lub _CYFRY/CYFRY (po zamianie / na _)
      var m = nazwa.match(/_(\d{4}_\d{4})$/);
      if (m) latSet[m[1].replace(/_/g, '/')] = true;
    });

    return { lata: Object.keys(latSet).sort().reverse() };
  } catch(e) {
    return { lata: [] };
  }
}

function przywrocRokFormacyjny(rokNazwa, userId, sessionToken) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (rola !== 'ADMIN') return { sukces: false, wiadomosc: 'Brak uprawnień.' };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sufiks = '_' + rokNazwa.replace(/[\/\s]/g, '_');
    var przywrocono = 0;

    var doArchiwizacji = ['Logi_ręczne', 'Logi_czytnik', 'Dyżury', 'Kalendarz', 'Społeczność', 'Wnioski_dyzury', 'Kandydaci'];

    doArchiwizacji.forEach(function(nazwa) {
      var archSheet = ss.getSheetByName(nazwa + sufiks);
      if (!archSheet) return;
      // Usuń bieżący arkusz
      var glowny = ss.getSheetByName(nazwa);
      if (glowny) ss.deleteSheet(glowny);
      // Kopiuj archiwum jako bieżący
      archSheet.copyTo(ss).setName(nazwa);
      przywrocono++;
    });

    // Aktywuj rok
    var props = PropertiesService.getScriptProperties();
    props.setProperty('rok_aktywny', 'true');
    props.setProperty('rok_nazwa',   rokNazwa);

    return { sukces: true, wiadomosc: 'Przywrócono ' + przywrocono + ' arkuszy.' };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
  }
}


// ----------------------------------------------------------------------
// PASSA DYŻURÓW (streak) + wnioski o nieobecność zachowujące passę
// Arkusz: Nieobecnosci_dyzur
//   Data zgłoszenia | UserID | Imię | Data dyżuru | Powód | Powrót | Status | AdminID | Odpowiedź
// ----------------------------------------------------------------------

function _arkuszNieobecnosciDyzur() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Nieobecnosci_dyzur");
  if (!sheet) {
    sheet = ss.insertSheet("Nieobecnosci_dyzur");
    sheet.appendRow(["Data zgłoszenia", "UserID", "Imię", "Data dyżuru", "Powód", "Powrót", "Status", "AdminID", "Odpowiedź"]);
  }
  return sheet;
}

/** Klucz tygodnia ISO-podobny: YYYY-Www (poniedziałek jako start). */
function _kluczTygodnia(d) {
  var date = (d instanceof Date) ? new Date(d.getTime()) : new Date(d);
  if (isNaN(date.getTime())) return null;
  // Poniedziałek tygodnia
  var day = date.getDay(); // 0=Nd
  var diff = (day === 0 ? -6 : 1 - day);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + diff);
  var y = date.getFullYear();
  var startYear = new Date(y, 0, 1);
  var week = Math.floor((date - startYear) / (7 * 24 * 3600 * 1000)) + 1;
  return y + "-W" + String(week).padStart(2, "0");
}

function _poniedzialekTygodnia(d) {
  var date = (d instanceof Date) ? new Date(d.getTime()) : new Date(d);
  date.setHours(0, 0, 0, 0);
  var day = date.getDay();
  var diff = (day === 0 ? -6 : 1 - day);
  date.setDate(date.getDate() + diff);
  return date;
}

function _etykietaZakresuTygodnia(pon) {
  var nd = new Date(pon.getTime());
  nd.setDate(nd.getDate() + 6);
  var tz = _APP_TZ;
  var a = Utilities.formatDate(pon, tz, "d.MM");
  var b = Utilities.formatDate(nd, tz, "d.MM.yyyy");
  return a + " – " + b;
}

function getPassaDyzuru_OLD_v1(userId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: true, passa: 0, szczegoly: [], historia: [] };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetD = ss.getSheetByName("Dyżury");
    var mapa = {};
    var _terazTsPassa = Date.now();

    if (sheetD && sheetD.getLastRow() > 1) {
      var dataD = sheetD.getDataRange().getValues();
      for (var i = 1; i < dataD.length; i++) {
        if (String(dataD[i][2] || "").trim() !== uid) continue;
        var d = dataD[i][0] instanceof Date ? dataD[i][0] : new Date(dataD[i][0]);
        if (isNaN(d.getTime())) continue;
        // FIX passy: nie zaliczaj tygodnia, w którym służba jeszcze się NIE
        // odbyła. Reprezentatywna data wpisu w arkuszu Dyżury w przyszłości
        // (np. sobota, gdy dziś jest wtorek) oznacza, że dyżur dopiero
        // będzie — passa nie może rosnąć przedwcześnie.
        if (d.getTime() > _terazTsPassa) continue;
        var k = _kluczTygodnia(d);
        if (!k) continue;
        if (!mapa[k]) mapa[k] = { dyzur: false, nieobecnosc: false };
        mapa[k].dyzur = true;
      }
    }

    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    if (sheetN && sheetN.getLastRow() > 1) {
      var dataN = sheetN.getDataRange().getValues();
      for (var j = 1; j < dataN.length; j++) {
        if (String(dataN[j][1] || "").trim() !== uid) continue;
        var st = String(dataN[j][6] || "").trim().toLowerCase();
        if (st !== "zaakceptowano" && st !== "accepted") continue;
        var dn = dataN[j][3] instanceof Date ? dataN[j][3] : new Date(dataN[j][3]);
        if (isNaN(dn.getTime())) continue;
        var kn = _kluczTygodnia(dn);
        if (!kn) continue;
        if (!mapa[kn]) mapa[kn] = { dyzur: false, nieobecnosc: false };
        mapa[kn].nieobecnosc = true;
      }
    }

    function tydzienOk(klucz) {
      return !!(mapa[klucz] && (mapa[klucz].dyzur || mapa[klucz].nieobecnosc));
    }

    var teraz = new Date();
    var passa = 0;
    var szczegoly = [];
    var historia = [];
    var przerwanaNa = null;

    for (var t = 0; t < 16; t++) {
      var tydzienData = new Date(teraz.getTime());
      tydzienData.setDate(tydzienData.getDate() - t * 7);
      var pon = _poniedzialekTygodnia(tydzienData);
      var klucz = _kluczTygodnia(pon);
      if (!klucz) break;
      var ok = tydzienOk(klucz);
      var zrodlo = "";
      if (mapa[klucz]) {
        if (mapa[klucz].dyzur && mapa[klucz].nieobecnosc) zrodlo = "dyzur+nieobecnosc";
        else if (mapa[klucz].nieobecnosc) zrodlo = "nieobecnosc";
        else if (mapa[klucz].dyzur) zrodlo = "dyzur";
      }
      historia.push({
        klucz: klucz,
        etykieta: _etykietaZakresuTygodnia(pon),
        ok: ok,
        biezacy: t === 0,
        zrodlo: zrodlo
      });
    }

    for (var p = 0; p < historia.length; p++) {
      if (historia[p].ok) {
        passa++;
        szczegoly.push(historia[p].klucz);
      } else {
        if (historia[p].biezacy) continue;
        przerwanaNa = p;
        break;
      }
    }

    return {
      sukces: true,
      passa: passa,
      szczegoly: szczegoly,
      historia: historia,
      przerwanaNa: przerwanaNa
    };
  } catch (e) {
    return { sukces: false, passa: 0, historia: [], wiadomosc: e.message };
  }
}

function zlozWniosekNieobecnosciDyzur(userId, imie, dataDyzuru, powod, dataPowrotu) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Brak ID użytkownika." };
    var pow = String(powod || "").trim();
    if (!pow) return { sukces: false, wiadomosc: "Opisz powód nieobecności." };
    if (!dataDyzuru) return { sukces: false, wiadomosc: "Podaj datę dyżuru, na którym Cię nie będzie." };

    var sheet = _arkuszNieobecnosciDyzur();
    var lastRow = sheet.getLastRow() + 1;
    var dataTxt = String(dataDyzuru || "").trim();
    var powrotTxt = String(dataPowrotu || "").trim();

    sheet.appendRow([
      new Date(),
      uid,
      String(imie || "").trim(),
      dataTxt,
      pow,
      powrotTxt,
      "Oczekuje",
      "",
      ""
    ]);

    // >>> FIX: wymuś PLAIN TEXT na komórkach kolumny D (Data dyżuru) i F (Powrót).
    // Bez tego Sheets konwertuje string "Czwartek 24.09.2026, 08:00" na Date,
    // a przy odczycie Utilities.formatDate przesuwa godziny przez strefę
    // Europe/Warsaw (+2h w lecie, +1h w zimie) — stąd było "10:00" zamiast
    // "08:00" i "9:00" zamiast "8:00".
    try {
      var cD = sheet.getRange(lastRow, 4);
      cD.setNumberFormat("@");
      cD.setValue(dataTxt);
    } catch (eD) {}

    try {
      var cF = sheet.getRange(lastRow, 6);
      cF.setNumberFormat("@");
      cF.setValue(powrotTxt);
    } catch (eF) {}

    try { _powiadomAdminowONowymDoPrzegladu("Nowy wniosek o nieobecność", String(imie || userId) + " — do rozpatrzenia", "page-wnioski", userId); } catch (eN) {}
    return { sukces: true, wiadomosc: "Wniosek o nieobecność wysłany. Po akceptacji admina passa zostanie zachowana." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}


/** Formatuje datę/tekst do czytelnej postaci PL: "Sobota 15.08.2026, 18:00" */
function _formatujDateNieobecnosc(val) {
  if (val === null || val === undefined || val === '') return '';

  // Już ładny tekst z frontu (np. "Sobota 15.08.2026, 7:00") — zwróć jak jest
  if (typeof val === 'string' &&
      /^(Poniedziałek|Wtorek|Środa|Czwartek|Piątek|Sobota|Niedziela)/.test(val.trim())) {
    return val.trim();
  }

  var d = null;
  if (val instanceof Date) {
    d = val;
  } else {
    var s = String(val).trim();
    d = new Date(s);
    if (isNaN(d.getTime())) {
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0);
      }
    }
  }
  if (!d || isNaN(d.getTime())) return String(val).trim();

  var dni = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota'];
  var pad = function(n) { return (n < 10 ? '0' : '') + n; };
  var dd, mm, yyyy, hhmm;

  // FIX 1899: komórka z samą godziną ("08:00") w Sheets to data 1899-12-30.
  // Utilities.formatDate dla takiej daty używa HISTORYCZNEJ strefy Warszawy
  // (Warsaw Mean Time = UTC+1:24) → zwraca "09:24". .getHours()/.getMinutes()
  // działają w BIEŻĄCEJ strefie projektu (Europe/Warsaw) — więc dla dat < 1970
  // liczymy lokalnie.
  if (d.getFullYear() < 1970) {
    dd   = pad(d.getDate());
    mm   = pad(d.getMonth() + 1);
    yyyy = String(d.getFullYear());
    hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  } else {
    dd   = Utilities.formatDate(d, _APP_TZ, 'dd');
    mm   = Utilities.formatDate(d, _APP_TZ, 'MM');
    yyyy = Utilities.formatDate(d, _APP_TZ, 'yyyy');
    hhmm = Utilities.formatDate(d, _APP_TZ, 'HH:mm');
  }

  var txt = dni[d.getDay()] + ' ' + dd + '.' + mm + '.' + yyyy;
  if (hhmm && hhmm !== '00:00') {
    txt += ', ' + hhmm;
  }
  return txt;
}

function getWnioskiNieobecnosciDyzur(userId, sessionToken) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (!rola) return { sukces: false, lista: [] };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Nieobecnosci_dyzur");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, lista: [] };
    var data = sheet.getDataRange().getValues();
    var lista = [];
    var tz = _APP_TZ;
    var uid = String(userId || "").trim();
    for (var i = 1; i < data.length; i++) {
      var rowUid = String(data[i][1] || "").trim();
      if (rola !== "ADMIN" && rowUid !== uid) continue;
      var dz = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
      lista.push({
        wiersz: i + 1,
        dataZgloszenia: isNaN(dz.getTime()) ? "" : Utilities.formatDate(dz, tz, "dd.MM.yyyy HH:mm"),
        userId: rowUid,
        imie: String(data[i][2] || "").trim(),
        dataDyzuru: _formatujDateNieobecnosc(data[i][3]),
        powod: String(data[i][4] || "").trim(),
        powrot: _formatujDateNieobecnosc(data[i][5]),
        status: String(data[i][6] || "Oczekuje").trim(),
        odpowiedz: String(data[i][8] || "").trim()
      });
    }
    lista.reverse();
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: e.message };
  }
}

function rozpatrzNieobecnoscDyzur(wiersz, decyzja, odpowiedz, wykonawcaId) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Brak uprawnień." };
    var sheet = _arkuszNieobecnosciDyzur();
    var row = parseInt(wiersz, 10);
    if (isNaN(row) || row < 2) return { sukces: false, wiadomosc: "Nieprawidłowy wiersz." };

    // >>> NOWE: zabezpieczenie przed konfliktem interesów — nie można
    // rozpatrzyć WŁASNEGO wniosku. Musi to zrobić inny admin.
    try {
      var wnioskId = _normId(sheet.getRange(row, 2).getValue());
      var execId = _normId(wykonawcaId);
      if (wnioskId && execId && wnioskId === execId) {
        return { sukces: false, konfliktInteresow: true,
                 wiadomosc: "Nie możesz rozpatrzyć własnego wniosku. Poproś innego administratora." };
      }
    } catch (eK) {}

    // >>> NOWE: zabezpieczenie przed konfliktem interesów — nie można
    // rozpatrzyć WŁASNEGO wniosku. Musi to zrobić inny admin.
    try {
      var wnioskId = _normId(sheet.getRange(row, 2).getValue());
      var execId = _normId(wykonawcaId);
      if (wnioskId && execId && wnioskId === execId) {
        return { sukces: false, konfliktInteresow: true,
                 wiadomosc: "Nie możesz rozpatrzyć własnego wniosku. Poproś innego administratora." };
      }
    } catch (eK) {}
    var status = (String(decyzja || "").toLowerCase() === "zaakceptowano" || String(decyzja || "").toLowerCase() === "ok")
      ? "Zaakceptowano" : "Odrzucono";
    var odp = String(odpowiedz || "").trim();
    var userId = String(sheet.getRange(row, 2).getValue() || "").trim();
    var dataDyzuruRaw = sheet.getRange(row, 4).getValue();

    // IDEMPOTENCJA: jeśli wniosek był już rozpatrzony, NIE rób tego drugi raz
    // (bez tego podwójne kliknięcie / retry generowało kilka powiadomień).
    var _statusObecny = String(sheet.getRange(row, 7).getValue() || "").trim();
    if (_statusObecny === "Zaakceptowano" || _statusObecny === "Odrzucono") {
      return { sukces: false, wiadomosc: "Ten wniosek został już rozpatrzony (" + _statusObecny + ")." };
    }

    sheet.getRange(row, 7).setValue(status);
    sheet.getRange(row, 8).setValue(String(wykonawcaId || "").trim());
    sheet.getRange(row, 9).setValue(odp || (status === "Zaakceptowano" ? "Nieobecność zaakceptowana — passa zachowana." : "Wniosek odrzucony."));

    // >>> FIX: jeśli wniosek jest akceptowany PO tym, jak auto-minus już
    //     się nałożył — usuń go i przelicz punkty.
    if (status === "Zaakceptowano") {
      // >>> FIX 2026-09 (NIEOB-HOUR): usuwamy auto-minus dokładnie
      //     dla tej pary (data + godzina). Minusy z innych godzin
      //     tego samego dnia zostają nietknięte.
      //     Jeśli wniosek nie ma godziny — usuwamy wszystkie
      //     auto-minusy za ten dzień (backward compat).
      try {
        var dKey = _parsujDateNieobecnosci(dataDyzuruRaw);
        if (dKey) {
          var godzNieob = _wyciagnijGodzineNieobecnosci(dataDyzuruRaw);
          _usunAutoMinusDyzurZaDzien(userId, dKey, godzNieob || "");
        }
      } catch (eCof) {}
    }

    if (userId) {
      var tytul = status === "Zaakceptowano"
        ? "Nieobecność zaakceptowana"
        : "Nieobecność odrzucona";
      var opis = status === "Zaakceptowano"
        ? ("Admin zaakceptował Twoją nieobecność. Passa dyżurów zostaje zachowana." + (odp ? ("\\n" + odp) : ""))
        : ("Admin odrzucił wniosek o nieobecność." + (odp ? ("\\n" + odp) : ""));
      _zapiszZdarzeniePowiadomienia(
        userId,
        "nieobecnosc_dyzur_" + row + "_" + status,
        "dyzur",
        status === "Zaakceptowano" ? "✅" : "❌",
        tytul,
        opis,
        "page-wnioski"
      );
      wyslijPowiadomienieDoUserow(userId, tytul, opis.replace(/\\n/g, " "));
    }
    _logAdmin(wykonawcaId, "", "NIEOBECNOSC_" + String(status||"").toUpperCase().replace(/\s+/g,"_"), String(userId||""), "wiersz=" + wiersz + " " + String(odp||""));
    return { sukces: true, wiadomosc: "Wniosek rozpatrzony: " + status };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}


// ----------------------------------------------------------------------
// WNIOSKI O PUNKTY DODATKOWE (pomoc w parafii itd.)
// Arkusz: Wnioski_punkty
//   Data | UserID | Imię | Kategoria | Opis | Proponowane pkt | Status | AdminID | Odpowiedź | Przyznane pkt
// ----------------------------------------------------------------------

function _arkuszWnioskiPunkty() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Wnioski_punkty");
  if (!sheet) {
    sheet = ss.insertSheet("Wnioski_punkty");
    sheet.appendRow([
      "Data", "UserID", "Imię", "Kategoria", "Opis",
      "Proponowane pkt", "Status", "AdminID", "Odpowiedź", "Przyznane pkt"
    ]);
  }
  return sheet;
}

function zlozWniosekPunktow(userId, imie, kategoria, opis, proponowanePkt) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Brak ID użytkownika." };
    if (_czyRangaLektor(uid)) {
      return { sukces: false, wiadomosc: "Lektorzy nie uczestniczą w systemie punktowym." };
    }
    // Księża nie składają wniosków o punkty
    try {
      var rk = String(pobierzRoleUzytkownika(uid) || "").toUpperCase();
      if (rk === "KSIADZ" || rk.indexOf("KSI") === 0) {
        return { sukces: false, wiadomosc: "Księża nie uczestniczą w systemie punktowym." };
      }
    } catch (eKs2) {}
    var kat = String(kategoria || "").trim();
    var op = String(opis || "").trim();
    if (!kat) return { sukces: false, wiadomosc: "Wybierz kategorię." };
    if (!op || op.length < 5) {
      return { sukces: false, wiadomosc: "Opisz dokładniej, za co prosisz o punkty (min. kilka słów)." };
    }
    var pkt = parseInt(proponowanePkt, 10);
    if (isNaN(pkt) || pkt < 1) pkt = 1;
    if (pkt > 20) pkt = 20;

    var sheet = _arkuszWnioskiPunkty();
    sheet.appendRow([
      new Date(),
      uid,
      String(imie || "").trim(),
      kat,
      op,
      pkt,
      "Oczekuje",
      "",
      "",
      ""
    ]);
    try { _powiadomAdminowONowymDoPrzegladu("Nowy wniosek o punkty", String(imie || uid) + " — do rozpatrzenia", "page-wnioski", uid); } catch (eN) {}
    return {
      sukces: true,
      wiadomosc: "Wniosek o punkty wysłany. Admin rozpatrzy go i przyzna punkty albo odrzuci."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function getWnioskiPunktow(userId, sessionToken) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (!rola) return { sukces: false, lista: [] };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Wnioski_punkty");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, lista: [] };
    var data = sheet.getDataRange().getValues();
    var lista = [];
    var tz = _APP_TZ;
    var uid = String(userId || "").trim();
    for (var i = 1; i < data.length; i++) {
      var rowUid = String(data[i][1] || "").trim();
      if (rola !== "ADMIN" && rola !== "MODERATOR" && rowUid !== uid) continue;
      var dz = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
      lista.push({
        wiersz: i + 1,
        dataZgloszenia: isNaN(dz.getTime()) ? "" : Utilities.formatDate(dz, tz, "dd.MM.yyyy HH:mm"),
        userId: rowUid,
        imie: String(data[i][2] || "").trim(),
        kategoria: String(data[i][3] || "").trim(),
        opis: String(data[i][4] || "").trim(),
        proponowane: parseInt(data[i][5], 10) || 0,
        status: String(data[i][6] || "Oczekuje").trim(),
        odpowiedz: String(data[i][8] || "").trim(),
        przyznane: data[i][9] !== "" && data[i][9] !== null ? (parseInt(data[i][9], 10) || 0) : null
      });
    }
    lista.reverse();
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: e.message };
  }
}

/**
 * decyzja: "Zaakceptowano" | "Odrzucono"
 * przyznanePkt — ile punktów faktycznie przyznać (przy akceptacji); domyślnie proponowane
 */
function rozpatrzWniosekPunktow(wiersz, decyzja, odpowiedz, przyznanePkt, wykonawcaId, wykonawcaImie) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (!_czyAdminLubKsiadz(rola)) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var sheet = _arkuszWnioskiPunkty();
    var row = parseInt(wiersz, 10);
    if (isNaN(row) || row < 2) return { sukces: false, wiadomosc: "Nieprawidłowy wiersz." };

    // >>> NOWE: konflikt interesów — nie można rozpatrzyć własnego wniosku.
    try {
      var wnioskId = _normId(sheet.getRange(row, 2).getValue());
      var execId = _normId(wykonawcaId);
      if (wnioskId && execId && wnioskId === execId) {
        return { sukces: false, konfliktInteresow: true,
                 wiadomosc: "Nie możesz rozpatrzyć własnego wniosku o punkty. Poproś innego administratora." };
      }
    } catch (eK) {}

    // >>> NOWE: konflikt interesów — nie można rozpatrzyć własnego wniosku.
    try {
      var wnioskId = _normId(sheet.getRange(row, 2).getValue());
      var execId = _normId(wykonawcaId);
      if (wnioskId && execId && wnioskId === execId) {
        return { sukces: false, konfliktInteresow: true,
                 wiadomosc: "Nie możesz rozpatrzyć własnego wniosku o punkty. Poproś innego administratora." };
      }
    } catch (eK) {}

    var statusAkt = String(sheet.getRange(row, 7).getValue() || "").trim().toLowerCase();
    if (statusAkt.indexOf("oczek") < 0 && statusAkt !== "") {
      return { sukces: false, wiadomosc: "Ten wniosek został już rozpatrzony." };
    }

    var userId = String(sheet.getRange(row, 2).getValue() || "").trim();
    var imie = String(sheet.getRange(row, 3).getValue() || "").trim();
    var kat = String(sheet.getRange(row, 4).getValue() || "").trim();
    var opis = String(sheet.getRange(row, 5).getValue() || "").trim();
    var proponowane = parseInt(sheet.getRange(row, 6).getValue(), 10) || 1;

    var akceptuj = String(decyzja || "").toLowerCase().indexOf("zaakcept") >= 0
      || String(decyzja || "").toLowerCase() === "ok";
    var status = akceptuj ? "Zaakceptowano" : "Odrzucono";
    var odp = String(odpowiedz || "").trim();
    var pkt = parseInt(przyznanePkt, 10);
    if (isNaN(pkt) || pkt < 1) pkt = proponowane;
    if (pkt > 50) pkt = 50;

    sheet.getRange(row, 7).setValue(status);
    sheet.getRange(row, 8).setValue(String(wykonawcaId || "").trim());
    sheet.getRange(row, 9).setValue(odp || (akceptuj ? ("Przyznano " + pkt + " pkt.") : "Wniosek odrzucony."));
    sheet.getRange(row, 10).setValue(akceptuj ? pkt : 0);

    if (akceptuj && userId) {
      var wynik = dodajWpisReczny(
        userId,
        kat || "Dodatkowa pomoc",
        pkt,
        "[Wniosek] " + opis,
        wykonawcaId,
        wykonawcaImie
      );
      // dodajWpisReczny zwraca string — jeśli zaczyna się od "Błąd" / "Lektorzy"
      if (typeof wynik === "string" && (wynik.indexOf("Błąd") === 0 || wynik.indexOf("Lektorzy") === 0 || wynik.indexOf("Ten wpis") === 0)) {
        // cofnij status jeśli nie udało się przyznać
        sheet.getRange(row, 7).setValue("Oczekuje");
        sheet.getRange(row, 8).setValue("");
        sheet.getRange(row, 9).setValue("");
        sheet.getRange(row, 10).setValue("");
        return { sukces: false, wiadomosc: wynik };
      }
    }

    if (userId) {
      var tytul = akceptuj ? ("Przyznano +" + pkt + " pkt") : "Wniosek o punkty odrzucony";
      var opisNotif = akceptuj
        ? ("Admin zaakceptował Twój wniosek: " + (kat || "punkty dodatkowe") + " (+" + pkt + " pkt)." + (odp ? ("\n" + odp) : ""))
        : ("Admin odrzucił wniosek o punkty." + (odp ? ("\n" + odp) : ""));
      _zapiszZdarzeniePowiadomienia(
        userId,
        "wniosek_pkt_" + row + "_" + status,
        "points",
        akceptuj ? "📈" : "❌",
        tytul,
        opisNotif,
        "page-profile"
      );
      wyslijPowiadomienieDoUserow(userId, tytul, opisNotif.replace(/\n/g, " "));
    }

    _logAdmin(wykonawcaId, wykonawcaImie, "WNIOSEK_PKT", String(wiersz||""), String(decyzja||"") + " " + String(przyznanePkt||"") + " " + String(odpowiedz||""));
    return {
      sukces: true,
      wiadomosc: akceptuj
        ? ("Zaakceptowano — przyznano " + pkt + " pkt.")
        : "Wniosek odrzucony."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}


// ----------------------------------------------------------------------
// TICKETY — Kontakt z administracją (styl Discord)
// Arkusze:
//   Tickety: ID | UserID | UserImie | Temat | Status | Data | AssignedAdminID | AssignedAdminImie | LastActivity
//   Tickety_wiadomosci: TicketID | AuthorID | AuthorImie | IsAdmin | Tresc | Data
// ----------------------------------------------------------------------

function _arkuszTickety() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Tickety");
  if (!sheet) {
    sheet = ss.insertSheet("Tickety");
    sheet.appendRow([
      "ID", "UserID", "UserImie", "Temat", "Status",
      "Data", "AssignedAdminID", "AssignedAdminImie", "LastActivity"
    ]);
  }
  return sheet;
}

function _arkuszTicketyWiadomosci() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Tickety_wiadomosci");
  if (!sheet) {
    sheet = ss.insertSheet("Tickety_wiadomosci");
    sheet.appendRow(["TicketID", "AuthorID", "AuthorImie", "IsAdmin", "Tresc", "Data", "Link_Media"]);
  } else {
    // Migracja: dopisz kolumnę Link_Media (G) w arkuszu utworzonym przed tą funkcją.
    try {
      if (sheet.getLastColumn() < 7) {
        sheet.getRange(1, 7).setValue("Link_Media");
      } else if (!String(sheet.getRange(1, 7).getValue() || "").trim()) {
        sheet.getRange(1, 7).setValue("Link_Media");
      }
    } catch (eMig) {}
  }
  return sheet;
}

/** Lista administratorów (ID + imię) do wyboru przy tworzeniu ticketu. */

/**
 * Admin dodaje nowego ministranta.
 * - Losuje unikalne 4-cyfrowe ID
 * - Hasło tymczasowe (wymaga zmiany przy pierwszym logowaniu)
 * - Wpis w Kandydaci + Hasła + powiązanie Karty_RFID (UID)
 */
function dodajNowegoMinistranta(wykonawcaId, imieNazwisko, stopien, uidKarty) {
  try {
    var execId = String(wykonawcaId || "").trim();
    var rola = pobierzRoleUzytkownika(execId);
    if (String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Tylko administrator może dodawać ministrantów." };
    }

    var imie = String(imieNazwisko || "").trim();
    var st = String(stopien || "").trim();
    var uid = String(uidKarty || "").trim().toUpperCase();

    if (!imie || imie.length < 3) return { sukces: false, wiadomosc: "Podaj imię i nazwisko." };
    if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(imie)) {
      return { sukces: false, wiadomosc: "Imię nie może zawierać polskich znaków (ąęłńóśźż…). Użyj zapisu bez ogonków, np. Lukasz." };
    }
    imie = String(imie).replace(/[^A-Za-z ]+/g, "").replace(/\s+/g, " ").trim();
    if (!imie || imie.length < 3 || !/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(imie)) {
      return { sukces: false, wiadomosc: "Imię: tylko litery A–Z i spacje (bez polskich znaków i cyfr)." };
    }
    if (!st) return { sukces: false, wiadomosc: "Wybierz stopień." };
    // UID opcjonalne
    if (st === "Lektor starszy") st = "Lektor";

    var dozwolone = {
      "Kandydat": 1,
      "Ministrant": 1,
      "Lektor młodszy": 1,
      "Lektor starszy": 1,
      "Lektor": 1,
      "Ksiądz": 1
    };
    if (!dozwolone[st]) return { sukces: false, wiadomosc: "Nieprawidłowy stopień." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetK = ss.getSheetByName("Kandydaci");
    var sheetH = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetK) return { sukces: false, wiadomosc: "Brak arkusza Kandydaci." };
    if (!sheetH) return { sukces: false, wiadomosc: "Brak arkusza Hasła." };

    // Zbiór zajętych ID z Kandydaci + Hasła — czytaj z A i B (jeśli są).
    var zajete = {};
    var daneK = sheetK.getDataRange().getValues();
    var _migB = _migracjaKolumnyBDone();
    for (var i = 1; i < daneK.length; i++) {
      var idk = _migB ? _idZWiersza(daneK[i]) : String(daneK[i][0] || "").trim();
      if (idk) zajete[idk] = true;
    }
    var daneH = sheetH.getDataRange().getValues();
    for (var h = 1; h < daneH.length; h++) {
      var idh = _migB ? _idZWiersza(daneH[h]) : String(daneH[h][0] || "").trim();
      if (idh) zajete[idh] = true;
    }

    // >>> ZMIANA: losuj unikalne 4-cyfrowe ID bez cyfr 7,8,9 (tylko 0-6).
    //     Pierwsza cyfra nie może być 0.
    var noweId = "";
    for (var proba = 0; proba < 500; proba++) {
      var kand = "";
      for (var p = 0; p < 4; p++) kand += String(Math.floor(Math.random() * 7)); // 0..6
      if (kand.charAt(0) === "0") continue;
      if (!zajete[kand]) { noweId = kand; break; }
    }
    if (!noweId) return { sukces: false, wiadomosc: "Nie udało się wylosować wolnego ID. Spróbuj ponownie." };

    // Hasło tymczasowe — 4 cyfry
    var haslo = String(1000 + Math.floor(Math.random() * 9000));

    var rolaMap = {
      "Lektor młodszy": "LEKTOR",
      "Lektor starszy": "LEKTOR",
      "Lektor": "LEKTOR",
      "Ministrant": "MINISTRANT",
      "Kandydat": "MINISTRANT",
      "Ksiądz": "KSIADZ"
    };
    var rolaH = rolaMap[st] || "MINISTRANT";

    // Kandydaci:
    //   - przed migracją: ID | Imię | Punkty | Funkcje | Dodatkowe | Uwagi | Ranga | Zdjęcie
    //   - po migracji:    A | B=ID | Imię | Punkty | Funkcje | Dodatkowe | Uwagi | Ranga | Zdjęcie
    //     Nowe ID zapisujemy w B, A zostawiamy puste (żeby stare ID pozostały czytelne).
    if (_migracjaKolumnyBDone()) {
      sheetK.appendRow(["", noweId, imie, 0, "", "", "", st, ""]);
    } else {
      sheetK.appendRow([noweId, imie, 0, "", "", "", st, ""]);
    }

    // Hasła:
    //   - przed migracją: ID | Imię | Hasło | Zmiana | Rola | Admin
    //   - po migracji:    A | B=ID | Imię | Hasło | Zmiana | Rola | Admin
    if (_migracjaKolumnyBDone()) {
      sheetH.appendRow(["", noweId, imie, _utworzZapisHasla(haslo), false, rolaH, "NIE"]);
    } else {
      sheetH.appendRow([noweId, imie, _utworzZapisHasla(haslo), false, rolaH, "NIE"]);
    }

    // Data założenia — automatyczne minusy tylko od tego dnia
    try { _ustawDataZalozeniaKonta(noweId, new Date()); } catch (eOd) {}

    // Karty_RFID tylko gdy podano UID
    if (uid) {
      var sheetR = _pobierzAlboUtworzArkuszKart();
      var daneR = sheetR.getDataRange().getValues();
      var znaleziono = false;
      for (var r = 1; r < daneR.length; r++) {
        if (String(daneR[r][0] || "").trim().toUpperCase() === uid) {
          sheetR.getRange(r + 1, 2).setValue(noweId);
          sheetR.getRange(r + 1, 3).setValue(imie);
          sheetR.getRange(r + 1, 4).setValue(true);
          znaleziono = true;
          break;
        }
      }
      if (!znaleziono) {
        sheetR.appendRow([uid, noweId, imie, true]);
      }
    }

    try { _invalidateCacheRfid(); } catch (eInv) {}
    _cInvalidateKandydaci();
    _logAdmin(execId, "", "DODAJ_MINISTRANTA", noweId + " / " + imie, st + (uid ? (" UID=" + uid) : " bez karty"));
    return {
      sukces: true,
      id: noweId,
      haslo: haslo,
      imie: imie,
      stopien: st,
      uid: uid,
      wiadomosc: "Dodano ministranta. ID: " + noweId + ", hasło tymczasowe: " + haslo
    };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/** Lista UID z arkusza Karty_RFID (kolumna A) — do podpowiedzi przy dodawaniu. */

/**
 * Trwałe usunięcie użytkownika (tylko ADMIN).
 * Usuwa wiersze z: Kandydaci, Hasła, Karty_RFID.
 * Logi historyczne zostają. Nie usuwa adminów ani własnego konta.
 */

// ======================================================================
// LOGI ADMINISTRACYJNE (widoczne dla ADMIN + KSIADZ)
// Arkusz: Logi_admin | Data | WykonawcaId | WykonawcaImie | Akcja | Cel | Szczegoly
// ======================================================================
function _arkuszLogiAdmin() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Logi_admin");
  if (!sheet) {
    sheet = ss.insertSheet("Logi_admin");
    sheet.appendRow(["Data", "WykonawcaId", "WykonawcaImie", "Akcja", "Cel", "Szczegoly"]);
    try { sheet.setFrozenRows(1); } catch (e) {}
  } else {
    // Migracja starych 5 kolumn -> 6
    var lastCol = sheet.getLastColumn();
    if (lastCol < 6) {
      var hdr = sheet.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0];
      if (String(hdr[1] || "").indexOf("Wykonawca") >= 0 && lastCol === 5) {
        // stary format: Data | Wykonawca | Akcja | Cel | Szczegoly
        sheet.insertColumnAfter(2);
        sheet.getRange(1, 2).setValue("WykonawcaId");
        sheet.getRange(1, 3).setValue("WykonawcaImie");
      } else {
        while (sheet.getLastColumn() < 6) sheet.insertColumnAfter(sheet.getLastColumn());
        sheet.getRange(1, 1, 1, 6).setValues([["Data", "WykonawcaId", "WykonawcaImie", "Akcja", "Cel", "Szczegoly"]]);
      }
    }
  }
  return sheet;
}

/** Zapis jednej akcji admina. Nie rzuca na zewnątrz. */
function _logAdmin(wykonawcaId, wykonawcaImie, akcja, cel, szczegoly) {
  try {
    var sheet = _arkuszLogiAdmin();
    var dataStr = Utilities.formatDate(new Date(), _APP_TZ, "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([
      dataStr,
      String(wykonawcaId || "").trim(),
      String(wykonawcaImie || "").trim(),
      String(akcja || "").trim(),
      String(cel || "").trim(),
      String(szczegoly || "").trim().substring(0, 500)
    ]);
  } catch (e) {
    try { console.log("logAdmin error: " + e); } catch (e2) {}
  }
}

/**
 * Pobierz logi adminowe. Widoczne dla ADMIN i KSIADZ.
 * limit opcjonalny (domyślnie 200, max 500).
 */
function getLogiAdmin(userId, limit) {
  try {
    var uid = _normId(userId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && rola !== "KSIADZ") {
      return { sukces: false, wiadomosc: "Brak uprawnień.", logi: [] };
    }
    var lim = parseInt(limit, 10);
    if (isNaN(lim) || lim < 1) lim = 200;
    if (lim > 500) lim = 500;

    var sheet = _arkuszLogiAdmin();
    var last = sheet.getLastRow();
    if (last < 2) return { sukces: true, logi: [] };

    var start = Math.max(2, last - lim + 1);
    var num = last - start + 1;
    var dane = sheet.getRange(start, 1, num, 6).getValues();
    var logi = [];
    for (var i = dane.length - 1; i >= 0; i--) {
      var d = dane[i];
      var dataVal = d[0];
      var dataStr = "";
      if (dataVal instanceof Date) {
        dataStr = Utilities.formatDate(dataVal, _APP_TZ, "yyyy-MM-dd HH:mm:ss");
      } else {
        dataStr = String(dataVal || "");
      }
      // Kompatybilność ze starym formatem 5-kolumnowym
      var execId = String(d[1] || "").trim();
      var execImie = String(d[2] || "").trim();
      var akcja = String(d[3] || "").trim();
      var cel = String(d[4] || "").trim();
      var sz = String(d[5] || "").trim();
      // jeśli ktoś ma stary wiersz bez imienia — akcja w kolumnie 2
      if (!akcja && execImie && String(d[3] || "") === "") {
        // legacy handled by migration
      }
      logi.push({
        data: dataStr,
        wykonawcaId: execId,
        wykonawcaImie: execImie,
        akcja: akcja,
        cel: cel,
        szczegoly: sz
      });
    }
    return { sukces: true, logi: logi };
  } catch (e) {
    return { sukces: false, logi: [], wiadomosc: String(e.message || e) };
  }
}

function usunUzytkownika(wykonawcaId, celId, powod) {
  try {
    var execId = _normId(wykonawcaId);
    var targetId = _normId(celId);
    var rola = pobierzRoleUzytkownika(execId);
    if (String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Tylko administrator może usuwać użytkowników." };
    }
    if (!targetId) return { sukces: false, wiadomosc: "Brak ID użytkownika." };
    if (targetId === execId) return { sukces: false, wiadomosc: "Nie możesz usunąć własnego konta." };

    var celRola = pobierzRoleUzytkownika(targetId);
    var celRolaU = String(celRola || "").toUpperCase();
    if (celRolaU.indexOf("ADMIN") === 0) {
      return { sukces: false, wiadomosc: "Nie można usunąć konta administratora." };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var imieUsunietego = targetId;
    var usunietoK = false, usunietoH = false, usunietoR = 0;

    // Kandydaci — lokalizuj wiersz i dopasuj ID z A lub B.
    var sheetK = ss.getSheetByName("Kandydaci");
    if (sheetK) {
      var daneK = sheetK.getDataRange().getValues();
      for (var i = daneK.length - 1; i >= 1; i--) {
        var idk = _migracjaKolumnyBDone()
          ? _idZWiersza(daneK[i])
          : String(daneK[i][0] || "").trim();
        if (_normId(idk) === targetId) {
          imieUsunietego = _migracjaKolumnyBDone()
            ? (String(daneK[i][2] || targetId).trim() || targetId)
            : (String(daneK[i][1] || targetId).trim() || targetId);
          sheetK.deleteRow(i + 1);
          usunietoK = true;
          break;
        }
      }
    }

    // Hasła
    var sheetH = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (sheetH) {
      var daneH = sheetH.getDataRange().getValues();
      for (var h = daneH.length - 1; h >= 1; h--) {
        var idh = _migracjaKolumnyBDone()
          ? _idZWiersza(daneH[h])
          : String(daneH[h][0] || "").trim();
        if (_normId(idh) === targetId) {
          if (!imieUsunietego || imieUsunietego === targetId) {
            imieUsunietego = _migracjaKolumnyBDone()
              ? (String(daneH[h][2] || targetId).trim() || targetId)
              : (String(daneH[h][1] || targetId).trim() || targetId);
          }
          sheetH.deleteRow(h + 1);
          usunietoH = true;
          break;
        }
      }
    }

    // Karty_RFID — odwiąż lub usuń wiersze z tym ID
    try {
      var sheetR = _pobierzAlboUtworzArkuszKart();
      var daneR = sheetR.getDataRange().getValues();
      for (var r = daneR.length - 1; r >= 1; r--) {
        if (_normId(daneR[r][1]) === targetId) {
          sheetR.deleteRow(r + 1);
          usunietoR++;
        }
      }
    } catch (eR) {}

    // Sesje / tokeny (jeśli są funkcje)
    try {
      if (typeof usunToken === "function") usunToken(targetId);
    } catch (eT) {}
    try {
      var props = PropertiesService.getScriptProperties();
      var keys = props.getKeys();
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki];
        if (k.indexOf("sesja_") === 0 || k.indexOf("token_") === 0) {
          var v = String(props.getProperty(k) || "");
          if (v.indexOf(targetId) >= 0) props.deleteProperty(k);
        }
      }
    } catch (eP) {}

    if (!usunietoK && !usunietoH) {
      return { sukces: false, wiadomosc: "Nie znaleziono użytkownika o ID " + targetId + "." };
    }

    try { _invalidateCacheRfid(); } catch (eInv) {}
    _cInvalidateKandydaci();
    _cInvalidateRola(targetId);
    _logAdmin(execId, "", "USUN_UZYTKOWNIKA", targetId + " / " + imieUsunietego, String(powod || "").trim() || ("K=" + usunietoK + " H=" + usunietoH + " RFID=" + usunietoR));

    return {
      sukces: true,
      id: targetId,
      imie: imieUsunietego,
      wiadomosc: "Usunięto „" + imieUsunietego + "” (ID " + targetId + ")."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

function getListaUidRfid(wykonawcaId) {
  try {
    var rola = pobierzRoleUzytkownika(String(wykonawcaId || "").trim());
    if (String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, lista: [] };
    }
    var sheet = _pobierzAlboUtworzArkuszKart();
    var dane = sheet.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < dane.length; i++) {
      var uid = String(dane[i][0] || "").trim();
      if (!uid) continue;
      lista.push({
        uid: uid,
        idMin: String(dane[i][1] || "").trim(),
        imie: String(dane[i][2] || "").trim(),
        wolna: !String(dane[i][1] || "").trim()
      });
    }
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: e.message };
  }
}


/** Lista osób do @wzmianek i zapraszania do ticketów — widoczna dla każdego zalogowanego. */
function getListaOsobDoWzmianek(userId) {
  try {
    if (!String(userId || "").trim()) return { sukces: false, lista: [] };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kandydaci");
    if (!sheet) return { sukces: true, lista: [] };
    var dane = sheet.getDataRange().getValues();
    var lista = [];
    var seen = {};
    for (var i = 1; i < dane.length; i++) {
      var id = String(dane[i][0] || "").trim();
      var imie = String(dane[i][1] || "").trim();
      if (!id || seen[id]) continue;
      seen[id] = true;
      lista.push({
        id: id,
        imie: imie || id,
        ranga: String(dane[i][6] || "").trim()
      });
    }
    lista.sort(function(a, b) {
      return String(a.imie).localeCompare(String(b.imie), "pl");
    });
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: e.message };
  }
}

function getListaAdminow() {
  try {
    var dane = _pobierzDaneHasla();
    if (!dane || dane.length < 2) return { sukces: true, admini: [] };

    // Domyślnie: A=ID, B=Imię, F=flaga admin (indeks 5) — TAK = administrator
    var colId = 0, colImie = 1, colAdmin = 5;
    var header = dane[0] || [];
    for (var h = 0; h < header.length; h++) {
      var hh = String(header[h] || "").toLowerCase().trim();
      if (hh === "id" || hh === "userid" || hh === "user id") colId = h;
      if (hh.indexOf("imi") >= 0 || hh === "name" || hh === "nazwa") colImie = h;
      // tylko jawne nagłówki admin (NIE "tak" — to wartość, nie nazwa kolumny)
      if (hh === "admin" || hh.indexOf("admin") === 0 || hh.indexOf("opiekun") >= 0) colAdmin = h;
    }
    // Użytkownik: kolumna F = TAK → admin; wymuś indeks 5 gdy nagłówek nie zmienił kolumny
    if (colAdmin === 5 || header.length >= 6) {
      // zostaw colAdmin (5 lub wykryty)
    }

    var admini = [];
    var seen = {};
    for (var i = 1; i < dane.length; i++) {
      if (!_czyFlagaAdmin(dane[i][colAdmin])) continue;
      // Zawsze zwracamy ID główne (kol. A / colId), nawet gdy wybrano drugą kolumnę.
      var id = String(dane[i][colId] || "").trim();
      if (!id || seen[id]) continue;
      seen[id] = true;
      admini.push({
        id: id,
        imie: String(dane[i][colImie] || "").trim() || id
      });
    }
    admini.sort(function(a, b) {
      return String(a.imie).localeCompare(String(b.imie), "pl");
    });
    return { sukces: true, admini: admini };
  } catch (e) {
    return { sukces: false, admini: [], wiadomosc: e.message };
  }
}

function _listaIdAdminow() {
  var res = getListaAdminow();
  return (res.admini || []).map(function(a) { return a.id; }).filter(Boolean);
}

/** Czy user może widzieć dany ticket (autor / przypisany admin / admin przy nieprzypisanym). */
function _upewnijKolumneHelperowTicket(sheet) {
  if (!sheet) return;
  if (sheet.getLastColumn() < 10) {
    sheet.getRange(1, 10).setValue("HelperAdminIDs");
  } else {
    var h = String(sheet.getRange(1, 10).getValue() || "").trim();
    if (!h) sheet.getRange(1, 10).setValue("HelperAdminIDs");
  }
}

function _parsujHelperIds(raw) {
  return String(raw || "")
    .split(/[,;|]/)
    .map(function(s) { return String(s || "").trim(); })
    .filter(Boolean);
}

function _mozeWidziecTicket(uid, rola, ticketUserId, assignedAdminId, helperIdsRaw) {
  var uidS = String(uid || "").trim();
  if (String(ticketUserId || "").trim() === uidS) return true;
  // Wezwany na pomoc (admin LUB ministrant) — zawsze widzi
  var helpers = _parsujHelperIds(helperIdsRaw);
  for (var i = 0; i < helpers.length; i++) {
    if (helpers[i] === uidS) return true;
  }
  var r = String(rola || "").toUpperCase().trim();
  var isAdmin = (r === "ADMIN" || r === "ADMINISTRATOR" || r.indexOf("ADMIN") === 0);
  if (!isAdmin) return false;
  var assigned = String(assignedAdminId || "").trim();
  // Nieprzypisany → każdy admin widzi (żeby mógł przejąć)
  if (!assigned) return true;
  if (assigned === uidS) return true;
  return false;
}

/**
 * Tworzy nowy ticket + pierwszą wiadomość.
 * targetAdminId — opcjonalnie konkretny admin; pusty = pula „ktokolwiek”.
 * Powiadomienie TYLKO gdy wskazano konkretnego admina.
 */
function utworzTicket(userId, imie, temat, tresc, targetAdminId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Brak ID użytkownika." };
    var tem = String(temat || "").trim();
    var tr = String(tresc || "").trim();
    if (!tem || tem.length < 2) return { sukces: false, wiadomosc: "Podaj temat (min. kilka znaków)." };
    if (!tr || tr.length < 3) return { sukces: false, wiadomosc: "Napisz treść wiadomości." };
    if (tem.length > 120) tem = tem.substring(0, 120);
    if (tr.length > 2000) tr = tr.substring(0, 2000);

    var ticketId = "TCK-" + new Date().getTime() + "-" + Math.floor(Math.random() * 10000);
    var teraz = new Date();
    // Zawsze pula administratorów (bez przypisania przy tworzeniu)
    var sheetT = _arkuszTickety();
    _upewnijKolumneHelperowTicket(sheetT);
    sheetT.appendRow([
      ticketId,
      uid,
      String(imie || "").trim(),
      tem,
      "Otwarty",
      teraz,
      "",
      "",
      teraz,
      ""
    ]);

    _arkuszTicketyWiadomosci().appendRow([
      ticketId,
      uid,
      String(imie || "").trim(),
      false,
      tr,
      teraz
    ]);

    try { _powiadomAdminowONowymDoPrzegladu("Nowy ticket: " + (temat || ""), String(imie || uid) + " — czeka na rozpatrzenie", "page-kontakt", uid); } catch (eN) {}
    return { sukces: true, ticketId: ticketId, wiadomosc: "Ticket utworzony." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

/**
 * Lista ticketów:
 * - autor: tylko własne
 * - admin: nieprzypisane (pula) + przypisane do niego
 *   (NIE widzi ticketów innych adminów)
 */
function getTickety(userId, statusFilter) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, lista: [] };
    var rola = pobierzRoleUzytkownika(uid);
    if (!rola) return { sukces: false, lista: [], wiadomosc: "Brak roli użytkownika" };

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Tickety");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, lista: [], otwarte: 0, nieprzypisane: 0, badge: 0 };

    var data = sheet.getDataRange().getValues();
    var tz = _APP_TZ;
    var lista = [];
    var otwarte = 0;
    var nieprzypisane = 0;
    var badge = 0;
    var filtr = String(statusFilter || "").trim().toLowerCase();
    var rolaU = String(rola || "").toUpperCase().trim();
    var isAdmin = (rolaU === "ADMIN" || rolaU === "ADMINISTRATOR" || rolaU.indexOf("ADMIN") === 0);

    for (var i = 1; i < data.length; i++) {
      var rowUid = String(data[i][1] || "").trim();
      var status = String(data[i][4] || "Otwarty").trim();
      var assignedId = String(data[i][6] || "").trim();
      var helpersRaw = data[i].length > 9 ? data[i][9] : "";
      if (!String(data[i][0] || "").trim()) continue;

      if (!_mozeWidziecTicket(uid, rola, rowUid, assignedId, helpersRaw)) continue;
      if (filtr === "otwarte" && status.toLowerCase().indexOf("otwart") < 0) continue;
      if (filtr === "zamkniete" && status.toLowerCase().indexOf("zamkn") < 0) continue;

      var isOpen = status.toLowerCase().indexOf("otwart") >= 0;
      if (isOpen) otwarte++;
      if (isAdmin && !assignedId && isOpen) nieprzypisane++;

      // Badge tylko dla adminów (nieprzypisane / przypisane do niego).
      // Użytkownicy NIE dostają czerwonej „1” za własne otwarte tickety.
      if (isAdmin && isOpen) {
        if (!assignedId || assignedId === uid) badge++;
      }

      var d = data[i][5] instanceof Date ? data[i][5] : new Date(data[i][5]);
      var last = data[i][8] instanceof Date ? data[i][8] : new Date(data[i][8] || data[i][5]);
      lista.push({
        wiersz: i + 1,
        id: String(data[i][0] || "").trim(),
        userId: rowUid,
        userImie: String(data[i][2] || "").trim(),
        temat: String(data[i][3] || "").trim(),
        status: status,
        data: isNaN(d.getTime()) ? "" : Utilities.formatDate(d, tz, "dd.MM.yyyy HH:mm"),
        dataTs: isNaN(d.getTime()) ? 0 : d.getTime(),
        assignedAdminId: assignedId,
        assignedAdminImie: String(data[i][7] || "").trim(),
        lastActivity: isNaN(last.getTime()) ? "" : Utilities.formatDate(last, tz, "dd.MM.yyyy HH:mm"),
        lastActivityTs: isNaN(last.getTime()) ? 0 : last.getTime(),
        moznaPrzejac: isAdmin && !assignedId && isOpen
      });
    }

    lista.sort(function(a, b) {
      var aOpen = a.status.toLowerCase().indexOf("otwart") >= 0 ? 1 : 0;
      var bOpen = b.status.toLowerCase().indexOf("otwart") >= 0 ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      if (isAdmin) {
        var aU = a.assignedAdminId ? 0 : 1;
        var bU = b.assignedAdminId ? 0 : 1;
        if (aU !== bU) return bU - aU;
      }
      return (b.lastActivityTs || b.dataTs) - (a.lastActivityTs || a.dataTs);
    });

    return { sukces: true, lista: lista, otwarte: otwarte, nieprzypisane: nieprzypisane, badge: badge, isAdmin: isAdmin };
  } catch (e) {
    return { sukces: false, lista: [], otwarte: 0, badge: 0, wiadomosc: e.message };
  }
}

function getWiadomosciTicketu(userId, ticketId) {
  try {
    var uid = String(userId || "").trim();
    var tid = String(ticketId || "").trim();
    if (!uid || !tid) return { sukces: false, wiadomosci: [] };

    var rola = pobierzRoleUzytkownika(uid);
    if (!rola) return { sukces: false, wiadomosci: [] };

    var sheetT = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Tickety");
    if (!sheetT) return { sukces: false, wiadomosci: [] };
    var dataT = sheetT.getDataRange().getValues();
    var ticket = null;
    var ticketRow = -1;
    for (var i = 1; i < dataT.length; i++) {
      if (String(dataT[i][0] || "").trim() === tid) {
        ticketRow = i + 1;
        ticket = {
          id: tid,
          userId: String(dataT[i][1] || "").trim(),
          userImie: String(dataT[i][2] || "").trim(),
          temat: String(dataT[i][3] || "").trim(),
          status: String(dataT[i][4] || "Otwarty").trim(),
          assignedAdminId: String(dataT[i][6] || "").trim(),
          assignedAdminImie: String(dataT[i][7] || "").trim(),
          helperAdminIds: String((dataT[i].length > 9 ? dataT[i][9] : "") || "").trim()
        };
        // PATCH_TICKET_HELPERS_V3 — lista helperów z rozwiązaniem imion (cache)
        ticket.helperList = _rozwiazHelperList(ticket.helperAdminIds);
        break;
      }
    }
    if (!ticket) return { sukces: false, wiadomosc: "Nie znaleziono ticketu.", wiadomosci: [] };

    var isAdmin = (String(rola || "").toUpperCase().indexOf("ADMIN") === 0);
    if (!_mozeWidziecTicket(uid, rola, ticket.userId, ticket.assignedAdminId, ticket.helperAdminIds)) {
      return { sukces: false, wiadomosc: "Brak dostępu do tego ticketu.", wiadomosci: [] };
    }

    var sheetW = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Tickety_wiadomosci");
    var wiadomosci = [];
    var tz = _APP_TZ;
    if (sheetW && sheetW.getLastRow() > 1) {
      var dataW = sheetW.getDataRange().getValues();
      for (var j = 1; j < dataW.length; j++) {
        if (String(dataW[j][0] || "").trim() !== tid) continue;
        var dw = dataW[j][5] instanceof Date ? dataW[j][5] : new Date(dataW[j][5]);
        var isAdm = dataW[j][3] === true || String(dataW[j][3]).toUpperCase() === "TRUE";
        wiadomosci.push({
          authorId: String(dataW[j][1] || "").trim(),
          authorImie: String(dataW[j][2] || "").trim(),
          isAdmin: isAdm,
          tresc: String(dataW[j][4] || ""),
          data: isNaN(dw.getTime()) ? "" : Utilities.formatDate(dw, tz, "dd.MM.yyyy HH:mm"),
          dataTs: isNaN(dw.getTime()) ? 0 : dw.getTime(),
          // PATCH_TICKET_PHOTOS_V1 — linki do zdjęć (JSON array lub "")
          linkMedia: String(dataW[j][6] || "")
        });
      }
      wiadomosci.sort(function(a, b) { return a.dataTs - b.dataTs; });
    }

    var moznaPrzejac = isAdmin && !ticket.assignedAdminId &&
      String(ticket.status || "").toLowerCase().indexOf("otwart") >= 0;

    return {
      sukces: true,
      ticket: ticket,
      wiadomosci: wiadomosci,
      isAdmin: isAdmin,
      moznaPrzejac: moznaPrzejac
    };
  } catch (e) {
    return { sukces: false, wiadomosci: [], wiadomosc: e.message };
  }
}

/** Admin przejmuje nieprzypisany ticket (pula „ktokolwiek”). */
function przejmijTicket(userId, imie, ticketId) {
  try {
    var uid = String(userId || "").trim();
    var tid = String(ticketId || "").trim();
    if (!uid || !tid) return { sukces: false, wiadomosc: "Brak danych." };

    var rola = pobierzRoleUzytkownika(uid);
    if (String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) return { sukces: false, wiadomosc: "Tylko administrator może przejąć ticket." };

    var sheetT = _arkuszTickety();
    var dataT = sheetT.getDataRange().getValues();
    var ticketRow = -1;
    var ticketUserId = "";
    var ticketTemat = "";
    var assignedId = "";
    var status = "";

    for (var i = 1; i < dataT.length; i++) {
      if (String(dataT[i][0] || "").trim() === tid) {
        ticketRow = i + 1;
        ticketUserId = String(dataT[i][1] || "").trim();
        ticketTemat = String(dataT[i][3] || "").trim();
        assignedId = String(dataT[i][6] || "").trim();
        status = String(dataT[i][4] || "").trim();
        break;
      }
    }
    if (ticketRow < 0) return { sukces: false, wiadomosc: "Nie znaleziono ticketu." };
    if (assignedId) {
      return { sukces: false, wiadomosc: "Ten ticket jest już przypisany do innego administratora." };
    }
    if (status.toLowerCase().indexOf("zamkn") >= 0) {
      return { sukces: false, wiadomosc: "Nie można przejąć zamkniętego ticketu." };
    }

    var adminImie = String(imie || "").trim();
    if (!adminImie) {
      var admini = getListaAdminow().admini || [];
      for (var a = 0; a < admini.length; a++) {
        if (admini[a].id === uid) { adminImie = admini[a].imie; break; }
      }
    }
    if (!adminImie) adminImie = uid;

    sheetT.getRange(ticketRow, 7).setValue(uid);
    sheetT.getRange(ticketRow, 8).setValue(adminImie);
    sheetT.getRange(ticketRow, 9).setValue(new Date());

    _arkuszTicketyWiadomosci().appendRow([
      tid,
      uid,
      adminImie,
      true,
      "Administrator " + adminImie + " przejął ten ticket.",
      new Date()
    ]);

    if (ticketUserId && ticketUserId !== uid) {
      var tyt = "Administrator zajął się Twoim ticketem";
      var op = adminImie + " przejął sprawę: " + ticketTemat;
      _zapiszZdarzeniePowiadomienia(
        ticketUserId,
        "ticket_claim_" + tid + "_" + Date.now(),
        "ticket",
        "🙋",
        tyt,
        op,
        "page-kontakt"
      );
      wyslijPowiadomienieDoUserow(ticketUserId, tyt, op);
    }

    _logAdmin(uid, adminImie, "TICKET_PRZEJMIJ", tid, ticketTemat);
    return { sukces: true, wiadomosc: "Przejęto ticket. Od teraz widzisz go tylko Ty i autor." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function dodajWiadomoscDoTicketu(userId, imie, ticketId, tresc, linkMedia) {
  var _tLock = LockService.getScriptLock();
  var _tGotLock = false;
  try { _tGotLock = _tLock.tryLock(8000); } catch (eL) {}
  if (!_tGotLock) return { sukces: false, wiadomosc: "Serwer zajęty — spróbuj ponownie." };
  try {
    var uid = String(userId || "").trim();
    var tid = String(ticketId || "").trim();
    var tr = String(tresc || "").trim();
    if (!uid || !tid) return { sukces: false, wiadomosc: "Brak danych." };
    // PATCH_TICKET_PHOTOS_V1 — dopuszczamy sam obraz bez tekstu
    var _maMedia = Array.isArray(linkMedia) && linkMedia.length > 0;
    if (!tr && !_maMedia) return { sukces: false, wiadomosc: "Wpisz treść wiadomości lub dodaj zdjęcie." };
    if (tr.length > 2000) tr = tr.substring(0, 2000);
    try {
      var _dedupKey = "ticket_msg_" + tid + "_" + uid;
      var _cache = CacheService.getScriptCache();
      if (_cache.get(_dedupKey) === tr) return { sukces: true, wiadomosc: "Wiadomość już wysłana.", _duplikat: true };
      _cache.put(_dedupKey, tr, 15);
    } catch (eC) {}
    // >>> FIX: dodatkowa warstwa dedup przez bezposredni skan arkusza.
    // CacheService bywa eventualnie spojny i NIE lapie duplikatu gdy
    // kilka wywolan trafia na rozne instancje Apps Script jednoczesnie.
    // Sprawdzamy ostatnie ~30 wierszy: ten sam autor + ta sama tresc
    // w ciagu 10 s -> traktujemy jako duplikat i odsylamy _duplikat:true.
    try {
      var _sheetW0 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Tickety_wiadomosci");
      if (_sheetW0 && _sheetW0.getLastRow() > 1) {
        var _last0 = _sheetW0.getLastRow();
        var _start0 = Math.max(2, _last0 - 30);
        var _recent0 = _sheetW0.getRange(_start0, 1, _last0 - _start0 + 1, 6).getValues();
        var _now0 = Date.now();
        for (var _ri = _recent0.length - 1; _ri >= 0; _ri--) {
          var _rowR = _recent0[_ri];
          if (String(_rowR[0]).trim() !== tid) continue;
          if (String(_rowR[1]).trim() !== uid) continue;
          if (String(_rowR[4]) !== tr) continue;
          var _dR = _rowR[5] instanceof Date ? _rowR[5] : new Date(_rowR[5]);
          if (isNaN(_dR.getTime())) continue;
          if (_now0 - _dR.getTime() < 10000) {
            return { sukces: true, wiadomosc: "Wiadomość już wysłana.", _duplikat: true };
          }
        }
      }
    } catch (eDedup) {}
    var rola = pobierzRoleUzytkownika(uid);
    if (!rola) return { sukces: false, wiadomosc: "Brak uprawnień." };
    var isAdmin = (String(rola || "").toUpperCase().indexOf("ADMIN") === 0);

    var sheetT = _arkuszTickety();
    var dataT = sheetT.getDataRange().getValues();
    var ticketRow = -1;
    var ticketUserId = "";
    var ticketTemat = "";
    var ticketStatus = "";
    var assignedId = "";
    var helpersRaw = "";

    for (var i = 1; i < dataT.length; i++) {
      if (String(dataT[i][0] || "").trim() === tid) {
        ticketRow = i + 1;
        ticketUserId = String(dataT[i][1] || "").trim();
        ticketTemat = String(dataT[i][3] || "").trim();
        ticketStatus = String(dataT[i][4] || "").trim();
        assignedId = String(dataT[i][6] || "").trim();
        helpersRaw = dataT[i].length > 9 ? String(dataT[i][9] || "") : "";
        break;
      }
    }
    if (ticketRow < 0) return { sukces: false, wiadomosc: "Nie znaleziono ticketu." };
    if (!_mozeWidziecTicket(uid, rola, ticketUserId, assignedId, helpersRaw)) {
      return { sukces: false, wiadomosc: "Brak dostępu do tego ticketu." };
    }
    if (ticketStatus.toLowerCase().indexOf("zamkn") >= 0) {
      return { sukces: false, wiadomosc: "Ticket jest zamknięty. Otwórz go ponownie, aby pisać." };
    }

    // Admin bez przypisania (i nie będący helperem) musi najpierw przejąć
    // ticket. Helper-admin może odpisywać od razu — jest traktowany jak
    // przypisany admin.
    var _helperIdsW = _parsujHelperIds(helpersRaw);
    var _isHelperW = _helperIdsW.indexOf(uid) >= 0;
    if (isAdmin && !assignedId && ticketUserId !== uid && !_isHelperW) {
      return { sukces: false, wiadomosc: "Najpierw przejmij ticket, zanim odpowiesz." };
    }

    var teraz = new Date();
    // PATCH_TICKET_PHOTOS_V1 — linki do zdjęć zapisujemy jako JSON array
    // (identyczny format jak w Społeczności i Komentarzach).
    var _mediaStr = "";
    if (_maMedia) {
      _mediaStr = JSON.stringify(linkMedia.filter(function(l) {
        return l && String(l).trim() !== "";
      }));
    }
    _arkuszTicketyWiadomosci().appendRow([
      tid,
      uid,
      String(imie || "").trim(),
      isAdmin,
      tr,
      teraz,
      _mediaStr
    ]);
    sheetT.getRange(ticketRow, 9).setValue(teraz);

    // >>> ZASADY POWIADOMIEŃ W TICKECIE:
    //   • admin pisze  → push do NIE-ADMINÓW (autor + helperzy-ministranci)
    //   • nie-admin    → push do ADMINÓW (assigned + helperzy-admini)
    //   • nadawca nigdy nie dostaje pusha o swojej wiadomości
    if (isAdmin) {
      var _odbA = [];
      if (ticketUserId && ticketUserId !== uid) _odbA.push(ticketUserId);
      for (var _hi = 0; _hi < _helperIdsW.length; _hi++) {
        var _hId = _helperIdsW[_hi];
        if (!_hId || _hId === uid) continue;
        if (_odbA.indexOf(_hId) >= 0) continue;
        var _hRola = String(pobierzRoleUzytkownika(_hId) || "").toUpperCase();
        if (_hRola.indexOf("ADMIN") === 0) continue;
        _odbA.push(_hId);
      }
      if (_odbA.length) {
        var tytA = "Odpowiedź administratora w tickecie: " + ticketTemat;
        var opA = (String(imie || "Admin") + ": " + tr).substring(0, 200);
        for (var _ai = 0; _ai < _odbA.length; _ai++) {
          _zapiszZdarzeniePowiadomienia(
            _odbA[_ai],
            "ticket_reply_" + tid + "_" + Date.now() + "_" + _odbA[_ai],
            "ticket", "💬", tytA, opA, "page-kontakt"
          );
        }
        wyslijPowiadomienieDoUserow(_odbA, tytA, opA);
      }
    } else {
      var _odbU = [];
      if (assignedId && assignedId !== uid) _odbU.push(assignedId);
      for (var _hi2 = 0; _hi2 < _helperIdsW.length; _hi2++) {
        var _hId2 = _helperIdsW[_hi2];
        if (!_hId2 || _hId2 === uid) continue;
        if (_odbU.indexOf(_hId2) >= 0) continue;
        var _hRola2 = String(pobierzRoleUzytkownika(_hId2) || "").toUpperCase();
        if (_hRola2.indexOf("ADMIN") !== 0) continue;
        _odbU.push(_hId2);
      }
      if (_odbU.length) {
        var tytU = "Nowa wiadomość w tickecie: " + ticketTemat;
        var opU = (String(imie || uid) + ": " + tr).substring(0, 200);
        for (var _ui = 0; _ui < _odbU.length; _ui++) {
          _zapiszZdarzeniePowiadomienia(
            _odbU[_ui],
            "ticket_reply_" + tid + "_" + Date.now() + "_" + _odbU[_ui],
            "ticket", "💬", tytU, opU, "page-kontakt"
          );
        }
        wyslijPowiadomienieDoUserow(_odbU, tytU, opU);
      }
    }

    return { sukces: true, wiadomosc: "Wiadomość wysłana." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  } finally {
    if (_tGotLock) { try { _tLock.releaseLock(); } catch (eR) {} }
  }
}


/** Administrator przypisany do ticketu wzywa innego admina na pomoc. */
function wezwijAdminaDoTicketu(userId, imie, ticketId, targetAdminId) {
  // Kompatybilność wsteczna — to samo co wezwijOsobeDoTicketu
  return wezwijOsobeDoTicketu(userId, imie, ticketId, targetAdminId);
}


/**
 * Zaprasza dowolną osobę (ministrant / admin) do ticketu jako helper.
 * Może: autor ticketu, przypisany admin, już dodany helper.
 */
function wezwijOsobeDoTicketu(userId, imie, ticketId, targetUserId) {
  try {
    var uid = String(userId || "").trim();
    var tid = String(ticketId || "").trim();
    var targetId = String(targetUserId || "").trim();
    if (!uid || !tid || !targetId) return { sukces: false, wiadomosc: "Brak danych." };
    if (targetId === uid) return { sukces: false, wiadomosc: "Nie możesz dodać samego siebie." };

    var rola = pobierzRoleUzytkownika(uid);
    if (!rola) return { sukces: false, wiadomosc: "Brak uprawnień." };

    var sheetT = _arkuszTickety();
    _upewnijKolumneHelperowTicket(sheetT);
    var dataT = sheetT.getDataRange().getValues();
    var ticketRow = -1;
    var ticketUserId = "";
    var ticketTemat = "";
    var assignedId = "";
    var helpersRaw = "";
    var status = "";

    for (var i = 1; i < dataT.length; i++) {
      if (String(dataT[i][0] || "").trim() === tid) {
        ticketRow = i + 1;
        ticketUserId = String(dataT[i][1] || "").trim();
        ticketTemat = String(dataT[i][3] || "").trim();
        status = String(dataT[i][4] || "").trim();
        assignedId = String(dataT[i][6] || "").trim();
        helpersRaw = dataT[i].length > 9 ? String(dataT[i][9] || "") : "";
        break;
      }
    }
    if (ticketRow < 0) return { sukces: false, wiadomosc: "Nie znaleziono ticketu." };
    if (String(status).toLowerCase().indexOf("zamkn") >= 0) {
      return { sukces: false, wiadomosc: "Nie można dodawać osób do zamkniętego ticketu." };
    }

    var isAuthor = (ticketUserId === uid);
    var isAssigned = (assignedId === uid);
    var helpers = _parsujHelperIds(helpersRaw);
    var isHelper = helpers.indexOf(uid) >= 0;
    var isAdmin = (String(rola || "").toUpperCase().indexOf("ADMIN") === 0);

    // >>> TYLKO ADMIN może dodawać kogokolwiek do ticketu.
    if (!isAdmin) {
      return { sukces: false, wiadomosc: "Tylko administrator może dodawać osoby do ticketu." };
    }
    // Admin nieprzypisany do cudzego ticketu — najpierw przejęcie
    if (!isAuthor && !isAssigned && !isHelper && assignedId) {
      return { sukces: false, wiadomosc: "Ten ticket prowadzi inny administrator." };
    }

    // Imię targetu z Kandydaci lub Hasła
    var targetImie = targetId;
    var sheetK = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Kandydaci");
    if (sheetK) {
      var dk = sheetK.getDataRange().getValues();
      for (var k = 1; k < dk.length; k++) {
        if (String(dk[k][0] || "").trim() === targetId) {
          targetImie = String(dk[k][1] || "").trim() || targetId;
          break;
        }
      }
    }
    if (targetImie === targetId) {
      var admini = getListaAdminow().admini || [];
      for (var a = 0; a < admini.length; a++) {
        if (admini[a].id === targetId) { targetImie = admini[a].imie || targetId; break; }
      }
    }

    if (helpers.indexOf(targetId) >= 0) {
      return { sukces: false, wiadomosc: "Ta osoba jest już dodana do ticketu." };
    }
    if (targetId === assignedId) {
      return { sukces: false, wiadomosc: "Ta osoba już prowadzi ten ticket." };
    }
    if (targetId === ticketUserId) {
      return { sukces: false, wiadomosc: "Autor ticketu jest już w rozmowie." };
    }

    helpers.push(targetId);
    sheetT.getRange(ticketRow, 10).setValue(helpers.join(","));
    sheetT.getRange(ticketRow, 9).setValue(new Date());

    var callerImie = String(imie || "").trim() || uid;
    _arkuszTicketyWiadomosci().appendRow([
      tid,
      uid,
      callerImie,
      isAdmin,
      callerImie + " dodał(a) do ticketu: " + targetImie + ".",
      new Date()
    ]);

    var tyt = "Dodano Cię do ticketu: " + ticketTemat;
    var op = callerImie + " dodał(a) Cię do rozmowy.";
    _zapiszZdarzeniePowiadomienia(
      targetId,
      "ticket_help_" + tid + "_" + targetId,
      "ticket",
      "🎫",
      tyt,
      op,
      "page-kontakt"
    );
    wyslijPowiadomienieDoUserow(targetId, tyt, op);

    return { sukces: true, wiadomosc: "Dodano: " + targetImie + "." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

function zmienStatusTicketu(userId, ticketId, nowyStatus, powodZamkniecia) {
  try {
    var uid = String(userId || "").trim();
    var tid = String(ticketId || "").trim();
    var st = String(nowyStatus || "").trim();
    var powodZ = String(powodZamkniecia || "").trim();
    if (!uid || !tid) return { sukces: false, wiadomosc: "Brak danych." };

    var rola = pobierzRoleUzytkownika(uid);
    if (!rola) return { sukces: false, wiadomosc: "Brak uprawnień." };
    var isAdmin = (String(rola || "").toUpperCase().indexOf("ADMIN") === 0);

    var sheetT = _arkuszTickety();
    var dataT = sheetT.getDataRange().getValues();
    var ticketRow = -1;
    var ticketUserId = "";
    var ticketTemat = "";
    var assignedId = "";
    var helpersRaw = "";

    for (var i = 1; i < dataT.length; i++) {
      if (String(dataT[i][0] || "").trim() === tid) {
        ticketRow = i + 1;
        ticketUserId = String(dataT[i][1] || "").trim();
        ticketTemat = String(dataT[i][3] || "").trim();
        assignedId = String(dataT[i][6] || "").trim();
        helpersRaw = dataT[i].length > 9 ? String(dataT[i][9] || "") : "";
        break;
      }
    }
    if (ticketRow < 0) return { sukces: false, wiadomosc: "Nie znaleziono ticketu." };

    if (!_mozeWidziecTicket(uid, rola, ticketUserId, assignedId, helpersRaw)) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    // Admin może zamykać:
    //  - tickety przypisane do siebie (assignedId === uid),
    //  - nieprzypisane (widzi je, żeby mógł przejąć i zamknąć),
    //  - tickety, do których został dodany jako HELPER (wezwany na pomoc),
    //  - własne tickety (ticketUserId === uid).
    // Admin z innego, już przypisanego ticketu (bez bycia helperem) — nadal
    // NIE może zamknąć cudzej rozmowy.
    var helperIdsZm = _parsujHelperIds(helpersRaw);
    var isHelperZm = helperIdsZm.indexOf(uid) >= 0;
    var isAuthorZm = (ticketUserId === uid);
    // Helper-ministrant NIE może zamykać ani otwierać ticketu.
    if (!isAdmin && !isAuthorZm && isHelperZm) {
      return { sukces: false, wiadomosc: "Helper nie może zmieniać statusu ticketu." };
    }
    // Admin nie-helper z cudzego, już przypisanego ticketu — brak uprawnień.
    if (isAdmin && assignedId && assignedId !== uid && !isAuthorZm && !isHelperZm) {
      return { sukces: false, wiadomosc: "Brak uprawnień do tego ticketu." };
    }

    var statusDocelowy = (st.toLowerCase().indexOf("zamkn") >= 0) ? "Zamknięty" : "Otwarty";
    if (isAdmin) _logAdmin(uid, "", "TICKET_" + (statusDocelowy === "Zamknięty" ? "ZAMKNIJ" : "OTWORZ"), tid, ticketTemat + (powodZ ? (" | " + powodZ) : ""));
    sheetT.getRange(ticketRow, 5).setValue(statusDocelowy);
    sheetT.getRange(ticketRow, 9).setValue(new Date());

    var sysTresc;
    if (statusDocelowy === "Zamknięty") {
      sysTresc = "Ticket został zamknięty." + (powodZ ? (" Powód: " + powodZ) : "");
    } else {
      sysTresc = "Ticket został ponownie otwarty.";
    }
    _arkuszTicketyWiadomosci().appendRow([
      tid,
      uid,
      String(isAdmin ? "Administrator" : "Użytkownik"),
      isAdmin,
      sysTresc,
      new Date()
    ]);

    // Powiadomienia o zmianie statusu (te same zasady co przy wiadomościach):
    //   • admin zmienił  → nie-admini (autor + helperzy-nie-admini)
    //   • nie-admin       → admini (assigned + helperzy-admini)
    if (isAdmin) {
      var _odbSt = [];
      if (ticketUserId && ticketUserId !== uid) _odbSt.push(ticketUserId);
      for (var _hsi = 0; _hsi < helperIdsZm.length; _hsi++) {
        var _hsId = helperIdsZm[_hsi];
        if (!_hsId || _hsId === uid) continue;
        if (_odbSt.indexOf(_hsId) >= 0) continue;
        var _hsRola = String(pobierzRoleUzytkownika(_hsId) || "").toUpperCase();
        if (_hsRola.indexOf("ADMIN") === 0) continue;
        _odbSt.push(_hsId);
      }
      if (_odbSt.length) {
        var tytSt = (statusDocelowy === "Zamknięty" ? "Ticket zamknięty: " : "Ticket otwarty: ") + ticketTemat;
        for (var _si = 0; _si < _odbSt.length; _si++) {
          _zapiszZdarzeniePowiadomienia(
            _odbSt[_si],
            "ticket_status_" + tid + "_" + statusDocelowy + "_" + _odbSt[_si],
            "ticket", statusDocelowy === "Zamknięty" ? "🔒" : "🔓", tytSt, sysTresc, "page-kontakt"
          );
        }
        wyslijPowiadomienieDoUserow(_odbSt, tytSt, sysTresc);
      }
    } else {
      var _odbSt2 = [];
      if (assignedId && assignedId !== uid) _odbSt2.push(assignedId);
      for (var _hsi2 = 0; _hsi2 < helperIdsZm.length; _hsi2++) {
        var _hsId2 = helperIdsZm[_hsi2];
        if (!_hsId2 || _hsId2 === uid) continue;
        if (_odbSt2.indexOf(_hsId2) >= 0) continue;
        var _hsRola2 = String(pobierzRoleUzytkownika(_hsId2) || "").toUpperCase();
        if (_hsRola2.indexOf("ADMIN") !== 0) continue;
        _odbSt2.push(_hsId2);
      }
      if (_odbSt2.length) {
        var tytSt2 = (statusDocelowy === "Zamknięty" ? "Ticket zamknięty przez użytkownika: " : "Ticket otwarty: ") + ticketTemat;
        for (var _si2 = 0; _si2 < _odbSt2.length; _si2++) {
          _zapiszZdarzeniePowiadomienia(
            _odbSt2[_si2],
            "ticket_status_" + tid + "_" + statusDocelowy + "_" + _odbSt2[_si2],
            "ticket", statusDocelowy === "Zamknięty" ? "🔒" : "🔓", tytSt2, sysTresc, "page-kontakt"
          );
        }
        wyslijPowiadomienieDoUserow(_odbSt2, tytSt2, sysTresc);
      }
    }

    return { sukces: true, status: statusDocelowy, wiadomosc: "Status zmieniony: " + statusDocelowy };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}

// ----------------------------------------------------------------------
// STATYSTYKI ADMINISTRACYJNE (zakładka tech. dla ADMIN/MODERATOR)
// ----------------------------------------------------------------------

function _parseZakresStat(odIso, doIso) {
  var teraz = new Date();
  var doD = doIso ? new Date(doIso) : teraz;
  var odD = odIso ? new Date(odIso) : new Date(teraz.getTime() - 30 * 24 * 3600 * 1000);
  if (isNaN(odD.getTime())) odD = new Date(teraz.getTime() - 30 * 24 * 3600 * 1000);
  if (isNaN(doD.getTime())) doD = teraz;
  odD.setHours(0, 0, 0, 0);
  doD.setHours(23, 59, 59, 999);
  if (odD.getTime() > doD.getTime()) {
    var t = odD; odD = doD; doD = t;
  }
  return { od: odD, do_: doD };
}

function _dataWZakresie(d, od, do_) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return false;
  var t = d.getTime();
  return t >= od.getTime() && t <= do_.getTime();
}

function _normalizujRangeLabel(ranga) {
  var r = String(ranga || "").trim();
  if (!r) return "Brak rangi";
  var low = r.toLowerCase();
  if (low.indexOf("kandydat") >= 0) return "Kandydat";
  if (low.indexOf("ministrant") >= 0 && low.indexOf("młod") >= 0) return "Ministrant młodszy";
  if (low.indexOf("ministrant") >= 0 && low.indexOf("stars") >= 0) return "Ministrant starszy";
  if (low === "ministrant") return "Ministrant";
  if (low.indexOf("lektor") >= 0 && low.indexOf("młod") >= 0) return "Lektor młodszy";
  if (low.indexOf("lektor") >= 0) return "Lektor";
  if (low.indexOf("ksi") >= 0) return "Ksiądz";
  return r;
}

/**
 * Statystyki LSO dla administracji.
 * odIso / doIso — opcjonalne ISO daty (YYYY-MM-DD lub pełne).
 */
function getStatystykiAdmin(userId, odIso, doIso) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Brak sesji." };
    var rola = pobierzRoleUzytkownika(uid);
    var rU = String(rola || "").toUpperCase();
    if (rU.indexOf("ADMIN") !== 0 && rU !== "MODERATOR" && rU !== "KSIADZ") {
      return { sukces: false, wiadomosc: "Brak uprawnień — tylko administracja." };
    }

    var zakres = _parseZakresStat(odIso, doIso);
    var od = zakres.od;
    var do_ = zakres.do_;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = _APP_TZ;

    // --- Skład LSO (obecny stan) ---
    var sklad = {
      "Kandydat": 0,
      "Ministrant": 0,
      "Ministrant młodszy": 0,
      "Ministrant starszy": 0,
      "Lektor młodszy": 0,
      "Lektor starszy": 0,
      "Lektor": 0,
      "Ksiądz": 0,
      "Inne": 0
    };
    var czlonkowie = 0;
    var sheetK = ss.getSheetByName("Kandydaci");
    var kandRows = sheetK ? sheetK.getDataRange().getValues() : [];
    var idToRanga = {};
    for (var i = 1; i < kandRows.length; i++) {
      var idK = _normId(kandRows[i][0]);
      if (!idK) continue;
      var rg = _normalizujRangeLabel(kandRows[i][6]);
      if (sklad.hasOwnProperty(rg)) sklad[rg]++;
      else sklad["Inne"]++;
      czlonkowie++;
      idToRanga[idK] = rg;
    }

    // --- Logi (czytnik + ręczne) ---
    var sheetLogi = ss.getSheetByName("Logi_czytnik");
    var logi = sheetLogi && sheetLogi.getLastRow() > 1 ? sheetLogi.getDataRange().getValues() : [];
    var sheetReczne = ss.getSheetByName("Logi_ręczne");
    var reczne = sheetReczne && sheetReczne.getLastRow() > 1 ? sheetReczne.getDataRange().getValues() : [];

    var dyzuryZrealizowane = 0;
    var zbiorkiUniqDni = {};
    var zbiorkiWpisy = 0;
    var mszeWpisy = 0;
    var uroczystosciLog = 0;
    var pierwszeLogTs = {}; // id -> earliest timestamp (all time)
    var aktywneIdWZakresie = {};

    function skanLogi(rows, colData, colId, colNazwa) {
      for (var r = 1; r < rows.length; r++) {
        var d = rows[r][colData] instanceof Date ? rows[r][colData] : new Date(rows[r][colData]);
        if (isNaN(d.getTime())) continue;
        var idL = _normId(rows[r][colId]);
        if (!idL) continue;
        var ts = d.getTime();
        if (!pierwszeLogTs[idL] || ts < pierwszeLogTs[idL]) pierwszeLogTs[idL] = ts;
        if (!_dataWZakresie(d, od, do_)) continue;
        aktywneIdWZakresie[idL] = true;
        var n = String(rows[r][colNazwa] || "").toLowerCase();
        if (n.indexOf("dyżur") >= 0 || n.indexOf("dyzur") >= 0) dyzuryZrealizowane++;
        if (n.indexOf("zbiór") >= 0 || n.indexOf("zbiork") >= 0) {
          zbiorkiWpisy++;
          var key = Utilities.formatDate(d, tz, "yyyy-MM-dd");
          zbiorkiUniqDni[key] = true;
        }
        if (n.indexOf("msza") >= 0) mszeWpisy++;
        if (n.indexOf("uroczyst") >= 0 || n.indexOf("triduum") >= 0 || n.indexOf("wielka sobota") >= 0) uroczystosciLog++;
      }
    }
    skanLogi(logi, 0, 1, 4);
    skanLogi(reczne, 0, 1, 2);

    var zbiorkiDni = Object.keys(zbiorkiUniqDni).length;

    // --- Nieobecności dyżurów (usprawiedliwione / wnioski) ---
    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    var nieobUsprawiedliwione = 0;
    var nieobOdrzucone = 0;
    var nieobOczekujace = 0;
    if (sheetN && sheetN.getLastRow() > 1) {
      var dn = sheetN.getDataRange().getValues();
      for (var ni = 1; ni < dn.length; ni++) {
        var dDyz = dn[ni][3] instanceof Date ? dn[ni][3] : new Date(dn[ni][3]);
        if (isNaN(dDyz.getTime())) {
          dDyz = dn[ni][0] instanceof Date ? dn[ni][0] : new Date(dn[ni][0]);
        }
        if (!_dataWZakresie(dDyz, od, do_)) continue;
        var st = String(dn[ni][6] || "").toLowerCase();
        if (st.indexOf("zaakcept") >= 0) nieobUsprawiedliwione++;
        else if (st.indexOf("odrzuc") >= 0) nieobOdrzucone++;
        else nieobOczekujace++;
      }
    }

    // --- Nieusprawiedliwione: z logów ręcznych (automatyczne minusy) ---
    var nieusprawiedliwione = 0;
    for (var rr = 1; rr < reczne.length; rr++) {
      var dR = reczne[rr][0] instanceof Date ? reczne[rr][0] : new Date(reczne[rr][0]);
      if (!_dataWZakresie(dR, od, do_)) continue;
      var naz = String(reczne[rr][2] || "").toLowerCase();
      if (naz.indexOf("nieusprawiedliw") >= 0 && (naz.indexOf("dyżur") >= 0 || naz.indexOf("dyzur") >= 0)) {
        nieusprawiedliwione++;
      }
    }
    // jeśli automat jeszcze nie naliczył — szacunek: oczekiwane tygodnie minus zrealizowane minus usprawiedliwione
    // (tylko gdy mamy stałe dyżury)
    var sheetD = ss.getSheetByName("Dyżury");
    var liczbaOsobZDyzurem = 0;
    if (sheetD && sheetD.getLastRow() > 1) {
      var dd = sheetD.getDataRange().getValues();
      var seenD = {};
      for (var di = 1; di < dd.length; di++) {
        var idD = _normId(dd[di][2]);
        if (!idD || seenD[idD]) continue;
        seenD[idD] = true;
        liczbaOsobZDyzurem++;
      }
    }

    // --- Uroczystości z kalendarza w zakresie ---
    var sheetKal = ss.getSheetByName("Kalendarz");
    var uroczystosciKal = [];
    var uroczystosciLiczba = 0;
    if (sheetKal && sheetKal.getLastRow() > 1) {
      var dk = sheetKal.getDataRange().getValues();
      for (var ki = 1; ki < dk.length; ki++) {
        if (!dk[ki][0]) continue;
        var dt = dk[ki][0] instanceof Date ? dk[ki][0] : new Date(dk[ki][0]);
        if (!_dataWZakresie(dt, od, do_)) continue;
        var nazwa = String(dk[ki][1] || "").trim();
        var pktK = parseInt(dk[ki][2], 10) || 0;
        var lowN = nazwa.toLowerCase();
        var jestUrocz = pktK >= 8 || lowN.indexOf("uroczyst") >= 0 || lowN.indexOf("triduum") >= 0
          || lowN.indexOf("święt") >= 0 || lowN.indexOf("swiet") >= 0
          || lowN.indexOf("wielk") >= 0 || lowN.indexOf("boże") >= 0 || lowN.indexOf("boze") >= 0;
        if (jestUrocz) {
          uroczystosciLiczba++;
          if (uroczystosciKal.length < 20) {
            uroczystosciKal.push({
              data: Utilities.formatDate(dt, tz, "dd.MM.yyyy"),
              nazwa: nazwa,
              punkty: pktK
            });
          }
        }
      }
    }

    // --- Nowi kandydaci: osoby z rangą Kandydat, których pierwszy log wpada w zakres
    //     LUB (gdy brak logów) raportujemy tylko aktualną liczbę kandydatów.
    var nowiKandydaci = 0;
    var nowiKandydaciLista = [];
    for (var cid in idToRanga) {
      if (!idToRanga.hasOwnProperty(cid)) continue;
      if (idToRanga[cid] !== "Kandydat") continue;
      var firstTs = pierwszeLogTs[cid];
      if (firstTs && firstTs >= od.getTime() && firstTs <= do_.getTime()) {
        nowiKandydaci++;
        var imieK = "";
        for (var ii = 1; ii < kandRows.length; ii++) {
          if (_normId(kandRows[ii][0]) === cid) { imieK = String(kandRows[ii][1] || cid); break; }
        }
        if (nowiKandydaciLista.length < 15) {
          nowiKandydaciLista.push({ id: cid, imie: imieK });
        }
      }
    }

    // Serie miesięczne (do wykresów) — ostatnie miesiące pokrywające zakres, max 12
    var serieMiesieczne = [];
    var cursor = new Date(od.getFullYear(), od.getMonth(), 1);
    var endM = new Date(do_.getFullYear(), do_.getMonth(), 1);
    var guard = 0;
    while (cursor.getTime() <= endM.getTime() && guard < 14) {
      var mStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 0, 0, 0, 0);
      var mEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
      var label = Utilities.formatDate(mStart, tz, "MM.yyyy");
      var dyzM = 0, zbM = 0, nieuspM = 0, usprM = 0;
      // reuse scan style on already-loaded arrays
      for (var lr = 1; lr < logi.length; lr++) {
        var dL = logi[lr][0] instanceof Date ? logi[lr][0] : new Date(logi[lr][0]);
        if (!_dataWZakresie(dL, mStart, mEnd)) continue;
        var nl = String(logi[lr][4] || "").toLowerCase();
        if (nl.indexOf("dyżur") >= 0 || nl.indexOf("dyzur") >= 0) dyzM++;
        if (nl.indexOf("zbiór") >= 0 || nl.indexOf("zbiork") >= 0) zbM++;
      }
      for (var lr2 = 1; lr2 < reczne.length; lr2++) {
        var dL2 = reczne[lr2][0] instanceof Date ? reczne[lr2][0] : new Date(reczne[lr2][0]);
        if (!_dataWZakresie(dL2, mStart, mEnd)) continue;
        var nl2 = String(reczne[lr2][2] || "").toLowerCase();
        if (nl2.indexOf("dyżur") >= 0 || nl2.indexOf("dyzur") >= 0) dyzM++;
        if (nl2.indexOf("zbiór") >= 0 || nl2.indexOf("zbiork") >= 0) zbM++;
        if (nl2.indexOf("nieusprawiedliw") >= 0 && (nl2.indexOf("dyżur") >= 0 || nl2.indexOf("dyzur") >= 0)) nieuspM++;
      }
      if (sheetN && sheetN.getLastRow() > 1) {
        var dn2 = sheetN.getDataRange().getValues();
        for (var n2 = 1; n2 < dn2.length; n2++) {
          var dDx = dn2[n2][3] instanceof Date ? dn2[n2][3] : new Date(dn2[n2][3]);
          if (isNaN(dDx.getTime())) dDx = dn2[n2][0] instanceof Date ? dn2[n2][0] : new Date(dn2[n2][0]);
          if (!_dataWZakresie(dDx, mStart, mEnd)) continue;
          if (String(dn2[n2][6] || "").toLowerCase().indexOf("zaakcept") >= 0) usprM++;
        }
      }
      serieMiesieczne.push({ miesiac: label, dyzury: dyzM, zbiorki: zbM, nieusprawiedliwione: nieuspM, usprawiedliwione: usprM });
      cursor.setMonth(cursor.getMonth() + 1);
      guard++;
    }

    return {
      sukces: true,
      od: Utilities.formatDate(od, tz, "yyyy-MM-dd"),
      do: Utilities.formatDate(do_, tz, "yyyy-MM-dd"),
      odLabel: Utilities.formatDate(od, tz, "dd.MM.yyyy"),
      doLabel: Utilities.formatDate(do_, tz, "dd.MM.yyyy"),
      sklad: sklad,
      czlonkowie: czlonkowie,
      dyzury: {
        zrealizowane: dyzuryZrealizowane,
        usprawiedliwione: nieobUsprawiedliwione,
        nieusprawiedliwione: nieusprawiedliwione,
        wnioskiOczekujace: nieobOczekujace,
        wnioskiOdrzucone: nieobOdrzucone,
        osobyZDyzurem: liczbaOsobZDyzurem
      },
      zbiorki: {
        dni: zbiorkiDni,
        wpisy: zbiorkiWpisy
      },
      msze: mszeWpisy,
      uroczystosci: {
        liczba: uroczystosciLiczba,
        lista: uroczystosciKal,
        logi: uroczystosciLog
      },
      nowiKandydaci: {
        liczba: nowiKandydaci,
        lista: nowiKandydaciLista,
        obecnieKandydatow: sklad["Kandydat"] || 0
      },
      aktywniUnikalni: Object.keys(aktywneIdWZakresie).length,
      serieMiesieczne: serieMiesieczne
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}
/**
 * Serwerowe przypomnienia push o dyżurach. Wywoływane przez trigger co 15 min.
 *  1) Dzień wcześniej między 20:00 a 20:29 — "Jutro masz dyżur o HH:MM"
 *  2) Między 2h a 2h29m przed startem — "Za 2h masz dyżur o HH:MM"
 *
 * Deduplikacja: ScriptProperties "notif_dyzur_dedup" trzyma klucze już
 * wysłanych przypomnień (max 3 dni wstecz). Dzięki temu nawet jeśli trigger
 * odpali się z opóźnieniem, push pójdzie tylko raz.
 *
 * Uwaga: korzysta z RZECZYWISTEGO czasu serwera Google (new Date()),
 * nie z "czasu testowego" — inaczej testy przesunęłyby przypomnienia.
 */
function wyslijPrzypomnieniaDyzuryServer() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetD = ss.getSheetByName("Dyżury");
    if (!sheetD || sheetD.getLastRow() < 2) return { sukces: true, wyslane: 0 };

    var tz = _APP_TZ;
    var teraz = new Date();
    var terazMs = teraz.getTime();

    // Dedup
    var props = PropertiesService.getScriptProperties();
    var dedupRaw = props.getProperty("notif_dyzur_dedup") || "{}";
    var dedup;
    try { dedup = JSON.parse(dedupRaw); } catch (e) { dedup = {}; }
    var cutoff = terazMs - 3 * 24 * 3600 * 1000;
    Object.keys(dedup).forEach(function(k) {
      if (dedup[k] < cutoff) delete dedup[k];
    });

    var dane = sheetD.getDataRange().getValues();
    var wyslane = 0;

    for (var i = 1; i < dane.length; i++) {
      var uid = String(dane[i][2] || "").trim();
      if (!uid) continue;
      var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
      if (isNaN(dt.getTime())) continue;

      // >>> FIX DYŻUR-STALE 2026-09: pomiń dyżury, których okres obowiązywania
      // już się zakończył. Powód: zaakceptujWniosek NIE kasuje wiersza z arkusza,
      // tylko zamyka go przez "Obowiązuje do" = wczoraj (historia zostaje).
      // Bez tego powiadomienia "Jutro masz dyżur" / "Za 2h masz dyżur" leciały
      // dalej mimo zamknięcia dyżuru przez admina.
      var _dspDoRaw = dane[i][4];
      if (_dspDoRaw !== null && _dspDoRaw !== undefined && _dspDoRaw !== "") {
        var _dspDoKey = "";
        if (_dspDoRaw instanceof Date && !isNaN(_dspDoRaw.getTime())) {
          _dspDoKey = Utilities.formatDate(_dspDoRaw, tz, "yyyy-MM-dd");
        } else {
          var _dspDoStr = String(_dspDoRaw).trim();
          if (_dspDoStr.length >= 10) _dspDoKey = _dspDoStr.substring(0, 10);
        }
        if (_dspDoKey) {
          var _dspDzisKey = Utilities.formatDate(teraz, tz, "yyyy-MM-dd");
          if (_dspDoKey < _dspDzisKey) continue;
        }
      }

      var wd = dt.getDay();
      if (wd === 0) continue; // niedziela — brak dyżurów
      var hh = dt.getHours();
      var mm = dt.getMinutes();
      // >>> FIX 2026-09 (SAT-18-REMINDER):
      // Usunięto skip "
      // dyżur w Sobotę 18:00 dostaje normalne przypomnienia push
      // (dzień wcześniej o 20:00 oraz 2h przed startem), tak jak
      // każdy inny dyżur tygodniowy.

      // Najbliższe wystąpienie tego dyżuru (dziś lub w przyszłym tygodniu)
      var dzisStart = new Date(teraz.getFullYear(), teraz.getMonth(), teraz.getDate());
      var offset = (wd - dzisStart.getDay() + 7) % 7;
      var nastepny = new Date(dzisStart);
      nastepny.setDate(dzisStart.getDate() + offset);
      nastepny.setHours(hh, mm, 0, 0);
      if (nastepny.getTime() <= terazMs) {
        nastepny.setDate(nastepny.getDate() + 7);
      }

      var diffMin = (nastepny.getTime() - terazMs) / 60000;
      var godzinaTxt = (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;

      // (1) Jutro dyżur — okno 30 min od 20:00 dnia poprzedzającego
      var dzienPrzed = new Date(nastepny.getTime());
      dzienPrzed.setDate(dzienPrzed.getDate() - 1);
      dzienPrzed.setHours(20, 0, 0, 0);
      var minOdWieczora = (terazMs - dzienPrzed.getTime()) / 60000;
      if (minOdWieczora >= 0 && minOdWieczora < 30) {
        var kluczW = "dyzur_wieczor_" + uid + "_" + Utilities.formatDate(nastepny, tz, "yyyy-MM-dd_HH:mm");
        if (!dedup[kluczW]) {
          try {
            wyslijPowiadomienieDoUserow(uid,
              "⛪ Jutro masz dyżur!",
              "Dyżur w " + _nazwaDniaPL(wd) + " o " + godzinaTxt + ". Pamiętaj!");
            _zapiszZdarzeniePowiadomienia(uid, kluczW, "dyzur", "⛪",
              "Jutro masz dyżur!",
              "Dyżur o " + godzinaTxt + " — pamiętaj!", "page-calendar");
            dedup[kluczW] = terazMs;
            wyslane++;
          } catch (eW) {}
        }
      }

      // (2) Za 2h dyżur — okno 30 min (od 120 do 150 min przed startem)
      if (diffMin >= 120 && diffMin < 150) {
        var klucz2 = "dyzur_2h_" + uid + "_" + Utilities.formatDate(nastepny, tz, "yyyy-MM-dd_HH:mm");
        if (!dedup[klucz2]) {
          try {
            wyslijPowiadomienieDoUserow(uid,
              "⏰ Za 2h masz dyżur!",
              "Dyżur o " + godzinaTxt + " — już niedługo!");
            _zapiszZdarzeniePowiadomienia(uid, klucz2, "dyzur", "⏰",
              "Za 2h masz dyżur!",
              "Dyżur o " + godzinaTxt + " — już niedługo!", "page-calendar");
            dedup[klucz2] = terazMs;
            wyslane++;
          } catch (e2) {}
        }
      }
    }

    // ============================================================
    // (3) Przypomnienia o ZBIÓRKACH — dzień wcześniej o 20:00 (okno 30 min)
    //     Push do wszystkich (poza księżmi).
    // ============================================================
    try {
      var kalZb = ss.getSheetByName("Kalendarz");
      if (kalZb && kalZb.getLastRow() > 1) {
        var dkZb = kalZb.getDataRange().getValues();
        var kandZb = ss.getSheetByName("Kandydaci");
        var dkKZb = (kandZb && kandZb.getLastRow() > 1) ? kandZb.getDataRange().getValues() : [];

        for (var kz = 1; kz < dkZb.length; kz++) {
          if (!dkZb[kz][0]) continue;
          var dtZ = dkZb[kz][0] instanceof Date ? dkZb[kz][0] : new Date(dkZb[kz][0]);
          if (isNaN(dtZ.getTime())) continue;
          var nazwaZb = String(dkZb[kz][1] || "").toLowerCase();
          if (nazwaZb.indexOf("zbiór") < 0 && nazwaZb.indexOf("zbiork") < 0) continue;

          var dpZb = new Date(dtZ.getTime());
          dpZb.setDate(dpZb.getDate() - 1);
          dpZb.setHours(20, 0, 0, 0);
          var minOdZb = (terazMs - dpZb.getTime()) / 60000;
          if (minOdZb < 0 || minOdZb >= 30) continue;

          var kluczZb = "kal_24h_" + dtZ.getTime();
          if (dedup[kluczZb]) continue;

          var idsZb = [];
          for (var iz = 1; iz < dkKZb.length; iz++) {
            var idZ = String(dkKZb[iz][0] || "").trim();
            if (!idZ) continue;
            var rZ = String(dkKZb[iz][6] || "").toLowerCase();
            if (rZ.indexOf("ksi") === 0) continue;
            idsZb.push(idZ);
          }

          if (idsZb.length) {
            var tytZb = "Jutro zbiórka!";
            var trZb = String(dkZb[kz][1] || "Zbiórka");

            // Dzwonek per-user (batch) + klucze dedup klienta
            try {
              var shZdZ = _arkuszZdarzenPowiadomien();
              var wZ = idsZb.map(function(x) {
                return [x, "push_" + kluczZb + "_" + x, "dyzur", "👥", tytZb, trZb, "page-calendar", teraz];
              });
              shZdZ.getRange(shZdZ.getLastRow() + 1, 1, wZ.length, 8).setValues(wZ);
            } catch (eZdZ) {}

            try {
              var shWZ = ss.getSheetByName("Powiadomienia_wyslane");
              if (!shWZ) {
                shWZ = ss.insertSheet("Powiadomienia_wyslane");
                shWZ.appendRow(["UserID", "Klucz", "Data"]);
              }
              var wZW = idsZb.map(function(x) { return [x, kluczZb, teraz]; });
              shWZ.getRange(shWZ.getLastRow() + 1, 1, wZW.length, 3).setValues(wZW);
            } catch (eWZ) {}

            // Push OneSignal — jedno zbiorcze wywołanie
            try {
              if (typeof wyslijPowiadomienieDoUserow === "function") {
                wyslijPowiadomienieDoUserow(idsZb, "👥 " + tytZb, trZb);
              }
            } catch (ePZ) {}

            dedup[kluczZb] = terazMs;
            wyslane++;
          }
        }
      }
    } catch (eBlokZb) {}

    // ============================================================
    // (4) DOSTĘPNOŚĆ — 7 dni przed uroczystością / Triduum,
    //     do tych, którzy jeszcze nie odpowiedzieli.
    // ============================================================
    try {
      var kalD = ss.getSheetByName("Kalendarz");
      if (kalD && kalD.getLastRow() > 1) {
        var dkD = kalD.getDataRange().getValues();
        var kandD = ss.getSheetByName("Kandydaci");
        var dkKD = (kandD && kandD.getLastRow() > 1) ? kandD.getDataRange().getValues() : [];

        // Odpowiedzi z arkusza Dostepnosc (kto odpowiedział na jaką uroczystość)
        var odpowiedzi = {};
        var shDost = ss.getSheetByName("Dostepnosc");
        if (shDost && shDost.getLastRow() > 1) {
          var dDost = shDost.getDataRange().getValues();
          for (var dd2 = 1; dd2 < dDost.length; dd2++) {
            var kluczD = String(dDost[dd2][3] || "").trim();
            var idOdp = String(dDost[dd2][1] || "").trim();
            if (kluczD && idOdp) odpowiedzi[kluczD + "|" + idOdp] = true;
          }
        }

        var dni7Ms = 7 * 24 * 3600 * 1000;
        for (var kd2 = 1; kd2 < dkD.length; kd2++) {
          if (!dkD[kd2][0]) continue;
          var dtD = dkD[kd2][0] instanceof Date ? dkD[kd2][0] : new Date(dkD[kd2][0]);
          if (isNaN(dtD.getTime())) continue;
          var nzD = String(dkD[kd2][1] || "").toLowerCase();
          var jestUroczD = nzD.indexOf("triduum") >= 0
                        || nzD.indexOf("uroczystoś") >= 0
                        || nzD.indexOf("uroczystos") >= 0
                        || nzD.indexOf("boże") >= 0
                        || nzD.indexOf("boze") >= 0
                        || nzD.indexOf("wniebow") >= 0
                        || nzD.indexOf("wielka sobota") >= 0;
          if (!jestUroczD) continue;

          var diffD = dtD.getTime() - terazMs;
          if (diffD < dni7Ms || diffD >= dni7Ms + 30 * 60 * 1000) continue;

          var kluczDostBazowy = "dostepnosc_" + dtD.getTime();
          if (dedup["dost_7d_" + dtD.getTime()]) continue;

          var idsD = [];
          for (var idD2 = 1; idD2 < dkKD.length; idD2++) {
            var idUserD = String(dkKD[idD2][0] || "").trim();
            if (!idUserD) continue;
            var rDD = String(dkKD[idD2][6] || "").toLowerCase();
            if (rDD.indexOf("ksi") === 0) continue;
            // pomiń tych, co już odpowiedzieli
            if (odpowiedzi[kluczDostBazowy + "|" + idUserD]) continue;
            idsD.push(idUserD);
          }

          if (idsD.length) {
            var tytDost = "Zgłoś dostępność!";
            var trDost = String(dkD[kd2][1] || "Uroczystość") +
                         " — zaznacz w apce czy będziesz.";
            var dataPlD = Utilities.formatDate(dtD, tz, "dd.MM.yyyy");

            try {
              var shZdD = _arkuszZdarzenPowiadomien();
              var wD = idsD.map(function(x) {
                return [x, "push_dost_7d_" + dtD.getTime() + "_" + x, "dostepnosc", "📅",
                        tytDost, dataPlD + " — " + trDost, "page-profile", teraz];
              });
              shZdD.getRange(shZdD.getLastRow() + 1, 1, wD.length, 8).setValues(wD);
            } catch (eZdD) {}

            // Klucz klienta per-user (klient używa formatu "dostepnosc_<ts>_<uid>")
            try {
              var shWD = ss.getSheetByName("Powiadomienia_wyslane");
              if (!shWD) {
                shWD = ss.insertSheet("Powiadomienia_wyslane");
                shWD.appendRow(["UserID", "Klucz", "Data"]);
              }
              var wDW = idsD.map(function(x) { return [x, "dostepnosc_" + dtD.getTime() + "_" + x, teraz]; });
              shWD.getRange(shWD.getLastRow() + 1, 1, wDW.length, 3).setValues(wDW);
            } catch (eWD) {}

            try {
              if (typeof wyslijPowiadomienieDoUserow === "function") {
                wyslijPowiadomienieDoUserow(idsD, "📅 " + tytDost, dataPlD + " — " + trDost);
              }
            } catch (ePD2) {}

            dedup["dost_7d_" + dtD.getTime()] = terazMs;
            wyslane++;
          }
        }
      }
    } catch (eBlokDost) {}

    // ============================================================
    // (5) WYDARZENIA BEZ PUNKTÓW (informacyjne) — przypomnienia push.
    //     Kryterium: punkty = 0 ORAZ nazwa nie zawiera słów specjalnych
    //     ("msza", "uroczyst", "triduum", "zbiórk", "wielka sobota") —
    //     dokładnie ta sama logika co _slotyWOknie (sekcja "BEZ PUNKTÓW").
    //
    //     Reguły czasu:
    //       (A) Dzień wcześniej, okno 20:00–20:29  → "📌 Jutro: <nazwa>"
    //       (B) 2h przed startem, okno 120–149 min → "⏰ Za 2h: <nazwa>"
    //
    //     NAZWA WYDARZENIA trafia DO TYTUŁU powiadomienia (i do treści),
    //     żeby odbiorca od razu wiedział, o jakie wydarzenie chodzi.
    //
    //     Odbiorcy: wszyscy poza księżmi (księża nie mają kalendarza w apce).
    //     Push idzie JEDNYM zbiorczym wywołaniem OneSignal, plus wpis do
    //     dzwonka (Powiadomienia_zdarzenia) i do Powiadomienia_wyslane
    //     (żeby klient w sprawdzPowiadomienia() nie dublował dzwonka).
    // ============================================================
    try {
      var kalInf = ss.getSheetByName("Kalendarz");
      if (kalInf && kalInf.getLastRow() > 1) {
        var dkInf = kalInf.getDataRange().getValues();
        var kandInf = ss.getSheetByName("Kandydaci");
        var dkKInf = (kandInf && kandInf.getLastRow() > 1)
          ? kandInf.getDataRange().getValues()
          : [];

        // Lista odbiorców: wszyscy poza księżmi
        var idsInf = [];
        for (var iuInf = 1; iuInf < dkKInf.length; iuInf++) {
          var idInf = String(dkKInf[iuInf][0] || "").trim();
          if (!idInf) continue;
          var rInf = String(dkKInf[iuInf][6] || "").toLowerCase();
          if (rInf.indexOf("ksi") === 0) continue;
          idsInf.push(idInf);
        }

        for (var kiInf = 1; kiInf < dkInf.length; kiInf++) {
          if (!dkInf[kiInf][0]) continue;
          var dtInf = dkInf[kiInf][0] instanceof Date
            ? dkInf[kiInf][0]
            : new Date(dkInf[kiInf][0]);
          if (isNaN(dtInf.getTime())) continue;

          var nazwaInf = String(dkInf[kiInf][1] || "").trim();
          if (!nazwaInf) continue;

          var pktInf = parseInt(dkInf[kiInf][2], 10);
          if (isNaN(pktInf)) pktInf = 0;
          if (pktInf !== 0) continue;   // tylko wydarzenia BEZ PUNKTÓW

          var lowInf = nazwaInf.toLowerCase();
          if (lowInf.indexOf("msza") >= 0) continue;
          if (lowInf.indexOf("uroczyst") >= 0) continue;
          if (lowInf.indexOf("triduum") >= 0) continue;
          if (lowInf.indexOf("zbiórk") >= 0 || lowInf.indexOf("zbiork") >= 0) continue;
          if (lowInf.indexOf("wielka sobota") >= 0) continue;

          // Skrócona nazwa do tytułu push (OneSignal ucina bardzo długie tytuły)
          var nazwaSkrocInf = nazwaInf.length > 60
            ? (nazwaInf.substring(0, 57) + "…")
            : nazwaInf;

          var infTs = dtInf.getTime();
          var dataPlInf = Utilities.formatDate(dtInf, tz, "dd.MM.yyyy");
          var godzInf = Utilities.formatDate(dtInf, tz, "HH:mm");

          // --- (A) Dzień wcześniej o 20:00, okno 30 min ---
          var dpInf = new Date(infTs);
          dpInf.setDate(dpInf.getDate() - 1);
          dpInf.setHours(20, 0, 0, 0);
          var minInfW = (terazMs - dpInf.getTime()) / 60000;
          if (minInfW >= 0 && minInfW < 30) {
            var kluczInfW = "info_wieczor_" + infTs;
            if (!dedup[kluczInfW] && idsInf.length) {
              var tytInfW = "📌 Jutro: " + nazwaSkrocInf;
              var trInfW = "Wydarzenie " + dataPlInf + " o " + godzInf +
                           " — bez punktów. Sprawdź kalendarz.";
              try {
                var shZdInf = _arkuszZdarzenPowiadomien();
                var wInfW = idsInf.map(function(x) {
                  return [x, "push_" + kluczInfW + "_" + x, "dyzur", "📌",
                          tytInfW, trInfW, "page-calendar", teraz];
                });
                shZdInf.getRange(shZdInf.getLastRow() + 1, 1, wInfW.length, 8).setValues(wInfW);
              } catch (eZdInfW) {}
              try {
                var shWInf = ss.getSheetByName("Powiadomienia_wyslane");
                if (!shWInf) {
                  shWInf = ss.insertSheet("Powiadomienia_wyslane");
                  shWInf.appendRow(["UserID", "Klucz", "Data"]);
                }
                var wInfWW = idsInf.map(function(x) { return [x, kluczInfW, teraz]; });
                shWInf.getRange(shWInf.getLastRow() + 1, 1, wInfWW.length, 3).setValues(wInfWW);
              } catch (eWInfW) {}
              try {
                if (typeof wyslijPowiadomienieDoUserow === "function") {
                  wyslijPowiadomienieDoUserow(idsInf, tytInfW, trInfW);
                }
              } catch (ePInfW) {}
              dedup[kluczInfW] = terazMs;
              wyslane++;
            }
          }

          // --- (B) 2h przed startem, okno 30 min ---
          var diffInfMin = (infTs - terazMs) / 60000;
          if (diffInfMin >= 120 && diffInfMin < 150) {
            var kluczInf2h = "info_2h_" + infTs;
            if (!dedup[kluczInf2h] && idsInf.length) {
              var tytInf2 = "⏰ Za 2h: " + nazwaSkrocInf;
              var trInf2 = "Wydarzenie bez punktów — start o " + godzInf +
                           " (" + dataPlInf + ").";
              try {
                var shZdInf2 = _arkuszZdarzenPowiadomien();
                var wInf2 = idsInf.map(function(x) {
                  return [x, "push_" + kluczInf2h + "_" + x, "dyzur", "⏰",
                          tytInf2, trInf2, "page-calendar", teraz];
                });
                shZdInf2.getRange(shZdInf2.getLastRow() + 1, 1, wInf2.length, 8).setValues(wInf2);
              } catch (eZdInf2) {}
              try {
                var shWInf2 = ss.getSheetByName("Powiadomienia_wyslane");
                if (!shWInf2) {
                  shWInf2 = ss.insertSheet("Powiadomienia_wyslane");
                  shWInf2.appendRow(["UserID", "Klucz", "Data"]);
                }
                var wInf2W = idsInf.map(function(x) { return [x, kluczInf2h, teraz]; });
                shWInf2.getRange(shWInf2.getLastRow() + 1, 1, wInf2W.length, 3).setValues(wInf2W);
              } catch (eWInf2) {}
              try {
                if (typeof wyslijPowiadomienieDoUserow === "function") {
                  wyslijPowiadomienieDoUserow(idsInf, tytInf2, trInf2);
                }
              } catch (ePInf2) {}
              dedup[kluczInf2h] = terazMs;
              wyslane++;
            }
          }
        }
      }
    } catch (eBlokInf) {}

    props.setProperty("notif_dyzur_dedup", JSON.stringify(dedup));
    return { sukces: true, wyslane: wyslane };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/** Nazwa dnia tygodnia po polsku (biernik) — do treści push. */
function _nazwaDniaPL(dzien) {
  var dni = ["niedzielę", "poniedziałek", "wtorek", "środę", "czwartek", "piątek", "sobotę"];
  var d = parseInt(dzien, 10);
  return (d >= 0 && d <= 6) ? dni[d] : "";
}

function ustawMojaLokalizacje() {
  return ustawLokalizacjeCheckin(
    "2212", DANE_WRAŻLIWE, DANE_WRAŻLIWE,
    50
  );
}


// ======================================================================
// PATCHES vPERM-ANK — 2026-09-02 (punkty 2-20)
// ======================================================================
/**
 * PATCHES do Panelu Ministrantów – wklej / scal z istniejącym Code.gs
 * Zakres: punkty 2, 3, 4, 5, 9, 11, 12, 13, 14, 15–20 (backend)
 * Frontend: patrz FRONTEND_PATCHES.md
 */

// ----------------------------------------------------------------------
// STAŁE – rozszerzenie minusów
// ----------------------------------------------------------------------
// W istniejącym _PKT dodaj:
//   BRAK_ZBIORKI: -3,   // lub inna wartość ustalona przez admina
// Jeśli _PKT jest już zdefiniowane, użyj:
if (typeof _PKT !== "undefined") {
  _PKT.BRAK_ZBIORKI = _PKT.BRAK_ZBIORKI || -3;
}

// ----------------------------------------------------------------------
// 2 + 3: DYŻURY – Lektor tylko swój; filtr widoczności
// ----------------------------------------------------------------------

/**
 * Zastępuje / opakowuje dodajDyzurZFrontu.
 * Lektor (rola LEKTOR) może dodać tylko dyżur na swoje ID.
 * Admin/Ksiądz/Moderator – bez ograniczeń.
 */
function dodajDyzurZFrontuSecure(dataFormatowana, imieNazwisko, id, wykonawcaId) {
  try {
    var targetId = String(id || "").trim();
    var actorId = String(wykonawcaId || "").trim();
    if (!targetId) return { sukces: false, wiadomosc: "Brak ID." };

    var rola = pobierzRoleUzytkownika(actorId);
    var r = _normalizujRole(rola);
    var isAdmin = _czyAdminLubKsiadz(rola) || String(rola || "").toUpperCase().indexOf("ADMIN") === 0;

    if (!isAdmin) {
      // Lektor / ministrant – tylko własny dyżur
      if (actorId !== targetId) {
        return { sukces: false, wiadomosc: "Możesz dodawać tylko swój własny dyżur." };
      }
      // Lektor młodszy też może (punkt 2: Lektor = samodzielnie)
    }

    // Wywołaj istniejącą logikę (jeśli funkcja zwraca string – opakuj)
    var wynik = dodajDyzurZFrontu(dataFormatowana, imieNazwisko, targetId);
    if (typeof wynik === "string") {
      var ok = wynik.toLowerCase().indexOf("błąd") < 0 && wynik.toLowerCase().indexOf("blad") < 0;
      return { sukces: ok, wiadomosc: wynik };
    }
    return wynik;
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * Usuwanie dyżuru z kontrolą uprawnień.
 * wiersz – numer wiersza w arkuszu Dyżury
 * wykonawcaId – kto klika
 */
function usunDyzurSecure(wiersz, wykonawcaId) {
  try {
    var actorId = String(wykonawcaId || "").trim();
    var row = parseInt(wiersz, 10);
    if (!row || row < 2) return { sukces: false, wiadomosc: "Nieprawidłowy wiersz." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Dyżury");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza Dyżury." };

    var dane = sheet.getDataRange().getValues();
    if (row > dane.length) return { sukces: false, wiadomosc: "Wiersz nie istnieje." };

    // Zakładamy kolumny: [Data/Dzień, Godzina, ID, Imię, ...] – dopasuj indeks ID do swojej struktury
    // W kodzie _dyzurUseraWTygodniu używa kolumny 2 jako ID (indeks 2)
    var ownerId = String(dane[row - 1][2] || "").trim();

    var rola = pobierzRoleUzytkownika(actorId);
    var isAdmin = _czyAdminLubKsiadz(rola) || String(rola || "").toUpperCase().indexOf("ADMIN") === 0;

    if (!isAdmin) {
      if (actorId !== ownerId) {
        return { sukces: false, wiadomosc: "Możesz usuwać tylko swój własny dyżur." };
      }
      // Lektor młodszy — bez samodzielnego usuwania dyżuru
      var ranga = "";
      try {
        var sheetK = ss.getSheetByName("Kandydaci");
        if (sheetK) {
          var dk = sheetK.getDataRange().getValues();
          for (var ki = 1; ki < dk.length; ki++) {
            if (String(dk[ki][0] || "").trim() === actorId) {
              ranga = String(dk[ki][6] || "");
              break;
            }
          }
        }
      } catch (eR) {}
      var rl = ranga.toLowerCase();
      var lektorPelny = rl.indexOf("lektor") >= 0 && rl.indexOf("młod") < 0 && rl.indexOf("mlod") < 0;
      if (!lektorPelny) {
        return { sukces: false, wiadomosc: "Brak uprawnień do usuwania dyżuru (Lektor młodszy nie może)." };
      }
    }

    sheet.deleteRow(row);
    try { _invalidateCacheRfid(); } catch (eInv) {}
    return { sukces: true, wiadomosc: "Usunięto dyżur." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

/**
 * Lista dyżurów / wydarzeń kalendarza z filtrem roli.
 * isAdmin → wszystko; inaczej: własne dyżury + uroczystości + pozostałe wydarzenia (bez cudzych dyżurów).
 */
function getKalendarzDlaUzytkownika(userId) {
  try {
    var uid = String(userId || "").trim();
    var rola = pobierzRoleUzytkownika(uid);
    var isAdmin = _czyAdminLubKsiadz(rola) || String(rola || "").toUpperCase().indexOf("ADMIN") === 0;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKal = ss.getSheetByName("Kalendarz");
    var sheetDyz = ss.getSheetByName("Dyżury");
    var wydarzenia = [];
    var dyzury = [];

    if (sheetKal && sheetKal.getLastRow() > 1) {
      var dk = sheetKal.getDataRange().getValues();
      for (var i = 1; i < dk.length; i++) {
        if (!dk[i][0]) continue;
        wydarzenia.push({
          data: dk[i][0],
          nazwa: String(dk[i][1] || ""),
          punkty: parseInt(dk[i][2], 10) || 0,
          wiersz: i + 1
        });
      }
    }

    if (sheetDyz && sheetDyz.getLastRow() > 1) {
      var dd = sheetDyz.getDataRange().getValues();
      for (var j = 1; j < dd.length; j++) {
        var idD = String(dd[j][2] || "").trim();
        if (!isAdmin && idD !== uid) continue; // punkt 3
        dyzury.push({
          dzien: dd[j][0],
          godzina: dd[j][1],
          id: idD,
          imie: String(dd[j][3] || ""),
          wiersz: j + 1
        });
      }
    }

    return { sukces: true, wydarzenia: wydarzenia, dyzury: dyzury, isAdmin: isAdmin };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

// ----------------------------------------------------------------------
// 4: MASOWE PUNKTY – tylko ministranci (bez księży / lektorów)
// ----------------------------------------------------------------------

/**
 * Zwraca listę ID+imię tylko ministrantów (do checkboxów masowych).
 * Wyklucza: Ksiądz, Lektor*, ADMIN flag.
 */
function getListaMinistrantowDoMasowychPunktow(wykonawcaId) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (!_czyAdminLubKsiadz(rola) && String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, lista: [], wiadomosc: "Brak uprawnień." };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kandydaci");
    if (!sheet) return { sukces: true, lista: [] };
    var dane = sheet.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < dane.length; i++) {
      var id = String(dane[i][0] || "").trim();
      if (!id) continue;
      var imie = String(dane[i][1] || "").trim();
      var ranga = String(dane[i][6] || "").trim().toLowerCase();
      if (ranga.indexOf("ksi") >= 0) continue;
      if (ranga.indexOf("lektor") >= 0) continue;
      // opcjonalnie pomiń adminów z flagi – sprawdzamy Hasła
      var rUser = pobierzRoleUzytkownika(id);
      if (_normalizujRole(rUser) === "KSIADZ") continue;
      lista.push({ id: id, imie: imie });
    }
    lista.sort(function(a, b) { return a.imie.localeCompare(b.imie, "pl"); });
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: String(e.message || e) };
  }
}

// ----------------------------------------------------------------------
// 5: Skład LSO bez księży + Lektor starszy
// ----------------------------------------------------------------------
// W getStatystykiAdmin – przy budowaniu `sklad` pomiń "Ksiądz".
// Kategoria "Lektor starszy" już jest w normalizacji; upewnij się w _normalizujRangeLabel:

function _normalizujRangeLabelPatched(ranga) {
  var r = String(ranga || "").trim();
  if (!r) return "Brak rangi";
  var low = r.toLowerCase();
  if (low.indexOf("kandydat") >= 0) return "Kandydat";
  if (low.indexOf("ministrant") >= 0 && low.indexOf("młod") >= 0) return "Ministrant młodszy";
  if (low.indexOf("ministrant") >= 0 && low.indexOf("stars") >= 0) return "Ministrant starszy";
  if (low === "ministrant") return "Ministrant";
  if (low.indexOf("lektor") >= 0 && low.indexOf("młod") >= 0) return "Lektor młodszy";
  if (low.indexOf("lektor") >= 0 && low.indexOf("stars") >= 0) return "Lektor starszy";
  if (low.indexOf("lektor") >= 0) return "Lektor";
  if (low.indexOf("ksi") >= 0) return "Ksiądz"; // nadal w bazie, ale nie na pie chart
  return r;
}

// W _renderStatystyki / getStatystykiAdmin: nie dodawaj sklad["Ksiądz"] do pie;
// albo filtruj: if (k === "Ksiądz") return;

// ----------------------------------------------------------------------
// 9b: Historia PRZYDZIAŁÓW dyżuru konkretnej osoby (zmiany dnia/godziny)
// Arkusz Dyżury: Data i Godzina | Imię i Nazwisko | ID | Obowiązuje od | Obowiązuje do
// Zwraca kolejne okresy, np.:
//   Poniedziałek 18:00 — obowiązywał od 01.10.2025 do 14.12.2025
//   Środa 18:00        — obowiązuje od 15.12.2025 (nadal)
// ----------------------------------------------------------------------

function getHistoriaPrzydzialowDyzuru(wykonawcaId, celId) {
  try {
    var actor = String(wykonawcaId || "").trim();
    var rola = pobierzRoleUzytkownika(actor);
    if (!_czyAdminLubKsiadz(rola) && String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var uid = String(celId || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Wybierz osobę." };

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Dyżury");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, lista: [] };

    var tz = _APP_TZ;
    var dane = sheet.getDataRange().getValues();
    var nazwyDni = ["Niedziela", "Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota"];
    var lista = [];

    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][2] || "").trim() !== uid) continue;
      if (!dane[i][0]) continue;
      var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
      if (isNaN(dt.getTime())) continue;

      var odRaw = dane[i][3], doRaw = dane[i][4];
      var odStr = "", doStr = "", odSort = dt.getTime();
      if (odRaw) {
        var odD = odRaw instanceof Date ? odRaw : new Date(odRaw);
        if (!isNaN(odD.getTime())) { odStr = Utilities.formatDate(odD, tz, "dd.MM.yyyy"); odSort = odD.getTime(); }
      }
      if (doRaw) {
        var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
        if (!isNaN(doD.getTime())) doStr = Utilities.formatDate(doD, tz, "dd.MM.yyyy");
      }

      lista.push({
        dzien: nazwyDni[dt.getDay()],
        godzina: _fixGodzina(dt),
        obowiazujeOd: odStr || "— (brak danych)",
        obowiazujeDo: doStr || "nadal",
        aktywny: !doStr || (function() {
          try {
            if (!doRaw) return true;
            var dd = doRaw instanceof Date ? doRaw : new Date(doRaw);
            if (isNaN(dd.getTime())) {
              var sx = String(doRaw).trim().substring(0, 10);
              return sx >= Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
            }
            return Utilities.formatDate(dd, tz, "yyyy-MM-dd") >= Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
          } catch (eA) { return !doStr; }
        })(),
        _sort: odSort
      });
    }

    lista.sort(function(a, b) { return a._sort - b._sort; });
    lista.forEach(function(x) { delete x._sort; });

    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

// ----------------------------------------------------------------------
// 9: Historia dyżurów konkretnej osoby
// ----------------------------------------------------------------------

function getHistoriaDyzurowOsoby(wykonawcaId, celId, odIso, doIso) {
  try {
    var actor = String(wykonawcaId || "").trim();
    var rola = pobierzRoleUzytkownika(actor);
    if (!_czyAdminLubKsiadz(rola) && String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var uid = String(celId || "").trim();
    if (!uid) return { sukces: false, wiadomosc: "Wybierz osobę." };

    var zakres = _parseZakresStat(odIso, doIso);
    var od = zakres.od;
    var do_ = zakres.do_;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = _APP_TZ;
    var nazwyDni = ["Niedziela", "Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota"];
    var lista = [];

    // --- Przydziały (harmonogram: dzień tygodnia + godzina, okres obowiązywania) ---
    var przydzialy = [];
    var sheetD = ss.getSheetByName("Dyżury");
    if (sheetD && sheetD.getLastRow() > 1) {
      var dd = sheetD.getDataRange().getValues();
      for (var i = 1; i < dd.length; i++) {
        if (String(dd[i][2] || "").trim() !== uid) continue;
        if (!dd[i][0]) continue;
        var dt = dd[i][0] instanceof Date ? dd[i][0] : new Date(dd[i][0]);
        if (isNaN(dt.getTime())) continue;

        var odRaw = dd[i][3], doRaw = dd[i][4];
        var odStr = "", doStr = "", odKey = "", doKey = "", odSort = dt.getTime();
        if (odRaw) {
          var odD = odRaw instanceof Date ? odRaw : new Date(odRaw);
          if (!isNaN(odD.getTime())) {
            odStr = Utilities.formatDate(odD, tz, "dd.MM.yyyy");
            odKey = Utilities.formatDate(odD, tz, "yyyy-MM-dd");
            odSort = odD.getTime();
          }
        }
        if (doRaw) {
          var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
          if (!isNaN(doD.getTime())) {
            doStr = Utilities.formatDate(doD, tz, "dd.MM.yyyy");
            doKey = Utilities.formatDate(doD, tz, "yyyy-MM-dd");
          }
        }
        // UWAGA: wiersz, w którym "Obowiązuje do" < "Obowiązuje od", to
        // NIE błąd — tak wygląda dyżur, który został utworzony i zamknięty
        // w tym samym dniu (admin akceptował zmianę jeszcze przed
        // rozpoczęciem obowiązywania). Taki wiersz MUSI zostać w historii.
        // Historia pokazuje wszystkie wpisy dyżurów tej osoby — może ich
        // być więcej niż jeden równolegle (np. wtorek 18:00 + środa 18:00).
        var aktywny = !doKey || (doKey >= Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
        przydzialy.push({
          dzien: nazwyDni[dt.getDay()],
          dayIdx: dt.getDay(),
          godzina: _fixGodzina(dt),
          obowiazujeOd: odStr || "— (brak danych)",
          obowiazujeDo: doStr || "nadal",
          odKey: odKey,
          doKey: doKey,
          aktywny: aktywny,
          _sort: odSort
        });
      }
      przydzialy.sort(function(a, b) { return a._sort - b._sort; });
      przydzialy.forEach(function(x) { delete x._sort; });
    }

    function _przydzialNaDate(dataObj) {
      if (!przydzialy.length) return null;
      var key = Utilities.formatDate(dataObj, tz, "yyyy-MM-dd");
      var trafione = [];
      for (var p = 0; p < przydzialy.length; p++) {
        var pr = przydzialy[p];
        var okOd = !pr.odKey || key >= pr.odKey;
        var okDo = !pr.doKey || key <= pr.doKey;
        // Dopasuj też dzień tygodnia — inaczej sobota dostawała
        // "przydział" z wtorku (bo zakres dat to obejmował).
        var okDow = (pr.dayIdx === dataObj.getDay());
        if (okOd && okDo && okDow) trafione.push(pr);
      }
      if (!trafione.length) return null;
      // najpóźniejszy "obowiązuje od"
      trafione.sort(function(a, b) { return String(a.odKey || "").localeCompare(String(b.odKey || "")); });
      return trafione[trafione.length - 1];
    }

    // --- Obecności (logi z „dyżur”) ---
    function skan(rows, colData, colId, colNazwa, colExtra) {
      for (var r = 1; r < rows.length; r++) {
        if (String(rows[r][colId] || "").trim() !== uid) continue;
        var d = rows[r][colData] instanceof Date ? rows[r][colData] : new Date(rows[r][colData]);
        if (isNaN(d.getTime()) || !_dataWZakresie(d, od, do_)) continue;
        var n = String(rows[r][colNazwa] || "");
        var low = n.toLowerCase();
        if (low.indexOf("dyżur") < 0 && low.indexOf("dyzur") < 0) continue;
        var pr = _przydzialNaDate(d);
        lista.push({
          data: Utilities.formatDate(d, tz, "dd.MM.yyyy"),
          dzien: nazwyDni[d.getDay()],
          godzina: _fixGodzina(d),
          rodzaj: n,
          punkty: colExtra != null ? (parseInt(rows[r][colExtra], 10) || 0) : null,
          przydzialDzien: pr ? pr.dzien : "",
          przydzialGodzina: pr ? pr.godzina : "",
          przydzialOpis: pr
            ? (pr.dzien + " " + pr.godzina + (pr.aktywny && (!pr.doKey || pr.doKey >= Utilities.formatDate(d, tz, "yyyy-MM-dd")) ? "" : ""))
            : "— (brak przydziału w tym dniu)"
        });
      }
    }

    var logi = ss.getSheetByName("Logi_czytnik");
    if (logi && logi.getLastRow() > 1) skan(logi.getDataRange().getValues(), 0, 1, 4, 5);
    var reczne = ss.getSheetByName("Logi_ręczne");
    if (reczne && reczne.getLastRow() > 1) skan(reczne.getDataRange().getValues(), 0, 1, 2, 3);

    lista.sort(function(a, b) {
      return a.data.split(".").reverse().join("").localeCompare(b.data.split(".").reverse().join(""));
    });

    return {
      sukces: true,
      lista: lista,
      przydzialy: przydzialy,
      od: Utilities.formatDate(od, tz, "yyyy-MM-dd"),
      do: Utilities.formatDate(do_, tz, "yyyy-MM-dd")
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}


/**
 * Dane do PDF: tabela dyżurów + ranking punktów.
 */
function getDaneDoPdfStatystyk(wykonawcaId, odIso, doIso) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (!_czyAdminLubKsiadz(rola) && String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = _APP_TZ;

    // Stałe dyżury (wzorzec tygodniowy) — jak DYŻURY.docx
    var dyzuryTabela = [];
    var dyzuryLektorzy = [];
    var sheetD = ss.getSheetByName("Dyżury");
    if (sheetD && sheetD.getLastRow() > 1) {
      var dd = sheetD.getDataRange().getValues();
      var tzPdf = _APP_TZ;
      var idToRanga = {};
      try {
        var sheetK2 = ss.getSheetByName("Kandydaci");
        if (sheetK2) {
          var dk2 = sheetK2.getDataRange().getValues();
          for (var ki = 1; ki < dk2.length; ki++) {
            idToRanga[String(dk2[ki][0] || "").trim()] = String(dk2[ki][6] || "");
          }
        }
      } catch (eR) {}
      for (var i = 1; i < dd.length; i++) {
        // Schema: Data i Godzina | Imię i Nazwisko | ID | Obowiązuje od | Obowiązuje do
        // Pomijamy zamknięte (historyczne) okresy — w tabeli "aktualny harmonogram"
        // ma się liczyć tylko dyżur, który wciąż obowiązuje.
        var doOkresu = dd[i][4];
        if (doOkresu) {
          var doOkresuD = doOkresu instanceof Date ? doOkresu : new Date(doOkresu);
          if (!isNaN(doOkresuD.getTime()) && Utilities.formatDate(doOkresuD, tzPdf, "yyyy-MM-dd") < Utilities.formatDate(new Date(), tzPdf, "yyyy-MM-dd")) {
            continue;
          }
        }
        var dt = dd[i][0] instanceof Date ? dd[i][0] : new Date(dd[i][0]);
        var dzien = "";
        var godzina = "";
        var dayIdx = -1;
        if (!isNaN(dt.getTime())) {
          dayIdx = dt.getDay(); // 0=Nd
          var nazwy = ["Niedziela","Poniedziałek","Wtorek","Środa","Czwartek","Piątek","Sobota"];
          dzien = nazwy[dayIdx];
          godzina = _fixGodzina(dt);
        } else {
          dzien = String(dd[i][0] || "");
        }
        var idD = String(dd[i][2] || "").trim();
        var imieD = String(dd[i][1] || "").trim();
        var rec = { dzien: dzien, godzina: godzina, id: idD, imie: imieD, dayIdx: dayIdx };
        if (dayIdx === 0) {
          dyzuryLektorzy.push(rec);
        }
        dyzuryTabela.push(rec);
      }
    }

    // Ranking punktów z Kandydaci — jeśli podano odIso/doIso, liczymy punkty
    // zdobyte TYLKO w tym okresie (z logów); bez zakresu -> suma "od zawsze".
    var ranking = [];
    var uzyjZakresuR = !!(String(odIso || "").trim() || String(doIso || "").trim());
    var zakresR = uzyjZakresuR ? _parseZakresStat(odIso, doIso) : null;
    var sheetK = ss.getSheetByName("Kandydaci");
    if (sheetK && sheetK.getLastRow() > 1) {
      var dk = sheetK.getDataRange().getValues();
      for (var k = 1; k < dk.length; k++) {
        var idK = String(dk[k][0] || "").trim();
        if (!idK) continue;
        var ranga = String(dk[k][6] || "");
        if (ranga.toLowerCase().indexOf("ksi") >= 0) continue;
        var punktyK = zakresR
          ? _sumaPunktowWZakresie(ss, idK, zakresR.od, zakresR.do_)
          : (parseInt(dk[k][2], 10) || 0);
        ranking.push({
          id: idK,
          imie: String(dk[k][1] || ""),
          punkty: punktyK,
          ranga: ranga
        });
      }
      ranking.sort(function(a, b) { return b.punkty - a.punkty; });
    }

    return {
      sukces: true,
      dyzury: dyzuryTabela,
      dyzuryLektorzy: dyzuryLektorzy,
      ranking: ranking,
      zakresRankingu: zakresR ? {
        od: Utilities.formatDate(zakresR.od, tz, "dd.MM.yyyy"),
        do: Utilities.formatDate(zakresR.do_, tz, "dd.MM.yyyy")
      } : null,
      wygenerowano: Utilities.formatDate(new Date(), tz, "dd.MM.yyyy HH:mm")
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}


// ----------------------------------------------------------------------
// PDF (serwer) — tabela dyżurów / ranking — bez CDN w przeglądarce
// ----------------------------------------------------------------------

function _pdfEsc(s) {
  return String(s == null ? "" : s);
}

function _pdfMapDzienSerwer(s) {
  var t = String(s || "").toLowerCase();
  if (t.indexOf("poniedzia") >= 0) return "Poniedziałek";
  if (t.indexOf("wtor") >= 0) return "Wtorek";
  if (t.indexOf("środ") >= 0 || t.indexOf("srod") >= 0) return "Środa";
  if (t.indexOf("czwart") >= 0) return "Czwartek";
  if (t.indexOf("piąt") >= 0 || t.indexOf("piat") >= 0) return "Piątek";
  if (t.indexOf("sobot") >= 0) return "Sobota";
  if (t.indexOf("niedziel") >= 0) return "Niedziela";
  return null;
}

function _pdfNormGodzSerwer(g) {
  var s = String(g || "").trim();
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  var h = parseInt(m[1], 10);
  return (h < 10 ? "0" : "") + h + ":" + m[2];
}

function _pdfCzyLektorSerwer(ss, id, imie) {
  try {
    var sheetK = ss.getSheetByName("Kandydaci");
    if (!sheetK) return false;
    var dk = sheetK.getDataRange().getValues();
    for (var i = 1; i < dk.length; i++) {
      if (String(dk[i][0] || "").trim() === String(id || "").trim() ||
          String(dk[i][1] || "").trim() === String(imie || "").trim()) {
        return String(dk[i][6] || "").toLowerCase().indexOf("lektor") >= 0;
      }
    }
  } catch (e) {}
  return false;
}

/** Buduje Google Doc → PDF → base64, usuwa tymczasowy plik. */
function _docNaPdfBase64(doc, nazwaPliku) {
  doc.saveAndClose();
  var id = doc.getId();
  var file = DriveApp.getFileById(id);
  var pdfBlob = file.getAs(MimeType.PDF);
  try { file.setTrashed(true); } catch (eT) {}
  return {
    sukces: true,
    nazwa: nazwaPliku || "dokument.pdf",
    base64: Utilities.base64Encode(pdfBlob.getBytes()),
    mime: "application/pdf"
  };
}

/**
 * PDF tabeli dyżurów tygodniowych (bez lektorów).
 * Zwraca { sukces, nazwa, base64 } albo { sukces:false, wiadomosc }.
 */
function generujPdfDyzurowSerwer(wykonawcaId, odIso, doIso) {
  try {
    var dane = getDaneDoPdfStatystyk(wykonawcaId, odIso, doIso);
    if (!dane || !dane.sukces) {
      return { sukces: false, wiadomosc: (dane && dane.wiadomosc) || "Brak danych." };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var dni = ["Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota"];
    var godziny = ["07:00", "08:00", "18:00"];
    var grid = {};
    dni.forEach(function(d) {
      grid[d] = { "07:00": [], "08:00": [], "18:00": [] };
    });
    (dane.dyzury || []).forEach(function(d) {
      var dz = _pdfMapDzienSerwer(d.dzien);
      var g = _pdfNormGodzSerwer(d.godzina);
      var imie = String(d.imie || "").trim();
      if (!imie || !g || !dz || !grid[dz] || !grid[dz][g]) return;
      if (_pdfCzyLektorSerwer(ss, d.id, imie)) return;
      if (dz === "Niedziela") return;
      if (grid[dz][g].indexOf(imie) < 0) grid[dz][g].push(imie);
    });

    var doc = DocumentApp.create("_tmp_pdf_dyzury_" + new Date().getTime());
    var body = doc.getBody();
    body.appendParagraph("Dyżury w tygodniu").setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph("Wygenerowano: " + String(dane.wygenerowano || "")).setFontSize(9);

    var header = ["Godz.", "Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota"];
    var tableData = [header];
    ["7:00", "8:00", "18:00"].forEach(function(label, gi) {
      var g = godziny[gi];
      var row = [label];
      dni.forEach(function(dz) {
        row.push((grid[dz][g] || []).join(", "));
      });
      tableData.push(row);
    });
    var table = body.appendTable(tableData);
    table.setBorderWidth(0.5);
    try {
      for (var c = 0; c < 7; c++) {
        table.getRow(0).getCell(c).getChild(0).asParagraph().setBold(true);
      }
    } catch (eH) {}

    return _docNaPdfBase64(doc, "Dyzury-LSO.pdf");
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

/**
 * PDF rankingu punktów ministrantów.
 */
function generujPdfRankinguSerwer(wykonawcaId, odIso, doIso) {
  try {
    var dane = getDaneDoPdfStatystyk(wykonawcaId, odIso, doIso);
    if (!dane || !dane.sukces) {
      return { sukces: false, wiadomosc: (dane && dane.wiadomosc) || "Brak danych." };
    }

    var doc = DocumentApp.create("_tmp_pdf_ranking_" + new Date().getTime());
    var body = doc.getBody();
    body.appendParagraph("Ranking punktów (ministranci)").setHeading(DocumentApp.ParagraphHeading.HEADING1);
    var meta = "Wygenerowano: " + String(dane.wygenerowano || "");
    if (dane.zakresRankingu) {
      meta += "  |  Okres: " + (dane.zakresRankingu.od || "") + " – " + (dane.zakresRankingu.do || "");
    }
    body.appendParagraph(meta).setFontSize(9);

    var tableData = [["#", "Imię", "Punkty", "Ranga"]];
    (dane.ranking || []).forEach(function(r, i) {
      tableData.push([
        String(i + 1),
        _pdfEsc(r.imie),
        String(r.punkty != null ? r.punkty : 0),
        _pdfEsc(r.ranga)
      ]);
    });
    if (tableData.length === 1) tableData.push(["—", "Brak danych", "", ""]);
    var table = body.appendTable(tableData);
    table.setBorderWidth(0.5);
    try {
      for (var c = 0; c < 4; c++) {
        table.getRow(0).getCell(c).getChild(0).asParagraph().setBold(true);
      }
    } catch (eH) {}

    return _docNaPdfBase64(doc, "Ranking-LSO.pdf");
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}


// ----------------------------------------------------------------------
// 11: Powiadomienia o ogłoszeniach, ankietach, wnioskach/ticketach
// ----------------------------------------------------------------------

/**
 * Wywołaj po dodaniu ogłoszenia (w dodajPost gdy typ=ogloszenie).
 */
/**
 * Centralna funkcja: NATYCHMIASTOWY push OneSignal + zapis do dzwonka
 * (Powiadomienia_zdarzenia) + wpis klucza do Powiadomienia_wyslane
 * (żeby klient nie dublował dzwonka przy następnym pollu).
 *
 * Używane przy każdym zdarzeniu, które ma dotrzeć nawet gdy apka jest
 * zamknięta: punkty, ogłoszenia, przypomnienia o zbiórkach, dostępność.
 *
 * @param {string} uid           odbiorca
 * @param {string} ikona         emoji (📈, 📉, 📢, 👥, 📅, ⛪…)
 * @param {string} tytul         tytuł powiadomienia
 * @param {string} tresc         treść
 * @param {string} typ           typ zdarzenia (points / ogloszenia / dyzur / dostepnosc)
 * @param {string} targetPage    np. "page-profile", "page-ogloszenia", "page-calendar"
 * @param {string} kluczKlienta  klucz dedup (taki sam jak generuje frontend)
 */
function _pushNatychmiast(uid, ikona, tytul, tresc, typ, targetPage, kluczKlienta) {
  try {
    var id = String(uid || "").trim();
    if (!id) return;
    var ik = String(ikona || "🔔");
    var tyt = String(tytul || "Powiadomienie");
    var tr = String(tresc || "");
    var tp = String(targetPage || "page-ustawienia");

    // 1) Push OneSignal — natychmiast (dokładnie jeden raz).
    try {
      if (typeof wyslijPowiadomienieDoUserow === "function") {
        wyslijPowiadomienieDoUserow(id, ik + " " + tyt, tr);
      }
    } catch (eP) {}

    // 2) Dzwonek in-app: zapisujemy zdarzenie do arkusza Powiadomienia_zdarzenia.
    //    Klient odbierze je przy najbliższym pollingu (15 s) i doda do
    //    lokalnego dzwonka. Używamy DOKŁADNIE tego samego klucza co
    //    kluczKlienta (bez prefiksu "push_"), żeby filtrujNowePowiadomienia
    //    mógł poprawnie oznaczyć je jako wyświetlone przy pierwszym odbiorze
    //    po stronie klienta — i żeby kolejne polle tego samego zdarzenia
    //    nie zwracały jako nowe.
    try {
      if (typeof _zapiszZdarzeniePowiadomienia === "function") {
        var kluczZdarzenia = kluczKlienta
          ? String(kluczKlienta)
          : ("push_" + typ + "_" + Date.now() + "_" + id);
        _zapiszZdarzeniePowiadomienia(id, kluczZdarzenia, typ || "info", ik, tyt, tr, tp);
      }
    } catch (eD) {}

    // 3) CELOWO NIE wpisujemy klucza do Powiadomienia_wyslane tutaj.
    //    Robi to dopiero filtrujNowePowiadomienia, gdy klient realnie
    //    odbierze zdarzenie i pokaże je w dzwonku. Dzięki temu:
    //      • push idzie DOKŁADNIE raz (z tego miejsca),
    //      • dzwonek pojawia się DOKŁADNIE raz (z pollingu klienta),
    //      • nie ma duplikatów ani "duchów" w Powiadomienia_wyslane.
  } catch (eAll) {}
}

function _powiadomWszystkichONowym(tytul, opis, stronaDocelowa, typIkona) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kandydaci");
    if (!sheet) return;
    var dane = sheet.getDataRange().getValues();
    var ids = [];
    for (var i = 1; i < dane.length; i++) {
      var id = String(dane[i][0] || "").trim();
      if (!id) continue;
      // Ksiądz: bez masowych pushy (ogłoszenia/ankiety) — tylko @wzmianki
      var ranga = String(dane[i][6] || "").toLowerCase();
      if (ranga.indexOf("ksi") >= 0) continue;
      try {
        var rolaU = String(pobierzRoleUzytkownika(id) || "").toUpperCase();
        if (rolaU === "KSIADZ" || rolaU.indexOf("KSIA") === 0) continue;
      } catch (eR) {}
      ids.push(id);
    }
    if (!ids.length) return;
    var znacznikCzasu = Date.now();
    // Wpis do "dzwonka" w aplikacji dla każdego użytkownika osobno
    ids.forEach(function(uid) {
      try {
        _zapiszZdarzeniePowiadomienia(uid, typIkona + "_" + znacznikCzasu + "_" + uid, typIkona, "📢", tytul, opis, stronaDocelowa || "page-ogloszenia");
      } catch (e1) {}
    });
    // Push OneSignal — JEDNO zbiorcze wywołanie do wszystkich ID naraz
    // (zamiast osobnego zapytania HTTP na użytkownika, co przy większej
    // liczbie osób mogło przekraczać limity/czas i po cichu się wyciszać)
    if (typeof wyslijPowiadomienieDoUserow === "function") {
      try {
        wyslijPowiadomienieDoUserow(ids, tytul, opis);
      } catch (e2) {}
    }
  } catch (e) {}
}

/**
 * Po złożeniu dowolnego wniosku / ticketu – powiadom administratorów.
 * Admin = arkusz Hasła (lub Hasla), kolumna F = TAK (getListaAdminow / _czyFlagaAdmin).
 * excludeUserId – opcjonalnie pominąć składającego (gdy sam jest adminem).
 */

/**
 * Kolejka powiadomień adminów — zapis wniosku wraca od razu do apki,
 * a dzwonek/push idzie w tle (trigger co 1 min albo przy kolejnym wywołaniu).
 */
function _kolejkujPowiadomienieAdminow(tytul, opis, strona, excludeUserId) {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty("admin_notif_queue") || "[]";
    var q;
    try { q = JSON.parse(raw); } catch (eJ) { q = []; }
    if (!Array.isArray(q)) q = [];
    q.push({
      t: String(tytul || "Nowy wniosek"),
      o: String(opis || "Do rozpatrzenia"),
      s: String(strona || "page-wnioski"),
      e: String(excludeUserId || "").trim(),
      ts: Date.now()
    });
    if (q.length > 40) q = q.slice(-40);
    props.setProperty("admin_notif_queue", JSON.stringify(q));
    _ensureTriggerKolejkiAdmin();
  } catch (e) {
    // Awaryjnie synchronicznie (lepiej późno niż wcale)
    try { _powiadomAdminowONowymDoPrzegladu(tytul, opis, strona, excludeUserId); } catch (e2) {}
  }
}

function _ensureTriggerKolejkiAdmin() {
  try {
    var handlers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < handlers.length; i++) {
      if (handlers[i].getHandlerFunction() === "przetworzKolejkePowiadomienAdmin") return;
    }
    ScriptApp.newTrigger("przetworzKolejkePowiadomienAdmin")
      .timeBased()
      .everyMinutes(1)
      .create();
  } catch (e) {}
}

/** Trigger / ręczne: opróżnia kolejkę powiadomień dla adminów. */
function przetworzKolejkePowiadomienAdmin() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty("admin_notif_queue") || "[]";
  var q;
  try { q = JSON.parse(raw); } catch (eJ) { q = []; }
  props.setProperty("admin_notif_queue", "[]");
  if (!Array.isArray(q) || !q.length) return;
  for (var i = 0; i < q.length; i++) {
    try {
      _powiadomAdminowONowymDoPrzegladu(q[i].t, q[i].o, q[i].s, q[i].e);
    } catch (e1) {}
  }
}

function _powiadomAdminowONowymDoPrzegladu(tytul, opis, strona, excludeUserId) {
  try {
    var resAdm = (typeof getListaAdminow === "function") ? getListaAdminow() : { admini: [] };
    var admini = (resAdm && resAdm.admini) ? resAdm.admini : [];
    var excl = String(excludeUserId || "").trim();
    var ids = [];
    var znacznik = Date.now();
    var tyt = String(tytul || "Nowy wniosek");
    var op = String(opis || "Do rozpatrzenia");
    var cel = String(strona || "page-wnioski");
    var teraz = new Date();

    admini.forEach(function(a) {
      if (!a || !a.id) return;
      var aid = String(a.id).trim();
      if (!aid || (excl && aid === excl)) return;
      if (ids.indexOf(aid) >= 0) return;
      ids.push(aid);
    });
    if (!ids.length) return;

    // Jedna seria zapisów do arkusza (zamiast appendRow w pętli = wolniej)
    try {
      var sheet = _arkuszZdarzenPowiadomien();
      var rows = ids.map(function(aid) {
        return [
          aid,
          "admin_review_" + znacznik + "_" + aid,
          "admin",
          "🔔",
          tyt,
          op,
          cel,
          teraz
        ];
      });
      if (rows.length) {
        // POPRAWKA: liczba wierszy = rows.length, NIE sheet.getLastRow() + rows.length
        // (stara wersja próbowała zapisać więcej wierszy niż danych → wyjątek
        //  i cichy fallback do zapisu po jednym wierszu).
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
      }
    } catch (eSheet) {
      // fallback pojedynczo
      ids.forEach(function(aid) {
        try {
          _zapiszZdarzeniePowiadomienia(aid, "admin_review_" + znacznik + "_" + aid, "admin", "🔔", tyt, op, cel);
        } catch (e1) {}
      });
    }

    // Push OneSignal — jedno wywołanie; błędy/timeout nie mogą rozwalać wniosku
    if (typeof wyslijPowiadomienieDoUserow === "function") {
      try {
        wyslijPowiadomienieDoUserow(ids, tyt, op);
      } catch (e2) {}
    }
  } catch (e) {}
}

// ----------------------------------------------------------------------
// 12: Atomowe przejmowanie ticketu
// ----------------------------------------------------------------------

/**
 * Zastąp ciało przejmijTicket tą wersją (lub wywołuj z frontu przejmijTicketAtomic).
 */
function przejmijTicketAtomic(userId, imie, ticketId) {
  try {
    var uid = String(userId || "").trim();
    var tid = String(ticketId || "").trim();
    if (!uid || !tid) return { sukces: false, wiadomosc: "Brak danych." };

    var rola = pobierzRoleUzytkownika(uid);
    if (String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Tylko administrator może przejąć ticket." };
    }

    var sheetT = _arkuszTickety();
    // ATOMIC: LockService
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (eLock) {
      return { sukces: false, wiadomosc: "Serwer zajęty – spróbuj ponownie za chwilę." };
    }

    try {
      var dataT = sheetT.getDataRange().getValues();
      var ticketRow = -1;
      var ticketUserId = "";
      var ticketTemat = "";
      var assignedId = "";
      var status = "";

      for (var i = 1; i < dataT.length; i++) {
        if (String(dataT[i][0] || "").trim() === tid) {
          ticketRow = i + 1;
          ticketUserId = String(dataT[i][1] || "").trim();
          ticketTemat = String(dataT[i][3] || "").trim();
          assignedId = String(dataT[i][6] || "").trim();
          status = String(dataT[i][4] || "").trim();
          break;
        }
      }
      if (ticketRow < 0) return { sukces: false, wiadomosc: "Nie znaleziono ticketu." };
      if (assignedId) {
        var kto = String(dataT[ticketRow - 1][7] || assignedId).trim();
        return {
          sukces: false,
          juzPrzejety: true,
          wiadomosc: "Ticket został właśnie przejęty przez innego administratora" + (kto ? (" (" + kto + ")") : "") + "."
        };
      }
      if (status.toLowerCase().indexOf("zamkn") >= 0) {
        return { sukces: false, wiadomosc: "Nie można przejąć zamkniętego ticketu." };
      }

      var adminImie = String(imie || "").trim() || uid;
      sheetT.getRange(ticketRow, 7).setValue(uid);
      sheetT.getRange(ticketRow, 8).setValue(adminImie);
      sheetT.getRange(ticketRow, 9).setValue(new Date());

      _arkuszTicketyWiadomosci().appendRow([
        tid, uid, adminImie, true,
        "Administrator " + adminImie + " przejął ten ticket.",
        new Date()
      ]);

      if (ticketUserId && ticketUserId !== uid) {
        var tyt = "Administrator zajął się Twoim ticketem";
        var op = adminImie + " przejął sprawę: " + ticketTemat;
        _zapiszZdarzeniePowiadomienia(ticketUserId, "ticket_claim_" + tid, "ticket", "🙋", tyt, op, "page-kontakt");
        if (typeof wyslijPowiadomienieDoUserow === "function") {
          wyslijPowiadomienieDoUserow(ticketUserId, tyt, op);
        }
      }

      return { sukces: true, wiadomosc: "Przejęto ticket." };
    } finally {
      try { lock.releaseLock(); } catch (eR) {}
    }
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

// ----------------------------------------------------------------------
// 13: Przejmowanie wniosków (status Nowy + przypisanie)
// ----------------------------------------------------------------------

/**
 * Wymaga kolumn w arkuszu wniosków (np. Wnioski / Nieobecnosci_dyzur):
 *  Status | PrzypisanyAdminId | PrzypisanyAdminImie
 * Dostosuj indeksy kolumn do swojej struktury.
 */
function przejmijWniosekAtomic(userId, imie, arkuszNazwa, wiersz) {
  try {
    var uid = String(userId || "").trim();
    var row = parseInt(wiersz, 10);
    if (!uid || !row) return { sukces: false, wiadomosc: "Brak danych." };

    var rola = pobierzRoleUzytkownika(uid);
    if (String(rola || "").toUpperCase().indexOf("ADMIN") !== 0 && !_czyAdminLubKsiadz(rola)) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }

    var lock = LockService.getScriptLock();
    try { lock.waitLock(10000); } catch (eL) {
      return { sukces: false, wiadomosc: "Serwer zajęty – spróbuj ponownie." };
    }

    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName(arkuszNazwa || "Nieobecnosci_dyzur");
      if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza." };

      // Przykład: kolumna 7 = Status, 8 = AdminId, 9 = AdminImie – DOPASUJ!
      var status = String(sheet.getRange(row, 7).getValue() || "").trim();
      var assigned = String(sheet.getRange(row, 8).getValue() || "").trim();

      if (assigned) {
        var kto = String(sheet.getRange(row, 9).getValue() || assigned).trim();
        return {
          sukces: false,
          juzPrzejety: true,
          wiadomosc: "Wniosek został już przejęty" + (kto ? (" przez " + kto) : "") + "."
        };
      }

      var adminImie = String(imie || "").trim() || uid;
      if (!status || status.toLowerCase() === "nowy" || status === "") {
        sheet.getRange(row, 7).setValue("W trakcie");
      }
      sheet.getRange(row, 8).setValue(uid);
      sheet.getRange(row, 9).setValue(adminImie);

      return { sukces: true, wiadomosc: "Przejęto wniosek." };
    } finally {
      try { lock.releaseLock(); } catch (eR) {}
    }
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

// ----------------------------------------------------------------------
// 14: Typ nieobecności (Zbiórka / Msza) przy wniosku
// ----------------------------------------------------------------------

/**
 * Rozszerzenie zlozWniosekNieobecnosciDyzur – dodaj parametr typNieobecnosci.
 * Zapisuj w nowej kolumnie arkusza Nieobecnosci_dyzur.
 */
function zlozWniosekNieobecnosciZTypem(userId, imie, dataDyzuru, powod, dataPowrotu, typNieobecnosci) {
  var typ = String(typNieobecnosci || "").trim();
  if (typ !== "Zbiorka" && typ !== "Zbiórka" && typ !== "Msza") {
    return { sukces: false, wiadomosc: "Wybierz typ nieobecności: Zbiórka lub Msza." };
  }
  // Wywołaj istniejącą funkcję, potem dopisz typ do wiersza
  var res = zlozWniosekNieobecnosciDyzur(userId, imie, dataDyzuru, powod, dataPowrotu);
  if (res && res.sukces) {
    try {
      var sheet = _arkuszNieobecnosciDyzur();
      var last = sheet.getLastRow();
      // kolumna na typ – np. 10; utwórz nagłówek jeśli brak
      if (sheet.getLastColumn() < 10) {
        sheet.getRange(1, 10).setValue("TypNieobecnosci");
      }
      sheet.getRange(last, 10).setValue(typ === "Zbiorka" ? "Zbiórka" : typ);
      if (sheet.getLastColumn() < 7 || !sheet.getRange(last, 7).getValue()) {
        sheet.getRange(last, 7).setValue("Nowy");
      }
    } catch (e1) {}
  }
  return res;
}

// ----------------------------------------------------------------------
// 15–16: Automatyczne minusy za zbiórkę + idempotencja
// ----------------------------------------------------------------------

/**
 * Zamienia surowy klucz idempotencji z kolumny Opis na czytelny, ładny
 * opis pokazywany w historii punktowej ministranta.
 * Zachowuje oryginalny klucz w arkuszu (potrzebny do idempotencji i do
 * "Cofnij minusy") — zmienia tylko to, co widzi użytkownik.
 */
function _formatujOpisLogu(opisRaw) {
  var opis = String(opisRaw == null ? "" : opisRaw);

  var mAuto = opis.match(/^AUTO_MINUS_ZBIORKA\|(\d{4}-\d{2}-\d{2})\|\S+\s*\|\s*(.*)$/);
  if (mAuto) {
    var dataPl1 = mAuto[1].split("-").reverse().join(".");
    var nazwaWyd = mAuto[2] || "Zbiórka";
    return "Brak potwierdzonej obecności na wydarzeniu „" + nazwaWyd + "” w dniu " + dataPl1 + ".";
  }

  var mReczny = opis.match(/^RECZNY_MINUS_ZBIORKA\|(\d{4}-\d{2}-\d{2})\s*\|\s*(.*)$/);
  if (mReczny) {
    var dataPl2 = mReczny[1].split("-").reverse().join(".");
    return "Nieobecność na zbiórce w dniu " + dataPl2 + " (naliczone przez administratora).";
  }

  return opis || "brak opisu";
}

/**
 * Nalicza minus za konkretną zbiórkę (data + nazwa) wszystkim, którzy:
 *  - nie mają odnotowanej obecności tego dnia na tej zbiórce,
 *  - nie mają zaakceptowanego wniosku o nieobecność na ten dzień,
 *  - nie mieli już wcześniej naliczonego minusa za tę samą zbiórkę (idempotencja).
 * Używana zarówno przez trigger co godzinę (24h po zbiórce), jak i przez
 * przycisk administratora "Uruchom korektę teraz" (na żądanie, natychmiast).
 * 
 * ZAKTUALIZOWANE: Brak kar za nieobecność na zbiórce (nowe zasady punktowe).
 * Funkcja zachowana dla kompatybilności - zwraca 0.
 */
function _naliczMinusyDlaZbiorkiWDniu(ss, tz, dataZ, nazwaOrig, wykonawcaId, wykonawcaImie) {
  // Brak kar za nieobecność na zbiórce - usunięte w nowej wersji systemu punktowego
  return 0;
}

/**
 * Wersja "na żądanie" — administrator klika przycisk i korekta wykonuje się
 * NATYCHMIAST (bez czekania na 24h), dokładnie tą samą logiką co trigger
 * automatyczny: minus dostają tylko ci, którzy nie mają obecności ani
 * zaakceptowanego wniosku o nieobecność na wskazany dzień zbiórki.
 * Nie wymaga zaznaczania osób — działa jak "uruchom trigger teraz".
 * 
 * ZAKTUALIZOWANE: Brak kar za nieobecność na zbiórce (nowe zasady punktowe).
 * Funkcja zachowana dla kompatybilności - zwraca sukces bez naliczania minusów.
 */
function uruchomKorekteZbiorkiTeraz(wykonawcaId, dataIso, wykonawcaImie) {
  return { sukces: false, wiadomosc: "Funkcja wycofana (brak minusów za zbiórki)." };
}

// ----------------------------------------------------------------------
// 17 + 19: Cofnięcie minusów (zbiórka / dyżur)
// ----------------------------------------------------------------------


/**
 * cofnijMinusyZaWydarzenie(wykonawcaId, typ, dataIso, listaId|null)
 * typ: "zbiorka" | "dyzur"
 * listaId: null = wszyscy; tablica ID = wybrane osoby
 */
function cofnijMinusyZaWydarzenie(wykonawcaId, typ, dataIso, listaId) {
  try {
    var rola = pobierzRoleUzytkownika(wykonawcaId);
    if (!_czyAdminLubKsiadz(rola) && String(rola || "").toUpperCase().indexOf("ADMIN") !== 0) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var prefix = (String(typ || "").toLowerCase().indexOf("dyz") >= 0)
      ? "Nieusprawiedliwiona nieobecność na dyżurze"
      : "Nieusprawiedliwiona nieobecność na zbiórce";
    var dataKey = String(dataIso || "").trim(); // yyyy-MM-dd
    var filterIds = null;
    if (listaId && listaId.length) {
      filterIds = {};
      listaId.forEach(function(id) { filterIds[String(id).trim()] = true; });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Logi_ręczne");
    if (!sheet || sheet.getLastRow() < 2) return { sukces: true, cofnieto: 0 };

    var dane = sheet.getDataRange().getValues();
    var tz = _APP_TZ;
    var doUsuniecia = []; // wiersze od dołu
    var affected = {};

    for (var i = 1; i < dane.length; i++) {
      var naz = String(dane[i][2] || "");
      if (naz.indexOf(prefix) < 0 && String(dane[i][4] || "").indexOf("AUTO_MINUS") < 0) continue;
      if (parseInt(dane[i][3], 10) >= 0) continue; // tylko minusy
      var uid = String(dane[i][1] || "").trim();
      if (filterIds && !filterIds[uid]) continue;

      if (dataKey) {
        var op = String(dane[i][4] || "");
        var dRow = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
        var matchData = op.indexOf(dataKey) >= 0 ||
          (!isNaN(dRow.getTime()) && Utilities.formatDate(dRow, tz, "yyyy-MM-dd") === dataKey);
        if (!matchData) continue;
      }
      doUsuniecia.push(i + 1);
      affected[uid] = true;
    }

    doUsuniecia.sort(function(a, b) { return b - a; });
    doUsuniecia.forEach(function(row) { sheet.deleteRow(row); });

    Object.keys(affected).forEach(function(uid) {
      if (typeof przeliczPunktyUzytkownika === "function") przeliczPunktyUzytkownika(uid);
    });

    if (typeof _logAdmin === "function") {
      _logAdmin(wykonawcaId, "", "COFNIJ_MINUSY", typ + "|" + dataKey, "osob=" + Object.keys(affected).length);
    }

    return { sukces: true, cofnieto: doUsuniecia.length, wiadomosc: "Cofnięto " + doUsuniecia.length + " wpisów minusowych." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

// ----------------------------------------------------------------------
// 18: (USUNIĘTO) Ręczne dodanie minusów wybranym osobom — zastąpione
// przez uruchomKorekteZbiorkiTeraz(), która działa jak trigger 24h,
// tylko uruchamiana od razu na żądanie administratora.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// Helper: instalacja triggera zbiórek - WYŁĄCZONE (brak kar za zbiórki)
// ----------------------------------------------------------------------
function zainstalujTriggerZbiorek() {
  // Usuń stare o tej nazwie
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "naliczMinusyZaOpuszczoneZbiorki") {
      ScriptApp.deleteTrigger(t);
    }
  });
  return "Minusy za zbiórki wyłączone w nowych zasadach punktowych - trigger nieinstalowany.";
}


// --- Alias: wszystkie stare wywołania idą w atomową wersję ---
function przejmijTicket(userId, imie, ticketId) {
  return przejmijTicketAtomic(userId, imie, ticketId);
}


// ======================================================================
// ZIELONY BANER — komunikat na ekranie logowania (tylko ID 2212)
// ======================================================================
function ustawZielonyBaner(wykonawcaId, tytul, tresc) {
  try {
    // >>> Zezwól wszystkim ADMIN/MODERATOR + 2212. Baner to tylko
    //     komunikat na ekranie logowania — bezpiecznie dać adminom.
    var _uidGB = _normId(wykonawcaId);
    var _rGB = _normalizujRole(pobierzRoleUzytkownika(_uidGB));
    var _okGB = (String(_uidGB) === "2212") || _rGB === "ADMIN" || _rGB === "MODERATOR";
    if (!_okGB) {
      return { sukces: false, wiadomosc: "Tylko administrator może ustawiać zielony baner." };
    }
    var props = PropertiesService.getScriptProperties();
    var t = String(tytul || "").trim();
    var m = String(tresc || "").trim();
    if (!t && !m) {
      props.deleteProperty("green_banner_tytul");
      props.deleteProperty("green_banner_tresc");
      return { sukces: true, wiadomosc: "Zielony baner wyłączony." };
    }
    props.setProperty("green_banner_tytul", t || "✅ Komunikat");
    props.setProperty("green_banner_tresc", m || "Wiadomość dla Ciebie.");
    try { _logAdmin(wykonawcaId, "", "ZIELONY_BANER_ON", t || "", m || ""); } catch (eL) {}
    return { sukces: true, wiadomosc: "Zielony baner ustawiony." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

function getZielonyBaner() {
  try {
    var props = PropertiesService.getScriptProperties();
    var t = props.getProperty("green_banner_tytul") || "";
    var m = props.getProperty("green_banner_tresc") || "";
    if (!t && !m) return { sukces: true, aktywny: false };
    return { sukces: true, aktywny: true, tytul: t, tresc: m };
  } catch (e) {
    return { sukces: false, aktywny: false };
  }
}


// ======================================================================
// CACHE RFID — szybkie rozpoznawanie kart bez czytania całych arkuszy
// ======================================================================
function _cacheRfidKeyMapaUid() { return "rfid_map_uid"; }
function _cacheRfidKeyMapaId()  { return "rfid_map_id"; }
function _cacheRfidKeyDyzury()  { return "rfid_dyzury_set"; }

function _invalidateCacheRfid() {
  try {
    var c = CacheService.getScriptCache();
    c.remove(_cacheRfidKeyMapaUid());
    c.remove(_cacheRfidKeyMapaId());
    c.remove(_cacheRfidKeyDyzury());
  } catch (e) {}
}

function _pobierzMapeUidRfid() {
  try {
    var raw = CacheService.getScriptCache().get(_cacheRfidKeyMapaUid());
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  } catch (eC) {}
  var map = {};
  try {
    var sheet = _pobierzAlboUtworzArkuszKart();
    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      var uid = String(dane[i][0] || "").trim().toUpperCase();
      if (!uid) continue;
      var idM = String(dane[i][1] || "").trim();
      if (!idM) continue;
      map[uid] = { id: idM, imie: String(dane[i][2] || "").trim() || idM, aktywna: _czyAktywne(dane[i][3]) };
    }
    try { CacheService.getScriptCache().put(_cacheRfidKeyMapaUid(), JSON.stringify(map), 21600); } catch (eP) {}
  } catch (e) {}
  return map;
}

function _pobierzMapeIdMinistrantow() {
  try {
    var raw = CacheService.getScriptCache().get(_cacheRfidKeyMapaId());
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  } catch (eC) {}
  var map = {};
  try {
    var dk = _pobierzDaneKandydaci();
    if (dk && dk.length > 1) {
      for (var i = 1; i < dk.length; i++) {
        var kid = String(dk[i][0] || "").trim();
        if (!kid) continue;
        map[kid] = String(dk[i][1] || "").trim() || kid;
      }
    }
    try { CacheService.getScriptCache().put(_cacheRfidKeyMapaId(), JSON.stringify(map), 21600); } catch (eP) {}
  } catch (e) {}
  return map;
}

function _pobierzSetOsobZDyzurem() {
  try {
    var raw = CacheService.getScriptCache().get(_cacheRfidKeyDyzury());
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  } catch (eC) {}
  var set = {};
  try {
    var sheetD = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Dyżury");
    if (sheetD && sheetD.getLastRow() > 1) {
      var dd = sheetD.getDataRange().getValues();
      var tz = _APP_TZ;
      var dzisiajKey = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
      for (var i = 1; i < dd.length; i++) {
        var uid = String(dd[i][2] || "").trim();
        if (!uid) continue;
        var doRaw = dd[i][4];
        if (doRaw) {
          var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
          if (!isNaN(doD.getTime()) && Utilities.formatDate(doD, tz, "yyyy-MM-dd") < dzisiajKey) continue;
        }
        set[uid] = true;
      }
    }
    try { CacheService.getScriptCache().put(_cacheRfidKeyDyzury(), JSON.stringify(set), 300); } catch (eP) {}
  } catch (e) {}
  return set;
}

function _rfidWymagajDyzuru() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty("rfid_wymagaj_dyzuru");
    return v === null ? true : (String(v).toLowerCase() === "true");
  } catch (e) { return true; }
}


// ======================================================================
// CACHE SERVICE — szybki cache dla powtarzalnych odczytów
// ======================================================================
function _cKey(n) { return "v1_" + String(n); }
function _cGet(n) {
  try { var r = CacheService.getScriptCache().get(_cKey(n)); return r || null; } catch (e) { return null; }
}
function _cPut(n, v, ttl) {
  try { CacheService.getScriptCache().put(_cKey(n), String(v), ttl || 300); } catch (e) {}
}
function _cRemove(n) {
  try { CacheService.getScriptCache().remove(_cKey(n)); } catch (e) {}
}
function _cRemoveByPrefix(prefix) {
  try {
    // CacheService nie wspiera listowania kluczy — trzymamy rejestr
    var reg = _cGet("_registry");
    if (!reg) return;
    var lista = JSON.parse(reg);
    var zostaja = [];
    lista.forEach(function(k) {
      if (k.indexOf(prefix) === 0) {
        try { CacheService.getScriptCache().remove(_cKey(k)); } catch (e) {}
      } else { zostaja.push(k); }
    });
    _cPut("_registry", JSON.stringify(zostaja), 21600);
  } catch (e) {}
}
function _cTrackKey(n) {
  try {
    var reg = _cGet("_registry");
    var lista = reg ? JSON.parse(reg) : [];
    if (lista.indexOf(n) === -1) {
      lista.push(n);
      _cPut("_registry", JSON.stringify(lista), 21600);
    }
  } catch (e) {}
}
function _cInvalidateKandydaci() {
  _cRemove("kandydaci_raw");
  _cRemoveByPrefix("rola_");
}
function _cInvalidateRola(uid) {
  if (uid) _cRemove("rola_" + String(uid).trim());
}


// ======================================================================
// Szybki odczyt arkusza Kandydaci (cache 60s)
// Zwraca surowy 2D array łącznie z nagłówkiem — tak samo jak getDataRange().getValues().
// ======================================================================
function _pobierzKandydatowRawCached() {
  var cached = _cGet("kandydaci_raw");
  if (cached) {
    try {
      var arr = JSON.parse(cached);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Kandydaci");
    if (!sheet) return [[]];
    var vals = sheet.getDataRange().getValues();
    // Normalizacja: daty zamieniamy na timestamp, żeby JSON nie zamienił ich w string
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      var row = [];
      for (var j = 0; j < vals[i].length; j++) {
        var c = vals[i][j];
        if (c instanceof Date) row.push({ __d: c.getTime() });
        else row.push(c);
      }
      out.push(row);
    }
    _cPut("kandydaci_raw", JSON.stringify(out), 60);
    _cTrackKey("kandydaci_raw");
    return vals;
  } catch (e) {
    return [[]];
  }
}


// ======================================================================
// FAST START — lekki endpoint na start aplikacji (profil + najbliższe)
// ======================================================================
function getInitialAppData(userId, userRole, sessionToken) {
  var _t0 = new Date().getTime();
  try {
    var uid = _normId(userId);
    if (!uid) return { success: false, error: "Brak ID." };

    // Rola z cache (albo z arkusza, jedno wywołanie)
    var rola = pobierzRoleUzytkownika(uid) || userRole || "";
    var rU = String(rola || "").toUpperCase();
    var jestAdminLike = (rU.indexOf("ADMIN") === 0 || rU === "MODERATOR" || rU === "KSIADZ" || rU === "KSIĄDZ");
    var jestLektorLike = (rU.indexOf("LEKTOR") === 0);

    // Kandydaci — pełna lista dla admina/lektora, tylko własny rekord dla reszty
    var wszyscyRaw = _pobierzKandydatowRawCached();
    var kandydaci = [];
    var mojRekord = null;
    var czyKandydat = false;
    for (var i = 1; i < wszyscyRaw.length; i++) {
      var kid = _normId(wszyscyRaw[i][0]);
      if (!kid) continue;
      var rec = [
        kid,
        String(wszyscyRaw[i][1] || ""),
        parseInt(wszyscyRaw[i][2]) || 0,
        String(wszyscyRaw[i][3] || ""),
        String(wszyscyRaw[i][4] || ""),
        String(wszyscyRaw[i][5] || ""),
        String(wszyscyRaw[i][6] || ""),
        String(wszyscyRaw[i][7] || "")
      ];
      if (kid === uid) { mojRekord = rec; czyKandydat = true; }
      if (jestAdminLike || jestLektorLike || kid === uid) kandydaci.push(rec);
    }

    // Dyżury — pełne dla admina, tylko własne dla reszty
    var dyzury = [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetD = ss.getSheetByName("Dyżury");
    if (sheetD && sheetD.getLastRow() > 1) {
      var tzD = _APP_TZ;
      var dzisiajKey = Utilities.formatDate(new Date(), tzD, "yyyy-MM-dd");
      var dd = sheetD.getDataRange().getValues();
      for (var j = 1; j < dd.length; j++) {
        var dId = String(dd[j][2] || "").trim();
        if (!jestAdminLike && dId !== uid) continue;
        if (!dd[j][0]) continue;
        var d = dd[j][0] instanceof Date ? dd[j][0] : new Date(dd[j][0]);
        if (isNaN(d.getTime())) continue;
        var doRaw = dd[j][4];
        if (doRaw) {
          var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
          if (!isNaN(doD.getTime()) && Utilities.formatDate(doD, tzD, "yyyy-MM-dd") < dzisiajKey) continue;
        }
        dyzury.push({
          wiersz: j + 1,
          timestamp: d.getTime(),
          dzienTygodnia: d.getDay(),
          godzina: _fixGodzina(d),
          imieNazwisko: String(dd[j][1] || ""),
          id: dId
        });
      }
    }

    // Kalendarz — tylko najbliższe 20 z okna [dziś .. +60 dni]
    var kalendarz = [];
    var sheetKal = ss.getSheetByName("Kalendarz");
    if (sheetKal && sheetKal.getLastRow() > 1) {
      var terazMs = new Date().getTime();
      var progMs = terazMs + 60 * 24 * 3600 * 1000;
      var dk = sheetKal.getDataRange().getValues();
      for (var k = 1; k < dk.length; k++) {
        if (!dk[k][0]) continue;
        var ts = dk[k][0] instanceof Date ? dk[k][0].getTime() : new Date(dk[k][0]).getTime();
        if (isNaN(ts)) continue;
        // 1 dzień tolerancji wstecz (żeby „dzisiejsze" jeszcze się łapały)
        if (ts < terazMs - 24 * 3600 * 1000 || ts > progMs) continue;
        kalendarz.push([
          ts,
          String(dk[k][1] || ""),
          parseInt(dk[k][2]) || 0,
          k + 1,
          String(dk[k][3] || ""),
          String(dk[k][4] || ""),
          String(dk[k][5] || "")
        ]);
      }
      kalendarz.sort(function(a, b) { return a[0] - b[0]; });
      if (kalendarz.length > 20) kalendarz = kalendarz.slice(0, 20);
    }

    var rokNazwa = "";
    try { rokNazwa = PropertiesService.getScriptProperties().getProperty('rok_nazwa') || ''; } catch (eRn) {}

    // ADMIN/MODERATOR: przy każdym wejściu przeprocesuj zaległą kolejkę
    // powiadomień — zamiast czekać na trigger 1-min (który w GAS bywa
    // opóźniony nawet o dziesiątki minut przy obciążonym projekcie).
    try {
      var _rInit = String(rola || "").toUpperCase();
      if (_rInit.indexOf("ADMIN") === 0 || _rInit === "MODERATOR" || String(uid) === "2212") {
        if (typeof przetworzKolejkePowiadomienAdmin === "function") {
          przetworzKolejkePowiadomienAdmin();
        }
      }
    } catch (eQ) {}

    var _dt = new Date().getTime() - _t0;
    console.log("[DIAG-INIT] getInitialAppData " + _dt + "ms kand=" + kandydaci.length + " dyz=" + dyzury.length + " kal=" + kalendarz.length);

    return {
      success: true,
      kandydaci: kandydaci,
      kalendarz: kalendarz,
      dyzury: dyzury,
      zweryfikowanaRola: rola,
      czyKandydat: czyKandydat,
      rokNazwa: rokNazwa,
      // Puste placeholdery — dociągane leniwie
      spolecznosc: [],
      wnioski: [],
      ostatnieKomentarze: [],
      postyMeta: { strona: 0, wszystkich: 0, naStrone: 10 },
      _fast: true
    };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}


// ======================================================================
// ZGŁOSZENIA BŁĘDÓW — ekran logowania (bez autoryzacji)
// Arkusz: Zgloszenia_bledow
// ======================================================================
function _arkuszZgloszenBledow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Zgloszenia_bledow");
  if (!sheet) {
    sheet = ss.insertSheet("Zgloszenia_bledow");
    sheet.appendRow([
      "Data", "Kategoria", "Opis", "Kontakt",
      "UserAgent", "Platforma", "Rozdzielczosc",
      "Jezyk", "URL", "Status", "Notatka admina",
      "DeviceID", "UserId", "Powiadomiono"
    ]);
    try {
      sheet.getRange(1, 1, 1, 14).setFontWeight("bold").setBackground("#fce8e6");
      sheet.setFrozenRows(1);
    } catch (eFmt) {}
  } else {
    try {
      var lastCol = sheet.getLastColumn();
      if (lastCol < 12) sheet.getRange(1, 12).setValue("DeviceID");
      if (lastCol < 13) sheet.getRange(1, 13).setValue("UserId");
      if (lastCol < 14) sheet.getRange(1, 14).setValue("Powiadomiono");
    } catch (eMig) {}
  }
  return sheet;
}

/**
 * Zapisuje zgłoszenie błędu z ekranu logowania.
 * NIE wymaga logowania — działa przed autoryzacją.
 * Zwraca { sukces, wiadomosc, id }.
 */
function _pobierzUserIdPoDeviceId(deviceId) {
  try {
    var dev = String(deviceId || "").trim();
    if (!dev) return "";
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sesje_urzadzen");
    if (!sheet || sheet.getLastRow() < 2) return "";
    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0] || "").trim() === dev) {
        return String(dane[i][1] || "").trim();
      }
    }
    return "";
  } catch (e) {
    return "";
  }
}

function _pobierzImiePoId(userId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return "";
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var k = ss.getSheetByName("Kandydaci");
    if (k && k.getLastRow() > 1) {
      var dk = k.getDataRange().getValues();
      for (var i = 1; i < dk.length; i++) {
        if (String(dk[i][0] || "").trim() === uid) return String(dk[i][1] || "").trim();
      }
    }
    var h = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (h && h.getLastRow() > 1) {
      var dh = h.getDataRange().getValues();
      for (var j = 1; j < dh.length; j++) {
        if (String(dh[j][0] || "").trim() === uid) return String(dh[j][1] || "").trim();
      }
    }
    return uid;
  } catch (e) {
    return "";
  }
}

function powiadomZglaszajacego(wiersz, tresc, wykonawcaId) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && uid !== "2212") {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var row = parseInt(wiersz, 10);
    if (!row || row < 2) return { sukces: false, wiadomosc: "Nieprawidłowy wiersz." };
    var sheet = _arkuszZgloszenBledow();
    if (row > sheet.getLastRow()) return { sukces: false, wiadomosc: "Brak takiego zgłoszenia." };

    var rowData = sheet.getRange(row, 1, 1, 14).getValues()[0];
    var kategoria = String(rowData[1] || "").trim();
    var dataZgl = String(rowData[0] || "").trim();
    var deviceId = String(rowData[11] || "").trim();
    var targetUserId = String(rowData[12] || "").trim();

    if (!targetUserId && deviceId) {
      targetUserId = _pobierzUserIdPoDeviceId(deviceId) || "";
      if (targetUserId) sheet.getRange(row, 13).setValue(targetUserId);
    }
    if (!targetUserId) {
      return { sukces: false, wiadomosc: "Nie można rozpoznać zgłaszającego (brak ID i device_id)." };
    }

    var imie = _pobierzImiePoId(targetUserId);
    var trescFinal = String(tresc || "").trim();
    if (!trescFinal) {
      trescFinal = "Twoje zgłoszenie błędu z dnia " + dataZgl + " (" + kategoria + ") zostało rozwiązane. Dziękujemy za pomoc!";
    }

    try {
      if (typeof _zapiszZdarzeniePowiadomienia === "function") {
        _zapiszZdarzeniePowiadomienia(
          targetUserId,
          "bug_fixed_" + row + "_" + Date.now(),
          "profil", "✅",
          "Naprawione: " + kategoria,
          trescFinal,
          "page-ustawienia"
        );
      }
    } catch (eN) {}

    try {
      if (typeof wyslijPowiadomienieDoUserow === "function") {
        wyslijPowiadomienieDoUserow(targetUserId, "✅ Naprawione: " + kategoria, trescFinal);
      }
    } catch (eP) {}

    var tz = _APP_TZ;
    var dataPow = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm:ss");
    sheet.getRange(row, 14).setValue(dataPow);

    try { _logAdmin(uid, "", "BUG_NOTIFY", targetUserId, "row=" + row + " " + kategoria); } catch (eL) {}

    return {
      sukces: true,
      userId: targetUserId,
      imie: imie || targetUserId,
      data: dataPow,
      wiadomosc: "Powiadomienie wysłane do: " + (imie || targetUserId)
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}

// [BUG-FIX-2026] Powiadomienia o nowych zgłoszeniach błędów → TYLKO ID 2212,
//                jedno zgłoszenie = DOKŁADNIE JEDNO powiadomienie (push + dzwonek).
//                Wszelkie broadcasty do innych adminów są celowo wyłączone.
function zglosBladAnonimowy(kategoria, opis, kontakt, uaInfo) {
  try {
    var kat = String(kategoria || "").trim();
    var op  = String(opis || "").trim();
    if (!kat) return { sukces: false, wiadomosc: "Wybierz kategorię zgłoszenia." };
    if (op.length > 3000) op = op.substring(0, 3000);

    var info = uaInfo || {};
    var ua   = String(info.ua || "").substring(0, 500);
    var plat = String(info.platform || "").substring(0, 100);
    var roz  = String(info.screen || "").substring(0, 60);
    var jez  = String(info.lang || "").substring(0, 30);
    var url  = String(info.url || "").substring(0, 300);
    var kont = String(kontakt || "").trim().substring(0, 200);
    var deviceId = String(info.deviceId || "").trim().substring(0, 60);

    // ── DEDUP: to samo zgłoszenie w ciągu 60 s z tego samego urządzenia
    //    NIE zostanie zapisane drugi raz ani nie wyśle drugiego pusha.
    //    Klucz: kategoria + device_id + końcówka URL-a.
    try {
      var props = PropertiesService.getScriptProperties();
      var urlTail = url ? url.substring(Math.max(0, url.length - 12)) : "";
      var dedupKlucz = "bug_dedup_" +
        (kat || "").replace(/[^A-Za-z0-9]/g, "").substring(0, 24) + "_" +
        (deviceId || "nodev").substring(0, 12) + "_" +
        urlTail.replace(/[^A-Za-z0-9]/g, "");
      var ostatniTs = parseInt(props.getProperty(dedupKlucz) || "0", 10);
      if (ostatniTs && (Date.now() - ostatniTs) < 60000) {
        return {
          sukces: true,
          id: "BUG-DUP",
          wiadomosc: "Zgłoszenie już zostało przyjęte."
        };
      }
      props.setProperty(dedupKlucz, String(Date.now()));
    } catch (eDedup) {}

    var wykrytyUserId = String(info.manualUserId || "").trim();
    if (!wykrytyUserId && deviceId) {
      try { wykrytyUserId = _pobierzUserIdPoDeviceId(deviceId) || ""; } catch (eU) {}
    }

    var sheet = _arkuszZgloszenBledow();
    var teraz = new Date();
    var tz = _APP_TZ;
    var dataStr = Utilities.formatDate(teraz, tz, "yyyy-MM-dd HH:mm:ss");
    var idKrotki = "BUG-" + Utilities.formatDate(teraz, tz, "yyMMdd-HHmmss");

    sheet.appendRow([
      dataStr, kat, op, kont, ua, plat, roz, jez, url, "Nowe", "",
      deviceId, wykrytyUserId, ""
    ]);

    // ── POWIADOMIENIE WYŁĄCZNIE DO ID 2212 (jeden push + jeden dzwonek).
    //    _pushNatychmiast robi dokładnie jedną akcję push OneSignal
    //    ORAZ jeden wpis w Powiadomienia_zdarzenia (dzwonek in-app).
    //    ŻADNYCH innych wywołań tutaj — świadoma decyzja właściciela systemu.
    try {
      if (typeof _pushNatychmiast === "function") {
        var _tytulBug = "🐞 Nowe zgłoszenie: " + kat;
        var _trescBug = op ? op.substring(0, 180) : "Bez opisu";
        var _kluczBug = "bug_report_" +
          Utilities.formatDate(teraz, tz, "yyyyMMdd_HHmmss") + "_" +
          kat.replace(/[^A-Za-z0-9]/g, "").substring(0, 16);
        _pushNatychmiast(
          "2212",
          "🐞",
          _tytulBug,
          _trescBug,
          "bug_report",
          "page-wnioski",
          _kluczBug
        );
      }
    } catch (ePush) {}

    _logAdmin("ANON", "Gość", "BUG_REPORT", kat, dataStr + " | " +
      (op ? op.substring(0, 120) : "bez opisu"));

    return {
      sukces: true,
      id: idKrotki,
      wykrytyUser: wykrytyUserId || "",
      wiadomosc: "Zgłoszenie wysłane. Dziękujemy!"
    };
  } catch (e) {
    return { sukces: false, wiadomosc: "Błąd zapisu: " + (e.message || e) };
  }
}


/**
 * Lista zgłoszeń — dla admina (zakładka Ustawienia / Logi).
 */
function getZgloszeniaBledow(wykonawcaId, tylkoNowe) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && uid !== "2212") {
      return { sukces: false, lista: [], wiadomosc: "Brak uprawnień." };
    }
    var sheet = _arkuszZgloszenBledow();
    var last = sheet.getLastRow();
    if (last < 2) return { sukces: true, lista: [] };
    var start = Math.max(2, last - 199);
    var numCols = Math.max(14, sheet.getLastColumn());
    var dane = sheet.getRange(start, 1, last - start + 1, numCols).getValues();
    var lista = [];
    for (var i = dane.length - 1; i >= 0; i--) {
      var r = dane[i];
      var status = String(r[9] || "").trim();
      if (tylkoNowe && status !== "Nowe") continue;
      lista.push({
        wiersz: start + i,
        data: String(r[0] || ""),
        kategoria: String(r[1] || ""),
        opis: String(r[2] || ""),
        kontakt: String(r[3] || ""),
        ua: String(r[4] || ""),
        platforma: String(r[5] || ""),
        rozdzielczosc: String(r[6] || ""),
        jezyk: String(r[7] || ""),
        url: String(r[8] || ""),
        status: status || "Nowe",
        notatka: String(r[10] || ""),
        deviceId: String(r[11] || ""),
        userId: String(r[12] || ""),
        powiadomiono: String(r[13] || "")
      });
    }
    return { sukces: true, lista: lista };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: String(e.message || e) };
  }
}

/**
 * Zmiana statusu zgłoszenia (Nowe / W trakcie / Zamknięte).
 */
function ustawStatusZgloszenia(wykonawcaId, wiersz, nowyStatus, notatka) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && uid !== "2212") {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var sheet = _arkuszZgloszenBledow();
    var row = parseInt(wiersz, 10);
    if (!row || row < 2 || row > sheet.getLastRow()) {
      return { sukces: false, wiadomosc: "Nieprawidłowy wiersz." };
    }
    sheet.getRange(row, 10).setValue(String(nowyStatus || "Nowe").trim());
    if (notatka != null) sheet.getRange(row, 11).setValue(String(notatka || ""));
    return { sukces: true, wiadomosc: "Status zaktualizowany." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}


// ======================================================================
// FOLDER ZDJĘĆ — jeden wspólny dla postów, ankiet i zdjęć profilowych.
// Uruchom RAZ z edytora Apps Script: Run ▶ ustawFolderZdjec()
// ======================================================================
function ustawFolderZdjec() {
  var FOLDER_ID = "DANE_WRAŻLIWE";
  PropertiesService.getScriptProperties().setProperty("DANE_WRAŻLIWE", FOLDER_ID);
  try {
    var f = DriveApp.getFolderById(FOLDER_ID);
    var msg = "OK. Folder: \"" + f.getName() + "\"";
    Logger.log(msg);
    return msg;
  } catch (e) {
    var msg2 = "BŁĄD — nie znaleziono folderu o ID " + FOLDER_ID + ": " + e.message;
    Logger.log(msg2);
    return msg2;
  }
}

function pokazFolderZdjec() {
  var id = PropertiesService.getScriptProperties().getProperty("FOLDER_ZDJEC_ID") || "(puste)";
  Logger.log("FOLDER_ZDJEC_ID = " + id);
  return id;
}
function testDysku() {
  DriveApp.getRootFolder();
}
function testDostepuDoFolderu() {
  var id = PropertiesService.getScriptProperties().getProperty("FOLDER_ZDJEC_ID");
  Logger.log("Zapisane ID: " + id);
  try {
    var folder = DriveApp.getFolderById(id);
    Logger.log("Sukces! Nazwa folderu to: " + folder.getName());
  } catch(e) {
    Logger.log("Błąd: " + e.toString());
  }
}
function nadajUprawnienia() {
  DriveApp.getRootFolder();
}


// ======================================================================
// OKNO ODBIJANIA KARTY RFID PER WYDARZENIE
// ----------------------------------------------------------------------
// Kolumny G i H w arkuszu Kalendarz:
//   G = OknoOdMin  (ile minut PRZED startem można odbić)
//   H = OknoDoMin  (ile minut PO starcie można odbić)
//
// Puste = fallback na domyślne zachowanie (_oknoCzasoweMszy bez override):
//   tydzień:    od -30 min, do +60 min
//   niedziela / sobota 18:00:  od -30 min, do +75 min
// ======================================================================

function _upewnijNaglowkiKalendarza(sheet) {
  if (!sheet) return;
  try {
    // Arkusz musi mieć co najmniej 8 kolumn (A..H)
    var guard = 0;
    while (sheet.getLastColumn() < 8 && guard < 20) {
      sheet.insertColumnAfter(sheet.getLastColumn());
      guard++;
    }
    var g7 = String(sheet.getRange(1, 7).getValue() || "").trim();
    var h8 = String(sheet.getRange(1, 8).getValue() || "").trim();
    if (!g7) sheet.getRange(1, 7).setValue("OknoOdMin");
    if (!h8) sheet.getRange(1, 8).setValue("OknoDoMin");
  } catch (e) {
    // nie blokuj zapisu wydarzenia jeśli migracja nagłówków się nie powiedzie
  }
}
function pokazWersje() {
  Logger.log("=== CO WIDZI URUCHOMIONY KOD ===");
  Logger.log("Session.getScriptTimeZone(): " + Session.getScriptTimeZone());
  Logger.log("Arkusz TZ: " + SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone());
  Logger.log("new Date().toISOString(): " + new Date().toISOString());
  Logger.log("getHours(): " + new Date().getHours() + ":" + new Date().getMinutes());
  Logger.log("formatDate Warsaw: " + Utilities.formatDate(new Date(), "Europe/Warsaw", "HH:mm z"));
  Logger.log("czas_testowy_iso: [" + (PropertiesService.getScriptProperties().getProperty("czas_testowy_iso") || "PUSTE") + "]");
}
function ustawStrefeArkusza() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("PRZED: [" + ss.getSpreadsheetTimeZone() + "]");
  ss.setSpreadsheetTimeZone("Europe/Warsaw");
  Logger.log("PO:    [" + ss.getSpreadsheetTimeZone() + "]");
}
function sprawdzPoZmianieStrefy() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("Arkusz TZ: [" + ss.getSpreadsheetTimeZone() + "]");
  Logger.log("Skrypt TZ: " + Session.getScriptTimeZone());
  Logger.log("Teraz (Warsaw): " + Utilities.formatDate(new Date(), "Europe/Warsaw", "yyyy-MM-dd HH:mm:ss z"));

  // Sprawdź pierwszy wpis z Logi_ręczne
  var sh = ss.getSheetByName("Logi_ręczne");
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, 1).getValue();
    Logger.log("Logi_ręczne A2 raw: " + v);
    if (v instanceof Date) {
      Logger.log("  getHours: " + v.getHours() + ":" + v.getMinutes());
      Logger.log("  formatDate Warsaw: " + Utilities.formatDate(v, "Europe/Warsaw", "yyyy-MM-dd HH:mm"));
    }
  }
}
// ============================================================
// NARZĘDZIA DIAGNOSTYCZNE / NAPRAWCZE — czas
// ============================================================

/** Ustawia strefę arkusza na Europe/Warsaw. Uruchom RAZ. */
function ustawStrefeArkusza() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("PRZED: [" + ss.getSpreadsheetTimeZone() + "]");
  ss.setSpreadsheetTimeZone("Europe/Warsaw");
  Logger.log("PO:    [" + ss.getSpreadsheetTimeZone() + "]");
}

/** Skanuje arkusze i wypisuje komórki z datą < 1970 (potencjalne "same godziny"). */
function skanuj1899() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var arkusze = [
    { nazwa: "Dyżury",             kolumny: [1, 4, 5] },
    { nazwa: "Kalendarz",          kolumny: [1] },
    { nazwa: "Wnioski_dyzury",     kolumny: [1, 4, 6] },
    { nazwa: "Nieobecnosci_dyzur", kolumny: [1, 4, 6] },
    { nazwa: "Wnioski_punkty",     kolumny: [1] },
    { nazwa: "Logi_czytnik",       kolumny: [1] },
    { nazwa: "Logi_ręczne",        kolumny: [1] },
    { nazwa: "Społeczność",        kolumny: [1] },
    { nazwa: "Komentarze",         kolumny: [1] },
    { nazwa: "Ankiety",            kolumny: [1, 5] },
    { nazwa: "Tickety",            kolumny: [6, 9] },
    { nazwa: "Tickety_wiadomosci", kolumny: [6] }
  ];
  var znalezione = 0;
  arkusze.forEach(function(a) {
    var sh = ss.getSheetByName(a.nazwa);
    if (!sh || sh.getLastRow() < 2) return;
    var dane = sh.getDataRange().getValues();
    a.kolumny.forEach(function(kol) {
      for (var i = 1; i < dane.length; i++) {
        var v = dane[i][kol - 1];
        if (v instanceof Date && v.getFullYear() < 1970) {
          Logger.log("[" + a.nazwa + "] " + sh.getRange(i + 1, kol).getA1Notation() +
            " raw=" + v.toISOString() +
            " getHours=" + v.getHours() + ":" + v.getMinutes() +
            " formatDate=" + Utilities.formatDate(v, "Europe/Warsaw", "HH:mm"));
          znalezione++;
        }
      }
    });
  });
  Logger.log("=== Znaleziono " + znalezione + " komórek z datą < 1970 ===");
  if (znalezione === 0) Logger.log("Wszystko czyste — brak problemu 1899.");
}

/** Sprawdza DST 2026. Oczekiwane getHours: 12, 1, 3, 12, 2, 3, 12. */
function testDST2026() {
  [
    "2026-01-15T12:00:00",  // zima CET
    "2026-03-29T01:30:00",  // przed DST
    "2026-03-29T03:30:00",  // po DST
    "2026-07-15T12:00:00",  // lato CEST
    "2026-10-25T02:30:00",  // przed cofnięciem
    "2026-10-25T03:30:00",  // po cofnięciu
    "2026-12-15T12:00:00"   // zima CET
  ].forEach(function(s) {
    var d = new Date(s);
    Logger.log(s + "  →  getHours=" + d.getHours() +
      "  formatDate=" + Utilities.formatDate(d, "Europe/Warsaw", "HH:mm z"));
  });
}

/** Sprawdza stan strefy po zmianach. */
function sprawdzPoZmianieStrefy() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("Arkusz TZ: [" + ss.getSpreadsheetTimeZone() + "]");
  Logger.log("Skrypt TZ: " + Session.getScriptTimeZone());
  Logger.log("Teraz (Warsaw): " +
    Utilities.formatDate(new Date(), "Europe/Warsaw", "yyyy-MM-dd HH:mm:ss z"));
  Logger.log("czas_testowy_iso: [" +
    (PropertiesService.getScriptProperties().getProperty("czas_testowy_iso") || "PUSTE") + "]");
}

/** Awaryjne wyczyszczenie sztucznego czasu (konto 2212). */
function wylaczCzasTestowy() {
  PropertiesService.getScriptProperties().deleteProperty("czas_testowy_iso");
  Logger.log("Wyczyszczono czas testowy");
}
function diagnozujDyzury() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("Arkusz TZ: [" + ss.getSpreadsheetTimeZone() + "]");
  Logger.log("Skrypt TZ: " + Session.getScriptTimeZone());
  var sh = ss.getSheetByName("Dyżury");
  if (!sh) { Logger.log("Brak arkusza Dyżury"); return; }
  var dane = sh.getDataRange().getValues();
  Logger.log("Wierszy: " + dane.length);
  for (var i = 1; i < Math.min(dane.length, 15); i++) {
    var v = dane[i][0];
    if (v instanceof Date) {
      Logger.log("Wiersz " + (i+1) +
        " | toISOString: " + v.toISOString() +
        " | getHours: " + v.getHours() + ":" + v.getMinutes() +
        " | formatDate: " + Utilities.formatDate(v, "Europe/Warsaw", "yyyy-MM-dd HH:mm z") +
        " | imie: " + String(dane[i][1] || ""));
    } else {
      Logger.log("Wiersz " + (i+1) + " | nie-Date: [" + v + "]");
    }
  }
}
function backupDyzury() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName("Dyżury");
  if (!src) { Logger.log("Brak arkusza Dyżury"); return; }
  var d = new Date();
  var pad = function(n){return (n<10?'0':'')+n;};
  var nazwa = "Dyżury_backup_" +
    d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + "_" +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  var kopia = src.copyTo(ss);
  kopia.setName(nazwa);
  Logger.log("Backup utworzony: " + nazwa);
}


// ────────────────────────────────────────────────────────────────
// PATCH_TICKET_HELPERS_V3 — lista osób do ticketu (admini + ministranci)
// ────────────────────────────────────────────────────────────────
/**
 * Zwraca listę osób, które można dodać do ticketu jako pomocników.
 *   admini:     [{id, imie}]
 *   ministranci:[{id, imie, ranga}]
 *   helperIds:  [id, id, ...]  (aktualni uczestnicy ticketu)
 *
 * Świadomie pomijam księży (nie używają ticketów) i samego wywołującego.
 * Jeśli ticketId jest podany, zwracam też obecnych helperów, żeby front
 * mógł pokazać ich jako (już dodanych) w liście wyboru.
 */
function getListaOsobDoTicketu(wykonawcaId, ticketId) {
  try {
    var uid = String(wykonawcaId || "").trim();
    if (!uid) return { sukces: false, admini: [], ministranci: [], helperIds: [] };

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── 1. Admini z arkusza Hasła (kol. F = TAK)
    var adminMap = {};
    try {
      var sh = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
      if (sh && sh.getLastRow() > 1) {
        var dh = sh.getDataRange().getValues();
        for (var i = 1; i < dh.length; i++) {
          if (!_czyFlagaAdmin(dh[i][5])) continue;
          var aid = String(dh[i][0] || "").trim();
          if (!aid) continue;
          adminMap[aid] = String(dh[i][1] || "").trim() || aid;
        }
      }
    } catch (eA) {}

    // ── 2. Wszyscy z Kandydaci (poza księżmi)
    var admini = [];
    var ministranci = [];
    var seen = {};
    try {
      var dk = _pobierzDaneKandydaci();
      for (var j = 1; j < dk.length; j++) {
        var kid = String(dk[j][0] || "").trim();
        if (!kid || seen[kid]) continue;
        seen[kid] = true;
        var kimie = String(dk[j][1] || "").trim() || kid;
        var kranga = String(dk[j][6] || "").trim();
        var kLow = kranga.toLowerCase();
        if (kLow.indexOf("ksi") === 0) continue; // księża poza ticketami
        if (adminMap[kid]) {
          admini.push({ id: kid, imie: kimie });
        } else {
          ministranci.push({ id: kid, imie: kimie, ranga: kranga });
        }
      }
    } catch (eK) {}

    // ── 3. Admini nieobecni w Kandydaci (np. konta techniczne)
    Object.keys(adminMap).forEach(function(aid) {
      if (seen[aid]) return;
      admini.push({ id: aid, imie: adminMap[aid] });
    });

    // Sortowanie alfabetyczne (pl)
    admini.sort(function(a, b) { return String(a.imie).localeCompare(String(b.imie), "pl"); });
    ministranci.sort(function(a, b) { return String(a.imie).localeCompare(String(b.imie), "pl"); });

    // Pomiń siebie (nie można dodać samego siebie)
    admini     = admini.filter(function(x) { return x.id !== uid; });
    ministranci = ministranci.filter(function(x) { return x.id !== uid; });

    // ── 4. Aktualni helperzy ticketu (jeśli podano ticketId)
    var helperIds = [];
    if (ticketId) {
      try {
        var sheetT = ss.getSheetByName("Tickety");
        if (sheetT && sheetT.getLastRow() > 1) {
          var tid = String(ticketId).trim();
          var dT = sheetT.getDataRange().getValues();
          for (var r = 1; r < dT.length; r++) {
            if (String(dT[r][0] || "").trim() !== tid) continue;
            var hRaw = (dT[r].length > 9 ? dT[r][9] : "") || "";
            helperIds = _parsujHelperIds(hRaw);
            break;
          }
        }
      } catch (eH) {}
    }

    return { sukces: true, admini: admini, ministranci: ministranci, helperIds: helperIds };
  } catch (e) {
    return { sukces: false, admini: [], ministranci: [], helperIds: [],
             wiadomosc: String(e && e.message ? e.message : e) };
  }
}


// ────────────────────────────────────────────────────────────────
// PATCH_TICKET_HELPERS_V3 — rozwiązanie imion helperów dla ticketu
// Używa cache (bez czytania Sheets przy każdym pollu).
// ────────────────────────────────────────────────────────────────
function _rozwiazHelperList(helperIdsRaw) {
  try {
    var ids = _parsujHelperIds(helperIdsRaw);
    if (!ids.length) return [];
    var mapa = _pobierzMapeIdMinistrantow(); // { id: imie } — cache 6h
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var hid = ids[i];
      out.push({ id: hid, imie: mapa[hid] || hid });
    }
    return out;
  } catch (e) {
    return [];
  }
}


// ═══════════════════════════════════════════════════════════════════════
// PATCH_TICKET_V4 — helperzy w ticketach (admini + ministranci)
// ═══════════════════════════════════════════════════════════════════════
function getListaOsobDoTicketu(wykonawcaId, ticketId) {
  try {
    var uid = String(wykonawcaId || "").trim();
    if (!uid) return { sukces: false, admini: [], ministranci: [], helperIds: [] };

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Admini z arkusza Hasła (kol. F = TAK)
    var adminMap = {};
    try {
      var sh = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
      if (sh && sh.getLastRow() > 1) {
        var dh = sh.getDataRange().getValues();
        for (var i = 1; i < dh.length; i++) {
          if (!_czyFlagaAdmin(dh[i][5])) continue;
          var aid = String(dh[i][0] || "").trim();
          if (!aid) continue;
          adminMap[aid] = String(dh[i][1] || "").trim() || aid;
        }
      }
    } catch (eA) {}

    var admini = [], ministranci = [], seen = {};
    try {
      var dk = _pobierzDaneKandydaci();
      for (var j = 1; j < dk.length; j++) {
        var kid = String(dk[j][0] || "").trim();
        if (!kid || seen[kid]) continue;
        seen[kid] = true;
        var kimie = String(dk[j][1] || "").trim() || kid;
        var kranga = String(dk[j][6] || "").trim();
        if (kranga.toLowerCase().indexOf("ksi") === 0) continue;
        if (adminMap[kid]) admini.push({ id: kid, imie: kimie });
        else ministranci.push({ id: kid, imie: kimie, ranga: kranga });
      }
    } catch (eK) {}

    Object.keys(adminMap).forEach(function(aid) {
      if (seen[aid]) return;
      admini.push({ id: aid, imie: adminMap[aid] });
    });

    admini.sort(function(a, b) { return String(a.imie).localeCompare(String(b.imie), "pl"); });
    ministranci.sort(function(a, b) { return String(a.imie).localeCompare(String(b.imie), "pl"); });
    admini = admini.filter(function(x) { return x.id !== uid; });
    ministranci = ministranci.filter(function(x) { return x.id !== uid; });

    var helperIds = [];
    if (ticketId) {
      try {
        var sheetT = ss.getSheetByName("Tickety");
        if (sheetT && sheetT.getLastRow() > 1) {
          var tid = String(ticketId).trim();
          var dT = sheetT.getDataRange().getValues();
          for (var r = 1; r < dT.length; r++) {
            if (String(dT[r][0] || "").trim() !== tid) continue;
            var hRaw = (dT[r].length > 9 ? dT[r][9] : "") || "";
            helperIds = _parsujHelperIds(hRaw);
            break;
          }
        }
      } catch (eH) {}
    }

    return { sukces: true, admini: admini, ministranci: ministranci, helperIds: helperIds };
  } catch (e) {
    return { sukces: false, admini: [], ministranci: [], helperIds: [],
             wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function _rozwiazHelperList(helperIdsRaw) {
  try {
    var ids = _parsujHelperIds(helperIdsRaw);
    if (!ids.length) return [];
    var mapa = _pobierzMapeIdMinistrantow();
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var hid = ids[i];
      out.push({ id: hid, imie: mapa[hid] || hid });
    }
    return out;
  } catch (e) {
    return [];
  }
}
// ═══════════════════════════════════════════════════════════════════════



// ======================================================================
// NAPRAWA DUPLIKATÓW POWIADOMIEŃ (jednorazowa akcja administratora)
// ----------------------------------------------------------------------
// Uruchom RĘCZNIE z edytora Apps Script (wybierz funkcję z listy, kliknij
// Uruchom) ALBO z konsoli w aplikacji: wyczyscDuplikatyPowiadomien("2212").
// Usuwa z arkuszy Powiadomienia_zdarzenia i Powiadomienia_wyslane
// powtarzające się pary (UserID, Klucz) — zostawia tylko pierwszy wiersz.
// ======================================================================
function wyczyscDuplikatyPowiadomien(wykonawcaId) {
  try {
    var uid = _normId(wykonawcaId || "2212");
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && String(uid) !== "2212") {
      return { sukces: false, wiadomosc: "Tylko administrator." };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var usunieto = 0;

    // 1. Powiadomienia_zdarzenia: (UserID, Klucz)
    var sheetZ = ss.getSheetByName("Powiadomienia_zdarzenia");
    if (sheetZ && sheetZ.getLastRow() > 1) {
      var dZ = sheetZ.getDataRange().getValues();
      var seenZ = {};
      var toDeleteZ = [];
      for (var i = dZ.length - 1; i >= 1; i--) {
        var uidZ = String(dZ[i][0] || "").trim();
        if (!uidZ) continue;
        var kZ = uidZ + "|" + String(dZ[i][1] || "").trim();
        if (seenZ[kZ]) { toDeleteZ.push(i + 1); }
        else { seenZ[kZ] = true; }
      }
      toDeleteZ.sort(function(a, b) { return b - a; });
      toDeleteZ.forEach(function(r) {
        try { sheetZ.deleteRow(r); usunieto++; } catch (e) {}
      });
    }

    // 2. Powiadomienia_wyslane: (UserID, Klucz)
    var sheetW = ss.getSheetByName("Powiadomienia_wyslane");
    if (sheetW && sheetW.getLastRow() > 1) {
      var dW = sheetW.getDataRange().getValues();
      var seenW = {};
      var toDeleteW = [];
      for (var j = dW.length - 1; j >= 1; j--) {
        var uidW = String(dW[j][0] || "").trim();
        if (!uidW) continue;
        var kW = uidW + "|" + String(dW[j][1] || "").trim();
        if (seenW[kW]) { toDeleteW.push(j + 1); }
        else { seenW[kW] = true; }
      }
      toDeleteW.sort(function(a, b) { return b - a; });
      toDeleteW.forEach(function(r) {
        try { sheetW.deleteRow(r); usunieto++; } catch (e) {}
      });
    }

    try { _logAdmin(uid, "", "WYCZYSC_DUPLIKATY_POWIADOMIEN", "", "usunieto=" + usunieto); } catch (eL) {}
    return { sukces: true, usunieto: usunieto, wiadomosc: "Usunięto " + usunieto + " duplikatów powiadomień." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}


// ======================================================================
// HARMONOGRAM RESETOW DLA ESP32
// ----------------------------------------------------------------------
// ScriptProperties:
//   esp32_reset_tryb       = "auto" | "off" | "force"
//   esp32_next_reset_iso   = ISO timestamp (opcjonalny, jednorazowy)
//   esp32_reset_godzina    = "03:00" (domyslna godzina resetu dziennego)
//
// Logika:
//   - tryb "auto":  serwer wylicza nastepne wystapienie godziny z
//                   esp32_reset_godzina (domyslnie 3:00) i zwraca je
//                   jako nextResetTs (UNIX sekundy). Gdy ustawiony jest
//                   esp32_next_reset_iso (jednorazowy), uzyje jego.
//   - tryb "force": zwraca forceNow=true i wraca do "auto".
//   - tryb "off":   nextResetTs=0 - ESP32 nie resetuje sie z serwera.
// ======================================================================
// >>> PATCH-2026-10-HARMONOGRAM-RESETOW
// Harmonogram resetow czytnikow ESP32.
//
// Zwraca JSON:
//   {
//     sukces: true,
//     tryb: "auto" | "off" | "force",
//     forceNow: bool,
//     nextResetTs: UNIX sekundy najbliszego resetu (lub 0),
//     nextResetIso: ISO tego samego czasu (diagnostyka),
//     serwerTs: UNIX sekundy teraz wg serwera,
//     harmonogram: [ "03:00", "11:00", ... ] — dla diagnostyki,
//     jednorazowyIso: "..." | ""
//   }
//
// Logika:
//   1) tryb "off"    → nextResetTs = 0 (nic sie nie resetuje)
//   2) tryb "force"  → forceNow=true, automatycznie wraca do "auto"
//   3) jednorazowy   → esp32_next_reset_iso ma priorytet (jesli w przyszlosci)
//   4) tygodniowy    → najblizsza godzina z listy dla dnia tygodnia:
//        codziennie 03:00
//        pon-pt     11:00, 15:00, 17:05
//        sobota     11:00, 15:00, 16:00
//        niedziela  09:20, 11:20, 13:20, 19:20
var _HARMONOGRAM_RESETU_TYGODNIOWY = {
  // 0 = niedziela ... 6 = sobota  (zgodnie z Date.getDay())
  0: [ "03:00", "09:20", "11:20", "13:20", "19:20" ], // niedziela
  1: [ "03:00", "11:00", "15:00", "17:05" ],           // poniedzialek
  2: [ "03:00", "11:00", "15:00", "17:05" ],           // wtorek
  3: [ "03:00", "11:00", "15:00", "17:05" ],           // sroda
  4: [ "03:00", "11:00", "15:00", "17:05" ],           // czwartek
  5: [ "03:00", "11:00", "15:00", "17:05" ],           // piatek
  6: [ "03:00", "11:00", "15:00", "16:00" ]            // sobota
};

function getHarmonogramResetu() {
  try {
    var props = PropertiesService.getScriptProperties();
    var tryb = String(props.getProperty("esp32_reset_tryb") || "auto").toLowerCase();
    if (tryb !== "auto" && tryb !== "off" && tryb !== "force") tryb = "auto";

    var nextResetSec = 0;
    var forceNow = false;
    var jednorazowyIso = String(props.getProperty("esp32_next_reset_iso") || "").trim();

    if (tryb === "force") {
      forceNow = true;
      props.setProperty("esp32_reset_tryb", "auto");
    } else if (tryb === "auto") {
      var teraz = new Date();
      var terazMs = teraz.getTime();

      // (1) Jednorazowy override — jesli ustawiony i w przyszlosci, ma priorytet
      var nextMs = 0;
      if (jednorazowyIso) {
        var dIso = new Date(jednorazowyIso);
        if (!isNaN(dIso.getTime()) && dIso.getTime() > terazMs) {
          nextMs = dIso.getTime();
        }
      }

      // (2) Tygodniowy harmonogram
      if (nextMs === 0) {
        nextMs = _najblizszyResetZHarmonogramu(teraz);
      }

      if (nextMs > 0) {
        nextResetSec = Math.floor(nextMs / 1000);
      }
    }

    var harmonyDzis = _HARMONOGRAM_RESETU_TYGODNIOWY[new Date().getDay()] || [];

    return JSON.stringify({
      sukces: true,
      tryb: tryb,
      forceNow: forceNow,
      nextResetTs: nextResetSec,
      nextResetIso: nextResetSec
        ? new Date(nextResetSec * 1000).toISOString()
        : "",
      serwerTs: Math.floor(Date.now() / 1000),
      harmonogram: harmonyDzis,
      jednorazowyIso: jednorazowyIso
    });
  } catch (e) {
    return JSON.stringify({
      sukces: false,
      wiadomosc: String(e && e.message ? e.message : e)
    });
  }
}

/**
 * Wewnetrzna: szuka najbliszego resetu wg tygodniowego harmonogramu.
 * Sprawdza dzisiaj pozostale godziny, potem kolejne dni (do 7 w przod).
 */
function _najblizszyResetZHarmonogramu(teraz) {
  var terazMs = teraz.getTime();
  for (var offset = 0; offset < 8; offset++) {
    var d = new Date(teraz.getFullYear(), teraz.getMonth(), teraz.getDate() + offset,
                     0, 0, 0, 0);
    var dzienTyg = d.getDay();
    var lista = _HARMONOGRAM_RESETU_TYGODNIOWY[dzienTyg] || [];
    // Posortuj rosnaco (na wypadek gdyby ktos dopisal godziny w innej kolejnosci)
    var godziny = lista.slice().sort();
    for (var i = 0; i < godziny.length; i++) {
      var parts = String(godziny[i]).split(":");
      var hh = parseInt(parts[0], 10);
      var mm = parseInt(parts[1], 10);
      if (isNaN(hh) || isNaN(mm)) continue;
      var kand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
      if (kand.getTime() > terazMs + 5000) { // +5 s margines, zeby nie lapac "wlasnie teraz"
        return kand.getTime();
      }
    }
  }
  return 0;
}

function wymusResetEsp32() {
  PropertiesService.getScriptProperties().setProperty("esp32_reset_tryb", "force");
  return { sukces: true, wiadomosc: "Przy nastepnym sprawdzeniu harmonogramu czytniki sie zresetuja (max ~30 min)." };
}

/** Recznie: tryb resetow. "auto" = wg harmonogramu, "off" = wcale. */
function ustawTrybResetowEsp32(tryb) {
  var t = String(tryb || "auto").toLowerCase();
  if (t !== "auto" && t !== "off") {
    return { sukces: false, wiadomosc: "Dozwolone wartosci: auto, off." };
  }
  PropertiesService.getScriptProperties().setProperty("esp32_reset_tryb", t);
  return { sukces: true, tryb: t, wiadomosc: "Tryb resetow: " + t };
}

/** Recznie: jednorazowa data resetu (ISO). Puste = usun. */
function ustawHarmonogramResetuEsp32(isoData) {
  var iso = String(isoData || "").trim();
  var props = PropertiesService.getScriptProperties();
  if (!iso) {
    props.deleteProperty("esp32_next_reset_iso");
    return { sukces: true, wiadomosc: "Usunieto jednorazowy termin - reset o domyslnej godzinie." };
  }
  var d = new Date(iso);
  if (isNaN(d.getTime())) {
    return { sukces: false, wiadomosc: "Zly format daty (oczekiwano ISO, np. 2026-09-24T03:00:00)." };
  }
  props.setProperty("esp32_next_reset_iso", d.toISOString());
  return { sukces: true, nextResetIso: d.toISOString() };
}

/** Recznie: domyslna godzina resetu dziennego, np. "03:00". */
function ustawGodzineResetuEsp32(godzinaTxt) {
  var g = String(godzinaTxt || "03:00").trim();
  if (!/^\d{1,2}:\d{2}$/.test(g)) {
    return { sukces: false, wiadomosc: "Format HH:MM, np. 03:00." };
  }
  PropertiesService.getScriptProperties().setProperty("esp32_reset_godzina", g);
  return { sukces: true, godzina: g };
}

/** Zbiorczy status dla UI (bezposredni powrot jako obiekt - wygodniejszy dla klienta JS). */
function getResetEsp32Status() {
  try {
    var res = JSON.parse(getHarmonogramResetu());
    var props = PropertiesService.getScriptProperties();
    res.godzina = String(props.getProperty("esp32_reset_godzina") || "03:00");
    try {
      var _hDzis = _HARMONOGRAM_RESETU_TYGODNIOWY[new Date().getDay()] || [];
      res.harmonogramDnia = _hDzis.join(", ");
    } catch (eH) {}
    res.jednorazowyIso = String(props.getProperty("esp32_next_reset_iso") || "");
    return res;
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

// ======================================================================

// ======================================================================

// ======================================================================


// ======================================================================
// ======================================================================
// PATCH-FIX-NIEOB-HOUR-2026-09
// ----------------------------------------------------------------------
// Precyzyjne dopasowanie wniosków o nieobecność po DACIE + GODZINIE.
// ----------------------------------------------------------------------

/** Wyciąga "HH:MM" z wartości komórki "Data dyżuru" (np. "Czwartek 24.09.2026, 08:00"). */
function _wyciagnijGodzineNieobecnosci(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return "";
  if (rawValue instanceof Date) {
    if (isNaN(rawValue.getTime())) return "";
    var hD = rawValue.getHours();
    var mD = rawValue.getMinutes();
    return (hD < 10 ? "0" : "") + hD + ":" + (mD < 10 ? "0" : "") + mD;
  }
  var s = String(rawValue).trim();
  if (!s) return "";
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  var hh = parseInt(m[1], 10);
  var mm = parseInt(m[2], 10);
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return "";
  return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
}

/** Zwraca true jeśli istnieje ZAAKCEPTOWANY wniosek o nieobecność dla (uid, dzienKey, godzinaKey).
 *  - Jeśli wniosek ma godzinę: pasuje TYLKO gdy godzinaKey === godzinaWniosku.
 *  - Jeśli wniosek nie ma godziny (stary format): pasuje dla całego dnia (backward compat).
 */
function _czyJestZaakceptowanaNieobecnoscDyzur(uid, dzienKey, godzinaKey) {
  try {
    var uidS = String(uid || "").trim();
    if (!uidS || !dzienKey) return false;
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Nieobecnosci_dyzur");
    if (!sheet || sheet.getLastRow() < 2) return false;
    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][1] || "").trim() !== uidS) continue;
      var st = String(dane[i][6] || "").trim().toLowerCase();
      if (st.indexOf("akcept") < 0) continue;
      var dKey = _parsujDateNieobecnosci(dane[i][3]);
      if (!dKey || dKey !== dzienKey) continue;
      var gKey = _wyciagnijGodzineNieobecnosci(dane[i][3]);
      if (!gKey) return true;   // całodniowa — akceptuj
      if (!godzinaKey) return true;
      if (gKey === godzinaKey) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}
// /PATCH-FIX-NIEOB-HOUR-2026-09


// ======================================================================
// PATCH-NADROB-CODE-2026-09 (v7)
// ======================================================================
var NADROB_KOD_TTL_MS = 5 * 60 * 1000;
var NADROB_DNI_MIN = 7;
var NADROB_DNI_MAX = 90;
var NADROB_DNI_DOMYSLNE = 30;

function _nadrobKodKey(userId) { return "nadrob_kod_" + String(userId || "").trim(); }

function generujKodPotwierdzeniaNadrabiania(wykonawcaId) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && String(uid) !== "2212") {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var kod = String(1000 + Math.floor(Math.random() * 9000));
    PropertiesService.getScriptProperties().setProperty(
      _nadrobKodKey(uid),
      JSON.stringify({ kod: kod, ts: Date.now() })
    );
    return { sukces: true, kod: kod, ttlMin: 5 };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function _nadrobKodWeryfikuj(uid, kodPodany) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_nadrobKodKey(uid));
  if (!raw) return { ok: false, wiadomosc: "Kod wygasł lub nie został wygenerowany." };
  var d;
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  if (!d || !d.kod || !d.ts) {
    props.deleteProperty(_nadrobKodKey(uid));
    return { ok: false, wiadomosc: "Kod nieprawidłowy." };
  }
  if (Date.now() - d.ts > NADROB_KOD_TTL_MS) {
    props.deleteProperty(_nadrobKodKey(uid));
    return { ok: false, wiadomosc: "Kod wygasł — zamknij i spróbuj ponownie." };
  }
  if (String(kodPodany || "").trim() !== String(d.kod)) {
    return { ok: false, wiadomosc: "Kod nieprawidłowy." };
  }
  props.deleteProperty(_nadrobKodKey(uid));
  return { ok: true };
}

function nadrobAutoMinusyZalegle(wykonawcaId, dniWstecz, kodPotwierdzenia) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && String(uid) !== "2212") {
      return { sukces: false, wiadomosc: "Brak uprawnień — tylko administrator." };
    }
    var w = _nadrobKodWeryfikuj(uid, kodPotwierdzenia);
    if (!w.ok) {
      try { _logAdmin(uid, "", "NADROB_AUTO_MINUSY_ODRZUCONE", "", "kod nieprawidłowy/wygasły"); } catch (eL) {}
      return { sukces: false, kodBledny: true, wiadomosc: w.wiadomosc };
    }
    var dni = parseInt(dniWstecz, 10);
    if (isNaN(dni) || dni < NADROB_DNI_MIN) dni = NADROB_DNI_DOMYSLNE;
    if (dni > NADROB_DNI_MAX) dni = NADROB_DNI_MAX;
    var t0 = Date.now();
    var wynik = naliczMinusyZaOpuszczoneDyzury(dni);
    var ms = Date.now() - t0;
    var naliczone = (wynik && wynik.naliczone) || 0;
    try { _logAdmin(uid, "", "NADROB_AUTO_MINUSY", "",
      "dni=" + dni + " naliczone=" + naliczone + " ms=" + ms); } catch (eL) {}
    return {
      sukces: true, naliczone: naliczone, dni: dni, ms: ms,
      wiadomosc: (naliczone === 0
        ? "Nic do nadrobienia — wszystkie zaległe minusy z ostatnich " + dni + " dni są już naliczone."
        : "Nadrobiono " + naliczone + " zaległych minusów (zakres: " + dni + " dni wstecz).")
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function getObecniNaDzien(dataIso) {
  try {
    var dataKey = String(dataIso || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataKey)) {
      return { sukces: false, wiadomosc: "Format: YYYY-MM-DD.", osoby: [], liczba: 0 };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = _APP_TZ;
    var mapaImion = {};
    try {
      var dk = _pobierzDaneKandydaci();
      for (var k = 1; k < dk.length; k++) {
        var kid = _normId(dk[k][0]);
        if (kid) mapaImion[kid] = String(dk[k][1] || "").trim() || kid;
      }
    } catch (eMap) {}
    var osoby = [], seen = {};
    var sheetL = ss.getSheetByName("Logi_czytnik");
    if (sheetL && sheetL.getLastRow() > 1) {
      var dL = sheetL.getDataRange().getValues();
      for (var i = 1; i < dL.length; i++) {
        var d = dL[i][0] instanceof Date ? dL[i][0] : new Date(dL[i][0]);
        if (isNaN(d.getTime())) continue;
        if (Utilities.formatDate(d, tz, "yyyy-MM-dd") !== dataKey) continue;
        var id = _normId(dL[i][1]);
        if (!id) continue;
        var hhmm = Utilities.formatDate(d, tz, "HH:mm");
        var kk = id + "|" + hhmm + "|RFID";
        if (seen[kk]) continue;
        seen[kk] = true;
        osoby.push({
          id: id, imie: String(dL[i][2] || mapaImion[id] || id).trim() || id,
          godzina: hhmm, wydarzenie: String(dL[i][4] || "").trim(),
          punkty: parseInt(dL[i][5], 10) || 0, zrodlo: "RFID"
        });
      }
    }
    var sheetR = ss.getSheetByName("Logi_ręczne");
    if (sheetR && sheetR.getLastRow() > 1) {
      var dR = sheetR.getDataRange().getValues();
      for (var j = 1; j < dR.length; j++) {
        var d2 = dR[j][0] instanceof Date ? dR[j][0] : new Date(dR[j][0]);
        if (isNaN(d2.getTime())) continue;
        if (Utilities.formatDate(d2, tz, "yyyy-MM-dd") !== dataKey) continue;
        var pkt = parseInt(dR[j][3], 10) || 0;
        if (pkt <= 0) continue;
        var id2 = _normId(dR[j][1]);
        if (!id2) continue;
        var hhmm2 = Utilities.formatDate(d2, tz, "HH:mm");
        var kk2 = id2 + "|" + hhmm2 + "|RECZNE";
        if (seen[kk2]) continue;
        seen[kk2] = true;
        osoby.push({
          id: id2, imie: mapaImion[id2] || id2, godzina: hhmm2,
          wydarzenie: String(dR[j][2] || "").trim(),
          punkty: pkt, zrodlo: "Ręczne"
        });
      }
    }
    osoby.sort(function(a, b) {
      var c = String(a.godzina).localeCompare(String(b.godzina));
      return c !== 0 ? c : String(a.imie).localeCompare(String(b.imie), "pl");
    });
    return { sukces: true, data: dataKey, osoby: osoby, liczba: osoby.length };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e), osoby: [], liczba: 0 };
  }
}
// /PATCH-NADROB-CODE-2026-09



// ======================================================================

// ======================================================================


// ======================================================================

// ======================================================================


// ======================================================================
// PASSA DYŻURÓW v3 — START BLOKU
// ----------------------------------------------------------------------
// POPRAWKA v3 (2026-09):
//   • Obecność liczona jest przez porównanie KONKRETNEGO dyżuru z arkusza
//     Dyżury (kolumna A „Data i Godzina", np. 2026-09-21 07:00) z wpisem
//     w Logi_czytnik / Logi_ręczne tego samego dnia w oknie ±45 min.
//   • Sam fakt bycia w innym dniu tego samego tygodnia NIE zalicza dyżuru.
//   • Grupowanie per tydzień (pon–nd) — dla passy max +1 na tydzień.
//   • Niedziele (dzień tygodnia 0) pomijane.
//
// Priorytet stanu tygodnia:
//   1. nadpisanie admina    (ScriptProperties passa_override_<uid>)
//   2. log RFID dyżuru      (dopasowanie po dacie+godzinie ±45 min)
//   3. zaakceptowany wniosek o nieobecność
//   4. brak wszystkiego     → nieobecnosc
//
// Nadpisanie „obecnosc” dodaje +4 pkt raz na tydzień (marker PASSA_OVERRIDE).
// ======================================================================

var PASSA_OVERRIDE_MARKER_V3 = "PASSA_OVERRIDE";
var PASSA_CACHE_TTL_V3 = 300;
var PASSA_OKNO_MINUT_V3 = 45;

function _passaCacheKeyV3(uid) {
  return "passa_v3_" + _passaResetVerGAS() + "_" + String(uid || "").trim();
}
function _passaInvalidateV3(uid) {
  try { CacheService.getScriptCache().remove(_passaCacheKeyV3(uid)); } catch (e) {}
}

function _poniedzialekZKluczaV3(klucz) {
  var m = String(klucz || "").match(/^(\d{4})-W(\d{1,2})$/);
  if (!m) return null;
  var y = parseInt(m[1], 10);
  var d = new Date(y, 0, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  for (var i = 0; i < 60; i++) {
    if (_kluczTygodnia(d) === klucz) return new Date(d.getTime());
    d.setDate(d.getDate() + 7);
  }
  return null;
}

function _pobierzNadpisaniaPassyV3(userId) {
  try {
    var raw = PropertiesService.getScriptProperties()
      .getProperty("passa_override_" + String(userId).trim());
    if (!raw) return {};
    var m = JSON.parse(raw);
    return (m && typeof m === "object") ? m : {};
  } catch (e) { return {}; }
}

function _zapiszNadpisaniaPassyV3(userId, mapa) {
  try {
    var key = "passa_override_" + String(userId).trim();
    var props = PropertiesService.getScriptProperties();
    if (!mapa || Object.keys(mapa).length === 0) props.deleteProperty(key);
    else props.setProperty(key, JSON.stringify(mapa));
    _passaInvalidateV3(userId);
  } catch (e) {}
}

function _czyWpisJestObecnosciaDyzuruV3(nazwaWydarzenia) {
  var n = String(nazwaWydarzenia || "").toLowerCase();
  if (!n) return false;
  if (n.indexOf("dyżur") < 0 && n.indexOf("dyzur") < 0) return false;
  var wykluczone = ["nieobecn", "minus", "kara", "przewinien", "przerwa",
                    "passa_override", "passą_override", "nadpisanie admina"];
  for (var i = 0; i < wykluczone.length; i++) {
    if (n.indexOf(wykluczone[i]) >= 0) return false;
  }
  return true;
}

/**
 * Główna funkcja passy v3.
 * Dopasowuje dyżury z arkusza Dyżury do logów RFID po konkretnej dacie i godzinie.
 */
function getPassaDyzuru(userId) {
  try {
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: true, passa: 0, szczegoly: [], historia: [] };

    try {
      var c = CacheService.getScriptCache().get(_passaCacheKeyV3(uid));
      if (c) { var p = JSON.parse(c); if (p && p.sukces) return p; }
    } catch (eC) {}

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = _APP_TZ;

    // ── 1) Wszystkie dyżury tej osoby (bez niedziel) ──────────────
    // Każdy dyżur: { data, godzina (HH:mm), ts, kluczTygodnia, dzien }
    var dyzury = [];
    var sheetD = ss.getSheetByName("Dyżury");
    if (sheetD && sheetD.getLastRow() > 1) {
      var dD = sheetD.getDataRange().getValues();
      for (var i = 1; i < dD.length; i++) {
        if (String(dD[i][2] || "").trim() !== uid) continue;
        var d = dD[i][0] instanceof Date ? dD[i][0] : new Date(dD[i][0]);
        if (isNaN(d.getTime())) continue;
        var wd = d.getDay();
        if (wd === 0) continue; // niedziela — pomijamy

        // Sprawdź, czy dyżur obowiązywał w dniu jego wystąpienia (kol. D/E)
        // (żeby nie liczyć starych, zamkniętych okresów)
        var odRaw = dD[i][3];
        var doRaw = dD[i][4];
        var odKey = "", doKey = "";
        if (odRaw) {
          var odD = odRaw instanceof Date ? odRaw : new Date(odRaw);
          if (!isNaN(odD.getTime())) odKey = Utilities.formatDate(odD, tz, "yyyy-MM-dd");
        }
        if (doRaw) {
          var doD = doRaw instanceof Date ? doRaw : new Date(doRaw);
          if (!isNaN(doD.getTime())) doKey = Utilities.formatDate(doD, tz, "yyyy-MM-dd");
        }
        var dzienKey = Utilities.formatDate(d, tz, "yyyy-MM-dd");
        if (odKey && dzienKey < odKey) continue;
        if (doKey && dzienKey > doKey) continue;

        dyzury.push({
          data: d,
          dataKey: dzienKey,
          godzinaH: d.getHours(),
          godzinaM: d.getMinutes(),
          ts: d.getTime(),
          kluczTygodnia: _kluczTygodnia(d),
          poniedzialek: _poniedzialekTygodnia(d),
          dopasowany: false
        });
      }
    }

    // ── 2) Wszystkie logi obecności tej osoby (z konkretnym timestampem) ──
    // Zachowujemy pełne Date, żeby porównać z dyżurem po dacie+godzinie.
    var logi = [];
    function skan(rows, colData, colId, colNazwa, colOpis) {
      for (var r = 1; r < rows.length; r++) {
        if (String(rows[r][colId] || "").trim() !== uid) continue;
        var ld = rows[r][colData] instanceof Date ? rows[r][colData] : new Date(rows[r][colData]);
        if (isNaN(ld.getTime())) continue;
        if (!_czyWpisJestObecnosciaDyzuruV3(rows[r][colNazwa])) continue;
        if (colOpis != null && rows[r].length > colOpis) {
          var op = String(rows[r][colOpis] || "").toLowerCase();
          if (op.indexOf("passa_override") >= 0 || op.indexOf("passą_override") >= 0) continue;
        }
        logi.push({ ts: ld.getTime() });
      }
    }
    var sheetL = ss.getSheetByName("Logi_czytnik");
    if (sheetL && sheetL.getLastRow() > 1) skan(sheetL.getDataRange().getValues(), 0, 1, 4, null);
    var sheetR = ss.getSheetByName("Logi_ręczne");
    if (sheetR && sheetR.getLastRow() > 1) skan(sheetR.getDataRange().getValues(), 0, 1, 2, 4);

    // ── 3) Dopasuj każdy dyżur do najbliższego logu w oknie ±45 min ──
    var oknoMs = PASSA_OKNO_MINUT_V3 * 60 * 1000;
    dyzury.forEach(function(dz) {
      var targetTs = dz.ts;
      for (var i = 0; i < logi.length; i++) {
        if (Math.abs(logi[i].ts - targetTs) <= oknoMs) {
          dz.dopasowany = true;
          return;
        }
      }
    });

    // ── 4) Grupowanie dyżurów per tydzień ─────────────────────────
    var tygodnie = {}; // klucz -> { poniedzialek, dyzury: [..] }
    dyzury.forEach(function(dz) {
      var kw = dz.kluczTygodnia;
      if (!kw) return;
      if (!tygodnie[kw]) {
        tygodnie[kw] = { poniedzialek: dz.poniedzialek, dyzury: [] };
      }
      tygodnie[kw].dyzury.push(dz);
    });

    // ── 5) Zaakceptowane wnioski o nieobecność (per tydzień) ──────
    var wnioskiUsprawiedliwione = {};
    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    if (sheetN && sheetN.getLastRow() > 1) {
      var dN = sheetN.getDataRange().getValues();
      for (var j = 1; j < dN.length; j++) {
        if (String(dN[j][1] || "").trim() !== uid) continue;
        var st = String(dN[j][6] || "").toLowerCase();
        if (st.indexOf("akcept") < 0) continue;
        var dn = dN[j][3] instanceof Date ? dN[j][3] : new Date(dN[j][3]);
        if (isNaN(dn.getTime())) {
          dn = dN[j][0] instanceof Date ? dN[j][0] : new Date(dN[j][0]);
        }
        if (isNaN(dn.getTime())) continue;
        var kwN = _kluczTygodnia(dn);
        if (kwN) wnioskiUsprawiedliwione[kwN] = true;
      }
    }

    // ── 6) Nadpisania admina ─────────────────────────────────────
    var nadpisania = _pobierzNadpisaniaPassyV3(uid);

    // Dodaj tygodnie z nadpisań, których nie ma w dyżurach (np. po zamknięciu roku)
    Object.keys(nadpisania).forEach(function(k) {
      if (!tygodnie[k]) {
        var pon = _poniedzialekZKluczaV3(k);
        if (pon) tygodnie[k] = { poniedzialek: pon, dyzury: [] };
      }
    });

    // >>> RESET PASSY: filtruj tygodnie przed pierwszym poniedziałkiem po resecie.
    try {
      var _resetIso = _passaResetIsoGAS();
      if (_resetIso) {
        var _resetDate = new Date(_resetIso);
        if (!isNaN(_resetDate.getTime())) {
          var _ponReset = _poniedzialekTygodnia(_resetDate);
          var _firstActiveMon = new Date(_ponReset.getTime() + 7 * 24 * 3600 * 1000);
          Object.keys(tygodnie).forEach(function(k) {
            if (tygodnie[k].poniedziałek.getTime() < _firstActiveMon.getTime()) {
              delete tygodnie[k];
            }
          });
        }
      }
    } catch (eRes) {}

    var klucze = Object.keys(tygodnie);
    if (klucze.length === 0) {
      var puste = { sukces: true, passa: 0, szczegoly: [], historia: [], przerwanaNa: null };
      try { CacheService.getScriptCache().put(_passaCacheKeyV3(uid), JSON.stringify(puste), PASSA_CACHE_TTL_V3); } catch (eP) {}
      return puste;
    }

    var kwTeraz = _kluczTygodnia(new Date());
    var historiaPelna = [];
    klucze.forEach(function(kw) {
      var ty = tygodnie[kw];
      var stan, zrodloStan;

      // 1) nadpisanie admina
      if (nadpisania[kw]) {
        stan = String(nadpisania[kw]).toLowerCase();
        if (stan !== "obecnosc" && stan !== "nieobecnosc" && stan !== "usprawiedliwiona") {
          stan = "nieobecnosc";
        }
        zrodloStan = "nadpisanie";
      }
      // 2) log RFID dopasowany do konkretnego dyżuru
      else if (ty.dyzury.some(function(d) { return d.dopasowany; })) {
        stan = "obecnosc"; zrodloStan = "log";
      }
      // 3) zaakceptowany wniosek
      else if (wnioskiUsprawiedliwione[kw]) {
        stan = "usprawiedliwiona"; zrodloStan = "wniosek";
      }
      // 4) brak — ale jeśli w tym tygodniu nie ma w ogóle dyżuru, to nie karzemy
      else if (ty.dyzury.length === 0) {
        stan = "brak_dyzuru"; zrodloStan = "brak";
      }
      // 5) brak — dyżur był, nikt nie odbił
      else {
        stan = "nieobecnosc"; zrodloStan = "brak";
      }

      historiaPelna.push({
        klucz: kw,
        etykieta: _etykietaZakresuTygodnia(ty.poniedzialek),
        poniedzialek: ty.poniedzialek,
        stan: stan,
        zrodloStan: zrodloStan,
        ok: (stan === "obecnosc" || stan === "usprawiedliwiona"),
        zrodlo: (stan === "obecnosc") ? "dyzur"
              : (stan === "usprawiedliwiona") ? "nieobecnosc"
              : "",
        biezacy: (kw === kwTeraz)
      });
    });

    historiaPelna.sort(function(a, b) { return b.poniedzialek.getTime() - a.poniedzialek.getTime(); });

    // ── 7) Oblicz passę ──────────────────────────────────────────
    var passa = 0;
    var szczegoly = [];
    var przerwanaNa = null;
    for (var k = 0; k < historiaPelna.length; k++) {
      var h = historiaPelna[k];
      if (h.stan === "obecnosc") { passa++; szczegoly.push(h.klucz); }
      else if (h.stan === "usprawiedliwiona") { szczegoly.push(h.klucz); }
      else if (h.stan === "brak_dyzuru") { continue; } // pomijamy tygodnie bez dyżuru
      else {
        if (h.biezacy) continue;
        przerwanaNa = k;
        break;
      }
    }

    var wynik = {
      sukces: true,
      passa: passa,
      passa_reset_iso: _passaResetIsoGAS(),
      szczegoly: szczegoly,
      przerwanaNa: przerwanaNa,
      historia: historiaPelna.map(function(h) {
        return {
          klucz: h.klucz,
          etykieta: h.etykieta,
          stan: h.stan,
          zrodloStan: h.zrodloStan,
          ok: h.ok,
          zrodlo: h.zrodlo,
          biezacy: h.biezacy
        };
      })
    };
    try { CacheService.getScriptCache().put(_passaCacheKeyV3(uid), JSON.stringify(wynik), PASSA_CACHE_TTL_V3); } catch (eP2) {}
    return wynik;
  } catch (e) {
    return { sukces: false, passa: 0, szczegoly: [], historia: [],
             wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function ustawPasseRecznie(userId, kluczTygodnia, stan, adminId) {
  try {
    var uid = String(userId || "").trim();
    var kw  = String(kluczTygodnia || "").trim();
    var st  = String(stan || "").toLowerCase();
    var exec = String(adminId || "").trim();

    var rola = _normalizujRole(pobierzRoleUzytkownika(exec));
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Tylko administrator." };
    if (!uid || !kw) return { sukces: false, wiadomosc: "Brak danych." };
    if (st !== "obecnosc" && st !== "nieobecnosc" && st !== "usprawiedliwiona") {
      return { sukces: false, wiadomosc: "Nieprawidłowy stan." };
    }
    if (!/^\d{4}-W\d{1,2}$/.test(kw)) return { sukces: false, wiadomosc: "Zły klucz tygodnia." };

    var mapa = _pobierzNadpisaniaPassyV3(uid);
    var poprzedni = String(mapa[kw] || "");
    if (poprzedni === st) return { sukces: true, wiadomosc: "Już ustawione.", bezZmian: true };

    mapa[kw] = st;
    _zapiszNadpisaniaPassyV3(uid, mapa);

    if (st === "obecnosc") _dodajWpisOverridePassyV3(uid, kw, exec);
    else _usunWpisOverridePassyV3(uid, kw);

    try { _logAdmin(exec, "", "PASSA_OVERRIDE", uid,
                     kw + " -> " + st + (poprzedni ? (" (z " + poprzedni + ")") : "")); } catch (eL) {}

    return { sukces: true, userId: uid, klucz: kw, stan: st,
             wiadomosc: "Zapisano: " + kw + " → " + st };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function usunPasseRecznie(userId, kluczTygodnia, adminId) {
  try {
    var uid = String(userId || "").trim();
    var kw  = String(kluczTygodnia || "").trim();
    var exec = String(adminId || "").trim();
    var rola = _normalizujRole(pobierzRoleUzytkownika(exec));
    if (rola !== "ADMIN") return { sukces: false, wiadomosc: "Tylko administrator." };
    if (!uid || !kw) return { sukces: false, wiadomosc: "Brak danych." };

    var mapa = _pobierzNadpisaniaPassyV3(uid);
    if (!mapa[kw]) return { sukces: true, wiadomosc: "Brak nadpisania.", bezZmian: true };
    var poprzedni = String(mapa[kw]);
    delete mapa[kw];
    _zapiszNadpisaniaPassyV3(uid, mapa);
    if (poprzedni === "obecnosc") _usunWpisOverridePassyV3(uid, kw);
    try { _logAdmin(exec, "", "PASSA_OVERRIDE_USUN", uid, kw + " (był " + poprzedni + ")"); } catch (e) {}
    return { sukces: true, wiadomosc: "Nadpisanie usunięte (" + kw + ")." };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function getListaPasAdmin(adminId) {
  try {
    var exec = String(adminId || "").trim();
    var rola = _normalizujRole(pobierzRoleUzytkownika(exec));
    if (rola !== "ADMIN") return { sukces: false, lista: [], wiadomosc: "Tylko administrator." };

    var kand = _pobierzDaneKandydaci();
    var lista = [];
    for (var i = 1; i < kand.length; i++) {
      var id = String(kand[i][0] || "").trim();
      if (!id) continue;
      var ranga = String(kand[i][6] || "").trim();
      if (ranga.toLowerCase().indexOf("ksi") === 0) continue;
      var imie = String(kand[i][1] || "").trim() || id;
      var p = getPassaDyzuru(id);
      lista.push({
        id: id, imie: imie, ranga: ranga,
        passa: (p && p.sukces) ? (parseInt(p.passa, 10) || 0) : 0
      });
    }
    lista.sort(function(a, b) {
      if (b.passa !== a.passa) return b.passa - a.passa;
      return String(a.imie).localeCompare(String(b.imie), "pl");
    });
    return { sukces: true, lista: lista, razem: lista.length };
  } catch (e) {
    return { sukces: false, lista: [], wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function getHistoriaPasAdmin(adminId, userId) {
  try {
    var exec = String(adminId || "").trim();
    var rola = _normalizujRole(pobierzRoleUzytkownika(exec));
    if (rola !== "ADMIN") return { sukces: false, tygodnie: [], wiadomosc: "Tylko administrator." };
    var uid = String(userId || "").trim();
    if (!uid) return { sukces: false, tygodnie: [], wiadomosc: "Brak ID." };

    var p = getPassaDyzuru(uid);
    if (!p || !p.sukces) return { sukces: false, tygodnie: [], wiadomosc: (p && p.wiadomosc) || "Błąd." };

    var imie = uid;
    try {
      var kand = _pobierzDaneKandydaci();
      for (var i = 1; i < kand.length; i++) {
        if (String(kand[i][0]).trim() === uid) {
          imie = String(kand[i][1] || "").trim() || uid;
          break;
        }
      }
    } catch (eK) {}

    return {
      sukces: true, userId: uid, imie: imie,
      passa: parseInt(p.passa, 10) || 0,
      tygodnie: p.historia || []
    };
  } catch (e) {
    return { sukces: false, tygodnie: [], wiadomosc: String(e && e.message ? e.message : e) };
  }
}

// ── Wpisy punktowe dla nadpisania „obecnosc” (v3, dedup) ─────────────

function _dodajWpisOverridePassyV3(userId, klucz, adminId) {
  try {
    var uid = String(userId || "").trim();
    var marker = PASSA_OVERRIDE_MARKER_V3 + "|" + klucz + "|" + uid;
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    var sheetR = ss.getSheetByName("Logi_ręczne");
    if (!sheetR) {
      sheetR = ss.insertSheet("Logi_ręczne");
      sheetR.appendRow(["Data","ID","Wydarzenie","Punkty","Opis","Wykonawca ID","Wykonawca Imię"]);
    }
    _upewnijSieOKolumnyWykonawcy(sheetR);
    var dR = sheetR.getDataRange().getValues();
    for (var j = 1; j < dR.length; j++) {
      if (String(dR[j][1] || "").trim() !== uid) continue;
      if (String(dR[j][4] || "").indexOf(marker) >= 0) return;
    }

    // Sprawdź, czy jest już prawdziwy log RFID na któryś dyżur tego tygodnia
    var sheetD = ss.getSheetByName("Dyżury");
    var dyzuryTygodnia = [];
    if (sheetD && sheetD.getLastRow() > 1) {
      var dD = sheetD.getDataRange().getValues();
      for (var k = 1; k < dD.length; k++) {
        if (String(dD[k][2] || "").trim() !== uid) continue;
        var dd = dD[k][0] instanceof Date ? dD[k][0] : new Date(dD[k][0]);
        if (isNaN(dd.getTime())) continue;
        if (_kluczTygodnia(dd) !== klucz) continue;
        dyzuryTygodnia.push(dd.getTime());
      }
    }
    if (dyzuryTygodnia.length > 0) {
      var sheetL = ss.getSheetByName("Logi_czytnik");
      if (sheetL && sheetL.getLastRow() > 1) {
        var dL = sheetL.getDataRange().getValues();
        var oknoMs = PASSA_OKNO_MINUT_V3 * 60 * 1000;
        for (var i = 1; i < dL.length; i++) {
          if (String(dL[i][1] || "").trim() !== uid) continue;
          if (!_czyWpisJestObecnosciaDyzuruV3(dL[i][4])) continue;
          var ld = dL[i][0] instanceof Date ? dL[i][0] : new Date(dL[i][0]);
          if (isNaN(ld.getTime())) continue;
          for (var q = 0; q < dyzuryTygodnia.length; q++) {
            if (Math.abs(ld.getTime() - dyzuryTygodnia[q]) <= oknoMs) return; // log już jest
          }
        }
      }
    }

    var pon = _poniedzialekZKluczaV3(klucz) || new Date();
    var dataWpisu = new Date(pon.getTime());
    dataWpisu.setHours(7, 0, 0, 0);

sheetR.appendRow([
  dataWpisu, uid, "Dyżur (nadpisanie admina)", _PKT.DYZUR, marker,
  String(adminId || "").trim(), ""
]);
    try { przeliczPunktyUzytkownika(uid); } catch (e) {}
  } catch (e) {
    try { Logger.log("dodajWpisOverridePassyV3: " + e); } catch (e2) {}
  }
}

function _usunWpisOverridePassyV3(userId, klucz) {
  try {
    var uid = String(userId || "").trim();
    var marker = PASSA_OVERRIDE_MARKER_V3 + "|" + klucz + "|" + uid;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetR = ss.getSheetByName("Logi_ręczne");
    if (!sheetR || sheetR.getLastRow() < 2) return;
    var dR = sheetR.getDataRange().getValues();
    var usunieto = 0;
    for (var j = dR.length - 1; j >= 1; j--) {
      if (String(dR[j][1] || "").trim() !== uid) continue;
      if (String(dR[j][4] || "").indexOf(marker) < 0) continue;
      try { sheetR.deleteRow(j + 1); usunieto++; } catch (eD) {}
    }
    if (usunieto > 0) { try { przeliczPunktyUzytkownika(uid); } catch (eP) {} }
  } catch (e) {
    try { Logger.log("usunWpisOverridePassyV3: " + e); } catch (e2) {}
  }
}

// ======================================================================
// PASSA DYŻURÓW v3 — KONIEC BLOKU
// ======================================================================



// ======================================================================
// RESET PASSY (v1) — START BLOKU
// ----------------------------------------------------------------------
// Admin może wyzerować passę WSZYSTKIM.
// • Zapisuje się data resetu w ScriptProperties (passa_reset_iso).
// • Tydzień, w którym nastąpił reset, jest POMIJANY — passa startuje od
//   poniedziałku następnego tygodnia.
// • CacheService jest wersjonowany (passa_reset_ver) — po resecie stare
//   cache'e są porzucane, więc zmiana widoczna jest od razu.
// • Wymaga kodu 4-cyfrowego (5 min TTL) — generowanego przez
//   generujKodPotwierdzeniaResetuPassy().
// ======================================================================

var PASSA_RESET_ISO_KEY = "passa_reset_iso";
var PASSA_RESET_VER_KEY = "passa_reset_ver";
var PASSA_RESET_KOD_TTL_MS = 5 * 60 * 1000;

function _passaResetVerGAS() {
  try { return String(PropertiesService.getScriptProperties().getProperty(PASSA_RESET_VER_KEY) || "0"); }
  catch (e) { return "0"; }
}

function _passaResetIsoGAS() {
  try { return String(PropertiesService.getScriptProperties().getProperty(PASSA_RESET_ISO_KEY) || ""); }
  catch (e) { return ""; }
}

function _passaResetKodKey(uid) { return "passa_reset_kod_" + String(uid || "").trim(); }

function generujKodPotwierdzeniaResetuPassy(adminId) {
  try {
    var uid = _normId(adminId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var kod = String(1000 + Math.floor(Math.random() * 9000));
    PropertiesService.getScriptProperties().setProperty(
      _passaResetKodKey(uid),
      JSON.stringify({ kod: kod, ts: Date.now() })
    );
    return { sukces: true, kod: kod, ttlMin: 5 };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function _passaResetKodWeryfikuj(uid, kodPodany) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_passaResetKodKey(uid));
  if (!raw) return { ok: false, wiadomosc: "Kod wygasł — zamknij i spróbuj ponownie." };
  var d;
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  if (!d || !d.kod || !d.ts) {
    props.deleteProperty(_passaResetKodKey(uid));
    return { ok: false, wiadomosc: "Kod nieprawidłowy." };
  }
  if (Date.now() - d.ts > PASSA_RESET_KOD_TTL_MS) {
    props.deleteProperty(_passaResetKodKey(uid));
    return { ok: false, wiadomosc: "Kod wygasł — zamknij i spróbuj ponownie." };
  }
  if (String(kodPodany || "").trim() !== String(d.kod)) {
    return { ok: false, wiadomosc: "Kod nieprawidłowy." };
  }
  props.deleteProperty(_passaResetKodKey(uid));
  return { ok: true };
}

/**
 * Główna funkcja resetu. Ustawia data resetu i inkrementuje wersję cache.
 * Zwraca info o pierwszym aktywnym poniedziałku.
 */
function wyzerujPasseWszystkim(adminId, kodPotwierdzenia) {
  try {
    var uid = _normId(adminId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") {
      return { sukces: false, wiadomosc: "Brak uprawnień — tylko administrator." };
    }
    var w = _passaResetKodWeryfikuj(uid, kodPotwierdzenia);
    if (!w.ok) {
      try { _logAdmin(uid, "", "PASSA_RESET_ODRZUCONE", "", "kod nieprawidłowy/wygasły"); } catch (eL) {}
      return { sukces: false, kodBledny: true, wiadomosc: w.wiadomosc };
    }

    var props = PropertiesService.getScriptProperties();
    var teraz = new Date();
    var iso = teraz.toISOString();
    props.setProperty(PASSA_RESET_ISO_KEY, iso);

    var ver = parseInt(props.getProperty(PASSA_RESET_VER_KEY) || "0", 10) || 0;
    props.setProperty(PASSA_RESET_VER_KEY, String(ver + 1));

    try { _logAdmin(uid, "", "PASSA_RESET_ALL", "", "reset na " + iso); } catch (eL2) {}

    var ponReset = _poniedzialekTygodnia(teraz);
    var firstActiveMon = new Date(ponReset.getTime() + 7 * 24 * 3600 * 1000);
    var dataPl = Utilities.formatDate(firstActiveMon, _APP_TZ, "dd.MM.yyyy");

    return {
      sukces: true,
      resetIso: iso,
      firstActiveMonday: firstActiveMon.getTime(),
      firstActiveMondayPl: dataPl,
      wiadomosc: "Passa wyzerowana dla wszystkich. Nowe liczenie od " +
                 dataPl + " (poniedziałek)."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

/** Info o ostatnim resecie — dla UI panelu. */
function getPassaResetInfo(adminId) {
  try {
    var uid = _normId(adminId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") return { sukces: false };

    var iso = _passaResetIsoGAS();
    if (!iso) return { sukces: true, aktywny: false };
    var d = new Date(iso);
    if (isNaN(d.getTime())) return { sukces: true, aktywny: false };

    var ponReset = _poniedzialekTygodnia(d);
    var firstActiveMon = new Date(ponReset.getTime() + 7 * 24 * 3600 * 1000);

    return {
      sukces: true,
      aktywny: true,
      resetIso: iso,
      resetPl: Utilities.formatDate(d, _APP_TZ, "dd.MM.yyyy HH:mm"),
      firstActiveMondayPl: Utilities.formatDate(firstActiveMon, _APP_TZ, "dd.MM.yyyy")
    };
  } catch (e) {
    return { sukces: false };
  }
}

// ======================================================================
// RESET PASSY (v1) — KONIEC BLOKU
// ======================================================================


// ======================================================================
// RESET PUNKTÓW (v1) — START BLOKU
// ----------------------------------------------------------------------
// Analogicznie do resetu passy, ale punkty zaczynają liczyć się OD RAZU
// po resecie (bez pomijania bieżącego tygodnia).
//
// • Data resetu zapisana w ScriptProperties: "punkty_reset_iso".
// • przerabiamy przeliczPunktyUzytkownika() — pomija logi sprzed resetu.
// • Kandydaci kolumna C jest ustawiana na aktualną (wyzerowaną) sumę.
// • Wymaga kodu 4-cyfrowego (5 min TTL) — generowanego przez
//   generujKodPotwierdzeniaResetuPunktow().
// ======================================================================

var PUNKTY_RESET_ISO_KEY = "punkty_reset_iso";
var PUNKTY_RESET_VER_KEY = "punkty_reset_ver";
var PUNKTY_RESET_KOD_TTL_MS = 5 * 60 * 1000;

function _punktyResetIsoGAS() {
  try {
    return String(
      PropertiesService.getScriptProperties().getProperty(PUNKTY_RESET_ISO_KEY) || ""
    );
  } catch (e) { return ""; }
}

function _punktyResetTs() {
  var iso = _punktyResetIsoGAS();
  if (!iso) return 0;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  return d.getTime();
}

function _punktyResetKodKey(uid) {
  return "punkty_reset_kod_" + String(uid || "").trim();
}

function generujKodPotwierdzeniaResetuPunktow(adminId) {
  try {
    var uid = _normId(adminId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var kod = String(1000 + Math.floor(Math.random() * 9000));
    PropertiesService.getScriptProperties().setProperty(
      _punktyResetKodKey(uid),
      JSON.stringify({ kod: kod, ts: Date.now() })
    );
    return { sukces: true, kod: kod, ttlMin: 5 };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

function _punktyResetKodWeryfikuj(uid, kodPodany) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_punktyResetKodKey(uid));
  if (!raw) return { ok: false, wiadomosc: "Kod wygasł — zamknij i spróbuj ponownie." };
  var d;
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  if (!d || !d.kod || !d.ts) {
    props.deleteProperty(_punktyResetKodKey(uid));
    return { ok: false, wiadomosc: "Kod nieprawidłowy." };
  }
  if (Date.now() - d.ts > PUNKTY_RESET_KOD_TTL_MS) {
    props.deleteProperty(_punktyResetKodKey(uid));
    return { ok: false, wiadomosc: "Kod wygasł — zamknij i spróbuj ponownie." };
  }
  if (String(kodPodany || "").trim() !== String(d.kod)) {
    return { ok: false, wiadomosc: "Kod nieprawidłowy." };
  }
  props.deleteProperty(_punktyResetKodKey(uid));
  return { ok: true };
}

/**
 * Główna funkcja resetu punktów dla wszystkich.
 * Ustawia znacznik czasu i przelicza wszystkich — punkty z logów
 * sprzed resetu są pomijane.
 */
function wyzerujPunktyWszystkim(adminId, kodPotwierdzenia) {
  try {
    var uid = _normId(adminId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") {
      return { sukces: false, wiadomosc: "Brak uprawnień — tylko administrator." };
    }
    var w = _punktyResetKodWeryfikuj(uid, kodPotwierdzenia);
    if (!w.ok) {
      try { _logAdmin(uid, "", "PUNKTY_RESET_ODRZUCONE", "", "kod nieprawidłowy/wygasły"); } catch (eL) {}
      return { sukces: false, kodBledny: true, wiadomosc: w.wiadomosc };
    }

    var props = PropertiesService.getScriptProperties();
    var iso = new Date().toISOString();
    props.setProperty(PUNKTY_RESET_ISO_KEY, iso);

    var ver = parseInt(props.getProperty(PUNKTY_RESET_VER_KEY) || "0", 10) || 0;
    props.setProperty(PUNKTY_RESET_VER_KEY, String(ver + 1));

    // Przelicz WSZYSTKICH na nowo (z uwzględnieniem filtra resetu).
    var przeliczono = 0;
    try {
      var kand = _pobierzDaneKandydaci();
      for (var i = 1; i < kand.length; i++) {
        var kid = _normId(kand[i][0]);
        if (!kid) continue;
        try {
          przeliczPunktyUzytkownika(kid);
          przeliczono++;
        } catch (eP) {}
      }
    } catch (eK) {}

    try {
      _logAdmin(uid, "", "PUNKTY_RESET_ALL", "",
                "reset na " + iso + " (przeliczono " + przeliczono + ")");
    } catch (eL2) {}

    return {
      sukces: true,
      resetIso: iso,
      przeliczono: przeliczono,
      wiadomosc: "Punkty wyzerowane dla wszystkich (" + przeliczono +
                 " osób). Zbieranie od teraz."
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e && e.message ? e.message : e) };
  }
}

/** Info o ostatnim resecie punktów — dla UI panelu. */
function getPunktyResetInfo(adminId) {
  try {
    var uid = _normId(adminId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN") return { sukces: false };
    var iso = _punktyResetIsoGAS();
    if (!iso) return { sukces: true, aktywny: false };
    var d = new Date(iso);
    if (isNaN(d.getTime())) return { sukces: true, aktywny: false };
    return {
      sukces: true,
      aktywny: true,
      resetIso: iso,
      resetPl: Utilities.formatDate(d, _APP_TZ, "dd.MM.yyyy HH:mm")
    };
  } catch (e) {
    return { sukces: false };
  }
}

// ======================================================================
// RESET PUNKTÓW (v1) — KONIEC BLOKU
// ======================================================================

// ======================================================================
// STATYSTYKI — punkty ministranta wg okresu i typu
// ======================================================================
function _pasujeDoTypuPunktow(nazwa, filtr) {
  if (!filtr || filtr === "wszystkie") return true;
  var n = String(nazwa || "").toLowerCase();
  if (filtr === "dyzur") return n.indexOf("dyżur") >= 0 || n.indexOf("dyzur") >= 0;
  if (filtr === "msza_nd") return n.indexOf("msza") >= 0 && n.indexOf("niedziel") >= 0;
  if (filtr === "msza_td") return n.indexOf("msza") >= 0 && n.indexOf("niedziel") < 0;
  if (filtr === "uroczystosc") return n.indexOf("uroczyst") >= 0;
  if (filtr === "zbiorka") return n.indexOf("zbiór") >= 0 || n.indexOf("zbiork") >= 0;
  if (filtr === "rozaniec") return n.indexOf("różan") >= 0 || n.indexOf("rozan") >= 0;
  if (filtr === "droga") return n.indexOf("droga") >= 0;
  if (filtr === "nabozenstwo") return (n.indexOf("naboże") >= 0 || n.indexOf("naboze") >= 0);
  if (filtr === "kary") return n.indexOf("nieobecn") >= 0 || n.indexOf("nieuspraw") >= 0 || n.indexOf("kara") >= 0 || n.indexOf("przewinien") >= 0;
  if (filtr === "dodatkowe") return n.indexOf("dodatk") >= 0 || n.indexOf("pomoc") >= 0 || n.indexOf("porząd") >= 0 || n.indexOf("porzad") >= 0 || n.indexOf("liturgii") >= 0;
  return true;
}

function getPunktyMinistrantaZakres(wykonawcaId, ministerId, odIso, doIso, typFiltr) {
  try {
    var execId = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(execId));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && rola !== "KSIADZ") {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var celId = _normId(ministerId);
    if (!celId) return { sukces: false, wiadomosc: "Wybierz ministranta." };

    var zakres = _parseZakresStat(odIso, doIso);
    var od = zakres.od, do_ = zakres.do_;
    var filtr = String(typFiltr || "wszystkie").trim().toLowerCase();

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = _APP_TZ;
    var wpisy = [];
    var suma = 0;

    var shC = ss.getSheetByName("Logi_czytnik");
    if (shC && shC.getLastRow() > 1) {
      var dC = shC.getDataRange().getValues();
      for (var i = 1; i < dC.length; i++) {
        if (String(dC[i][1] || "").trim() !== celId) continue;
        var d = dC[i][0] instanceof Date ? dC[i][0] : new Date(dC[i][0]);
        if (isNaN(d.getTime()) || !_dataWZakresie(d, od, do_)) continue;
        var nazwa = String(dC[i][4] || "");
        if (!_pasujeDoTypuPunktow(nazwa, filtr)) continue;
        var pkt = parseInt(dC[i][5], 10) || 0;
        wpisy.push({
          data: Utilities.formatDate(d, tz, "dd.MM.yyyy HH:mm"),
          ts: d.getTime(),
          wydarzenie: nazwa,
          punkty: pkt,
          zrodlo: "RFID"
        });
        suma += pkt;
      }
    }

    var shR = ss.getSheetByName("Logi_ręczne");
    if (shR && shR.getLastRow() > 1) {
      var dR = shR.getDataRange().getValues();
      for (var j = 1; j < dR.length; j++) {
        if (String(dR[j][1] || "").trim() !== celId) continue;
        var d2 = dR[j][0] instanceof Date ? dR[j][0] : new Date(dR[j][0]);
        if (isNaN(d2.getTime()) || !_dataWZakresie(d2, od, do_)) continue;
        var nazwa2 = String(dR[j][2] || "");
        if (!_pasujeDoTypuPunktow(nazwa2, filtr)) continue;
        var pkt2 = parseInt(dR[j][3], 10) || 0;
        wpisy.push({
          data: Utilities.formatDate(d2, tz, "dd.MM.yyyy HH:mm"),
          ts: d2.getTime(),
          wydarzenie: nazwa2,
          punkty: pkt2,
          zrodlo: "Ręczne"
        });
        suma += pkt2;
      }
    }

    wpisy.sort(function (a, b) { return b.ts - a.ts; });

    return {
      sukces: true,
      ministerId: celId,
      od: Utilities.formatDate(od, tz, "dd.MM.yyyy"),
      do: Utilities.formatDate(do_, tz, "dd.MM.yyyy"),
      typ: filtr,
      suma: suma,
      liczba: wpisy.length,
      wpisy: wpisy
    };
  } catch (e) {
    return { sukces: false, wiadomosc: String(e.message || e) };
  }
}


// ======================================================================
// FIX 2026-10: lista ministrantów do karty "🎯 Punkty ministranta — filtr"
// ----------------------------------------------------------------------
// Zwraca [{id, imie, ranga}] — wszyscy poza księżmi.
// Dostęp: ADMIN, MODERATOR, KSIĄDZ.
// ======================================================================
function getListaMinistrantowDoStatystyk(wykonawcaId) {
  try {
    var uid = _normId(wykonawcaId);
    var rola = _normalizujRole(pobierzRoleUzytkownika(uid));
    if (rola !== "ADMIN" && rola !== "MODERATOR" && rola !== "KSIADZ") {
      return { sukces: false, lista: [], wiadomosc: "Brak uprawnień." };
    }
    var kand = _pobierzDaneKandydaci();
    var lista = [];
    for (var i = 1; i < kand.length; i++) {
      var id = _normId(kand[i][0]);
      if (!id) continue;
      var ranga = String(kand[i][6] || "").trim();
      // pomiń księży
      if (ranga.toLowerCase().indexOf("ksi") === 0) continue;
      lista.push({
        id: id,
        imie: String(kand[i][1] || "").trim() || id,
        ranga: ranga
      });
    }
    lista.sort(function(a, b) {
      return String(a.imie).localeCompare(String(b.imie), "pl");
    });
    return { sukces: true, lista: lista, liczba: lista.length };
  } catch (e) {
    return { sukces: false, lista: [],
             wiadomosc: String(e && e.message ? e.message : e) };
  }
}

// >>> PATCH-2026-10-NAN-PUNKTY
// Mapa: nazwa wydarzenia (lowercase) → punkty.
// Używana wyłącznie gdy klient przyśle null/NaN/pusty string w polu "punkty".
// To NIE nadpisuje normalnego przepływu - tylko łatka awaryjna.
function _mapaNazwNaPunkty() {
  return {
    "wielka sobota": 15,
    "dyżur": 4,
    "dyzur": 4,
    "msza święta w niedzielę": 7,
    "msza swieta w niedziele": 7,
    "msza święta w tygodniu": 4,
    "msza swieta w tygodniu": 4,
    "służba na uroczystości": 12,
    "sluzba na uroczystosci": 12,
    "droga krzyżowa": 4,
    "droga krzyzowa": 4,
    "różaniec październikowy": 5,
    "rozaniec pazdziernikowy": 5,
    "nabożeństwo majowe/czerwcowe": 2,
    "nabozenstwo majowe/czerwcowe": 2,
    "pogrzeb": 7,
    "ślub": 7,
    "slub": 7,
    "obecność na zbiórce lso": 6,
    "obecnosc na zbiorce lso": 6,
    "zbiórka ogólna": 6,
    "zbiorka ogolna": 6,
    "nieobecność na dyżurze": -4,
    "nieobecnosc na dyzurze": -4,
    "nieobecność na uroczystości": -12,
    "nieobecnosc na uroczystosci": -12
  };
}

/**
 * Zwraca liczbę punktów dla (nazwa, pktRaw).
 * Jeśli pktRaw jest poprawne (np. 15, -4, 0), zwraca je bez zmian.
 * Jeśli pktRaw jest null / undefined / "" / NaN - próbuje dopasować z nazwy.
 * Jeśli dopasowanie się nie powiedzie - zwraca 0 i loguje problem.
 */
function _naprawPunktyNaN(nazwa, pktRaw) {
  var rawStr = (pktRaw === null || pktRaw === undefined) ? "" : String(pktRaw).trim();

  // Prawidłowa liczba (również 0) - nie ruszamy
  if (rawStr !== "") {
    var n = parseInt(rawStr, 10);
    if (!isNaN(n)) return n;
  }

  // Surowa wartość zepsuta - mapujemy z nazwy wydarzenia
  var key = String(nazwa || "").toLowerCase().trim();
  var mapa = _mapaNazwNaPunkty();
  if (mapa.hasOwnProperty(key)) {
    var v = mapa[key];
    try { console.log("[NAN-FIX] '" + nazwa + "' pktRaw='" + rawStr + "' -> " + v); } catch (e) {}
    return v;
  }

  // Nie udało się zmapować - log i 0
  try {
    console.log("[NAN-FIX] BRAK MAPY dla nazwa='" + nazwa + "' pktRaw='" + rawStr + "'");
    _logAdmin("SYSTEM", "", "NAN_PUNKTY_NIEZMAPOWANE", String(nazwa || ""), "pktRaw='" + rawStr + "'");
  } catch (e2) {}
  return 0;
}

