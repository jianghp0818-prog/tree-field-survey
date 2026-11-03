// Online species identification with Pl@ntNet (my.plantnet.org). The office puts the API key in the field pack;
// Pl@ntNet accepts it from the browser only for the domains authorised in that account.
// Only the leaf and bark photos are sent (close-ups: no people or number plates), at most 1280 px, JPEG 90 %.

import { compressPhoto } from "./photos.js";

const API = "https://my-api.plantnet.org/v2/identify/";
const SEND_SIDE = 1280;     // Pl@ntNet scales images to this size anyway

export function identifyAvailable(pack) {
  const cfg = pack?.species_id;
  return Boolean(cfg && cfg.tablet && cfg.api_key);
}

// photos: [{blob, organ}] with organ "leaf" or "bark". Returns {results: [...], remaining} - results empty when
// Pl@ntNet does not recognise a plant.
export async function identifyOnline(cfg, photos) {
  const form = new FormData();
  for (const p of photos) {
    const { blob } = await compressPhoto(p.blob, SEND_SIDE, 0.9);
    form.append("images", blob, `${p.organ}.jpg`);
    form.append("organs", p.organ);
  }
  const n = cfg.results || 3;
  const url = `${API}${encodeURIComponent(cfg.project || "all")}?api-key=${encodeURIComponent(cfg.api_key)}` +
    `&nb-results=${n}&lang=en&include-related-images=false`;
  let res;
  try {
    res = await fetch(url, { method: "POST", body: form });
  } catch {
    throw new Error("Pl@ntNet could not be reached. Check the internet connection.");
  }
  if (res.status === 404) return { results: [], remaining: null };
  if (res.status === 429) throw new Error("Today's Pl@ntNet identifications are used up; try again tomorrow.");
  if (res.status === 401 || res.status === 403) {
    throw new Error("Pl@ntNet refused the key. The office should check the key and the authorised domain.");
  }
  if (!res.ok) throw new Error(`Pl@ntNet answered with an error (${res.status}).`);
  const data = await res.json();
  return {
    remaining: data.remainingIdentificationRequests ?? null,
    results: (data.results || []).slice(0, n).map((r) => ({
      scientific_name: r.species?.scientificNameWithoutAuthor || "",
      common_name: r.species?.commonNames?.[0] || "",
      family: r.species?.family?.scientificNameWithoutAuthor || "",
      score: Math.round((r.score || 0) * 1000) / 1000,
    })),
  };
}
