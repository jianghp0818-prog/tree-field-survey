// Field record helpers shared by the form, the map and the export.

export const PHOTO_KINDS = ["whole", "leaf", "bark"];
export const PHOTO_LABELS = { whole: "Whole tree", leaf: "Leaf", bark: "Bark" };
export const STATUS_LABELS = { todo: "To do", partial: "Started", done: "Complete", missing: "Not found" };

export function blankRecord(jobId, tree) {
  return {
    jobId,
    key: tree.key,
    no: tree.no || "",
    corrected_no: "",       // number found on site when the drawing's is wrong (drawing trees only)
    new: false,             // added in the field; then x, y hold its position from the map
    deleted: false,         // an added tree deleted after it was exported: tells the office to remove it
    species: null,          // {scientific_name, common_name, chinese_name, family} or {text} when typed freely
    height_m: null,
    girth_m: null,
    crown_m: null,
    condition: "",
    multi_stem: false,
    remarks: "",
    status: "",             // "" while being filled in, "done" or "missing"
    photos: {},             // kind -> photo id
    surveyor: "",
    created: null,
    updated: null,
    exported: null,         // value of `updated` at the last export
  };
}

export function hasData(rec) {
  if (!rec) return false;
  return Boolean(rec.new || rec.corrected_no || rec.species || rec.height_m != null || rec.girth_m != null || rec.crown_m != null ||
    rec.condition || rec.multi_stem || rec.remarks || Object.keys(rec.photos || {}).length || rec.status);
}

export function statusOf(rec) {
  if (!rec) return "todo";
  if (rec.status === "done" || rec.status === "missing") return rec.status;
  return hasData(rec) ? "partial" : "todo";
}

export function missingItems(rec) {
  const missing = PHOTO_KINDS.filter((k) => !rec.photos?.[k]).map((k) => `${PHOTO_LABELS[k].toLowerCase()} photo`);
  if (!rec.species) missing.push("species");
  if (rec.height_m == null) missing.push("height");
  if (rec.girth_m == null) missing.push("girth");
  if (rec.crown_m == null) missing.push("crown spread");
  if (!rec.condition) missing.push("condition");
  return missing;
}

export function speciesText(sp) {
  if (!sp) return "";
  if (sp.scientific_name) return `${sp.common_name || ""} (${sp.scientific_name})`.trim();
  return sp.text || "";
}
