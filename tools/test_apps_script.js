// Prueba del Apps Script (apps-script/Code.gs) con simulaciones de los
// servicios de Google. Uso: node tools/test_apps_script.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

let idSeq = 0;
const newId = (p) => p + '_' + (++idSeq);
const files = {};
class Folder {
  constructor(name, parent) { this.id = newId('fold'); this.name = name; this.parent = parent; this.trashed = false; files[this.id] = this; }
  getId() { return this.id; } getName() { return this.name; } getUrl() { return 'https://drive/' + this.id; }
  isTrashed() { return this.trashed; } setDescription() { return this; }
  createFolder(n) { return new Folder(n, this); }
  getParents() { const p = this.parent; let done = !p; return { hasNext: () => !done, next: () => { done = true; return p; } }; }
  moveTo(f) { this.parent = f; return this; }
  createFile(name, content) { const f = new File(name, this); f.content = content; return f; }
  getFilesByName(n) { const l = Object.values(files).filter((x) => x instanceof File && x.parent === this && x.name === n); let i = 0; return { hasNext: () => i < l.length, next: () => l[i++] }; }
}
class File { constructor(name, parent) { this.id = newId('file'); this.name = name; this.parent = parent; files[this.id] = this; } moveTo(f) { this.parent = f; return this; } setTrashed(t) { this.trashed = t; } }
const ROOT = new Folder('Mi unidad', null);

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.prot = []; }
  setName(n) { this.name = n; } getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getRange(r, c, nr, nc) {
    const sh = this;
    if (typeof r === 'string') return { setNumberFormat() { return this; }, setFontWeight() { return this; }, setFontSize() { return this; } };
    const api = {
      setValues(v) { v.forEach((row, i) => { sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || []; row.forEach((x, j) => (sh.rows[r - 1 + i][c - 1 + j] = x)); }); return api; },
      setFontWeight() { return api; }, setBackground() { return api; }, setFontColor() { return api; },
    };
    return api;
  }
  getDataRange() { return { getValues: () => this.rows.map((r) => r.slice()) }; }
  appendRow(r) { this.rows.push(r); }
  setFrozenRows() {} setColumnWidth() {} clear() { this.rows = []; }
  getProtections() { return this.prot; }
  protect() { const p = { setDescription() { return p; }, setWarningOnly() { return p; } }; this.prot.push(p); return p; }
}
class SS {
  constructor(name) { this.id = newId('ss'); this.name = name; this.sheets = [new Sheet('Hoja 1')]; files[this.id] = new File(name, ROOT); files[this.id].id = this.id; this.file = files[this.id]; }
  getId() { return this.id; } getUrl() { return 'https://sheets/' + this.id; }
  getSheets() { return this.sheets; } getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
}
const sheets = {};
const props = {};
const logs = [];
const triggers = [];
const SCRIPT_FILE = new File('Timbre Apps Script', ROOT);

const ctx = {
  console, Date, JSON, Math, Number, String, Array, Object,
  Logger: { log: (m) => logs.push(String(m)) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
  DriveApp: {
    createFolder: (n) => new Folder(n, ROOT), getRootFolder: () => ROOT,
    getFolderById: (id) => { if (!files[id]) throw new Error('no'); return files[id]; },
    getFileById: (id) => { if (!files[id]) throw new Error('no file ' + id); return files[id]; },
  },
  SpreadsheetApp: { create: (n) => { const s = new SS(n); sheets[s.id] = s; return s; }, openById: (id) => sheets[id], ProtectionType: { SHEET: 'SHEET' } },
  ScriptApp: {
    getScriptId: () => SCRIPT_FILE.id, getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: (fn) => { const t = { fn, getHandlerFunction: () => fn }; const b = { timeBased: () => b, onMonthDay: () => b, atHour: () => b, create: () => { triggers.push(t); return t; } }; return b; },
  },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(s, 'utf8')).map((b) => (b > 127 ? b - 256 : b)) }),
    computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', Buffer.from(k.map((b) => (b + 256) % 256))).update(Buffer.from(v.map((b) => (b + 256) % 256))).digest()).map((b) => (b > 127 ? b - 256 : b)),
    formatDate: (d) => d.toISOString(),
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: (t) => ({ setMimeType() { return { body: t }; } }), MimeType: { JSON: 'json' } },
  MimeType: { PLAIN_TEXT: 'text/plain', CSV: 'text/csv' },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);

let fails = 0;
const check = (name, cond) => { console.log((cond ? '[OK]    ' : '[FALLA] ') + name); if (!cond) fails++; };
const pathOf = (f) => (f && f.parent ? pathOf(f.parent) + '/' + f.name : f ? f.name : '');

// 1) Instalación
ctx.instalar();
ctx.instalar(); // segunda vez: no debe duplicar nada
const root = files[props.ROOT_FOLDER_ID];
const subs = Object.values(files).filter((f) => f instanceof Folder && f.parent === root).map((f) => f.name).sort();
check('Carpeta raíz "TIMBRE_VER:2" en Mi unidad', root.name === 'TIMBRE_VER:2' && root.parent === ROOT);
check('5 subcarpetas sin duplicados: ' + subs.join(', '), subs.length === 5);
const ss = sheets[props.SPREADSHEET_ID];
check('Sheet dentro de 01_Base_de_datos: ' + pathOf(ss.file), pathOf(ss.file) === 'Mi unidad/TIMBRE_VER:2/01_Base_de_datos/Timbre Alba - Base de datos');
check('Apps Script dentro de 02_Apps_Script: ' + pathOf(SCRIPT_FILE), pathOf(SCRIPT_FILE).endsWith('TIMBRE_VER:2/02_Apps_Script/Timbre Apps Script'));
const docs = Object.values(files).filter((f) => f instanceof File && !f.trashed && f.parent && f.parent.name === '05_Documentacion');
check('Un solo LEEME en 05_Documentacion', docs.length === 1);
check('Hojas Historial/Equipos/Léame', ['Historial', 'Equipos', 'Léame'].every((n) => ss.getSheetByName(n)));
check('Una sola protección (aviso) en Historial', ss.getSheetByName('Historial').prot.length === 1);
check('Un solo disparador mensual', triggers.length === 1);
check('Clave secreta de 64 caracteres', /^[0-9a-f]{64}$/.test(props.TIMBRE_SECRET));

// 2) Recepción firmada
const secret = props.TIMBRE_SECRET;
const mk = (events, opts = {}) => {
  const payload = JSON.stringify({ v: 1, device: opts.device || 'timbre-01', log: 'ab12cd34', ts: opts.ts || Math.floor(Date.now() / 1000), events });
  const sig = opts.sig || crypto.createHmac('sha256', opts.key || secret).update(Buffer.from(payload, 'utf8')).digest('hex');
  return { postData: { contents: JSON.stringify({ payload, sig }) } };
};
const post = (e) => JSON.parse(ctx.doPost(e).body);
const ev = (q, a, d) => ({ q, t: '2026-10-13T07:00:01', u: 'Rector', r: 'admin', a, d, ip: '192.168.4.2' });

let r = post(mk([ev(1, 'auth.login', 'Ingreso'), ev(2, 'sched.add', '07:00 Inicio de clases ñ')]));
check('Acepta lote firmado (2 eventos)', r.ok && r.received === 2);
r = post(mk([ev(1, 'auth.login', 'Ingreso'), ev(2, 'sched.add', 'x'), ev(3, 'ring.manual', '=HYPERLINK("http://malo")')]));
check('Reenvío no duplica (solo 1 nuevo)', r.ok && r.received === 1 && r.lastSeq === 3);
const rows = ss.getSheetByName('Historial').rows;
check('Historial tiene encabezado + 3 filas', rows.length === 4);
check('Fórmula neutralizada con apóstrofo', String(rows[3][7]).startsWith("'="));
check('Acción traducida al español', rows[1][6] === 'Inicio de sesión');
check('Acentos/ñ intactos', rows[2][7] === '07:00 Inicio de clases ñ');
check('Rechaza firma con clave equivocada', post(mk([ev(9, 'x', 'x')], { key: 'otra-clave' })).error.startsWith('Firma inválida'));
check('Rechaza firma alterada', post(mk([ev(9, 'x', 'x')], { sig: '00'.repeat(32) })).ok === false);
check('Rechaza hora desfasada (repetición vieja)', /desfasada/.test(post(mk([ev(9, 'x', 'x')], { ts: 1000 })).error));
check('Rechaza petición vacía', post({}).ok === false);
props.ALLOWED_DEVICES = 'timbre-01';
check('Rechaza equipo no autorizado', post(mk([ev(1, 'x', 'x')], { device: 'intruso' })).error === 'Equipo no autorizado');
check('Equipos registra el timbre', ss.getSheetByName('Equipos').rows.some((x) => x[0] === 'timbre-01' && x[2] === 3));
check('doGet no revela datos', JSON.parse(ctx.doGet().body).service === 'timbre-alba');

console.log(fails ? `\n${fails} FALLAS` : '\nAPPS SCRIPT: TODAS LAS PRUEBAS PASARON');
process.exit(fails ? 1 : 0);
