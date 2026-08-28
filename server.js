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
const OpenAI = require("openai");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || "bingeit-dev-secret-change-this";

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "https://valiant-gratitude-production.up.railway.app",
        "X-Title": "BingeIt",
    }
});

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

    if (!OPENROUTER_API_KEY) {
        return res.status(500).json({ error: "Server missing OPENROUTER_API_KEY." });
    }

    const filterLines = [];
    if (genre) filterLines.push(`Genre: ${genre}`);
    if (mood) filterLines.push(`Mood: ${mood}`);
    if (era) filterLines.push(`Era: ${era}`);
    if (length) filterLines.push(`Preferred length: ${length}`);

    const userPrompt = `
Recommend exactly 6 real movies fitting these criteria:
${description ? `Description: "${description}"` : ""}
${filterLines.length ? `Filters:\n${filterLines.join("\n")}` : ""}

Respond ONLY with valid JSON with this exact structure:
{
  "recommendations": [
    { "title": "Movie Title", "year": "2010", "genre": "Sci-Fi", "reason": "Short reason." }
  ]
}
`.trim();

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "HTTP-Referer": "https://valiant-gratitude-production.up.railway.app",
                "X-Title": "BingeIt",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                // OpenRouter attempts each model in order until one succeeds
                models: [
                    "google/gemini-2.5-flash",
                    "meta-llama/llama-3.3-70b-instruct:free",
                    "mistralai/mistral-7b-instruct:free",
                    "qwen/qwen-2.5-7b-instruct:free"
                ],
                messages: [
                    { role: "system", content: "You are a movie recommendation assistant. Always output valid JSON only." },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.7
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("OpenRouter Error Response:", response.status, data);
            return res.status(502).json({ error: data.error?.message || `OpenRouter returned status ${response.status}` });
        }

        const rawText = data.choices?.[0]?.message?.content || "";
        const jsonStart = rawText.indexOf("{");
        const jsonEnd = rawText.lastIndexOf("}");

        if (jsonStart === -1 || jsonEnd === -1) {
            return res.status(502).json({ error: "AI response did not contain valid JSON." });
        }

        const cleaned = rawText.substring(jsonStart, jsonEnd + 1);
        res.json(JSON.parse(cleaned));
    } catch (err) {
        console.error("Recommend error:", err);
        res.status(500).json({ error: err.message || "Internal server error." });
    }
});