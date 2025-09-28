import serverless from "serverless-http";
import app from "../src/app.js";

export const config = { api: { bodyParser: false } };

export default serverless(app);