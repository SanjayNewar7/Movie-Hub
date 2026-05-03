// netlify/functions/movies.js
// Movie Hub — Paginated API with In-Memory Cache + Single Blob Pattern
//
// NEW PAGINATION PARAMS:
//   ?page=1          — page number (1-based, default 1)
//   ?limit=20        — items per page (default 20, max 100)
//   ?cursor=<id>     — cursor-based (alternative to page; more efficient)
//
// RESPONSE ENVELOPE NOW INCLUDES:
//   pagination: { page, limit, total, totalPages, hasNext, hasPrev, nextCursor }

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const INDEX_KEY = "movies_index";

// ── IN-MEMORY CACHE (30s TTL) ────────────────────────────────────────────────
let memoryCache = {
  movies: null,
  lastFetch: 0,
  ttl: 30000,
};

function isCacheValid() {
  return memoryCache.movies !== null &&
    Date.now() - memoryCache.lastFetch < memoryCache.ttl;
}

function getCachedMovies() {
  if (isCacheValid()) {
    console.log(`📦 Memory cache hit (${memoryCache.movies.length} movies)`);
    return memoryCache.movies;
  }
  return null;
}

function setCachedMovies(movies) {
  memoryCache.movies = movies;
  memoryCache.lastFetch = Date.now();
  console.log(`💾 Cached ${movies.length} movies (TTL: ${memoryCache.ttl}ms)`);
}

function invalidateCache() {
  memoryCache.movies = null;
  memoryCache.lastFetch = 0;
  console.log("🗑️ Cache invalidated");
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    // Short CDN cache — aligns with memory cache TTL
    "Cache-Control": "public, max-age=30, s-maxage=30",
  };
}

function jsonResponse(statusCode, data) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: corsHeaders(),
  });
}

function corsResponse() {
  return new Response("", { status: 204, headers: corsHeaders() });
}

function generateId() {
  return `movie_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function verifyAuth(headers) {
  const auth = headers["authorization"] || headers["Authorization"] || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === ADMIN_PASSWORD;
}

async function getMoviesIndex(store) {
  const cached = getCachedMovies();
  if (cached) return cached;

  console.log("📡 Cache miss — fetching from blob storage...");
  try {
    const index = await store.get(INDEX_KEY, { type: "json" });
    const movies = index || [];
    if (movies.length > 0) setCachedMovies(movies);
    return movies;
  } catch (err) {
    console.error("Error reading index:", err);
    return [];
  }
}

async function saveMoviesIndex(store, index) {
  await store.setJSON(INDEX_KEY, index);
  setCachedMovies(index);
}

async function runMigration(store, ratingStore) {
  console.log("🚀 Running migration to build movies_index...");
  const { blobs } = await store.list();
  const movies = [];
  const movieBlobs = blobs.filter((b) => b.key !== INDEX_KEY);

  for (const blob of movieBlobs) {
    const movie = await store.get(blob.key, { type: "json" });
    if (movie) {
      const rating = await ratingStore
        .get(blob.key, { type: "json" })
        .catch(() => null);
      movies.push({
        ...movie,
        rating: rating || {
          averageRating: 0,
          totalRatings: 0,
          breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
        },
      });
    }
  }

  movies.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  await saveMoviesIndex(store, movies);
  console.log(`✅ Migration complete — indexed ${movies.length} movies.`);
  return movies;
}

// ── PAGINATION HELPER ─────────────────────────────────────────────────────────
// Supports both page-based and cursor-based pagination.
//
// Page-based:   ?page=2&limit=20
// Cursor-based: ?cursor=movie_1720000000_abc123&limit=20
//   → cursor is the ID of the LAST item on the previous page.
//   → More efficient for large datasets (no offset scan).

function paginateMovies(movies, params) {
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "20", 10), 1), 100);
  const cursor = params.get("cursor") || null;
  const pageParam = parseInt(params.get("page") || "1", 10);

  let startIndex = 0;

  if (cursor) {
    // Cursor-based: find position after the cursor ID
    const cursorIndex = movies.findIndex((m) => m.id === cursor);
    startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  } else {
    // Page-based
    const page = Math.max(pageParam, 1);
    startIndex = (page - 1) * limit;
  }

  const slice = movies.slice(startIndex, startIndex + limit);
  const total = movies.length;
  const totalPages = Math.ceil(total / limit);
  const currentPage = cursor ? null : pageParam; // null when cursor mode
  const hasNext = startIndex + limit < total;
  const hasPrev = cursor ? true : pageParam > 1;
  const nextCursor = hasNext && slice.length > 0 ? slice[slice.length - 1].id : null;

  return {
    movies: slice,
    pagination: {
      page: currentPage,
      limit,
      total,
      totalPages: cursor ? null : totalPages,
      hasNext,
      hasPrev,
      nextCursor,            // Use this as ?cursor= on the next request
      currentCount: slice.length,
    },
  };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async (req, context) => {
  if (req.method === "OPTIONS") return corsResponse();

  const store = getStore({ name: "movies", consistency: "strong" });
  const ratingStore = getStore({ name: "ratings", consistency: "strong" });
  const url = new URL(req.url);
  const pathParts = url.pathname
    .replace(/^\/api\/movies\/?|^\/.netlify\/functions\/movies\/?/, "")
    .split("/")
    .filter(Boolean);
  const movieId = pathParts[0];

  // ── HEALTH / WARMUP ────────────────────────────────────────────────────────
  if (
    req.method === "GET" &&
    (url.pathname.includes("/health") ||
      url.pathname.includes("/warmup") ||
      url.pathname.includes("/init") ||
      url.pathname.includes("/cache"))
  ) {
    try {
      let index = await getMoviesIndex(store);
      let migrated = false;
      if (index.length === 0) {
        index = await runMigration(store, ratingStore);
        migrated = true;
      }
      return jsonResponse(200, {
        status: "healthy",
        timestamp: Date.now(),
        movieCount: index.length,
        migrated,
        cache: {
          isCached: memoryCache.movies !== null,
          cacheAge: memoryCache.movies ? Date.now() - memoryCache.lastFetch : null,
          cacheTTL: memoryCache.ttl,
          cacheValid: isCacheValid(),
        },
      });
    } catch (err) {
      return jsonResponse(500, { error: "Health check failed: " + err.message });
    }
  }

  // ── CACHE INVALIDATION (admin) ─────────────────────────────────────────────
  if (req.method === "POST" && pathParts[0] === "invalidate-cache") {
    const headers = Object.fromEntries(req.headers.entries());
    if (!verifyAuth(headers))
      return jsonResponse(401, { error: "Unauthorized." });
    invalidateCache();
    return jsonResponse(200, { success: true, message: "Cache invalidated." });
  }

  // ── MIGRATION (admin) ──────────────────────────────────────────────────────
  if (req.method === "POST" && pathParts[0] === "migrate") {
    const headers = Object.fromEntries(req.headers.entries());
    if (!verifyAuth(headers))
      return jsonResponse(401, { error: "Unauthorized." });
    try {
      const movies = await runMigration(store, ratingStore);
      return jsonResponse(200, { success: true, count: movies.length });
    } catch (err) {
      return jsonResponse(500, { error: "Migration failed: " + err.message });
    }
  }

  // ── PUBLIC GET ─────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      let movies = await getMoviesIndex(store);
      if (movies.length === 0) {
        movies = await runMigration(store, ratingStore);
      }

      // Single movie by ID
      if (movieId && movieId !== "health" && movieId !== "cache") {
        const movie = movies.find((m) => m.id === movieId);
        if (!movie) return jsonResponse(404, { error: "Movie not found" });
        return jsonResponse(200, { success: true, movie });
      }

      // ── Apply text/field filters first ──
      const qTitle   = url.searchParams.get("title")?.trim().toLowerCase()  || "";
      const qGenre   = url.searchParams.get("genre")?.trim().toLowerCase()  || "";
      const qYear    = url.searchParams.get("year")?.trim()                 || "";
      const qCast    = url.searchParams.get("cast")?.trim().toLowerCase()   || "";
      const qGlobal  = url.searchParams.get("q")?.trim().toLowerCase()      || "";

      let results = [...movies];

      if (qTitle)  results = results.filter((m) => m.title?.toLowerCase().includes(qTitle));
      if (qGenre)  results = results.filter((m) => m.genre?.toLowerCase().includes(qGenre));
      if (qYear)   results = results.filter((m) => String(m.year) === qYear);
      if (qCast)   results = results.filter((m) => (m.cast || []).some((c) => c.toLowerCase().includes(qCast)));
      if (qGlobal) {
        results = results.filter(
          (m) =>
            m.title?.toLowerCase().includes(qGlobal) ||
            m.genre?.toLowerCase().includes(qGlobal) ||
            m.description?.toLowerCase().includes(qGlobal) ||
            m.distributor?.toLowerCase().includes(qGlobal) ||
            String(m.year).includes(qGlobal) ||
            (m.cast || []).some((c) => c.toLowerCase().includes(qGlobal))
        );
      }

      // ── Apply pagination ──
      // If ?all=true is passed, skip pagination (used for full local cache warm-up)
      const fetchAll = url.searchParams.get("all") === "true";

      if (fetchAll) {
        // Return ALL records (used on first app load to warm local cache)
        const appliedFilters = {};
        if (qTitle)  appliedFilters.title  = qTitle;
        if (qGenre)  appliedFilters.genre  = qGenre;
        if (qYear)   appliedFilters.year   = qYear;
        if (qCast)   appliedFilters.cast   = qCast;
        if (qGlobal) appliedFilters.q      = qGlobal;

        return jsonResponse(200, {
          success: true,
          count: results.length,
          filters: Object.keys(appliedFilters).length ? appliedFilters : undefined,
          movies: results,
          pagination: {
            page: 1,
            limit: results.length,
            total: results.length,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
            nextCursor: null,
            currentCount: results.length,
          },
        });
      }

      const paginated = paginateMovies(results, url.searchParams);

      const appliedFilters = {};
      if (qTitle)  appliedFilters.title  = qTitle;
      if (qGenre)  appliedFilters.genre  = qGenre;
      if (qYear)   appliedFilters.year   = qYear;
      if (qCast)   appliedFilters.cast   = qCast;
      if (qGlobal) appliedFilters.q      = qGlobal;

      return jsonResponse(200, {
        success: true,
        count: paginated.movies.length,
        filters: Object.keys(appliedFilters).length ? appliedFilters : undefined,
        movies: paginated.movies,
        pagination: paginated.pagination,
      });
    } catch (err) {
      console.error("GET error:", err);
      return jsonResponse(500, { error: "Failed to fetch movies: " + err.message });
    }
  }

  // ── PROTECTED WRITE ROUTES ─────────────────────────────────────────────────
  const headers = Object.fromEntries(req.headers.entries());
  if (!verifyAuth(headers)) {
    return jsonResponse(401, { error: "Unauthorized. Provide a valid Bearer token." });
  }

  // POST — Create
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const { title, youtubeLink, distributor, cast, genre, year, description, thumbnail } = body;
      if (!title || !year) return jsonResponse(400, { error: "title and year are required" });

      const id = generateId();
      const movie = {
        id,
        title,
        youtubeLink:  youtubeLink  || "",
        distributor:  distributor  || "",
        cast: Array.isArray(cast) ? cast : (cast ? cast.split(",").map((s) => s.trim()) : []),
        genre:        genre        || "",
        year:         parseInt(year),
        description:  description  || "",
        thumbnail:    thumbnail    || "",
        rating: { averageRating: 0, totalRatings: 0, breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await store.setJSON(id, movie);
      const index = await getMoviesIndex(store);
      index.unshift(movie);
      await saveMoviesIndex(store, index);
      return jsonResponse(201, { success: true, movie });
    } catch (err) {
      return jsonResponse(500, { error: "Failed to create movie: " + err.message });
    }
  }

  // PUT — Update
  if (req.method === "PUT") {
    if (!movieId) return jsonResponse(400, { error: "Movie ID required in path." });
    try {
      const index = await getMoviesIndex(store);
      const idx = index.findIndex((m) => m.id === movieId);
      if (idx === -1) return jsonResponse(404, { error: "Movie not found" });

      const body = await req.json();
      const updated = {
        ...index[idx],
        ...body,
        id: movieId,
        cast: body.cast
          ? Array.isArray(body.cast) ? body.cast : body.cast.split(",").map((s) => s.trim())
          : index[idx].cast,
        year: body.year ? parseInt(body.year) : index[idx].year,
        updatedAt: new Date().toISOString(),
        rating: index[idx].rating,
      };

      await store.setJSON(movieId, updated);
      index[idx] = updated;
      await saveMoviesIndex(store, index);
      return jsonResponse(200, { success: true, movie: updated });
    } catch (err) {
      return jsonResponse(500, { error: "Failed to update movie: " + err.message });
    }
  }

  // DELETE
  if (req.method === "DELETE") {
    if (!movieId) return jsonResponse(400, { error: "Movie ID required in path." });
    try {
      const index = await getMoviesIndex(store);
      const idx = index.findIndex((m) => m.id === movieId);
      if (idx === -1) return jsonResponse(404, { error: "Movie not found" });

      const deletedMovie = index[idx];
      await store.delete(movieId);
      await ratingStore.delete(movieId).catch(() => {});
      const newIndex = index.filter((m) => m.id !== movieId);
      await saveMoviesIndex(store, newIndex);
      return jsonResponse(200, { success: true, message: `"${deletedMovie.title}" deleted.`, deletedId: movieId });
    } catch (err) {
      return jsonResponse(500, { error: "Failed to delete movie: " + err.message });
    }
  }

  return jsonResponse(405, { error: "Method not allowed" });
};

export const config = {
  path: ["/api/movies", "/api/movies/*"],
};
