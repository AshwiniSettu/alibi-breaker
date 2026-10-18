const $ = (sel) => document.querySelector(sel);
const esc = (t) =>
  String(t ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const toMin = (hhmm) => hhmm.split(":").reduce((h, m) => Number(h) * 60 + Number(m));
const fmt = (min) => {
  const h = Math.floor(min / 60) % 24;
  return `${h % 12 || 12}:${String(min % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const firstName = (s) => s.name.split(" ")[0];

const QUICK = ["Where were you tonight?", "What time did you leave?", "Which way did you drive?", "Who can confirm that?"];

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
  };
}
const suspect = (id) => state.case.suspects.find((s) => s.id === id);
const place = (id) => state.case.map.places.find((p) => p.id === id);

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
    const html = `Suspect brain: ${tier(health.big)} · Note-taker: ${tier(health.fast)}${health.big.provider === "mock" ? " · mock mode, no AI" : ""}`;
    $("#model-badge").innerHTML = html;
    $("#model-badge-game").innerHTML = `${tier(health.big)} + ${tier(health.fast)}`;
  } catch {
    $("#model-badge").textContent = "Server not reachable.";
  }
  try {
    const { cases } = await api("GET", "/api/cases");
    $("#case-list").innerHTML = cases.length
      ? cases
          .map(
            (c) => `<button class="case-card" data-case="${esc(c.id)}">
              <span class="stamp">${esc(c.category)}</span>
              <h3>${esc(c.title)}</h3><p>${esc(c.tagline)}</p></button>`,
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
  $("#case-title").textContent = c.title;
  $("#case-category").textContent = `${c.category} · You are the ${c.labels.role.toLowerCase()}`;
  $("#btn-accuse").textContent = c.labels.accuse;
  $("#legend-crime").textContent = c.crime.label;
  $("#question").placeholder = `Where were you at ${fmt(toMin(c.crime.time))}?`;
  $("#quick").innerHTML = QUICK.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  renderSuspects();
  renderChat();
  renderMap();
  renderAlerts();
  renderTimeline();
  renderEvidence();
}

function stressColor(v) {
  return v > 65 ? "var(--red)" : v > 35 ? "var(--amber)" : "var(--green)";
}

function renderSuspects() {
  $("#suspects").innerHTML = state.case.suspects
    .map((s) => {
      const v = state.stress[s.id];
      const broken = state.contradictions.some((x) => x.suspect === s.id);
      return `<button class="suspect" data-suspect="${s.id}" aria-pressed="${s.id === state.active}" style="--sc:${esc(s.color)}">
        <span class="name"><span class="dot"></span>${esc(s.name)}</span>
        <span class="role">${esc(s.role)}</span>
        <span class="stress"><span style="width:${v}%;background:${stressColor(v)}"></span></span>
        <span class="stress-label">Stress ${v}% ${broken ? '<span class="flag">· ALIBI BROKEN</span>' : ""}</span>
      </button>`;
    })
    .join("");
}

function renderChat() {
  const s = suspect(state.active);
  const msgs = state.chats[s.id];
  const chat = $("#chat");
  if (!msgs.length) {
    chat.innerHTML = `<div class="msg system">${esc(s.name)} sits down across the table. ${esc(s.bio)}</div>`;
    return;
  }
  chat.innerHTML = msgs
    .map((m) => {
      if (m.kind === "detective") {
        return `<div class="msg detective">${m.shown ? `<div class="shown">Shows: ${esc(m.shown)}</div>` : ""}${esc(m.text)}</div>`;
      }
      if (m.kind === "typing") {
        return `<div class="msg suspect" style="--sc:${esc(s.color)}"><div class="who">${esc(s.name)}</div><div class="typing">thinking</div></div>`;
      }
      if (m.kind === "suspect") {
        const chips = m.claims.map((x) => `<span class="chip">📍 ${esc(x.placeName)} · ${esc(x.timeText)}</span>`).join("");
        return `<div class="msg suspect" style="--sc:${esc(s.color)}">
          <div class="who">${esc(s.name)}</div>
          <div class="line" data-full="${esc(m.text)}">${m.animate ? "" : esc(m.text)}</div>
          ${m.tell ? `<div class="tell">${esc(firstName(s))} ${esc(m.tell)}</div>` : ""}
          ${chips ? `<div class="chips">${chips}</div>` : ""}</div>`;
      }
      return `<div class="msg system ${m.kind}">${esc(m.text)}</div>`;
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
  let i = 0;
  const step = () => {
    i = Math.min(text.length, Math.ceil((performance.now() - started) / 12));
    el.textContent = text.slice(0, i);
    $("#chat").scrollTop = $("#chat").scrollHeight;
    if (i < text.length) el._timer = setTimeout(step, 18);
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
  const svg = $("#map");
  svg.setAttribute("viewBox", `0 0 ${map.width} ${map.height}`);
  let out = "";

  for (const r of map.roads) {
    const a = place(r.from);
    const b = place(r.to);
    out += SVG("line", { class: "road", x1: a.x, y1: a.y, x2: b.x, y2: b.y }, `<title>${esc(r.name)}: ${r.minutes} min</title>`);
    out += SVG("text", { class: "road-label", x: (a.x + b.x) / 2 + 6, y: (a.y + b.y) / 2 - 6 }, `${r.minutes}m`);
  }

  if (state.highlight?.path?.length > 1) {
    const pts = state.highlight.path.map((id) => `${place(id).x},${place(id).y}`).join(" ");
    out += SVG("polyline", { class: `route ${state.highlight.kind}`, points: pts });
  }

  for (const p of map.places) {
    const isCrime = p.id === crime.place;
    const below = p.y < map.height - 60;
    const anchor = p.x < 90 ? "start" : p.x > map.width - 90 ? "end" : "middle";
    const tx = anchor === "start" ? p.x - 10 : anchor === "end" ? p.x + 10 : p.x;
    const ty = below ? p.y + 25 : p.y - 30;
    const picked = state.pick.includes(p.id);
    out += `<g class="place${isCrime ? " crime" : ""}${picked ? " picked" : ""}" data-place="${p.id}">
      ${isCrime ? SVG("circle", { class: "pulse", cx: p.x, cy: p.y, r: 9 }) : ""}
      ${SVG("circle", { class: "node", cx: p.x, cy: p.y, r: 9 }, `<title>${esc(p.name)}, ${esc(p.area)}</title>`)}
      ${SVG("text", { x: tx, y: ty, "text-anchor": anchor }, esc(p.name))}
      ${SVG("text", { class: "area", x: tx, y: ty + 13, "text-anchor": anchor }, esc(p.area))}
    </g>`;
  }

  // Pins: what people said (circles) and what evidence shows (squares).
  const pins = new Map();
  const add = (pt) => pins.set(pt.place, [...(pins.get(pt.place) ?? []), pt]);
  for (const e of state.case.evidence) {
    for (const f of e.facts ?? []) add({ ...f, time: toMin(f.time), source: "fact", evidence: e.title });
  }
  for (const c of state.claims) add(c);
  for (const [pid, list] of pins) {
    const p = place(pid);
    const left = p.x > map.width - 110;
    list.sort((a, b) => a.time - b.time);
    list.forEach((pt, i) => {
      const s = pt.suspect ? suspect(pt.suspect) : null;
      const color = s?.color ?? "#b8ae98";
      // Stack pins away from the place label (labels sit below, or above near the bottom edge).
      const labelBelow = p.y < map.height - 60;
      const x = left ? p.x - 52 : p.x + 15;
      const y = labelBelow ? p.y - 12 - (list.length - 1 - i) * 18 : p.y - 6 + i * 18;
      const dim = s && s.id !== state.active ? 0.4 : 1;
      const who = s ? s.name : "Unknown";
      const what = pt.source === "fact" ? `${pt.evidence}: ${pt.label}` : `said: ${pt.label}`;
      out += `<g class="pin" opacity="${dim}">
        ${SVG("rect", { x, y, width: 38, height: 15, rx: pt.source === "fact" ? 2 : 7.5, fill: color, stroke: pt.source === "fact" ? "#0e0d0b" : "none" }, `<title>${esc(who)} · ${esc(fmt(pt.time))} · ${esc(what)}</title>`)}
        ${SVG("text", { x: x + 19, y: y + 11, "text-anchor": "middle" }, esc(fmt(pt.time).replace(" PM", "").replace(" AM", "a")))}
      </g>`;
    });
  }
  svg.innerHTML = out;
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
            <span class="kind">${x.kind === "contradiction" ? "ALIBI DOESN'T ADD UP" : "SUSPICIOUS ROUTE"}</span>${esc(x.text)}</button>`,
        )
        .join("")
    : `<p class="muted">No contradictions yet. Ask about times and places.</p>`;
}

function renderTimeline() {
  const s = suspect(state.active);
  $("#timeline-who").textContent = s.name;
  const points = [
    ...state.case.evidence.flatMap((e) =>
      (e.facts ?? []).filter((f) => f.suspect === s.id).map((f) => ({ ...f, time: toMin(f.time), source: "fact", evidence: e.title })),
    ),
    ...state.claims.filter((c) => c.suspect === s.id),
  ].sort((a, b) => a.time - b.time);
  $("#timeline").innerHTML = points.length
    ? points
        .map(
          (p) => `<li class="${p.source}" style="--sc:${esc(s.color)}"><span class="t">${fmt(p.time)}</span>${esc(place(p.place).name)}: ${esc(p.label)}
            <span class="src">(${p.source === "fact" ? esc(p.evidence) : "said in interview"})</span></li>`,
        )
        .join("")
    : `<li class="muted">Nothing yet.</li>`;
}

function renderEvidence() {
  const s = suspect(state.active);
  $("#evidence").innerHTML = state.case.evidence
    .map(
      (e) => `<div class="ev"><h3>${esc(e.title)}</h3><p>${esc(e.detail)}</p>
        <button type="button" data-evidence="${e.id}">Show to ${esc(firstName(s))}</button></div>`,
    )
    .join("");
  const chip = $("#evidence-chip");
  const ev = state.case.evidence.find((e) => e.id === state.evidence);
  chip.hidden = !ev;
  if (ev) $("#evidence-chip-title").textContent = ev.title;
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
  if (!$("#question").value) $("#question").value = "Explain this.";
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
  chat.push({ kind: "detective", text: question, shown: evidence?.title });
  const typing = { kind: "typing" };
  chat.push(typing);
  renderChat();

  try {
    const r = await api("POST", "/api/ask", { sessionId: state.sessionId, suspectId, question, evidenceId: evidence?.id });
    chat.splice(chat.indexOf(typing), 1);
    chat.push({ kind: "suspect", text: r.reply, tell: r.tell, claims: r.claims, animate: suspectId === state.active });
    state.stress[suspectId] = r.stress;
    state.claims.push(...r.claims);
    state.contradictions.push(...r.contradictions);
    state.suspicions.push(...r.suspicions);
    for (const x of r.contradictions) chat.push({ kind: "alert", text: `🚨 Alibi doesn't add up. ${x.text}` });
    for (const x of r.suspicions) chat.push({ kind: "warn", text: `⚠️ ${x.text}` });
    const latest = r.contradictions.at(-1) ?? r.suspicions.at(-1);
    if (latest) state.highlight = { id: latest.id, kind: r.contradictions.length ? "contradiction" : "suspicion", path: latest.path };
    state.evidence = null;
  } catch (err) {
    chat.splice(chat.indexOf(typing), 1);
    chat.push({ kind: "system", text: `⚠️ ${err.message}` });
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
      $("#route-readout").innerHTML = `<b>${esc(place(from).name)} → ${esc(place(to).name)}: ${r.minutes} min</b> via ${esc(r.roads.join(", "))}`;
    } catch (err) {
      $("#route-readout").textContent = err.message;
    }
    state.pick = [];
  } else if (state.pick.length === 1) {
    $("#route-readout").innerHTML = `From <b>${esc(place(id).name)}</b>, now click a second place.`;
  }
  renderMap();
});

// ------------------------------------------------------------ dialogs

function openBriefing() {
  const c = state.case;
  $("#briefing-title").textContent = c.title;
  $("#briefing-text").textContent = c.briefing;
  $("#briefing-people").innerHTML = c.suspects
    .map((s) => `<div class="person" style="--sc:${esc(s.color)}"><b>${esc(s.name)}: ${esc(s.role)}</b>${esc(s.bio)}</div>`)
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
      return `<button data-accuse="${s.id}" style="--sc:${esc(s.color)}"><b>${esc(s.name)}</b>
        <small>${n ? `${n} impossible alibi${n > 1 ? "s" : ""} on record` : "No contradictions on record"}</small></button>`;
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
    $("#result-title").textContent = r.title;
    $("#result-title").className = r.outcome;
    $("#result-text").textContent = r.text;
    $("#result-proof").innerHTML = (r.proof ?? []).map((p) => `<li>${esc(p)}</li>`).join("");
    $("#result-solution").textContent = r.solution ?? "";
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
