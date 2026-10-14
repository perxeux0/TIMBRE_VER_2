/* Timbre Alba V2 — MODO DEMOSTRACIÓN (GitHub Pages).
   Simula en el navegador las rutas /api del timbre para mostrar el panel sin
   hardware. No controla ningún equipo, no envía datos a ningún servidor y no
   contiene claves reales: todo vive en el almacenamiento local de este navegador.
   Las reglas de roles, contraseñas y validaciones imitan las del firmware. */
'use strict';
(function () {
  const DEMO_PASSWORD = 'Demo-Timbre-2026';
  const FACTORY_WIFI = 'Clave-de-fabrica-demo';
  const KEY = 'timbre-demo-state-v1';
  const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const enc = new TextEncoder();
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function pbkdf2(pw, salt, iter) {
    const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
  }
  async function hashPw(pw, saltHex) { return hex(await pbkdf2(pw, unhex(saltHex), 1000)); }
  async function newUser(name, role, pw, must) {
    const s = hex(rnd(16));
    return { name, role, salt: s, hash: await hashPw(pw, s), mustChange: must, active: true, fails: 0, lockUntil: 0 };
  }

  // ---------- Estado (persistente en este navegador) ----------
  async function freshState() {
    const st = {
      users: [await newUser('Rector', 'admin', DEMO_PASSWORD, true), await newUser('Coordinador', 'admin', DEMO_PASSWORD, true),
        await newUser('Secretaria', 'admin', DEMO_PASSWORD, true), await newUser('Docente', 'usuario', DEMO_PASSWORD, false)],
      schedules: [], nextId: 1, sessions: {}, audit: [], seq: 0, auto: true, clockOffset: 0, relayUntil: 0, lastManual: 0,
      net: { apSsid: 'Timbre Alba (demo)', apPass: FACTORY_WIFI, apIp: '192.168.4.1', apMask: '255.255.255.0', staEn: false, staSsid: '', staPass: '', lanAdmin: false, ntpEn: true },
      gs: { en: false, url: '', key: '', devId: 'timbre-demo' }, cfgRev: 1, bkRev: 0, bkAt: '', boot: Date.now(),
    };
    [['07:00', 'Inicio de clases', 31], ['08:45', 'Descanso 1', 31], ['09:00', 'Fin de descanso 1', 31], ['10:30', 'Descanso 2', 31],
      ['10:45', 'Fin de descanso 2', 31], ['12:15', 'Salida', 31], ['14:00', 'Inicio jornada tarde', 15], ['17:30', 'Salida final', 15], ['08:00', 'Entrada sábado', 32]]
      .forEach(([t, n, d]) => { const [h, m] = t.split(':').map(Number); st.schedules.push({ id: st.nextId++, name: n, hour: h, minute: m, days: d, duration: 3, enabled: true }); });
    audit(st, ['Sistema', 'sistema'], 'system.boot', 'Equipo iniciado v2.0.0 (modo demostración)', '');
    return st;
  }
  function load() { try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch (e) { return MEM; } }
  function save(st) { MEM = st; try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* modo privado: queda en memoria */ } }
  let MEM = null;

  // ---------- Utilidades ----------
  const now = (st) => new Date(Date.now() - 5 * 3600e3 + st.clockOffset * 1000); // hora de Colombia en campos UTC
  const iso = (d) => d.toISOString().slice(0, 19);
  const dow = (d) => (d.getUTCDay() + 6) % 7;
  const hhmm = (s) => String(s.hour).padStart(2, '0') + ':' + String(s.minute).padStart(2, '0');
  const daysText = (m) => ({ 127: 'Todos los días', 31: 'Lun a Vie', 63: 'Lun a Sáb', 96: 'Sáb y Dom' }[m] || DAYS.filter((_, i) => m & (1 << i)).join(','));
  const schedText = (s) => `${hhmm(s)} ${s.name} [${daysText(s.days)}, ${s.duration} s${s.enabled ? '' : ', pausado'}]`;
  const norm = (n) => { n = String(n || '').trim(); return /^[A-Za-z][A-Za-z0-9]{2,19}$/.test(n) ? n[0].toUpperCase() + n.slice(1).toLowerCase() : ''; };
  function audit(st, actor, a, d, ip) { st.seq++; st.audit.push({ q: st.seq, t: iso(now(st)), u: actor[0], r: actor[1], a, d: String(d).slice(0, 180), ip: ip || '192.168.4.2' }); }
  function pwProblem(pw, user) {
    if (pw.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
    if (!/[A-Za-zÀ-ÿ]/.test(pw) || !/\d/.test(pw)) return 'Use letras y números en la contraseña.';
    if (user && pw.toLowerCase().includes(user.toLowerCase())) return 'La contraseña no puede contener el nombre de usuario.';
    if (pw === DEMO_PASSWORD) return 'No puede reutilizar la contraseña inicial.';
    return null;
  }
  function findNext(st, d) {
    const today = dow(d), nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    let best = null;
    for (let k = 0; k <= 7; k++) {
      const day = (today + k) % 7;
      for (const s of st.schedules) {
        if (!s.enabled || !(s.days & (1 << day))) continue;
        const t = s.hour * 60 + s.minute;
        if ((k === 0 && t <= nowMin) || (k === 7 && t > nowMin)) continue;
        const sec = (k * 1440 + t - nowMin) * 60 - d.getUTCSeconds();
        if (!best || sec < best[0]) best = [sec, s, day];
      }
    }
    return best;
  }
  const sortS = (st) => st.schedules.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  // ---------- Respuestas ----------
  const J = (status, obj, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...(extra || {}) } });
  const ok = (msg, extra) => J(200, { ok: true, ...(msg ? { message: msg } : {}), ...(extra || {}) });
  const err = (status, msg, code) => J(status, { ok: false, error: msg, ...(code ? { code } : {}) });

  async function handle(path, method, headers, body) {
    let st = load();
    if (!st) { st = await freshState(); save(st); }
    const q = new URL(path, 'http://x').searchParams;
    const p = path.split('?')[0];
    const tok = headers['X-Session'] || headers['x-session'] || '';
    let actor = null, sess = null;
    const guard = (admin, allowMust) => {
      sess = st.sessions[tok];
      if (!sess || Date.now() - sess.seen > 1800e3) return err(401, 'Sesión vencida. Ingrese de nuevo.', 'auth');
      sess.seen = Date.now();
      actor = [sess.user, sess.role];
      if (sess.mustChange && !allowMust) return err(403, 'Debe cambiar su contraseña antes de continuar.', 'must_change');
      if (admin && sess.role !== 'admin') { audit(st, actor, 'security.denied', 'Intento de usar función de administrador: ' + p); return err(403, 'Esta función es solo para administradores.', 'forbidden'); }
      return null;
    };
    const d = body ? JSON.parse(body) : {};
    const changed = () => { st.cfgRev++; };
    const r = await route();
    save(st);
    return r;

    async function route() {
      let g;
      // ----- autenticación -----
      if (p === '/api/login') {
        const name = norm(d.username), u = st.users.find((x) => x.name === name);
        const a = [name || '(desconocido)', '-'];
        if (u && u.lockUntil > Date.now()) return err(429, `Cuenta bloqueada por intentos fallidos. Intente en ${Math.ceil((u.lockUntil - Date.now()) / 60000)} min.`);
        if (!u || !u.active || (await hashPw(d.password || '', u.salt)) !== u.hash) {
          if (u) { if (++u.fails >= 5) { u.fails = 0; u.lockUntil = Date.now() + 300e3; audit(st, a, 'auth.locked', 'Cuenta bloqueada 5 min por intentos fallidos'); } else audit(st, a, 'auth.fail', 'Contraseña incorrecta'); } else audit(st, a, 'auth.fail', 'Usuario inexistente o inactivo');
          return err(401, 'Usuario o contraseña incorrectos.');
        }
        u.fails = 0;
        const t = hex(rnd(16));
        st.sessions[t] = { user: u.name, role: u.role, mustChange: u.mustChange, seen: Date.now() };
        audit(st, [u.name, u.role], 'auth.login', u.mustChange ? 'Ingreso (debe cambiar contraseña)' : 'Ingreso');
        return ok(null, { token: t, user: u.name, role: u.role, mustChange: u.mustChange });
      }
      if (p === '/api/logout') { if ((g = guard(false, true))) return g; audit(st, actor, 'auth.logout', 'Cierre de sesión'); delete st.sessions[tok]; return ok(); }
      if (p === '/api/me') { if ((g = guard(false, true))) return g; return ok(null, { user: sess.user, role: sess.role, mustChange: sess.mustChange }); }
      if (p === '/api/password') {
        if ((g = guard(false, true))) return g;
        const u = st.users.find((x) => x.name === sess.user);
        if ((await hashPw(d.current || '', u.salt)) !== u.hash) return err(403, 'La contraseña actual no es correcta.');
        const pr = pwProblem(d.new || '', u.name);
        if (pr) return err(400, pr);
        if (d.new === d.current) return err(400, 'La nueva contraseña debe ser distinta a la actual.');
        u.salt = hex(rnd(16)); u.hash = await hashPw(d.new, u.salt); u.mustChange = false; sess.mustChange = false;
        Object.keys(st.sessions).forEach((k) => { if (k !== tok && st.sessions[k].user === u.name) delete st.sessions[k]; });
        changed(); audit(st, actor, 'auth.password', 'Cambió su contraseña');
        return ok('Contraseña actualizada.');
      }
      // ----- estado -----
      if (p === '/api/status') {
        if ((g = guard())) return g;
        const dt = now(st), nx = st.auto ? findNext(st, dt) : null, nowMin = dt.getUTCHours() * 60 + dt.getUTCMinutes();
        const w = [];
        if (sess.role === 'admin') {
          if (st.net.apPass === FACTORY_WIFI) w.push('La clave Wi-Fi del timbre sigue siendo la de fábrica. Cámbiela en Red y equipo.');
          const pend = st.users.filter((u) => u.active && u.mustChange).map((u) => u.name);
          if (pend.length) w.push('Usuarios que aún no cambian su contraseña inicial: ' + pend.join(', ') + '.');
          if (!st.bkAt) w.push('Aún no hay copia de seguridad de la configuración. Descárguela en Copias de seguridad.');
          else if (st.cfgRev !== st.bkRev) w.push(`Hay cambios posteriores a la última copia de seguridad (${st.bkAt.replace('T', ' ')}). Descargue una nueva.`);
        }
        const rem = Math.max(0, st.relayUntil - Date.now());
        const o = {
          now: iso(dt), dow: dow(dt), rtcOk: true, ntp: false, relay: { on: rem > 0, remainingMs: rem }, auto: st.auto,
          today: st.schedules.filter((s) => s.days & (1 << dow(dt))).map((s) => ({ id: s.id, name: s.name, time: hhmm(s), duration: s.duration, enabled: s.enabled, past: s.hour * 60 + s.minute < nowMin })),
          device: { name: st.net.apSsid, ip: st.net.apIp, version: '2.0.0', uptime: Math.floor((Date.now() - st.boot) / 1000) }, me: { user: sess.user, role: sess.role }, warnings: w,
        };
        if (nx) o.next = { name: nx[1].name, time: hhmm(nx[1]), dow: nx[2], in: nx[0] };
        return ok(null, o);
      }
      // ----- horarios -----
      if (p === '/api/schedules' && method === 'GET') { if ((g = guard())) return g; return ok(null, { items: st.schedules.map((s) => ({ id: s.id, name: s.name, time: hhmm(s), days: s.days, duration: s.duration, enabled: s.enabled })), max: 80 }); }
      if (p === '/api/schedules') {
        if ((g = guard())) return g;
        const parse = (selfId) => {
          const name = String(d.name || '').trim(), m = /^(\d\d):(\d\d)$/.exec(d.time || '');
          if (!name || name.length > 30) return [null, 'El nombre debe tener entre 1 y 30 caracteres.'];
          if (!m || +m[1] > 23 || +m[2] > 59) return [null, 'Hora inválida (use HH:MM).'];
          const days = +d.days, dur = +d.duration;
          if (!(days >= 1 && days <= 127)) return [null, 'Seleccione al menos un día.'];
          if (!(dur >= 1 && dur <= 60)) return [null, 'La duración debe estar entre 1 y 60 segundos.'];
          for (const o of st.schedules) if (o.id !== selfId && o.hour === +m[1] && o.minute === +m[2] && (o.days & days)) {
            const k = [0, 1, 2, 3, 4, 5, 6].find((i) => o.days & days & (1 << i));
            return [null, `Ya existe un timbre a las ${m[1]}:${m[2]} el ${DAYS[k]} (${o.name}).`];
          }
          return [{ name, hour: +m[1], minute: +m[2], days, duration: dur, enabled: d.enabled !== false }, null];
        };
        if (d.action === 'add') { const [s, e] = parse(0); if (e) return err(400, e); s.id = st.nextId++; st.schedules.push(s); sortS(st); changed(); audit(st, actor, 'sched.add', schedText(s)); return ok('Timbre agregado.'); }
        if (d.action === 'copyDay') {
          const fr = +d.from, to = +d.to & ~(1 << fr); let n = 0;
          for (const s of st.schedules) if (s.days & (1 << fr)) { let add = to & ~s.days; for (const o of st.schedules) if (o !== s && o.hour === s.hour && o.minute === s.minute) add &= ~o.days; if (add) { s.days |= add; n++; } }
          changed(); audit(st, actor, 'sched.copy', `Copiados ${n} timbres del ${DAYS[fr]} a: ${daysText(to)}`); return ok(`${n} timbres copiados.`);
        }
        if (d.action === 'clearDay') {
          const day = +d.day; let n = 0;
          st.schedules = st.schedules.filter((s) => { if (s.days & (1 << day)) { s.days &= ~(1 << day); n++; } return s.days; });
          changed(); audit(st, actor, 'sched.clear', `Vaciado el ${DAYS[day]} (${n} timbres)`); return ok(`${n} timbres quitados del ${DAYS[day]}.`);
        }
        const s = st.schedules.find((x) => x.id === +d.id);
        if (!s) return err(404, 'Ese timbre ya no existe. Actualice la página.');
        if (d.action === 'update') { const [n, e] = parse(s.id); if (e) return err(400, e); const before = schedText(s); Object.assign(s, n); sortS(st); changed(); audit(st, actor, 'sched.update', before + ' → ' + schedText(s)); return ok('Timbre actualizado.'); }
        if (d.action === 'toggle') { s.enabled = d.enabled !== undefined ? !!d.enabled : !s.enabled; changed(); audit(st, actor, 'sched.toggle', schedText(s)); return ok(s.enabled ? 'Timbre activado.' : 'Timbre pausado.'); }
        if (d.action === 'delete') { st.schedules = st.schedules.filter((x) => x !== s); changed(); audit(st, actor, 'sched.delete', schedText(s)); return ok('Timbre eliminado.'); }
        if (d.action === 'split') {
          const day = +d.day;
          if (s.days === 1 << day) return ok(null, { id: s.id });
          const c = { ...s, id: st.nextId++, days: 1 << day }; s.days &= ~(1 << day); st.schedules.push(c); sortS(st); changed();
          audit(st, actor, 'sched.split', `Separado el ${DAYS[day]} de: ${c.name}`); return ok(null, { id: c.id });
        }
        return err(400, 'Acción inválida.');
      }
      if (p === '/api/ring') {
        if ((g = guard())) return g;
        const sec = Math.max(1, Math.min(10, +d.seconds || 3));
        if (Date.now() - st.lastManual < 3000) return err(429, 'Espere unos segundos antes de volver a timbrar.');
        st.lastManual = Date.now(); st.relayUntil = Date.now() + sec * 1000;
        audit(st, actor, 'ring.manual', `Timbre manual ${sec} s`); return ok(`Timbre sonando ${sec} s (simulado).`);
      }
      if (p === '/api/stop') { if ((g = guard())) return g; if (st.relayUntil > Date.now()) audit(st, actor, 'ring.stop', 'Timbre detenido manualmente'); st.relayUntil = 0; return ok('Timbre detenido.'); }
      // ----- solo administradores -----
      if (p === '/api/auto') { if ((g = guard(true))) return g; st.auto = d.enabled !== false; changed(); audit(st, actor, 'auto.set', 'Timbre automático ' + (st.auto ? 'ACTIVADO' : 'DESACTIVADO')); return ok(st.auto ? 'Modo automático activado.' : 'Modo automático desactivado.'); }
      if (p === '/api/time') {
        if ((g = guard(true))) return g;
        const t = (d.time || '').length === 5 ? d.time + ':00' : d.time;
        const target = Date.parse(`${d.date}T${t}Z`);
        if (isNaN(target)) return err(400, 'Fecha u hora inválida.');
        const before = iso(now(st)); st.clockOffset = (target - (Date.now() - 5 * 3600e3)) / 1000;
        audit(st, actor, 'time.set', `De ${before} a ${iso(now(st))}`); return ok('Fecha y hora guardadas.');
      }
      if (p === '/api/users' && method === 'GET') {
        if ((g = guard(true))) return g;
        return ok(null, { items: st.users.map((u) => ({ name: u.name, role: u.role, active: u.active, mustChange: u.mustChange, locked: u.lockUntil > Date.now(), me: u.name === sess.user })), max: 16 });
      }
      if (p === '/api/users') {
        if ((g = guard(true))) return g;
        const name = norm(d.username);
        if (!name) return err(400, 'Usuario inválido: 3 a 20 letras o números, empezando por letra.');
        const u = st.users.find((x) => x.name === name), me = name === sess.user;
        const admins = () => st.users.filter((x) => x.active && x.role === 'admin').length;
        const kill = (n) => Object.keys(st.sessions).forEach((k) => { if (st.sessions[k].user === n) delete st.sessions[k]; });
        if (d.action === 'add') {
          if (u) return err(400, 'Ese usuario ya existe.');
          if (!['admin', 'usuario'].includes(d.role)) return err(400, 'Rol inválido.');
          const pr = pwProblem(d.password || '', name); if (pr) return err(400, pr);
          if (st.users.length >= 16) return err(400, 'Máximo 16 usuarios.');
          st.users.push(await newUser(name, d.role, d.password, true)); changed(); audit(st, actor, 'user.add', `Creó a ${name} (${d.role})`);
          return ok('Usuario creado. Deberá cambiar la contraseña al ingresar.');
        }
        if (!u) return err(404, 'Usuario no encontrado.');
        if (d.action === 'update') {
          const role = d.role || u.role, active = d.active !== undefined ? !!d.active : u.active;
          if (me && (role !== u.role || !active)) return err(400, 'No puede cambiar su propio rol ni desactivarse.');
          if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && admins() <= 1) return err(400, 'Debe quedar al menos un administrador activo.');
          u.role = role; u.active = active; kill(name); changed(); audit(st, actor, 'user.update', `${name}: ${role}, ${active ? 'activo' : 'inactivo'}`); return ok('Usuario actualizado.');
        }
        if (d.action === 'reset') {
          if (me) return err(400, 'Para su propia cuenta use Mi cuenta → Cambiar contraseña.');
          const pr = pwProblem(d.password || '', name); if (pr) return err(400, pr);
          Object.assign(u, await newUser(name, u.role, d.password, true)); kill(name); changed(); audit(st, actor, 'user.reset', `Restableció la contraseña de ${name}`);
          return ok('Contraseña temporal asignada. Deberá cambiarla al ingresar.');
        }
        if (d.action === 'unlock') { u.lockUntil = 0; u.fails = 0; audit(st, actor, 'user.unlock', `Desbloqueó a ${name}`); return ok('Cuenta desbloqueada.'); }
        if (d.action === 'delete') {
          if (me) return err(400, 'No puede eliminar su propia cuenta.');
          if (u.role === 'admin' && u.active && admins() <= 1) return err(400, 'Debe quedar al menos un administrador activo.');
          st.users = st.users.filter((x) => x !== u); kill(name); changed(); audit(st, actor, 'user.delete', `Eliminó a ${name}`); return ok('Usuario eliminado.');
        }
        return err(400, 'Acción inválida.');
      }
      if (p === '/api/network' && method === 'GET') {
        if ((g = guard(true))) return g;
        const n = st.net;
        return ok(null, { apSsid: n.apSsid, apIp: n.apIp, apMask: n.apMask, apPassDefault: n.apPass === FACTORY_WIFI, apClients: 2, staEnabled: n.staEn, staSsid: n.staSsid, staPassSet: !!n.staPass, staConnected: false, staIp: '', staRssi: 0, lanAdmin: n.lanAdmin, ntpEnabled: n.ntpEn, ntpSynced: false, hostname: 'timbre.local' });
      }
      if (p === '/api/network') {
        if ((g = guard(true))) return g;
        const n = { ...st.net, apSsid: String(d.apSsid || '').trim(), apIp: d.apIp, apMask: d.apMask, staEn: !!d.staEnabled, staSsid: d.staSsid || '', lanAdmin: !!d.lanAdmin, ntpEn: !!d.ntpEnabled };
        if (d.apPassword) n.apPass = d.apPassword;
        if (d.staPassword) n.staPass = d.staPassword;
        if (!/^[\x20-\x7e]{1,32}$/.test(n.apSsid)) return err(400, 'Nombre de red: 1 a 32 caracteres sin tildes ni ñ.');
        if (!/^[\x20-\x7e]{8,63}$/.test(n.apPass)) return err(400, 'Clave Wi-Fi: 8 a 63 caracteres sin tildes ni ñ.');
        const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(n.apIp || '');
        if (!m || !(m[1] === '10' || (m[1] === '192' && m[2] === '168') || (m[1] === '172' && +m[2] >= 16 && +m[2] <= 31)) || m[4] === '0' || m[4] === '255') return err(400, 'IP inválida. Use una IP privada, p. ej. 192.168.4.1');
        if (n.staEn && !n.staSsid) return err(400, 'Escriba el nombre de la red institucional.');
        st.net = n; changed(); audit(st, actor, 'net.update', 'Configuración de red cambiada. Reinicio programado');
        return ok('Configuración guardada (demostración: no hay equipo que reiniciar).', { restart: true, ssid: n.apSsid, url: location.href.split('#')[0] });
      }
      if (p === '/api/integration' && method === 'GET') {
        if ((g = guard(true))) return g;
        return ok(null, { enabled: st.gs.en, url: st.gs.url, keySet: !!st.gs.key, deviceId: st.gs.devId, lastOk: false, lastMsg: 'Modo demostración: no se envía nada', lastAt: '', pending: st.seq, staConnected: false });
      }
      if (p === '/api/integration') {
        if ((g = guard(true))) return g;
        if (d.action === 'test') return ok('Modo demostración: la prueba de conexión no se realiza.');
        const gs = { ...st.gs, en: !!d.enabled, url: d.url || '', devId: d.deviceId || 'timbre-demo' };
        if (d.key) gs.key = d.key;
        if (gs.url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(gs.url)) return err(400, 'La URL debe ser la de la aplicación web de Apps Script (https://script.google.com/macros/s/.../exec).');
        if (gs.en && (!gs.url || !gs.key)) return err(400, 'Para activar el respaldo escriba la URL y la clave secreta.');
        st.gs = gs; changed(); audit(st, actor, 'gs.update', 'Respaldo en Google Sheets ' + (gs.en ? 'activado' : 'desactivado')); return ok('Integración guardada.');
      }
      if (p === '/api/audit') {
        if ((g = guard(true))) return g;
        const before = +(q.get('before') || 1e9), limit = Math.max(1, Math.min(100, +(q.get('limit') || 50))), text = (q.get('q') || '').toLowerCase();
        const items = st.audit.filter((e) => e.q < before && (!q.get('user') || e.u === q.get('user')) && (!q.get('type') || e.a.startsWith(q.get('type'))) && (!text || JSON.stringify(e).toLowerCase().includes(text)));
        return ok(null, { more: items.length > limit, items: items.slice(-limit).reverse() });
      }
      if (p === '/api/audit.csv') {
        if ((g = guard(true))) return g;
        audit(st, actor, 'audit.export', 'Descargó el historial en CSV');
        const cell = (v) => { v = String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
        const rows = ['N.,Fecha y hora,Usuario,Rol,Acción,Detalle,IP'].concat(st.audit.map((e) => [e.q, cell(e.t), cell(e.u), cell(e.r), cell(e.a), cell(e.d), cell(e.ip)].join(',')));
        return new Response('﻿' + rows.join('\r\n') + '\r\n', { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
      }
      if (p === '/api/system') {
        if ((g = guard(true))) return g;
        return ok(null, { version: '2.0.0', uptime: Math.floor((Date.now() - st.boot) / 1000), heapFree: 176000, heapMin: 150000, fsTotal: 1966080, fsUsed: 24576, resetReason: 'Encendido', mac: 'DE:MO:00:00:00:01', chip: 'ESP32-C3 (simulado)', cpuMhz: 160, relayPin: 8, schedules: st.schedules.length, users: st.users.length, sessions: Object.keys(st.sessions).length, auditSeq: st.seq, rtcOk: true, ntp: false });
      }
      if (p === '/api/reboot') { if ((g = guard(true))) return g; audit(st, actor, 'system.reboot', 'Reinicio solicitado desde el panel'); return ok('Reiniciando… (simulado)'); }
      // ----- copias de seguridad: mismo formato y cifrado que el firmware -----
      const configDoc = () => ({ format: 'timbre-alba-config', v: 1, net: st.net, gs: st.gs, auto: st.auto,
        users: st.users.map((u) => ({ n: u.name, r: u.role === 'admin' ? 0 : 1, s: u.salt, h: u.hash, i: 1000, m: u.mustChange, a: u.active })),
        schedules: st.schedules.map((s) => ({ id: s.id, n: s.name, h: s.hour, m: s.minute, d: s.days, s: s.duration, e: s.enabled })) });
      const aad = (dev, created) => enc.encode(`timbre-alba-backup-v1|${dev}|${created}`);
      if (p === '/api/backup' && method === 'GET') { if ((g = guard(true))) return g; return ok(null, { lastBackupAt: st.bkAt, pendingChanges: st.cfgRev !== st.bkRev, users: st.users.length, schedules: st.schedules.length }); }
      if (p === '/api/backup') {
        if ((g = guard(true))) return g;
        const pw = d.passphrase || '';
        if (pw.length < 12 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return err(400, 'La frase de la copia debe tener al menos 12 caracteres.');
        const created = iso(now(st)), salt = rnd(16), iv = rnd(12);
        const key = await crypto.subtle.importKey('raw', await pbkdf2(pw, salt, 20000), 'AES-GCM', false, ['encrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(st.gs.devId, created) }, key, enc.encode(JSON.stringify(configDoc()))));
        st.bkRev = st.cfgRev; st.bkAt = created;
        audit(st, actor, 'backup.create', `Descargó una copia de seguridad cifrada (${st.users.length} usuarios, ${st.schedules.length} timbres)`);
        return J(200, { format: 'timbre-alba-backup', v: 1, device: st.gs.devId, createdAt: created, createdBy: sess.user, fw: '2.0.0',
          kdf: { alg: 'pbkdf2-sha256', iter: 20000, salt: hex(salt) }, cipher: { alg: 'aes-256-gcm', iv: hex(iv), tag: hex(ct.slice(-16)) }, data: b64(ct.slice(0, -16)) });
      }
      if (p === '/api/restore') {
        if ((g = guard(true))) return g;
        const b = d.backup || {};
        if (b.format !== 'timbre-alba-backup' || b.v !== 1) return err(400, 'El archivo no es una copia de seguridad de Timbre Alba.');
        let c;
        try {
          const key = await crypto.subtle.importKey('raw', await pbkdf2(d.passphrase || '', unhex(b.kdf.salt), +b.kdf.iter), 'AES-GCM', false, ['decrypt']);
          const data = new Uint8Array([...unb64(b.data), ...unhex(b.cipher.tag)]);
          c = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(b.cipher.iv), additionalData: aad(b.device || '', b.createdAt || '') }, key, data)));
        } catch (e) {
          audit(st, actor, 'backup.fail', 'Restauración rechazada: frase incorrecta o archivo alterado');
          return err(400, 'Frase incorrecta o archivo alterado. No se cambió nada.');
        }
        if (!c.users.some((u) => u.r === 0 && u.a)) return err(400, 'La copia no se puede aplicar: No hay ningún administrador activo.');
        if (d.action === 'preview') {
          return ok(null, { createdAt: b.createdAt, createdBy: b.createdBy, device: b.device, fw: b.fw, users: c.users.map((u) => ({ name: u.n, role: u.r === 0 ? 'admin' : 'usuario', active: u.a })),
            schedules: c.schedules.length, apSsid: c.net.apSsid, apIp: c.net.apIp, staEnabled: c.net.staEn, staSsid: c.net.staSsid, gsEnabled: c.gs.en, auto: c.auto });
        }
        st.users = c.users.map((u) => ({ name: u.n, role: u.r === 0 ? 'admin' : 'usuario', salt: u.s, hash: u.h, mustChange: u.m, active: u.a, fails: 0, lockUntil: 0 }));
        st.schedules = c.schedules.map((s) => ({ id: s.id, name: s.n, hour: s.h, minute: s.m, days: s.d, duration: s.s, enabled: s.e }));
        st.nextId = Math.max(0, ...st.schedules.map((s) => s.id)) + 1; st.net = c.net; st.gs = c.gs; st.auto = c.auto; st.bkRev = st.cfgRev;
        audit(st, actor, 'backup.restore', `Restauró la copia del ${b.createdAt} hecha por ${b.createdBy}`);
        st.sessions = {};
        return ok('Copia restaurada. En el equipo real se reinicia; aquí, ingrese de nuevo.', { restart: true, ssid: st.net.apSsid, url: location.href.split('#')[0] });
      }
      return err(404, 'Ruta no encontrada.');
    }
  }

  // ---------- Interceptar fetch: /api/* nunca sale del navegador ----------
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opt) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, opt);
    opt = opt || {};
    await new Promise((r) => setTimeout(r, 120)); // latencia realista de la placa
    return handle(url, (opt.method || 'GET').toUpperCase(), opt.headers || {}, opt.body);
  };

  // ---------- Aviso visible de demostración ----------
  window.TIMBRE_DEMO = { reset() { try { localStorage.removeItem(KEY); sessionStorage.clear(); } catch (e) { /* */ } MEM = null; location.reload(); } };
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = '<b>MODO DEMOSTRACIÓN</b> · datos simulados en su navegador, no controla ningún timbre · ' +
      'Ingrese como <b>Rector</b> (administrador) o <b>Docente</b> (usuario) con la clave <b>' + DEMO_PASSWORD + '</b> ' +
      '<button type="button" id="demo-reset">Reiniciar demo</button>';
    document.body.prepend(bar);
    document.getElementById('demo-reset').addEventListener('click', () => window.TIMBRE_DEMO.reset());
  });
})();
