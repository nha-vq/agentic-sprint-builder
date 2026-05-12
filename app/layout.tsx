import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Agentic Sprint Builder',
  description: 'Markdown-skill multi-agent SDLC generator for the AI Tech Contest'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
