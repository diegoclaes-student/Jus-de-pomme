// Démarrage local (facultatif). Sur Vercel, non utilisé.
import app from "./app.js";
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Local: http://localhost:${PORT}`);
});