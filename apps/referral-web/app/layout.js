import "@halunasu/web-ui/styles/halunasu-ui.css";
import "./globals.css";
import Script from "next/script";
import { AuthGate, PlatformAuthProvider } from "../components/platform-auth";
import { SiteNav } from "../components/site-nav";
import { BRAND_DESCRIPTION, BRAND_TITLE } from "../lib/brand";
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
        <PlatformAuthProvider platformBaseUrl={runtimeConfig.platformBaseUrl}>
          <AuthGate>
            <SiteNav />
            {children}
          </AuthGate>
        </PlatformAuthProvider>
      </body>
    </html>
  );
}
