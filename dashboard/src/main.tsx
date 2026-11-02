import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@mantine/core/styles.css";
import "./ui/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { createQueryClient } from "./ui/queries";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App queryClient={createQueryClient()} />
  </StrictMode>,
);
