require("dotenv").config();
const app = require("./app");

// THIS IS THE ONLY CHANGE - USE AZURE'S PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`BingeIt server running on port ${PORT}`);
});