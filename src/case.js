// Loads case files from cases/*.json and the map each one points at
// (maps/<name>.json). Case files are re-read on every new game, so you can
// edit a case and just click "New game".

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "./map.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const casesDir = path.join(root, "cases");
const mapsDir = path.join(root, "maps");
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`Can't read ${path.relative(root, file)}: ${err.message}`);
  }
}

export async function listCases() {
  const files = (await readdir(casesDir)).filter((f) => f.endsWith(".json")).sort();
  const cases = [];
  for (const file of files) {
    try {
      const c = await readJson(path.join(casesDir, file));
      cases.push({ id: c.id, title: c.title, category: c.category ?? "Case", tagline: c.tagline ?? "" });
    } catch (err) {
      console.warn(`Skipping ${file}: ${err.message}`);
    }
  }
  return cases;
}

export async function loadCase(id) {
  if (!SAFE_ID.test(id ?? "")) throw new Error(`Bad case id "${id}"`);
  const data = await readJson(path.join(casesDir, `${id}.json`));
  if (typeof data.map === "string" && !SAFE_ID.test(data.map)) throw new Error(`Bad map id "${data.map}"`);
  const map = typeof data.map === "string" ? await readJson(path.join(mapsDir, `${data.map}.json`)) : data.map;
  const c = {
    labels: { role: "Detective", subjects: "Suspects", accuse: "Accuse", win: "Case closed", wrong: "Wrong suspect" },
    ...data,
    map,
    graph: buildGraph(map),
    places: new Map(map.places.map((p) => [p.id, p])),
  };
  c.watch ??= { place: c.crime.place, window: c.crime.window, label: c.crime.label };
  validate(c);
  return c;
}

function validate(c) {
  const problems = [];
  const place = (id, where) => {
    if (id != null && !c.places.has(id)) problems.push(`${where}: unknown place "${id}"`);
  };
  const suspects = new Set(c.suspects.map((s) => s.id));
  for (const road of c.map.roads) {
    place(road.from, `road ${road.name}`);
    place(road.to, `road ${road.name}`);
  }
  place(c.crime.place, "crime");
  place(c.watch.place, "watch");
  for (const s of c.suspects) {
    place(s.home, `suspect ${s.id} home`);
    for (const key of ["name", "truth", "cover", "pressure"]) {
      if (!s[key]) problems.push(`suspect ${s.id}: missing "${key}"`);
    }
  }
  if (c.suspects.filter((s) => s.guilty).length !== 1) problems.push("exactly one suspect must have guilty: true");
  for (const e of c.evidence) {
    for (const f of e.facts ?? []) {
      place(f.place, `evidence ${e.id}`);
      if (f.suspect != null && !suspects.has(f.suspect)) problems.push(`evidence ${e.id}: unknown suspect "${f.suspect}"`);
      if (!/^\d{2}:\d{2}$/.test(f.time)) problems.push(`evidence ${e.id}: time must be HH:MM (24h)`);
    }
  }
  if (problems.length) throw new Error(`Case "${c.id}" has problems:\n- ${problems.join("\n- ")}`);
}

// What the browser is allowed to see: no truths, cover stories or solution.
export function publicCase(c) {
  return {
    id: c.id,
    title: c.title,
    category: c.category,
    labels: c.labels,
    briefing: c.briefing,
    crime: { place: c.crime.place, time: c.crime.time, label: c.crime.label },
    map: {
      name: c.map.name,
      note: c.map.note,
      width: c.map.width,
      height: c.map.height,
      places: c.map.places.map(({ id, name, area, x, y }) => ({ id, name, area, x, y })),
      roads: c.map.roads,
    },
    suspects: c.suspects.map(({ id, name, role, color, bio }) => ({ id, name, role, color, bio })),
    evidence: c.evidence,
  };
}
