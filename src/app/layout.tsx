import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "fetchGithub",
  description: "GitHub 项目发现与推荐工作台",
  icons: {
    icon: "/favicon.svg"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
