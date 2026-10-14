#pragma once
// =====================================================================
//  TIMBRE ALBA V2 - Configuración NO secreta (sí va a GitHub)
//  Los valores secretos (claves, usuarios iniciales) van en secrets.h,
//  que NUNCA se sube al repositorio (ver .gitignore).
// =====================================================================

#define FW_NAME    "Timbre Alba"
#define FW_VERSION "2.0.0"

// ---------- Pines ESP32-C3 SuperMini ----------
// Verifique el pinout de SU placa: los clones varían.
static const uint8_t PIN_RTC_CLK = 4;   // DS1302 CLK
static const uint8_t PIN_RTC_DAT = 5;   // DS1302 DAT (I/O)
static const uint8_t PIN_RTC_CE  = 6;   // DS1302 RST (CE)

// Relé del timbre.
// ADVERTENCIA: GPIO8 es pin de arranque (strapping) y en la SuperMini tiene
// el LED azul integrado. Funciona, pero se recomienda mover el relé a GPIO10
// (pin libre, sin funciones de arranque). Si lo mueve, cambie este valor.
static const uint8_t PIN_RELAY = 8;
// false = el módulo se activa con HIGH (jumper del módulo en "H").
// true  = el módulo se activa con LOW  (jumper en "L").
static const bool RELAY_ACTIVE_LOW = false;

// Botón BOOT de la placa (GPIO9). Mantenerlo presionado 10 s con el equipo
// encendido restaura red y usuarios de fábrica (requiere acceso físico).
static const uint8_t  PIN_RESET_BTN          = 9;
static const uint32_t FACTORY_RESET_HOLD_MS  = 10000;

// ---------- Límites del sistema ----------
static const uint8_t  MAX_SCHEDULES      = 80;
static const uint8_t  MAX_USERS          = 16;
static const uint8_t  MAX_SESSIONS       = 8;
static const uint16_t RING_MAX_SECONDS   = 60;   // automático: tope absoluto
static const uint16_t MANUAL_MAX_SECONDS = 10;   // manual desde la web
static const uint32_t MANUAL_COOLDOWN_MS = 3000; // evita "spam" del timbre

// ---------- Seguridad ----------
static const uint32_t SESSION_IDLE_MS     = 30UL * 60UL * 1000UL;      // 30 min sin uso
static const uint32_t SESSION_MAX_MS      = 8UL * 60UL * 60UL * 1000UL; // 8 h máximo
static const uint32_t PBKDF2_ITERATIONS   = 10000; // costo del hash de contraseñas
static const uint8_t  LOGIN_MAX_FAILS     = 5;     // intentos antes de bloquear
static const uint32_t LOGIN_LOCK_MS       = 5UL * 60UL * 1000UL;        // 5 min (se duplica)
static const uint8_t  PASSWORD_MIN_LEN    = 10;
static const size_t   MAX_BODY_BYTES      = 2048;  // tamaño máximo de una petición
static const size_t   RESTORE_MAX_BYTES   = 24576; // una copia de seguridad completa (~14 KB)

// ---------- Copias de seguridad ----------
static const uint32_t BACKUP_KDF_ITERATIONS = 20000; // costo de derivar la clave de cifrado
static const uint8_t  BACKUP_PASS_MIN       = 12;    // largo mínimo de la frase de la copia

// ---------- Historial (auditoría) ----------
static const size_t   AUDIT_FILE_MAX_BYTES = 48 * 1024; // rota a /audit.1 al llenarse
static const uint8_t  SYNC_BATCH           = 25;        // eventos por envío a Sheets
static const uint32_t SYNC_INTERVAL_MS     = 60000;

// ---------- Hora ----------
// Colombia: UTC-5 sin horario de verano (formato POSIX).
#define TZ_POSIX   "<-05>5"
#define NTP_SERVER1 "pool.ntp.org"
#define NTP_SERVER2 "time.google.com"
static const uint32_t NTP_TO_RTC_EVERY_MS = 6UL * 60UL * 60UL * 1000UL; // cada 6 h

// ---------- Red ----------
#define MDNS_HOSTNAME "timbre"   // http://timbre.local (Windows/iPhone/Mac)
static const uint8_t AP_MAX_CLIENTS = 6;
