import serverless from "serverless-http";
import app from "../src/app-minimal.js";

export const config = { api: { bodyParser: false } };

export default serverless(app);