"use client";

// platform-auth は @halunasu/web-ui に一本化(ステップ3)。ブランドは layout から brand prop で渡す。
export {
  PlatformAuthProvider,
  AuthGate,
  usePlatformAuth,
  getStoredPlatformAccessToken
} from "@halunasu/web-ui/platform-auth";
