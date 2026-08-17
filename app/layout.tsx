import './globals.css';
import './analysis/analysis.css';
import './analysis/analysis-direct.css';
import './analysis/exact-plan.css';
import './analysis/market-roadmap.css';
import './analysis/practical-controls.css';
import './analysis/current-patterns.css';
import './analysis/decision-tools.css';
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
