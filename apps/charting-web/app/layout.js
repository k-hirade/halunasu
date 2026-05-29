import "./globals.css";
import Script from "next/script";
import { AdminNavProvider } from "../components/admin-nav-context";
import { SiteNav } from "../components/site-nav";
import { BRAND_NAME, BRAND_TAGLINE } from "../lib/brand";

export const metadata = {
  title: BRAND_NAME,
  description: BRAND_TAGLINE,
  icons: {
    icon: "/brand/harunas-mark.png",
    apple: "/brand/harunas-mark.png"
  }
};

export default function RootLayout({ children }) {
  const runtimeConfig = {
    gatewayBaseUrl:
      process.env.GATEWAY_BASE_URL ??
      process.env.NEXT_PUBLIC_GATEWAY_BASE_URL ??
      "http://localhost:8081",
    gatewayWsUrl:
      process.env.GATEWAY_WS_URL ??
      process.env.NEXT_PUBLIC_GATEWAY_WS_URL ??
      null,
    billingBaseUrl:
      process.env.BILLING_BASE_URL ??
      process.env.NEXT_PUBLIC_BILLING_BASE_URL ??
      "http://localhost:8083"
  };

  return (
    <html lang="ja">
      <body>
        <Script
          id="medical-runtime-config"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `window.__MEDICAL_CONFIG__ = ${JSON.stringify(runtimeConfig)};`
          }}
        />
        <AdminNavProvider>
          <SiteNav />
          {children}
        </AdminNavProvider>
      </body>
    </html>
  );
}
