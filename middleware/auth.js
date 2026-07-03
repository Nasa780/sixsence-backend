const jwt = require("jsonwebtoken");
const supabase = require("../src/utils/supabase");

async function authMiddleware(req, res, next) {
  // Lire le cookie "session"
  const token = req.cookies.session;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", decoded.discord_id)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "User not found" });
    }

    req.user = {
      discord_id: user.discord_id,
      username: user.username,
      avatar: user.avatar,
      email: user.email,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { authMiddleware };
