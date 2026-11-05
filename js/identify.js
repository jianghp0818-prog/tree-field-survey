// Online species identification with Pl@ntNet (my.plantnet.org). The office puts the API key in the field pack;
// Pl@ntNet accepts it from the browser only for the domains authorised in that account.
// The leaf photo and the third photo (flower, fruit or bark) are sent, never the whole-tree photo (it may show
// people or number plates), at most 1280 px, JPEG 90 %. Each photo is labelled with its organ.

import { compressPhoto } from "./photos.js";

const API = "https://my-api.plantnet.org/v2/identify/";
const SEND_SIDE = 1280;     // Pl@ntNet scales images to this size anyway
const ASK_RESULTS = 5;      // more than shown, so the family hint has something to go on

export function identifyAvailable(pack) {
  const cfg = pack?.species_id;
  return Boolean(cfg && cfg.tablet && cfg.api_key);
}

// photos: [{blob, organ}] with organ leaf, flower, fruit or bark. Returns {results, organs, remaining}: results empty
// when Pl@ntNet does not recognise a plant; organs = what Pl@ntNet sees in each photo [{sent, seen, score}].
export async function identifyOnline(cfg, photos) {
  const form = new FormData();
  for (const p of photos) {
    const { blob } = await compressPhoto(p.blob, SEND_SIDE, 0.9);
    form.append("images", blob, `${p.organ}.jpg`);
    form.append("organs", p.organ);
  }
  const url = `${API}${encodeURIComponent(cfg.project || "all")}?api-key=${encodeURIComponent(cfg.api_key)}` +
    `&nb-results=${ASK_RESULTS}&lang=en&include-related-images=false`;
  let res;
  try {
    res = await fetch(url, { method: "POST", body: form });
  } catch {
    throw new Error("Pl@ntNet could not be reached. Check the internet connection.");
  }
  if (res.status === 404) return { results: [], organs: [], remaining: null };
  if (res.status === 429) throw new Error("Today's Pl@ntNet identifications are used up; try again tomorrow.");
  if (res.status === 401 || res.status === 403) {
    throw new Error("Pl@ntNet refused the key. The office should check the key, and that the Pl@ntNet account " +
      `lists ${location.origin} under Authorized domains.`);
  }
  if (!res.ok) throw new Error(`Pl@ntNet answered with an error (${res.status}).`);
  const data = await res.json();
  const sent = Object.fromEntries(photos.map((p) => [`${p.organ}.jpg`, p.organ]));
  return {
    remaining: data.remainingIdentificationRequests ?? null,
    organs: (data.predictedOrgans || []).map((o) => ({ sent: sent[o.filename] || "", seen: o.organ,
      score: Math.round((o.score || 0) * 100) / 100 })),
    results: (data.results || []).slice(0, ASK_RESULTS).map((r) => ({
      scientific_name: r.species?.scientificNameWithoutAuthor || "",
      common_name: r.species?.commonNames?.[0] || "",
      family: r.species?.family?.scientificNameWithoutAuthor || "",
      score: Math.round((r.score || 0) * 1000) / 1000,
    })),
  };
}
