import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";

const TYPES = new Set([
  "title_mismatch",
  "not_playing",
  "lagging",
  "wrong_thumbnail",
  "other",
]);
const labels = {
  title_mismatch: "Title and movie are different",
  not_playing: "Movie is not playing",
  lagging: "Movie lagged",
  wrong_thumbnail: "Wrong poster or thumbnail",
  other: "Other",
};
const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers });
}

function authorized(req) {
  const password = process.env.ADMIN_PASSWORD;
  return Boolean(password && req.headers.get("authorization") === `Bearer ${password}`);
}

async function readBody(req) {
  if (Number(req.headers.get("content-length")) > 4096) throw new Error("Request is too large");
  return req.json();
}

async function movieForId(id) {
  if (typeof id !== "string" || !/^movie_[a-zA-Z0-9_\-]{1,80}$/.test(id)) return null;
  const store = getStore({ name: "movies", consistency: "strong" });
  return store.get(id, { type: "json" });
}

async function listAll(store) {
  const { blobs } = await store.list();
  return Promise.all(blobs.map(({ key }) => store.get(key, { type: "json" })));
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  const path = new URL(req.url).pathname.replace(/^\/api\/reports\/?|^\/\.netlify\/functions\/reports\/?/, "");
  const reportStore = getStore({ name: "movie-reports", consistency: "strong" });
  const likeStore = getStore({ name: "movie-likes", consistency: "strong" });

  try {
    if (req.method === "POST" && !path) {
      const body = await readBody(req);
      const { movieId, type } = body;
      const detail = typeof body.detail === "string" ? body.detail.trim() : "";
      if (!TYPES.has(type) || detail.length > 500 || (type === "other" && !detail)) {
        return json(400, { error: "Select a valid reason and enter up to 500 characters." });
      }
      const movie = await movieForId(movieId);
      if (!movie) return json(404, { error: "Movie not found" });
      const id = `report_${Date.now()}_${randomUUID()}`;
      const report = {
        id, movieId, movieTitle: movie.title, type, reason: labels[type],
        detail, status: "open", createdAt: new Date().toISOString(),
      };
      await reportStore.setJSON(id, report);
      return json(201, { success: true, id });
    }

    if (req.method === "POST" && path === "likes") {
      const body = await readBody(req);
      const { installationId, movieIds } = body;
      if (typeof installationId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(installationId) ||
          !Array.isArray(movieIds) || movieIds.length > 500 ||
          movieIds.some(id => typeof id !== "string" || !/^movie_[a-zA-Z0-9_\-]{1,80}$/.test(id))) {
        return json(400, { error: "Invalid like request" });
      }
      await likeStore.setJSON(installationId, { movieIds: [...new Set(movieIds)] });
      return json(200, { success: true });
    }

    if (!authorized(req)) return json(401, { error: "Unauthorized" });

    if (req.method === "PATCH" && path.startsWith("report_")) {
      const body = await readBody(req);
      if (!["open", "resolved"].includes(body.status)) return json(400, { error: "Invalid status" });
      const report = await reportStore.get(path, { type: "json" });
      if (!report) return json(404, { error: "Report not found" });
      report.status = body.status;
      report.updatedAt = new Date().toISOString();
      await reportStore.setJSON(path, report);
      return json(200, { success: true, report });
    }

    if (req.method === "GET" && !path) {
      const [allReports, allLikes, movieIndex] = await Promise.all([
        listAll(reportStore), listAll(likeStore),
        getStore({ name: "movies", consistency: "strong" }).get("movies_index", { type: "json" }),
      ]);
      const reports = allReports.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const byType = Object.fromEntries(Object.keys(labels).map(type => [type, 0]));
      const byMovie = new Map();
      for (const report of reports) {
        byType[report.type] = (byType[report.type] || 0) + 1;
        const current = byMovie.get(report.movieId) || { movieId: report.movieId, title: report.movieTitle, count: 0 };
        current.count++;
        byMovie.set(report.movieId, current);
      }
      const liked = new Map();
      const movieTitles = new Map((movieIndex || []).map(movie => [movie.id, movie.title]));
      for (const item of allLikes.filter(Boolean)) {
        for (const movieId of item.movieIds || []) {
          if (!movieTitles.has(movieId)) continue;
          const current = liked.get(movieId) || { movieId, title: movieTitles.get(movieId), count: 0 };
          current.count++;
          liked.set(movieId, current);
        }
      }
      return json(200, {
        success: true, reports,
        stats: {
          total: reports.length,
          open: reports.filter(r => r.status === "open").length,
          byType,
          mostReported: [...byMovie.values()].sort((a, b) => b.count - a.count).slice(0, 10),
          mostLiked: [...liked.values()].sort((a, b) => b.count - a.count).slice(0, 10),
        },
      });
    }
    return json(405, { error: "Method not allowed" });
  } catch (error) {
    console.error("Reports API error", error);
    return json(error instanceof SyntaxError || error.message === "Request is too large" ? 400 : 500,
      { error: "Could not process request" });
  }
};

export const config = { path: ["/api/reports", "/api/reports/*"] };
