require("dotenv").config();
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const pool = require("./db/pool");

const app = express();
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || "bingeit-dev-secret-change-this";

pool.getConnection()
    .then(conn => {
        console.log("Connected to MySQL");
        conn.release();
    })
    .catch(err => console.error("MySQL connection error:", err.message));

const sessionStore = new MySQLStore({
    host: process.env.DB_HOST || "127.0.0.1",
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "bingeit",
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined
});

app.use(express.json());
app.use(session({
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
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
        const [existing] = await pool.query(
            "SELECT id FROM users WHERE email = ?",
            [email.toLowerCase()]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: "An account with this email already exists." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
            [name, email.toLowerCase(), hashedPassword]
        );

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
        const [rows] = await pool.query(
            "SELECT * FROM users WHERE email = ?",
            [email.toLowerCase()]
        );
        const user = rows[0];

        if (!user) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        const passwordMatches = await bcrypt.compare(password, user.password);
        if (!passwordMatches) {
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
    req.session.destroy(() => {
        res.json({ message: "Logged out." });
    });
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
        console.error("Missing TMDB_API_KEY in .env");
        return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });
    }

    try {
        let url;

        if (query) {
            url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${pageNum}`;
        } else {
            url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc&page=${pageNum}`;
            if (genre) url += `&with_genres=${genre}`;
        }

        const response = await fetch(url);

        if (!response.ok) {
            const errText = await response.text();
            console.error("TMDB API error:", errText);
            return res.status(502).json({ error: "Movie database returned an error." });
        }

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
    if (!TMDB_API_KEY) {
        console.error("Missing TMDB_API_KEY in .env");
        return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });
    }

    try {
        const url = `https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_API_KEY}`;
        const response = await fetch(url);

        if (!response.ok) {
            const errText = await response.text();
            console.error("TMDB trending error:", errText);
            return res.status(502).json({ error: "Movie database returned an error." });
        }

        const data = await response.json();
        res.json({ movies: (data.results || []).slice(0, 12) });

    } catch (err) {
        console.error("Trending route error:", err);
        res.status(500).json({ error: "Something went wrong loading trending movies." });
    }
});

app.get("/api/movie/:id", requireAuthApi, async (req, res) => {
    const { id } = req.params;

    if (!TMDB_API_KEY) {
        console.error("Missing TMDB_API_KEY in .env");
        return res.status(500).json({ error: "Server is missing a TMDB_API_KEY." });
    }

    try {
        const url = `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits`;
        const response = await fetch(url);

        if (!response.ok) {
            const errText = await response.text();
            console.error("TMDB movie details error:", errText);
            return res.status(502).json({ error: "Movie database returned an error." });
        }

        const data = await response.json();
        res.json(data);

    } catch (err) {
        console.error("Movie details route error:", err);
        res.status(500).json({ error: "Something went wrong loading movie details." });
    }
});

app.post("/api/recommend", requireAuthApi, async (req, res) => {
    const { description, genre, mood, era, length } = req.body;

    if (!GROQ_API_KEY) {
        console.error("Missing GROQ_API_KEY in .env");
        return res.status(500).json({
            error: "Server is missing a GROQ_API_KEY. Add one to your .env file."
        });
    }

    const filterLines = [];
    if (genre) filterLines.push(`Genre: ${genre}`);
    if (mood) filterLines.push(`Mood: ${mood}`);
    if (era) filterLines.push(`Era: ${era}`);
    if (length) filterLines.push(`Preferred length: ${length}`);

    const userPrompt = `
A user wants movie recommendations.

${description ? `Their description: "${description}"` : ""}
${filterLines.length ? `Filters they selected:\n${filterLines.join("\n")}` : ""}

Recommend exactly 6 real movies that fit. Respond with ONLY valid JSON (no markdown, no code fences, no preamble), in this exact shape:

{
  "recommendations": [
    { "title": "Movie Title", "year": "2010", "genre": "Sci-Fi", "reason": "One or two sentence reason this fits what they asked for." }
  ]
}
`.trim();

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: "user", content: userPrompt }],
                max_tokens: 1000,
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("Groq API error:", errText);
            return res.status(502).json({ error: "AI provider returned an error." });
        }

        const data = await response.json();
        const rawText = data.choices?.[0]?.message?.content || "";

        const cleaned = rawText.replace(/```json|```/g, "").trim();

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch (parseErr) {
            console.error("Failed to parse AI response:", rawText);
            return res.status(502).json({ error: "Could not parse AI response." });
        }

        res.json(parsed);

    } catch (err) {
        console.error("Recommendation route error:", err);
        res.status(500).json({ error: "Something went wrong generating recommendations." });
    }
});

module.exports = app;