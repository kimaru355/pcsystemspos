import type { Metadata, Viewport } from "next";
import { Martian_Mono, Roboto } from "next/font/google";
import "./globals.css";

// Roboto is the face Android phones set their SMS confirmations in: the counter already reads it daily.
const ui = Roboto({
  variable: "--font-ui",
  subsets: ["latin"],
});

// Codes only: order numbers, outlet and device codes, receipt references.
// Set at its narrowest width so a code like KTL-03-000124 scans as one token.
const code = Martian_Mono({
  variable: "--font-code",
  subsets: ["latin"],
  axes: ["wdth"],
});

export const metadata: Metadata = {
  title: "PC Systems POS",
  description: "Point of sale and stock management for hardware shops.",
};

export const viewport: Viewport = {
  themeColor: "#1b2530",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${ui.variable} ${code.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
