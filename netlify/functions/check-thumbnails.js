// netlify/functions/check-thumbnails.js
// Thumbnail URL Health Checker
// GET  /api/check-thumbnails           → returns all movies with thumbnail status
// POST /api/check-thumbnails/refresh   → force refresh cache (admin)
//
// This function checks if thumbnail URLs are accessible and caches results for 1 hour

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// In-memory cache for thumbnail check results (1 hour TTL)
let thumbnailCache = {
  results: null,
  lastFetch: 0,
  ttl: 3600000, // 1 hour
};

function isCacheValid() {
  return thumbnailCache.results !== null && 
    Date.now() - thumbnailCache.lastFetch < thumbnailCache.ttl;
}

function setCacheResults(results) {
  thumbnailCache.results = results;
  thumbnailCache.lastFetch = Date.now();
  console.log(`💾 Thumbnail check cached (${results.length} results, TTL: 1 hour)`);
}

function invalidateCache() {
  thumbnailCache.results = null;
  thumbnailCache.lastFetch = 0;
  console.log("🗑️ Thumbnail cache invalidated");
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
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

function verifyAuth(headers) {
  const auth = headers["authorization"] || headers["Authorization"] || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === ADMIN_PASSWORD;
}

// Check if a URL is accessible
async function checkUrlAccessibility(url) {
  if (!url || url.trim() === "") {
    return { accessible: false, error: "No URL provided", statusCode: null };
  }
  
  try {
    // Use HEAD request first (faster, less bandwidth)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: {
        "User-Agent": "MovieHub-HealthCheck/1.0",
      },
    });
    
    clearTimeout(timeoutId);
    
    const accessible = response.ok;
    const statusCode = response.status;
    const contentType = response.headers.get("content-type") || "";
    
    // For YouTube thumbnails, also check if it's a valid image
    if (url.includes("youtube.com") || url.includes("ytimg.com")) {
      // YouTube always returns 200 even for invalid IDs, so we need to check content
      if (statusCode === 200 && contentType.includes("image")) {
        return { accessible: true, statusCode, contentType: contentType.split(";")[0] };
      }
    }
    
    if (accessible) {
      return { accessible: true, statusCode, contentType: contentType.split(";")[0] };
    } else {
      return { accessible: false, error: `HTTP ${statusCode}`, statusCode };
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return { accessible: false, error: "Timeout (5s)", statusCode: null };
    }
    return { accessible: false, error: error.message, statusCode: null };
  }
}

// Get all movies with thumbnail status
async function getAllMoviesWithThumbnailStatus(store) {
  try {
    const index = await store.get("movies_index", { type: "json" });
    const movies = index || [];
    
    const results = [];
    for (const movie of movies) {
      results.push({
        id: movie.id,
        title: movie.title,
        thumbnailUrl: movie.thumbnail || null,
        hasThumbnail: !!movie.thumbnail && movie.thumbnail.trim() !== "",
        status: "pending", // Will be filled when checked
      });
    }
    
    return results;
  } catch (err) {
    console.error("Error reading movie index:", err);
    return [];
  }
}

// Check thumbnails for all movies (with concurrency limit)
async function checkAllThumbnails(movies) {
  const results = [];
  const concurrencyLimit = 5; // Check 5 URLs at a time to avoid overwhelming
  const batches = [];
  
  // Split into batches
  for (let i = 0; i < movies.length; i += concurrencyLimit) {
    batches.push(movies.slice(i, i + concurrencyLimit));
  }
  
  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (movie) => {
        if (!movie.hasThumbnail) {
          return {
            ...movie,
            status: "missing",
            accessible: false,
            error: "No thumbnail URL",
          };
        }
        
        const check = await checkUrlAccessibility(movie.thumbnailUrl);
        return {
          ...movie,
          status: check.accessible ? "ok" : "broken",
          accessible: check.accessible,
          statusCode: check.statusCode,
          error: check.error,
          contentType: check.contentType,
        };
      })
    );
    results.push(...batchResults);
  }
  
  return results;
}

// ── MAIN HANDLER ──
export default async (req, context) => {
  if (req.method === "OPTIONS") return corsResponse();
  
  const store = getStore({ name: "movies", consistency: "strong" });
  const url = new URL(req.url);
  const pathParts = url.pathname
    .replace(/^\/api\/check-thumbnails\/?|^\/.netlify\/functions\/check-thumbnails\/?/, "")
    .split("/")
    .filter(Boolean);
  
  // ── GET /api/check-thumbnails ──
  if (req.method === "GET") {
    try {
      // Check if we should force refresh (bypass cache)
      const forceRefresh = url.searchParams.get("refresh") === "true";
      
      let results;
      if (!forceRefresh && isCacheValid()) {
        console.log("📦 Returning cached thumbnail check results");
        results = thumbnailCache.results;
      } else {
        console.log("🔍 Performing fresh thumbnail health check...");
        const movies = await getAllMoviesWithThumbnailStatus(store);
        results = await checkAllThumbnails(movies);
        setCacheResults(results);
      }
      
      // Calculate statistics
      const stats = {
        total: results.length,
        ok: results.filter(r => r.status === "ok").length,
        broken: results.filter(r => r.status === "broken").length,
        missing: results.filter(r => r.status === "missing").length,
        lastChecked: new Date(thumbnailCache.lastFetch).toISOString(),
        cacheAge: isCacheValid() ? Date.now() - thumbnailCache.lastFetch : null,
        cacheTTL: thumbnailCache.ttl,
      };
      
      // Optional: filter only broken or missing thumbnails
      const filter = url.searchParams.get("filter");
      let filteredResults = results;
      if (filter === "broken") {
        filteredResults = results.filter(r => r.status === "broken");
      } else if (filter === "missing") {
        filteredResults = results.filter(r => r.status === "missing");
      } else if (filter === "problematic") {
        filteredResults = results.filter(r => r.status !== "ok");
      }
      
      return jsonResponse(200, {
        success: true,
        stats,
        movies: filteredResults,
        message: filter ? `Showing ${filteredResults.length} movies with ${filter} thumbnails` : "All movies with thumbnail status",
      });
      
    } catch (err) {
      console.error("Thumbnail check error:", err);
      return jsonResponse(500, { error: "Failed to check thumbnails: " + err.message });
    }
  }
  
  // ── POST /api/check-thumbnails/refresh (admin only) ──
  if (req.method === "POST" && pathParts[0] === "refresh") {
    const headers = Object.fromEntries(req.headers.entries());
    if (!verifyAuth(headers)) {
      return jsonResponse(401, { error: "Unauthorized. Provide a valid Bearer token." });
    }
    
    try {
      invalidateCache();
      const movies = await getAllMoviesWithThumbnailStatus(store);
      const results = await checkAllThumbnails(movies);
      setCacheResults(results);
      
      const stats = {
        total: results.length,
        ok: results.filter(r => r.status === "ok").length,
        broken: results.filter(r => r.status === "broken").length,
        missing: results.filter(r => r.status === "missing").length,
      };
      
      return jsonResponse(200, {
        success: true,
        message: "Thumbnail cache refreshed",
        stats,
      });
    } catch (err) {
      return jsonResponse(500, { error: "Failed to refresh: " + err.message });
    }
  }
  
  // ── GET /api/check-thumbnails/status/{movieId} (check single movie) ──
  if (req.method === "GET" && pathParts[0] === "status" && pathParts[1]) {
    try {
      const movieId = pathParts[1];
      const index = await store.get("movies_index", { type: "json" });
      const movie = (index || []).find(m => m.id === movieId);
      
      if (!movie) {
        return jsonResponse(404, { error: "Movie not found" });
      }
      
      const check = await checkUrlAccessibility(movie.thumbnail);
      
      return jsonResponse(200, {
        success: true,
        movie: {
          id: movie.id,
          title: movie.title,
          thumbnailUrl: movie.thumbnail || null,
          hasThumbnail: !!movie.thumbnail,
        },
        accessibility: {
          accessible: check.accessible,
          statusCode: check.statusCode,
          error: check.error,
          contentType: check.contentType,
        },
      });
    } catch (err) {
      return jsonResponse(500, { error: "Failed to check movie: " + err.message });
    }
  }
  
  return jsonResponse(405, { error: "Method not allowed" });
};

export const config = {
  path: ["/api/check-thumbnails", "/api/check-thumbnails/*"],
};
