import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Auraplex 图片合成工具",
  description: "Milestone 1 product image composition prototype",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
