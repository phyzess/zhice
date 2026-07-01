import "../.astro/types.d.ts";
import "astro/client";
import "unplugin-icons/types/astro";

declare global {
  interface ImportMetaEnv {
    readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
