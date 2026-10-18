// Loads case files from cases/*.json and the street map each one points at
// (maps/<name>.json, made from OpenStreetMap by scripts/import-rally-map.mjs).
// A case puts its places (Joe's Café, the jewelers...) on real street corners.
// Case files are re-read on every new game, so you can edit and click "New game".

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
      cases.push({ id: c.id, title: c.title, category: c.category ?? "Case", tagline: c.tagline ?? "", icon: c.icon ?? "🕵️", area: c.area ?? "" });
    } catch (err) {
      console.warn(`Skipping ${file}: ${err.message}`);
    }
  }
  return cases;
}

const norm = (s) => s.toLowerCase().replace(/\b(street|st|avenue|ave)\b\.?/g, "").replace(/\s+/g, " ").trim();

function findCorner(map, corner) {
  if (typeof corner === "string") return map.corners.find((c) => c.id === corner);
  const [a, b] = corner.map(norm);
  return map.corners.find((c) => {
    const streets = c.streets.map(norm);
    return streets.includes(a) && streets.includes(b);
  });
}

export async function loadCase(id) {
  if (!SAFE_ID.test(id ?? "")) throw new Error(`Bad case id "${id}"`);
  const data = await readJson(path.join(casesDir, `${id}.json`));
  if (!SAFE_ID.test(data.map ?? "")) throw new Error(`Case "${id}": bad map id "${data.map}"`);
  const map = await readJson(path.join(mapsDir, `${data.map}.json`));

  const problems = [];
  const places = data.places.map((p) => {
    const corner = findCorner(map, p.corner);
    if (!corner) problems.push(`place ${p.id}: no corner ${JSON.stringify(p.corner)} on ${map.name}`);
    return { ...p, cornerId: corner?.id, cornerName: corner?.name, x: corner?.x, y: corner?.y };
  });
  if (problems.length) throw new Error(`Case "${id}" has problems:\n- ${problems.join("\n- ")}`);

  // Places hang off their corner with a zero-minute link, so routes run on real streets.
  const nodes = [...map.corners, ...places];
  const roads = [...map.roads, ...places.map((p) => ({ from: p.id, to: p.cornerId, minutes: 0, name: null }))];

  const c = {
    labels: { role: "Detective", subjects: "Suspects", accuse: "Accuse", win: "Case closed", wrong: "Wrong suspect" },
    ...data,
    map: { ...map, places },
    graph: buildGraph({ places: nodes, roads }),
    places: new Map(places.map((p) => [p.id, p])),
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
    icon: c.icon,
    area: c.area,
    labels: c.labels,
    briefing: c.briefing,
    crime: { place: c.crime.place, time: c.crime.time, label: c.crime.label, icon: c.crime.icon },
    map: {
      name: c.map.name,
      attribution: c.map.attribution,
      travel: c.map.travel,
      width: c.map.width,
      height: c.map.height,
      tiles: c.map.tiles,
      corners: c.map.corners.map(({ id, name, x, y }) => ({ id, name, x, y })),
      places: c.map.places.map(({ id, name, icon, cornerName, x, y }) => ({ id, name, icon, cornerName, x, y })),
    },
    suspects: c.suspects.map(({ id, name, role, color, bio, avatar }) => ({ id, name, role, color, bio, avatar })),
    evidence: c.evidence,
  };
}
