// The page (Vite + React): the board's UI over the JSON API under /api/ (src/ui/).
// The two font families, self-hosted from npm (no request leaves the app's origin), then Mantine's CSS.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
// KaTeX's own CSS and fonts, from the package (no CDN): the manager's math.
import "katex/dist/katex.min.css";
import "./ui/layout/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { createQueryClient } from "./ui/api/queryClient";
import { createAppRouter } from "./ui/router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={createAppRouter()} queryClient={createQueryClient()} />
  </StrictMode>,
);
