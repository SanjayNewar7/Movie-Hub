// netlify/functions/ratings.js
// Movie Hub – Ratings API
// GET  /api/ratings/{movieId}  → public, returns aggregated rating
// POST /api/ratings/{movieId}  → public, submit a 1-5 star rating
// No authentication required for either method.
//
// Storage schema (Netlify Blobs, store: "ratings"):
//   key = movieId
//   value = {
//     movieId,
//     totalRatings,      // total number of votes
//     sumOfRatings,      // raw sum used to compute average
//     averageRating,     // rounded to 1 decimal
//     breakdown: { "1": n, "2": n, "3": n, "4": n, "5": n }
//     lastRatedAt,
//   }

import { getStore } from "@netlify/blobs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

function emptyRating(movieId) {
  return {
    movieId,
    totalRatings: 0,
    sumOfRatings: 0,
    averageRating: 0,
    breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    lastRatedAt: null,
  };
}

export default async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  // Extract movieId from path:  /api/ratings/{movieId}
  const pathParts = url.pathname
    .replace(/^\/api\/ratings\/?|^\/.netlify\/functions\/ratings\/?/, "")
    .split("/")
    .filter(Boolean);
  const movieId = pathParts[0];

  if (!movieId) {
    return json(400, { error: "movieId is required in path: /api/ratings/{movieId}" });
  }

  // Verify the referenced movie actually exists
  const movieStore  = getStore({ name: "movies",  consistency: "strong" });
  const ratingStore = getStore({ name: "ratings", consistency: "strong" });

  // ── GET /api/ratings/{movieId} ────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const existing = await ratingStore.get(movieId, { type: "json" }).catch(() => null);
      const rating = existing || emptyRating(movieId);
      return json(200, { success: true, rating });
    } catch (err) {
      console.error("Ratings GET error:", err);
      return json(500, { error: "Failed to fetch rating" });
    }
  }

  // ── POST /api/ratings/{movieId} ───────────────────────────────────────────
  if (req.method === "POST") {
    try {
      // Validate movie exists
      const movie = await movieStore.get(movieId, { type: "json" }).catch(() => null);
      if (!movie) return json(404, { error: "Movie not found" });

      // Parse and validate star value
      const body = await req.json();
      const star = parseInt(body.rating);
      if (!star || star < 1 || star > 5) {
        return json(400, { error: "rating must be an integer between 1 and 5" });
      }

      // Fetch existing rating doc (or init fresh)
      let rating = await ratingStore.get(movieId, { type: "json" }).catch(() => null);
      if (!rating) rating = emptyRating(movieId);

      // Aggregate
      rating.totalRatings  += 1;
      rating.sumOfRatings  += star;
      rating.breakdown[String(star)] = (rating.breakdown[String(star)] || 0) + 1;
      rating.averageRating = Math.round((rating.sumOfRatings / rating.totalRatings) * 10) / 10;
      rating.lastRatedAt   = new Date().toISOString();

      await ratingStore.setJSON(movieId, rating);

      return json(201, {
        success: true,
        message: `Thank you! Your ${star}-star rating has been recorded.`,
        rating,
      });
    } catch (err) {
      console.error("Ratings POST error:", err);
      return json(500, { error: "Failed to submit rating" });
    }
  }

  return json(405, { error: "Method not allowed. Use GET or POST." });
};

export const config = {
  path: ["/api/ratings/*"],
};
