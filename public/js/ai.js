const askAiBtn = document.getElementById("ask-ai-btn");
const moodInput = document.getElementById("mood-input");
const genreSelect = document.getElementById("genre");
const moodSelect = document.getElementById("mood");
const eraSelect = document.getElementById("era");
const lengthSelect = document.getElementById("length");
const resetBtn = document.getElementById("reset-btn");

const resultsSection = document.getElementById("results-section");
const resultsGrid = document.getElementById("ai-results-grid");
const resultsSubtitle = document.getElementById("results-subtitle");
const loadingEl = document.getElementById("ai-loading");
const errorEl = document.getElementById("ai-error");

let loadingInterval = null;

// Setup prompt chip listeners
document.querySelectorAll(".prompt-chip").forEach(chip => {
    chip.addEventListener("click", () => {
        if (chip.dataset.query) moodInput.value = chip.dataset.query;
        if (chip.dataset.genre) genreSelect.value = chip.dataset.genre;
        if (chip.dataset.mood) moodSelect.value = chip.dataset.mood;
        if (chip.dataset.era) eraSelect.value = chip.dataset.era;
        if (chip.dataset.length) lengthSelect.value = chip.dataset.length;
        getRecommendations();
    });
});

// Setup reset button listener
if (resetBtn) {
    resetBtn.addEventListener("click", () => {
        moodInput.value = "";
        genreSelect.value = "";
        moodSelect.value = "";
        eraSelect.value = "";
        lengthSelect.value = "";
        resultsSection.hidden = true;
        errorEl.hidden = true;
        resultsGrid.innerHTML = "";
        moodInput.focus();
    });
}

const urlParams = new URLSearchParams(window.location.search);
const prefillDescription = urlParams.get("description");
if (prefillDescription) {
    moodInput.value = prefillDescription;
    getRecommendations();
}

if (askAiBtn) {
    askAiBtn.addEventListener("click", getRecommendations);
}

// Allow Ctrl+Enter or Cmd+Enter to submit
if (moodInput) {
    moodInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            getRecommendations();
        }
    });
}

function startLoadingAnimation(era, genre) {
    const titleEl = loadingEl ? loadingEl.querySelector(".loading-title") : null;
    const subEl = loadingEl ? loadingEl.querySelector(".loading-sub") : null;

    const messages = [
        { title: "Analyzing your requested vibe...", sub: "Extracting themes, mood, and cinematic parameters" },
        { title: era ? `Filtering cinema archives for the ${era}...` : "Searching TMDB movie database...", sub: "Applying precise release year and genre constraints" },
        { title: "Ranking high-acclaim recommendations...", sub: "Balancing ratings, diversity, and thematic relevance" },
        { title: "Personalizing your curated watchlist...", sub: "Generating tailored match reasons for you" }
    ];

    let step = 0;
    if (titleEl) titleEl.textContent = messages[0].title;
    if (subEl) subEl.textContent = messages[0].sub;

    if (loadingInterval) clearInterval(loadingInterval);
    loadingInterval = setInterval(() => {
        step = (step + 1) % messages.length;
        if (titleEl) titleEl.textContent = messages[step].title;
        if (subEl) subEl.textContent = messages[step].sub;
    }, 1800);
}

function stopLoadingAnimation() {
    if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
    }
}

async function getRecommendations() {
    const description = moodInput ? moodInput.value.trim() : "";
    const genre = genreSelect ? genreSelect.value : "";
    const mood = moodSelect ? moodSelect.value : "";
    const era = eraSelect ? eraSelect.value : "";
    const length = lengthSelect ? lengthSelect.value : "";

    if (!description && !genre && !mood && !era && !length) {
        showError("Tell us what you'd like to watch in your own words, or select at least one filter above.");
        return;
    }

    resultsSection.hidden = false;
    resultsGrid.innerHTML = "";
    errorEl.hidden = true;
    loadingEl.hidden = false;
    if (askAiBtn) askAiBtn.disabled = true;

    startLoadingAnimation(era, genre);
    updateSubtitle(description, genre, mood, era);

    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
        const response = await fetch("/api/recommend", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ description, genre, mood, era, length })
        });

        const data = await response.json();

        if (!response.ok) {
            showError(data.error || "Failed to load recommendations. Please try again.");
            return;
        }

        renderResults(data.recommendations);

    } catch (err) {
        showError("Network connection error. Please check your internet connection and try again.");
        console.error("Fetch exception:", err);
    } finally {
        stopLoadingAnimation();
        loadingEl.hidden = true;
        if (askAiBtn) askAiBtn.disabled = false;
    }
}

function updateSubtitle(description, genre, mood, era) {
    if (!resultsSubtitle) return;
    const parts = [];
    if (genre) parts.push(genre);
    if (era) parts.push(era);
    if (mood) parts.push(mood);
    if (description) parts.push(`"${description.length > 35 ? description.slice(0, 32) + "..." : description}"`);

    if (parts.length > 0) {
        resultsSubtitle.innerHTML = `Curated for: <span class="highlight-filter">${escapeHtml(parts.join(" • "))}</span>`;
    } else {
        resultsSubtitle.textContent = "Personalized movie picks matching your taste";
    }
}

function renderResults(recommendations) {
    if (!recommendations || recommendations.length === 0) {
        showError("No movies matched your exact criteria. Try broadening your description or adjusting your filters.");
        return;
    }

    resultsGrid.innerHTML = recommendations.map((movie, index) => {
        const posterUrl = movie.poster_path
            ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
            : "https://via.placeholder.com/342x513/17141f/9c98ab?text=No+Poster";

        const ratingDisplay = movie.vote_average
            ? `<span class="card-rating" title="${movie.vote_count ? movie.vote_count.toLocaleString() + ' votes' : ''}"><i class="fa-solid fa-star"></i> ${movie.vote_average.toFixed(1)}</span>`
            : "";

        const yearDisplay = movie.year && movie.year !== "N/A"
            ? `<span class="card-year"><i class="fa-regular fa-calendar"></i> ${escapeHtml(movie.year)}</span>`
            : "";

        const genreDisplay = movie.genre
            ? `<span class="card-genre">${escapeHtml(movie.genre)}</span>`
            : "";

        const detailLink = movie.id ? `details.html?id=${movie.id}` : "#";

        return `
            <article class="ai-movie-card" style="animation-delay: ${index * 60}ms">
                <div class="card-poster-wrapper">
                    <img src="${posterUrl}" alt="${escapeHtml(movie.title)}" loading="lazy" class="card-poster">
                    <div class="poster-overlay">
                        ${ratingDisplay}
                        <a href="${detailLink}" class="poster-play-btn" title="View details for ${escapeHtml(movie.title)}">
                            <i class="fa-solid fa-circle-info"></i>
                        </a>
                    </div>
                </div>
                <div class="card-body">
                    <div class="card-header-meta">
                        ${yearDisplay}
                        ${genreDisplay}
                    </div>
                    <h3 class="card-title" title="${escapeHtml(movie.title)}">
                        <a href="${detailLink}">${escapeHtml(movie.title)}</a>
                    </h3>
                    <div class="card-reason-box">
                        <p class="card-reason">
                            <i class="fa-solid fa-quote-left reason-quote-icon"></i>
                            ${escapeHtml(movie.reason || "Popular match for your requested vibe.")}
                        </p>
                    </div>
                    <div class="card-footer">
                        <a href="${detailLink}" class="view-details-btn">
                            <span>View Details</span>
                            <i class="fa-solid fa-arrow-right"></i>
                        </a>
                    </div>
                </div>
            </article>
        `;
    }).join("");
}

function showError(message) {
    errorEl.innerHTML = `
        <div class="error-container">
            <i class="fa-solid fa-circle-exclamation error-icon"></i>
            <div class="error-text-wrap">
                <p class="error-msg">${escapeHtml(message)}</p>
                <button type="button" class="error-retry-btn" onclick="getRecommendations()"><i class="fa-solid fa-rotate-right"></i> Retry</button>
            </div>
        </div>
    `;
    errorEl.hidden = false;
}

function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}