// The game loop for one question:
//   1. BIG model plays the suspect and answers.
//   2. FAST model reads the answer: which places at which times, stress, a tell.
//   3. Plain code checks every claim against the map + evidence. No AI here,
//      so a "lie caught" is always provably true.

import { randomUUID } from "node:crypto";
import { complete } from "./llm.js";
import { shortestPath } from "./map.js";
import { mentionsPlace, mockNotes, mockSuspectReply, statesTime } from "./mock.js";

const sessions = new Map();
const TOLERANCE_MIN = 2; // forgive small rounding in people's times
const MAX_SESSIONS = 200;

export const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fmt = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = String(min % 60).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
};

export function createSession(caseData) {
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const session = {
    id: randomUUID(),
    caseData,
    history: Object.fromEntries(caseData.suspects.map((s) => [s.id, []])),
    stress: Object.fromEntries(caseData.suspects.map((s) => [s.id, 15])),
    claims: [],
    contradictions: [],
    suspicions: [],
    over: false,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw Object.assign(new Error("Game not found. Start a new game."), { status: 404 });
  return session;
}

// ------------------------------------------------------------- prompts

function suspectSystem(c, s) {
  const places = c.map.places.map((p) => `${p.name} (${p.area})`).join(", ");
  return `You are ${s.name}, ${s.role}. You are being questioned by a ${c.labels.role.toLowerCase()} about ${c.crime.summary}.

Your personality and voice: ${s.voice}

What really happened tonight. This is your private knowledge; never state it outright:
${s.truth}

Your story, which is what you tell the ${c.labels.role.toLowerCase()}:
${s.cover}

If you are cornered:
${s.pressure}

Places in ${c.map.name ?? "town"}: ${places}.

How to talk:
- Stay in character. Answer in 1 to 3 short spoken sentences, like a real interview. No stage directions, asterisks or narration; body language is handled separately.
- When asked where you were, give the specific times and place names from your story. All times are in the evening; say them like "9:10".
- Don't invent new exact times or places beyond your story. If pushed for details your story doesn't cover, be vague.
- Never confess and never reveal the private knowledge directly. Anything that appears only in your private knowledge (what you really did, your motive, money worries, where things are hidden) stays unsaid unless the "cornered" instructions allow it.
- When caught in an inconsistency, follow the "cornered" instructions.
- If you are shown evidence, react to that specific piece of evidence.
- Latency-sensitive; begin your visible answer immediately.`;
}

function notesSystem(c, s) {
  const places = c.map.places.map((p) => `- ${p.id}: ${p.name} (${p.area})`).join("\n");
  return `You are the note-taker in an interview room. You read one answer from ${s.name} and record where ${s.name} says ${s.name} was, and when.

Known places (use only these ids):
${places}
${s.home ? `"Home" for ${s.name} means place id ${s.home}.` : `${s.name}'s home is not on the map; ignore claims about being home.`}

Rules for claims:
- One claim per (place, time) that ${s.name} states or clearly implies about ${s.name}'s own whereabouts. Ignore claims about other people.
- Convert times to 24-hour HH:MM. Everything happened in the evening, so "9:10" means 21:10 and "ten past nine" means 21:10.
- A range like "from 8:00 until 9:10 at Joe's" becomes two claims: start and end.
- Work out relative times ("got home five minutes later") when the base time is given.
- Leaving a place at a time counts as being there at that time. Arriving somewhere counts as being there.
- Only record a place that this answer names (or "home" when ${s.name}'s home is on the map). Streets and routes are not places: never infer a place from a route.
- Only record a time that this answer states, or that you can compute from a time it states. Skip statements with no time.
- label: a short paraphrase, at most 8 words.

Stress (0 to 100): how rattled ${s.name} is right now, starting from the previous level. What ${s.name} is sensitive about: ${s.stressHint ?? "unknown"}. Raise it sharply when the question hits a pressure point or the answer shows a story change; let it drift down for easy questions.

tell: one visible body-language cue that fits the stress level, at most 8 words, third person, no name, e.g. "glances at the door".`;
}

function notesSchema(c) {
  return {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            place: { type: "string", enum: c.map.places.map((p) => p.id) },
            time: { type: "string", description: "24-hour HH:MM" },
            label: { type: "string" },
          },
          required: ["place", "time", "label"],
          additionalProperties: false,
        },
      },
      stress: { type: "integer", description: "0 to 100" },
      tell: { type: "string" },
    },
    required: ["claims", "stress", "tell"],
    additionalProperties: false,
  };
}

// ------------------------------------------------------------- one turn

export async function ask(session, { suspectId, question, evidenceId }) {
  const c = session.caseData;
  const suspect = c.suspects.find((s) => s.id === suspectId);
  if (!suspect) throw Object.assign(new Error("Unknown suspect."), { status: 400 });
  question = String(question ?? "").trim().slice(0, 600);
  if (!question) throw Object.assign(new Error("Type a question first."), { status: 400 });
  const evidence = evidenceId ? c.evidence.find((e) => e.id === evidenceId) : null;

  const history = session.history[suspect.id];
  const content = evidence
    ? `[The ${c.labels.role.toLowerCase()} shows you evidence: "${evidence.title}": ${evidence.detail}]\n\n${question}`
    : question;
  const messages = [...history, { role: "user", content }];

  // 1. Suspect answers.
  let reply = await complete({
    tier: "big",
    system: suspectSystem(c, suspect),
    messages,
    maxTokens: 4000,
    mock: () => mockSuspectReply({ suspect, history, question, evidence }),
  });
  reply = reply.replace(/^["']|["']$/g, "").trim() || "...";
  history.push({ role: "user", content }, { role: "assistant", content: reply });

  // 2. Note-taker reads the answer. A failure here shouldn't kill the turn.
  const prevStress = session.stress[suspect.id];
  let notes = { claims: [], stress: prevStress, tell: "" };
  try {
    notes = await complete({
      tier: "fast",
      system: notesSystem(c, suspect),
      messages: [
        {
          role: "user",
          content: `Previous stress: ${prevStress}\n\nQuestion: ${content}\n\n${suspect.name}'s answer: ${reply}`,
        },
      ],
      schema: notesSchema(c),
      maxTokens: 2000,
      mock: () => mockNotes({ caseData: c, suspect, question, reply, prevStress }),
    });
  } catch (err) {
    console.warn(`Note-taker failed: ${err.message}`);
  }

  const stress = Math.max(0, Math.min(100, Math.round(Number(notes.stress) || prevStress)));
  session.stress[suspect.id] = stress;

  const newClaims = [];
  for (const claim of Array.isArray(notes.claims) ? notes.claims : []) {
    if (!c.places.has(claim.place) || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(claim.time ?? "")) continue;
    // Small models sometimes infer places nobody said. Only keep what was actually named.
    if (!mentionsPlace(c, suspect, claim.place, reply)) continue;
    const time = toMin(claim.time);
    if (!statesTime(reply, time)) continue;
    const duplicate = session.claims.some((x) => x.suspect === suspect.id && x.place === claim.place && x.time === time);
    if (duplicate) continue;
    const record = {
      id: `c${session.claims.length + 1}`,
      source: "claim",
      suspect: suspect.id,
      place: claim.place,
      time,
      label: String(claim.label ?? "").slice(0, 80) || "said so",
    };
    session.claims.push(record);
    newClaims.push(record);
  }

  // 3. Check the map.
  const contradictions = findContradictions(session, suspect, newClaims);
  const suspicions = findSuspicions(session, suspect);

  return {
    reply,
    tell: String(notes.tell ?? "").slice(0, 80),
    stress,
    claims: newClaims.map((x) => publicPoint(c, x)),
    contradictions,
    suspicions,
  };
}

// ------------------------------------------------------------- the checker

function pointsFor(session, suspectId) {
  const facts = session.caseData.evidence.flatMap((e) =>
    (e.facts ?? [])
      .filter((f) => f.suspect === suspectId)
      .map((f, i) => ({ id: `${e.id}-${i}`, source: "fact", evidence: e.title, suspect: f.suspect, place: f.place, time: toMin(f.time), label: f.label })),
  );
  return [...facts, ...session.claims.filter((x) => x.suspect === suspectId)];
}

function publicPoint(c, p) {
  return { ...p, placeName: c.places.get(p.place).name, timeText: fmt(p.time) };
}

function describe(c, p, who) {
  const where = `${c.places.get(p.place).name} at ${fmt(p.time)}`;
  return p.source === "fact" ? `the ${p.evidence} puts ${who} at ${where}` : `${who} said ${where}`;
}
const firstName = (s) => s.name.split(" ")[0];
const capitalize = (t) => t[0].toUpperCase() + t.slice(1);

function findContradictions(session, suspect, newClaims) {
  const c = session.caseData;
  const points = pointsFor(session, suspect.id);
  const found = [];
  for (const claim of newClaims) {
    for (const other of points) {
      if (other === claim || other.place === claim.place) continue;
      const [a, b] = other.time <= claim.time ? [other, claim] : [claim, other];
      const gap = b.time - a.time;
      const route = shortestPath(c.graph, a.place, b.place);
      if (!route || route.minutes <= gap + TOLERANCE_MIN) continue;
      const key = [suspect.id, `${a.place}@${a.time}`, `${b.place}@${b.time}`].join("|");
      if (session.contradictions.some((x) => x.key === key)) continue;
      const item = {
        key,
        id: `x${session.contradictions.length + 1}`,
        suspect: suspect.id,
        a: publicPoint(c, a),
        b: publicPoint(c, b),
        gap,
        travel: route.minutes,
        path: route.path,
        roads: route.roads,
        text: `${capitalize(describe(c, a, firstName(suspect)))}, and ${describe(c, b, firstName(suspect))}. That's ${gap} min apart, but the drive takes ${route.minutes} min.`,
      };
      session.contradictions.push(item);
      found.push(item);
    }
  }
  return found;
}

function findSuspicions(session, suspect) {
  const c = session.caseData;
  const watch = c.watch;
  if (!watch?.window) return [];
  const [start, end] = watch.window.map(toMin);
  const watchName = c.places.get(watch.place).name;
  const points = pointsFor(session, suspect.id).sort((a, b) => a.time - b.time);
  const found = [];
  const add = (key, item) => {
    if (session.suspicions.some((x) => x.key === key)) return;
    item = { key, id: `s${session.suspicions.length + 1}`, suspect: suspect.id, ...item };
    session.suspicions.push(item);
    found.push(item);
  };

  for (const p of points) {
    if (p.source === "claim" && p.place === watch.place && p.time >= start - 15 && p.time <= end + 15) {
      add(`${suspect.id}|at|${p.time}`, {
        path: [p.place],
        text: `${firstName(suspect)} puts themself at ${watchName} at ${fmt(p.time)}. Evidence: ${watch.label}.`,
      });
    }
  }
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (a.place === b.place || a.place === watch.place || b.place === watch.place) continue;
    if (a.source === "fact" && b.source === "fact") continue; // only flag routes the suspect's own words create
    const route = shortestPath(c.graph, a.place, b.place);
    if (!route || !route.path.includes(watch.place)) continue;
    const passAt = a.time + shortestPath(c.graph, a.place, watch.place).minutes;
    if (passAt < start || passAt > end) continue;
    add(`${suspect.id}|route|${a.place}@${a.time}|${b.place}@${b.time}`, {
      path: route.path,
      text: `${suspect.name}'s trip from ${c.places.get(a.place).name} (${fmt(a.time)}) to ${c.places.get(b.place).name} (${fmt(b.time)}) goes via ${route.roads.join(" and ")}, past ${watchName} at about ${fmt(passAt)}. Evidence: ${watch.label}.`,
    });
  }
  return found;
}

// ------------------------------------------------------------- accusation

export function accuse(session, suspectId) {
  const c = session.caseData;
  const suspect = c.suspects.find((s) => s.id === suspectId);
  if (!suspect) throw Object.assign(new Error("Unknown suspect."), { status: 400 });
  if (session.over) throw Object.assign(new Error("This game is over. Start a new one."), { status: 409 });

  if (!suspect.guilty) {
    session.over = true;
    return {
      outcome: "wrong",
      title: c.labels.wrong,
      text: suspect.innocentReveal ?? `${suspect.name} was telling the truth about the night.`,
      solution: c.solution.explanation,
    };
  }
  const proof = session.contradictions.filter((x) => x.suspect === suspect.id);
  if (proof.length === 0) {
    return { outcome: "weak", title: "Not enough proof", text: c.solution.weakCase };
  }
  session.over = true;
  return {
    outcome: "win",
    title: c.labels.win,
    text: suspect.confession,
    proof: proof.map((x) => x.text),
    solution: c.solution.explanation,
  };
}

export function route(session, from, to) {
  const c = session.caseData;
  if (!c.places.has(from) || !c.places.has(to)) throw Object.assign(new Error("Unknown place."), { status: 400 });
  return shortestPath(c.graph, from, to);
}
