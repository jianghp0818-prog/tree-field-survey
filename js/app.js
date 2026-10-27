// Tree Field Survey: open a field pack, tap a tree on the topo map, fill in the form, export the results.

import { db } from "./db.js";
import { TopoMap } from "./map.js";
import { compressPhoto } from "./photos.js";
import { buildResultsZip, exportCandidates, shareOrDownload } from "./export.js";
import { PHOTO_KINDS, STATUS_LABELS, blankRecord, hasData, missingItems, speciesText, statusOf } from "./records.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const APP_VERSION = "0.3.0";     // change with CACHE in sw.js
const SVY21 = "+proj=tmerc +lat_0=1.366666666666667 +lon_0=103.8333333333333 +k=1 +x_0=28001.642 +y_0=38744.572 " +
  "+ellps=WGS84 +units=m +no_defs";
const BASEMAP_DEFAULT = { on: false, style: "Grey", opacity: 0.8, contrast: 1 };

const state = {
  job: null,          // {id, name, pack, packId, loadedAt}
  pack: null,
  records: new Map(), // tree key -> record
  trees: new Map(),   // tree key -> tree from the pack
  current: null,      // record shown in the form
  surveyor: "",
  mode: null,         // null, "add" (tap to place a new tree) or "move" (tap the new position of moveKey)
  moveKey: null,
  addPoint: null,
  watchId: null,
  listFilter: "all",
  species: [],        // [{row, haystack}]
  thumbUrls: {},
  basemap: { ...BASEMAP_DEFAULT },
};
let map;

// ---------------------------------------------------------------- small helpers
function toast(text, ms = 3000) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function fmt(n, digits = 3) {
  return n.toLocaleString("en-SG", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function absolute(x, y) {
  const [e0, n0] = state.pack.origin;
  return { e: e0 + x, n: n0 + y };
}

function treeLabel(t) {
  if (!t.no) return "(no number)";
  const dup = t.key.match(/#(\d+)$/);
  return dup ? `${t.no} (${dup[1]})` : t.no;
}

// The number shown for a drawing tree: the one found on site (marked *) when it differs from the drawing.
function displayLabel(t, rec) {
  return rec?.corrected_no ? `${rec.corrected_no}*` : treeLabel(t);
}

// Is a tree number already taken by another tree (its number on site counts, not the drawing's)?
function numberInUse(no, exceptKey = null) {
  for (const t of state.pack.trees) {
    if (t.key !== exceptKey && (state.records.get(t.key)?.corrected_no || t.no) === no) return true;
  }
  for (const r of state.records.values()) {
    if (r.new && !r.deleted && r.key !== exceptKey && r.no === no) return true;
  }
  return false;
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/['’]/g, "").replace(/×/g, "x").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- home screen
async function showHome() {
  setMode(null);
  closeForm();
  stopLocate();
  state.job = null;
  $("#survey").hidden = true;
  $("#home").hidden = false;
  history.replaceState(null, "", location.pathname);
  const jobs = (await db.listJobs()).sort((a, b) => (b.openedAt || "").localeCompare(a.openedAt || ""));
  const list = $("#job-list");
  list.innerHTML = "";
  $("#no-jobs").hidden = jobs.length > 0;
  for (const job of jobs) {
    const records = (await db.getRecords(job.id)).filter((r) => !r.deleted);
    const done = records.filter((r) => statusOf(r) === "done").length;
    const started = records.filter((r) => hasData(r)).length;
    const li = document.createElement("li");
    li.innerHTML = `<div class="job-main"><div class="job-name"></div><div class="muted small"></div></div>
      <button class="btn small ghost" data-delete>Delete</button>`;
    li.querySelector(".job-name").textContent = job.name;
    li.querySelector(".muted").textContent =
      `${job.pack.trees.length} trees · ${started} with data · ${done} complete · loaded ${new Date(job.loadedAt).toLocaleDateString("en-SG")}`;
    li.querySelector(".job-main").onclick = () => openJob(job.id);
    li.querySelector("[data-delete]").onclick = async () => {
      const unsent = records.filter((r) => hasData(r) && r.exported !== r.updated).length;
      const warning = unsent ? `\n\n${unsent} trees have data that has not been exported yet.` : "";
      if (confirm(`Delete job "${job.name}" and all its field data and photos from this tablet?${warning}`)) {
        await db.deleteJob(job.id);
        showHome();
      }
    };
    list.appendChild(li);
  }
  showStorage();
}

async function showStorage() {
  if (!navigator.storage?.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $("#storage-info").textContent = `Storage used ${(usage / 1048576).toFixed(1)} MB of ${(quota / 1073741824).toFixed(1)} GB` +
    (persisted ? " · protected from automatic clean-up" : " · not protected: export results often");
}

async function loadPack(pack) {
  if (pack?.format !== "treefield-pack" || pack.version !== 1) {
    throw new Error("This file is not a tree field pack.");
  }
  const existing = await db.getJob(pack.job.id);
  const now = new Date().toISOString();
  await db.putJob({
    id: pack.job.id, name: pack.job.name || pack.job.id, pack, packId: pack.pack_id,
    loadedAt: now, openedAt: existing?.openedAt || now,
  });
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (existing && existing.packId !== pack.pack_id) {
    const keys = new Set(pack.trees.map((t) => t.key));
    const records = await db.getRecords(pack.job.id);
    const orphans = records.filter((r) => !r.new && !keys.has(r.key) && hasData(r));
    toast(`Drawing updated. Field data kept.${orphans.length ? ` ${orphans.length} trees with data are no longer in the drawing: ${orphans.map((r) => r.key).join(", ")}` : ""}`, 8000);
  }
  await openJob(pack.job.id);
  if (pack.issues?.length) toast(`Office check: ${pack.issues.length} drawing issue(s), e.g. ${pack.issues[0]}`, 8000);
}

async function readPackFile(file) {
  try {
    await loadPack(JSON.parse(await file.text()));
  } catch (err) {
    alert(`Could not open ${file.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- survey screen
async function openJob(id) {
  const job = await db.getJob(id);
  job.openedAt = new Date().toISOString();
  await db.putJob(job);
  await db.setSetting("lastJob", id);
  state.job = job;
  state.pack = job.pack;
  state.trees = new Map(job.pack.trees.map((t) => [t.key, t]));
  state.records = new Map((await db.getRecords(id)).map((r) => [r.key, r]));
  const cols = job.pack.species.columns;
  state.species = job.pack.species.rows.map((row) => {
    const r = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    return { r, sci: normalize(r.scientific_name), com: normalize(r.common_name), hay: normalize(row.join(" | ")) };
  });
  $("#home").hidden = true;
  $("#survey").hidden = false;
  $("#job-title").textContent = job.name;
  $("#f-girth-label").textContent = `Girth at ${job.pack.form.girth_height.toFixed(1)} m (m)`;
  buildConditionButtons(job.pack.form.conditions);
  map.setPack(job.pack);
  map.setGeo(makeGeo(job.pack.origin));
  map.selected = null;
  refreshTrees();
  history.replaceState(null, "", `#job=${encodeURIComponent(id)}`);
}

function mapTrees() {
  const trees = state.pack.trees.map((t) => {
    const rec = state.records.get(t.key);
    return { key: t.key, label: displayLabel(t, rec), alt: t.no, x: t.x, y: t.y, status: statusOf(rec), isNew: false };
  });
  for (const r of state.records.values()) {
    if (r.new && !r.deleted) {
      trees.push({ key: r.key, label: r.no, alt: "", x: r.x, y: r.y, status: statusOf(r), isNew: true });
    }
  }
  return trees;
}

function refreshTrees() {
  const trees = mapTrees();
  map.setTrees(trees);
  const done = trees.filter((t) => t.status === "done" || t.status === "missing").length;
  const started = trees.filter((t) => t.status === "partial").length;
  $("#progress").textContent = `${done} of ${trees.length} complete · ${started} started`;
  if (!$("#tree-list-panel").hidden) renderTreeList();
}

// On wide screens the form covers the right side of the map: keep the tree in the part left uncovered.
function formWidth() {
  return window.innerWidth > 720 ? Math.min(460, window.innerWidth) : 0;
}

function focusTree(t) {
  map.centerOn(t.x, t.y, 4, formWidth() / 2);
}

function onMapTap({ tree, world }) {
  $("#layers-panel").hidden = true;
  if (state.mode === "add") {
    setMode(null);
    openAddDialog(world);
    return;
  }
  if (state.mode === "move") {
    const key = state.moveKey;
    setMode(null);
    moveTreeTo(key, world);
    return;
  }
  if (tree) {
    if (map.toScreen(tree.x, tree.y)[0] > map.canvas.clientWidth - formWidth() - 30) focusTree(tree);
    openForm(tree.key);
  } else {
    showCoord(world);
  }
}

function showCoord([x, y]) {
  if (!state.pack) return;
  const { e, n } = absolute(x, y);
  $("#coord").textContent = `N ${fmt(n, 2)}  E ${fmt(e, 2)}`;
}

// ---------------------------------------------------------------- tree list
function renderTreeList() {
  const q = normalize($("#tree-search").value);
  const ul = $("#tree-list");
  ul.innerHTML = "";
  const trees = mapTrees().sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  for (const t of trees) {
    if (state.listFilter !== "all" && t.status !== state.listFilter) continue;
    if (q && !normalize(`${t.label} ${t.alt}`).includes(q)) continue;
    const rec = state.records.get(t.key);
    const li = document.createElement("li");
    li.innerHTML = `<span class="status-chip ${t.status}"></span><span class="tno"></span><span class="tsp"></span>`;
    li.querySelector(".status-chip").textContent = STATUS_LABELS[t.status];
    li.querySelector(".tno").textContent = t.label;
    li.querySelector(".tsp").textContent = speciesText(rec?.species);
    li.onclick = () => {
      focusTree(t);
      openForm(t.key);
    };
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- form
function buildConditionButtons(conditions) {
  const seg = $("#f-condition");
  seg.innerHTML = "";
  seg.style.gridTemplateColumns = `repeat(${conditions.length}, 1fr)`;
  for (const c of conditions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c;
    b.dataset.value = c;
    b.onclick = () => save({ condition: state.current.condition === c ? "" : c });
    seg.appendChild(b);
  }
}

function recordFor(key) {
  if (state.records.has(key)) return state.records.get(key);
  return blankRecord(state.job.id, state.trees.get(key));
}

async function openForm(key) {
  if (window.innerWidth < 1200) $("#tree-list-panel").hidden = true;
  state.current = recordFor(key);
  map.selected = key;
  map.draw();
  $("#form-panel").hidden = false;
  fillForm();
  await showThumbs();
}

function closeForm() {
  $("#form-panel").hidden = true;
  $("#species-results").hidden = true;
  state.current = null;
  if (map) {
    map.selected = null;
    map.draw();
  }
}

function fillForm() {
  const rec = state.current;
  const tree = state.trees.get(rec.key);
  $("#f-title").textContent = rec.new ? `Tree ${rec.no} (added in field)`
    : rec.corrected_no ? `Tree ${rec.corrected_no} (drawing: ${treeLabel(tree)})` : `Tree ${treeLabel(tree)}`;
  $("#f-new-tools").hidden = !rec.new;
  $("#f-corrected-row").hidden = !!rec.new;
  $("#f-corrected").value = rec.corrected_no || "";
  const pos = tree || rec;
  const { e, n } = absolute(pos.x, pos.y);
  $("#f-coords").textContent = `N ${fmt(n)}  E ${fmt(e)}`;
  $("#f-check").textContent = tree?.check ? `Office note: ${tree.check}` : "";
  $("#f-check").hidden = !tree?.check;
  $("#f-species").value = speciesText(rec.species);
  $("#f-species-picked").textContent = rec.species?.scientific_name
    ? [rec.species.family, rec.species.chinese_name].filter(Boolean).join(" · ")
    : rec.species?.text ? "Not in the species list: check in the office" : "";
  $("#f-height").value = rec.height_m ?? "";
  $("#f-girth").value = rec.girth_m ?? "";
  $("#f-crown").value = rec.crown_m ?? "";
  $("#f-multistem").checked = !!rec.multi_stem;
  $("#f-remarks").value = rec.remarks || "";
  updateFormState();
}

function updateFormState() {
  const rec = state.current;
  const status = statusOf(rec);
  const chip = $("#f-status");
  chip.className = `status-chip ${status}`;
  chip.textContent = STATUS_LABELS[status];
  $$("#f-condition button").forEach((b) => b.classList.toggle("on", b.dataset.value === rec.condition));
  $("#f-done").textContent = rec.status === "done" ? "Reopen" : "Mark complete";
  $("#f-missing").textContent = rec.status === "missing" ? "Found it" : "Not found";
  $("#f-saved").textContent = rec.updated
    ? `Saved on this tablet ${new Date(rec.updated).toLocaleString("en-SG")}${rec.surveyor ? ` by ${rec.surveyor}` : ""}` +
      (rec.exported === rec.updated ? " · exported" : "")
    : "";
  $("#f-warn").textContent = rangeWarnings(rec).join(" ");
}

function rangeWarnings(rec) {
  const w = [];
  if (rec.height_m != null && (rec.height_m < 0.5 || rec.height_m > 50)) w.push("Check height.");
  if (rec.girth_m != null && (rec.girth_m < 0.05 || rec.girth_m > 12)) w.push("Check girth: metres, not cm.");
  if (rec.crown_m != null && (rec.crown_m < 0.5 || rec.crown_m > 40)) w.push("Check crown spread.");
  return w;
}

async function save(changes) {
  const rec = state.current;
  if (!rec) return;
  Object.assign(rec, changes);
  const now = new Date().toISOString();
  rec.updated = now;
  rec.created = rec.created || now;
  if (state.surveyor) rec.surveyor = state.surveyor;
  state.records.set(rec.key, rec);
  await db.putRecord(rec);
  updateFormState();
  refreshTrees();
}

function numberInput(sel, field) {
  const el = $(sel);
  el.addEventListener("change", () => {
    const v = el.value.trim() === "" ? null : Number(el.value);
    save({ [field]: Number.isFinite(v) ? Math.round(v * 100) / 100 : null });
  });
}

// ---------------------------------------------------------------- photos
async function showThumbs() {
  const rec = state.current;
  for (const slot of $$(".photo-slot")) {
    const kind = slot.dataset.kind;
    const thumb = slot.querySelector(".thumb");
    const img = thumb.querySelector("img");
    if (state.thumbUrls[kind]) URL.revokeObjectURL(state.thumbUrls[kind]);
    state.thumbUrls[kind] = null;
    const id = rec.photos?.[kind];
    const photo = id ? await db.getPhoto(id) : null;
    if (state.current !== rec) return;   // another tree was opened meanwhile
    if (photo) {
      state.thumbUrls[kind] = URL.createObjectURL(photo.blob);
      img.src = state.thumbUrls[kind];
    } else {
      img.removeAttribute("src");
    }
    thumb.classList.toggle("has", !!photo);
    slot.querySelector("[data-remove]").hidden = !photo;
  }
}

async function addPhoto(kind, file) {
  const rec = state.current;
  if (!rec || !file) return;
  toast("Saving photo…", 1500);
  try {
    const { blob, width, height } = await compressPhoto(file);
    const id = `${rec.jobId}|${rec.key}|${kind}`;
    await db.putPhoto({ id, jobId: rec.jobId, key: rec.key, kind, blob, width, height, taken: new Date().toISOString() });
    if (state.current !== rec) return;
    await save({ photos: { ...rec.photos, [kind]: id } });
    await showThumbs();
    toast(`${kind === "whole" ? "Whole tree" : kind[0].toUpperCase() + kind.slice(1)} photo saved (${(blob.size / 1024).toFixed(0)} KB)`);
  } catch (err) {
    alert(`The photo could not be saved: ${err.message}`);
  }
}

async function removePhoto(kind) {
  const rec = state.current;
  const id = rec?.photos?.[kind];
  if (!id || !confirm(`Remove the ${kind} photo of this tree?`)) return;
  await db.deletePhoto(id);
  const photos = { ...rec.photos };
  delete photos[kind];
  await save({ photos });
  await showThumbs();
}

// ---------------------------------------------------------------- species search
function searchSpecies(text) {
  const q = normalize(text);
  if (q.length < 2) return [];
  const scored = [];
  for (const s of state.species) {
    if (!s.hay.includes(q)) continue;
    const score = s.com === q || s.sci === q ? 0 : s.com.startsWith(q) || s.sci.startsWith(q) ? 1 : 2;
    scored.push([score, s.r.common_name, s.r]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, 30).map((x) => x[2]);
}

function showSpeciesResults() {
  const text = $("#f-species").value;
  const ul = $("#species-results");
  ul.innerHTML = "";
  if (!text.trim() || text === speciesText(state.current?.species)) {
    ul.hidden = true;
    return;
  }
  const add = (html, fill, onPick) => {
    const li = document.createElement("li");
    li.innerHTML = html;
    fill(li);
    li.addEventListener("pointerdown", (e) => {
      e.preventDefault();       // keep the focus so blur does not run first
      onPick();
    });
    ul.appendChild(li);
  };
  for (const r of searchSpecies(text)) {
    add(`<div><b></b> <span class="sci"></span></div><div class="alt"></div>`, (li) => {
      li.querySelector("b").textContent = r.common_name;
      li.querySelector(".sci").textContent = r.scientific_name;
      li.querySelector(".alt").textContent = [r.chinese_name, r.other_names, r.family].filter(Boolean).join(" · ");
    }, () => pickSpecies({ scientific_name: r.scientific_name, common_name: r.common_name,
      chinese_name: r.chinese_name, family: r.family }));
  }
  add(`<div></div><div class="alt">Keep the name as typed; the office checks it</div>`, (li) => {
    li.querySelector("div").textContent = `Use “${text.trim()}”`;
  }, () => pickSpecies({ text: text.trim() }));
  ul.hidden = false;
}

function pickSpecies(species) {
  $("#species-results").hidden = true;
  $("#f-species").value = speciesText(species);
  save({ species }).then(fillForm);
  $("#f-species").blur();
}

// ---------------------------------------------------------------- status buttons
async function markDone() {
  const rec = state.current;
  if (rec.status === "done") {
    await save({ status: "" });
    return;
  }
  const missing = missingItems(rec);
  if (missing.length && !confirm(`Still missing: ${missing.join(", ")}.\n\nMark this tree complete anyway?`)) return;
  await save({ status: "done" });
  toast(`Tree ${rec.corrected_no || rec.no || rec.key} complete`);
}

// The number found on site, when the drawing has the wrong one. The drawing's number stays the tree's key.
function setCorrected(value) {
  const rec = state.current;
  if (!rec || rec.new) return;
  const tree = state.trees.get(rec.key);
  let no = value.trim();
  if (no === tree?.no) no = "";
  if (no === (rec.corrected_no || "")) return;
  if (no && numberInUse(no, rec.key)) toast(`Number ${no} is also used by another tree: please check.`, 6000);
  save({ corrected_no: no }).then(fillForm);
}

async function markMissing() {
  const rec = state.current;
  if (rec.status === "missing") {
    await save({ status: "" });
    return;
  }
  await save({ status: "missing" });
  if (!rec.remarks) {
    $("#f-remarks").focus();
    toast("Add a remark: removed, not accessible, private property…", 5000);
  }
}

function nextTree() {
  const rec = state.current;
  const here = state.trees.get(rec?.key) || rec;
  const todo = mapTrees().filter((t) => t.status === "todo" && t.key !== rec?.key);
  if (!todo.length) {
    toast("Every tree has been visited.");
    return;
  }
  todo.sort((a, b) => Math.hypot(a.x - here.x, a.y - here.y) - Math.hypot(b.x - here.x, b.y - here.y));
  const t = todo[0];
  focusTree(t);
  openForm(t.key);
}

// ---------------------------------------------------------------- trees added in the field: add, move, delete
function setMode(mode, key = null) {
  const cancelledMove = state.mode === "move" && !mode ? state.moveKey : null;
  state.mode = mode;
  state.moveKey = key;
  $("#btn-add").classList.toggle("on", mode === "add");
  const hint = $("#map-hint");
  hint.hidden = !mode;
  hint.textContent = mode === "add" ? "Tap the map where the tree stands  ·  Cancel"
    : mode === "move" ? `Tap the new position of tree ${state.records.get(key)?.no}  ·  Cancel` : "";
  if (mode) closeForm();
  return cancelledMove;
}

function cancelMode() {
  const key = setMode(null);
  if (key) openForm(key);
}

function startMove() {
  if (state.current?.new) setMode("move", state.current.key);
}

async function moveTreeTo(key, [x, y]) {
  const rec = state.records.get(key);
  if (!rec) return;
  state.current = rec;
  await save({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  toast(`Tree ${rec.no} moved`);
  openForm(key);
}

async function deleteNewTree() {
  const rec = state.current;
  if (!rec?.new) return;
  if (!confirm(`Delete tree ${rec.no}, which was added in the field, and its photos from this tablet?`)) return;
  closeForm();
  for (const id of Object.values(rec.photos || {})) await db.deletePhoto(id);
  if (rec.exported) {
    // the office may already have this tree: keep a deletion note that goes out with the next export
    const note = { ...blankRecord(rec.jobId, { key: rec.key, no: rec.no }), new: true, deleted: true,
      x: rec.x, y: rec.y, created: rec.created, exported: rec.exported,
      updated: new Date().toISOString(), surveyor: state.surveyor || rec.surveyor };
    state.records.set(rec.key, note);
    await db.putRecord(note);
  } else {
    state.records.delete(rec.key);
    await db.deleteRecord(rec.jobId, rec.key);
  }
  refreshTrees();
  toast(`Tree ${rec.no} deleted`);
}

function openAddDialog([x, y]) {
  state.addPoint = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  const { e, n } = absolute(x, y);
  $("#add-pos").textContent = `Position from the map: N ${fmt(n, 2)}  E ${fmt(e, 2)} (approximate)`;
  $("#add-no").value = "";
  $("#add-error").textContent = "";
  $("#add-dialog").showModal();
}

async function confirmAdd(event) {
  const no = $("#add-no").value.trim();
  const live = state.records.get(no);
  const taken = state.trees.has(no) || (live && !live.deleted) || numberInUse(no);
  if (!no || taken) {
    event.preventDefault();
    $("#add-error").textContent = no ? `Tree ${no} already exists.` : "Enter a tree number.";
    return;
  }
  const [x, y] = state.addPoint;
  state.current = { ...blankRecord(state.job.id, { key: no, no }), new: true, x, y };
  await save({});
  map.selected = no;
  $("#form-panel").hidden = false;
  fillForm();
  await showThumbs();
}

// ---------------------------------------------------------------- my position
function stopLocate() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $("#btn-locate").classList.remove("on");
  if (map) {
    map.location = null;
    map.draw();
  }
}

function toggleLocate() {
  if (state.watchId !== null) {
    stopLocate();
    return;
  }
  if (!navigator.geolocation) {
    toast("This device has no location service.");
    return;
  }
  let first = true;
  $("#btn-locate").classList.add("on");
  state.watchId = navigator.geolocation.watchPosition((pos) => {
    const [e, n] = window.proj4("EPSG:4326", SVY21, [pos.coords.longitude, pos.coords.latitude]);
    const [e0, n0] = state.pack.origin;
    map.location = { x: e - e0, y: n - n0, acc: pos.coords.accuracy };
    if (first) {
      first = false;
      map.centerOn(e - e0, n - n0, 2);
      toast(`Position accuracy about ${Math.round(pos.coords.accuracy)} m`);
    }
    map.draw();
  }, (err) => {
    stopLocate();
    toast(`Location not available: ${err.message}`, 5000);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

// ---------------------------------------------------------------- export
function openExport() {
  closeForm();
  $("#exp-changed").textContent = exportCandidates(state.records, "changed").length;
  $("#exp-all").textContent = exportCandidates(state.records, "all").length;
  $("#exp-status").textContent = "";
  $("#exp-go").disabled = false;
  $("#export-dialog").showModal();
}

async function runExport(event) {
  event.preventDefault();
  const mode = document.querySelector("input[name=export-mode]:checked").value;
  if (!exportCandidates(state.records, mode).length) {
    $("#exp-status").textContent = "Nothing to export.";
    return;
  }
  $("#exp-go").disabled = true;
  try {
    const result = await buildResultsZip({
      job: state.job, pack: state.pack, records: state.records, mode, getPhoto: (id) => db.getPhoto(id),
      onProgress: (i, n) => ($("#exp-status").textContent = `Packing tree ${i} of ${n}…`),
    });
    $("#exp-status").textContent = `${result.name}: ${result.exported.length} trees, ${result.photoCount} photos, ` +
      `${(result.blob.size / 1048576).toFixed(1)} MB`;
    const how = await shareOrDownload(result.blob, result.name);
    if (how === "cancelled") {
      $("#exp-go").disabled = false;
      return;
    }
    for (const rec of result.exported) rec.exported = rec.updated;
    await db.putRecords(result.exported);
    $("#export-dialog").close();
    refreshTrees();
    toast(how === "shared" ? `Sent ${result.name}`
      : `Saved ${result.name} to Downloads. Send it to the office from the Files app.`, 8000);
  } catch (err) {
    $("#exp-status").textContent = `Export failed: ${err.message}`;
    $("#exp-go").disabled = false;
  }
}

// ---------------------------------------------------------------- OneMap base map
function makeGeo([e0, n0]) {
  return {
    toLonLat: (x, y) => window.proj4(SVY21, "EPSG:4326", [e0 + x, n0 + y]),
    fromLonLat: (lon, lat) => {
      const [e, n] = window.proj4("EPSG:4326", SVY21, [lon, lat]);
      return [e - e0, n - n0];
    },
  };
}

function applyBasemap(changes = null) {
  if (changes) {
    Object.assign(state.basemap, changes);
    db.setSetting("basemap", state.basemap);
  }
  const b = state.basemap;
  map.setBasemap(b);
  $("#bm-on").checked = b.on;
  $("#bm-opacity").value = b.opacity;
  $("#bm-contrast").value = b.contrast;
  $$("#bm-styles .chip").forEach((c) => c.classList.toggle("on", c.dataset.style === b.style));
  $("#onemap-attr").hidden = !b.on;
  $("#btn-layers").classList.toggle("on", b.on);
}

function onTileError() {
  if (!state.basemap.on || Date.now() - (onTileError.last || 0) < 60000) return;
  onTileError.last = Date.now();
  toast(navigator.onLine ? "Some OneMap base map tiles could not be loaded." :
    "No internet connection: the OneMap base map is not available. The drawing and trees still work.", 6000);
}

// ---------------------------------------------------------------- start
async function openFromLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("pack")) {
    try {
      const res = await fetch(params.get("pack"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadPack(await res.json());
      return true;
    } catch (err) {
      alert(`Could not open the field pack from the link: ${err.message}`);
    }
  }
  if (params.get("job") && (await db.getJob(params.get("job")))) {
    await openJob(params.get("job"));
    return true;
  }
  return false;
}

function bind() {
  $("#pack-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) readPackFile(file);
  });
  const surveyorInput = $("#surveyor-home");
  surveyorInput.value = state.surveyor;
  surveyorInput.addEventListener("change", async () => {
    state.surveyor = surveyorInput.value.trim();
    await db.setSetting("surveyor", state.surveyor);
  });

  $("#btn-home").onclick = showHome;
  $("#btn-list").onclick = () => {
    const panel = $("#tree-list-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderTreeList();
  };
  $("#btn-locate").onclick = toggleLocate;
  $("#btn-add").onclick = () => (state.mode === "add" ? cancelMode() : setMode("add"));
  $("#map-hint").onclick = cancelMode;
  $("#btn-export").onclick = openExport;
  $("#btn-layers").onclick = () => ($("#layers-panel").hidden = !$("#layers-panel").hidden);
  $("#bm-on").addEventListener("change", (e) => applyBasemap({ on: e.target.checked }));
  $("#bm-opacity").addEventListener("input", (e) => applyBasemap({ opacity: Number(e.target.value) }));
  $("#bm-contrast").addEventListener("input", (e) => applyBasemap({ contrast: Number(e.target.value) }));
  $$("#bm-styles .chip").forEach((c) => (c.onclick = () => applyBasemap({ style: c.dataset.style, on: true })));
  $("#zoom-in").onclick = () => map.zoomBy(1.6);
  $("#zoom-out").onclick = () => map.zoomBy(1 / 1.6);
  $("#zoom-fit").onclick = () => map.fit(state.pack.view);
  $$("[data-close]").forEach((b) => (b.onclick = () => ($(`#${b.dataset.close}`).hidden = true)));
  $("#tree-search").addEventListener("input", renderTreeList);
  $$("#tree-filters .chip").forEach((chip) => (chip.onclick = () => {
    state.listFilter = chip.dataset.filter;
    $$("#tree-filters .chip").forEach((c) => c.classList.toggle("on", c === chip));
    renderTreeList();
  }));

  $("#f-close").onclick = closeForm;
  numberInput("#f-height", "height_m");
  numberInput("#f-girth", "girth_m");
  numberInput("#f-crown", "crown_m");
  $("#f-multistem").addEventListener("change", (e) => save({ multi_stem: e.target.checked }));
  $("#f-remarks").addEventListener("change", (e) => save({ remarks: e.target.value.trim() }));
  $("#f-species").addEventListener("input", showSpeciesResults);
  $("#f-species").addEventListener("focus", showSpeciesResults);
  $("#f-species").addEventListener("blur", () => {
    $("#species-results").hidden = true;
    const text = $("#f-species").value.trim();
    if (!state.current || text === speciesText(state.current.species)) return;
    save({ species: text ? { text } : null }).then(fillForm);
  });
  $("#f-done").onclick = markDone;
  $("#f-missing").onclick = markMissing;
  $("#f-next").onclick = nextTree;
  $("#f-corrected").addEventListener("change", (e) => setCorrected(e.target.value));
  $("#f-move").onclick = startMove;
  $("#f-delete").onclick = deleteNewTree;
  for (const slot of $$(".photo-slot")) {
    for (const input of slot.querySelectorAll("input[type=file]")) {
      input.addEventListener("change", (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        addPhoto(slot.dataset.kind, file);
      });
    }
    slot.querySelector("[data-remove]").onclick = () => removePhoto(slot.dataset.kind);
  }

  $("#exp-go").addEventListener("click", runExport);
  $("#add-go").addEventListener("click", confirmAdd);
  window.addEventListener("hashchange", openFromLink);
}

// Side panels start below the top bar, whose height depends on the screen width.
function trackBarHeight() {
  const update = () => {
    const bar = $("#survey .bar");
    if (bar.offsetHeight) document.documentElement.style.setProperty("--bar-h", `${bar.offsetHeight}px`);
  };
  new ResizeObserver(update).observe($("#survey .bar"));
}

async function start() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  $("#app-version").textContent = `Tree Field Survey ${APP_VERSION}`;
  state.surveyor = await db.getSetting("surveyor", "");
  state.basemap = { ...BASEMAP_DEFAULT, ...(await db.getSetting("basemap", {})) };
  map = new TopoMap($("#map"), { onTap: onMapTap, onMove: showCoord, onTileError });
  bind();
  applyBasemap();
  trackBarHeight();
  if (!(await openFromLink())) await showHome();
}

// For checks from the browser console during development.
window.treefield = { state, db, addPhoto, openForm, loadPack, map: () => map };

start();
