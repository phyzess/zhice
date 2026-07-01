import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  vite: {
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [
      tailwindcss(),
      Icons({
        compiler: "astro",
        autoInstall: false,
      }),
    ],
  },
});
