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
    const { description, genre, mood, era, length } = req.body || {};
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

    if (!TMDB_API_KEY) {
        return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });
    }

    const TMDB_GENRES = {
        "action": 28, "adventure": 12, "animation": 16, "animated": 16,
        "comedy": 35, "comedic": 35, "crime": 80, "documentary": 99,
        "drama": 18, "dramatic": 18, "family": 10751, "fantasy": 14,
        "history": 36, "historical": 36, "horror": 27, "music": 10402,
        "musical": 10402, "mystery": 9648, "romance": 10749, "romantic": 10749,
        "science fiction": 878, "sci-fi": 878, "scifi": 878,
        "thriller": 53, "war": 10752, "western": 37
    };

    const GENRE_ID_TO_NAME = {
        28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
        80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
        14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
        9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 53: "Thriller",
        10752: "War", 37: "Western"
    };

    const LANGUAGE_MAP = {
        "korean": "ko", "korea": "ko", "hindi": "hi", "bollywood": "hi", "indian": "hi",
        "japanese": "ja", "anime": "ja", "japan": "ja", "french": "fr", "france": "fr",
        "spanish": "es", "spain": "es", "german": "de", "germany": "de",
        "italian": "it", "italy": "it", "chinese": "zh", "mandarin": "zh", "cantonese": "cn",
        "tamil": "ta", "telugu": "te", "malayalam": "ml", "turkish": "tr", "russian": "ru"
    };

    function normalizeEra(eraStr) {
        if (!eraStr) return "";
        const clean = String(eraStr).toLowerCase().trim();

        if (/\b(202\d|2020s?|20s|twenty\s*twenties)\b/i.test(clean) || clean.includes("2020")) return "2020s";
        if (/\b(201\d|2010s?|10s|twenty\s*tens|tens)\b/i.test(clean) || clean.includes("2010")) return "2010s";
        if (/\b(200\d|2000s?|00s|aughts|two\s*thousands?)\b/i.test(clean) || clean.includes("2000")) return "2000s";
        if (/\b(199\d|1990s?|90s?|90's|nineties)\b/i.test(clean) || clean.includes("1990")) return "1990s";
        if (/\b(198\d|1980s?|80s?|80's|eighties)\b/i.test(clean) || clean.includes("1980")) return "1980s";
        if (/\b(197\d|1970s?|70s?|70's|seventies)\b/i.test(clean) || clean.includes("1970")) return "1970s";
        if (/\b(196\d|195\d|194\d|193\d|192\d|60s?|50s?|classic|classics|older|golden|vintage|retro|pre-1970)\b/i.test(clean) || clean.includes("classic")) return "classics";

        return "";
    }

    function buildDateFilter(eraStr) {
        const today = new Date().toISOString().split("T")[0];
        const norm = normalizeEra(eraStr);
        const eraMap = {
            "2020s": `&primary_release_date.gte=2020-01-01&primary_release_date.lte=${today}`,
            "2010s": "&primary_release_date.gte=2010-01-01&primary_release_date.lte=2019-12-31",
            "2000s": "&primary_release_date.gte=2000-01-01&primary_release_date.lte=2009-12-31",
            "1990s": "&primary_release_date.gte=1990-01-01&primary_release_date.lte=1999-12-31",
            "1980s": "&primary_release_date.gte=1980-01-01&primary_release_date.lte=1989-12-31",
            "1970s": "&primary_release_date.gte=1970-01-01&primary_release_date.lte=1979-12-31",
            "classics": "&primary_release_date.gte=1920-01-01&primary_release_date.lte=1969-12-31"
        };
        if (norm && eraMap[norm]) {
            return eraMap[norm];
        }
        return `&primary_release_date.lte=${today}`;
    }

    function movieMatchesEra(movie, eraStr) {
        const norm = normalizeEra(eraStr);
        if (!norm) return true;
        const year = parseInt((movie.release_date || "").split("-")[0], 10);
        if (isNaN(year)) return false;
        const currentYear = new Date().getFullYear();
        if (norm === "2020s") return year >= 2020 && year <= currentYear;
        if (norm === "2010s") return year >= 2010 && year <= 2019;
        if (norm === "2000s") return year >= 2000 && year <= 2009;
        if (norm === "1990s") return year >= 1990 && year <= 1999;
        if (norm === "1980s") return year >= 1980 && year <= 1989;
        if (norm === "1970s") return year >= 1970 && year <= 1979;
        if (norm === "classics") return year < 1970 && year >= 1900;
        return true;
    }

    function movieMatchesGenre(movie, requiredGenreId) {
        if (!requiredGenreId) return true;
        return Array.isArray(movie.genre_ids) && movie.genre_ids.includes(requiredGenreId);
    }

    function buildRuntimeFilter(len) {
        if (!len) return "";
        const l = len.toLowerCase();
        if (l.includes("under 90")) return "&with_runtime.lte=90";
        if (l.includes("90-120") || l.includes("90 to 120")) return "&with_runtime.gte=90&with_runtime.lte=120";
        if (l.includes("over 2 hours") || l.includes("over 120")) return "&with_runtime.gte=120";
        return "";
    }

    async function interpretQueryWithAI(userInput, filterContext) {
        const apiKey = (GROQ_API_KEY || OPENROUTER_API_KEY || "").trim();
        if (!apiKey) return null;

        const isGroq = !!GROQ_API_KEY;
        const endpoint = isGroq
            ? "https://api.groq.com/openai/v1/chat/completions"
            : "https://openrouter.ai/api/v1/chat/completions";
        const model = isGroq ? "llama-3.3-70b-versatile" : "meta-llama/llama-3.3-70b-instruct";

        const systemPrompt = `You are an expert film query analyzer for a movie database. Your ONLY job is to analyze the user's input and extract structured search parameters.
CRITICAL: You must NEVER recommend or output movie titles yourself (unless extracting a reference title mentioned by the user in "similar_to"). TMDB will fetch the actual movies.

Respond ONLY with a JSON object in this exact format:
{
  "people": ["string"], // Names of actors, directors, writers mentioned (e.g. "Cillian Murphy", "Christopher Nolan", "Al Pacino").
  "genres": ["string"], // TMDB genres: Action, Adventure, Animation, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Mystery, Romance, Sci-Fi, Thriller, War, Western.
  "keywords": ["string"], // 1-4 short thematic or plot tags (e.g. "serial killer", "time travel", "mind bending", "heist", "space", "revenge", "superhero", "dystopia", "coming of age", "haunted house").
  "similar_to": ["string"], // Reference movies the user explicitly mentioned to find similar films for (e.g. "like Inception" -> ["Inception"]).
  "language": "string", // ISO 639-1 code if a language or regional cinema is requested (e.g. "ko" for Korean, "hi" for Hindi/Bollywood, "ja" for Japanese/Anime, "fr" for French, "es" for Spanish).
  "era": "string" // Era/decade if mentioned or inferred (e.g. "1990s", "2000s", "2010s", "2020s", "classic").
}`;

        const contextPayload = {
            query: userInput,
            filter_genre: filterContext.genre || "",
            filter_mood: filterContext.mood || "",
            filter_era: filterContext.era || "",
            filter_length: filterContext.length || ""
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7000);

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: JSON.stringify(contextPayload) }
                    ],
                    temperature: 0.1,
                    response_format: { type: "json_object" }
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);
            if (!response.ok) return null;

            const data = await response.json();
            const rawContent = data.choices?.[0]?.message?.content || "{}";
            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawContent.replace(/```json|```/g, "").trim());

            const extractedGenres = Array.isArray(parsed.genres) ? parsed.genres.filter(g => typeof g === "string" && g.trim()) : [];
            if (filterContext.genre && !extractedGenres.some(g => g.toLowerCase() === filterContext.genre.toLowerCase())) {
                extractedGenres.push(filterContext.genre);
            }

            const inferredEra = (typeof parsed.era === "string" && parsed.era.trim()) ? parsed.era.trim() : (filterContext.era || "");

            return {
                people: Array.isArray(parsed.people) ? parsed.people.filter(p => typeof p === "string" && p.trim()) : [],
                genres: extractedGenres,
                keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter(k => typeof k === "string" && k.trim()) : [],
                similar_to: Array.isArray(parsed.similar_to) ? parsed.similar_to.filter(s => typeof s === "string" && s.trim()) : [],
                language: typeof parsed.language === "string" ? parsed.language.trim().toLowerCase() : "",
                era: inferredEra
            };
        } catch (err) {
            clearTimeout(timeout);
            console.error("AI interpreter error / fallback triggered:", err.message);
            return null;
        }
    }

    function fallbackRuleBasedIntent(text, filters = {}) {
        const combined = `${text || ""} ${filters.genre || ""} ${filters.mood || ""}`.toLowerCase();
        const genres = [];
        for (const [kw] of Object.entries(TMDB_GENRES)) {
            if (new RegExp(`\\b${kw}\\b`, "i").test(combined)) {
                if (!genres.includes(kw)) genres.push(kw);
            }
        }
        if (filters.genre && !genres.some(g => g.toLowerCase() === filters.genre.toLowerCase())) {
            genres.push(filters.genre);
        }

        let language = "";
        for (const [langKw, code] of Object.entries(LANGUAGE_MAP)) {
            if (combined.includes(langKw)) {
                language = code;
                break;
            }
        }

        const people = [];
        const cleaned = (text || "")
            .replace(/\b(movies?|films?|shows?|series|please|recommend|suggest|show me|about|with|like|similar to|good|best|great)\b/gi, "")
            .replace(/\s+/g, " ")
            .trim();

        if (cleaned && cleaned.split(" ").length <= 3 && !genres.some(g => cleaned.toLowerCase().includes(g))) {
            people.push(cleaned);
        }

        const extractedEra = normalizeEra(filters.era) || normalizeEra(text) || "";

        return {
            people,
            genres,
            keywords: cleaned ? [cleaned] : [],
            similar_to: [],
            language,
            era: extractedEra
        };
    }

    async function searchTMDBPerson(name) {
        if (!name) return null;
        const res = await fetch(`https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}`);
        const data = await res.json();
        if (data.results && data.results.length > 0) return data.results[0];

        const words = name.trim().split(/\s+/);
        if (words.length === 1 && words[0].length > 4) {
            for (let i = 2; i < words[0].length - 1; i++) {
                const variant = `${words[0].slice(0, i)} ${words[0].slice(i)}`;
                const vRes = await fetch(`https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(variant)}`);
                const vData = await vRes.json();
                if (vData.results && vData.results.length > 0) return vData.results[0];
            }
        }
        return null;
    }

    async function searchTMDBKeywords(keywords) {
        const ids = [];
        for (const kw of keywords) {
            const res = await fetch(`https://api.themoviedb.org/3/search/keyword?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(kw)}`);
            const data = await res.json();
            if (data.results && data.results.length > 0) {
                const exact = data.results.find(r => r.name.toLowerCase() === kw.toLowerCase());
                ids.push((exact || data.results[0]).id);
            }
        }
        return ids;
    }

    async function searchTMDBSimilar(movieTitle) {
        const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(movieTitle)}`);
        const data = await res.json();
        if (!data.results || data.results.length === 0) return [];
        const movieId = data.results[0].id;

        const recRes = await fetch(`https://api.themoviedb.org/3/movie/${movieId}/recommendations?api_key=${TMDB_API_KEY}`);
        const recData = await recRes.json();
        if (recData.results && recData.results.length > 0) {
            return recData.results;
        }

        const simRes = await fetch(`https://api.themoviedb.org/3/movie/${movieId}/similar?api_key=${TMDB_API_KEY}`);
        const simData = await simRes.json();
        return simData.results || [];
    }

    try {
        const rawText = (description || "").trim();
        const filterContext = { description: rawText, genre, mood, era, length, rawText };

        let intent = null;
        if (rawText || genre || mood || era || length) {
            intent = await interpretQueryWithAI(rawText, filterContext);
        }

        if (!intent || (!intent.people.length && !intent.genres.length && !intent.keywords.length && !intent.similar_to.length && !intent.language && !intent.era)) {
            intent = fallbackRuleBasedIntent(rawText, filterContext);
        }

        // Authoritative explicit user dropdown overrides
        const explicitEra = normalizeEra(era);
        const explicitGenreKey = genre ? genre.toLowerCase().trim() : "";
        const primaryGenreId = explicitGenreKey ? TMDB_GENRES[explicitGenreKey] : null;

        const effectiveEra = explicitEra || normalizeEra(intent.era) || normalizeEra(rawText) || "";
        const dateFilter = buildDateFilter(effectiveEra);
        const runtimeFilter = buildRuntimeFilter(length || "");
        const langFilter = intent.language ? `&with_original_language=${intent.language}` : "";

        const allGenreIds = (intent.genres || [])
            .map(g => TMDB_GENRES[g.toLowerCase().trim()])
            .filter(Boolean);

        if (primaryGenreId && !allGenreIds.includes(primaryGenreId)) {
            allGenreIds.unshift(primaryGenreId);
        }

        const candidatePool = [];
        const isClassic = ["classics", "1970s", "1980s"].includes(effectiveEra);
        const voteThreshold = isClassic || (intent.language && intent.language !== "en")
            ? 30
            : (effectiveEra === "2020s" ? 80 : 100);

        // 1. Reference movies (e.g. "like Inception", "movies like Gone Girl")
        if (intent.similar_to && intent.similar_to.length > 0) {
            for (const title of intent.similar_to) {
                const similar = await searchTMDBSimilar(title);
                for (const m of similar) {
                    if (movieMatchesEra(m, effectiveEra) && movieMatchesGenre(m, primaryGenreId)) {
                        candidatePool.push({ ...m, _source: "similar", _matchedRef: title });
                    }
                }
            }
        }

        // 2. People (actors, directors)
        if (intent.people && intent.people.length > 0) {
            for (const personName of intent.people) {
                const person = await searchTMDBPerson(personName);
                if (person) {
                    const creditsRes = await fetch(`https://api.themoviedb.org/3/person/${person.id}/movie_credits?api_key=${TMDB_API_KEY}`);
                    const creditsData = await creditsRes.json();
                    let list = [
                        ...(creditsData.cast || []),
                        ...(creditsData.crew || []).filter(c => ["Director", "Writer"].includes(c.job))
                    ];

                    for (const m of list) {
                        if (movieMatchesEra(m, effectiveEra) && movieMatchesGenre(m, primaryGenreId)) {
                            candidatePool.push({ ...m, _source: "person", _matchedPerson: personName });
                        }
                    }
                }
            }
        }

        // 3. Thematic Discover (Keywords + Genres + Language + Era + Runtime)
        const keywordIds = await searchTMDBKeywords(intent.keywords || []);
        if (keywordIds.length > 0) {
            const gParam = primaryGenreId ? `&with_genres=${primaryGenreId}` : (allGenreIds.length > 0 ? `&with_genres=${allGenreIds.join("|")}` : "");
            const kwUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_keywords=${keywordIds.join("|")}&sort_by=popularity.desc&vote_count.gte=${voteThreshold}${gParam}${dateFilter}${runtimeFilter}${langFilter}`;

            const res = await fetch(kwUrl);
            const data = await res.json();
            for (const m of (data.results || [])) {
                if (movieMatchesEra(m, effectiveEra) && movieMatchesGenre(m, primaryGenreId)) {
                    candidatePool.push({ ...m, _source: "keyword" });
                }
            }
        }

        // 4. Multi-Page / Diverse Discover by Genre & Era across pages 1, 2, and 3
        const gParam = primaryGenreId ? `&with_genres=${primaryGenreId}` : (allGenreIds.length > 0 ? `&with_genres=${allGenreIds.join("|")}` : "");

        const [popPage1, popPage2, popPage3, votePage1, votePage2] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}${gParam}&sort_by=popularity.desc&vote_count.gte=${voteThreshold}&page=1${dateFilter}${runtimeFilter}${langFilter}`).then(r => r.json()).catch(() => ({ results: [] })),
            fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}${gParam}&sort_by=popularity.desc&vote_count.gte=${voteThreshold}&page=2${dateFilter}${runtimeFilter}${langFilter}`).then(r => r.json()).catch(() => ({ results: [] })),
            fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}${gParam}&sort_by=popularity.desc&vote_count.gte=${voteThreshold}&page=3${dateFilter}${runtimeFilter}${langFilter}`).then(r => r.json()).catch(() => ({ results: [] })),
            fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}${gParam}&sort_by=vote_average.desc&vote_count.gte=${voteThreshold}&page=1${dateFilter}${runtimeFilter}${langFilter}`).then(r => r.json()).catch(() => ({ results: [] })),
            fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}${gParam}&sort_by=vote_average.desc&vote_count.gte=${voteThreshold}&page=2${dateFilter}${runtimeFilter}${langFilter}`).then(r => r.json()).catch(() => ({ results: [] }))
        ]);

        for (const m of [...(popPage1.results || []), ...(popPage2.results || []), ...(popPage3.results || [])]) {
            if (movieMatchesEra(m, effectiveEra) && movieMatchesGenre(m, primaryGenreId)) {
                candidatePool.push({ ...m, _source: "popularity" });
            }
        }
        for (const m of [...(votePage1.results || []), ...(votePage2.results || [])]) {
            if (movieMatchesEra(m, effectiveEra) && movieMatchesGenre(m, primaryGenreId)) {
                candidatePool.push({ ...m, _source: "rating" });
            }
        }

        // 5. Literal Title Search fallback if still empty and user entered text
        if (candidatePool.length === 0 && rawText) {
            const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(rawText)}`);
            const data = await res.json();
            for (const m of (data.results || [])) {
                if (movieMatchesEra(m, effectiveEra) && movieMatchesGenre(m, primaryGenreId)) {
                    candidatePool.push({ ...m, _source: "search" });
                }
            }
        }

        // 6. Deduplicate, filter out unreleased / missing data / era mismatches
        const today = new Date().toISOString().split("T")[0];
        const minVoteRequired = effectiveEra === "classics" || effectiveEra === "1970s"
            ? 25
            : (effectiveEra === "1980s" ? 50 : 80);

        const seen = new Set();
        const unique = [];

        for (const m of candidatePool) {
            if (!m || !m.title || !m.poster_path || !m.overview || seen.has(m.id)) continue;
            if (m.release_date && m.release_date > today) continue;
            if ((m.vote_count || 0) < minVoteRequired) continue;
            if (!movieMatchesEra(m, effectiveEra)) continue;
            if (!movieMatchesGenre(m, primaryGenreId)) continue;
            seen.add(m.id);
            unique.push(m);
        }

        // 7. Score & Rank Candidates for Relevance + Balanced Diversity
        const searchTerms = `${rawText} ${mood || ""}`.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        const scored = unique.map(m => {
            // Quality score from vote average
            let score = (m.vote_average || 6.0) * 1.5;

            // Capped logarithmic vote count bonus (prevents all-time top 5 blockbusters from crowding out everything)
            const voteCount = Math.max(1, m.vote_count || 1);
            const cappedLogVotes = Math.min(Math.log10(voteCount), 4.0);
            score += cappedLogVotes * 1.2;

            if (m._source === "person") score += 4.5;
            if (m._source === "similar") score += 4.0;
            if (m._source === "keyword") score += 3.5;

            if (primaryGenreId && m.genre_ids && m.genre_ids.includes(primaryGenreId)) {
                score += 2.5;
            }

            const text = `${m.title} ${m.overview || ""}`.toLowerCase();
            for (const term of searchTerms) {
                if (text.includes(term)) score += 2.0;
            }

            // Controlled stochastic jitter for dynamic freshness across repeat searches
            score += (Math.random() * 2.2);

            return { movie: m, score };
        });

        scored.sort((a, b) => b.score - a.score);

        // Pick top recommendations with diverse selection
        const selected = scored.slice(0, 6);

        const recommendations = selected.map(({ movie: m }) => {
            const yearStr = (m.release_date || "").split("-")[0] || "N/A";
            const primaryGenreName = m.genre_ids && m.genre_ids.length > 0
                ? (GENRE_ID_TO_NAME[m.genre_ids[0]] || "Movie")
                : (genre || "Movie");

            let reason = "";
            if (m._matchedPerson) {
                reason = `Features ${m._matchedPerson} in an iconic performance.`;
            } else if (m._matchedRef) {
                reason = `Recommended for fans of "${m._matchedRef}".`;
            } else if (effectiveEra && genre) {
                reason = `Quintessential ${effectiveEra} ${genre} pick with strong acclaim.`;
            } else if (effectiveEra) {
                reason = `Standout ${effectiveEra} cinematic discovery matching your vibe.`;
            } else if (genre) {
                reason = `Highly recommended ${genre} title tailored to your search.`;
            } else {
                reason = "Highly rated cinematic pick matching your requested taste.";
            }

            if (m.overview) {
                const maxOverviewLen = 130;
                const snippet = m.overview.length > maxOverviewLen ? m.overview.slice(0, maxOverviewLen).trim() + "..." : m.overview;
                reason = `${reason} ${snippet}`;
            }

            return {
                id: m.id,
                title: m.title,
                year: yearStr,
                genre: primaryGenreName,
                poster_path: m.poster_path || "",
                backdrop_path: m.backdrop_path || "",
                vote_average: m.vote_average ? Number(m.vote_average.toFixed(1)) : null,
                vote_count: m.vote_count || 0,
                overview: m.overview || "",
                reason: reason
            };
        });

        return res.json({ recommendations });

    } catch (err) {
        console.error("Recommend route error:", err);
        return res.status(500).json({ error: "Something went wrong getting recommendations." });
    }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test" && !process.env.SERVERLESS) {
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;