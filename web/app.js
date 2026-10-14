/* Timbre Alba V2 — panel web.
   La interfaz muestra u oculta funciones según el rol, pero quien decide los
   permisos es SIEMPRE el equipo (cada ruta /api verifica sesión y rol). */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DAYS_LONG = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const NAME_SUGGESTIONS = ['Inicio de clases', 'Cambio de clase', 'Descanso', 'Fin de descanso', 'Almuerzo', 'Fin de almuerzo', 'Salida', 'Inicio jornada tarde', 'Salida final'];

const S = { token: '', user: '', role: '', status: null, statusAt: 0, schedules: [], users: [], view: '', ringSec: 3, weekDay: null, auditBefore: null, tick: null, poll: null };
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* modo privado */ } },
};
const isAdmin = () => S.role === 'admin';

// ---------- Iconos (trazos simples, sin recursos externos) ----------
const ICONS = {
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  stop: 'M7 7h10v10H7z',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7zM16 10h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M20 6 9 17l-5-5',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  sheet: 'M5 3h14v18H5zM5 9h14M5 15h14M11 3v18',
};
function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;
}
function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((el) => { if (!el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)); });
}

// ---------- Utilidades ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function daysText(mask) {
  if (mask === 127) return 'Todos los días';
  if (mask === 31) return 'Lun a Vie';
  if (mask === 63) return 'Lun a Sáb';
  if (mask === 96) return 'Sáb y Dom';
  return DAYS.filter((_, i) => mask & (1 << i)).join(', ');
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}
function fmtUptime(s) { return fmtDur(s); }
function fmtBytes(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; }
function normName(s) { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : ''; }
function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3500);
}
function randomPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz', num = '23456789';
  const r = new Uint32Array(12);
  crypto.getRandomValues(r); // disponible también sin HTTPS
  let p = '';
  for (let i = 0; i < 12; i++) p += (i % 4 === 3 ? num : abc)[r[i] % (i % 4 === 3 ? num.length : abc.length)];
  return p;
}
function pwScore(p) {
  let s = 0;
  if (p.length >= 10) s++;
  if (p.length >= 14) s++;
  if (/[a-zA-Z]/.test(p) && /\d/.test(p)) s++;
  if (/[^a-zA-Z0-9]/.test(p)) s++;
  return s;
}
function pwProblem(p, user) {
  if (p.length < 10) return 'Debe tener al menos 10 caracteres.';
  if (!/[a-zA-ZÀ-ÿ]/.test(p) || !/\d/.test(p)) return 'Use letras y números.';
  if (user && p.toLowerCase().includes(user.toLowerCase())) return 'No puede contener su nombre de usuario.';
  return '';
}

// ---------- API ----------
async function api(path, body, method) {
  method = method || (body !== undefined ? 'POST' : 'GET');
  const opt = { method, headers: {}, cache: 'no-store' };
  if (S.token) opt.headers['X-Session'] = S.token;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(path, opt); } catch (e) { throw new Error('Sin conexión con el timbre. Verifique que sigue conectado a su red Wi-Fi.'); }
  let j = {};
  try { j = await r.json(); } catch (e) { /* respuesta vacía */ }
  if (r.status === 401 && path !== '/api/login') { endSession('Su sesión terminó. Ingrese de nuevo.'); throw new Error(j.error || 'Sesión vencida'); }
  if (r.status === 403 && j.code === 'must_change') { showChange(); throw new Error(j.error); }
  if (!r.ok || j.ok === false) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
async function busy(btn, fn) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}
function saveBlob(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Sesión ----------
function show(id) { ['login', 'change', 'app'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id)); }
function endSession(msg) {
  S.token = ''; S.user = ''; S.role = '';
  store.set('tk', null);
  clearInterval(S.poll); clearInterval(S.tick);
  closeModal();
  show('login');
  const m = $('#login-msg'); m.textContent = msg || ''; m.className = 'form-msg';
  $('#lp').value = '';
  setTimeout(() => ($('#lu').value ? $('#lp') : $('#lu')).focus(), 50);
}
function showChange() {
  show('change');
  $('#change-user').textContent = S.user;
  setTimeout(() => $('#cp-old').focus(), 50);
}
async function startApp() {
  const me = await api('/api/me');
  S.user = me.user; S.role = me.role;
  if (me.mustChange) { showChange(); return; }
  show('app');
  $('#me-name').textContent = S.user;
  $('#me-role').textContent = isAdmin() ? 'Administrador' : 'Usuario';
  $('#me-initial').textContent = S.user[0] || '?';
  buildNav();
  await refreshStatus();
  clearInterval(S.poll); clearInterval(S.tick);
  S.poll = setInterval(() => { if (!document.hidden) refreshStatus().catch(() => {}); }, 5000);
  S.tick = setInterval(tick, 1000);
  route();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  msg.textContent = '';
  const username = $('#lu').value.trim(), password = $('#lp').value;
  if (!username || !password) { msg.textContent = 'Escriba usuario y contraseña.'; return; }
  await busy($('#login-btn'), async () => {
    try {
      const j = await api('/api/login', { username, password });
      S.token = j.token; store.set('tk', j.token);
      $('#lp').value = '';
      await startApp();
    } catch (err) { msg.textContent = err.message; }
  });
});

$('#cp-new').addEventListener('input', (e) => {
  const s = pwScore(e.target.value), m = $('#cp-meter');
  m.style.width = (s * 25) + '%';
  m.style.background = s >= 3 ? 'var(--ok)' : s === 2 ? 'var(--warn)' : 'var(--danger)';
});
$('#change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#change-msg'), cur = $('#cp-old').value, n1 = $('#cp-new').value, n2 = $('#cp-new2').value;
  msg.className = 'form-msg';
  const p = pwProblem(n1, S.user);
  if (p) { msg.textContent = p; return; }
  if (n1 !== n2) { msg.textContent = 'Las contraseñas nuevas no coinciden.'; return; }
  try {
    await api('/api/password', { current: cur, new: n1 });
    ['#cp-old', '#cp-new', '#cp-new2'].forEach((s) => ($(s).value = ''));
    toast('Contraseña creada. ¡Bienvenido!');
    await startApp();
  } catch (err) { msg.textContent = err.message; }
});

// ---------- Navegación ----------
const VIEWS = {
  inicio: { title: 'Inicio', icon: 'home', render: viewHome },
  horarios: { title: 'Horarios', icon: 'calendar', render: viewSchedules },
  usuarios: { title: 'Usuarios', icon: 'users', render: viewUsers, admin: true },
  historial: { title: 'Historial', icon: 'history', render: viewAudit, admin: true },
  reloj: { title: 'Reloj y modo automático', nav: 'Reloj', icon: 'clock', render: viewClock, admin: true },
  red: { title: 'Red y equipo', icon: 'wifi', render: viewNetwork, admin: true },
  respaldo: { title: 'Copias y respaldo', icon: 'shield', render: viewBackup, admin: true },
  sistema: { title: 'Sistema', icon: 'cpu', render: viewSystem, admin: true },
  cuenta: { title: 'Mi cuenta', icon: 'user', render: viewAccount },
};
function buildNav() {
  const item = (k) => `<a href="#/${k}" data-view="${k}">${icon(VIEWS[k].icon)}<span>${VIEWS[k].nav || VIEWS[k].title}</span></a>`;
  let h = item('inicio') + item('horarios');
  if (isAdmin()) h += '<div class="nav-sep">Administración</div>' + ['usuarios', 'historial', 'reloj', 'red', 'respaldo', 'sistema'].map(item).join('');
  h += '<div class="nav-sep">Cuenta</div>' + item('cuenta');
  $('#nav').innerHTML = h;
}
function route() {
  if ($('#app').classList.contains('hidden')) return;
  let v = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'inicio';
  if (!VIEWS[v] || (VIEWS[v].admin && !isAdmin())) v = 'inicio';
  S.view = v;
  $$('#nav a').forEach((a) => (a.dataset.view === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('#view-title').textContent = VIEWS[v].title;
  document.title = VIEWS[v].title + ' · Timbre Alba';
  $('#app').classList.remove('menu-open');
  const el = $('#view');
  el.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  VIEWS[v].render(el).catch((e) => { el.innerHTML = `<div class="banner danger">${icon('alert')}<div>${esc(e.message)}</div></div>`; });
}
window.addEventListener('hashchange', route);

// ---------- Estado general ----------
async function refreshStatus() {
  const st = await api('/api/status');
  S.status = st; S.statusAt = Date.now();
  $('#dev-name').textContent = st.device.name;
  $('#foot-ver').textContent = 'v' + st.device.version;
  const auto = st.auto ? '<span class="pill ok hide-sm">Automático</span>' : '<span class="pill warn">Automático en pausa</span>';
  const relay = st.relay.on ? '<span class="pill danger">Sonando</span>' : '';
  $('#top-status').innerHTML = relay + (st.rtcOk ? auto : '<span class="pill danger">Reloj sin hora</span>');
  $('#banners').innerHTML = (st.warnings || []).map((w) => `<div class="banner">${icon('alert')}<div>${esc(w)}</div></div>`).join('');
  if (S.view === 'inicio') paintHome();
}
function deviceNow() {
  const st = S.status;
  if (!st || !st.now) return null;
  const [d, t] = st.now.split('T'), [y, mo, da] = d.split('-').map(Number), [h, mi, se] = t.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h, mi, se) + (Date.now() - S.statusAt));
}
function tick() {
  if (S.view !== 'inicio' || !S.status) return;
  const now = deviceNow();
  if (now && $('#clk')) {
    $('#clk').textContent = now.toISOString().slice(11, 19);
    const ds = now.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    $('#clk-date').textContent = ds.charAt(0).toUpperCase() + ds.slice(1);
  }
  const st = S.status, el = (Date.now() - S.statusAt) / 1000;
  if (st.next && $('#nx-in')) {
    const left = st.next.in - el;
    $('#nx-in').textContent = left > 0 ? 'Faltan ' + fmtDur(left) : 'Sonando ahora';
    const bar = $('#nx-bar');
    if (bar) bar.style.width = Math.max(2, Math.min(100, 100 - (left / Math.max(st.next.in, 3600)) * 100)) + '%';
  }
  const rb = $('#ring-btn');
  if (rb) {
    const rem = st.relay.on ? st.relay.remainingMs / 1000 - el : 0;
    rb.classList.toggle('on', rem > 0);
    rb.innerHTML = rem > 0 ? `${icon('bell')} Sonando… ${Math.ceil(rem)} s` : `${icon('bell')} Tocar el timbre ahora`;
  }
}

// ---------- Vista: Inicio ----------
async function viewHome(el) {
  el.innerHTML = `
  <div class="cards">
    <div class="card clock-card span-5">
      <h2>${icon('clock')} Hora del timbre</h2>
      <div class="clock" id="clk">--:--:--</div>
      <div class="clock-date" id="clk-date"></div>
      <div class="row" id="clk-pills"></div>
    </div>
    <div class="card span-7">
      <h2>${icon('bell')} Próximo timbre</h2>
      <div id="nx"></div>
    </div>
    <div class="card span-5">
      <h2>${icon('bell')} Timbre manual</h2>
      <p class="sub">Para emergencias, simulacros o cuando se necesite fuera de horario.</p>
      <div class="row"><span class="muted">Duración</span><div class="seg" id="ring-seg">${[3, 5, 10].map((s) => `<button type="button" data-sec="${s}" aria-pressed="${S.ringSec === s}">${s} s</button>`).join('')}</div></div>
      <button class="btn gold ring-btn" id="ring-btn" type="button" data-action="ring">${icon('bell')} Tocar el timbre ahora</button>
      <button class="btn ghost block" type="button" data-action="stop">${icon('stop')} Detener</button>
      ${isAdmin() ? `<label class="switch"><input type="checkbox" id="auto-sw"> <span>Timbre automático<small>Si lo apaga, no sonará ningún horario hasta encenderlo.</small></span></label>` : ''}
    </div>
    <div class="card span-7">
      <h2>${icon('calendar')} Timbres de hoy</h2>
      <ul class="timeline" id="today"></ul>
    </div>
  </div>`;
  $('#ring-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sec]');
    if (!b) return;
    S.ringSec = Number(b.dataset.sec);
    $$('#ring-seg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  });
  const sw = $('#auto-sw');
  if (sw) sw.addEventListener('change', async () => {
    try { const r = await api('/api/auto', { enabled: sw.checked }); toast(r.message); await refreshStatus(); } catch (e) { toast(e.message, true); sw.checked = !sw.checked; }
  });
  paintHome();
  tick();
}
function paintHome() {
  const st = S.status;
  if (!st || !$('#nx')) return;
  $('#clk-pills').innerHTML = `<span class="pill">${st.ntp ? 'Sincronizado por internet' : 'Reloj interno'}</span>` + (st.auto ? '<span class="pill">Automático activo</span>' : '<span class="pill">Automático en pausa</span>');
  const sw = $('#auto-sw');
  if (sw) sw.checked = !!st.auto;
  if (!st.rtcOk) $('#nx').innerHTML = `<div class="banner danger">${icon('alert')}<div>El reloj no tiene hora válida. ${isAdmin() ? '<a href="#/reloj">Ajustar fecha y hora</a>' : 'Avise a un administrador.'}</div></div>`;
  else if (!st.auto) $('#nx').innerHTML = `<div class="big-num">—</div><p class="muted">El modo automático está en pausa.</p>`;
  else if (!st.next) $('#nx').innerHTML = `<div class="big-num">—</div><p class="muted">No hay timbres programados. <a href="#/horarios">Programar horarios</a></p>`;
  else {
    const today = st.dow === st.next.dow && st.next.in < 86400;
    $('#nx').innerHTML = `<div class="row"><div class="big-num">${esc(st.next.time)}</div><span class="pill info plain">${today ? 'Hoy' : esc(DAYS_LONG[st.next.dow])}</span></div>
      <div>${esc(st.next.name)}</div><div class="muted" id="nx-in"></div><div class="bar"><span id="nx-bar"></span></div>`;
  }
  const list = st.today || [];
  let nextMarked = false;
  $('#today').innerHTML = list.length
    ? list.map((t) => {
      let cls = t.past ? 'past' : '', tag = t.past ? 'Sonó' : 'Pendiente';
      if (!t.enabled) { cls = 'past'; tag = 'Pausado'; } else if (!t.past && !nextMarked && st.auto) { cls = 'next'; tag = 'Próximo'; nextMarked = true; }
      return `<li class="${cls}"><span class="t">${esc(t.time)}</span><span class="n">${esc(t.name)}</span><span class="badge">${tag}</span></li>`;
    }).join('')
    : '<li class="muted">Hoy no hay timbres programados.</li>';
  tick();
}

// ---------- Vista: Horarios ----------
async function loadSchedules() { S.schedules = (await api('/api/schedules')).items; }
async function viewSchedules(el) {
  await loadSchedules();
  const st = S.status || {};
  if (S.weekDay === null) S.weekDay = st.dow >= 0 ? st.dow : 0;
  const cols = DAYS.map((d, i) => {
    const items = S.schedules.filter((s) => s.days & (1 << i));
    return `<div class="day ${i === st.dow ? 'today' : ''} ${i === S.weekDay ? 'shown' : ''}" data-day="${i}">
      <div class="day-head">${DAYS_LONG[i]}<span class="count">${items.length}</span>
        <button class="icon-btn" data-action="day-menu" data-day="${i}" aria-label="Opciones del ${DAYS_LONG[i]}" title="Copiar o vaciar">${icon('copy')}</button></div>
      <div class="day-list">${items.map((s) => `<button class="chip-s ${s.enabled ? '' : 'off'}" data-action="edit-sched" data-id="${s.id}" data-day="${i}"><b>${esc(s.time)}</b><span>${esc(s.name)} · ${s.duration} s</span></button>`).join('') || '<span class="muted">Sin timbres</span>'}
      </div></div>`;
  }).join('');
  el.innerHTML = `
    <div class="row"><p class="muted spacer">Cada timbre puede sonar varios días. Toque uno para editarlo. Use ${icon('copy')} para copiar un día completo a otros.</p>
      <button class="btn primary" data-action="new-sched">${icon('plus')} Nuevo timbre</button></div>
    <div class="day-tabs" id="day-tabs">${DAYS.map((d, i) => `<button data-tab="${i}" aria-pressed="${i === S.weekDay}">${d}</button>`).join('')}</div>
    <div class="week">${cols}</div>
    <h3 class="section-title">Todos los timbres (${S.schedules.length})</h3>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Hora</th><th>Nombre</th><th>Días</th><th>Duración</th><th>Activo</th><th></th></tr></thead>
      <tbody>${S.schedules.map((s) => `<tr><td class="num"><b>${esc(s.time)}</b></td><td>${esc(s.name)}</td><td>${esc(daysText(s.days))}</td><td class="num">${s.duration} s</td>
        <td><label class="switch"><input type="checkbox" data-action="toggle-sched" data-id="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="Activar ${esc(s.name)}"></label></td>
        <td class="actions"><button class="icon-btn" data-action="edit-sched" data-id="${s.id}" aria-label="Editar">${icon('edit')}</button><button class="icon-btn" data-action="del-sched" data-id="${s.id}" aria-label="Eliminar">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Aún no hay timbres. Use “Nuevo timbre”.</td></tr>'}</tbody>
    </table></div></div>`;
  $('#day-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.weekDay = Number(b.dataset.tab);
    $$('#day-tabs button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    $$('.day').forEach((d) => d.classList.toggle('shown', Number(d.dataset.day) === S.weekDay));
  });
}

function daysPicker(mask, name = 'dp') {
  return `<div class="days-pick" id="${name}">${DAYS.map((d, i) => `<label><input type="checkbox" value="${1 << i}" ${mask & (1 << i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
  <div class="quick" data-for="${name}"><button type="button" data-mask="31">Lun a Vie</button><button type="button" data-mask="63">Lun a Sáb</button><button type="button" data-mask="127">Todos</button><button type="button" data-mask="0">Ninguno</button></div>`;
}
function readDays(name = 'dp') { return $$(`#${name} input:checked`).reduce((m, x) => m | Number(x.value), 0); }

function scheduleModal(s, fromDay) {
  const isNew = !s;
  s = s || { name: '', time: '07:00', duration: 3, days: 31, enabled: true };
  const multi = !isNew && fromDay !== undefined && (s.days & ~(1 << fromDay));
  openModal(isNew ? 'Nuevo timbre' : 'Editar timbre', `
    <label for="f-name">Nombre</label>
    <input id="f-name" maxlength="30" list="names" value="${esc(s.name)}" placeholder="Ej. Inicio de clases">
    <datalist id="names">${NAME_SUGGESTIONS.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="grid2"><div><label for="f-time">Hora</label><input id="f-time" type="time" value="${esc(s.time)}" required></div>
      <div><label for="f-dur">Duración (segundos)</label><input id="f-dur" type="number" min="1" max="60" value="${s.duration}"></div></div>
    <label>Días en que suena</label>${daysPicker(s.days)}
    ${multi ? `<div class="radio-list"><label><input type="radio" name="scope" value="all" checked> Cambiar en todos sus días (${esc(daysText(s.days))})</label>
      <label><input type="radio" name="scope" value="one"> Cambiar solo el ${esc(DAYS_LONG[fromDay])}</label></div>` : ''}
    <label class="switch"><input type="checkbox" id="f-en" ${s.enabled ? 'checked' : ''}> <span>Activo<small>Pausado = se conserva pero no suena.</small></span></label>
    <p class="form-msg" id="f-msg"></p>`,
  `${isNew ? '' : '<button class="btn ghost" data-m="delete">' + icon('trash') + ' Eliminar</button><span class="spacer"></span>'}
   <button class="btn ghost" data-m="cancel">Cancelar</button><button class="btn primary" data-m="save">Guardar</button>`,
  async (act, btn) => {
    if (act === 'delete') { closeModal(); return deleteSchedule(s); }
    if (act !== 'save') return true;
    const data = { name: $('#f-name').value.trim(), time: $('#f-time').value, duration: Number($('#f-dur').value), days: readDays(), enabled: $('#f-en').checked };
    if (!data.name) return msgIn('#f-msg', 'Escriba un nombre.');
    if (!data.days) return msgIn('#f-msg', 'Seleccione al menos un día.');
    try {
      await busy(btn, async () => {
        let id = s.id;
        const scope = $('input[name=scope]:checked');
        if (multi && scope && scope.value === 'one') {
          id = (await api('/api/schedules', { action: 'split', id: s.id, day: fromDay })).id;
          data.days = 1 << fromDay;
        }
        const r = await api('/api/schedules', isNew ? { action: 'add', ...data } : { action: 'update', id, ...data });
        toast(r.message);
      });
      closeModal();
      route();
    } catch (e) { msgIn('#f-msg', e.message); }
  });
  setTimeout(() => $('#f-name').focus(), 30);
}
async function deleteSchedule(s) {
  if (!(await confirmModal('Eliminar timbre', `Se eliminará “${esc(s.name)}” de las ${esc(s.time)} (${esc(daysText(s.days))}).`, 'Eliminar', true))) return;
  try { toast((await api('/api/schedules', { action: 'delete', id: s.id })).message); route(); } catch (e) { toast(e.message, true); }
}
function dayMenu(day) {
  openModal(`${DAYS_LONG[day]}`, `
    <p class="muted">Copie todos los timbres del ${DAYS_LONG[day].toLowerCase()} a otros días. Las horas que ese día ya tenga no se duplican.</p>
    <label>Copiar a</label>${daysPicker(31 & ~(1 << day), 'dc')}
    <p class="form-msg" id="dm-msg"></p>`,
  `<button class="btn ghost" data-m="clear">${icon('trash')} Vaciar ${DAYS[day]}</button><span class="spacer"></span><button class="btn ghost" data-m="cancel">Cancelar</button><button class="btn primary" data-m="copy">${icon('copy')} Copiar</button>`,
  async (act, btn) => {
    if (act === 'copy') {
      const to = readDays('dc');
      if (!to) return msgIn('#dm-msg', 'Seleccione los días destino.');
      try { await busy(btn, async () => toast((await api('/api/schedules', { action: 'copyDay', from: day, to })).message)); closeModal(); route(); } catch (e) { msgIn('#dm-msg', e.message); }
    } else if (act === 'clear') {
      closeModal();
      if (await confirmModal('Vaciar día', `Se quitarán todos los timbres del ${DAYS_LONG[day].toLowerCase()}. Los demás días no cambian.`, 'Vaciar', true)) {
        try { toast((await api('/api/schedules', { action: 'clearDay', day })).message); route(); } catch (e) { toast(e.message, true); }
      }
    } else return true;
  });
}

// ---------- Vista: Usuarios ----------
async function viewUsers(el) {
  const r = await api('/api/users');
  S.users = r.items;
  el.innerHTML = `
    <div class="row"><p class="muted spacer">Administradores: todo el sistema. Usuarios: horarios y timbre manual. Toda cuenta nueva debe cambiar su contraseña al primer ingreso.</p>
      <button class="btn primary" data-action="new-user">${icon('plus')} Nuevo usuario</button></div>
    <div class="card" ><div class="table-wrap"><table>
    <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
    <tbody>${r.items.map((u) => `<tr>
      <td><b>${esc(u.name)}</b>${u.me ? ' <span class="badge info">Usted</span>' : ''}</td>
      <td><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'Administrador' : 'Usuario'}</span></td>
      <td>${!u.active ? '<span class="badge">Inactivo</span>' : u.locked ? '<span class="badge danger">Bloqueado</span>' : u.mustChange ? '<span class="badge warn">Debe cambiar contraseña</span>' : '<span class="badge ok">Activo</span>'}</td>
      <td class="actions">${u.me ? '' : `
        ${u.locked ? `<button class="btn small ghost" data-action="unlock-user" data-name="${esc(u.name)}">Desbloquear</button>` : ''}
        <button class="icon-btn" data-action="edit-user" data-name="${esc(u.name)}" aria-label="Editar ${esc(u.name)}" title="Rol y estado">${icon('edit')}</button>
        <button class="icon-btn" data-action="reset-user" data-name="${esc(u.name)}" aria-label="Restablecer contraseña de ${esc(u.name)}" title="Restablecer contraseña">${icon('key')}</button>
        <button class="icon-btn" data-action="del-user" data-name="${esc(u.name)}" aria-label="Eliminar ${esc(u.name)}" title="Eliminar">${icon('trash')}</button>`}</td></tr>`).join('')}</tbody></table></div></div>
    <p class="fine">${r.items.length} de ${r.max} cuentas. Los nombres se guardan con mayúscula inicial (p. ej. “carolina” → “Carolina”).</p>`;
}
function pwField(id, label) {
  return `<label for="${id}">${label}</label><div class="row"><div class="pw spacer"><input id="${id}" type="text" autocomplete="off" spellcheck="false" maxlength="64"></div>
    <button class="btn ghost" type="button" data-gen="${id}">Generar</button></div><div class="field-hint">Mínimo 10 caracteres con letras y números. Entréguela en persona; el sistema pedirá cambiarla.</div>`;
}
function userModal() {
  openModal('Nuevo usuario', `
    <label for="u-name">Nombre de usuario</label><input id="u-name" maxlength="20" autocomplete="off" spellcheck="false" placeholder="Ej. Carolina">
    <div class="field-hint" id="u-prev">Letras y números, sin espacios.</div>
    <label for="u-role">Rol</label><select id="u-role"><option value="usuario">Usuario — horarios y timbre manual</option><option value="admin">Administrador — acceso total</option></select>
    ${pwField('u-pass', 'Contraseña temporal')}<p class="form-msg" id="u-msg"></p>`,
  '<button class="btn ghost" data-m="cancel">Cancelar</button><button class="btn primary" data-m="save">Crear usuario</button>',
  async (act, btn) => {
    if (act !== 'save') return true;
    const name = $('#u-name').value.trim(), password = $('#u-pass').value;
    if (!/^[A-Za-z][A-Za-z0-9]{2,19}$/.test(name)) return msgIn('#u-msg', 'Use de 3 a 20 letras o números, empezando por letra.');
    const p = pwProblem(password, name);
    if (p) return msgIn('#u-msg', p);
    try { await busy(btn, async () => toast((await api('/api/users', { action: 'add', username: name, role: $('#u-role').value, password })).message)); closeModal(); route(); } catch (e) { msgIn('#u-msg', e.message); }
  });
  $('#u-name').addEventListener('input', (e) => { $('#u-prev').textContent = e.target.value ? 'Se guardará como: ' + normName(e.target.value) : 'Letras y números, sin espacios.'; });
}
function editUserModal(u) {
  openModal('Editar ' + u.name, `
    <label for="e-role">Rol</label><select id="e-role"><option value="usuario">Usuario</option><option value="admin">Administrador</option></select>
    <label class="switch"><input type="checkbox" id="e-act" ${u.active ? 'checked' : ''}> <span>Cuenta activa<small>Una cuenta inactiva no puede ingresar; se conserva su historial.</small></span></label>
    <p class="form-msg" id="e-msg"></p>`,
  '<button class="btn ghost" data-m="cancel">Cancelar</button><button class="btn primary" data-m="save">Guardar</button>',
  async (act, btn) => {
    if (act !== 'save') return true;
    try { await busy(btn, async () => toast((await api('/api/users', { action: 'update', username: u.name, role: $('#e-role').value, active: $('#e-act').checked })).message)); closeModal(); route(); } catch (e) { msgIn('#e-msg', e.message); }
  });
  $('#e-role').value = u.role;
}
function resetUserModal(u) {
  openModal('Restablecer contraseña', `<p class="muted">Asigne una contraseña temporal a <b>${esc(u.name)}</b>. Se cerrarán sus sesiones abiertas y deberá crear una nueva al ingresar.</p>
    ${pwField('r-pass', 'Contraseña temporal')}<p class="form-msg" id="r-msg"></p>`,
  '<button class="btn ghost" data-m="cancel">Cancelar</button><button class="btn primary" data-m="save">Restablecer</button>',
  async (act, btn) => {
    if (act !== 'save') return true;
    const password = $('#r-pass').value, p = pwProblem(password, u.name);
    if (p) return msgIn('#r-msg', p);
    try { await busy(btn, async () => toast((await api('/api/users', { action: 'reset', username: u.name, password })).message)); closeModal(); route(); } catch (e) { msgIn('#r-msg', e.message); }
  });
}

// ---------- Vista: Historial ----------
const AUDIT_LABELS = {
  'auth.login': ['Inicio de sesión', 'info'], 'auth.fail': ['Ingreso fallido', 'warn'], 'auth.locked': ['Cuenta bloqueada', 'danger'], 'auth.logout': ['Cierre de sesión', ''],
  'auth.password': ['Cambio de contraseña', 'info'], 'user.add': ['Usuario creado', 'info'], 'user.update': ['Usuario modificado', 'info'], 'user.reset': ['Contraseña restablecida', 'warn'],
  'user.unlock': ['Usuario desbloqueado', 'info'], 'user.delete': ['Usuario eliminado', 'warn'], 'sched.add': ['Timbre agregado', 'ok'], 'sched.update': ['Timbre modificado', 'ok'],
  'sched.delete': ['Timbre eliminado', 'warn'], 'sched.toggle': ['Timbre activado/pausado', 'ok'], 'sched.copy': ['Horario copiado', 'ok'], 'sched.clear': ['Día vaciado', 'warn'],
  'sched.split': ['Timbre separado', 'ok'], 'ring.manual': ['Timbre manual', 'admin'], 'ring.auto': ['Timbre automático', ''], 'ring.stop': ['Timbre detenido', ''],
  'auto.set': ['Modo automático', 'warn'], 'time.set': ['Ajuste de hora', 'warn'], 'time.ntp': ['Hora por internet', ''], 'net.update': ['Cambio de red', 'warn'],
  'gs.update': ['Respaldo Sheets', 'info'], 'backup.create': ['Copia de seguridad', 'ok'], 'backup.restore': ['Copia restaurada', 'danger'], 'backup.fail': ['Restauración rechazada', 'danger'],
  'audit.export': ['Historial exportado', ''], 'security.denied': ['Acceso denegado', 'danger'], 'system.boot': ['Equipo iniciado', ''], 'system.reboot': ['Reinicio', 'warn'],
  'system.provision': ['Primer arranque', 'info'], 'system.factory': ['Restauración de fábrica', 'danger'], 'system.recover': ['Recuperación de archivos', 'danger'],
};
async function viewAudit(el) {
  if (!S.users.length) { try { S.users = (await api('/api/users')).items; } catch (e) { /* sin lista */ } }
  el.innerHTML = `
    <div class="card">
      <form class="filters" id="af">
        <div class="grow"><label for="af-q">Buscar</label><input id="af-q" placeholder="Texto, hora, IP…"></div>
        <div><label for="af-u">Usuario</label><select id="af-u"><option value="">Todos</option><option>Sistema</option>${S.users.map((u) => `<option>${esc(u.name)}</option>`).join('')}</select></div>
        <div><label for="af-t">Tipo</label><select id="af-t"><option value="">Todo</option><option value="auth">Ingresos y contraseñas</option><option value="sched">Horarios</option><option value="ring">Timbres</option><option value="user">Usuarios</option><option value="net">Red</option><option value="time">Hora</option><option value="backup">Copias</option><option value="security">Seguridad</option><option value="system">Sistema</option></select></div>
        <div class="row"><button class="btn primary" type="submit">Filtrar</button><button class="btn ghost" type="button" data-action="csv">${icon('download')} CSV</button></div>
      </form>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Fecha y hora</th><th>Usuario</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead><tbody id="ab"></tbody></table></div>
      <div class="row end"><button class="btn ghost hidden" id="a-more" type="button">Cargar más</button></div>
    </div>
    <p class="fine">El historial se guarda en el equipo (últimos ~1.000 eventos) y, si activa el respaldo, también en Google Sheets.</p>`;
  $('#af').addEventListener('submit', (e) => { e.preventDefault(); loadAudit(true); });
  $('#a-more').addEventListener('click', () => loadAudit(false));
  await loadAudit(true);
}
async function loadAudit(reset) {
  if (reset) { S.auditBefore = null; $('#ab').innerHTML = ''; }
  const q = new URLSearchParams({ limit: 50, q: $('#af-q').value, user: $('#af-u').value, type: $('#af-t').value });
  if (S.auditBefore) q.set('before', S.auditBefore);
  const r = await api('/api/audit?' + q);
  const rows = r.items.map((e) => {
    const [label, cls] = AUDIT_LABELS[e.a] || [e.a, ''];
    return `<tr><td class="num muted">${e.q}</td><td class="num">${esc((e.t || 'sin hora').replace('T', ' '))}</td><td><b>${esc(e.u)}</b><br><small class="muted">${esc(e.r)}</small></td>
      <td><span class="badge ${cls}">${esc(label)}</span></td><td class="detail">${esc(e.d)}</td><td class="num muted">${esc(e.ip)}</td></tr>`;
  }).join('');
  $('#ab').insertAdjacentHTML('beforeend', rows || (reset ? '<tr><td colspan="6" class="empty">Sin resultados.</td></tr>' : ''));
  if (r.items.length) S.auditBefore = r.items[r.items.length - 1].q;
  $('#a-more').classList.toggle('hidden', !r.more);
}
async function downloadCsv(btn) {
  await busy(btn, async () => {
    const r = await fetch('/api/audit.csv', { headers: { 'X-Session': S.token } });
    if (!r.ok) { toast('No se pudo descargar el historial.', true); return; }
    const stamp = (S.status && S.status.now ? S.status.now.slice(0, 10) : 'historial');
    saveBlob(await r.text(), `historial-timbre-${stamp}.csv`, 'text/csv;charset=utf-8');
  });
}

// ---------- Vista: Reloj ----------
async function viewClock(el) {
  await refreshStatus();
  const st = S.status, now = deviceNow();
  el.innerHTML = `<div class="cards">
    <div class="card span-6"><h2>${icon('clock')} Fecha y hora del timbre</h2>
      <p class="sub">Actual: <b>${now ? esc(now.toISOString().slice(0, 19).replace('T', ' ')) : 'sin hora válida'}</b> · ${st.ntp ? 'sincronizado por internet' : 'reloj interno DS1302'}</p>
      <div class="grid2"><div><label for="t-date">Fecha</label><input id="t-date" type="date"></div><div><label for="t-time">Hora</label><input id="t-time" type="time" step="1"></div></div>
      <div class="row"><button class="btn ghost" data-action="use-device-time">${icon('refresh')} Usar la hora de este dispositivo</button><span class="spacer"></span><button class="btn primary" data-action="save-time">Guardar</button></div>
      <p class="fine">Si conecta el timbre a la red institucional (Red y equipo), la hora se corrige sola por internet.</p></div>
    <div class="card span-6"><h2>${icon('bell')} Modo automático</h2>
      <p class="sub">Apáguelo en vacaciones o jornadas especiales. Los horarios se conservan.</p>
      <label class="switch"><input type="checkbox" id="auto-sw2" ${st.auto ? 'checked' : ''}> <span>Timbres automáticos ${st.auto ? 'activos' : 'en pausa'}</span></label></div></div>`;
  if (now) { $('#t-date').value = now.toISOString().slice(0, 10); $('#t-time').value = now.toISOString().slice(11, 19); }
  $('#auto-sw2').addEventListener('change', async (e) => {
    try { toast((await api('/api/auto', { enabled: e.target.checked })).message); await refreshStatus(); route(); } catch (err) { toast(err.message, true); }
  });
}

// ---------- Vista: Red y equipo ----------
async function viewNetwork(el) {
  const n = await api('/api/network');
  el.innerHTML = `<div class="cards">
    <div class="card span-6"><h2>${icon('wifi')} Red Wi-Fi del timbre</h2>
      <p class="sub">La red que crea el equipo. ${n.apClients} dispositivo(s) conectado(s).</p>
      ${n.apPassDefault ? `<div class="banner">${icon('alert')}<div>La clave sigue siendo la de fábrica. Cámbiela ahora.</div></div>` : ''}
      <label for="n-ssid">Nombre de la red (SSID)</label><input id="n-ssid" maxlength="32" value="${esc(n.apSsid)}">
      <label for="n-pass">Nueva clave Wi-Fi</label><div class="pw"><input id="n-pass" type="password" maxlength="63" autocomplete="new-password" placeholder="Dejar vacío para no cambiarla"><button type="button" class="pw-toggle" data-toggle-pw="n-pass" aria-label="Mostrar">${icon('eye')}</button></div>
      <div class="field-hint">8 a 63 caracteres, sin tildes ni ñ. La clave actual nunca se muestra.</div>
      <div class="grid2"><div><label for="n-ip">Dirección IP</label><input id="n-ip" value="${esc(n.apIp)}" inputmode="decimal"></div>
        <div><label for="n-mask">Máscara</label><select id="n-mask"><option>255.255.255.0</option><option>255.255.0.0</option></select></div></div>
      <div class="field-hint">Panel: http://${esc(n.apIp)}/ · también http://${esc(n.hostname)} en computadores y iPhone.</div></div>
    <div class="card span-6"><h2>${icon('wifi')} Red institucional (opcional)</h2>
      <p class="sub">Conecta el timbre al Wi-Fi del colegio para tener hora exacta por internet y respaldo en Google Sheets.</p>
      <div class="kv"><div><small>Estado</small><b>${n.staEnabled ? (n.staConnected ? 'Conectado · ' + esc(n.staIp) : 'Sin conexión') : 'Desactivada'}</b></div><div><small>Hora por internet</small><b>${n.ntpSynced ? 'Sincronizada' : 'No'}</b></div></div>
      <label class="switch"><input type="checkbox" id="n-sta" ${n.staEnabled ? 'checked' : ''}> <span>Usar red institucional</span></label>
      <label for="n-sssid">Nombre de la red del colegio</label><input id="n-sssid" maxlength="32" value="${esc(n.staSsid)}">
      <label for="n-spass">Clave de la red del colegio</label><div class="pw"><input id="n-spass" type="password" maxlength="63" autocomplete="off" placeholder="${n.staPassSet ? 'Guardada · dejar vacío para no cambiarla' : 'Escriba la clave'}"><button type="button" class="pw-toggle" data-toggle-pw="n-spass" aria-label="Mostrar">${icon('eye')}</button></div>
      <label class="switch"><input type="checkbox" id="n-ntp" ${n.ntpEnabled ? 'checked' : ''}> <span>Corregir la hora por internet</span></label>
      <label class="switch"><input type="checkbox" id="n-lan" ${n.lanAdmin ? 'checked' : ''}> <span>Permitir el panel desde la red del colegio<small>Riesgo: cualquier equipo de esa red verá la pantalla de ingreso. Recomendado: apagado.</small></span></label></div>
    <div class="card span-12"><div class="row"><p class="muted spacer">Al guardar, el timbre se reinicia (unos 10 s). Los timbres programados no se pierden.</p><button class="btn primary" data-action="save-net">Guardar y reiniciar</button></div></div></div>`;
  $('#n-mask').value = n.apMask;
}
async function saveNetwork(btn) {
  const body = {
    apSsid: $('#n-ssid').value.trim(), apPassword: $('#n-pass').value, apIp: $('#n-ip').value.trim(), apMask: $('#n-mask').value,
    staEnabled: $('#n-sta').checked, staSsid: $('#n-sssid').value.trim(), staPassword: $('#n-spass').value, ntpEnabled: $('#n-ntp').checked, lanAdmin: $('#n-lan').checked,
  };
  if (body.apPassword && (body.apPassword.length < 8 || /[^\x20-\x7e]/.test(body.apPassword))) return toast('La clave Wi-Fi debe tener 8 a 63 caracteres sin tildes ni ñ.', true);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(body.apIp)) return toast('Escriba una IP válida, p. ej. 192.168.4.1', true);
  if (!(await confirmModal('Guardar y reiniciar', `El timbre se reiniciará. Después conéctese a la red <b>${esc(body.apSsid)}</b>${body.apPassword ? ' con la <b>nueva clave</b>' : ''} y abra <b>http://${esc(body.apIp)}/</b>.`, 'Guardar y reiniciar'))) return;
  try {
    const r = await busy(btn, () => api('/api/network', body));
    if (r.restart) restartingModal(r.message, r.ssid, r.url); else toast(r.message);
  } catch (e) { toast(e.message, true); }
}
function restartingModal(msg, ssid, url) {
  clearInterval(S.poll);
  openModal('Reiniciando el timbre', `<p>${esc(msg)}</p><ol><li>Espere unos 10 segundos.</li><li>Conecte este dispositivo a la red <b>${esc(ssid)}</b>.</li><li>Abra <b>${esc(url)}</b> e ingrese de nuevo.</li></ol><p class="muted"><span class="spin"></span> Esperando al equipo…</p>`, `<a class="btn primary" href="${esc(url)}">Abrir ${esc(url)}</a>`, () => false);
  store.set('tk', null);
}

// ---------- Vista: Copias y respaldo ----------
async function viewBackup(el) {
  const [b, g] = await Promise.all([api('/api/backup'), api('/api/integration')]);
  el.innerHTML = `<div class="cards">
    <div class="card span-6"><h2>${icon('download')} Crear copia de seguridad</h2>
      <p class="sub">Incluye usuarios, horarios, red, modo automático y respaldo en Sheets. Sale <b>cifrada</b> (AES-256) con la frase que usted elija.</p>
      <div class="kv"><div><small>Última copia</small><b>${esc(b.lastBackupAt || 'Nunca')}</b></div><div><small>Estado</small><b>${b.pendingChanges ? '<span class="badge warn">Hay cambios sin copia</span>' : '<span class="badge ok">Al día</span>'}</b></div></div>
      <label for="b-p1">Frase de la copia</label><div class="pw"><input id="b-p1" type="password" autocomplete="new-password" maxlength="128"><button type="button" class="pw-toggle" data-toggle-pw="b-p1" aria-label="Mostrar">${icon('eye')}</button></div>
      <label for="b-p2">Repita la frase</label><input id="b-p2" type="password" autocomplete="new-password" maxlength="128">
      <div class="field-hint">Mínimo 12 caracteres con letras y números. <b>Guárdela fuera del timbre</b> (gestor de contraseñas o sobre sellado): sin ella la copia no se puede abrir.</div>
      <p class="form-msg" id="b-msg"></p>
      <button class="btn primary block" data-action="make-backup">${icon('download')} Descargar copia cifrada</button>
      <p class="fine">Guarde el archivo en Drive → TIMBRE_VER:2 → 03_Copias_de_seguridad.</p></div>
    <div class="card span-6"><h2>${icon('upload')} Restaurar desde una copia</h2>
      <p class="sub">Para reparar un daño o pasar la configuración a un timbre nuevo. Primero se verifica la copia; nada cambia hasta que confirme.</p>
      <label for="r-file">Archivo de copia (.json)</label><input id="r-file" type="file" accept=".json,application/json">
      <label for="r-pass">Frase de la copia</label><input id="r-pass" type="password" autocomplete="off" maxlength="128">
      <p class="form-msg" id="r-msg"></p>
      <button class="btn ghost block" data-action="check-backup">${icon('shield')} Verificar copia</button>
      <div id="r-prev"></div></div>
    <div class="card span-12"><h2>${icon('sheet')} Respaldo del historial en Google Sheets</h2>
      <p class="sub">Envía cada minuto los eventos nuevos, firmados, a la hoja de la carpeta TIMBRE_VER:2. Requiere la red institucional.</p>
      <div class="kv"><div><small>Estado</small><b>${g.enabled ? (g.lastOk ? '<span class="badge ok">Funcionando</span>' : '<span class="badge warn">Revisar</span>') : '<span class="badge">Desactivado</span>'}</b></div>
        <div><small>Último intento</small><b>${esc(g.lastAt || '—')}</b></div><div><small>Resultado</small><b>${esc(g.lastMsg)}</b></div><div><small>Eventos pendientes</small><b>${g.pending}</b></div></div>
      ${g.staConnected ? '' : `<div class="banner info">${icon('wifi')}<div>El timbre no está conectado a la red institucional. Actívela en <a href="#/red">Red y equipo</a>.</div></div>`}
      <label class="switch"><input type="checkbox" id="g-en" ${g.enabled ? 'checked' : ''}> <span>Activar respaldo en Google Sheets</span></label>
      <div class="grid2"><div><label for="g-url">URL de la aplicación web (/exec)</label><input id="g-url" value="${esc(g.url)}" placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false"></div>
        <div><label for="g-key">Clave secreta</label><div class="pw"><input id="g-key" type="password" autocomplete="off" maxlength="128" placeholder="${g.keySet ? 'Guardada · dejar vacío para no cambiarla' : 'Pegue la clave de instalar()'}"><button type="button" class="pw-toggle" data-toggle-pw="g-key" aria-label="Mostrar">${icon('eye')}</button></div></div></div>
      <div class="grid2"><div><label for="g-dev">Identificador de este timbre</label><input id="g-dev" maxlength="24" value="${esc(g.deviceId)}"></div></div>
      <div class="row end"><button class="btn ghost" data-action="test-gs">Probar conexión</button><button class="btn primary" data-action="save-gs">Guardar</button></div></div></div>`;
}
async function makeBackup(btn) {
  const p1 = $('#b-p1').value, p2 = $('#b-p2').value;
  if (p1.length < 12 || !/[a-zA-ZÀ-ÿ]/.test(p1) || !/\d/.test(p1)) return msgIn('#b-msg', 'La frase debe tener al menos 12 caracteres con letras y números.');
  if (p1 !== p2) return msgIn('#b-msg', 'Las frases no coinciden.');
  try {
    const f = await busy(btn, () => api('/api/backup', { passphrase: p1 }));
    const date = (f.createdAt || 'copia').slice(0, 10);
    saveBlob(JSON.stringify(f, null, 1), `timbre-${f.device}-${date}.json`, 'application/json');
    $('#b-p1').value = ''; $('#b-p2').value = '';
    msgIn('#b-msg', 'Copia descargada. Guárdela en un lugar seguro.', true);
    refreshStatus().catch(() => {});
  } catch (e) { msgIn('#b-msg', e.message); }
}
async function readBackupFile() {
  const f = $('#r-file').files[0];
  if (!f) throw new Error('Seleccione el archivo de copia.');
  if (f.size > 24000) throw new Error('El archivo es demasiado grande para ser una copia del timbre.');
  try { return JSON.parse(await f.text()); } catch (e) { throw new Error('El archivo no es una copia válida.'); }
}
async function checkBackup(btn) {
  $('#r-prev').innerHTML = '';
  try {
    const backup = await readBackupFile(), pass = $('#r-pass').value;
    if (!pass) return msgIn('#r-msg', 'Escriba la frase de la copia.');
    const p = await busy(btn, () => api('/api/restore', { action: 'preview', passphrase: pass, backup }));
    msgIn('#r-msg', 'Copia válida y sin alteraciones.', true);
    $('#r-prev').innerHTML = `<div class="kv">
      <div><small>Creada</small><b>${esc((p.createdAt || 'sin fecha').replace('T', ' '))}</b></div><div><small>Por</small><b>${esc(p.createdBy)}</b></div>
      <div><small>Equipo</small><b>${esc(p.device)} · v${esc(p.fw)}</b></div><div><small>Timbres</small><b>${p.schedules}</b></div>
      <div><small>Red Wi-Fi</small><b>${esc(p.apSsid)} · ${esc(p.apIp)}</b></div><div><small>Red institucional</small><b>${p.staEnabled ? esc(p.staSsid) : 'No'}</b></div></div>
      <p class="muted">Usuarios: ${p.users.map((u) => `${esc(u.name)} (${u.role === 'admin' ? 'admin' : 'usuario'}${u.active ? '' : ', inactivo'})`).join(', ')}</p>
      <div class="banner danger">${icon('alert')}<div>Restaurar <b>reemplaza</b> usuarios, horarios y red actuales. El historial actual se conserva. El equipo se reiniciará y deberá ingresar con los usuarios de la copia.</div></div>
      <button class="btn danger block" data-action="apply-backup">Restaurar esta copia</button>`;
  } catch (e) { msgIn('#r-msg', e.message); }
}
async function applyBackup() {
  const ok = await confirmModal('Restaurar copia', 'Escriba <span class="confirm-word">RESTAURAR</span> para confirmar.<input id="cw" autocomplete="off" aria-label="Confirmación">', 'Restaurar', true, () => $('#cw').value.trim().toUpperCase() === 'RESTAURAR');
  if (!ok) return;
  try {
    const backup = await readBackupFile();
    const r = await api('/api/restore', { action: 'apply', passphrase: $('#r-pass').value, backup });
    restartingModal(r.message, r.ssid, r.url);
  } catch (e) { toast(e.message, true); }
}
async function saveGs(btn) {
  const body = { enabled: $('#g-en').checked, url: $('#g-url').value.trim(), key: $('#g-key').value.trim(), deviceId: $('#g-dev').value.trim() };
  try { toast((await busy(btn, () => api('/api/integration', body))).message); route(); } catch (e) { toast(e.message, true); }
}

// ---------- Vista: Sistema ----------
async function viewSystem(el) {
  const s = await api('/api/system');
  el.innerHTML = `<div class="cards"><div class="card span-12"><h2>${icon('cpu')} Estado del equipo</h2><div class="kv">
    <div><small>Versión</small><b>${esc(s.version)}</b></div><div><small>Encendido hace</small><b>${fmtUptime(s.uptime)}</b></div>
    <div><small>Último reinicio</small><b>${esc(s.resetReason)}</b></div><div><small>Chip</small><b>${esc(s.chip)} · ${s.cpuMhz} MHz</b></div>
    <div><small>Memoria libre</small><b>${fmtBytes(s.heapFree)} (mín. ${fmtBytes(s.heapMin)})</b></div><div><small>Almacenamiento</small><b>${fmtBytes(s.fsUsed)} de ${fmtBytes(s.fsTotal)}</b></div>
    <div><small>Horarios / usuarios</small><b>${s.schedules} / ${s.users}</b></div><div><small>Sesiones abiertas</small><b>${s.sessions}</b></div>
    <div><small>Reloj</small><b>${s.rtcOk ? 'Hora válida' : 'Sin hora'}${s.ntp ? ' · internet' : ''}</b></div><div><small>Pin del relé</small><b>GPIO ${s.relayPin}</b></div>
    <div><small>MAC</small><b>${esc(s.mac)}</b></div><div><small>Eventos registrados</small><b>${s.auditSeq}</b></div></div></div>
    <div class="card span-6"><h2>${icon('refresh')} Reiniciar</h2><p class="sub">No borra nada. Útil si el equipo se comporta raro.</p><button class="btn ghost" data-action="reboot">Reiniciar ahora</button></div>
    <div class="card span-6"><h2>${icon('lock')} Restaurar de fábrica</h2><p class="sub">Por seguridad solo se hace en el equipo: mantenga presionado el botón <b>BOOT</b> 10 segundos con el timbre encendido. Restablece red y usuarios iniciales; conserva horarios e historial. Después use una copia de seguridad.</p></div></div>`;
}

// ---------- Vista: Mi cuenta ----------
async function viewAccount(el) {
  el.innerHTML = `<div class="cards"><div class="card span-6"><h2>${icon('key')} Cambiar mi contraseña</h2>
    <label for="a-old">Contraseña actual</label><input id="a-old" type="password" autocomplete="current-password" maxlength="64">
    <label for="a-new">Nueva contraseña</label><div class="pw"><input id="a-new" type="password" autocomplete="new-password" maxlength="64"><button type="button" class="pw-toggle" data-toggle-pw="a-new" aria-label="Mostrar">${icon('eye')}</button></div>
    <label for="a-new2">Repita la nueva contraseña</label><input id="a-new2" type="password" autocomplete="new-password" maxlength="64">
    <p class="form-msg" id="a-msg"></p><button class="btn primary" data-action="change-pw">Actualizar contraseña</button>
    <p class="fine">Al cambiarla se cierran sus sesiones en otros dispositivos.</p></div>
    <div class="card span-6"><h2>${icon('user')} Mi sesión</h2><div class="kv"><div><small>Usuario</small><b>${esc(S.user)}</b></div><div><small>Rol</small><b>${isAdmin() ? 'Administrador' : 'Usuario'}</b></div></div>
    <p class="muted">La sesión se cierra sola tras 30 minutos sin uso.</p><button class="btn ghost" data-action="logout">${icon('logout')} Cerrar sesión</button></div></div>`;
}
async function changeMyPassword(btn) {
  const cur = $('#a-old').value, n1 = $('#a-new').value, n2 = $('#a-new2').value, p = pwProblem(n1, S.user);
  if (p) return msgIn('#a-msg', p);
  if (n1 !== n2) return msgIn('#a-msg', 'Las contraseñas nuevas no coinciden.');
  try { await busy(btn, () => api('/api/password', { current: cur, new: n1 })); ['#a-old', '#a-new', '#a-new2'].forEach((s) => ($(s).value = '')); msgIn('#a-msg', 'Contraseña actualizada.', true); } catch (e) { msgIn('#a-msg', e.message); }
}

// ---------- Modales ----------
let modalHandler = null, lastFocus = null;
function openModal(title, body, footer, handler) {
  lastFocus = document.activeElement;
  modalHandler = handler;
  $('#modal-root').innerHTML = `<div class="modal-back" data-m="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <header><h2 id="m-title">${esc(title)}</h2><button class="icon-btn" data-m="cancel" aria-label="Cerrar">${icon('x')}</button></header>
    <div class="body">${body}</div><footer>${footer}</footer></div></div>`;
  const first = $('#modal-root input, #modal-root select, #modal-root button.primary');
  if (first) setTimeout(() => first.focus(), 20);
}
function closeModal() { $('#modal-root').innerHTML = ''; modalHandler = null; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
function confirmModal(title, html, okText, danger, validate) {
  return new Promise((resolve) => {
    openModal(title, `<p>${html}</p>`, `<button class="btn ghost" data-m="cancel">Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-m="ok">${esc(okText)}</button>`, (act) => {
      if (act === 'ok') { if (validate && !validate()) { toast('Escriba la palabra de confirmación.', true); return false; } closeModal(); resolve(true); return false; }
      closeModal(); resolve(false); return false;
    });
  });
}
function msgIn(sel, text, ok) { const m = $(sel); if (m) { m.textContent = text; m.className = 'form-msg' + (ok ? ' ok' : ''); } return false; }
$('#modal-root').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-m]');
  if (!b || (b.dataset.m === 'backdrop' && e.target !== b)) return;
  const act = b.dataset.m === 'backdrop' ? 'cancel' : b.dataset.m;
  const keep = modalHandler ? await modalHandler(act, b) : true;
  if (keep === true && (act === 'cancel')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !modalHandler) return;
  Promise.resolve(modalHandler('cancel')).then((k) => { if (k === true) closeModal(); });
});

// ---------- Acciones (delegación de eventos: sin JS en línea, compatible con CSP) ----------
document.addEventListener('click', async (e) => {
  const tg = e.target.closest('[data-toggle-pw]');
  if (tg) { const i = $('#' + tg.dataset.togglePw); i.type = i.type === 'password' ? 'text' : 'password'; return; }
  const gen = e.target.closest('[data-gen]');
  if (gen) { $('#' + gen.dataset.gen).value = randomPassword(); return; }
  const q = e.target.closest('.quick button[data-mask]');
  if (q) { const m = Number(q.dataset.mask); $$(`#${q.parentElement.dataset.for} input`).forEach((x) => (x.checked = !!(m & Number(x.value)))); return; }
  const a = e.target.closest('[data-action]');
  if (!a || a.matches('input')) return;
  const act = a.dataset.action, id = Number(a.dataset.id), sched = () => S.schedules.find((s) => s.id === id), user = () => S.users.find((u) => u.name === a.dataset.name);
  try {
    switch (act) {
      case 'logout': try { await api('/api/logout', {}); } catch (err) { /* ya cerrada */ } endSession('Sesión cerrada.'); break;
      case 'open-menu': $('#app').classList.add('menu-open'); break;
      case 'close-menu': $('#app').classList.remove('menu-open'); break;
      case 'ring': await busy(a, async () => { toast((await api('/api/ring', { seconds: S.ringSec })).message); await refreshStatus(); }); break;
      case 'stop': toast((await api('/api/stop', {})).message); await refreshStatus(); break;
      case 'new-sched': scheduleModal(null); break;
      case 'edit-sched': scheduleModal(sched(), a.dataset.day !== undefined ? Number(a.dataset.day) : undefined); break;
      case 'del-sched': deleteSchedule(sched()); break;
      case 'day-menu': dayMenu(Number(a.dataset.day)); break;
      case 'new-user': userModal(); break;
      case 'edit-user': editUserModal(user()); break;
      case 'reset-user': resetUserModal(user()); break;
      case 'unlock-user': toast((await api('/api/users', { action: 'unlock', username: a.dataset.name })).message); route(); break;
      case 'del-user':
        if (await confirmModal('Eliminar usuario', `Se eliminará la cuenta <b>${esc(a.dataset.name)}</b>. Su historial se conserva.`, 'Eliminar', true)) {
          toast((await api('/api/users', { action: 'delete', username: a.dataset.name })).message); route();
        }
        break;
      case 'csv': await downloadCsv(a); break;
      case 'use-device-time': { const d = new Date(), p = (n) => String(n).padStart(2, '0'); $('#t-date').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; $('#t-time').value = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; break; }
      case 'save-time': toast((await busy(a, () => api('/api/time', { date: $('#t-date').value, time: $('#t-time').value }))).message); await refreshStatus(); route(); break;
      case 'save-net': await saveNetwork(a); break;
      case 'make-backup': await makeBackup(a); break;
      case 'check-backup': await checkBackup(a); break;
      case 'apply-backup': await applyBackup(); break;
      case 'save-gs': await saveGs(a); break;
      case 'test-gs': toast((await api('/api/integration', { action: 'test' })).message); setTimeout(route, 6000); break;
      case 'reboot':
        if (await confirmModal('Reiniciar', 'El timbre se reiniciará (unos 10 s). Los horarios no se pierden.', 'Reiniciar')) { await api('/api/reboot', {}); restartingModal('Reiniciando…', S.status.device.name, location.origin + '/'); }
        break;
      case 'change-pw': await changeMyPassword(a); break;
      default: break;
    }
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', async (e) => {
  const t = e.target.closest('[data-action="toggle-sched"]');
  if (!t) return;
  try { toast((await api('/api/schedules', { action: 'toggle', id: Number(t.dataset.id), enabled: t.checked })).message); route(); } catch (err) { toast(err.message, true); t.checked = !t.checked; }
});

// ---------- Inicio ----------
hydrateIcons();
(async () => {
  S.token = store.get('tk') || '';
  if (S.token) { try { await startApp(); return; } catch (e) { /* sesión vencida */ } }
  endSession('');
})();
