const $ = (sel) => document.querySelector(sel);
const esc = (t) =>
  String(t ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const toMin = (hhmm) => hhmm.split(":").reduce((h, m) => Number(h) * 60 + Number(m));
const fmt = (min) => {
  const h = Math.floor(min / 60) % 24;
  return `${h % 12 || 12}:${String(Math.round(min) % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const short = (min) => fmt(min).replace(/ [AP]M$/, "");
const span = (p) => (p.until > p.time ? `${short(p.time)}–${short(p.until)}` : short(p.time));
const firstName = (s) => s.name.split(" ")[0];

const QUICK = ["Where were you tonight?", "When did you leave?", "Which way did you walk?", "Who can back that up?"];
const MOODS = [
  [30, "😌", "Calm", "#2f9e6e"],
  [50, "😐", "Uneasy", "#9bb83a"],
  [70, "😟", "Nervous", "#e9a23b"],
  [101, "😰", "Sweating", "#ef6a4c"],
];
const mood = (v) => MOODS.find(([max]) => v < max);

let state;
function resetState(data) {
  state = {
    case: data.case,
    sessionId: data.sessionId,
    active: data.case.suspects[0].id,
    chats: Object.fromEntries(data.case.suspects.map((s) => [s.id, []])),
    stress: Object.fromEntries(data.case.suspects.map((s) => [s.id, 15])),
    claims: [],
    contradictions: [],
    suspicions: [],
    evidence: null,
    highlight: null,
    pick: [],
    busy: false,
    shake: null,
  };
}
const suspect = (id) => state.case.suspects.find((s) => s.id === id);
const place = (id) => state.case.map.places.find((p) => p.id === id);
const nodeXY = (id) => place(id) ?? state.case.map.corners.find((c) => c.id === id);

function avatar(s, withMood = false) {
  const m = mood(state.stress[s.id]);
  return `<span class="avatar" style="--sc:${esc(s.color)}">${esc(s.avatar ?? "🙂")}${withMood ? `<span class="mood" title="${m[2]}">${m[1]}</span>` : ""}</span>`;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// ------------------------------------------------------------ start screen

async function boot() {
  try {
    const health = await api("GET", "/api/health");
    const tier = (t) => `<b>${esc(t.model)}</b> (${esc(t.provider)})`;
    $("#model-badge").innerHTML = `Suspects played by ${tier(health.big)} · notes by ${tier(health.fast)}${health.big.provider === "mock" ? " · mock mode, no AI" : ""}`;
    $("#model-badge-game").innerHTML = `🤖 ${esc(health.big.model)}`;
  } catch {
    $("#model-badge").textContent = "Can't reach the game server.";
  }
  try {
    const { cases } = await api("GET", "/api/cases");
    $("#case-list").innerHTML = cases.length
      ? cases
          .map(
            (c) => `<button class="case-card" data-case="${esc(c.id)}">
              <span class="cover" aria-hidden="true">${esc(c.icon)}</span>
              <span><span class="tag">${esc(c.category)}</span>
                <h3>${esc(c.title)}</h3><p>${esc(c.tagline)}</p><span class="area">📍 ${esc(c.area)}</span></span>
            </button>`,
          )
          .join("")
      : `<p class="muted">No cases found in the cases/ folder.</p>`;
  } catch (err) {
    $("#case-list").innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$("#case-list").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-case]");
  if (!card) return;
  card.disabled = true;
  try {
    resetState(await api("POST", "/api/new", { caseId: card.dataset.case }));
    $("#start").hidden = true;
    $("#game").hidden = false;
    renderAll();
    openBriefing();
  } catch (err) {
    alert(err.message);
  } finally {
    card.disabled = false;
  }
});

function showStart() {
  $("#game").hidden = true;
  $("#start").hidden = false;
}

// ------------------------------------------------------------ rendering

function renderAll() {
  const c = state.case;
  $("#case-icon").textContent = c.icon ?? "🕵️";
  $("#case-title").textContent = c.title;
  $("#case-sub").textContent = `📍 ${c.area} · You're the ${c.labels.role.toLowerCase()}`;
  $("#btn-accuse").textContent = `👉 ${c.labels.accuse}`;
  $("#legend-crime").textContent = c.crime.label;
  $("#map-title").textContent = `🗺️ ${c.map.name}`;
  $("#map-attribution").textContent = c.map.attribution;
  $("#quick").innerHTML = QUICK.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  renderSuspects();
  renderChat();
  renderMap();
  renderAlerts();
  renderTimeline();
  renderEvidence();
}

function renderSuspects() {
  $("#suspects").innerHTML = state.case.suspects
    .map((s) => {
      const v = state.stress[s.id];
      const m = mood(v);
      const caught = state.contradictions.filter((x) => x.suspect === s.id).length;
      return `<button class="suspect${state.shake === s.id ? " shake" : ""}" data-suspect="${s.id}" aria-pressed="${s.id === state.active}" style="--sc:${esc(s.color)}">
        ${avatar(s, true)}
        <span><span class="name">${esc(s.name)}</span><br><span class="mood-label">${m[2]}</span></span>
        <span class="meter"><span style="width:${v}%;background:${m[3]}"></span></span>
        ${caught ? `<span class="caught">🚨 ${caught} lie${caught > 1 ? "s" : ""} caught</span>` : ""}
      </button>`;
    })
    .join("");
  state.shake = null;
}

function renderChat() {
  const s = suspect(state.active);
  const msgs = state.chats[s.id];
  const chat = $("#chat");
  const intro = `<div class="note intro">${avatar(s)}<br><b>${esc(s.name)}</b> sits down across the table.<br>${esc(s.bio)}</div>`;
  chat.innerHTML =
    intro +
    msgs
      .map((m) => {
        if (m.kind === "me") {
          return `<div class="msg me">${m.shown ? `<span class="shown">📎 showing ${esc(m.shown)}</span>` : ""}<div class="bubble">${esc(m.text)}</div></div>`;
        }
        if (m.kind === "typing") {
          return `<div class="msg them" style="--sc:${esc(s.color)}">${avatar(s)}<div class="bubble typing"><i></i><i></i><i></i></div></div>`;
        }
        if (m.kind === "them") {
          const chips = m.claims.map((x) => `<span class="chip">📍 ${esc(x.placeName)} · ${esc(x.timeText)}</span>`).join("");
          return `<div class="msg them" style="--sc:${esc(s.color)}">${avatar(s)}<div>
            <div class="who">${esc(firstName(s))}</div>
            <div class="bubble line">${m.animate ? "" : esc(m.text)}</div>
            ${m.tell ? `<div class="tell">👀 ${esc(m.tell)}</div>` : ""}
            ${chips ? `<div class="chips">${chips}</div>` : ""}</div></div>`;
        }
        return `<div class="note ${m.kind}">${m.title ? `<b>${esc(m.title)}</b>` : ""}${esc(m.text)}</div>`;
      })
      .join("");
  const pending = msgs.find((m) => m.animate);
  if (pending) {
    pending.animate = false;
    const lines = chat.querySelectorAll(".line");
    typewrite(lines[lines.length - 1], pending.text);
  }
  chat.scrollTop = chat.scrollHeight;
}

function typewrite(el, text) {
  if (!el) return;
  // Time-based, so it catches up even if the browser throttles timers.
  const started = performance.now();
  const step = () => {
    const i = Math.min(text.length, Math.ceil((performance.now() - started) / 14));
    el.textContent = text.slice(0, i);
    $("#chat").scrollTop = $("#chat").scrollHeight;
    if (i < text.length) el._timer = setTimeout(step, 16);
  };
  el.addEventListener("click", () => {
    clearTimeout(el._timer);
    el.textContent = text;
  });
  step();
}

const SVG = (tag, attrs, inner = "") =>
  `<${tag} ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(" ")}>${inner}</${tag}>`;

function renderMap() {
  const { map, crime } = state.case;
  const u = map.width / 600; // one "screen pixel" when the map is ~600px wide
  const svg = $("#map");
  svg.setAttribute("viewBox", `0 0 ${map.width} ${map.height}`);
  let out = "";

  // Real map tiles (OpenStreetMap), served offline from maps/tiles.
  const { zoom, left, top } = map.tiles;
  out += `<g class="tiles">`;
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + map.width) / 256); tx++) {
    for (let ty = Math.floor(top / 256); ty <= Math.floor((top + map.height) / 256); ty++) {
      out += SVG("image", { href: `/tiles/${zoom}/${tx}/${ty}.png`, x: tx * 256 - left, y: ty * 256 - top, width: 256.6, height: 256.6, preserveAspectRatio: "none" });
    }
  }
  out += `</g>`;
  out += SVG("rect", { width: map.width, height: map.height, fill: "#fffaf2", opacity: 0.18 });

  if (state.highlight?.path?.length > 1) {
    const pts = state.highlight.path.map((id) => nodeXY(id)).filter(Boolean).map((n) => `${n.x},${n.y}`).join(" ");
    out += SVG("polyline", { class: "route-glow", points: pts, fill: "none", stroke: "#fff", "stroke-width": 11 * u, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.85 });
    out += SVG("polyline", { class: `route ${state.highlight.kind}`, points: pts, "stroke-width": 6 * u, "stroke-dasharray": `${16 * u} ${10 * u}` });
  }

  // Pins: what people said (filled pills) and what evidence shows (white pills).
  const pins = new Map();
  const add = (pt) => pins.set(pt.place, [...(pins.get(pt.place) ?? []), pt]);
  for (const e of state.case.evidence) {
    for (const f of e.facts ?? []) {
      const time = toMin(f.time);
      add({ ...f, time, until: time, source: "fact", evidence: e.title });
    }
  }
  for (const c of state.claims) add(c);
  let pinsOut = "";
  for (const [pid, list] of pins) {
    const p = place(pid);
    const toLeft = p.x > map.width - 140 * u;
    list.sort((a, b) => a.time - b.time);
    list.forEach((pt, i) => {
      const s = pt.suspect ? suspect(pt.suspect) : null;
      const label = span(pt);
      const w = (label.length * 6.3 + 14) * u;
      const h = 17 * u;
      const x = toLeft ? p.x - 20 * u - w : p.x + 20 * u;
      const y = p.y - h / 2 - (list.length - 1 - i) * (h + 3 * u); // stack upward, clear of the label below
      const dim = s && s.id !== state.active ? 0.35 : 1;
      const fact = pt.source === "fact";
      const who = s ? s.name : "Unknown person";
      const what = fact ? `${pt.evidence}: ${pt.label}` : `said: ${pt.label}`;
      pinsOut += `<g class="pin${fact ? " fact" : ""}" opacity="${dim}">
        ${SVG("rect", { x, y, width: w, height: h, rx: fact ? 4 * u : h / 2, fill: fact ? "#fff" : s?.color ?? "#999", stroke: fact ? s?.color ?? "#5d564c" : "#fff", "stroke-width": 1.5 * u }, `<title>${esc(who)} · ${esc(label)} · ${esc(what)}</title>`)}
        ${SVG("text", { x: x + w / 2, y: y + h / 2 + 4 * u, "text-anchor": "middle", "font-size": 11 * u }, esc(label))}
      </g>`;
    });
  }

  for (const p of map.places) {
    const isCrime = p.id === crime.place;
    const picked = state.pick.includes(p.id);
    const r = 15 * u;
    const name = p.name;
    const lw = (name.length * 6.8 + 16) * u;
    const ly = p.y + r + 5 * u;
    out += `<g class="place${picked ? " picked" : ""}" data-place="${p.id}">
      ${isCrime ? SVG("circle", { class: "pulse", cx: p.x, cy: p.y, r, "stroke-width": 3 * u }) : ""}
      ${SVG("circle", { class: "ring", cx: p.x, cy: p.y, r, stroke: isCrime ? "#ef6a4c" : "#5d564c", "stroke-width": 3 * u }, `<title>${esc(name)} · ${esc(p.cornerName)}</title>`)}
      ${SVG("text", { x: p.x, y: p.y + 6 * u, "text-anchor": "middle", "font-size": 16 * u }, esc(p.icon ?? "📍"))}
      ${SVG("rect", { class: "label-bg", x: p.x - lw / 2, y: ly, width: lw, height: 18 * u, rx: 9 * u })}
      ${SVG("text", { x: p.x, y: ly + 13 * u, "text-anchor": "middle", "font-size": 11.5 * u }, esc(name))}
    </g>`;
  }
  svg.innerHTML = out + pinsOut;
}

function renderAlerts() {
  const items = [
    ...state.contradictions.map((x) => ({ ...x, kind: "contradiction" })),
    ...state.suspicions.map((x) => ({ ...x, kind: "suspicion" })),
  ].reverse();
  $("#alerts").innerHTML = items.length
    ? items
        .map(
          (x) => `<button class="alert-card ${x.kind}${state.highlight?.id === x.id ? " active" : ""}" data-alert="${x.id}">
            <span class="kind">${x.kind === "contradiction" ? "🚨 That doesn't add up" : "🤔 Suspicious route"}</span>${esc(x.text)}</button>`,
        )
        .join("")
    : `<p class="muted">Nothing yet. Ask about times and places, and the map will check every answer.</p>`;
}

function renderTimeline() {
  const s = suspect(state.active);
  $("#timeline-who").textContent = firstName(s);
  const points = [
    ...state.case.evidence.flatMap((e) =>
      (e.facts ?? [])
        .filter((f) => f.suspect === s.id)
        .map((f) => ({ ...f, time: toMin(f.time), until: toMin(f.time), source: "fact", evidence: e.title })),
    ),
    ...state.claims.filter((c) => c.suspect === s.id),
  ].sort((a, b) => a.time - b.time);
  $("#timeline").innerHTML = points.length
    ? points
        .map(
          (p) => `<li class="${p.source}" style="--sc:${esc(s.color)}"><span class="t">${esc(span(p))}</span>${esc(place(p.place).name)}
            <span class="src">${p.source === "fact" ? `🗂️ ${esc(p.evidence)}` : `💬 “${esc(p.label)}”`}</span></li>`,
        )
        .join("")
    : `<li class="muted">Nothing yet.</li>`;
}

function renderEvidence() {
  const s = suspect(state.active);
  $("#evidence").innerHTML = state.case.evidence
    .map(
      (e) => `<div class="ev"><span class="ev-icon" aria-hidden="true">${esc(e.icon ?? "🗂️")}</span><div>
        <h3>${esc(e.title)}</h3><p>${esc(e.detail)}</p>
        <button type="button" data-evidence="${e.id}">Show ${esc(firstName(s))}</button></div></div>`,
    )
    .join("");
  const ev = state.case.evidence.find((e) => e.id === state.evidence);
  $("#evidence-chip").hidden = !ev;
  if (ev) $("#evidence-chip-title").textContent = `${ev.icon ?? ""} ${ev.title}`;
}

// ------------------------------------------------------------ interactions

$("#suspects").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-suspect]");
  if (!btn) return;
  state.active = btn.dataset.suspect;
  renderSuspects();
  renderChat();
  renderMap();
  renderTimeline();
  renderEvidence();
});

$("#quick").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-q]");
  if (!btn) return;
  $("#question").value = btn.dataset.q;
  $("#ask-form").requestSubmit();
});

$("#question").addEventListener("input", () => ($("#ask-error").hidden = true));

$("#evidence").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-evidence]");
  if (!btn) return;
  state.evidence = btn.dataset.evidence;
  renderEvidence();
  $("#question").focus();
  if (!$("#question").value) $("#question").value = "Can you explain this?";
});
$("#evidence-chip-clear").addEventListener("click", () => {
  state.evidence = null;
  renderEvidence();
});

$("#ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const question = $("#question").value.trim();
  if (!question) {
    $("#ask-error").textContent = "Type a question first.";
    $("#ask-error").hidden = false;
    return;
  }
  const suspectId = state.active;
  const chat = state.chats[suspectId];
  const evidence = state.case.evidence.find((x) => x.id === state.evidence);
  state.busy = true;
  $("#btn-ask").disabled = true;
  $("#question").value = "";
  chat.push({ kind: "me", text: question, shown: evidence?.title });
  const typing = { kind: "typing" };
  chat.push(typing);
  renderChat();

  try {
    const r = await api("POST", "/api/ask", { sessionId: state.sessionId, suspectId, question, evidenceId: evidence?.id });
    chat.splice(chat.indexOf(typing), 1);
    chat.push({ kind: "them", text: r.reply, tell: r.tell, claims: r.claims, animate: suspectId === state.active });
    if (r.stress - state.stress[suspectId] >= 15) state.shake = suspectId;
    state.stress[suspectId] = r.stress;
    state.claims.push(...r.claims);
    state.contradictions.push(...r.contradictions);
    state.suspicions.push(...r.suspicions);
    for (const x of r.contradictions) chat.push({ kind: "alert", title: "🚨 Gotcha! That doesn't add up.", text: x.text });
    for (const x of r.suspicions) chat.push({ kind: "warn", title: "🤔 Hmm, suspicious route.", text: x.text });
    const latest = r.contradictions.at(-1) ?? r.suspicions.at(-1);
    if (latest) state.highlight = { id: latest.id, kind: r.contradictions.length ? "contradiction" : "suspicion", path: latest.path };
    state.evidence = null;
  } catch (err) {
    chat.splice(chat.indexOf(typing), 1);
    chat.push({ kind: "error", text: `⚠️ ${err.message}` });
  } finally {
    state.busy = false;
    $("#btn-ask").disabled = false;
    if (suspectId === state.active) $("#question").focus();
    renderAll();
  }
});

$("#alerts").addEventListener("click", (e) => {
  const card = e.target.closest("[data-alert]");
  if (!card) return;
  const x = [...state.contradictions, ...state.suspicions].find((y) => y.id === card.dataset.alert);
  state.highlight = { id: x.id, kind: x.id.startsWith("x") ? "contradiction" : "suspicion", path: x.path };
  state.active = x.suspect;
  renderAll();
});

$("#map").addEventListener("click", async (e) => {
  const g = e.target.closest("[data-place]");
  if (!g) return;
  const id = g.dataset.place;
  state.pick = state.pick[0] === id ? [] : [...state.pick, id].slice(-2);
  if (state.pick.length === 2) {
    const [from, to] = state.pick;
    try {
      const params = new URLSearchParams({ sessionId: state.sessionId, from, to });
      const r = await api("GET", `/api/route?${params}`);
      state.highlight = { id: null, kind: "check", path: r.path };
      $("#route-readout").innerHTML = `🚶 <b>${esc(place(from).name)} → ${esc(place(to).name)}: ${Math.round(r.minutes)} min walk</b>`;
    } catch (err) {
      $("#route-readout").textContent = err.message;
    }
    state.pick = [];
  } else if (state.pick.length === 1) {
    $("#route-readout").innerHTML = `From <b>${esc(place(id).name)}</b>… now tap a second place.`;
  }
  renderMap();
});

// ------------------------------------------------------------ dialogs

function openBriefing() {
  const c = state.case;
  $("#briefing-kicker").textContent = `${c.icon ?? ""} ${c.category} · ${c.area}`;
  $("#briefing-title").textContent = c.title;
  $("#briefing-text").textContent = c.briefing;
  $("#briefing-people").innerHTML = c.suspects
    .map((s) => `<div class="person">${avatar(s)}<span><b>${esc(s.name)}</b>${esc(s.role)}</span></div>`)
    .join("");
  $("#briefing-dialog").showModal();
}
$("#btn-briefing").addEventListener("click", openBriefing);
$("#btn-cases").addEventListener("click", showStart);

$("#btn-accuse").addEventListener("click", () => {
  const c = state.case;
  $("#accuse-heading").textContent = `${c.labels.accuse}: who's lying?`;
  $("#accuse-options").innerHTML = c.suspects
    .map((s) => {
      const n = state.contradictions.filter((x) => x.suspect === s.id).length;
      return `<button data-accuse="${s.id}">${avatar(s)}<span><b>${esc(s.name)}</b>
        <small>${n ? `🚨 ${n} impossible alibi${n > 1 ? "s" : ""} on record` : "No lies caught yet"}</small></span></button>`;
    })
    .join("");
  $("#accuse-pick").hidden = false;
  $("#accuse-result").hidden = true;
  $("#accuse-dialog").showModal();
});

$("#accuse-options").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-accuse]");
  if (!btn) return;
  try {
    const r = await api("POST", "/api/accuse", { sessionId: state.sessionId, suspectId: btn.dataset.accuse });
    $("#result-emoji").textContent = { win: "🎉", weak: "🤔", wrong: "😬" }[r.outcome];
    $("#result-title").textContent = r.title;
    $("#result-title").className = r.outcome;
    $("#result-text").textContent = r.text;
    $("#result-proof").innerHTML = (r.proof ?? []).map((p) => `<li>${esc(p)}</li>`).join("");
    $("#result-solution").textContent = r.solution ?? "";
    $("#result-stats").textContent = r.outcome === "weak" ? "" : `You asked ${r.stats.questions} question${r.stats.questions === 1 ? "" : "s"}.`;
    $("#btn-result-new").hidden = r.outcome === "weak";
    $("#accuse-pick").hidden = true;
    $("#accuse-result").hidden = false;
  } catch (err) {
    alert(err.message);
  }
});
$("#btn-result-close").addEventListener("click", () => $("#accuse-dialog").close());
$("#btn-result-new").addEventListener("click", () => {
  $("#accuse-dialog").close();
  showStart();
});

boot();
