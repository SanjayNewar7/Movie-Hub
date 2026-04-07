// netlify/functions/movies.js
// Movie Hub - CRUD API + Public GET Endpoint
// Powered by Netlify Blobs for persistent storage

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "moviehub2024";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
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

export default async (req, context) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }

  const store = getStore({ name: "movies", consistency: "strong" });
  const url = new URL(req.url);
  const pathParts = url.pathname.replace(/^\/api\/movies\/?|^\/.netlify\/functions\/movies\/?/, "").split("/").filter(Boolean);
  const movieId = pathParts[0];

  // ── PUBLIC GET (no auth required) ──────────────────────────────────────────
  if (req.method === "GET") {
    try {
      if (movieId) {
        // GET single movie: /api/movies/{id}
        const data = await store.get(movieId, { type: "json" });
        if (!data) return new Response(JSON.stringify({ error: "Movie not found" }), { status: 404, headers: corsHeaders() });
        return new Response(JSON.stringify({ success: true, movie: data }), { status: 200, headers: corsHeaders() });
      } else {
        // GET all movies: /api/movies
        const { blobs } = await store.list();
        const movies = await Promise.all(
          blobs.map(async (blob) => {
            const data = await store.get(blob.key, { type: "json" });
            return data;
          })
        );
        const sorted = movies
          .filter(Boolean)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return new Response(
          JSON.stringify({
            success: true,
            count: sorted.length,
            movies: sorted,
          }),
          { status: 200, headers: corsHeaders() }
        );
      }
    } catch (err) {
      console.error("GET error:", err);
      return new Response(JSON.stringify({ error: "Failed to fetch movies" }), { status: 500, headers: corsHeaders() });
    }
  }

  // ── PROTECTED ROUTES (require admin auth) ──────────────────────────────────
  const headers = Object.fromEntries(req.headers.entries());
  if (!verifyAuth(headers)) {
    return new Response(JSON.stringify({ error: "Unauthorized. Provide a valid Bearer token." }), {
      status: 401,
      headers: corsHeaders(),
    });
  }

  // POST - Create movie
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const { title, youtubeLink, distributor, cast, genre, year, description, thumbnail } = body;

      if (!title || !year) {
        return new Response(JSON.stringify({ error: "title and year are required" }), { status: 400, headers: corsHeaders() });
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await store.setJSON(id, movie);
      return new Response(JSON.stringify({ success: true, movie }), { status: 201, headers: corsHeaders() });
    } catch (err) {
      console.error("POST error:", err);
      return new Response(JSON.stringify({ error: "Failed to create movie" }), { status: 500, headers: corsHeaders() });
    }
  }

  // PUT - Update movie
  if (req.method === "PUT") {
    if (!movieId) return new Response(JSON.stringify({ error: "Movie ID required in path: /api/movies/{id}" }), { status: 400, headers: corsHeaders() });
    try {
      const existing = await store.get(movieId, { type: "json" });
      if (!existing) return new Response(JSON.stringify({ error: "Movie not found" }), { status: 404, headers: corsHeaders() });

      const body = await req.json();
      const updated = {
        ...existing,
        ...body,
        id: movieId,
        cast: body.cast
          ? (Array.isArray(body.cast) ? body.cast : body.cast.split(",").map(s => s.trim()))
          : existing.cast,
        year: body.year ? parseInt(body.year) : existing.year,
        updatedAt: new Date().toISOString(),
      };

      await store.setJSON(movieId, updated);
      return new Response(JSON.stringify({ success: true, movie: updated }), { status: 200, headers: corsHeaders() });
    } catch (err) {
      console.error("PUT error:", err);
      return new Response(JSON.stringify({ error: "Failed to update movie" }), { status: 500, headers: corsHeaders() });
    }
  }

  // DELETE - Delete movie
  if (req.method === "DELETE") {
    if (!movieId) return new Response(JSON.stringify({ error: "Movie ID required in path: /api/movies/{id}" }), { status: 400, headers: corsHeaders() });
    try {
      const existing = await store.get(movieId, { type: "json" });
      if (!existing) return new Response(JSON.stringify({ error: "Movie not found" }), { status: 404, headers: corsHeaders() });

      await store.delete(movieId);
      return new Response(JSON.stringify({ success: true, message: `Movie "${existing.title}" deleted.` }), { status: 200, headers: corsHeaders() });
    } catch (err) {
      console.error("DELETE error:", err);
      return new Response(JSON.stringify({ error: "Failed to delete movie" }), { status: 500, headers: corsHeaders() });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders() });
};

export const config = {
  path: ["/api/movies", "/api/movies/*"],
};
