// The scheme follows the system: set before the first paint, so a dark system never flashes light.
document.documentElement.setAttribute("data-mantine-color-scheme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
