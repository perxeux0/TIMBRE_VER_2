#pragma once
// Tipos de datos del firmware. Van en un .h aparte porque el Arduino IDE
// inserta prototipos de funciones al inicio del .ino, antes de las structs.
#include <Arduino.h>

enum Role : uint8_t { ROLE_ADMIN = 0, ROLE_USER = 1 };

struct User {
  char name[21];
  uint8_t role;
  uint8_t salt[16];
  uint8_t hash[32];
  uint32_t iter;
  bool mustChange;
  bool active;
};

struct LoginGuard { uint8_t fails; uint8_t level; uint32_t lockUntil; };

struct Schedule {
  uint16_t id;
  char name[64];
  uint8_t hour, minute;
  uint8_t days;      // bit0 = lunes ... bit6 = domingo
  uint8_t duration;  // segundos
  bool enabled;
};

struct Session {
  bool used;
  char token[33];
  char user[21];
  uint8_t role;
  bool mustChange;
  uint32_t created, lastSeen;
};

// Quién ejecuta la acción (para el historial)
struct Actor { String name = "Sistema"; String role = "sistema"; String ip = ""; };

struct NetCfg {
  String apSsid, apPass, apIp, apMask;
  bool staEn = false;
  String staSsid, staPass;
  bool lanAdmin = false, ntpEn = true;
};

struct GsCfg { bool en = false; String url, key, devId; };

struct SyncState {
  uint32_t syncedSeq = 0, lastAttempt = 0;
  bool lastOk = false, forceTest = false;
  String lastMsg = "Sin enviar todavía", lastAt = "";
};

struct NextRing { bool found; int idx; uint8_t day; uint32_t inSec; };
