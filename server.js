require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const authRoutes = require("./src/routes/auth");
const queueRoutes = require("./src/routes/queueRoutes");

const app = express();

// 🔥 FIX : empêcher les réponses 304
app.set("etag", false);
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// 🔥 Autoriser les cookies cross-site
app.use(
  cors({
    origin: [
      "https://sixsence.fr",
      "https://www.sixsence.fr",
      "https://sixsence.vercel.app"
    ],
    credentials: true,
  })
);

// 🔥 Lire les cookies
app.use(cookieParser());

app.use(express.json());

// Route principale
app.get("/", (req, res) => {
  res.redirect("https://sixsence.fr");
});

// Routes d'authentification
app.use("/", authRoutes);

const leaderboardRoutes = require("./src/routes/leaderboard");
app.use("/", leaderboardRoutes);

// Routes de la file d'attente
app.use("/", queueRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Sixsence Backend running on port ${PORT}`);
});
