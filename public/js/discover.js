const searchInput = document.getElementById("search-input");
const genreFilter = document.getElementById("genre-filter");
const grid = document.getElementById("discover-grid");
const loadingEl = document.getElementById("discover-loading");
const errorEl = document.getElementById("discover-error");
const emptyEl = document.getElementById("discover-empty");
const loadMoreBtn = document.getElementById("load-more-btn");

let debounceTimer = null;
let currentPage = 1;
let totalPages = 1;

function loadMovies(append) {
    if (!append) {
        currentPage = 1;
        grid.innerHTML = "";
    }

    loadingEl.hidden = false;
    errorEl.hidden = true;
    emptyEl.hidden = true;
    loadMoreBtn.hidden = true;

    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set("query", searchInput.value.trim());
    if (genreFilter.value) params.set("genre", genreFilter.value);
    params.set("page", currentPage);

    fetch(`/api/discover?${params.toString()}`)
        .then(res => {
            if (!res.ok) throw new Error("Server error");
            return res.json();
        })
        .then(data => {
            loadingEl.hidden = true;
            totalPages = data.totalPages || 1;
            renderMovies(data.movies || [], append);

            if (currentPage < totalPages) {
                loadMoreBtn.hidden = false;
            }
        })
        .catch(err => {
            loadingEl.hidden = true;
            errorEl.hidden = false;
            errorEl.textContent = "Couldn't load movies. Please try again.";
            console.error(err);
        });
}

function renderMovies(movies, append) {
    if (!append && !movies.length) {
        emptyEl.hidden = false;
        return;
    }

    const cardsHtml = movies.map(movie => {
        const posterUrl = movie.poster_path
            ? `https://image.tmdb.org/t/p/w300${movie.poster_path}`
            : "https://via.placeholder.com/300x450/17141f/9c98ab?text=No+Poster";
        const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
        const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "N/A";

        return `
            <a href="details.html?id=${movie.id}" class="discover-card">
                <img src="${posterUrl}" alt="${escapeHtml(movie.title)}" loading="lazy">
                <div class="discover-card-info">
                    <h3>${escapeHtml(movie.title)}</h3>
                    <span>Rating: ${rating} ${year ? "- " + year : ""}</span>
                </div>
            </a>
        `;
    }).join("");

    if (append) {
        grid.insertAdjacentHTML("beforeend", cardsHtml);
    } else {
        grid.innerHTML = cardsHtml;
    }
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadMovies(false), 400);
});

genreFilter.addEventListener("change", () => loadMovies(false));

loadMoreBtn.addEventListener("click", () => {
    currentPage++;
    loadMovies(true);
});

loadMovies(false);