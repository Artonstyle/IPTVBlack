/* global fetch, process */
"use strict";

// Imports a catalog JSON document that you own or are authorized to use.
// Required environment variables: SUPABASE_URL, SUPABASE_KEY, CATALOG_JSON_URL
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseKey = String(process.env.SUPABASE_KEY || "").trim();
const catalogUrl = String(process.env.CATALOG_JSON_URL || "").trim();

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

async function supabase(path, options) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${await response.text()}`);
}

function normalizeItem(value) {
  const id = text(value.id || value.slug);
  const title = text(value.title);
  if (!id || !title) throw new Error("Every item needs id (or slug) and title");
  return {
    movie: {
      id,
      title,
      type: text(value.type).toLowerCase() === "series" ? "series" : "movie",
      year: text(value.year),
      poster: text(value.poster),
      description: text(value.description),
      url: text(value.url),
      source: text(value.source || "authorized-catalog"),
      updated_at: new Date().toISOString()
    },
    hosters: Array.isArray(value.hosters) ? value.hosters : []
  };
}

async function main() {
  required(supabaseUrl, "SUPABASE_URL");
  required(supabaseKey, "SUPABASE_KEY");
  required(catalogUrl, "CATALOG_JSON_URL");

  const sourceResponse = await fetch(catalogUrl);
  if (!sourceResponse.ok) throw new Error(`Catalog HTTP ${sourceResponse.status}`);
  const payload = await sourceResponse.json();
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) throw new Error("Catalog JSON must be an array or { items: [...] }");

  let imported = 0;
  for (const value of items) {
    const { movie, hosters } = normalizeItem(value);
    await supabase("movies?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(movie)
    });
    await supabase(`hosters?movie_slug=eq.${encodeURIComponent(movie.id)}`, { method: "DELETE" });
    const safeHosters = hosters
      .filter((hoster) => text(hoster && hoster.url))
      .map((hoster) => ({ movie_slug: movie.id, name: text(hoster.name || "Source"), url: text(hoster.url) }));
    if (safeHosters.length) {
      await supabase("hosters", { method: "POST", body: JSON.stringify(safeHosters) });
    }
    imported += 1;
  }
  console.log(`Imported ${imported} catalog items.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
