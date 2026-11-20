interface Window {
  astroThemeToggle?: {
    getTheme(): "dark" | "light";
    setTheme(theme: "dark" | "light"): void;
  };
}
