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

  res.redirect(redirect);
});

// ---------------------------------------------
// 2) CALLBACK DISCORD (VERSION TOKEN)
// ---------------------------------------------
router.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
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

    // ---------------------------------------------
    // 3) INSÉRER / METTRE À JOUR L'UTILISATEUR DANS SUPABASE
    // ---------------------------------------------
    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", discordUser.id)
      .single();

    if (!existingUser) {
      await supabase.from("users").insert([
        {
          discord_id: discordUser.id,
          username: discordUser.username,
          avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
          email: discordUser.email || null,
        },
      ]);
    } else {
      await supabase
        .from("users")
        .update({
          username: discordUser.username,
          avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
        })
        .eq("discord_id", discordUser.id);
    }

    // ---------------------------------------------
    // 4) CRÉER UN TOKEN JWT POUR LE FRONTEND (SANS COOKIE)
    // ---------------------------------------------
    const token = jwt.sign(
      { discord_id: discordUser.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // ---------------------------------------------
    // 5) REDIRECTION VERS LE FRONTEND AVEC LE TOKEN DANS L’URL
    // ---------------------------------------------
    res.redirect(`https://sixsence.fr/auth/callback?token=${token}`);

  } catch (err) {
    console.log("===== ERREUR DISCORD =====");
    console.log(err.response?.data || err);
    console.log("===== FIN ERREUR =====");
    return res.send("Erreur lors de la connexion Discord");
  }
});

// ---------------------------------------------
// 6) ROUTE /me → VERSION TOKEN (PAS COOKIE)
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
