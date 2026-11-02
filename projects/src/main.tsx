// The page (Vite + React): the board's UI over the JSON API under /api/ (src/ui/).
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
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
