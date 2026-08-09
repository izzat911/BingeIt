const askAiBtn = document.getElementById("ask-ai-btn");
const moodInput = document.getElementById("mood-input");
const resultsSection = document.getElementById("results-section");
const resultsGrid = document.getElementById("ai-results-grid");
const loadingEl = document.getElementById("ai-loading");
const errorEl = document.getElementById("ai-error");

const urlParams = new URLSearchParams(window.location.search);
const prefillDescription = urlParams.get("description");
if (prefillDescription) {
    moodInput.value = prefillDescription;
    getRecommendations();
}

askAiBtn.addEventListener("click", getRecommendations);

async function getRecommendations() {
    const description = moodInput.value.trim();
    const genre = document.getElementById("genre").value;
    const mood = document.getElementById("mood").value;
    const era = document.getElementById("era").value;
    const length = document.getElementById("length").value;

    if (!description && !genre && !mood && !era && !length) {
        showError("Tell us a bit about what you want to watch, or pick at least one filter.");
        return;
    }

    resultsSection.hidden = false;
    resultsGrid.innerHTML = "";
    errorEl.hidden = true;
    loadingEl.hidden = false;
    askAiBtn.disabled = true;

    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
        const response = await fetch("/api/recommend", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description, genre, mood, era, length })
        });

        if (!response.ok) {
            throw new Error("Server returned an error");
        }

        const data = await response.json();
        renderResults(data.recommendations);

    } catch (err) {
        showError("Something went wrong getting recommendations. Please try again.");
        console.error(err);
    } finally {
        loadingEl.hidden = true;
        askAiBtn.disabled = false;
    }
}

function renderResults(recommendations) {
    if (!recommendations || recommendations.length === 0) {
        showError("No recommendations came back. Try describing your mood differently.");
        return;
    }

    resultsGrid.innerHTML = recommendations.map(movie => `
        <div class="ai-result-card">
            <h3>${escapeHtml(movie.title)}</h3>
            <span class="meta">${escapeHtml(movie.year || "")} ${movie.genre ? "- " + escapeHtml(movie.genre) : ""}</span>
            <p>${escapeHtml(movie.reason)}</p>
        </div>
    `).join("");
}

function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}