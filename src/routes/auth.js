const express = require("express");
const router = express.Router();
const axios = require("axios");
const jwt = require("jsonwebtoken");
const supabase = require("../utils/supabase");

const { authMiddleware } = require("../../middleware/auth.js");

// ---------------------------------------------
// 1) REDIRECTION VERS DISCORD
// ---------------------------------------------
router.get("/auth/discord", (req, res) => {
  const redirect = `https://discord.com/oauth2/authorize?client_id=${
    process.env.DISCORD_CLIENT_ID
  }&redirect_uri=${encodeURIComponent(
    process.env.DISCORD_REDIRECT_URI
  )}&response_type=code&scope=identify%20email`;

  console.log("REDIRECT_URI ENVOYÉ À DISCORD :", process.env.DISCORD_REDIRECT_URI);

  res.redirect(redirect);
});

// ---------------------------------------------
// 2) CALLBACK DISCORD
// ---------------------------------------------
router.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  console.log("CODE REÇU :", code);

  if (!code) {
    console.log("CALLBACK SANS CODE → IGNORÉ");
    return res.status(200).send("Callback ignoré");
  }

  try {
    // Échanger le code contre un access_token
    const tokenResponse = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenResponse.data.access_token;

    // Récupérer les infos utilisateur Discord
    const userResponse = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const discordUser = userResponse.data;
    console.log("Utilisateur Discord :", discordUser);

    // ---------------------------------------------
    // 3) INSÉRER / METTRE À JOUR L'UTILISATEUR DANS SUPABASE
    // ---------------------------------------------
    const { data: existingUser, error: selectError } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", discordUser.id)
      .single();

    console.log("SELECT ERROR :", selectError);
    console.log("EXISTING USER :", existingUser);

    if (!existingUser) {
      const { error: insertError } = await supabase.from("users").insert([
        {
          discord_id: discordUser.id,
          username: discordUser.username,
          avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
          email: discordUser.email || null,
        },
      ]);

      console.log("INSERT ERROR :", insertError);
    } else {
      const { error: updateError } = await supabase
        .from("users")
        .update({
          username: discordUser.username,
          avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
        })
        .eq("discord_id", discordUser.id);

      console.log("UPDATE ERROR :", updateError);
    }

    // ---------------------------------------------
    // 4) CRÉER UN TOKEN JWT POUR LE FRONTEND
    // ---------------------------------------------
const token = jwt.sign(
  {
    discord_id: discordUser.id,
  },
  process.env.JWT_SECRET,
  { expiresIn: "7d" }
);

// 🔥 CRÉER LE COOKIE DE SESSION
res.cookie("session", token, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  // domain supprimé
  path: "/",
});

console.log("FRONTEND_URL =", process.env.FRONTEND_URL);

// 🔥 Redirection propre (sans token dans l’URL)
res.redirect("https://sixsence.fr/auth/callback");



  } catch (err) {
    console.log("===== ERREUR DISCORD =====");
    console.log(err.response?.data || err);
    console.log("===== FIN ERREUR =====");
    return res.send("Erreur lors de la connexion Discord");
  }
});

// ---------------------------------------------
// 5) ROUTE /me → SÉCURISÉE AVEC authMiddleware
// ---------------------------------------------
router.get("/me", authMiddleware, async (req, res) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("discord_id", req.user.discord_id)
    .single();

  if (error) return res.status(400).json({ error });

  res.json(user);
});

module.exports = router;
