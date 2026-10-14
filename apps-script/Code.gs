/**
 * TIMBRE ALBA V2 — Respaldo del historial en Google Sheets
 * ===========================================================
 * Qué hace:
 *  1. instalar(): crea en Drive la carpeta "TIMBRE_VER:2" con sus subcarpetas,
 *     la hoja de cálculo (base de datos), mueve este proyecto de Apps Script a
 *     su carpeta, genera la clave secreta y programa el reporte mensual.
 *  2. doPost(): recibe los eventos del timbre, verifica la firma HMAC-SHA256 y
 *     los agrega a la hoja sin duplicar.
 *
 * Seguridad:
 *  - Ninguna clave está en este código: la clave secreta vive en las
 *    Propiedades del script (PropertiesService), que no se copian a GitHub.
 *  - La aplicación web debe publicarse como "Cualquier persona" porque el
 *    timbre no puede iniciar sesión con Google. Por eso TODA petición se valida
 *    con HMAC: sin la clave nadie puede escribir registros falsos.
 *  - Los textos que empiezan por = + - @ se guardan como texto para evitar
 *    "inyección de fórmulas" en la hoja.
 */

const CONFIG = {
  ROOT_FOLDER: 'TIMBRE_VER:2',
  SUBFOLDERS: {
    db: '01_Base_de_datos',
    script: '02_Apps_Script',
    backups: '03_Copias_de_seguridad',
    reports: '04_Reportes',
    docs: '05_Documentacion',
  },
  SPREADSHEET_NAME: 'Timbre Alba - Base de datos',
  SHEET_LOG: 'Historial',
  SHEET_DEVICES: 'Equipos',
  SHEET_README: 'Léame',
  MAX_CLOCK_SKEW_SEC: 15 * 60, // tolerancia de hora entre el timbre y Google
  MAX_EVENTS_PER_POST: 50,
  MAX_PAYLOAD_CHARS: 30000,
};

const LOG_HEADERS = ['Recibido', 'Equipo', 'N.º', 'Fecha y hora (equipo)', 'Usuario', 'Rol', 'Acción', 'Descripción', 'Detalle', 'IP'];
const DEVICE_HEADERS = ['Equipo', 'Último contacto', 'Último N.º recibido', 'Identificador de historial', 'Eventos recibidos'];

const ACTION_LABELS = {
  'auth.login': 'Inicio de sesión', 'auth.fail': 'Ingreso fallido', 'auth.locked': 'Cuenta bloqueada',
  'auth.logout': 'Cierre de sesión', 'auth.password': 'Cambio de contraseña',
  'user.add': 'Usuario creado', 'user.update': 'Usuario modificado', 'user.reset': 'Contraseña restablecida',
  'user.unlock': 'Usuario desbloqueado', 'user.delete': 'Usuario eliminado',
  'sched.add': 'Timbre agregado', 'sched.update': 'Timbre modificado', 'sched.delete': 'Timbre eliminado',
  'sched.toggle': 'Timbre activado/pausado', 'sched.copy': 'Horario copiado', 'sched.clear': 'Día vaciado',
  'sched.split': 'Timbre separado por día',
  'ring.manual': 'Timbre manual', 'ring.auto': 'Timbre automático', 'ring.stop': 'Timbre detenido',
  'auto.set': 'Modo automático', 'time.set': 'Ajuste de hora', 'time.ntp': 'Hora por internet',
  'net.update': 'Cambio de red', 'gs.update': 'Cambio de respaldo Sheets',
  'backup.create': 'Copia de seguridad', 'backup.restore': 'Restauración de copia', 'backup.fail': 'Restauración rechazada',
  'audit.export': 'Historial exportado', 'security.denied': 'Acceso denegado',
  'system.boot': 'Equipo iniciado', 'system.reboot': 'Reinicio', 'system.provision': 'Primer arranque',
  'system.factory': 'Restauración de fábrica', 'system.recover': 'Recuperación de archivos',
};

// ---------------------------------------------------------------------
// Instalación (ejecutar UNA vez desde el editor: menú Ejecutar → instalar)
// ---------------------------------------------------------------------
function instalar() {
  const props = PropertiesService.getScriptProperties();

  const root = folderFromProp_('ROOT_FOLDER_ID', () => DriveApp.createFolder(CONFIG.ROOT_FOLDER));
  root.setDescription('Proyecto Timbre Alba V2: base de datos, Apps Script, copias de seguridad, reportes y documentación.');
  const sub = {};
  Object.keys(CONFIG.SUBFOLDERS).forEach((k) => {
    sub[k] = folderFromProp_('FOLDER_' + k.toUpperCase(), () => root.createFolder(CONFIG.SUBFOLDERS[k]));
    if (sub[k].getParents().hasNext() && sub[k].getParents().next().getId() !== root.getId()) sub[k].moveTo(root);
  });

  // Base de datos (Google Sheet) dentro de 01_Base_de_datos
  let ss;
  const sheetId = props.getProperty('SPREADSHEET_ID');
  if (sheetId) {
    ss = SpreadsheetApp.openById(sheetId);
  } else {
    ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }
  DriveApp.getFileById(ss.getId()).moveTo(sub.db);
  prepararHojas_(ss);

  // Este proyecto de Apps Script → 02_Apps_Script
  let scriptMsg = 'Proyecto de Apps Script movido a ' + CONFIG.SUBFOLDERS.script;
  try {
    DriveApp.getFileById(ScriptApp.getScriptId()).moveTo(sub.script);
  } catch (e) {
    scriptMsg = 'El proyecto está vinculado a una hoja y no se puede mover (normal si lo creó desde Extensiones). ' + e.message;
  }

  // Clave secreta compartida con el timbre (solo se genera si no existe)
  let secret = props.getProperty('TIMBRE_SECRET');
  const nuevaClave = !secret;
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('TIMBRE_SECRET', secret);
  }

  // Reporte CSV mensual automático en 04_Reportes
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'reporteMensual')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('reporteMensual').timeBased().onMonthDay(1).atHour(6).create();

  escribirLeeme_(sub.docs, root, ss);

  Logger.log('================ TIMBRE ALBA V2 instalado ================');
  Logger.log('Carpeta principal: ' + root.getUrl());
  Logger.log('Base de datos:     ' + ss.getUrl());
  Logger.log(scriptMsg);
  if (nuevaClave) {
    Logger.log('CLAVE SECRETA (cópiela en el panel del timbre → Respaldo en Sheets).');
    Logger.log('No la comparta ni la guarde en GitHub. Puede verla de nuevo con mostrarClave():');
    Logger.log(secret);
  } else {
    Logger.log('La clave secreta ya existía (use mostrarClave() si la necesita).');
  }
  Logger.log('SIGUIENTE PASO: Implementar → Nueva implementación → Aplicación web,');
  Logger.log('  Ejecutar como: Yo · Quién tiene acceso: Cualquier persona. Copie la URL /exec al panel del timbre.');
}

function mostrarClave() {
  Logger.log(PropertiesService.getScriptProperties().getProperty('TIMBRE_SECRET') || 'No hay clave: ejecute instalar()');
}

/** Cambia la clave (si se filtró). Después escriba la nueva en el panel del timbre. */
function rotarClave() {
  const secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('TIMBRE_SECRET', secret);
  Logger.log('Nueva clave (la anterior deja de funcionar ya mismo): ' + secret);
}

/** Opcional: limitar qué equipos pueden escribir, p. ej. "timbre-01,timbre-02". */
function permitirEquipos() {
  const lista = 'timbre-01';
  PropertiesService.getScriptProperties().setProperty('ALLOWED_DEVICES', lista);
  Logger.log('Equipos permitidos: ' + lista);
}

// ---------------------------------------------------------------------
// Recepción de eventos desde el timbre
// ---------------------------------------------------------------------
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('TIMBRE_SECRET');
    if (!secret) return json_({ ok: false, error: 'Apps Script sin instalar: ejecute instalar()' });
    if (!e || !e.postData || !e.postData.contents) return json_({ ok: false, error: 'Petición vacía' });

    const body = JSON.parse(e.postData.contents);
    const payload = String(body.payload || '');
    const sig = String(body.sig || '').toLowerCase();
    if (!payload || payload.length > CONFIG.MAX_PAYLOAD_CHARS) return json_({ ok: false, error: 'Contenido inválido' });

    // Firma: HMAC-SHA256 del texto exacto (bytes UTF-8) con la clave compartida
    const mac = Utilities.computeHmacSha256Signature(Utilities.newBlob(payload).getBytes(), Utilities.newBlob(secret).getBytes());
    if (!safeEqual_(toHex_(mac), sig)) return json_({ ok: false, error: 'Firma inválida (revise la clave secreta)' });

    const p = JSON.parse(payload);
    const device = String(p.device || '').slice(0, 24);
    const logId = String(p.log || '').slice(0, 16);
    if (!/^[\x20-\x7e]{1,24}$/.test(device)) return json_({ ok: false, error: 'Equipo inválido' });

    const allowed = (props.getProperty('ALLOWED_DEVICES') || '').split(',').map((s) => s.trim()).filter(String);
    if (allowed.length && allowed.indexOf(device) < 0) return json_({ ok: false, error: 'Equipo no autorizado' });

    // Evita reenvíos viejos capturados (ataque de repetición)
    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(p.ts || 0));
    if (!(skew <= CONFIG.MAX_CLOCK_SKEW_SEC)) return json_({ ok: false, error: 'Hora del equipo desfasada (' + skew + ' s)' });

    const events = Array.isArray(p.events) ? p.events.slice(0, CONFIG.MAX_EVENTS_PER_POST) : [];
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const key = 'SEQ_' + device + '_' + logId;
      const last = Number(props.getProperty(key) || 0);
      const nuevos = events.filter((ev) => Number(ev.q) > last).sort((a, b) => Number(a.q) - Number(b.q));
      const ss = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
      const now = new Date();
      if (nuevos.length) {
        const rows = nuevos.map((ev) => [
          now, device, Number(ev.q), safe_(ev.t), safe_(ev.u), safe_(ev.r),
          safe_(ACTION_LABELS[ev.a] || ev.a), safe_(ev.d), safe_(ev.a), safe_(ev.ip),
        ]);
        const sh = ss.getSheetByName(CONFIG.SHEET_LOG);
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
      }
      const maxQ = nuevos.length ? Number(nuevos[nuevos.length - 1].q) : last;
      props.setProperty(key, String(maxQ));
      actualizarEquipo_(ss, device, now, maxQ, logId, nuevos.length);
      return json_({ ok: true, received: nuevos.length, lastSeq: maxQ });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Error interno' }); // no revela detalles al exterior
  }
}

// No expone información: solo confirma que el servicio existe.
function doGet() {
  return json_({ ok: true, service: 'timbre-alba' });
}

// ---------------------------------------------------------------------
// Reporte mensual: CSV del mes anterior en 04_Reportes
// ---------------------------------------------------------------------
function reporteMensual() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
  const folder = DriveApp.getFolderById(props.getProperty('FOLDER_REPORTS'));
  const sh = ss.getSheetByName(CONFIG.SHEET_LOG);
  const data = sh.getDataRange().getValues();
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const rows = data.slice(1).filter((r) => r[0] instanceof Date && r[0] >= ini && r[0] < fin);
  const csv = [LOG_HEADERS].concat(rows.map((r) => r.map((v, i) => (i === 0 ? Utilities.formatDate(v, 'America/Bogota', 'yyyy-MM-dd HH:mm:ss') : v))))
    .map((r) => r.map(csvCell_).join(','))
    .join('\r\n');
  const nombre = 'historial-timbre-' + Utilities.formatDate(ini, 'America/Bogota', 'yyyy-MM') + '.csv';
  folder.createFile(nombre, '﻿' + csv, MimeType.CSV);
}

// ---------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------
function folderFromProp_(prop, create) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(prop);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* fue borrada: se crea de nuevo */ }
  }
  const f = create();
  props.setProperty(prop, f.getId());
  return f;
}

function prepararHojas_(ss) {
  let log = ss.getSheetByName(CONFIG.SHEET_LOG);
  if (!log) {
    log = ss.getSheets()[0];
    log.setName(CONFIG.SHEET_LOG);
  }
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold').setBackground('#10243a').setFontColor('#ffffff');
    log.setFrozenRows(1);
    log.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    log.setColumnWidth(8, 420);
  }
  let dev = ss.getSheetByName(CONFIG.SHEET_DEVICES) || ss.insertSheet(CONFIG.SHEET_DEVICES);
  if (dev.getLastRow() === 0) {
    dev.getRange(1, 1, 1, DEVICE_HEADERS.length).setValues([DEVICE_HEADERS]).setFontWeight('bold').setBackground('#10243a').setFontColor('#ffffff');
    dev.setFrozenRows(1);
  }
  let readme = ss.getSheetByName(CONFIG.SHEET_README) || ss.insertSheet(CONFIG.SHEET_README);
  readme.clear();
  readme.getRange(1, 1, 6, 1).setValues([
    ['Timbre Alba V2 — base de datos del historial'],
    ['Esta hoja la llena automáticamente el timbre. No edite ni borre filas de "Historial": es registro de auditoría.'],
    ['Cada fila fue verificada con firma HMAC antes de guardarse.'],
    ['"Equipos" muestra el último contacto de cada timbre.'],
    ['Reportes CSV mensuales: carpeta 04_Reportes. Copias de seguridad del timbre: carpeta 03_Copias_de_seguridad.'],
    ['Instalado: ' + new Date()],
  ]);
  readme.getRange('A1').setFontWeight('bold').setFontSize(14);
  // Advertencia al editar a mano el historial (quien sea editor aún podría, pero se le avisa)
  if (log.getProtections(SpreadsheetApp.ProtectionType.SHEET).length === 0) {
    log.protect().setDescription('Historial de auditoría: solo lo escribe el timbre').setWarningOnly(true);
  }
}

function actualizarEquipo_(ss, device, when, lastSeq, logId, count) {
  const sh = ss.getSheetByName(CONFIG.SHEET_DEVICES);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === device) {
      sh.getRange(i + 1, 2, 1, 4).setValues([[when, lastSeq, logId, Number(data[i][4] || 0) + count]]);
      return;
    }
  }
  sh.appendRow([safe_(device), when, lastSeq, logId, count]);
}

function escribirLeeme_(docsFolder, root, ss) {
  const nombre = 'LEEME - Timbre Alba V2.txt';
  const it = docsFolder.getFilesByName(nombre);
  while (it.hasNext()) it.next().setTrashed(true);
  const txt = [
    'TIMBRE ALBA V2 - Carpeta del proyecto',
    '',
    'Carpeta principal: ' + root.getUrl(),
    'Base de datos (Google Sheets): ' + ss.getUrl(),
    '',
    'Subcarpetas:',
    '  01_Base_de_datos        Hoja con el historial firmado de todos los timbres.',
    '  02_Apps_Script          Este proyecto (recibe los eventos y genera reportes).',
    '  03_Copias_de_seguridad  Guarde aquí las copias .json descargadas del panel del timbre.',
    '                          Están cifradas (AES-256-GCM); la frase NO se guarda aquí.',
    '  04_Reportes             CSV mensual automático (día 1 de cada mes, 6 a. m.).',
    '  05_Documentacion        Este archivo.',
    '',
    'Seguridad:',
    '  - La clave secreta está en Configuración del proyecto → Propiedades del script.',
    '  - Si cree que la clave se filtró: ejecute rotarClave() y escriba la nueva en el panel.',
    '  - Comparta esta carpeta solo con administradores.',
  ].join('\n');
  docsFolder.createFile(nombre, txt, MimeType.PLAIN_TEXT);
}

function toHex_(bytes) {
  return bytes.map((b) => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Texto seguro para la hoja: máximo 300 caracteres y nunca interpretado como fórmula
function safe_(v) {
  let s = v === undefined || v === null ? '' : String(v).slice(0, 300);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function csvCell_(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
