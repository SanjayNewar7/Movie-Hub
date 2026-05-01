// netlify/functions/movies.js
// Movie Hub - OPTIMIZED API with movies_index (Single Blob Pattern)

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const INDEX_KEY = "movies_index";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

// ✅ FIXED: Return proper Response object
function jsonResponse(statusCode, data) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: corsHeaders()
  });
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
  try {
    const index = await store.get(INDEX_KEY, { type: "json" });
    return index || [];
  } catch (err) {
    console.error("Error reading index:", err);
    return [];
  }
}

async function saveMoviesIndex(store, index) {
  await store.setJSON(INDEX_KEY, index);
}

async function runMigration(store, ratingStore) {
  console.log("🚀 Running migration to build movies_index...");
  
  const { blobs } = await store.list();
  const movies = [];
  
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

  // ── HEALTH / WARMUP / INIT ENDPOINT (No auth required) ────────────────
  if (req.method === "GET" && (url.pathname.includes("/health") || url.pathname.includes("/warmup") || url.pathname.includes("/init"))) {
    try {
      let index = await getMoviesIndex(store);
      let migrated = false;
      
      // Auto-initialize if empty
      if (index.length === 0) {
        console.log("🔄 Health check triggered auto-migration...");
        index = await runMigration(store, ratingStore);
        migrated = true;
      }
      
      return jsonResponse(200, {
        status: "healthy",
        timestamp: Date.now(),
        movieCount: index.length,
        usingIndex: true,
        migrated: migrated
      });
    } catch (err) {
      console.error("Health check error:", err);
      return jsonResponse(500, { error: "Health check failed: " + err.message });
    }
  }

  // ── MIGRATION ENDPOINT (Requires auth) ────────────────────────────────
  if (req.method === "POST" && pathParts[0] === "migrate") {
    const headers = Object.fromEntries(req.headers.entries());
    if (!verifyAuth(headers)) {
      return jsonResponse(401, { error: "Unauthorized. Invalid or missing Bearer token." });
    }
    
    try {
      const movies = await runMigration(store, ratingStore);
      return jsonResponse(200, { 
        success: true, 
        message: "Migration completed successfully",
        count: movies.length 
      });
    } catch (err) {
      console.error("Migration error:", err);
      return jsonResponse(500, { error: "Migration failed: " + err.message });
    }
  }

  // ── PUBLIC GET (No auth required) ──────────────────────────────────────
  if (req.method === "GET") {
    try {
      let movies = await getMoviesIndex(store);
      
      if (movies.length === 0) {
        console.log("⚠️ movies_index is empty, running auto-migration...");
        movies = await runMigration(store, ratingStore);
      }
      
      if (movieId) {
        const movie = movies.find(m => m.id === movieId);
        if (!movie) {
          return jsonResponse(404, { error: "Movie not found" });
        }
        return jsonResponse(200, { success: true, movie });
      }
      
      // Apply filters
      const qTitle = url.searchParams.get("title")?.trim().toLowerCase() || "";
      const qGenre = url.searchParams.get("genre")?.trim().toLowerCase() || "";
      const qYear = url.searchParams.get("year")?.trim() || "";
      const qCast = url.searchParams.get("cast")?.trim().toLowerCase() || "";
      const qGlobal = url.searchParams.get("q")?.trim().toLowerCase() || "";
      
      let results = [...movies];
      
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
        results = results.filter(m => (m.cast || []).some(c => c.toLowerCase().includes(qCast)));
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
      
      const appliedFilters = {};
      if (qTitle) appliedFilters.title = qTitle;
      if (qGenre) appliedFilters.genre = qGenre;
      if (qYear) appliedFilters.year = qYear;
      if (qCast) appliedFilters.cast = qCast;
      if (qGlobal) appliedFilters.q = qGlobal;
      
      return jsonResponse(200, {
        success: true,
        count: results.length,
        filters: Object.keys(appliedFilters).length ? appliedFilters : undefined,
        movies: results,
      });
      
    } catch (err) {
      console.error("GET error:", err);
      return jsonResponse(500, { error: "Failed to fetch movies: " + err.message });
    }
  }

  // ── PROTECTED ROUTES (require admin auth) ──────────────────────────────
  const headers = Object.fromEntries(req.headers.entries());
  if (!verifyAuth(headers)) {
    return jsonResponse(401, { error: "Unauthorized. Provide a valid Bearer token." });
  }

  // POST - Create movie
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const { title, youtubeLink, distributor, cast, genre, year, description, thumbnail } = body;

      if (!title || !year) {
        return jsonResponse(400, { error: "title and year are required" });
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

      await store.setJSON(id, movie);
      
      const index = await getMoviesIndex(store);
      index.unshift(movie);
      await saveMoviesIndex(store, index);
      
      return jsonResponse(201, { success: true, movie });
    } catch (err) {
      console.error("POST error:", err);
      return jsonResponse(500, { error: "Failed to create movie: " + err.message });
    }
  }

  // PUT - Update movie
  if (req.method === "PUT") {
    if (!movieId) {
      return jsonResponse(400, { error: "Movie ID required in path: /api/movies/{id}" });
    }
    
    try {
      const index = await getMoviesIndex(store);
      const movieIndex = index.findIndex(m => m.id === movieId);
      
      if (movieIndex === -1) {
        return jsonResponse(404, { error: "Movie not found" });
      }
      
      const body = await req.json();
      const updated = {
        ...index[movieIndex],
        ...body,
        id: movieId,
        cast: body.cast ? (Array.isArray(body.cast) ? body.cast : body.cast.split(",").map(s => s.trim())) : index[movieIndex].cast,
        year: body.year ? parseInt(body.year) : index[movieIndex].year,
        updatedAt: new Date().toISOString(),
      };
      
      updated.rating = index[movieIndex].rating;
      
      await store.setJSON(movieId, updated);
      index[movieIndex] = updated;
      await saveMoviesIndex(store, index);
      
      return jsonResponse(200, { success: true, movie: updated });
    } catch (err) {
      console.error("PUT error:", err);
      return jsonResponse(500, { error: "Failed to update movie: " + err.message });
    }
  }

  // DELETE - Delete movie
  if (req.method === "DELETE") {
    if (!movieId) {
      return jsonResponse(400, { error: "Movie ID required in path: /api/movies/{id}" });
    }
    
    try {
      const index = await getMoviesIndex(store);
      const movieIndex = index.findIndex(m => m.id === movieId);
      
      if (movieIndex === -1) {
        return jsonResponse(404, { error: "Movie not found" });
      }
      
      const deletedMovie = index[movieIndex];
      
      await store.delete(movieId);
      await ratingStore.delete(movieId).catch(() => {});
      
      const newIndex = index.filter(m => m.id !== movieId);
      await saveMoviesIndex(store, newIndex);
      
      return jsonResponse(200, { 
        success: true, 
        message: `Movie "${deletedMovie.title}" deleted.`,
        deletedId: movieId
      });
    } catch (err) {
      console.error("DELETE error:", err);
      return jsonResponse(500, { error: "Failed to delete movie: " + err.message });
    }
  }

  return jsonResponse(405, { error: "Method not allowed" });
};

export const config = {
  path: ["/api/movies", "/api/movies/*"],
};
