require("dotenv").config();

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception thrown:", err);
});

const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const pool = require("./pool");

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || "bingeit-dev-secret-change-this";

const app = express();
app.set("trust proxy", 1);

app.use(express.json());

const sessionStore = new MySQLStore({
    clearExpired: true,
    checkExpirationInterval: 900000,
    createDatabaseTable: true,
}, pool);

app.use(session({
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, secure: process.env.NODE_ENV === "production", sameSite: "lax" } 
}));

app.use("/public", express.static(path.join(__dirname, "public")));

function requireAuthPage(req, res, next) {
    if (req.session.userId) return next();
    res.redirect("/login.html");
}

function requireAuthApi(req, res, next) {
    if (req.session.userId) return next();
    res.status(401).json({ error: "You must be logged in." });
}

app.get(["/login.html", "/signup.html"], (req, res) => {
    res.sendFile(path.join(__dirname, "views", req.path));
});

app.get(["/", "/index.html", "/discover.html", "/ai.html", "/details.html"], requireAuthPage, (req, res) => {
    const page = req.path === "/" ? "index.html" : req.path.slice(1);
    res.sendFile(path.join(__dirname, "views", page));
});

app.post("/api/signup", async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: "Name, email, and password are all required." });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    try {
        const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
        if (existing.length > 0) {
            return res.status(409).json({ error: "An account with this email already exists." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email.toLowerCase(), hashedPassword]);

        res.status(201).json({ message: "Account created successfully." });
    } catch (err) {
        console.error("Signup error:", err);
        res.status(500).json({ error: "Something went wrong creating your account." });
    }
});

app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }

    try {
        const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
        const user = rows[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        req.session.userId = user.id;
        req.session.userName = user.name;

        res.json({ message: "Logged in successfully.", name: user.name });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Something went wrong logging in." });
    }
});

app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out." }));
});

app.get("/api/me", (req, res) => {
    if (req.session.userId) {
        res.json({ loggedIn: true, name: req.session.userName });
    } else {
        res.json({ loggedIn: false });
    }
});

app.get("/api/discover", requireAuthApi, async (req, res) => {
    const { query, genre, page } = req.query;
    const pageNum = page || 1;

    if (!TMDB_API_KEY) {
        return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });
    }

    try {
        let url = query
            ? `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${pageNum}`
            : `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc&page=${pageNum}`;
        if (!query && genre) url += `&with_genres=${genre}`;

        const response = await fetch(url);
        if (!response.ok) return res.status(502).json({ error: "Movie database returned an error." });

        const data = await response.json();
        res.json({
            movies: data.results || [],
            page: data.page || 1,
            totalPages: data.total_pages || 1
        });
    } catch (err) {
        console.error("Discover route error:", err);
        res.status(500).json({ error: "Something went wrong loading movies." });
    }
});

app.get("/api/trending", requireAuthApi, async (req, res) => {
    if (!TMDB_API_KEY) return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });

    try {
        const response = await fetch(`https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_API_KEY}`);
        if (!response.ok) return res.status(502).json({ error: "Movie database returned an error." });

        const data = await response.json();
        res.json({ movies: (data.results || []).slice(0, 12) });
    } catch (err) {
        console.error("Trending route error:", err);
        res.status(500).json({ error: "Something went wrong loading trending movies." });
    }
});

app.get("/api/movie/:id", requireAuthApi, async (req, res) => {
    const { id } = req.params;
    if (!TMDB_API_KEY) return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });

    try {
        const response = await fetch(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits`);
        if (!response.ok) return res.status(502).json({ error: "Movie database returned an error." });

        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error("Movie details route error:", err);
        res.status(500).json({ error: "Something went wrong loading movie details." });
    }
});

app.post("/api/recommend", requireAuthApi, async (req, res) => {
    const { description, genre, mood, era, length } = req.body;

    if (!TMDB_API_KEY) {
        return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });
    }

    try {
        const searchText = (description || mood || genre || "").trim();
        let results = [];

        if (searchText) {
            // Step 1: try searching for a matching person (actor/director)
            const personRes = await fetch(
                `https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(searchText)}`
            );
            const personData = await personRes.json();

            if (personData.results && personData.results.length > 0) {
                // Found a matching person — pull their most popular movies
                const personId = personData.results[0].id;
                const creditsRes = await fetch(
                    `https://api.themoviedb.org/3/person/${personId}/movie_credits?api_key=${TMDB_API_KEY}`
                );
                const creditsData = await creditsRes.json();
                const cast = creditsData.cast || [];
                results = cast
                    .filter(m => m.vote_count > 20 && m.poster_path)
                    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
            }

            // Step 2: if no person match (or no good results), fall back to title search
            if (results.length === 0) {
                const movieRes = await fetch(
                    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(searchText)}`
                );
                const movieData = await movieRes.json();
                results = (movieData.results || []).filter(m => m.vote_count > 20);
            }

            // Step 3: if still nothing, fall back to popular movies matching genre/era loosely
            if (results.length === 0) {
                const discoverRes = await fetch(
                    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc`
                );
                const discoverData = await discoverRes.json();
                results = (discoverData.results || []).filter(m => m.vote_count > 20);
            }
        } else {
            // No search text — just use filters (genre/era) against discover
            let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc`;

            if (era) {
                const eraMap = {
                    "2020s": "2020-01-01,2029-12-31",
                    "2010s": "2010-01-01,2019-12-31",
                    "2000s": "2000-01-01,2009-12-31",
                    "1990s": "1990-01-01,1999-12-31",
                    "1980s": "1980-01-01,1989-12-31"
                };
                if (eraMap[era]) {
                    const [gte, lte] = eraMap[era].split(",");
                    url += `&primary_release_date.gte=${gte}&primary_release_date.lte=${lte}`;
                }
            }

            const discoverRes = await fetch(url);
            const discoverData = await discoverRes.json();
            results = (discoverData.results || []).filter(m => m.vote_count > 20);
        }

        const recommendations = results.slice(0, 6).map(m => ({
            title: m.title,
            year: (m.release_date || "").split("-")[0] || "N/A",
            genre: genre || "Movie",
            reason: m.overview ? m.overview.slice(0, 140) + (m.overview.length > 140 ? "..." : "") : "Popular pick matching your search."
        }));

        res.json({ recommendations });

    } catch (err) {
        console.error("Recommend route error:", err);
        res.status(500).json({ error: "Something went wrong getting recommendations." });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});