const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../../middleware/auth");
const supabase = require("../utils/supabase");

router.get("/leaderboard/top10", authMiddleware, async (req, res) => {
  const { data: players, error: playersError } = await supabase
    .from("users")
    .select("discord_id, username, avatar, ranked_points")
    .order("ranked_points", { ascending: false })
    .limit(10);

  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id, name, logo, points")
    .order("points", { ascending: false })
    .limit(10);

  res.json({ players, teams });
});

module.exports = router;
