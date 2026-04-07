# 🎬 Movie Hub — Admin Panel

A full-featured Movie admin panel with CRUD operations and a public REST API, powered by **Netlify Functions + Netlify Blobs** (no external database needed).

---

## 🚀 Deploy to Netlify (GitHub → Netlify)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit: Movie Hub"
git remote add origin https://github.com/YOUR_USERNAME/movie-hub.git
git push -u origin main
```

### Step 2 — Connect to Netlify
1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site → Import from Git**
2. Select your GitHub repo
3. Build settings:
   - **Publish directory**: `public`
   - **Functions directory**: `netlify/functions` (auto-detected)
4. Click **Deploy site**

### Step 3 — Set Environment Variable (optional)
In Netlify → Site Settings → Environment Variables:
```
ADMIN_PASSWORD = your_secret_password_here
```
Default password is `moviehub2024` if not set.

### Step 4 — Enable Netlify Blobs
Netlify Blobs is automatically available on all Netlify sites. No additional setup needed.

---

## 📡 Public API Reference

Once deployed, your public API is available at:

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `https://yoursite.netlify.app/api/movies` | ❌ None | Get all movies |
| `GET` | `https://yoursite.netlify.app/api/movies/{id}` | ❌ None | Get single movie |
| `POST` | `https://yoursite.netlify.app/api/movies` | ✅ Required | Create movie |
| `PUT` | `https://yoursite.netlify.app/api/movies/{id}` | ✅ Required | Update movie |
| `DELETE` | `https://yoursite.netlify.app/api/movies/{id}` | ✅ Required | Delete movie |

### Authentication
Protected routes require:
```
Authorization: Bearer your_password_here
```

### Example GET Response
```json
{
  "success": true,
  "count": 2,
  "movies": [
    {
      "id": "movie_1720000000000_abc123",
      "title": "Inception",
      "youtubeLink": "https://www.youtube.com/watch?v=YoHD9XEInc0",
      "distributor": "Warner Bros. Pictures",
      "cast": ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page"],
      "genre": "Sci-Fi",
      "year": 2010,
      "description": "A thief who steals corporate secrets through dream-sharing technology.",
      "thumbnail": "https://...",
      "createdAt": "2024-07-01T00:00:00.000Z",
      "updatedAt": "2024-07-01T00:00:00.000Z"
    }
  ]
}
```

---

## 🛠️ Local Development
```bash
npm install
npx netlify dev
```
Visit `http://localhost:8888`

---

## 📁 Project Structure
```
movie-hub/
├── public/
│   └── index.html          # Admin UI (single page app)
├── netlify/
│   └── functions/
│       └── movies.js       # All CRUD + public GET API
├── netlify.toml            # Netlify routing config
├── package.json
└── README.md
```
