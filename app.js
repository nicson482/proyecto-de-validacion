import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, collection, doc, setDoc, getDoc, onSnapshot, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const REGIONES = ["Cobán", "Salamá", "Petén", "Poptún", "Morales"];
const TIPOS = ["El cliente rechazó el pedido", "No se pudo contactar al cliente", "Otra incidencia"];
const ESTADOS = { pendiente: "Pendiente", seguimiento: "En seguimiento", validada: "Aprobada", rechazada: "Rechazada" };
const ABIERTA = ["pendiente", "seguimiento"];
const state = { users: [], incidents: [], loaded: { u: false, i: false }, ready: false, me: null, tab: null, editing: null,
  filt: { estado: "", region: "" }, msg: "", err: "", bootstrapped: true, creating: false };

const needsConfig = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PEGA");
let fbApp, auth, db, unsubs = [], dirty = false;
if (!needsConfig) {
  fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = initializeFirestore(fbApp, { ignoreUndefinedProperties: true });
}

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = t => t ? new Date(t).toLocaleString("es-GT", { dateStyle: "short", timeStyle: "short" }) : "";
const cleanUser = s => String(s || "").trim().toLowerCase();
const validUser = s => /^[a-z0-9._-]{3,30}$/.test(s);
const email = u => u + "@rutas-app.com"; // correo interno; nunca se envía nada a esa dirección
const user = id => state.users.find(u => u.id === id);
const nom = id => user(id)?.nombre || "—";
function authMsg(e) {
  const c = e.code || "";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(c)) return "Usuario o PIN incorrecto";
  if (c === "auth/email-already-in-use") return "Ese usuario ya existe en el sistema (aunque esté desactivado)";
  if (c === "auth/weak-password") return "El PIN debe tener al menos 6 caracteres";
  if (c === "auth/too-many-requests") return "Demasiados intentos, espera un momento";
  if (c === "auth/network-request-failed") return "Sin conexión a internet";
  if (c === "auth/operation-not-allowed") return "Falta activar «Correo electrónico/contraseña» en Firebase Authentication";
  return "Error: " + (c || e.message);
}

/* ---------- avisos (sonido, vibración, notificación) ---------- */
let seen = new Set(), base = false, audio = null;
function unlockAudio() { try { if (!audio) { const C = window.AudioContext || window.webkitAudioContext; if (C) audio = new C(); } if (audio && audio.state === "suspended") audio.resume(); } catch (e) {} }
function beep() { try { if (!audio) return; [0, .18].forEach((d, k) => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = k ? 1040 : 780; g.gain.value = .15; o.connect(g); g.connect(audio.destination); o.start(audio.currentTime + d); o.stop(audio.currentTime + d + .14); }); } catch (e) {} }
async function showNotif(txt) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) reg.showNotification("Rutas e Incidencias", { body: txt, icon: "icon-192.png", vibrate: [200, 100, 200] });
    else new Notification("Rutas e Incidencias", { body: txt });
  } catch (e) {}
}
function pendientesAviso(me) {
  if (!me) return [];
  if (me.rol === "validador") return state.incidents.filter(i => i.asignadoA === me.id && i.vistoValidador === false && ABIERTA.includes(i.estado));
  if (me.rol === "piloto") return state.incidents.filter(i => i.pilotoId === me.id && ["validada", "rechazada"].includes(i.estado) && !i.vistoPiloto);
  return [];
}
function notifyCheck() {
  const me = user(state.me);
  if (!me) { base = false; seen = new Set(); return; }
  if (!(state.loaded.u && state.loaded.i)) return;
  const key = i => i.id + ":" + i.estado + ":" + (i.asignadoA || "");
  const list = pendientesAviso(me), fresh = list.filter(i => !seen.has(key(i)));
  list.forEach(i => seen.add(key(i)));
  if (!base) { base = true; return; }
  if (!fresh.length) return;
  const i = fresh[0];
  const txt = me.rol === "validador" ? "Nueva incidencia asignada: pedido " + i.pedido + " (" + i.region + ")"
    : (i.estado === "validada" ? "Aprobada" : "Rechazada") + ": tu constancia del pedido " + i.pedido;
  beep(); try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
  showNotif(txt);
}

/* ---------- datos ---------- */
async function put(col, obj) {
  try { await setDoc(doc(db, col, obj.id), obj); }
  catch (e) { state.err = "No se pudo guardar: " + (e.code || e.message); render(); }
}
function stopSubs() { unsubs.forEach(f => f()); unsubs = []; state.loaded = { u: false, i: false }; }
function subscribe() {
  stopSubs();
  const onErr = e => { state.err = "No se pudo leer la base de datos (" + (e.code || e.message) + ")"; render(); };
  unsubs.push(onSnapshot(collection(db, "users"), s => {
    state.users = s.docs.map(d => ({ ...d.data(), id: d.id }));
    state.loaded.u = true;
    const m = user(state.me);
    if (m && m.activo === false) { signOut(auth); return; }
    softRender();
  }, onErr));
  unsubs.push(onSnapshot(collection(db, "incidents"), s => {
    state.incidents = s.docs.map(d => ({ ...d.data(), id: d.id }));
    state.loaded.i = true;
    softRender();
  }, onErr));
}
async function loadProfile(fu) {
  try {
    const s = await getDoc(doc(db, "users", fu.uid));
    if (!s.exists() || s.data().activo === false) {
      state.err = s.exists() ? "Tu usuario está desactivado. Habla con el administrador." : "Tu usuario no tiene perfil. Habla con el administrador.";
      await signOut(auth); return;
    }
    state.me = fu.uid; state.err = ""; state.tab = null;
    subscribe();
  } catch (e) {
    state.err = "No se pudo cargar tu perfil: " + (e.code || e.message);
    await signOut(auth); return;
  }
  state.ready = true; render();
}
async function start() {
  if (needsConfig) { state.ready = true; render(); return; }
  try { state.bootstrapped = (await getDoc(doc(db, "config", "bootstrap"))).exists(); } catch (e) { state.bootstrapped = true; }
  onAuthStateChanged(auth, async fu => {
    if (state.creating) return;
    if (!fu) { stopSubs(); state.me = null; state.users = []; state.incidents = []; state.ready = true; render(); return; }
    await loadProfile(fu);
  });
}

/* ---------- asignación automática ---------- */
const abiertas = id => state.incidents.filter(i => i.asignadoA === id && ABIERTA.includes(i.estado)).length;
const validadoresDe = region => state.users.filter(u => u.rol === "validador" && u.activo !== false && (u.regiones || []).includes(region));
function elegirValidador(region) {
  const vs = validadoresDe(region); if (!vs.length) return null;
  vs.sort((a, b) => abiertas(a.id) - abiertas(b.id) || a.nombre.localeCompare(b.nombre));
  return vs[0].id;
}
/* Reasigna incidencias abiertas sin validador o cuyo validador ya no cubre la región (lo ejecuta el administrador) */
async function reconciliar() {
  for (const inc of state.incidents) {
    if (!ABIERTA.includes(inc.estado)) continue;
    const a = user(inc.asignadoA);
    const ok = a && a.rol === "validador" && a.activo !== false && (a.regiones || []).includes(inc.region);
    if (ok) continue;
    const nuevo = elegirValidador(inc.region);
    if (nuevo !== (inc.asignadoA || null)) {
      await put("incidents", { ...inc, asignadoA: nuevo, estado: (inc.estado === "seguimiento" && !nuevo) ? "pendiente" : inc.estado, vistoValidador: false });
    }
  }
}

/* ---------- vistas ---------- */
function softRender() {
  notifyCheck();
  const a = document.activeElement;
  if (a && $("#app").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { dirty = true; return; }
  render();
}
document.addEventListener("focusout", () => setTimeout(() => {
  if (dirty && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) { dirty = false; render(); }
}, 50));

function render() {
  dirty = false; const app = $("#app");
  if (needsConfig) { app.innerHTML = configView(); return; }
  if (!state.ready) { app.textContent = "Cargando…"; return; }
  if (state.me && !(state.loaded.u && state.loaded.i)) { app.textContent = "Cargando…"; return; }
  notifyCheck();
  const me = user(state.me);
  if (!me) { app.innerHTML = loginView(); return; }
  const tabs = me.rol === "admin" ? [["usuarios", "Usuarios"], ["incidencias", "Incidencias"]]
    : me.rol === "validador" ? [["cola", "Mis incidencias"]] : [["nueva", "Reportar"], ["mias", "Mis reportes"]];
  if (!state.tab || !tabs.find(t => t[0] === state.tab)) state.tab = tabs[0][0];
  let body = "";
  if (me.rol === "admin") body = state.tab === "usuarios" ? adminUsers() : adminIncs();
  else if (me.rol === "validador") body = validatorView(me);
  else body = state.tab === "nueva" ? pilotForm(me) : pilotList(me);
  const nv = me.rol === "validador" ? pendientesAviso(me) : [];
  const notifs = me.rol === "piloto" ? pendientesAviso(me) : [];
  const nAv = nv.length + notifs.length;
  document.title = (nAv ? "(" + nAv + ") " : "") + "Rutas e Incidencias";
  const canNotif = me.rol !== "admin" && ("Notification" in window) && Notification.permission === "default";
  app.innerHTML = `
  <header class="top"><div><h1>Rutas e Incidencias</h1><div class="small mut">${esc(me.nombre)} · ${esc(me.rol)}${me.rol !== "admin" ? " · " + (me.regiones || []).map(esc).join(", ") : ""}</div></div>
  <div style="display:flex;gap:8px;flex:0 0 auto;flex-wrap:wrap">${canNotif ? '<button data-act="enablenotif">🔔 Activar avisos</button>' : ""}<button data-act="changepin">Cambiar PIN</button><button data-act="logout">Salir</button></div></header>
  ${state.err ? `<div class="notice bad"><span>${esc(state.err)}</span><button class="sm" data-act="clearerr">OK</button></div>` : ""}
  ${state.msg ? `<div class="notice"><span>${esc(state.msg)}</span><button class="sm" data-act="clearmsg">OK</button></div>` : ""}
  ${nv.map(i => `<div class="notice"><span>🔔 Nueva incidencia asignada: pedido <b>${esc(i.pedido)}</b> (${esc(i.region)}) · Piloto: ${esc(nom(i.pilotoId))}</span><button class="sm" data-act="vistoval" data-id="${i.id}">Entendido</button></div>`).join("")}
  ${notifs.map(i => `<div class="notice ${i.estado === "rechazada" ? "bad" : ""}"><span>${i.estado === "validada" ? "✓ Se aprobó tu constancia del pedido" : "✗ Se rechazó tu constancia del pedido"} <b>${esc(i.pedido)}</b>${i.comentario ? " — " + esc(i.comentario) : ""}</span><button class="sm" data-act="visto" data-id="${i.id}">Entendido</button></div>`).join("")}
  <nav class="tabs">${tabs.map(t => `<button data-act="tab" data-t="${t[0]}" class="${state.tab === t[0] ? "on" : ""}">${t[1]}${(t[0] === "cola" && nv.length) || (t[0] === "mias" && notifs.length) ? `<span class="dot">${t[0] === "cola" ? nv.length : notifs.length}</span>` : ""}</button>`).join("")}</nav>
  ${body}`;
}

function configView() {
  return `<div class="card" style="max-width:560px;margin:30px auto"><h2>Falta conectar Firebase</h2>
  <p>Abre el archivo <b>firebase-config.js</b>, pega los datos de tu proyecto de Firebase y vuelve a subirlo a GitHub. Los pasos están en el <b>README.md</b>.</p></div>`;
}
function loginView() {
  const primera = !state.bootstrapped;
  return `<div class="card" style="max-width:380px;margin:40px auto"><h2>${primera ? "Crear administrador" : "Iniciar sesión"}</h2>
  ${primera ? `<p class="small mut">Aún no hay usuarios. Crea la cuenta del administrador para empezar.</p><label>Nombre</label><input id="l_nom">` : ""}
  <label>Usuario</label><input id="l_u" autocapitalize="off" autocomplete="username">
  <label>PIN / contraseña${primera ? " (mínimo 6 caracteres)" : ""}</label><input id="l_p" type="password" autocomplete="current-password">
  <div class="err">${esc(state.err)}</div>
  <div style="margin-top:12px"><button class="pri" data-act="${primera ? "setup" : "login"}">${primera ? "Crear y entrar" : "Entrar"}</button></div></div>`;
}
const regionChecks = sel => `<div class="checks">${REGIONES.map(r => `<label><input type="checkbox" name="reg" value="${r}" ${sel.includes(r) ? "checked" : ""}>${r}</label>`).join("")}</div>`;

function adminUsers() {
  const e = state.editing, u = e === "new" ? { rol: "piloto", regiones: [], activo: true } : (user(e) || { rol: "piloto", regiones: [], activo: true });
  const nuevo = e === "new";
  const form = e ? `<div class="card"><h2>${nuevo ? "Nuevo usuario" : "Editar usuario"}</h2>
   <div class="row"><div><label>Nombre</label><input id="f_nom" value="${esc(u.nombre || "")}"></div>
   <div><label>Usuario${nuevo ? "" : " (no se puede cambiar)"}</label><input id="f_usr" value="${esc(u.usuario || "")}" autocapitalize="off" ${nuevo ? "" : "disabled"}></div>
   ${nuevo ? `<div><label>PIN inicial (mínimo 6 caracteres)</label><input id="f_pin" type="password"></div>` : ""}
   <div><label>Rol</label><select id="f_rol"><option value="piloto" ${u.rol === "piloto" ? "selected" : ""}>Piloto</option><option value="validador" ${u.rol === "validador" ? "selected" : ""}>Validador</option><option value="admin" ${u.rol === "admin" ? "selected" : ""}>Administrador</option></select></div></div>
   <label>Regiones a cargo</label>${regionChecks(u.regiones || [])}
   <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="f_act" style="width:auto" ${u.activo !== false ? "checked" : ""}> Usuario activo</label>
   <div class="err">${esc(state.err)}</div>
   <div style="margin-top:12px;display:flex;gap:8px"><button class="pri" data-act="saveuser">Guardar</button><button data-act="canceledit">Cancelar</button></div>
   ${nuevo ? "" : `<p class="banner">Cada persona cambia su propio PIN con el botón «Cambiar PIN».</p>`}</div>` : "";
  const rows = state.users.slice().sort((a, b) => a.rol.localeCompare(b.rol) || a.nombre.localeCompare(b.nombre)).map(x => `<tr>
   <td><b>${esc(x.nombre)}</b><div class="small mut">@${esc(x.usuario)}${x.activo === false ? " · inactivo" : ""}</div></td>
   <td>${esc(x.rol)}</td><td>${x.rol === "admin" ? '<span class="mut">todas</span>' : (x.regiones || []).map(r => `<span class="chip">${esc(r)}</span>`).join("") || '<span class="mut">sin región</span>'}</td>
   <td style="white-space:nowrap"><button class="sm" data-act="edituser" data-id="${x.id}">Editar</button> <button class="sm ${x.activo === false ? "" : "bad"}" data-act="toggleuser" data-id="${x.id}">${x.activo === false ? "Activar" : "Desactivar"}</button></td></tr>`).join("");
  return `${form}<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2 style="margin:0">Usuarios</h2><button class="pri" data-act="newuser">+ Agregar</button></div>
  <div class="tblw"><table><thead><tr><th>Usuario</th><th>Rol</th><th>Regiones</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="banner">Al cambiar las regiones de un validador (o desactivarlo), sus incidencias abiertas se reasignan solas al validador que cubra esa región.</p></div>`;
}
function filtros() {
  return `<div class="row" style="margin-bottom:8px"><div><label>Estado</label><select data-act="filt" data-k="estado"><option value="">Todos</option>${Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}" ${state.filt.estado === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
  <div><label>Región</label><select data-act="filt" data-k="region"><option value="">Todas</option>${REGIONES.map(r => `<option ${state.filt.region === r ? "selected" : ""}>${r}</option>`).join("")}</select></div></div>`;
}
const pasaFiltro = i => (!state.filt.estado || i.estado === state.filt.estado) && (!state.filt.region || i.region === state.filt.region);
function incBody(i, showPiloto = true) {
  return `<div><b>Pedido ${esc(i.pedido)}</b> <span class="badge b-${i.estado}">${ESTADOS[i.estado]}</span> <span class="chip">${esc(i.region)}</span></div>
  <div class="small mut">${esc(i.tipo)} · ${fmt(i.creado)}${showPiloto ? " · Piloto: " + esc(nom(i.pilotoId)) : ""}</div>
  <div class="small">Ref. en la otra plataforma: <b>${esc(i.referencia)}</b></div>
  ${i.nota ? `<div class="small">${esc(i.nota)}</div>` : ""}
  ${i.imagen ? `<div><img src="${i.imagen}" data-act="zoom" alt="Constancia"></div>` : ""}
  ${i.comentario ? `<div class="small mut">Comentario del validador: ${esc(i.comentario)}</div>` : ""}`;
}
function adminIncs() {
  const list = state.incidents.filter(pasaFiltro).sort((a, b) => b.creado - a.creado);
  const sin = state.incidents.filter(i => !i.asignadoA && ABIERTA.includes(i.estado)).length;
  return `<div class="card"><h2>Incidencias (${list.length})</h2>${sin ? `<div class="notice bad">${sin} sin validador asignado: falta un validador activo en esa región.</div>` : ""}${filtros()}
  ${list.map(i => `<div class="inc">${incBody(i)}
   <div style="margin-top:6px" class="small">Asignada a: <select data-act="reasignar" data-id="${i.id}" style="width:auto;display:inline-block"><option value="">Sin asignar</option>${state.users.filter(u => u.rol === "validador" && u.activo !== false).map(u => `<option value="${u.id}" ${i.asignadoA === u.id ? "selected" : ""}>${esc(u.nombre)}${(u.regiones || []).includes(i.region) ? "" : " (otra región)"}</option>`).join("")}</select></div></div>`).join("") || '<p class="mut">No hay incidencias.</p>'}</div>`;
}
function pilotForm(me) {
  const regs = me.regiones || [];
  if (!regs.length) return `<div class="card"><p>No tienes una región asignada. Pide al administrador que te asigne una.</p></div>`;
  return `<div class="card"><h2>Reportar incidencia subida a la otra plataforma</h2>
  <div class="row"><div><label>Código de pedido</label><input id="p_ped"></div>
  <div><label>Región</label><select id="p_reg">${regs.map(r => `<option>${r}</option>`).join("")}</select></div></div>
  <div class="row"><div><label>No. / enlace de la incidencia en la otra plataforma</label><input id="p_ref"></div>
  <div><label>Tipo de incidencia</label><select id="p_tipo">${TIPOS.map(t => `<option>${t}</option>`).join("")}</select></div></div>
  <label>Nota (opcional)</label><textarea id="p_nota"></textarea>
  <label>Imagen de constancia (opcional)</label><input type="file" id="p_img" accept="image/*">
  <div class="err">${esc(state.err)}</div>
  <div style="margin-top:12px"><button class="pri" data-act="sendinc">Enviar reporte</button></div>
  <p class="banner">El reporte se asigna automáticamente a un validador de la región seleccionada.</p></div>`;
}
function pilotList(me) {
  const list = state.incidents.filter(i => i.pilotoId === me.id).sort((a, b) => b.creado - a.creado);
  return `<div class="card"><h2>Mis reportes (${list.length})</h2>${list.map(i => `<div class="inc">${incBody(i, false)}<div class="small mut">Validador: ${esc(nom(i.asignadoA))}</div></div>`).join("") || '<p class="mut">Aún no has reportado incidencias.</p>'}</div>`;
}
function validatorView(me) {
  const mias = state.incidents.filter(i => i.asignadoA === me.id).filter(pasaFiltro).sort((a, b) => b.creado - a.creado);
  const libres = state.incidents.filter(i => !i.asignadoA && ABIERTA.includes(i.estado) && (me.regiones || []).includes(i.region));
  return `${libres.length ? `<div class="card"><h2>Sin asignar en tus regiones (${libres.length})</h2>${libres.map(i => `<div class="inc">${incBody(i)}<button class="sm" data-act="tomar" data-id="${i.id}" style="margin-top:6px">Tomar</button></div>`).join("")}</div>` : ""}
  <div class="card"><h2>Asignadas a mí (${mias.length})</h2>${filtros()}
  ${mias.map(i => {
    const abierta = ABIERTA.includes(i.estado);
    return `<div class="inc">${incBody(i)}
   ${abierta ? `<div style="margin-top:8px"><input id="c_${i.id}" placeholder="Comentario (opcional)"><div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
    ${i.estado === "pendiente" ? `<button class="sm" data-act="estado" data-e="seguimiento" data-id="${i.id}">Iniciar seguimiento</button>` : ""}
    <button class="sm pri" data-act="estado" data-e="validada" data-id="${i.id}">Aprobar</button>
    <button class="sm bad" data-act="estado" data-e="rechazada" data-id="${i.id}">Rechazar</button></div></div>` : ""}</div>`;
  }).join("") || '<p class="mut">No tienes incidencias.</p>'}</div>`;
}

/* ---------- acciones ---------- */
function resizeImg(file) {
  return new Promise((res, rej) => {
    const r = new FileReader(); r.onerror = rej;
    r.onload = () => {
      const im = new Image(); im.onerror = rej;
      im.onload = () => {
        const m = 900, k = Math.min(1, m / Math.max(im.width, im.height));
        const c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", .7));
      };
      im.src = r.result;
    };
    r.readAsDataURL(file);
  });
}
/* Crea la cuenta de acceso con una segunda instancia para no cerrar la sesión del administrador */
async function crearAuth(usuario, pin) {
  const sec = initializeApp(firebaseConfig, "sec" + Date.now());
  try {
    const a = getAuth(sec);
    const c = await createUserWithEmailAndPassword(a, email(usuario), pin);
    const uid = c.user.uid; await signOut(a); return uid;
  } finally { await deleteApp(sec); }
}

document.addEventListener("click", async ev => {
  unlockAudio();
  const el = ev.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id;
  if (["filt", "reasignar"].includes(a)) return;
  state.err = "";
  if (a === "zoom") { $("#viewer img").src = el.src; $("#viewer").style.display = "flex"; return; }
  if (a === "login") {
    const u = cleanUser($("#l_u").value), p = $("#l_p").value;
    if (!u || !p) { state.err = "Escribe usuario y PIN"; render(); return; }
    el.disabled = true;
    try { await signInWithEmailAndPassword(auth, email(u), p); } catch (e) { state.err = authMsg(e); render(); }
    return;
  }
  if (a === "setup") {
    const n = $("#l_nom").value.trim(), u = cleanUser($("#l_u").value), p = $("#l_p").value;
    if (!n || !validUser(u)) { state.err = "Escribe tu nombre y un usuario de 3 a 30 caracteres (letras, números, punto, guion)"; render(); return; }
    if (p.length < 6) { state.err = "El PIN debe tener al menos 6 caracteres"; render(); return; }
    el.disabled = true; state.creating = true;
    try {
      const c = await createUserWithEmailAndPassword(auth, email(u), p);
      const b = writeBatch(db);
      b.set(doc(db, "users", c.user.uid), { nombre: n, usuario: u, rol: "admin", regiones: [], activo: true });
      b.set(doc(db, "config", "bootstrap"), { creado: Date.now(), por: c.user.uid });
      await b.commit();
      state.bootstrapped = true; state.creating = false;
      await loadProfile(c.user);
    } catch (e) {
      state.creating = false; state.err = authMsg(e);
      try { await signOut(auth); } catch (x) {}
      render();
    }
    return;
  }
  if (a === "logout") { await signOut(auth); return; }
  if (a === "changepin") {
    const n = prompt("Nuevo PIN (mínimo 6 caracteres)"); if (!n) return;
    if (n.length < 6) { state.err = "El PIN debe tener al menos 6 caracteres"; render(); return; }
    try { await updatePassword(auth.currentUser, n); state.msg = "PIN actualizado"; }
    catch (e) { state.err = e.code === "auth/requires-recent-login" ? "Por seguridad, cierra sesión, vuelve a entrar y repite el cambio" : authMsg(e); }
    render(); return;
  }
  if (a === "tab") { state.tab = el.dataset.t; state.editing = null; render(); return; }
  if (a === "clearerr") { render(); return; }
  if (a === "clearmsg") { state.msg = ""; render(); return; }
  if (a === "enablenotif") {
    try { const r = await Notification.requestPermission(); state.msg = r === "granted" ? "Avisos activados mientras la app esté abierta." : "El navegador no permitió avisos del sistema; igual verás alertas y sonido dentro de la app."; }
    catch (e) { state.msg = "Este navegador no permite avisos del sistema; verás alertas y sonido dentro de la app."; }
    render(); return;
  }
  if (a === "newuser") { state.editing = "new"; render(); return; }
  if (a === "edituser") { state.editing = id; render(); return; }
  if (a === "canceledit") { state.editing = null; render(); return; }
  if (a === "toggleuser") {
    const u = user(id); if (!u) return;
    if (u.id === state.me) { state.err = "No puedes desactivar tu propio usuario"; render(); return; }
    await put("users", { ...u, activo: u.activo === false });
    Object.assign(u, { activo: u.activo === false });
    await reconciliar(); render(); return;
  }
  if (a === "saveuser") {
    const nuevo = state.editing === "new", prev = nuevo ? null : user(state.editing);
    const nombre = $("#f_nom").value.trim(), rol = $("#f_rol").value, activo = $("#f_act").checked;
    const usr = nuevo ? cleanUser($("#f_usr").value) : prev.usuario;
    const pin = nuevo ? $("#f_pin").value : "";
    const regiones = [...document.querySelectorAll('input[name="reg"]:checked')].map(x => x.value);
    if (!nombre) { state.err = "El nombre es obligatorio"; render(); return; }
    if (nuevo && !validUser(usr)) { state.err = "Usuario de 3 a 30 caracteres: letras, números, punto o guion (sin espacios)"; render(); return; }
    if (nuevo && state.users.some(x => x.usuario === usr)) { state.err = "Ese usuario ya existe"; render(); return; }
    if (nuevo && pin.length < 6) { state.err = "El PIN debe tener al menos 6 caracteres"; render(); return; }
    if (rol !== "admin" && !regiones.length) { state.err = "Asigna al menos una región"; render(); return; }
    if (prev && prev.id === state.me && (rol !== "admin" || !activo)) { state.err = "No puedes quitarte el rol de administrador ni desactivarte"; render(); return; }
    el.disabled = true;
    let uidNuevo = prev?.id;
    if (nuevo) { try { uidNuevo = await crearAuth(usr, pin); } catch (e) { state.err = authMsg(e); render(); return; } }
    const o = { nombre, usuario: usr, rol, regiones: rol === "admin" ? [] : regiones, activo, id: uidNuevo };
    await put("users", o);
    const k = state.users.findIndex(x => x.id === o.id); k >= 0 ? state.users[k] = o : state.users.push(o);
    await reconciliar();
    state.editing = null; state.msg = "Usuario guardado"; render(); return;
  }
  if (a === "sendinc") {
    const me = user(state.me), ped = $("#p_ped").value.trim(), ref = $("#p_ref").value.trim();
    if (!ped || !ref) { state.err = "Código de pedido y referencia de la otra plataforma son obligatorios"; render(); return; }
    let img = null; const f = $("#p_img").files[0];
    el.disabled = true;
    if (f) { try { img = await resizeImg(f); } catch (e) { state.err = "No se pudo leer la imagen"; render(); return; } }
    const region = $("#p_reg").value;
    const nid = doc(collection(db, "incidents")).id;
    await put("incidents", { id: nid, pedido: ped, referencia: ref, region, tipo: $("#p_tipo").value, nota: $("#p_nota").value.trim(), imagen: img,
      pilotoId: me.id, asignadoA: elegirValidador(region), estado: "pendiente", comentario: "", vistoPiloto: false, vistoValidador: false, creado: Date.now() });
    if (!state.err) { state.msg = "Reporte enviado y asignado automáticamente"; state.tab = "mias"; }
    render(); return;
  }
  if (a === "visto") { const i = state.incidents.find(x => x.id === id); if (i) await put("incidents", { ...i, vistoPiloto: true }); return; }
  if (a === "vistoval") { const i = state.incidents.find(x => x.id === id); if (i) await put("incidents", { ...i, vistoValidador: true }); return; }
  if (a === "tomar") { const i = state.incidents.find(x => x.id === id); if (i) await put("incidents", { ...i, asignadoA: state.me, vistoValidador: true }); return; }
  if (a === "estado") {
    const i = state.incidents.find(x => x.id === id); if (!i) return;
    const c = document.getElementById("c_" + id)?.value.trim() || "";
    const cierre = ["validada", "rechazada"].includes(el.dataset.e);
    await put("incidents", { ...i, estado: el.dataset.e, vistoValidador: true, comentario: c || i.comentario || "", vistoPiloto: cierre ? false : !!i.vistoPiloto, resuelto: cierre ? Date.now() : null });
    return;
  }
});
document.addEventListener("change", async ev => {
  const el = ev.target.closest("[data-act]"); if (!el) return;
  if (el.dataset.act === "filt") { state.filt[el.dataset.k] = el.value; render(); }
  if (el.dataset.act === "reasignar") {
    const i = state.incidents.find(x => x.id === el.dataset.id);
    if (i) await put("incidents", { ...i, asignadoA: el.value || null, vistoValidador: false });
  }
});
$("#viewer").addEventListener("click", () => { $("#viewer").style.display = "none"; });

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
start();
