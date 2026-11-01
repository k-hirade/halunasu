import "./globals.css";
import { headers } from "next/headers";
import { AuthGate, PlatformAuthProvider } from "../components/platform-auth";
import { SiteNav } from "../components/site-nav";
import { BRAND_DESCRIPTION, BRAND_LOGIN, BRAND_NAME, BRAND_TITLE, PRODUCT_NAME } from "../lib/brand";
import { eyeRuntimeConfigFromEnv } from "../lib/runtime-config";
import { THEME_BOOT_SCRIPT } from "../lib/theme";

export const metadata = {
  title: BRAND_TITLE,
  description: BRAND_DESCRIPTION,
  icons: {
    icon: "/brand/harunas-mark.png",
    apple: "/brand/harunas-mark.png"
  }
};

export default async function RootLayout({ children }) {
  const runtimeConfig = eyeRuntimeConfigFromEnv();
  const nonce = (await headers()).get("x-nonce") || "";
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        {/* ブラウザは nonce 属性を DOM から隠すため、照合の警告を抑える */}
        <script
          id="halunasu-eye-runtime-config"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `window.__HALUNASU_EYE_CONFIG__ = ${JSON.stringify(runtimeConfig)};`
          }}
        />
        <script id="halunasu-eye-theme" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <PlatformAuthProvider
          platformBaseUrl={runtimeConfig.platformBaseUrl}
          brand={{ name: BRAND_NAME, product: PRODUCT_NAME, login: BRAND_LOGIN }}
        >
          <AuthGate>
            <SiteNav />
            {children}
          </AuthGate>
        </PlatformAuthProvider>
      </body>
    </html>
  );
}
