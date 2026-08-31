const trendingGrid = document.getElementById("trending-grid");

if (trendingGrid) {
    loadTrending();
}

function loadTrending() {
    fetch("/api/trending")
        .then(res => {
            if (!res.ok) throw new Error("Server error");
            return res.json();
        })
        .then(data => renderTrending(data.movies || []))
        .catch(err => {
            console.error(err);
            trendingGrid.innerHTML = '<p style="color:#94a3b8;text-align:center;grid-column:1/-1;padding:40px;">Couldn\'t load trending movies right now.</p>';
        });
}

function renderTrending(movies) {
    if (!movies.length) {
        trendingGrid.innerHTML = '<p style="color:#94a3b8;text-align:center;grid-column:1/-1;padding:40px;">No trending movies found.</p>';
        return;
    }

    trendingGrid.innerHTML = movies.map(movie => {
        const posterUrl = movie.poster_path
            ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
            : "https://via.placeholder.com/300x450/151322/94a3b8?text=No+Poster";
        const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "N/A";
        const genreLabel = movie.genre_ids && movie.genre_ids.length
            ? genreIdToName(movie.genre_ids[0])
            : "Feature";

        return `
            <div class="movie-card" onclick="window.location.href='details.html?id=${movie.id}'">
                <img src="${posterUrl}" alt="${escapeHtml(movie.title)}" loading="lazy">
                <div class="movie-info">
                    <h3>${escapeHtml(movie.title)}</h3>
                    <span><i class="fa-solid fa-star" style="color: #f59e0b; font-size: 11px;"></i> ${rating} • ${genreLabel}</span>
                    <a href="details.html?id=${movie.id}" onclick="event.stopPropagation();"><button type="button">View Details</button></a>
                </div>
            </div>
        `;
    }).join("");
}

function genreIdToName(id) {
    const genreMap = {
        28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
        80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
        14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
        9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 53: "Thriller",
        10752: "War", 37: "Western"
    };
    return genreMap[id] || "Feature";
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
