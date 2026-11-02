// A placeholder until the board's UI lands (a later PR): the JSON API under /api/ is what it will read.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h1>nest projects</h1>
      <p>The board's UI isn't built yet. The JSON API is at /api/projects.</p>
    </main>
  </StrictMode>,
);
