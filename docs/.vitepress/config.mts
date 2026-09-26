import { defineConfig } from "vitepress";

const authoringPages = [
  ["Scenario", "/authoring/scenario"],
  ["Directives", "/authoring/directives"],
  ["Conditions", "/authoring/conditions"],
  ["Composition", "/authoring/composition"],
  ["Markdown", "/authoring/markdown"],
  ["Lua", "/authoring/lua"],
  ["UI", "/authoring/ui"],
  ["Tools", "/authoring/tools"],
  ["Canvas", "/authoring/canvas"],
  ["Audio", "/authoring/audio"],
  ["Project format", "/authoring/project-format"],
  ["Diagnostics", "/authoring/diagnostics"],
].map(([text, link]) => ({ text, link }));

const developmentPages = [
  ["Architecture", "/development/architecture"],
  ["Build and test", "/development/build-and-test"],
  ["Conventions", "/development/conventions"],
].map(([text, link]) => ({ text, link }));

export default defineConfig({
  title: "Inkforge documentation",
  description: "Authoring and development guides for Inkforge Adventure Studio.",
  base: "/inkforge/docs/",
  outDir: "../dist/docs",
  cleanUrls: true,
  markdown: { html: false },
  rewrites: {
    "README.md": "index.md",
    "authoring/README.md": "authoring/index.md",
    "development/README.md": "development/index.md",
  },
  themeConfig: {
    nav: [
      { text: "Open Inkforge", link: "https://svaltek.github.io/inkforge/" },
      { text: "GitHub", link: "https://github.com/SvalTek/inkforge" },
    ],
    search: { provider: "local" },
    sidebar: [
      {
        text: "Overview",
        items: [{ text: "Documentation home", link: "/" }],
      },
      {
        text: "Authoring",
        items: [{ text: "Start here", link: "/authoring/" }, ...authoringPages],
      },
      {
        text: "Development",
        items: [{ text: "Start here", link: "/development/" }, ...developmentPages],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/SvalTek/inkforge" }],
  },
});
