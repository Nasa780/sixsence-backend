const jwt = require("jsonwebtoken");
const supabase = require("../src/utils/supabase");

async function authMiddleware(req, res, next) {
  // Lire le header Authorization: Bearer <token>
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = authHeader.split(" ")[1]; // Bearer <token>

  try {
    // Vérifier le JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Charger l'utilisateur COMPLET depuis Supabase
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", decoded.discord_id)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Injecter l'utilisateur complet dans req.user
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
