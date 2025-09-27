import serverless from "serverless-http";
import app from "../src/app.js";

// Laisse Express gérer le body (formulaires HTML)
export const config = { api: { bodyParser: false } };

export default serverless(app);