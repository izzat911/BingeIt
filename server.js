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

    const GENRE_MAP = {
        "action": 28, "adventure": 12, "animation": 16,
        "comedy": 35, "crime": 80, "documentary": 99,
        "drama": 18, "family": 10751, "fantasy": 14,
        "history": 36, "horror": 27, "music": 10402,
        "mystery": 9648, "romance": 10749,
        "science fiction": 878, "sci-fi": 878,
        "thriller": 53, "war": 10752, "western": 37
    };

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

    function findGenreIds(text) {
        const lower = text.toLowerCase();
        const ids = new Set();
        for (const [keyword, id] of Object.entries(GENRE_MAP)) {
            const re = new RegExp(`\\b${keyword}\\b`, "i");
            if (re.test(lower)) ids.add(id);
        }
        return Array.from(ids);
    }

    async function fetchPersonMovies(name) {
        async function tryPersonSearch(query) {
            const personRes = await fetch(
                `https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
            );
            const personData = await personRes.json();
            return (personData.results && personData.results.length > 0) ? personData.results[0] : null;
        }

        // Attempt 1: the name exactly as typed
        let person = await tryPersonSearch(name);

        // Attempt 2: if that fails, try inserting a space at each position within the first word.
        // This catches cases like "Shahrukh Khan" -> TMDB's actual entry "Shah Rukh Khan"
        if (!person) {
            const words = name.trim().split(/\s+/);
            const firstWord = words[0];
            const rest = words.slice(1).join(" ");

            for (let i = 2; i < firstWord.length - 1 && !person; i++) {
                const variant = `${firstWord.slice(0, i)} ${firstWord.slice(i)}${rest ? " " + rest : ""}`;
                person = await tryPersonSearch(variant);
            }
        }

        if (!person) return [];

        const creditsRes = await fetch(
            `https://api.themoviedb.org/3/person/${person.id}/movie_credits?api_key=${TMDB_API_KEY}`
        );
        const creditsData = await creditsRes.json();
        const cast = (creditsData.cast || []).filter(m => m.poster_path);

        // Adaptive quality bar: try strict first, but progressively relax if that
        // wipes out everything. This matters for cinema with naturally lower TMDB
        // vote counts (e.g. much of Bollywood, regional/international films) so we
        // don't lose real results just because western audiences vote less on them.
        const thresholds = [50, 20, 5, 0];
        for (const minVotes of thresholds) {
            const filtered = cast.filter(m => m.vote_count >= minVotes);
            if (filtered.length > 0) {
                return filtered.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
            }
        }
        return [];
    }

    async function fetchByGenres(ids, eraFilter) {
        const voteThresholds = [500, 100, 20, 0];

        for (const minVotes of voteThresholds) {
            let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${ids.join(",")}&sort_by=vote_average.desc&vote_count.gte=${minVotes}${eraFilter}`;
            let r = await fetch(url);
            let d = await r.json();
            let results = d.results || [];
            if (results.length > 0) return results;
        }

        // Combining all genres together found nothing at any threshold — relax to just the first genre
        if (ids.length > 1) {
            for (const minVotes of voteThresholds) {
                let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${ids[0]}&sort_by=vote_average.desc&vote_count.gte=${minVotes}${eraFilter}`;
                let r = await fetch(url);
                let d = await r.json();
                let results = d.results || [];
                if (results.length > 0) return results;
            }
        }
        return [];
    }

    const KEYWORD_SYNONYMS = {
        "true events": "true story", "real events": "true story",
        "true story": "true story", "real life": "true story",
        "real story": "true story", "actual events": "true story",
        "based on a true story": "true story",
        "time travel": "time travel", "time traveling": "time travel",
        "artificial intelligence": "artificial intelligence (a.i.)",
        "haunted house": "haunted house", "serial killer": "serial killer",
        "single mother": "single mother", "single father": "single father",
        "down syndrome": "down syndrome"
    };

    const STOPWORDS = new Set([
        "movies", "movie", "films", "film", "shows", "show", "series",
        "please", "recommend", "suggest", "based", "on", "about", "that",
        "are", "is", "the", "a", "an", "of", "with", "involving", "featuring", "me"
    ]);

    function cleanForKeyword(text) {
        return text
            .toLowerCase()
            .split(/\s+/)
            .filter(w => !STOPWORDS.has(w))
            .join(" ")
            .trim();
    }

    async function fetchByKeyword(text) {
        async function tryKeyword(query) {
            if (!query) return [];
            const keywordRes = await fetch(
                `https://api.themoviedb.org/3/search/keyword?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
            );
            const keywordData = await keywordRes.json();
            if (!keywordData.results || keywordData.results.length === 0) return [];

            const keywordId = keywordData.results[0].id;
            const kwRes = await fetch(
                `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_keywords=${keywordId}&sort_by=popularity.desc`
            );
            const kwData = await kwRes.json();
            return kwData.results || [];
        }

        const cleaned = cleanForKeyword(text);

        // Attempt 1: cleaned phrase as-is
        let results = await tryKeyword(cleaned);
        if (results.length > 0) return results;

        // Attempt 2: check known synonym phrases contained in the cleaned text
        for (const [phrase, mapped] of Object.entries(KEYWORD_SYNONYMS)) {
            if (cleaned.includes(phrase)) {
                results = await tryKeyword(mapped);
                if (results.length > 0) return results;
            }
        }

        // Attempt 3: try progressively shorter versions (drop the first word each time)
        const words = cleaned.split(" ").filter(Boolean);
        for (let i = 1; i < words.length && results.length === 0; i++) {
            results = await tryKeyword(words.slice(i).join(" "));
        }

        return results;
    }

    try {
        const rawText = (description || mood || genre || "").trim();
        const eraFilter = buildEraFilter(era);
        let results = [];
        let usedGenreLabel = null;

        if (rawText) {
            // Priority 1: treat the text as an actor/director name first (the main use case)
            const cleanedForPerson = rawText
                .replace(/\b(movies?|films?|shows?|series|please|recommend|suggest|show me|of)\b/gi, "")
                .replace(/\s+/g, " ")
                .trim();

            if (cleanedForPerson) {
                results = await fetchPersonMovies(cleanedForPerson);
            }

            // Priority 2: genre words (e.g. "crime", "family drama")
            if (results.length === 0) {
                const genreIds = findGenreIds(rawText);
                if (genreIds.length > 0) {
                    results = await fetchByGenres(genreIds, eraFilter);
                    usedGenreLabel = Object.keys(GENRE_MAP)
                        .filter(k => genreIds.includes(GENRE_MAP[k]))
                        .join(" / ");
                }
            }

            // Priority 3: thematic keyword search (e.g. "down syndrome", "time travel")
            if (results.length === 0) {
                results = await fetchByKeyword(rawText);
            }

            // Priority 4: literal movie title search
            if (results.length === 0) {
                const movieRes = await fetch(
                    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(rawText)}`
                );
                const movieData = await movieRes.json();
                results = movieData.results || [];
            }

            // Priority 5: last resort — generic popular movies
            if (results.length === 0) {
                const discoverRes = await fetch(
                    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc`
                );
                const discoverData = await discoverRes.json();
                results = discoverData.results || [];
            }
        } else {
            // No typed text — use Genre/Era dropdowns directly
            let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc`;
            if (genre) url += `&with_genres=${genre}`;
            url += eraFilter;

            const discoverRes = await fetch(url);
            const discoverData = await discoverRes.json();
            results = discoverData.results || [];
        }

        const recommendations = results.slice(0, 6).map(m => ({
            title: m.title,
            year: (m.release_date || "").split("-")[0] || "N/A",
            genre: usedGenreLabel || genre || "Movie",
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