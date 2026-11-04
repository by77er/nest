// The scheme follows the system: set before the first paint, so a dark system never flashes light.
// A file of its own, not inline, so the Content-Security-Policy runs only the app's own scripts.
document.documentElement.setAttribute("data-mantine-color-scheme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
