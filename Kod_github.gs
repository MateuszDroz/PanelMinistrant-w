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
        e.parameter.haslo,
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
    var uid = _normId(userId);
    var pass = String(haslo || "").trim();
    var kod = String(kodZdarzenia || "AUTO").trim().toUpperCase();
    if (!uid || !pass) return { sukces: false, wiadomosc: "Podaj ID i hasło." };

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
        var weryfikacjaQr = _sprawdzHaslo(pass, dane[i][2]);
        if (weryfikacjaQr.ok) {
          ok = true;
          imie = String(dane[i][1] || "").trim();
          if (weryfikacjaQr.legacy) {
            sheetHasla.getRange(i + 1, 3).setValue(_utworzZapisHasla(pass));
          }
        }
        break;
      }
    }
    if (!ok) return { sukces: false, wiadomosc: "Błędne ID lub hasło." };
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
    out.push({
      nazwa: nazwa,
      punkty: pkt,
      godzina: dt.getHours(),
      minuta: dt.getMinutes(),
      start: dt,
      typ: "kalendarz"
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
  var tz = Session.getScriptTimeZone();
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

    pasujace.push({ dt: dt, odKey: odKey });
  }
  if (!pasujace.length) return null;
  // Gdyby kilka okresów się pokrywało (nie powinno), bierz to z najpóźniejszym "Obowiązuje od".
  pasujace.sort(function(a, b) { return (a.odKey || "").localeCompare(b.odKey || ""); });
  var wybrany = pasujace[pasujace.length - 1].dt;

  // bierzemy wzorzec dnia tygodnia + godziny (dyżur cykliczny) z wybranego okresu
  var wd = wybrany.getDay();
  var h = wybrany.getHours();
  var mi = wybrany.getMinutes();
  if (wd === 0) return null;
  return { dzienTygodnia: wd, godzina: h, minuta: mi, nazwa: "Dyżur " + _fmtHM(h, mi) };
}

function _czyTenSamDyzurTeraz(dyzur, dataObj) {
  if (!dyzur) return false;
  if (dataObj.getDay() !== dyzur.dzienTygodnia) return false;
  var start = _cloneDateAt(dataObj, dyzur.godzina, dyzur.minuta);
  var od = new Date(start.getTime() - 60 * 60 * 1000);
  var do_ = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  var t = dataObj.getTime();
  return t >= od.getTime() && t <= do_.getTime();
}

/** Zbuduj listę możliwych „slotów” w danym momencie (okno −1h…+2h). */
function _slotyWOknie(ss, dataObj) {
  var t = dataObj.getTime();
  var sloty = [];
  var kal = _kalendarzNaDzien(ss, dataObj);
  var dzien = dataObj.getDay(); // 0=nd

  // Uroczystości / wpisy kalendarza (tylko prawdziwe uroczystości, nie zwykłe msze)
  kal.forEach(function(k) {
    var start = k.start;
    if (!start) return;
    var od = new Date(start.getTime() - 60 * 60 * 1000);
    var do_ = new Date(start.getTime() + 2 * 60 * 60 * 1000);
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

  // Stałe msze: nd 8/10/12/18 → +7; tydzień 7/8/18 → +5; okno −1h…+2h od startu
  var stale = _staleMszeDlaDnia(dataObj);
  stale.forEach(function(s) {
    var start = _cloneDateAt(dataObj, s.godzina, s.minuta);
    var od = new Date(start.getTime() - 60 * 60 * 1000);
    var do_ = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    if (t < od.getTime() || t > do_.getTime()) return;
    var konfliktKal = sloty.some(function(sl) {
      return sl.start && Math.abs(sl.start.getTime() - start.getTime()) < 30 * 60 * 1000 &&
        (sl.typ === "uroczystosc" || sl.typ === "triduum" || sl.typ === "wielka_sobota");
    });
    if (konfliktKal) return;
    // nie duplikuj tej samej godziny
    var dup = sloty.some(function(sl) {
      return sl.start && sl.start.getHours() === s.godzina && sl.start.getMinutes() === (s.minuta || 0) &&
        (sl.typ === "msza_nd" || sl.typ === "msza_td");
    });
    if (dup) return;
    sloty.push({
      kod: "M" + s.godzina + (s.minuta < 10 ? "0" : "") + (s.minuta || 0),
      nazwa: s.nazwa,
      typ: s.typ,
      punktyBazowe: s.typ === "msza_nd" ? _PKT.MSZA_ND : _PKT.MSZA_TD,
      start: start
    });
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
  if (mies === 9 && wd >= 1 && wd <= 5) {
    if (slot.typ === "msza_td" && h === 18 && mi === 0) {
      bonus += _PKT.ROZANIEC_PAZDZ;
      etykiety.push("Różaniec +" + _PKT.ROZANIEC_PAZDZ);
    }
  }
  return { bonus: bonus, etykiety: etykiety };
}

function _policzPunktyZaSlot(slot, dataObj, maDyzurNaTenSlot) {
  if (!slot) return { punkty: 0, nazwa: "Służba", kod: "" };
  var typ = String(slot.typ || "");
  var nazwa = slot.nazwa || "Służba";
  var baz = 0;

  if (typ === "msza_nd") baz = _PKT.MSZA_ND;
  else if (typ === "msza_td") baz = _PKT.MSZA_TD;
  else if (typ === "wielka_sobota") baz = _PKT.WIELKA_SOBOTA;
  else if (typ === "triduum") baz = _PKT.TRIDUUM;
  else if (typ === "uroczystosc") baz = _PKT.UROCZYSTOSC;
  else if (typ === "droga_krzyzowa") baz = _PKT.DROGA_KRZYZOWA;
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
    baz = _PKT.DYZUR;
    nazwa = "Dyżur (" + (slot.nazwa || "") + ")";
  }
  var b = _bonusyDoSlotu(slot, dataObj);
  return { punkty: baz + b.bonus,
           nazwa: nazwa + (b.etykiety.length ? " · " + b.etykiety.join(", ") : ""),
           kod: slot.kod };
}

function _czyJuzZaliczoneDziś(ss, userId, nazwaWydarzenia, dataObj) {
  var sheet = ss.getSheetByName("Logi_czytnik");
  if (!sheet) return false;
  var dane = sheet.getDataRange().getValues();
  var uid = String(userId).trim();
  var y = dataObj.getFullYear(), m = dataObj.getMonth(), d = dataObj.getDate();
  var klucz = String(nazwaWydarzenia || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (var i = dane.length - 1; i >= 1; i--) {
    if (String(dane[i][1] || "").trim() !== uid) continue;
    var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
    if (isNaN(dt.getTime())) continue;
    if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) continue;
    var n = String(dane[i][4] || "").toLowerCase().replace(/\s+/g, " ").trim();
    // ten sam slot / ta sama godzina w nazwie
    if (n.indexOf(klucz.substring(0, 12)) >= 0 || klucz.indexOf(n.substring(0, 12)) >= 0) return true;
    // dyżur dziś
    if (klucz.indexOf("dyżur") >= 0 && n.indexOf("dyżur") >= 0) return true;
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

  // 3) Same zwykłe msze (7 i 8 itd.) → BEZ wyboru „Msza 7 albo Msza 8”
  //    bierz najbliższą godzinę; punkty zwykłej mszy (+5 / +7)
  if (_tylkoZwykleMsze(sloty)) {
    return { tryb: "ok", slot: _najblizszySlot(sloty), maDyzur: false };
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
  var dataStr = Utilities.formatDate(_getCzasSystemowy(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
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
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Kandydaci");
    if (!sheet) return { sukces: false, wiadomosc: "Brak arkusza Kandydaci." };
    var dane = sheet.getDataRange().getValues();
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

    // Opcjonalny zakres dat: jeśli podany, ranking liczy punkty zdobyte TYLKO
    // w tym okresie (z logów), a nie sumę "od zawsze" z kolumny w Kandydaci.
    var uzyjZakresu = !!(String(odIso || "").trim() || String(doIso || "").trim());
    var zakres = uzyjZakresu ? _parseZakresStat(odIso, doIso) : null;

    var dane = sheet.getDataRange().getValues();
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
    var tzR = Session.getScriptTimeZone();
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

function getCzasTestowyStatus(userId) {
  try {
    if (String(userId || "").trim() !== _CZAS_TEST_USER_ID) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
    }
    var props = PropertiesService.getScriptProperties();
    var iso = String(props.getProperty("czas_testowy_iso") || "").trim();
    var real = new Date();
    var eff = _getCzasSystemowy();
    var tz = Session.getScriptTimeZone();
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
    if (String(userId || "").trim() !== _CZAS_TEST_USER_ID) {
      return { sukces: false, wiadomosc: "Tylko konto 2212 może zmieniać czas systemowy." };
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
    if (String(userId || "").trim() !== _CZAS_TEST_USER_ID) {
      return { sukces: false, wiadomosc: "Brak uprawnień." };
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
      var _prz = getPrzerwaTechniczna();
      if (_prz && _prz.aktywna) {
        return JSON.stringify({
          sukces: false,
          blad: "przerwa_techniczna",
          wiadomosc: (_prz.wiadomosc || "Trwa przerwa techniczna — rejestracja obecności wstrzymana.")
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
      Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd")
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

function naliczMinusyZaOpuszczoneDyzury() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetD = ss.getSheetByName("Dyżury");
  if (!sheetD) return { sukces: false, wiadomosc: "Brak Dyżury" };
  var teraz = new Date();
  // poniedziałek bieżącego tygodnia
  var pon = new Date(teraz.getFullYear(), teraz.getMonth(), teraz.getDate());
  var day = pon.getDay();
  var diff = day === 0 ? -6 : 1 - day;
  pon.setDate(pon.getDate() + diff);
  pon.setHours(0, 0, 0, 0);

  var dane = sheetD.getDataRange().getValues();
  var sheetLogi = ss.getSheetByName("Logi_czytnik");
  var logi = sheetLogi ? sheetLogi.getDataRange().getValues() : [];
  var sheetReczne = ss.getSheetByName("Logi_ręczne");
  var reczne = sheetReczne ? sheetReczne.getDataRange().getValues() : [];
  var naliczone = 0;

  for (var i = 1; i < dane.length; i++) {
    var uid = String(dane[i][2] || "").trim();
    if (!uid || !dane[i][0]) continue;
    var dt = dane[i][0] instanceof Date ? dane[i][0] : new Date(dane[i][0]);
    if (isNaN(dt.getTime())) continue;
    var wd = dt.getDay();
    if (wd === 0) continue;
    if (wd === 6 && dt.getHours() === 18) continue;

    // Konto założone po starcie tygodnia (lub później) — bez minusa za ten tydzień
    if (!_kontoIstnialoWDniu(uid, pon)) continue;

    // Czy był log dyżuru w tym tygodniu?
    var byl = false;
    function skanLog(rows, colId, colNazwa, colData) {
      for (var r = 1; r < rows.length; r++) {
        if (String(rows[r][colId] || "").trim() !== uid) continue;
        var ld = rows[r][colData] instanceof Date ? rows[r][colData] : new Date(rows[r][colData]);
        if (isNaN(ld.getTime()) || ld.getTime() < pon.getTime()) continue;
        var n = String(rows[r][colNazwa] || "").toLowerCase();
        if (n.indexOf("dyżur") >= 0 || n.indexOf("dyzur") >= 0) { byl = true; return; }
      }
    }
    skanLog(logi, 1, 4, 0);
    if (!byl) skanLog(reczne, 1, 2, 0);

    // Wniosek o nieobecność zaakceptowany?
    var sheetN = ss.getSheetByName("Nieobecnosci_dyzur");
    if (sheetN && !byl) {
      var dn = sheetN.getDataRange().getValues();
      for (var n = 1; n < dn.length; n++) {
        if (String(dn[n][1] || "").trim() !== uid) continue;
        if (String(dn[n][6] || "").toLowerCase().indexOf("akcept") < 0) continue;
        byl = true; // usprawiedliwione
        break;
      }
    }
    if (byl) continue;

    // Czy już jest minus w tym tygodniu?
    var juzMinus = false;
    for (var r = 1; r < reczne.length; r++) {
      if (String(reczne[r][1] || "").trim() !== uid) continue;
      var ld = reczne[r][0] instanceof Date ? reczne[r][0] : new Date(reczne[r][0]);
      if (isNaN(ld.getTime()) || ld.getTime() < pon.getTime()) continue;
      if (String(reczne[r][2] || "").toLowerCase().indexOf("nieobec") >= 0 && parseInt(reczne[r][3], 10) < 0) {
        juzMinus = true; break;
      }
    }
    if (juzMinus) continue;

    if (!sheetReczne) {
      sheetReczne = ss.insertSheet("Logi_ręczne");
      sheetReczne.appendRow(["Data", "ID", "Wydarzenie", "Punkty", "Opis", "WykonawcaID", "WykonawcaImie"]);
      reczne = sheetReczne.getDataRange().getValues();
    }
    sheetReczne.appendRow([
      new Date(), uid, "Nieusprawiedliwiona nieobecność na dyżurze", _PKT.BRAK_DYZURU,
      "Automat niedziela 23:59", "SYSTEM", "System"
    ]);
    przeliczPunktyUzytkownika(uid);
    naliczone++;
  }
  return { sukces: true, naliczone: naliczone };
}

/**
 * Automat −12 za nieobecność na uroczystości (dzień po, jeśli brak logu i brak wniosku).
 */
function naliczMinusyZaOpuszczoneUroczystosci() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetK = ss.getSheetByName("Kalendarz");
  if (!sheetK) return { sukces: false };
  var wczoraj = new Date();
  wczoraj.setDate(wczoraj.getDate() - 1);
  var kal = _kalendarzNaDzien(ss, wczoraj);
  var urocz = kal.filter(function(k) {
    var n = String(k.nazwa || "").toLowerCase();
    return n.indexOf("uroczyst") >= 0 || (k.punkty && k.punkty >= 10);
  });
  if (!urocz.length) return { sukces: true, naliczone: 0 };

  var sheetKand = ss.getSheetByName("Kandydaci");
  if (!sheetKand) return { sukces: false };
  var kand = sheetKand.getDataRange().getValues();
  var sheetLogi = ss.getSheetByName("Logi_czytnik");
  var logi = sheetLogi ? sheetLogi.getDataRange().getValues() : [];
  var sheetReczne = ss.getSheetByName("Logi_ręczne") || ss.insertSheet("Logi_ręczne");
  if (sheetReczne.getLastRow() === 0) sheetReczne.appendRow(["Data", "ID", "Wydarzenie", "Punkty", "Opis", "WykonawcaID", "WykonawcaImie"]);
  var reczne = sheetReczne.getDataRange().getValues();
  var naliczone = 0;
  var y = wczoraj.getFullYear(), m = wczoraj.getMonth(), d = wczoraj.getDate();

  for (var i = 1; i < kand.length; i++) {
    var uid = String(kand[i][0] || "").trim();
    if (!uid) continue;
    // Minus tylko jeśli konto istniało w dniu uroczystości
    if (!_kontoIstnialoWDniu(uid, wczoraj)) continue;
    var byl = false;
    for (var r = 1; r < logi.length; r++) {
      if (String(logi[r][1] || "").trim() !== uid) continue;
      var ld = logi[r][0] instanceof Date ? logi[r][0] : new Date(logi[r][0]);
      if (isNaN(ld.getTime())) continue;
      if (ld.getFullYear() === y && ld.getMonth() === m && ld.getDate() === d) { byl = true; break; }
    }
    if (byl) continue;
    // wniosek o nieobecność na ten dzień?
    // (arkusz Nieobecnosci_dyzur lub przyszły wniosek o uroczystość — na razie ten sam)
    sheetReczne.appendRow([
      new Date(), uid, "Nieusprawiedliwiona nieobecność na uroczystości", _PKT.BRAK_UROCZYSTOSCI,
      "Automat: " + (urocz[0].nazwa || "uroczystość") + " " + Utilities.formatDate(wczoraj, Session.getScriptTimeZone(), "yyyy-MM-dd"),
      "SYSTEM", "System"
    ]);
    przeliczPunktyUzytkownika(uid);
    naliczone++;
  }
  return { sukces: true, naliczone: naliczone };
}

/** Instalacja triggerów czasowych (uruchom raz ręcznie z edytora). */
function zainstalujTriggeryPunktow() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var h = t.getHandlerFunction();
    if (h === "naliczMinusyZaOpuszczoneDyzury" || h === "naliczMinusyZaOpuszczoneUroczystosci") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("naliczMinusyZaOpuszczoneDyzury")
    .timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(23).create();
  ScriptApp.newTrigger("naliczMinusyZaOpuszczoneUroczystosci")
    .timeBased().everyDays(1).atHour(1).create();
  return "Zainstalowano triggery: niedziela 23:xx (dyżury), codziennie 1:xx (uroczystości).";
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
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Sesje_urzadzen");
    if (!sheet) {
      sheet = ss.insertSheet("Sesje_urzadzen");
      sheet.appendRow(["DeviceID", "UserID", "Token", "Imie", "Rola", "DataWaznosci"]);
    }
    var deviceId = String(deviceId).trim();
    var dataWaznosci = new Date();
    dataWaznosci.setDate(dataWaznosci.getDate() + 30);

    var dane = sheet.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === deviceId) {
        sheet.getRange(i + 1, 1, 1, 6).setValues([[deviceId, String(userId).trim(), String(token).trim(), String(imie || "").trim(), String(rola).trim(), dataWaznosci]]);
        return { sukces: true };
      }
    }
    sheet.appendRow([deviceId, String(userId).trim(), String(token).trim(), String(imie || "").trim(), String(rola).trim(), dataWaznosci]);
    return { sukces: true };
  } catch(e) {
    return { sukces: false, wiadomosc: e.message };
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
    if (!raw) return { count: 0, level: 0, lockedUntil: 0, permanent: false };
    var d = JSON.parse(raw);
    return {
      count: parseInt(d.count) || 0,
      level: parseInt(d.level) || 0,
      lockedUntil: parseInt(d.lockedUntil) || 0,
      permanent: !!d.permanent
    };
  } catch (e) {
    return { count: 0, level: 0, lockedUntil: 0, permanent: false };
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
    if (!raw) return { count: 0, level: 0, lockedUntil: 0, permanent: false };
    var d = JSON.parse(raw);
    return {
      count: parseInt(d.count) || 0,
      level: parseInt(d.level) || 0,
      lockedUntil: parseInt(d.lockedUntil) || 0,
      permanent: !!d.permanent
    };
  } catch (e) { return { count: 0, level: 0, lockedUntil: 0, permanent: false }; }
}
function _saveLoginAttempts(userId, data) {
  try { PropertiesService.getScriptProperties().setProperty("login_attempts_" + userId, JSON.stringify(data)); } catch (e) {}
}
function _sprawdzBlokadeLogowania(userId) {
  var a = _getLoginAttempts(userId);
  var teraz = Date.now();
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
    var dane = sheetH.getDataRange().getValues();
    var znaleziono = false, imie = target;
    for (var i = 1; i < dane.length; i++) {
      if (_normId(dane[i][0]) === target) {
        imie = String(dane[i][1] || "").trim() || target;
        sheetH.getRange(i + 1, 3).setValue(_utworzZapisHasla(noweHaslo));
        sheetH.getRange(i + 1, 4).setValue(false);
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
    var sheetHasla = ss.getSheetByName("Hasła");
    if (!sheetHasla) return { sukces: false, wiadomosc: "Błąd krytyczny: Brak arkusza 'Hasła'" };
    
    var dane = sheetHasla.getDataRange().getValues();
    var targetId = String(id).trim();

    // Sprawdź czy konto jest aktualnie zablokowane
    var _lockInfo = _sprawdzBlokadeLogowania(targetId);
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
      if (String(dane[i][0]).trim() === targetId) {
        var weryfikacja = _sprawdzHaslo(haslo, dane[i][2]);
        if (weryfikacja.ok) {
          // Sukces — wyzeruj licznik nieudanych prób
          _resetBlokadyLogowania(targetId);
          // Migracja "w locie": jeśli w arkuszu było jeszcze stare, jawne
          // hasło, od razu je nadpisujemy zahaszowaną wersją.
          if (weryfikacja.legacy) {
            sheetHasla.getRange(i + 1, 3).setValue(_utworzZapisHasla(haslo));
          }
          var zmianaHaslaWymagana = (dane[i][3] === false || dane[i][3] === "FALSE" || dane[i][3] === "");
          
          // Kolumna F (indeks 5) TAK = admin; kolumna E = ranga bazowa (MINISTRANT/LEKTOR/…)
          var rola = _czyFlagaAdmin(dane[i][5])
            ? "ADMIN"
            : _normalizujRole(dane[i][4] || "");
          if (!rola) rola = "MINISTRANT";
          var token = generujToken();
          zapiszToken(targetId, token, rola);
          var ustawienia = getUstawieniaUsera(targetId);
          if (zapamietaj && deviceId) {
            zapiszSesjeUrzadzenia(deviceId, targetId, token, String(dane[i][1]), rola);
          }
          
          // Technical break banner for user ID 2212
          var przerwaTechniczna = (targetId === "2212");
          // Zielony baner — widoczny dla WSZYSTKICH zalogowanych (ustawia tylko admin 2212)
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
          // Błędne hasło — zarejestruj próbę i ew. nałóż blokadę
          var _wynikProb = _zarejestrujNieudaneLogowanie(targetId);
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
      if (_normId(dane[i][0]) === _uid) {
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
    
    var dane = sheetHasla.getDataRange().getValues();
    var targetId = String(id).trim();
    var pass = String(noweHaslo || "");
    if (pass.length < 4) return { sukces: false, wiadomosc: "Hasło musi mieć min. 4 znaki." };
    
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() === targetId) {
        sheetHasla.getRange(i + 1, 3).setValue(_utworzZapisHasla(pass));
        sheetHasla.getRange(i + 1, 4).setValue(true);
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

    var dane = sheetHasla.getDataRange().getValues();
    for (var i = 1; i < dane.length; i++) {
      if (String(dane[i][0]).trim() !== uid) continue;
      var weryfikacja = _sprawdzHaslo(stare, dane[i][2]);
      if (!weryfikacja || !weryfikacja.ok) {
        return { sukces: false, wiadomosc: "Aktualne hasło jest nieprawidłowe." };
      }
      sheetHasla.getRange(i + 1, 3).setValue(_utworzZapisHasla(nowe));
      sheetHasla.getRange(i + 1, 4).setValue(true);
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
    
    var dataKandydaci = _pobierzKandydatowRawCached();
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
          var _uidCmp = _normId(userId);
          if (iterowanyId !== _uidCmp) {
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
      var tzDyz = Session.getScriptTimeZone();
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
        
        dyzury.push({
          wiersz: k + 1,
          timestamp: d.getTime(),
          dzienTygodnia: d.getDay(),
          godzina: Utilities.formatDate(d, tzDyz, "HH:mm"),
          imieNazwisko: String(dataDyzury[k][1] || "Nieznany"),
          id: String(dataDyzury[k][2] || "")
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
          data: Utilities.formatDate(ds, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm"),
          dataFormated: Utilities.formatDate(ds, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm"),
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

        var nowaGodzinaRaw = dataWnioski[w][4];
        var nowaGodzina = (nowaGodzinaRaw instanceof Date)
          ? Utilities.formatDate(nowaGodzinaRaw, Session.getScriptTimeZone(), "HH:mm")
          : String(nowaGodzinaRaw || "");

        var staraGodzinaRaw = dataWnioski[w][6];
        var staraGodzina = (staraGodzinaRaw instanceof Date)
          ? Utilities.formatDate(staraGodzinaRaw, Session.getScriptTimeZone(), "HH:mm")
          : String(staraGodzinaRaw || "");

        wnioski.push({
          wiersz: w + 1,
          timestamp: dw.getTime(),
          dataFormated: Utilities.formatDate(dw, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm"),
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
    return "https://drive.google.com/uc?export=view&id=" + idMatch[1];
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
    var godzinaRaw = dane[4];
    var godzina = (godzinaRaw instanceof Date)
      ? Utilities.formatDate(godzinaRaw, Session.getScriptTimeZone(), "HH:mm")
      : String(godzinaRaw || "").trim();

    var dataNowegoDyzuru = obliczDateDlaWniosku(dzienLabel, godzina);

    // Zamykamy STARY dyżur (Obowiązuje do = wczoraj) i dopisujemy nowy.
    // Preferuj wiersz z wniosku (kol. J); dodatkowo zamknij wszystkie inne
    // nadal otwarte dyżury tej osoby, żeby nie zostawały 2 aktywne.
    var tzA = Session.getScriptTimeZone();
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

    // 1) Zamknij wskazany wiersz z wniosku
    if (!isNaN(targetRow) && targetRow >= 2 && targetRow <= dyzury.length) {
      var idx = targetRow - 1;
      if (String(dyzury[idx][2] || "").trim() === wnioskodawcaId) {
        imieNazwiskoStare = String(dyzury[idx][1] || "");
        sheetDyzury.getRange(targetRow, 5).setValue(wczorajStr);
        znaleziono = true;
      }
    }

    // 2) Zamknij WSZYSTKIE inne otwarte dyżury tej osoby
    for (var i = 1; i < dyzury.length; i++) {
      if (String(dyzury[i][2] || "").trim() !== wnioskodawcaId) continue;
      if (!_dyzurJeszczeOtwarty(dyzury[i][4])) continue;
      if (!imieNazwiskoStare) imieNazwiskoStare = String(dyzury[i][1] || "");
      sheetDyzury.getRange(i + 1, 5).setValue(wczorajStr);
      znaleziono = true;
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
    var tzD = Session.getScriptTimeZone();
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
function dodajDoKalendarza(dataStr, wydarzenie, punkty, powtarzanie, dataKoncaStr, dzienMiesiaca) {
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
        var dataPl = Utilities.formatDate(dataObj, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
        wyslijPowiadomienieDostepnosc(wydarzenie, dataPl);
      }
      return "Dodano wydarzenie do kalendarza!";
    }

    // Powtarzające się — użyj istniejącej funkcji
    return dodajPowtarzajaceWydarzenia(dataStr, wydarzenie, pkt, powtarzanie, dataKoncaStr || dataStr, dzienMiesiaca);
  } catch(e) {
    return "Błąd: " + e.message;
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
  var dataStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  var samodzielnie = wykonawcaId && String(wykonawcaId).trim() === String(id).trim();

  sheetReczne.appendRow([
    dataStr, id, wydarzenie, parseInt(punkty), opis,
    String(wykonawcaId || "").trim(),
    String(wykonawcaImie || "").trim() + (samodzielnie ? " (przyznane samodzielnie)" : "")
  ]);
  przeliczPunktyUzytkownika(id);
  _logAdmin(wykonawcaId, wykonawcaImie, "WPIS_RECZNY", String(id||""), String(wydarzenie||"") + " " + String(punkty||"") + " " + String(opis||""));
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

function dodajDoKalendarza(dataStr, wydarzenie, punkty, opis) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetKalendarz = ss.getSheetByName("Kalendarz");
  if (!sheetKalendarz) return "Błąd: Brak arkusza 'Kalendarz'";

  // Kolumny E (ID grupy) i F (etykieta) puste — to wydarzenie jednorazowe.
  sheetKalendarz.appendRow([dataStr, wydarzenie, parseInt(punkty), String(opis || "").trim(), "", ""]);
  return "Uroczystość dodana do kalendarza!";
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
  var targetId = String(id).trim();
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

function getHistoriaUzytkownika(id) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetCzytnik = ss.getSheetByName("Logi_czytnik");
    var sheetReczne = ss.getSheetByName("Logi_ręczne");
    var targetId = String(id).trim();
    var historia = [];
    
    if (sheetCzytnik) {
      var logiCzytnik = sheetCzytnik.getDataRange().getValues();
      for (var i = 1; i < logiCzytnik.length; i++) {
        if (logiCzytnik[i][1] && String(logiCzytnik[i][1]).trim() === targetId) {
          var dateObj = new Date(logiCzytnik[i][0]);
          var dataFormated = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
          historia.push({
            timestamp: dateObj.getTime(),
            tekst: `<strong>${logiCzytnik[i][4]}</strong><br><span style="color:gray; font-size:12px;">Czytnik: ${logiCzytnik[i][3]}</span>`,
            punkty: parseInt(logiCzytnik[i][5] || 0),
            data: dataFormated
          });
        }
      }
    }
    
    if (sheetReczne) {
      var logiReczne = sheetReczne.getDataRange().getValues();
      for (var j = 1; j < logiReczne.length; j++) {
        if (logiReczne[j][1] && String(logiReczne[j][1]).trim() === targetId) {
          var dateObj2 = new Date(logiReczne[j][0]);
          var dataFormated2 = Utilities.formatDate(dateObj2, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
          var wykonawcaIdWpis = String(logiReczne[j][5] || "").trim();
          var wykonawcaImieWpis = String(logiReczne[j][6] || "").trim();
          var samodzielnyWpis = wykonawcaIdWpis && wykonawcaIdWpis === targetId;
          var etykietaWykonawcy = wykonawcaImieWpis
            ? ` <span style="color:${samodzielnyWpis ? '#e41e3f' : 'gray'}; font-size:11px;">${samodzielnyWpis ? '⚠️ przyznane samodzielnie' : 'przyznał: ' + wykonawcaImieWpis.replace(' (przyznane samodzielnie)','')}</span>`
            : "";
          historia.push({
            timestamp: dateObj2.getTime(),
            tekst: `<strong>${logiReczne[j][2]}</strong><br><span style="color:gray; font-size:12px;">${_formatujOpisLogu(logiReczne[j][4])}</span>${etykietaWykonawcy}`,
            punkty: parseInt(logiReczne[j][3] || 0),
            data: dataFormated2
          });
        }
      }
    }
    
    historia.sort(function(a, b) { return b.timestamp - a.timestamp; });
    return { success: true, dane: historia };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function przeliczPunktyUzytkownika(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetKandydaci = ss.getSheetByName("Kandydaci");
  var sheetCzytnik = ss.getSheetByName("Logi_czytnik");
  var sheetReczne = ss.getSheetByName("Logi_ręczne");
  var targetId = String(id).trim();
  var suma = 0;
  
  if (sheetCzytnik) {
    var logiCzytnik = sheetCzytnik.getDataRange().getValues();
    for (var i = 1; i < logiCzytnik.length; i++) {
      if (logiCzytnik[i][1] && String(logiCzytnik[i][1]).trim() === targetId) {
        suma += parseInt(logiCzytnik[i][5]) || 0; 
      }
    }
  }
  
  if (sheetReczne) {
    var logiReczne = sheetReczne.getDataRange().getValues();
    for (var j = 1; j < logiReczne.length; j++) {
      if (logiReczne[j][1] && String(logiReczne[j][1]).trim() === targetId) {
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
    var dataStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    var pkt = parseInt(punkty);
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
          dataFormated: Utilities.formatDate(d, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm"),
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
        dataZakonczeniaFormated: terminData ? Utilities.formatDate(terminData, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm") : "",
        dataFormated: Utilities.formatDate(d, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm"),
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
  var folderId = 'DANE_WRAŻLIWE';
  PropertiesService.getScriptProperties().setProperty("FOLDER_ZDJEC_ID", folderId);
}
function getFolderZdjecId() {
  return PropertiesService.getScriptProperties().getProperty("FOLDER_ZDJEC_ID") || "";
}

function uploadZdjecie(base64Data, nazwaPliku, mimeType) {
  try {
    var folderId = getFolderZdjecId();
    if (!folderId) return { sukces: false, wiadomosc: "Brak ID folderu Drive. Uruchom setFolderZdjecId('TWOJE_ID') w edytorze Apps Script." };

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
    var sheet = _arkuszZdarzenPowiadomien();
    sheet.appendRow([
      uid,
      String(klucz),
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
        snoozeUntil = Utilities.formatDate(dS, Session.getScriptTimeZone(), "yyyy-MM-dd");
      }
      notatka = "snooze:" + snoozeUntil;
    } else if (z !== "tak" && z !== "nie") {
      z = "tak";
    }

    var sheet = _pobierzAlboUtworzArkuszZgodyPush();
    var dane = sheet.getDataRange().getValues();

    for (var i = 1; i < dane.length; i++) {
      var rowId = String(dane[i][0] || "").trim();
      var rowDev = String(dane[i][1] || "").trim();
      if (rowId === id && rowDev === dev) {
        sheet.getRange(i + 1, 3).setValue(z);
        sheet.getRange(i + 1, 4).setValue(new Date());
        sheet.getRange(i + 1, 5).setValue(notatka);
        return { sukces: true, deviceId: dev, zgoda: z, snoozeUntil: snoozeUntil };
      }
    }
    sheet.appendRow([id, dev, z, new Date(), notatka]);
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
            var todayF = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
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
      // Brak wpisu dla tego urządzenia → pytaj na tym urządzeniu
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

    var doPl = Utilities.formatDate(koniec, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
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
    var tz = Session.getScriptTimeZone();
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
    var tz = Session.getScriptTimeZone();
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


function filtrujNowePowiadomienia(userId, sessionToken, klucze) {
  try {
    var rola = pobierzRoleUzytkownika(userId);
    if (!rola) return { success: false, nowe: [] };
    if (!Array.isArray(klucze) || klucze.length === 0) return { success: true, nowe: [] };

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
    klucze.forEach(function(k) {
      var kl = String(k || "").trim();
      if (!kl) return;
      if (!wyslaneMap[kl]) {
        nowe.push(kl);
        wierszeDoZapisu.push([uid, kl, teraz]);
        wyslaneMap[kl] = true; // zabezpieczenie przed duplikatami w tej samej paczce
      }
    });

    if (wierszeDoZapisu.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, wierszeDoZapisu.length, 3).setValues(wierszeDoZapisu);
    }

    return { success: true, nowe: nowe };
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

function getDostepnoscAdmin() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Dostepnosc");
    if (!sheet) return { dane: [] };
    var data = sheet.getDataRange().getValues();
    var wynik = [];
    for (var i = 1; i < data.length; i++) {
      if (!data[i][1]) continue;
      wynik.push({
        userId: String(data[i][1]).trim(),
        imie: String(data[i][2] || "").trim(),
        klucz: String(data[i][3]).trim(),
        wartosc: String(data[i][4]).trim()
      });
    }
    return { dane: wynik };
  } catch(e) {
    return { dane: [] };
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

function dodajPowtarzajaceWydarzenia(dataStartStr, wydarzenie, punkty, powtarzanie, dataKoncaStr, dzienMiesiaca, opis) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetKalendarz = ss.getSheetByName("Kalendarz");
    if (!sheetKalendarz) return "Błąd: Brak arkusza 'Kalendarz'";
    var opisWpis = String(opis || "").trim();

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
      sheetKalendarz.appendRow([d, wydarzenie, pkt, opisWpis, groupId, etykietaPowtarzania]);
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
  var tz = Session.getScriptTimeZone();
  var a = Utilities.formatDate(pon, tz, "d.MM");
  var b = Utilities.formatDate(nd, tz, "d.MM.yyyy");
  return a + " – " + b;
}

function getPassaDyzuru(userId) {
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
    sheet.appendRow([
      new Date(),
      uid,
      String(imie || "").trim(),
      dataDyzuru,
      pow,
      String(dataPowrotu || "").trim(),
      "Oczekuje",
      "",
      ""
    ]);
    try { _powiadomAdminowONowymDoPrzegladu("Nowy wniosek o nieobecność", String(imie || userId) + " — do rozpatrzenia", "page-wnioski", userId); } catch (eN) {}
    return { sukces: true, wiadomosc: "Wniosek o nieobecność wysłany. Po akceptacji admina passa zostanie zachowana." };
  } catch (e) {
    return { sukces: false, wiadomosc: e.message };
  }
}


/** Formatuje datę/tekst do czytelnej postaci PL: "Sobota 15.08.2026, 18:00" */
function _formatujDateNieobecnosc(val) {
  if (val === null || val === undefined || val === '') return '';
  // Już ładny tekst z frontu (np. "Sobota 15.08.2026, 7:00")
  if (typeof val === 'string' && /^(Poniedziałek|Wtorek|Środa|Czwartek|Piątek|Sobota|Niedziela)/.test(val.trim())) {
    return val.trim();
  }
  var d = null;
  if (val instanceof Date) {
    d = val;
  } else {
    var s = String(val).trim();
    // Spróbuj sparsować typowe formaty
    d = new Date(s);
    if (isNaN(d.getTime())) {
      // ISO yyyy-mm-dd
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10), 12, 0, 0);
    }
  }
  if (!d || isNaN(d.getTime())) return String(val).trim();

  var dni = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota'];
  var tz = Session.getScriptTimeZone();
  var dd = Utilities.formatDate(d, tz, 'dd');
  var mm = Utilities.formatDate(d, tz, 'MM');
  var yyyy = Utilities.formatDate(d, tz, 'yyyy');
  var hhmm = Utilities.formatDate(d, tz, 'HH:mm');
  // Jeśli godzina to 00:00 i nie było jawnej godziny w oryginale – pomiń godzinę
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
    var tz = Session.getScriptTimeZone();
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
    var status = (String(decyzja || "").toLowerCase() === "zaakceptowano" || String(decyzja || "").toLowerCase() === "ok")
      ? "Zaakceptowano" : "Odrzucono";
    var odp = String(odpowiedz || "").trim();
    var userId = String(sheet.getRange(row, 2).getValue() || "").trim();
    sheet.getRange(row, 7).setValue(status);
    sheet.getRange(row, 8).setValue(String(wykonawcaId || "").trim());
    sheet.getRange(row, 9).setValue(odp || (status === "Zaakceptowano" ? "Nieobecność zaakceptowana — passa zachowana." : "Wniosek odrzucony."));

    if (userId) {
      var tytul = status === "Zaakceptowano"
        ? "Nieobecność zaakceptowana"
        : "Nieobecność odrzucona";
      var opis = status === "Zaakceptowano"
        ? ("Admin zaakceptował Twoją nieobecność. Passa dyżurów zostaje zachowana." + (odp ? ("\\n" + odp) : ""))
        : ("Admin odrzucił wniosek o nieobecność." + (odp ? ("\\n" + odp) : ""));
      _zapiszZdarzeniePowiadomienia(
        userId,
        "nieobecnosc_dyzur_" + row + "_" + Date.now(),
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
    var tz = Session.getScriptTimeZone();
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
        "wniosek_pkt_" + row + "_" + Date.now(),
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
    sheet.appendRow(["TicketID", "AuthorID", "AuthorImie", "IsAdmin", "Tresc", "Data"]);
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

    // Zbiór zajętych ID z Kandydaci + Hasła
    var zajete = {};
    var daneK = sheetK.getDataRange().getValues();
    for (var i = 1; i < daneK.length; i++) {
      var idk = String(daneK[i][0] || "").trim();
      if (idk) zajete[idk] = true;
    }
    var daneH = sheetH.getDataRange().getValues();
    for (var h = 1; h < daneH.length; h++) {
      var idh = String(daneH[h][0] || "").trim();
      if (idh) zajete[idh] = true;
    }

    // Losuj unikalne 4-cyfrowe ID (1000–9999)
    var noweId = "";
    for (var proba = 0; proba < 200; proba++) {
      var kand = String(1000 + Math.floor(Math.random() * 9000));
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

    // Kandydaci: ID | Imię | Punkty | Funkcje | Dodatkowe | Uwagi | Ranga | Zdjęcie
    sheetK.appendRow([noweId, imie, 0, "", "", "", st, ""]);

    // Hasła: ID | Imię | Hasło (zahaszowane: "sol$hash") | Zmiana (FALSE = wymaga zmiany) | Rola | Admin
    // Kolumna 4 = wymaga zmiany hasła przy pierwszym logowaniu gdy false/puste
    // Hasło jawne ("haslo") jest zwracane administratorowi TYLKO w tej odpowiedzi
    // (do przekazania osobie) — w arkuszu zapisywany jest wyłącznie hash.
    sheetH.appendRow([noweId, imie, _utworzZapisHasla(haslo), false, rolaH, "NIE"]);

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
    var dataStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
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
        dataStr = Utilities.formatDate(dataVal, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
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

    // Kandydaci
    var sheetK = ss.getSheetByName("Kandydaci");
    if (sheetK) {
      var daneK = sheetK.getDataRange().getValues();
      for (var i = daneK.length - 1; i >= 1; i--) {
        if (_normId(daneK[i][0]) === targetId) {
          imieUsunietego = String(daneK[i][1] || targetId).trim() || targetId;
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
        if (_normId(daneH[h][0]) === targetId) {
          if (!imieUsunietego || imieUsunietego === targetId) {
            imieUsunietego = String(daneH[h][1] || targetId).trim() || targetId;
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
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetHasla = ss.getSheetByName("Hasła") || ss.getSheetByName("Hasla");
    if (!sheetHasla) {
      var sheets = ss.getSheets();
      for (var si = 0; si < sheets.length; si++) {
        var n = String(sheets[si].getName() || "").toLowerCase().replace(/ł/g, "l");
        if (n.indexOf("hasl") >= 0) { sheetHasla = sheets[si]; break; }
      }
    }
    if (!sheetHasla) return { sukces: true, admini: [], wiadomosc: "Brak arkusza Hasła" };

    var dane = sheetHasla.getDataRange().getValues();
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
    var tz = Session.getScriptTimeZone();
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
    var tz = Session.getScriptTimeZone();
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
          dataTs: isNaN(dw.getTime()) ? 0 : dw.getTime()
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

function dodajWiadomoscDoTicketu(userId, imie, ticketId, tresc) {
  var _tLock = LockService.getScriptLock();
  var _tGotLock = false;
  try { _tGotLock = _tLock.tryLock(8000); } catch (eL) {}
  if (!_tGotLock) return { sukces: false, wiadomosc: "Serwer zajęty — spróbuj ponownie." };
  try {
    var uid = String(userId || "").trim();
    var tid = String(ticketId || "").trim();
    var tr = String(tresc || "").trim();
    if (!uid || !tid) return { sukces: false, wiadomosc: "Brak danych." };
    if (!tr || tr.length < 1) return { sukces: false, wiadomosc: "Wpisz treść wiadomości." };
    if (tr.length > 2000) tr = tr.substring(0, 2000);
    try {
      var _dedupKey = "ticket_msg_" + tid + "_" + uid;
      var _cache = CacheService.getScriptCache();
      if (_cache.get(_dedupKey) === tr) return { sukces: true, wiadomosc: "Wiadomość już wysłana.", _duplikat: true };
      _cache.put(_dedupKey, tr, 15);
    } catch (eC) {}
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

    // Admin bez przypisania musi najpierw przejąć ticket
    if (isAdmin && !assignedId && ticketUserId !== uid) {
      return { sukces: false, wiadomosc: "Najpierw przejmij ticket, zanim odpowiesz." };
    }

    var teraz = new Date();
    _arkuszTicketyWiadomosci().appendRow([
      tid,
      uid,
      String(imie || "").trim(),
      isAdmin,
      tr,
      teraz
    ]);
    sheetT.getRange(ticketRow, 9).setValue(teraz);

    if (isAdmin) {
      if (ticketUserId && ticketUserId !== uid) {
        var tytA = "Odpowiedź administratora w tickecie: " + ticketTemat;
        var opA = (String(imie || "Admin") + ": " + tr).substring(0, 200);
        _zapiszZdarzeniePowiadomienia(
          ticketUserId,
          "ticket_reply_" + tid + "_" + Date.now(),
          "ticket",
          "💬",
          tytA,
          opA,
          "page-kontakt"
        );
        wyslijPowiadomienieDoUserow(ticketUserId, tytA, opA);
      }
    } else {
      // Autor odpisał → powiadom TYLKO przypisanego admina (jeśli jest)
      if (assignedId && assignedId !== uid) {
        var tytU = "Nowa wiadomość w tickecie: " + ticketTemat;
        var opU = (String(imie || uid) + ": " + tr).substring(0, 200);
        _zapiszZdarzeniePowiadomienia(
          assignedId,
          "ticket_reply_" + tid + "_" + Date.now(),
          "ticket",
          "💬",
          tytU,
          opU,
          "page-kontakt"
        );
        wyslijPowiadomienieDoUserow(assignedId, tytU, opU);
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

    if (!isAuthor && !isAssigned && !isHelper && !isAdmin) {
      return { sukces: false, wiadomosc: "Nie możesz dodawać osób do tego ticketu." };
    }
    // Admin nieprzypisany do cudzego ticketu — najpierw przejęcie (jak wcześniej)
    if (isAdmin && !isAuthor && !isAssigned && !isHelper && assignedId) {
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
      "ticket_help_" + tid + "_" + Date.now(),
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
    if (isAdmin && assignedId && assignedId !== uid && ticketUserId !== uid && !isHelperZm) {
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

    if (isAdmin && ticketUserId && ticketUserId !== uid) {
      var tyt = (statusDocelowy === "Zamknięty" ? "Ticket zamknięty: " : "Ticket otwarty: ") + ticketTemat;
      _zapiszZdarzeniePowiadomienia(
        ticketUserId,
        "ticket_status_" + tid + "_" + Date.now(),
        "ticket",
        statusDocelowy === "Zamknięty" ? "🔒" : "🔓",
        tyt,
        sysTresc,
        "page-kontakt"
      );
      wyslijPowiadomienieDoUserow(ticketUserId, tyt, sysTresc);
    } else if (!isAdmin && assignedId) {
      var tyt2 = (statusDocelowy === "Zamknięty" ? "Ticket zamknięty przez użytkownika: " : "Ticket otwarty: ") + ticketTemat;
      _zapiszZdarzeniePowiadomienia(
        assignedId,
        "ticket_status_" + tid + "_" + Date.now(),
        "ticket",
        statusDocelowy === "Zamknięty" ? "🔒" : "🔓",
        tyt2,
        sysTresc,
        "page-kontakt"
      );
      wyslijPowiadomienieDoUserow(assignedId, tyt2, sysTresc);
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
    var tz = Session.getScriptTimeZone();

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
function ustawMojaLokalizacje() {
  return ustawLokalizacjeCheckin(
    "2212",
    0,
    0,
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

    var tz = Session.getScriptTimeZone();
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
        godzina: Utilities.formatDate(dt, tz, "HH:mm"),
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
    var tz = Session.getScriptTimeZone();
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
        var aktywny = !doKey || (doKey >= Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
        przydzialy.push({
          dzien: nazwyDni[dt.getDay()],
          dayIdx: dt.getDay(),
          godzina: Utilities.formatDate(dt, tz, "HH:mm"),
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
        if (okOd && okDo) trafione.push(pr);
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
          dzien: Utilities.formatDate(d, tz, "EEEE"),
          godzina: Utilities.formatDate(d, tz, "HH:mm"),
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
    var tz = Session.getScriptTimeZone();

    // Stałe dyżury (wzorzec tygodniowy) — jak DYŻURY.docx
    var dyzuryTabela = [];
    var dyzuryLektorzy = [];
    var sheetD = ss.getSheetByName("Dyżury");
    if (sheetD && sheetD.getLastRow() > 1) {
      var dd = sheetD.getDataRange().getValues();
      var tzPdf = Session.getScriptTimeZone();
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
          godzina = Utilities.formatDate(dt, tzPdf, "HH:mm");
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
        _zapiszZdarzeniePowiadomienia(ticketUserId, "ticket_claim_" + tid + "_" + Date.now(), "ticket", "🙋", tyt, op, "page-kontakt");
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
    var tz = Session.getScriptTimeZone();
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
    if (String(wykonawcaId || "").trim() !== "2212") {
      return { sukces: false, wiadomosc: "Tylko konto 2212 może ustawiać zielony baner." };
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
    var sheetK = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Kandydaci");
    if (sheetK && sheetK.getLastRow() > 1) {
      var dk = sheetK.getDataRange().getValues();
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
      var tz = Session.getScriptTimeZone();
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
      var tzD = Session.getScriptTimeZone();
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
          godzina: Utilities.formatDate(d, tzD, "HH:mm"),
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

    var tz = Session.getScriptTimeZone();
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

    var wykrytyUserId = String(info.manualUserId || "").trim();
    if (!wykrytyUserId && deviceId) {
      try { wykrytyUserId = _pobierzUserIdPoDeviceId(deviceId) || ""; } catch (eU) {}
    }

    var sheet = _arkuszZgloszenBledow();
    var teraz = new Date();
    var tz = Session.getScriptTimeZone();
    var dataStr = Utilities.formatDate(teraz, tz, "yyyy-MM-dd HH:mm:ss");
    var idKrotki = "BUG-" + Utilities.formatDate(teraz, tz, "yyMMdd-HHmmss");

    sheet.appendRow([
      dataStr, kat, op, kont, ua, plat, roz, jez, url, "Nowe", "",
      deviceId, wykrytyUserId, ""
    ]);

    try {
      if (typeof wyslijPowiadomienieDoUserow === "function") {
        wyslijPowiadomienieDoUserow(
          "2212",
          "🐞 Nowe zgłoszenie błędu (" + kat + ")",
          (op ? op.substring(0, 120) : "Bez opisu")
        );
      }
    } catch (ePush) {}

    try {
      if (typeof _powiadomAdminowONowymDoPrzegladu === "function") {
        _powiadomAdminowONowymDoPrzegladu(
          "🐞 Zgłoszenie błędu: " + kat,
          (op ? op.substring(0, 150) : "(bez opisu)") + (kont ? (" · kontakt: " + kont) : ""),
          "page-ustawienia",
          ""
        );
      }
    } catch (eNotifInApp) {}

    _logAdmin("ANON", "Gość", "BUG_REPORT", kat, dataStr + " | " + (op ? op.substring(0, 120) : "bez opisu"));

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