/*
  =====================================================================
   TIMBRE ALBA V2 - Timbre escolar programable con panel web por roles
  =====================================================================
   Placa:   ESP32-C3 SuperMini  (Arduino-ESP32 core 3.3.x)
   Reloj:   DS1302 (CLK=GPIO4, DAT=GPIO5, RST=GPIO6)
   Salida:  módulo de relé (GPIO8 por defecto, ver config.h)

   Bibliotecas (Gestor de bibliotecas del Arduino IDE):
     - "Rtc by Makuna"  2.5.x
     - "ArduinoJson"    7.x   (Benoit Blanchon)
   Incluidas en el core: WiFi, WebServer, DNSServer, ESPmDNS, Preferences,
   LittleFS, HTTPClient, NetworkClientSecure, mbedtls.

   Arduino IDE > Herramientas:
     Placa: "ESP32C3 Dev Module" · USB CDC On Boot: "Enabled"
     Partition Scheme: "Default 4MB with spiffs" (LittleFS usa esa partición)

   Seguridad (resumen; detalle en SECURITY.md):
     - Sin contraseñas en el código: los valores iniciales están en secrets.h
       (excluido de Git) y solo se usan en el primer arranque.
     - Contraseñas guardadas como PBKDF2-HMAC-SHA256 con sal aleatoria.
     - Cambio de contraseña obligatorio en el primer ingreso.
     - Sesiones con token aleatorio de 128 bits, expiración y bloqueo por
       intentos fallidos. Permisos verificados SIEMPRE en el equipo.
     - Historial de auditoría local + respaldo firmado (HMAC) a Google Sheets.
  =====================================================================
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <ArduinoJson.h>
#include <ThreeWire.h>
#include <RtcDS1302.h>
#include <mbedtls/md.h>
#include <mbedtls/gcm.h>
#include <mbedtls/base64.h>
#include <esp_random.h>
#include <esp_task_wdt.h>
#include <functional>
#include <time.h>

#include "config.h"
#include "types.h"
#include "crypto_util.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Falta secrets.h: copie secrets.example.h como secrets.h y escriba sus valores."
#endif
#include "google_roots.h"
static_assert(sizeof(INITIAL_AP_PASSWORD) - 1 >= 8, "INITIAL_AP_PASSWORD (secrets.h) debe tener al menos 8 caracteres");
#include "web_assets.h"

// =====================================================================
//  Objetos globales
// =====================================================================
ThreeWire rtcWire(PIN_RTC_DAT, PIN_RTC_CLK, PIN_RTC_CE);
RtcDS1302<ThreeWire> rtc(rtcWire);
WebServer server(80);
DNSServer dns;
Preferences prefs;

static const char *roleName(uint8_t r) { return r == ROLE_ADMIN ? "admin" : "usuario"; }

User users[MAX_USERS];
uint8_t userCount = 0;
LoginGuard guards[MAX_USERS];
uint32_t globalFailWindowStart = 0;
uint8_t  globalFails = 0;

Schedule schedules[MAX_SCHEDULES];
uint8_t scheduleCount = 0;
uint16_t nextScheduleId = 1;

Session sessions[MAX_SESSIONS];
Session *cur = nullptr;  // sesión de la petición en curso

Actor actor;
NetCfg net;
GsCfg gs;
SyncState syncSt;

bool automaticMode = true;
bool relayOn = false;
uint32_t relayStartedAt = 0, relayMs = 0, lastManualAt = 0;
uint32_t lastFiredKey = 0, lastMinuteKey = 0;
uint32_t auditSeq = 0;
String logEpoch;
bool apIsDefault = true;
uint32_t restartAt = 0;
uint32_t lastNtpToRtc = 0;
bool ntpStarted = false;
bool fsOk = false;
uint32_t cfgRev = 0, backupRev = 0;  // detecta cambios hechos después de la última copia
String lastBackupAt;

void markChanged() {
  cfgRev++;
  prefs.putUInt("cfgRev", cfgRev);
}

static const char *DAY_SHORT[7] = {"Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"};

void setUserPassword(User &u, const String &pw) {
  esp_fill_random(u.salt, sizeof(u.salt));
  u.iter = PBKDF2_ITERATIONS;
  pbkdf2Sha256((const uint8_t *)pw.c_str(), pw.length(), u.salt, sizeof(u.salt), u.iter, u.hash);
}

bool checkUserPassword(const User &u, const String &pw) {
  uint8_t h[32];
  pbkdf2Sha256((const uint8_t *)pw.c_str(), pw.length(), u.salt, sizeof(u.salt), u.iter, h);
  bool ok = ctEqual(h, u.hash, 32);
  memset(h, 0, sizeof(h));
  return ok;
}

// Se ejecuta cuando el usuario no existe, para que la respuesta tarde lo mismo
// y no se pueda averiguar qué nombres de usuario son válidos.
void dummyPasswordWork(const String &pw) {
  uint8_t salt[16] = {0}, h[32];
  pbkdf2Sha256((const uint8_t *)pw.c_str(), pw.length(), salt, sizeof(salt), PBKDF2_ITERATIONS, h);
}

// =====================================================================
//  Validaciones
// =====================================================================
// Nombres de usuario: 3-20 letras/números, empieza por letra.
// Se normalizan a "Primera mayúscula, resto minúscula" (rector -> Rector).
String normalizeUsername(String s) {
  s.trim();
  if (s.length() < 3 || s.length() > 20) return "";
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    bool digit = c >= '0' && c <= '9';
    if (!(letter || digit) || (i == 0 && !letter)) return "";
  }
  s.toLowerCase();
  s.setCharAt(0, toupper(s[0]));
  return s;
}

const char *passwordProblem(const String &pw, const String &username) {
  if (pw.length() < PASSWORD_MIN_LEN) return "La contraseña debe tener al menos 10 caracteres.";
  if (pw.length() > 64) return "La contraseña no puede superar 64 caracteres.";
  bool hasLetter = false, hasDigit = false;
  for (size_t i = 0; i < pw.length(); i++) {
    uint8_t c = pw[i];
    if (c < 32 || c == 127) return "La contraseña tiene caracteres no permitidos.";
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 128) hasLetter = true;
    if (c >= '0' && c <= '9') hasDigit = true;
  }
  if (!hasLetter || !hasDigit) return "Use letras y números en la contraseña.";
  String lp = pw, lu = username;
  lp.toLowerCase(); lu.toLowerCase();
  if (lu.length() && lp.indexOf(lu) >= 0) return "La contraseña no puede contener el nombre de usuario.";
  static const char *weak[] = {"1234567890", "0123456789", "password1", "contrasena", "contraseña",
                               "qwertyuiop", "cambiar", "timbre", "admin123", "colegio"};
  for (auto w : weak) if (lp.indexOf(w) >= 0) return "Esa contraseña es demasiado común. Elija otra.";
  if (pw == INITIAL_ADMIN_PASSWORD) return "No puede reutilizar la contraseña inicial.";
  return nullptr;
}

bool validPrintable(const String &s, size_t minLen, size_t maxLen) {
  if (s.length() < minLen || s.length() > maxLen) return false;
  for (size_t i = 0; i < s.length(); i++) {
    uint8_t c = s[i];
    if (c < 32 || c == 127) return false;
  }
  return true;
}

bool validAsciiPrintable(const String &s, size_t minLen, size_t maxLen) {
  if (s.length() < minLen || s.length() > maxLen) return false;
  for (size_t i = 0; i < s.length(); i++) if (s[i] < 32 || s[i] > 126) return false;
  return true;
}

bool isPrivateIp(const IPAddress &ip) {
  return ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] == 192 && ip[1] == 168);
}

// =====================================================================
//  Reloj (DS1302 + NTP)
// =====================================================================
RtcDateTime nowCache;
uint32_t nowCacheAt = 0;
bool nowCacheValid = false, rtcOk = false;

bool rtcPlausible(const RtcDateTime &dt) {
  return dt.IsValid() && dt.Year() >= 2025 && dt.Year() <= 2099;
}

RtcDateTime nowLocal() {
  if (!nowCacheValid || millis() - nowCacheAt >= 200) {
    nowCache = rtc.GetDateTime();
    nowCacheAt = millis();
    nowCacheValid = true;
    rtcOk = rtcPlausible(nowCache);
  }
  return nowCache;
}

String isoTime(const RtcDateTime &dt) {
  char b[32];
  snprintf(b, sizeof(b), "%04u-%02u-%02uT%02u:%02u:%02u", dt.Year(), dt.Month(), dt.Day(),
           dt.Hour(), dt.Minute(), dt.Second());
  return String(b);
}
String hhmm(uint8_t h, uint8_t m) {
  char b[8];
  snprintf(b, sizeof(b), "%02u:%02u", h, m);
  return String(b);
}
uint8_t dayIndex(const RtcDateTime &dt) { return (dt.DayOfWeek() + 6) % 7; }  // 0 = lunes

// La V1 no quitaba la protección de escritura del DS1302: SetDateTime()
// se ignoraba en silencio. Aquí se quita y se verifica leyendo de vuelta.
bool rtcSet(const RtcDateTime &dt) {
  if (rtc.GetIsWriteProtected()) rtc.SetIsWriteProtected(false);
  if (!rtc.GetIsRunning()) rtc.SetIsRunning(true);
  rtc.SetDateTime(dt);
  nowCacheValid = false;
  RtcDateTime back = rtc.GetDateTime();
  int32_t diff = (int32_t)back.TotalSeconds() - (int32_t)dt.TotalSeconds();
  rtcOk = rtcPlausible(back);
  return rtcOk && diff >= -2 && diff <= 2;
}

bool timeSynced() { return time(nullptr) > 1767225600; }  // posterior a 2026-01-01: hubo NTP

int daysInMonth(int y, int m) {
  static const uint8_t d[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0)) return 29;
  return d[m - 1];
}

// =====================================================================
//  Historial de auditoría (LittleFS, líneas JSON)
// =====================================================================
void auditRotateIfNeeded() {
  File f = LittleFS.open("/audit.log", "r");
  size_t sz = f ? f.size() : 0;
  if (f) f.close();
  if (sz < AUDIT_FILE_MAX_BYTES) return;
  LittleFS.remove("/audit.1");
  LittleFS.rename("/audit.log", "/audit.1");
}

void audit(const char *action, const String &detail) {
  JsonDocument d;
  d["q"] = ++auditSeq;
  RtcDateTime n = nowLocal();
  d["t"] = rtcOk ? isoTime(n) : String("");
  d["u"] = actor.name;
  d["r"] = actor.role;
  d["a"] = action;
  d["d"] = detail.substring(0, 180);
  d["ip"] = actor.ip;
  String line;
  serializeJson(d, line);
  if (fsOk) {
    auditRotateIfNeeded();
    File f = LittleFS.open("/audit.log", "a");
    if (f) { f.println(line); f.close(); }
  }
  prefs.putUInt("seq", auditSeq);
  Serial.println(line);
}

// Recorre el historial en orden cronológico (archivo viejo y luego el actual)
void forEachAuditLine(std::function<bool(const String &)> cb) {
  const char *files[] = {"/audit.1", "/audit.log"};
  for (auto path : files) {
    File f = LittleFS.open(path, "r");
    if (!f) continue;
    while (f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.length() < 5) continue;
      if (!cb(line)) { f.close(); return; }
    }
    f.close();
  }
}

void setActorFromSession(Session *s) {
  actor.name = s->user;
  actor.role = roleName(s->role);
  actor.ip = server.client().remoteIP().toString();
}
void clearActor() { actor.name = "Sistema"; actor.role = "sistema"; actor.ip = ""; }

// =====================================================================
//  Persistencia: usuarios y horarios (LittleFS), configuración (NVS)
// =====================================================================
// Escritura segura: se escribe un .tmp y luego se reemplaza. Si se va la luz
// a mitad de escritura, al arrancar se recupera el .tmp.
bool writeJsonFile(const char *path, JsonDocument &doc) {
  String tmp = String(path) + ".tmp";
  File f = LittleFS.open(tmp, "w");
  if (!f) return false;
  size_t n = serializeJson(doc, f);
  f.close();
  if (n == 0) return false;
  LittleFS.remove(path);
  return LittleFS.rename(tmp, path);
}
bool readJsonFile(const char *path, JsonDocument &doc) {
  String tmp = String(path) + ".tmp";
  if (!LittleFS.exists(path) && LittleFS.exists(tmp)) LittleFS.rename(tmp, path);
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  return !e;
}

// Conversión usuarios <-> JSON (la usan el archivo interno y las copias de seguridad)
void usersToJson(JsonArray a) {
  for (uint8_t i = 0; i < userCount; i++) {
    JsonObject o = a.add<JsonObject>();
    o["n"] = users[i].name;
    o["r"] = users[i].role;
    o["s"] = toHex(users[i].salt, 16);
    o["h"] = toHex(users[i].hash, 32);
    o["i"] = users[i].iter;
    o["m"] = users[i].mustChange;
    o["a"] = users[i].active;
  }
}

// Valida y carga usuarios desde JSON. Devuelve "" o el motivo del error.
String usersFromJson(JsonArrayConst a, User *out, uint8_t &count) {
  count = 0;
  if (a.isNull()) return "No hay lista de usuarios.";
  for (JsonObjectConst o : a) {
    if (count >= MAX_USERS) return "Hay más usuarios de los permitidos.";
    User u;
    memset(&u, 0, sizeof(u));
    String n = normalizeUsername(o["n"] | "");
    if (n.isEmpty()) return "Hay un nombre de usuario inválido.";
    for (uint8_t i = 0; i < count; i++) if (n.equals(out[i].name)) return "Usuario repetido: " + n;
    strlcpy(u.name, n.c_str(), sizeof(u.name));
    u.role = (o["r"] | 1) == 0 ? ROLE_ADMIN : ROLE_USER;
    u.iter = o["i"] | 0;
    u.mustChange = o["m"] | true;
    u.active = o["a"] | true;
    if (u.iter < 1000 || u.iter > 200000) return "Datos de contraseña dañados (" + n + ").";
    if (!fromHex(o["s"] | "", u.salt, 16) || !fromHex(o["h"] | "", u.hash, 32)) return "Datos de contraseña dañados (" + n + ").";
    out[count++] = u;
  }
  bool admin = false;
  for (uint8_t i = 0; i < count; i++) if (out[i].active && out[i].role == ROLE_ADMIN) admin = true;
  return admin ? "" : "No hay ningún administrador activo.";
}

bool saveUsers() {
  JsonDocument d;
  usersToJson(d.to<JsonArray>());
  markChanged();
  return writeJsonFile("/users.json", d);
}

int findUser(const String &name) {
  for (uint8_t i = 0; i < userCount; i++) if (name.equals(users[i].name)) return i;
  return -1;
}
uint8_t activeAdmins() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < userCount; i++) if (users[i].active && users[i].role == ROLE_ADMIN) n++;
  return n;
}

// Primer arranque: crea los administradores definidos en secrets.h con la
// contraseña inicial y la marca de "cambio obligatorio". La contraseña nunca
// se imprime ni se guarda en texto plano: solo su hash PBKDF2.
void provisionInitialAdmins() {
  userCount = 0;
  String list = INITIAL_ADMINS;
  int start = 0;
  while (start <= (int)list.length() && userCount < MAX_USERS) {
    int comma = list.indexOf(',', start);
    if (comma < 0) comma = list.length();
    String name = normalizeUsername(list.substring(start, comma));
    start = comma + 1;
    if (name.isEmpty() || findUser(name) >= 0) continue;
    User &u = users[userCount++];
    memset(&u, 0, sizeof(u));
    strlcpy(u.name, name.c_str(), sizeof(u.name));
    u.role = ROLE_ADMIN;
    u.active = true;
    u.mustChange = true;
    setUserPassword(u, INITIAL_ADMIN_PASSWORD);
  }
  saveUsers();
  audit("system.provision", String(userCount) + " administradores iniciales creados (deben cambiar su contraseña)");
  Serial.printf("Primer arranque: %u administradores iniciales creados. La clave inicial esta en secrets.h.\n", userCount);
}

void loadUsers() {
  JsonDocument d;
  userCount = 0;
  bool exists = LittleFS.exists("/users.json") || LittleFS.exists("/users.json.tmp");
  String err = "sin archivo";
  if (readJsonFile("/users.json", d)) err = usersFromJson(d.as<JsonArrayConst>(), users, userCount);
  if (err.length()) {
    userCount = 0;
    if (exists) audit("system.recover", "Archivo de usuarios dañado (" + err + "). Se recrean los administradores iniciales; restaure una copia de seguridad.");
    provisionInitialAdmins();
  }
  memset(guards, 0, sizeof(guards));
}

void sortSchedules() {
  for (uint8_t i = 1; i < scheduleCount; i++) {
    Schedule k = schedules[i];
    int j = i - 1;
    while (j >= 0 && (schedules[j].hour * 60 + schedules[j].minute) > (k.hour * 60 + k.minute)) {
      schedules[j + 1] = schedules[j];
      j--;
    }
    schedules[j + 1] = k;
  }
}

void schedulesToJson(JsonArray a) {
  for (uint8_t i = 0; i < scheduleCount; i++) {
    JsonObject o = a.add<JsonObject>();
    o["id"] = schedules[i].id;
    o["n"] = schedules[i].name;
    o["h"] = schedules[i].hour;
    o["m"] = schedules[i].minute;
    o["d"] = schedules[i].days;
    o["s"] = schedules[i].duration;
    o["e"] = schedules[i].enabled;
  }
}

String schedulesFromJson(JsonArrayConst a, Schedule *out, uint8_t &count) {
  count = 0;
  if (a.isNull()) return "";  // sin horarios es válido
  for (JsonObjectConst o : a) {
    if (count >= MAX_SCHEDULES) return "Hay más timbres de los permitidos.";
    Schedule s;
    memset(&s, 0, sizeof(s));
    s.id = o["id"] | 0;
    String name = o["n"] | "";
    int h = o["h"] | -1, m = o["m"] | -1, days = o["d"] | 0, dur = o["s"] | 0;
    if (s.id == 0 || !validPrintable(name, 1, 60) || h < 0 || h > 23 || m < 0 || m > 59 || days < 1 || days > 127 ||
        dur < 1 || dur > RING_MAX_SECONDS)
      return "Hay un timbre con datos inválidos.";
    for (uint8_t i = 0; i < count; i++) if (out[i].id == s.id) return "Hay timbres repetidos.";
    strlcpy(s.name, name.c_str(), sizeof(s.name));
    s.hour = h;
    s.minute = m;
    s.days = days;
    s.duration = dur;
    s.enabled = o["e"] | true;
    out[count++] = s;
  }
  return "";
}

bool saveSchedules() {
  JsonDocument d;
  schedulesToJson(d.to<JsonArray>());
  prefs.putUShort("nextId", nextScheduleId);
  markChanged();
  return writeJsonFile("/sched.json", d);
}

void loadSchedules() {
  scheduleCount = 0;
  nextScheduleId = prefs.getUShort("nextId", 1);
  JsonDocument d;
  if (!readJsonFile("/sched.json", d)) return;
  String err = schedulesFromJson(d.as<JsonArrayConst>(), schedules, scheduleCount);
  if (err.length()) {
    scheduleCount = 0;
    audit("system.recover", "Archivo de horarios dañado (" + err + "). Restaure una copia de seguridad.");
    return;
  }
  for (uint8_t i = 0; i < scheduleCount; i++) if (schedules[i].id >= nextScheduleId) nextScheduleId = schedules[i].id + 1;
  sortSchedules();
}

void loadConfig() {
  net.apSsid = prefs.getString("apSsid", INITIAL_AP_SSID);
  net.apPass = prefs.getString("apPass", INITIAL_AP_PASSWORD);
  net.apIp = prefs.getString("apIp", INITIAL_AP_IP);
  net.apMask = prefs.getString("apMask", "255.255.255.0");
  net.staEn = prefs.getBool("staEn", false);
  net.staSsid = prefs.getString("staSsid", "");
  net.staPass = prefs.getString("staPass", "");
  net.lanAdmin = prefs.getBool("lanAdmin", false);
  net.ntpEn = prefs.getBool("ntpEn", true);
  apIsDefault = (net.apPass == INITIAL_AP_PASSWORD);

  gs.en = prefs.getBool("gsEn", false);
  gs.url = prefs.getString("gsUrl", "");
  gs.key = prefs.getString("gsKey", "");
  gs.devId = prefs.getString("devId", DEVICE_ID);

  automaticMode = prefs.getBool("auto", true);
  lastFiredKey = prefs.getUInt("lastFired", 0);
  auditSeq = prefs.getUInt("seq", 0);
  syncSt.syncedSeq = prefs.getUInt("synced", 0);
  cfgRev = prefs.getUInt("cfgRev", 0);
  backupRev = prefs.getUInt("bkRev", 0);
  lastBackupAt = prefs.getString("bkAt", "");
  logEpoch = prefs.getString("logEpoch", "");
  if (logEpoch.isEmpty()) {  // identifica esta "vida" del historial ante Sheets
    logEpoch = randomHex(4);
    prefs.putString("logEpoch", logEpoch);
  }
}

// =====================================================================
//  Relé
// =====================================================================
void relayWrite(bool on) {
  digitalWrite(PIN_RELAY, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW);
}
void setRelay(bool on, uint32_t ms = 3000) {
  if (on) {
    relayMs = min<uint32_t>(ms, RING_MAX_SECONDS * 1000UL);  // nunca más de 60 s
    relayStartedAt = millis();
    relayOn = true;
  } else {
    relayOn = false;
  }
  relayWrite(relayOn);
}

// =====================================================================
//  Horarios: próximo timbre y disparo automático
// =====================================================================
String daysText(uint8_t mask) {
  if (mask == 0x7F) return "Todos los días";
  if (mask == 0x1F) return "Lun a Vie";
  if (mask == 0x3F) return "Lun a Sáb";
  if (mask == 0x60) return "Sáb y Dom";
  String s;
  for (uint8_t i = 0; i < 7; i++) if (mask & (1 << i)) { if (s.length()) s += ","; s += DAY_SHORT[i]; }
  return s;
}

// La V1 usaba el día de HOY para los 7 días de búsqueda: el "próximo timbre"
// salía mal los fines de semana. Aquí se recorre cada día realmente.
NextRing findNext(const RtcDateTime &now) {
  NextRing r = {false, -1, 0, UINT32_MAX};
  if (!rtcOk) return r;
  uint8_t today = dayIndex(now);
  uint32_t nowMin = now.Hour() * 60 + now.Minute();
  for (uint8_t d = 0; d <= 7; d++) {
    uint8_t day = (today + d) % 7;
    for (uint8_t i = 0; i < scheduleCount; i++) {
      const Schedule &s = schedules[i];
      if (!s.enabled || !(s.days & (1 << day))) continue;
      uint32_t t = s.hour * 60 + s.minute;
      if (d == 0 && t <= nowMin) continue;
      if (d == 7 && t > nowMin) continue;
      uint32_t sec = (d * 1440 + t - nowMin) * 60 - now.Second();
      if (sec < r.inSec) r = {true, i, day, sec};
    }
  }
  return r;
}

bool ringSoon(uint32_t withinSec) {
  if (!automaticMode) return false;
  NextRing n = findNext(nowLocal());
  return n.found && n.inSec <= withinSec;
}

// Se evalúa una vez por cada minuto nuevo (no solo en los segundos 0-2 como
// la V1): si el loop se demora unos segundos, el timbre igual suena.
void checkSchedules() {
  static uint32_t lastPoll = 0;
  if (millis() - lastPoll < 250) return;
  lastPoll = millis();
  RtcDateTime now = nowLocal();
  if (!rtcOk) return;
  uint32_t key = now.TotalSeconds() / 60;
  if (key == lastMinuteKey) return;
  lastMinuteKey = key;
  if (!automaticMode || key == lastFiredKey) return;
  uint8_t bit = 1 << dayIndex(now);
  uint8_t maxDur = 0;
  String names;
  for (uint8_t i = 0; i < scheduleCount; i++) {
    const Schedule &s = schedules[i];
    if (!s.enabled || !(s.days & bit) || s.hour != now.Hour() || s.minute != now.Minute()) continue;
    if (s.duration > maxDur) maxDur = s.duration;
    if (names.length()) names += " + ";
    names += s.name;
  }
  if (!maxDur) return;
  lastFiredKey = key;
  prefs.putUInt("lastFired", key);  // evita doble timbre si se reinicia en el mismo minuto
  setRelay(true, maxDur * 1000UL);
  clearActor();
  audit("ring.auto", hhmm(now.Hour(), now.Minute()) + " " + names + " (" + maxDur + " s)");
}

// =====================================================================
//  Sesiones y control de acceso
// =====================================================================
Session *newSession(const User &u) {
  int slot = -1;
  uint32_t oldest = UINT32_MAX;
  for (uint8_t i = 0; i < MAX_SESSIONS; i++) {
    if (!sessions[i].used) { slot = i; break; }
    if (sessions[i].lastSeen < oldest) { oldest = sessions[i].lastSeen; slot = i; }
  }
  Session &s = sessions[slot];
  s.used = true;
  strlcpy(s.token, randomHex(16).c_str(), sizeof(s.token));  // 128 bits
  strlcpy(s.user, u.name, sizeof(s.user));
  s.role = u.role;
  s.mustChange = u.mustChange;
  s.created = s.lastSeen = millis();
  return &s;
}

Session *findSession(const String &token) {
  if (token.length() != 32) return nullptr;
  Session *found = nullptr;
  uint32_t now = millis();
  for (uint8_t i = 0; i < MAX_SESSIONS; i++) {
    Session &s = sessions[i];
    if (!s.used) continue;
    if (now - s.lastSeen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) { s.used = false; continue; }
    if (ctEqual((const uint8_t *)s.token, (const uint8_t *)token.c_str(), 32)) found = &s;
  }
  if (found) found->lastSeen = now;
  return found;
}

void killSessionsOf(const char *name, Session *except = nullptr) {
  for (uint8_t i = 0; i < MAX_SESSIONS; i++)
    if (sessions[i].used && &sessions[i] != except && strcmp(sessions[i].user, name) == 0) sessions[i].used = false;
}

void securityHeaders() {
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.sendHeader("X-Frame-Options", "DENY");
  server.sendHeader("Referrer-Policy", "no-referrer");
  server.sendHeader("Content-Security-Policy",
                    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

void sendJson(int code, JsonDocument &d) {
  securityHeaders();
  server.sendHeader("Cache-Control", "no-store");
  String out;
  serializeJson(d, out);
  server.send(code, "application/json; charset=utf-8", out);
}
void sendOk(const String &msg = "") {
  JsonDocument d;
  d["ok"] = true;
  if (msg.length()) d["message"] = msg;
  sendJson(200, d);
}
void sendErr(int code, const String &msg, const char *errCode = nullptr) {
  JsonDocument d;
  d["ok"] = false;
  d["error"] = msg;
  if (errCode) d["code"] = errCode;
  sendJson(code, d);
}

// Si la administración por red institucional está apagada, solo se atiende a
// quien esté conectado a la red propia del timbre.
bool interfaceAllowed() {
  if (net.lanAdmin) return true;
  return server.client().localIP() == WiFi.softAPIP();
}

bool readBodyMax(JsonDocument &d, size_t maxBytes) {
  if (!server.hasArg("plain")) { sendErr(400, "Petición sin datos."); return false; }
  const String &b = server.arg("plain");
  if (b.length() > maxBytes) { sendErr(413, "Petición demasiado grande."); return false; }
  if (deserializeJson(d, b)) { sendErr(400, "Datos inválidos."); return false; }
  return true;
}
bool readBody(JsonDocument &d) { return readBodyMax(d, MAX_BODY_BYTES); }

// Guardia de TODAS las rutas protegidas. La interfaz oculta botones según el
// rol, pero la decisión real se toma aquí: ocultar un botón no es seguridad.
bool guard(bool adminOnly, bool allowMustChange = false) {
  cur = nullptr;
  if (!interfaceAllowed()) { sendErr(403, "Acceso permitido solo desde la red del timbre.", "interface"); return false; }
  Session *s = findSession(server.header("X-Session"));
  if (!s) { sendErr(401, "Sesión vencida. Ingrese de nuevo.", "auth"); return false; }
  cur = s;
  setActorFromSession(s);
  if (s->mustChange && !allowMustChange) {
    sendErr(403, "Debe cambiar su contraseña antes de continuar.", "must_change");
    return false;
  }
  if (adminOnly && s->role != ROLE_ADMIN) {
    audit("security.denied", "Intento de usar función de administrador: " + server.uri());
    sendErr(403, "Esta función es solo para administradores.", "forbidden");
    return false;
  }
  return true;
}

// =====================================================================
//  Rutas: archivos de la interfaz (comprimidos con gzip)
// =====================================================================
void serveAsset(const char *type, const uint8_t *data, size_t len) {
  if (!interfaceAllowed()) { server.send(403, "text/plain", "Acceso solo desde la red del timbre"); return; }
  securityHeaders();
  server.sendHeader("Cache-Control", "no-cache");
  server.sendHeader("ETag", WEB_ETAG);
  if (server.header("If-None-Match") == WEB_ETAG) { server.send(304, type, ""); return; }
  server.sendHeader("Content-Encoding", "gzip");
  server.send_P(200, type, (PGM_P)data, len);
}
void handleIndex() { serveAsset("text/html; charset=utf-8", WEB_INDEX_GZ, WEB_INDEX_GZ_LEN); }
void handleCss()   { serveAsset("text/css; charset=utf-8", WEB_CSS_GZ, WEB_CSS_GZ_LEN); }
void handleJs()    { serveAsset("application/javascript; charset=utf-8", WEB_JS_GZ, WEB_JS_GZ_LEN); }

String stripPort(String h) {
  int c = h.indexOf(':');
  return c >= 0 ? h.substring(0, c) : h;
}

// Portal cautivo: si un celular pregunta por otra página (p. ej. la prueba de
// conexión de Android/iPhone), se le redirige al panel del timbre.
void handleNotFound() {
  if (server.uri().startsWith("/api/")) { sendErr(404, "Ruta no encontrada."); return; }
  String host = stripPort(server.hostHeader());
  bool ours = host.isEmpty() || host == WiFi.softAPIP().toString() || host == String(MDNS_HOSTNAME) + ".local" ||
              (WiFi.status() == WL_CONNECTED && host == WiFi.localIP().toString());
  if (!ours && server.client().localIP() == WiFi.softAPIP()) {
    server.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/", true);
    server.send(302, "text/plain", "");
    return;
  }
  server.send(404, "text/plain", "No encontrado");
}

// =====================================================================
//  Rutas: autenticación
// =====================================================================
void handleLogin() {
  clearActor();
  if (!interfaceAllowed()) { sendErr(403, "Acceso permitido solo desde la red del timbre.", "interface"); return; }
  actor.ip = server.client().remoteIP().toString();
  JsonDocument d;
  if (!readBody(d)) return;
  String rawName = d["username"] | "";
  String pw = d["password"] | "";
  String name = normalizeUsername(rawName);
  uint32_t now = millis();

  // Freno global: más de 15 fallos por minuto en todo el equipo
  if (now - globalFailWindowStart > 60000) { globalFailWindowStart = now; globalFails = 0; }
  if (globalFails >= 15) { sendErr(429, "Demasiados intentos. Espere un minuto."); return; }

  int idx = name.isEmpty() ? -1 : findUser(name);
  if (idx >= 0 && guards[idx].lockUntil && (int32_t)(guards[idx].lockUntil - now) > 0) {
    uint32_t mins = (guards[idx].lockUntil - now) / 60000 + 1;
    sendErr(429, "Cuenta bloqueada por intentos fallidos. Intente en " + String(mins) + " min.");
    return;
  }
  bool ok = false;
  if (idx < 0 || pw.isEmpty() || pw.length() > 64) dummyPasswordWork(pw.substring(0, 64));
  else ok = users[idx].active && checkUserPassword(users[idx], pw);

  if (!ok) {
    globalFails++;
    String shown = name.length() ? name : String("(desconocido)");
    actor.name = shown;
    actor.role = "-";
    if (idx >= 0) {
      LoginGuard &g = guards[idx];
      if (++g.fails >= LOGIN_MAX_FAILS) {
        g.fails = 0;
        g.level = min<uint8_t>(g.level + 1, 4);
        g.lockUntil = now + LOGIN_LOCK_MS * (1UL << (g.level - 1));  // 5, 10, 20, 40 min
        audit("auth.locked", "Cuenta bloqueada " + String((LOGIN_LOCK_MS * (1UL << (g.level - 1))) / 60000) + " min por intentos fallidos");
      } else {
        audit("auth.fail", "Contraseña incorrecta");
      }
    } else {
      audit("auth.fail", "Usuario inexistente o inactivo");
    }
    sendErr(401, "Usuario o contraseña incorrectos.");
    return;
  }
  guards[idx].fails = 0;
  guards[idx].level = 0;
  guards[idx].lockUntil = 0;
  Session *s = newSession(users[idx]);
  setActorFromSession(s);
  audit("auth.login", users[idx].mustChange ? "Ingreso (debe cambiar contraseña)" : "Ingreso");
  JsonDocument out;
  out["ok"] = true;
  out["token"] = s->token;
  out["user"] = s->user;
  out["role"] = roleName(s->role);
  out["mustChange"] = s->mustChange;
  sendJson(200, out);
}

void handleLogout() {
  if (!guard(false, true)) return;
  audit("auth.logout", "Cierre de sesión");
  cur->used = false;
  sendOk();
}

void handleMe() {
  if (!guard(false, true)) return;
  JsonDocument d;
  d["ok"] = true;
  d["user"] = cur->user;
  d["role"] = roleName(cur->role);
  d["mustChange"] = cur->mustChange;
  sendJson(200, d);
}

void handlePassword() {
  if (!guard(false, true)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  String oldP = d["current"] | "", newP = d["new"] | "";
  int idx = findUser(cur->user);
  if (idx < 0) { sendErr(404, "Usuario no encontrado."); return; }
  if (oldP.length() > 64 || !checkUserPassword(users[idx], oldP)) {
    audit("auth.fail", "Contraseña actual incorrecta al intentar cambiarla");
    sendErr(403, "La contraseña actual no es correcta.");
    return;
  }
  if (const char *p = passwordProblem(newP, cur->user)) { sendErr(400, p); return; }
  if (newP == oldP) { sendErr(400, "La nueva contraseña debe ser distinta a la actual."); return; }
  setUserPassword(users[idx], newP);
  users[idx].mustChange = false;
  saveUsers();
  cur->mustChange = false;
  killSessionsOf(cur->user, cur);  // cierra la cuenta en otros dispositivos
  audit("auth.password", "Cambió su contraseña");
  sendOk("Contraseña actualizada.");
}

// =====================================================================
//  Rutas: estado e inicio
// =====================================================================
void handleStatus() {
  if (!guard(false)) return;
  RtcDateTime now = nowLocal();
  JsonDocument d;
  d["ok"] = true;
  d["now"] = rtcOk ? isoTime(now) : String("");
  d["dow"] = rtcOk ? dayIndex(now) : -1;
  d["rtcOk"] = rtcOk;
  d["ntp"] = timeSynced();
  JsonObject r = d["relay"].to<JsonObject>();
  r["on"] = relayOn;
  r["remainingMs"] = relayOn ? (int32_t)(relayMs - (millis() - relayStartedAt)) : 0;
  d["auto"] = automaticMode;
  NextRing n = findNext(now);
  if (automaticMode && n.found) {
    JsonObject nx = d["next"].to<JsonObject>();
    nx["name"] = schedules[n.idx].name;
    nx["time"] = hhmm(schedules[n.idx].hour, schedules[n.idx].minute);
    nx["dow"] = n.day;
    nx["in"] = n.inSec;
  }
  JsonArray today = d["today"].to<JsonArray>();
  if (rtcOk) {
    uint8_t bit = 1 << dayIndex(now);
    uint16_t nowMin = now.Hour() * 60 + now.Minute();
    for (uint8_t i = 0; i < scheduleCount; i++) {
      const Schedule &s = schedules[i];
      if (!(s.days & bit)) continue;
      JsonObject o = today.add<JsonObject>();
      o["id"] = s.id;
      o["name"] = s.name;
      o["time"] = hhmm(s.hour, s.minute);
      o["duration"] = s.duration;
      o["enabled"] = s.enabled;
      o["past"] = (s.hour * 60 + s.minute) < nowMin;
    }
  }
  JsonObject dev = d["device"].to<JsonObject>();
  dev["name"] = net.apSsid;
  dev["ip"] = WiFi.softAPIP().toString();
  dev["version"] = FW_VERSION;
  dev["uptime"] = millis() / 1000;
  JsonObject me = d["me"].to<JsonObject>();
  me["user"] = cur->user;
  me["role"] = roleName(cur->role);

  JsonArray w = d["warnings"].to<JsonArray>();
  if (!rtcOk) w.add("El reloj no tiene una hora válida: los timbres automáticos están detenidos. Un administrador debe ajustar la fecha y hora.");
  if (cur->role == ROLE_ADMIN) {
    if (apIsDefault) w.add("La clave Wi-Fi del timbre sigue siendo la de fábrica. Cámbiela en Red y equipo.");
    String pending;
    for (uint8_t i = 0; i < userCount; i++)
      if (users[i].active && users[i].mustChange) { if (pending.length()) pending += ", "; pending += users[i].name; }
    if (pending.length()) w.add("Usuarios que aún no cambian su contraseña inicial: " + pending + ".");
    if (lastBackupAt.isEmpty()) w.add("Aún no hay copia de seguridad de la configuración. Descárguela en Copias de seguridad.");
    else if (cfgRev != backupRev) {
      String bk = lastBackupAt;
      bk.replace("T", " ");
      w.add("Hay cambios posteriores a la última copia de seguridad (" + bk + "). Descargue una nueva.");
    }
    if (gs.en && !syncSt.lastOk && syncSt.lastAttempt) w.add("El respaldo en Google Sheets está fallando: " + syncSt.lastMsg);
  }
  sendJson(200, d);
}

// =====================================================================
//  Rutas: horarios (administradores y usuarios)
// =====================================================================
int findSchedule(uint16_t id) {
  for (uint8_t i = 0; i < scheduleCount; i++) if (schedules[i].id == id) return i;
  return -1;
}

void handleSchedulesGet() {
  if (!guard(false)) return;
  JsonDocument d;
  d["ok"] = true;
  JsonArray a = d["items"].to<JsonArray>();
  for (uint8_t i = 0; i < scheduleCount; i++) {
    JsonObject o = a.add<JsonObject>();
    o["id"] = schedules[i].id;
    o["name"] = schedules[i].name;
    o["time"] = hhmm(schedules[i].hour, schedules[i].minute);
    o["days"] = schedules[i].days;
    o["duration"] = schedules[i].duration;
    o["enabled"] = schedules[i].enabled;
  }
  d["max"] = MAX_SCHEDULES;
  sendJson(200, d);
}

// Valida los datos de un horario. Devuelve mensaje de error o "" si está bien.
String parseSchedule(JsonDocument &d, Schedule &s, uint16_t selfId) {
  String name = d["name"] | "";
  name.trim();
  if (!validPrintable(name, 1, 60)) return "El nombre debe tener entre 1 y 30 caracteres.";
  String t = d["time"] | "";
  int h = -1, m = -1;
  if (t.length() != 5 || sscanf(t.c_str(), "%d:%d", &h, &m) != 2 || h < 0 || h > 23 || m < 0 || m > 59)
    return "Hora inválida (use HH:MM).";
  int days = d["days"] | 0;
  if (days < 1 || days > 127) return "Seleccione al menos un día.";
  int dur = d["duration"] | 3;
  if (dur < 1 || dur > RING_MAX_SECONDS) return "La duración debe estar entre 1 y 60 segundos.";
  for (uint8_t i = 0; i < scheduleCount; i++) {
    const Schedule &o = schedules[i];
    if (o.id == selfId || o.hour != h || o.minute != m || !(o.days & days)) continue;
    uint8_t both = o.days & days;
    for (uint8_t k = 0; k < 7; k++)
      if (both & (1 << k)) return "Ya existe un timbre a las " + hhmm(h, m) + " el " + DAY_SHORT[k] + " (" + o.name + ").";
  }
  strlcpy(s.name, name.c_str(), sizeof(s.name));
  s.hour = h;
  s.minute = m;
  s.days = days;
  s.duration = dur;
  s.enabled = d["enabled"] | true;
  return "";
}

String schedText(const Schedule &s) {
  return hhmm(s.hour, s.minute) + " " + s.name + " [" + daysText(s.days) + ", " + s.duration + " s" + (s.enabled ? "" : ", pausado") + "]";
}

void handleSchedulesPost() {
  if (!guard(false)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  String action = d["action"] | "";

  if (action == "add") {
    if (scheduleCount >= MAX_SCHEDULES) { sendErr(400, "Se alcanzó el máximo de " + String(MAX_SCHEDULES) + " timbres."); return; }
    Schedule s;
    String e = parseSchedule(d, s, 0);
    if (e.length()) { sendErr(400, e); return; }
    s.id = nextScheduleId++;
    schedules[scheduleCount++] = s;
    sortSchedules();
    saveSchedules();
    audit("sched.add", schedText(s));
    sendOk("Timbre agregado.");
    return;
  }

  uint16_t id = d["id"] | 0;
  int idx = (action == "copyDay" || action == "clearDay") ? -2 : findSchedule(id);
  if (idx == -1) { sendErr(404, "Ese timbre ya no existe. Actualice la página."); return; }

  if (action == "update") {
    Schedule s;
    String e = parseSchedule(d, s, id);
    if (e.length()) { sendErr(400, e); return; }
    String before = schedText(schedules[idx]);
    s.id = id;
    schedules[idx] = s;
    sortSchedules();
    saveSchedules();
    audit("sched.update", before + " → " + schedText(s));
    sendOk("Timbre actualizado.");
  } else if (action == "toggle") {
    schedules[idx].enabled = d["enabled"] | !schedules[idx].enabled;
    saveSchedules();
    audit("sched.toggle", schedText(schedules[idx]));
    sendOk(schedules[idx].enabled ? "Timbre activado." : "Timbre pausado.");
  } else if (action == "delete") {
    String txt = schedText(schedules[idx]);
    for (uint8_t j = idx; j + 1 < scheduleCount; j++) schedules[j] = schedules[j + 1];
    scheduleCount--;
    saveSchedules();
    audit("sched.delete", txt);
    sendOk("Timbre eliminado.");
  } else if (action == "split") {
    // "Editar solo este día": separa un día de un timbre que aplica a varios
    int day = d["day"] | -1;
    if (day < 0 || day > 6 || !(schedules[idx].days & (1 << day))) { sendErr(400, "Día inválido."); return; }
    if (schedules[idx].days == (1 << day)) { JsonDocument o; o["ok"] = true; o["id"] = id; sendJson(200, o); return; }
    if (scheduleCount >= MAX_SCHEDULES) { sendErr(400, "Se alcanzó el máximo de timbres."); return; }
    Schedule copy = schedules[idx];
    schedules[idx].days &= ~(1 << day);
    copy.id = nextScheduleId++;
    copy.days = 1 << day;
    schedules[scheduleCount++] = copy;
    sortSchedules();
    saveSchedules();
    audit("sched.split", String("Separado el ") + DAY_SHORT[day] + " de: " + copy.name);
    JsonDocument o;
    o["ok"] = true;
    o["id"] = copy.id;
    sendJson(200, o);
  } else if (action == "copyDay") {
    // Copia los timbres de un día a otros (p. ej. lunes → martes a viernes)
    int from = d["from"] | -1;
    int to = d["to"] | 0;
    if (from < 0 || from > 6 || to < 1 || to > 127) { sendErr(400, "Días inválidos."); return; }
    to &= ~(1 << from);
    uint8_t changed = 0;
    for (uint8_t i = 0; i < scheduleCount; i++) {
      Schedule &s = schedules[i];
      if (!(s.days & (1 << from))) continue;
      uint8_t add = to & ~s.days;
      for (uint8_t j = 0; j < scheduleCount && add; j++)  // no duplica una hora que ese día ya tiene
        if (j != i && schedules[j].hour == s.hour && schedules[j].minute == s.minute) add &= ~schedules[j].days;
      if (add) { s.days |= add; changed++; }
    }
    saveSchedules();
    audit("sched.copy", String("Copiados ") + changed + " timbres del " + DAY_SHORT[from] + " a: " + daysText(to));
    sendOk(String(changed) + " timbres copiados.");
  } else if (action == "clearDay") {
    int day = d["day"] | -1;
    if (day < 0 || day > 6) { sendErr(400, "Día inválido."); return; }
    uint8_t removed = 0;
    for (int i = scheduleCount - 1; i >= 0; i--) {
      if (!(schedules[i].days & (1 << day))) continue;
      schedules[i].days &= ~(1 << day);
      removed++;
      if (schedules[i].days == 0) {
        for (uint8_t j = i; j + 1 < scheduleCount; j++) schedules[j] = schedules[j + 1];
        scheduleCount--;
      }
    }
    saveSchedules();
    audit("sched.clear", String("Vaciado el ") + DAY_SHORT[day] + " (" + removed + " timbres)");
    sendOk(String(removed) + " timbres quitados del " + DAY_SHORT[day] + ".");
  } else {
    sendErr(400, "Acción inválida.");
  }
}

// =====================================================================
//  Rutas: timbre manual
// =====================================================================
void handleRing() {
  if (!guard(false)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  int sec = d["seconds"] | 3;
  sec = constrain(sec, 1, (int)MANUAL_MAX_SECONDS);
  if (lastManualAt && millis() - lastManualAt < MANUAL_COOLDOWN_MS) { sendErr(429, "Espere unos segundos antes de volver a timbrar."); return; }
  lastManualAt = millis();
  setRelay(true, sec * 1000UL);
  audit("ring.manual", "Timbre manual " + String(sec) + " s");
  sendOk("Timbre sonando " + String(sec) + " s.");
}

void handleStop() {
  if (!guard(false)) return;
  bool was = relayOn;
  setRelay(false);
  if (was) audit("ring.stop", "Timbre detenido manualmente");
  sendOk("Timbre detenido.");
}

// =====================================================================
//  Rutas: solo administradores
// =====================================================================
void handleAuto() {
  if (!guard(true)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  automaticMode = d["enabled"] | true;
  prefs.putBool("auto", automaticMode);
  markChanged();
  audit("auto.set", automaticMode ? "Timbre automático ACTIVADO" : "Timbre automático DESACTIVADO");
  sendOk(automaticMode ? "Modo automático activado." : "Modo automático desactivado.");
}

void handleTime() {
  if (!guard(true)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  String date = d["date"] | "", t = d["time"] | "";
  int y, mo, da, h, mi, se = 0;
  if (sscanf(date.c_str(), "%d-%d-%d", &y, &mo, &da) != 3 || sscanf(t.c_str(), "%d:%d:%d", &h, &mi, &se) < 2) {
    sendErr(400, "Fecha u hora inválida.");
    return;
  }
  if (y < 2025 || y > 2099 || mo < 1 || mo > 12 || da < 1 || da > daysInMonth(y, mo) || h < 0 || h > 23 ||
      mi < 0 || mi > 59 || se < 0 || se > 59) {
    sendErr(400, "Fecha u hora fuera de rango.");
    return;
  }
  String before = rtcOk ? isoTime(nowLocal()) : String("sin hora válida");
  if (!rtcSet(RtcDateTime(y, mo, da, h, mi, se))) {
    sendErr(500, "El reloj DS1302 no aceptó la hora. Revise el cableado y la pila.");
    return;
  }
  lastMinuteKey = nowLocal().TotalSeconds() / 60;  // no dispara timbres "atrasados" por el ajuste
  audit("time.set", "De " + before + " a " + isoTime(nowLocal()));
  sendOk("Fecha y hora guardadas.");
}

void handleUsersGet() {
  if (!guard(true)) return;
  JsonDocument d;
  d["ok"] = true;
  JsonArray a = d["items"].to<JsonArray>();
  uint32_t now = millis();
  for (uint8_t i = 0; i < userCount; i++) {
    JsonObject o = a.add<JsonObject>();
    o["name"] = users[i].name;
    o["role"] = roleName(users[i].role);
    o["active"] = users[i].active;
    o["mustChange"] = users[i].mustChange;
    o["locked"] = guards[i].lockUntil && (int32_t)(guards[i].lockUntil - now) > 0;
    o["me"] = strcmp(users[i].name, cur->user) == 0;
  }
  d["max"] = MAX_USERS;
  sendJson(200, d);
}

void handleUsersPost() {
  if (!guard(true)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  String action = d["action"] | "";
  String name = normalizeUsername(d["username"] | "");
  if (name.isEmpty()) { sendErr(400, "Usuario inválido: 3 a 20 letras o números, empezando por letra."); return; }
  int idx = findUser(name);

  if (action == "add") {
    if (idx >= 0) { sendErr(400, "Ese usuario ya existe."); return; }
    if (userCount >= MAX_USERS) { sendErr(400, "Máximo " + String(MAX_USERS) + " usuarios."); return; }
    String role = d["role"] | "usuario";
    if (role != "admin" && role != "usuario") { sendErr(400, "Rol inválido."); return; }
    String pw = d["password"] | "";
    if (const char *p = passwordProblem(pw, name)) { sendErr(400, p); return; }
    User &u = users[userCount];
    memset(&u, 0, sizeof(u));
    strlcpy(u.name, name.c_str(), sizeof(u.name));
    u.role = role == "admin" ? ROLE_ADMIN : ROLE_USER;
    u.active = true;
    u.mustChange = true;  // la clave la conoce el admin: el usuario debe crear la suya
    setUserPassword(u, pw);
    guards[userCount] = {0, 0, 0};
    userCount++;
    saveUsers();
    audit("user.add", "Creó a " + name + " (" + role + ")");
    sendOk("Usuario creado. Deberá cambiar la contraseña al ingresar.");
    return;
  }
  if (idx < 0) { sendErr(404, "Usuario no encontrado."); return; }
  bool self = name.equals(cur->user);
  User &u = users[idx];

  if (action == "update") {
    String role = d["role"] | roleName(u.role);
    bool active = d["active"] | u.active;
    if (role != "admin" && role != "usuario") { sendErr(400, "Rol inválido."); return; }
    uint8_t newRole = role == "admin" ? ROLE_ADMIN : ROLE_USER;
    if (self && (newRole != u.role || !active)) { sendErr(400, "No puede cambiar su propio rol ni desactivarse."); return; }
    bool losesAdmin = u.role == ROLE_ADMIN && u.active && (newRole != ROLE_ADMIN || !active);
    if (losesAdmin && activeAdmins() <= 1) { sendErr(400, "Debe quedar al menos un administrador activo."); return; }
    String before = String(roleName(u.role)) + (u.active ? ", activo" : ", inactivo");
    u.role = newRole;
    u.active = active;
    saveUsers();
    killSessionsOf(u.name);  // aplica los nuevos permisos de inmediato
    audit("user.update", String(u.name) + ": " + before + " → " + roleName(u.role) + (u.active ? ", activo" : ", inactivo"));
    sendOk("Usuario actualizado.");
  } else if (action == "reset") {
    if (self) { sendErr(400, "Para su propia cuenta use Mi cuenta → Cambiar contraseña."); return; }
    String pw = d["password"] | "";
    if (const char *p = passwordProblem(pw, name)) { sendErr(400, p); return; }
    setUserPassword(u, pw);
    u.mustChange = true;
    guards[idx] = {0, 0, 0};
    saveUsers();
    killSessionsOf(u.name);
    audit("user.reset", String("Restableció la contraseña de ") + u.name);
    sendOk("Contraseña temporal asignada. Deberá cambiarla al ingresar.");
  } else if (action == "unlock") {
    guards[idx] = {0, 0, 0};
    audit("user.unlock", String("Desbloqueó a ") + u.name);
    sendOk("Cuenta desbloqueada.");
  } else if (action == "delete") {
    if (self) { sendErr(400, "No puede eliminar su propia cuenta."); return; }
    if (u.role == ROLE_ADMIN && u.active && activeAdmins() <= 1) { sendErr(400, "Debe quedar al menos un administrador activo."); return; }
    String deleted = u.name;
    killSessionsOf(u.name);
    for (uint8_t j = idx; j + 1 < userCount; j++) { users[j] = users[j + 1]; guards[j] = guards[j + 1]; }
    userCount--;
    saveUsers();
    audit("user.delete", "Eliminó a " + deleted);
    sendOk("Usuario eliminado.");
  } else {
    sendErr(400, "Acción inválida.");
  }
}

// Reglas de una configuración de red válida (panel y restauración de copias)
String validateNetCfg(const NetCfg &n) {
  if (!validAsciiPrintable(n.apSsid, 1, 32)) return "Nombre de red: 1 a 32 caracteres sin tildes ni ñ.";
  if (!validAsciiPrintable(n.apPass, 8, 63)) return "Clave Wi-Fi: 8 a 63 caracteres sin tildes ni ñ.";
  IPAddress ip, mask;
  if (!ip.fromString(n.apIp) || !isPrivateIp(ip)) return "IP inválida. Use una IP privada, p. ej. 192.168.4.1";
  if (n.apMask != "255.255.255.0" && n.apMask != "255.255.0.0") return "Máscara permitida: 255.255.255.0 o 255.255.0.0";
  if (ip[3] == 0 || ip[3] == 255) return "La IP no puede terminar en .0 ni en .255";
  if (n.staEn) {
    if (!validPrintable(n.staSsid, 1, 32)) return "Escriba el nombre de la red institucional.";
    if (n.staPass.length() && !validPrintable(n.staPass, 8, 63)) return "Clave de la red institucional: 8 a 63 caracteres.";
  }
  return "";
}

String validateGsCfg(const GsCfg &g) {
  if (g.url.length() && (!g.url.startsWith("https://script.google.com/macros/s/") || !g.url.endsWith("/exec") || g.url.length() > 200))
    return "La URL debe ser la de la aplicación web de Apps Script (https://script.google.com/macros/s/.../exec).";
  if (g.key.length() && !validAsciiPrintable(g.key, 32, 128)) return "La clave secreta debe tener entre 32 y 128 caracteres.";
  if (!validAsciiPrintable(g.devId, 1, 24)) return "Identificador de equipo inválido.";
  if (g.en && (g.url.isEmpty() || g.key.isEmpty())) return "Para activar el respaldo escriba la URL y la clave secreta.";
  return "";
}

void handleNetworkGet() {
  if (!guard(true)) return;
  JsonDocument d;
  d["ok"] = true;
  d["apSsid"] = net.apSsid;
  d["apIp"] = net.apIp;
  d["apMask"] = net.apMask;
  d["apPassDefault"] = apIsDefault;
  d["apClients"] = WiFi.softAPgetStationNum();
  d["staEnabled"] = net.staEn;
  d["staSsid"] = net.staSsid;
  d["staPassSet"] = net.staPass.length() > 0;  // la clave NUNCA se devuelve
  d["staConnected"] = WiFi.status() == WL_CONNECTED;
  d["staIp"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("");
  d["staRssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  d["lanAdmin"] = net.lanAdmin;
  d["ntpEnabled"] = net.ntpEn;
  d["ntpSynced"] = timeSynced();
  d["hostname"] = String(MDNS_HOSTNAME) + ".local";
  sendJson(200, d);
}

void handleNetworkPost() {
  if (!guard(true)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  NetCfg n = net;
  n.apSsid = d["apSsid"] | net.apSsid;
  n.apSsid.trim();
  String apPass = d["apPassword"] | "";
  n.apIp = d["apIp"] | net.apIp;
  n.apMask = d["apMask"] | net.apMask;
  n.staEn = d["staEnabled"] | net.staEn;
  n.staSsid = d["staSsid"] | net.staSsid;
  String staPass = d["staPassword"] | "";
  bool staPassClear = d["staPasswordClear"] | false;
  n.lanAdmin = d["lanAdmin"] | net.lanAdmin;
  n.ntpEn = d["ntpEnabled"] | net.ntpEn;

  if (apPass.length()) {
    if (apPass == INITIAL_AP_PASSWORD) { sendErr(400, "No use la clave Wi-Fi de fábrica."); return; }
    n.apPass = apPass;
  }
  n.staSsid.trim();
  if (staPass.length()) n.staPass = staPass;
  if (staPassClear) n.staPass = "";
  String e = validateNetCfg(n);
  if (e.length()) { sendErr(400, e); return; }
  IPAddress ip;
  ip.fromString(n.apIp);
  n.apIp = ip.toString();
  if (n.staEn && WiFi.status() == WL_CONNECTED) {
    IPAddress sip = WiFi.localIP();
    if (sip[0] == ip[0] && sip[1] == ip[1] && sip[2] == ip[2]) {
      sendErr(400, "La red del timbre no puede usar el mismo rango que la red institucional (" + sip.toString() + "). Use otra IP, p. ej. 192.168.50.1");
      return;
    }
  }

  String changes;
  auto add = [&](const String &c) { if (changes.length()) changes += "; "; changes += c; };
  if (n.apSsid != net.apSsid) add("Nombre Wi-Fi: " + net.apSsid + " → " + n.apSsid);
  if (n.apPass != net.apPass) add("Clave Wi-Fi cambiada");
  if (n.apIp != net.apIp) add("IP: " + net.apIp + " → " + n.apIp);
  if (n.apMask != net.apMask) add("Máscara: " + n.apMask);
  if (n.staEn != net.staEn) add(String("Red institucional ") + (n.staEn ? "activada" : "desactivada"));
  if (n.staSsid != net.staSsid) add("Red institucional: " + n.staSsid);
  if (n.staPass != net.staPass) add("Clave de red institucional cambiada");
  if (n.lanAdmin != net.lanAdmin) add(String("Administración desde red institucional ") + (n.lanAdmin ? "PERMITIDA" : "bloqueada"));
  if (n.ntpEn != net.ntpEn) add(String("Hora por internet ") + (n.ntpEn ? "activada" : "desactivada"));
  if (changes.isEmpty()) { sendOk("No hubo cambios."); return; }

  prefs.putString("apSsid", n.apSsid);
  prefs.putString("apPass", n.apPass);
  prefs.putString("apIp", n.apIp);
  prefs.putString("apMask", n.apMask);
  prefs.putBool("staEn", n.staEn);
  prefs.putString("staSsid", n.staSsid);
  prefs.putString("staPass", n.staPass);
  prefs.putBool("lanAdmin", n.lanAdmin);
  prefs.putBool("ntpEn", n.ntpEn);
  markChanged();
  net = n;
  apIsDefault = (net.apPass == INITIAL_AP_PASSWORD);
  audit("net.update", changes + ". Reinicio programado");
  JsonDocument o;
  o["ok"] = true;
  o["message"] = "Configuración guardada. El timbre se reiniciará en 2 segundos.";
  o["restart"] = true;
  o["ssid"] = net.apSsid;
  o["url"] = "http://" + net.apIp + "/";
  sendJson(200, o);
  restartAt = millis() + 2000;
}

void handleIntegrationGet() {
  if (!guard(true)) return;
  JsonDocument d;
  d["ok"] = true;
  d["enabled"] = gs.en;
  d["url"] = gs.url;
  d["keySet"] = gs.key.length() > 0;
  d["deviceId"] = gs.devId;
  d["lastOk"] = syncSt.lastOk;
  d["lastMsg"] = syncSt.lastMsg;
  d["lastAt"] = syncSt.lastAt;
  d["pending"] = auditSeq > syncSt.syncedSeq ? auditSeq - syncSt.syncedSeq : 0;
  d["staConnected"] = WiFi.status() == WL_CONNECTED;
  sendJson(200, d);
}

void handleIntegrationPost() {
  if (!guard(true)) return;
  JsonDocument d;
  if (!readBody(d)) return;
  if (String(d["action"] | "") == "test") {
    syncSt.forceTest = true;
    sendOk("Prueba en curso. Revise el estado en unos segundos.");
    return;
  }
  bool en = d["enabled"] | gs.en;
  String url = d["url"] | gs.url;
  url.trim();
  String key = d["key"] | "";
  String devId = d["deviceId"] | gs.devId;
  GsCfg g = gs;
  g.en = en;
  g.url = url;
  if (key.length()) g.key = key;
  g.devId = devId;
  String e = validateGsCfg(g);
  if (e.length()) { sendErr(400, e); return; }
  gs = g;
  prefs.putBool("gsEn", gs.en);
  prefs.putString("gsUrl", gs.url);
  prefs.putString("gsKey", gs.key);
  markChanged();
  prefs.putString("devId", gs.devId);
  audit("gs.update", String("Respaldo en Google Sheets ") + (gs.en ? "activado" : "desactivado") + (key.length() ? " (clave actualizada)" : ""));
  sendOk("Integración guardada.");
}

void handleAuditGet() {
  if (!guard(true)) return;
  uint32_t before = server.hasArg("before") ? server.arg("before").toInt() : UINT32_MAX;
  int limit = server.hasArg("limit") ? constrain(server.arg("limit").toInt(), 1, 100) : 50;
  String q = server.arg("q");
  q.toLowerCase();
  String fUser = server.arg("user");
  String fType = server.arg("type");
  String *ring = new String[limit];
  uint32_t matched = 0;
  forEachAuditLine([&](const String &line) {
    JsonDocument e;
    if (deserializeJson(e, line)) return true;
    uint32_t seq = e["q"] | 0;
    if (seq >= before) return true;
    if (fUser.length() && !fUser.equals(e["u"] | "")) return true;
    if (fType.length() && !String(e["a"] | "").startsWith(fType)) return true;
    if (q.length()) { String l = line; l.toLowerCase(); if (l.indexOf(q) < 0) return true; }
    ring[matched % limit] = line;
    matched++;
    return true;
  });
  // Se arma la respuesta a mano para no volver a interpretar cada línea
  securityHeaders();
  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json; charset=utf-8", "");
  server.sendContent("{\"ok\":true,\"more\":");
  server.sendContent(matched > (uint32_t)limit ? "true" : "false");
  server.sendContent(",\"items\":[");
  uint32_t count = min<uint32_t>(matched, limit);
  for (uint32_t k = 0; k < count; k++) {
    uint32_t pos = (matched - 1 - k) % limit;  // del más reciente al más antiguo
    if (k) server.sendContent(",");
    server.sendContent(ring[pos]);
  }
  server.sendContent("]}");
  server.sendContent("");
  delete[] ring;
}

// CSV con protección contra "inyección de fórmulas": un valor que empieza por
// = + - @ se ejecutaría como fórmula al abrirlo en Excel o Sheets.
String csvCell(String v) {
  if (v.length() && (v[0] == '=' || v[0] == '+' || v[0] == '-' || v[0] == '@')) v = "'" + v;
  v.replace("\"", "\"\"");
  return "\"" + v + "\"";
}

void handleAuditCsv() {
  if (!guard(true)) return;
  audit("audit.export", "Descargó el historial en CSV");
  securityHeaders();
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("Content-Disposition", "attachment; filename=\"historial-timbre.csv\"");
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/csv; charset=utf-8", "");
  server.sendContent("\xEF\xBB\xBF" "N.,Fecha y hora,Usuario,Rol,Acción,Detalle,IP\r\n");
  forEachAuditLine([&](const String &line) {
    JsonDocument e;
    if (deserializeJson(e, line)) return true;
    String row = String((uint32_t)(e["q"] | 0)) + "," + csvCell(e["t"] | "") + "," + csvCell(e["u"] | "") + "," +
                 csvCell(e["r"] | "") + "," + csvCell(e["a"] | "") + "," + csvCell(e["d"] | "") + "," +
                 csvCell(e["ip"] | "") + "\r\n";
    server.sendContent(row);
    return true;
  });
  server.sendContent("");
}

const char *resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "Encendido";
    case ESP_RST_SW: return "Reinicio por software";
    case ESP_RST_PANIC: return "Error de programa";
    case ESP_RST_TASK_WDT:
    case ESP_RST_INT_WDT:
    case ESP_RST_WDT: return "Vigilante (watchdog)";
    case ESP_RST_BROWNOUT: return "Bajo voltaje (revise la fuente)";
    case ESP_RST_EXT: return "Reset externo";
    default: return "Otro";
  }
}

void handleSystemGet() {
  if (!guard(true)) return;
  JsonDocument d;
  d["ok"] = true;
  d["version"] = FW_VERSION;
  d["uptime"] = millis() / 1000;
  d["heapFree"] = ESP.getFreeHeap();
  d["heapMin"] = ESP.getMinFreeHeap();
  d["fsTotal"] = fsOk ? LittleFS.totalBytes() : 0;
  d["fsUsed"] = fsOk ? LittleFS.usedBytes() : 0;
  d["resetReason"] = resetReasonText();
  d["mac"] = WiFi.macAddress();
  d["chip"] = ESP.getChipModel();
  d["cpuMhz"] = ESP.getCpuFreqMHz();
  d["relayPin"] = PIN_RELAY;
  d["schedules"] = scheduleCount;
  d["users"] = userCount;
  uint8_t act = 0;
  for (auto &s : sessions) if (s.used) act++;
  d["sessions"] = act;
  d["auditSeq"] = auditSeq;
  d["rtcOk"] = rtcOk;
  d["ntp"] = timeSynced();
  sendJson(200, d);
}

void handleReboot() {
  if (!guard(true)) return;
  audit("system.reboot", "Reinicio solicitado desde el panel");
  sendOk("Reiniciando…");
  restartAt = millis() + 1500;
}

// =====================================================================
//  Copias de seguridad cifradas (AES-256-GCM) y restauración
// =====================================================================
// La copia incluye claves Wi-Fi, la clave de Sheets y los hash de usuarios,
// por eso SIEMPRE sale cifrada con una frase que elige el administrador (no
// se guarda en el equipo). GCM además detecta cualquier alteración del
// archivo: si alguien lo modifica, la restauración se rechaza.
static const char BACKUP_AAD_PREFIX[] = "timbre-alba-backup-v1";

String backupAad(const String &device, const String &created) {
  return String(BACKUP_AAD_PREFIX) + "|" + device + "|" + created;
}

const char *backupPassProblem(const String &p) {
  if (p.length() < BACKUP_PASS_MIN) return "La frase de la copia debe tener al menos 12 caracteres.";
  if (p.length() > 128) return "La frase de la copia es demasiado larga.";
  bool l = false, dg = false;
  for (size_t i = 0; i < p.length(); i++) {
    uint8_t c = p[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 128) l = true;
    if (c >= '0' && c <= '9') dg = true;
  }
  return (l && dg) ? nullptr : "Use letras y números en la frase de la copia.";
}

void buildConfigDoc(JsonDocument &c) {
  c["format"] = "timbre-alba-config";
  c["v"] = 1;
  JsonObject n = c["net"].to<JsonObject>();
  n["apSsid"] = net.apSsid;
  n["apPass"] = net.apPass;
  n["apIp"] = net.apIp;
  n["apMask"] = net.apMask;
  n["staEn"] = net.staEn;
  n["staSsid"] = net.staSsid;
  n["staPass"] = net.staPass;
  n["lanAdmin"] = net.lanAdmin;
  n["ntpEn"] = net.ntpEn;
  JsonObject g = c["gs"].to<JsonObject>();
  g["en"] = gs.en;
  g["url"] = gs.url;
  g["key"] = gs.key;
  g["devId"] = gs.devId;
  c["auto"] = automaticMode;
  usersToJson(c["users"].to<JsonArray>());
  schedulesToJson(c["schedules"].to<JsonArray>());
}

void wipe(String &s) {
  for (size_t i = 0; i < s.length(); i++) s.setCharAt(i, 0);
  s = "";
}

void handleBackupInfo() {
  if (!guard(true)) return;
  JsonDocument d;
  d["ok"] = true;
  d["lastBackupAt"] = lastBackupAt;
  d["pendingChanges"] = cfgRev != backupRev;
  d["users"] = userCount;
  d["schedules"] = scheduleCount;
  sendJson(200, d);
}

void handleBackup() {
  if (!guard(true)) return;
  JsonDocument req;
  if (!readBody(req)) return;
  String pass = req["passphrase"] | "";
  if (const char *p = backupPassProblem(pass)) { sendErr(400, p); return; }

  JsonDocument c;
  buildConfigDoc(c);
  String plain;
  serializeJson(c, plain);
  c.clear();

  uint8_t salt[16], iv[12], key[32], tag[16];
  esp_fill_random(salt, sizeof(salt));
  esp_fill_random(iv, sizeof(iv));
  pbkdf2Sha256((const uint8_t *)pass.c_str(), pass.length(), salt, sizeof(salt), BACKUP_KDF_ITERATIONS, key);
  wipe(pass);
  String created = rtcOk ? isoTime(nowLocal()) : String("");
  String aad = backupAad(gs.devId, created);

  size_t len = plain.length();
  uint8_t *ct = (uint8_t *)malloc(len);
  size_t b64Len = 4 * ((len + 2) / 3) + 1;  // tamaño exacto de base64 + fin de texto
  uint8_t *b64 = (uint8_t *)malloc(b64Len);
  bool ok = ct && b64 && aesGcm(true, key, iv, aad, (const uint8_t *)plain.c_str(), len, ct, tag);
  size_t outLen = 0;
  if (ok) ok = mbedtls_base64_encode(b64, b64Len, &outLen, ct, len) == 0;
  memset(key, 0, sizeof(key));
  wipe(plain);
  free(ct);
  if (!ok) { free(b64); sendErr(500, "No hay memoria suficiente para crear la copia. Reinicie e intente de nuevo."); return; }

  JsonDocument f;
  f["format"] = "timbre-alba-backup";
  f["v"] = 1;
  f["device"] = gs.devId;
  f["createdAt"] = created;
  f["createdBy"] = cur->user;
  f["fw"] = FW_VERSION;
  JsonObject kdf = f["kdf"].to<JsonObject>();
  kdf["alg"] = "pbkdf2-sha256";
  kdf["iter"] = BACKUP_KDF_ITERATIONS;
  kdf["salt"] = toHex(salt, sizeof(salt));
  JsonObject ci = f["cipher"].to<JsonObject>();
  ci["alg"] = "aes-256-gcm";
  ci["iv"] = toHex(iv, sizeof(iv));
  ci["tag"] = toHex(tag, sizeof(tag));
  f["data"] = (const char *)b64;  // ArduinoJson copia el texto
  free(b64);

  backupRev = cfgRev;
  lastBackupAt = created.length() ? created : String("fecha desconocida");
  prefs.putUInt("bkRev", backupRev);
  prefs.putString("bkAt", lastBackupAt);
  audit("backup.create", "Descargó una copia de seguridad cifrada (" + String(userCount) + " usuarios, " + scheduleCount + " timbres)");
  String fname = "timbre-" + gs.devId + "-" + (created.length() ? created.substring(0, 10) : String("copia")) + ".json";
  server.sendHeader("Content-Disposition", "attachment; filename=\"" + fname + "\"");
  sendJson(200, f);
}

// Paso 1 "preview": descifra, valida TODO y muestra un resumen sin tocar nada.
// Paso 2 "apply": repite la validación y solo entonces reemplaza todo y reinicia.
void handleRestore() {
  if (!guard(true)) return;
  JsonDocument d;
  if (!readBodyMax(d, RESTORE_MAX_BYTES)) return;
  String action = d["action"] | "preview";
  String pass = d["passphrase"] | "";
  JsonObjectConst b = d["backup"];
  if (b.isNull() || String(b["format"] | "") != "timbre-alba-backup" || (b["v"] | 0) != 1) {
    sendErr(400, "El archivo no es una copia de seguridad de Timbre Alba.");
    return;
  }
  uint8_t salt[16], iv[12], tag[16], key[32];
  uint32_t iter = b["kdf"]["iter"] | 0;
  if (String(b["kdf"]["alg"] | "") != "pbkdf2-sha256" || String(b["cipher"]["alg"] | "") != "aes-256-gcm" ||
      iter < 1000 || iter > 200000 || !fromHex(b["kdf"]["salt"] | "", salt, 16) || !fromHex(b["cipher"]["iv"] | "", iv, 12) ||
      !fromHex(b["cipher"]["tag"] | "", tag, 16)) {
    sendErr(400, "El archivo de copia está incompleto o dañado.");
    return;
  }
  String created = b["createdAt"] | "", device = b["device"] | "", by = b["createdBy"] | "", fw = b["fw"] | "";
  const char *data = b["data"] | "";
  size_t dataLen = strlen(data), ctLen = 0;
  mbedtls_base64_decode(nullptr, 0, &ctLen, (const uint8_t *)data, dataLen);
  if (ctLen == 0 || ctLen > RESTORE_MAX_BYTES) { sendErr(400, "El archivo de copia está dañado."); return; }
  uint8_t *ct = (uint8_t *)malloc(ctLen);
  uint8_t *pt = (uint8_t *)malloc(ctLen + 1);
  if (!ct || !pt) { free(ct); free(pt); sendErr(500, "Memoria insuficiente. Reinicie el equipo e intente de nuevo."); return; }
  size_t got = 0;
  bool ok = mbedtls_base64_decode(ct, ctLen, &got, (const uint8_t *)data, dataLen) == 0;
  pbkdf2Sha256((const uint8_t *)pass.c_str(), pass.length(), salt, 16, iter, key);
  wipe(pass);
  ok = ok && aesGcm(false, key, iv, backupAad(device, created), ct, got, pt, tag);
  memset(key, 0, sizeof(key));
  free(ct);
  if (!ok) {
    free(pt);
    audit("backup.fail", "Restauración rechazada: frase incorrecta o archivo alterado");
    sendErr(400, "Frase incorrecta o archivo alterado. No se cambió nada.");
    return;
  }
  JsonDocument c;
  DeserializationError je = deserializeJson(c, (const char *)pt, got);
  memset(pt, 0, got);
  free(pt);
  d.clear();  // libera memoria del archivo recibido
  if (je || String(c["format"] | "") != "timbre-alba-config") { sendErr(400, "El contenido de la copia no es válido."); return; }

  // Validación completa en estructuras temporales: si algo falla, nada cambia.
  User *tu = new User[MAX_USERS];
  Schedule *ts = new Schedule[MAX_SCHEDULES];
  uint8_t nu = 0, ns = 0;
  String err = usersFromJson(c["users"], tu, nu);
  if (err.isEmpty()) err = schedulesFromJson(c["schedules"], ts, ns);
  NetCfg tn;
  JsonObjectConst jn = c["net"];
  tn.apSsid = jn["apSsid"] | "";
  tn.apPass = jn["apPass"] | "";
  tn.apIp = jn["apIp"] | "";
  tn.apMask = jn["apMask"] | "";
  tn.staEn = jn["staEn"] | false;
  tn.staSsid = jn["staSsid"] | "";
  tn.staPass = jn["staPass"] | "";
  tn.lanAdmin = jn["lanAdmin"] | false;
  tn.ntpEn = jn["ntpEn"] | true;
  if (err.isEmpty()) err = validateNetCfg(tn);
  GsCfg tg;
  JsonObjectConst jg = c["gs"];
  tg.en = jg["en"] | false;
  tg.url = jg["url"] | "";
  tg.key = jg["key"] | "";
  tg.devId = jg["devId"] | DEVICE_ID;
  if (err.isEmpty()) err = validateGsCfg(tg);
  bool autoMode = c["auto"] | true;
  c.clear();
  if (err.length()) {
    delete[] tu;
    delete[] ts;
    sendErr(400, "La copia no se puede aplicar: " + err);
    return;
  }

  if (action == "preview") {
    JsonDocument o;
    o["ok"] = true;
    o["createdAt"] = created;
    o["createdBy"] = by;
    o["device"] = device;
    o["fw"] = fw;
    JsonArray ua = o["users"].to<JsonArray>();
    for (uint8_t i = 0; i < nu; i++) {
      JsonObject u = ua.add<JsonObject>();
      u["name"] = tu[i].name;
      u["role"] = roleName(tu[i].role);
      u["active"] = tu[i].active;
    }
    o["schedules"] = ns;
    o["apSsid"] = tn.apSsid;
    o["apIp"] = tn.apIp;
    o["staEnabled"] = tn.staEn;
    o["staSsid"] = tn.staSsid;
    o["gsEnabled"] = tg.en;
    o["auto"] = autoMode;
    delete[] tu;
    delete[] ts;
    sendJson(200, o);
    return;
  }
  if (action != "apply") { delete[] tu; delete[] ts; sendErr(400, "Acción inválida."); return; }

  // Aplicar: usuarios, horarios y configuración, y reiniciar.
  String restoredBy = cur->user;
  memcpy(users, tu, sizeof(User) * nu);
  userCount = nu;
  memset(guards, 0, sizeof(guards));
  memcpy(schedules, ts, sizeof(Schedule) * ns);
  scheduleCount = ns;
  delete[] tu;
  delete[] ts;
  nextScheduleId = 1;
  for (uint8_t i = 0; i < scheduleCount; i++) if (schedules[i].id >= nextScheduleId) nextScheduleId = schedules[i].id + 1;
  sortSchedules();
  bool saved = saveUsers() & saveSchedules();
  net = tn;
  prefs.putString("apSsid", net.apSsid);
  prefs.putString("apPass", net.apPass);
  prefs.putString("apIp", net.apIp);
  prefs.putString("apMask", net.apMask);
  prefs.putBool("staEn", net.staEn);
  prefs.putString("staSsid", net.staSsid);
  prefs.putString("staPass", net.staPass);
  prefs.putBool("lanAdmin", net.lanAdmin);
  prefs.putBool("ntpEn", net.ntpEn);
  apIsDefault = (net.apPass == INITIAL_AP_PASSWORD);
  gs = tg;
  prefs.putBool("gsEn", gs.en);
  prefs.putString("gsUrl", gs.url);
  prefs.putString("gsKey", gs.key);
  prefs.putString("devId", gs.devId);
  automaticMode = autoMode;
  prefs.putBool("auto", automaticMode);
  backupRev = cfgRev;  // el estado actual es igual a una copia existente
  prefs.putUInt("bkRev", backupRev);
  for (auto &ss : sessions) ss.used = false;  // todos ingresan de nuevo con los usuarios restaurados
  audit("backup.restore", "Restauró la copia del " + (created.length() ? created : String("(sin fecha)")) + " hecha por " + by +
                              " en " + device + ": " + nu + " usuarios, " + ns + " timbres" + (saved ? "" : " (ERROR al guardar)"));
  JsonDocument o;
  o["ok"] = saved;
  o["message"] = saved ? "Copia restaurada. El timbre se reinicia ahora; ingrese con los usuarios de la copia."
                       : "Se restauró en memoria pero falló la escritura en flash. No apague el equipo y repita la restauración.";
  o["restart"] = saved;
  o["ssid"] = net.apSsid;
  o["url"] = "http://" + net.apIp + "/";
  sendJson(saved ? 200 : 500, o);
  if (saved) restartAt = millis() + 2500;
}

void setupRoutes() {
  server.on("/", HTTP_GET, handleIndex);
  server.on("/app.css", HTTP_GET, handleCss);
  server.on("/app.js", HTTP_GET, handleJs);
  server.on("/favicon.ico", HTTP_GET, []() { server.send(204); });
  server.on("/api/login", HTTP_POST, handleLogin);
  server.on("/api/logout", HTTP_POST, handleLogout);
  server.on("/api/me", HTTP_GET, handleMe);
  server.on("/api/password", HTTP_POST, handlePassword);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/schedules", HTTP_GET, handleSchedulesGet);
  server.on("/api/schedules", HTTP_POST, handleSchedulesPost);
  server.on("/api/ring", HTTP_POST, handleRing);
  server.on("/api/stop", HTTP_POST, handleStop);
  server.on("/api/auto", HTTP_POST, handleAuto);
  server.on("/api/time", HTTP_POST, handleTime);
  server.on("/api/users", HTTP_GET, handleUsersGet);
  server.on("/api/users", HTTP_POST, handleUsersPost);
  server.on("/api/network", HTTP_GET, handleNetworkGet);
  server.on("/api/network", HTTP_POST, handleNetworkPost);
  server.on("/api/integration", HTTP_GET, handleIntegrationGet);
  server.on("/api/integration", HTTP_POST, handleIntegrationPost);
  server.on("/api/audit", HTTP_GET, handleAuditGet);
  server.on("/api/audit.csv", HTTP_GET, handleAuditCsv);
  server.on("/api/system", HTTP_GET, handleSystemGet);
  server.on("/api/reboot", HTTP_POST, handleReboot);
  server.on("/api/backup", HTTP_POST, handleBackup);
  server.on("/api/backup", HTTP_GET, handleBackupInfo);
  server.on("/api/restore", HTTP_POST, handleRestore);
  server.onNotFound(handleNotFound);
  const char *headers[] = {"X-Session", "If-None-Match"};
  server.collectHeaders(headers, 2);
}

// =====================================================================
//  Red: punto de acceso + (opcional) red institucional, DNS, mDNS, NTP
// =====================================================================
void startNetwork() {
  WiFi.persistent(false);  // no duplicar credenciales en la zona de Wi-Fi del SDK
  bool sta = net.staEn && net.staSsid.length();
  WiFi.mode(sta ? WIFI_AP_STA : WIFI_AP);
  WiFi.setSleep(false);
  IPAddress ip, mask;
  if (!ip.fromString(net.apIp)) ip = IPAddress(192, 168, 4, 1);
  if (!mask.fromString(net.apMask)) mask = IPAddress(255, 255, 255, 0);
  WiFi.softAPConfig(ip, ip, mask);
  bool ok = WiFi.softAP(net.apSsid.c_str(), net.apPass.c_str(), 1, 0, AP_MAX_CLIENTS);
  Serial.printf("Red del timbre '%s' en http://%s  (%s)\n", net.apSsid.c_str(), WiFi.softAPIP().toString().c_str(), ok ? "OK" : "ERROR");
  if (sta) {
    WiFi.setAutoReconnect(true);
    WiFi.begin(net.staSsid.c_str(), net.staPass.c_str());
    Serial.printf("Conectando a la red institucional '%s'...\n", net.staSsid.c_str());
  }
  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", WiFi.softAPIP());
  if (MDNS.begin(MDNS_HOSTNAME)) MDNS.addService("http", "tcp", 80);
  setenv("TZ", TZ_POSIX, 1);
  tzset();
}

// Hora por internet: solo si hay red institucional. Corrige el DS1302, que
// puede atrasarse o adelantarse varios segundos por semana.
void ntpTick() {
  if (!net.ntpEn || WiFi.status() != WL_CONNECTED) return;
  if (!ntpStarted) {
    configTzTime(TZ_POSIX, NTP_SERVER1, NTP_SERVER2);
    ntpStarted = true;
    return;
  }
  if (!timeSynced()) return;
  if (lastNtpToRtc && millis() - lastNtpToRtc < NTP_TO_RTC_EVERY_MS && rtcOk) return;
  if (relayOn || ringSoon(90)) return;  // no tocar el reloj justo antes de un timbre
  time_t t = time(nullptr);
  struct tm lt;
  localtime_r(&t, &lt);
  RtcDateTime inet(lt.tm_year + 1900, lt.tm_mon + 1, lt.tm_mday, lt.tm_hour, lt.tm_min, lt.tm_sec);
  RtcDateTime r = nowLocal();
  bool hadTime = rtcOk;
  int32_t drift = hadTime ? (int32_t)r.TotalSeconds() - (int32_t)inet.TotalSeconds() : 0;
  lastNtpToRtc = millis();
  if (!hadTime || abs(drift) >= 2) {
    bool ok = rtcSet(inet);
    lastMinuteKey = nowLocal().TotalSeconds() / 60;  // no dispara timbres "saltados" por el ajuste
    clearActor();
    if (!ok) audit("time.ntp", "No se pudo escribir la hora en el DS1302 (revise cableado)");
    else if (!hadTime) audit("time.ntp", "Hora establecida por internet");
    else if (abs(drift) >= 5) audit("time.ntp", "Hora corregida por internet (desfase " + String(drift) + " s)");
  }
}

// =====================================================================
//  Respaldo del historial en Google Sheets (Apps Script)
// =====================================================================
// Cada envío va firmado con HMAC-SHA256 usando una clave que solo conocen el
// equipo y el Apps Script. Así, aunque la URL se filtre, nadie puede escribir
// registros falsos. TLS con certificados raíz de Google evita suplantaciones.
void syncTick() {
  if (!gs.en || gs.url.isEmpty() || gs.key.isEmpty()) return;
  if (WiFi.status() != WL_CONNECTED) { syncSt.lastMsg = "Sin conexión a la red institucional"; return; }
  bool test = syncSt.forceTest;
  if (!test && millis() - syncSt.lastAttempt < SYNC_INTERVAL_MS && syncSt.lastAttempt) return;
  if (!test && auditSeq <= syncSt.syncedSeq) return;
  if (!timeSynced()) { syncSt.lastMsg = "Esperando hora de internet (NTP)"; return; }
  if (relayOn || ringSoon(120)) return;  // prioridad absoluta: el timbre
  syncSt.forceTest = false;
  syncSt.lastAttempt = millis();

  JsonDocument p;
  p["v"] = 1;
  p["device"] = gs.devId;
  p["log"] = logEpoch;
  p["ts"] = (uint32_t)time(nullptr);
  JsonArray ev = p["events"].to<JsonArray>();
  uint32_t maxQ = syncSt.syncedSeq;
  uint8_t n = 0;
  forEachAuditLine([&](const String &line) {
    JsonDocument e;
    if (deserializeJson(e, line)) return true;
    uint32_t q = e["q"] | 0;
    if (q <= syncSt.syncedSeq) return true;
    ev.add(e);
    maxQ = q;
    return ++n < SYNC_BATCH;
  });
  String payload;
  serializeJson(p, payload);
  JsonDocument b;
  b["payload"] = payload;
  b["sig"] = hmacSha256Hex(gs.key, payload);
  String body;
  serializeJson(b, body);

  NetworkClientSecure tls;
  tls.setCACert(GOOGLE_ROOT_CAS);
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(10000);
  // Apps Script responde 302 hacia script.googleusercontent.com; HTTPClient lo
  // sigue con GET (comportamiento verificado en el core 3.3.x).
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  RtcDateTime now = nowLocal();
  syncSt.lastAt = rtcOk ? isoTime(now) : String("");
  if (!http.begin(tls, gs.url)) { syncSt.lastOk = false; syncSt.lastMsg = "URL inválida"; return; }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  String resp = code > 0 ? http.getString() : String("");
  http.end();

  JsonDocument r;
  bool parsed = !deserializeJson(r, resp);
  if (code == 200 && parsed && (r["ok"] | false)) {
    syncSt.syncedSeq = max<uint32_t>(maxQ, syncSt.syncedSeq);
    prefs.putUInt("synced", syncSt.syncedSeq);
    syncSt.lastOk = true;
    syncSt.lastMsg = n ? String(n) + " eventos respaldados" : String("Conexión correcta (sin eventos nuevos)");
  } else {
    syncSt.lastOk = false;
    if (code <= 0) syncSt.lastMsg = "Error de conexión: " + http.errorToString(code);
    else if (parsed && r["error"].is<const char *>()) syncSt.lastMsg = String("Apps Script: ") + (const char *)r["error"];
    else syncSt.lastMsg = "Respuesta HTTP " + String(code);
  }
  Serial.println("[Sheets] " + syncSt.lastMsg);
}

// =====================================================================
//  Restaurar de fábrica con el botón BOOT (acceso físico)
// =====================================================================
void checkResetButton() {
  static uint32_t pressedAt = 0;
  if (digitalRead(PIN_RESET_BTN) == HIGH) { pressedAt = 0; return; }
  if (!pressedAt) { pressedAt = millis() | 1; return; }
  if (millis() - pressedAt < FACTORY_RESET_HOLD_MS) return;
  clearActor();
  audit("system.factory", "Botón físico: red, usuarios e integración restaurados de fábrica");
  LittleFS.remove("/users.json");
  const char *keys[] = {"apSsid", "apPass", "apIp", "apMask", "staEn", "staSsid", "staPass", "lanAdmin", "gsEn", "gsUrl", "gsKey"};
  for (auto k : keys) prefs.remove(k);
  setRelay(false);
  delay(300);
  ESP.restart();
}

// =====================================================================
//  setup / loop
// =====================================================================
void setup() {
  // 1) Lo primero: relé apagado, antes de cualquier otra cosa.
  relayWrite(false);
  pinMode(PIN_RELAY, OUTPUT);
  relayWrite(false);
  pinMode(PIN_RESET_BTN, INPUT_PULLUP);

  Serial.begin(115200);
  delay(300);
  Serial.printf("\n=== %s v%s ===\n", FW_NAME, FW_VERSION);

  // 2) Vigilante: si el programa se cuelga más de 30 s, el equipo se reinicia
  //    solo (y el relé vuelve a quedar apagado por el paso 1).
  esp_task_wdt_config_t wdt = {.timeout_ms = 30000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&wdt);
  enableLoopWDT();

  prefs.begin("timbre", false);
  fsOk = LittleFS.begin(true);
  if (!fsOk) Serial.println("ERROR: no se pudo montar LittleFS (revise el esquema de particiones).");
  loadConfig();
  clearActor();

  rtc.Begin();
  if (rtc.GetIsWriteProtected()) rtc.SetIsWriteProtected(false);
  if (!rtc.GetIsRunning()) rtc.SetIsRunning(true);
  nowLocal();
  Serial.printf("Reloj: %s\n", rtcOk ? isoTime(nowCache).c_str() : "SIN HORA VALIDA (ajustar desde el panel)");

  loadUsers();
  loadSchedules();
  startNetwork();
  setupRoutes();
  server.begin();
  audit("system.boot", String("Equipo iniciado v") + FW_VERSION + " · " + resetReasonText());
}

void loop() {
  dns.processNextRequest();
  server.handleClient();
  cur = nullptr;
  clearActor();

  if (relayOn && millis() - relayStartedAt >= relayMs) setRelay(false);
  checkSchedules();
  ntpTick();
  syncTick();
  checkResetButton();

  if (restartAt && (int32_t)(millis() - restartAt) >= 0) {
    setRelay(false);
    ESP.restart();
  }
  delay(2);
}
