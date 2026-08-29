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
    const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

    // --- Step 1: ask the AI to interpret the query into structured intent only.
    // The AI never invents movie titles — it only extracts genres/people/keywords.
    // If this fails for any reason, we fall back to simple rule-based parsing below.
    async function interpretQuery(text) {
        if (!GROQ_API_KEY || !text) return null;

        const systemPrompt = `You are a query interpreter for a movie search engine. You NEVER invent or name specific movies. You only extract structured search intent from the user's text.

Respond ONLY with valid JSON in this exact structure:
{
  "genres": ["Drama", "Family"],
  "people": ["Tom Holland"],
  "keywords": ["down syndrome"]
}

Rules:
- "genres" must ONLY use values from this exact list: Action, Adventure, Animation, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Mystery, Romance, Science Fiction, Thriller, War, Western. Leave empty array if none clearly apply.
- "people" should contain real actor/director names mentioned or clearly implied by the text (e.g. "shahrukh khan movies" -> ["Shah Rukh Khan"]). Correct obvious misspellings of famous names. Leave empty if none.
- "keywords" should contain short thematic search phrases (2-4 words) for specific subjects, situations, or plot elements NOT covered by genre (e.g. "down syndrome", "time travel", "based on true story", "single father"). Leave empty if none apply.
- Only fill fields that are clearly supported by the text. It's fine for one or more fields to be empty arrays.`;

        try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${GROQ_API_KEY.trim()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: text }
                    ],
                    temperature: 0.1,
                    response_format: { type: "json_object" }
                })
            });

            if (!response.ok) {
                console.error("Groq interpret error:", response.status, await response.text());
                return null;
            }

            const data = await response.json();
            const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
            return {
                genres: Array.isArray(parsed.genres) ? parsed.genres : [],
                people: Array.isArray(parsed.people) ? parsed.people : [],
                keywords: Array.isArray(parsed.keywords) ? parsed.keywords : []
            };
        } catch (err) {
            console.error("interpretQuery exception:", err);
            return null;
        }
    }

    // --- Simple rule-based fallback if AI interpretation is unavailable/fails
    function ruleBasedIntent(text) {
        const lower = text.toLowerCase();
        const genres = [];
        for (const key of Object.keys(GENRE_MAP)) {
            const re = new RegExp(`\\b${key}\\b`, "i");
            if (re.test(lower)) genres.push(key.charAt(0).toUpperCase() + key.slice(1));
        }
        return { genres, people: [], keywords: genres.length ? [] : [text] };
    }

    async function fetchPersonMovies(name) {
        const personRes = await fetch(
            `https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}`
        );
        const personData = await personRes.json();
        if (!personData.results || personData.results.length === 0) return [];

        const personId = personData.results[0].id;
        const creditsRes = await fetch(
            `https://api.themoviedb.org/3/person/${personId}/movie_credits?api_key=${TMDB_API_KEY}`
        );
        const creditsData = await creditsRes.json();
        const cast = creditsData.cast || [];
        return cast
            .filter(m => m.vote_count > 20 && m.poster_path)
            .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    }

    async function fetchByGenres(genreNames, eraFilter) {
        const ids = genreNames
            .map(g => GENRE_MAP[g.toLowerCase()])
            .filter(Boolean);
        if (ids.length === 0) return [];

        let url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${ids.join(",")}&sort_by=vote_average.desc&vote_count.gte=500${eraFilter}`;
        let r = await fetch(url);
        let d = await r.json();
        let results = (d.results || []).filter(m => m.vote_count > 100);

        // If combining all genres was too narrow, relax to first genre only
        if (results.length === 0 && ids.length > 1) {
            url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${ids[0]}&sort_by=vote_average.desc&vote_count.gte=500${eraFilter}`;
            r = await fetch(url);
            d = await r.json();
            results = (d.results || []).filter(m => m.vote_count > 100);
        }
        return results;
    }

    async function fetchByKeyword(text) {
        const keywordRes = await fetch(
            `https://api.themoviedb.org/3/search/keyword?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(text)}`
        );
        const keywordData = await keywordRes.json();
        if (!keywordData.results || keywordData.results.length === 0) return [];

        const keywordId = keywordData.results[0].id;
        const kwRes = await fetch(
            `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_keywords=${keywordId}&sort_by=popularity.desc`
        );
        const kwData = await kwRes.json();
        return (kwData.results || []).filter(m => m.vote_count > 10);
    }

    try {
        const rawText = (description || mood || genre || "").trim();
        const eraFilter = buildEraFilter(era);
        let results = [];
        let usedGenreLabel = null;

        if (rawText) {
            let intent = await interpretQuery(rawText);
            if (!intent || (intent.genres.length === 0 && intent.people.length === 0 && intent.keywords.length === 0)) {
                intent = ruleBasedIntent(rawText);
            }

            // Priority 1: named people
            for (const person of intent.people) {
                if (results.length > 0) break;
                results = await fetchPersonMovies(person);
            }

            // Priority 2: genres
            if (results.length === 0 && intent.genres.length > 0) {
                results = await fetchByGenres(intent.genres, eraFilter);
                usedGenreLabel = intent.genres.join(" / ");
            }

            // Priority 3: thematic keywords
            if (results.length === 0 && intent.keywords.length > 0) {
                for (const kw of intent.keywords) {
                    if (results.length > 0) break;
                    results = await fetchByKeyword(kw);
                }
            }

            // Priority 4: literal title search
            if (results.length === 0) {
                const movieRes = await fetch(
                    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(rawText)}`
                );
                const movieData = await movieRes.json();
                results = (movieData.results || []).filter(m => m.vote_count > 20);
            }

            // Priority 5: last resort, generic popular movies
            if (results.length === 0) {
                const discoverRes = await fetch(
                    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc`
                );
                const discoverData = await discoverRes.json();
                results = (discoverData.results || []).filter(m => m.vote_count > 20);
            }
        } else {
            // No typed text — use Genre/Era dropdowns directly
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