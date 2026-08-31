const params = new URLSearchParams(window.location.search);
const movieId = params.get("id");

const loadingEl = document.getElementById("details-loading");
const errorEl = document.getElementById("details-error");
const contentEl = document.getElementById("details-content");

if (!movieId) {
    showError("No movie was specified.");
} else {
    loadDetails();
}

function loadDetails() {
    fetch(`/api/movie/${movieId}`)
        .then(res => {
            if (!res.ok) throw new Error("Server error");
            return res.json();
        })
        .then(data => renderDetails(data))
        .catch(err => {
            console.error(err);
            showError("Couldn''t load this movie''s details.");
        });
}

function renderDetails(movie) {
    loadingEl.hidden = true;
    contentEl.hidden = false;

    const posterUrl = movie.poster_path
        ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
        : "https://via.placeholder.com/500x750/17141f/9c98ab?text=No+Poster";

    document.getElementById("details-poster").src = posterUrl;
    document.getElementById("details-poster").alt = movie.title;
    document.title = `BingeIt - ${movie.title}`;

    document.getElementById("details-title").textContent = movie.title;
    document.getElementById("details-tagline").textContent = movie.tagline || "";

    const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "N/A";
    const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
    const runtime = movie.runtime ? `${movie.runtime} min` : "";

    document.getElementById("details-rating").innerHTML = `<i class="fa-solid fa-star" style="color: #f59e0b; margin-right: 4px;"></i> ${rating}`;
    document.getElementById("details-year").textContent = year;
    document.getElementById("details-runtime").textContent = runtime;

    const genresEl = document.getElementById("details-genres");
    genresEl.innerHTML = (movie.genres || [])
        .map(g => `<span>${escapeHtml(g.name)}</span>`)
        .join("");

    document.getElementById("details-overview").textContent = movie.overview || "No synopsis available.";

    const castEl = document.getElementById("details-cast");
    const cast = (movie.credits && movie.credits.cast) ? movie.credits.cast.filter(person => person.profile_path).slice(0, 10) : [];

    if (cast.length) {
        castEl.innerHTML = cast.map(person => {
             const photoUrl = `https://image.tmdb.org/t/p/w200${person.profile_path}`;
            return `
                <div class="cast-card">
                    <img src="${photoUrl}" alt="${escapeHtml(person.name)}">
                    <p>${escapeHtml(person.name)}<span>${escapeHtml(person.character || "")}</span></p>
                </div>
            `;
        }).join("");
    } else {
        castEl.innerHTML = "<p style=\"color:#9c98ab;\">No cast information available.</p>";
    }
}

function showError(message) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = message;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
