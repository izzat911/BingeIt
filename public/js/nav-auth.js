const navLoginBtn = document.getElementById("login-nav-btn");

if (navLoginBtn) {
    checkLoginState();
}

function checkLoginState() {
    fetch("/api/me")
        .then(res => res.json())
        .then(data => {
            if (data.loggedIn) {
                showLoggedInState(data.name);
            }
        })
        .catch(err => console.error("Could not check login state:", err));
}

 function showLoggedInState(fullName) { const firstName = fullName.trim().split(" ")[0]; navLoginBtn.textContent = firstName;
    navLoginBtn.href = "#";

    navLoginBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (confirm("Log out?")) {
            fetch("/api/logout", { method: "POST" })
                .then(() => {
                    window.location.href = "index.html";
                })
                .catch(err => console.error("Logout failed:", err));
        }
    });
}
