/* global fetch, process */
"use strict";

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseKey = String(process.env.SUPABASE_KEY || "").trim();
const tmdbToken = String(process.env.TMDB_READ_ACCESS_TOKEN || "").trim();
const limit = Math.max(1, Math.min(Number.parseInt(process.env.TMDB_LIMIT || "100", 10) || 100, 500));

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function supabase(path, options = {}) {
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
  return response.headers.get("content-type")?.includes("application/json") ? response.json() : null;
}

async function tmdb(path, params) {
  const query = new URLSearchParams(params);
  const response = await fetch(`https://api.themoviedb.org/3/${path}?${query.toString()}`, {
    headers: { Authorization: `Bearer ${tmdbToken}`, accept: "application/json" }
  });
  if (!response.ok) throw new Error(`TMDb HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function year(value) {
  const match = String(value || "").match(/^\d{4}/);
  return match ? match[0] : "";
}

async function main() {
  required(supabaseUrl, "SUPABASE_URL");
  required(supabaseKey, "SUPABASE_KEY");
  required(tmdbToken, "TMDB_READ_ACCESS_TOKEN");

  const rows = await supabase(`movies?select=id,title,type,year,poster,description&order=updated_at.desc&limit=${limit}`);
  let enriched = 0;
  for (const row of rows) {
    const kind = row.type === "series" ? "tv" : "movie";
    const data = await tmdb(`search/${kind}`, { query: row.title, language: "de-DE", include_adult: "false", page: "1" });
    const match = data.results && data.results[0];
    if (!match) continue;
    const update = {
      id: row.id,
      title: match.title || match.name || row.title,
      year: year(match.release_date || match.first_air_date) || row.year || "",
      poster: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : row.poster || "",
      description: match.overview || row.description || "",
      updated_at: new Date().toISOString()
    };
    await supabase("movies?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(update)
    });
    enriched += 1;
  }
  console.log(`TMDb enriched ${enriched} of ${rows.length} cached catalog items.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
