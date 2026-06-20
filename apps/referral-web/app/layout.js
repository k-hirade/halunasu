import "@halunasu/web-ui/styles/halunasu-ui.css";
import "./globals.css";
import Script from "next/script";
import { AuthGate, PlatformAuthProvider } from "../components/platform-auth";
import { SiteNav } from "../components/site-nav";
import { BRAND_DESCRIPTION, BRAND_LOGIN, BRAND_NAME, BRAND_TITLE, PRODUCT_NAME } from "../lib/brand";
import { referralRuntimeConfigFromEnv } from "../lib/runtime-config";

export const metadata = {
  title: BRAND_TITLE,
  description: BRAND_DESCRIPTION,
  icons: {
    icon: "/brand/harunas-mark.png",
    apple: "/brand/harunas-mark.png"
  }
};

export default function RootLayout({ children }) {
  const runtimeConfig = referralRuntimeConfigFromEnv();

  return (
    <html lang="ja">
      <body>
        <Script
          id="halunasu-referral-runtime-config"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `window.__HALUNASU_REFERRAL_CONFIG__ = ${JSON.stringify(runtimeConfig)};`
          }}
        />
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
