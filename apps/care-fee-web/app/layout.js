import "@halunasu/web-ui/styles/halunasu-ui.css";
import "./globals.css";
import { headers } from "next/headers";
import Script from "next/script";
import { AuthGate, PlatformAuthProvider } from "../components/platform-auth";
import { SiteNav } from "../components/site-nav";
import { BRAND_DESCRIPTION, BRAND_LOGIN, BRAND_NAME, BRAND_TITLE, PRODUCT_NAME } from "../lib/brand";
import { careFeeRuntimeConfigFromEnv } from "../lib/runtime-config";

export const metadata = {
  title: BRAND_TITLE,
  description: BRAND_DESCRIPTION,
  icons: {
    icon: "/brand/harunas-mark.png",
    apple: "/brand/harunas-mark.png"
  }
};

export default async function RootLayout({ children }) {
  const runtimeConfig = careFeeRuntimeConfigFromEnv();
  const nonce = (await headers()).get("x-nonce") || "";
  return (
    <html lang="ja">
      <body>
        <Script
          id="halunasu-care-fee-runtime-config"
          strategy="beforeInteractive"
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `window.__HALUNASU_CARE_FEE_CONFIG__ = ${JSON.stringify(runtimeConfig)};`
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
