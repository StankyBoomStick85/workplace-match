import type { Metadata, Viewport } from "next";
import { Header } from "@/components/Header";
import { ThemeProvider } from "@/components/ThemeProvider";
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workplace Match",
  description: "Capability-first job matching for applicants and employers."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <ThemeProvider />
        <Header />
        <main>{children}</main>
      </body>
    </html>
  );
}
