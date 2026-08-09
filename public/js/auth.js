const loginForm = document.querySelector(".auth-card form");
const isSignupPage = document.getElementById("name") !== null;

if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        clearAuthError();
        const submitBtn = loginForm.querySelector(".auth-button");
        submitBtn.disabled = true;

        try {
            if (isSignupPage) {
                await handleSignup();
            } else {
                await handleLogin();
            }
        } finally {
            submitBtn.disabled = false;
        }
    });
}

async function handleSignup() {
    const name = document.getElementById("name").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const confirmPassword = document.getElementById("confirm-password").value;

    if (password !== confirmPassword) {
        showAuthError("Passwords do not match.");
        return;
    }

    try {
        const response = await fetch("/api/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            showAuthError(data.error || "Something went wrong signing up.");
            return;
        }

        window.location.href = "login.html";

    } catch (err) {
        console.error(err);
        showAuthError("Could not reach the server. Is it running?");
    }
}

async function handleLogin() {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            showAuthError(data.error || "Something went wrong logging in.");
            return;
        }

        window.location.href = "index.html";

    } catch (err) {
        console.error(err);
        showAuthError("Could not reach the server. Is it running?");
    }
}

function showAuthError(message) {
    let errorBox = document.getElementById("auth-form-error");
    if (!errorBox) {
        errorBox = document.createElement("p");
        errorBox.id = "auth-form-error";
        errorBox.style.color = "#fca5a5";
        errorBox.style.fontSize = "13px";
        errorBox.style.textAlign = "center";
        errorBox.style.marginTop = "10px";
        loginForm.insertAdjacentElement("afterend", errorBox);
    }
    errorBox.textContent = message;
}

function clearAuthError() {
    const errorBox = document.getElementById("auth-form-error");
    if (errorBox) errorBox.textContent = "";
}
