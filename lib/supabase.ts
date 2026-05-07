import { createBrowserClient } from "@supabase/ssr";

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      storage: {
        getItem: (key: string) => {
          if (typeof document === "undefined") return null;
          const cookies = document.cookie.split("; ");
          const found = cookies.find((cookie) => cookie.startsWith(`${key}=`));
          return found ? decodeURIComponent(found.split("=")[1]) : null;
        },
        setItem: (key: string, value: string) => {
          if (typeof document === "undefined") return;
          document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=604800; SameSite=Lax`;
        },
        removeItem: (key: string) => {
          if (typeof document === "undefined") return;
          document.cookie = `${key}=; path=/; max-age=0`;
        }
      }
    }
  }
);
