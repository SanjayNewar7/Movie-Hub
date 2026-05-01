// netlify/functions/movies.js
// Movie Hub - OPTIMIZED API with movies_index (Single Blob Pattern)
// Reduces 500+ reads to just 1 read per request

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "moviehub2024";
const INDEX_KEY = "movies_index"; // Single blob containing ALL movies with ratings

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    // Cache headers to reduce cold starts
    "Cache-Control": "public, max-age=300, s-maxage=600",
    "CDN-Cache-Control": "public, max-age=600",
  };
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

function generateId() {
  return `movie_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function verifyAuth(headers) {
  const auth = headers["authorization"] || headers["Authorization"] || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === ADMIN_PASSWORD;
}

// Helper: Get movies index (single blob read!)
async function getMoviesIndex(store) {
  try {
    const index = await store.get(INDEX_KEY, { type: "json" });
    return index || [];
  } catch (err) {
    console.error("Error reading index:", err);
    return [];
  }
}

// Helper: Save movies index (single blob write!)
async function saveMoviesIndex(store, index) {
  await store.setJSON(INDEX_KEY, index);
}

// Helper: Update rating in index
async function updateRatingInIndex(store, ratingStore, movieId) {
  const index = await getMoviesIndex(store);
  const movieIndex = index.findIndex(m => m.id === movieId);
  
  if (movieIndex !== -1) {
    const rating = await ratingStore.get(movieId, { type: "json" }).catch(() => null);
    if (rating) {
      index[movieIndex].rating = {
        averageRating: rating.averageRating || 0,
        totalRatings: rating.totalRatings || 0,
        breakdown: rating.breakdown || { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }
      };
      await saveMoviesIndex(store, index);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// MIGRATION SCRIPT (Run once via /api/migrate endpoint)
// This builds the movies_index from existing individual blobs
// ──────────────────────────────────────────────────────────────────────────
async function runMigration(store, ratingStore) {
  console.log("🚀 Running migration to build movies_index...");
  
  const { blobs } = await store.list();
  const movies = [];
  
  // Exclude the index itself from migration
  const movieBlobs = blobs.filter(b => b.key !== INDEX_KEY);
  
  for (const blob of movieBlobs) {
    const movie = await store.get(blob.key, { type: "json" });
    if (movie) {
      const rating = await ratingStore.get(blob.key, { type: "json" }).catch(() => null);
      movies.push({
        ...movie,
        rating: rating || {
          averageRating: 0,
          totalRatings: 0,
          breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }
        }
      });
    }
  }
  
  // Sort by creation date (newest first)
  movies.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  await saveMoviesIndex(store, movies);
  console.log(`✅ Migration complete! Indexed ${movies.length} movies.`);
  return movies;
}

export default async (req, context) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }

  const store = getStore({ name: "movies", consistency: "strong" });
  const ratingStore = getStore({ name: "ratings", consistency: "strong" });
  const url = new URL(req.url);
  const pathParts = url.pathname.replace(/^\/api\/movies\/?|^\/.netlify\/functions\/movies\/?/, "").split("/").filter(Boolean);
  const movieId = pathParts[0];

  // ── MIGRATION ENDPOINT (Run once: POST /api/movies/migrate) ─────────────
  if (req.method === "POST" && pathParts[0] === "migrate") {
    const headers = Object.fromEntries(req.headers.entries());
    if (!verifyAuth(headers)) {
      return response(401, { error: "Unauthorized. Admin access required for migration." });
    }
    
    try {
      const movies = await runMigration(store, ratingStore);
      return response(200, { 
        success: true, 
        message: `Migration completed successfully`,
        count: movies.length 
      });
    } catch (err) {
      console.error("Migration error:", err);
      return response(500, { error: "Migration failed: " + err.message });
    }
  }

  // ── PUBLIC GET (No auth required) ──────────────────────────────────────
  // ✅ OPTIMIZED: Single blob read instead of 500+ reads!
  if (req.method === "GET") {
    try {
      // Get movies index (ONE blob read!)
      let movies = await getMoviesIndex(store);
      
      // If index is empty, trigger migration automatically (first run)
      if (movies.length === 0) {
        console.log("⚠️ movies_index is empty, running auto-migration...");
        movies = await runMigration(store, ratingStore);
      }
      
      if (movieId) {
        // GET single movie: /api/movies/{id}
        const movie = movies.find(m => m.id === movieId);
        if (!movie) {
          return response(404, { error: "Movie not found" });
        }
        return response(200, { success: true, movie });
      }
      
      // GET all movies with optional query filters
      const qTitle = url.searchParams.get("title")?.trim().toLowerCase() || "";
      const qGenre = url.searchParams.get("genre")?.trim().toLowerCase() || "";
      const qYear = url.searchParams.get("year")?.trim() || "";
      const qCast = url.searchParams.get("cast")?.trim().toLowerCase() || "";
      const qGlobal = url.searchParams.get("q")?.trim().toLowerCase() || "";
      
      let results = [...movies];
      
      // Apply filters
      if (qTitle) {
        results = results.filter(m => m.title?.toLowerCase().includes(qTitle));
      }
      if (qGenre) {
        results = results.filter(m => m.genre?.toLowerCase().includes(qGenre));
      }
      if (qYear) {
        results = results.filter(m => String(m.year) === qYear);
      }
      if (qCast) {
        results = results.filter(m =>
          (m.cast || []).some(c => c.toLowerCase().includes(qCast))
        );
      }
      if (qGlobal) {
        results = results.filter(m =>
          m.title?.toLowerCase().includes(qGlobal) ||
          m.genre?.toLowerCase().includes(qGlobal) ||
          m.description?.toLowerCase().includes(qGlobal) ||
          m.distributor?.toLowerCase().includes(qGlobal) ||
          String(m.year).includes(qGlobal) ||
          (m.cast || []).some(c => c.toLowerCase().includes(qGlobal))
        );
      }
      
      // Build active filters summary
      const appliedFilters = {};
      if (qTitle) appliedFilters.title = qTitle;
      if (qGenre) appliedFilters.genre = qGenre;
      if (qYear) appliedFilters.year = qYear;
      if (qCast) appliedFilters.cast = qCast;
      if (qGlobal) appliedFilters.q = qGlobal;
      
      return response(200, {
        success: true,
        count: results.length,
        filters: Object.keys(appliedFilters).length ? appliedFilters : undefined,
        movies: results,
      });
      
    } catch (err) {
      console.error("GET error:", err);
      return response(500, { error: "Failed to fetch movies: " + err.message });
    }
  }

  // ── PROTECTED ROUTES (require admin auth) ──────────────────────────────
  const headers = Object.fromEntries(req.headers.entries());
  if (!verifyAuth(headers)) {
    return response(401, { error: "Unauthorized. Provide a valid Bearer token." });
  }

  // POST - Create movie
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const { title, youtubeLink, distributor, cast, genre, year, description, thumbnail } = body;

      if (!title || !year) {
        return response(400, { error: "title and year are required" });
      }

      const id = generateId();
      const movie = {
        id,
        title,
        youtubeLink: youtubeLink || "",
        distributor: distributor || "",
        cast: Array.isArray(cast) ? cast : (cast ? cast.split(",").map(s => s.trim()) : []),
        genre: genre || "",
        year: parseInt(year),
        description: description || "",
        thumbnail: thumbnail || "",
        rating: {
          averageRating: 0,
          totalRatings: 0,
          breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Save individual blob (keep for backward compatibility)
      await store.setJSON(id, movie);
      
      // Update index (✅ OPTIMIZED: single index update)
      const index = await getMoviesIndex(store);
      index.unshift(movie); // Add to beginning (newest first)
      await saveMoviesIndex(store, index);
      
      return response(201, { success: true, movie });
    } catch (err) {
      console.error("POST error:", err);
      return response(500, { error: "Failed to create movie: " + err.message });
    }
  }

  // PUT - Update movie
  if (req.method === "PUT") {
    if (!movieId) {
      return response(400, { error: "Movie ID required in path: /api/movies/{id}" });
    }
    
    try {
      const index = await getMoviesIndex(store);
      const movieIndex = index.findIndex(m => m.id === movieId);
      
      if (movieIndex === -1) {
        return response(404, { error: "Movie not found" });
      }
      
      const body = await req.json();
      const updated = {
        ...index[movieIndex],
        ...body,
        id: movieId,
        cast: body.cast
          ? (Array.isArray(body.cast) ? body.cast : body.cast.split(",").map(s => s.trim()))
          : index[movieIndex].cast,
        year: body.year ? parseInt(body.year) : index[movieIndex].year,
        updatedAt: new Date().toISOString(),
      };
      
      // Keep rating from index
      updated.rating = index[movieIndex].rating;
      
      // Update individual blob
      await store.setJSON(movieId, updated);
      
      // Update index
      index[movieIndex] = updated;
      await saveMoviesIndex(store, index);
      
      return response(200, { success: true, movie: updated });
    } catch (err) {
      console.error("PUT error:", err);
      return response(500, { error: "Failed to update movie: " + err.message });
    }
  }

  // DELETE - Delete movie
  if (req.method === "DELETE") {
    if (!movieId) {
      return response(400, { error: "Movie ID required in path: /api/movies/{id}" });
    }
    
    try {
      const index = await getMoviesIndex(store);
      const movieIndex = index.findIndex(m => m.id === movieId);
      
      if (movieIndex === -1) {
        return response(404, { error: "Movie not found" });
      }
      
      const deletedMovie = index[movieIndex];
      
      // Delete individual blob
      await store.delete(movieId);
      
      // Delete rating if exists
      await ratingStore.delete(movieId).catch(() => {});
      
      // Update index
      const newIndex = index.filter(m => m.id !== movieId);
      await saveMoviesIndex(store, newIndex);
      
      return response(200, { 
        success: true, 
        message: `Movie "${deletedMovie.title}" deleted.`,
        deletedId: movieId
      });
    } catch (err) {
      console.error("DELETE error:", err);
      return response(500, { error: "Failed to delete movie: " + err.message });
    }
  }

  // WARMUP / HEALTH endpoint (for keeping function alive)
  if (req.method === "GET" && (url.pathname.includes("/warmup") || url.pathname.includes("/health"))) {
    const index = await getMoviesIndex(store);
    return response(200, {
      status: "healthy",
      timestamp: Date.now(),
      movieCount: index.length,
      usingIndex: true
    });
  }

  return response(405, { error: "Method not allowed" });
};

export const config = {
  path: ["/api/movies", "/api/movies/*"],
};
