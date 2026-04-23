import type { ReactNode } from 'react';

export const metadata = {
  title: 'Safyr Deal Terminal',
  description: 'Live deal-sourcing terminal for Safyr Capital Partners Ltd.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
