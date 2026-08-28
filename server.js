const app = require("./db/app");

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`BingeIt server running on port ${PORT}`);
});