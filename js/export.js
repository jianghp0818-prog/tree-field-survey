// Results zip for the office:
//   results.json   format "treefield-results", the records with absolute SVY21 coordinates
//   results.csv    the same as a table (opens in Excel)
//   photos/        <tree>_whole.jpg, <tree>_leaf.jpg, <tree>_bark.jpg

import { PHOTO_KINDS, hasData, statusOf } from "./records.js";

const CSV_COLUMNS = [
  ["Tree No.", (r) => r.no || r.key],
  ["Number on Site", (r) => r.corrected_no],
  ["Northing", (r) => r.northing?.toFixed(3)],
  ["Easting", (r) => r.easting?.toFixed(3)],
  ["Status", (r) => r.status_label],
  ["Scientific Name", (r) => r.species?.scientific_name],
  ["Common Name", (r) => r.species?.common_name],
  ["Chinese Name", (r) => r.species?.chinese_name],
  ["Species (as typed)", (r) => r.species?.text],
  ["Height (m)", (r) => r.height_m],
  ["Girth (m)", (r) => r.girth_m],
  ["Crown Spread (m)", (r) => r.crown_m],
  ["Condition", (r) => r.condition],
  ["Multi-stem", (r) => (r.multi_stem ? "Yes" : "")],
  ["Remarks", (r) => r.remarks],
  ["Added in Field", (r) => (r.new ? "Yes" : "")],
  ["Surveyor", (r) => r.surveyor],
  ["Last Saved", (r) => r.updated],
  ["Whole Tree Photo", (r) => r.photos.whole],
  ["Leaf Photo", (r) => r.photos.leaf],
  ["Bark Photo", (r) => r.photos.bark],
];
const STATUS_EXPORT = { partial: "Started", done: "Complete", missing: "Not found", todo: "", deleted: "Deleted" };

function fileKey(key) {
  return key.replace(/\?/g, "Q").replace(/#/g, "-").replace(/[^\w.-]+/g, "_");
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function exportCandidates(records, mode) {
  return [...records.values()].filter((r) => hasData(r) && (mode === "all" || r.exported !== r.updated));
}

export async function buildResultsZip({ job, pack, records, mode, getPhoto, onProgress }) {
  const trees = new Map(pack.trees.map((t) => [t.key, t]));
  const [e0, n0] = pack.origin;
  const zip = new window.JSZip();
  const list = exportCandidates(records, mode).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  const out = [];
  let photoCount = 0;
  for (const [i, rec] of list.entries()) {
    const tree = trees.get(rec.key);
    const x = tree ? tree.x : rec.x, y = tree ? tree.y : rec.y;
    const photos = {};
    for (const kind of PHOTO_KINDS) {
      const id = rec.photos?.[kind];
      if (!id) continue;
      const photo = await getPhoto(id);
      if (!photo) continue;
      const name = `photos/${fileKey(rec.key)}_${kind}.jpg`;
      zip.file(name, photo.blob, { compression: "STORE", date: new Date(photo.taken || Date.now()) });
      photos[kind] = name;
      photoCount += 1;
    }
    const { jobId, exported, photos: _ids, x: _x, y: _y, ...fields } = rec;
    const status = rec.deleted ? "deleted" : statusOf(rec);
    out.push({
      ...fields,
      status,
      status_label: STATUS_EXPORT[status],
      easting: x == null ? null : Math.round((e0 + x) * 1000) / 1000,
      northing: y == null ? null : Math.round((n0 + y) * 1000) / 1000,
      photos,
    });
    onProgress?.(i + 1, list.length);
  }
  const exportedAt = new Date().toISOString();
  const results = {
    format: "treefield-results",
    version: 1,
    job: pack.job,
    pack_id: pack.pack_id,
    crs: pack.crs,
    girth_height_m: pack.form.girth_height,
    exported: exportedAt,
    mode,
    device: navigator.userAgent,
    records: out.map(({ status_label, ...r }) => r),
  };
  zip.file("results.json", JSON.stringify(results, null, 1));
  const csv = [CSV_COLUMNS.map(([h]) => h).join(",")]
    .concat(out.map((r) => CSV_COLUMNS.map(([, f]) => csvCell(f(r))).join(",")))
    .join("\r\n");
  zip.file("results.csv", "﻿" + csv);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/zip" });
  return { blob, name: `${job.id}_results_${stamp()}.zip`, exported: list, photoCount };
}

export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: "application/zip" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
      // sharing refused (e.g. file too large): save it instead
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "downloaded";
}
