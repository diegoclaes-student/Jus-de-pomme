import express from "express";

const app = express();

// Route de test ultra-simple
app.get("/test-minimal", (req, res) => {
  res.send("✅ Express fonctionne !");
});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Test Minimal</title></head>
    <body>
      <h1>🎉 App Express Minimaliste</h1>
      <p>Si tu vois ça, Express fonctionne !</p>
      <a href="/test-minimal">Tester route minimal</a>
    </body>
    </html>
  `);
});

export default app;