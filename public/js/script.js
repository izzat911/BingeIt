const heroInput = document.querySelector(".search-box input");
const heroButton = document.querySelector(".search-box button");

if (heroInput && heroButton) {
    heroButton.addEventListener("click", goToAiPage);
    heroInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") goToAiPage();
    });
}

function goToAiPage() {
    const description = heroInput.value.trim();
    if (!description) {
        heroInput.focus();
        return;
    }
    window.location.href = `ai.html?description=${encodeURIComponent(description)}`;
}