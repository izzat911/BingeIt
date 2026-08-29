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

    // TMDB's official genre IDs
    const GENRE_MAP = {
        "action": 28, "adventure": 12, "animation": 16, "animated": 16,
        "comedy": 35, "comedies": 35, "crime": 80, "documentary": 99,
        "drama": 18, "dramas": 18, "family": 10751, "fantasy": 14,
        "history": 36, "historical": 36, "horror": 27, "music": 10402,
        "musical": 10402, "mystery": 9648, "romance": 10749, "romantic": 10749,
        "scifi": 878, "sci-fi": 878, "science fiction": 878,
        "thriller": 53, "thrillers": 53, "war": 10752,
        "western": 37, "westerns": 37
    };

    function findGenreId(text) {
        const lower = text.toLowerCase();
        for (const [keyword, id] of Object.entries(GENRE_MAP)) {
            if (lower.includes(keyword)) return id;
        }
        return null;
    }

    async function discoverByGenre(genreId, eraFilter) {
        let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${genreId}&sort_by=vote_average.desc&vote_count.gte=1000`;
        if (eraFilter) url += eraFilter;
        const r = await fetch(url);
        const d = await r.json();
        return (d.results || []).filter(m => m.vote_count > 100);
    }

    function buildEraFilter(era) {
        const eraMap = {
            "2020s": "2020-01-01,2029-12-31",
            "2010s": "2010-01-01,2019-12-31",
            "2000s": "2000-01-01,2009-12-31",
            "1990s": "1990-01-01,1999-12-31",
            "1980s": "1980-01-01,1989-12-31"
        };
        if (!eraMap[era]) return "";
        const [gte, lte] = eraMap[era].split(",");
        return `&primary_release_date.gte=${gte}&primary_release_date.lte=${lte}`;
    }

    try {
        const rawText = (description || mood || genre || "").trim();
        const eraFilter = buildEraFilter(era);
        let results = [];
        let matchedGenreLabel = null;

        if (rawText) {
            // Priority 1: does the text match a known genre? (e.g. "crime", "action", "romantic")
            const genreId = findGenreId(rawText);
            if (genreId) {
                results = await discoverByGenre(genreId, eraFilter);
                matchedGenreLabel = Object.keys(GENRE_MAP).find(k => GENRE_MAP[k] === genreId);
            }

            // Priority 2: does the text match a real actor/director name?
            if (results.length === 0) {
                const cleanedForPerson = rawText
                    .replace(/\b(movies?|films?|shows?|series|please|recommend|suggest)\b/gi, "")
                    .replace(/\s+/g, " ")
                    .trim();

                if (cleanedForPerson) {
                    const personRes = await fetch(
                        `https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanedForPerson)}`
                    );
                    const personData = await personRes.json();
                    if (personData.results && personData.results.length > 0) {
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
                }
            }

            // Priority 3: literal title search (only useful if they typed an actual movie name)
            if (results.length === 0) {
                const movieRes = await fetch(
                    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(rawText)}`
                );
                const movieData = await movieRes.json();
                results = (movieData.results || []).filter(m => m.vote_count > 20);
            }

            // Priority 4: give up gracefully, show popular movies rather than an error
            if (results.length === 0) {
                const discoverRes = await fetch(
                    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc`
                );
                const discoverData = await discoverRes.json();
                results = (discoverData.results || []).filter(m => m.vote_count > 20);
            }
        } else {
            // No typed text — use the Genre/Era dropdowns directly
            let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc`;
            if (genre) url += `&with_genres=${genre}`;
            url += eraFilter;

            const discoverRes = await fetch(url);
            const discoverData = await discoverRes.json();
            results = (discoverData.results || []).filter(m => m.vote_count > 20);
        }

        const recommendations = results.slice(0, 6).map(m => ({
            title: m.title,
            year: (m.release_date || "").split("-")[0] || "N/A",
            genre: matchedGenreLabel ? matchedGenreLabel[0].toUpperCase() + matchedGenreLabel.slice(1) : (genre || "Movie"),
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