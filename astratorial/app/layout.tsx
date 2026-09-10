import type { Metadata } from "next";
import { Geist, DM_Serif_Display } from "next/font/google";
import { AppShell } from "@/components/shell/app-shell";
import "./globals.css";
const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const serif = DM_Serif_Display({ variable: "--font-editorial", subsets: ["latin"], weight: "400" });
export const metadata: Metadata = {
  title: { default: "astratorial — a little guidance, a lot more possible", template: "%s · astratorial" },
  description: "Turn your space into a place to learn. Personal, interactive 3D tutorials with a guide by your side.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${serif.variable}`}><body><AppShell>{children}</AppShell></body></html>;
}
